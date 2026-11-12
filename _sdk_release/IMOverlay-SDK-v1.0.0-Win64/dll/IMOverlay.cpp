// =====================================================================
//  IMOverlay.dll — 核心实现
//  内部用 C++（std::string / std::thread / std::atomic 等），
//  对外导出纯 C 接口 + POD 结构体（零 STL 暴露）。
//  依赖：Windows SDK + C++11 标准库（/MT 静态链接，商户零 VC 运行时）。
// =====================================================================

#include "IMOverlay.h"

#include <windows.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <memory>
#include <cstring>
#include <cstdlib>

// —— 渲染引擎 + UI 面板 ——
#include "renderer/render_engine.h"
#include "ui/ui_panels.h"

// =====================================================================
//  内部工具函数（匿名 namespace 隔离，不对外暴露）
// =====================================================================

namespace {

// —— NDJSON 解析器 ——
// 极简版，只支持协议用到的子集。容错优先（解析失败返回 Null，不抛异常）。

struct JVal {
    enum Type { Null, String, Int, Bool, Array, Object };
    Type type = Null;
    std::string s;
    int i = 0;
    bool b = false;
    std::vector<JVal> arr;
    std::vector<std::pair<std::string, JVal>> obj;

    const JVal* find(const std::string& key) const {
        for (auto& kv : obj) if (kv.first == key) return &kv.second;
        static JVal empty;
        return &empty;
    }
};

class JsonParser {
public:
    explicit JsonParser(const std::string& src) : src_(src), pos_(0) {}
    JVal parse() { skipWs(); return parseValue(); }

private:
    const std::string& src_;
    size_t pos_;

    char peek() { return pos_ < src_.size() ? src_[pos_] : '\0'; }
    char next() { return pos_ < src_.size() ? src_[pos_++] : '\0'; }

    void skipWs() {
        while (pos_ < src_.size()) {
            char c = src_[pos_];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') pos_++;
            else break;
        }
    }

    JVal parseValue() {
        skipWs();
        char c = peek();
        if (c == '"') return parseString();
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '-' || (c >= '0' && c <= '9')) return parseInt();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        JVal v; v.type = JVal::Null; return v;
    }

    JVal parseString() {
        JVal v; v.type = JVal::String;
        next(); // consume "
        std::string out;
        while (pos_ < src_.size()) {
            char c = next();
            if (c == '"') break;
            if (c == '\\') {
                char esc = next();
                switch (esc) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;
                    case '\\': out += '\\'; break;
                    case '"': out += '"'; break;
                    case '/': out += '/'; break;
                    default: out += esc; break;
                }
            } else out += c;
        }
        v.s = std::move(out);
        return v;
    }

    JVal parseInt() {
        JVal v; v.type = JVal::Int;
        int sign = 1;
        if (peek() == '-') { sign = -1; next(); }
        int num = 0;
        while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') {
            num = num * 10 + (src_[pos_] - '0');
            pos_++;
        }
        v.i = sign * num;
        return v;
    }

    JVal parseBool() {
        JVal v; v.type = JVal::Bool;
        if (src_.compare(pos_, 4, "true") == 0) { v.b = true; pos_ += 4; }
        else if (src_.compare(pos_, 5, "false") == 0) { v.b = false; pos_ += 5; }
        return v;
    }

    JVal parseNull() {
        JVal v; v.type = JVal::Null;
        if (src_.compare(pos_, 4, "null") == 0) pos_ += 4;
        return v;
    }

    JVal parseArray() {
        JVal v; v.type = JVal::Array;
        next(); // consume [
        skipWs();
        if (peek() == ']') { next(); return v; }
        while (pos_ < src_.size()) {
            v.arr.push_back(parseValue());
            skipWs();
            if (peek() == ',') { next(); skipWs(); continue; }
            if (peek() == ']') { next(); break; }
            break;
        }
        return v;
    }

    JVal parseObject() {
        JVal v; v.type = JVal::Object;
        next(); // consume {
        skipWs();
        if (peek() == '}') { next(); return v; }
        while (pos_ < src_.size()) {
            skipWs();
            if (peek() != '"') break;
            JVal key = parseString();
            skipWs();
            if (peek() == ':') next();
            JVal val = parseValue();
            v.obj.push_back({ key.s, val });
            skipWs();
            if (peek() == ',') { next(); continue; }
            if (peek() == '}') { next(); break; }
            break;
        }
        return v;
    }
};

// —— NDJSON 序列化 ——

std::string escapeJson(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

std::string jStr(const std::string& s) { return "\"" + escapeJson(s) + "\""; }
std::string jInt(int i) { return std::to_string(i); }
std::string jBool(bool b) { return b ? "true" : "false"; }

// —— 内部帧结构 ——

struct InternalFrame {
    std::string type;
    std::string u, from, name, to, text, action, mode;
    int room_id = 0, pid = 0, vk = 0, ctrl = 0, shift = 0, alt = 0;
    int w = 0, h = 0;
    std::vector<std::pair<std::string, std::string>> friends;
    std::vector<std::pair<std::string, std::string>> players;
    bool has_room = false, follow_all = false;
    std::vector<std::string> follow_list;
};

// 把 JSON 对象解析成 InternalFrame
InternalFrame parseInternalFrame(const std::string& line) {
    InternalFrame f;
    JsonParser parser(line);
    JVal root = parser.parse();
    if (root.type != JVal::Object) return f;

    const JVal* t = root.find("t");
    if (t && t->type == JVal::String) f.type = t->s;
    else return f; // 没有 t 字段，跳过

    auto sStr = [&](const char* key, std::string& out) {
        const JVal* v = root.find(key);
        if (v && v->type == JVal::String) out = v->s;
    };
    auto sInt = [&](const char* key, int& out) {
        const JVal* v = root.find(key);
        if (v && v->type == JVal::Int) out = v->i;
    };
    auto sBool = [&](const char* key, bool& out) {
        const JVal* v = root.find(key);
        if (v && v->type == JVal::Bool) out = v->b;
    };

    sStr("u", f.u); sStr("from", f.from); sStr("name", f.name); sStr("to", f.to);
    sStr("text", f.text); sStr("action", f.action); sStr("sdk", f.mode);
    sStr("b64", f.text); // 复用 text 字段存 avatar base64
    sStr("mode", f.mode);
    sInt("pid", f.pid); sInt("room_id", f.room_id);
    sInt("vk", f.vk); sInt("ctrl", f.ctrl); sInt("shift", f.shift); sInt("alt", f.alt);
    sInt("w", f.w); sInt("h", f.h);

    // friends.list[]
    if (f.type == "friends") {
        const JVal* list = root.find("list");
        if (list && list->type == JVal::Array) {
            for (auto& item : list->arr) {
                if (item.type != JVal::Object) continue;
                const JVal* j_u = item.find("u");
                const JVal* j_n = item.find("n");
                if (j_u && j_u->type == JVal::String) {
                    std::string u = j_u->s, n;
                    if (j_n && j_n->type == JVal::String) n = j_n->s;
                    f.friends.push_back({ std::move(u), std::move(n) });
                }
            }
        }
    }

    // room.players[]
    if (f.type == "room") {
        const JVal* room = root.find("room");
        if (room && room->type == JVal::Object) {
            f.has_room = true;
            const JVal* players = room->find("players");
            if (players && players->type == JVal::Array) {
                for (auto& item : players->arr) {
                    if (item.type != JVal::Object) continue;
                    const JVal* j_u = item.find("u");
                    const JVal* j_n = item.find("n");
                    if (j_u && j_u->type == JVal::String) {
                        std::string u = j_u->s, n;
                        if (j_n && j_n->type == JVal::String) n = j_n->s;
                        f.players.push_back({ std::move(u), std::move(n) });
                    }
                }
            }
        } else {
            f.has_room = false; // room == null
        }
    }

    // follow.list[] + follow.mode
    if (f.type == "follow") {
        f.follow_all = (f.mode == "all");
        const JVal* list = root.find("list");
        if (list && list->type == JVal::Array) {
            for (auto& item : list->arr) {
                if (item.type == JVal::String) f.follow_list.push_back(item.s);
            }
        }
    }

    return f;
}

// 帧字符串 → 枚举
IMOVERLAY_FrameType strToFrameType(const std::string& t) {
    static const char* names[] = {
        "hello-ack", "me", "friends", "msg", "room", "roomchat", "avatar", "hotkey", "follow"
    };
    static const IMOVERLAY_FrameType vals[] = {
        IMOVERLAY_FT_HELLO_ACK, IMOVERLAY_FT_ME, IMOVERLAY_FT_FRIENDS, IMOVERLAY_FT_MSG,
        IMOVERLAY_FT_ROOM, IMOVERLAY_FT_ROOMCHAT, IMOVERLAY_FT_AVATAR, IMOVERLAY_FT_HOTKEY, IMOVERLAY_FT_FOLLOW
    };
    for (int i = 0; i < 9; i++) if (t == names[i]) return vals[i];
    return IMOVERLAY_FT_UNKNOWN;
}

} // anonymous namespace

// =====================================================================
//  全局状态（模块级，仅内部使用）
// =====================================================================

namespace {

IMOVERLAY_FrameCallback g_cb = nullptr;
void* g_user_data = nullptr;
std::atomic<bool> g_initialized{false};
std::atomic<bool> g_running{false};
std::atomic<bool> g_should_stop{false};
std::thread g_worker;
HANDLE g_pipe = INVALID_HANDLE_VALUE;
CRITICAL_SECTION g_pipeLock;   // 写 pipe 时串行化（Send* 可能和回调并行）

const char* g_version = "1.0.0";

// —— 渲染引擎 + UI 面板（帧内/悬浮窗双模式）——
imoverlay::RenderEngine g_renderEngine;

// 把 InternalFrame 转成对外 POD（分配线程局部 buffer，回调后立即释放）
// 用 std::vector<char> 存储所有字符串，按 const char* 顺序拼进去
void dispatchFrame(InternalFrame& iframe) {
    if (!g_cb) return;

    // 1. 组装 POD（所有 const char* 指向 storage buffer 里的位置）
    // 全在 storage 内部，无外部分配（回调返回后 storage 析构，所有指针立即失效）
    std::vector<char> storage;
    storage.reserve(4096 + iframe.friends.size() * 64 + iframe.players.size() * 64);

    auto copyStr2 = [&](const std::string& s) -> const char* {
        size_t offset = storage.size();
        storage.insert(storage.end(), s.begin(), s.end());
        storage.push_back('\0');
        return storage.data() + offset;
    };

    IMOVERLAY_Frame pod2 = {};
    pod2.type = strToFrameType(iframe.type);
    pod2.u = iframe.u.empty() ? nullptr : copyStr2(iframe.u);
    pod2.from = iframe.from.empty() ? nullptr : copyStr2(iframe.from);
    pod2.name = iframe.name.empty() ? nullptr : copyStr2(iframe.name);
    pod2.to = iframe.to.empty() ? nullptr : copyStr2(iframe.to);
    pod2.text = iframe.text.empty() ? nullptr : copyStr2(iframe.text);
    pod2.action = iframe.action.empty() ? nullptr : copyStr2(iframe.action);
    pod2.mode = iframe.mode.empty() ? nullptr : copyStr2(iframe.mode);

    pod2.room_id = iframe.room_id;
    pod2.vk = iframe.vk; pod2.ctrl = iframe.ctrl; pod2.shift = iframe.shift; pod2.alt = iframe.alt;
    pod2.w = iframe.w; pod2.h = iframe.h;

    // friends: 连续内存块（username, nickname 都在 storage 里）
    if (!iframe.friends.empty()) {
        // storage 里存 N 个 IMOVERLAY_Friend 结构体
        size_t friendsOffset = storage.size();
        storage.resize(storage.size() + sizeof(IMOVERLAY_Friend) * iframe.friends.size());
        IMOVERLAY_Friend* friendsArr = reinterpret_cast<IMOVERLAY_Friend*>(storage.data() + friendsOffset);
        for (size_t i = 0; i < iframe.friends.size(); i++) {
            friendsArr[i].username = copyStr2(iframe.friends[i].first);
            friendsArr[i].nickname = copyStr2(iframe.friends[i].second);
            friendsArr[i].online = 0;
        }
        pod2.friends = friendsArr;
        pod2.friends_count = (int)iframe.friends.size();
    }

    // players: 同理
    if (!iframe.players.empty()) {
        size_t playersOffset = storage.size();
        storage.resize(storage.size() + sizeof(IMOVERLAY_Player) * iframe.players.size());
        IMOVERLAY_Player* playersArr = reinterpret_cast<IMOVERLAY_Player*>(storage.data() + playersOffset);
        for (size_t i = 0; i < iframe.players.size(); i++) {
            playersArr[i].username = copyStr2(iframe.players[i].first);
            playersArr[i].nickname = copyStr2(iframe.players[i].second);
        }
        pod2.has_room = 1;
        pod2.room_players = playersArr;
        pod2.room_players_count = (int)iframe.players.size();
    } else if (!iframe.has_room) {
        pod2.has_room = 0;
    }

    // follow_list: const char** 数组 + 每个字符串
    if (!iframe.follow_list.empty()) {
        size_t listArrOffset = storage.size();
        storage.resize(storage.size() + sizeof(const char*) * iframe.follow_list.size());
        const char** listArr = reinterpret_cast<const char**>(storage.data() + listArrOffset);
        for (size_t i = 0; i < iframe.follow_list.size(); i++) {
            listArr[i] = copyStr2(iframe.follow_list[i]);
        }
        pod2.follow_all = iframe.follow_all ? 1 : 0;
        pod2.follow_list = listArr;
        pod2.follow_list_count = (int)iframe.follow_list.size();
    }

    // 2. 回调（storage 在回调返回后析构 → 所有 const char* 立即悬空）
    try { g_cb(&pod2, g_user_data); } catch (...) { /* 用户代码异常静默吞掉 */ }
}

// Pipe 管理
bool connectPipe() {
    if (g_pipe != INVALID_HANDLE_VALUE) return true;
    DWORD pid = GetCurrentProcessId();
    char path[64];
    _snprintf_s(path, sizeof(path), "\\\\.\\pipe\\im-overlay-%lu", pid);

    // 最多尝试 3 次（主进程 spawn 后 pipe server 可能还没建好）
    for (int attempt = 0; attempt < 3; attempt++) {
        HANDLE h = CreateFileA(
            path,
            GENERIC_READ | GENERIC_WRITE,
            0, NULL, OPEN_EXISTING, 0, NULL
        );
        if (h != INVALID_HANDLE_VALUE) {
            g_pipe = h;
            return true;
        }
        // 失败等 200ms 再试
        Sleep(200);
    }
    return false;
}

void disconnectPipe() {
    if (g_pipe != INVALID_HANDLE_VALUE) {
        EnterCriticalSection(&g_pipeLock);
        CloseHandle(g_pipe);
        g_pipe = INVALID_HANDLE_VALUE;
        LeaveCriticalSection(&g_pipeLock);
    }
}

bool writePipe(const std::string& line) {
    if (g_pipe == INVALID_HANDLE_VALUE) return false;
    EnterCriticalSection(&g_pipeLock);
    bool ok = false;
    if (g_pipe != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        ok = (WriteFile(g_pipe, line.data(), (DWORD)line.size(), &written, NULL) != FALSE)
             && (written == line.size());
        if (!ok) {
            CloseHandle(g_pipe);
            g_pipe = INVALID_HANDLE_VALUE;
        }
    }
    LeaveCriticalSection(&g_pipeLock);
    return ok;
}

void sendHello() {
    std::string pid_str = std::to_string(GetCurrentProcessId());
    std::string line = "{\"t\":\"hello\",\"pid\":" + pid_str +
                       ",\"sdk\":\"cpp\",\"version\":\"1.0.0\"}\n";
    writePipe(line);
}

// 后台线程主循环
void workerLoop() {
    if (!connectPipe()) {
        // 重连循环：每秒一次，直到 g_should_stop
        while (!g_should_stop) {
            Sleep(1000);
            if (g_should_stop) return;
            if (connectPipe()) break;
        }
        if (g_should_stop) return;
    }

    sendHello();

    // 主收帧循环
    std::string buffer;
    char readBuf[4096];
    while (!g_should_stop) {
        DWORD bytesRead = 0;
        BOOL ok = ReadFile(g_pipe, readBuf, sizeof(readBuf), &bytesRead, NULL);
        if (!ok || bytesRead == 0) {
            // pipe 断开，重连循环
            disconnectPipe();
            while (!g_should_stop) {
                Sleep(1000);
                if (g_should_stop) return;
                if (connectPipe()) {
                    sendHello();
                    break;
                }
            }
            if (g_should_stop) return;
            continue;
        }

        // NDJSON 按 \n 切帧
        buffer.append(readBuf, bytesRead);
        size_t start = 0, pos;
        while ((pos = buffer.find('\n', start)) != std::string::npos) {
            std::string line = buffer.substr(start, pos - start);
            start = pos + 1;
            if (!line.empty()) {
                InternalFrame iframe = parseInternalFrame(line);
                if (!iframe.type.empty()) {
                    try { dispatchFrame(iframe); } catch (...) { }
                }
            }
        }
        if (start > 0) buffer.erase(0, start);
        if (buffer.size() > 1024 * 1024) buffer.clear(); // 防异常膨胀
    }
}

// 静态初始化：CRITICAL_SECTION（DLL 全局生命周期）
struct CriticalSectionInit {
    CriticalSectionInit() { InitializeCriticalSection(&g_pipeLock); }
    ~CriticalSectionInit() { DeleteCriticalSection(&g_pipeLock); }
};
static CriticalSectionInit g_csInit;

} // anonymous namespace

// =====================================================================
//  extern "C" 导出函数（商户直接调用）
// =====================================================================

// imgui_impl_dx11.cpp 里引用了这个日志函数（注入版 overlay_hook.cpp 提供），
// DLL 版本不需要日志，空实现即可。
extern "C" void __stdcall OverlayLogLine(const char* msg) { (void)msg; }

extern "C" {

IMOVERLAY_API int IMOVERLAY_Init(IMOVERLAY_FrameCallback cb, void* user_data) {
    if (!cb) return -4;
    if (g_initialized.exchange(true)) return 0; // 已初始化
    g_cb = cb;
    g_user_data = user_data;
    return 0;
}

IMOVERLAY_API int IMOVERLAY_Start(void) {
    if (!g_initialized) return -1;
    if (g_running.exchange(true)) return 0; // 已在运行
    g_should_stop = false;
    try {
        g_worker = std::thread(&workerLoop);
    } catch (...) {
        g_running = false;
        return -3;
    }
    // 启动渲染引擎（默认帧内模式 → 等商户调 RenderPresent*；5 秒未调自动悬浮窗兜底）
    g_renderEngine.Start();
    return 0;
}

IMOVERLAY_API void IMOVERLAY_Stop(void) {
    if (!g_running.exchange(false)) return; // 已经停了
    g_should_stop = true;
    disconnectPipe(); // 打断 ReadFile
    if (g_worker.joinable()) {
        g_worker.join();
    }
    g_renderEngine.Stop();
}

IMOVERLAY_API int IMOVERLAY_IsRunning(void) {
    return g_running.load() ? 1 : 0;
}

// —— 上行帧 ——

IMOVERLAY_API int IMOVERLAY_SendChat(const char* to, const char* text) {
    if (!g_running) return -1;
    if (!to || !*to || !text) return -4;
    // 截断保护（主进程也会校验，但上游先做）
    std::string toStr(to);
    std::string textStr(text);
    if (toStr.size() > 64) toStr.resize(64);
    if (textStr.size() > 2000) textStr.resize(2000);
    std::string line = "{\"t\":\"chat-send\",\"to\":" + jStr(toStr) +
                       ",\"text\":" + jStr(textStr) + "}\n";
    writePipe(line);
    return 0;
}

IMOVERLAY_API int IMOVERLAY_SendRoomReady(int room_id) {
    if (!g_running) return -1;
    if (!room_id) return -4;
    std::string line = "{\"t\":\"room-act\",\"action\":\"ready\",\"room_id\":" + jInt(room_id) + "}\n";
    writePipe(line);
    return 0;
}

IMOVERLAY_API int IMOVERLAY_SendRoomLeave(int room_id) {
    if (!g_running) return -1;
    if (!room_id) return -4;
    std::string line = "{\"t\":\"room-act\",\"action\":\"leave\",\"room_id\":" + jInt(room_id) + "}\n";
    writePipe(line);
    return 0;
}

IMOVERLAY_API int IMOVERLAY_SendRoomChat(int room_id, const char* text) {
    if (!g_running) return -1;
    if (!room_id || !text || !*text) return -4;
    std::string textStr(text);
    if (textStr.size() > 500) textStr.resize(500);
    std::string line = "{\"t\":\"room-act\",\"action\":\"chat\",\"room_id\":" + jInt(room_id) +
                       ",\"text\":" + jStr(textStr) + "}\n";
    writePipe(line);
    return 0;
}

IMOVERLAY_API int IMOVERLAY_SendPanelOpen(int open) {
    if (!g_running) return -1;
    std::string line = "{\"t\":\"panel\",\"open\":" + jBool(open != 0) + "}\n";
    writePipe(line);
    return 0;
}

IMOVERLAY_API const char* IMOVERLAY_GetVersion(void) {
    return g_version;
}

// —— 帧内渲染 ——

IMOVERLAY_API int IMOVERLAY_RenderPresent(void* dev, void* ctx, void* backbuffer) {
    if (!g_running) return -1;
    return g_renderEngine.RenderPresentD3D(dev, ctx, backbuffer);
}

IMOVERLAY_API int IMOVERLAY_RenderPresentVulkan(
    uint64_t device, uint64_t queue,
    uint64_t cmdBuffer, uint64_t renderPass,
    uint64_t framebuffer, int width, int height)
{
    if (!g_running) return -1;
    return g_renderEngine.RenderPresentVulkan(device, queue, cmdBuffer, renderPass, framebuffer, width, height);
}

IMOVERLAY_API int IMOVERLAY_RenderPresentGL(void) {
    if (!g_running) return -1;
    return g_renderEngine.RenderPresentGL();
}

// —— 悬浮窗控制 ——

IMOVERLAY_API int IMOVERLAY_SetOverlayOpen(int open) {
    return g_renderEngine.SetOverlayOpen(open);
}

IMOVERLAY_API int IMOVERLAY_ShowPanel(void) {
    return g_renderEngine.ShowPanel();
}

IMOVERLAY_API int IMOVERLAY_SetOverlayRect(int x, int y, int w, int h) {
    return g_renderEngine.SetOverlayRect(x, y, w, h);
}

// —— 样式定制 ——

IMOVERLAY_API int IMOVERLAY_SetThemeColor(int r, int g, int b) {
    return g_renderEngine.SetThemeColor(r, g, b);
}

IMOVERLAY_API int IMOVERLAY_SetFont(const char* font_data, int data_len, float size) {
    return g_renderEngine.SetFont(font_data, data_len, size);
}

// —— UI 帧缓存同步：workerLoop 里收到 pipe 帧后调这些 ——
// （声明在 ui_panels.h 作为 extern）
// 为避免多重定义，这里只做内部转发

} // extern "C"
