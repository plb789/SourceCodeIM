// elevator.c —— IM 客户端提权启动器（纯 C + /MT 静态 CRT：零运行库依赖，与 C++ 版等价但更精简）
//
// 职责：以管理员令牌启动同目录下的 im-client.exe，启动后自身退出。
// 原理：本程序 manifest 声明 requireAdministrator（见 elevator.manifest / elevator.rc）——
//       双击/调用即弹一次 UAC，确认后本进程持有完整管理员令牌；子进程默认继承父令牌，
//       故 im-client.exe 及其孙子进程（p2p-host.exe / netsh / tapinstall）全程管理员权限。
// 客户端本体保持 asInvoker：直开可用（非提权，netsh 类操作受限），经启动器拉起则全链路提权。
// 无窗口：GUI 子系统（wWinMain），启动过程异常用 MessageBox 提示。
// 实现约束：全部使用 Win32 API（lstrcpy/lstrcat/wsprintf 为系统 API 非 CRT 函数），
//           编译 /TC 强制 C 模式、/MT 静态 CRT——目标机无需任何运行库。
//
// 构建：build-elevator.bat（VS2022 x64）

#include <windows.h>
#include <stddef.h>

#pragma comment(lib, "user32.lib")

#define ELEV_DIR_CAP   32768
#define ELEV_CMD_CAP   (ELEV_DIR_CAP + 16)

static WCHAR g_dir[ELEV_DIR_CAP];    // 本 exe 所在目录
static WCHAR g_target[ELEV_DIR_CAP]; // 客户端完整路径
static WCHAR g_cmd[ELEV_CMD_CAP];    // 命令行（路径加引号，兼容含空格安装路径）

static void fail(const WCHAR* msg) {
    MessageBoxW(NULL, msg, L"IM 客户端启动器", MB_ICONERROR | MB_OK);
}

int APIENTRY wWinMain(HINSTANCE hInst, HINSTANCE hPrev, LPWSTR lpCmdLine, int nShow) {
    // 注意：C 模式不支持匿名形参（C++ 才允许），wWinMain 参数必须全部命名，否则 C2055
    // 自身路径 → 目录（去文件名，兼容深路径）
    DWORD n = GetModuleFileNameW(NULL, g_dir, ELEV_DIR_CAP);
    if (n == 0 || n >= ELEV_DIR_CAP) {
        fail(L"获取启动器路径失败。");
        return 1;
    }
    while (n > 0 && g_dir[n - 1] != L'\\' && g_dir[n - 1] != L'/') n--;
    g_dir[n] = 0;

    // 客户端 = 同目录 im-client.exe；命令行加引号（路径含空格安全）
    lstrcpyW(g_target, g_dir);
    lstrcatW(g_target, L"im-client.exe");
    if (GetFileAttributesW(g_target) == INVALID_FILE_ATTRIBUTES) {
        fail(L"未找到同目录下的 im-client.exe。\n请将本启动器与客户端放在同一目录后重试。");
        return 1;
    }
    wsprintfW(g_cmd, L"\"%s\"", g_target);

    // 继承当前（提权）令牌启动客户端；工作目录 = 客户端目录（其 sidecar 按相对 cwd 归口）
    {
        STARTUPINFOW si;
        PROCESS_INFORMATION pi;
        ZeroMemory(&si, sizeof(si));
        si.cb = sizeof(si);
        ZeroMemory(&pi, sizeof(pi));
        if (!CreateProcessW(NULL, g_cmd, NULL, NULL, FALSE, 0, NULL, g_dir, &si, &pi)) {
            WCHAR b[320];
            wsprintfW(b, L"启动 im-client.exe 失败（错误码 %lu）。", GetLastError());
            fail(b);
            return 1;
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    // 启动即退：客户端为独立进程，自身生命周期不依赖启动器
    return 0;
}
