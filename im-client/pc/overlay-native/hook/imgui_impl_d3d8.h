// imgui_impl_d3d8.h - ImGui 的 D3D8 后端接口（M3 自写精简版；官方无 d3d8 backend）
// 与 dx9 后端同形：Init/Shutdown/NewFrame/RenderDrawData/InvalidateDeviceObjects/CreateDeviceObjects
// M4 增：ProbeHookDeviceVtable——自建一次性虚拟设备读出 IDirect3DDevice8 静态虚表并挂钩
//（绕开"游戏 create8 调用被平台钩抢占导致设备捕获不到"的时序问题，与调用时机无关）
#pragma once

struct IDirect3DDevice8;
struct IDirect3D8;

bool ImGui_ImplD3D8_Init(IDirect3DDevice8* device);
void ImGui_ImplD3D8_Shutdown();
void ImGui_ImplD3D8_NewFrame();
void ImGui_ImplD3D8_RenderDrawData(ImDrawData* draw_data);
bool ImGui_ImplD3D8_CreateDeviceObjects();
void ImGui_ImplD3D8_InvalidateDeviceObjects();

// 自建探针设备 → 读 IDirect3DDevice8 虚表（静态表，游戏的设备同样生效）→ 挂 resetHook/presentHook。
// d3d：调用方调 Direct3DCreate8 原函数取得的 IDirect3D8（void* 透传，d3d8.h 仅本 TU 可见）；
// 由调用方创建时所有权归调用方（探针内部不释放）；vtDevOut 返回 vt[14] 槽地址。
bool ImGui_ImplD3D8_ProbeHookDeviceVtable(void* d3d, void* resetHook, void* presentHook, void*** vtDevOut);
