// d3d9host.exe - Overlay 二期 POC 测试宿主（自证注入链路用，非发布产物）
// 一个最小 D3D9 窗口：旋转三角形，窗口标题显示 FPS——
// 注入 overlay_hook.dll 后应看到：游戏画面上叠出测试面板（Shift+Tab 切换），FPS 无明显掉落
#include <windows.h>
#include <d3d9.h>
#include <cmath>
#include <cstdio>

#pragma comment(lib, "d3d9.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

static IDirect3D9* g_d3d = NULL;
static IDirect3DDevice9* g_dev = NULL;
static HWND g_hwnd = NULL;
static DWORD g_lastTick = 0;
static int g_frames = 0;
static float g_angle = 0;

struct V { float x, y, z, rhw; D3DCOLOR c; };
#define FVF (D3DFVF_XYZRHW | D3DFVF_DIFFUSE)

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(h, m, w, l);
}

static bool InitD3D(HWND h) {
    g_d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!g_d3d) return false;
    D3DPRESENT_PARAMETERS pp = {};
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferFormat = D3DFMT_UNKNOWN;
    pp.hDeviceWindow = h;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_DEFAULT;
    return SUCCEEDED(g_d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, h, D3DCREATE_HARDWARE_VERTEXPROCESSING, &pp, &g_dev));
}

static void UpdateFpsTitle() {
    g_frames++;
    DWORD now = GetTickCount();
    if (now - g_lastTick >= 1000) {
        wchar_t t[64];
        swprintf(t, 64, L"D3D9 POC Host - FPS: %d", g_frames * 1000 / (now - g_lastTick));
        SetWindowTextW(g_hwnd, t);
        g_lastTick = now;
        g_frames = 0;
    }
}

static void Render() {
    if (!g_dev) return;
    g_dev->Clear(0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(30, 34, 40), 1.0f, 0);
    g_dev->BeginScene();
    g_angle += 0.03f;
    float cx = 640, cy = 360, r = 200;
    V tri[3] = {
        { cx + (float)cos(g_angle) * r,          cy + (float)sin(g_angle) * r,          0, 1, D3DCOLOR_XRGB(7, 193, 96) },
        { cx + (float)cos(g_angle + 2.094f) * r, cy + (float)sin(g_angle + 2.094f) * r, 0, 1, D3DCOLOR_XRGB(0x2B, 0x6C, 0xB8) },
        { cx + (float)cos(g_angle + 4.188f) * r, cy + (float)sin(g_angle + 4.188f) * r, 0, 1, D3DCOLOR_XRGB(0xEF, 0xAA, 0x17) }
    };
    g_dev->SetFVF(FVF);
    g_dev->DrawPrimitiveUP(D3DPT_TRIANGLELIST, 1, tri, sizeof(V));
    g_dev->EndScene();
    g_dev->Present(NULL, NULL, NULL, NULL);
    UpdateFpsTitle();
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR cmdLine, int show) {
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
    wc.lpszClassName = L"ImOverlayPocHost";
    RegisterClassExW(&wc);
    HWND h = CreateWindowExW(0, wc.lpszClassName, L"D3D9 POC Host", WS_OVERLAPPEDWINDOW, 100, 100, 1280, 720, NULL, NULL, inst, NULL);
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
        Render();
        Sleep(1);
    }
}
int main(int argc, char** argv) { return wWinMain(GetModuleHandleW(NULL), NULL, GetCommandLineW(), SW_SHOW); }
