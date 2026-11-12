// =====================================================================
//  ui_panels.h — ImGUI 面板绘制模块（复用注入版 overlay_hook.cpp 代码）
//  SDK 内部使用，不对外暴露。
// =====================================================================
#ifndef IMOVERLAY_UI_PANELS_H
#define IMOVERLAY_UI_PANELS_H

namespace imoverlay {
namespace ui {

/// 每帧调用：绘制好友 / 房间 / 设置 Tab，以及聊天 toast 通知
void DrawOverlayPanels();

/// 在 DrawOverlayPanels() 前调用一次：设置主题色
void ApplyTheme(int r, int g, int b);

} // namespace ui
} // namespace imoverlay

#endif // IMOVERLAY_UI_PANELS_H
