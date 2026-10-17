// scr-hook.cpp - P0 尖刺：SC:R 网络调用捕获 DLL（IAT Hook 最小验证版）
// 目的：验证 ① 提权注入是否成功 ② IAT Hook 是否生效 ③ 抓到游戏真实 sendto/recvfrom
// 原则：P0 只读不转发（捕获日志后原样调用真实函数，游戏行为不变）
// 日志：%TEMP%\scr-hook.log（每函数前 64 次调用记录，之后静默透传，避免卡顿）
//
// 注入方式：scr-injector.exe（CreateRemoteThread + LoadLibraryW，标准注入）
// 编译：cl /O2 /MT /LD scr-hook.cpp /Fe:scr-hook.dll ws2_32.lib（见 build.ps1）

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string.h>
#include <tlhelp32.h>
#include <MinHook.h>

#pragma comment(lib, "ws2_32.lib")

static FILE* g_log = NULL;
static CRITICAL_SECTION g_cs;
static volatile LONG g_calls[8] = { 0 }; // sendto/recvfrom/WSASendTo/WSARecvFrom/send/recv/WSARecv/connect
static const int kLogLimit = 64;

static void LogLine(const char* fmt, ...) {
    if (!g_log) return;
    EnterCriticalSection(&g_cs);
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(g_log, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    va_list a; va_start(a, fmt);
    vfprintf(g_log, fmt, a);
    va_end(a);
    fputc('\n', g_log);
    fflush(g_log);
    LeaveCriticalSection(&g_cs);
}

// sockaddr → "ip:port"（不查 DNS，纯数值转换）
static void SockToStr(const struct sockaddr* sa, char* out, size_t outlen) {
    if (!sa) { strcpy_s(out, outlen, "(null)"); return; }
    char ip[64] = "?";
    unsigned short port = 0;
    if (sa->sa_family == AF_INET) {
        auto s4 = (const struct sockaddr_in*)sa;
        inet_ntop(AF_INET, &s4->sin_addr, ip, sizeof(ip));
        port = ntohs(s4->sin_port);
    } else if (sa->sa_family == AF_INET6) {
        auto s6 = (const struct sockaddr_in6*)sa;
        inet_ntop(AF_INET6, &s6->sin6_addr, ip, sizeof(ip));
        port = ntohs(s6->sin6_port);
    } else {
        sprintf_s(ip, sizeof(ip), "af%d", sa->sa_family);
    }
    sprintf_s(out, outlen, "%s:%u", ip, port);
}

static void LogPayload(char* tag, const char* buf, int len) {
    char hex[80] = "";
    int n = len < 16 ? len : 16;
    if (buf && n > 0) {
        for (int i = 0; i < n; i++) sprintf_s(hex + i * 2, sizeof(hex) - i * 2, "%02x", (unsigned char)buf[i]);
    }
    LogLine("%s len=%d head=%s", tag, len, hex);
}

// ---------- 原函数指针（Hook 集：发现流量在 mDNSResponder 服务进程，对战流量在游戏进程
// 且可能为连接式 UDP——send/recv/connect 全覆盖）----------
typedef int (WINAPI* pfn_sendto)(SOCKET, const char*, int, int, const struct sockaddr*, int);
typedef int (WINAPI* pfn_recvfrom)(SOCKET, char*, int, int, struct sockaddr*, int*);
typedef int (WINAPI* pfn_WSASendTo)(SOCKET, LPWSABUF, DWORD, LPDWORD, DWORD, const struct sockaddr*, int, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WINAPI* pfn_WSARecvFrom)(SOCKET, LPWSABUF, DWORD, LPDWORD, LPDWORD, struct sockaddr*, LPINT, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WINAPI* pfn_send)(SOCKET, const char*, int, int);
typedef int (WINAPI* pfn_recv)(SOCKET, char*, int, int);
typedef int (WINAPI* pfn_WSARecv)(SOCKET, LPWSABUF, DWORD, LPDWORD, LPDWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WINAPI* pfn_connect)(SOCKET, const struct sockaddr*, int);
static pfn_sendto      real_sendto = NULL;
static pfn_recvfrom    real_recvfrom = NULL;
static pfn_WSASendTo   real_WSASendTo = NULL;
static pfn_WSARecvFrom real_WSARecvFrom = NULL;
static pfn_send        real_send = NULL;
static pfn_recv        real_recv = NULL;
static pfn_WSARecv     real_WSARecv = NULL;
static pfn_connect     real_connect = NULL;

// ---------- Hook 桥 ----------
static bool LogGate(int idx) {
    // 每函数前 kLogLimit 次记录，之后静默透传（游戏实时性优先）
    LONG c = InterlockedIncrement(&g_calls[idx]);
    return c <= kLogLimit;
}

// ---------- P1 桥接（跨网数据路径）：截获游戏↔房主的 6112 UDP 流量 ⇄ 平台桥 ----------
// 帧格式（与平台 game-hook.js 统一）：[0]=0xFC [1..4]=源IP(主机序) [5..6]=源端口 [7..]=载荷
// 语义：帧内地址=游戏包的「源地址」——对端 DLL 以此为 from 注入 recvfrom；对端游戏回包的
// dst 即此地址，被对端 sendto Hook 截获——对称 NAT-in-user-mode（与 IP 路由/防火墙无关）
static SOCKET g_bridge = INVALID_SOCKET;
static volatile bool g_bridgeUp = false;
static sockaddr_in g_bridgeAddr = {};
static const unsigned short kGamePort = 6112; // 截获触发口（游戏↔房主数据面）
static volatile bool g_peerLocked = false;    // 首包锁定对端端点（过滤暴雪在线流量）
static volatile unsigned int g_peerIp = 0;
static volatile unsigned short g_peerPort = 0;

// 注入队列（桥线程生产 → 游戏网络线程消费，单生产单消费无锁环）
struct InjPkt { unsigned int ip; unsigned short port; int len; char data[1400]; };
static InjPkt g_inj[64];
static volatile LONG g_injHead = 0, g_injTail = 0;

static void PushInject(unsigned int ip, unsigned short port, const char* data, int len) {
    LONG h = InterlockedIncrement(&g_injHead);
    InjPkt* p = &g_inj[(h - 1) & 63];
    p->ip = ip; p->port = port;
    p->len = len < 1400 ? len : 1400;
    memcpy(p->data, data, p->len);
}

static bool PopInject(unsigned int* ip, unsigned short* port, char* buf, int* len) {
    if (g_injTail == g_injHead) return false;
    InjPkt* p = &g_inj[g_injTail & 63];
    *ip = p->ip; *port = p->port;
    int n = p->len < *len ? p->len : *len;
    memcpy(buf, p->data, n);
    *len = n;
    g_injTail = g_injTail + 1;
    return true;
}

// 截获转发：游戏包 → 封帧 → 平台桥（DataChannel → 对端）
static bool BridgeForward(unsigned int ip, unsigned short port, const char* data, int len) {
    if (!g_bridgeUp) return false;
    char frame[1600];
    frame[0] = (char)0xFC;
    memcpy(frame + 1, &ip, 4);
    memcpy(frame + 5, &port, 2);
    int pl = len < 1500 ? len : 1500;
    memcpy(frame + 7, data, pl);
    sendto(g_bridge, frame, 7 + pl, 0, (const sockaddr*)&g_bridgeAddr, sizeof(g_bridgeAddr));
    return true;
}

// 桥线程：HELLO 上线 → 收对端帧入注入队列
static DWORD WINAPI BridgeThread(LPVOID) {
    g_bridge = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (g_bridge == INVALID_SOCKET) return 1;
    BOOL nb = TRUE; ioctlsocket(g_bridge, FIONBIO, (u_long*)&nb); // 非阻塞轮询（与游戏 recv 轮询共存）
    g_bridgeAddr.sin_family = AF_INET;
    g_bridgeAddr.sin_addr.s_addr = inet_addr("127.0.0.1");
    g_bridgeAddr.sin_port = htons(61230);
    char hello[16]; strcpy_s(hello, "SCRHOOK1");
    DWORD lastHello = 0;
    char buf[2048];
    sockaddr_in from; int fl = sizeof(from);
    for (;;) {
        DWORD now = GetTickCount();
        if (!g_bridgeUp && now - lastHello > 2000) {
            lastHello = now;
            sendto(g_bridge, hello, (int)strlen(hello), 0, (const sockaddr*)&g_bridgeAddr, sizeof(g_bridgeAddr));
        }
        int r = recvfrom(g_bridge, buf, sizeof(buf), 0, (sockaddr*)&from, &fl);
        if (r > 0) {
            if (r == 10 && memcmp(buf, "SCRHOOKACK", 10) == 0 && !g_bridgeUp) {
                g_bridgeUp = true;
                LogLine("桥已上线（127.0.0.1:61230）：6112 流量进入转发模式");
            } else if (r > 7 && (unsigned char)buf[0] == 0xFC && g_bridgeUp) {
                unsigned int ip; unsigned short port;
                memcpy(&ip, buf + 1, 4); memcpy(&port, buf + 5, 2);
                PushInject(ip, port, buf + 7, r - 7);
            }
        }
        Sleep(1);
    }
}

static int WINAPI hook_sendto(SOCKET s, const char* buf, int len, int flags, const struct sockaddr* to, int tolen) {
    // P1 桥接：游戏套接字（源端口 6112）的全部流量截获转发（跨网数据路径；桥未上线时透传原生）。
    // 触发用源端口而非目标端口：房主通告端点为动态口（实测 192.168.1.15:57623），按目标口匹配
    // 会漏截。首包锁定对端端点（过滤暴雪在线流量），此后仅转发对端方向
    if (to && to->sa_family == AF_INET && g_bridgeUp) {
        auto a = (const struct sockaddr_in*)to;
        unsigned short dport = ntohs(a->sin_port);
        sockaddr_in ls = {}; int lsn = sizeof(ls);
        getsockname(s, (sockaddr*)&ls, &lsn);
        unsigned short sport = ntohs(ls.sin_port);
        if (sport == kGamePort || dport == kGamePort) {
            unsigned int dip = ntohl(a->sin_addr.s_addr);
            if (!g_peerLocked) {
                g_peerIp = dip; g_peerPort = dport; g_peerLocked = true;
                char ad[32]; sprintf_s(ad, sizeof(ad), "%u.%u.%u.%u:%u", (dip >> 24) & 255, (dip >> 16) & 255, (dip >> 8) & 255, dip & 255, dport);
                LogLine("对端端点锁定：%s（此后仅转发该方向）", ad);
            }
            if (dip == g_peerIp && dport == g_peerPort) {
                char dst[80]; SockToStr(to, dst, sizeof(dst));
                if (LogGate(0)) { char t[48]; sprintf_s(t, sizeof(t), "sendto[FWD] dst=%s", dst); LogPayload(t, buf, len); }
                BridgeForward(dip, dport, buf, len);
                return len; // 截获成功：不落真实网络
            }
            // 非对端目标（暴雪在线等）：透传原生
        }
    }
    char dst[80];
    SockToStr(to, dst, sizeof(dst));
    if (LogGate(0)) { char t[32]; sprintf_s(t, sizeof(t), "sendto sock=%llu dst=%s", (unsigned long long)s, dst); LogPayload(t, buf, len); }
    return real_sendto(s, buf, len, flags, to, tolen);
}

static int WINAPI hook_recvfrom(SOCKET s, char* buf, int len, int flags, struct sockaddr* from, int* fromlen) {
    int r = real_recvfrom(s, buf, len, flags, from, fromlen);
    char src[80];
    SockToStr(from, src, sizeof(src));
    if (r > 0 && LogGate(1)) { char t[32]; sprintf_s(t, sizeof(t), "recvfrom sock=%llu src=%s", (unsigned long long)s, src); LogPayload(t, buf, r); }
    return r;
}

static int WINAPI hook_WSASendTo(SOCKET s, LPWSABUF bufs, DWORD cnt, LPDWORD sent, DWORD flags, const struct sockaddr* to, int tolen, LPWSAOVERLAPPED ov, LPWSAOVERLAPPED_COMPLETION_ROUTINE cr) {
    char dst[80];
    SockToStr(to, dst, sizeof(dst));
    if (LogGate(2) && bufs && cnt) { char t[96]; sprintf_s(t, sizeof(t), "WSASendTo sock=%llu dst=%s", (unsigned long long)s, dst); LogPayload(t, bufs[0].buf, (int)bufs[0].len); }
    return real_WSASendTo(s, bufs, cnt, sent, flags, to, tolen, ov, cr);
}

static int WINAPI hook_WSARecvFrom(SOCKET s, LPWSABUF bufs, DWORD cnt, LPDWORD recvd, LPDWORD flags, struct sockaddr* from, LPINT fromlen, LPWSAOVERLAPPED ov, LPWSAOVERLAPPED_COMPLETION_ROUTINE cr) {
    // P1 桥接：注入队列优先（对端包以帧内源地址呈现，游戏视角=局域网）
    if (g_bridgeUp && bufs && cnt && bufs[0].len > 0) {
        unsigned int ip; unsigned short port; int len = bufs[0].len;
        if (PopInject(&ip, &port, bufs[0].buf, &len)) {
            if (from) {
                auto a = (struct sockaddr_in*)from;
                a->sin_family = AF_INET;
                a->sin_addr.s_addr = htonl(ip);
                a->sin_port = htons(port);
                if (fromlen) *fromlen = sizeof(sockaddr_in);
            }
            if (recvd) *recvd = len;
            if (LogGate(3)) { char t[80], ad[32]; sprintf_s(ad, sizeof(ad), "%u.%u.%u.%u:%u", (ip >> 24) & 255, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255, port); sprintf_s(t, sizeof(t), "WSARecvFrom[INJ] src=%s", ad); LogPayload(t, bufs[0].buf, len); }
            return 0;
        }
    }
    int r = real_WSARecvFrom(s, bufs, cnt, recvd, flags, from, fromlen, ov, cr);
    char src[80];
    SockToStr(from, src, sizeof(src));
    if (r == 0 && recvd && *recvd > 0 && LogGate(3) && bufs && cnt) {
        char t[96]; sprintf_s(t, sizeof(t), "WSARecvFrom sock=%llu src=%s", (unsigned long long)s, src);
        LogPayload(t, bufs[0].buf, (int)*recvd);
    }
    return r;
}

static int WINAPI hook_send(SOCKET s, const char* buf, int len, int flags) {
    if (LogGate(4)) { char t[32]; sprintf_s(t, sizeof(t), "send sock=%llu", (unsigned long long)s); LogPayload(t, buf, len); }
    return real_send(s, buf, len, flags);
}

static int WINAPI hook_recv(SOCKET s, char* buf, int len, int flags) {
    int r = real_recv(s, buf, len, flags);
    if (r > 0 && LogGate(5)) { char t[32]; sprintf_s(t, sizeof(t), "recv sock=%llu", (unsigned long long)s); LogPayload(t, buf, r); }
    return r;
}

static int WINAPI hook_WSARecv(SOCKET s, LPWSABUF bufs, DWORD cnt, LPDWORD recvd, LPDWORD flags, LPWSAOVERLAPPED ov, LPWSAOVERLAPPED_COMPLETION_ROUTINE cr) {
    int r = real_WSARecv(s, bufs, cnt, recvd, flags, ov, cr);
    if (r == 0 && recvd && *recvd > 0 && LogGate(6) && bufs && cnt) {
        char t[32]; sprintf_s(t, sizeof(t), "WSARecv sock=%llu", (unsigned long long)s);
        LogPayload(t, bufs[0].buf, (int)*recvd);
    }
    return r;
}

static int WINAPI hook_connect(SOCKET s, const struct sockaddr* name, int namelen) {
    char dst[80];
    SockToStr(name, dst, sizeof(dst));
    if (LogGate(7)) LogLine("connect sock=%llu dst=%s", (unsigned long long)s, dst);
    return real_connect(s, name, namelen);
}

// ---------- MinHook 内联 Hook：直接挂 ws2_32 函数体——游戏动态解析（GetProcAddress）
// 缓存的函数指针也指向函数体，内联 Hook 全量命中（IAT 方案实测 0 命中，已废弃）
static void InitHook(void) {
    InitializeCriticalSection(&g_cs);
    char path[MAX_PATH];
    GetTempPathA(MAX_PATH, path);
    strcat_s(path, "scr-hook.log");
    g_log = fopen(path, "a");
    LogLine("===== scr-hook 注入成功 pid=%d =====", GetCurrentProcessId());
    WSADATA wd; WSAStartup(MAKEWORD(2, 2), &wd);
    if (MH_Initialize() != MH_OK) { LogLine("MH_Initialize 失败"); return; }
    MH_STATUS st[8];
    st[0] = MH_CreateHookApi(L"ws2_32", "sendto", (void*)hook_sendto, (void**)&real_sendto);
    st[1] = MH_CreateHookApi(L"ws2_32", "recvfrom", (void*)hook_recvfrom, (void**)&real_recvfrom);
    st[2] = MH_CreateHookApi(L"ws2_32", "WSASendTo", (void*)hook_WSASendTo, (void**)&real_WSASendTo);
    st[3] = MH_CreateHookApi(L"ws2_32", "WSARecvFrom", (void*)hook_WSARecvFrom, (void**)&real_WSARecvFrom);
    st[4] = MH_CreateHookApi(L"ws2_32", "send", (void*)hook_send, (void**)&real_send);
    st[5] = MH_CreateHookApi(L"ws2_32", "recv", (void*)hook_recv, (void**)&real_recv);
    st[6] = MH_CreateHookApi(L"ws2_32", "WSARecv", (void*)hook_WSARecv, (void**)&real_WSARecv);
    st[7] = MH_CreateHookApi(L"ws2_32", "connect", (void*)hook_connect, (void**)&real_connect);
    LogLine("MH_CreateHookApi sendto=%d recvfrom=%d WSASendTo=%d WSARecvFrom=%d send=%d recv=%d WSARecv=%d connect=%d（0=MH_OK）",
            (int)st[0], (int)st[1], (int)st[2], (int)st[3], (int)st[4], (int)st[5], (int)st[6], (int)st[7]);
    MH_STATUS en = MH_EnableHook(MH_ALL_HOOKS);
    LogLine("MH_EnableHook=%d（0=MH_OK）——内联 Hook 生效", (int)en);
    LogLine("日志上限：每函数前 %d 次调用，之后静默透传", kLogLimit);
    HANDLE bt = CreateThread(NULL, 0, BridgeThread, NULL, 0, NULL); // P1 桥线程（HELLO/收帧/注入队列）
    if (bt) CloseHandle(bt);
}

static DWORD WINAPI InitThread(LPVOID) {
    InitHook();
    return 0;
}

BOOL APIENTRY DllMain(HMODULE mod, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(mod);
        CreateThread(NULL, 0, InitThread, NULL, 0, NULL); // 避开加载器锁
    }
    return TRUE;
}
