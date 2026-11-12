// =====================================================================
//  ImOverlayPlugin.cpp — UE 插件模块入口实现
//  负责：加载 IMOverlay.dll → 调 Init → Start → 注册热键委托
// =====================================================================

#include "ImOverlayPlugin.h"
#include "ImOverlaySubsystem.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

// —— 直接 include IMOverlay.h（Build.cs 已配好 Include 路径 → Plugins/ImOverlay/Include/）——
#include "IMOverlay.h"

// —— 全局静态（插件模块级）——
static FImOverlayPluginModule* GPluginModule = nullptr;

// —— DLL 回调桥接（必须 __cdecl，和 IMOVERLAY_FrameCallback 类型一致）——
static void __cdecl OnDllFrame(const IMOVERLAY_Frame* frame, void* userData)
{
    // 跨线程安全：把原始结构传给 GameInstanceSubsystem（它自己在 GameThread 上分发）
    // 这里不做任何 UE API 调用
    if (!frame) return;
    // 交给 Subsystem（通过 GPluginModule 拿到）
    if (auto* sub = GPluginModule ? GPluginModule->GetSubsystem() : nullptr) {
        sub->EnqueueFrame(*frame);
    }
}

// =====================================================================
//  模块实现
// =====================================================================

void FImOverlayPluginModule::StartupModule()
{
    GPluginModule = this;

    // Delay-load DLL（Build.cs 里已配置 PublicDelayLoadDLLs）
    DllHandle = GetModuleHandleA("IMOverlay.dll");
    if (!DllHandle) {
        // 尝试显式加载
        FString DllPath = FPaths::ProjectPluginsDir() / TEXT("ImOverlay") / TEXT("Binaries") / TEXT("Win64") / TEXT("IMOverlay.dll");
        if (FPaths::FileExists(DllPath)) {
            DllHandle = LoadLibraryW(*DllPath);
        }
    }

    if (!DllHandle) {
        UE_LOG(LogTemp, Warning, TEXT("[ImOverlay] IMOverlay.dll not found — plugin disabled"));
        return;
    }

    // Init（注册回调）
    int rc = IMOVERLAY_Init(OnDllFrame, nullptr);
    if (rc != 0) {
        UE_LOG(LogTemp, Warning, TEXT("[ImOverlay] IMOVERLAY_Init failed rc=%d"), rc);
    }

    // Start（启动后台收帧线程 + 默认帧内模式等待 RenderPresent）
    rc = IMOVERLAY_Start();
    UE_LOG(LogTemp, Log, TEXT("[ImOverlay] IMOVERLAY_Start rc=%d"), rc);
}

void FImOverlayPluginModule::ShutdownModule()
{
    if (IMOVERLAY_IsRunning()) {
        IMOVERLAY_Stop();
    }
    if (DllHandle) {
        FreeLibrary((HMODULE)DllHandle);
        DllHandle = nullptr;
    }
    GPluginModule = nullptr;
}

// —— 让 Subsystem 能拿到 PluginModule（EnqueueFrame 分发帧）——
class UImOverlaySubsystem* GetImOverlaySubsystem();

UImOverlaySubsystem* FImOverlayPluginModule::GetSubsystem()
{
    return GetImOverlaySubsystem();
}

// =====================================================================
// IMPLEMENT_MODULE — UE 标准模块入口
// =====================================================================

IMPLEMENT_MODULE(FImOverlayPluginModule, ImOverlay)
