// injector.exe - 游戏内 Overlay 二期注入器（docs/游戏内Overlay二期注入式设计.md §3.1）
//
// 两种模式：
//   1) 手动注入：injector.exe <pid> <dll目录>
//      （M0 POC 验证用；按目标位数选 overlay_hook_x86/x64.dll 远线程 LoadLibraryW 注入）
//   2) 启动注入：injector.exe --launch <exe> -- <args...>     （M2 主进程 spawn 链用）
//      CREATE_SUSPENDED 建进程 → 首行 stdout 打 "pid:<n>"（主进程回读校正 pipe 名）→ 注入 →
//      resume → 等待游戏退出（exit code 透传，主进程 exit/close 监听语义不变）。
//      注入失败不终止游戏（照常 resume）——设计硬性边界：注入失败不影响游戏启动。
//
// 位数约束：注入器自身位数必须与目标一致（LoadLibraryW 远线程地址换算要求同位数）——
// 主进程按 32 位构建调用（WOW64 下可注入 x86 目标），x64 目标属 M3。
// 退出码：0 成功（--launch 模式=游戏退出码透传）/ 2 参数错误 / 3 OpenProcess 失败 / 4 位数不匹配
//        / 5 写内存失败 / 6 远线程失败 / 7 超时 / 8 模块加载失败 / 10 CreateProcess 失败

#include <windows.h>
#include <cstdio>
#include <cstring>
#include <string>

// 远线程 LoadLibraryW 注入核心（两种模式共用）
// 返回：0 成功 / 5 写内存失败 / 6 远线程失败 / 7 超时 / 8 模块加载失败
static int InjectDll(HANDLE ph, const char* dllA) {
    wchar_t dllW[MAX_PATH];
    int wl = MultiByteToWideChar(CP_ACP, 0, dllA, -1, NULL, 0);
    if (wl <= 0 || wl > MAX_PATH) return 5;
    MultiByteToWideChar(CP_ACP, 0, dllA, -1, dllW, wl);

    SIZE_T bytes = (SIZE_T)wl * sizeof(wchar_t);
    void* remote = VirtualAllocEx(ph, NULL, bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!remote) return 5;
    if (!WriteProcessMemory(ph, remote, dllW, bytes, NULL)) { VirtualFreeEx(ph, remote, 0, MEM_RELEASE); return 5; }

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC loadLib = GetProcAddress(k32, "LoadLibraryW");
    if (!loadLib) { VirtualFreeEx(ph, remote, 0, MEM_RELEASE); return 6; }
    HANDLE th = CreateRemoteThread(ph, NULL, 0, (LPTHREAD_START_ROUTINE)loadLib, remote, 0, NULL);
    if (!th) { VirtualFreeEx(ph, remote, 0, MEM_RELEASE); return 6; }
    DWORD wr = WaitForSingleObject(th, 10000);
    // 校验远线程返回值 = LoadLibraryW 返回的模块基址（NULL = 目标进程内加载失败，如路径/DllMain 错误）
    DWORD modBase = 0;
    GetExitCodeThread(th, &modBase);
    CloseHandle(th);
    VirtualFreeEx(ph, remote, 0, MEM_RELEASE);
    if (wr != WAIT_OBJECT_0) return 7;
    if (modBase == 0) return 8;
    return 0;
}
// 按"目标进程位数 + 注入器自身目录"拼 DLL 路径
static void BuildDllPath(char* out, int outCap, const char* dirA, BOOL wow) {
    snprintf(out, outCap, "%s\\overlay_hook_%s.dll", dirA, wow ? "x86" : "x64");
}

// 模式 2：启动注入（M2 spawn 链）。argv[2]=exe，argv[3] 预期 "--"，argv[4..]=游戏参数
static int LaunchAndInject(int argc, char** argv) {
    const char* exe = argv[2];
    int argStart = 4; // argv[3] == "--"
    if (argc < 4 || strcmp(argv[3], "--") != 0) { printf("usage: injector.exe --launch <exe> -- <args...>\n"); return 2; }

    // 游戏命令行（含空格的参数加引号）
    std::string cmd = "\"" + std::string(exe) + "\"";
    for (int i = argStart; i < argc; ++i) {
        std::string a = argv[i];
        if (a.find(' ') != std::string::npos || a.find('\t') != std::string::npos) cmd += " \"" + a + "\"";
        else cmd += " " + a;
    }
    STARTUPINFOA si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessA(exe, (LPSTR)cmd.c_str(), NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
        printf("CreateProcess failed err=%lu\n", GetLastError());
        return 10;
    }
    // 真实游戏 pid 首行输出（主进程 ovReadGamePid 回读；须在注入前 flush，注入耗时不阻塞 pid 就绪）
    printf("pid:%lu\n", pi.dwProcessId);
    fflush(stdout);

    // 位数匹配校验：不匹配则跳过注入照常 resume（降级一期悬浮窗，游戏启动不受影响）
    BOOL wow = FALSE, selfWow = FALSE;
    IsWow64Process(pi.hProcess, &wow);
    IsWow64Process(GetCurrentProcess(), &selfWow);
    int rc = 0;
    if (wow != selfWow) {
        printf("bitness mismatch (target %s), skip inject\n", wow ? "x86" : "x64");
        rc = 4;
    } else {
        char selfPath[MAX_PATH];
        GetModuleFileNameA(NULL, selfPath, MAX_PATH);
        char* slash = strrchr(selfPath, '\\');
        if (slash) *slash = 0;
        char dllA[MAX_PATH];
        BuildDllPath(dllA, MAX_PATH, selfPath, wow);
        rc = InjectDll(pi.hProcess, dllA);
        if (rc != 0) printf("inject failed rc=%d, resume anyway\n", rc);
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE); // 等游戏退出：helper 退出=游戏退出（主进程 exit 监听语义不变）
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    return (int)code;
}

int main(int argc, char** argv) {
    if (argc >= 2 && strcmp(argv[1], "--launch") == 0) return LaunchAndInject(argc, argv);
    // 模式 1：手动注入（M0 POC 验证用，保留）
    if (argc < 3) return 2;
    DWORD pid = (DWORD)atol(argv[1]);
    const char* dirA = argv[2];

    HANDLE ph = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (!ph) return 3;

    // 位数匹配校验
    BOOL wow = FALSE, selfWow = FALSE;
    IsWow64Process(ph, &wow);
    IsWow64Process(GetCurrentProcess(), &selfWow);
    if (wow != selfWow) { CloseHandle(ph); return 4; }

    char dllA[MAX_PATH];
    BuildDllPath(dllA, MAX_PATH, dirA, wow);
    int rc = InjectDll(ph, dllA);
    // POC 验证：5 秒后读回目标进程内补丁地址的字节（决定性判定：补丁在/被覆盖）
    if (rc == 0) {
        Sleep(5000);
        HMODULE d3d = LoadLibraryW(L"d3d9.dll"); // 同 boot 下 x86 d3d9 基址与目标一致
        if (d3d) {
            void* tgt = (void*)GetProcAddress(d3d, "Direct3DCreate9");
            if (tgt) {
                BYTE buf[7] = { 0 };
                SIZE_T rd = 0;
                if (ReadProcessMemory(ph, tgt, buf, 7, &rd)) {
                    printf("host bytes after 5s: %02X %02X %02X %02X %02X %02X %02X\n", buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6]);
                } else {
                    printf("RPM failed err=%lu\n", GetLastError());
                }
            }
            FreeLibrary(d3d);
        }
    }
    CloseHandle(ph);
    return rc;
}
