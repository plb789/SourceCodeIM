// =====================================================================
//  ImOverlayRenderHook.h — UE 5 帧内渲染钩子
//  挂在 GameViewportClient::OnEndFrame / RHIEndFrame 上，
//  自动在引擎 Present 前调 IMOVERLAY_RenderPresent。
//  商户零配置自动帧内渲染。
// =====================================================================

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

class FViewport;

class FImOverlayRenderHook : public IModuleInterface
{
public:
    // Module 接口（用这个类做 hook 的唯一作用：构造时注册，析构时反注册）
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    // —— UE 渲染回调注册 ——
    void RegisterRenderCallbacks();
    void UnregisterRenderCallbacks();

    // —— 回调（RenderThread 上执行）——
    static void OnEndFrame_RenderThread(void* userData);

private:
    // 注册状态
    bool bRegistered = false;
};
