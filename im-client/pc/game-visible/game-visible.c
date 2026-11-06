// game-visible.c — 游戏启动“正在启动 → 运行中”窗口可见探测工具（im-client 随包分发的原生组件）
//
// 背景：main.js spawn 游戏进程后需等待“游戏画面真正可见”才把按钮从“正在启动”切“运行中”。
// 主进程无原生窗口枚举能力，原实现经 PowerShell P/Invoke 轮询（每次 Add-Type 编译约 1~2s 开销）；
// 本工具以等价逻辑原生实现，启动即跑（毫秒级）。main.js 优先调用本工具，缺失时回退 PowerShell。
//
// 编译：双击本目录 build.bat（自动定位 VS 工具链，输出本目录 game-visible.exe）。
// 本目录（源码+脚本）不打包进客户端；exe 经 package.json extraResources 进 resources\game-visible\。
//
// 用法: game-visible.exe <rootPid> <leafExeName> <waitMs> <excludeRoot>
//   rootPid     spawn 的游戏进程 pid（进程族根）
//   leafExeName 启动 exe 的文件名（如 notepad.exe；空串跳过名字兜底匹配）
//   waitMs      探测上限（毫秒），超时输出 0
//   excludeRoot 1=排除根进程自身窗口（SmartSteamEmu loader 常驻自带可见主窗，须排除只认真实游戏窗口）
//
// 进程族三层归口（与原 PowerShell 实现一致）：
//   1) 直启：根进程即窗口宿主；2) 父链后代：启动器 CreateProcess 拉起真实游戏，父链展开且探测集
//   跨轮询累积（存根中途退出不丢链）；3) exe 文件名兜底：存根重拉链父链断裂场景。
// 窗口判定：IsWindowVisible + 矩形 ≥150x100（滤 0 尺寸消息窗/隐藏辅助窗）。
//
// 输出：命中打印 "1"、超时打印 "0"（退出码 0）；父进程读 stdout 判定。

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <wchar.h>

#define MAX_PROC 8192
#define MAX_ACC  8192
#define NAME_LEN 260
#define POLL_MS  500
#define MIN_W    150
#define MIN_H    100

typedef struct { DWORD pid; DWORD parent; WCHAR name[NAME_LEN]; } PROC_ITEM;

static PROC_ITEM g_procs[MAX_PROC];
static int       g_procN = 0;
static DWORD     g_acc[MAX_ACC];   // 进程族累积集合（跨轮询持久：存根退出后已发现的链路不丢）
static int       g_accN = 0;
static DWORD     g_root = 0;
static int       g_exclRoot = 0;
static int       g_hit = 0;

static int accHas(DWORD pid)
{
    int i;
    for (i = 0; i < g_accN; i++) if (g_acc[i] == pid) return 1;
    return 0;
}

static void accAdd(DWORD pid)
{
    if (g_accN < MAX_ACC && !accHas(pid)) g_acc[g_accN++] = pid;
}

// 快照当前进程表（pid/父 pid/exe 文件名）
static void snapshot(void)
{
    HANDLE s;
    PROCESSENTRY32W e;
    g_procN = 0;
    s = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (s == INVALID_HANDLE_VALUE) return;
    e.dwSize = sizeof(e);
    if (Process32FirstW(s, &e)) {
        do {
            if (g_procN >= MAX_PROC) break;
            g_procs[g_procN].pid = e.th32ProcessID;
            g_procs[g_procN].parent = e.th32ParentProcessID;
            wcsncpy(g_procs[g_procN].name, e.szExeFile, NAME_LEN - 1);
            g_procs[g_procN].name[NAME_LEN - 1] = L'\0';
            g_procN++;
        } while (Process32NextW(s, &e));
    }
    CloseHandle(s);
}

// 扩展进程族：root + exe 名匹配 + 父链后代展开至不动点
static void expand(const wchar_t* leaf)
{
    int i, added;
    if (!accHas(g_root)) accAdd(g_root);
    if (leaf[0]) {
        for (i = 0; i < g_procN; i++)
            if (_wcsicmp(g_procs[i].name, leaf) == 0) accAdd(g_procs[i].pid);
    }
    added = 1;
    while (added) {
        added = 0;
        for (i = 0; i < g_procN; i++) {
            if (!accHas(g_procs[i].pid) && accHas(g_procs[i].parent)) {
                accAdd(g_procs[i].pid);
                added = 1;
            }
        }
    }
}

static BOOL CALLBACK wndEnum(HWND h, LPARAM lp)
{
    DWORD p = 0;
    RECT r;
    (void)lp;
    if (!IsWindowVisible(h)) return TRUE;
    GetWindowThreadProcessId(h, &p);
    if (!accHas(p)) return TRUE;
    if (g_exclRoot && p == g_root) return TRUE;
    if (!GetWindowRect(h, &r)) return TRUE;
    if (r.right - r.left >= MIN_W && r.bottom - r.top >= MIN_H) { g_hit = 1; return FALSE; }
    return TRUE;
}

int wmain(int argc, wchar_t** argv)
{
    const wchar_t* leaf;
    DWORD waitMs, start;
    int i;

    if (argc < 4) { printf("0\n"); fflush(stdout); return 0; }
    g_root = (DWORD)wcstoul(argv[1], NULL, 10);
    leaf = argv[2];
    waitMs = (DWORD)wcstoul(argv[3], NULL, 10);
    if (waitMs == 0) waitMs = 30000;
    g_exclRoot = (argc >= 5) ? (wcstoul(argv[4], NULL, 10) != 0) : 0;

    start = GetTickCount();
    for (;;) {
        snapshot();
        expand(leaf);
        g_hit = 0;
        EnumWindows(wndEnum, 0);
        if (g_hit) { printf("1\n"); fflush(stdout); return 0; }
        if (GetTickCount() - start >= waitMs) break;
        Sleep(POLL_MS);
    }
    printf("0\n");
    fflush(stdout);
    return 0;
}
