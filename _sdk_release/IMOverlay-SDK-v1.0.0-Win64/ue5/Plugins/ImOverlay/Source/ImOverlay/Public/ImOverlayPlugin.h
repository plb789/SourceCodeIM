// =====================================================================
//  ImOverlayPlugin.h — UE 插件模块入口
//  IModuleInterface，加载时调用 IMOverlay.dll 的 Init。
// =====================================================================

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

class FImOverlayPluginModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    // DLL 句柄（模块加载期间保活）
    void* DllHandle = nullptr;
};
