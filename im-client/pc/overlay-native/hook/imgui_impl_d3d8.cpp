// imgui_impl_d3d8.cpp - ImGui 的 D3D8 后端（M3 自写精简版；官方无 d3d8 backend，
// 参照 imgui_impl_dx9.cpp 移植。D3D8 与 D3D9 主要差异：SetVertexShader(FVF DWORD) 载 FVF、
// stateblock 为 token 制（CreateStateBlock/ApplyStateBlock/DeleteStateBlock）、
// SetIndices 自带基址顶点偏移参数、无 32 位索引、无 SetScissorRect（裁剪取舍见下）、D3D8 仅 x86）。
//
// 与 dx9 后端一致的三点约定：
//   1. RenderDrawData 由调用方在 Present 钩内调用（场景外渲染，本项目实测稳定，见设计文档踩坑 4）；
//   2. 动态 VB/IB（D3DPOOL_DEFAULT + D3DLOCK_DISCARD），设备 Reset 后由钩子调 Invalidate/CreateDeviceObjects 重建；
//   3. 裁剪：D3D8 无 scissor API——矩形裁剪缺失会导致溢出绘制（本面板自绘内容可控、圆角/滚动区域少，
//      取"不裁剪"降级；若后续出现溢出伪影，再换 CPU 侧顶点钳制或像素着色器方案）。

#ifndef __MSABI_LONG
#define __MSABI_LONG(x) x##L // ReactOS 头依赖（D3D_SDK_VERSION）
#endif
#include <windows.h>
#include <cstdio>
#include "imgui.h"
#include "../third_party/d3d8/d3d8.h"

// M3 诊断：HRESULT 首败记录（自包含写 %TEMP%\im-overlay-hook.log，与 hook 主模块同一日志）
static void HrLog(const char* what, HRESULT hr) {
    static const char* seen[16] = { 0 };
    static int seenN = 0;
    for (int i = 0; i < seenN; ++i) { if (seen[i] == what) return; }
    if (seenN < 16) seen[seenN++] = what;
    char path[MAX_PATH];
    UINT n = GetTempPathA(MAX_PATH, path);
    if (n == 0 || n > MAX_PATH - 40) return;
    strcat_s(path, "im-overlay-hook.log");
    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    char line[160];
    int len = snprintf(line, sizeof(line), "[%lu] d3d8 backend: %s failed hr=0x%08lX\r\n", GetTickCount(), what, (unsigned long)hr);
    if (len > 0) { DWORD w = 0; WriteFile(f, line, (DWORD)len, &w, NULL); }
    CloseHandle(f);
}
struct ImGui_ImplD3D8_Data {
    IDirect3DDevice8*   pd3dDevice = NULL;
    IDirect3DTexture8*  pFontTexture = NULL;
    IDirect3DVertexBuffer8* pVB = NULL;
    IDirect3DIndexBuffer8*  pIB = NULL;
    DWORD               dwStateBlock = 0;   // state block token（CreateStateBlock 产物）
    UINT                vbSize = 0, ibSize = 0;
};
static ImGui_ImplD3D8_Data* g_bd8 = NULL;

void ImGui_ImplD3D8_Shutdown(); // 前置声明（Init 内复用重复初始化防护）

static ImGui_ImplD3D8_Data* ImGui_ImplD3D8_GetBackendData() { return g_bd8; }

// D3D8 固定 FVF 流水线无 vertex declaration：内存布局必须严格符合 FVF 顺序
// （x,y,z,rhw,col,tu,tv），而 ImDrawVert 是 (x,y,u,v,col) 且颜色为 RGBA 内存序——
// 上传时必须逐顶点转换 + R/B 交换（dx9 后端同款宏），直接 memcpy 会顶点错位全画飞（实测踩坑）
struct D3D8Vtx { float x, y, z, rhw; D3DCOLOR col; float u, v; };
#define IMGUI_COL_TO_D3D8_ARGB(_COL) (((_COL) & 0xFF00FF00) | (((_COL) & 0xFF0000) >> 16) | (((_COL) & 0xFF) << 16))

// ---- 字体纹理（RGBA32 → A8R8G8B8 内存序重排）----
static bool ImGui_ImplD3D8_CreateFontsTexture() {
    ImGui_ImplD3D8_Data* bd = g_bd8;
    ImGuiIO& io = ImGui::GetIO();
    unsigned char* pixels = NULL;
    int width = 0, height = 0;
    io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
    if (!pixels || width <= 0 || height <= 0) return false;
    if (bd->pFontTexture) { bd->pFontTexture->Release(); bd->pFontTexture = NULL; }
    if (FAILED(bd->pd3dDevice->CreateTexture(width, height, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &bd->pFontTexture)))
        return false;
    D3DLOCKED_RECT lr;
    if (FAILED(bd->pFontTexture->LockRect(0, &lr, NULL, 0))) return false;
    for (int y = 0; y < height; ++y) {
        const unsigned char* src = pixels + (size_t)y * width * 4;             // R,G,B,A
        unsigned char* dst = (unsigned char*)lr.pBits + (size_t)y * lr.Pitch;  // B,G,R,A
        for (int x = 0; x < width; ++x) {
            dst[x * 4 + 0] = src[x * 4 + 2]; // B
            dst[x * 4 + 1] = src[x * 4 + 1]; // G
            dst[x * 4 + 2] = src[x * 4 + 0]; // R
            dst[x * 4 + 3] = src[x * 4 + 3]; // A
        }
    }
    bd->pFontTexture->UnlockRect(0);
    io.Fonts->SetTexID((ImTextureID)(intptr_t)bd->pFontTexture);
    return true;
}

bool ImGui_ImplD3D8_CreateDeviceObjects() {
    ImGui_ImplD3D8_Data* bd = g_bd8;
    if (!bd || !bd->pd3dDevice) return false;
    if (!ImGui_ImplD3D8_CreateFontsTexture()) return false;
    // 状态块（token 制）：CreateStateBlock(D3DSBT_ALL) 即捕获当前全部状态，ApplyStateBlock 还原
    bd->dwStateBlock = 0;
    if (FAILED(bd->pd3dDevice->CreateStateBlock(D3DSBT_ALL, &bd->dwStateBlock))) bd->dwStateBlock = 0;
    bd->vbSize = 20000 * (UINT)sizeof(ImDrawVert);
    bd->ibSize = 40000 * (UINT)sizeof(ImDrawIdx);
    if (FAILED(bd->pd3dDevice->CreateVertexBuffer(bd->vbSize, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
        D3DFVF_XYZRHW | D3DFVF_DIFFUSE | D3DFVF_TEX1, D3DPOOL_DEFAULT, &bd->pVB)))
        return false;
    if (FAILED(bd->pd3dDevice->CreateIndexBuffer(bd->ibSize, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
        sizeof(ImDrawIdx) == 2 ? D3DFMT_INDEX16 : D3DFMT_INDEX32, D3DPOOL_DEFAULT, &bd->pIB)))
        return false;
    return true;
}

void ImGui_ImplD3D8_InvalidateDeviceObjects() {
    ImGui_ImplD3D8_Data* bd = g_bd8;
    if (!bd || !bd->pd3dDevice) return;
    if (bd->pFontTexture) { bd->pFontTexture->Release(); bd->pFontTexture = NULL; ImGui::GetIO().Fonts->SetTexID(NULL); }
    if (bd->pVB) { bd->pVB->Release(); bd->pVB = NULL; }
    if (bd->pIB) { bd->pIB->Release(); bd->pIB = NULL; }
    if (bd->dwStateBlock) { bd->pd3dDevice->DeleteStateBlock(bd->dwStateBlock); bd->dwStateBlock = 0; }
}

bool ImGui_ImplD3D8_Init(IDirect3DDevice8* device) {
    if (g_bd8) ImGui_ImplD3D8_Shutdown();
    if (!device) return false;
    g_bd8 = new ImGui_ImplD3D8_Data();
    g_bd8->pd3dDevice = device;
    device->AddRef();
    return true;
}

void ImGui_ImplD3D8_Shutdown() {
    ImGui_ImplD3D8_Data* bd = g_bd8;
    if (!bd) return;
    ImGui_ImplD3D8_InvalidateDeviceObjects();
    if (bd->pd3dDevice) { bd->pd3dDevice->Release(); bd->pd3dDevice = NULL; }
    delete bd;
    g_bd8 = NULL;
}

void ImGui_ImplD3D8_NewFrame() {
    // dx9 后端此函数为空壳（鼠标/键盘由 Win32 后端负责），保持同形
    IM_ASSERT(g_bd8 != NULL);
}

void ImGui_ImplD3D8_RenderDrawData(ImDrawData* draw_data) {
    ImGui_ImplD3D8_Data* bd = g_bd8;
    if (!bd || !bd->pd3dDevice) return;
    { // M3 诊断：调用可见性（前 3 帧；放 DisplaySize 检查前防静默早退盲区）
        static int logged = 0;
        if (logged < 3) {
            ++logged;
            char path[MAX_PATH];
            UINT pn = GetTempPathA(MAX_PATH, path);
            if (pn && pn < MAX_PATH - 40) {
                strcat_s(path, "im-overlay-hook.log");
                HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, 0, NULL);
                if (f != INVALID_HANDLE_VALUE) {
                    char line[160];
                    int len = snprintf(line, sizeof(line), "[%lu] d3d8 RenderDrawData #%d size=%.0fx%.0f vtx=%d idx=%d\r\n",
                        GetTickCount(), logged, draw_data->DisplaySize.x, draw_data->DisplaySize.y,
                        draw_data->TotalVtxCount, draw_data->TotalIdxCount);
                    if (len > 0) { DWORD w = 0; WriteFile(f, line, (DWORD)len, &w, NULL); }
                    CloseHandle(f);
                }
            }
        }
    }
    IDirect3DDevice8* device = bd->pd3dDevice;
    if (draw_data->DisplaySize.x <= 0.0f || draw_data->DisplaySize.y <= 0.0f) return;

    // 缓冲不足时重建（动态池；顶点按 D3D8 FVF 布局，比 ImDrawVert 多 z/rhw 两 float）
    if (!bd->pVB || bd->vbSize < (UINT)draw_data->TotalVtxCount * (UINT)sizeof(D3D8Vtx)) {
        if (bd->pVB) { bd->pVB->Release(); bd->pVB = NULL; }
        bd->vbSize = (UINT)(draw_data->TotalVtxCount + 1000) * (UINT)sizeof(D3D8Vtx);
        HRESULT hvb = bd->pd3dDevice->CreateVertexBuffer(bd->vbSize, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
            D3DFVF_XYZRHW | D3DFVF_DIFFUSE | D3DFVF_TEX1, D3DPOOL_DEFAULT, &bd->pVB);
        if (FAILED(hvb)) { HrLog("CreateVertexBuffer", hvb); return; }
    }
    if (!bd->pIB || bd->ibSize < (UINT)draw_data->TotalIdxCount * (UINT)sizeof(ImDrawIdx)) {
        if (bd->pIB) { bd->pIB->Release(); bd->pIB = NULL; }
        bd->ibSize = (UINT)(draw_data->TotalIdxCount + 2000) * (UINT)sizeof(ImDrawIdx);
        HRESULT hib = bd->pd3dDevice->CreateIndexBuffer(bd->ibSize, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
            sizeof(ImDrawIdx) == 2 ? D3DFMT_INDEX16 : D3DFMT_INDEX32, D3DPOOL_DEFAULT, &bd->pIB);
        if (FAILED(hib)) { HrLog("CreateIndexBuffer", hib); return; }
    }
    // 上传顶点/索引（顶点逐个转 D3D8 FVF 布局 + 颜色 R/B 交换）
    D3D8Vtx* vtx_dst = NULL;
    ImDrawIdx* idx_dst = NULL;
    HRESULT hlv, hli;
    if (FAILED(hlv = bd->pVB->Lock(0, (UINT)(draw_data->TotalVtxCount * sizeof(D3D8Vtx)), (BYTE**)&vtx_dst, D3DLOCK_DISCARD))) { HrLog("VB.Lock", hlv); return; }
    if (FAILED(hli = bd->pIB->Lock(0, (UINT)(draw_data->TotalIdxCount * sizeof(ImDrawIdx)), (BYTE**)&idx_dst, D3DLOCK_DISCARD))) { bd->pVB->Unlock(); HrLog("IB.Lock", hli); return; }
    for (int n = 0; n < draw_data->CmdListsCount; ++n) {
        const ImDrawList* cl = draw_data->CmdLists[n];
        const ImDrawVert* src = cl->VtxBuffer.Data;
        for (int i = 0; i < cl->VtxBuffer.Size; ++i) {
            vtx_dst[i].x = src[i].pos.x;
            vtx_dst[i].y = src[i].pos.y;
            vtx_dst[i].z = 0.0f;
            vtx_dst[i].rhw = 1.0f;
            vtx_dst[i].col = IMGUI_COL_TO_D3D8_ARGB(src[i].col);
            vtx_dst[i].u = src[i].uv.x;
            vtx_dst[i].v = src[i].uv.y;
        }
        memcpy(idx_dst, cl->IdxBuffer.Data, (size_t)cl->IdxBuffer.Size * sizeof(ImDrawIdx));
        vtx_dst += cl->VtxBuffer.Size;
        idx_dst += cl->IdxBuffer.Size;
    }
    bd->pVB->Unlock();
    bd->pIB->Unlock();

    // 渲染状态（XYZRHW 已变换顶点：变换管线被跳过，无需 SetTransform）
    device->SetVertexShader(D3DFVF_XYZRHW | D3DFVF_DIFFUSE | D3DFVF_TEX1);
    device->SetPixelShader(0);
    device->SetRenderState(D3DRS_ALPHABLENDENABLE, TRUE);
    device->SetRenderState(D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
    device->SetRenderState(D3DRS_DESTBLEND, D3DBLEND_INVSRCALPHA);
    device->SetRenderState(D3DRS_ZENABLE, FALSE);
    device->SetRenderState(D3DRS_LIGHTING, FALSE);
    device->SetRenderState(D3DRS_CULLMODE, D3DCULL_NONE);
    device->SetRenderState(D3DRS_ALPHATESTENABLE, FALSE);
    device->SetRenderState(D3DRS_FOGENABLE, FALSE);
    device->SetTextureStageState(0, D3DTSS_COLOROP, D3DTOP_MODULATE);
    device->SetTextureStageState(0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    device->SetTextureStageState(0, D3DTSS_COLORARG2, D3DTA_DIFFUSE);
    device->SetTextureStageState(0, D3DTSS_ALPHAOP, D3DTOP_MODULATE);
    device->SetTextureStageState(0, D3DTSS_ALPHAARG1, D3DTA_TEXTURE);
    device->SetTextureStageState(0, D3DTSS_ALPHAARG2, D3DTA_DIFFUSE);
    device->SetTextureStageState(1, D3DTSS_COLOROP, D3DTOP_DISABLE);
    device->SetTextureStageState(1, D3DTSS_ALPHAOP, D3DTOP_DISABLE);
    device->SetStreamSource(0, bd->pVB, sizeof(D3D8Vtx)); // D3D8：stride 随流绑定（dx9 在 declaration 时代无需）

    // 场景包裹：D3D8 严格要求绘制在 BeginScene/EndScene 之间——场景外绘制运行时"成功"但被忽略
    //（实测：全部 HRESULT OK 却无输出）。与 D3D9 的场景外包绕反而 ~130s AV 的怪癖相反，勿混用结论。
    HRESULT hbs = device->BeginScene();
    if (FAILED(hbs)) { HrLog("BeginScene", hbs); return; }

    // 命令绘制（SetIndices 第二参 = 基址顶点偏移，D3D8 特有）
    int global_vtx = 0, global_idx = 0;
    for (int n = 0; n < draw_data->CmdListsCount; ++n) {
        const ImDrawList* cl = draw_data->CmdLists[n];
        for (int i = 0; i < cl->CmdBuffer.Size; ++i) {
            const ImDrawCmd* cmd = &cl->CmdBuffer[i];
            if (cmd->UserCallback) { cmd->UserCallback(cl, cmd); continue; }
            device->SetTexture(0, (IDirect3DTexture8*)(intptr_t)cmd->GetTexID());
            HRESULT hsi = device->SetIndices(bd->pIB, (UINT)(global_vtx));
            if (FAILED(hsi)) HrLog("SetIndices", hsi);
            HRESULT hdp = device->DrawIndexedPrimitive(D3DPT_TRIANGLELIST,
                (UINT)cmd->VtxOffset,                                  // MinIndex（相对基址）
                (UINT)(cl->VtxBuffer.Size - cmd->VtxOffset),           // NumVertices
                (UINT)(cmd->IdxOffset + global_idx),                   // StartIndex
                (UINT)cmd->ElemCount / 3);
            if (FAILED(hdp)) HrLog("DrawIndexedPrimitive", hdp);
        }
        global_vtx += cl->VtxBuffer.Size;
        global_idx += cl->IdxBuffer.Size;
    }
    device->SetTexture(0, NULL);
    device->SetIndices(NULL, 0);
    device->EndScene(); // 与 BeginScene 配对（场景内绘制，见上）
    // 状态还原（stateblock token 制；创建失败时手动还原混合/深度关键项）
    if (bd->dwStateBlock) device->ApplyStateBlock(bd->dwStateBlock);
    else {
        device->SetRenderState(D3DRS_ALPHABLENDENABLE, FALSE);
        device->SetRenderState(D3DRS_ZENABLE, TRUE);
        device->SetTextureStageState(0, D3DTSS_COLOROP, D3DTOP_MODULATE);
        device->SetTextureStageState(0, D3DTSS_ALPHAOP, D3DTOP_MODULATE);
        device->SetTextureStageState(1, D3DTSS_COLOROP, D3DTOP_DISABLE);
        device->SetTextureStageState(1, D3DTSS_ALPHAOP, D3DTOP_DISABLE);
    }
}

// ---- M4 探针：自建一次性虚拟设备 → 读 IDirect3DDevice8 静态虚表 → 挂 Reset/Present 钩 ----
// 背景：平台补丁（w3plus 等）会在游戏 create8 调用前抢占 IDirect3D8 vt[15]，游戏启动期的
// CreateDevice 调用全部走平台链，本 DLL 永远捕获不到设备。标准解法：自己调 Direct3DCreate8
// 建一个一次性探针设备，读其 vtable（d3d8.dll 内静态表——游戏的设备同用此表）并挂钩，
// 与"游戏何时创建设备"完全解耦；探针设备用后即释（虚表槽为静态内存，钩持续有效）。
static LRESULT CALLBACK ProbeWndProc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcW(h, m, w, l); }

bool ImGui_ImplD3D8_ProbeHookDeviceVtable(void* d3dIn, void* resetHook, void* presentHook, void*** vtDevOut) {
    if (vtDevOut) *vtDevOut = NULL;
    IDirect3D8* d3d = (IDirect3D8*)d3dIn; // 调用方创建、调用方释放（探针内部不接管所有权）
    bool ownD3d = false;
    if (!d3d) {
        typedef IDirect3D8* (WINAPI* PFN_D3DC8)(UINT);
        HMODULE dll = GetModuleHandleW(L"d3d8.dll");
        if (!dll) return false;
        PFN_D3DC8 create8 = (PFN_D3DC8)GetProcAddress(dll, "Direct3DCreate8");
        if (!create8) return false;
        d3d = create8(220 /* D3D_SDK_VERSION */);
        if (!d3d) return false;
        ownD3d = true;
    }
    // 1x1 隐藏探针窗口（D3D8 windowed 设备需要真 HWND）
    wchar_t cls[40];
    wsprintfW(cls, L"ImOvProbe%u", GetCurrentProcessId());
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc = ProbeWndProc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.lpszClassName = cls;
    if (!GetClassInfoExW(wc.hInstance, cls, (LPWNDCLASSEXW)0) && !RegisterClassExW(&wc)) { if (ownD3d) d3d->Release(); return false; }
    HWND wnd = CreateWindowExW(0, cls, L"", WS_OVERLAPPED, 0, 0, 1, 1, NULL, NULL, wc.hInstance, NULL);
    if (!wnd) { if (ownD3d) d3d->Release(); return false; }
    D3DPRESENT_PARAMETERS pp = {};
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.hDeviceWindow = wnd;
    pp.BackBufferWidth = 1;
    pp.BackBufferHeight = 1;
    // D3D8 windowed 必须显式桌面格式（UNKNOWN 会 D3DERR_NOTAVAILABLE，实测踩坑）
    D3DDISPLAYMODE dm = {};
    if (FAILED(d3d->GetAdapterDisplayMode(D3DADAPTER_DEFAULT, &dm))) {
        DestroyWindow(wnd);
        if (ownD3d) d3d->Release();
        return false;
    }
    pp.BackBufferFormat = dm.Format;
    IDirect3DDevice8* dev = NULL;
    // SW 顶点处理：兼容性最高（探针设备只用于读虚表，不渲染）
    HRESULT hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd,
        D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev);
    if (FAILED(hr)) {
        HrLog("probe CreateDevice(HAL,SW)", hr); // War3 启动极早期显卡未就绪会拒——调用方需重试
        DestroyWindow(wnd);
        if (ownD3d) d3d->Release();
        return false;
    }
    // 读静态虚表并挂钩（vt[14]=Reset vt[15]=Present；探针设备与游戏设备共享同一 vtable）
    void** vt = *(void***)dev;
    DWORD old = 0;
    bool ok = false;
    if (VirtualProtect(&vt[14], sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) {
        vt[14] = resetHook;
        vt[15] = presentHook;
        VirtualProtect(&vt[14], sizeof(void*) * 2, old, &old);
        if (vtDevOut) *vtDevOut = &vt[14];
        ok = true;
    }
    dev->Release();
    // 关键（M4 真机 War3 实测）：d3d8 按顶点处理模式返回不同实现类（各自独立 vtable）——
    // 仅钩 SW 表则 HW/MIXED 表（游戏实际所用）不受影响。三种 VP 全部探一遍，每张表都挂。
    const DWORD vpModes[3] = { D3DCREATE_HARDWARE_VERTEXPROCESSING, D3DCREATE_MIXED_VERTEXPROCESSING, D3DCREATE_SOFTWARE_VERTEXPROCESSING };
    for (int m = 0; m < 3; ++m) {
        IDirect3DDevice8* dev2 = NULL;
        if (SUCCEEDED(d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd, vpModes[m], &pp, &dev2))) {
            void** vt2 = *(void***)dev2;
            if (VirtualProtect(&vt2[14], sizeof(void*) * 2, PAGE_EXECUTE_READWRITE, &old)) {
                vt2[14] = resetHook;
                vt2[15] = presentHook;
                VirtualProtect(&vt2[14], sizeof(void*) * 2, old, &old);
            }
            dev2->Release();
        }
    }
    return ok;
}
