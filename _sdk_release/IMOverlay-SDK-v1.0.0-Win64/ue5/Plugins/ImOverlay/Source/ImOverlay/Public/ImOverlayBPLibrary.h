// =====================================================================
//  ImOverlayBPLibrary.h — Blueprint Function Library
//  让蓝图能直接调 IM Overlay 功能，不需要写 C++。
//  节点分类：IM Overlay >
// =====================================================================

#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "ImOverlaySubsystem.h"
#include "ImOverlayBPLibrary.generated.h"

UCLASS()
class IMOVERLAY_API UImOverlayBPLibrary : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()

    // —— 上行帧 ——

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Send", meta = (WorldContext = "WorldContextObject"))
    static int32 SendChat(UObject* WorldContextObject, const FString& To, const FString& Text);

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Send", meta = (WorldContext = "WorldContextObject"))
    static int32 SendRoomReady(UObject* WorldContextObject, int32 RoomId);

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Send", meta = (WorldContext = "WorldContextObject"))
    static int32 SendRoomLeave(UObject* WorldContextObject, int32 RoomId);

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Send", meta = (WorldContext = "WorldContextObject"))
    static int32 SendRoomChat(UObject* WorldContextObject, int32 RoomId, const FString& Text);

    // —— 悬浮窗控制 ——

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Overlay", meta = (WorldContext = "WorldContextObject"))
    static int32 SetOverlayOpen(UObject* WorldContextObject, bool bOpen);

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Overlay", meta = (WorldContext = "WorldContextObject"))
    static int32 ShowPanel(UObject* WorldContextObject);

    UFUNCTION(BlueprintCallable, Category = "IM Overlay|Overlay", meta = (WorldContext = "WorldContextObject"))
    static int32 SetOverlayRect(UObject* WorldContextObject, int32 X, int32 Y, int32 W, int32 H);

    // —— 查询 ——

    UFUNCTION(BlueprintPure, Category = "IM Overlay|Query", meta = (WorldContext = "WorldContextObject"))
    static bool IsOverlayRunning(UObject* WorldContextObject);

    UFUNCTION(BlueprintPure, Category = "IM Overlay|Query", meta = (WorldContext = "WorldContextObject"))
    static FString GetOverlayVersion(UObject* WorldContextObject);

private:
    static UImOverlaySubsystem* GetSubsystem(UObject* WorldContextObject);
};
