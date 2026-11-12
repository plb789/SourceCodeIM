// =====================================================================
//  render_engine.h — 多后端渲染引擎（帧内 + 悬浮窗）
//  SDK 内部使用，不对外暴露。
// =====================================================================
#ifndef IMOVERLAY_RENDER_ENGINE_H
#define IMOVERLAY_RENDER_ENGINE_H

#include <windows.h>
#include <cstdint>

namespace imoverlay {

enum class RenderMode {
    None,           // 未初始化
    InlineD3D11,    // 帧内 D3D11（RenderPresent 首次调用自动切换）
    InlineD3D12,    // 帧内 D3D12
    InlineVulkan,   // 帧内 Vulkan
    InlineGL3,      // 帧内 OpenGL 3+
    Floating,       // 悬浮窗（Start() 5 秒兜底 / 设备丢失回退）
};

enum class RenderBackend {
    None,
    DX9,
    DX11,
    DX12,
    Vulkan,
    OpenGL3,
};

class RenderEngine {
public:
    RenderEngine();
    ~RenderEngine();

    // Start() 后立即调，启动 5 秒计时器 + 后台线程（悬浮窗用）
    void Start();
    void Stop();

    // —— 帧内渲染 API ——

    int RenderPresentD3D(void* dev, void* ctx, void* backbuffer);
    int RenderPresentVulkan(uint64_t device, uint64_t queue,
                            uint64_t cmdBuffer, uint64_t renderPass,
                            uint64_t framebuffer, int width, int height);
    int RenderPresentGL();

    // —— 悬浮窗控制 ——

    int SetOverlayOpen(int open);
    int ShowPanel();
    int SetOverlayRect(int x, int y, int w, int h);

    // —— 样式 ——

    int SetThemeColor(int r, int g, int b);
    int SetFont(const char* font_data, int data_len, float size);

    // —— 状态查询 ——

    RenderMode GetMode() const { return mode_; }
    bool IsRunning() const { return running_; }

    // —— 通知 pipe 有新好友/房间快照（UI 面板需要最新数据）——
    void SnapshotUpdated();

private:
    // 帧内模式初始化（由首次 RenderPresent* 触发）
    bool InitInlineD3D(void* dev);
    bool InitInlineVulkan(uint64_t device, uint64_t queue);
    bool InitInlineGL();
    void ShutdownInline();

    // 悬浮窗模式（Start 5 秒后自动兜底 / ShutdownInline 回退）
    void StartFloatingWindow();
    void StopFloatingWindow();
    static DWORD WINAPI FloatingThreadProc(LPVOID param);
    void FloatingRenderLoop();

    // 通用 ImGUI 初始化/关闭
    bool InitImGuiWin32Backend(HWND hwnd);
    void ShutdownImGui();

    // 渲染一帧（所有后端通用）
    void BeginFrame();
    void DrawAllPanels();
    void EndFrame();

    // —— 状态 ——
    RenderMode mode_ = RenderMode::None;
    RenderBackend backend_ = RenderBackend::None;
    bool running_ = false;
    bool inline_started_ = false;
    bool floating_active_ = false;

    // 帧内设备指针缓存
    void* d3d_device_ = nullptr;
    void* d3d_context_ = nullptr;
    void* d3d_backbuffer_ = nullptr;
    uint64_t vk_device_ = 0;
    uint64_t vk_queue_ = 0;
    uint64_t vk_cmdbuf_ = 0;
    uint64_t vk_renderpass_ = 0;
    uint64_t vk_framebuffer_ = 0;
    int vk_width_ = 0;
    int vk_height_ = 0;

    // 悬浮窗
    HWND floating_hwnd_ = nullptr;
    HANDLE floating_thread_ = nullptr;
    HANDLE floating_event_ = nullptr;   // 信号：退出循环
    int rect_x_ = -1, rect_y_ = -1, rect_w_ = 520, rect_h_ = 360;

    // 主题色（ImGui 面板主色调）
    int theme_r_ = 74, theme_g_ = 158, theme_b_ = 242;  // #4A9EF2

    // 字体缓存
    unsigned char* font_data_ = nullptr;
    int font_data_len_ = 0;
    float font_size_ = 18.0f;
};

} // namespace imoverlay

#endif // IMOVERLAY_RENDER_ENGINE_H
