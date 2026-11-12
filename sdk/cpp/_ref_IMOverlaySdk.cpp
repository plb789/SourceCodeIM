// =====================================================================
//  IM Overlay SDK — 商户游戏集成版（实现）
//  依赖：Windows SDK（CreateFile / ReadFile / WriteFile / CloseHandle）
//  零外部依赖，C++11 标准库足够。
// =====================================================================

#include "im-overlay-sdk.h"
#include <string.h>
#include <sstream>

namespace im {

// =====================================================================
//  极简 NDJSON 解析器（协议里实际用到的子集）
//  不支持：浮点数（协议没有）、Unicode 转义（UTF-8 原生即可）、科学计数法
//  支持：string / int / bool / null / array / object（任意嵌套）
// =====================================================================

namespace {

struct JVal {
    enum Type { Null, String, Int, Bool, Array, Object };
    Type type = Null;
    std::string s;
    int i = 0;
    bool b = false;
    std::vector<JVal> arr;
    // object: vector<pair<string, JVal>> 保留 key 顺序（协议字段固定顺序时方便调试）
    std::vector<std::pair<std::string, JVal>> obj;

    // 查找 object 里的 key，找不到返回 Null 引用（内部静态空对象，不要改）
    const JVal* find(const std::string& key) const {
        for (auto& kv : obj) if (kv.first == key) return &kv.second;
        static JVal empty;
        return &empty;
    }
};

class JsonParser {
public:
    JsonParser(const std::string& src) : src_(src), pos_(0) {}

    JVal parse() {
        skipWs();
        JVal v = parseValue();
        return v;
    }

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
        JVal v; v.type = JVal::Null; return v; // 容错：解析失败返回 Null
    }

    JVal parseString() {
        JVal v; v.type = JVal::String;
        next(); // consume opening "
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
            } else {
                out += c;
            }
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

// 简单的 JSON 序列化（我们只写上行帧，字段都是 string/int/bool，不需要嵌套）
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

} // anonymous namespace

// =====================================================================
//  IMFrame 构造：从 JSON 对象映射到 IMFrame 结构体
// =====================================================================

IMFrame IMOverlay::parseFrame(const std::string& line) {
    IMFrame f;
    JsonParser parser(line);
    JVal root = parser.parse();
    if (root.type != JVal::Object) return f;

    const JVal* t = root.find("t");
    if (t && t->type == JVal::String) f.type = t->s;
    else return f; // 没有 t 字段，跳过

    // —— 通用字段（各种帧用到）——
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
    sStr("text", f.text); sStr("action", f.action); sStr("sdk", f.sdk);
    sStr("version", f.version); sStr("b64", f.b64); sStr("mode", f.mode);
    sInt("pid", f.pid); sInt("room_id", f.room_id);
    sInt("vk", f.vk); sInt("ctrl", f.ctrl); sInt("shift", f.shift); sInt("alt", f.alt);
    sInt("w", f.w); sInt("h", f.h); sInt("max", f.max);
    sBool("open", f.open);

    // friends.list[] — array of {u, n, on}
    if (f.type == "friends") {
        const JVal* list = root.find("list");
        if (list && list->type == JVal::Array) {
            for (auto& item : list->arr) {
                if (item.type != JVal::Object) continue;
                std::string u, n; bool on = false;
                const JVal* j_u = item.find("u");
                const JVal* j_n = item.find("n");
                const JVal* j_on = item.find("on");
                if (j_u && j_u->type == JVal::String) u = j_u->s;
                if (j_n && j_n->type == JVal::String) n = j_n->s;
                if (j_on && j_on->type == JVal::Bool) on = j_on->b;
                f.friends.push_back({ u, n });
                f.online = on; // 注意：这里把最后一个的 on 填到 f.online（协议不需要，留空也行）
                (void)on;
            }
        }
    }

    // room.players[] — array of {u, n}
    if (f.type == "room") {
        const JVal* room = root.find("room");
        if (room && room->type == JVal::Object) {
            f.has_room = true;
            const JVal* players = room->find("players");
            if (players && players->type == JVal::Array) {
                for (auto& item : players->arr) {
                    if (item.type != JVal::Object) continue;
                    std::string u, n;
                    const JVal* j_u = item.find("u");
                    const JVal* j_n = item.find("n");
                    if (j_u && j_u->type == JVal::String) u = j_u->s;
                    if (j_n && j_n->type == JVal::String) n = j_n->s;
                    f.players.push_back({ u, n });
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

// =====================================================================
//  IMOverlay 实现
// =====================================================================

std::unique_ptr<IMOverlay> IMOverlay::connect(OnFrameCallback cb) {
    return std::unique_ptr<IMOverlay>(new IMOverlay(std::move(cb)));
}

IMOverlay::IMOverlay(OnFrameCallback cb)
    : on_frame_(std::move(cb))
{
}

IMOverlay::~IMOverlay() {
    stop();
}

void IMOverlay::start() {
    if (running_.exchange(true)) return; // already running
    should_stop_ = false;
    worker_ = std::thread(&IMOverlay::runLoop, this);
}

void IMOverlay::stop() {
    should_stop_ = true;
    running_ = false;
    disconnectPipe();
    if (worker_.joinable()) {
        worker_.join();
    }
}

// —— 上行帧发送 ——

void IMOverlay::sendChat(const std::string& to, const std::string& text) {
    std::string line = "{\"t\":\"chat-send\",";
    line += "\"to\":" + jStr(to) + ",";
    line += "\"text\":" + jStr(text);
    line += "}\n";
    writeLine(line);
}

void IMOverlay::sendRoomReady(int roomId) {
    std::string line = "{\"t\":\"room-act\",";
    line += "\"action\":\"ready\",";
    line += "\"room_id\":" + jInt(roomId);
    line += "}\n";
    writeLine(line);
}

void IMOverlay::sendRoomLeave(int roomId) {
    std::string line = "{\"t\":\"room-act\",";
    line += "\"action\":\"leave\",";
    line += "\"room_id\":" + jInt(roomId);
    line += "}\n";
    writeLine(line);
}

void IMOverlay::sendRoomChat(int roomId, const std::string& text) {
    std::string line = "{\"t\":\"room-act\",";
    line += "\"action\":\"chat\",";
    line += "\"room_id\":" + jInt(roomId) + ",";
    line += "\"text\":" + jStr(text);
    line += "}\n";
    writeLine(line);
}

void IMOverlay::sendPanelOpen(bool open) {
    std::string line = "{\"t\":\"panel\",";
    line += "\"open\":" + jBool(open);
    line += "}\n";
    writeLine(line);
}

// —— 后台线程主循环 ——

void IMOverlay::runLoop() {
    // 先尝试连一次（主进程的 pipe 可能已经 ready，也可能还没 spawn 完游戏——等 CreateFile 超时）
    if (!connectPipe()) {
        // 重连循环：每秒一次，直到 should_stop_ 或连上
        while (!should_stop_) {
            Sleep(1000);
            if (should_stop_) return;
            if (connectPipe()) break;
        }
        if (should_stop_) return;
    }

    // 连上后立即发 hello
    {
        std::string pid_str = std::to_string(GetCurrentProcessId());
        std::string hello = "{\"t\":\"hello\",\"pid\":" + pid_str +
                            ",\"sdk\":\"cpp\",\"version\":\"1.0.0\"}\n";
        writeLine(hello);
    }

    // 主收帧循环（按 \n 切分 NDJSON）
    std::string buffer;
    char readBuf[4096];
    while (!should_stop_) {
        DWORD bytesRead = 0;
        BOOL ok = ReadFile(pipe_, readBuf, sizeof(readBuf), &bytesRead, NULL);
        if (!ok || bytesRead == 0) {
            // pipe 断开（游戏关闭 / im-client 关闭 / 网络错误）
            disconnectPipe();
            // 自动重连循环
            while (!should_stop_) {
                Sleep(1000);
                if (should_stop_) return;
                if (connectPipe()) {
                    // 重连成功，重新发 hello
                    std::string pid_str = std::to_string(GetCurrentProcessId());
                    std::string hello = "{\"t\":\"hello\",\"pid\":" + pid_str +
                                        ",\"sdk\":\"cpp\",\"version\":\"1.0.0\"}\n";
                    writeLine(hello);
                    break;
                }
            }
            continue;
        }

        // 追加到 buffer，按 \n 切帧
        buffer.append(readBuf, bytesRead);
        size_t start = 0;
        size_t pos;
        while ((pos = buffer.find('\n', start)) != std::string::npos) {
            std::string line = buffer.substr(start, pos - start);
            start = pos + 1;
            if (!line.empty()) {
                IMFrame f = parseFrame(line);
                if (on_frame_ && !f.type.empty()) {
                    try { on_frame_(f); } catch (...) { /* 用户代码异常不影响收帧循环 */ }
                }
            }
        }
        // 未完整帧的剩余部分留在 buffer 开头
        if (start > 0) buffer.erase(0, start);
        // 防异常膨胀：buffer 超过 1MB 就清空重等（协议单行最大 262KB）
        if (buffer.size() > 1024 * 1024) buffer.clear();
    }
}

// —— Pipe 管理 ——

bool IMOverlay::connectPipe() {
    if (pipe_ != INVALID_HANDLE_VALUE) return true;
    DWORD pid = GetCurrentProcessId();
    char path[64];
    _snprintf_s(path, sizeof(path), "\\\\.\\pipe\\im-overlay-%lu", pid);

    // CreateFile 默认同步打开（无 FILE_FLAG_OVERLAPPED），pipe 不存在时返回 INVALID_HANDLE_VALUE
    HANDLE h = CreateFileA(
        path,
        GENERIC_READ | GENERIC_WRITE,
        0,         // 不共享（pipe 不是文件，不用 FILE_SHARE_*）
        NULL,
        OPEN_EXISTING,
        0,
        NULL
    );
    if (h == INVALID_HANDLE_VALUE) return false;

    // 设置读超时 5s（主进程暂时无帧时 ReadFile 自动返回，不阻塞）
    DWORD mode = PIPE_READMODE_BYTE | PIPE_WAIT;
    // NOTE: 这里不调 SetNamedPipeHandleState 设置超时——保持默认无限阻塞，
    // 因为后台线程有 should_stop_ 检查；真正断开靠 ReadFile 返回 0 或 error 发现
    (void)mode;

    pipe_ = h;
    return true;
}

void IMOverlay::disconnectPipe() {
    if (pipe_ != INVALID_HANDLE_VALUE) {
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
}

bool IMOverlay::writeLine(const std::string& line) {
    if (pipe_ == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    BOOL ok = WriteFile(pipe_, line.data(), (DWORD)line.size(), &written, NULL);
    if (!ok || written != line.size()) {
        // 写失败 → pipe 断开，等重连
        disconnectPipe();
        return false;
    }
    return true;
}

} // namespace im
