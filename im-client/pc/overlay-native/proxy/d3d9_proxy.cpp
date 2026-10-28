// d3d9_proxy.cpp - SC:R 版本劫持代理（docs/游戏内Overlay二期注入式设计.md 版本劫持节）
//
// 背景（2026-10-28 实测四堵墙）：SC:R 进程环境对「外部线程新建 D3D 设备」在 D3DKMT 内核层返回
// E_INVALIDARG（系统 d3d9 原版 + 适配器正常已排除参数面）；游戏自己的设备在注入完成前已建好且
// 整局不重建（整局验证零重建）；挂起期注入 LoadLibraryW 死锁。唯一介入窗口 = 游戏
// LoadLibrary("d3d9.dll") 的时刻——Windows DLL 搜索顺序应用目录优先，本代理（部署为游戏目录
// d3d9.dll）被游戏加载：
//   1. 全部导出代码级转发到 d3d9_orig.dll（System32 真身复制；不用链接器 forwarder——
//      本工具集对其解析行为异常，实测同名形状时好时坏无法收敛）
//   2. DllMain CreateThread → BootstrapThread：主模块白名单校验（防同目录暴雪助手进程误拉）→
//      LoadLibrary 同目录 overlay_hook_x64.dll（探针/虚表钩/pipe/ImGui 全部现有逻辑原样复用）
//
// 时机优势：游戏加载 d3d9 紧邻其第一次建设备——此刻反作弊保护不可能已拦截（拦了游戏自己也建
// 不成）——探针抢在该窗口自建设备拿静态虚表，成功率最高；即便失败，CreateDeviceEx 虚表钩常备
// 捕获游戏后续建设备（换分辨率/进出对局等重建场景）。
//
// 转发实现注记（x64）：签名按公开 ABI 书写；Direct3DCreate9On12 系未公开签名按 ≤4 寄存器参数
// 宽松透传（x64 caller 清栈，参数全走寄存器语义等价，签名偏差不破坏栈）。真身惰性加载一次
// （Interlocked 双检），加载发生在游戏线程的正常调用栈上（非 loader lock，合法）。
//
// 部署（客户端 spawn 前幂等复制三件套到游戏目录）：d3d9_proxy.dll→d3d9.dll、
// System32 d3d9.dll→d3d9_orig.dll、overlay_hook_x64.dll（同名）。游戏更新可能清理游戏目录，
// 每次启动重新部署。

#include <windows.h>

EXTERN_C IMAGE_DOS_HEADER __ImageBase; // MSVC 链接器提供：代理自身模块基址（定位同目录）

// ===== 主模块白名单（BootstrapThread 与 Create 转发函数共用）=====
// 版本劫持代理是 SC:R 专用组件——游戏目录里的暴雪助手进程（ClientSdkFirewallHelper.exe 等）
// 的「应用目录」同样是游戏目录，它们若加载 d3d9 会命中本代理，不得拉起 overlay。
static bool AllowedHost() {
    wchar_t self[MAX_PATH] = { 0 };
    GetModuleFileNameW(NULL, self, MAX_PATH);
    const wchar_t* base = wcsrchr(self, L'\\');
    base = base ? base + 1 : self;
    if (lstrcmpiW(base, L"StarCraft.exe") == 0) return true; // 名单匹配大小写不敏感
    // 测试口子：宿主（d3d9host）验证转发 + 拉起链路用，部署环境不设置该变量
    char env[8] = { 0 };
    return GetEnvironmentVariableA("IM_OVERLAY_PROXY_FORCE", env, sizeof(env)) && env[0] == '1';
}

// 拉起同目录 overlay_hook_x64.dll（幂等）→ 取虚表补丁导出。
// 游戏调用 Create9/Ex 时在游戏线程正常调用栈上（loader lock 已释放）LoadLibrary 合法；
// 同路径重复加载返回已加载句柄（injector 注入场景 DllMain 不会二次执行）。
typedef void (__stdcall *PFN_HookObj)(void*);
static HMODULE g_hookDll = NULL;
static volatile LONG s_loadState = 0; // 0=未试 1=成功 2=失败（不再重试，文件缺失属部署异常）
static PFN_HookObj EnsureHookDll(void) {
    LONG st = InterlockedCompareExchange(&s_loadState, 0, 0);
    if (st == 1) return (PFN_HookObj)GetProcAddress(g_hookDll, "OverlayHookD3D9Object");
    if (st == 2) return NULL;
    if (InterlockedCompareExchange(&s_loadState, 3, 0) != 0) { // 3=装载中，自旋等结果
        for (int i = 0; i < 100; ++i) {
            LONG v = InterlockedCompareExchange(&s_loadState, 0, 0);
            if (v == 1 || v == 2) break;
            Sleep(2);
        }
        return (s_loadState == 1 && g_hookDll) ? (PFN_HookObj)GetProcAddress(g_hookDll, "OverlayHookD3D9Object") : NULL;
    }
    wchar_t dir[MAX_PATH];
    GetModuleFileNameW((HMODULE)&__ImageBase, dir, MAX_PATH); // 代理自身所在目录（=游戏目录）
    wchar_t* slash = wcsrchr(dir, L'\\');
    if (slash) {
        *(slash + 1) = L'\0';
        lstrcatW(dir, L"overlay_hook_x64.dll");
        g_hookDll = LoadLibraryW(dir);
        InterlockedExchange(&s_loadState, g_hookDll ? 1 : 2);
        return g_hookDll ? (PFN_HookObj)GetProcAddress(g_hookDll, "OverlayHookD3D9Object") : NULL;
    }
    InterlockedExchange(&s_loadState, 2);
    return NULL;
}

// ===== 真身（d3d9_orig.dll）惰性加载（一次，双检）=====
static volatile LONG g_origLoading = 0;
static HMODULE g_orig = NULL;
static FARPROC OrigProc(const char* name) {
    if (!g_orig) {
        if (InterlockedCompareExchange(&g_origLoading, 1, 0) == 0) {
            // 相对搜索：应用目录（游戏目录）命中同目录 d3d9_orig.dll；名字不以 d3d9 开头防
            // 搜索顺序混乱——d3d9_orig.dll 由客户端部署到游戏目录
            HMODULE h = LoadLibraryW(L"d3d9_orig.dll");
            g_orig = h;
            InterlockedExchange(&g_origLoading, 0);
        } else {
            // 极小概率并发首调：自旋等初始化线程装载（毫秒级）
            for (int i = 0; i < 200 && !g_orig; ++i) Sleep(5);
        }
    }
    return g_orig ? GetProcAddress(g_orig, name) : NULL;
}

// ===== 导出转发（17 个按名导出；签名公开 ABI 或 ≤4 寄存器参数宽松透传）=====
// 注意：绝不能 #include <d3d9.h>——会引入 d3d9.lib 静态导入，加载器解析代理自身的导入表时
// 按搜索顺序又命中游戏目录 d3d9.dll（代理自身）=递归死锁。接口类型前置声明（仅指针语义）。
struct IDirect3D9;
struct IDirect3D9Ex;
typedef IDirect3D9* (WINAPI* PFN_Create9)(UINT);
typedef HRESULT (WINAPI* PFN_Create9Ex)(UINT, IDirect3D9Ex**);

extern "C" {

// 真身对象返回游戏前当场补虚表钩（版本劫持核心：钩装好严格发生在「游戏拿到对象」与
// 「游戏调建设备」之间，游戏建设备必经钩子捕获——SC:R 环境进程内自建设备被 D3DKMT 层
// 拦截 E_INVALIDARG，此路径让游戏自己建设备给我们，彻底绕开）
static void HookHandoff(void* d3d) {
    PFN_HookObj hk = EnsureHookDll();
    if (hk) hk(d3d);
}

__declspec(dllexport) IDirect3D9* __stdcall Direct3DCreate9(UINT sdk) {
    PFN_Create9 p = (PFN_Create9)OrigProc("Direct3DCreate9");
    IDirect3D9* d3d = p ? p(sdk) : NULL;
    if (d3d && AllowedHost()) HookHandoff(d3d);
    return d3d;
}
__declspec(dllexport) HRESULT __stdcall Direct3DCreate9Ex(UINT sdk, IDirect3D9Ex** out) {
    PFN_Create9Ex p = (PFN_Create9Ex)OrigProc("Direct3DCreate9Ex");
    HRESULT hr = p ? p(sdk, out) : E_NOTIMPL;
    if (SUCCEEDED(hr) && out && *out && AllowedHost()) HookHandoff(*out);
    return hr;
}
// D3D9On12 桥（SC:R 实测主路径：游戏经 Direct3DCreate9On12(Ex) 拿 9On12 包装对象建设备——
// SDK d3d9on12.h：返回值就是 IDirect3D9Ex 接口语义（包装在 D3D12 底座上），虚表布局与 9Ex
// 一致，slot 16/20 同样是 CreateDevice/CreateDeviceEx——转发函数必须同样 handoff 补钩，
// 否则游戏建设备完全绕开捕获（2026-10-28 实测零捕获的根因）。D3D9ON12_ARGS 用 void* 免 include。
__declspec(dllexport) IDirect3D9* __stdcall Direct3DCreate9On12(UINT sdk, void* overrideList, UINT num) {
    typedef IDirect3D9* (WINAPI* FP)(UINT, void*, UINT);
    FP p = (FP)OrigProc("Direct3DCreate9On12");
    IDirect3D9* d3d = p ? p(sdk, overrideList, num) : NULL;
    if (d3d && AllowedHost()) HookHandoff(d3d);
    return d3d;
}
__declspec(dllexport) HRESULT __stdcall Direct3DCreate9On12Ex(UINT sdk, void* overrideList, UINT num, IDirect3D9Ex** out) {
    typedef HRESULT (WINAPI* FP)(UINT, void*, UINT, IDirect3D9Ex**);
    FP p = (FP)OrigProc("Direct3DCreate9On12Ex");
    HRESULT hr = p ? p(sdk, overrideList, num, out) : E_NOTIMPL;
    if (SUCCEEDED(hr) && out && *out && AllowedHost()) HookHandoff(*out);
    return hr;
}
__declspec(dllexport) void* __stdcall Direct3DShaderValidatorCreate9(void) {
    typedef void* (WINAPI* FP)(void);
    FP p = (FP)OrigProc("Direct3DShaderValidatorCreate9");
    return p ? p() : NULL;
}
// D3DPERF_*（PIX 分析桩；游戏引擎可能调用 BeginEvent/EndEvent）
__declspec(dllexport) int __stdcall D3DPERF_BeginEvent(unsigned long col, const wchar_t* name) {
    typedef int (WINAPI* FP)(unsigned long, const wchar_t*);
    FP p = (FP)OrigProc("D3DPERF_BeginEvent");
    return p ? p(col, name) : 0;
}
__declspec(dllexport) int __stdcall D3DPERF_EndEvent(void) {
    typedef int (WINAPI* FP)(void);
    FP p = (FP)OrigProc("D3DPERF_EndEvent");
    return p ? p() : 0;
}
__declspec(dllexport) void __stdcall D3DPERF_SetMarker(unsigned long col, const wchar_t* name) {
    typedef void (WINAPI* FP)(unsigned long, const wchar_t*);
    FP p = (FP)OrigProc("D3DPERF_SetMarker");
    if (p) p(col, name);
}
__declspec(dllexport) void __stdcall D3DPERF_SetRegion(unsigned long col, const wchar_t* name) {
    typedef void (WINAPI* FP)(unsigned long, const wchar_t*);
    FP p = (FP)OrigProc("D3DPERF_SetRegion");
    if (p) p(col, name);
}
__declspec(dllexport) unsigned long __stdcall D3DPERF_QueryRepeatFrame(void) {
    typedef unsigned long (WINAPI* FP)(void);
    FP p = (FP)OrigProc("D3DPERF_QueryRepeatFrame");
    return p ? p() : 0;
}
__declspec(dllexport) void __stdcall D3DPERF_SetOptions(unsigned long options) {
    typedef void (WINAPI* FP)(unsigned long);
    FP p = (FP)OrigProc("D3DPERF_SetOptions");
    if (p) p(options);
}
__declspec(dllexport) unsigned long __stdcall D3DPERF_GetStatus(void) {
    typedef unsigned long (WINAPI* FP)(void);
    FP p = (FP)OrigProc("D3DPERF_GetStatus");
    return p ? p() : 0;
}
// 调试桩（内部函数，签名 DWORD 入参宽松透传）
__declspec(dllexport) void __stdcall DebugSetLevel(unsigned long a) {
    typedef void (WINAPI* FP)(unsigned long);
    FP p = (FP)OrigProc("DebugSetLevel");
    if (p) p(a);
}
__declspec(dllexport) void __stdcall DebugSetMute(unsigned long a) {
    typedef void (WINAPI* FP)(unsigned long);
    FP p = (FP)OrigProc("DebugSetMute");
    if (p) p(a);
}
// PSGP 内部函数（≤4 寄存器参数宽松透传；签名未公开）
__declspec(dllexport) void* __stdcall PSGPError(void* a, void* b, void* c) {
    typedef void* (WINAPI* FP)(void*, void*, void*);
    FP p = (FP)OrigProc("PSGPError");
    return p ? p(a, b, c) : NULL;
}
__declspec(dllexport) void* __stdcall PSGPSampleTexture(void* a, void* b, void* c, void* d) {
    typedef void* (WINAPI* FP)(void*, void*, void*, void*);
    FP p = (FP)OrigProc("PSGPSampleTexture");
    return p ? p(a, b, c, d) : NULL;
}
// 窗口化模式 Shim（D3D9Ex 运行时兼容开关；BOOL 入参）
__declspec(dllexport) int __stdcall Direct3D9EnableMaximizedWindowedModeShim(int a) {
    typedef int (WINAPI* FP)(int);
    FP p = (FP)OrigProc("Direct3D9EnableMaximizedWindowedModeShim");
    return p ? p(a) : 0;
}

} // extern "C"

static DWORD WINAPI BootstrapThread(LPVOID) {
    if (AllowedHost()) {
        wchar_t dir[MAX_PATH];
        GetModuleFileNameW((HMODULE)&__ImageBase, dir, MAX_PATH); // 代理自身所在目录（=游戏目录）
        wchar_t* slash = wcsrchr(dir, L'\\');
        if (slash) {
            *(slash + 1) = L'\0';
            lstrcatW(dir, L"overlay_hook_x64.dll");
            // 同路径重复加载幂等（EnsureHookDll 已拉的场合返回已加载模块句柄）
            LoadLibraryW(dir);
        }
    }
    return 0;
}

BOOL APIENTRY DllMain(HMODULE mod, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(mod);
        // DllMain 内不 LoadLibrary（loader lock 禁忌，SC:R 环境 rc=258 死锁同源）——
        // CreateThread 合法（线程体延迟到 loader lock 释放后执行）
        HANDLE th = CreateThread(NULL, 0, BootstrapThread, NULL, 0, NULL);
        if (th) CloseHandle(th);
    }
    return TRUE;
}
