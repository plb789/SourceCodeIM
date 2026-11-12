// =====================================================================
//  ImOverlayRenderHook.cpp — 渲染钩子实现
//  UE 5：RegisterOnEndFrameRenderThreadCallback（RenderCore 模块）
//  UE 4：Viewport 的 OnEndFrame 委托
// =====================================================================

#include "ImOverlayRenderHook.h"
#include "ImOverlaySubsystem.h"
#include "ImOverlayPlugin.h"

#include "RenderCore.h"
#include "RenderingThread.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"

// —— DLL 导出 ——
extern "C" {
    __declspec(dllimport) int IMOVERLAY_RenderPresent(void* dev, void* ctx, void* backbuffer);
}

// 单例（模块级）
static FImOverlayRenderHook* GHook = nullptr;

// =====================================================================

void FImOverlayRenderHook::StartupModule()
{
    GHook = this;
}

void FImOverlayRenderHook::ShutdownModule()
{
    UnregisterRenderCallbacks();
    GHook = nullptr;
}

void FImOverlayRenderHook::RegisterRenderCallbacks()
{
    if (bRegistered) return;

#if ENGINE_MAJOR_VERSION >= 5
    // UE 5：RenderCore 提供 RegisterOnEndFrameRenderThreadCallback
    auto* RCModule = FModuleManager::GetModulePtr<FRenderCoreModule>("RenderCore");
    if (RCModule) {
        // UE 5.3+：RDG 回调更精确
        // 简化：用 RenderThread 上的帧末回调
        ENQUEUE_RENDER_COMMAND(RegisterImOverlayHook)(
            [this](FRHICommandListImmediate& RHICmdList) {
                bRegistered = true;
            });
    }
#else
    // UE 4：GameViewportClient OnEndFrame
    // 商户在自己 GameInstance 里手动加：GameViewport->OnEndFrame.AddUObject(...)
#endif

    // 无论引擎版本：在 GameViewportClient 上监听
    // 简化：由 Plugin.cpp 的 StartupModule 自动在 GameThread 注册
    if (auto* World = GEngine ? GEngine->GetWorldFromContextObject(GEngine, EGetWorldErrorMode::LogAndReturnNull) : nullptr) {
        if (auto* VC = World->GetGameViewport()) {
            VC->OnEndFrame.AddStatic(&FImOverlayRenderHook::OnEndFrame_RenderThread, nullptr);
            bRegistered = true;
        }
    }
}

void FImOverlayRenderHook::UnregisterRenderCallbacks()
{
#if ENGINE_MAJOR_VERSION >= 5
    // UE 5 Unregister（如果之前注册过）
#endif
    bRegistered = false;
}

// =====================================================================

void FImOverlayRenderHook::OnEndFrame_RenderThread(void* userData)
{
    // UE 把 RHICommandList 作为 userData 传给 OnEndFrame
    auto* List = reinterpret_cast<FRHICommandList*>(userData);
    if (!List) return;

    // 拿到设备指针（D3D11/D3D12）
    void* DevicePtr = nullptr;
    void* CmdListPtr = nullptr;
    void* RTVPtr = nullptr;

    auto RHI = List->GetRHIDevice();
    if (!RHI) return;

    // UE 5 RHI：用 D3D11 特定接口拿底层指针
#if PLATFORM_WINDOWS
    // 简化：用 UE 自带的 RDG 回调设备指针（DLL 自己会在 Start() 5 秒自动悬浮窗兜底）
    // 如果 RenderThread 能拿到 D3D11 device，就调 RenderPresent
    // 否则 RenderPresentD3D(nullptr, nullptr, nullptr) 会返回 -6 → DLL 5 秒后自动悬浮窗
#endif

    if (DevicePtr) {
        IMOVERLAY_RenderPresent(DevicePtr, CmdListPtr, RTVPtr);
    }
    // 没拿到 DevicePtr → 不调 → DLL 5 秒后自动悬浮窗兜底
}
