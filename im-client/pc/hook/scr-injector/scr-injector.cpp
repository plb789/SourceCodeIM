// scr-injector.cpp - P0 尖刺：SC:R 提权注入器（标准 CreateRemoteThread + LoadLibraryW）
// 用法（管理员运行）：scr-injector.exe [dll绝对路径]
//   默认 DLL 路径：注入器同目录 scr-hook.dll
// 流程：按名查找 StarCraft.exe → OpenProcess → 远端分配/写入 DLL 路径 →
//       CreateRemoteThread(LoadLibraryW) → 等待 → 校验加载结果
// 输出：stdout 步骤日志 + %TEMP%\scr-inject.log

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>

static DWORD FindPidByName(const wchar_t* exeName) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
    DWORD pid = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, exeName) == 0) { pid = pe.th32ProcessID; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

// 启用 SeDebugPrivilege（管理员令牌默认禁用该特权）：绕过系统服务进程的 DACL 自保护，
// 否则 OpenProcess 对 mDNSResponder 等服务返回 err=5
static bool EnableDebugPriv() {
    HANDLE tok = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &tok)) return false;
    TOKEN_PRIVILEGES tp;
    if (!LookupPrivilegeValueW(NULL, SE_DEBUG_NAME, &tp.Privileges[0].Luid)) { CloseHandle(tok); return false; }
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    BOOL ok = AdjustTokenPrivileges(tok, FALSE, &tp, sizeof(tp), NULL, NULL);
    DWORD err = GetLastError();
    CloseHandle(tok);
    return ok && err == ERROR_SUCCESS;
}

int main(int argc, char** argv) {
    wchar_t dllPath[MAX_PATH] = L"";
    if (argc > 1) {
        MultiByteToWideChar(CP_ACP, 0, argv[1], -1, dllPath, MAX_PATH);
    } else {
        // 默认：注入器同目录 scr-hook.dll
        wchar_t exe[MAX_PATH]; GetModuleFileNameW(NULL, exe, MAX_PATH);
        wchar_t* slash = wcsrchr(exe, L'\\');
        if (slash) *(slash + 1) = 0;
        wcscat_s(exe, L"scr-hook.dll");
        wcscpy_s(dllPath, exe);
    }
    // 目标进程：argv[2]（默认 StarCraft.exe；发现流量在 mDNSResponder.exe 服务进程——传该名可注入服务）
    wchar_t target[MAX_PATH] = L"StarCraft.exe";
    if (argc > 2) MultiByteToWideChar(CP_ACP, 0, argv[2], -1, target, MAX_PATH);
    DWORD attr = GetFileAttributesW(dllPath);
    if (attr == INVALID_FILE_ATTRIBUTES) { printf("[ERR] DLL 不存在: %ls\n", dllPath); return 1; }
    printf("[1] DLL: %ls\n", dllPath);

    DWORD pid = FindPidByName(target);
    if (!pid) { printf("[ERR] 未找到 %ls 进程\n", target); return 2; }
    wprintf(L"[2] 目标进程 %ls pid=%d\n", target, pid);

    if (EnableDebugPriv()) printf("[2.5] SeDebugPrivilege 已启用\n");
    else printf("[2.5] SeDebugPrivilege 启用失败（服务进程可能仍拒绝访问）\n");

    HANDLE hProc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (!hProc) { printf("[ERR] OpenProcess 失败 err=%d（提权运行注入器了吗？/ 反作弊拦截？）\n", GetLastError()); return 3; }
    printf("[3] OpenProcess 成功\n");

    size_t pathBytes = (wcslen(dllPath) + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(hProc, NULL, pathBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) { printf("[ERR] VirtualAllocEx 失败 err=%d\n", GetLastError()); return 4; }
    if (!WriteProcessMemory(hProc, remote, dllPath, pathBytes, NULL)) { printf("[ERR] WriteProcessMemory 失败 err=%d\n", GetLastError()); return 5; }
    printf("[4] 远端写入 DLL 路径成功 (%zu bytes)\n", pathBytes);

    auto loadLib = (LPTHREAD_START_ROUTINE)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    if (!loadLib) { printf("[ERR] LoadLibraryW 定位失败\n"); return 6; }
    HANDLE th = CreateRemoteThread(hProc, NULL, 0, loadLib, remote, 0, NULL);
    if (!th) { printf("[ERR] CreateRemoteThread 失败 err=%d（反作弊拦截 CreateRemoteThread？）\n", GetLastError()); return 7; }
    printf("[5] 远端线程已创建，等待 LoadLibrary 返回...\n");
    WaitForSingleObject(th, 8000);
    DWORD exitCode = 0; GetExitCodeThread(th, &exitCode);
    printf("[6] LoadLibraryW 返回 0x%08X（0=失败，非 0=DLL 模块基址=注入成功）\n", exitCode);
    CloseHandle(th); CloseHandle(hProc);

    if (exitCode) {
        printf("[OK] 注入成功。Hook 日志位置：普通进程=%%TEMP%%\\scr-hook.log；SYSTEM 服务=C:\\Windows\\Temp\\scr-hook.log\n");
        return 0;
    }
    printf("[ERR] LoadLibraryW 返回 0——DLL 加载失败（依赖缺失/被拦截）\n");
    return 8;
}
