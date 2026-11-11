// shortcut-helper.c -- 桌面快捷方式创建/删除/查询辅助工具
//
// 职责：纯命令行，给 im-client.exe 的 Electron main.js 经 spawnSync 调用，
//       创建 .lnk 桌面快捷方式（IShellLinkW COM），stdout 输出 UTF-8 JSON 供 Node.js 解析。
// 技术栈：纯 C + Win32 + IShellLinkW COM + /MT 静态 CRT（零运行库依赖）。
// 系统需求：Windows 7+（IShellLinkW 自 Win95 即有）。
//
// 命令行接口：
//   create  --name <str> --target <path> [--args <str>] [--workdir <path>]
//           [--icon "exePath,index" | --icon <exePath>] --desktop [--overwrite]
//   delete  --name <str> --desktop
//   exists  --name <str> --desktop   (exit 0=存在, 1=不存在, 2=错误)
//
// 构建：build-shortcut-helper.bat（VS2022 x64）
// 部署：编译产物 shortcut-helper.exe 留在本目录，electron-builder extraResources
//       仅将 exe 打入 resources/shortcut-helper/（源码目录文件全部排除）

#include <windows.h>
#include <shlobj.h>        /* IShellLinkW, IPersistFile, SHGetFolderPathW */
#include <stdio.h>
#include <stdarg.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")

#define MAX_PATH_W 32768
#define MAX_ARGS_W  8192
#define MAX_UTF8   (MAX_PATH_W * 4 + 16)  /* 每个 WCHAR 最多 3 字节 UTF-8，留些余量 */

/* ===== 全局：当前命令上下文 ===== */
static WCHAR g_cmd[32]        = { 0 };
static WCHAR g_name[MAX_PATH_W]    = { 0 };
static WCHAR g_target[MAX_PATH_W]  = { 0 };
static WCHAR g_args[MAX_ARGS_W]    = { 0 };
static WCHAR g_workdir[MAX_PATH_W] = { 0 };
static WCHAR g_icon[MAX_PATH_W]    = { 0 };
static int   g_iconIndex     = 0;
static int   g_flagDesktop   = 0;
static int   g_flagStartmenu = 0;
static int   g_flagOverwrite = 0;

/* ===== WCHAR -> UTF-8 转换（CRT，无运行库依赖）===== */
static int wchar_to_utf8(const WCHAR *src, char *dst, int dstCap) {
    if (!dstCap) return 0;
    if (!src || !*src) { dst[0] = 0; return 0; }
    int needed = WideCharToMultiByte(CP_UTF8, 0, src, -1, NULL, 0, NULL, NULL);
    if (needed > dstCap) needed = dstCap;
    WideCharToMultiByte(CP_UTF8, 0, src, -1, dst, needed, NULL, NULL);
    dst[needed - 1] = 0; /* 确保 null 终止 */
    return needed - 1;
}

/* ===== 把 UTF-8 字符串里的 JSON 特殊字符转义后输出 ===== */
static void put_escaped_utf8(const char *s) {
    char c;
    if (!s) return;
    while ((c = *s++)) {
        switch (c) {
            case '\\': fputs("\\\\", stdout); break;
            case '"':  fputs("\\\"", stdout); break;
            case '\b': fputs("\\b",  stdout); break;
            case '\f': fputs("\\f",  stdout); break;
            case '\n': fputs("\\n",  stdout); break;
            case '\r': fputs("\\r",  stdout); break;
            case '\t': fputs("\\t",  stdout); break;
            default:
                /* 非 ASCII（>=0x80）和普通可见字符直接原样输出 */
                if ((unsigned char)c >= 0x80 || c >= 0x20) putchar(c);
                break;
        }
    }
}

/* ===== 辅助：格式化 printf ===== */
static void out_printf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
}

/* ===== 输出 JSON 成功（含路径）===== */
static void ok_json_path(const WCHAR *lnkPath) {
    char utf8[MAX_UTF8];
    printf("{\"ok\":true,\"path\":\"");
    wchar_to_utf8(lnkPath, utf8, MAX_UTF8);
    put_escaped_utf8(utf8);
    printf("\"}\n");
}

/* ===== 输出 JSON 成功（无路径）===== */
static void ok_json_simple(void) {
    printf("{\"ok\":true}\n");
}

/* ===== 输出 JSON 失败 ===== */
static void err_json(DWORD code, const WCHAR *msg) {
    char utf8[MAX_UTF8];
    printf("{\"ok\":false,\"error\":\"");
    wchar_to_utf8(msg, utf8, MAX_UTF8);
    put_escaped_utf8(utf8);
    printf("\",\"code\":%lu}\n", (unsigned long)code);
}

/* ===== exists 成功输出 ===== */
static void exists_json(int found, const WCHAR *lnkPath) {
    char utf8[MAX_UTF8];
    if (found) {
        printf("{\"ok\":true,\"exists\":true,\"path\":\"");
        wchar_to_utf8(lnkPath, utf8, MAX_UTF8);
        put_escaped_utf8(utf8);
        printf("\"}\n");
    } else {
        printf("{\"ok\":true,\"exists\":false}\n");
    }
}

/* ===== 名称非法字符过滤 ===== */
static void sanitizeName(WCHAR *dst, const WCHAR *src) {
    static const WCHAR bad[] = { L'\\', L'/', L':', L'*', L'?', L'"', L'<', L'>', L'|', 0 };
    while (*src) {
        if (wcschr(bad, *src)) *dst++ = L'_';
        else                    *dst++ = *src;
        src++;
    }
    *dst = 0;
}

/* ===== 获取已知文件夹路径（CSIDL，Win7 兼容）===== */
static int get_known_path(WCHAR *out, int outCap, int csidl) {
    if (outCap <= 0) return 0;
    HRESULT hr = SHGetFolderPathW(NULL, csidl, NULL, 0, out);
    if (FAILED(hr)) { out[0] = 0; return 0; }
    return 1;
}

/* ===== 拼接目录 + 文件名 ===== */
static void join_path(WCHAR *out, int outCap, const WCHAR *dir, const WCHAR *file) {
    if (!dir || !*dir || outCap <= 0) { out[0] = 0; return; }
    swprintf_s(out, outCap, L"%s\\%s", dir, file);
}

/* ===== 解析 --icon 参数（格式: "exePath,index" 或纯 exePath）===== */
static void parse_icon(const WCHAR *spec) {
    const WCHAR *comma = NULL;
    WCHAR *p = NULL;
    int len = 0;

    g_icon[0] = 0;
    g_iconIndex = 0;
    if (!spec || !*spec) return;

    for (p = (WCHAR *)spec; *p; ++p) if (*p == L',') comma = p;

    if (comma) {
        len = (int)(comma - spec);
        if (len > 0) {
            wcsncpy_s(g_icon, MAX_PATH_W, spec, (size_t)len);
            g_icon[len] = 0;
        }
        g_iconIndex = (int)wcstol(comma + 1, NULL, 10);
    } else {
        wcsncpy_s(g_icon, MAX_PATH_W, spec, _TRUNCATE);
    }
}

/* ===== 解析命令行参数 ===== */
static int parse_args(int argc, WCHAR **argv) {
    int i = 0;
    WCHAR *a = NULL;
    WCHAR *val = NULL;
    int needVal = 0;

    for (i = 1; i < argc; i++) {
        a = argv[i];
        if (!a || a[0] != L'-') continue;
        needVal = 1;
        if (!wcscmp(a, L"--desktop"))   { g_flagDesktop   = 1; needVal = 0; }
        else if (!wcscmp(a, L"--startmenu")) { g_flagStartmenu = 1; needVal = 0; }
        else if (!wcscmp(a, L"--overwrite")) { g_flagOverwrite = 1; needVal = 0; }
        else {
            if (i + 1 >= argc) {
                err_json(1, L"缺少参数值");
                return -1;
            }
            val = argv[++i];
        }
        if (needVal) {
            if      (!wcscmp(a, L"--name"))    wcsncpy_s(g_name,    MAX_PATH_W,  val, _TRUNCATE);
            else if (!wcscmp(a, L"--target"))  wcsncpy_s(g_target,  MAX_PATH_W,  val, _TRUNCATE);
            else if (!wcscmp(a, L"--args"))    wcsncpy_s(g_args,    MAX_ARGS_W,  val, _TRUNCATE);
            else if (!wcscmp(a, L"--workdir")) wcsncpy_s(g_workdir, MAX_PATH_W,  val, _TRUNCATE);
            else if (!wcscmp(a, L"--icon"))    parse_icon(val);
            else {
                err_json(1, L"未知参数");
                return -1;
            }
        }
    }
    return 0;
}

/* ===== cmd_create ===== */
static int cmd_create(void) {
    HRESULT hr;
    IShellLinkW *pLink = NULL;
    IPersistFile *pFile = NULL;
    int rc = 1;
    WCHAR safeName[MAX_PATH_W];
    WCHAR dir[MAX_PATH_W];
    WCHAR lnkPath[MAX_PATH_W];
    int csidl;
    DWORD attr;

    if (!g_name[0] || !g_target[0]) {
        err_json(1, L"create 命令需要 --name 和 --target");
        return 1;
    }
    if (!g_flagDesktop && !g_flagStartmenu) {
        err_json(1, L"create 命令需要 --desktop 或 --startmenu");
        return 1;
    }

    sanitizeName(safeName, g_name);
    csidl = g_flagStartmenu ? CSIDL_STARTMENU : CSIDL_DESKTOPDIRECTORY;
    if (!get_known_path(dir, MAX_PATH_W, csidl)) {
        err_json(GetLastError(), L"获取桌面路径失败");
        return 1;
    }
    join_path(lnkPath, MAX_PATH_W, dir, safeName);
    wcscat_s(lnkPath, MAX_PATH_W, L".lnk");

    attr = GetFileAttributesW(lnkPath);
    if (attr != INVALID_FILE_ATTRIBUTES && !g_flagOverwrite) {
        err_json(1, L"快捷方式已存在（加 --overwrite 可覆盖）");
        return 1;
    }

    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        err_json(hr, L"COM 初始化失败");
        return 1;
    }

    hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                          &IID_IShellLinkW, (void **)&pLink);
    if (FAILED(hr)) {
        err_json(hr, L"CoCreateInstance ShellLink 失败");
        goto cleanup;
    }

    hr = pLink->lpVtbl->SetPath(pLink, g_target);
    if (FAILED(hr)) { err_json(hr, L"SetPath 失败"); goto cleanup; }

    if (g_args[0]) {
        hr = pLink->lpVtbl->SetArguments(pLink, g_args);
        if (FAILED(hr)) { err_json(hr, L"SetArguments 失败"); goto cleanup; }
    }

    if (g_workdir[0]) {
        hr = pLink->lpVtbl->SetWorkingDirectory(pLink, g_workdir);
        if (FAILED(hr)) { err_json(hr, L"SetWorkingDirectory 失败"); goto cleanup; }
    }

    if (g_icon[0]) {
        /* 图标设置失败不阻断创建 */
        pLink->lpVtbl->SetIconLocation(pLink, g_icon, g_iconIndex);
    }

    hr = pLink->lpVtbl->QueryInterface(pLink, &IID_IPersistFile, (void **)&pFile);
    if (FAILED(hr)) {
        err_json(hr, L"QueryInterface IPersistFile 失败");
        goto cleanup;
    }

    hr = pFile->lpVtbl->Save(pFile, lnkPath, TRUE);
    if (FAILED(hr)) {
        err_json(hr, L"Save .lnk 文件失败（可能是权限不足）");
        goto cleanup;
    }

    ok_json_path(lnkPath);
    rc = 0;

cleanup:
    if (pFile) { pFile->lpVtbl->Release(pFile); }
    if (pLink) { pLink->lpVtbl->Release(pLink); }
    CoUninitialize();
    return rc;
}

/* ===== cmd_delete ===== */
static int cmd_delete(void) {
    WCHAR safeName[MAX_PATH_W];
    WCHAR dir[MAX_PATH_W];
    WCHAR lnkPath[MAX_PATH_W];
    int csidl;
    DWORD attr;

    if (!g_name[0]) {
        err_json(1, L"delete 命令需要 --name");
        return 1;
    }
    if (!g_flagDesktop && !g_flagStartmenu) {
        err_json(1, L"delete 命令需要 --desktop 或 --startmenu");
        return 1;
    }

    sanitizeName(safeName, g_name);
    csidl = g_flagStartmenu ? CSIDL_STARTMENU : CSIDL_DESKTOPDIRECTORY;
    if (!get_known_path(dir, MAX_PATH_W, csidl)) {
        err_json(GetLastError(), L"获取桌面路径失败");
        return 1;
    }
    join_path(lnkPath, MAX_PATH_W, dir, safeName);
    wcscat_s(lnkPath, MAX_PATH_W, L".lnk");

    attr = GetFileAttributesW(lnkPath);
    if (attr == INVALID_FILE_ATTRIBUTES) {
        err_json(2, L"快捷方式不存在");
        return 2;
    }

    if (!DeleteFileW(lnkPath)) {
        err_json(GetLastError(), L"删除失败");
        return 1;
    }

    ok_json_simple();
    return 0;
}

/* ===== cmd_exists ===== */
static int cmd_exists(void) {
    WCHAR safeName[MAX_PATH_W];
    WCHAR dir[MAX_PATH_W];
    WCHAR lnkPath[MAX_PATH_W];
    int csidl;
    DWORD attr;

    if (!g_name[0]) {
        err_json(1, L"exists 命令需要 --name");
        return 2;
    }
    if (!g_flagDesktop && !g_flagStartmenu) {
        err_json(1, L"exists 命令需要 --desktop 或 --startmenu");
        return 2;
    }

    sanitizeName(safeName, g_name);
    csidl = g_flagStartmenu ? CSIDL_STARTMENU : CSIDL_DESKTOPDIRECTORY;
    if (!get_known_path(dir, MAX_PATH_W, csidl)) {
        err_json(GetLastError(), L"获取桌面路径失败");
        return 2;
    }
    join_path(lnkPath, MAX_PATH_W, dir, safeName);
    wcscat_s(lnkPath, MAX_PATH_W, L".lnk");

    attr = GetFileAttributesW(lnkPath);
    if (attr != INVALID_FILE_ATTRIBUTES) {
        exists_json(1, lnkPath);
        return 0;
    }

    exists_json(0, NULL);
    return 1;
}

/* ===== wmain：入口 ===== */
int wmain(int argc, WCHAR **argv) {
    /* 设置 stdout 为 UTF-8（Windows 10+ 支持，Win7 回退但也能输出） */
    SetConsoleOutputCP(CP_UTF8);

    if (argc < 2) {
        printf("Usage: shortcut-helper <create|delete|exists> [options]\n");
        return 2;
    }
    wcsncpy_s(g_cmd, 32, argv[1], _TRUNCATE);
    if (parse_args(argc, argv) != 0) return 2;

    if      (!wcscmp(g_cmd, L"create")) return cmd_create();
    else if (!wcscmp(g_cmd, L"delete")) return cmd_delete();
    else if (!wcscmp(g_cmd, L"exists")) return cmd_exists();
    else {
        err_json(1, L"未知命令：仅支持 create / delete / exists");
        return 2;
    }
}
