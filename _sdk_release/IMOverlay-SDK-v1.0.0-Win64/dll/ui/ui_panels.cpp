// =====================================================================
//  ui_panels.cpp — ImGUI 面板绘制实现
//  代码来源于注入版 overlay_hook.cpp（DrawFriendsList / DrawRoomTab / DrawToastNotifications），
//  数据驱动改为从 SDK 内部快照缓存读取（pipe 收帧 → 更新缓存 → UI 帧消费）。
// =====================================================================

#include "ui_panels.h"
#include "../renderer/render_engine.h"

#include "imgui.h"
#include <vector>
#include <string>
#include <mutex>
#include <algorithm>

namespace imoverlay {
namespace ui {

// —— 主题色状态（render_engine 每帧调用 ApplyTheme 更新）——
static int g_theme_r = 74, g_theme_g = 158, g_theme_b = 242; // #4A9EF2

void ApplyTheme(int r, int g, int b) {
    g_theme_r = r; g_theme_g = g; g_theme_b = b;
    // 转成 0-1 浮点供 ImGui ColorConvertRGB
}

// —— SDK 内部快照缓存（由 IMOverlay.cpp 收到 pipe 帧后更新）——
// 这里先留接口，后续 IMOverlay.cpp 接进来
// 简化版：直接用全局 atomic flag + 静态变量

struct FriendEntry {
    std::string username;
    std::string nickname;
    bool online;
};
struct RoomSnapshot {
    int room_id = 0;
    bool valid = false;  // false = room==null（未在房）
    std::vector<std::pair<std::string, std::string>> players; // username + nickname
};
struct ChatEntry {
    std::string from;
    std::string name;
    std::string text;
    std::string target;  // 私聊时的对端；房间聊天为 room_id
    bool is_room = false;
};

static std::mutex g_data_mutex;
static std::vector<FriendEntry> g_friends;
static RoomSnapshot g_room;
static std::vector<ChatEntry> g_toasts;
static std::string g_me;

// —— 供 IMOverlay.cpp 调用：收到 pipe 帧后更新缓存 ——
extern void UpdateFriendsSnapshot(const std::vector<FriendEntry>& friends) {
    std::lock_guard<std::mutex> lock(g_data_mutex);
    g_friends = friends;
}
extern void UpdateRoomSnapshot(const RoomSnapshot& room) {
    std::lock_guard<std::mutex> lock(g_data_mutex);
    g_room = room;
}
extern void PushChatToast(const ChatEntry& toast) {
    std::lock_guard<std::mutex> lock(g_data_mutex);
    g_toasts.push_back(toast);
    if (g_toasts.size() > 20) g_toasts.erase(g_toasts.begin()); // 最多 20 条 toast
}
extern void SetMe(const std::string& me) {
    std::lock_guard<std::mutex> lock(g_data_mutex);
    g_me = me;
}

// —— 好友列表绘制 ——

static void DrawFriendsList() {
    ImGui::PushItemWidth(-1);

    std::vector<FriendEntry> snapshot;
    std::lock_guard<std::mutex> lock(g_data_mutex);
    snapshot = g_friends;
    std::string me_copy = g_me;

    // 自己的标题
    ImGui::Text("我的账号: %s", me_copy.empty() ? "(未连接)" : me_copy.c_str());
    ImGui::Separator();

    if (snapshot.empty()) {
        ImGui::TextDisabled("暂无好友");
        ImGui::PopItemWidth();
        return;
    }

    // 按在线优先排序
    std::sort(snapshot.begin(), snapshot.end(), [](const FriendEntry& a, const FriendEntry& b) {
        return a.online > b.online;
    });

    for (auto& f : snapshot) {
        ImGui::PushID(f.username.c_str());

        // 彩色圆点 + 名字（点击展开聊天）
        float dot[4] = { 0.3f, 0.3f, 0.3f, 1.0f };
        if (f.online) dot[0] = g_theme_r / 255.0f, dot[1] = g_theme_g / 255.0f, dot[2] = g_theme_b / 255.0f;
        ImGui::ColorEdit4("##dot", dot, ImGuiColorEditFlags_NoTooltip | ImGuiColorEditFlags_NoPicker);

        ImGui::SameLine();
        std::string display = f.nickname.empty() ? f.username : f.nickname;
        ImGui::Selectable(display.c_str(), false);

        ImGui::PopID();
    }

    ImGui::PopItemWidth();
}

// —— 房间 Tab 绘制 ——

static void DrawRoomTab() {
    std::lock_guard<std::mutex> lock(g_data_mutex);

    if (!g_room.valid) {
        ImGui::TextDisabled("当前未在房间中");
        ImGui::TextDisabled("（进入游戏房间后自动同步）");
        return;
    }

    ImGui::Text("房间 #%d 成员 (%d 人)", g_room.room_id, (int)g_room.players.size());
    ImGui::Separator();

    for (auto& p : g_room.players) {
        ImGui::PushID(p.first.c_str());
        std::string display = p.second.empty() ? p.first : p.second;
        ImGui::Text("• %s", display.c_str());
        ImGui::PopID();
    }

    ImGui::Separator();

    if (ImGui::Button("准备", ImVec2(-1, 0))) {
        // 这里应该调 SDK 内部 wrapper，暂时留空
    }
    ImGui::SameLine();
    if (ImGui::Button("离开", ImVec2(-1, 0))) {
        // 同上
    }
}

// —— 设置 Tab ——

static void DrawSettingsTab() {
    ImGui::Text("SDK 版本: 1.0.0");
    ImGui::Separator();
    ImGui::Text("主题色: RGB(%d, %d, %d)", g_theme_r, g_theme_g, g_theme_b);
    ImGui::Text("热键: Shift+Tab（默认）");
    ImGui::Text("（可由主进程 IM-Client 配置下发）");
}

// —— Toast 通知（右上角气泡）——

static void DrawToastNotifications() {
    std::vector<ChatEntry> toasts;
    {
        std::lock_guard<std::mutex> lock(g_data_mutex);
        toasts = g_toasts;
    }
    if (toasts.empty()) return;

    // 右上角悬浮 toast 容器
    ImGuiWindowFlags flags = ImGuiWindowFlags_AlwaysAutoResize |
                             ImGuiWindowFlags_NoTitleBar |
                             ImGuiWindowFlags_NoMove |
                             ImGuiWindowFlags_NoBackground;

    ImGui::Begin("##toasts", nullptr, flags);
    // 右对齐：先拿主窗口宽度再定位
    ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x - 320, 20), ImGuiCond_Always);

    for (auto& t : toasts) {
        ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.15f, 0.15f, 0.2f, 0.95f));
        ImGui::BeginChild(("##toast_" + t.from + t.text).c_str(), ImVec2(300, 0), true);

        ImGui::TextColored(ImVec4(g_theme_r / 255.0f, g_theme_g / 255.0f, g_theme_b / 255.0f, 1.0f),
                           "%s", t.name.empty() ? t.from.c_str() : t.name.c_str());
        ImGui::SameLine();
        ImGui::TextWrapped("%s", t.text.c_str());

        ImGui::EndChild();
        ImGui::PopStyleColor();
        ImGui::Spacing();
    }
    ImGui::End();
}

// —— 主面板入口 ——

void DrawOverlayPanels() {
    ImGuiIO& io = ImGui::GetIO();

    // 主窗口：左下角固定位置（和 Steam Overlay 类似）
    ImGuiWindowFlags mainFlags =
        ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoResize |
        ImGuiWindowFlags_NoCollapse;

    ImGui::Begin("##imoverlay_main", nullptr, mainFlags);
    ImGui::SetWindowPos(ImVec2(20, io.DisplaySize.y - 400), ImGuiCond_Always);
    ImGui::SetWindowSize(ImVec2(500, 380), ImGuiCond_Always);

    // Tab Bar
    if (ImGui::BeginTabBar("main_tabs", ImGuiTabBarFlags_None)) {
        ImGui::PushStyleColor(ImGuiCol_TabActive, ImVec4(g_theme_r / 255.0f, g_theme_g / 255.0f, g_theme_b / 255.0f, 1.0f));

        if (ImGui::BeginTabItem("好友")) {
            DrawFriendsList();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("房间")) {
            DrawRoomTab();
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("设置")) {
            DrawSettingsTab();
            ImGui::EndTabItem();
        }

        ImGui::PopStyleColor();
        ImGui::EndTabBar();
    }

    ImGui::End();

    // Toast 通知（独立窗口，右上角）
    DrawToastNotifications();
}

} // namespace ui
} // namespace imoverlay
