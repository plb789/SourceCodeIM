// d3d11_proxy.cpp - SC:R 版本劫持代理·D3D11 版（方案 B 立项 2026-10-28）
//
// 背景：deny-time 模块快照实锤 SC:R 主渲染 = D3D11（d3d11.dll + dxgi.dll + nvd3dumx NVIDIA
// D3D11 UMD 在进程稳定态在场；d3d9 路线对主渲染无捕获面）。本代理（部署为游戏目录 d3d11.dll）
// 借 DLL 搜索顺序（应用目录优先）被游戏动态解析加载：
//   1. D3D11CreateDevice / D3D11CreateDeviceAndSwapChain 转发真身（d3d11_orig.dll）并在设备
//      返回游戏前调 overlay_hook 的 OverlayHookD3D11Device 导出——hook 侧经 device QI
//      IDXGIDevice → GetParent 工厂 → 钩工厂虚表四个 CreateSwapChain* 槽 → 游戏建交换链被
//      捕获 → 钩其 Present(8)/Present1(22) → 每帧 ImGui DX11 渲染（时序零竞态、零拦截面——
//      设备是游戏自己建的）
//   2. 其余导出（D3DKMT* 单结构指针参数等）宏批透传转发
// 主模块白名单同 d3d9 代理（防同目录暴雪助手进程误拉）。

#include <windows.h>
#include <cstdio>

EXTERN_C IMAGE_DOS_HEADER __ImageBase;

// ===== 主模块白名单 =====
static bool AllowedHost() {
    wchar_t self[MAX_PATH] = { 0 };
    GetModuleFileNameW(NULL, self, MAX_PATH);
    const wchar_t* base = wcsrchr(self, L'\\');
    base = base ? base + 1 : self;
    if (lstrcmpiW(base, L"StarCraft.exe") == 0) return true;
    char env[8] = { 0 };
    return GetEnvironmentVariableA("IM_OVERLAY_PROXY_FORCE", env, sizeof(env)) && env[0] == '1';
}

// ===== 真身（d3d11_orig.dll）惰性加载（一次）=====
static volatile LONG g_origLoading = 0;
static HMODULE g_orig = NULL;
static FARPROC OrigProc(const char* name) {
    if (!g_orig) {
        if (InterlockedCompareExchange(&g_origLoading, 1, 0) == 0) {
            g_orig = LoadLibraryW(L"d3d11_orig.dll");
            InterlockedExchange(&g_origLoading, 0);
        } else {
            for (int i = 0; i < 200 && !g_orig; ++i) Sleep(5);
        }
    }
    return g_orig ? GetProcAddress(g_orig, name) : NULL;
}

// ===== 排障日志（与 hook DLL 共用 %TEMP%\im-overlay-hook.log）=====
static void LogLine11(const char* msg) {
    char path[MAX_PATH];
    UINT n = GetTempPathA(MAX_PATH, path);
    if (n == 0 || n > MAX_PATH - 40) return;
    strcat_s(path, "im-overlay-hook.log");
    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    char line[512];
    int len = snprintf(line, sizeof(line), "[%lu] d3d11proxy: %s\r\n", GetTickCount(), msg);
    if (len > 0) { DWORD w = 0; WriteFile(f, line, (DWORD)len, &w, NULL); }
    CloseHandle(f);
}

// ===== 拉起同目录 overlay_hook_x64.dll（幂等）→ 取 D3D11 handoff 导出 =====
typedef void (__stdcall *PFN_HookD3D11)(void* dev, void* ctx, void* sc);
static HMODULE g_hookDll = NULL;
static volatile LONG s_loadState = 0; // 0=未试 1=成功 2=失败
static PFN_HookD3D11 EnsureHookDll(void) {
    LONG st = InterlockedCompareExchange(&s_loadState, 0, 0);
    if (st == 1) return (PFN_HookD3D11)GetProcAddress(g_hookDll, "OverlayHookD3D11Device");
    if (st == 2) { LogLine11("EnsureHookDll: cached fail (loadState=2)"); return NULL; }
    if (InterlockedCompareExchange(&s_loadState, 3, 0) != 0) {
        for (int i = 0; i < 100; ++i) {
            LONG v = InterlockedCompareExchange(&s_loadState, 0, 0);
            if (v == 1 || v == 2) break;
            Sleep(2);
        }
        LogLine11(s_loadState == 1 ? "EnsureHookDll: spin-wait resolved ok" : "EnsureHookDll: spin-wait resolved fail");
        return (s_loadState == 1 && g_hookDll) ? (PFN_HookD3D11)GetProcAddress(g_hookDll, "OverlayHookD3D11Device") : NULL;
    }
    wchar_t dir[MAX_PATH];
    GetModuleFileNameW((HMODULE)&__ImageBase, dir, MAX_PATH);
    wchar_t* slash = wcsrchr(dir, L'\\');
    if (slash) {
        *(slash + 1) = L'\0';
        lstrcatW(dir, L"overlay_hook_x64.dll");
        g_hookDll = LoadLibraryW(dir);
        InterlockedExchange(&s_loadState, g_hookDll ? 1 : 2);
        char lb[MAX_PATH + 80];
        snprintf(lb, sizeof(lb), "EnsureHookDll: LoadLibraryW(%ls) = %p err=%lu", dir, (void*)g_hookDll, g_hookDll ? 0 : GetLastError());
        LogLine11(lb);
        PFN_HookD3D11 hk = g_hookDll ? (PFN_HookD3D11)GetProcAddress(g_hookDll, "OverlayHookD3D11Device") : NULL;
        LogLine11(hk ? "EnsureHookDll: OverlayHookD3D11Device resolved ok" : "EnsureHookDll: GetProcAddress OverlayHookD3D11Device FAILED");
        return hk;
    }
    InterlockedExchange(&s_loadState, 2);
    LogLine11("EnsureHookDll: no slash in self path");
    return NULL;
}

extern "C" {

// ===== 核心转发（精确签名 + handoff）=====
// D3D11CreateDevice：7 参（pAdapter/DriverType/Software/Flags/FeatureLevels/Num/SDKVersion/
// ppDevice/FeatureLevel/ppImmediateContext）——手写透传
__declspec(dllexport) HRESULT __stdcall D3D11CreateDevice(void* pAdapter, unsigned long driverType, unsigned long software, unsigned int flags, const void* pFeatureLevels, unsigned int numLevels, unsigned int sdkVersion, void** ppDevice, void* pFeatureLevel, void** ppImmediateContext) {
    typedef HRESULT (WINAPI* FP)(void*, unsigned long, unsigned long, unsigned int, const void*, unsigned int, unsigned int, void**, void*, void**);
    FP p = (FP)OrigProc("D3D11CreateDevice");
    HRESULT hr = p ? p(pAdapter, driverType, software, flags, pFeatureLevels, numLevels, sdkVersion, ppDevice, pFeatureLevel, ppImmediateContext) : E_NOTIMPL;
    {
        static volatile LONG s_logN = 0;
        if (InterlockedIncrement(&s_logN) <= 3) {
            char lb[160];
            snprintf(lb, sizeof(lb), "D3D11CreateDevice called hr=0x%08X dev=%p ctx=%p allowed=%d", (unsigned)hr, (ppDevice && *ppDevice) ? *ppDevice : NULL, (ppImmediateContext && *ppImmediateContext) ? *ppImmediateContext : NULL, AllowedHost() ? 1 : 0);
            LogLine11(lb);
        }
    }
    if (SUCCEEDED(hr) && ppDevice && *ppDevice && AllowedHost()) {
        PFN_HookD3D11 hk = EnsureHookDll();
        if (hk) {
            LogLine11("calling OverlayHookD3D11Device now...");
            hk(*ppDevice, ppImmediateContext ? *ppImmediateContext : NULL, NULL);
            LogLine11("OverlayHookD3D11Device call returned");
        }
        else LogLine11("D3D11CreateDevice: EnsureHookDll FAILED (OverlayHookD3D11Device not called)");
    }
    return hr;
}
// D3D11CreateDeviceAndSwapChain：10 参（末三参 ppImmediateContext/ppSwapChain 顺延）
__declspec(dllexport) HRESULT __stdcall D3D11CreateDeviceAndSwapChain(void* pAdapter, unsigned long driverType, unsigned long software, unsigned int flags, const void* pFeatureLevels, unsigned int numLevels, unsigned int sdkVersion, const void* pSwapChainDesc, void** ppSwapChain, void** ppDevice, void* pFeatureLevel, void** ppImmediateContext) {
    typedef HRESULT (WINAPI* FP)(void*, unsigned long, unsigned long, unsigned int, const void*, unsigned int, unsigned int, const void*, void**, void**, void*, void**);
    FP p = (FP)OrigProc("D3D11CreateDeviceAndSwapChain");
    HRESULT hr = p ? p(pAdapter, driverType, software, flags, pFeatureLevels, numLevels, sdkVersion, pSwapChainDesc, ppSwapChain, ppDevice, pFeatureLevel, ppImmediateContext) : E_NOTIMPL;
    {
        static volatile LONG s_logN = 0;
        if (InterlockedIncrement(&s_logN) <= 3) {
            char lb[160];
            snprintf(lb, sizeof(lb), "D3D11CreateDeviceAndSwapChain called hr=0x%08X dev=%p sc=%p", (unsigned)hr, (ppDevice && *ppDevice) ? *ppDevice : NULL, (ppSwapChain && *ppSwapChain) ? *ppSwapChain : NULL);
            LogLine11(lb);
        }
    }
    if (SUCCEEDED(hr) && ppDevice && *ppDevice && AllowedHost()) {
        PFN_HookD3D11 hk = EnsureHookDll();
        if (hk) {
            LogLine11("calling OverlayHookD3D11Device (AndSwapChain) now...");
            hk(*ppDevice, ppImmediateContext ? *ppImmediateContext : NULL, (ppSwapChain && *ppSwapChain) ? *ppSwapChain : NULL);
            LogLine11("OverlayHookD3D11Device (AndSwapChain) call returned");
        }
        else LogLine11("D3D11CreateDeviceAndSwapChain: EnsureHookDll FAILED");
    }
    return hr;
}

// ===== 透传宏批（x64 寄存器语义：真函数只读自己声明的参数，多余寄存器无害；
// ≤4 参全走寄存器零栈依赖——D3DKMT* 单结构指针/D3DPerformance 1-2 参安全）=====
#define FWD0(name) __declspec(dllexport) void* __stdcall name(void) { typedef void* (WINAPI* FP)(void); FP p = (FP)OrigProc(#name); return p ? p() : NULL; }
#define FWD1(name) __declspec(dllexport) void* __stdcall name(void* a) { typedef void* (WINAPI* FP)(void*); FP p = (FP)OrigProc(#name); return p ? p(a) : NULL; }
#define FWD2(name) __declspec(dllexport) void* __stdcall name(void* a, void* b) { typedef void* (WINAPI* FP)(void*, void*); FP p = (FP)OrigProc(#name); return p ? p(a, b) : NULL; }
#define FWD3(name) __declspec(dllexport) void* __stdcall name(void* a, void* b, void* c) { typedef void* (WINAPI* FP)(void*, void*, void*); FP p = (FP)OrigProc(#name); return p ? p(a, b, c) : NULL; }
#define FWD4(name) __declspec(dllexport) void* __stdcall name(void* a, void* b, void* c, void* d) { typedef void* (WINAPI* FP)(void*, void*, void*, void*); FP p = (FP)OrigProc(#name); return p ? p(a, b, c, d) : NULL; }

FWD3(CreateDirect3D11DeviceFromDXGIDevice)
FWD2(CreateDirect3D11SurfaceFromDXGISurface)
FWD4(D3D11CoreCreateDevice)
FWD1(D3D11CoreCreateLayeredDevice)
FWD1(D3D11CoreGetLayeredDeviceSize)
FWD1(D3D11CoreRegisterLayers)
FWD4(D3D11CreateDeviceForD3D12)
FWD4(D3D11On12CreateDevice)
FWD1(D3DKMTCloseAdapter)
FWD1(D3DKMTCreateAllocation)
FWD1(D3DKMTCreateContext)
FWD1(D3DKMTCreateDevice)
FWD1(D3DKMTCreateSynchronizationObject)
FWD1(D3DKMTDestroyAllocation)
FWD1(D3DKMTDestroyContext)
FWD1(D3DKMTDestroyDevice)
FWD1(D3DKMTDestroySynchronizationObject)
FWD1(D3DKMTEscape)
FWD1(D3DKMTGetContextSchedulingPriority)
FWD1(D3DKMTGetDeviceState)
FWD1(D3DKMTGetDisplayModeList)
FWD1(D3DKMTGetMultisampleMethodList)
FWD1(D3DKMTGetRuntimeData)
FWD1(D3DKMTGetSharedPrimaryHandle)
FWD1(D3DKMTLock)
FWD1(D3DKMTOpenAdapterFromHdc)
FWD1(D3DKMTOpenResource)
FWD1(D3DKMTPresent)
FWD1(D3DKMTQueryAdapterInfo)
FWD1(D3DKMTQueryAllocationResidency)
FWD1(D3DKMTQueryResourceInfo)
FWD1(D3DKMTRender)
FWD1(D3DKMTSetAllocationPriority)
FWD1(D3DKMTSetContextSchedulingPriority)
FWD1(D3DKMTSetDisplayMode)
FWD1(D3DKMTSetDisplayPrivateDriverFormat)
FWD1(D3DKMTSetGammaRamp)
FWD1(D3DKMTSetVidPnSourceOwner)
FWD1(D3DKMTSignalSynchronizationObject)
FWD1(D3DKMTUnlock)
FWD1(D3DKMTWaitForSynchronizationObject)
FWD0(D3DKMTWaitForVerticalBlankEvent)
FWD2(D3DPerformance_BeginEvent)
FWD0(D3DPerformance_EndEvent)
FWD0(D3DPerformance_GetStatus)
FWD2(D3DPerformance_SetMarker)
FWD1(EnableFeatureLevelUpgrade)
FWD1(OpenAdapter10)
FWD1(OpenAdapter10_2)

} // extern "C"

// ===== Bootstrap =====
static DWORD WINAPI BootstrapThread(LPVOID) {
    if (AllowedHost()) {
        wchar_t dir[MAX_PATH];
        GetModuleFileNameW((HMODULE)&__ImageBase, dir, MAX_PATH);
        wchar_t* slash = wcsrchr(dir, L'\\');
        if (slash) {
            *(slash + 1) = L'\0';
            lstrcatW(dir, L"overlay_hook_x64.dll");
            LoadLibraryW(dir); // 幂等（EnsureHookDll 已拉的场合返回已加载句柄）
        }
    }
    return 0;
}

BOOL APIENTRY DllMain(HMODULE mod, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(mod);
        HANDLE th = CreateThread(NULL, 0, BootstrapThread, NULL, 0, NULL);
        if (th) CloseHandle(th);
    }
    return TRUE;
}
