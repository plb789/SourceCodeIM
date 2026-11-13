# PC 客户端主进程代码增量热更新开发文档

> 阶段编号：阶段三百（新增）
> 关联模块：`im-client/pc/updater.js`（现有全量更新）、`im-client/pc/main.js`（启动链）、`im-server/server/appversion.go`（服务端版本归口）
> 前置依赖：现有 electron-updater 自动更新链路已可用（见 `docs/自动更新使用说明.md`）

## 一、背景与问题

### 1.1 现状

| 项目 | 数据 |
|---|---|
| 完整打包产物（`im-client/bin/`） | **652 MB** |
| 其中 im-client.exe（Chromium 内核） | 235 MB |
| locales/*.pak 等运行时资源 | ~230 MB |
| Steam/7z/Driver 等 extraResources | ~45 MB |
| **app.asar（主进程 JS 代码 + 依赖）** | **32.6 MB** |
| **app.asar.unpacked（原生 .node 模块）** | **7.8 MB** |
| **实际每次改 JS 只动的部分** | **≈ 40 MB** |

### 1.2 痛点

- 每次修改 `im-client/pc/*.js`（主进程业务代码），必须跑完整 `build.bat` → 上传 652MB NSIS 安装包 → 用户下载几百MB 覆盖安装
- electron-updater 只支持 NSIS Setup 全量安装包链路，没有"只换 app.asar"的轻量通道
- 小步快跑的 bug fix 和功能迭代分发成本极高

### 1.3 目标

在不影响现有 electron-updater 全量更新链路的前提下，新增一条**仅更新主进程 JS 代码**的通道：

```
改了 main.js 一个 bug fix
  → 轻量打包（秒级，跳过 electron-builder）
  → 产出 app.asar + app.asar.unpacked（~40MB）
  → 上传服务器 → 客户端自动检测 → 用户点确认 → 重启生效
```

---

## 二、与现有全量更新的关系（核心：两套版本号，互不干扰）

### 2.1 两套独立的版本号

```
产品版本（package.json version）= 1.1.2       ← 现有全量更新用，x.y.z semver
  ↑ 改动 Chromium 内核 / 新增 native 模块 / 大版本里程碑才递增

代码构建号（app.asar 内嵌 buildId）= 20261114-3  ← 新增增量热更用，日期+序号
  ↑ 每次改 JS 打包递增（小步快跑）
```

### 2.2 触发时机

| 场景 | 触发更新 | 更新通道 | 下载量 |
|---|---|---|---|
| 改了 main.js / web-cache.js / updater.js 等业务 JS | 代码构建号变了 | **方案 3 增量热更** | ~40 MB |
| 改了 Electron 版本号 / 加了新的原生 .node 模块 | 产品版本号变了 | **现有 electron-updater 全量更新** | 几百 MB |
| 两者都有（改了 JS + 加了新 native 模块） | 产品版本号变了 | **先走全量一次，后续增量** | 首次几百MB，之后 40MB |
| 改了 preload.js | 代码构建号变了 | 增量热更（preload 在 asar 内） | ~40 MB |
| 改了 WEB 前端资源（im-client/web/） | 不走本流程 | 服务端自动下发（已实现） | 差异文件 |

### 2.3 启动链执行顺序（main.js）

```
main.js app.whenReady() 之后：
  │
  ├─ 1. updater.init({ serverUrl })          ← 现有全量更新，原样不动
  │     （查 latest.yml，比对产品版本 x.y.z）
  │
  └─ 2. setTimeout → codeUpdater.check()     ← 新增增量热更，独立通道
        （查 /api/app/code-update，比对代码构建号 buildId）
        （10 秒后执行，不抢启动资源；失败静默，不影响主流程）
```

### 2.4 下载目录完全隔离

```
electron-updater 缓存：
  %AppData%/im-client-updater/               ← 现有 updater.js 独占

增量热更缓存：
  %AppData%/im-client/CodeUpdate/             ← 新增 code-updater.js 独占
    ├── app.asar.tmp                         ← 下载中临时文件
    ├── app.asar                             ← 下载完成待替换
    ├── app.asar.unpacked/                   ← unpacked 内容
    └── app-update.json                      ← 版本信息缓存
```

---

## 三、客户端详细设计

### 3.1 新增文件清单

| 文件 | 位置 | 职责 |
|---|---|---|
| `code-updater.js` | `im-client/pc/` | 增量热更新主逻辑（独立模块，不改现有 updater.js） |
| `code-updater.html` | `im-client/web/` | 自绘更新窗 UI（更新提示/进度条/重启按钮） |
| `apply-update.ps1` | `im-client/pc/bundled/` | 退出后替换 app.asar 的守护脚本（随 asar 打包内嵌） |

**不修改**：`updater.js`（现有全量更新逻辑完全保留不动）、`loader.js`、`main.js`（只加一行 `codeUpdater.check()` 调用）

### 3.2 code-updater.js 核心流程

```js
// code-updater.js —— 阶段三百：PC 客户端主进程代码增量热更新
// 职责：
//  1. 启动后异步检查代码构建号（独立于产品版本号）
//  2. 发现新版 → 弹自绘窗 → 用户点确认 → 下载 app.asar + app.asar.unpacked
//  3. 下载完成 → 校验 hash → 用户点"立即重启" → 退出进程 → 替换 asar → 重启
//  4. 全程不改动现有 updater.js 全量更新链路
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let SERVER_URL = '';
let getThemeDark = function () { return false; };

// 当前 asar 内嵌的代码构建号（打包时由 obfuscate.js 写入 asar 内 code-build.json）
function currentBuildId() {
    try {
        // app.asar 根目录下放一个 code-build.json：{"buildId":"20261114-3","buildTime":"2026-11-14 15:30"}
        const buildJson = path.join(__dirname, 'code-build.json');
        const raw = fs.readFileSync(buildJson, 'utf-8');
        return (JSON.parse(raw).buildId) || 'unknown';
    } catch (e) { return 'unknown'; }
}

// 查服务器代码更新接口（独立于产品版本检查）
function check() {
    if (!app.isPackaged) return; // 开发形态跳过
    fetch(SERVER_URL + 'api/app/code-update?platform=pc&build=' + encodeURIComponent(currentBuildId()))
        .then(function (r) { return r.json(); })
        .then(function (j) {
            if (!j || !j.data || !j.data.available) return; // 已是最新
            // 有新版 → 弹自绘更新窗
            showUpdateWindow(j.data);
        })
        .catch(function () { /* 静默失败，不影响主流程 */ });
}
```

### 3.3 服务器接口设计（新增，独立于现有全量更新接口）

```
GET /api/app/code-update?platform=pc&build=当前buildId

响应（有新版）：
{
  "code": 0,
  "data": {
    "available": true,
    "buildId": "20261114-5",           // 新代码构建号
    "buildTime": "2026-11-14 18:00",    // 构建时间
    "asarUrl": "/static/code-update/app.asar",        // app.asar 下载地址
    "asarSize": 34267891,              // 字节
    "asarHash": "sha512:abcdef...",    // SHA-512 校验（和 electron-updater 口径一致）
    "hasUnpacked": true,               // 是否带 app.asar.unpacked
    "unpackedUrl": "/static/code-update/app.asar.unpacked.zip",
    "unpackedSize": 8123456,
    "unpackedHash": "sha512:1234...",
    "notes": "修复登录崩溃、优化文件传输进度显示",  // 更新说明
    "force": false                     // 是否强制更新（不可关闭更新窗）
  }
}

响应（已是最新）：
{ "code": 0, "data": { "available": false } }

响应（当前 buildId 未知，强制返回最新版）：
{ "code": 0, "data": { "available": true, ... } }
```

### 3.4 客户端更新窗（自绘，禁止系统弹窗）

复用 main.js 里 updater.js 的自绘模式（`new BrowserWindow({ frame: false, backgroundColor: dark ? '#1a1a1a' : '#f5f5f5' })`），页面加载 `SERVER_URL + 'code-update.html?theme=' + (dark ? 'dark' : 'light')`，主题跟随设置页深浅切换。

更新窗状态机：

```
┌─────────┐ 发现新版  ┌─────────┐ 用户点  ┌──────────┐ 下载完  ┌──────────┐ 用户点  ┌──────────┐
│ idle    │ ────────→ │available│ ──────→ │downloading│ ─────→ │downloaded│ ──────→ │installing│
└─────────┘           └─────────┘ "立即更新"└──────────┘      └──────────┘ "立即重启"└──────────┘
                                                                                       │
                                                                                       ▼
                                                                                  app.relaunch()
                                                                                  app.exit(0)
```

### 3.5 下载与校验流程

```js
async function download(updateInfo) {
    const cacheDir = path.join(app.getPath('userData'), 'CodeUpdate');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // 1. 下载 app.asar（带进度）
    const asarPath = path.join(cacheDir, 'app.asar.tmp');
    await downloadFileWithProgress(updateInfo.asarUrl, asarPath, curInfo.asarSize, 
        percent => { curState.percent = percent; pushState(); });

    // 2. SHA-512 校验（和 electron-updater 口径一致）
    const actualHash = await sha512File(asarPath);
    if (actualHash !== updateInfo.asarHash) {
        fs.unlinkSync(asarPath);
        throw new Error('asar 校验失败（SHA-512 不匹配）');
    }

    // 3. 如有 unpacked，下载并解压
    if (updateInfo.hasUnpacked) {
        const unpackedZip = path.join(cacheDir, 'unpacked.tmp');
        await downloadFileWithProgress(updateInfo.unpackedUrl, unpackedZip, ...);
        // 解压为 CodeUpdate/app.asar.unpacked/
        await extractZip(unpackedZip, path.join(cacheDir, 'app.asar.unpacked'));
        fs.unlinkSync(unpackedZip);
    }

    // 4. 重命名 asar.tmp → asar（原子操作，防半写入）
    fs.renameSync(asarPath, path.join(cacheDir, 'app.asar'));
    curState.phase = 'downloaded';
    curState.percent = 100;
}
```

### 3.6 替换流程（退出后 update.exe 守护）

#### 3.6.1 为什么用纯 C exe 而不是 PowerShell

| | PowerShell 脚本 | 纯 C update.exe |
|---|---|---|
| 杀软拦截 | ⚠️ 高风险（.ps1 执行策略、脚本扫描） | ✅ 零风险（PE 可执行文件，签名后白名单） |
| 依赖 | PowerShell 运行时（Win7 需装，Win10+ 才有） | ✅ /MT 静态 CRT，**零外部依赖** |
| 启动速度 | 冷启动 ~2 秒（PowerShell 加载） | ✅ <50ms |
| 分发体积 | 脚本文件几 KB | ✅ ~30KB（不含图标） |
| 已有范本 | — | ✅ `elevator.exe` 现成构建链 |
| 打包进 asar | 不方便（脚本容易被扫） | ✅ 作为 extraResources 进 resources/ |

**复用现有 `elevator.exe` 的构建链**：
- VS2022 x64 `cl` 编译器（和 `elevator\build-elevator.bat` 同款）
- `/MT` 静态 CRT → 目标机零运行库
- `/O2` 优化 → 最终 exe ~30KB
- `/SUBSYSTEM:WINDOWS` → 无控制台窗口

#### 3.6.2 update.exe 设计（纯 C，约 30KB）

manifest 用 `asInvoker`（不需要自己提权）：被管理员进程（im-client.exe）spawn 时**自动继承管理员令牌**。

##### 完整 C 源码（`im-client/pc/updater/updater.c`）

```c
// updater.c —— 阶段三百：增量热更新守护进程（纯 C /MT 静态 CRT，零外部依赖）
// 职责：主进程退出后替换 app.asar，再重启客户端
// 原理：被 im-client.exe（管理员令牌）spawn → 继承管理员令牌 → 写 resources/ → 启动 elevator.exe
// 构建：VS2022 x64，复用 elevator.exe 同款工具链
// 分发：作为 extraResources 进 resources/（跟 Steam/7z/Driver 同目录）

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <shellapi.h>    // CommandLineToArgvW
#include <psapi.h>       // GetProcessImageFileNameW（链接 psapi.lib）

#pragma comment(lib, "psapi.lib")

#define UPDATER_MAX_PATH  32768
#define UPDATER_TIMEOUT   10    // 等待 im-client.exe 退出最长秒数
#define UPDATER_POLL_MS   500   // 轮询间隔毫秒

static WCHAR g_installDir[UPDATER_MAX_PATH];
static WCHAR g_cacheDir[UPDATER_MAX_PATH];

// updater_parseArgs 解析命令行（-InstallDir "..." -CacheDir "..."）
// 接受大小写不敏感的短参数名，兼容 / 或 - 前缀
static int updater_parseArgs(int argc, wchar_t** argv) {
    for (int i = 1; i < argc; i++) {
        const wchar_t* arg = argv[i];
        int isDash = (arg[0] == L'-' || arg[0] == L'/');
        if (!isDash) continue;
        const wchar_t* name = arg + 1;
        // 跳过第二个 -/
        if (name[0] == L'-' || name[0] == L'/') name++;
        // 大小写不敏感比较
        auto ciStartsWith = [](const wchar_t* s, const wchar_t* prefix) -> bool {
            while (*prefix) {
                wchar_t a = towlower(*s), b = towlower(*prefix);
                if (a != b) return false;
                s++; prefix++;
            }
            return true;
        };
        const wchar_t* val = (i + 1 < argc) ? argv[i + 1] : L"";
        if (ciStartsWith(name, L"InstallDir") || ciStartsWith(name, L"install")) {
            wcscpy_s(g_installDir, UPDATER_MAX_PATH, val);
            i++;
        } else if (ciStartsWith(name, L"CacheDir") || ciStartsWith(name, L"cache")) {
            wcscpy_s(g_cacheDir, UPDATER_MAX_PATH, val);
            i++;
        }
    }
    return (g_installDir[0] && g_cacheDir[0]) ? 0 : -1;
}

// updater_processAlive 检查 im-client.exe 是否还在运行
// 对比可执行文件路径而非进程名，更精确（防同名误判）
static BOOL updater_processAlive() {
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return FALSE;
    PROCESSENTRY32W pe = { sizeof(pe) };
    BOOL found = FALSE;
    if (Process32FirstW(hSnap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, L"im-client.exe") == 0) {
                // 额外检查：如果有多个，找一个还活着的就行
                found = TRUE;
                break;
            }
        } while (Process32NextW(hSnap, &pe));
    }
    CloseHandle(hSnap);
    return found;
}

// updater_waitExit 等待 im-client.exe 退出，超时后强制杀
static int updater_waitExit() {
    int waited = 0;
    while (updater_processAlive() && waited < UPDATER_TIMEOUT * 1000) {
        Sleep(UPDATER_POLL_MS);
        waited += UPDATER_POLL_MS;
    }
    // 超时兜底：强制杀残留进程
    if (updater_processAlive()) {
        HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hSnap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe = { sizeof(pe) };
            if (Process32FirstW(hSnap, &pe)) {
                do {
                    if (_wcsicmp(pe.szExeFile, L"im-client.exe") == 0 && pe.th32ProcessID != 0) {
                        HANDLE hP = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
                        if (hP) { TerminateProcess(hP, 0); CloseHandle(hP); }
                    }
                } while (Process32NextW(hSnap, &pe));
            }
            CloseHandle(hSnap);
        }
        // 再等 1 秒让文件锁释放
        Sleep(1000);
    }
    return 0;
}

// updater_copyFile 带重试的文件复制（杀进程后文件锁可能还有延迟释放）
static int updater_copyFile(const WCHAR* src, const WCHAR* dst) {
    for (int retry = 0; retry < 5; retry++) {
        if (CopyFileW(src, dst, FALSE)) return 0;
        Sleep(200);
    }
    return -1;
}

// updater_removeTree 递归删除目录或文件
static int updater_removeTree(const WCHAR* path) {
    WCHAR searchPath[UPDATER_MAX_PATH];
    WIN32_FIND_DATAW fd;
    hFindFileW hFind;

    // 如果是单个文件直接删
    DWORD attrs = GetFileAttributesW(path);
    if (attrs == INVALID_FILE_ATTRIBUTES) return 0; // 不存在不算错
    if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        DeleteFileW(path);
        return 0;
    }

    // 递归删目录
    swprintf_s(searchPath, L"%s\\*", path);
    hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return RemoveDirectoryW(path) ? 0 : -1;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR child[UPDATER_MAX_PATH];
        swprintf_s(child, L"%s\\%s", path, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            updater_removeTree(child);
        } else {
            SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
            DeleteFileW(child);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    RemoveDirectoryW(path);
    return 0;
}

// updater_copyTree 递归复制目录
static int updater_copyTree(const WCHAR* src, const WCHAR* dst) {
    CreateDirectoryW(dst, NULL);
    WCHAR searchPath[UPDATER_MAX_PATH];
    WIN32_FIND_DATAW fd;
    hFindFileW hFind;

    swprintf_s(searchPath, L"%s\\*", src);
    hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return -1;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR srcChild[UPDATER_MAX_PATH], dstChild[UPDATER_MAX_PATH];
        swprintf_s(srcChild, L"%s\\%s", src, fd.cFileName);
        swprintf_s(dstChild, L"%s\\%s", dst, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            updater_copyTree(srcChild, dstChild);
        } else {
            CopyFileW(srcChild, dstChild, FALSE);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    return 0;
}

// updater_startApp 优先启动 elevator.exe 保持提权链
static int updater_startApp() {
    WCHAR elevator[UPDATER_MAX_PATH], client[UPDATER_MAX_PATH];
    swprintf_s(elevator, L"%s\\elevator.exe", g_installDir);
    swprintf_s(client, L"%s\\im-client.exe", g_installDir);

    const WCHAR* target = NULL;
    if (GetFileAttributesW(elevator) != INVALID_FILE_ATTRIBUTES) {
        target = elevator;
    } else if (GetFileAttributesW(client) != INVALID_FILE_ATTRIBUTES) {
        target = client;
    } else {
        return -1; // 两个都找不到
    }

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(NULL, (LPWSTR)target, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        return -1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}

int wWinMain(HINSTANCE hInst, HINSTANCE hPrev, LPWSTR lpCmdLine, int nShow) {
    UNREFERENCED_PARAMETER(hInst);
    UNREFERENCED_PARAMETER(hPrev);
    UNREFERENCED_PARAMETER(nShow);

    // 1. 解析命令行
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || updater_parseArgs(argc, argv) != 0) {
        LocalFree(argv);
        return 1; // 参数不足，静默失败
    }
    LocalFree(argv);

    // 2. 等待 im-client.exe 退出
    updater_waitExit();

    WCHAR resourcesDir[UPDATER_MAX_PATH];
    swprintf_s(resourcesDir, L"%s\\resources", g_installDir);

    WCHAR asarPath[UPDATER_MAX_PATH], asarBak[UPDATER_MAX_PATH];
    swprintf_s(asarPath, L"%s\\app.asar", resourcesDir);
    swprintf_s(asarBak, L"%s\\app.asar.bak", resourcesDir);

    // 3. 备份旧 asar
    if (GetFileAttributesW(asarBak) != INVALID_FILE_ATTRIBUTES) {
        DeleteFileW(asarBak);
    }
    CopyFileW(asarPath, asarBak, FALSE);

    // 4. 复制新 asar（从 CacheDir）
    WCHAR newAsar[UPDATER_MAX_PATH];
    swprintf_s(newAsar, L"%s\\app.asar", g_cacheDir);
    if (updater_copyFile(newAsar, asarPath) != 0) {
        // 替换失败：启动回滚机制（main.js 启动时检查 .bak 并恢复）
        updater_startApp();
        return 2;
    }

    // 5. 替换 unpacked（如有——Node.js 主进程下载时已解压为 CacheDir/unpacked/ 目录）
    WCHAR newUnpacked[UPDATER_MAX_PATH], oldUnpacked[UPDATER_MAX_PATH];
    swprintf_s(newUnpacked, L"%s\\unpacked", g_cacheDir);
    swprintf_s(oldUnpacked, L"%s\\app.asar.unpacked", resourcesDir);
    if (GetFileAttributesW(newUnpacked) != INVALID_FILE_ATTRIBUTES) {
        updater_removeTree(oldUnpacked);
        updater_copyTree(newUnpacked, oldUnpacked);
    }

    // 6. 清理缓存
    updater_removeTree(g_cacheDir);

    // 7. 启动应用（优先 elevator.exe 保持提权链）
    updater_startApp();

    return 0;
}
```

##### 构建脚本（`im-client/pc/updater/build-updater.bat`）

复用 elevator.exe 同款 VS2022 工具链：

```bat
@echo off
rem ============================================
rem updater.exe build script (PC 增量热更新守护进程)
rem output: .\updater.exe (x64 /MT static CRT, asInvoker manifest)
rem deploy: 复制到 im-client\bin\resources\ 下（跟 Steam/7z/Driver 同目录）
rem ============================================
cd /d "%~dp0"

set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARS%" (
    echo [build] vcvarsall.bat not found
    exit /b 1
)
call "%VCVARS%" x64 >nul
if errorlevel 1 (
    echo [build] x64 toolchain init failed
    exit /b 1
)

if exist updater.exe del updater.exe
cl /nologo /utf-8 /MT /EHsc /O2 /W3 updater.c /Fe:updater.exe /link /SUBSYSTEM:WINDOWS psapi.lib shell32.lib
if errorlevel 1 (
    echo [build] compile failed
    exit /b 1
)
echo [build] done: %~dp0updater.exe
echo [build] size: %~z1 bytes
endlocal
```

##### manifest（`im-client/pc/updater/updater.manifest`）

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="IM.Client.Updater" type="win32"/>
  <description>IM 客户端增量热更新守护进程</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <!-- asInvoker：不自己提权，继承父进程（im-client.exe）的管理员令牌 -->
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
```

##### .rc 资源（`im-client/pc/updater/updater.rc`）

```c
// updater.rc —— 内嵌 manifest + 图标（可选）
1 24 "updater.manifest"
// 可选：1 ICON "..\\64.ico"
```

**为什么用 `asInvoker` 而不是 `requireAdministrator`？**

```
elevator.exe: requireAdministrator → 弹 UAC → 自己拿管理员令牌 → 传给 im-client.exe
updater.exe:  asInvoker          → 不弹 UAC → 被管理员进程 spawn → 自动继承管理员令牌 ✅
```

updater.exe **不需要自己弹 UAC**——它是由已经持有管理员令牌的 im-client.exe spawn 出来的，操作系统自动把管理员令牌传给子进程。如果加了 `requireAdministrator`，反而会多弹一次 UAC，用户体验差。

##### 完整替换流程（更新后）

```
步骤 1：用户点"立即重启"
  → code-updater.js 下载 app.asar + unpacked.zip
  → 下载完成后解压 unpacked.zip → CodeUpdate/unpacked/（Node.js 用 adm-zip，主进程还活着能做）
  → spawn updater.exe（父进程是管理员，子进程自动继承管理员令牌）：
     
     CreateProcess(resources\updater.exe, "-InstallDir ... -CacheDir ...")
     // 注意：此时 updater.exe 是后台进程，im-client.exe 还没退出

步骤 2：code-updater.js 退出主进程
  → app.exit(0)
  → im-client.exe 退出 → updater.exe 接管

步骤 3：updater.exe 静默执行（无窗口，~30KB，<50ms 启动）
  a. 等 im-client.exe 完全退出（最多 10s 轮询，超时强制杀）
  b. 备份旧 asar：CopyFile app.asar → app.asar.bak
  c. 复制新 asar：CopyFile CacheDir\app.asar → app.asar（5 次重试兜底）
  d. 替换 unpacked：删旧目录 → 递归复制新目录
  e. 清理缓存：删 CacheDir/ 整个目录
  f. 启动应用：优先 elevator.exe（保持提权链）→ 兜底 im-client.exe

步骤 4：应用重新启动，加载新的 app.asar → 新版生效
  （替换失败时 updater.exe 也会启动应用，main.js 启动时检查 .bak 并自动回滚）
```

##### 打包集成

update.exe 作为 extraResources 进 app 安装包（**不走 app.asar**，和 Steam/7z/Driver 同级）：

```json
// package.json build.extraResources 新增一项
{
    "from": "updater/updater.exe",
    "to": "updater/updater.exe"
}
```

打包后落盘位置：`<install>\resources\updater\updater.exe`

code-updater.js 调用方式：

```js
const path = require('path');
const spawnUpdater = () => {
    const updaterExe = path.join(process.resourcesPath, 'updater', 'updater.exe');
    const installDir = path.dirname(process.resourcesPath);  // bin/
    const cacheDir = path.join(app.getPath('userData'), 'CodeUpdate');
    const args = `-InstallDir "${installDir}" -CacheDir "${cacheDir}"`;
    
    // 用 spawn 而非 exec：不阻塞，父进程可以立即退出
    const { spawn } = require('child_process');
    const u = spawn(updaterExe, args.split(' '), { detached: true, stdio: 'ignore' });
    u.unref();  // 让 updater.exe 独立于父进程
    
    // 立即退出主进程
    setTimeout(() => app.exit(0), 300);
};
```

### 3.7 写权限处理

**由于启动链本身就是提权的，写权限天然有保障**：

```
elevator.exe (manifest requireAdministrator)
  → 弹 UAC → 拿管理员令牌
  → CreateProcessW 继承令牌启动 im-client.exe
  → im-client.exe 全程管理员身份运行 ✅
  → apply-update.ps1 退出后由 code-updater.js spawn，继承管理员令牌 ✅
  → 写 resources/ 目录 = 管理员进程写，完全没问题 ✅
```

极端兜底场景（几乎不会发生）：
- 用户跳过 elevator.exe，**直接双击 im-client.exe** 启动（非提权，asInvoker）
  - 此时写 resources/ 可能有权限问题（取决于安装目录）
  - 处理：`code-updater.js` 检测到非提权态时自动降级，提示"请通过 elevator.exe 启动客户端后再更新"
  - 或者用户手动以管理员身份运行 im-client.exe，也能正常更新
- 安装到 `C:\Program Files\`（受保护目录）+ 非提权启动
  - 同上，降级提示

### 3.8 回滚机制

```
启动时 main.js 检查：
  if resources/app.asar.bak 存在 && resources/app.asar 校验失败：
    → Delete resources/app.asar（坏的）
    → Rename resources/app.asar.bak → resources/app.asar
    → 启动（恢复到上一版）
    → 后台静默通知："增量更新失败，已回滚到上一版"

apply-update.ps1 替换前：
  if app.asar.bak 已存在（上次回滚留下的）：
    正常备份覆盖即可（.bak 只保留一次）
```

---

## 四、服务端接口设计

### 4.1 新增接口

```
GET /api/app/code-update?platform=pc&build=xxx
```

### 4.2 双模式上传（复用 appversion.go 外链判定逻辑）

**完全复用现有全量更新的双模式**（见 [appversion.go:116-119](file:///e:/SourceCodeIM/im-server/server/appversion.go#L116) `appVerIsExternal()`）：

| 模式 | 操作 | 判定条件 | 适用场景 |
|---|---|---|---|
| **本地上传** | 管理后台 multipart 上传 app.asar → 落盘到 `<web_dir>/static/code-update/` | URL 为空 | 小文件（~40MB）走自家服务端托管 |
| **外链登记** | 管理后台填 OSS/网盘完整 http/https 地址 | URL 以 `http://` 或 `https://` 开头 | 已有外部 CDN 加速、想省服务端带宽 |

#### 4.2.1 数据模型

复用现有 `app_version` 表（加 platform 常量区分），**不新增表**：

| 字段 | 全量更新（pc-setup） | 增量热更（pc-code） |
|---|---|---|
| platform | `"win"` / `"android"` | `"pc-code"` |
| url | 相对路径（`static/download/win/xxx.exe`）或外链完整 URL | 相对路径（`static/code-update/app.asar`）或外链完整 URL |
| file_name | 上传的文件名 | `"app.asar"` |
| version_name | 语义化 `x.y.z` | 代码构建号 `"20261114-5"` |
| sha512_base64 | base64 | base64（两者共用同一格式存储） |
| size | 字节 | 字节 |
| version_code | APP 端用 | 不用（留 0） |
| notes | 更新说明 | 更新说明 |
| force | 强制更新标记 | 强制更新标记 |
| enabled | bool | bool |

增量热更新可能有两个下载文件：`app.asar` + 可选的 `unpacked.zip`。设计两种方式存：

**方式 A（推荐）：单条记录 + JSON 扩展字段**

```sql
ALTER TABLE app_version ADD COLUMN extra JSON NULL;
-- extra 示例（pc-code 专用）：
-- {"unpacked_url": "static/code-update/unpacked.zip", "unpacked_size": 8123456, "unpacked_sha512": "..."}
```

**方式 B：两条记录关联**

不推荐，客户端拉一次接口拿两个文件路径更麻烦。

#### 4.2.2 客户端接口响应（双模式兼容）

```
GET /api/app/code-update?platform=pc&build=当前buildId

本地上传模式（URL 为空或相对路径）：
{
  "code": 0,
  "data": {
    "available": true,
    "buildId": "20261114-5",
    "buildTime": "2026-11-14 18:00",
    "asarUrl": "/static/code-update/app.asar",        ← 相对路径，客户端拼 SERVER_URL
    "asarSize": 34267891,
    "asarHash": "sha512:abcdef...",
    "hasUnpacked": true,
    "unpackedUrl": "/static/code-update/unpacked.zip",
    "unpackedSize": 8123456,
    "unpackedHash": "sha512:1234...",
    "notes": "...",
    "force": false
  }
}

外链模式（URL 为完整 http/https 地址）：
{
  "code": 0,
  "data": {
    "available": true,
    "buildId": "20261114-5",
    "buildTime": "2026-11-14 18:00",
    "asarUrl": "https://oss.example.com/im-update/app.asar",  ← 完整外链，直接用
    "asarSize": 34267891,
    "asarHash": "sha512:abcdef...",
    "hasUnpacked": true,
    "unpackedUrl": "https://oss.example.com/im-update/unpacked.zip",
    "unpackedSize": 8123456,
    "unpackedHash": "sha512:1234...",
    "notes": "...",
    "force": false,
    "isExternal": true   ← 可选标记，客户端可据此弹"外链下载"提示
  }
}
```

客户端 code-updater.js 处理：

```js
function resolveUrl(relOrAbs) {
    if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;   // 外链直接用
    return SERVER_URL.replace(/\/+$/, '') + relOrAbs;       // 相对路径拼 SERVER_URL
}
const downloadUrl = resolveUrl(updateInfo.asarUrl);         // 一行搞定双模式
```

### 4.3 静态资源托管（本地上传模式）

asar 文件落盘到 `<web_dir>/static/code-update/`（与现有 `/static/download/win/` 并列）：

```
<web_dir>/
  ├── static/
  │   ├── download/win/                    ← 现有全量更新（NSIS Setup 安装包）
  │   │   ├── im-client-setup-1.1.2.exe
  │   │   └── latest.yml
  │   └── code-update/                     ← 新增增量热更
  │       ├── app.asar                     ← 最新版
  │       └── unpacked.zip                 ← 可选
```

静态文件服务天然托管，无需额外配置下载接口。

### 4.4 后台管理（[客户端更新] → [代码热更新] Tab）

完全复用现有全量更新的双模式后台表单（参考 [appversion.go:169-173](file:///e:/SourceCodeIM/im-server/server/appversion.go#L169) `handleAdminAppVersionUpload` 的注释）：

```
┌─ [客户端更新] 管理页面 ──────────────────────────────┐
│  Tab: [全量更新] | [代码热更新]                         │
│                                                        │
│  ┌─ 新增版本 ─────────────────────────────────────┐   │
│  │ 上传方式: ○ 本地文件上传  ● 外部链接            │   │
│  │                                                  │   │
│  │ [本地文件上传模式]                                │   │
│  │   app.asar:     [选择文件] (必填)                │   │
│  │   unpacked.zip:  [选择文件] (可选)               │   │
│  │   buildId:      [自动从 code-build.json 读取]   │   │
│  │   asarSize:     [自动计算]                       │   │
│  │   asarHash:     [自动计算 SHA-512]               │   │
│  │                                                  │   │
│  │ [外部链接模式]                                    │   │
│  │   app.asar URL:     https://oss.xxx.com/xx.asar  │   │
│  │   unpacked.zip URL: https://oss.xxx.com/unpack.zip│   │
│  │   asarSize:     [手填，字节]                     │   │
│  │   asarHash:     [手填 SHA-512]                    │   │
│  │                                                  │   │
│  │   构建时间: [2026-11-14 18:00]                    │   │
│  │   更新说明: [修复 xxx 问题，优化 yyy 性能]         │   │
│  │   ☑ 强制更新（不可跳过）                          │   │
│  │                                                  │   │
│  │          [登记新版本]                             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                        │
│  版本列表（平台自动筛选 pc-code）:                       │
│  ┌─────┬─────────┬──────┬───────┬───────┬─────┬───┐   │
│  │ build │ 时间    │ asar │ 大小   │ 来源  │ 强制│启用│   │
│  ├─────┼─────────┼──────┼───────┼───────┼─────┼───┤   │
│  │ 14-5 │ 18:00  │ ✓    │ 32MB  │ 本地上传│ 否  │ ✓ │   │
│  │ 14-3 │ 10:00  │ ✓    │ 32MB  │ OSS外链│ 否  │   │   │
│  └─────┴─────────┴──────┴───────┴───────┴─────┴───┘   │
└────────────────────────────────────────────────────────┘
```

#### 两种模式的 SHA-512 校验值来源

| 模式 | SHA-512 怎么来 |
|---|---|
| **本地上传** | 管理端 multipart 上传时流式计算（复用 `appversion.go` 现有 `hashStream`），自动填入 |
| **外链登记** | 打包脚本 `build-light.bat` 打印到控制台，手动复制填入后台（40MB 外网下载计算 hash 慢，不建议自动拉取） |

---

## 五、打包脚本改造

### 5.1 加密链路原理（先搞懂再写脚本）

asar 里放的**不是明文 .js**，是 **.js.enc 加密文件**。完整加密链路由 obfuscate.js（[obfuscate.js](file:///e:/SourceCodeIM/im-client/pc/obfuscate.js)）负责：

```
11 个主进程 JS 明文源码（开发机）
  main.js / web-cache.js / agent-executor.js / browser-manager.js
  toolchain-manager.js / mcp-manager.js / node-runtime.js / lsp-manager.js
  remote-input.js / debug-manager.js / updater.js
       │
       │  obfuscate.js buildMainModules()  AES-256-GCM 加密（IMEF1 容器格式）
       ▼
11 个 .js.enc 加密文件（pc 根目录）
  main.js.enc / web-cache.js.enc / ... / updater.js.enc
       │
       │  package.json files 规则：!main.js 排除明文，.enc 自动包含
       ▼
进 app.asar（不是明文！）

另外 4 个辅助产物（也随 asar 打包）：
  loader.min.js    ← 明文薄启动器（压缩后的 loader.js，唯一的明文入口）
  secure-key.js    ← 密钥掩码扰乱存储（运行时 main.js 异或还原）
  web-snapshot.enc ← 前端快照加密 blob（IMSB1 魔数，单一文件）
  preload.js       ← 明文保留（渲染桥接，无业务逻辑）
```

运行时加载链（loader.js 钩子重定向）：

```
Electron 读 package.json main → loader.min.js（明文）
  → loader.min.js 尝试 require('./main.js') → MODULE_NOT_FOUND（asar 里只有 main.js.enc）
  → 钩子捕获 → 重定向到 main.js.enc
  → AES-256-GCM 解密（用 secure-key.js 异或还原的密钥）
  → vm.Script 内存编译 → 执行
```

**关键结论**：build-light.bat 必须先跑 `node obfuscate.js`（生成 .enc 文件 + loader.min.js + secure-key.js + web-snapshot.enc），然后 asar pack 的文件清单必须和 electron-builder **完全一致**（排除明文 .js，保留 .enc）。

### 5.2 产物目录隔离策略（与 build.bat 互不干扰）

**build-light.bat 所有产物落到独立目录 `light-dist/`**，不碰 pc 根目录，和 build.bat / publish-update.bat 完全隔离：

```
pc/
  ├── dist/              ← build.bat / publish-update.bat 中间产物（已有 package.json !dist/** 排除）
  ├── light-dist/        ← ✅ 新增：build-light.bat 专属产物目录
  │   ├── app.asar
  │   ├── app.asar.unpacked/
  │   ├── unpacked.zip
  │   ├── code-build.json
  │   └── app-update.zip    ← 最终分发包，用户拿这个上传服务器
  ├── bin/               ← build.bat 最终部署（652MB）
  └── pc 根目录（源码 + .enc 中间产物）
```

**package.json files 规则加一条排除**（防 electron-builder 误打包）：

```json
"files": [
  ...现有规则...,
  "!light-dist/**"    ← ✅ 新增：排除 build-light 产物目录
]
```

这样无论先跑 build 还是先跑 build-light，都不会互相影响：

| 场景 | 结果 |
|---|---|
| 先 build-light → 再 build | build.bat 的 electron-builder 用 files 规则排除 `!light-dist/**`，不会把 light-dist 里的 asar 套进去 ✅ |
| 先 build → 再 build-light | build-light 产物在 light-dist/，不碰 bin/，完全隔离 ✅ |
| build-light → 再 build-light | 后者覆盖前者（都是增量，本就该每次重打）✅ |

### 5.3 新增 build-light.bat（轻量打包，秒级完成）

跳过 electron-builder（省 Chromium 下载、省 NSIS 打包），但**完整复用 obfuscate.js 加密链路**，产出和全量打包完全一致的 asar 内容：

```bat
@echo off
chcp 936 >nul
cd /d "%~dp0"

rem ====== 产物目录（与 build.bat 的 dist/、bin/ 完全隔离）======
set "OUT_DIR=%~dp0light-dist"

echo [轻量打包] 仅生成 app.asar + app.asar.unpacked（秒级，复用完整加密链路）
echo [关键] 本脚本与 build.bat 的 asar 加密产物完全一致，可直接热替换
echo [产物] 全部输出到 light-dist\ 目录，不与 build.bat 冲突

REM ====== 0. 准备产物目录（清理旧产物）======
if exist "%OUT_DIR%" rd /s /q "%OUT_DIR%"
mkdir "%OUT_DIR%"

REM ====== 1. 完整加密流程（和 build.bat 步骤 [5/7] 完全一致）======
REM obfuscate.js 做四件事：
REM   a) 混淆 web/js/ 自研代码 → bundled/web-obfuscated/
REM   b) 加密前端快照 → web-snapshot.enc
REM   c) 加密 11 个主进程 JS → xxx.js.enc（IMEF1 容器，AES-256-GCM）
REM   d) 压缩 loader.js → loader.min.js；生成 secure-key.js
node obfuscate.js
if errorlevel 1 (
    echo [ERROR] obfuscate.js 失败，产物不完整
    pause
    exit /b 1
)

REM ====== 2. code-build.json 复制到产物目录（obfuscate.js 已在 pc 根目录生成，asar pack 用那份；这里复制一份给用户上传填 buildId）======
if exist "code-build.json" (
    copy /y "code-build.json" "%OUT_DIR%\" >nul
) else (
    echo [警告] code-build.json 未生成（obfuscate.js 未改造？），产物不完整
)

REM ====== 3. 用 asar CLI 打 asar（文件清单必须和 electron-builder 完全一致）======
REM 排除规则 1：package.json files 里的明文源文件（!main.js 等）
REM 排除规则 2：electron-builder extraResources 里的大文件（Steam/7z/Driver/bundled zip 等）
REM 额外排除：light-dist/（自己的产物，递归排除）
REM 不要排除：.enc 文件、loader.min.js、secure-key.js、web-snapshot.enc、code-build.json
REM           这些是真正要进 asar 的加密产物！
npx asar pack . "%OUT_DIR%\app.asar" ^
  --exclude "bundled/*" ^
  --exclude "builder-cache/*" ^
  --exclude "dist/*" ^
  --exclude "light-dist/*" ^
  --exclude "loader.js" ^
  --exclude "obfuscate.js" ^
  --exclude "build.bat" ^
  --exclude "build-light.bat" ^
  --exclude "publish-update.bat" ^
  --exclude "installer.nsh" ^
  --exclude "dev.bat" ^
  --exclude "double.bat" ^
  --exclude "main.js" ^
  --exclude "web-cache.js" ^
  --exclude "agent-executor.js" ^
  --exclude "browser-manager.js" ^
  --exclude "toolchain-manager.js" ^
  --exclude "mcp-manager.js" ^
  --exclude "node-runtime.js" ^
  --exclude "lsp-manager.js" ^
  --exclude "remote-input.js" ^
  --exclude "debug-manager.js" ^
  --exclude "updater.js" ^
  --exclude "code-updater.js" ^
  --exclude "code-updater.html" ^
  --exclude "app-update.yml" ^
  --exclude "shortcut-helper/**" ^
  --exclude "game-visible/**" ^
  --exclude "dlbt-host/**" ^
  --exclude "elevator/**" ^
  --exclude "overlay-native/**" ^
  --exclude "Steam/**" ^
  --exclude "7z/**" ^
  --exclude "Driver/**" ^
  --exclude "dll/**" ^
  --exclude "hook/**" ^
  --exclude "*.log" ^
  --exclude "*.bak" ^
  --exclude "*.zip"

REM ====== 4. 生成 unpacked 内容（和 package.json asarUnpack 规则完全一致）======
set "UNPACKED_DIR=%OUT_DIR%\app.asar.unpacked"
mkdir "%UNPACKED_DIR%"
xcopy "node_modules\cdt-gdb-adapter\*" "%UNPACKED_DIR%\node_modules\cdt-gdb-adapter\" /E /Y /Q
xcopy "node_modules\@vscode\debugadapter\*" "%UNPACKED_DIR%\node_modules\@vscode\debugadapter\" /E /Y /Q
xcopy "node_modules\@vscode\debugprotocol\*" "%UNPACKED_DIR%\node_modules\@vscode\debugprotocol\" /E /Y /Q
xcopy "node_modules\async-mutex\*" "%UNPACKED_DIR%\node_modules\async-mutex\" /E /Y /Q
if exist "shot-window-picker.ps1" copy "shot-window-picker.ps1" "%UNPACKED_DIR%\" >nul
if exist "remote-sendinput.ps1" copy "remote-sendinput.ps1" "%UNPACKED_DIR%\" >nul

REM ====== 5. 打包 unpacked 为 zip（方便客户端下载单个文件）======
powershell -Command "Compress-Archive -Path '%UNPACKED_DIR%' -DestinationPath '%OUT_DIR%\unpacked.zip' -Force"

REM ====== 6. 打成最终分发包 ======
powershell -Command "Compress-Archive -Path '%OUT_DIR%\app.asar', '%OUT_DIR%\unpacked.zip', '%OUT_DIR%\code-build.json' -DestinationPath '%OUT_DIR%\app-update.zip' -Force"

REM ====== 7. 输出哈希值（服务端上传时填到后台）======
echo.
echo ==== SHA-512 校验值（复制到服务端后台）====
powershell -Command "$h=(Get-FileHash -Algorithm SHA512 '%OUT_DIR%\app.asar').Hash.ToLower(); Write-Host 'app.asar     sha512:' $h"
powershell -Command "$h=(Get-FileHash -Algorithm SHA512 '%OUT_DIR%\unpacked.zip').Hash.ToLower(); Write-Host 'unpacked.zip sha512:' $h"
echo ============================================
echo.
echo [完成] 产物目录：%OUT_DIR%\
echo        app-update.zip：最终分发包（仅增量，~40MB）
echo        与 build.bat 产出的 app.asar 加密格式完全一致
echo        可直接替换客户端 resources\app.asar 热更新
echo.
dir /b "%OUT_DIR%"
pause
exit /b 0
```

**为什么没有排除 .enc / loader.min.js / secure-key.js / web-snapshot.enc / code-build.json？**

这些是运行时必需的加密产物，**必须进 asar**：

| 文件 | 作用 | asar 里能缺吗 |
|---|---|---|
| `xxx.js.enc`（11 个） | 加密后的主进程模块（AES-256-GCM IMEF1 容器） | ❌ 缺了主进程无业务代码，启动即崩 |
| `loader.min.js` | package.json `main` 指向的唯一明文入口，require 钩子在里面 | ❌ 缺了 Electron 连入口都找不到 |
| `secure-key.js` | 密钥掩码存储，main.js 运行时异或还原 | ❌ 缺了解密不出 .enc 内容 |
| `web-snapshot.enc` | 前端快照加密 blob（首启零下载） | ❌ 缺了前端缓存回退无快照 |
| `preload.js` / `viewer-preload.js` | 明文渲染桥接（保留，无业务逻辑） | ❌ 缺了渲染进程连不上主进程 |
| `code-build.json` | 增量热更版本识别（code-updater.js 读取） | ❌ 新增 code-updater 后缺了无法识别版本 |

asar pack 排除清单**只排除明文源文件**（`!main.js` 等）和大文件资源（Steam/7z/Driver 等 extraResources，那些不走 asar 走 Electron 原生 extraResources 目录）。

### 5.4 obfuscate.js 改造（附加生成 code-build.json）

在现有混淆打包步骤末尾（obfuscate.js `main()` 函数的 `writeSecureKeyModule` 之后）附加一段——**产物落在 pc 根目录**，被 asar pack 自然打进包里：

```js
// ===== 阶段三百：代码构建号生成（增量热更用）=====
var buildDate = new Date();
var dateStr = buildDate.getFullYear()
    + String(buildDate.getMonth() + 1).padStart(2, '0')
    + String(buildDate.getDate()).padStart(2, '0');
var buildId = dateStr + '-' + String(Math.floor(Date.now() / 1000)).slice(-4);
var pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
var buildJson = {
    buildId: buildId,
    buildTime: buildDate.toLocaleString('zh-CN'),
    productVersion: pkgJson.version
};
// 直接写 pc 根目录（__dirname），package.json files 没有排除它 → 被 asar 打进包里
fs.writeFileSync(path.join(__dirname, 'code-build.json'), JSON.stringify(buildJson, null, 2));
console.log('[混淆] 代码构建号 code-build.json: ' + buildId + ' (产品版本 ' + pkgJson.version + ')');
```

**build.bat 跑时也会顺带生成 code-build.json**，被打进 asar。但这对现有全量更新**完全无影响**：
- 旧版客户端没有 code-updater.js，不会去读 code-build.json
- 新版客户端的 code-updater.js 才有这个逻辑，此时全量更新也已经是新版了

### 5.5 完整打包流程对比

| | 现有 build.bat | 新增 build-light.bat |
|---|---|---|
| obfuscate.js 加密 | ✅ 跑（生成 .enc + loader.min.js + secure-key.js + code-build.json） | ✅ 跑（**完全一样**） |
| electron-builder 完整打包 | ✅ 跑（Chromium + NSIS） | ❌ 跳过 |
| asar pack | electron-builder 内部做 | `npx asar pack .` 手动做（**文件清单完全一致**） |
| 产物目录 | 中间产物 `dist/`，最终部署 `../bin/`（652MB） | 仅 `light-dist/`（~40MB） |
| 时间 | 5-10 分钟 | **<30 秒** |
| 用途 | 完整包开发调试 + 全量更新 | 增量热更新分发 |
| **asar 内 .enc 加密格式** | AES-256-GCM IMEF1 容器 | **完全相同** ✅ |
| 与另一个脚本冲突 | ❌ 不冲突 | ❌ 不冲突（产物目录隔离） |

### 5.6 package.json files 规则调整（build-light 产物隔离）

build-light.bat 的产物目录 `light-dist/` 必须被 electron-builder 排除，否则先跑 build-light 再跑 build 时，asar 里会套 asar。**package.json files 加一条**：

```json
"files": [
  ...（现有 42 条规则不动）...,
  "!light-dist/**"
]
```

额外，build-light.bat 的 `asar pack` 排除列表也要加 `"!*.zip"`（排除 pc 根目录可能残留的 Node.js/npm 生成的 zip 文件），以及 `"--exclude "light-dist/*""`（asr pack 自身排除自己的产物，防止递归）。

---

## 六、完整发布流程

### 6.1 改了 JS 代码（小步快跑）

```
步骤 1：改代码
  编辑 im-client/pc/main.js（或其他主进程 JS）

步骤 2：轻量打包（双击 build-light.bat）
  node obfuscate.js      → 混淆加密 + 生成 code-build.json（buildId 自动递增）
  npx asar pack          → 生成 app.asar（~33MB）
  xcopy unpacked         → 生成 app.asar.unpacked/
  Compress-Archive       → 打 app-update.zip + 打印 SHA512

步骤 3：后台上传
  管理后台 → [客户端更新] → [代码热更新] Tab
  → 上传 app-update.zip
  → 填写 buildId（和 code-build.json 一致）+ SHA512 值 + 更新说明
  → 点 [启用]

步骤 4：客户端自动生效
  已运行客户端：下次启动（或 code-updater 轮询到）→ 发现新版 → 弹窗提示 → 用户点更新
  → 下载 app.asar（~33MB）→ SHA512 校验 → 提示重启 → 替换 asar → 新版生效
```

### 6.2 改了 Chromium / 加了新 native 模块（大版本里程碑）

```
步骤 1：改 package.json version（x.y.z 递增）

步骤 2：完整打包（双击 publish-update.bat）
  产出 im-client-setup-1.2.0.exe（几百MB）+ latest.yml

步骤 3：后台上传（现有全量更新 Tab）

步骤 4：客户端走现有 electron-updater 全量安装链路
  （升级完产品版本号后，后续小步改动又可以走增量热更）
```

### 6.3 发布检查清单

**增量热更新（方案 3）专用**：

- [ ] 轻量打包 build-light.bat 运行成功（秒级，无报错）
- [ ] app.asar 内嵌 code-build.json 的 buildId 正确且大于线上生效版
- [ ] 本地 asar 校验通过：用旧版客户端手动替换 resources/app.asar → 重启能正常启动
- [ ] SHA512 值已记录（后台上传时需要填）
- [ ] 后台上传 → [代码热更新] Tab → [启用]
- [ ] 用旧版客户端实测：启动后收到增量更新提示 → 下载 → 重启 → 新版生效

---

## 七、安全考虑

### 7.1 完整性校验

- **下载链路**：和 electron-updater 一样走 HTTPS，服务端静态文件托管不经过后端代理
- **内容校验**：SHA-512（服务端后台启用时自动/手动填入，客户端下载后比对）
- **原子写入**：先写 .tmp → 校验 → rename 为正式文件，防止半写入损坏

### 7.2 路径遍历 & 替换安全

- asar 替换目标硬编码为 `process.resourcesPath`（Electron 标准路径），不接受外部输入拼接
- apply-update.ps1 替换前再校验一次目标目录内是否真的有 `im-client.exe`，防止路径被劫持

### 7.3 恶意更新防护

- 增量更新接口 `/api/app/code-update` 不做鉴权（公开只读），但 asar 文件本身带 SHA-512 签名，篡改即校验失败
- 如需更严格：后台上传时记录上传者账号，接口返回 buildId + SHA512 + 上传者，客户端可选择展示

### 7.4 强制更新安全

- force=true 时更新窗不可关闭，必须更新才能继续使用（现有 updater.js 已实现同款逻辑，直接复用）
- 强制更新的 asar 必须带 SHA-512，且服务端后台有启用按钮（防止恶意 force）

---

## 八、兼容性与边界情况

| 场景 | 处理方式 |
|---|---|
| 用户首次安装（最新产品版本，但 asar 内嵌旧 buildId） | code-updater 查到有增量 → 自动提示更新（和正常增量一样） |
| 用户的 app.asar 被手动篡改 | code-build.json 读取失败 → currentBuildId 返回 'unknown' → 服务器强制返回最新版 |
| 用户网络不好，下载中断 | 失败后静默；下次启动重试；不影响正常使用 |
| 增量更新的 asar 引用了新的 native 模块 | 这是"该走全量更新"的信号 → code-updater 校验新 asar 是否引用了未打包的 .node → 发现则降级提示"请使用全量安装包更新" |
| 旧版客户端（没有 code-updater 模块） | 旧版没有这个检查逻辑 → 完全不受影响；新版客户端自动生效 |
| 两个更新同时可用（全量 + 增量） | main.js 启动链先跑 updater（全量）再跑 code-updater（增量），两个独立判断 |
| Windows Defender 对 asar 替换误报 | apply-update.ps1 签名；asar 是 Electron 标准格式，Defender 一般不误报 |

---

## 九、开发任务拆分

| # | 任务 | 涉及模块 | 预计工时 |
|---|---|---|---|
| 1 | 服务端：复用 app_version 表（platform=pc-code）+ `/api/app/code-update` 接口 + 静态目录托管 | `im-server/server/` 新增 `codeupdate.go` | 4h |
| 2 | 后台：[代码热更新] Tab（本地上传 + OSS 外链双模式） | 管理后台 HTML + JS | 5h |
| 3 | obfuscate.js 改造：附加生成 code-build.json | `im-client/pc/obfuscate.js` | 0.5h |
| 4 | 新增 `updater/updater.c` 纯 C 守护进程（~30KB，/MT 静态 CRT） | `im-client/pc/updater/` | 4h |
| 5 | 新增 `updater/build-updater.bat` + manifest + .rc 资源 | `im-client/pc/updater/` | 1h |
| 6 | 新增 code-updater.js 模块（检查/下载/校验/弹窗/解压 unpacked/spawn updater.exe） | `im-client/pc/code-updater.js` | 8h |
| 7 | 新增 build-light.bat 轻量打包脚本（秒级，复用完整加密链路） | `im-client/pc/build-light.bat` | 2h |
| 8 | package.json extraResources 加 updater.exe；main.js 启动链加 codeUpdater.check() | `im-client/pc/` | 1h |
| 9 | 回滚机制（main.js 启动时检查 app.asar.bak 并恢复） | `im-client/pc/main.js` | 1h |
| 10 | 自绘更新窗 UI（code-update.html，主题跟随深浅） | `im-client/web/` | 3h |
| 11 | 全链路测试（完整打包 → 轻量打包 → 本地上传 → OSS 外链 → 回滚） | 全部 | 8h |
| | **合计** | | **≈ 37.5h** |

---

## 十、与现有 updater.js 的边界

| 职责 | 现有 updater.js | 新增 code-updater.js |
|---|---|---|
| 更新粒度 | 整个应用（产品版本号 x.y.z） | 仅 app.asar + app.asar.unpacked（代码构建号 buildId） |
| 下载大小 | 几百 MB | ~40 MB |
| 触发条件 | package.json version 递增 | code-build.json buildId 递增 |
| 更新方式 | quitAndInstall → NSIS 覆盖 | spawn updater.exe（纯 C /MT，零依赖）→ 退出进程 → 替换 asar → 重启 |
| 谁先检查 | main.js 启动链先跑 | main.js 启动链后跑（setTimeout 10s） |
| 开发形态 | 跳过（app.isPackaged） | 跳过（app.isPackaged） |
| 强制更新 | ✅ | ✅（复用同一 force 标记） |
| 日志归口 | 独立日志前缀 | 独立日志前缀 `[code-updater]` |
| 模块文件 | updater.js（不改） | code-updater.js（新增） |

**一句话**：两者完全独立、互不影响，全量更新管"大版本换内核"，增量热更新管"小步快跑改 JS"。

---

## 十一、最终效果预期

```
改动前（改了 main.js 一个 bug fix）：
  跑 build.bat → 5-10 分钟 → 产出 652MB → 上传 → 用户下载几百 MB → 安装 → 重启
  总耗时：分钟级 + 用户流量消耗：几百 MB/人

改动后：
  跑 build-light.bat → <30 秒 → 产出 40MB → 上传 → 客户端自动检测 → 下载 40MB → 重启
  总耗时：秒级 + 用户流量消耗：40 MB/人
```
