// =====================================================================
//  ImOverlaySubsystem.h — UE 5 游戏实例级 Subsystem
//  职责：
//    1. 接收 DLL 后台线程回调的帧 → 入队
//    2. OnTick 在 GameThread 上 PumpFrames → 触发 Blueprint C++ 委托
//    3. 渲染路径：OnEndFrame 在 RenderThread 上调 IMOVERLAY_RenderPresent
// =====================================================================

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "ImOverlaySubsystem.generated.h"

// —— IMOverlay SDK 纯 C 头文件（Build.cs 已配好 Include 路径）——
#include "IMOverlay.h"

// 帧类型枚举（和 DLL 端 1:1 对齐）
UENUM(BlueprintType)
enum class EImOverlayFrameType : uint8
{
    Unknown   = 0,
    HelloAck  = 1,
    Me        = 2,
    Friends   = 3,
    Msg       = 4,
    Room      = 5,
    RoomChat  = 6,
    Avatar    = 7,
    Hotkey    = 8,
    Follow    = 9,
};

// 好友条目
USTRUCT(BlueprintType)
struct FImOverlayFriend
{
    GENERATED_BODY()
    UPROPERTY(BlueprintReadOnly) FString Username;
    UPROPERTY(BlueprintReadOnly) FString Nickname;
    UPROPERTY(BlueprintReadOnly) bool Online = false;
};

// 房间成员
USTRUCT(BlueprintType)
struct FImOverlayPlayer
{
    GENERATED_BODY()
    UPROPERTY(BlueprintReadOnly) FString Username;
    UPROPERTY(BlueprintReadOnly) FString Nickname;
};

// 完整帧数据
USTRUCT(BlueprintType)
struct FImOverlayFrame
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly) EImOverlayFrameType Type = EImOverlayFrameType::Unknown;

    UPROPERTY(BlueprintReadOnly) FString U;
    UPROPERTY(BlueprintReadOnly) FString From;
    UPROPERTY(BlueprintReadOnly) FString Name;
    UPROPERTY(BlueprintReadOnly) FString To;
    UPROPERTY(BlueprintReadOnly) FString Text;
    UPROPERTY(BlueprintReadOnly) FString Action;
    UPROPERTY(BlueprintReadOnly) FString Mode;

    UPROPERTY(BlueprintReadOnly) int32 RoomId = 0;
    UPROPERTY(BlueprintReadOnly) int32 Vk = 0, Ctrl = 0, Shift = 0, Alt = 0;
    UPROPERTY(BlueprintReadOnly) int32 W = 0, H = 0;

    UPROPERTY(BlueprintReadOnly) TArray<FImOverlayFriend> Friends;
    UPROPERTY(BlueprintReadOnly) bool HasRoom = false;
    UPROPERTY(BlueprintReadOnly) TArray<FImOverlayPlayer> RoomPlayers;
    UPROPERTY(BlueprintReadOnly) bool FollowAll = false;
    UPROPERTY(BlueprintReadOnly) TArray<FString> FollowList;
};

// 委托（Blueprint 可绑定）
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnImOverlayFrame, const FImOverlayFrame&, Frame);

UCLASS()
class IMOVERLAY_API UImOverlaySubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    // —— IGameInstanceSubsystem 接口 ——
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    // —— Tick 驱动 ——
    virtual bool DoesSupportWorldType(EWorldType::Type WorldType) const override { return WorldType == EWorldType::Game || WorldType == EWorldType::PIE; }
    void OnTick(float DeltaTime);

    // —— Blueprint 可绑定事件 ——
    UPROPERTY(BlueprintAssignable, Category = "IM Overlay|Events")
    FOnImOverlayFrame OnFrame;

    // —— 插件内部接口（OnDllFrame 桥接，直接用 DLL 的 C 结构体）——
    void EnqueueFrame(const IMOVERLAY_Frame& raw);

    // —— 帧内渲染（由引擎渲染回调触发）——
    void OnEndFrameRenderThread(void* dev, void* ctx, void* rtv);

    // —— 上行帧（Blueprint Function Library 内部调）——
    int32 SendChat(const FString& To, const FString& Text);
    int32 SendRoomReady(int32 RoomId);
    int32 SendRoomLeave(int32 RoomId);
    int32 SendRoomChat(int32 RoomId, const FString& Text);

    // —— 悬浮窗控制 ——
    int32 SetOverlayOpen(bool bOpen);
    int32 ShowPanel();
    int32 SetOverlayRect(int32 X, int32 Y, int32 W, int32 H);

    // —— 查询 ——
    bool IsRunning() const;
    FString GetVersion() const;

private:
    // 线程安全队列（dll 回调线程写，OnTick GameThread 读）
    FCriticalSection FrameQueueCS;
    TArray<FImOverlayFrame> FrameQueue;

    // 渲染线程设备缓存
    TWeakObjectPtr<class FViewport> Viewport;
    void* CachedDevice = nullptr;
    void* CachedContext = nullptr;
    void* CachedRTV = nullptr;
};
