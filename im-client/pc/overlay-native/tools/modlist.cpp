// modlist.cpp - 诊断工具：列指定进程已加载模块（x86 工具可枚举 WoW64 进程；验证完可删）
// 用法：modlist.exe <pid> [过滤关键字小写]
#include <windows.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>

int main(int argc, char** argv) {
    if (argc < 2) { printf("usage: modlist.exe <pid> [filter]\n"); return 1; }
    DWORD pid = (DWORD)atol(argv[1]);
    const char* filter = argc >= 3 ? argv[2] : NULL;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snap == INVALID_HANDLE_VALUE) { printf("snapshot failed err=%lu\n", GetLastError()); return 1; }
    MODULEENTRY32W me;
    me.dwSize = sizeof(me);
    if (!Module32FirstW(snap, &me)) { printf("Module32First failed err=%lu\n", GetLastError()); CloseHandle(snap); return 1; }
    int n = 0;
    do {
        char nameA[MAX_PATH];
        WideCharToMultiByte(CP_ACP, 0, me.szModule, -1, nameA, MAX_PATH, NULL, NULL);
        for (int i = 0; nameA[i]; ++i) if (nameA[i] >= 'A' && nameA[i] <= 'Z') nameA[i] += 32;
        if (!filter || strstr(nameA, filter)) { printf("%s\n", nameA); n++; }
    } while (Module32NextW(snap, &me));
    CloseHandle(snap);
    printf("--- total %d ---\n", n);
    return 0;
}
