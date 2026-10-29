// dlbt-host —— DLBT BT 下载引擎 x86 宿主进程（方案 A 一期：sidecar + P2SP 混合下载）
//
// 背景：DLBT.dll 为 x86 商业 BT/P2SP 引擎，Electron x64 主进程无法直接加载（位宽必须一致），
//       故由本进程（固定 x86 编译）承载引擎，经 stdio JSON 行协议与主进程通讯。
// 协议（stdin 命令 / stdout 事件，均 UTF-8，一行一个 JSON，'\n' 结尾；日志走 stderr 不污染协议）：
//   命令：{"cmd":"start","id":"g1-1700","torrent":"C:\\a\\x.torrent","out":"C:\\install","status":"C:\\Status","http":["url1","url2"]}
//         {"cmd":"pause","id":"..."}  {"cmd":"resume","id":"..."}  {"cmd":"cancel","id":"...","del":true}
//         {"cmd":"quit"}
//   事件：{"evt":"ready","port":29123}  {"evt":"progress","id":...,"state":"downloading","progress":0.42,
//         "received":...,"total":...,"down":B/s,"up":B/s,"error":""}
//         {"evt":"done","id":...}（FINISHED/SEEDING 首次转达）  {"evt":"error","id":...,"error":"..."}
//         {"evt":"closed","id":...}（cancel 移除后回执，页面清 UI）
// 断点续传：status 目录按任务 id 落 DLBT 状态文件（跨宿主重启续传由引擎 status 文件保证）；
// 任务表不持久化：宿主退出后主进程按库状态可重新 start（status 文件仍在，引擎续传）。
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <string>
#include <map>
#include <mutex>
#include <thread>
#include <atomic>
#include <vector>
#include "../dll/DLBT.h"

// 商业授权入口（用户已有授权，见参考工程 DLBTWrapper.cpp；头文件未声明，手动 extern）
extern "C" {
DLBT_API void WINAPI DLBT_AddAppSettings(
    ULONGLONG cert1, LPCSTR cert2, ULONGLONG cert3, LPCSTR cert4, ULONGLONG cert5);
}

// —— UTF-8 ↔ UTF-16 转换（协议侧 UTF-8，DLBT 侧宽字符）——
static std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), NULL, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
static std::string wideToUtf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), NULL, 0, NULL, NULL);
    std::string s(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, NULL, NULL);
    return s;
}
// JSON 字符串转义（协议最小实现：引号/反斜杠/控制字符）
static std::string jsonEsc(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (size_t i = 0; i < s.size(); i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
        else if (c == '\n') o += "\\n";
        else if (c == '\r') o += "\\r";
        else if (c == '\t') o += "\\t";
        else if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o;
}
static void emitLine(const std::string& line) {
    // stdout 二进制模式单行写 + 立即刷（主进程按行读）
    fwrite(line.c_str(), 1, line.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

// —— 引擎状态映射（DLBT_DOWNLOAD_STATE → 协议字符串）——
static const char* stateName(int st) {
    switch (st) {
        case BTDS_QUEUED:            return "queued";
        case BTDS_CHECKING_FILES:    return "checking";
        case BTDS_DOWNLOADING_TORRENT: return "metainfo";
        case BTDS_DOWNLOADING:       return "downloading";
        case BTDS_PAUSED:            return "paused";
        case BTDS_FINISHED:          return "finished";
        case BTDS_SEEDING:           return "seeding";
        case BTDS_ALLOCATING:        return "allocating";
        case BTDS_ERROR:             return "error";
        default:                     return "unknown";
    }
}
static bool isDoneState(int st) { return st == BTDS_FINISHED || st == BTDS_SEEDING; }

// 取错误详情（BTDS_ERROR 时引擎内记录的原因文本）
static std::string lastErrorText(HANDLE h) {
    char buf[512] = { 0 };
    int n = (int)sizeof(buf);
    if (DLBT_Downloader_GetLastError(h, buf, &n) == S_OK && n > 0) {
        if (n > (int)sizeof(buf) - 1) n = (int)sizeof(buf) - 1;
        return std::string(buf, (size_t)n);
    }
    return std::string("BT download error");
}

// —— 任务表 ——
struct Task {
    std::wstring id;          // 任务 id（与主进程 taskId 一致）
    HANDLE h;                 // DLBT 下载器句柄
    std::wstring statusFile;  // 引擎状态文件（续传锚点）
    int state;                // 上次轮询引擎态（转达沿检测）
    bool doneSent;            // done 事件已发
    bool errorSent;           // error 事件已发
    Task() : h(NULL), state(BTDS_QUEUED), doneSent(false), errorSent(false) {}
};
static std::map<std::wstring, Task> g_tasks;
static std::mutex g_mtx;
static std::atomic<bool> g_quit(false);

// 1s 轮询：进度推送 + done/error 沿检测（每任务一条，量级 ≤ 并行任务数，无节流必要）
static void pollLoop() {
    while (!g_quit.load()) {
        Sleep(1000);
        if (g_quit.load()) break;
        std::lock_guard<std::mutex> lock(g_mtx);
        for (auto& kv : g_tasks) {
            Task& t = kv.second;
            if (!t.h) continue;
            int st = (int)DLBT_Downloader_GetState(t.h);
            UINT64 done = DLBT_Downloader_GetTotalWantedDone(t.h);
            UINT64 total = DLBT_Downloader_GetTotalWanted(t.h);
            if (!total) total = DLBT_Downloader_GetTotalFileSize(t.h);
            UINT down = DLBT_Downloader_GetDownloadSpeed(t.h);
            UINT up = DLBT_Downloader_GetUploadSpeed(t.h);
            float prog = DLBT_Downloader_GetProgress(t.h) / 100.0f; // 引擎返回 0-100 百分值，归一 0-1（E2E 实测口径）
            std::string errText;
            if (st == BTDS_ERROR) errText = lastErrorText(t.h);
            char b[1024];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                "{\"evt\":\"progress\",\"id\":\"%s\",\"state\":\"%s\",\"progress\":%.4f,\"received\":%llu,\"total\":%llu,\"down\":%u,\"up\":%u,\"error\":\"%s\"}",
                wideToUtf8(t.id).c_str(), stateName(st), prog,
                (unsigned long long)done, (unsigned long long)total, down, up,
                jsonEsc(errText).c_str());
            emitLine(b);
            if (isDoneState(st) && !t.doneSent) {
                t.doneSent = true;
                emitLine("{\"evt\":\"done\",\"id\":\"" + jsonEsc(wideToUtf8(t.id)) + "\"}");
            }
            if (st == BTDS_ERROR && !t.errorSent) {
                t.errorSent = true;
                emitLine("{\"evt\":\"error\",\"id\":\"" + jsonEsc(wideToUtf8(t.id)) +
                         "\",\"error\":\"" + jsonEsc(errText) + "\"}");
            }
            t.state = st;
        }
    }
}

// start：种子文件(本地路径) + 输出目录 + 状态目录 + P2SP HTTP 源列表 → 引擎任务
// reportIp：Tracker 自报 IP（服务端登录回执核实的真实外网地址，主进程经 stdio 协议透传）——
// announce 时引擎以 ip= 参数上报，供自建 Tracker 优先采信（公共 Tracker 按 BEP42 忽略跨网段
// 自报，不影响）；空串=不设置，走引擎默认行为（Tracker 记录 announce 连接来源）
static void cmdStart(const std::wstring& id, const std::wstring& torrent,
                     const std::wstring& out, const std::wstring& statusDir,
                     const std::vector<std::string>& httpUrls,
                     const std::string& reportIp) {
    std::lock_guard<std::mutex> lock(g_mtx);
    if (g_tasks.find(id) != g_tasks.end()) { emitLine("{\"evt\":\"log\",\"m\":\"task exists\"}"); return; }
    // 全局设置在首个任务 start 时刷新即可（引擎内核已启动，幂等）；每次 start 重设同值无害
    if (!reportIp.empty()) DLBT_SetReportIP(reportIp.c_str());
    CreateDirectoryW(statusDir.c_str(), NULL);
    std::wstring statusFile = statusDir + L"\\" + id + L".dat";
    HANDLE h = DLBT_Downloader_Initialize(
        torrent.c_str(), out.c_str(), statusFile.c_str(),
        FILE_ALLOCATE_SPARSE, FALSE, FALSE, NULL, NULL, FALSE, FALSE);
    if (!h) {
        char b[512];
        _snprintf_s(b, sizeof(b), _TRUNCATE,
            "{\"evt\":\"start_fail\",\"id\":\"%s\",\"error\":\"%s\"}",
            jsonEsc(wideToUtf8(id)).c_str(), jsonEsc(wideToUtf8(std::to_wstring(GetLastError()))).c_str());
        emitLine(b);
        return;
    }
    // P2SP：同一任务叠加 HTTP 直链源（服务器文件接口，URL 自带 username 鉴权参数），
    // 无 peer/种子时 HTTP 保底出速度，BT 通道与 HTTP 通道并行互补。
    // 单 HTTP 源默认 1 会话会因任一 404/慢响应队头阻塞整任务，提至 8 并发
    DLBT_Downloader_SetMaxSessionPerHttp(h, 8);
    for (size_t i = 0; i < httpUrls.size(); i++) {
        std::string u = httpUrls[i];
        DLBT_Downloader_AddHttpDownload(h, &u[0]);
    }
    Task t;
    t.id = id;
    t.h = h;
    t.statusFile = statusFile;
    g_tasks[id] = t;
}

static void cmdPause(const std::wstring& id) {
    std::lock_guard<std::mutex> lock(g_mtx);
    auto it = g_tasks.find(id);
    if (it != g_tasks.end() && it->second.h) DLBT_Downloader_Pause(it->second.h);
}
static void cmdResume(const std::wstring& id) {
    std::lock_guard<std::mutex> lock(g_mtx);
    auto it = g_tasks.find(id);
    if (it != g_tasks.end() && it->second.h) {
        if ((int)DLBT_Downloader_GetState(it->second.h) == BTDS_ERROR)
            DLBT_Downloader_ResumeInError(it->second.h); // 错误态先恢复重下
        DLBT_Downloader_Resume(it->second.h);
    }
}
static void cmdCancel(const std::wstring& id, bool del) {
    std::wstring statusFile;
    {
        std::lock_guard<std::mutex> lock(g_mtx);
        auto it = g_tasks.find(id);
        if (it == g_tasks.end()) return;
        if (it->second.h) {
            // del=true 删全部已下数据（取消不留残留）；否则仅释放句柄保留断点
            DLBT_Downloader_Release(it->second.h, del ? DLBT_RELEASE_DELETE_ALL : DLBT_RELEASE_NO_WAIT);
        }
        statusFile = it->second.statusFile;
        g_tasks.erase(it);
    }
    if (del && !statusFile.empty()) DeleteFileW(statusFile.c_str());
    emitLine("{\"evt\":\"closed\",\"id\":\"" + jsonEsc(wideToUtf8(id)) + "\"}");
}

// stdin 行读取线程：解析命令分发（UTF-8 JSON 最小解析：仅取本协议已知键，字符串值支持 \" \\\\ \\n \\r \\t \\uXXXX）
static std::string jsonUnesc(const std::string& s) {
    std::string o;
    o.reserve(s.size());
    for (size_t i = 0; i < s.size(); i++) {
        if (s[i] != '\\') { o += s[i]; continue; }
        if (++i >= s.size()) break;
        char c = s[i];
        if (c == 'n') o += '\n';
        else if (c == 'r') o += '\r';
        else if (c == 't') o += '\t';
        else if (c == 'u' && i + 4 < s.size()) {
            wchar_t wc = (wchar_t)strtoul(std::string(s, i + 1, 4).c_str(), NULL, 16);
            i += 4;
            // 仅处理 BMP 内字符：UTF-8 编码落回（中文在 \u 转义时走这里）
            if (wc < 0x80) o += (char)wc;
            else if (wc < 0x800) { o += (char)(0xC0 | (wc >> 6)); o += (char)(0x80 | (wc & 0x3F)); }
            else { o += (char)(0xE0 | (wc >> 12)); o += (char)(0x80 | ((wc >> 6) & 0x3F)); o += (char)(0x80 | (wc & 0x3F)); }
        }
        else o += c;
    }
    return o;
}
// 极简 JSON 取值：在整行中找 "key":"value"（字符串值）或 "key":123（数值），不处理嵌套同名歧义
static bool jGetStr(const std::string& line, const char* key, std::string& out) {
    std::string pat = "\"" + std::string(key) + "\":\"";
    size_t p = line.find(pat);
    if (p == std::string::npos) return false;
    p += pat.size();
    std::string v;
    while (p < line.size()) {
        if (line[p] == '\\' && p + 1 < line.size()) { v += line[p]; v += line[p + 1]; p += 2; continue; }
        if (line[p] == '"') break;
        v += line[p]; p++;
    }
    out = jsonUnesc(v);
    return true;
}
static bool jGetNum(const std::string& line, const char* key, long long& out) {
    std::string pat = "\"" + std::string(key) + "\":";
    size_t p = line.find(pat);
    if (p == std::string::npos) return false;
    p += pat.size();
    while (p < line.size() && (line[p] == ' ' || line[p] == '\t')) p++;
    bool neg = false;
    if (p < line.size() && line[p] == '-') { neg = true; p++; }
    if (p >= line.size() || line[p] < '0' || line[p] > '9') return false;
    long long v = 0;
    while (p < line.size() && line[p] >= '0' && line[p] <= '9') { v = v * 10 + (line[p] - '0'); p++; }
    out = neg ? -v : v;
    return true;
}
// 取字符串数组值 "key":["a","b"]
static bool jGetArr(const std::string& line, const char* key, std::vector<std::string>& out) {
    std::string pat = "\"" + std::string(key) + "\":[";
    size_t p = line.find(pat);
    if (p == std::string::npos) return false;
    p += pat.size();
    while (p < line.size()) {
        while (p < line.size() && (line[p] == ' ' || line[p] == ',')) p++;
        if (p >= line.size() || line[p] == ']') break;
        if (line[p] != '"') break;
        p++;
        std::string v;
        while (p < line.size()) {
            if (line[p] == '\\' && p + 1 < line.size()) { v += line[p]; v += line[p + 1]; p += 2; continue; }
            if (line[p] == '"') break;
            v += line[p]; p++;
        }
        p++; // 跳过收尾引号
        out.push_back(jsonUnesc(v));
    }
    return true;
}

static void stdinLoop() {
    std::string line;
    char buf[65536];
    while (!g_quit.load()) {
        DWORD n = 0;
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, (DWORD)sizeof(buf), &n, NULL) || n == 0) break;
        for (DWORD i = 0; i < n; i++) {
            char c = buf[i];
            if (c == '\n') {
                if (!line.empty()) {
                    if (line[line.size() - 1] == '\r') line.erase(line.size() - 1);
                    std::string cmd;
                    std::string id;
                    if (jGetStr(line, "cmd", cmd)) {
                        jGetStr(line, "id", id);
                        std::wstring wid = utf8ToWide(id);
                        if (cmd == "start") {
                            std::string torrent, out, status, reportIp;
                            std::vector<std::string> http;
                            jGetStr(line, "torrent", torrent);
                            jGetStr(line, "out", out);
                            jGetStr(line, "status", status);
                            jGetArr(line, "http", http);
                            jGetStr(line, "report_ip", reportIp); // 可选：缺失时保持空串=不自报
                            cmdStart(wid, utf8ToWide(torrent), utf8ToWide(out), utf8ToWide(status), http, reportIp);
                        } else if (cmd == "pause") cmdPause(wid);
                        else if (cmd == "resume") cmdResume(wid);
                        else if (cmd == "cancel") {
                            long long del = 0;
                            jGetNum(line, "del", del);
                            cmdCancel(wid, del != 0);
                        } else if (cmd == "quit") {
                            g_quit.store(true);
                            break;
                        }
                    }
                    line.clear();
                }
                if (g_quit.load()) break;
            } else {
                line += c;
            }
        }
    }
    g_quit.store(true);
}

int main() {
    // stdio 二进制模式：协议按行裸传，禁止 CRLF 文本翻译破坏 JSON
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);

    // 商业授权（用户已有授权串，照参考工程原样启用）
    DLBT_AddAppSettings(0x7001139, "gengyang", 0x30003, "20220630", 0x202106280);

    // P2SP HTTP 源路径编码：引擎把种子内 UTF-8 path 按 ANSI(GBK) 解读，bUtf8=false 使其回转
    // GBK 字节（恰还原为原始 UTF-8 字节流）后再百分号编码——服务端按 UTF-8 解码即得正确文件名。
    // extName 传空=不追加扩展名伪装，bUseRandParam=false=不加随机防缓存参数（污染 URL 匹配）。
    // E2E 实测：中文文件名缺此设置会 404 死循环，单 HTTP 会话被阻塞拖垮整任务吞吐（80% 数据丢弃）。
    DLBT_SetP2SPExtName("", false, false);

    // 全局上传限速 2MB/s（接口单位为字节/秒，见 DLBT.h"限速1M请输入1024*1024"）：完成转做种后
    // 引擎持续对外供种，不限速会占满上行带宽拖慢用户游戏/聊天体验（下载时 BT 通道上传贡献同样
    // 受此约束，P2SP 下行主力是 HTTP 源，不受影响）
    DLBT_SetUploadSpeedLimit(2 * 1024 * 1024);

    // 内核启动：DHT + UPnP + 局域网发现全开；监听端口 29010-29030（避开 im-server 常用端口段）
    DLBT_KERNEL_START_PARAM param;
    param.bStartLocalDiscovery = TRUE;
    param.bStartUPnP = TRUE;
    param.bStartDHT = TRUE;
    param.bLanUser = FALSE;
    param.bVODMode = FALSE;
    param.startPort = 29010;
    param.endPort = 29030;
    if (!DLBT_Startup(&param, NULL, false, "{5930D71F-D6B6-4019-A186-8F7226F54573}")) {
        emitLine("{\"evt\":\"fatal\",\"error\":\"DLBT_Startup failed\"}");
        return 1;
    }
    USHORT port = DLBT_GetListenPort();
    char b[128];
    _snprintf_s(b, sizeof(b), _TRUNCATE, "{\"evt\":\"ready\",\"port\":%u}", (unsigned)port);
    emitLine(b);

    std::thread thIn(stdinLoop);
    std::thread thPoll(pollLoop);

    // 等退出信号后收口：先停读，再逐任务等待释放（保文件完整），最后关内核
    while (!g_quit.load()) Sleep(200);
    thIn.join();
    {
        std::lock_guard<std::mutex> lock(g_mtx);
        for (auto& kv : g_tasks) {
            if (kv.second.h) DLBT_Downloader_Release(kv.second.h, DLBT_RELEASE_WAIT);
        }
        g_tasks.clear();
    }
    DLBT_PreShutdown();
    DLBT_Shutdown();
    thPoll.join();
    return 0;
}
