/**
 * (C) 2007-09 - Luca Deri <deri@ntop.org>
 *               Richard Andrews <andrews@ntop.org>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not see see <http://www.gnu.org/licenses/>
 *
 * Code contributions courtesy of:
 * Don Bindner <don.bindner@gmail.com>
 * Sylwester Sosnowski <syso-n2n@no-route.org>
 * Wilfried "Wonka" Klaebe
 * Lukasz Taczuk
 *
 */

#include "n2n.h"
#include "n2n_transforms.h"
#include <assert.h>
#include <sys/stat.h>
#include "minilzo.h"

#include "scm.h"
#include <stdio.h>
#include <Windows.h>
#include <string.h>
#include <tlhelp32.h>

int n2n_main(int, char **);// 主函数
int n2n_stop(void *);// 停止函数
// 共享内存名称
// ===== launch guard: this binary is private to the project client =====
// 1) parent process must be the project client (im-client.exe; electron.exe for dev run)
// 2) parent must write the auth secret to stdin within timeout, or we exit silently
// (old shared-memory gate removed; UDP mgmt "stop" now requires the same secret)
#define LAUNCH_AUTH_SECRET      "b7e4a91c5d2f83a60f4d1c8e97b25a36"
#define LAUNCH_AUTH_TIMEOUT_MS  10000

int keep_running = 1; /* global run flag: n2n_stop/mgmt-stop clear it; TAP reader thread polls it */

static HANDLE g_authEvent = NULL;

static int checkParentProcess(void) {
    DWORD selfPid = GetCurrentProcessId();
    DWORD parentPid = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32 pe;
        ZeroMemory(&pe, sizeof(pe));
        pe.dwSize = sizeof(pe);
        if (Process32First(snap, &pe)) {
            do {
                if (pe.th32ProcessID == selfPid) { parentPid = pe.th32ParentProcessID; break; }
            } while (Process32Next(snap, &pe));
        }
        CloseHandle(snap);
    }
    if (parentPid == 0) return 0;
    {
        HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid);
        char path[MAX_PATH];
        DWORD sz = MAX_PATH;
        int ok = 0;
        if (hp) {
            if (QueryFullProcessImageNameA(hp, 0, path, &sz) && sz > 0 && sz < MAX_PATH) {
                const char *base = path + sz;
                const char *q;
                for (q = path; q < path + sz; q++)
                    if (*q == '\\' || *q == '/') base = q + 1;
                ok = (_stricmp(base, "im-client.exe") == 0) || (_stricmp(base, "electron.exe") == 0);
            }
            CloseHandle(hp);
        }
        return ok;
    }
}

static DWORD WINAPI authReadThread(LPVOID unused) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    char buf[64];
    DWORD n = 0, total = 0;
    (void)unused;
    ZeroMemory(buf, sizeof(buf));
    while (total < sizeof(buf) - 1) {
        if (!ReadFile(in, buf + total, 1, &n, NULL) || n == 0) break;
        if (buf[total] == '\n') break;
        total++;
    }
    buf[total] = 0;
    if (strcmp(buf, LAUNCH_AUTH_SECRET) == 0) SetEvent(g_authEvent);
    /* parent-liveness watchdog: the stdin pipe stays open while the project client runs;
       EOF/error here means the client died (crash/force-kill) -> graceful stop, no orphan */
    for (;;) {
        char sink[256];
        if (!ReadFile(in, sink, sizeof(sink), &n, NULL) || n == 0) {
            n2n_stop(NULL);
            break;
        }
    }
    return 0;
}

struct SCM_def sd = {
        .name = "edge",// 边缘节点名称
        .desc = "edge - n2n VPN Edge node",/// 边缘节点
        .main = n2n_main,// 主函数
        .stop = n2n_stop,// 停止函数
};


#if defined(DEBUG)
#define SOCKET_TIMEOUT_INTERVAL_SECS    5// 调试模式下，套接字超时间隔为5秒
#define DEFAULT_HOLEPUNCH_INTERVAL      20 // 调试模式下，默认的打洞间隔为20秒
#else  /* #if defined(DEBUG) */
#define SOCKET_TIMEOUT_INTERVAL_SECS    5// 套接字超时间为5秒
#define DEFAULT_HOLEPUNCH_INTERVAL      25 // 默认的打洞间隔为25秒
#endif /* #if defined(DEBUG) */

#define REGISTER_SUPER_INTERVAL_MIN     10   //注册超级节点的最小时间间隔为10秒
#define REGISTER_SUPER_INTERVAL_MAX     120  //注册超级节点的最大时间间隔为120秒

#define IFACE_UPDATE_INTERVAL           (30) /* 通常获取IP地址租约所需的时间间隔为30秒. */
#define TRANSOP_TICK_INTERVAL           (10) /* TRANSOP计时器的时间间隔为10秒 */

#define STAT_CALC_INTERVAL				(10) /* 大约每隔10秒计算一次bps值 */

/** command line参数的最大长度 */
#define MAX_CMDLINE_BUFFER_LENGTH    4096

/** 配置文件中一行的最大长度 */
#define MAX_CONFFILE_LINE_LENGTH        1024

#define N2N_PATHNAME_MAXLEN             256
#define N2N_MAX_TRANSFORMS              16
#define N2N_EDGE_MGMT_PORT              5644

/** 存储不同transform的transop数组的位置.
 *
 *  Used by transop_enum_to_index(). 函数使用这些位置
 *  参考n2n_transforms.h中的transform枚举 */
#define N2N_TRANSOP_NULL_IDX    0// 空transform的位置
#define N2N_TRANSOP_TF_IDX      1// TF transform的位置
#define N2N_TRANSOP_AESCBC_IDX  2// AES-CBC transform的位置
/* etc. */



/* Work-memory needed for compression. Allocate memory in units
 * of `lzo_align_t' (instead of `char') to make sure it is properly aligned.
 */

/* #define HEAP_ALLOC(var,size)						\ */
/*   lzo_align_t __LZO_MMODEL var [ ((size) + (sizeof(lzo_align_t) - 1)) / sizeof(lzo_align_t) ] */

/* static HEAP_ALLOC(wrkmem,LZO1X_1_MEM_COMPRESS); */

/* ******************************************************* */

#define N2N_EDGE_SN_HOST_SIZE 48// 48位主机名为48字节
#define N2N_EDGE_LOCAL_IP_SIZE 48// 48位本地IP为48字节

typedef char n2n_sn_name_t[N2N_EDGE_SN_HOST_SIZE];// 超级节点主机名类型
typedef char n2n_local_ip_t[N2N_EDGE_LOCAL_IP_SIZE];// 本地IP类型

#define N2N_EDGE_NUM_SUPERNODES 2 // 目前有2个网关数量限制
#define N2N_EDGE_SUP_ATTEMPTS   3       /* 在切换到下一个超级节点之前的失败尝试次数. */


/** 边缘主要结构类型. */
struct n2n_edge
{
    int                 daemon;                 /**< 如果该边应该在后台运行，则为非零值。. */
    uint8_t             re_resolve_supernode_ip;//** 重新解析超级节点IP地址. */

    n2n_sock_t          supernode;//** 超级节点套接字. */
    n2n_sock_t          local_sock;//* 本地套接字. */

    size_t              sn_idx;                 /**< 当前活动的超级节点. */
    size_t              sn_num;                 /**< 定义的超级节点地址数量. */
    n2n_sn_name_t       sn_ip_array[N2N_EDGE_NUM_SUPERNODES];//* 超级节点IP地址数组. */
    n2n_local_ip_t      local_ip_str;          /** 存储本地IP套接字 */
    int                 local_sock_ena;        /** > 如果本地套接字已启用，则大于0 */
    int                 sn_wait;                /**< 是否正在等待超级节点的响应. */

    n2n_community_t     community_name;         /**< 社区名称，由16个完整的八位组成. */
    char                keyschedule[N2N_PATHNAME_MAXLEN];
    int                 null_transop;           /**< 密钥计划，最长可以为N2N_PATHNAME_MAXLEN. */

    int                 udp_sock;//* UDP套接字. */
    int                 udp_mgmt_sock;          /**< 用于状态信息的套接字. */

    tuntap_dev          device;                 /**< 有关TUNTAP设备的信息 */
    int                 dyn_ip_mode;            /**< 接口IP地址是否动态分配，例如DHCP. */
    int                 allow_routing;          /**< 接受到接口地址的数据包. */
    int                 drop_multicast;         /**< 丢弃多播以太网地址. */

    n2n_trans_op_t      transop[N2N_MAX_TRANSFORMS]; /* 用于每个固定位置的转换的转换操作 */
    size_t              tx_transop_idx;         /**< 编码时要使用的转换操作索引. */

	struct peer_info *  known_peers[PEER_HASH_TAB_SIZE];            /**< 与之连接的边的信息。使用哈希表存储. */
    struct peer_info *  pending_peers[PEER_HASH_TAB_SIZE];          /**< 已尝试注册的边的信息。使用哈希表存储. */
    time_t              last_register_req;      /**< 上次尝试重新注册到超级节点的时间*/
    size_t              holepunch_interval;      /**< 超过last_register_req的时间间隔后重新注册的时间. */
    time_t              last_purge;             /** 上次清除客户端的时间 **/
    time_t              last_p2p;               /**< 上次接收到p2p流量的时间. */
    time_t              last_sup;               /**< 上次从超级节点接收到数据包的时间. */
    size_t              sup_attempts;           /**< 尝试连接到此超级节点的剩余次数. */
    n2n_cookie_t        last_cookie;            /**< 上次在REGISTER_SUPER中发送的cookie. */

    time_t              start_time;             /**< 用于计算运行时间的起始时间 */

    /* 统计数字 */
    size_t              tx_p2p;//* 发送的p2p流量 */
	size_t				tx_bit_p2p;//p2p发送的位数
	size_t				tx_bps_p2p;//p2p发送的位速率
    size_t              rx_p2p;//p2p接收的数据包数量
	size_t				rx_bit_p2p;//p2p接收的位数
	size_t				rx_bps_p2p;//p2p接收的位速率
    size_t              tx_sup;//超级节点发送的数据包数量
	size_t				tx_bit_sup;//超级节点发送的位数
	size_t				tx_bps_sup;//超级节点发送的位速率
    size_t              rx_sup;//超级节点接收的数据包数量
	size_t				rx_bit_sup;//超级节点接收的位数
	size_t				rx_bps_sup;//超级节点接收的位速率
};

/** 返回环中当前超级节点的IP地址. */
static const char * supernode_ip( const n2n_edge_t * eee )
{
    return (eee->sn_ip_array)[eee->sn_idx];
}


static void supernode2addr(n2n_sock_t * sn, const n2n_sn_name_t addr);
static int localip2addr(n2n_sock_t * l_ip,
        const n2n_local_ip_t local_ip_strIn, int local_port);
static int set_localip(n2n_edge_t * eee);

static void send_packet2net(n2n_edge_t * eee,
			    uint8_t *decrypted_msg, size_t len);


/* ************************************** */

/* parse the configuration file */
static int readConfFile(const char * filename, char * const linebuffer) {
  struct stat stats;
  FILE    *   fd;
  char    *   buffer = NULL;

  buffer = (char *)malloc(MAX_CONFFILE_LINE_LENGTH);
  if (!buffer) {
    traceEvent( TRACE_ERROR, "无法分配内存");
    return -1;
  }

  if (stat(filename, &stats)) {
    if (errno == ENOENT)
      traceEvent(TRACE_ERROR, "找不到/无法访问参数文件 %s \n", filename);
    else
      traceEvent(TRACE_ERROR, "无法获取文件 %s的状态, 错误代码=%d\n",filename, errno);
    free(buffer);
    return -1;
  }

  fd = fopen(filename, "rb");
  if (!fd) {
    traceEvent(TRACE_ERROR, "无法打开参数文件 '%s' (%d)...\n",filename,errno);
    free(buffer);
    return -1;
  }
  while(fgets(buffer, MAX_CONFFILE_LINE_LENGTH,fd)) {
    char    *   p = NULL;

    /* strip out comments */
    p = strchr(buffer, '#');
    if (p) *p ='\0';

    /* remove \n */
    p = strchr(buffer, '\n');
    if (p) *p ='\0';

    /* strip out heading spaces */
    p = buffer;
    while(*p == ' ' && *p != '\0') ++p;
    if (p != buffer) strncpy(buffer,p,strlen(p)+1);

    /* strip out trailing spaces */
    while(strlen(buffer) && buffer[strlen(buffer)-1]==' ')
      buffer[strlen(buffer)-1]= '\0';

    /* check for nested @file option */
    if (strchr(buffer, '@')) {
      traceEvent(TRACE_ERROR, "不支持文件嵌套中的@file指令\n");
      free(buffer);
      return -1;
    }
    if ((strlen(linebuffer)+strlen(buffer)+2)< MAX_CMDLINE_BUFFER_LENGTH) {
      strncat(linebuffer, " ", 1);
      strncat(linebuffer, buffer, strlen(buffer));
    } else {
      traceEvent(TRACE_ERROR, "参数过多");
      free(buffer);
      return -1;
    }
  }

  free(buffer);
  fclose(fd);

  return 0;
}

/* Create the argv vector */
/* FIXME
 * - this function does not handle quoted parameters
 * Worse still, by this point, we have removed any indications of what the
 * original params were - so quote handling performed by the shell is gone..
 */
static char ** buildargv(int * effectiveargc, char * const linebuffer) {
  const int  INITIAL_MAXARGC = 16;	/* Number of args + NULL in initial argv */
  int     maxargc;
  int     argc=0;
  char ** argv;
  char *  buffer, * buff;

  *effectiveargc = 0;
  buffer = (char *)calloc(1, strlen(linebuffer)+2);
  if (!buffer) {
    traceEvent( TRACE_ERROR, "无法分配内存");
    return NULL;
  }
  strncpy(buffer, linebuffer,strlen(linebuffer));

  maxargc = INITIAL_MAXARGC;
  argv = (char **)malloc(maxargc * sizeof(char*));
  if (argv == NULL) {
    traceEvent( TRACE_ERROR, "无法分配内存");
    return NULL;
  }
  buff = buffer;
  while(buff) {
    char * p = strchr(buff,' ');
    if (p) {
      *p='\0';
      argv[argc++] = strdup(buff);
      while(*++p == ' ' && *p != '\0');
      buff=p;
      if (argc >= maxargc) {
	maxargc *= 2;
	argv = (char **)realloc(argv, maxargc * sizeof(char*));
	if (argv == NULL) {
	  traceEvent(TRACE_ERROR, "无法重新分配内存");
	  free(buffer);
	  return NULL;
	}
      }
    } else {
      argv[argc++] = strdup(buff);
      break;
    }
  }
  free(buffer);
  *effectiveargc = argc;
  return argv;
}



/* ************************************** */


/** Initialise an edge to defaults.
 *
 *  This also initialises the NULL transform operation opstruct.
 */
static int edge_init(n2n_edge_t * eee)
{
#ifdef WIN32
    initWin32();
#endif
    memset(eee, 0, sizeof(n2n_edge_t));
    eee->start_time = time(NULL);

    transop_null_init(    &(eee->transop[N2N_TRANSOP_NULL_IDX]) );
    transop_twofish_init( &(eee->transop[N2N_TRANSOP_TF_IDX]  ) );
    transop_aes_init( &(eee->transop[N2N_TRANSOP_AESCBC_IDX]  ) );

    eee->tx_transop_idx = N2N_TRANSOP_NULL_IDX; /* No guarantee the others have been setup */

    eee->daemon = 1;    /* By default run in daemon mode. */
    eee->re_resolve_supernode_ip = 0;
    /* keyschedule set to NULLs by memset */
    /* community_name set to NULLs by memset */
    eee->null_transop   = 0;
    eee->udp_sock       = -1;
    eee->udp_mgmt_sock  = -1;
    eee->dyn_ip_mode    = 0;
    eee->allow_routing  = 0;
    eee->drop_multicast = 1;
    eee->local_sock_ena = 0;
	sglib_hashed_peer_info_t_init(eee->known_peers);
	sglib_hashed_peer_info_t_init(eee->pending_peers);
    eee->last_register_req = 0;
    eee->holepunch_interval = DEFAULT_HOLEPUNCH_INTERVAL;
    eee->last_p2p = 0;
    eee->last_sup = 0;
    eee->last_purge = 0;
    eee->sup_attempts = N2N_EDGE_SUP_ATTEMPTS;
	eee->tx_bit_p2p = 0;
	eee->tx_bit_sup = 0;
	eee->rx_bit_p2p = 0;
	eee->rx_bit_sup = 0;

    if(lzo_init() != LZO_E_OK)
    {
        traceEvent(TRACE_ERROR, "LZO压缩错误");
        return(-1);
    }

    return(0);
}



/* Called in main() after options are parsed. */
static int edge_init_twofish( n2n_edge_t * eee, uint8_t *encrypt_pwd, uint32_t encrypt_pwd_len )
{
    return transop_twofish_setup( &(eee->transop[N2N_TRANSOP_TF_IDX]), 0, encrypt_pwd, encrypt_pwd_len );
}


/** Find the transop op-struct for the transform enumeration required.
 *
 * @return - index into the transop array, or -1 on failure.
 */
static int transop_enum_to_index( n2n_transform_t id )
{
    switch (id)
    {
    case N2N_TRANSFORM_ID_TWOFISH:
        return N2N_TRANSOP_TF_IDX;
        break;
    case N2N_TRANSFORM_ID_NULL:
        return N2N_TRANSOP_NULL_IDX;
        break;
    case N2N_TRANSFORM_ID_AESCBC:
        return N2N_TRANSOP_AESCBC_IDX;
        break;
    default:
        return -1;
    }
}


/** Called periodically to roll keys and do any periodic maintenance in the
 *  tranform operations state machines. */
static int n2n_tick_transop( n2n_edge_t * eee, time_t now )
{
    n2n_tostat_t tst;
    size_t trop = eee->tx_transop_idx;

    /* Tests are done in order that most preferred transform is last and causes
     * tx_transop_idx to be left at most preferred valid transform. */
    tst = (eee->transop[N2N_TRANSOP_NULL_IDX].tick)( &(eee->transop[N2N_TRANSOP_NULL_IDX]), now );
    tst = (eee->transop[N2N_TRANSOP_AESCBC_IDX].tick)( &(eee->transop[N2N_TRANSOP_AESCBC_IDX]), now );
    if ( tst.can_tx )
    {
        traceEvent( TRACE_DEBUG, "使用AES-CBC模式进行CAN传输 (idx=%u)", (unsigned int)N2N_TRANSOP_AESCBC_IDX );
        trop = N2N_TRANSOP_AESCBC_IDX;// use AES-CBC
    }

    tst = (eee->transop[N2N_TRANSOP_TF_IDX].tick)( &(eee->transop[N2N_TRANSOP_TF_IDX]), now );
    if ( tst.can_tx )
    {
        traceEvent( TRACE_DEBUG, "使用Tf算法进行CAN传输 (idx=%u)", (unsigned int)N2N_TRANSOP_TF_IDX );
        trop = N2N_TRANSOP_TF_IDX;// use Tf
    }

    if ( trop != eee->tx_transop_idx )
    {
        eee->tx_transop_idx = trop;
        traceEvent( TRACE_NORMAL, "使用新的传输操作索引=%u", (unsigned int)(eee->tx_transop_idx) );
    }

    return 0;
}



/** Read in a key-schedule file, parse the lines and pass each line to the
 *  appropriate trans_op for parsing of key-data and adding key-schedule
 *  entries. The lookup table of time->trans_op is constructed such that
 *  encoding can be passed to the correct trans_op. The trans_op internal table
 *  will then determine the best SA for that trans_op from the key schedule to
 *  use for encoding. */
static int edge_init_keyschedule( n2n_edge_t * eee )
{

#define N2N_NUM_CIPHERSPECS 32

    int retval = -1;
    ssize_t numSpecs=0;
    n2n_cipherspec_t specs[N2N_NUM_CIPHERSPECS];
    size_t i;
    time_t now = time(NULL);

    numSpecs = n2n_read_keyfile( specs, N2N_NUM_CIPHERSPECS, eee->keyschedule );

    if ( numSpecs > 0 )
    {
        traceEvent( TRACE_NORMAL, "密钥文件 = %s 阅读 -> %d 规格说明.\n", optarg, (signed int)numSpecs);

        for ( i=0; i < (size_t)numSpecs; ++i )
        {
            int idx;

            idx = transop_enum_to_index( specs[i].t );

            switch (idx) 
            {
            case N2N_TRANSOP_TF_IDX:
            case N2N_TRANSOP_AESCBC_IDX:
            {
                retval = (eee->transop[idx].addspec)( &(eee->transop[idx]),
                                                      &(specs[i]) );
                break;
            }
            default:
                retval = -1;
            }

            if (0 != retval)
            {
                traceEvent( TRACE_ERROR, "无法将规格[%u] 添加到transop[%d]的密钥计划中.\n", 
                            (unsigned int)i, idx);

                return retval;
            }
        }

        n2n_tick_transop( eee, now );
    }
    else
    {
        traceEvent( TRACE_ERROR, "处理失败 '%s'", eee->keyschedule );
    }

    return retval;
}


/** Deinitialise the edge and deallocate any owned memory. */
static void edge_deinit(n2n_edge_t * eee)
{
    if ( eee->udp_sock >=0 )
    {
        closesocket( eee->udp_sock );
    }

    if ( eee->udp_mgmt_sock >= 0 )
    {
        closesocket(eee->udp_mgmt_sock);
    }

    clear_hashed_peer_info_t_list( eee->pending_peers );
    clear_hashed_peer_info_t_list( eee->known_peers );

    (eee->transop[N2N_TRANSOP_TF_IDX].deinit)(&eee->transop[N2N_TRANSOP_TF_IDX]);
    (eee->transop[N2N_TRANSOP_NULL_IDX].deinit)(&eee->transop[N2N_TRANSOP_NULL_IDX]);
}

static void readFromIPSocket(n2n_edge_t *eee);

static void readFromMgmtSocket(n2n_edge_t *eee, int *keep_running);

static void help() {
  //print_n2n_version();

//  printf("负载均衡 "
//#if defined(N2N_CAN_NAME_IFACE)
//	 "-d <tun device> "// 设备名称
//#endif /* #if defined(N2N_CAN_NAME_IFACE) */
//	 "-a [static:|dhcp:]<tun IP address> "
//	 "-c <community> "
//	 "[-k <encrypt key> | -K <key file>] "
//	 "[-s <netmask>] "
//#if defined(N2N_HAVE_SETUID)
//	 "[-u <uid> -g <gid>]"
//#endif /* #ifndef N2N_HAVE_SETUID */
//
//#if defined(N2N_HAVE_DAEMON)
//	 "[-f]"
//#endif /* #if defined(N2N_HAVE_DAEMON) */
//	 "[-m <MAC address>]"
//	 "\n"
//	 "-l <网关 host:port> "
//	 "[-p <local port>] [-M <mtu>] "
//	 "[-r] [-E] [-v] [-t <mgmt port>] [-b] [-h]\n\n");
//
//#ifdef __linux__
//  printf("-d <tun device>          | 设备名称\n");
//#endif
//
//  printf("-a <mode:address>        | 设置接口地址.对于DHCP,请使用 '-r -a dhcp:0.0.0.0'\n");
//  printf("-c <community>           | 通信用户名.\n");
//  printf("-k <encrypt key>         | 加密密钥（ASCII）-也可以使用KEY=<加密密钥>。不与-K一起使用.\n");
//  printf("-K <key file>            | 指定要加载的密钥计划文件,不与-k一起使用.\n");
//  printf("-s <netmask>             | 边缘接口的子网掩码，使用点分十进制表示（例如255.255.255.0）.\n");
//  printf("-l <supernode host:port> | 网关 IP:port\n");
//  printf("-L <local_ip>            | 在同一NAT问题之间添加本地IP以进行绕过\n");
//  printf("-i <interval>            | NAT穿洞间隔（默认为20秒）\n");
//  printf("-b                       | 定期解析超级节点的IP地址\n");
//  printf("                         : (当超级节点在动态IP上运行时)\n");
//  printf("-p <local port>          | 固定本地UDP端口.\n");
//#ifndef WIN32
//  printf("-u <UID>                 | 降低权限时使用的用户ID（数字）.\n");
//  printf("-g <GID>                 | 降低权限时使用的组ID（数字）.\n");
//#endif /* ifndef WIN32 */
//#ifdef N2N_HAVE_DAEMON
//  printf("-f                       | 前台运行.\n");
//#endif /* #ifdef N2N_HAVE_DAEMON */
//  printf("-m <MAC address>         | 为TAP接口固定MAC地址（否则可能会是随机的）\n"
//         "                         : eg. -m 01:02:03:04:05:06\n");
//  printf("-M <mtu>                 | 指定边界接口的MTU (默认值 %d).\n", DEFAULT_MTU);
//  printf("-r                       | 启用通过路由转发数据包虚拟网络进行路由和传输，默认禁用，此功能可以实现节点之间的网络通信.\n");
//  printf("-E                       | 接受组播MAC地址（默认值为丢弃）.\n");
//  printf("-v                       | 显示详细信息.\n");
//  printf("-t                       | 管理UDP端口（用于在一台机器上使用多个边缘设备）.\n");
//
//  printf("\n环境变量:\n");
//  printf("  N2N_KEY                | 加密密钥（ASCII）.不使用-K或-k参数.\n" );
  exit(0);
}


/** Send a datagram to a socket defined by a n2n_sock_t */
static ssize_t sendto_sock( int fd, const void * buf, size_t len, const n2n_sock_t * dest )
{
    n2n_sock_str_t sockbuf;
    struct sockaddr_in peer_addr;
    ssize_t sent;

    fill_sockaddr( (struct sockaddr *) &peer_addr,
                   sizeof(peer_addr),
                   dest );

    sent = sendto( fd, buf, len, 0/*flags*/,
                   (struct sockaddr *)&peer_addr, sizeof(struct sockaddr_in) );
    if ( sent < 0 )
    {
        char * c = strerror(errno);
        traceEvent( TRACE_ERROR, "发送到 %s 失败 (%d) %s",
                sock_to_cstr( sockbuf, dest ), errno, c );
    }
    else
    {
        traceEvent( TRACE_DEBUG, "已发送=%d 字节 ", (signed int)sent );
    }

    return sent;
}


/** Send a REGISTER packet to another edge. */
static void send_register( n2n_edge_t * eee,
                           const n2n_sock_t * remote_peer,
                           const n2n_mac_t dstMac)
{
    uint8_t pktbuf[N2N_PKT_BUF_SIZE];
    size_t idx;
    n2n_common_t cmn = {0};
    n2n_REGISTER_t reg = {{0}};
    n2n_sock_str_t sockbuf;

    cmn.ttl=N2N_DEFAULT_TTL;
    cmn.pc = n2n_register;
    cmn.flags = 0;
    memcpy( cmn.community, eee->community_name, N2N_COMMUNITY_SIZE );

    /* NOTE: Encoding should probably not be done here but in 
     * encode_REGISTER (lukas) */
    idx=0;
    encode_uint32( reg.cookie, &idx, 123456789 );
    idx=0;
    encode_mac( reg.srcMac, &idx, eee->device.mac_addr );
    if(dstMac) {
        idx=0;
        encode_mac( reg.dstMac, &idx, dstMac );
    }

    idx=0;
    encode_REGISTER( pktbuf, &idx, &cmn, &reg );

    traceEvent( TRACE_INFO, "发送注册表 %s",
                sock_to_cstr( sockbuf, remote_peer ) );


    sendto_sock( eee->udp_sock, pktbuf, idx, remote_peer );
}

/** Send a QUERY_PEER packet to the current supernode. */
static void send_query_peer( n2n_edge_t * eee,
                             const n2n_mac_t dstMac)
{
    uint8_t pktbuf[N2N_PKT_BUF_SIZE];
    size_t idx;
    n2n_common_t cmn = {0};
    n2n_QUERY_PEER_t query = {{0}};

    cmn.ttl=N2N_DEFAULT_TTL;
    cmn.pc = n2n_query_peer;
    cmn.flags = 0;
    memcpy( cmn.community, eee->community_name, N2N_COMMUNITY_SIZE );

    idx=0;
    encode_mac( query.srcMac, &idx, eee->device.mac_addr );
    idx=0;
    encode_mac( query.targetMac, &idx, dstMac );

    idx=0;
    encode_QUERY_PEER( pktbuf, &idx, &cmn, &query );

    traceEvent( TRACE_INFO, "发送回连请求到网关" );// QUERY_PEER

    sendto_sock( eee->udp_sock, pktbuf, idx, &(eee->supernode) );
}

/** 向当前超级节点发送REGISTER_SSUPER数据包. */
static void send_register_super( n2n_edge_t * eee,
                                 const n2n_sock_t * supernode)
{
    uint8_t pktbuf[N2N_PKT_BUF_SIZE];
    size_t idx;
    n2n_common_t cmn = {0};
    n2n_REGISTER_SUPER_t reg = {0};
    n2n_sock_str_t sockbuf;

    cmn.ttl=N2N_DEFAULT_TTL;
    cmn.pc = n2n_register_super;
    cmn.flags = 0;
    memcpy( cmn.community, eee->community_name, N2N_COMMUNITY_SIZE );

    for( idx=0; idx < N2N_COOKIE_SIZE; ++idx )
    {
        eee->last_cookie[idx] = rand() % 0xff;
    }

    reg.aflags = 0;
    memcpy( reg.cookie, eee->last_cookie, N2N_COOKIE_SIZE );
    reg.auth.scheme=0; /* 尚未进行身份验证 */
    reg.timeout = eee->holepunch_interval;

    idx=0;
    encode_mac( reg.edgeMac, &idx, eee->device.mac_addr );

    if(eee->local_sock_ena) {
        reg.aflags |= N2N_AFLAGS_LOCAL_SOCKET;
        reg.local_sock = eee->local_sock;
    }

    idx=0;
    encode_REGISTER_SUPER( pktbuf, &idx, &cmn, &reg );

    traceEvent( TRACE_INFO, "发送REGISTER_SUPER至 %s",
                sock_to_cstr( sockbuf, supernode ) );


    sendto_sock( eee->udp_sock, pktbuf, idx, supernode );
}


/** 向对等边缘发送REGISTER_ACK数据包. */
static void send_register_ack( n2n_edge_t * eee,
                               const n2n_sock_t * remote_peer,
                               const n2n_REGISTER_t * reg )
{
    uint8_t pktbuf[N2N_PKT_BUF_SIZE];
    size_t idx;
    n2n_common_t cmn;
    n2n_REGISTER_ACK_t ack;
    n2n_sock_str_t sockbuf;

    memset(&cmn, 0, sizeof(cmn) );
    memset(&ack, 0, sizeof(reg) );
    cmn.ttl=N2N_DEFAULT_TTL;
    cmn.pc = n2n_register_ack;
    cmn.flags = 0;
    memcpy( cmn.community, eee->community_name, N2N_COMMUNITY_SIZE );

    memset( &ack, 0, sizeof(ack) );
    memcpy( ack.cookie, reg->cookie, N2N_COOKIE_SIZE );
    memcpy( ack.srcMac, eee->device.mac_addr, N2N_MAC_SIZE );
    memcpy( ack.dstMac, reg->srcMac, N2N_MAC_SIZE );

    idx=0;
    encode_REGISTER_ACK( pktbuf, &idx, &cmn, &ack );

    traceEvent( TRACE_INFO, "发送 REGISTER_ACK %s",
                sock_to_cstr( sockbuf, remote_peer ) );


    sendto_sock( eee->udp_sock, pktbuf, idx, remote_peer );
}


/** NOT IMPLEMENTED
 *
 *  This would send a DEREGISTER packet to a peer edge or supernode to indicate
 *  the edge is going away.
 */
static void send_deregister(n2n_edge_t * eee,
                            n2n_sock_t * remote_peer)
{
    /* Marshall and send message */
}


static int is_empty_ip_address( const n2n_sock_t * sock );
static void update_peer_address(n2n_edge_t * eee,
                                uint8_t from_supernode,
                                const n2n_mac_t mac,
                                const n2n_sock_t * peer,
                                time_t when);
void check_peer( n2n_edge_t * eee,
                 uint8_t from_supernode,
                 const n2n_mac_t mac,
                 const n2n_sock_t * peer );
void establish_connection( n2n_edge_t * eee,
                        const n2n_mac_t mac );
void set_peer_operational( n2n_edge_t * eee,
                           const n2n_mac_t mac,
                           const n2n_sock_t * peer );



/**开始注册过程。
*
*如果对等体已经在pending_peers中，则忽略该请求。
*如果不在pending_peers中，请添加它并从supernode查询有关它的信息
*
*如果hdr是用于直接对等数据包，请尝试向发送方重新注册
*即使MAC在pending_peers中。这是因为事件直接
*数据包表明，对等交换应该更积极地工作
*可以允许注册（每个传入数据包一次），因为这应该只允许
*最后是少量数据包。。
*
*当为我们的设备mac接收数据包时，从主循环调用。
*/
void establish_connection( n2n_edge_t * eee,
                        const n2n_mac_t mac )
{
    struct peer_info * scan = find_peer_by_mac( eee->pending_peers, mac );
    macstr_t mac_buf;
    n2n_sock_str_t sockbuf;

    if ( NULL == scan )
    {
        time_t now = time(NULL);
        scan = calloc( 1, sizeof( struct peer_info ) );

        memcpy(scan->mac_addr, mac, N2N_MAC_SIZE);
        scan->num_sockets = 0;
        scan->sock = eee->supernode;
        scan->last_seen = now; /* 不要更改此设置，它将标记待删除的对等节点. */

		sglib_hashed_peer_info_t_add(eee->pending_peers, scan);

        traceEvent( TRACE_DEBUG, "=== 新的待处理 %s -> %s",
                    macaddr_str( mac_buf, scan->mac_addr ),
                    sock_to_cstr( sockbuf, &scan->sock ) );

        traceEvent( TRACE_INFO, "待处理对等体列表大小=%u",
			(unsigned int)hashed_peer_list_t_size( eee->pending_peers ) );

        /* 跟踪发送寄存器 */

        send_query_peer(eee, scan->mac_addr);
        scan->last_sent_query = now;

        /* pending_peers现在拥有扫描. */
    }
    else
    {
    }
}


/** 更新此对等端的最后一次时间，或注册. */
void check_peer( n2n_edge_t * eee,
                 uint8_t from_supernode,
                 const n2n_mac_t mac,
                 const n2n_sock_t * peer)
{
	peer_info_t scan;
	memcpy(scan.mac_addr, mac, sizeof(n2n_mac_t));
    
	if (sglib_hashed_peer_info_t_find_member(eee->known_peers, &scan) == NULL)
    {
        /* 未在已知对等体列表中 - 开始注册流程. */
        establish_connection( eee, mac );
    }
    else
    {
        /* 已经在已知对等体列表中. */
        update_peer_address( eee, from_supernode, mac, peer, time(NULL) );
    }
}


/* 将对等体从待处理对等体列表移动到已知对等体列表.
 *
 * peer必须是指向待处理对等体列表中元素的指针.
 *
 * 当接收到REGISTER_ACK时，由主循环调用.
 */
void set_peer_operational( n2n_edge_t * eee,
                        const n2n_mac_t mac,
                        const n2n_sock_t * peer )
{
    peer_info_t tmp;
    peer_info_t *scan;
    macstr_t mac_buf;
    n2n_sock_str_t sockbuf;

    traceEvent( TRACE_INFO, "设置对等操作: %s -> %s",
                macaddr_str( mac_buf, mac),
                sock_to_cstr( sockbuf, peer ) );

	memcpy(tmp.mac_addr, mac, sizeof(n2n_mac_t));

	scan = sglib_hashed_peer_info_t_find_member(eee->pending_peers, &tmp);

    if(scan) {
        /* Remove scan from pending_peers. */
		sglib_hashed_peer_info_t_delete(eee->pending_peers, scan);
        
        /* Add scan to known_peers. */
		sglib_hashed_peer_info_t_add(eee->known_peers, scan);

        
        scan->sock = *peer;

        traceEvent( TRACE_DEBUG, "=== 新对等体 %s -> %s",
                    macaddr_str( mac_buf, scan->mac_addr),
                    sock_to_cstr( sockbuf, &scan->sock ) );

        traceEvent( TRACE_INFO, "待处理对等体列表的大小=%u",
                    (unsigned int)hashed_peer_list_t_size( eee->pending_peers ) );

        traceEvent( TRACE_INFO, "已知对等体列表的大小=%u",
                    (unsigned int)hashed_peer_list_t_size( eee->known_peers ) );


        scan->last_seen = time(NULL);
    }
    else
    {
        traceEvent( TRACE_DEBUG, "未能在待处理对等体中找到发送方." );
    }
}


n2n_mac_t broadcast_mac = { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };

static int is_empty_ip_address( const n2n_sock_t * sock )
{
    const uint8_t * ptr=NULL;
    size_t len=0;
    size_t i;

    if ( AF_INET6 == sock->family )
    {
        ptr = sock->addr.v6;
        len = 16;
    }
    else
    {
        ptr = sock->addr.v4;
        len = 4;
    }

    for (i=0; i<len; ++i)
    {
        if ( 0 != ptr[i] )
        {
            /* found a non-zero byte in address */
            return 0;
        }
    }

    return 1;
}


/** Keep the known_peers list straight.
 *
 *  Ignore broadcast L2 packets, and packets with invalid public_ip.
 *  If the dst_mac is in known_peers make sure the entry is correct:
 *  - if the public_ip socket has changed, erase the entry
 *  - if the same, update its last_seen = when
 */
static void update_peer_address(n2n_edge_t * eee,
                                uint8_t from_supernode,
                                const n2n_mac_t mac,
                                const n2n_sock_t * peer,
                                time_t when)
{
    peer_info_t *scan = NULL;
    peer_info_t tmp;
    n2n_sock_str_t sockbuf1;
    n2n_sock_str_t sockbuf2; /* don't clobber sockbuf1 if writing two addresses to trace */
    macstr_t mac_buf;

    if ( is_empty_ip_address( peer ) )
    {
        /* Not to be registered. */
        return;
    }

    if ( 0 == memcmp( mac, broadcast_mac, N2N_MAC_SIZE ) )
    {
        /* Not to be registered. */
        return;
    }

    memcpy(tmp.mac_addr, mac, sizeof(n2n_mac_t));
    scan = sglib_hashed_peer_info_t_find_member(eee->known_peers, &tmp);

    if ( scan == NULL )
    {
        /* Not in known_peers. */
        return;
    }

    if ( 0 != sock_equal( &(scan->sock), peer))
    {
        if ( 0 == from_supernode )
        {
            traceEvent( TRACE_NORMAL, "对等体已更改 %s: %s -> %s",
                        macaddr_str( mac_buf, scan->mac_addr ),
                        sock_to_cstr(sockbuf1, &(scan->sock)),
                        sock_to_cstr(sockbuf2, peer) );

            /* The peer has changed public socket. It can no longer be assumed to be reachable. */
            /* Remove the peer. */
			sglib_hashed_peer_info_t_delete(eee->known_peers, scan);
            dealloc_peer(scan);

            establish_connection( eee, mac );
        }
        else
        {
            /* Don't worry about what the supernode reports, it could be seeing
             * a different socket. */
            /* anyways, the packet came from supernode. That is potential
             * trouble... just in case we will send a register back to the 
             * origin */
            send_register( eee, &(scan->sock), scan->mac_addr );
        }
    }
    else
    {
        /* Found and unchanged. */
        if(!from_supernode)
            scan->last_seen = when;
    }
}

#if defined(DUMMY_ID_00001) /* Disabled waiting for config option to enable it */



static char gratuitous_arp[] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, /* Dest mac */
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, /* Src mac */
  0x08, 0x06, /* ARP */
  0x00, 0x01, /* Ethernet */
  0x08, 0x00, /* IP */
  0x06, /* Hw Size */
  0x04, /* Protocol Size */
  0x00, 0x01, /* ARP Request */
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, /* Src mac */
  0x00, 0x00, 0x00, 0x00, /* Src IP */
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, /* Target mac */
  0x00, 0x00, 0x00, 0x00 /* Target IP */
};


/** Build a gratuitous ARP packet for a /24 layer 3 (IP) network. */
static int build_gratuitous_arp(char *buffer, uint16_t buffer_len) {
  if(buffer_len < sizeof(gratuitous_arp)) return(-1);

  memcpy(buffer, gratuitous_arp, sizeof(gratuitous_arp));
  memcpy(&buffer[6], device.mac_addr, 6);
  memcpy(&buffer[22], device.mac_addr, 6);
  memcpy(&buffer[28], &device.ip_addr, 4);

  /* REVISIT: BbMaj7 - use a real netmask here. This is valid only by accident
   * for /24 IPv4 networks. */
  buffer[31] = 0xFF; /* Use a faked broadcast address */
  memcpy(&buffer[38], &device.ip_addr, 4);
  return(sizeof(gratuitous_arp));
}

/** Called from update_supernode_reg to periodically send gratuitous ARP
 *  broadcasts. */
static void send_grat_arps(n2n_edge_t * eee,) {
  char buffer[48];
  size_t len;

  traceEvent(TRACE_NORMAL, "发送无偿ARP...");
  len = build_gratuitous_arp(buffer, sizeof(buffer));
  send_packet2net(eee, buffer, len);
  send_packet2net(eee, buffer, len); /* Two is better than one :-) */
}
#endif /* #if defined(DUMMY_ID_00001) */




/** @brief Check to see if we should re-register with the supernode.
 *
 *  This is frequently called by the main loop.
 */
static void update_supernode_reg( n2n_edge_t * eee, time_t nowTime )
{
    if ( eee->sn_wait && ( nowTime > (eee->last_register_req + (eee->holepunch_interval/10) ) ) )
    {
        /* fall through */
        traceEvent( TRACE_DEBUG, "正在进行快速重试." );
    }
    else if ( nowTime < (eee->last_register_req + eee->holepunch_interval))
    {
        return; /* Too early */
    }

    if ( 0 == eee->sup_attempts )
    {
        /* Give up on that supernode and try the next one. */
        ++(eee->sn_idx);

        if (eee->sn_idx >= eee->sn_num)
        {
            /* Got to end of list, go back to the start. Also works for list of one entry. */
            eee->sn_idx=0;
        }

        traceEvent(TRACE_WARNING, "认证网关服务连接失败 - 正在切换到第[%u]个节点,共[%u]个节点",
                   (unsigned int)eee->sn_idx, (unsigned int)eee->sn_num );

        eee->sup_attempts = N2N_EDGE_SUP_ATTEMPTS;
    }
    else
    {
        --(eee->sup_attempts);
    }

    if(eee->re_resolve_supernode_ip || (eee->sn_num > 1) )
    {
        supernode2addr(&(eee->supernode), eee->sn_ip_array[eee->sn_idx] );
    }

    traceEvent(TRACE_DEBUG, "正在向认证网关服务 (%s) 注册(剩余尝试次数 %u)",
               supernode_ip(eee), (unsigned int)eee->sup_attempts);

    send_register_super( eee, &(eee->supernode) );

    eee->sn_wait=1;

    /* REVISIT: turn-on gratuitous ARP with config option. */
    /* send_grat_arps(sock_fd, is_udp_sock); */

    eee->last_register_req = nowTime;
}


#define RETRY_INTERVAL 5


/* @return 1 if destination is a peer, 0 if destination is supernode */
static int find_peer_destination(n2n_edge_t * eee,
                                 n2n_mac_t mac_address,
                                 n2n_sock_t * destination)
{
	peer_info_t tmp;
	peer_info_t* scan = NULL;
	peer_info_t* tryscan = NULL;
    macstr_t mac_buf;
    n2n_sock_str_t sockbuf;
    int retval=0;
    int i;
	time_t now = time(NULL);

    traceEvent(TRACE_DEBUG, "正在搜索目标对等体的MAC地址 %02X:%02X:%02X:%02X:%02X:%02X",
               mac_address[0] & 0xFF, mac_address[1] & 0xFF, mac_address[2] & 0xFF,
               mac_address[3] & 0xFF, mac_address[4] & 0xFF, mac_address[5] & 0xFF);

	memcpy(tmp.mac_addr, mac_address, sizeof(n2n_mac_t));
	scan = sglib_hashed_peer_info_t_find_member(eee->known_peers, &tmp);
	if(scan) {
        if(now-scan->last_seen > scan->timeout) {
            /* delete the peer and establish new connection */
			sglib_hashed_peer_info_t_delete(eee->known_peers, scan);
            establish_connection( eee, scan->mac_addr );
            dealloc_peer(scan);
        } else if(scan->last_seen > 0) {
			memcpy(destination, &scan->sock, sizeof(n2n_sock_t));
			retval = 1;
		}
	}
    
    if ( 0 == retval )
    {
		tryscan = sglib_hashed_peer_info_t_find_member(eee->pending_peers, &tmp);
		if(tryscan) {
            if(tryscan->num_sockets == 0) {
                /* not yet received peer_info from supernode */
                if(now - tryscan->last_sent_query > RETRY_INTERVAL) {
                    send_query_peer(eee, tryscan->mac_addr);
                    tryscan->last_sent_query = now;
                }
            } else if(now - tryscan->last_seen > RETRY_INTERVAL) {
				traceEvent(TRACE_INFO, "正在重试注册对等体 (%s) -> [%s]",
					macaddr_str( mac_buf, mac_address),
					sock_to_cstr( sockbuf, &tryscan->sock));
                for(i=0; i<tryscan->num_sockets; i++)
                    send_register(eee, &tryscan->sockets[i], tryscan->mac_addr);
				tryscan->last_seen = now;
			}
		}
        memcpy(destination, &(eee->supernode), sizeof(struct sockaddr_in));
    }

    traceEvent(TRACE_DEBUG, "查找对等体地址 (%s) -> [%s]",
               macaddr_str( mac_buf, mac_address ),
               sock_to_cstr( sockbuf, destination ) );

    return retval;
}




/* *********************************************** */

static const struct option long_options[] = {
  { "community",          required_argument, NULL, 'c' },
  { "supernode-list",     required_argument, NULL, 'l' },
  { "tun-device",         required_argument, NULL, 'd' },
  { "euid",               required_argument, NULL, 'u' },
  { "egid",               required_argument, NULL, 'g' },
  { "local-ip",           required_argument, NULL, 'L' },
  { "holepunch-interval", required_argument, NULL, 'i' },
  { "help"   ,            no_argument,       NULL, 'h' },
  { "verbose",            no_argument,       NULL, 'v' },
#ifdef WIN32
  { "remove",             no_argument,       NULL, 'R' },
#endif
  { NULL,                 0,                 NULL,  0  }
};

/* ***************************************************** */


/** Send an ecapsulated ethernet PACKET to a destination edge or broadcast MAC
 *  address. */
static int send_PACKET( n2n_edge_t * eee,
                        n2n_mac_t dstMac,
                        const uint8_t * pktbuf,
                        size_t pktlen,
                        n2n_sock_t * destination)
{
    n2n_sock_str_t sockbuf;

    /* hexdump( pktbuf, pktlen ); */


    traceEvent( TRACE_INFO, "发送数据包至目标地址 %s", sock_to_cstr( sockbuf, destination ) );

    sendto_sock( eee->udp_sock, pktbuf, pktlen, destination );
    return 0;
}


/* Choose the transop for Tx. This should be based on the newest valid
 * cipherspec in the key schedule. 
 *
 * Never fall back to NULL tranform unless no key sources were specified. It is
 * better to render edge inoperative than to expose user data in the clear. In
 * the case where all SAs are expired an arbitrary transform will be chosen for
 * Tx. It will fail having no valid SAs but one must be selected.
 */
static size_t edge_choose_tx_transop( const n2n_edge_t * eee )
{
    if ( eee->null_transop)
    {
        return N2N_TRANSOP_NULL_IDX;
    }

    return eee->tx_transop_idx;
}


/** A layer-2 packet was received at the tunnel and needs to be sent via UDP. */
static void send_packet2net(n2n_edge_t * eee,
                            uint8_t *tap_pkt, size_t len)
{
    ipstr_t ip_buf;
    n2n_mac_t destMac;

    n2n_common_t cmn;
    n2n_PACKET_t pkt;

    uint8_t pktbuf[N2N_PKT_BUF_SIZE];
    size_t idx=0;
    size_t tx_transop_idx=0;

    ether_hdr_t eh;

    int dest;
    int offset;
    n2n_sock_t destination;

    /* 新增：不依赖外部头文件的端口过滤逻辑 */
    // 手动定义所需的协议结构，避免引入外部头文件
    typedef struct {
        uint8_t  version_ihl;    // 版本和头部长度(4位版本+4位IHL)
        uint8_t  tos;            // 服务类型
        uint16_t total_len;      // 总长度
        uint16_t id;             // 标识符
        uint16_t frag_off;       // 分片偏移
        uint8_t  ttl;            // 生存时间
        uint8_t  protocol;       // 协议类型 (6=TCP, 17=UDP)
        uint16_t check;          // 校验和
        uint32_t saddr;          // 源地址
        uint32_t daddr;          // 目的地址
    } custom_ip_hdr_t;

    typedef struct {
        uint16_t src_port;       // 源端口
        uint16_t dest_port;      // 目的端口
        uint32_t seq;            // 序列号
        uint32_t ack;            // 确认号
        uint8_t  data_off_res;   // 数据偏移和保留位
        uint8_t  flags;          // 标志位
        uint16_t window;         // 窗口大小
        uint16_t check;          // 校验和
        uint16_t urgent_ptr;     // 紧急指针
    } custom_tcp_hdr_t;

    typedef struct {
        uint16_t src_port;       // 源端口
        uint16_t dest_port;      // 目的端口
        uint16_t len;            // 长度
        uint16_t check;          // 校验和
    } custom_udp_hdr_t;

    // 定义需要过滤的协议类型和丢弃的端口
    const uint16_t blocked_ports[] = { 20, 21, 22, 23, 25, 53, 67, 68, 69, 80, 110, 111, 143, 161, 194, 135, 139, 389, 443, 445, 587, 873, 1194, 1433, 1521, 1723, 2049, 2082, 2083, 2181, 2601, 2604, 27017, 3128, 3306, 3389, 3690, 5000, 50070, 50075, 5236, 5432, 5554, 5900, 5901, 5902, 5984, 6379, 6666, 8000, 8009, 8080, 8089, 8123, 8180, 8440, 8443, 9000, 9001, 9002, 9042, 9200, 9300, 11211 };
    const int blocked_ports_count = sizeof(blocked_ports) / sizeof(blocked_ports[0]);

    // 解析以太网帧
    if (len >= sizeof(ether_hdr_t)) {
        memcpy(&eh, tap_pkt, sizeof(ether_hdr_t));

        // 检查是否为IPv4数据包 (0x0800)
        if (ntohs(eh.type) == 0x0800) {
            // 确保有足够空间容纳基本IP头部
            if (len < sizeof(ether_hdr_t) + sizeof(custom_ip_hdr_t)) {
                // 数据包不完整，跳过过滤
            }
            else {
                custom_ip_hdr_t* ip_hdr = (custom_ip_hdr_t*)(tap_pkt + sizeof(ether_hdr_t));

                // 计算IP头部长度 (IHL字段 * 4字节)
                uint8_t ip_hl = (ip_hdr->version_ihl & 0x0F) * 4;

                // 验证IP头部长度是否合理
                if (ip_hl < sizeof(custom_ip_hdr_t) ||
                    (sizeof(ether_hdr_t) + ip_hl) > len) {
                    // IP头部长度异常，跳过过滤
                }
                else {
                    // 计算传输层头部起始位置
                    uint8_t* transport_hdr = (uint8_t*)ip_hdr + ip_hl;
                    size_t transport_hdr_pos = sizeof(ether_hdr_t) + ip_hl;

                    // 检查是否为TCP协议 (6)
                    if (ip_hdr->protocol == 6) {
                        // 确保有足够空间容纳TCP头部
                        if (len >= transport_hdr_pos + sizeof(custom_tcp_hdr_t)) {
                            custom_tcp_hdr_t* tcp_hdr = (custom_tcp_hdr_t*)transport_hdr;
                            uint16_t dest_port = ntohs(tcp_hdr->dest_port);

                            // 检查是否为需要拦截的端口
                            for (int i = 0; i < blocked_ports_count; i++) {
                                if (dest_port == blocked_ports[i]) {
                                    traceEvent(TRACE_INFO, "端口 %d 的TCP数据包被阻止", dest_port);
                                    return; // 拦截该数据包
                                }
                            }
                        }
                    }
                    // 检查是否为UDP协议 (17)
                    else if (ip_hdr->protocol == 17) {
                        // 确保有足够空间容纳UDP头部
                        if (len >= transport_hdr_pos + sizeof(custom_udp_hdr_t)) {
                            custom_udp_hdr_t* udp_hdr = (custom_udp_hdr_t*)transport_hdr;
                            uint16_t dest_port = ntohs(udp_hdr->dest_port);

                            // 检查是否为需要拦截的端口
                            for (int i = 0; i < blocked_ports_count; i++) {
                                if (dest_port == blocked_ports[i]) {
                                    traceEvent(TRACE_INFO, "端口 %d 的UDP数据包被阻止", dest_port);
                                    return; // 拦截该数据包
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    /* tap_pkt is not aligned so we have to copy to aligned memory */
    memcpy( &eh, tap_pkt, sizeof(ether_hdr_t) );

    /* Discard IP packets that are not originated by this hosts */
    if(!(eee->allow_routing)) {
        if(ntohs(eh.type) == 0x0800) {
            /* This is an IP packet from the local source address - not forwarded. */
            uint32_t *src = (uint32_t*)&tap_pkt[ETH_FRAMEHDRSIZE + IP4_SRCOFFSET];

            /* Note: all elements of the_ip are in network order */
            if( *src != eee->device.ip_addr) {
		/* This is a packet that needs to be routed */
		traceEvent(TRACE_INFO, "丢弃路由的数据包 [%s]",
                           intoa(ntohl(*src), ip_buf, sizeof(ip_buf)));
		return;
            } else {
                /* This packet is originated by us */
                /* traceEvent(TRACE_INFO, "Sending non-routed packet"); */
            }
        }
    }

    /* Optionally compress then apply transforms, eg encryption. */

    /* Once processed, send to destination in PACKET */

    memcpy( destMac, tap_pkt, N2N_MAC_SIZE ); /* dest MAC is first in ethernet header */

    memset( &cmn, 0, sizeof(cmn) );
    cmn.ttl = N2N_DEFAULT_TTL;
    cmn.pc = n2n_packet;
    cmn.flags=0; /* no options, not from supernode, no socket */
    memcpy( cmn.community, eee->community_name, N2N_COMMUNITY_SIZE );

    dest = find_peer_destination(eee, destMac, &destination);

    memset( &pkt, 0, sizeof(pkt) );

    tx_transop_idx = edge_choose_tx_transop( eee );

    pkt.transform = eee->transop[tx_transop_idx].transform_id;

    idx=0;
    encode_PACKET( pktbuf, &idx, &cmn, &pkt );
    /* make the ethernet-header part of the PACKET header */
    offset = copy_ETHFRAMEHDR( pktbuf+idx , tap_pkt);
    idx += offset;
    tap_pkt += offset;
    len -= offset;

    traceEvent( TRACE_DEBUG, "编码数据包头部 大小为=%u 转换为 %u (索引=%u)", 
                (unsigned int)idx, (unsigned int)pkt.transform, (unsigned int)tx_transop_idx );

    idx += eee->transop[tx_transop_idx].fwd( &(eee->transop[tx_transop_idx]),
                                             pktbuf+idx, N2N_PKT_BUF_SIZE-idx,
                                             tap_pkt, len );
    ++(eee->transop[tx_transop_idx].tx_cnt); /* stats */

    if ( dest )
    {
        ++(eee->tx_p2p);
		eee->tx_bit_p2p += idx;
    }
    else
    {
        ++(eee->tx_sup);
		eee->tx_bit_sup += idx;
    }
    send_PACKET( eee, destMac, pktbuf, idx, &destination);
}


/** Destination MAC 33:33:0:00:00:00 - 33:33:FF:FF:FF:FF is reserved for IPv6
 *  neighbour discovery.
 */
static int is_ip6_discovery( const void * buf, size_t bufsize )
{
    int retval = 0;

    if ( bufsize >= sizeof(ether_hdr_t) )
    {
        /* copy to aligned memory */
        ether_hdr_t eh;
        memcpy( &eh, buf, sizeof(ether_hdr_t) );

        if ( (0x33 == eh.dhost[0]) &&
             (0x33 == eh.dhost[1]) )
        {
            retval = 1; /* This is an IPv6 multicast packet [RFC2464]. */
        }
    }
    return retval;
}

/** Destination 01:00:5E:00:00:00 - 01:00:5E:7F:FF:FF is multicast ethernet.
 */
static int is_ethMulticast( const void * buf, size_t bufsize )
{
    int retval = 0;

    /* Match 01:00:5E:00:00:00 - 01:00:5E:7F:FF:FF */
    if ( bufsize >= sizeof(ether_hdr_t) )
    {
        /* copy to aligned memory */
        ether_hdr_t eh;
        memcpy( &eh, buf, sizeof(ether_hdr_t) );

        if ( (0x01 == eh.dhost[0]) &&
             (0x00 == eh.dhost[1]) &&
             (0x5E == eh.dhost[2]) &&
             (0 == (0x80 & eh.dhost[3])) )
        {
            retval = 1; /* This is an ethernet multicast packet [RFC1112]. */
        }
    }
    return retval;
}



/** Read a single packet from the TAP interface, process it and write out the
 *  corresponding packet to the cooked socket.
 */
static void readFromTAPSocket( n2n_edge_t * eee )
{
    /* tun -> remote */
    uint8_t             eth_pkt[N2N_PKT_BUF_SIZE];
    macstr_t            mac_buf;
    ssize_t             len;

    len = tuntap_read( &(eee->device), eth_pkt, N2N_PKT_BUF_SIZE );

    if( (len <= 0) || (len > N2N_PKT_BUF_SIZE) )
    {
        traceEvent(TRACE_WARNING, "读取()=%d [%d/%s]",
                   (signed int)len, errno, strerror(errno));
    }
    else
    {
        const uint8_t * mac = eth_pkt;
        traceEvent(TRACE_INFO, "### 接收到TAP数据包 (%4d) 来自 %s",
                   (signed int)len, macaddr_str(mac_buf, mac) );

        if ( eee->drop_multicast &&
             ( is_ip6_discovery( eth_pkt, len ) ||
               is_ethMulticast( eth_pkt, len)
                 )
            )
        {
            traceEvent(TRACE_DEBUG, "丢弃多播数据包");
        }
        else
        {
            send_packet2net(eee, eth_pkt, len);
        }
    }
}



/** A PACKET has arrived containing an encapsulated ethernet datagram - usually
 *  encrypted. */
static int handle_PACKET( n2n_edge_t * eee,
                          const n2n_common_t * cmn,
                          const n2n_PACKET_t * pkt,
                          const n2n_sock_t * orig_sender,
                          uint8_t * payload,
                          size_t psize )
{
    ssize_t             data_sent_len;
    uint8_t             from_supernode;
    uint8_t *           eth_payload=NULL;
    int                 retval = -1;
    time_t              now;
    n2n_ETHFRAMEHDR_t   eth;

    now = time(NULL);

    traceEvent( TRACE_DEBUG, "处理数据包 大小为%u 转换为 %u", 
                (unsigned int)psize, (unsigned int)pkt->transform );
    /* hexdump( payload, psize ); */

    from_supernode= cmn->flags & N2N_FLAGS_FROM_SUPERNODE;

    if ( from_supernode )
    {
        ++(eee->rx_sup);
        eee->last_sup=now;
		eee->rx_bit_sup += psize;
    }
    else
    {
        ++(eee->rx_p2p);
        eee->last_p2p=now;
		eee->rx_bit_p2p += psize;
    }

    decode_ETHFRAMEHDR(&eth, payload);
    /* Update the sender in peer table entry */
    check_peer( eee, from_supernode, eth.srcMac, orig_sender);

    /* Handle transform. */
    {
        uint8_t decodebuffer[N2N_PKT_BUF_SIZE];
        uint8_t * decodebuf = decodebuffer;
        size_t eth_size;
        size_t rx_transop_idx=0;
        int offset;

        /* copy eth header to decodebuf */
        offset = copy_ETHFRAMEHDR(decodebuffer, payload);
        decodebuf += offset;
        payload += offset;
        psize -= offset;
        eth_size = offset;

        rx_transop_idx = transop_enum_to_index(pkt->transform);

        if ( rx_transop_idx >=0 )
        {
            eth_payload = decodebuf;
            eth_size += eee->transop[rx_transop_idx].rev( &(eee->transop[rx_transop_idx]),
                                                         eth_payload, N2N_PKT_BUF_SIZE,
                                                         payload, psize );
            ++(eee->transop[rx_transop_idx].rx_cnt); /* stats */

            /* Write ethernet packet to tap device. */
            traceEvent( TRACE_INFO, "发送到TAP接口 %u", (unsigned int)eth_size );
            data_sent_len = tuntap_write(&(eee->device), decodebuffer, eth_size);

            if (data_sent_len == eth_size)
            {
                retval = 0;
            }
        }
        else
        {
            traceEvent( TRACE_ERROR, "丢弃未知的转换枚举的数据包 %u", 
                        (unsigned int)pkt->transform );
        }
    }

    return retval;
}


/** 从管理UDP套接字读取数据报，并采取适当的措施
 *  执行. */
static void readFromMgmtSocket( n2n_edge_t * eee, int * keep_running )
{
    uint8_t             udp_buf[N2N_PKT_BUF_SIZE+1];   /* 完整的UDP数据包 */
    ssize_t             recvlen;
    struct sockaddr_in  sender_sock;
    socklen_t           i;
    size_t              msg_len;
    time_t              now;
    macstr_t		mac_buf;
    n2n_sock_str_t	sockbuf;
    peer_info_t *	lpi = NULL;
    struct sglib_hashed_peer_info_t_iterator    it;
    int			c;

    now = time(NULL);
    i = sizeof(sender_sock);
    recvlen = recvfrom(eee->udp_mgmt_sock, udp_buf, N2N_PKT_BUF_SIZE, 0/*flags*/,
		     (struct sockaddr *)&sender_sock, (socklen_t*)&i);

    if ( recvlen < 0 )
    {
        traceEvent(TRACE_ERROR, "管理记录失败 错误原因 %s", strerror(errno) );

        return; /* 无法从UDP接收数据 */
    }

    /* 避免解析堆栈中任何未初始化的垃圾 */
    udp_buf[recvlen] = 0;

    if ( recvlen >= 4 )
    {
        if ( ( recvlen >= 5 + (int)strlen(LAUNCH_AUTH_SECRET) ) &&
             ( 0 == memcmp( udp_buf, "stop ", 5 ) ) &&
             ( 0 == memcmp( udp_buf + 5, LAUNCH_AUTH_SECRET, strlen(LAUNCH_AUTH_SECRET) ) ) )
        {
            traceEvent( TRACE_ERROR, "收到停止命令." );
            *keep_running = 0;
            return;
        }

        if ( 0 == memcmp( udp_buf, "help", 4 ) )
        {
            msg_len=0;
            //++traceLevel;

            msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                 "Help for edge management console:\n"
                                 "  stop <key>  Gracefully exit edge\n"
                                 "  help    This help message\n"
                                 "  +verb   Increase verbosity of logging\n"
                                 "  -verb   Decrease verbosity of logging\n"
								 "  peers   List table of known peers\n"
                                 "  reload  Re-read the keyschedule\n"
                                 "  mangle_peer mac ip [port] mangle peer\n"
                                 "  localip [value]     Show or set the local IP value\n"
                                 "  <enter> Display statistics\n\n");

            sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0/*flags*/,
                    (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );

            return;
        }

    }

    if ( recvlen >= 5 )
    {
        if ( 0 == memcmp( udp_buf, "+verb", 5 ) )
        {
            msg_len=0;
            ++traceLevel;

            traceEvent( TRACE_ERROR, "+verb traceLevel=%u", (unsigned int)traceLevel );
            msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                     "> +OK traceLevel=%u\n", (unsigned int)traceLevel );

            sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0/*flags*/,
                    (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );

            return;
        }

        if ( 0 == memcmp( udp_buf, "-verb", 5 ) )
        {
            msg_len=0;

            if ( traceLevel > 0 )
            {
                --traceLevel;
                msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                     "> -OK traceLevel=%u\n", traceLevel );
            }
            else
            {
                msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                     "> -NOK traceLevel=%u\n", traceLevel );
            }

            traceEvent( TRACE_ERROR, "-verb traceLevel=%u", (unsigned int)traceLevel );

            sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0/*flags*/,
                    (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
            return;
        }

		if ( 0 == memcmp( udp_buf, "peers", 5 ) )
		{
			msg_len = 0;
			
			msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
								 "> known peers (connected edges):\n");

			traceEvent( TRACE_ERROR, "listing peers on mgmt socket", 0);
			sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0,
				(struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );

			c = 0;
			for(lpi=sglib_hashed_peer_info_t_it_init(&it,eee->known_peers); lpi!=NULL; lpi=sglib_hashed_peer_info_t_it_next(&it)) {
				c++;
				msg_len = 0;
				msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                        ">  %i: %s -> %s last: %li(%ld sec ago)\n", c, macaddr_str( mac_buf, lpi->mac_addr ),
						sock_to_cstr( sockbuf, &(lpi->sock) ),
                                                lpi->last_seen, (now - lpi->last_seen));
				sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0,
					(struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
			}

			msg_len = 0;
			
			msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
								 "> known peers (tried edges):\n");
			sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0,
				(struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );

			c = 0;
			for(lpi=sglib_hashed_peer_info_t_it_init(&it,eee->pending_peers); lpi!=NULL; lpi=sglib_hashed_peer_info_t_it_next(&it)) {
				c++;
				msg_len = 0;
                if(lpi->num_sockets == 0)
                    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                        ">  %i: %s -> (no info) last: %li(%ld sec ago)\n", c,
                        macaddr_str( mac_buf, lpi->mac_addr ), 
                        lpi->last_seen, (now - lpi->last_seen));
                else
                    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                        ">  %i: %s -> %s last: %li(%ld sec ago)\n", c, macaddr_str( mac_buf, lpi->mac_addr ),
                            sock_to_cstr( sockbuf, lpi->sockets ),
                            lpi->last_seen, (now - lpi->last_seen));
                if(lpi->num_sockets > 1)
                    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                        "                           %s\n",
                            sock_to_cstr( sockbuf, lpi->sockets+1 ));
				sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0,
					(struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
			}

			return;
		}
    }

    if ( recvlen >= 6 )
    {
        if ( 0 == memcmp( udp_buf, "reload", 6 ) )
        {
            if ( strlen( eee->keyschedule ) > 0 )
            {
                if ( edge_init_keyschedule(eee) == 0 )
                {
                    msg_len=0;
                    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                         "> OK\n" );
                    sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0/*flags*/,
                            (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
                }
                return;
            }
        }
    }

    if ( recvlen >= 12 )
    {
        if ( 0 == memcmp (udp_buf, "mangle_peer ", 12) )
        {
            int j, n_matched;
            n2n_mac_t target_mac;
            unsigned int mac[6];
            int ip[4];
            int port;
            struct peer_info * scan;

            udp_buf[recvlen] = 0;
            n_matched = sscanf((const char *) udp_buf,
                    "mangle_peer %x:%x:%x:%x:%x:%x %d.%d.%d.%d %d", mac, mac+1,
                    mac+2, mac+3, mac+4, mac+5, ip, ip+1, ip+2, ip+3, &port);
            for( j=0; j<6; j++ )
                target_mac[j] = (uint8_t) mac[j];
            scan = find_peer_by_mac( eee->pending_peers, target_mac );
            if (NULL != scan && n_matched >= 10) {
                scan->sock.family = AF_INET;
                printf("n_matched: %d, port: %d\n", n_matched, port);
                if (n_matched >= 11 && port > 0)
                    scan->sock.port = (uint16_t) port;
                for( j=0; j<4; j++)
                    scan->sock.addr.v4[j] = (uint8_t) ip[j];
                sendto( eee->udp_mgmt_sock, "success\n", 9, 0,
                        (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
            } else {
                sendto( eee->udp_mgmt_sock, "failure\n", 9, 0,
                        (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
            }
            return;
        }
    }

    char * cmd = strtok( (char *)udp_buf, " \r\n");
    if (cmd) {
        if ( 0 == strcmp( cmd, "localip" ) )
        {
            char *arg = strtok( NULL, " \r\n");
            if (arg) {
                strncpy( eee->local_ip_str, arg, N2N_EDGE_LOCAL_IP_SIZE);
                if ( set_localip(eee) != 0) {
                    sendto( eee->udp_mgmt_sock, "failure\n", 9, 0,
                            (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
                    return;
                }
            }

            /* show current value - possibly after changing it */
            msg_len=0;
            if (!eee->local_sock_ena) {
                msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                     "> localip off\n" );
            } else {
                n2n_sock_str_t local_sockbuf;
                msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                                     "> localip %s (%s)\n",
                                     eee->local_ip_str,
                                     sock_to_cstr( local_sockbuf, &(eee->local_sock) ) );
            }
            sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0/*flags*/,
                    (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
            return;
        }
    }

    traceEvent(TRACE_DEBUG, "管理状态请求" );

    msg_len=0;
    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                         "Statistics for edge\n" );

    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                         "uptime %lu\n",
                         time(NULL) - eee->start_time );

    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
			"paths  super:(tx),(rx) p2p: (tx),(rx)\n");
    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                         "packets      %u,%u     %u,%u\n",
                         (unsigned int)eee->tx_sup,
			 (unsigned int)eee->rx_sup,
			 (unsigned int)eee->tx_p2p,
			 (unsigned int)eee->rx_p2p );

   msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
			 "byte/s       %u,%u     %u,%u\n",
			 (unsigned int)eee->tx_bps_sup,
			 (unsigned int)eee->rx_bps_sup,
			 (unsigned int)eee->tx_bps_p2p,
			 (unsigned int)eee->rx_bps_p2p );

    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                         "trans:null |%6u|%6u|\n"
                         "trans:tf   |%6u|%6u|\n"
                         "trans:aes  |%6u|%6u|\n",
                         (unsigned int)eee->transop[N2N_TRANSOP_NULL_IDX].tx_cnt,
                         (unsigned int)eee->transop[N2N_TRANSOP_NULL_IDX].rx_cnt,
                         (unsigned int)eee->transop[N2N_TRANSOP_TF_IDX].tx_cnt,
                         (unsigned int)eee->transop[N2N_TRANSOP_TF_IDX].rx_cnt,
                         (unsigned int)eee->transop[N2N_TRANSOP_AESCBC_IDX].tx_cnt,
                         (unsigned int)eee->transop[N2N_TRANSOP_AESCBC_IDX].rx_cnt );

    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                         "peers  pend:%u full:%u\n",
                         (unsigned int)hashed_peer_list_t_size( eee->pending_peers ), 
			 (unsigned int)hashed_peer_list_t_size( eee->known_peers ) );

    msg_len += snprintf( (char *)(udp_buf+msg_len), (N2N_PKT_BUF_SIZE-msg_len),
                         "last   super:%lu(%ld sec ago) p2p:%lu(%ld sec ago)\n",
                         eee->last_sup, (now - eee->last_sup), eee->last_p2p, (now - eee->last_p2p) );

    traceEvent(TRACE_DEBUG, "管理状态发送中: %s", udp_buf );


    sendto( eee->udp_mgmt_sock, udp_buf, msg_len, 0/*flags*/,
            (struct sockaddr *)&sender_sock, sizeof(struct sockaddr_in) );
}


/** 从主UDP套接字中读取一个数据报到互联网. */
static void readFromIPSocket(n2n_edge_t *eee)
{
    n2n_common_t        cmn; /* 数据包报头中的公共字段 */

    n2n_sock_str_t      sockbuf1;
    n2n_sock_str_t      sockbuf2; /* 如果在跟踪中写入两个地址，请不要覆盖sockbuf1 */
    macstr_t            mac_buf1;
    macstr_t            mac_buf2;

    uint8_t             udp_buf[N2N_PKT_BUF_SIZE+1];      /* 完整的UDP数据包 */
    ssize_t             recvlen;//接收到的字节数
    size_t              rem;//剩余的字节数
    size_t              idx;//索引
    size_t              msg_type;//消息类型
    struct sockaddr_in  sender_sock;//发送者的地址
    n2n_sock_t          sender;//发送者的地址
    n2n_sock_t *        orig_sender = NULL;//原始发送者的地址
    time_t              now = 0;//当前时间
    size_t              i;//循环变量
    int                 j;//循环变量

    /* for PACKET packages */
    n2n_PACKET_t pkt;

    /* for PEER_INFO packages */
    n2n_PEER_INFO_t pi;
    struct peer_info *scan;

    /* for REGISTER packages */
    n2n_REGISTER_t reg;
    peer_info_t tmp;

    /* for REGISTER_ACK packages */
    n2n_REGISTER_ACK_t ra;

    /* For REGISTER_SUPER_ACK packages */
    n2n_REGISTER_SUPER_ACK_t rsa;


    i = sizeof(sender_sock);//初始化sender_sock的大小
    recvlen = recvfrom(eee->udp_sock, udp_buf, N2N_PKT_BUF_SIZE, 0/*flags*/,
                     (struct sockaddr *)&sender_sock, (socklen_t*)&i);

    if ( recvlen < 0 )//失败了
    {
        //traceEvent(TRACE_ERROR, "UDP接收数据[%s]已转换为TCP接收:联系QQ4722100,如:无连接问题,可忽略此条信息", strerror(errno) );//失败了 - 转换为TCP接收临时屏蔽
        traceEvent(TRACE_INFO, "更新接收数据包大小:%d", recvlen);//失败了 - 转换为TCP接收临时屏蔽

        /* REVISIT: 我们应该关闭套接字并退出吗？ */

        return; /* 无法从UDP接收数据 */
    }

    //* 预留：当支持UDP/IPv6时，我们需要一个标识来指示数据包到达的IP传输版本。可能需要UDP套接字。 */
    sender.family = AF_INET; /* udp_sock是以IPv4的PF_INET打开的 */
    sender.port = ntohs(sender_sock.sin_port);//将网络字节序转换为主机字节序
    memcpy( &(sender.addr.v4), &(sender_sock.sin_addr.s_addr), IPV4_SIZE );//将IPv4地址复制到sender.addr.v4

    /* 数据包可能没有orig_sender socket spec。因此默认将上一个跳作为发送者。 */
    orig_sender = &sender;

    traceEvent(TRACE_INFO, "### 从(%d)接收到 UDP %s", 
               (signed int)recvlen, sock_to_cstr(sockbuf1, &sender) );

    /* hexdump( udp_buf, recvlen ); */

    rem = recvlen; /* Counts down bytes of packet to protect against buffer overruns. */
    idx = 0; /* marches through packet header as parts are decoded. */
    if ( decode_common(&cmn, udp_buf, &rem, &idx) < 0 )
    {
        traceEvent( TRACE_ERROR, "解码UDP中的公共部分失败" );
        return; /* failed to decode packet */
    }

    now = time(NULL);

    msg_type = cmn.pc; /* packet code */

    if( 0 == memcmp(cmn.community, eee->community_name, N2N_COMMUNITY_SIZE) )
    {
        switch(msg_type) {
        case MSG_TYPE_PACKET:
            /* process PACKET */
            decode_PACKET( &pkt, &cmn, udp_buf, &rem, &idx );

            traceEvent(TRACE_INFO, "从 %s (%s)接收到数据包",
                       sock_to_cstr(sockbuf1, &sender),
                       sock_to_cstr(sockbuf2, orig_sender) );

            handle_PACKET( eee, &cmn, &pkt, orig_sender, udp_buf+idx,
                    recvlen-idx );
            break;
        case MSG_TYPE_PEER_INFO:
            decode_PEER_INFO( &pi, &cmn, udp_buf, &rem, &idx );

            scan = find_peer_by_mac( eee->pending_peers, pi.mac );
            if (scan) {
                scan->timeout = pi.timeout;
                if (scan->num_sockets > 0)
                    free(scan->sockets);
                if (pi.aflags & N2N_AFLAGS_LOCAL_SOCKET)
                    scan->num_sockets = 2;
                else
                    scan->num_sockets = 1;
                scan->sockets = malloc(scan->num_sockets*sizeof(n2n_sock_t));
                for(j=0; j<scan->num_sockets; j++)
                    scan->sockets[j] = pi.sockets[j];
                traceEvent(TRACE_INFO, "在 %s上接收到PEER_INFO",
                           macaddr_str(mac_buf1, pi.mac) );
                for(j=0; j<scan->num_sockets; j++)
                    send_register(eee, scan->sockets+j, scan->mac_addr);
            } else {
                traceEvent(TRACE_INFO, "在 %s上接收到未知的PEER_INFO",
                           macaddr_str(mac_buf1, pi.mac) );
            }

            break;
        case MSG_TYPE_REGISTER:
            /* Another edge is registering with us */
            decode_REGISTER( &reg, &cmn, udp_buf, &rem, &idx );

            traceEvent(TRACE_INFO,
                    "Rx寄存器 源地址=%s 目标地址=%s 来自 %s (%s)",
                    macaddr_str( mac_buf1, reg.srcMac ),
                    macaddr_str( mac_buf2, reg.dstMac ),
                    sock_to_cstr(sockbuf1, &sender),
                    sock_to_cstr(sockbuf2, orig_sender) );

            if ( 0 == memcmp(reg.dstMac, (eee->device.mac_addr), 6) )
            {
                memcpy(tmp.mac_addr, reg.srcMac, sizeof(n2n_mac_t));
                if (sglib_hashed_peer_info_t_find_member( 
                            eee->pending_peers, &tmp) != NULL)
                    send_register(eee, orig_sender, NULL);
            }

            send_register_ack(eee, orig_sender, &reg);
            break;
        case MSG_TYPE_REGISTER_ACK:
            /* Peer edge is acknowledging our register request */

            decode_REGISTER_ACK( &ra, &cmn, udp_buf, &rem, &idx );

            if ( ra.sock.family )
            {
                orig_sender = &(ra.sock);
            }

            traceEvent(TRACE_INFO, "Rx REGISTER_ACK 源地址=%s 目标地址=%s 来自 %s (%s)",
                       macaddr_str( mac_buf1, ra.srcMac ),
                       macaddr_str( mac_buf2, ra.dstMac ),
                       sock_to_cstr(sockbuf1, &sender),
                       sock_to_cstr(sockbuf2, orig_sender) );

            /* Move from pending_peers to known_peers; ignore if not in pending. */
            set_peer_operational( eee, ra.srcMac, &sender );
            break;
        case MSG_TYPE_REGISTER_SUPER_ACK:
            if ( eee->sn_wait )
            {
                decode_REGISTER_SUPER_ACK( &rsa, &cmn, udp_buf, &rem, &idx );

                if ( rsa.sock.family )
                {
                    orig_sender = &(rsa.sock);
                }

                traceEvent(TRACE_NORMAL, "接收数据包:MAC地址:%s (网关IP:%s).次数:%u",//接收 REGISTER_SUPER_ACK 指令,MAC地址:%s [%s] (外网IP: %s).次数: %u
                           macaddr_str( mac_buf1, rsa.edgeMac ),
                           /*sock_to_cstr(sockbuf1, &sender),*/
                           sock_to_cstr(sockbuf2, orig_sender), 
                           (unsigned int)eee->sup_attempts );

                if ( 0 == memcmp( rsa.cookie, eee->last_cookie, N2N_COOKIE_SIZE ) )
                {
                    if ( rsa.num_sn > 0 )
                    {
                        traceEvent(TRACE_NORMAL, "接收 REGISTER_SUPER_ACK 备份网关位于 %s",
                                   sock_to_cstr(sockbuf1, &(rsa.sn_bak) ) );
                    }

                    eee->last_p2p = now;
                    eee->last_sup = now;
                    eee->sn_wait=0;
                    eee->sup_attempts = N2N_EDGE_SUP_ATTEMPTS; /* refresh because we got a response */

                    /* REVISIT: store sn_back */
                    /* don't adjust lifetime according to supernode - this value should be specified
                     * by the client (because dependent on NAT/firewall) (lukas) 
                    eee->holepunch_interval = rsa.lifetime;
                    eee->holepunch_interval = MAX( eee->holepunch_interval, REGISTER_SUPER_INTERVAL_MIN );
                    eee->holepunch_interval = MIN( eee->holepunch_interval, REGISTER_SUPER_INTERVAL_MAX );
                     */
                }
                else
                {
                    traceEvent( TRACE_WARNING, "Rx REGISTER_SUPER_ACK 使用错误或旧的cookie." );
                }
            }
            else
            {
                traceEvent( TRACE_WARNING, "Rx REGISTER_SUPER_ACK with no outstanding REGISTER_SUPER." );
            }
            break;
        default:
            /* Not a known message type */
            traceEvent(TRACE_WARNING, "无法处理数据包类型 %d: 忽略", (signed int)msg_type);
            break;
        } /* end switch(msg_type) */
    } /* if (community match) */
    else
    {
        traceEvent(TRACE_WARNING, "收到包含无效客户端的数据包");
    }

}

/* ***************************************************** */


#ifdef WIN32
static DWORD tunReadThread(LPVOID lpArg )
{
    n2n_edge_t *eee = (n2n_edge_t*)lpArg;

    while(keep_running) /* was while(1): thread must observe the stop flag or it touches freed eee */
    {
        readFromTAPSocket(eee);
    }

    return((DWORD)NULL);
}


/** Start a second thread in Windows because TUNTAP interfaces do not expose
 *  file descriptors. */
static HANDLE s_tapThread = NULL; /* TAP reader thread handle, for orderly shutdown */

static void startTunReadThread(n2n_edge_t *eee)
{
    DWORD dwThreadId;

    s_tapThread = CreateThread(NULL,     /* security attributes */
                           0,            /* use default stack size */
                           (LPTHREAD_START_ROUTINE)tunReadThread, /* thread function */
                           (void*)eee,   /* argument to thread function */
                           0,            /* thread creation flags */
                           &dwThreadId); /* thread id out */
}
#endif

/* ***************************************************** */

/** Resolve the supernode IP address.
 *
 *  REVISIT: This is a really bad idea. The edge will block completely while the
 *           hostname resolution is performed. This could take 15 seconds.
 */
static void supernode2addr(n2n_sock_t * sn, const n2n_sn_name_t addrIn)
{
    n2n_sn_name_t addr;
	const char *supernode_host;

    memcpy( addr, addrIn, N2N_EDGE_SN_HOST_SIZE );

    supernode_host = strtok(addr, ":");

    if(supernode_host)
    {
        in_addr_t sn_addr;
        char *supernode_port = strtok(NULL, ":");
        const struct addrinfo aihints = {0, PF_INET, 0, 0, 0, NULL, NULL, NULL};
        struct addrinfo * ainfo = NULL;
        int nameerr;

        if ( supernode_port )
            sn->port = atoi(supernode_port);
        else
            traceEvent(TRACE_WARNING, "参数错误 (-l <host:port>) %s %s:%s",
                       addr, supernode_host, supernode_port);

        nameerr = getaddrinfo( supernode_host, NULL, &aihints, &ainfo );

        if( 0 == nameerr )
        {
            struct sockaddr_in * saddr;

            /* ainfo s the head of a linked list if non-NULL. */
            if ( ainfo && (PF_INET == ainfo->ai_family) )
            {
                /* It is definitely and IPv4 address -> sockaddr_in */
                saddr = (struct sockaddr_in *)ainfo->ai_addr;

                memcpy( sn->addr.v4, &(saddr->sin_addr.s_addr), IPV4_SIZE );
                sn->family=AF_INET;
            }
            else
            {
                /* Should only return IPv4 addresses due to aihints. */
                traceEvent(TRACE_WARNING, "无法解析的IPv4地址 %s", supernode_host);
            }

            freeaddrinfo(ainfo); /* free everything allocated by getaddrinfo(). */
            ainfo = NULL;
        } else {
            traceEvent(TRACE_WARNING, "无法解析网关主机 %s, 假设为数值型", supernode_host);
            sn_addr = inet_addr(supernode_host); /* uint32_t */
            memcpy( sn->addr.v4, &(sn_addr), IPV4_SIZE );
            sn->family=AF_INET;
        }

    } else
        traceEvent(TRACE_WARNING, "参数错误 (-l <host:port>)");
}

/** Decode local address string (given on command line)
 */
static int localip2addr(n2n_sock_t * l_ip,
        const n2n_local_ip_t local_ip_str, int local_port)
{
    /* TODO: IPv6? */
    unsigned int ip[4];
    int i, n_matches;

    n_matches = sscanf( local_ip_str, "%u.%u.%u.%u", &ip[0], &ip[1], &ip[2],
            &ip[3]);

    if( n_matches != 4) {
        return 0;
    }

    for( i=0; i < 4; i++ ) {
        if( ip[i] > 255 ) {
            return 0;
        }
    }
    l_ip->family = AF_INET;
    l_ip->port = local_port;
    for( i = 0; i < 4; i++ )
        l_ip->addr.v4[i] = ip[i];
    return 1;
}

static int set_localip(n2n_edge_t * eee) {
    int     local_port;
    n2n_sock_str_t local_sockbuf;
    struct sockaddr_in sa;

    /* Assume failure, until one of the methods succeeds */
    eee->local_sock_ena = 0;

    if (eee->local_ip_str[0] == 0) {
        /* Sanity check - cannot use an empty string to set localip */
        traceEvent( TRACE_ERROR, "本地IP字符串为空" );
        return(-1);
    }

    socklen_t sa_len = sizeof(sa);
    if ( getsockname(eee->udp_sock, (struct sockaddr *) &sa, &sa_len) == -1 ) {
        traceEvent( TRACE_ERROR, "getsockname() 失败" );
        return(-1);
    }

    local_port = ntohs(sa.sin_port);
    memset(&(eee->local_sock), 0, sizeof(eee->local_sock));

    if ( localip2addr( &(eee->local_sock),
                    eee->local_ip_str, local_port ) ) {
        eee->local_sock_ena = 1;
    } else if ( 0 == strcmp( eee->local_ip_str, "auto" ) ) {
        /* Automatically use a "sane" value for the localip.
         * This is currently using the local ip address that is used to
         * talk to the supernode, but that could change if a better method
         * if found
         */

        SOCKET fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (fd < 0) {
            traceEvent(TRACE_WARNING, "socket() 失败");
            return(-1);
        }

        struct sockaddr_in sa_sn;

        fill_sockaddr( (struct sockaddr *) &sa_sn,
                       sizeof(sa_sn),
                       &eee->supernode );

        if ( connect(fd, (struct sockaddr *) &sa_sn, sizeof(sa_sn) ) <0 ) {
            close(fd);
            traceEvent(TRACE_WARNING, "connect() 失败");
            return(-1);
        }

        if ( getsockname(fd, (struct sockaddr *) &sa, &sa_len) <0 ) {
            close(fd);
            traceEvent(TRACE_WARNING, "getsockname() 失败");
            return(-1);
        }

        if ( AF_INET != sa.sin_family ) {
            /* TODO IPV6 */
            close(fd);
            traceEvent(TRACE_WARNING, "错误的套接字类型");
            return(-1);
        }

        eee->local_sock.family = sa.sin_family;
        eee->local_sock.port = local_port;
        memcpy( eee->local_sock.addr.v4, &(sa.sin_addr.s_addr), IPV4_SIZE );
        eee->local_sock_ena = 1;
        close(fd);
    }

    if (eee->local_sock_ena) {
        traceEvent(TRACE_NORMAL, "本地套接字为 %s",
                sock_to_cstr( local_sockbuf, &(eee->local_sock) ) );
        return(0);
    }

    traceEvent(TRACE_WARNING, "错误的本地IP参数 (-L ip), 已禁用");
    return(-1);
}

/* ***************************************************** */


/** Find the address and IP mode for the tuntap device.
 *
 *  s is one of these forms:
 *
 *  <host> := <hostname> | A.B.C.D
 *
 *  <host> | static:<host> | dhcp:<host>
 *
 *  If the mode is present (colon required) then fill ip_mode with that value
 *  otherwise do not change ip_mode. Fill ip_mode with everything after the
 *  colon if it is present; or s if colon is not present.
 *
 *  ip_add and ip_mode are NULL terminated if modified.
 *
 *  return 0 on success and -1 on error
 */
static int scan_address( char * ip_addr, size_t addr_size,
                         char * ip_mode, size_t mode_size,
                         const char * s )
{
    int retval = -1;
    char * p;

    if ( ( NULL == s ) || ( NULL == ip_addr) )
    {
        return -1;
    }

    memset(ip_addr, 0, addr_size);

    p = strpbrk(s, ":");

    if ( p )
    {
        /* colon is present */
        if ( ip_mode )
        {
            size_t end=0;

            memset(ip_mode, 0, mode_size);
            end = MIN( p-s, (ssize_t)(mode_size-1) ); /* ensure NULL term */
            strncpy( ip_mode, s, end );
            strncpy( ip_addr, p+1, addr_size-1 ); /* ensure NULL term */
            retval = 0;
        }
    }
    else
    {
        /* colon is not present */
        strncpy( ip_addr, s, addr_size );
    }

    return retval;
}

static int run_loop(n2n_edge_t * eee );
int real_main(int argc, char* argv[]);

#define N2N_NETMASK_STR_SIZE    16 /* dotted decimal 12 numbers + 3 dots */
#define N2N_MACNAMSIZ           18 /* AA:BB:CC:DD:EE:FF + NULL*/
#define N2N_IF_MODE_SIZE        16 /* static | dhcp */

/** 程序从内核的入口点. */
int real_main(int argc, char* argv[])
{
    int     opt;// getopt_long()选项
    int     local_port = 0 /* 本地端口，初始值为0（任意端口） */;
    int     mgmt_port = N2N_EDGE_MGMT_PORT; /* 管理端口，默认为5644 */
    char    tuntap_dev_name[N2N_IFNAMSIZ] = "edge0";// TUN/TAP设备名称，默认为"edge0"
    char    ip_mode[N2N_IF_MODE_SIZE] = "static";// IP模式，默认为"static"（静态）
    char    ip_addr[N2N_NETMASK_STR_SIZE] = "";// IP地址，默认为空
    char    netmask[N2N_NETMASK_STR_SIZE] = "255.255.255.0";// 子网掩码，默认为"255.255.255.0"
    int     mtu = DEFAULT_MTU;// 最大传输单元（MTU），默认为DEFAULT_MTU 1400
    int     got_s = 0;// 标识是否已经获取到选项s的值，默认为0

#ifndef WIN32
    uid_t   userid = 0; /* userid: 用户ID，默认为0（root用户的ID是保证的） */
    gid_t   groupid = 0; /* groupid: 组ID，默认为0（root用户的ID是保证的） */
#endif

    char    device_mac[N2N_MACNAMSIZ] = "";// 设备的MAC地址，初始为空
    char *  encrypt_key = NULL;// 加密密钥，默认为空

    int     i, effectiveargc = 0;// i用于循环计数，effectiveargc用于记录有效的命令行参数个数
    char ** effectiveargv = NULL; // 有效的命令行参数列表
    char  * linebuffer = NULL;// 用于存储读取的行数据的缓冲区

    n2n_edge_t eee; /* 该程序的单个实例 */

    if (-1 == edge_init(&eee))// 初始化n2n_edge_t结构体实例eee，如果失败则输出错误信息并退出程序
    {
        traceEvent(TRACE_ERROR, "负载服务初始化失败");
        exit(1);
    }

    if(getenv( "N2N_KEY" ))// 获取环境变量"N2N_KEY"的值，并将其赋值给encrypt_key变量
    {
        encrypt_key = strdup(getenv("N2N_KEY"));// 复制环境变量的值到encrypt_key变量中
    }

#ifdef WIN32
    tuntap_dev_name[0] = '\0';// 若环境变量"N2N_KEY"不存在，则将tuntap_dev_name变量置为空字符串
#endif
    memset(&(eee.supernode), 0, sizeof(eee.supernode));// 初始化supernode结构体，其中的addr成员为0
    eee.supernode.family = AF_INET;// 初始化supernode的地址族为IPv4

    linebuffer = (char *)malloc(MAX_CMDLINE_BUFFER_LENGTH);// 申请内存，用于存储读取的行数据的缓冲区
    if (!linebuffer)// 内存申请失败则输出错误信息并退出程序
    {
        traceEvent( TRACE_ERROR, "无法分配内存");// 输出错误信息
        exit(1);// 退出程序
    }
    snprintf(linebuffer, MAX_CMDLINE_BUFFER_LENGTH, "%s",argv[0]);// 将argv[0]的值复制到linebuffer中

#ifdef WIN32
    for(i=0; i < (int)strlen(linebuffer); i++)// 遍历linebuffer中的每个字符
        if(linebuffer[i] == '\\') linebuffer[i] = '/';// 将所有反斜杠替换为正斜杠
#endif

    for(i = 1; i < argc; ++i)// 遍历命令行参数
    {
        if(argv[i][0] == '@')// 如果命令行参数以"@"开头，则表示读取配置文件
        {
            if (readConfFile(&argv[i][1], linebuffer)<0) exit(1); /* <<<<----- check */
        }
        else if ((strlen(linebuffer)+strlen(argv[i])+2) < MAX_CMDLINE_BUFFER_LENGTH)// 如果命令行参数的长度加上linebuffer中的长度加2小于等于MAX_CMDLINE_BUFFER_LENGTH，则将命令行参数追加到linebuffer中
        {
            strncat(linebuffer, " ", 1);// 将空格追加到linebuffer中
            strncat(linebuffer, argv[i], strlen(argv[i]));// 将命令行参数追加到linebuffer中
        }
        else
        {
            traceEvent( TRACE_ERROR, "太多参数");// 输出错误信息
            exit(1);// 退出程序
        }
    }
    /*  strip trailing spaces */
    while(strlen(linebuffer) && linebuffer[strlen(linebuffer)-1]==' ')// 若linebuffer的最后一个字符是空格，则将其删除
        linebuffer[strlen(linebuffer)-1]= '\0';// 删除最后一个字符

    /* build the new argv from the linebuffer */
    effectiveargv = buildargv(&effectiveargc, linebuffer);// 调用buildargv()函数，将linebuffer中的命令行参数转换为字符串数组effectiveargv，并记录有效的命令行参数个数effectiveargc

#ifdef WIN32
    /* unfortunately, any cmdline quoting used originally is gone, so we can
     * not use the getopt to process the install
     */
    if (!_strnicmp(effectiveargv[1], "--install", 9)) {// 如果effectiveargv[1]以"--install"开头，则表示安装服务
        char *p = strchr(linebuffer,' ') + 1; /* skip the argv[0] */ // 跳过argv[0]
        char *scm_args = strchr(p,' ') + 1; /* skip the "--install" */ // 跳过"--install"

        printf("使用args安装服务 '%s'\n", scm_args);// 输出安装服务的提示信息
        /* request service installation */
        char *path = SCM_Install(&sd,scm_args);// 调用SCM_Install()函数，安装服务，并返回服务的路径
        if (!path) {
            printf("服务安装失败\n");// 输出安装服务失败的提示信息
            return 2;// 退出程序
        }
        printf("已安装服务 '%s' 路径 '%s'\n", sd.name,path);// 输出安装服务成功的提示信息
        printf("您现在应该使用服务管理器启动该服务.\n");// 输出提示信息
        return 1;// 退出程序
    }
#endif

    if (linebuffer)// 如果linebuffer不为空，则释放内存
    {
        free(linebuffer);// 释放linebuffer所占的内存
        linebuffer = NULL;// 将linebuffer变量置为空指针
    }

    /* {int k;for(k=0;k<effectiveargc;++k)  printf("%s\n",effectiveargv[k]);} */

    optarg = NULL;// 初始化getopt_long()函数的选项参数
    while((opt = getopt_long(effectiveargc,
                             effectiveargv,
                             "K:k:a:bc:Eu:g:m:M:s:d:l:L:i:p:fvhrt:R", long_options, NULL)) != EOF)// 循环读取命令行参数
    {
        switch (opt)// 根据命令行参数的选项进行处理
        {
        case'K':
        {
            if ( encrypt_key )// 如果encrypt_key变量不为空，则输出错误信息
            {
                fprintf(stderr, "错误: -K 和 -k 不能同时使用.\n");// 输出错误信息
                exit(1);// 退出程序
            }
            else
            {
                strncpy( eee.keyschedule, optarg, N2N_PATHNAME_MAXLEN-1 );// 将选项参数赋值给encrypt_key变量
                eee.keyschedule[N2N_PATHNAME_MAXLEN-1]=0; /* strncpy does not add NULL if the source has no NULL. */ // 确保encrypt_key变量以NULL结尾
                traceEvent(TRACE_DEBUG, "密钥文件 = '%s'\n", eee.keyschedule);// 输出调试信息
                fprintf(stderr, "密钥文件 = '%s'\n", eee.keyschedule);// 输出加密密钥信息
            }
            break;
        }
        case 'a': /* TUNTAP接口的IP地址和模式 */ // 处理选项-a
        {
            scan_address(ip_addr, N2N_NETMASK_STR_SIZE,
                         ip_mode, N2N_IF_MODE_SIZE,
                         optarg );// 调用scan_address()函数，解析选项参数optarg，并将结果赋值给ip_addr、ip_mode、netmask变量
            break;
        }
        case 'c': /* 用作身份验证或访问控制机制 */ // 处理选项-c
        {
            memset( eee.community_name, 0, N2N_COMMUNITY_SIZE );// 将选项参数赋值给eee.community_name变量
            strncpy( (char *)eee.community_name, optarg, N2N_COMMUNITY_SIZE);// 确保eee.community_name变量以NULL结尾
            break;
        }
        case 'E': /* 接受多播以太网地址. */ // 处理选项-E
        {
            eee.drop_multicast=0;// 允许接收组播数据包
            traceEvent(TRACE_DEBUG, "启用以太网组播流量实现一对多的数据传输\n");// 输出调试信息
            break;
        }

#ifndef WIN32
        case 'u': /* unprivileged uid */ // 处理选项-u
        {
            userid = atoi(optarg);// 将选项参数转换为整数，并赋值给userid变量
            break;
        }
        case 'g': /* unprivileged uid */ // 处理选项-g
        {
            groupid = atoi(optarg); // 将选项参数转换为整数，并赋值给groupid变量
            break;
        }
#endif
#ifdef N2N_HAVE_DAEMON
        case 'f' : /* do not fork as daemon */ // 处理选项-f
        {
            eee.daemon=0;// 不作为守护进程运行
            break;
        }
#endif /* #ifdef N2N_HAVE_DAEMON */

        case 'm' : /* TUNTAP MAC 地址 */ // 处理选项-m
        {
            strncpy(device_mac,optarg,N2N_MACNAMSIZ);// 将选项参数赋值给device_mac变量
            break;
        }

        case 'M' : /* TUNTAP MTU */ // 处理选项-M
        {
            mtu = atoi(optarg);// 将选项参数转换为整数，并赋值给mtu变量
            break;
        }

        case 'k': /* encrypt key */ // 处理选项-k
        {
            if (strlen(eee.keyschedule) > 0 )// 如果encrypt_key变量不为空，则输出错误信息
            {
                fprintf(stderr, "错误: -K 和 -k 不能同时使用.\n");// 输出错误信息
                exit(1);
            } else {
                traceEvent(TRACE_DEBUG, "加密密钥 = '%s'\n", encrypt_key);// 输出调试信息
                encrypt_key = strdup(optarg);
            }
            break;
        }
        case 'r': /* enable packet routing across n2n endpoints */ // 处理选项-r
        {
            eee.allow_routing = 1;// 允许路由
            break;
        }

        case 'l': /* supernode-list */ // 处理选项-l
        {
            if ( eee.sn_num < N2N_EDGE_NUM_SUPERNODES )// 如果超级节点列表中还没有超级节点，则将选项参数赋值给超级节点列表中
            {
                strncpy( (eee.sn_ip_array[eee.sn_num]), optarg, N2N_EDGE_SN_HOST_SIZE);// 将选项参数赋值给超级节点列表中
                traceEvent(TRACE_DEBUG, "添加网关服务地址 [%u] = %s\n", (unsigned int)eee.sn_num, (eee.sn_ip_array[eee.sn_num]) );// 输出调试信息
                ++eee.sn_num;
            }
            else
            {
                fprintf(stderr, "网关服务地址太多!\n" );// 输出错误信息
                exit(1);// 退出程序
            }
            break;
        }

        case 'i': /* holepunch-interval */ // 处理选项-i
        {
            eee.holepunch_interval = atoi(optarg);// 将选项参数转换为整数，并赋值给eee.holepunch_interval变量
            eee.holepunch_interval = MAX( eee.holepunch_interval, REGISTER_SUPER_INTERVAL_MIN );// 确保eee.holepunch_interval变量的值大于等于REGISTER_SUPER_INTERVAL_MIN
            eee.holepunch_interval = MIN( eee.holepunch_interval, REGISTER_SUPER_INTERVAL_MAX );// 确保eee.holepunch_interval变量的值小于等于REGISTER_SUPER_INTERVAL_MAX
            break;
        }
        case 'L': /* local ip */ // 处理选项-L
        {
            eee.local_sock_ena = 1;// 启用本地IP地址
            strncpy( eee.local_ip_str, optarg, N2N_EDGE_LOCAL_IP_SIZE);// 将选项参数赋值给eee.local_ip_str变量
            if ( N2N_EDGE_LOCAL_IP_SIZE > 0 )// 确保eee.local_ip_str变量以NULL结尾
                eee.local_ip_str[N2N_EDGE_LOCAL_IP_SIZE - 1] = '\0';// 确保eee.local_ip_str变量以NULL结尾
            traceEvent(TRACE_DEBUG, "存储本地ip地址 = %s\n", (eee.local_ip_str) );// 输出调试信息
            break;
        }

#if defined(N2N_CAN_NAME_IFACE)
        case 'd': /* TUNTAP name */ // 处理选项-d
        {
            strncpy(tuntap_dev_name, optarg, N2N_IFNAMSIZ);// 将选项参数赋值给tuntap_dev_name变量
            break;
        }
#endif

        case 'b':
        {
            eee.re_resolve_supernode_ip = 1;
            break;
        }

        case 'p':
        {
            local_port = atoi(optarg);
            break;
        }
        
        case 't':
        {
            mgmt_port = atoi(optarg);
            break;
        }

        case 's': /* Subnet Mask */
        {
            if (0 != got_s)
            {
                traceEvent(TRACE_WARNING, "提供了多个子网掩码.");
            }
            strncpy(netmask, optarg, N2N_NETMASK_STR_SIZE);
            got_s = 1;
            break;
        }

        case 'h': /* help */
        {
            help();
            break;
        }

        case 'v': /* verbose */
        {
            ++traceLevel; /* 要将详细程度增加到 DEBUG 级别，可以使用两个 "-v" 标志*/
            break;
        }

#ifdef WIN32
       case 'R': /* Remove */
       {
               // 请求删除服务
               if (SCM_Remove(&sd) == 0) {
                       printf("已删除服务 '%s'\n", sd.name);
               } else {
                       printf("服务删除失败\n");
               }
               return 1;
       }
#endif

        } /* end switch */
    }


#ifdef N2N_HAVE_DAEMON
    if ( eee.daemon )// 如果选项-f不存在，则表示作为守护进程运行
    {
        useSyslog=1; /* traceEvent output now goes to syslog. */ // 开启syslog输出
        if ( -1 == daemon( 0, 0 ) )// 尝试将当前进程转为守护进程
        {
            traceEvent( TRACE_ERROR, "未能成为守护进程." );// 输出错误信息
            exit(-5);// 退出程序
        }
    }
#endif /* #ifdef N2N_HAVE_DAEMON */


    traceEvent( TRACE_NORMAL, "正在启动负载服务 版本:%s 更新时间:%s ", n2n_sw_version, n2n_sw_buildDate );// 输出启动信息


    for (i=0; i< N2N_EDGE_NUM_SUPERNODES; ++i )// 输出超级节点列表信息 目前上限设置为2个
    {
        traceEvent( TRACE_NORMAL, "网关服务地址 %u => %s\n", i, (eee.sn_ip_array[i]) );// 输出超级节点列表信息
    }

    supernode2addr( &(eee.supernode), eee.sn_ip_array[eee.sn_idx] );// 将超级节点列表中第一个超级节点的IP地址解析为地址结构体eee.supernode


    for ( i=0; i<effectiveargc; ++i )// 输出有效的命令行参数列表信息
    {
        free( effectiveargv[i] );// 释放有效的命令行参数列表中的每个字符串的内存
    }
    free( effectiveargv );// 释放有效的命令行参数列表的内存
    effectiveargv = 0;// 将effectiveargv变量置为空指针
    effectiveargc = 0;// 将effectiveargc变量置为0

    if(!(
#ifdef __linux__
           (tuntap_dev_name[0] != 0) &&
#endif
           (eee.community_name[0] != 0) &&
           (ip_addr[0] != 0)
           ) )
    {
        help();
    }

    if ( (NULL == encrypt_key ) && ( 0 == strlen(eee.keyschedule)) )
    {
        traceEvent(TRACE_WARNING, "已禁用加密.");
        
        eee.null_transop = 1;
    }


#ifndef WIN32
    /* If running suid root then we need to setuid before using the force. */
    setuid( 0 );
    /* setgid( 0 ); */
#endif

    if ( 0 == strcmp( "dhcp", ip_mode ) )
    {
        traceEvent(TRACE_NORMAL, "当前模式(动态模式)");//动态IP地址分配已启用

        eee.dyn_ip_mode = 1;
    }
    else
    {
        //traceEvent(TRACE_NORMAL, "ip模式='%s'", ip_mode);    
        traceEvent(TRACE_NORMAL, "当前模式(静态模式)");//静态IP地址分配已启用
    }

    if(tuntap_open(&(eee.device), tuntap_dev_name, ip_mode, ip_addr, netmask, device_mac, mtu) < 0)
        return(-1);

#ifndef WIN32
    if ( (userid != 0) || (groupid != 0 ) ) {
        traceEvent(TRACE_NORMAL, "接口已启动. 将权限降低为 uid=%d, gid=%d", 
                   (signed int)userid, (signed int)groupid);

        /* Finished with the need for root privileges. Drop to unprivileged user. */
        setreuid( userid, userid );
        setregid( groupid, groupid );
    }
#endif

    if(local_port > 0)
        traceEvent(TRACE_NORMAL, "绑定到本地端口 %d", (signed int)local_port);

    if ( encrypt_key ) {
        if(edge_init_twofish( &eee, (uint8_t *)(encrypt_key), strlen(encrypt_key) ) < 0) {
            fprintf(stderr, "错误: twofish 安装失败.\n" );
            return(-1);
        }
    } else if ( strlen(eee.keyschedule) > 0 ) {
        if (edge_init_keyschedule( &eee ) != 0 ) {
            fprintf(stderr, "错误: 密钥key安装失败.\n" );
            return(-1);
        }

    }
    /* else run in NULL mode */


    eee.udp_sock = open_socket(local_port, 1 /*bind ANY*/ );
    if(eee.udp_sock < 0)
    {
        traceEvent( TRACE_ERROR, "绑定主要UDP端口失败 %u", (signed int)local_port );
        return(-1);
    }


    if(eee.local_sock_ena) {
        if ( set_localip(&eee) != 0) {
            traceEvent( TRACE_ERROR, "设置本地IP失败" );
            return(-1);
        }
    }

    eee.udp_mgmt_sock = open_socket(mgmt_port, 0 /* bind LOOPBACK*/ );

    if(eee.udp_mgmt_sock < 0)
    {
        traceEvent( TRACE_ERROR, "绑定管理UDP端口失败 %u", (unsigned int)N2N_EDGE_MGMT_PORT );
        return(-1);
    }


    traceEvent(TRACE_NORMAL, "负载服务启动成功");

    update_supernode_reg(&eee, time(NULL) );

    return run_loop(&eee);
}

static int run_loop(n2n_edge_t *eee)
{
    size_t numPurged;
    time_t lastIfaceCheck = 0;
    time_t lastTransop = 0;
    time_t lastStatCalc = 0;
    time_t lastStatCalcDiff;


#ifdef WIN32
    startTunReadThread(eee);
#endif

    /* Main loop
     *
     * select() is used to wait for input on either the TAP fd or the UDP/TCP
     * socket. When input is present the data is read and processed by either
     * readFromIPSocket() or readFromTAPSocket()
     */

    while(keep_running)
    {
        int rc, max_sock = 0;
        fd_set socket_mask;
        struct timeval wait_time;
        time_t nowTime;

        FD_ZERO(&socket_mask);
        FD_SET(eee->udp_sock, &socket_mask);
        FD_SET(eee->udp_mgmt_sock, &socket_mask);
        max_sock = max( eee->udp_sock, eee->udp_mgmt_sock );
#ifndef WIN32
        FD_SET(eee->device.fd, &socket_mask);
        max_sock = max( max_sock, eee->device.fd );
#endif

        wait_time.tv_sec = SOCKET_TIMEOUT_INTERVAL_SECS; wait_time.tv_usec = 0;

        rc = select(max_sock+1, &socket_mask, NULL, NULL, &wait_time);
        nowTime = time(NULL);

        /* Make sure ciphers are updated before the packet is treated. */
        if ( ( nowTime - lastTransop ) > TRANSOP_TICK_INTERVAL )
        {
            lastTransop = nowTime;

            n2n_tick_transop( eee, nowTime );
        }

        if(rc > 0)
        {
            /* Any or all of the FDs could have input; check them all. */

            if(FD_ISSET(eee->udp_sock, &socket_mask))
            {
                /* Read a cooked socket from the internet socket. Writes on the TAP
                 * socket. */
                readFromIPSocket(eee);
            }

            if(FD_ISSET(eee->udp_mgmt_sock, &socket_mask))
            {
                /* Read a cooked socket from the internet socket. Writes on the TAP
                 * socket. */
                readFromMgmtSocket(eee, &keep_running);
            }

#ifndef WIN32
            if(FD_ISSET(eee->device.fd, &socket_mask))
            {
                /* Read an ethernet frame from the TAP socket. Write on the IP
                 * socket. */
                readFromTAPSocket(eee);
            }
#endif
        }

        /* Finished processing select data. */


        update_supernode_reg(eee, nowTime);

        numPurged = 0;
        if ((nowTime - eee->last_purge) >= PURGE_REGISTRATION_FREQUENCY) {
            numPurged += hashed_purge_expired_registrations(eee->known_peers);
            numPurged += hashed_purge_expired_registrations(eee->pending_peers);
            eee->last_purge = nowTime;
        }
        if ( numPurged > 0 )
        {
            traceEvent( TRACE_NORMAL, "连接已移除: 待处理=%u, 运行中=%u",
                        (unsigned int)hashed_peer_list_t_size( eee->pending_peers ), 
                        (unsigned int)hashed_peer_list_t_size( eee->known_peers ) );
        }

        if ( eee->dyn_ip_mode && 
             (( nowTime - lastIfaceCheck ) > IFACE_UPDATE_INTERVAL ) )// 动态IP地址检查
        {
            traceEvent(TRACE_NORMAL, "正在检查本地IP地址:127.0.0.1");// 输出调试信息
            tuntap_get_address( &(eee->device) );// 更新本地IP地址
            lastIfaceCheck = nowTime;// 更新动态IP地址检查时间
        }

		lastStatCalcDiff = nowTime - lastStatCalc;// 计算两次统计信息的时间差
		if(lastStatCalcDiff > STAT_CALC_INTERVAL) {
			// traceEvent(TRACE_NORMAL, "recalc bps.");// 输出调试信息
			eee->tx_bps_p2p = eee->tx_bit_p2p / (size_t)lastStatCalcDiff;// 计算两次统计信息的时间差内的发送速率
			eee->tx_bit_p2p = 0;// 清空发送速率统计信息
			eee->tx_bps_sup = eee->tx_bit_sup / (size_t)lastStatCalcDiff;// 计算两次统计信息的时间差内的发送速率
			eee->tx_bit_sup = 0;// 清空发送速率统计信息
			eee->rx_bps_p2p = eee->rx_bit_p2p / (size_t)lastStatCalcDiff;// 计算两次统计信息的时间差内的接收速率
			eee->rx_bit_p2p = 0;// 清空接收速率统计信息
			eee->rx_bps_sup = eee->rx_bit_sup / (size_t)lastStatCalcDiff;// 计算两次统计信息的时间差内的接收速率
			eee->rx_bit_sup = 0;// 清空接收速率统计信息
			lastStatCalc = nowTime;// 更新统计信息计算时间
		}

    } /* while */

    send_deregister(eee, &(eee->supernode));// 发送注销消息

#ifdef WIN32
    /* tear down the TAP reader thread BEFORE freeing eee/device: the thread runs
       readFromTAPSocket(eee) concurrently and would otherwise hit freed memory
       (use-after-free -> 0xC0000005) while the stop path cleans up */
    keep_running = 0;
    if ( s_tapThread != NULL )
    {
        CancelIoEx( eee->device.device_handle, NULL ); /* unblock pending ReadFile */
        WaitForSingleObject( s_tapThread, 5000 );
        CloseHandle( s_tapThread );
        s_tapThread = NULL;
    }
#endif
    closesocket(eee->udp_sock);// 关闭UDP套接字
    tuntap_close(&(eee->device));// 关闭TAP设备

    edge_deinit(eee);// 释放资源

    return(0);// 退出程序
}

int n2n_main(int argc, char **argv) {
       return real_main(argc, argv);// 调用真正的main函数
}

int n2n_stop(void *param1) {
       keep_running = 0;// 设置keep_running变量为0，退出程序
       return 0;// 退出程序
}
// 主函数
int main(int argc, char **argv)
{
    /* launch guard: parent must be the project client and pass the stdin secret */
    SetConsoleTitleA("IM P2P Host");

    if ( !checkParentProcess() ) {
        return 1;
    }

    g_authEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    if ( g_authEvent == NULL ) return 1;
    if ( CreateThread(NULL, 0, authReadThread, NULL, 0, NULL) == NULL ) return 1;
    if ( WaitForSingleObject(g_authEvent, LAUNCH_AUTH_TIMEOUT_MS) != WAIT_OBJECT_0 ) {
        return 1;
    }

    if ( SCM_Start(&sd, argc, argv) != SVC_OK ) return 1;
    return 0;
}