// =====================================================================
//  ImOverlaySubsystem.cpp — Subsystem 实现
// =====================================================================

#include "ImOverlaySubsystem.h"
#include "ImOverlayPlugin.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Misc/App.h"
#include "RenderingThread.h"
#include "RenderResource.h"
#include "RHI.h"

// —— 直接 include（Build.cs 已配好 Plugins/ImOverlay/Include/ 路径）——
#include "IMOverlay.h"

// —— Subsystem 实例指针（OnDllFrame 回调时取）——
static UImOverlaySubsystem* GSubsystemPtr = nullptr;

UImOverlaySubsystem* GetImOverlaySubsystem()
{
    return GSubsystemPtr;
}

// =====================================================================
//  初始化 / 销毁
// =====================================================================

void UImOverlaySubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    GSubsystemPtr = this;

    // 注册 Tick（GameInstanceSubsystem 没有自动 Tick，手动注册）
    if (auto* World = GetWorld()) {
        World->GetTimerManager().SetTimerForNextTick(this, &UImOverlaySubsystem::OnTick);
    }
}

void UImOverlaySubsystem::Deinitialize()
{
    GSubsystemPtr = nullptr;
    Super::Deinitialize();
}

// =====================================================================
//  DLL 回调 → 队列 → OnTick 分发
// =====================================================================

void UImOverlaySubsystem::EnqueueFrame(const IMOVERLAY_Frame& raw)
{
    FImOverlayFrame f;
    f.Type = (EImOverlayFrameType)raw.type;

    auto ToFStr = [](const char* s) -> FString {
        return s ? FString(ANSI_TO_TCHAR(s)) : FString();
    };

    f.U    = ToFStr(raw.u);
    f.From = ToFStr(raw.from);
    f.Name = ToFStr(raw.name);
    f.To   = ToFStr(raw.to);
    f.Text = ToFStr(raw.text);
    f.Action = ToFStr(raw.action);
    f.Mode = ToFStr(raw.mode);

    f.RoomId = raw.room_id;
    f.Vk = raw.vk; f.Ctrl = raw.ctrl; f.Shift = raw.shift; f.Alt = raw.alt;
    f.W = raw.w; f.H = raw.h;

    // friends — 直接用 IMOverlay.h 的结构体（内存布局已保证一致）
    if (raw.friends && raw.friends_count > 0) {
        auto* arr = reinterpret_cast<const IMOVERLAY_Friend*>(raw.friends);
        for (int i = 0; i < raw.friends_count; i++) {
            f.Friends.Add({ ToFStr(arr[i].username), ToFStr(arr[i].nickname), arr[i].online != 0 });
        }
    }

    // room players — 同理
    f.HasRoom = raw.has_room != 0;
    if (f.HasRoom && raw.room_players && raw.room_players_count > 0) {
        auto* arr = reinterpret_cast<const IMOVERLAY_Player*>(raw.room_players);
        for (int i = 0; i < raw.room_players_count; i++) {
            f.RoomPlayers.Add({ ToFStr(arr[i].username), ToFStr(arr[i].nickname) });
        }
    }

    // follow list
    f.FollowAll = raw.follow_all != 0;
    if (raw.follow_list && raw.follow_list_count > 0) {
        for (int i = 0; i < raw.follow_list_count; i++) {
            f.FollowList.Add(ToFStr(raw.follow_list[i]));
        }
    }

    // 线程安全入队
    {
        FScopeLock Lock(&FrameQueueCS);
        FrameQueue.Add(MoveTemp(f));
        if (FrameQueue.Num() > 256) {
            // 防堆积：丢最旧的
            FrameQueue.RemoveAt(0, FrameQueue.Num() - 256);
        }
    }
}

void UImOverlaySubsystem::OnTick(float DeltaTime)
{
    UNUSED(DeltaTime);

    // Pump frames → 触发委托（GameThread 安全）
    TArray<FImOverlayFrame> LocalQueue;
    {
        FScopeLock Lock(&FrameQueueCS);
        LocalQueue = MoveTemp(FrameQueue);
        FrameQueue.Empty();
    }

    for (auto& f : LocalQueue) {
        OnFrame.Broadcast(f);
    }

    // 下一次 Tick 继续
    if (auto* World = GetWorld()) {
        World->GetTimerManager().SetTimerForNextTick(this, &UImOverlaySubsystem::OnTick);
    }
}

// =====================================================================
//  帧内渲染（从 GameViewportClient 回调触发）
// =====================================================================

void UImOverlaySubsystem::OnEndFrameRenderThread(void* dev, void* ctx, void* rtv)
{
    // 这是 RenderThread 上的回调，直接调 DLL 的 RenderPresent（线程安全）
    if (!IMOVERLAY_IsRunning()) return;
    IMOVERLAY_RenderPresent(dev, ctx, rtv);
}

// =====================================================================
//  上行帧 / 悬浮窗控制
// =====================================================================

int32 UImOverlaySubsystem::SendChat(const FString& To, const FString& Text)
{
    FUTF8 ToUtf8(To);
    FUTF8 TextUtf8(Text);
    return IMOVERLAY_SendChat(ToUtf8.Get(), TextUtf8.Get());
}

int32 UImOverlaySubsystem::SendRoomReady(int32 RoomId)  { return IMOVERLAY_SendRoomReady(RoomId); }
int32 UImOverlaySubsystem::SendRoomLeave(int32 RoomId)  { return IMOVERLAY_SendRoomLeave(RoomId); }

int32 UImOverlaySubsystem::SendRoomChat(int32 RoomId, const FString& Text)
{
    FUTF8 TextUtf8(Text);
    return IMOVERLAY_SendRoomChat(RoomId, TextUtf8.Get());
}

int32 UImOverlaySubsystem::SetOverlayOpen(bool bOpen)  { return IMOVERLAY_SetOverlayOpen(bOpen ? 1 : 0); }
int32 UImOverlaySubsystem::ShowPanel()                 { return IMOVERLAY_ShowPanel(); }
int32 UImOverlaySubsystem::SetOverlayRect(int32 X, int32 Y, int32 W, int32 H)
{
    return IMOVERLAY_SetOverlayRect(X, Y, W, H);
}

bool UImOverlaySubsystem::IsRunning() const { return IMOVERLAY_IsRunning() == 1; }

FString UImOverlaySubsystem::GetVersion() const
{
    const char* v = IMOVERLAY_GetVersion();
    return v ? FString(ANSI_TO_TCHAR(v)) : FString();
}
