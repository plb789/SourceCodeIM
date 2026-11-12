// =====================================================================
//  ImOverlayBPLibrary.cpp — Blueprint Function Library 实现
// =====================================================================

#include "ImOverlayBPLibrary.h"

UImOverlaySubsystem* UImOverlayBPLibrary::GetSubsystem(UObject* WorldContextObject)
{
    if (!WorldContextObject) return nullptr;
    if (auto* GI = WorldContextObject->GetWorld()) {
        if (auto* S = GI->GetSubsystem<UImOverlaySubsystem>()) return S;
    }
    return nullptr;
}

int32 UImOverlayBPLibrary::SendChat(UObject* W, const FString& To, const FString& Text)
{ auto* S = GetSubsystem(W); return S ? S->SendChat(To, Text) : -1; }

int32 UImOverlayBPLibrary::SendRoomReady(UObject* W, int32 RoomId)
{ auto* S = GetSubsystem(W); return S ? S->SendRoomReady(RoomId) : -1; }

int32 UImOverlayBPLibrary::SendRoomLeave(UObject* W, int32 RoomId)
{ auto* S = GetSubsystem(W); return S ? S->SendRoomLeave(RoomId) : -1; }

int32 UImOverlayBPLibrary::SendRoomChat(UObject* W, int32 RoomId, const FString& Text)
{ auto* S = GetSubsystem(W); return S ? S->SendRoomChat(RoomId, Text) : -1; }

int32 UImOverlayBPLibrary::SetOverlayOpen(UObject* W, bool bOpen)
{ auto* S = GetSubsystem(W); return S ? S->SetOverlayOpen(bOpen) : -1; }

int32 UImOverlayBPLibrary::ShowPanel(UObject* W)
{ auto* S = GetSubsystem(W); return S ? S->ShowPanel() : -1; }

int32 UImOverlayBPLibrary::SetOverlayRect(UObject* W, int32 X, int32 Y, int32 W2, int32 H2)
{ auto* S = GetSubsystem(W); return S ? S->SetOverlayRect(X, Y, W2, H2) : -1; }

bool UImOverlayBPLibrary::IsOverlayRunning(UObject* W)
{ auto* S = GetSubsystem(W); return S ? S->IsRunning() : false; }

FString UImOverlayBPLibrary::GetOverlayVersion(UObject* W)
{ auto* S = GetSubsystem(W); return S ? S->GetVersion() : FString(); }
