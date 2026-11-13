// updater.c —— 阶段三百：PC 增量热更新守护进程
// 职责：主进程退出后替换 app.asar + app.asar.unpacked，再重启客户端
// 原理：被 im-client.exe（管理员令牌）spawn -> 继承管理员令牌 -> 写 resources/ -> 启动 elevator.exe
// 构建：VS2022 x64，/MT 静态 CRT，/O2 优化，/SUBSYSTEM:WINDOWS
// 分发：extraResources -> resources/updater/updater.exe
// manifest：asInvoker（不自己提权，继承父进程令牌）

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "psapi.lib")

#define U_MAX_PATH   32768
#define U_TIMEOUT_MS 10000   // 等待 im-client.exe 退出最长 10 秒
#define U_POLL_MS    500     // 轮询间隔
#define U_COPY_RETRY 5       // 文件复制重试次数
#define U_COPY_DELAY 200     // 复制重试间隔 ms

static WCHAR g_installDir[U_MAX_PATH];
static WCHAR g_cacheDir[U_MAX_PATH];

// ---- 大小写不敏感宽字符比较 ----
static int ci_wcscmp(const WCHAR* a, const WCHAR* b) {
    while (*a && *b) {
        wchar_t ca = towlower(*a), cb = towlower(*b);
        if (ca != cb) return (int)ca - (int)cb;
        a++; b++;
    }
    return (int)*a - (int)*b;
}

// ---- 宽字符大小写不敏感 startsWith ----
static BOOL ci_starts_with(const WCHAR* s, const WCHAR* prefix) {
    while (*prefix) {
        if (towlower(*s) != towlower(*prefix)) return FALSE;
        s++; prefix++;
    }
    return TRUE;
}

// ---- 解析命令行（-InstallDir "...\" -CacheDir "...\"） ----
static int parse_args(int argc, wchar_t** argv) {
    g_installDir[0] = L'\0';
    g_cacheDir[0] = L'\0';
    for (int i = 1; i < argc; i++) {
        const wchar_t* arg = argv[i];
        int isDash = (arg[0] == L'-' || arg[0] == L'/');
        if (!isDash) continue;
        const wchar_t* name = arg + 1;
        if (name[0] == L'-' || name[0] == L'/') name++;
        const wchar_t* val = (i + 1 < argc) ? argv[i + 1] : L"";
        if (ci_starts_with(name, L"InstallDir") || ci_starts_with(name, L"install")) {
            wcscpy_s(g_installDir, U_MAX_PATH, val);
            i++;
        } else if (ci_starts_with(name, L"CacheDir") || ci_starts_with(name, L"cache")) {
            wcscpy_s(g_cacheDir, U_MAX_PATH, val);
            i++;
        }
    }
    return (g_installDir[0] && g_cacheDir[0]) ? 0 : -1;
}

// ---- 检查 im-client.exe 是否还在运行 ----
static BOOL process_alive(void) {
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return FALSE;
    PROCESSENTRY32W pe = { sizeof(pe) };
    pe.dwSize = sizeof(pe);
    BOOL found = FALSE;
    if (Process32FirstW(hSnap, &pe)) {
        do {
            if (ci_wcscmp(pe.szExeFile, L"im-client.exe") == 0) {
                found = TRUE;
                break;
            }
        } while (Process32NextW(hSnap, &pe));
    }
    CloseHandle(hSnap);
    return found;
}

// ---- 等待 im-client.exe 退出，超时强制杀 ----
static int wait_exit(void) {
    int waited = 0;
    while (process_alive() && waited < U_TIMEOUT_MS) {
        Sleep(U_POLL_MS);
        waited += U_POLL_MS;
    }
    if (process_alive()) {
        // 强制杀残留
        HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hSnap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe = { sizeof(pe) };
            pe.dwSize = sizeof(pe);
            if (Process32FirstW(hSnap, &pe)) {
                do {
                    if (ci_wcscmp(pe.szExeFile, L"im-client.exe") == 0 && pe.th32ProcessID != 0) {
                        HANDLE hP = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
                        if (hP) { TerminateProcess(hP, 0); CloseHandle(hP); }
                    }
                } while (Process32NextW(hSnap, &pe));
            }
            CloseHandle(hSnap);
        }
        Sleep(1000); // 等文件锁释放
    }
    return 0;
}

// ---- 带重试的文件复制 ----
static int copy_file(const WCHAR* src, const WCHAR* dst) {
    for (int r = 0; r < U_COPY_RETRY; r++) {
        if (CopyFileW(src, dst, FALSE)) return 0;
        Sleep(U_COPY_DELAY);
    }
    return -1;
}

// ---- 递归删除目录或文件 ----
static int remove_tree(const WCHAR* path) {
    DWORD attrs = GetFileAttributesW(path);
    if (attrs == INVALID_FILE_ATTRIBUTES) return 0;
    if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        DeleteFileW(path);
        return 0;
    }
    WCHAR searchPath[U_MAX_PATH];
    WIN32_FIND_DATAW fd;
    HANDLE hFind;
    swprintf_s(searchPath, U_MAX_PATH, L"%s\\*", path);
    hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) {
        RemoveDirectoryW(path);
        return 0;
    }
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR child[U_MAX_PATH];
        swprintf_s(child, U_MAX_PATH, L"%s\\%s", path, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            remove_tree(child);
        } else {
            SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
            DeleteFileW(child);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    RemoveDirectoryW(path);
    return 0;
}

// ---- 递归复制目录 ----
static int copy_tree(const WCHAR* src, const WCHAR* dst) {
    CreateDirectoryW(dst, NULL);
    WCHAR searchPath[U_MAX_PATH];
    WIN32_FIND_DATAW fd;
    HANDLE hFind;
    swprintf_s(searchPath, U_MAX_PATH, L"%s\\*", src);
    hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return -1;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR srcChild[U_MAX_PATH], dstChild[U_MAX_PATH];
        swprintf_s(srcChild, U_MAX_PATH, L"%s\\%s", src, fd.cFileName);
        swprintf_s(dstChild, U_MAX_PATH, L"%s\\%s", dst, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            copy_tree(srcChild, dstChild);
        } else {
            CopyFileW(srcChild, dstChild, FALSE);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    return 0;
}

// ---- 启动应用（优先 elevator.exe 保持提权链） ----
static int start_app(void) {
    WCHAR elevator[U_MAX_PATH], client[U_MAX_PATH];
    swprintf_s(elevator, U_MAX_PATH, L"%s\\elevator.exe", g_installDir);
    swprintf_s(client, U_MAX_PATH, L"%s\\im-client.exe", g_installDir);
    const WCHAR* target = NULL;
    if (GetFileAttributesW(elevator) != INVALID_FILE_ATTRIBUTES) target = elevator;
    else if (GetFileAttributesW(client) != INVALID_FILE_ATTRIBUTES) target = client;
    else return -1;

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(target, NULL, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        return -1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}

// ---- wWinMain（无控制台窗口，SUBSYSTEM:WINDOWS） ----
int wWinMain(HINSTANCE hInst, HINSTANCE hPrev, LPWSTR lpCmdLine, int nShow) {
    UNREFERENCED_PARAMETER(hInst);
    UNREFERENCED_PARAMETER(hPrev);
    UNREFERENCED_PARAMETER(nShow);
    UNREFERENCED_PARAMETER(lpCmdLine);

    // 1. 解析命令行
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || parse_args(argc, argv) != 0) {
        LocalFree(argv);
        return 1;
    }
    LocalFree(argv);

    // 2. 等待 im-client.exe 退出
    wait_exit();

    WCHAR resourcesDir[U_MAX_PATH];
    swprintf_s(resourcesDir, U_MAX_PATH, L"%s\\resources", g_installDir);

    WCHAR asarPath[U_MAX_PATH], asarBak[U_MAX_PATH];
    swprintf_s(asarPath, U_MAX_PATH, L"%s\\app.asar", resourcesDir);
    swprintf_s(asarBak, U_MAX_PATH, L"%s\\app.asar.bak", resourcesDir);

    // 3. 备份旧 asar
    if (GetFileAttributesW(asarBak) != INVALID_FILE_ATTRIBUTES) {
        DeleteFileW(asarBak);
    }
    CopyFileW(asarPath, asarBak, FALSE);

    // 4. 复制新 asar
    WCHAR newAsar[U_MAX_PATH];
    swprintf_s(newAsar, U_MAX_PATH, L"%s\\app.asar", g_cacheDir);
    if (copy_file(newAsar, asarPath) != 0) {
        start_app(); // 失败也启动（main.js 会检查 .bak 回滚）
        return 2;
    }

    // 5. 替换 unpacked（Node.js 主进程已解压为 CacheDir/unpacked/）
    WCHAR newUnpacked[U_MAX_PATH], oldUnpacked[U_MAX_PATH];
    swprintf_s(newUnpacked, U_MAX_PATH, L"%s\\unpacked", g_cacheDir);
    swprintf_s(oldUnpacked, U_MAX_PATH, L"%s\\app.asar.unpacked", resourcesDir);
    if (GetFileAttributesW(newUnpacked) != INVALID_FILE_ATTRIBUTES) {
        remove_tree(oldUnpacked);
        copy_tree(newUnpacked, oldUnpacked);
    }

    // 6. 清理缓存
    remove_tree(g_cacheDir);

    // 7. 启动应用（优先 elevator.exe 保持提权链）
    start_app();
    return 0;
}
