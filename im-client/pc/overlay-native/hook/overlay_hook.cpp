// overlay_hook.cpp - 游戏内 Overlay 二期注入式 DLL（docs/游戏内Overlay二期注入式设计.md）
//
// 已验证里程碑：
//   M0 POC（2026-10-27）：自研热补丁 detour 钩 d3d9 导出 Direct3DCreate9 → 虚表捕获设备 →
//     Present(17)/Reset(16) 虚表指针交换钩，截图验证"能画上去/游戏不崩/FPS 64 无损耗"
//   M1 通信（2026-10-27）：\\.\pipe\im-overlay-<pid> NDJSON 下行帧（好友/消息）+ 断线 3s 重连
//   M2 面板（本次）：Dear ImGui 精简面板（好友/私聊/房间镜像）+ WndProc 子类化输入劫持 +
//     上行帧（chat-send/room-act）+ 看门狗自卸载（FreeLibraryAndExitThread，绝不拖死游戏）
//
// 安全边界：
//   1. 游戏逻辑零修改（只在 Present 尾部叠加绘制）；绘制走 __try 防御，异常计数超限交看门狗
//   2. 面板激活期才渲染（未激活零渲染开销，仅 hook 透传）；激活期输入全部吞掉喂 ImGui
//   3. 自卸载序列：置 g_shutdown → 等 DLL 自有线程退出 → 摘钩收尾在游戏线程 Present 内一次性执行
//      （跨线程释放 D3D 资源与在飞设备调用竞态实测崩 d3d9.dll）→ 逻辑卸载（DLL 常驻休眠，
//      FreeLibrary 实测必崩——/MT 静态析构链），任何一步失败则钩子保留常驻，绝不带病硬拆
//   4. DLL 侧零业务逻辑：好友/房间/消息全部由主进程推帧，DLL 只画 + 转发面板事件上行帧

#include <windows.h>
#include <d3d9.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <imm.h>
#include <cfloat>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>

#include "../third_party/imgui/imgui.h"
#include "../third_party/imgui/backends/imgui_impl_dx9.h"
#include "../third_party/imgui/backends/imgui_impl_win32.h"
#include "imgui_impl_d3d8.h" // M3：D3D8 后端（独立 TU 含 third_party/d3d8 头；D3D8 仅 x86）

// 1.90+ 头文件不再默认声明（官方约定由使用方自行 extern，见 imgui_impl_win32.h 注释块）
extern LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

#pragma comment(lib, "d3d9.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "imm32.lib")

// ===== 配置 =====
static const wchar_t* K_D3D9_MODULE    = L"d3d9.dll";
static const DWORD    K_WAIT_MODULE_MS = 600000;  // 注入早于游戏加载 d3d9：轮询等待上限 10 分钟（CryEngine 等
                                                  // 运行时动态加载渲染器，登录/大厅流程可能超过 2 分钟；命中即退）
static const DWORD    K_PIPE_LOST_MS   = 30000;   // 看门狗：pipe 断连超时（主进程已不在）→ 自卸载
static const DWORD    K_PIPE_FIRST_MS  = 120000;  // 看门狗：加载后从未连上 pipe（客户端启动即亡）→ 自卸载

// ===== 原始函数指针 =====
typedef IDirect3D9* (WINAPI* PFN_Direct3DCreate9)(UINT);
typedef HRESULT     (WINAPI* PFN_CreateDevice)(IDirect3D9*, UINT, D3DDEVTYPE, HWND, DWORD, D3DPRESENT_PARAMETERS*, IDirect3DDevice9**);
typedef HRESULT     (WINAPI* PFN_Present)(IDirect3DDevice9*, CONST RECT*, CONST RECT*, HWND, CONST RGNDATA*);
typedef HRESULT     (WINAPI* PFN_Reset)(IDirect3DDevice9*, D3DPRESENT_PARAMETERS*);

static PFN_Direct3DCreate9 g_origD3DCreate9 = NULL;
static PFN_CreateDevice    g_origCreateDevice = NULL;
static PFN_Present         g_origPresent = NULL;
static PFN_Reset           g_origReset = NULL;
static void**              g_vtD3d9Slot = NULL;   // IDirect3D9 虚表 CreateDevice 槽（自卸载还原用）
static void**              g_vtDevSlot = NULL;    // 设备虚表 Present 槽（槽+1=Reset；自卸载还原用；d3d9 运行时静态表，设备释放后地址仍有效）

static IDirect3DDevice9* g_device = NULL;
static IDirect3DDevice9* g_imguiDev = NULL;  // ImGui DX9 后端当前绑定的设备（呈现设备不一致时自愈重绑）
static HWND              g_gameHwnd = NULL;
static volatile LONG     g_probeBusy = 0;         // D3D9 探针自建设备进行中（Hooked_CreateDevice 据此不捕获）
static volatile LONG     g_panelActive = 0;       // 面板显隐（Shift+Tab 切换；未激活零渲染开销）
static volatile LONG     g_pipeConnected = 0;
static volatile LONG     g_shutdown = 0;          // 自卸载序列已启动（各线程见到即自行退出/透传）
static volatile LONG     g_finalized = 0;         // 游戏线程已完成摘钩收尾（看门狗等待此标记）
static volatile LONG     g_exceptStreak = 0;      // Present 绘制连续异常计数（>100 交看门狗卸载）
static volatile LONG     g_panelReady = 0;        // M4.1：面板钩已装好（WndProc 子类化成功）——热键让位依据，PipeThread 重连重发
static CRITICAL_SECTION  g_cs;                    // 共享面板数据锁（pipe 线程写 / 渲染+UI 线程读）
static HMODULE           g_selfMod = NULL;        // 自身模块句柄（自卸载用）

// ===== 调试日志（%TEMP%\im-overlay-hook.log；正式版随签名/灰度移除，见设计文档 §3.2）=====
static void LogLine(const char* msg) {
    char path[MAX_PATH];
    UINT n = GetTempPathA(MAX_PATH, path);
    if (n == 0 || n > MAX_PATH - 40) return;
    strcat_s(path, "im-overlay-hook.log");
    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    char line[512];
    int len = snprintf(line, sizeof(line), "[%lu] %s\r\n", GetTickCount(), msg);
    if (len > 0) { DWORD w = 0; WriteFile(f, line, (DWORD)len, &w, NULL); }
    CloseHandle(f);
}

// ===== 热补丁 detour（x86/x64 通用实现；M0 已验证）=====
// 前提：target 入口为 mov edi,edi(2B) 且前置 ≥5 字节 padding（d3d9 导出普遍如此，含 0x90/0xCC）。
// 正确布局（三段）：
//   [target-5, target) ：E9 rel32 → detour（占用 padding，5 字节）
//   [target, target+2) ：EB rel8 → target-5（mov edi,edi 2 字节被短跳替换——调用方进 target 即入 detour）
//   trampoline         ：E9 rel32 → target+2（跳回原函数体）
// M2 补充：原始 7 字节备份 + 还原（看门狗自卸载前置步骤，避免卸载后跳转目标失效）
// M3 补充：x64 系统导出普遍无 mov edi,edi 热补丁头 → HotPatch 失败时落 IAT hook（见 HookIAT）
static BYTE  g_origPatchBytes[7] = { 0 };
static void* g_patchTarget = NULL;
static void* g_trampoline = NULL;

static bool HotPatch(void* target, void* detour, void** trampolineOut) {
    BYTE* t = (BYTE*)target;
    if (!(t[0] == 0x8B && t[1] == 0xFF)) return false; // 宽松校验：入口前 2 字节应为 mov edi,edi（8B FF）
    DWORD oldProt = 0;
    if (!VirtualProtect(t - 5, 7, PAGE_EXECUTE_READWRITE, &oldProt)) return false;
    memcpy(g_origPatchBytes, t - 5, 7); // 原始字节备份（卸载还原用：5 字节 padding + mov edi,edi）
    // trampoline 分配：自 target 向下 1GB 范围按 64KB 步进试探（保证 jmp rel32 可达）
    void* tramp = NULL;
    for (SIZE_T off = 0; off < 0x40000000ULL && !tramp; off += 0x10000) {
        void* base = (BYTE*)t - 0x10000 - off;
        tramp = VirtualAlloc(base, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    }
    if (!tramp) { VirtualProtect(t - 5, 7, oldProt, &oldProt); return false; }
    BYTE* tr = (BYTE*)tramp;
    tr[0] = 0xE9;
    *(LONG*)(tr + 1) = (LONG)((t + 2) - (tr + 5)); // trampoline → t+2（跳过被短跳替换的 2 字节入口；
                                                   // mov edi,edi 是 nop 语义，跳过等价——
                                                   // 若跳回 t 会经短跳再进 detour 造成无限递归，实测踩坑）
    t[-5] = 0xE9;
    *(LONG*)(t - 4) = (LONG)((BYTE*)detour - t); // padding jmp → detour
    t[0] = 0xEB;
    t[1] = (BYTE)(0xF9);                          // 入口短跳 → t-5（rel8 = -7）
    DWORD tmp = 0;
    VirtualProtect(t - 5, 7, oldProt, &tmp);
    FlushInstructionCache(GetCurrentProcess(), t - 5, 7);
    FlushInstructionCache(GetCurrentProcess(), tramp, 8);
    g_patchTarget = target;
    g_trampoline = tramp;
    *trampolineOut = tramp;
    return true;
}
static void UnpatchHotPatch() {
    if (!g_patchTarget) return;
    BYTE* t = (BYTE*)g_patchTarget;
    DWORD old = 0;
    if (VirtualProtect(t - 5, 7, PAGE_EXECUTE_READWRITE, &old)) {
        memcpy(t - 5, g_origPatchBytes, 7);
        DWORD tmp = 0;
        VirtualProtect(t - 5, 7, old, &tmp);
        FlushInstructionCache(GetCurrentProcess(), t - 5, 7);
    }
    if (g_trampoline) { VirtualFree(g_trampoline, 0, MEM_RELEASE); g_trampoline = NULL; }
    g_patchTarget = NULL;
}

// ===== IAT hook（M3：x64 体系导出普遍无热补丁头，x64 走 IAT；x86 hotpatch 失败亦兜底）=====
// 改主模块（游戏 exe）导入表中 dllName!funcName 的 IAT 项——游戏静态导入 d3d9.lib 的场景覆盖
// （动态 GetProcAddress/加壳 IAT 混淆会漏：静默降级一期悬浮窗，绝不影响游戏启动）。
// 只 hook 进程已加载镜像（RVA=VA），无需重定位换算。
// IAT 钩核心：在指定模块的导入表中找 dllName!funcName 并替换（patched=本次实际补丁的槽位数）
static bool HookIATInModule(HMODULE mod, const char* dllName, const char* funcName, void* hook, void** origOut, int* patchedOut) {
    if (patchedOut) *patchedOut = 0;
    if (!mod) return false;
    BYTE* base = (BYTE*)mod;
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
    IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return false;
    DWORD impRva = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (!impRva) return false;
    IMAGE_IMPORT_DESCRIPTOR* desc = (IMAGE_IMPORT_DESCRIPTOR*)(base + impRva);
    for (; desc->Name; ++desc) {
        const char* name = (const char*)(base + desc->Name);
        if (_stricmp(name, dllName) != 0) continue;
        IMAGE_THUNK_DATA* orig = desc->OriginalFirstThunk ? (IMAGE_THUNK_DATA*)(base + desc->OriginalFirstThunk) : NULL;
        IMAGE_THUNK_DATA* first = (IMAGE_THUNK_DATA*)(base + desc->FirstThunk);
        for (int i = 0; first[i].u1.Function; ++i) {
            // 按序号导入无名字可匹配：跳过
            if (orig && (orig[i].u1.Ordinal & IMAGE_ORDINAL_FLAG)) continue;
            if (orig) {
                IMAGE_IMPORT_BY_NAME* byName = (IMAGE_IMPORT_BY_NAME*)(base + orig[i].u1.AddressOfData);
                if (strcmp((const char*)byName->Name, funcName) != 0) continue;
            }
            // 命中：改 IAT 项
            void** slot = (void**)&first[i].u1.Function;
            if (*slot == hook) continue; // 已是钩（重复调用/校验场景）：不计补丁
            DWORD old = 0;
            if (!VirtualProtect(slot, sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) return false;
            if (origOut && !*origOut) *origOut = *slot;
            *slot = hook;
            VirtualProtect(slot, sizeof(void*), old, &old);
            if (patchedOut) (*patchedOut)++;
        }
        return patchedOut ? *patchedOut > 0 : false; // 该 dll 的导入表处理完毕
    }
    return false;
}
static bool HookIAT(const char* dllName, const char* funcName, void* hook, void** origOut) {
    int patched = 0;
    return HookIATInModule(GetModuleHandleW(NULL), dllName, funcName, hook, origOut, &patched); // 主 exe
}
// 全模块 IAT 补丁：渲染器 DLL（CryRenderD3D9 等）才导入 Direct3DCreate9 的游戏（主 exe 导入表无 d3d9 项，
// 实测 Warface/GameCdonl）——枚举全部已加载模块逐个尝试。返回本次实际补丁数
static int HookIATAllModules(const char* dllName, const char* funcName, void* hook, void** origOut) {
    HMODULE mods[1024];
    DWORD needed = 0;
    if (!EnumProcessModules(GetCurrentProcess(), mods, sizeof(mods), &needed)) return 0;
    int n = (int)(needed / sizeof(HMODULE));
    if (n > 1024) n = 1024;
    int total = 0;
    for (int i = 0; i < n; ++i) {
        int patched = 0;
        if (HookIATInModule(mods[i], dllName, funcName, hook, origOut, &patched)) total += patched;
    }
    return total;
}

// ===== M1/M2 共享面板数据（pipe 线程写 / 渲染线程读；全部 UTF-8 存储直供 ImGui 显示与上行回填）=====
static void HandleFollowFrame(const char* line); // 前置声明（M4 子进程跟随，定义在文件后段）
static void HookCreateProcessIAT();              // 前置声明（follow 名单到达时挂 CreateProcess 钩）
#define OV_FRIEND_CAP  50       // 好友上限（协议侧截 50）
#define OV_CHAT_CAP    16       // 会话上限（来过消息或打开过的对象按需建）
#define OV_MSG_CAP     64       // 单会话消息环形上限
#define OV_ROOM_MEMBER_CAP 8    // 房间成员显示上限
#define OV_ROOM_CHAT_CAP   20   // M5.9：房内聊天显示上限（快照带近 20 条历史）
#define OV_UNAME_CAP   32
#define OV_NAME_CAP    48
#define OV_TEXT_CAP    160      // 主进程已截 60 字符（UTF-8 中文 3B/字 ≈ 180B），留余量

struct FriendRow { char uname[OV_UNAME_CAP]; char name[OV_NAME_CAP]; bool on; int unread; };
struct ChatMsg   { char uname[OV_UNAME_CAP]; char ts[10]; char name[OV_NAME_CAP]; char text[OV_TEXT_CAP]; bool self; };
struct ChatLog   { char uname[OV_UNAME_CAP]; ChatMsg items[OV_MSG_CAP]; int count; };
struct RoomMember { char name[OV_NAME_CAP]; bool ready; bool host; };
struct RoomChatMsg { char uname[OV_UNAME_CAP]; char name[OV_NAME_CAP]; char text[OV_TEXT_CAP]; bool self; };
struct RoomSnap {
    bool inRoom;
    int roomId;
    char name[64];
    char gameName[64];
    char status[16];
    int memberCount;
    RoomMember members[OV_ROOM_MEMBER_CAP];
    int chatCount;                       // M5.9：房内聊天（快照历史 + roomchat 实时帧）
    RoomChatMsg chats[OV_ROOM_CHAT_CAP];
};

static FriendRow g_friends[OV_FRIEND_CAP];
static int       g_friendCount = 0;
static ChatLog   g_chats[OV_CHAT_CAP];
static int       g_chatCount = 0;
static RoomSnap  g_room;                       // room 帧快照（inRoom=false = 未在房）
static char      g_sysMsg[160] = { 0 };        // 最近一条系统提示（好友页状态行）
static char      g_selfUname[OV_UNAME_CAP] = { 0 }; // 本端账号（me 帧；回显消息 self 判定用）
// UI 线程状态（渲染线程独占；pipe 线程只读 g_activeChatUname 做未读判定，读竞态无害）
static bool g_chatOpen = false;                // 私聊视图（替代好友列表页）
static char g_activeChatUname[OV_UNAME_CAP] = { 0 };
static char g_activeChatName[OV_NAME_CAP] = { 0 };
static char g_chatInput[512] = { 0 };
static char g_roomInput[512] = { 0 };   // M5.9：房间聊天输入（独立于私聊输入）
static bool g_roomRefocus = false;      // M5.9：房间聊天发送后重聚焦（同私聊 refocus 语义）
static bool g_chatRefocus = false;  // M5.6：发送后重聚焦输入框（Enter/点按钮会提交并释放 ActiveID——连续输入靠主动要回焦点）
// M5.5：帧内通知 toast（Steam 式右下角堆叠；面板关闭也渲染；屏外通知窗在帧内渲染期停用）
struct GameToast { char uname[OV_UNAME_CAP]; char name[OV_NAME_CAP]; char text[OV_TEXT_CAP]; DWORD born; };
static GameToast g_toasts[3] = { 0 };
static int       g_toastCount = 0;
static volatile LONG g_toastsVisible = 0; // toast 可见（WndProc 据此把鼠标喂 ImGui 做命中测试=可点击）
// M5.10：房间消息左下角角标（面板关闭期；NoInputs 点击透传 + 纯文字无背景 + 1px 黑影；6s 过期=无新消息自动隐藏）
struct RoomCornerMsg { char uname[OV_UNAME_CAP]; char name[OV_NAME_CAP]; char text[OV_TEXT_CAP]; double until; };
#define OV_ROOMCORNER_CAP 4
static RoomCornerMsg g_roomCorner[OV_ROOMCORNER_CAP] = { 0 };
static int g_roomCornerN = 0; // g_cs 保护（pipe 线程写 / 渲染线程读）
// M5.7：帧内热键（hotkey 帧下发，客户端把设置里的加速器映射成 VK；默认 Shift+Tab 与旧行为一致）
static volatile LONG g_hotkeyVK = VK_TAB;
static volatile LONG g_hotkeyCtrl = 0;
static volatile LONG g_hotkeyShift = 1;
static volatile LONG g_hotkeyAlt = 0;
static char g_hotkeyLabel[40] = "Shift+Tab"; // M5.11b：标题条热键提示（跟随设置；hotkey 帧到达时重建；pipe 线程写/渲染线程读，单帧撕裂无害）
static void HotkeyLabelRebuild() {
    int vk = g_hotkeyVK;
    char kb[16];
    const char* kn = NULL;
    if (vk >= 'A' && vk <= 'Z') { kb[0] = (char)vk; kb[1] = 0; kn = kb; }
    else if (vk >= '0' && vk <= '9') { kb[0] = (char)vk; kb[1] = 0; kn = kb; }
    else if (vk >= VK_F1 && vk <= VK_F12) { snprintf(kb, sizeof(kb), "F%d", vk - VK_F1 + 1); kn = kb; }
    else if (vk == VK_TAB) kn = "Tab";
    else if (vk == VK_SPACE) kn = "Space";
    else if (vk == VK_UP) kn = "Up";
    else if (vk == VK_DOWN) kn = "Down";
    else if (vk == VK_LEFT) kn = "Left";
    else if (vk == VK_RIGHT) kn = "Right";
    else if (vk == VK_HOME) kn = "Home";
    else if (vk == VK_END) kn = "End";
    else if (vk == VK_PRIOR) kn = "PgUp";
    else if (vk == VK_NEXT) kn = "PgDn";
    else if (vk == VK_INSERT) kn = "Ins";
    else if (vk == VK_DELETE) kn = "Del";
    else { snprintf(kb, sizeof(kb), "VK%02X", vk); kn = kb; }
    char lb[32];
    int o = 0;
    if (g_hotkeyCtrl) o += snprintf(lb + o, sizeof(lb) - o, "Ctrl+");
    if (g_hotkeyShift) o += snprintf(lb + o, sizeof(lb) - o, "Shift+");
    if (g_hotkeyAlt) o += snprintf(lb + o, sizeof(lb) - o, "Alt+");
    snprintf(lb + o, sizeof(lb) - o, "%s", kn);
    snprintf(g_hotkeyLabel, sizeof(g_hotkeyLabel), "%s", lb);
}
// M5.8：好友头像（客户端 nativeImage 缩 48x48 转 BGRA 位图 base64 下发；D3D9 MANAGED 纹理懒建）
struct AvatarSlot { char uname[OV_UNAME_CAP]; int w, h; std::vector<unsigned char> px; IDirect3DTexture9* tex; void* dev; };
static AvatarSlot g_avatars[64] = { 0 };
static int        g_avatarCount = 0;
static int B64Val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
static int B64Decode(const char* in, int inLen, unsigned char* out, int outCap) {
    int o = 0, acc = 0, bits = 0;
    for (int i = 0; i < inLen && o < outCap; ++i) {
        int v = B64Val(in[i]);
        if (v < 0 || in[i] == '=') break;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (unsigned char)((acc >> bits) & 0xFF); }
    }
    return o;
}
static IDirect3DTexture9* AvatarTexGet(const char* uname); // 前置声明（定义在 M5.2 段；好友列表/Toast 绘制用）
static void AvatarDraw(const char* uname, const char* name, ImVec2 pos, float size);

// ===== 简易 JSON 提取器（M1 已验证；处理 \" \\ \n \t \r；\uXXXX 协议不用）=====
// 局限：值内含转义引号的极端串可能错位——本协议键名恒在值前 emit；完整解析器待实测需要时再换
static bool JsonStr(const char* json, const char* key, char* out, int outLen) {
    out[0] = 0;
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return false;
    p = strchr(p + strlen(pat), ':');
    if (!p) return false;
    ++p;
    while (*p == ' ') ++p;
    if (*p != '"') return false;
    ++p;
    int i = 0;
    while (*p && *p != '"') {
        char c = *p;
        if (c == '\\' && p[1]) {
            char e = p[1];
            p += 2;
            if (e == '"') c = '"'; else if (e == '\\') c = '\\'; else if (e == 'n') c = '\n';
            else if (e == 't') c = '\t'; else if (e == 'r') c = '\r'; else c = e;
        } else ++p;
        if (i < outLen - 1) out[i++] = c;
    }
    out[i] = 0;
    return true;
}
static bool JsonBool(const char* json, const char* key, bool* out) {
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return false;
    p = strchr(p + strlen(pat), ':');
    if (!p) return false;
    ++p;
    while (*p == ' ') ++p;
    if (strncmp(p, "true", 4) == 0) { *out = true; return true; }
    if (strncmp(p, "false", 5) == 0) { *out = false; return true; }
    return false;
}
static bool JsonInt(const char* json, const char* key, int* out) {
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return false;
    p = strchr(p + strlen(pat), ':');
    if (!p) return false;
    ++p;
    while (*p == ' ') ++p;
    *out = (int)strtol(p, NULL, 10);
    return true;
}
// JSON 字符串转义（上行帧 text 字段：聊天正文可能含引号/反斜杠/换行）
static void JsonEscape(const char* in, char* out, int cap) {
    int j = 0;
    for (int i = 0; in[i] && j < cap - 3; ++i) {
        char c = in[i];
        if (c == '"' || c == '\\') { out[j++] = '\\'; out[j++] = c; }
        else if (c == '\n') { out[j++] = '\\'; out[j++] = 'n'; }
        else if (c == '\t') { out[j++] = '\\'; out[j++] = 't'; }
        else if (c != '\r') out[j++] = c;
    }
    out[j] = 0;
}

// ===== 上行帧发件箱（UI 线程产 / pipe 线程消费；SPSC 环 + 事件唤醒，避免游戏线程直接阻塞写 pipe）=====
#define OV_OUTBOX_CAP  16
#define OV_OUTBOX_SLOT 560
static char  g_outbox[OV_OUTBOX_CAP][OV_OUTBOX_SLOT];
static volatile LONG g_outHead = 0;  // 生产者写后移（单生产者=UI 线程）
static volatile LONG g_outTail = 0;  // 消费者取后移（单消费者=pipe 线程）
static HANDLE g_outEvent = NULL;     // auto-reset：入队即唤醒 pipe 线程

static bool PipePushOut(const char* frame) {
    LONG head = InterlockedExchangeAdd(&g_outHead, 0);
    LONG tail = InterlockedExchangeAdd(&g_outTail, 0);
    if (head - tail >= OV_OUTBOX_CAP - 1) { LogLine("outbox full, drop frame"); return false; }
    LONG slot = head % OV_OUTBOX_CAP;
    snprintf(g_outbox[slot], OV_OUTBOX_SLOT, "%s", frame);
    InterlockedExchange(&g_outHead, head + 1); // 发布（数据先落、计数后移）
    if (g_outEvent) SetEvent(g_outEvent);
    return true;
}

// ===== 收帧分发（线程：pipe）=====
static ChatLog* FindChat(const char* uname, bool create) {
    for (int i = 0; i < g_chatCount; ++i) {
        if (strcmp(g_chats[i].uname, uname) == 0) return &g_chats[i];
    }
    if (!create || g_chatCount >= OV_CHAT_CAP) return NULL;
    ChatLog* c = &g_chats[g_chatCount++];
    ZeroMemory(c, sizeof(ChatLog));
    snprintf(c->uname, OV_UNAME_CAP, "%s", uname);
    return c;
}
static void AppendMsg(const char* uname, const char* name, const char* text, bool self) {
    ChatLog* c = FindChat(uname, uname[0] != 0);
    if (!c) return;
    SYSTEMTIME st;
    GetLocalTime(&st);
    ChatMsg m;
    snprintf(m.ts, sizeof(m.ts), "%02d:%02d", st.wHour, st.wMinute);
    snprintf(m.uname, sizeof(m.uname), "%s", uname);
    snprintf(m.name, OV_NAME_CAP, "%s", name);
    snprintf(m.text, OV_TEXT_CAP, "%s", text);
    m.self = self;
    if (c->count >= OV_MSG_CAP) { // 环形滚动：最新在末尾
        for (int i = 0; i < OV_MSG_CAP - 1; ++i) c->items[i] = c->items[i + 1];
        c->count = OV_MSG_CAP - 1;
    }
    c->items[c->count++] = m;
    // 未读：非当前会话累计（g_activeChatUname 为 UI 线程状态，读竞态最坏=少计一次，无害）
    if (uname[0] && _stricmp(uname, g_activeChatUname) != 0) {
        for (int i = 0; i < g_friendCount; ++i) {
            if (_stricmp(g_friends[i].uname, uname) == 0) { g_friends[i].unread++; break; }
        }
    }
}
static void HandleLine(const char* line) {
    char t[16] = { 0 };
    if (!JsonStr(line, "t", t, sizeof(t))) return;
    if (strcmp(t, "hello-ack") == 0) { LogLine("pipe: hello-ack"); return; }
    if (strcmp(t, "friends") == 0) {
        const char* arr = strstr(line, "\"list\"");
        if (!arr) return;
        arr = strchr(arr, '[');
        if (!arr) return;
        int count = 0;
        const char* p = arr + 1;
        char lb[48];
        EnterCriticalSection(&g_cs);
        while (*p && *p != ']' && count < OV_FRIEND_CAP) {
            const char* os = strchr(p, '{');
            if (!os) break;
            const char* oe = strchr(os, '}');
            if (!oe) break;
            char obj[512];
            size_t len = (size_t)(oe - os + 1);
            if (len >= sizeof(obj)) len = sizeof(obj) - 1;
            memcpy(obj, os, len); obj[len] = 0;
            char u[64] = { 0 }, n[64] = { 0 };
            bool on = false;
            bool hasU = JsonStr(obj, "u", u, sizeof(u));
            JsonStr(obj, "n", n, sizeof(n));
            JsonBool(obj, "on", &on);
            if (hasU) {
                snprintf(g_friends[count].uname, OV_UNAME_CAP, "%s", u);
                snprintf(g_friends[count].name, OV_NAME_CAP, "%s", n[0] ? n : u);
                g_friends[count].on = on;
                g_friends[count].unread = 0; // 快照刷新重置未读（93 增量与活动同源，误清窗口可忽略）
                count++;
            }
            p = oe + 1;
        }
        g_friendCount = count;
        LeaveCriticalSection(&g_cs);
        snprintf(lb, sizeof(lb), "pipe: friends %d", count);
        LogLine(lb);
        return;
    }
    if (strcmp(t, "msg") == 0) {
        char n[64] = { 0 }, x[OV_TEXT_CAP + 16] = { 0 }, from[64] = { 0 }, to[64] = { 0 };
        if (!JsonStr(line, "text", x, sizeof(x))) return;
        JsonStr(line, "name", n, sizeof(n));
        JsonStr(line, "from", from, sizeof(from));
        JsonStr(line, "to", to, sizeof(to));
        bool self = from[0] && g_selfUname[0] && _stricmp(from, g_selfUname) == 0;
        EnterCriticalSection(&g_cs);
        if (from[0]) {
            // 会话路由：自己的回显进"对方"的会话（to），别人的消息进 from 的会话（一期悬浮窗同口径）
            const char* key = self ? (to[0] ? to : from) : from;
            const char* shown = self ? u8"我" : (n[0] ? n : from);
            AppendMsg(key, shown, x, self);
            // M5.5：他人私聊 → 帧内通知 toast（自己的回显不弹；"当前打开的会话不弹"仅限面板可见时——
            // 面板收起后 g_chatOpen 是保留态，用户并没在看该会话，照常弹，实测漏弹根因）
            if (!self && !(g_panelActive && g_chatOpen && from[0] && _stricmp(from, g_activeChatUname) == 0)) {
                if (g_toastCount < 3) ++g_toastCount;
                for (int m2 = 2; m2 > 0; --m2) g_toasts[m2] = g_toasts[m2 - 1]; // 新消息顶到最上
                GameToast* tt = &g_toasts[0];
                snprintf(tt->uname, sizeof(tt->uname), "%s", from);
                snprintf(tt->name, sizeof(tt->name), "%s", n[0] ? n : from);
                snprintf(tt->text, sizeof(tt->text), "%s", x);
                tt->born = GetTickCount();
            }
        } else {
            snprintf(g_sysMsg, sizeof(g_sysMsg), "%s", x); // 系统提示（from 空）：好友页状态行
        }
        LeaveCriticalSection(&g_cs);
        LogLine("pipe: msg");
        return;
    }
    if (strcmp(t, "me") == 0) { // 本端账号（连接即推；回显消息 self 判定）
        char u[64] = { 0 };
        JsonStr(line, "u", u, sizeof(u));
        EnterCriticalSection(&g_cs);
        snprintf(g_selfUname, sizeof(g_selfUname), "%s", u);
        LeaveCriticalSection(&g_cs);
        return;
    }
    if (strcmp(t, "room") == 0) {
        const char* p = strstr(line, "\"room\"");
        if (!p) return;
        p = strchr(p, ':');
        if (!p) return;
        ++p;
        while (*p == ' ') ++p;
        EnterCriticalSection(&g_cs);
        if (strncmp(p, "null", 4) == 0) {
            g_room.inRoom = false;
            g_roomCornerN = 0; // M5.10：退出房间清空左下角角标
        } else {
            const char* os = strchr(p, '{');
            const char* oe = NULL;
            if (os) { // M5.9：房间对象边界改括号深度匹配（原 strchr 首 '}' 截断嵌套 members/chats——多成员房间只解析到首个成员）
                int depth = 0;
                for (const char* q = os; *q; ++q) {
                    if (*q == '{') ++depth;
                    else if (*q == '}') { if (--depth == 0) { oe = q; break; } }
                }
            }
            if (os && oe) {
                char obj[16384]; // M5.9f 审计：4096 装不下 20 条长聊天快照（中文 UTF-8 最坏 ~13KB）→ chats 数组被截断丢历史；16384 覆盖最坏情形
                size_t len = (size_t)(oe - os + 1);
                if (len >= sizeof(obj)) len = sizeof(obj) - 1;
                memcpy(obj, os, len); obj[len] = 0;
                char n[64] = { 0 }, g[64] = { 0 }, st[16] = { 0 };
                int rid = 0;
                JsonStr(obj, "name", n, sizeof(n));
                JsonStr(obj, "game_name", g, sizeof(g));
                JsonStr(obj, "status", st, sizeof(st));
                JsonInt(obj, "room_id", &rid);
                ZeroMemory(&g_room, sizeof(g_room));
                g_room.inRoom = true;
                g_room.roomId = rid;
                snprintf(g_room.name, sizeof(g_room.name), "%s", n);
                snprintf(g_room.gameName, sizeof(g_room.gameName), "%s", g);
                snprintf(g_room.status, sizeof(g_room.status), "%s", st);
                const char* ma = strstr(obj, "\"members\"");
                ma = ma ? strchr(ma, '[') : NULL;
                int mc = 0;
                const char* mp = ma ? ma + 1 : NULL;
                while (mp && *mp && *mp != ']' && mc < OV_ROOM_MEMBER_CAP) {
                    const char* ms = strchr(mp, '{');
                    if (!ms) break;
                    const char* me = strchr(ms, '}');
                    if (!me) break;
                    char mobj[256];
                    size_t mlen = (size_t)(me - ms + 1);
                    if (mlen >= sizeof(mobj)) mlen = sizeof(mobj) - 1;
                    memcpy(mobj, ms, mlen); mobj[mlen] = 0;
                    char mn[64] = { 0 };
                    bool r = false, h = false;
                    JsonStr(mobj, "n", mn, sizeof(mn));
                    JsonBool(mobj, "r", &r);
                    JsonBool(mobj, "h", &h);
                    snprintf(g_room.members[mc].name, OV_NAME_CAP, "%s", mn);
                    g_room.members[mc].ready = r;
                    g_room.members[mc].host = h;
                    mc++;
                    mp = me + 1;
                }
                g_room.memberCount = mc;
                // M5.9：房内聊天历史（快照 chats 数组，{n,x} 对；与 members 同款顺序扫描）
                const char* ca = strstr(obj, "\"chats\"");
                ca = ca ? strchr(ca, '[') : NULL;
                int cc = 0;
                const char* cp = ca ? ca + 1 : NULL;
                while (cp && *cp && *cp != ']' && cc < OV_ROOM_CHAT_CAP) {
                    const char* cs2 = strchr(cp, '{');
                    if (!cs2) break;
                    const char* ce = strchr(cs2, '}');
                    if (!ce) break;
                    char cobj[512];
                    size_t clen = (size_t)(ce - cs2 + 1);
                    if (clen >= sizeof(cobj)) clen = sizeof(cobj) - 1;
                    memcpy(cobj, cs2, clen); cobj[clen] = 0;
                    char cn[OV_NAME_CAP] = { 0 }, cx[OV_TEXT_CAP] = { 0 }, cu[OV_UNAME_CAP] = { 0 };
                    bool cself = false;
                    JsonStr(cobj, "n", cn, sizeof(cn));
                    JsonStr(cobj, "x", cx, sizeof(cx));
                    JsonStr(cobj, "u", cu, sizeof(cu));
                    JsonBool(cobj, "s", &cself);
                    snprintf(g_room.chats[cc].uname, OV_UNAME_CAP, "%s", cu);
                    snprintf(g_room.chats[cc].name, OV_NAME_CAP, "%s", cn);
                    snprintf(g_room.chats[cc].text, OV_TEXT_CAP, "%s", cx);
                    g_room.chats[cc].self = cself;
                    cc++;
                    cp = ce + 1;
                }
                g_room.chatCount = cc;
            }
        }
        LeaveCriticalSection(&g_cs);
        LogLine("pipe: room");
        return;
    }
    if (strcmp(t, "roomchat") == 0) { // M5.9：房内聊天实时帧（109 chat 广播 → 快照节流窗口内的即时显示）
        char n[OV_NAME_CAP] = { 0 }, x[OV_TEXT_CAP] = { 0 }, u[OV_UNAME_CAP] = { 0 };
        bool self = false;
        JsonStr(line, "name", n, sizeof(n));
        JsonStr(line, "text", x, sizeof(x));
        JsonStr(line, "u", u, sizeof(u));
        JsonBool(line, "self", &self);
        EnterCriticalSection(&g_cs);
        if (g_room.inRoom) {
            // M5.10d 审计：缓冲满必须环形丢最旧再追加——原 chatCount<20 直接丢弃新消息，
            // 聊满 20 条后每条实时消息都被静默丢弃、只能等快照整体替换才显示（实测"延迟起来就一直延迟"根因）
            if (g_room.chatCount >= OV_ROOM_CHAT_CAP) {
                for (int i = 1; i < OV_ROOM_CHAT_CAP; ++i) g_room.chats[i - 1] = g_room.chats[i];
                g_room.chatCount = OV_ROOM_CHAT_CAP - 1;
            }
            snprintf(g_room.chats[g_room.chatCount].uname, OV_UNAME_CAP, "%s", u);
            snprintf(g_room.chats[g_room.chatCount].name, OV_NAME_CAP, "%s", n);
            snprintf(g_room.chats[g_room.chatCount].text, OV_TEXT_CAP, "%s", x);
            g_room.chats[g_room.chatCount].self = self;
            g_room.chatCount++;
        }
        // M5.10：面板关闭期其他人发言 → 左下角角标（面板打开时房间页签直接可见，不入角标）
        if (g_room.inRoom && !self && g_panelActive == 0) {
            int idx = g_roomCornerN < OV_ROOMCORNER_CAP ? g_roomCornerN : OV_ROOMCORNER_CAP - 1;
            if (g_roomCornerN >= OV_ROOMCORNER_CAP) { // 满则前移丢最旧
                for (int i = 1; i < OV_ROOMCORNER_CAP; ++i) g_roomCorner[i - 1] = g_roomCorner[i];
            }
            snprintf(g_roomCorner[idx].uname, OV_UNAME_CAP, "%s", u);
            snprintf(g_roomCorner[idx].name, OV_NAME_CAP, "%s", n);
            snprintf(g_roomCorner[idx].text, OV_TEXT_CAP, "%s", x);
            g_roomCorner[idx].until = GetTickCount64() / 1000.0 + 6.0;
            g_roomCornerN = idx + 1;
        }
        LeaveCriticalSection(&g_cs);
        return;
    }
    if (strcmp(t, "follow") == 0) { HandleFollowFrame(line); return; } // M4：兼容名单下发（子进程跟随启用）
    if (strcmp(t, "hotkey") == 0) { // M5.7：设置热键下发（帧内热键跟随设置；默认 Shift+Tab）
        int vk = 0, c = 0, s = 0, a = 0;
        if (JsonInt(line, "vk", &vk) && vk > 0) {
            InterlockedExchange(&g_hotkeyVK, vk);
            JsonInt(line, "ctrl", &c); InterlockedExchange(&g_hotkeyCtrl, c);
            JsonInt(line, "shift", &s); InterlockedExchange(&g_hotkeyShift, s);
            JsonInt(line, "alt", &a); InterlockedExchange(&g_hotkeyAlt, a);
            HotkeyLabelRebuild(); // M5.11b：标题条提示跟随实际热键
            LogLine("hotkey updated from settings");
        }
        return;
    }
    if (strcmp(t, "avatar") == 0) { // M5.8：好友头像位图（BGRA，客户端 nativeImage 缩放；纹理懒建到绘制时）
        char u[OV_UNAME_CAP] = { 0 }, b64[24576 + 16] = { 0 };
        int w = 0, h = 0;
        JsonStr(line, "u", u, sizeof(u));
        JsonInt(line, "w", &w);
        JsonInt(line, "h", &h);
        if (!u[0] || w <= 0 || h <= 0 || w > 128 || h > 128 || !JsonStr(line, "b64", b64, sizeof(b64))) return;
        int need = w * h * 4;
        std::vector<unsigned char> px((size_t)need);
        int got = B64Decode(b64, (int)strlen(b64), &px[0], need);
        if (got < need) return; // 位图不完整丢弃（等客户端重发）
        EnterCriticalSection(&g_cs);
        AvatarSlot* slot = NULL;
        for (int i = 0; i < g_avatarCount; ++i) {
            if (_stricmp(g_avatars[i].uname, u) == 0) { slot = &g_avatars[i]; break; }
        }
        if (!slot && g_avatarCount < 64) slot = &g_avatars[g_avatarCount++];
        if (slot) {
            snprintf(slot->uname, sizeof(slot->uname), "%s", u);
            slot->w = w; slot->h = h;
            slot->px.swap(px); // 换入新位图（旧纹理由绘制线程按 dev 失配重建）
        }
        LeaveCriticalSection(&g_cs);
        LogLine("pipe: avatar");
        return;
    }
    LogLine("pipe: unknown frame");
}

// ===== pipe 客户端线程（M1 骨架 + M2 发件箱：overlapped 双事件等读/写互不阻塞）=====
static DWORD WINAPI PipeThread(LPVOID) {
    wchar_t wname[64];
    wsprintfW(wname, L"\\\\.\\pipe\\im-overlay-%lu", GetCurrentProcessId());
    char lb[80];
    snprintf(lb, sizeof(lb), "pipe thread start: \\\\.\\pipe\\im-overlay-%lu", GetCurrentProcessId());
    LogLine(lb);
    HANDLE evR = CreateEventW(NULL, TRUE, FALSE, NULL); // 读完成（手动复位，GetOverlappedResult 后 ResetEvent）
    HANDLE evW = CreateEventW(NULL, TRUE, FALSE, NULL); // 写完成
    for (;;) {
        if (g_shutdown) break;
        HANDLE f = CreateFileW(wname, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
        if (f == INVALID_HANDLE_VALUE) {
            // 服务端未就绪（游戏刚启动/主进程未起）：静默重试；自卸载期立即退出
            for (DWORD w2 = 0; w2 < 10 && !g_shutdown; ++w2) Sleep(300);
            continue;
        }
        LogLine("pipe connected");
        InterlockedExchange(&g_pipeConnected, 1);
        {
            char hello[64];
            int len = snprintf(hello, sizeof(hello), "{\"t\":\"hello\",\"pid\":%lu}\n", GetCurrentProcessId());
            DWORD w2 = 0;
            if (len > 0) WriteFile(f, hello, (DWORD)len, &w2, NULL);
        }
        // M4.1（审计修复）：重连后补报就绪——客户端在连接断开时已收回热键（悬浮窗兜底恢复），
        // 面板能力仍在（g_panelReady 已置位）就立即让回，不等下一次 Shift+Tab。
        // 二轮审计修复：走发件箱（PipePushOut，overlapped 正规出队路径）而非裸 WriteFile——
        // NULL OVERLAPPED 写 FILE_FLAG_OVERLAPPED 句柄不可靠，失败即丢且无重试
        // 发件箱清空（重连后新会话）
        InterlockedExchange(&g_outTail, InterlockedExchangeAdd(&g_outHead, 0));
        if (InterlockedExchangeAdd(&g_panelReady, 0)) PipePushOut("{\"t\":\"panel-ready\"}\n"); // 必须在清空之后入队
        char acc[262144]; // 下行帧累计缓冲（NDJSON 按行切分；M5.8 头像帧 ~12KB 且多帧可合并到达，超长行丢弃防溢出）
        int accLen = 0;
        char buf[4096];
        OVERLAPPED orv = { 0 };
        orv.hEvent = evR;
        BOOL pending = ReadFile(f, buf, sizeof(buf), NULL, &orv);
        if (!pending && GetLastError() != ERROR_IO_PENDING) { InterlockedExchange(&g_pipeConnected, 0); CloseHandle(f); continue; }
        bool alive = true;
        while (alive && !g_shutdown) {
            HANDLE hs[2] = { evR, g_outEvent };
            DWORD w2 = WaitForMultipleObjects(2, hs, FALSE, 250);
            if (w2 == WAIT_OBJECT_0 + 1) {
                // 发件箱出队（overlapped 写；服务端持续在读，小帧直写不阻塞）
                for (;;) {
                    LONG tail = InterlockedExchangeAdd(&g_outTail, 0);
                    LONG head = InterlockedExchangeAdd(&g_outHead, 0);
                    if (tail >= head) break;
                    const char* frame = g_outbox[tail % OV_OUTBOX_CAP];
                    OVERLAPPED ow = { 0 };
                    ow.hEvent = evW;
                    if (!WriteFile(f, frame, (DWORD)strlen(frame), NULL, &ow)) {
                        if (GetLastError() != ERROR_IO_PENDING) { alive = false; break; }
                    }
                    DWORD wr = 0;
                    if (!GetOverlappedResult(f, &ow, &wr, TRUE)) { alive = false; break; }
                    InterlockedExchange(&g_outTail, tail + 1);
                }
                continue;
            }
            if (w2 != WAIT_OBJECT_0) continue; // 超时：回环查 g_shutdown
            DWORD n = 0;
            if (!GetOverlappedResult(f, &orv, &n, FALSE) || n == 0) { alive = false; break; }
            ResetEvent(evR);
            for (DWORD i = 0; i < n; ++i) {
                if (buf[i] == '\n') {
                    acc[accLen] = 0;
                    if (accLen > 0) HandleLine(acc);
                    accLen = 0;
                } else if (accLen < (int)sizeof(acc) - 1) {
                    acc[accLen++] = buf[i];
                } else {
                    accLen = 0; // 单行超限=协议错：丢弃整行等待下一帧
                }
            }
            if (!alive || g_shutdown) break;
            pending = ReadFile(f, buf, sizeof(buf), NULL, &orv);
            if (!pending && GetLastError() != ERROR_IO_PENDING) { alive = false; }
        }
        CancelIo(f);
        InterlockedExchange(&g_pipeConnected, 0);
        LogLine("pipe disconnected (cancel done)");
        CloseHandle(f);
        LogLine("pipe handle closed");
        if (!g_shutdown) {
            for (DWORD w2 = 0; w2 < 10 && !g_shutdown; ++w2) Sleep(300); // 断线 3s 重连（可被打断）
        }
    }
    if (evR) CloseHandle(evR);
    if (evW) CloseHandle(evW);
    return 0;
}

// ===== ImGui（M2/M3）：面板激活期渲染；字体用系统微软雅黑（中文字形）=====
static void InstallWndProcHook(); // 前置声明（定义在 WndProc 段）
// 上下文+字体+样式（D3D9/D3D8 双后端共用一份观感）
static bool InitContextCommon() {
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    // 系统字体：微软雅黑（Win7+ 自带；不硬编码盘符，GetWindowsDirectory 解析）
    wchar_t fontPath[MAX_PATH];
    UINT n = GetWindowsDirectoryW(fontPath, MAX_PATH);
    if (n > 0 && n < MAX_PATH - 24) {
        lstrcatW(fontPath, L"\\Fonts\\msyh.ttc");
        char fontA[MAX_PATH];
        WideCharToMultiByte(CP_ACP, 0, fontPath, -1, fontA, MAX_PATH, NULL, NULL);
        // 自定义码段：ChineseSimplifiedCommon 基础上补几何图形区（●/○ 在线点，实测 Common 段无 0x25CF 显 "?"）
        static const ImWchar ranges[] = { 0x0020, 0x00FF, 0x2000, 0x206F, 0x2500, 0x25FF, 0x3000, 0x30FF, 0x31F0, 0x31FF, 0x4E00, 0x9FAF, 0xFF00, 0xFFEF, 0 };
        if (!io.Fonts->AddFontFromFileTTF(fontA, 17.0f, NULL, ranges)) {
            LogLine("imgui font load failed (msyh.ttc), fallback default");
        }
    }
    // 主题（一期 WeChat 观感映射：深色卡 + 微信绿主色）
    ImGui::StyleColorsDark();
    ImGuiStyle& s = ImGui::GetStyle();
    ImVec4* c = s.Colors;
    c[ImGuiCol_WindowBg]        = ImVec4(0.118f, 0.118f, 0.118f, 0.97f);
    c[ImGuiCol_TitleBg]         = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_TitleBgActive]   = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_FrameBg]         = ImVec4(0.20f, 0.20f, 0.20f, 1.00f);
    c[ImGuiCol_FrameBgHovered]  = ImVec4(0.26f, 0.26f, 0.26f, 1.00f);
    c[ImGuiCol_FrameBgActive]   = ImVec4(0.027f, 0.757f, 0.376f, 0.60f);
    c[ImGuiCol_Button]          = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_ButtonHovered]   = ImVec4(0.06f, 0.85f, 0.44f, 1.00f);
    c[ImGuiCol_ButtonActive]    = ImVec4(0.02f, 0.60f, 0.30f, 1.00f);
    c[ImGuiCol_CheckMark]       = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_SliderGrab]      = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_Tab]             = ImVec4(0.16f, 0.16f, 0.16f, 1.00f);
    c[ImGuiCol_TabSelected]     = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_TabHovered]      = ImVec4(0.06f, 0.85f, 0.44f, 1.00f);
    c[ImGuiCol_Header]          = ImVec4(0.027f, 0.757f, 0.376f, 0.85f);
    c[ImGuiCol_HeaderHovered]   = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_HeaderActive]    = ImVec4(0.02f, 0.60f, 0.30f, 1.00f);
    c[ImGuiCol_Separator]       = ImVec4(0.30f, 0.30f, 0.30f, 1.00f);
    c[ImGuiCol_ScrollbarBg]     = ImVec4(0.10f, 0.10f, 0.10f, 0.60f);
    c[ImGuiCol_ScrollbarGrab]   = ImVec4(0.35f, 0.35f, 0.35f, 1.00f);
    c[ImGuiCol_ScrollbarGrabHovered] = ImVec4(0.027f, 0.757f, 0.376f, 1.00f);
    c[ImGuiCol_ScrollbarGrabActive]  = ImVec4(0.02f, 0.60f, 0.30f, 1.00f);
    s.WindowRounding = 6.0f;
    s.FrameRounding = 4.0f;
    s.GrabRounding = 4.0f;
    s.ScrollbarSize = 12.0f;
    return true;
}
// M4：面板初始化失败上报（一次）——客户端收到 nopanel 即恢复全局热键（否则 Shift+Tab 成死键）；
// 同时置 g_panelBroken：之后 Shift+Tab 不再切换面板（否则切换后不可见面板照吞游戏输入=输入黑洞）。
// 二轮审计修复：失败发生在面板已激活帧时必须复位 g_panelActive 并收回面板上行态——否则激活态卡死
// （吞输入不看 broken 就会永久吞游戏输入；切换被禁也无法收起）
static volatile LONG g_panelBroken = 0;
static void ReportNoPanelOnce() {
    InterlockedExchange(&g_panelBroken, 1);
    if (InterlockedExchange(&g_panelActive, 0)) PipePushOut("{\"t\":\"panel\",\"on\":0}\n");
    static bool sent = false;
    if (sent) return;
    sent = true;
    PipePushOut("{\"t\":\"nopanel\"}\n");
    LogLine("panel init failed, nopanel reported (hotkey back to float window)");
}
// M4.1（审计修复）：WndProc 子类化成功=Shift+Tab 真正可用（ImGui 随 init 一并装钩）——客户端收到才让位全局热键。
// 不能在 pipe 连接时就让位：启动器型进程（GameCdonl）无 D3D 设备永远走不到初始化，连接就让位会让
// 启动器阶段 Shift+Tab 全程死键（子进程跟随失败时更无任何面板可用）。重连后由 PipeThread 按 g_panelReady 重发。
static void ReportPanelReadyOnce() {
    if (InterlockedExchange(&g_panelReady, 1)) return;
    PipePushOut("{\"t\":\"panel-ready\"}\n");
    LogLine("panel ready reported (hotkey yield to native)");
}
static bool g_imguiWin32Inited = false; // Win32 后端+WndProc 阶段完成标记（DX9 后端需游戏设备，两阶段初始化）
static HWND FindMainWindowOfCurrentProcess(); // 前置声明（定义在 D3D8 段；探针路径枚举主窗口用）
// 探针路径前置：Win32 后端 + WndProc 子类化尽早就位（DX9 后端等首帧拿到游戏设备指针再建）。
// 若等首次 Shift+Tab 才装 WndProc，第一下热键会被原窗口过程吞掉（M2 踩坑 1 时序死锁）
static void ImGuiPreInitWin32() {
    if (g_imguiWin32Inited) return;
    if (!g_gameHwnd) g_gameHwnd = FindMainWindowOfCurrentProcess();
    if (!g_gameHwnd) return;
    InitContextCommon();
    if (!ImGui_ImplWin32_Init(g_gameHwnd)) { LogLine("imgui win32 pre-init failed"); return; }
    g_imguiWin32Inited = true;
    InstallWndProcHook(); // Shift+Tab 检测/面板期吞输入的入口
    InterlockedExchange(&g_panelBroken, 0);
    ReportPanelReadyOnce(); // WndProc 已装好 = Shift+Tab 真正可用（热键让位）
    LogLine("imgui win32 pre-init ok (probe path)");
}
static bool ImGuiEnsure9(IDirect3DDevice9* dev) {
    static bool inited = false;
    if (inited) return true;
    if (!dev) return false;
    if (!g_imguiWin32Inited) {
        ImGuiPreInitWin32();
        if (!g_imguiWin32Inited) return false;
    }
    if (!ImGui_ImplDX9_Init(dev)) { LogLine("imgui dx9 init failed"); return false; }
    g_imguiDev = dev;
    inited = true;
    LogLine("imgui initialized (msyh + dx9 + win32)");
    InterlockedExchange(&g_panelBroken, 0); // 此前失败置的 broken 作废——init 已成功，恢复切换能力
    return true;
}

// ===== WndProc 子类化（M2 输入劫持）：Shift+Tab 切换；面板期键盘/鼠标全部吞掉喂 ImGui =====
static WNDPROC g_origWndProc = NULL;
static volatile LONG g_shiftMsgDown = 0; // 消息驱动 shift 跟踪（WM_KEYDOWN/UP；GetAsyncKeyState 只反映真实键盘，
                                         // PostMessage/SendMessage 注入的输入读不到——面板期消息吞掉后异步态也不可靠）
static volatile LONG g_imeSwallowUntil = 0; // M5.4：IME 提交后吞 WM_CHAR 的截止 tick（引擎/IME 链路会把提交串
                                            // 以"UTF-16 字节对被 GBK 误读"的形态送入 WM_CHAR，实测 Warface 试→諎）

// M5.7：配置热键的修饰键是否按住（Ctrl/Shift/Alt 按需检查；Shift 保留消息态兜底——注入输入读不到异步态）
static bool HotkeyModsHeld() {
    if (g_hotkeyCtrl && !(GetAsyncKeyState(VK_CONTROL) & 0x8000)) return false;
    if (g_hotkeyShift && !(g_shiftMsgDown || (GetAsyncKeyState(VK_SHIFT) & 0x8000))) return false;
    if (g_hotkeyAlt && !(GetAsyncKeyState(VK_MENU) & 0x8000)) return false;
    return true;
}

static LRESULT CALLBACK Hooked_WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_DESTROY) { // 游戏窗口销毁：先还原子类再透传（防卸载后打死窗口）
        LogLine("wndproc: WM_DESTROY");
        if (g_origWndProc) {
            WNDPROC orig = g_origWndProc;
            g_origWndProc = NULL;
            SetWindowLongPtrW(h, GWLP_WNDPROC, (LONG_PTR)orig);
            return CallWindowProcW(orig, h, m, w, l);
        }
        return DefWindowProcW(h, m, w, l);
    }
    if (m == WM_CLOSE) LogLine("wndproc: WM_CLOSE"); // 排查：谁在关窗口
    // M5.4：IME 提交接管（仅面板激活期）。实测 Warface：引擎/IME 链路把提交串以"UTF-16 字节对被 GBK
    // 误读"的形态经 WM_CHAR 送入（试 U+8BD5 → 諎），ImGui 缓冲即乱码。面板期自己从 IME 读提交串
    // （ImmGetCompositionStringW 恒为 UTF-16，与窗口 A/W 无关）注入，并吞掉随后的污染 WM_CHAR 流
    if (g_panelActive) {
        if (m == WM_IME_COMPOSITION && (l & GCS_RESULTSTR)) {
            HIMC himc = ImmGetContext(h);
            if (himc) {
                LONG n = ImmGetCompositionStringW(himc, GCS_RESULTSTR, NULL, 0);
                if (n > 0) {
                    wchar_t buf[32];
                    if (n > (LONG)sizeof(buf)) n = sizeof(buf); // 单次提交上限 16 字（环形缓冲 512B 足够）
                    if (ImmGetCompositionStringW(himc, GCS_RESULTSTR, buf, n) >= 0) {
                        int units = n / (int)sizeof(wchar_t);
                        for (int i = 0; i < units; ++i) ImGui::GetIO().AddInputCharacterUTF16((ImWchar16)buf[i]);
                        g_imeSwallowUntil = (LONG)(GetTickCount() + 150); // 吞随后的污染 WM_CHAR 回声
                        static int imeLogged = 0;
                        if (imeLogged < 3) { ++imeLogged; LogLine("ime commit injected via GCS_RESULTSTR"); }
                    }
                }
                ImmReleaseContext(h, himc);
            }
        }
        if (m == WM_IME_CHAR) return 0; // 防 DefWindowProc 二次生成 WM_CHAR（文本已由上方注入）
        if (m == WM_CHAR && g_imeSwallowUntil && (LONG)(GetTickCount() - (DWORD)g_imeSwallowUntil) < 0) return 0;
    }
    if (m == WM_KEYDOWN && w == VK_SHIFT) InterlockedExchange(&g_shiftMsgDown, 1);
    if (m == WM_KEYUP && w == VK_SHIFT) InterlockedExchange(&g_shiftMsgDown, 0);
    // 热键显隐（M5.7：跟随设置下发的 hotkey 帧，默认 Shift+Tab；吞掉本键不给游戏）。消息态为主、异步态兜底；
    // g_panelBroken 门禁：初始化失败后不再切换（否则不可见面板吞游戏输入）
    if (m == WM_KEYDOWN && w == (WPARAM)g_hotkeyVK && !g_panelBroken && HotkeyModsHeld()) {
        LONG nv = g_panelActive ? 0 : 1;
        InterlockedExchange(&g_panelActive, nv);
        // 面板状态上行：客户端收到 on:1 时悬浮窗热键让位（globalShortcut 是系统级，DLL 吞不掉——
        // 不让位会出现 DLL 面板与悬浮窗叠加，实测踩坑）
        PipePushOut(nv ? "{\"t\":\"panel\",\"on\":1}\n" : "{\"t\":\"panel\",\"on\":0}\n");
        return 0;
    }
    if (m == WM_KEYDOWN && w == VK_ESCAPE && g_panelActive) { // Esc 收起（一期同口径）
        InterlockedExchange(&g_panelActive, 0);
        PipePushOut("{\"t\":\"panel\",\"on\":0}\n");
        return 0;
    }
    bool keyMsg = (m >= WM_KEYFIRST && m <= WM_KEYLAST);
    bool mouseMsg = (m >= WM_MOUSEFIRST && m <= WM_MOUSELAST);
    if (!g_panelBroken && ImGui::GetCurrentContext() && (keyMsg || mouseMsg)) {
        if (g_panelActive) {
            ImGui_ImplWin32_WndProcHandler(h, m, w, l); // 喂 ImGui（含 IME 组字消息透传给它内部处理）
            return 0; // 面板期吞输入：游戏收不到键盘/鼠标（设计 §3.2 输入行）
        }
        if (g_toastsVisible && mouseMsg) {
            // M5.5：toast 可点击——鼠标喂 ImGui 命中测试：悬停 toast 上吞掉（点击开面板），其余透传游戏
            ImGui_ImplWin32_WndProcHandler(h, m, w, l);
            if (ImGui::GetIO().WantCaptureMouse) return 0;
        }
    }
    return CallWindowProcW(g_origWndProc, h, m, w, l);
}
static void InstallWndProcHook() {
    if (!g_gameHwnd || g_origWndProc) return;
    WNDPROC prev = (WNDPROC)SetWindowLongPtrW(g_gameHwnd, GWLP_WNDPROC, (LONG_PTR)&Hooked_WndProc);
    if (prev) {
        g_origWndProc = prev;
        LogLine(IsWindowUnicode(g_gameHwnd) ? "wndproc subclassed (window unicode)" : "wndproc subclassed (window ANSI/MBCS)");
    }
    else LogLine("wndproc subclass failed");
}
static void RestoreWndProc() {
    if (g_origWndProc && g_gameHwnd && IsWindow(g_gameHwnd)) {
        SetWindowLongPtrW(g_gameHwnd, GWLP_WNDPROC, (LONG_PTR)g_origWndProc);
        LogLine("wndproc restored");
    }
    g_origWndProc = NULL;
}

// ===== 面板 UI（M2 精简版：好友列表 + 私聊 + 房间镜像； ImGui UTF-8 直绘）=====
// UI 线程状态声明在共享数据段（g_chatOpen/g_activeChatUname/g_activeChatName/g_chatInput）

static void SendChatText() {
    char text[OV_TEXT_CAP] = { 0 }; // M5.9f 审计：384B 文本转义后 ~770B 超出发件箱槽 560→snprintf 截断=坏帧+尾部 \n 被切污染流（长消息静默丢失）；160B×2+头 < 560
    snprintf(text, sizeof(text), "%s", g_chatInput);
    // 首尾去空白
    char* s = text;
    while (*s == ' ' || *s == '\t') ++s;
    char* e = s + strlen(s);
    while (e > s && (e[-1] == ' ' || e[-1] == '\t')) --e;
    *e = 0;
    if (!s[0] || !g_activeChatUname[0]) return;
    char esc[768];
    JsonEscape(s, esc, sizeof(esc));
    char frame[OV_OUTBOX_SLOT];
    snprintf(frame, sizeof(frame), "{\"t\":\"chat-send\",\"to\":\"%s\",\"text\":\"%s\"}\n", g_activeChatUname, esc);
    PipePushOut(frame);
    g_chatInput[0] = 0;
}
static void SendRoomAct(const char* action) {
    char frame[OV_OUTBOX_SLOT];
    snprintf(frame, sizeof(frame), "{\"t\":\"room-act\",\"action\":\"%s\",\"room_id\":%d}\n", action, g_room.roomId);
    PipePushOut(frame);
}
// M5.9：房内聊天发送（客户端 room-act chat 分支已支持 → 109 信封上行）
static void SendRoomChat() {
    char text[OV_TEXT_CAP] = { 0 }; // M5.9f 审计：同 SendChatText，超槽位截断会丢帧污染流
    snprintf(text, sizeof(text), "%s", g_roomInput);
    char* s = text;
    while (*s == ' ' || *s == '\t') ++s;
    char* e = s + strlen(s);
    while (e > s && (e[-1] == ' ' || e[-1] == '\t')) --e;
    *e = 0;
    if (!s[0] || !g_room.roomId) return;
    char esc[768];
    JsonEscape(s, esc, sizeof(esc));
    char frame[OV_OUTBOX_SLOT];
    snprintf(frame, sizeof(frame), "{\"t\":\"room-act\",\"action\":\"chat\",\"room_id\":%d,\"text\":\"%s\"}\n", g_room.roomId, esc);
    PipePushOut(frame);
    g_roomInput[0] = 0;
}
// 快照到本地（短临界区；ImGui 绘制不持锁）
struct PanelData {
    FriendRow friends[OV_FRIEND_CAP];
    int friendCount;
    ChatMsg msgs[OV_MSG_CAP];
    int msgCount;
    RoomSnap room;
    char sysMsg[160];
    bool chatOpen;
    char selfUname[OV_UNAME_CAP]; // M5.9：本端账号（自己消息头像用）
};
static void SnapshotPanel(PanelData* d) {
    EnterCriticalSection(&g_cs);
    d->friendCount = g_friendCount;
    for (int i = 0; i < g_friendCount && i < OV_FRIEND_CAP; ++i) d->friends[i] = g_friends[i];
    d->room = g_room;
    snprintf(d->sysMsg, sizeof(d->sysMsg), "%s", g_sysMsg);
    snprintf(d->selfUname, sizeof(d->selfUname), "%s", g_selfUname);
    d->chatOpen = g_chatOpen;
    ChatLog* c = g_activeChatUname[0] ? FindChat(g_activeChatUname, false) : NULL;
    d->msgCount = c ? c->count : 0;
    for (int i = 0; i < d->msgCount && i < OV_MSG_CAP; ++i) d->msgs[i] = c->items[i];
    LeaveCriticalSection(&g_cs);
}
static const ImU32 COL_GREEN = IM_COL32(7, 193, 96, 255);
static const ImU32 COL_GRAY = IM_COL32(150, 150, 150, 255);
static const ImU32 COL_TEXT = IM_COL32(230, 230, 230, 255);

// M5.9e：CJK/无空格长串手动折行——ImGui 词折行按空格/标点断行，中文长句/长数字串（无空格）整串视为一个词永不折行溢出裁断；
// 逐 UTF-8 码点测宽、超宽插 '\n'，渲染端直接 TextUnformatted（嵌入式换行生效），气泡尺寸按折后文本实测
static void WrapTextCJK(const char* src, float maxw, char* dst, size_t dstcap) {
    size_t o = 0;
    float lw = 0.0f;
    const char* p = src;
    while (*p && o + 8 < dstcap) {
        if (*p == '\n') { dst[o++] = '\n'; lw = 0.0f; p++; continue; }
        const char* s = p;
        p++;
        while ((*p & 0xC0) == 0x80) p++; // UTF-8 续字节
        float cw = ImGui::CalcTextSize(s, p).x;
        if (lw > 0.0f && lw + cw > maxw) { dst[o++] = '\n'; lw = 0.0f; }
        for (const char* q = s; q < p && o + 1 < dstcap; q++) dst[o++] = *q;
        lw += cw;
    }
    dst[o] = 0;
}

// M5.10：房间消息左下角角标渲染（纯文字：绿色名字 + 白色正文 + 1px 黑影保证游戏画面可读；NoInputs 点击透传）
// 快照压实：g_cs 内拷出有效项并清理过期（ImGui 调用一律在锁外）
static int RoomCornerSnapshot(RoomCornerMsg* out, int cap) {
    EnterCriticalSection(&g_cs);
    double now = GetTickCount64() / 1000.0;
    int keep = 0;
    for (int i = 0; i < g_roomCornerN; ++i) {
        if (g_roomCorner[i].until <= now) continue;
        g_roomCorner[keep] = g_roomCorner[i];
        if (keep < cap) out[keep] = g_roomCorner[i];
        keep++;
    }
    g_roomCornerN = keep;
    LeaveCriticalSection(&g_cs);
    return keep < cap ? keep : cap;
}
static void DrawRoomToasts() {
    RoomCornerMsg tmp[OV_ROOMCORNER_CAP];
    int n = RoomCornerSnapshot(tmp, OV_ROOMCORNER_CAP);
    if (n <= 0) return; // 无新消息：整窗不建（需求：没消息时隐藏）
    float lineH = ImGui::GetTextLineHeight();
    float av = 22.0f;
    ImGui::SetNextWindowPos(ImVec2(16.0f, ImGui::GetIO().DisplaySize.y - 14.0f), ImGuiCond_Always, ImVec2(0.0f, 1.0f)); // 左下角底对齐，向上堆叠
    ImGui::SetNextWindowBgAlpha(0.0f); // 全透明背景
    ImGuiWindowFlags wf = ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_AlwaysAutoResize |
                          ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing |
                          ImGuiWindowFlags_NoNav | ImGuiWindowFlags_NoBringToFrontOnFocus;
    ImGui::Begin("##roomcorner", NULL, wf);
    ImDrawList* dl = ImGui::GetWindowDrawList();
    for (int i = 0; i < n; ++i) {
        // 正文 40 字符码点安全截断（角标提示性质，全文在房间页签）
        char tpart[OV_TEXT_CAP];
        size_t o = 0;
        int cp = 0;
        bool trunc = false;
        const char* p = tmp[i].text;
        while (*p && o + 8 < sizeof(tpart)) {
            if (cp >= 40) { trunc = true; break; }
            const char* s = p;
            p++;
            while ((*p & 0xC0) == 0x80) p++;
            for (const char* q = s; q < p; q++) tpart[o++] = *q;
            cp++;
        }
        if (trunc && o + 4 < sizeof(tpart)) { tpart[o++] = '.'; tpart[o++] = '.'; tpart[o++] = '.'; }
        tpart[o] = 0;
        char npart[OV_NAME_CAP + 4];
        snprintf(npart, sizeof(npart), "%s:", tmp[i].name);
        float nameW = ImGui::CalcTextSize(npart).x + 4.0f;
        float textW = ImGui::CalcTextSize(tpart).x;
        float rowH = (av > lineH ? av : lineH) + 4.0f;
        ImVec2 p0 = ImGui::GetCursorScreenPos();
        float ty = p0.y + (rowH - lineH) * 0.5f;
        char line[OV_NAME_CAP + OV_TEXT_CAP + 8];
        snprintf(line, sizeof(line), "%s %s", npart, tpart);
        // M5.10 修复：行项必须带真实宽度撑开窗口（纯 0 宽 Dummy 会让 AlwaysAutoResize 塌缩到内边距宽，DrawList 文字全被窗口矩形裁掉只剩首字母）
        ImGui::Dummy(ImVec2(av + 7.0f + nameW + textW + 4.0f, rowH));
        dl->AddText(ImVec2(p0.x + av + 7.0f + 1.0f, ty + 1.0f), IM_COL32(0, 0, 0, 200), line); // 黑影（可读性，非背景色）
        AvatarDraw(tmp[i].uname, tmp[i].name, ImVec2(p0.x, p0.y + (rowH - av) * 0.5f), av);
        dl->AddText(ImVec2(p0.x + av + 7.0f, ty), IM_COL32(120, 220, 140, 255), npart);
        dl->AddText(ImVec2(p0.x + av + 7.0f + nameW, ty), IM_COL32(235, 235, 235, 255), tpart);
    }
    ImGui::End();
}

static void DrawChatView(PanelData* d) {
    if (ImGui::Button(u8"返回")) { g_chatOpen = false; g_activeChatUname[0] = 0; return; }
    ImGui::SameLine();
    ImGui::TextColored(ImVec4(0.90f, 0.90f, 0.90f, 1.0f), "%s", g_activeChatName);
    // 注意：SameLine 之后不可直接 Separator（会画进同一行导致后续布局整体错位、输入框被推出窗口裁掉，实测踩坑）
    ImGui::Dummy(ImVec2(0.0f, 4.0f));
    ImGui::Separator();
    float footer = ImGui::GetFrameHeightWithSpacing() + 16.0f;
    ImGui::BeginChild("chatlog", ImVec2(0, -footer), ImGuiChildFlags_None);
    int n = d->msgCount;
    for (int i = 0; i < n; ++i) {
        ChatMsg& m = d->msgs[i];
        // M5.9d/e：PC 客户端同款气泡布局 + CJK 手动折行（词折行切不动无空格长串）
        float avail = ImGui::GetContentRegionAvail().x;
        float av = 26.0f;
        float wrapW = avail - av - 36.0f;
        char wt[1024];
        WrapTextCJK(m.text, wrapW, wt, sizeof(wt));
        ImVec2 tsz = ImGui::CalcTextSize(wt);               // 折后尺寸（嵌入式换行）
        float bw = tsz.x + 14.0f;                            // 气泡宽 = 最长行 + 内边距
        float bh = tsz.y + 10.0f;                            // 气泡高
        float rowX = ImGui::GetCursorPosX();
        ImVec2 scr0 = ImGui::GetCursorScreenPos(); // 行首屏幕坐标（气泡/头像 DrawList 定位）
        float vpad = (bh > av + 2.0f) ? 0.0f : (av + 2.0f - bh) * 0.5f; // 气泡比头像矮时垂直居中
        ImU32 bubbleCol = m.self ? IM_COL32(22, 132, 66, 235) : IM_COL32(44, 48, 54, 235);
        if (m.self) {
            float bx = rowX + avail - av - 6 - bw;
            ImGui::GetWindowDrawList()->AddRectFilled(ImVec2(bx, scr0.y + vpad), ImVec2(bx + bw, scr0.y + vpad + bh), bubbleCol, 6.0f);
            ImGui::SetCursorPosX(bx + 7.0f);
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() + vpad + 5.0f);
            ImGui::TextColored(ImVec4(0.94f, 0.94f, 0.94f, 1.0f), "%s", wt);
            AvatarDraw(d->selfUname, u8"我", ImVec2(scr0.x + avail - av, scr0.y + 2), av);
        } else {
            float bx = rowX + av + 6;
            ImGui::GetWindowDrawList()->AddRectFilled(ImVec2(bx, scr0.y + vpad), ImVec2(bx + bw, scr0.y + vpad + bh), bubbleCol, 6.0f);
            ImGui::SetCursorPosX(bx + 7.0f);
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() + vpad + 5.0f);
            ImGui::TextColored(ImVec4(0.94f, 0.94f, 0.94f, 1.0f), "%s", wt);
            AvatarDraw(m.uname, m.name, ImVec2(scr0.x + 2, scr0.y + 2), av);
        }
        float used = vpad + 5.0f + tsz.y;                            // 光标实际推进量
        float deficit = (bh > used ? bh : (av + 4.0f > used ? av + 4.0f : used)) - used; // 行高补差（不重复计入已推进部分）
        ImGui::Dummy(ImVec2(0, deficit > 0 ? deficit : 0));
    }
    // 新消息跟随滚动到底（用户上翻时不动）
    if (ImGui::GetScrollY() >= ImGui::GetScrollMaxY() - 8.0f) ImGui::SetScrollHereY(1.0f);
    ImGui::EndChild();
    ImGui::Separator();
    if (g_chatRefocus) { ImGui::SetKeyboardFocusHere(0); g_chatRefocus = false; } // 发送/切会话后焦点自动回输入框（0=下一个控件即 InputText；-1 是上一个控件，初版用错语义）
    bool send = ImGui::InputText("##chatin", g_chatInput, sizeof(g_chatInput), ImGuiInputTextFlags_EnterReturnsTrue);
    ImGui::SameLine();
    send = ImGui::Button(u8"发送") || send;
    if (send) { SendChatText(); g_chatRefocus = true; }
}
static void DrawFriendsList(PanelData* d) {
    if (d->sysMsg[0]) {
        ImGui::TextColored(ImVec4(0.62f, 0.62f, 0.62f, 1.0f), "%s", d->sysMsg);
        ImGui::Separator();
    }
    ImGui::TextColored(ImVec4(0.62f, 0.62f, 0.62f, 1.0f), u8"好友（%d）", d->friendCount);
    ImGui::BeginChild("friends", ImVec2(0, 0), ImGuiChildFlags_None);
    for (int i = 0; i < d->friendCount; ++i) {
        FriendRow& f = d->friends[i];
        ImVec4 dotCol = f.on ? ImVec4(0.10f, 0.85f, 0.45f, 1.0f) : ImVec4(0.47f, 0.47f, 0.47f, 1.0f);
        ImGui::PushStyleColor(ImGuiCol_Text, dotCol);
        // 在线点与名字同色难分：名字列由 selectable 自身文字色接管——用两段绘制太繁琐，POC 精简版整行同色，
        // 在线态由圆点符号形状区分（●/○），正式版换两列布局（M3 皮肤细化）
        ImVec2 avPos = ImGui::GetCursorScreenPos();
        char label[OV_UNAME_CAP + 8];
        snprintf(label, sizeof(label), "##%s", f.uname);
        if (ImGui::Selectable(label, false, ImGuiSelectableFlags_AllowOverlap, ImVec2(0, 30))) {
            snprintf(g_activeChatUname, OV_UNAME_CAP, "%s", f.uname);
            snprintf(g_activeChatName, OV_NAME_CAP, "%s", f.name);
            g_chatOpen = true;
            g_chatInput[0] = 0;
            g_chatRefocus = true; // 切会话后输入框自动聚焦（免点一下）
            EnterCriticalSection(&g_cs);
            for (int k = 0; k < g_friendCount; ++k) {
                if (_stricmp(g_friends[k].uname, f.uname) == 0) g_friends[k].unread = 0;
            }
            LeaveCriticalSection(&g_cs);
        }
        AvatarDraw(f.uname, f.name, ImVec2(avPos.x + 2, avPos.y + 2), 26); // M5.8：头像（纹理或首字母圆底）
        ImDrawList* fdl = ImGui::GetWindowDrawList();
        ImU32 fcol = ImGui::GetColorU32(dotCol);
        fdl->AddText(ImVec2(avPos.x + 32, avPos.y + 7), fcol, f.on ? "\xe2\x97\x8f" : "\xe2\x97\x8b"); // 在线点（头像右侧起，不再被遮挡）
        fdl->AddText(ImVec2(avPos.x + 46, avPos.y + 7), fcol, f.name); // 名字
        ImGui::PopStyleColor();
        if (f.unread > 0) {
            ImGui::SameLine(ImGui::GetContentRegionAvail().x - 24.0f);
            ImGui::TextColored(ImVec4(1.0f, 0.35f, 0.35f, 1.0f), "%d", f.unread);
        }
    }
    if (d->friendCount == 0) ImGui::TextColored(ImVec4(0.59f, 0.59f, 0.59f, 1.0f), u8"等待连接主进程…");
    ImGui::EndChild();
}
static void DrawRoomTab(PanelData* d) {
    if (!d->room.inRoom) {
        ImGui::Dummy(ImVec2(0, 24));
        ImGui::TextColored(ImVec4(0.59f, 0.59f, 0.59f, 1.0f), u8"未在房间");
        ImGui::TextColored(ImVec4(0.47f, 0.47f, 0.47f, 1.0f), u8"在游戏大厅创建/加入房间后，此处镜像显示房间态");
        return;
    }
    ImGui::Text("%s", d->room.name[0] ? d->room.name : u8"（未命名房间）");
    ImGui::TextColored(ImVec4(0.62f, 0.62f, 0.62f, 1.0f), "%s · %s",
        d->room.gameName[0] ? d->room.gameName : u8"未知游戏",
        strcmp(d->room.status, "playing") == 0 ? u8"游戏中" : u8"等待中");
    ImGui::Separator();
    ImGui::TextColored(ImVec4(0.62f, 0.62f, 0.62f, 1.0f), u8"成员（%d）", d->room.memberCount);
    for (int i = 0; i < d->room.memberCount && i < OV_ROOM_MEMBER_CAP; ++i) {
        RoomMember& m = d->room.members[i];
        if (m.host) ImGui::TextColored(ImVec4(1.0f, 0.80f, 0.30f, 1.0f), u8"[房主] %s%s", m.name, m.ready ? u8"（已准备）" : "");
        else ImGui::TextColored(m.ready ? ImVec4(0.10f, 0.85f, 0.45f, 1.0f) : ImVec4(0.75f, 0.75f, 0.75f, 1.0f),
            "    %s%s", m.name, m.ready ? u8"（已准备）" : "");
    }
    ImGui::Dummy(ImVec2(0, 12));
    if (ImGui::Button(u8"准备 / 取消准备", ImVec2(180, 0))) SendRoomAct("ready");
    ImGui::SameLine();
    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.70f, 0.20f, 0.20f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.85f, 0.28f, 0.28f, 1.0f));
    if (ImGui::Button(u8"退出房间", ImVec2(120, 0))) SendRoomAct("leave");
    ImGui::PopStyleColor(2);
    // M5.9：房内聊天（历史 + 输入；成员上方区域让给状态，聊天区占余下全部高度）
    ImGui::Separator();
    ImGui::TextColored(ImVec4(0.62f, 0.62f, 0.62f, 1.0f), u8"房内聊天");
    float inH = ImGui::GetFrameHeightWithSpacing();
    ImGui::BeginChild("roomchats", ImVec2(0, -inH), ImGuiChildFlags_None);
    for (int i = 0; i < d->room.chatCount; ++i) {
        RoomChatMsg& c = d->room.chats[i];
        // M5.9d：房间群聊——名字行（群聊语义保留）+ 气泡；Dummy 只补差值（修复双倍计数=间距过宽根因）
        float avail = ImGui::GetContentRegionAvail().x;
        float av = 26.0f;
        float wrapW = avail - av - 36.0f;
        char wt[1024];
        WrapTextCJK(c.text, wrapW, wt, sizeof(wt));
        ImVec2 tsz = ImGui::CalcTextSize(wt);
        float bw = tsz.x + 14.0f;
        float bh = tsz.y + 10.0f;
        float nameW = ImGui::CalcTextSize(c.name).x;
        float rowX = ImGui::GetCursorPosX();
        ImVec2 scr0 = ImGui::GetCursorScreenPos();
        float vpad = (bh > av + 2.0f) ? 0.0f : (av + 2.0f - bh) * 0.5f;
        ImU32 bubbleCol = c.self ? IM_COL32(22, 132, 66, 235) : IM_COL32(44, 48, 54, 235);
        if (c.self) {
            ImGui::SetCursorPosX(rowX + avail - av - 6 - bw + (bw > nameW ? bw - nameW : 0)); // 名字右对齐气泡右缘
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.45f, 0.78f, 0.35f, 1.0f));
            ImGui::TextUnformatted(c.name);
            ImGui::PopStyleColor();
            float bx = rowX + avail - av - 6 - bw;
            ImGui::GetWindowDrawList()->AddRectFilled(ImVec2(bx, scr0.y + ImGui::GetTextLineHeight() + vpad), ImVec2(bx + bw, scr0.y + ImGui::GetTextLineHeight() + vpad + bh), bubbleCol, 6.0f);
            ImGui::SetCursorPosX(bx + 7.0f);
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() + vpad + 5.0f);
            ImGui::TextColored(ImVec4(0.94f, 0.94f, 0.94f, 1.0f), "%s", wt);
            AvatarDraw(d->selfUname, u8"我", ImVec2(scr0.x + avail - av, scr0.y + 2), av);
        } else {
            ImGui::SetCursorPosX(rowX + av + 6);
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.45f, 0.78f, 0.35f, 1.0f));
            ImGui::TextUnformatted(c.name);
            ImGui::PopStyleColor();
            float bx = rowX + av + 6;
            ImGui::GetWindowDrawList()->AddRectFilled(ImVec2(bx, scr0.y + ImGui::GetTextLineHeight() + vpad), ImVec2(bx + bw, scr0.y + ImGui::GetTextLineHeight() + vpad + bh), bubbleCol, 6.0f);
            ImGui::SetCursorPosX(bx + 7.0f);
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() + vpad + 5.0f);
            ImGui::TextColored(ImVec4(0.94f, 0.94f, 0.94f, 1.0f), "%s", wt);
            AvatarDraw(c.uname, c.name, ImVec2(scr0.x + 2, scr0.y + 2), av);
        }
        float nameH = ImGui::GetTextLineHeight();
        float used = nameH + vpad + 5.0f + tsz.y;
        float want = (nameH + bh > used ? nameH + bh : (av + 4.0f > used ? av + 4.0f : used));
        float deficit = want - used;
        ImGui::Dummy(ImVec2(0, deficit > 0 ? deficit : 0));
    }
    if (ImGui::GetScrollY() >= ImGui::GetScrollMaxY() - 8.0f) ImGui::SetScrollHereY(1.0f);
    ImGui::EndChild();
    if (g_roomRefocus) { ImGui::SetKeyboardFocusHere(0); g_roomRefocus = false; }
    bool rsend = ImGui::InputText("##roomin", g_roomInput, sizeof(g_roomInput), ImGuiInputTextFlags_EnterReturnsTrue);
    ImGui::SameLine();
    rsend = ImGui::Button(u8"发送") || rsend;
    if (rsend) { SendRoomChat(); g_roomRefocus = true; }
}
// M5.11：面板拖拽（按住绿色标题条移动位置；位置本会话内保持——面板开关/重开不回中）
static ImVec2 s_ovPos = ImVec2(0, 0);        // 当前窗口位置
static bool   s_ovPosInit = false;           // 首开初始化（默认居中）
static bool   s_ovDragging = false;
static ImVec2 s_ovDragOff = ImVec2(0, 0);    // 按下点相对窗口左上角的偏移

static void DrawPanel() {
    ImGuiIO& io = ImGui::GetIO();
    // 面板高度自适应：矮窗口（如 720p 全屏含标题栏）不超出 client 区（输入行被裁实测踩坑）
    float ph = 700.0f;
    if (io.DisplaySize.y < ph + 20.0f) ph = io.DisplaySize.y - 20.0f;
    if (ph < 320.0f) ph = 320.0f;
    float py = (io.DisplaySize.y - ph) * 0.5f;
    if (py < 8.0f) py = 8.0f;
    if (!s_ovPosInit) { s_ovPos = ImVec2(io.DisplaySize.x * 0.5f - 270.0f, py); s_ovPosInit = true; }
    ImGui::SetNextWindowPos(s_ovPos, ImGuiCond_Always);
    ImGui::SetNextWindowSize(ImVec2(540.0f, ph), ImGuiCond_Always);
    ImGuiWindowFlags flags = ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                             ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoBringToFrontOnFocus;
    ImGui::Begin("##ovpanel", NULL, flags);
    // 自绘标题条（微信绿 + 白字；窗口本体 NoTitleBar）
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 p0 = ImGui::GetWindowPos();
    dl->AddRectFilled(p0, ImVec2(p0.x + 540.0f, p0.y + 44.0f), COL_GREEN, 6.0f, ImDrawFlags_RoundCornersTop);
    dl->AddText(ImVec2(p0.x + 16.0f, p0.y + 10.0f), IM_COL32(255, 255, 255, 255), u8"游戏内 Overlay");
    char hkTxt[48];
    snprintf(hkTxt, sizeof(hkTxt), "%s %s", g_hotkeyLabel, u8"收起");
    ImVec2 ht = ImGui::CalcTextSize(hkTxt);
    dl->AddText(ImVec2(p0.x + 540.0f - ht.x - 16.0f, p0.y + 12.0f), IM_COL32(255, 255, 255, 200), hkTxt); // M5.11b：跟随设置热键（右对齐）
    // M5.11：标题条拖拽热区（ InvisibleButton 占位同原 Dummy——既让出标题条高度又当拖拽手柄；NoMove 窗口的手动移动）
    ImGui::InvisibleButton("##ovdrag", ImVec2(540.0f - ImGui::GetStyle().WindowPadding.x * 2.0f, 30.0f));
    if (ImGui::IsItemActive()) {
        if (!s_ovDragging) { s_ovDragging = true; ImVec2 mp = io.MousePos; s_ovDragOff = ImVec2(mp.x - s_ovPos.x, mp.y - s_ovPos.y); }
        float nx = io.MousePos.x - s_ovDragOff.x;
        float ny = io.MousePos.y - s_ovDragOff.y;
        if (nx < 4.0f) nx = 4.0f;
        if (ny < 4.0f) ny = 4.0f;
        if (nx > io.DisplaySize.x - 544.0f) nx = io.DisplaySize.x - 544.0f; // 夹紧：面板不出屏（标题条恒可见）
        if (ny > io.DisplaySize.y - 40.0f) ny = io.DisplaySize.y - 40.0f;
        if (nx < 4.0f) nx = 4.0f; // 极窄屏兜底
        s_ovPos = ImVec2(nx, ny);
    } else {
        s_ovDragging = false;
    }
    PanelData d;
    SnapshotPanel(&d);
    if (d.chatOpen) {
        DrawChatView(&d);
    } else {
        if (ImGui::BeginTabBar("ovtabs")) {
            if (ImGui::BeginTabItem(u8"好友")) { DrawFriendsList(&d); ImGui::EndTabItem(); }
            if (ImGui::BeginTabItem(u8"房间")) { DrawRoomTab(&d); ImGui::EndTabItem(); }
            ImGui::EndTabBar();
        }
    }
    ImGui::End();
}

// ===== 虚表钩（M0 已验证：指针交换，无代码补丁）=====
static void UnhookAll(); // 前置声明（定义在看门狗段；由游戏线程 Present 钩内一次性调用）
static void RenderPanelFrame(IDirect3DDevice9* dev); // 前置声明（M5.2，定义在 Hooked_Reset 后：诊断/自愈重绑/异常防御统一入口）
static HRESULT WINAPI Hooked_SCPresent(IDirect3DSwapChain9*, CONST RECT*, CONST RECT*, HWND, CONST RGNDATA*, DWORD); // 前置声明（M5.2 隐式交换链钩）
static volatile LONG g_scLastTick = 0;      // M5.3：交换链钩最近渲染时刻（0=从未）——渲染自适应归属判据（定义上移，Present 钩先用）
static HRESULT WINAPI Hooked_Present(IDirect3DDevice9* dev, CONST RECT* src, CONST RECT* dst, HWND wnd, CONST RGNDATA* dirty) {
    if (g_shutdown) {
        // 逻辑卸载的一次性收尾必须在游戏线程上做（看门狗线程释放 D3D 资源会与在飞的设备调用竞态，
        // 实测 d3d9.dll 内 AV）——利用下一帧 Present 在正确的线程上摘钩/关停 ImGui
        if (!InterlockedExchange(&g_finalized, 1)) {
            UnhookAll();
            LogLine("shutdown: finalized on game thread");
        }
        return g_origPresent(dev, src, dst, wnd, dirty);
    }
    if (dev) {
        // 渲染归属：交换链钩已接管（100ms 内渲染过）则让位，防同帧双渲染/高帧率下时间去重跳帧闪烁。
        // 100ms 短窗双向自愈：交换链每帧渲染→设备钩永久让位；交换链停渲染→设备钩 100ms 后自动接管。
        // M5.5：面板关闭期 toast 渲染也走此通道（RenderPanelFrame 内部无可渲染内容时早退）
        LONG scLast = InterlockedExchangeAdd(&g_scLastTick, 0);
        if (scLast == 0 || (LONG)GetTickCount() - scLast > 100) RenderPanelFrame(dev);
    }
    return g_origPresent(dev, src, dst, wnd, dirty);
}
static HRESULT WINAPI Hooked_Reset(IDirect3DDevice9* dev, D3DPRESENT_PARAMETERS* pp) {
    static bool resetLogged = false;
    if (!resetLogged) { resetLogged = true; LogLine("d3d9 reset hook fired"); } // 诊断：设备重置可见化
    // 设备重置（全屏切换/尺寸变化）：先失效 ImGui 设备资源，放行原 Reset，成功后重建
    ImGui_ImplDX9_InvalidateDeviceObjects();
    HRESULT hr = g_origReset(dev, pp);
    if (SUCCEEDED(hr)) ImGui_ImplDX9_CreateDeviceObjects();
    return hr;
}

// ===== M5.2 虚表完整性守护 + 隐式交换链补钩（12:33 会话定论：面板切换正常但 Present 从未被调——
// 引擎建设备后整体替换实例虚表指针（w3plus 同款对抗，M3 D3D8 已有先例）或走交换链呈现）=====
typedef HRESULT (WINAPI* PFN_SCPresent_t)(IDirect3DSwapChain9*, CONST RECT*, CONST RECT*, HWND, CONST RGNDATA*, DWORD);
static void*  g_origSCPresent = NULL;
static void** g_vtSCSlot = NULL;            // 隐式交换链虚表 Present 槽（逻辑卸载后保留透传，同 WndProc 语义）
static void** g_vtDevBase = NULL;           // 捕获时的设备虚表基址（守护比对：实例指针被换即重打）
                                            // g_scLastTick 定义上移至 Hooked_Present 前（渲染归属判据）

// M5.8：头像纹理懒建（客户端下发的 BGRA 位图 → D3D9 MANAGED 纹理；设备重绑后旧纹理作废重建）
static IDirect3DTexture9* AvatarTexGet(const char* uname) {
    if (!g_imguiDev || !uname || !uname[0]) return NULL;
    IDirect3DTexture9* tex = NULL;
    EnterCriticalSection(&g_cs);
    for (int i = 0; i < g_avatarCount; ++i) {
        if (_stricmp(g_avatars[i].uname, uname) != 0 || g_avatars[i].px.empty()) continue;
        if (g_avatars[i].tex && g_avatars[i].dev == (void*)g_imguiDev) { tex = g_avatars[i].tex; break; }
        if (g_avatars[i].tex) { g_avatars[i].tex->Release(); g_avatars[i].tex = NULL; }
        if (SUCCEEDED(g_imguiDev->CreateTexture(g_avatars[i].w, g_avatars[i].h, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &tex, NULL))) {
            D3DLOCKED_RECT lr;
            if (SUCCEEDED(tex->LockRect(0, &lr, NULL, 0))) {
                for (int y = 0; y < g_avatars[i].h; ++y)
                    memcpy((unsigned char*)lr.pBits + y * lr.Pitch, &g_avatars[i].px[(size_t)y * g_avatars[i].w * 4], (size_t)g_avatars[i].w * 4);
                tex->UnlockRect(0);
            }
            g_avatars[i].tex = tex;
            g_avatars[i].dev = (void*)g_imguiDev;
        } else tex = NULL;
        break;
    }
    LeaveCriticalSection(&g_cs);
    return tex;
}
// 设备重绑后旧设备纹理全作废：清纹理指针（位图保留）+ 向客户端要重发（新设备重建）
static void AvatarTexFlush() {
    EnterCriticalSection(&g_cs);
    for (int i = 0; i < g_avatarCount; ++i) {
        if (g_avatars[i].tex) { g_avatars[i].tex->Release(); g_avatars[i].tex = NULL; }
    }
    LeaveCriticalSection(&g_cs);
    PipePushOut("{\"t\":\"avatars-need\"}\n");
}
// 头像绘制：有纹理画圆角图，无纹理画"首字母圆底"兜底（主题绿）
static void AvatarDraw(const char* uname, const char* name, ImVec2 pos, float size) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    IDirect3DTexture9* tex = AvatarTexGet(uname);
    if (tex) {
        dl->AddImageRounded((ImTextureID)tex, pos, ImVec2(pos.x + size, pos.y + size), ImVec2(0, 0), ImVec2(1, 1), IM_COL32(255, 255, 255, 255), size * 0.5f);
        return;
    }
    float cx = pos.x + size * 0.5f, cy = pos.y + size * 0.5f;
    dl->AddCircleFilled(ImVec2(cx, cy), size * 0.5f, IM_COL32(69, 150, 90, 255), 24);
    char ini[8] = { 0 };
    const char* src = (name && name[0]) ? name : uname;
    if (src[0]) {
        unsigned char c = (unsigned char)src[0];
        if (c < 0x80) { ini[0] = src[0]; } // ASCII 取首字母
        else { ini[0] = src[0]; ini[1] = src[1]; } // UTF-8 中文取首字节对（字体裁剪安全：只需该字符字形在 atlas 内）
    }
    if (ini[0]) {
        ImVec2 ts = ImGui::CalcTextSize(ini);
        dl->AddText(ImVec2(cx - ts.x * 0.5f, cy - ts.y * 0.5f), IM_COL32(255, 255, 255, 255), ini);
    }
}

// M5.5：帧内通知 toast 绘制（右下角堆叠；6s 自愈过期；面板关闭期可点击=打开面板直达该会话，
// 面板打开期 NoInputs 只展示——防 toast 窗口抢面板输入）
static void DrawToasts() {
    DWORD now = GetTickCount();
    GameToast snap[3];
    int n = 0;
    EnterCriticalSection(&g_cs);
    for (int i = 0; i < g_toastCount; ++i) {
        if (now - g_toasts[i].born < 6000) snap[n++] = g_toasts[i]; // 顺带清理过期（新在上）
    }
    g_toastCount = n;
    LeaveCriticalSection(&g_cs);
    InterlockedExchange(&g_toastsVisible, n > 0 ? 1 : 0); // WndProc 鼠标路由开关
    if (n <= 0) return;
    bool interactive = !g_panelActive; // 面板打开期 toast 只展示（输入已归 ImGui，但防 toast 抢面板点击）
    ImVec2 disp = ImGui::GetIO().DisplaySize;
    const float tw = 320, est = 52, gap = 8, margin = 14;
    ImGui::SetNextWindowPos(ImVec2(disp.x - tw - margin, disp.y - margin - n * (est + gap)), ImGuiCond_Always);
    ImGui::SetNextWindowSizeConstraints(ImVec2(tw, 0), ImVec2(tw, FLT_MAX)); // 宽固定、高自适应
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 6.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(12, 8));
    ImGui::PushStyleColor(ImGuiCol_WindowBg, ImVec4(0.07f, 0.07f, 0.07f, 0.88f));
    ImGui::Begin("##imtoasts", NULL, ImGuiWindowFlags_NoDecoration | (interactive ? 0 : ImGuiWindowFlags_NoInputs) |
                 ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings |
                 ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    for (int i = 0; i < n; ++i) {
        ImGui::BeginGroup();
        if (i) ImGui::Separator();
        ImVec2 avPos = ImGui::GetCursorScreenPos();
        ImGui::Dummy(ImVec2(30, 30)); // 头像位
        ImGui::SameLine(48); // 头像右缘外起文（窗口 padding 12 + 30 头像 + 6 间距）
        ImGui::BeginGroup();
        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.45f, 0.78f, 0.35f, 1.0f)); // 名字=主题绿（跟随主界面观感）
        ImGui::TextUnformatted(snap[i].name);
        ImGui::PopStyleColor(); // M5.8b：名字色出栈（缺失=每条 toast 泄漏一次 PushStyleColor→EndFrame 断言弹窗，实测崩溃）
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + tw - 62);
        ImGui::TextUnformatted(snap[i].text);
        ImGui::PopTextWrapPos();
        ImGui::EndGroup();
        ImGui::EndGroup();
        AvatarDraw(snap[i].uname, snap[i].name, avPos, 30); // M5.8：头像（纹理或首字母圆底）
        // 点击 toast：打开面板直达该会话（Steam 同款）；清掉全部 toast（视觉收敛）
        if (interactive && ImGui::IsItemHovered() && ImGui::IsMouseReleased(ImGuiMouseButton_Left)) {
            InterlockedExchange(&g_panelActive, 1); // 呼出面板（与 Shift+Tab 同语义）
            g_chatOpen = true;
            snprintf(g_activeChatUname, sizeof(g_activeChatUname), "%s", snap[i].uname);
            snprintf(g_activeChatName, sizeof(g_activeChatName), "%s", snap[i].name);
            g_chatRefocus = true; // 输入框自动聚焦（免点一下）
            PipePushOut("{\"t\":\"panel\",\"on\":1}\n"); // 客户端悬浮窗让位
            EnterCriticalSection(&g_cs);
            g_toastCount = 0;
            LeaveCriticalSection(&g_cs);
            LogLine("toast clicked, panel opened to chat");
        }
    }
    ImGui::End();
    ImGui::PopStyleColor();
    ImGui::PopStyleVar(3);
}

// 面板渲染（Device::Present / SwapChain::Present 双钩共用）。
// 渲染归属自适应（M5.3 闪烁修复）：交换链 Present 是最终呈现调用=归属它；Device::Present 仅在
// 交换链 100ms 未渲染时兜底。不能用时间窗去重——高帧率（聚焦 120fps+，帧间隔<8ms）下会把相邻帧
// 误判为同帧双入口而跳帧=面板闪烁（实测 Warface 聚焦闪烁/失焦正常的根因）
static void RenderPanelFrame(IDirect3DDevice9* dev) {
    if (g_panelBroken) return;
    // M5.5/M5.10：面板激活或存在未过期 toast/房间角标才渲染（两者在面板关闭期也要画进帧内）
    bool panelOn = g_panelActive != 0;
    int toastN = 0;
    if (!panelOn) {
        EnterCriticalSection(&g_cs);
        toastN = g_toastCount + g_roomCornerN;
        LeaveCriticalSection(&g_cs);
        if (toastN <= 0) return;
    }
    __try {
        // 诊断：前 3 个激活帧记录调用设备指针（甄别换设备呈现/渲染静默异常）
        static int dbgFrames = 0;
        if (dbgFrames < 3) {
            ++dbgFrames;
            char lb[128];
            snprintf(lb, sizeof(lb), "d3d9 present active frame #%d dev=%p g_device=%p", dbgFrames, (void*)dev, (void*)g_device);
            LogLine(lb);
        }
        // 多设备自愈：引擎可能先建测试设备再建真设备（首建设备被释放）——ImGui 绑定设备与
        // 实际呈现设备不一致时重绑，防"渲染进已释放设备=静默不可见"
        if (g_imguiDev && g_imguiDev != dev) {
            ImGui_ImplDX9_Shutdown();
            ImGui_ImplDX9_Init(dev);
            g_imguiDev = dev;
            AvatarTexFlush(); // M5.8：旧设备头像纹理作废 + 向客户端要重发
            LogLine("imgui dx9 rebound to presenting device");
        }
        if (ImGuiEnsure9(dev)) {
            ImGui_ImplDX9_NewFrame();
            ImGui_ImplWin32_NewFrame();
            ImGui::NewFrame();
            ImGui::GetIO().MouseDrawCursor = panelOn; // 面板期自绘光标兜底；关面板期必须复位（否则 toast/角标帧残留软件光标叠在游戏光标上）
            if (panelOn) {
                DrawPanel();
            }
            DrawToasts(); // M5.5：通知 toast（面板关闭期也渲染；内部无 toast 时直接跳过）
            DrawRoomToasts(); // M5.10：房间消息左下角角标（面板关闭期；无条目整窗不建）
            ImGui::Render();
            // 注意：此处位于游戏 EndScene 之后（场景外渲染）。实测 场景外渲染长期稳定（160s+ 常开面板），
            // 而 BeginScene/EndScene 包裹反而在 ~130s 后确定性 d3d9 AV（实测踩坑，勿"按官方例程"改回去）
            ImGui_ImplDX9_RenderDrawData(ImGui::GetDrawData());
        } else {
            ReportNoPanelOnce(); // 面板起不来：热键收回悬浮窗（Shift+Tab 不能成死键）
        }
        InterlockedExchange(&g_exceptStreak, 0);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        // 绘制异常：跳过本帧绝不外抛；连续异常交看门狗自卸载
        LogLine("d3d9 present draw EXCEPTION"); // 诊断：静默异常可见化
        if (InterlockedIncrement(&g_exceptStreak) > 100) InterlockedExchange(&g_shutdown, 1);
    }
}
// 设备虚表槽补丁（幂等）：实例虚表指针被引擎换成拷贝表时在新表重打（orig 取当前槽位值，链路不中断）
static bool PatchDeviceVtableSlots(IDirect3DDevice9* dev) {
    if (!dev) return false;
    void** vt = *(void***)dev;
    if (g_origPresent && vt == g_vtDevBase && vt[17] == (void*)&Hooked_Present) return true; // 完好
    DWORD old = 0;
    if (!VirtualProtect(&vt[16], sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) return false;
    bool changed = false;
    if (vt[16] != (void*)&Hooked_Reset) { g_origReset = (PFN_Reset)vt[16]; vt[16] = (void*)&Hooked_Reset; changed = true; }
    if (vt[17] != (void*)&Hooked_Present) { g_origPresent = (PFN_Present)vt[17]; vt[17] = (void*)&Hooked_Present; changed = true; }
    g_vtDevSlot = &vt[16];
    g_vtDevBase = vt;
    VirtualProtect(&vt[16], sizeof(void*) * 2, old, &old);
    if (changed) LogLine(g_origPresent ? "device vtable swapped by engine, Present/Reset re-applied" : "Present/Reset vtable hooked");
    return true;
}
// 隐式交换链 Present 补钩（第二呈现路径：引擎可能 GetSwapChain(0) 后走交换链呈现，绕过 Device::Present）
static void HookImplicitSwapChain(IDirect3DDevice9* dev) {
    if (g_vtSCSlot || !dev) return;
    IDirect3DSwapChain9* sc = NULL;
    if (FAILED(dev->GetSwapChain(0, &sc)) || !sc) return;
    void** vt = *(void***)sc;
    DWORD old = 0;
    if (vt[3] != (void*)&Hooked_SCPresent &&
        VirtualProtect(&vt[3], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
        g_origSCPresent = vt[3];
        vt[3] = (void*)&Hooked_SCPresent;
        g_vtSCSlot = &vt[3];
        LogLine("implicit swapchain Present hooked");
        VirtualProtect(&vt[3], sizeof(void*), old, &old);
    }
    sc->Release();
}
static HRESULT WINAPI Hooked_SCPresent(IDirect3DSwapChain9* sc, CONST RECT* src, CONST RECT* dst, HWND wnd, CONST RGNDATA* dirty, DWORD flags) {
    if (!g_shutdown) {
        IDirect3DDevice9* dev = NULL;
        if (SUCCEEDED(sc->GetDevice(&dev)) && dev) {
            InterlockedExchange(&g_scLastTick, (LONG)GetTickCount()); // 宣告归属：Device::Present 钩让位
            RenderPanelFrame(dev); // M5.5：内部按 panelOn/toast 自判（无可渲染内容早退）
            dev->Release();
        }
    }
    return ((PFN_SCPresent_t)g_origSCPresent)(sc, src, dst, wnd, dirty, flags);
}
static HRESULT WINAPI Hooked_CreateDevice(IDirect3D9* self, UINT adapter, D3DDEVTYPE type, HWND hFocus, DWORD behavior, D3DPRESENT_PARAMETERS* pp, IDirect3DDevice9** out) {
    HRESULT hr = g_origCreateDevice(self, adapter, type, hFocus, behavior, pp, out);
    if (g_probeBusy) return hr; // 探针自建设备：不捕获（防探针设备被当游戏设备、释放后悬空）
    if (SUCCEEDED(hr) && out && *out) {
        char line[128];
        snprintf(line, sizeof(line), "device captured hwnd=%p, hooking Present/Reset", (void*)hFocus);
        LogLine(line);
        g_device = *out; // 总是记录最新设备（引擎可能先建测试设备再建真设备；渲染以 Present 实参设备为准）
        g_gameHwnd = hFocus;
        PatchDeviceVtableSlots(*out); // Present/Reset 槽补丁（幂等；防重复钩——二次 create 重补会把 orig 覆写成钩自身→递归）
        HookImplicitSwapChain(*out);  // 隐式交换链 Present 补钩（第二呈现路径）
        // 立即初始化 ImGui + WndProc 子类化（不能等首次激活帧：Shift+Tab 检测依赖 WndProc 钩，
        // 若钩子等激活后才装，第一次呼出会被原窗口过程吞掉——时序死锁，实测踩坑）
        ImGuiEnsure9(*out);
    }
    return hr;
}
static IDirect3D9* WINAPI Hooked_Direct3DCreate9(UINT sdk) {
    IDirect3D9* d3d = g_origD3DCreate9(sdk);
    if (d3d && !g_origCreateDevice) {
        void** vt = *(void***)d3d;
        DWORD old = 0;
        if (VirtualProtect(&vt[16], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
            g_vtD3d9Slot = &vt[16];
            g_origCreateDevice = (PFN_CreateDevice)vt[16];
            vt[16] = (void*)&Hooked_CreateDevice; // 虚表指针交换：捕获游戏设备指针
            VirtualProtect(&vt[16], sizeof(void*), old, &old);
            LogLine("CreateDevice vtable hooked");
        }
    }
    return d3d;
}

// ===== M4 子进程跟随注入（启动器型游戏：启动器拉起游戏进程时自动跟随）=====
// 链路：客户端 pipe 下发 follow 帧（兼容名单）→ DLL 存名单 + IAT hook CreateProcessW/A →
// 启动器拉起进程时：exe 名在名单内 → 以 CREATE_SUSPENDED 重建 → 注入自身 DLL → resume →
// 经父 pipe 上报 child 帧（客户端为子进程建 pipe，好友/房间推流闭环）。
// 门禁三重：名单 exe 名匹配 / 位数一致（跨位跳过）/ 深度限 2（防递归跟随）。
static char g_followMode[8] = { 0 };        // "all"/"list"/""（空=未收到 follow 帧，不跟随）
static wchar_t g_followList[24][64] = { 0 }; // exe 名（小写宽字符）
static int g_followCount = 0;
static volatile LONG g_followDepth = 0;     // 跟随深度（限 2：启动器→游戏→游戏内子进程）

static void HandleFollowFrame(const char* line) {
    JsonStr(line, "mode", g_followMode, sizeof(g_followMode));
    g_followCount = 0;
    ZeroMemory(g_followList, sizeof(g_followList));
    const char* arr = strstr(line, "\"list\"");
    if (!arr) return;
    arr = strchr(arr, '[');
    if (!arr) return;
    const char* p = arr + 1;
    while (*p && *p != ']' && g_followCount < 24) {
        while (*p == ' ' || *p == ',') ++p;
        if (*p != '"') break;
        ++p;
        char u[64] = { 0 };
        int i = 0;
        while (*p && *p != '"' && i < 62) u[i++] = *p++;
        u[i] = 0;
        if (*p == '"') ++p;
        wchar_t wu[64];
        if (MultiByteToWideChar(CP_UTF8, 0, u, -1, wu, 64) > 0) {
            // 统一小写（比对用）
            for (wchar_t* q = wu; *q; ++q) if (*q >= L'A' && *q <= L'Z') *q += 32;
            lstrcpynW(g_followList[g_followCount], wu, 64);
            g_followCount++;
        }
        // 循环头自动跳过元素间逗号/空白（exe 名为文件名不含逗号）
    }
    char lb[48];
    snprintf(lb, sizeof(lb), "follow list: mode=%s count=%d", g_followMode[0] ? g_followMode : "?", g_followCount);
    LogLine(lb);
    HookCreateProcessIAT(); // 名单到达即挂 CreateProcess 钩（IAT 对 x86/x64 通用；启动器动态 GetProcAddress 的场景漏——降级悬浮窗）
}

// 枚举本进程最大可见顶层窗口（探针路径的 Win32 后端窗口来源；CreateDevice 路径用 hFocusWindow）
static HWND FindMainWindowOfCurrentProcess() {
    DWORD pid = GetCurrentProcessId();
    struct Ctx { DWORD pid; HWND best; DWORD area; };
    Ctx ctx = { pid, NULL, 0 };
    WNDENUMPROC unused = NULL; // 占位防误用（实际用下方 lambda 化的静态回调）
    struct Thunk { static BOOL CALLBACK Cb(HWND h, LPARAM lp) {
        Ctx* c = (Ctx*)lp;
        DWORD p = 0;
        GetWindowThreadProcessId(h, &p);
        if (p != c->pid || !IsWindowVisible(h)) return TRUE;
        RECT r;
        if (!GetWindowRect(h, &r)) return TRUE;
        DWORD a = (DWORD)((r.right - r.left) * (r.bottom - r.top));
        if (a > c->area && (r.right - r.left) > 64 && (r.bottom - r.top) > 64) { c->area = a; c->best = h; }
        return TRUE;
    } };
    EnumWindows(Thunk::Cb, (LPARAM)&ctx);
    return ctx.best;
}
#ifndef _WIN64
// ===== D3D8 适配层（M3；D3D8 仅有 x86 运行时）=====
// 用 void* 风格函数指针 + 裸虚表槽位，避免 d3d8.h 与 d3d9.h 同 TU 重定义冲突；
// ImGui 的 D3D8 后端在独立 TU（imgui_impl_d3d8.cpp，其内包含 third_party/d3d8 头）。
// 虚表槽位（ReactOS d3d8.h 头顺序核对）：IDirect3D8::CreateDevice=15；
// IDirect3DDevice8::Reset=14、Present=15（各比 D3D9 前移一位）
typedef void*   (WINAPI* PFN_Direct3DCreate8_t)(UINT);
typedef HRESULT (WINAPI* PFN_CreateDevice8_t)(void*, UINT, UINT, HWND, DWORD, void*, void**);
typedef HRESULT (WINAPI* PFN_Present8_t)(void*, CONST RECT*, CONST RECT*, HWND, CONST RGNDATA*);
typedef HRESULT (WINAPI* PFN_Reset8_t)(void*, void*);

static void* g_origCreateDevice8 = NULL;
static void* g_origPresent8 = NULL;
static void* g_origReset8 = NULL;
static void** g_vtD3d8Slot = NULL;
static void** g_vtDev8Slot = NULL;
static void*  g_device8 = NULL;
static PFN_Direct3DCreate8_t g_origD3DCreate8 = NULL;
static bool ImGuiEnsure8(IDirect3DDevice8* dev8) {
    static bool inited = false;
    if (inited) return true;
    if (!dev8) return false;
    if (!g_gameHwnd) g_gameHwnd = FindMainWindowOfCurrentProcess(); // 探针路径无 CreateDevice 焦点窗口：枚举本进程主窗口
    if (!g_gameHwnd) return false;
    InitContextCommon();
    if (!ImGui_ImplWin32_Init(g_gameHwnd)) { LogLine("imgui win32 init failed (d3d8)"); return false; }
    if (!ImGui_ImplD3D8_Init(dev8)) { LogLine("imgui d3d8 init failed"); return false; }
    if (!ImGui_ImplD3D8_CreateDeviceObjects()) { LogLine("imgui d3d8 CreateDeviceObjects failed"); return false; } // 字体纹理+VB/IB+stateblock（dx9 后端惰性建于 NewFrame，D3D8 后端必须显式建——否则 NewFrame 撞 Font Atlas assert 阻塞主线程，实测踩坑）
    inited = true;
    LogLine("imgui initialized (msyh + d3d8 + win32)");
    InstallWndProcHook();
    InterlockedExchange(&g_panelBroken, 0); // 二轮审计修复：init 成功即清 broken（失败重试成功路径恢复切换）
    ReportPanelReadyOnce(); // 热键让位依据（d3d8 首帧初始化路径）
    return true;
}
static HRESULT WINAPI Hooked_Present8(void* dev, CONST RECT* src, CONST RECT* dst, HWND wnd, CONST RGNDATA* dirty) {
    if (g_shutdown) {
        if (!InterlockedExchange(&g_finalized, 1)) {
            UnhookAll();
            LogLine("shutdown: finalized on game thread (d3d8)");
        }
        return ((PFN_Present8_t)g_origPresent8)(dev, src, dst, wnd, dirty);
    }
    if (dev) {
        // 首帧无条件初始化（探针路径设备捕获不发生——WndProc 钩若等 Shift+Tab 会时序死锁，M2 踩坑 1 同款）
        static bool inited = false;
        if (!inited) {
            inited = true;
            if (ImGuiEnsure8((IDirect3DDevice8*)dev)) {
                char lb[64];
                snprintf(lb, sizeof(lb), "d3d8 present-path init ok (gameHwnd=%p)", (void*)g_gameHwnd);
                LogLine(lb);
            } else {
                ReportNoPanelOnce(); // 面板起不来：热键收回悬浮窗
            }
        }
    }
    // M5.10：D3D8 面板关闭期也渲染 toast/房间角标（与 D3D9 RenderPanelFrame 对称；此前 D3D8 关面板期 toast 静默丢失）
    bool d8render = g_panelActive != 0;
    if (!d8render && dev) {
        EnterCriticalSection(&g_cs);
        d8render = (g_toastCount + g_roomCornerN) > 0;
        LeaveCriticalSection(&g_cs);
    }
    if (d8render && dev && !g_panelBroken) {
        { // M3 诊断：Present 钩激活链路可见性（前 2 帧记录）
            static int logged = 0;
            if (logged < 2) {
                ++logged;
                char lbuf[96];
                snprintf(lbuf, sizeof(lbuf), "d3d8 present hook active frame #%d", logged);
                LogLine(lbuf);
            }
        }
        __try {
            if (ImGuiEnsure8((IDirect3DDevice8*)dev)) {
                ImGui_ImplD3D8_NewFrame();
                ImGui_ImplWin32_NewFrame();
                ImGui::NewFrame();
                ImGui::GetIO().MouseDrawCursor = (g_panelActive != 0); // 同 D3D9：关面板期复位，防残留软件光标
                if (g_panelActive) DrawPanel();
                DrawToasts();
                DrawRoomToasts(); // M5.10：房间角标（D3D8 对称）
                ImGui::Render();
                ImGui_ImplD3D8_RenderDrawData(ImGui::GetDrawData());
            } else {
                ReportNoPanelOnce(); // 面板起不来：热键收回悬浮窗
            }
            InterlockedExchange(&g_exceptStreak, 0);
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            LogLine("d3d8 present draw EXCEPTION"); // M3 诊断：区分"链路异常被吞"与"正常无绘制"
            if (InterlockedIncrement(&g_exceptStreak) > 100) InterlockedExchange(&g_shutdown, 1);
        }
    }
    return ((PFN_Present8_t)g_origPresent8)(dev, src, dst, wnd, dirty);
}
static HRESULT WINAPI Hooked_Reset8(void* dev, void* pp) {
    ImGui_ImplD3D8_InvalidateDeviceObjects();
    HRESULT hr = ((PFN_Reset8_t)g_origReset8)(dev, pp);
    if (SUCCEEDED(hr)) ImGui_ImplD3D8_CreateDeviceObjects();
    return hr;
}
static HRESULT WINAPI Hooked_CreateDevice8(void* self, UINT adapter, UINT type, HWND hFocus, DWORD behavior, void* pp, void** out) {
    PFN_CreateDevice8_t orig = (PFN_CreateDevice8_t)g_origCreateDevice8;
    HRESULT hr = orig(self, adapter, type, hFocus, behavior, pp, out);
    { // M3 排障：CreateDevice 调用可见性（前 3 次，含失败——War3 启动期探测性失败属正常）
        static int logged = 0;
        if (logged < 3) {
            ++logged;
            char lb[96];
            snprintf(lb, sizeof(lb), "d3d8 CreateDevice call #%d hr=0x%08lX out=%p", logged, (unsigned long)hr, (out ? *out : NULL));
            LogLine(lb);
        }
    }
    if (SUCCEEDED(hr) && out && *out && !g_device8) {
        char line[128];
        snprintf(line, sizeof(line), "d3d8 device captured hwnd=%p, hooking Present/Reset", (void*)hFocus);
        LogLine(line);
        g_device8 = *out;
        g_gameHwnd = hFocus;
        void** vt = *(void***)g_device8;
        DWORD old = 0;
        if (VirtualProtect(&vt[14], sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) {
            g_vtDev8Slot = &vt[14];
            g_origReset8 = vt[14];   vt[14] = (void*)&Hooked_Reset8;
            g_origPresent8 = vt[15]; vt[15] = (void*)&Hooked_Present8;
            VirtualProtect(&vt[14], sizeof(void*) * 2, old, &old);
            LogLine("d3d8 Present/Reset vtable hooked");
        }
        ImGuiEnsure8((IDirect3DDevice8*)*out); // 立即初始化（时序死锁教训同 D3D9，见 M2 踩坑 1）
    }
    return hr;
}
static void* WINAPI Hooked_Direct3DCreate8(UINT sdk) {
    void* d3d = g_origD3DCreate8(sdk);
    if (d3d && !g_origCreateDevice8) {
        void** vt = *(void***)d3d;
        DWORD old = 0;
        if (VirtualProtect(&vt[15], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
            g_vtD3d8Slot = &vt[15];
            g_origCreateDevice8 = vt[15];
            vt[15] = (void*)&Hooked_CreateDevice8;
            VirtualProtect(&vt[15], sizeof(void*), old, &old);
            LogLine("d3d8 CreateDevice vtable hooked");
        }
    }
    return d3d;
}
#endif // !_WIN64


// ===== M4 子进程跟随注入（启动器型游戏）=====
// 门禁：follow 名单（pipe 下发）匹配 + 位数一致 + 深度≤2。以 CREATE_SUSPENDED 重建消除
// "设备创建早于注入"的竞态（注入完成才 resume），并把 child 帧上报客户端（父 pipe）建子 pipe。
static int InjectSelfToProcess(HANDLE hProcess) {
    wchar_t dllPath[MAX_PATH];
    if (!GetModuleFileNameW(g_selfMod, dllPath, MAX_PATH)) return -1;
    BOOL wow = FALSE, selfWow = FALSE;
    IsWow64Process(hProcess, &wow);
    IsWow64Process(GetCurrentProcess(), &selfWow);
    if (wow != selfWow) return -2; // 位数不匹配（跨位跳过，不注入）
    SIZE_T bytes = (SIZE_T)(lstrlenW(dllPath) + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(hProcess, NULL, bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!remote) return -3;
    if (!WriteProcessMemory(hProcess, remote, dllPath, bytes, NULL)) { VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE); return -4; }
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC loadLib = GetProcAddress(k32, "LoadLibraryW");
    if (!loadLib) { VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE); return -5; }
    HANDLE th = CreateRemoteThread(hProcess, NULL, 0, (LPTHREAD_START_ROUTINE)loadLib, remote, 0, NULL);
    if (!th) { VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE); return -6; }
    DWORD wr = WaitForSingleObject(th, 10000);
    DWORD modBase = 0;
    GetExitCodeThread(th, &modBase);
#ifdef _WIN64
    DWORD64 modBase64 = modBase; // x64 下 ExitCodeThread 只回 32 位——用 GetExitCodeThread 高位丢失问题：
#endif
    CloseHandle(th);
    VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
    if (wr != WAIT_OBJECT_0) return -7;
    if (modBase == 0) return -8; // 目标进程内加载失败
    return 0;
}
static BOOL ShouldFollowChild(LPCWSTR lpAppName, LPCWSTR lpCmdLine) {
    if (g_followDepth >= 2) return false;                       // 深度限制
    if (g_followCount == 0 && _stricmp(g_followMode, "all") != 0) return false; // 未收到名单或空名单
    if (_stricmp(g_followMode, "all") == 0) return true;
    // 取子进程 exe 文件名（lpApplicationName 优先，否则命令行首段；带引号路径先去引号）
    wchar_t exe[MAX_PATH] = { 0 };
    LPCWSTR src = lpAppName;
    if (!src && lpCmdLine) {
        src = (*lpCmdLine == L'"') ? lpCmdLine + 1 : lpCmdLine;
    }
    if (!src) return false;
    LPCWSTR end = src;
    while (*end && *end != L'"' && *end != L' ') ++end;
    LPCWSTR slash = src;
    for (LPCWSTR q = src; q < end; ++q) if (*q == L'\\' || *q == L'/') slash = q + 1;
    lstrcpynW(exe, slash, (int)(end - slash) + 1);
    for (wchar_t* q = exe; *q; ++q) if (*q >= L'A' && *q <= L'Z') *q += 32;
    for (int i = 0; i < g_followCount; ++i) {
        if (lstrcmpiW(exe, g_followList[i]) == 0) return true;
    }
    return false;
}
typedef BOOL (WINAPI* PFN_CreateProcessW_t)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
typedef BOOL (WINAPI* PFN_CreateProcessA_t)(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION);
typedef FARPROC (WINAPI* PFN_GetProcAddress_t)(HMODULE, LPCSTR);
static PFN_CreateProcessW_t g_origCPW = NULL;
static PFN_CreateProcessA_t g_origCPA = NULL;
static PFN_GetProcAddress_t g_origGPA = NULL;

// 前置声明：Hooked_GetProcAddress 需返回下方定义的 CreateProcess/ShellExecute 钩地址
static BOOL WINAPI Hooked_CreateProcessW(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
static BOOL WINAPI Hooked_CreateProcessA(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION);
static HINSTANCE WINAPI Hooked_ShellExecuteA(HWND, LPCSTR, LPCSTR, LPCSTR, LPCSTR, INT);
static HINSTANCE WINAPI Hooked_ShellExecuteW(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT);

// 启动器防 hook 惯例：IAT 里的 CreateProcessA 被改后，运行时用 GetProcAddress 动态重解析绕开
//（真机 GameCdonl 实测：IAT hooked 成功但进对局无 child 日志）。钩掉 IAT 里的 GetProcAddress，
// 动态解析 CreateProcessA/W、ShellExecuteA/W 时直接返回我们的钩（双覆盖：IAT 直调 + 动态解析都进钩）。
// g_origGPA NULL 竞态兜底（IAT 换入与赋值间极小窗口他线程可调到）：直调自身导入——HookIAT 只扫主 exe
// 的导入表（GetModuleHandleW(NULL)），本 DLL 自身 IAT 未被改，无递归风险
static FARPROC WINAPI Hooked_GetProcAddress(HMODULE mod, LPCSTR name) {
    if (!g_origGPA) return ::GetProcAddress(mod, name);
    FARPROC r = g_origGPA(mod, name);
    if (r && name) {
        if (mod == GetModuleHandleW(L"kernel32.dll")) {
            if (lstrcmpiA(name, "CreateProcessA") == 0) return (FARPROC)&Hooked_CreateProcessA;
            if (lstrcmpiA(name, "CreateProcessW") == 0) return (FARPROC)&Hooked_CreateProcessW;
        } else if (mod == GetModuleHandleW(L"shell32.dll")) {
            if (lstrcmpiA(name, "ShellExecuteA") == 0) return (FARPROC)&Hooked_ShellExecuteA;
            if (lstrcmpiA(name, "ShellExecuteW") == 0) return (FARPROC)&Hooked_ShellExecuteW;
        }
    }
    return r;
}

static void ReportChildAndPipe(DWORD childPid) {
    char frame[96];
    snprintf(frame, sizeof(frame), "{\"t\":\"child\",\"pid\":%lu}\n", childPid);
    PipePushOut(frame); // 客户端收到后为子进程建 pipe server（好友/房间推流闭环）
}
static BOOL WINAPI Hooked_CreateProcessW(LPCWSTR lpAppName, LPWSTR lpCmdLine, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta, BOOL bInherit, DWORD flags, LPVOID env, LPCWSTR curDir, LPSTARTUPINFOW si, LPPROCESS_INFORMATION pi) {
    if (!g_origCPW) return ::CreateProcessW(lpAppName, lpCmdLine, pa, ta, bInherit, flags, env, curDir, si, pi); // IAT 换入与赋值间竞态兜底（自身导入未被钩，无递归）
    BOOL wantFollow = ShouldFollowChild(lpAppName, lpCmdLine);
    DWORD newFlags = wantFollow ? (flags | CREATE_SUSPENDED) : flags;
    BOOL ok = g_origCPW(lpAppName, lpCmdLine, pa, ta, bInherit, newFlags, env, curDir, si, pi);
    if (ok && wantFollow && pi->hProcess && pi->hThread) {
        int rc = InjectSelfToProcess(pi->hProcess);
        char lb[96];
        snprintf(lb, sizeof(lb), "follow: child pid=%lu inject rc=%d", pi->dwProcessId, rc);
        LogLine(lb);
        if (rc == 0) ReportChildAndPipe(pi->dwProcessId);
        ResumeThread(pi->hThread); // 抵消 CREATE_SUSPENDED（计数制，启动器重复 resume 无害）
    }
    return ok;
}
static BOOL WINAPI Hooked_CreateProcessA(LPCSTR lpAppName, LPSTR lpCmdLine, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta, BOOL bInherit, DWORD flags, LPVOID env, LPCSTR curDir, LPSTARTUPINFOA si, LPPROCESS_INFORMATION pi) {
    if (!g_origCPA) return ::CreateProcessA(lpAppName, lpCmdLine, pa, ta, bInherit, flags, env, curDir, si, pi); // 竞态兜底（同上）
    // A 版：命令行转宽判定（同名单语义），实际透传原 A 版
    wchar_t wApp[MAX_PATH] = { 0 }, wCmd[1024] = { 0 }, wDir[MAX_PATH] = { 0 };
    if (lpAppName) MultiByteToWideChar(CP_ACP, 0, lpAppName, -1, wApp, MAX_PATH);
    if (lpCmdLine) MultiByteToWideChar(CP_ACP, 0, lpCmdLine, -1, wCmd, 1024);
    if (curDir) MultiByteToWideChar(CP_ACP, 0, curDir, -1, wDir, MAX_PATH);
    BOOL wantFollow = ShouldFollowChild(lpAppName ? wApp : NULL, lpCmdLine ? wCmd : NULL);
    DWORD newFlags = wantFollow ? (flags | CREATE_SUSPENDED) : flags;
    BOOL ok = g_origCPA(lpAppName, lpCmdLine, pa, ta, bInherit, newFlags, env, curDir, si, pi);
    if (ok && wantFollow && pi->hProcess && pi->hThread) {
        int rc = InjectSelfToProcess(pi->hProcess);
        char lb[96];
        snprintf(lb, sizeof(lb), "follow: child pid=%lu inject rc=%d (A)", pi->dwProcessId, rc);
        LogLine(lb);
        if (rc == 0) ReportChildAndPipe(pi->dwProcessId);
        ResumeThread(pi->hThread);
    }
    return ok;
}

// 启动器拉起游戏的第二路径：ShellExecuteA/W（真机 GameCdonl dumpbin：IAT 含 ShellExecuteA）。
// ShellExecute 无 CREATE_SUSPENDED 介入点 → 透传后异步轮询进程快照按 exe 名补注入
//（DLL 对晚注入自带 2 分钟 d3d9 等待窗口；设备已创建的场景同样能捕获虚表）
typedef HINSTANCE (WINAPI* PFN_ShellExecuteA_t)(HWND, LPCSTR, LPCSTR, LPCSTR, LPCSTR, INT);
typedef HINSTANCE (WINAPI* PFN_ShellExecuteW_t)(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT);
static PFN_ShellExecuteA_t g_origSEA = NULL;
static PFN_ShellExecuteW_t g_origSEW = NULL;

static bool FollowNameMatch(LPCWSTR file) {
    if (!file || !*file) return false;
    while (*file == L'"') ++file; // 引号容错（lpFile 理论可带引号）
    if (!*file) return false;
    if (_stricmp(g_followMode, "all") == 0) { // 全量模式：仅认 .exe 结尾（ShellExecute 也用于开 URL/文档）
        size_t n = lstrlenW(file);
        if (n && file[n - 1] == L'"') n--; // 去尾引号
        return n >= 4 && _wcsicmp(file + n - 4, L".exe") == 0;
    }
    // 名单模式：basename 比对（lstrcmpiW 大小写不敏感，名单存的是小写；止于引号防带参路径）
    LPCWSTR base = file;
    for (LPCWSTR q = file; *q && *q != L'"'; ++q) if (*q == L'\\' || *q == L'/') base = q + 1;
    wchar_t name[64];
    size_t n2 = 0;
    while (base[n2] && base[n2] != L'"' && n2 < 63) { name[n2] = base[n2]; ++n2; }
    name[n2] = 0;
    for (int i = 0; i < g_followCount; ++i) {
        if (lstrcmpiW(name, g_followList[i]) == 0) return true;
    }
    return false;
}
static DWORD WINAPI FollowScanThread(LPVOID param) {
    wchar_t* exe = (wchar_t*)param; // heap（FollowShellSpawnAsync 分配，本线程释放）
    bool done = false;
    for (int i = 0; i < 40 && !g_shutdown && !done; ++i) { // ~20s：进程可能延迟数秒才出现
        Sleep(500);
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE) continue;
        PROCESSENTRY32W pe;
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
            do {
                if (pe.th32ProcessID == GetCurrentProcessId()) continue;
                if (_wcsicmp(pe.szExeFile, exe) != 0) continue;
                HANDLE p = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE |
                                       PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pe.th32ProcessID);
                if (!p) continue;
                int rc = InjectSelfToProcess(p);
                CloseHandle(p);
                char lb[96];
                snprintf(lb, sizeof(lb), "follow(SE): pid=%lu inject rc=%d", pe.th32ProcessID, rc);
                LogLine(lb);
                if (rc == 0) { ReportChildAndPipe(pe.th32ProcessID); done = true; }
            } while (!done && Process32NextW(snap, &pe));
        }
        CloseHandle(snap);
    }
    free(exe);
    return 0;
}
static void FollowShellSpawnAsync(LPCWSTR file) {
    if (!FollowNameMatch(file)) return;
    size_t n = lstrlenW(file) + 1;
    wchar_t* copy = (wchar_t*)malloc(n * sizeof(wchar_t));
    if (!copy) return;
    lstrcpynW(copy, file, (int)n);
    HANDLE th = CreateThread(NULL, 0, FollowScanThread, copy, 0, NULL);
    if (th) CloseHandle(th); else free(copy);
}
static HINSTANCE WINAPI Hooked_ShellExecuteA(HWND hwnd, LPCSTR verb, LPCSTR file, LPCSTR params, LPCSTR dir, INT show) {
    if (!g_origSEA) return ::ShellExecuteA(hwnd, verb, file, params, dir, show); // 竞态兜底（同 CreateProcess）
    HINSTANCE r = g_origSEA(hwnd, verb, file, params, dir, show);
    if (!g_shutdown) {
        wchar_t wfile[MAX_PATH] = { 0 };
        if (file) MultiByteToWideChar(CP_ACP, 0, file, -1, wfile, MAX_PATH);
        if (wfile[0]) FollowShellSpawnAsync(wfile);
    }
    return r;
}
static HINSTANCE WINAPI Hooked_ShellExecuteW(HWND hwnd, LPCWSTR verb, LPCWSTR file, LPCWSTR params, LPCWSTR dir, INT show) {
    if (!g_origSEW) return ::ShellExecuteW(hwnd, verb, file, params, dir, show);
    HINSTANCE r = g_origSEW(hwnd, verb, file, params, dir, show);
    if (!g_shutdown) FollowShellSpawnAsync(file);
    return r;
}
static void HookCreateProcessIAT() {
    if (g_followCount == 0 && _stricmp(g_followMode, "all") != 0) { LogLine("follow list empty, skip CreateProcess hook"); return; } // 未收到名单：不挂
    bool ok = false;
    void* orig = NULL;
    if (HookIAT("kernel32.dll", "CreateProcessW", (void*)&Hooked_CreateProcessW, &orig)) { g_origCPW = (PFN_CreateProcessW_t)orig; ok = true; }
    orig = NULL;
    if (HookIAT("kernel32.dll", "CreateProcessA", (void*)&Hooked_CreateProcessA, &orig)) { g_origCPA = (PFN_CreateProcessA_t)orig; ok = true; }
    // GetProcAddress 钩：覆盖启动器动态解析 CreateProcessA/W 绕 IAT 的路径（真机 GameCdonl 实测存在）
    if (g_origCPW || g_origCPA) { // 先有直调钩，GPA 钩返回的钩子才有 g_origCPx 可透传
        orig = NULL;
        if (HookIAT("kernel32.dll", "GetProcAddress", (void*)&Hooked_GetProcAddress, &orig)) { g_origGPA = (PFN_GetProcAddress_t)orig; ok = true; }
    }
    // ShellExecuteA/W 钩：启动器第二拉起路径（真机 dumpbin IAT 含 ShellExecuteA）
    orig = NULL;
    if (HookIAT("shell32.dll", "ShellExecuteA", (void*)&Hooked_ShellExecuteA, &orig)) { g_origSEA = (PFN_ShellExecuteA_t)orig; ok = true; }
    orig = NULL;
    if (HookIAT("shell32.dll", "ShellExecuteW", (void*)&Hooked_ShellExecuteW, &orig)) { g_origSEW = (PFN_ShellExecuteW_t)orig; ok = true; }
    LogLine(ok ? "CreateProcess/ShellExecute IAT hooked (follow enabled)" : "CreateProcess IAT hook failed");
}



// ===== 看门狗（M2）：pipe 断连超时/从未连上/绘制异常超限 → 自卸载（绝不拖死游戏）=====
// 卸载序列：置 g_shutdown → 等 DLL 自有线程退出（超时即放弃卸载保持常驻）→ 摘 WndProc/虚表钩 →
// ImGui 关停 → 还原热补丁字节并释放 trampoline → FreeLibraryAndExitThread
static HANDLE g_hInitThread = NULL;
static HANDLE g_hPipeThread = NULL;

static void UnhookAll() {
    LogLine("unhook: begin");
    RestoreWndProc();
    // 虚表还原（d3d9 运行时虚表为静态内存，设备释放后槽地址仍有效）。
    // 槽位注意：vt[16]=Reset、vt[17]=Present（与安装处一致）——装反会让游戏每帧 Present 调到
    // Reset，数秒内 d3d9.dll AV（实测踩坑：卸载后游戏必死且日志无痕）
    if (g_vtDevSlot && g_origPresent && g_origReset) {
        DWORD old = 0;
        if (VirtualProtect(g_vtDevSlot, sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) {
            g_vtDevSlot[0] = (void*)g_origReset;   // vt[16] = Reset
            g_vtDevSlot[1] = (void*)g_origPresent; // vt[17] = Present
            VirtualProtect(g_vtDevSlot, sizeof(void*) * 2, old, &old);
            LogLine("unhook: Present/Reset vtable restored");
        }
    }
    g_vtDevSlot = NULL;
    if (g_vtD3d9Slot && g_origCreateDevice) {
        DWORD old = 0;
        if (VirtualProtect(g_vtD3d9Slot, sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
            *g_vtD3d9Slot = (void*)g_origCreateDevice;
            VirtualProtect(g_vtD3d9Slot, sizeof(void*), old, &old);
            LogLine("unhook: CreateDevice vtable restored");
        }
    }
    g_vtD3d9Slot = NULL;
#ifndef _WIN64
    // M3：D3D8 槽还原（vt[14]=Reset、vt[15]=Present，与安装处一致）
    if (g_vtDev8Slot && g_origPresent8 && g_origReset8) {
        DWORD old = 0;
        if (VirtualProtect(g_vtDev8Slot, sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) {
            g_vtDev8Slot[0] = g_origReset8;
            g_vtDev8Slot[1] = g_origPresent8;
            VirtualProtect(g_vtDev8Slot, sizeof(void*) * 2, old, &old);
            LogLine("unhook: d3d8 Present/Reset vtable restored");
        }
    }
    g_vtDev8Slot = NULL;
    if (g_vtD3d8Slot && g_origCreateDevice8) {
        DWORD old = 0;
        if (VirtualProtect(g_vtD3d8Slot, sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
            *g_vtD3d8Slot = g_origCreateDevice8;
            VirtualProtect(g_vtD3d8Slot, sizeof(void*), old, &old);
            LogLine("unhook: d3d8 CreateDevice vtable restored");
        }
    }
    g_vtD3d8Slot = NULL;
#endif
    LogLine("unhook: imgui kept alive (see comment)");
    // ImGui 上下文/后端刻意不关停：实测 ImGui_ImplDX9_Shutdown 释放后端 D3D 资源后数秒内
    // d3d9.dll Present 必 AV（三次复现，与执行线程无关——收尾已挪到游戏线程仍崩）；
    // 摘钩后 ImGui 本就零渲染零开销，资源随进程退出统一回收， Dormant 且无害
    LogLine("unhook: unpatch begin");
    UnpatchHotPatch();
    LogLine("unhook: done");
}
static DWORD WINAPI WatchdogThread(LPVOID) {
    DWORD loadTick = GetTickCount();
    bool everConnected = false;
    DWORD lostTick = 0;
    for (;;) {
        Sleep(500);
        if (g_shutdown) break;
        if (g_pipeConnected) { everConnected = true; lostTick = 0; continue; }
        if (everConnected) {
            if (!lostTick) lostTick = GetTickCount();
            if (GetTickCount() - lostTick > K_PIPE_LOST_MS) { LogLine("watchdog: pipe lost timeout"); break; }
        } else if (GetTickCount() - loadTick > K_PIPE_FIRST_MS) { LogLine("watchdog: pipe never connected"); break; }
    }
    if (!g_shutdown) {
        LogLine("watchdog: starting self-unload");
        InterlockedExchange(&g_shutdown, 1);
    } else {
        LogLine("watchdog: shutdown requested, unloading");
    }
    // 等 DLL 自有线程退出（超时放弃卸载：带线程强卸会踩已卸载代码页，宁可常驻）
    if (g_hPipeThread) {
        if (WaitForSingleObject(g_hPipeThread, 5000) != WAIT_OBJECT_0) { LogLine("watchdog: pipe thread stuck, abort unload"); return 0; }
    }
    if (g_hInitThread) {
        if (WaitForSingleObject(g_hInitThread, 5000) != WAIT_OBJECT_0) { LogLine("watchdog: init thread stuck, abort unload"); return 0; }
    }
    // 摘钩收尾必须在游戏线程执行（看门狗线程释放 D3D 资源会与在飞设备调用竞态，实测 d3d9.dll 内 AV）：
    // 游戏线程下一次进 Present 钩时一次性 UnhookAll（见 Hooked_Present），此处只等标记
    for (int i = 0; i < 50 && !g_finalized; ++i) Sleep(100);
    if (!g_finalized) { LogLine("watchdog: game thread idle (minimized/paused), finalize deferred, hooks kept"); return 0; }
    LogLine("watchdog: logical unload done (all hooks removed on game thread, dll kept mapped)");
    return 0;
}

// ===== 初始化线程：先挂 LoadLibrary 钩（零竞态根治）→ 查模块表 → 50ms 轮询兜底 =====
// 真实游戏（War3）动态加载 d3d8.dll 后 <50ms 即调 create8——轮询粒度追不上竞态（500ms/50ms 实测均会错过，
// 补丁就位时调用已发生且游戏单次调用不再重试）。根治：hotpatch kernel32!LoadLibraryW/A/ExW/ExA，
// 目标模块加载完成瞬间（返回前不可能调 create8）立即挂钩；轮询仅兜底"注入前已加载"的静态导入场景。
static bool TryHookD3D9(HMODULE d3d9);
#ifndef _WIN64
static bool TryHookD3D8(HMODULE d3d8);
#endif

typedef HMODULE (WINAPI* PFN_LoadLibraryW_t)(LPCWSTR);
typedef HMODULE (WINAPI* PFN_LoadLibraryA_t)(LPCSTR);
typedef HMODULE (WINAPI* PFN_LoadLibraryExW_t)(LPCWSTR, HANDLE, DWORD);
typedef HMODULE (WINAPI* PFN_LoadLibraryExA_t)(LPCSTR, HANDLE, DWORD);
static PFN_LoadLibraryW_t   g_origLLW = NULL;
static PFN_LoadLibraryA_t   g_origLLA = NULL;
static PFN_LoadLibraryExW_t g_origLLExW = NULL;
static PFN_LoadLibraryExA_t g_origLLExA = NULL;

// 模块加载后处理：d3d8/d3d9 → 挂钩（幂等）；返回是否命中目标模块
static bool PostLoadCheck(HMODULE mod) {
    if (!mod) return false;
    wchar_t path[MAX_PATH];
    if (GetModuleFileNameW(mod, path, MAX_PATH) == 0) return false;
    wchar_t* fn = path + lstrlenW(path);
    while (fn > path && fn[-1] != L'\\' && fn[-1] != L'/') --fn;
    if (_wcsicmp(fn, L"d3d9.dll") == 0) {
        if (!g_origD3DCreate9) TryHookD3D9(mod);
        return true;
    }
#ifndef _WIN64
    if (_wcsicmp(fn, L"d3d8.dll") == 0) {
        if (!g_origD3DCreate8) TryHookD3D8(mod);
        return true;
    }
#endif
    return false;
}
static HMODULE WINAPI Hooked_LoadLibraryW(LPCWSTR name) {
    HMODULE m = g_origLLW(name);
    PostLoadCheck(m);
    return m;
}
static HMODULE WINAPI Hooked_LoadLibraryA(LPCSTR name) {
    HMODULE m = g_origLLA(name);
    PostLoadCheck(m);
    return m;
}
static HMODULE WINAPI Hooked_LoadLibraryExW(LPCWSTR name, HANDLE file, DWORD flags) {
    HMODULE m = g_origLLExW(name, file, flags);
    PostLoadCheck(m);
    return m;
}
static HMODULE WINAPI Hooked_LoadLibraryExA(LPCSTR name, HANDLE file, DWORD flags) {
    HMODULE m = g_origLLExA(name, file, flags);
    PostLoadCheck(m);
    return m;
}
static bool HookLoadLibraries() {
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    if (!k32) return false;
    struct { const char* fn; void* hook; void** orig; } targets[] = {
        { "LoadLibraryW",   (void*)&Hooked_LoadLibraryW,   (void**)&g_origLLW },
        { "LoadLibraryA",   (void*)&Hooked_LoadLibraryA,   (void**)&g_origLLA },
        { "LoadLibraryExW", (void*)&Hooked_LoadLibraryExW, (void**)&g_origLLExW },
        { "LoadLibraryExA", (void*)&Hooked_LoadLibraryExA, (void**)&g_origLLExA }
    };
    int okN = 0;
    for (int i = 0; i < 4; ++i) {
        void* target = (void*)GetProcAddress(k32, targets[i].fn);
        if (!target) continue;
        void* tramp = NULL;
        if (HotPatch(target, targets[i].hook, &tramp)) {
            *targets[i].orig = tramp;
            okN++;
        }
    }
#ifdef _WIN64
    // x64 kernel32 导出普遍无热补丁头（实测 0/4）→ IAT hook 兜底：改主 exe 导入表的
    // LoadLibraryW/A 项（启动器/游戏静态调用 LoadLibrary 的场景覆盖；动态 GetProcAddress 漏）
    void* orig = NULL;
    if (HookIAT("kernel32.dll", "LoadLibraryW", (void*)&Hooked_LoadLibraryW, &orig)) { g_origLLW = (PFN_LoadLibraryW_t)orig; okN++; }
    orig = NULL;
    if (HookIAT("kernel32.dll", "LoadLibraryA", (void*)&Hooked_LoadLibraryA, &orig)) { g_origLLA = (PFN_LoadLibraryA_t)orig; okN++; }
#endif
    char lb[64];
    snprintf(lb, sizeof(lb), "LoadLibrary hooks installed: %d/4", okN);
    LogLine(lb);
    return okN > 0;
}

// TryHookD3D9/D3D8：hotpatch 优先（x86 惯例头）→ IAT hook 兜底（x64 必经/加壳降级）
// 钩子来源（决定是否需要 Loader 绑定竞态重校验）：0=hotpatch 1=主 exe IAT 2=全模块 IAT
static int g_d3d9HookVia = 0;
static bool TryHookD3D9(HMODULE d3d9) {
    if (!d3d9) return false;
    if (g_origD3DCreate9) return true; // 幂等
    void* target = (void*)GetProcAddress(d3d9, "Direct3DCreate9");
    if (!target) { LogLine("Direct3DCreate9 export not found"); return false; }
    void* tramp = NULL;
    if (HotPatch(target, (void*)&Hooked_Direct3DCreate9, &tramp)) {
        g_origD3DCreate9 = (PFN_Direct3DCreate9)tramp;
        g_patchTarget = target;
        g_d3d9HookVia = 0;
        LogLine("Direct3DCreate9 hotpatched, waiting for device creation");
        return true;
    }
    if (HookIAT("d3d9.dll", "Direct3DCreate9", (void*)&Hooked_Direct3DCreate9, (void**)&g_origD3DCreate9)) {
        g_d3d9HookVia = 1;
        LogLine("Direct3DCreate9 IAT hooked in main exe (no hotpatch prologue, x64/mangled prologue path)");
        return true;
    }
    // 渲染器 DLL 才导入 Direct3DCreate9 的游戏（主 exe 导入表无 d3d9 项，实测 Warface/GameCdonl：
    // CryRenderD3D9.dll 动态加载，游戏对局/大厅渲染全部经它）→ 枚举全部已加载模块补丁
    int n = HookIATAllModules("d3d9.dll", "Direct3DCreate9", (void*)&Hooked_Direct3DCreate9, (void**)&g_origD3DCreate9);
    if (n > 0) {
        g_d3d9HookVia = 2;
        char lb[64];
        snprintf(lb, sizeof(lb), "Direct3DCreate9 IAT hooked in %d module(s)", n);
        LogLine(lb);
        return true;
    }
    static bool failLogged = false;
    if (!failLogged) {
        failLogged = true;
        LogLine("d3d9 hook failed (hotpatch + IAT + all-modules), probe fallback pending"); // 探针为最终兜底，失败不再刷屏
    }
    return false;
}

// D3D9 探针（M5）：自建一次性设备读静态虚表——与游戏获取 create9 的方式（常规导入/延迟加载/
// GetProcAddress 动态解析，实测 Warface 的 CryRenderD3D9.dll 为动态解析，IAT 类钩子全部无效）
// 和创建时机完全解耦；虚表为 d3d9 运行时静态表，对已创建的游戏设备同样立即生效。
// 双挂点：①IDirect3D9 虚表 CreateDevice 槽（捕获游戏后续创建，走既有 ImGuiEnsure 流程）；
// ②Device 虚表 Present/Reset 槽（覆盖已存在的游戏设备）。D3D8 探针同款模式（M3 已验证）。
static HWND g_probeHwnd = NULL;
static bool ProbeHookD3D9DeviceVtable(HMODULE d3d9) {
    if (g_origPresent) return true; // 已挂（幂等）
    PFN_Direct3DCreate9 create = (PFN_Direct3DCreate9)GetProcAddress(d3d9, "Direct3DCreate9");
    if (!create) return false;
    // 探针专用隐藏窗口（进程生命周期常驻，一次创建）
    if (!g_probeHwnd || !IsWindow(g_probeHwnd)) {
        WNDCLASSW wc;
        ZeroMemory(&wc, sizeof(wc));
        wc.lpfnWndProc = DefWindowProcW;
        wc.hInstance = GetModuleHandleW(NULL);
        wc.lpszClassName = L"im-overlay-probe";
        RegisterClassW(&wc);
        g_probeHwnd = CreateWindowExW(0, wc.lpszClassName, L"", WS_OVERLAPPED, 0, 0, 8, 8, NULL, NULL, wc.hInstance, NULL);
        if (!g_probeHwnd) return false;
    }
    InterlockedExchange(&g_probeBusy, 1); // 下方 CreateDevice 经本钩进入：不得捕获自建设备
    IDirect3D9* d3d = create(D3D_SDK_VERSION);
    bool ok = false;
    if (d3d) {
        // ① IDirect3D9 虚表 CreateDevice 槽（slot 16）
        void** vtD3d = *(void***)d3d;
        DWORD old = 0;
        if (VirtualProtect(&vtD3d[16], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
            if (vtD3d[16] != (void*)&Hooked_CreateDevice) {
                g_vtD3d9Slot = &vtD3d[16];
                g_origCreateDevice = (PFN_CreateDevice)vtD3d[16];
                vtD3d[16] = (void*)&Hooked_CreateDevice;
                LogLine("CreateDevice vtable hooked via probe");
            }
            VirtualProtect(&vtD3d[16], sizeof(void*), old, &old);
        }
        // ② Device 虚表 Present/Reset 槽（slot 17/16）：静态表，覆盖已创建的游戏设备
        D3DPRESENT_PARAMETERS pp;
        ZeroMemory(&pp, sizeof(pp));
        pp.Windowed = TRUE;
        pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
        pp.hDeviceWindow = g_probeHwnd; // 不设 PresentationInterval（部分运行时对 IMMEDIATE+窗口化返回 E_INVALIDARG，实测踩坑）
        IDirect3DDevice9* dev = NULL;
        // D3D9 窗口化 BackBufferFormat=D3DFMT_UNKNOWN 合法（自动匹配；M3 显式格式要求为 D3D8 特有）——
        // 先 UNKNOWN，E_INVALIDARG 再退桌面格式（两试）
        pp.BackBufferFormat = D3DFMT_UNKNOWN;
        HRESULT hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, g_probeHwnd,
                                       D3DCREATE_HARDWARE_VERTEXPROCESSING | D3DCREATE_NOWINDOWCHANGES, &pp, &dev);
        if (FAILED(hr)) {
            D3DDISPLAYMODE dm;
            if (SUCCEEDED(d3d->GetAdapterDisplayMode(D3DADAPTER_DEFAULT, &dm))) pp.BackBufferFormat = dm.Format;
            dev = NULL;
            hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, g_probeHwnd,
                                   D3DCREATE_HARDWARE_VERTEXPROCESSING | D3DCREATE_NOWINDOWCHANGES, &pp, &dev);
        }
        if (SUCCEEDED(hr) && dev) {
            PatchDeviceVtableSlots(dev); // Present/Reset 槽补丁（静态表，对已创建的游戏设备立即生效）
            dev->Release();
            ok = (g_origPresent != NULL);
        } else {
            char lb[96];
            snprintf(lb, sizeof(lb), "d3d9 probe CreateDevice failed hr=0x%08X (GPU not ready? retry)", hr);
            LogLine(lb);
        }
        d3d->Release(); // IDirect3D9 正常释放（虚表属 d3d9 静态数据，补丁不随对象消失）
    }
    InterlockedExchange(&g_probeBusy, 0);
    if (ok) ImGuiPreInitWin32(); // WndProc/Win32 后端尽早就位（否则首个 Shift+Tab 被原窗口过程吞掉，M2 踩坑 1）
    return ok;
}
#ifndef _WIN64
static bool TryHookD3D8(HMODULE d3d8) {
    if (!d3d8) return false;
    if (g_origD3DCreate8) return true; // 幂等
    void* target = (void*)GetProcAddress(d3d8, "Direct3DCreate8");
    if (!target) { LogLine("Direct3DCreate8 export not found"); return false; }
    void* tramp = NULL;
    if (HotPatch(target, (void*)&Hooked_Direct3DCreate8, &tramp)) {
        g_origD3DCreate8 = (PFN_Direct3DCreate8_t)tramp;
        LogLine("Direct3DCreate8 hotpatched, waiting for device creation");
    } else if (HookIAT("d3d8.dll", "Direct3DCreate8", (void*)&Hooked_Direct3DCreate8, (void**)&g_origD3DCreate8)) {
        LogLine("Direct3DCreate8 IAT hooked");
    } else {
        LogLine("d3d8 hook failed (hotpatch + IAT both), overlay disabled");
        return false;
    }
    // M4 平台共存：平台补丁会抢 IDirect3D8 vt[15] 吸走游戏的 create8 调用（设备捕获不到，实测 War3+w3plus）。
    // 标准解法：自建一次性探针设备直挂 Device 静态虚表（与游戏 create8 时机完全解耦，vtable 为静态表对
    // 游戏设备同样生效）；CreateDevice 钩保留为双保险（时机命中则更早初始化）。
    if (!g_vtDev8Slot && g_origD3DCreate8) {
        void* d3d = ((PFN_Direct3DCreate8_t)g_origD3DCreate8)(220 /* D3D_SDK_VERSION */);
        if (d3d) {
            void** vtDev = NULL;
            if (ImGui_ImplD3D8_ProbeHookDeviceVtable(d3d, (void*)&Hooked_Reset8, (void*)&Hooked_Present8, &vtDev)) {
                g_vtDev8Slot = vtDev;
                LogLine("d3d8 device vtable hooked via probe (game-device independent)");
            } else {
                LogLine("d3d8 probe hook failed (device create denied), fallback to create-time capture");
            }
            // IDirect3D8 一次性有意不释放（void* 无法调 Release 且仅泄漏一个对象/游戏会话；探针内已释探针设备与窗口）
        }
    }
    return true;
}
#endif

static DWORD WINAPI InitThread(LPVOID) {
    LogLine("hook dll attached");
    // 第一步：挂 LoadLibrary 钩（kernel32 启动即加载，无竞态；此后目标模块加载瞬间即挂钩）
    HookLoadLibraries();
    // 第二步：查模块表兜底（静态导入游戏：注入时模块已在，LoadLibrary 钩等不到）
    HMODULE d3d9 = GetModuleHandleW(K_D3D9_MODULE);
    if (d3d9) TryHookD3D9(d3d9);
#ifndef _WIN64
    HMODULE d3d8 = GetModuleHandleW(L"d3d8.dll");
    if (d3d8) TryHookD3D8(d3d8);
#endif
    // 第三步：50ms 轮询兜底（前两步都没覆盖的极端时序；命中即退）。
    // 探针重试：War3 启动极早期自建设备会被拒（显卡未就绪，实测 hr 拒绝）——
    // 每 300ms 重试一次探针（30s 窗口），游戏进菜单/对局后旁路设备创建即成功。
    // 槽位校验（每 2s）合并进轮询：平台补丁（w3plus 等）会反复覆盖 IDirect3D8/Device 虚表槽
    //（实测 War3+w3plus：探针挂钩后 266ms 即被覆盖，游戏 create8 被吸走），被覆盖则立即重打。
    int probeRetry = 0;
    int probeRetry9 = 0;
    bool slotLoggedIntact = false;
    for (DWORD i = 0; i < K_WAIT_MODULE_MS / 50; ++i) {
        if (g_shutdown) return 0;
#ifndef _WIN64
        // 槽位校验（g_origD3DCreate8 就位后才有意义）
        if (g_origD3DCreate8 && (i % 40 == 39)) {
            void* curCD = g_vtD3d8Slot ? g_vtD3d8Slot[0] : NULL;
            void* curR = g_vtDev8Slot ? g_vtDev8Slot[0] : NULL;
            void* curP = g_vtDev8Slot ? g_vtDev8Slot[1] : NULL;
            bool cdOk = !g_vtD3d8Slot || curCD == (void*)&Hooked_CreateDevice8;
            bool devOk = !g_vtDev8Slot || (curR == (void*)&Hooked_Reset8 && curP == (void*)&Hooked_Present8);
            if (!(cdOk && devOk)) {
                char lb[128];
                snprintf(lb, sizeof(lb), "d3d8 slots overwritten (cd=%p r=%p p=%p), re-applying", curCD, curR, curP);
                LogLine(lb);
                DWORD old = 0;
                if (g_vtD3d8Slot && !cdOk &&
                    VirtualProtect(g_vtD3d8Slot, sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
                    *g_vtD3d8Slot = (void*)&Hooked_CreateDevice8;
                    VirtualProtect(g_vtD3d8Slot, sizeof(void*), old, &old);
                }
                if (g_vtDev8Slot && !devOk &&
                    VirtualProtect(g_vtDev8Slot, sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) {
                    g_vtDev8Slot[0] = (void*)&Hooked_Reset8;
                    g_vtDev8Slot[1] = (void*)&Hooked_Present8;
                    VirtualProtect(g_vtDev8Slot, sizeof(void*) * 2, old, &old);
                }
                LogLine("d3d8 vtable re-applied");
                slotLoggedIntact = false;
            } else if (!slotLoggedIntact) {
                LogLine("d3d8 vtable slots intact");
                slotLoggedIntact = true;
            }
        }
        // 探针重试（设备虚表挂钩；g_vtDev8Slot 就位即停）
        if (!g_vtDev8Slot && g_origD3DCreate8) {
            HMODULE m8 = GetModuleHandleW(L"d3d8.dll");
            if (m8 && probeRetry < 100) {
                if (i % 6 == 5) {
                    ++probeRetry;
                    void* d3d = ((PFN_Direct3DCreate8_t)g_origD3DCreate8)(220 /* D3D_SDK_VERSION */);
                    if (d3d) {
                        void** vtDev = NULL;
                        if (ImGui_ImplD3D8_ProbeHookDeviceVtable(d3d, (void*)&Hooked_Reset8, (void*)&Hooked_Present8, &vtDev)) {
                            g_vtDev8Slot = vtDev;
                            LogLine("d3d8 device vtable hooked via probe retry (game-device independent)");
                        }
                        // IDirect3D8 一次性有意不释放（见 TryHookD3D8 注释）
                    }
                }
            }
        }
#endif // _WIN64 以外才有 D3D8 段；D3D9 迟加载检测必须双架构生效（见下）
        // D3D9 迟加载检测（双架构必需——CryEngine 等运行时动态加载 d3d9.dll，注入时模块未在）。
        // 三轮实测修复（Warface/GameCdonl）：原 #endif 误把本段圈进 x86-only，x64 轮询体只剩 Sleep，
        // 真游戏永不挂钩（d3d9host 静态导入走注入时模块检查，测试一直正常掩盖了此缺陷）
        HMODULE m9 = GetModuleHandleW(K_D3D9_MODULE);
        if (m9) {
            if (TryHookD3D9(m9) && g_origD3DCreate9) {
                // Loader 绑定竞态校验：全模块补丁若落在「依赖已映射、IAT 未绑定完成」窗口内，
                // 绑定会把槽位覆写回原地址——补上后 300ms×3 次复检，发现丢失立即重补。
                // 仅全模块 IAT 路径需要（hotpatch/主 exe 路径无此竞态；重补会把 hotpatch 域搞出递归）
                if (g_d3d9HookVia == 2) {
                    for (int v = 0; v < 3 && !g_shutdown; ++v) {
                        Sleep(300);
                        HookIATAllModules("d3d9.dll", "Direct3DCreate9", (void*)&Hooked_Direct3DCreate9, (void**)&g_origD3DCreate9);
                    }
                }
                break;
            }
            // 探针兜底（M5）：渲染器动态解析 create9 时 IAT 类钩子全部无效（实测 Warface/CryRenderD3D9.dll）——
            // 自建一次性设备读静态虚表，对已创建的游戏设备同样立即生效。300ms 间隔重试：
            // 早期 GPU 未就绪 CreateDevice 会被拒（War3 实测踩坑同款），进菜单后即成功
            if (!g_origPresent && (i % 6) == 5 && probeRetry9 < 100) {
                ++probeRetry9;
                ProbeHookD3D9DeviceVtable(m9);
            }
            if (g_origPresent) break; // 探针挂钩成功（g_origD3DCreate9 保持 NULL 属正常）
        }
        Sleep(50);
    }
    // M5.2 虚表完整性守护：引擎可能建设备后整体替换实例虚表指针（12:33 会话实测 Present 从未被调的头号
    // 嫌疑，w3plus 同款对抗 M3 已有先例）——每 2s 校验实例虚表基址，被换表立即在新表重打 Present/Reset；
    // 顺带补挂隐式交换链（第二呈现路径）。逻辑卸载期 g_shutdown 退出
    for (DWORD i = 0; i < K_WAIT_MODULE_MS / 50 && !g_shutdown; ++i) {
        if ((i % 40) == 39 && g_device) {
            PatchDeviceVtableSlots(g_device);
            HookImplicitSwapChain(g_device);
        }
        Sleep(50);
    }
    return 0;
}

BOOL APIENTRY DllMain(HMODULE mod, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(mod);
        g_selfMod = mod;
        InitializeCriticalSection(&g_cs); // 共享面板数据锁（须早于任何 pipe/渲染线程使用）
        g_outEvent = CreateEventW(NULL, FALSE, FALSE, NULL); // 发件箱唤醒（auto-reset）
        HANDLE th = CreateThread(NULL, 0, InitThread, NULL, 0, NULL);
        if (th) { g_hInitThread = th; } else CloseHandle(th);
        HANDLE ph = CreateThread(NULL, 0, PipeThread, NULL, 0, NULL); // pipe 客户端（独立线程，不阻塞 hook 初始化；连接失败 3s 重试）
        if (ph) { g_hPipeThread = ph; } else CloseHandle(ph);
        HANDLE wh = CreateThread(NULL, 0, WatchdogThread, NULL, 0, NULL); // 看门狗（M2：断连超时自卸载）
        if (wh) CloseHandle(wh);
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_outEvent) { CloseHandle(g_outEvent); g_outEvent = NULL; }
        DeleteCriticalSection(&g_cs);
    }
    return TRUE;
}
