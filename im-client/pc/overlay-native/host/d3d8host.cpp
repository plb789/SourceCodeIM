// d3d8host.exe - M3 D3D8 适配层测试宿主（自证注入链路用，非发布产物；仅 x86——D3D8 无 64 位运行时）
// 一个最小 D3D8 窗口：旋转三角形，窗口标题显示 FPS——
// 注入 overlay_hook_x86.dll 后应看到：游戏画面上叠出 ImGui 面板（Shift+Tab 切换），FPS 无明显掉落
// Direct3DCreate8 经 GetProcAddress（不链接 d3d8.lib——third_party/d3d8 仅头文件）
#include <windows.h>
#include <cstdio>
#include <cmath>
#ifndef __MSABI_LONG
#define __MSABI_LONG(x) x##L // ReactOS 头依赖该宏（非 ReactOS 环境需自行定义）
#endif
#include "../third_party/d3d8/d3d8.h"

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

typedef IDirect3D8* (WINAPI* PFN_Direct3DCreate8)(UINT);

static IDirect3D8* g_d3d = NULL;
static IDirect3DDevice8* g_dev = NULL;
static HWND g_hwnd = NULL;
static DWORD g_lastTick = 0;
static int g_frames = 0;
static float g_angle = 0;

// 诊断日志（%TEMP%\d3d8host.log）：InitD3D 失败路径排查
static void ILog(const char* msg) {
    char path[MAX_PATH];
    UINT n = GetTempPathA(MAX_PATH, path);
    if (n == 0 || n > MAX_PATH - 40) return;
    strcat_s(path, "d3d8host.log");
    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    char line[256];
    int len = snprintf(line, sizeof(line), "[%lu] %s\r\n", GetTickCount(), msg);
    if (len > 0) { DWORD w = 0; WriteFile(f, line, (DWORD)len, &w, NULL); }
    CloseHandle(f);
}

struct V { float x, y, z, rhw; D3DCOLOR c; };
#define FVF (D3DFVF_XYZRHW | D3DFVF_DIFFUSE)

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(h, m, w, l);
}

static bool InitD3D(HWND h) {
    HMODULE d3d8 = GetModuleHandleW(L"d3d8.dll"); // 静态加载器在进程启动时已载（本项目用 LoadLibrary 保底）
    if (!d3d8) d3d8 = LoadLibraryW(L"d3d8.dll");
    if (!d3d8) { ILog("d3d8.dll not loaded"); return false; }
    PFN_Direct3DCreate8 create8 = (PFN_Direct3DCreate8)GetProcAddress(d3d8, "Direct3DCreate8");
    if (!create8) { ILog("Direct3DCreate8 export not found"); return false; }
    g_d3d = create8(D3D_SDK_VERSION);
    if (!g_d3d) { ILog("Direct3DCreate8 returned NULL"); return false; }
    D3DDISPLAYMODE dm = {};
    D3DFORMAT bbFmt = D3DFMT_UNKNOWN;
    if (SUCCEEDED(g_d3d->GetAdapterDisplayMode(D3DADAPTER_DEFAULT, &dm))) bbFmt = dm.Format; // D3D8 windowed 更稳：显式桌面格式
    D3DPRESENT_PARAMETERS pp = {};
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.hDeviceWindow = h;
    pp.BackBufferFormat = bbFmt;
    HRESULT hr = g_d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, h,
        D3DCREATE_HARDWARE_VERTEXPROCESSING, &pp, &g_dev);
    if (FAILED(hr)) {
        ILog("CreateDevice HW failed, retry MIXED/SW");
        hr = g_d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, h,
            D3DCREATE_MIXED_VERTEXPROCESSING, &pp, &g_dev);
        if (FAILED(hr)) hr = g_d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, h,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &g_dev);
    }
    if (FAILED(hr)) { ILog("CreateDevice all VP modes failed"); return false; }
    ILog("InitD3D ok");
    return true;
}

static void UpdateFpsTitle() {
    g_frames++;
    DWORD now = GetTickCount();
    if (now - g_lastTick >= 1000) {
        wchar_t t[64];
        wsprintfW(t, L"D3D8 POC Host - FPS: %d", g_frames);
        SetWindowTextW(g_hwnd, t);
        g_frames = 0;
        g_lastTick = now;
    }
}

static void Render() {
    if (!g_dev) return;
    g_dev->Clear(0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(22, 22, 30), 1.0f, 0);
    g_dev->BeginScene();
    const float cx = 632.0f, cy = 340.0f, r = 160.0f;
    V tri[3] = {
        { cx + (float)cos(g_angle) * r,          cy + (float)sin(g_angle) * r,          0, 1, D3DCOLOR_XRGB(0xEF, 0xAA, 0x17) },
        { cx + (float)cos(g_angle + 2.094f) * r, cy + (float)sin(g_angle + 2.094f) * r, 0, 1, D3DCOLOR_XRGB(0x07, 0xC1, 0x60) },
        { cx + (float)cos(g_angle + 4.188f) * r, cy + (float)sin(g_angle + 4.188f) * r, 0, 1, D3DCOLOR_XRGB(0x17, 0x6B, 0xEF) }
    };
    g_dev->SetVertexShader(FVF);
    g_dev->DrawPrimitiveUP(D3DPT_TRIANGLELIST, 1, tri, sizeof(V));
    g_dev->EndScene();
    g_dev->Present(NULL, NULL, NULL, NULL);
    UpdateFpsTitle();
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR cmdLine, int show) {
    // 模拟真实 D3D8 游戏：进程启动即静态加载 d3d8.dll（真游戏静态导入 d3d8.lib，DLL 在进程启动时
    // 就能检测到 d3d8.dll 并热补丁——若延迟到 InitD3D 才加载，create8 调用会先于补丁，实测踩坑）
    LoadLibraryW(L"d3d8.dll");
    // -delay <ms>：模拟大游戏"启动到 D3D 设备创建"的窗口期（验证注入竞态：注入须在此前完成）
    int delayMs = 0;
    if (cmdLine && *cmdLine) {
        wchar_t* p = wcsstr(cmdLine, L"-delay");
        if (p) delayMs = (int)wcstol(p + 6, NULL, 10);
    }
    if (delayMs > 0) Sleep((DWORD)delayMs);
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.lpszClassName = L"ImOverlayD3D8Host";
    RegisterClassExW(&wc);
    HWND h = CreateWindowExW(0, wc.lpszClassName, L"D3D8 POC Host", WS_OVERLAPPEDWINDOW, 100, 100, 1280, 720, NULL, NULL, inst, NULL);
    g_hwnd = h;
    if (!InitD3D(h)) return 1;
    ShowWindow(h, show);
    UpdateWindow(h);
    g_lastTick = GetTickCount();
    MSG msg;
    while (true) {
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) return 0;
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        g_angle += 0.01f;
        Render();
        Sleep(1);
    }
}
int main(int argc, char** argv) { return wWinMain(GetModuleHandleW(NULL), NULL, GetCommandLineW(), SW_SHOW); }
