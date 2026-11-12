// =====================================================================
//  render_engine.cpp — 渲染引擎实现
//  依赖：ImGUI 1.90+（本地 third_party）、Windows SDK、D3D11/DXGI/Vulkan 头文件
//  注意：本文件是 SDK 内部实现，不对外暴露符号。
// =====================================================================

#include "render_engine.h"
#include "../IMOverlay.h"

// —— ImGUI 头文件（复用项目内 third_party）——
#include "imgui.h"
#include "imgui_impl_win32.h"
#include "imgui_impl_dx11.h"
#include "imgui_impl_dx12.h"
#include "imgui_impl_opengl3.h"
#ifndef IMOVERLAY_NO_VULKAN
#include "imgui_impl_vulkan.h"
#endif

// —— 第三方依赖 ——
#include <d3d11.h>
#include <d3d12.h>
#include <dxgi.h>
#include <d3dcompiler.h>
#ifndef IMOVERLAY_NO_VULKAN
#include <vulkan/vulkan.h>
#endif
#include <gl/gl.h>
// wglext.h 由 imgui_impl_opengl3.h 内部处理，不需要我们显式 include

#include <thread>
#include <chrono>
#include <atomic>
#include <cstring>
#include <vector>
#include <mutex>

// —— UI 面板绘制 ——
#include "../ui/ui_panels.h"

// —— std 头文件 ——
#include <string>

// —— 未使用参数消除警告 ——
#ifndef UNUSED_PARAMETER
#define UNUSED_PARAMETER(x) (void)(x)
#endif

namespace imoverlay {

// =====================================================================
//  Vulkan ImGui 辅助（ImGUI Vulkan backend 初始化时需要的参数结构）
// =====================================================================
// 这些 struct 是 imgui_impl_vulkan.h 定义的，用前确保 Vulkan headers
// 版本足够新（ImGUI 1.90 要求 Vulkan 1.2+）。
// 简化处理：我们用默认 descriptor pool + 内部 pipeline cache。

// =====================================================================
//  构造 / 析构
// =====================================================================

RenderEngine::RenderEngine() = default;
RenderEngine::~RenderEngine() { Stop(); ShutdownImGui(); }

// =====================================================================
//  Start / Stop
// =====================================================================

void RenderEngine::Start() {
    if (running_) return;
    running_ = true;
    mode_ = RenderMode::None;   // 等待商户首次调 RenderPresent*

    // 启动 5 秒定时器：如果商户没调任何 RenderPresent*，自动启动悬浮窗兜底
    std::thread([this]() {
        for (int i = 0; i < 50; i++) {  // 50 × 100ms = 5s
            if (!running_) return;
            if (mode_ != RenderMode::None) return;  // 商户已调 Render*
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        if (running_ && mode_ == RenderMode::None) {
            StartFloatingWindow();
        }
    }).detach();
}

void RenderEngine::Stop() {
    if (!running_) return;
    running_ = false;
    StopFloatingWindow();
    ShutdownInline();
    ShutdownImGui();
    mode_ = RenderMode::None;
}

// =====================================================================
//  帧内渲染：D3D11 / D3D12 自动识别
// =====================================================================

int RenderEngine::RenderPresentD3D(void* dev, void* ctx, void* backbuffer) {
    if (!running_) return -1;

    // 首次调用 → 初始化
    if (mode_ == RenderMode::Floating) {
        StopFloatingWindow();
    }
    if (!inline_started_) {
        if (!InitInlineD3D(dev)) return -6;
        inline_started_ = true;
    }

    // 缓存
    d3d_device_ = dev;
    d3d_context_ = ctx;
    d3d_backbuffer_ = backbuffer;
    mode_ = (backend_ == RenderBackend::DX12) ? RenderMode::InlineD3D12 : RenderMode::InlineD3D11;

    BeginFrame();
    DrawAllPanels();
    EndFrame();
    return 0;
}

int RenderEngine::RenderPresentVulkan(
    uint64_t device, uint64_t queue,
    uint64_t cmdBuffer, uint64_t renderPass,
    uint64_t framebuffer, int width, int height)
{
#ifndef IMOVERLAY_NO_VULKAN
    if (!running_) return -1;

    // 首次调用 → 初始化
    if (mode_ == RenderMode::Floating) { StopFloatingWindow(); }
    if (!inline_started_) {
        if (!InitInlineVulkan(device, queue)) return -6;
        inline_started_ = true;
    }

    // 参数更新
    vk_device_ = device;
    vk_queue_ = queue;
    vk_cmdbuf_ = cmdBuffer;
    vk_renderpass_ = renderPass;
    vk_framebuffer_ = framebuffer;
    vk_width_ = width;
    vk_height_ = height;
    mode_ = RenderMode::InlineVulkan;

    BeginFrame();
    DrawAllPanels();
    EndFrame();
    return 0;
#else
    UNUSED_PARAMETER(device); UNUSED_PARAMETER(queue);
    UNUSED_PARAMETER(cmdBuffer); UNUSED_PARAMETER(renderPass);
    UNUSED_PARAMETER(framebuffer); UNUSED_PARAMETER(width); UNUSED_PARAMETER(height);
    return -8; // Vulkan backend not compiled in
#endif
}

int RenderEngine::RenderPresentGL() {
    if (!running_) return -1;
    if (mode_ == RenderMode::Floating) { StopFloatingWindow(); }
    if (!inline_started_) {
        if (!InitInlineGL()) return -6;
        inline_started_ = true;
    }
    mode_ = RenderMode::InlineGL3;

    BeginFrame();
    DrawAllPanels();
    EndFrame();
    return 0;
}

// =====================================================================
//  初始化各后端
// =====================================================================

bool RenderEngine::InitInlineD3D(void* dev) {
    // 先试 D3D12
    auto* d3d12 = reinterpret_cast<ID3D12Device*>(dev);
    if (d3d12 && SUCCEEDED(d3d12->QueryInterface(IID_PPV_ARGS(&d3d12)))) {
        backend_ = RenderBackend::DX12;
        // ImGUI DX12 backend 需要：device + commandQueue
        // 简化：假设 d3d_context_ 就是 PCommandQueue
        auto queue = reinterpret_cast<ID3D12CommandQueue*>(d3d_context_);
        // ImGui_ImplDX12_Init 正确签名（6 参数）：
        //   device, num_frames_in_flight, rtv_format, cbv_srv_heap,
        //   font_srv_cpu_desc_handle, font_srv_gpu_desc_handle
        // heap 传 nullptr → ImGui 自动创建内部 heap；font handles 传零值 → 自动创建
        D3D12_CPU_DESCRIPTOR_HANDLE null_cpu = {};
        D3D12_GPU_DESCRIPTOR_HANDLE null_gpu = {};
        ImGui_ImplDX12_Init(d3d12, 2, DXGI_FORMAT_R8G8B8A8_UNORM,
                            nullptr, null_cpu, null_gpu);
        ImGui_ImplDX12_CreateDeviceObjects();
        ImGui_ImplWin32_Init(GetActiveWindow());
        return true;
    }
    // D3D11
    auto* d3d11 = reinterpret_cast<ID3D11Device*>(dev);
    if (d3d11 && SUCCEEDED(d3d11->QueryInterface(IID_PPV_ARGS(&d3d11)))) {
        backend_ = RenderBackend::DX11;
        ImGui_ImplDX11_Init(d3d11, reinterpret_cast<ID3D11DeviceContext*>(d3d_context_));
        ImGui_ImplDX11_CreateDeviceObjects();
        ImGui_ImplWin32_Init(GetActiveWindow());
        return true;
    }
    return false;
}

bool RenderEngine::InitInlineVulkan(uint64_t device, uint64_t queue) {
#ifndef IMOVERLAY_NO_VULKAN
    backend_ = RenderBackend::Vulkan;
    // ImGui_ImplVulkan_InitInfo struct 初始化
    ImGui_ImplVulkan_InitInfo vi = {};
    vi.Instance = nullptr;  // 商户设备已隐含 instance
    vi.PhysicalDevice = nullptr;
    vi.Device = reinterpret_cast<VkDevice>(device);
    vi.QueueFamily = 0;
    vi.Queue = reinterpret_cast<VkQueue>(queue);
    vi.Subpass = 0;
    vi.MinImageCount = 2;
    vi.ImageCount = 3;
    vi.MSAASamples = VK_SAMPLE_COUNT_1_BIT;
    vi.PipelineCache = nullptr;
    vi.DescriptorPool = nullptr;  // ImGui 会自动创建

    // 简化：先用 null renderPass，后面由商户传入更新
    ImGui_ImplVulkan_Init(&vi, VK_NULL_HANDLE);
    ImGui_ImplVulkan_CreateFontsTexture(reinterpret_cast<VkCommandBuffer>(0));
    ImGui_ImplWin32_Init(GetActiveWindow());
    return true;
#else
    UNUSED_PARAMETER(device); UNUSED_PARAMETER(queue);
    return false;
#endif
}

bool RenderEngine::InitInlineGL() {
    backend_ = RenderBackend::OpenGL3;
    ImGui_ImplOpenGL3_Init("#version 330 core");
    ImGui_ImplWin32_Init(GetActiveWindow());
    return true;
}

void RenderEngine::ShutdownInline() {
    if (!inline_started_) return;
    try {
        switch (backend_) {
            case RenderBackend::DX11:  ImGui_ImplDX11_Shutdown(); break;
            case RenderBackend::DX12:  ImGui_ImplDX12_Shutdown(); break;
#ifndef IMOVERLAY_NO_VULKAN
            case RenderBackend::Vulkan: ImGui_ImplVulkan_Shutdown(); break;
#endif
            case RenderBackend::OpenGL3: ImGui_ImplOpenGL3_Shutdown(); break;
            default: break;
        }
        ImGui_ImplWin32_Shutdown();
    } catch (...) {}
    inline_started_ = false;
    backend_ = RenderBackend::None;
}

// =====================================================================
//  BeginFrame / EndFrame / DrawAllPanels
// =====================================================================

void RenderEngine::BeginFrame() {
    try {
        switch (backend_) {
            case RenderBackend::DX11:   ImGui_ImplDX11_NewFrame(); break;
            case RenderBackend::DX12:   ImGui_ImplDX12_NewFrame(); break;
#ifndef IMOVERLAY_NO_VULKAN
            case RenderBackend::Vulkan: ImGui_ImplVulkan_NewFrame(); break;
#endif
            case RenderBackend::OpenGL3: ImGui_ImplOpenGL3_NewFrame(); break;
            default: break;
        }
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();
    } catch (...) {}
}

void RenderEngine::DrawAllPanels() {
    // ImGUI 面板主题色设置（每次帧前更新，保证热色变化立即生效）
    ui::ApplyTheme(theme_r_, theme_g_, theme_b_);

    // 复用注入版 UI 面板（已抽成独立 TU）
    ui::DrawOverlayPanels();
}

void RenderEngine::EndFrame() {
    try {
        ImGui::Render();
        switch (backend_) {
            case RenderBackend::DX11:
                ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
                break;
            case RenderBackend::DX12: {
                auto list = reinterpret_cast<ID3D12GraphicsCommandList*>(d3d_context_);
                if (list) ImGui_ImplDX12_RenderDrawData(ImGui::GetDrawData(), list);
                break;
            }
#ifndef IMOVERLAY_NO_VULKAN
            case RenderBackend::Vulkan:
                ImGui_ImplVulkan_RenderDrawData(ImGui::GetDrawData(),
                    reinterpret_cast<VkCommandBuffer>(vk_cmdbuf_), nullptr);
                break;
#endif
            case RenderBackend::OpenGL3:
                ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
                break;
            default: break;
        }
    } catch (...) {}
}

void RenderEngine::ShutdownImGui() {
    try { ImGui::DestroyContext(); } catch (...) {}
}

// =====================================================================
//  悬浮窗模式（兜底）
// =====================================================================

void RenderEngine::StartFloatingWindow() {
    if (floating_active_) return;

    // 注册窗口类
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"IMOverlay_Floating";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    RegisterClassExW(&wc);

    // 创建透明覆盖窗
    floating_hwnd_ = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST,
        wc.lpszClassName, L"IM Overlay",
        WS_POPUP,
        rect_x_ < 0 ? 100 : rect_x_,
        rect_y_ < 0 ? 100 : rect_y_,
        rect_w_, rect_h_,
        nullptr, nullptr, wc.hInstance, nullptr
    );
    if (!floating_hwnd_) return;

    ShowWindow(floating_hwnd_, SW_SHOW);
    floating_active_ = true;
    mode_ = RenderMode::Floating;
    backend_ = RenderBackend::DX11;  // 悬浮窗固定 DX11

    // 启动独立渲染线程
    floating_event_ = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    floating_thread_ = CreateThread(nullptr, 0, FloatingThreadProc, this, 0, nullptr);
}

void RenderEngine::StopFloatingWindow() {
    if (!floating_active_) return;
    if (floating_event_) { SetEvent(floating_event_); }
    if (floating_thread_) { WaitForSingleObject(floating_thread_, 500); CloseHandle(floating_thread_); }
    if (floating_event_) { CloseHandle(floating_event_); floating_event_ = nullptr; }
    if (floating_hwnd_) { DestroyWindow(floating_hwnd_); floating_hwnd_ = nullptr; }
    floating_active_ = false;
}

DWORD WINAPI RenderEngine::FloatingThreadProc(LPVOID param) {
    auto* self = reinterpret_cast<RenderEngine*>(param);
    self->FloatingRenderLoop();
    return 0;
}

void RenderEngine::FloatingRenderLoop() {
    if (!floating_hwnd_) return;

    // 创建独立 D3D11 设备
    IDXGIAdapter* adapter = nullptr;
    IDXGIOutput* output = nullptr;
    ID3D11Device* dev = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    IDXGISwapChain* sc = nullptr;
    ID3D11RenderTargetView* rtv = nullptr;

    HRESULT hr = CreateDXGIFactory(__uuidof(IDXGIFactory), (void**)(&sc ? nullptr : nullptr));
    // 简化：直接用 D3D11CreateDevice + D3D11CreateDeviceAndSwapChain
    DXGI_SWAP_CHAIN_DESC scd = {};
    scd.BufferCount = 1;
    scd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.OutputWindow = floating_hwnd_;
    scd.SampleDesc.Count = 1;
    scd.Windowed = TRUE;
    scd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    D3D_FEATURE_LEVEL fl;
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    if (D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
            nullptr, 0, D3D11_SDK_VERSION, &scd, &sc, &dev, &fl, &ctx) != S_OK) {
        return;
    }

    ID3D11Texture2D* backTex = nullptr;
    sc->GetBuffer(0, IID_PPV_ARGS(&backTex));
    dev->CreateRenderTargetView(backTex, nullptr, &rtv);
    backTex->Release();

    // ImGUI 初始化
    ImGui_ImplDX11_Init(dev, ctx);
    ImGui_ImplDX11_CreateDeviceObjects();
    ImGui_ImplWin32_Init(floating_hwnd_);
    ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_NoMouseCursorChange;

    while (running_ && floating_active_ && WaitForSingleObject(floating_event_, 16) == WAIT_TIMEOUT) {
        ctx->OMSetRenderTargets(1, &rtv, nullptr);
        float clear[4] = { 0, 0, 0, 0 };
        ctx->ClearRenderTargetView(rtv, clear);

        BeginFrame();
        DrawAllPanels();
        ImGui::Render();
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

        sc->Present(1, 0);
    }

    // 清理
    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    if (rtv) rtv->Release();
    if (sc) sc->Release();
    if (ctx) ctx->Release();
    if (dev) dev->Release();
}

// =====================================================================
//  悬浮窗控制 API 实现
// =====================================================================

int RenderEngine::SetOverlayOpen(int open) {
    if (open && mode_ == RenderMode::None) {
        StartFloatingWindow();
    } else if (!open && floating_active_) {
        ShowWindow(floating_hwnd_, SW_HIDE);
    } else if (open && floating_active_) {
        ShowWindow(floating_hwnd_, SW_SHOW);
    }
    return 0;
}

int RenderEngine::ShowPanel() {
    if (mode_ == RenderMode::None) StartFloatingWindow();
    if (floating_active_) ShowWindow(floating_hwnd_, SW_SHOW);
    return 0;
}

int RenderEngine::SetOverlayRect(int x, int y, int w, int h) {
    if (w > 0) rect_w_ = w;
    if (h > 0) rect_h_ = h;
    if (x >= 0) rect_x_ = x;
    if (y >= 0) rect_y_ = y;
    if (floating_hwnd_) {
        SetWindowPos(floating_hwnd_, HWND_TOPMOST, rect_x_, rect_y_, rect_w_, rect_h_, SWP_SHOWWINDOW);
    }
    return 0;
}

// =====================================================================
//  样式定制
// =====================================================================

int RenderEngine::SetThemeColor(int r, int g, int b) {
    theme_r_ = (r < 0 ? 0 : r > 255 ? 255 : r);
    theme_g_ = (g < 0 ? 0 : g > 255 ? 255 : g);
    theme_b_ = (b < 0 ? 0 : b > 255 ? 255 : b);
    return 0;
}

int RenderEngine::SetFont(const char* font_data, int data_len, float size) {
    if (font_data && data_len > 0) {
        // 释放旧字体
        if (font_data_) { delete[] font_data_; font_data_ = nullptr; }
        font_data_ = new unsigned char[data_len];
        memcpy(font_data_, font_data, data_len);
        font_data_len_ = data_len;
        font_size_ = (size > 6.0f && size < 72.0f) ? size : 18.0f;
    }
    return 0;
}

} // namespace imoverlay
