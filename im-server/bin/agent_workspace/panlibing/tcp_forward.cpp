// ============================================================
// tcp_forward.cpp —— 简单的 TCP 端口转发工具
// 用法: tcp_forward <本地监听端口> <远端主机> <远端端口> [本地绑定地址]
// 示例: tcp_forward 8080 192.168.1.10 80
//       即: 把发往本机 8080 的 TCP 流量转发到 192.168.1.10:80
//
// 平台: Windows (WinSock2) / Linux/macOS (POSIX socket)，单文件无第三方依赖
// 编译:
//   Windows(MSVC)  : cl tcp_forward.cpp ws2_32.lib
//   Windows(MinGW) : g++ -std=c++11 tcp_forward.cpp -o tcp_forward.exe -lws2_32
//   Linux          : g++ -std=c++11 tcp_forward.cpp -o tcp_forward -pthread
// ============================================================

#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <atomic>
#include <chrono>

#ifdef _WIN32
    #define WIN32_LEAN_AND_MEAN
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
    typedef SOCKET socket_t;
    #define CLOSE_SOCKET(s) closesocket(s)
    #define SHUT_WR_SOCKET  SD_SEND
    #define SHUT_RD_SOCKET  SD_RECEIVE
#else
    #include <unistd.h>
    #include <cerrno>
    #include <cstdlib>
    #include <sys/socket.h>
    #include <sys/types.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <netdb.h>
    #include <csignal>
    typedef int socket_t;
    #define INVALID_SOCKET (-1)
    #define SOCKET_ERROR    (-1)
    #define CLOSE_SOCKET(s) close(s)
    #define SHUT_WR_SOCKET  SHUT_WR
    #define SHUT_RD_SOCKET  SHUT_RD
#endif

// ---------------- 简易日志 ----------------
static void log_msg(const std::string &tag, const std::string &msg)
{
    char timebuf[64];
    auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm_now;
#ifdef _WIN32
    localtime_s(&tm_now, &now);
#else
    localtime_r(&now, &tm_now);
#endif
    std::strftime(timebuf, sizeof(timebuf), "%H:%M:%S", &tm_now);
    printf("[%s] [%s] %s\n", timebuf, tag.c_str(), msg.c_str());
    fflush(stdout);
}

// ---------------- 跨平台 socket 初始化 ----------------
static bool socket_startup()
{
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        printf("WSAStartup 失败\n");
        return false;
    }
#else
    // 避免对端关闭时进程被 SIGPIPE 干掉
    signal(SIGPIPE, SIG_IGN);
#endif
    return true;
}

static void socket_cleanup()
{
#ifdef _WIN32
    WSACleanup();
#endif
}

static std::string sock_err_str()
{
#ifdef _WIN32
    int e = WSAGetLastError();
#else
    int e = errno;
#endif
    char buf[256];
#ifdef _WIN32
    sprintf(buf, "错误码=%d", e);
    return std::string(buf);
#else
    return std::string(strerror(e));
#endif
}

// 解析主机名/地址到 sockaddr
static bool resolve_host(const std::string &host, int port, struct sockaddr_storage &out)
{
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;   // IPv4/IPv6 均可
    hints.ai_socktype = SOCK_STREAM;

    char portstr[16];
    sprintf(portstr, "%d", port);

    struct addrinfo *result = nullptr;
    int rc = getaddrinfo(host.c_str(), portstr, &hints, &result);
    if (rc != 0 || result == nullptr) {
#ifdef _WIN32
        printf("无法解析主机 %s:%d (%s)\n", host.c_str(), port, gai_strerrorA(rc));
#else
        printf("无法解析主机 %s:%d (%s)\n", host.c_str(), port, gai_strerror(rc));
#endif
        return false;
    }
    memcpy(&out, result->ai_addr, result->ai_addrlen);
    freeaddrinfo(result);
    return true;
}

// ---------------- 单向数据搬运（每个方向一个线程） ----------------
static void pump(socket_t from, socket_t to, std::atomic<bool> &peer_alive)
{
    char buf[8192];
    for (;;) {
        int n = recv(from, buf, sizeof(buf), 0);
        if (n <= 0) {              // 连接关闭或出错
            peer_alive = false;
            shutdown(to, SHUT_WR_SOCKET);   // 半关闭：通知对端数据已发完
            break;
        }
        int off = 0;
        while (off < n) {
            int w = send(to, buf + off, n - off, 0);
            if (w <= 0) {
                peer_alive = false;
                shutdown(from, SHUT_RD_SOCKET);
                return;
            }
            off += w;
        }
    }
}

// ---------------- 处理一条会话 ----------------
static void handle_connection(socket_t client, const std::string &remote_host, int remote_port)
{
    std::string client_ip = "未知";
    {
        struct sockaddr_storage ca;
        socklen_t alen = sizeof(ca);
        if (getpeername(client, (struct sockaddr *)&ca, &alen) == 0) {
            char ip[INET6_ADDRSTRLEN] = {0};
            if (ca.ss_family == AF_INET) {
                struct sockaddr_in *s4 = (struct sockaddr_in *)&ca;
                inet_ntop(AF_INET, &s4->sin_addr, ip, sizeof(ip));
            } else {
                struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)&ca;
                inet_ntop(AF_INET6, &s6->sin6_addr, ip, sizeof(ip));
            }
            client_ip = ip;
        }
    }

    // 1. 连接远端
    struct sockaddr_storage remote;
    if (!resolve_host(remote_host, remote_port, remote)) {
        CLOSE_SOCKET(client);
        return;
    }
    socket_t upstream = socket(remote.ss_family, SOCK_STREAM, 0);
    if (upstream == INVALID_SOCKET) {
        log_msg("ERR", "创建上游 socket 失败: " + sock_err_str());
        CLOSE_SOCKET(client);
        return;
    }
    if (connect(upstream, (struct sockaddr *)&remote, (socklen_t)sizeof(remote)) == SOCKET_ERROR) {
        log_msg("ERR", "连接远端 " + remote_host + ":" + std::to_string(remote_port)
                + " 失败: " + sock_err_str());
        CLOSE_SOCKET(upstream);
        CLOSE_SOCKET(client);
        return;
    }

    log_msg("连接", client_ip + " -> " + remote_host + ":" + std::to_string(remote_port) + " 建立");

    // 2. 两个线程分别负责 client->upstream 与 upstream->client 两个方向
    std::atomic<bool> aliveA(true), aliveB(true);
    std::thread t1(pump, client,   upstream, std::ref(aliveA));
    std::thread t2(pump, upstream, client,   std::ref(aliveB));
    t1.join();
    t2.join();

    log_msg("关闭", client_ip + " 的会话结束");

    CLOSE_SOCKET(upstream);
    CLOSE_SOCKET(client);
}

// ---------------- 主函数 ----------------
int main(int argc, char *argv[])
{
    printf("=====================================================\n");
    printf("  TCP 端口转发工具 (tcp_forward)\n");
    printf("=====================================================\n");

    if (argc < 4) {
        printf("用法: %s <本地监听端口> <远端主机> <远端端口> [本地绑定地址]\n", argv[0]);
        printf("示例: %s 8080 192.168.1.10 80\n", argv[0]);
        printf("      %s 8080 example.com 443 127.0.0.1\n", argv[0]);
        return 1;
    }

    int  listen_port  = atoi(argv[1]);
    int  remote_port  = atoi(argv[3]);
    std::string remote_host = argv[2];
    std::string bind_addr   = (argc >= 5) ? argv[4] : "0.0.0.0";

    if (listen_port <= 0 || listen_port > 65535 ||
        remote_port <= 0 || remote_port > 65535) {
        printf("端口号必须在 1~65535 之间\n");
        return 1;
    }
    if (!socket_startup()) return 1;

    // 监听 socket（绑定所有本地地址）
    struct addrinfo hints, *res = nullptr;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags    = AI_PASSIVE;

    char portstr[16];
    sprintf(portstr, "%d", listen_port);

    int rc = getaddrinfo(bind_addr.c_str(), portstr, &hints, &res);
    if (rc != 0 || res == nullptr) {
#ifdef _WIN32
        printf("无法解析本地绑定地址 %s: %s\n", bind_addr.c_str(), gai_strerrorA(rc));
#else
        printf("无法解析本地绑定地址 %s: %s\n", bind_addr.c_str(), gai_strerror(rc));
#endif
        socket_cleanup();
        return 1;
    }

    socket_t listen_fd = INVALID_SOCKET;
    for (struct addrinfo *p = res; p != nullptr; p = p->ai_next) {
        listen_fd = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (listen_fd == INVALID_SOCKET) continue;

        int yes = 1;
        setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));

        if (bind(listen_fd, p->ai_addr, (socklen_t)p->ai_addrlen) == 0) break;
        CLOSE_SOCKET(listen_fd);
        listen_fd = INVALID_SOCKET;
    }
    freeaddrinfo(res);

    if (listen_fd == INVALID_SOCKET) {
        printf("绑定/监听端口 %d 失败: %s\n", listen_port, sock_err_str().c_str());
        socket_cleanup();
        return 1;
    }
    if (listen(listen_fd, SOMAXCONN) == SOCKET_ERROR) {
        printf("listen 失败: %s\n", sock_err_str().c_str());
        CLOSE_SOCKET(listen_fd);
        socket_cleanup();
        return 1;
    }

    printf("转发规则:  监听 [%s]:%d  ->  %s:%d\n",
           bind_addr.c_str(), listen_port, remote_host.c_str(), remote_port);
    printf("按 Ctrl+C 退出。等待连接中...\n");

    for (;;) {
        struct sockaddr_storage client_addr;
        socklen_t addrlen = sizeof(client_addr);
        socket_t client = accept(listen_fd, (struct sockaddr *)&client_addr, &addrlen);
        if (client == INVALID_SOCKET) {
            log_msg("ERR", "accept 失败: " + sock_err_str());
            continue;
        }
        // 每个连接一个线程处理，主循环继续 accept 新连接
        try {
            std::thread(handle_connection, client, remote_host, remote_port).detach();
        } catch (const std::exception &e) {
            log_msg("ERR", std::string("创建线程失败: ") + e.what());
            CLOSE_SOCKET(client);
        }
    }

    // 正常运行不会走到这里（Ctrl+C 直接终止进程）
    CLOSE_SOCKET(listen_fd);
    socket_cleanup();
    return 0;
}
