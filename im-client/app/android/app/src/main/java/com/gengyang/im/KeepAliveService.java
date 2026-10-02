package com.gengyang.im;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
// 阶段二百三十七：来电邀请全屏意图通知（渠道铃声属性 + 全屏意图权限查询）
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Base64;
// 阶段二百三十八：来电通知卡片（头像位图圆形裁剪）
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
// 微信同款来电通知：系统 CallStyle 模板 + Person（头像随 Person 渲染大圆标）
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.io.InputStream;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * 阶段二百二十五：后台保活前台服务（微信同款后台收消息）
 *
 * 根因：Android 切后台/息屏后 WebView 网络与 JS 定时器被系统冻结（Doze/厂商省电），
 * WebView 内 30s 心跳发不出，服务端 90s 判死断线，纯 Web 层无法对抗。
 * 方案：原生前台服务（remoteMessaging 类型）在后台期间接管长连接——
 *   阶段二百四十四 P1 make-before-break（交接真空归零）：
 *   切后台/息屏：页面连接不主动断开，本服务 TAKEOVER 后以同一协议（登录帧 msg_type=7
 *               platform='app' + 30s 心跳 msg_type=4）登录，服务端同端互踢自动顶掉
 *               页面连接（页面静默让位），实时接收消息帧并弹系统通知；弱网下本服务
 *               连不上时页面连接保持在线，消息经页面连接不丢（优于先断后建）；
 *   回前台：页面立即重连登录，服务端同端互踢顶掉本连接（收 kick 置 handover 待命
 *           不重连），页面登录回执再补一次 HANDBACK（幂等，兼撤来电通知）。
 *           本服务 onOpen 时检测页面在前台（isAppForeground）则让位不发登录帧，
 *           防反向互踢页面连接引发乒乓。
 * 同一时刻仅一条 app 端连接，由服务端同端互踢（hub.go platform 相等即踢）收敛保证。
 * 服务端零改动：本服务就是一个普通 app 端客户端。
 */
public class KeepAliveService extends Service {

    // 通知渠道：前台常驻（静音）/ 聊天消息（高优先级横幅）/ 系统提示（默认）/ 通话邀请（来电铃声+振动）
    private static final String CH_FG = "im_keepalive_fg";
    private static final String CH_MSG = "im_messages";
    private static final String CH_SYS = "im_system";
    // 阶段二百三十七：通话邀请渠道（CATEGORY_CALL + 来电铃声循环 + 振动，微信来电同款提醒强度）
    private static final String CH_CALL = "im_calls";
    private static final int FG_ID = 1001;
    private static final int SYS_ID = 1002;
    // 阶段二百三十七：来电邀请通知固定 id（同一时刻仅一路来电，新邀请顶替旧通知）
    public static final int CALL_NOTIFY_ID = 1003;
    /** 阶段二百五十：无 FSI 兜底来电卡片 id（vivo 等 ROM「锁屏显示/后台弹出」默认拒绝时
     * FSI 全屏页被拦且通知被消费 → 空亮屏无任何来电提示；无 FSI 通知不受影响锁屏可见） */
    public static final int CALL_NOTIFY_FALLBACK_ID = 1004;

    /** 撤下来电通知归口（主卡 + 兜底卡一起撤，接听/挂断/取消/超时共用） */
    static void cancelCallCards(NotificationManager nm) {
        if (nm == null) return;
        try {
            nm.cancel(CALL_NOTIFY_ID);
        } catch (Exception ignored) {
        }
        try {
            nm.cancel(CALL_NOTIFY_FALLBACK_ID);
        } catch (Exception ignored) {
        }
    }

    /**
     * 阶段二百五十：无 FSI 兜底来电卡（普通样式，非 CallStyle）——vivo OriginOS 对
     * CallStyle 通话模板做 ROM 级拦截（转自有来电 UI 需厂商权限），锁屏不显示；普通
     * 消息通知样式与"已取消xx通话"消息卡完全同构，实测锁屏可显。点卡片走接听深链
     */
    private Notification buildFallbackCard(String name, String body, PendingIntent piAccept, String channel) {
        return new NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(name)
                .setContentText(body)
                // 阶段二百五十二：不再设 CATEGORY_CALL/ongoing——vivo 对"通话类"通知有 ROM
                // 级管控（CallStyle 被拦转自有来电 UI 同源），兜底卡须与消息通知最大同构
                // （消息通知 vivo 实测锁屏可显）
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(piAccept) // 点卡片=接听（锁屏直显来电页自动接听）
                .build();
    }
    private static final int MSG_ID_BASE = 10000;
    // 阶段二百三十七：当前响铃中的通话邀请 call_id——后续 cancel/dismiss/timeout 等帧据此撤通知
    private volatile String ringingCallId;
    // 阶段二百四十七：息屏来电原生响铃（微信同款循环铃声+振动）。根因：悬浮窗已授权时来电
    // 走一级路径直接 startActivity 不落通知（渠道铃声从未播放），且息屏时 WebView 冻结、
    // 页内 WebAudio 响铃不可用 → 息屏整程静音。改由原生循环播放+振动，接听/挂断/取消/
    // 超时/交还即停。CH_CALL_QUIET 为息屏专用静音渠道（铃声原生播，避免渠道铃声叠加双响）
    private static final String CH_CALL_QUIET = "im_calls_native";
    private MediaPlayer ringPlayer;
    private Vibrator ringVibrator;
    private final Runnable ringStopTask = this::stopRingtone;
    // 阶段二百三十八：运行实例静态桥（通知挂断钮广播直达信令用，onCreate/onDestroy 对称维护）
    private static volatile KeepAliveService self;
    // 凭据存储名（插件层 startKeepAlive 写入、本服务 loadCreds 读取，公共常量）
    public static final String PREFS_FIELD = "im_bg_keepalive";

    // 插件层下发指令（startKeepAlive/takeOver/handBack 经 Intent action 归口）
    public static final String ACTION_START = "com.gengyang.im.bg.START";
    public static final String ACTION_TAKEOVER = "com.gengyang.im.bg.TAKEOVER";
    public static final String ACTION_HANDBACK = "com.gengyang.im.bg.HANDBACK";

    private final Handler main = new Handler(Looper.getMainLooper());
    private OkHttpClient http;
    // 阶段二百三十：息屏 CPU 休眠会冻结 Handler 定时器——30s 应用层心跳与 OkHttp 25s 协议层
    // ping 全部发不出，服务端约 90s 判死断线（现象即"息屏一会就下线"）。接管期间持 PARTIAL
    // WakeLock 保 CPU 运行（前台服务静音常驻场景，微信同款做法）；交还/销毁时对称释放。
    private PowerManager.WakeLock wakeLock;
    private volatile WebSocket ws;
    private volatile String username;
    private volatile String password;
    private volatile String wsUrl;
    private volatile boolean loggedIn;   // 已完成登录（LOGIN_RESP ok）
    private volatile boolean handover;   // 前台交还期：暂停连接（WebView 持有连接）
    private volatile boolean stopped;    // stopKeepAlive 后彻底停止
    private volatile boolean loginRejected; // 登录被拒（密码错误/封禁等）：不再自动重连
    private int reconnectDelay = 3000;

    // 群名/好友显示名映射（登录后由 73 群列表同步/22 好友列表帧维护，通知标题用）
    private final Map<Integer, String> groupNames = new HashMap<>();
    private final Map<String, String> friendNames = new HashMap<>();
    // 阶段二百三十八：好友头像相对路径映射（好友列表帧 22 携带，来电卡片头像装载用）
    private final Map<String, String> friendAvatars = new HashMap<>();
    // 阶段二百四十六：消息通知头像（微信同款）——圆形头像位图缓存（连续消息免重复拉取）
    // + 会话维度通知序号（连续消息顶替时作废在途头像回填任务，防旧内容覆盖新通知）
    private final Map<String, Bitmap> noticeAvatarCache = new ConcurrentHashMap<>();
    private final Map<String, Long> noticeSeq = new ConcurrentHashMap<>();
    private final AtomicLong noticeSeqGen = new AtomicLong();
    // 阶段二百五十一：后台期间桌面角标未读累加计数（页面回前台后由会话未读总数精确校准）
    private final AtomicInteger badgeCount = new AtomicInteger(0);
    // 阶段二百五十二：standby 复位兜底——被踢待命 5 秒未见 HANDBACK 且页面非前台时
    // 自动重连接管（防"页面被锁屏冻结 + 服务永久待命"双离线）
    private final Runnable standbyRetry = this::standbyReclaim;
    private volatile boolean handBackSeen;
    // 阶段二百五十二：网络恢复侦测回调（onCreate 注册、onDestroy 对称注销）
    private ConnectivityManager.NetworkCallback netCallback;

    @Override
    public void onCreate() {
        super.onCreate();
        self = this; // 阶段二百三十八：静态桥登记（通知挂断钮广播直达信令）
        ensureChannels();
        http = new OkHttpClient.Builder()
                .pingInterval(25, TimeUnit.SECONDS)     // WS 协议层 ping，防 NAT/代理掐空闲链路
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)  // 长连接不设读超时
                .build();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "im:keepalive");
            wakeLock.setReferenceCounted(false); // 非计数锁：acquire/release 一对一，避免重复 acquire 泄漏
        }
        // 阶段二百五十二：网络恢复侦测——vivo OriginOS 等会掐后台应用网络（即使亮屏），
        // 掐网期间指数退避重连全失败且 delay 涨到 60s 封顶；网络恢复时立即重连回线，
        // 消除恢复后最长 60 秒的离线空窗（MuMu 无此限制所以模拟器不复现）
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) {
                netCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        main.post(new Runnable() {
                            @Override
                            public void run() {
                                if (stopped || handover || ws != null) return;
                                android.util.Log.i("BGIM", "network available -> immediate connect");
                                reconnectDelay = 3000; // 退避复位：恢复后从头递增
                                main.removeCallbacks(reconnectTask);
                                connect();
                            }
                        });
                    }
                };
                cm.registerNetworkCallback(new NetworkRequest.Builder().build(), netCallback);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopped = false;
        // 每次 startForegroundService 调用都必须立即进入前台态（Android 8+ 硬性要求）。
        // 阶段二百五十二：叠加 mediaPlayback 类型——vivo OriginOS 实测对后台应用整进程
        // cgroup 冻结（切后台 20s freeze=1，心跳停 → CDN 30s 空闲掐连接 → 离线，
        // WakeLock 无效），媒体类前台服务获 freezer 豁免；34+ 组合 remoteMessaging
        //（消息类）与 mediaPlayback（响铃播音频，语义成立）
        int type;
        if (Build.VERSION.SDK_INT >= 34) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                    | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        } else if (Build.VERSION.SDK_INT >= 29) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        } else {
            type = 0;
        }
        ServiceCompat.startForeground(this, FG_ID, buildFgNotification(), type);

        if (intent == null) {
            // START_STICKY 系统重启（进程被杀后拉起）：WebView 已不在，立即接管连接
            loadCreds();
            handover = false;
            connect();
            return START_STICKY;
        }
        String action = intent.getAction();
        android.util.Log.i("BGIM", "onStartCommand action=" + action);
        if (ACTION_START.equals(action)) {
            loadCreds();
            boolean appFg = intent.getBooleanExtra("app_fg", true);
            if (appFg) {
                // 前台登录场景：服务待命不连接（连接归 WebView），等切后台再接管
                handover = true;
                teardown();
            } else {
                handover = false;
                connect();
            }
        } else if (ACTION_TAKEOVER.equals(action)) {
            // 切后台/息屏：接管长连接（持 WakeLock 保 CPU，防息屏心跳冻结）
            handover = false;
            main.removeCallbacks(reconnectTask);
            main.removeCallbacks(standbyRetry); // 阶段二百五十二：新接管流程复位待命兜底
            if (wakeLock != null) {
                // 带超时兜底防极端场景泄漏：12 小时后自动失效（正常使用远不会到）
                if (Build.VERSION.SDK_INT >= 28) wakeLock.acquire(12 * 3600 * 1000L);
                else wakeLock.acquire();
            }
            connect();
        } else if (ACTION_HANDBACK.equals(action)) {
            // 回前台：断开交还 WebView
            handover = true;
            main.removeCallbacks(reconnectTask);
            // 阶段二百五十二：页面已交还成功（前台交接主路径闭环），取消待命自动复位兜底
            handBackSeen = true;
            main.removeCallbacks(standbyRetry);
            // 阶段二百三十七：交还前台时撤下来电通知——前台响铃画面由 WebView 经深链路由展示，
            // 通知残留会与页内响铃条重复；后续信令（cancel/超时）归口 WebView 处理
            ringingCallId = null;
            stopRingtone(); // 页内响铃条接管响铃，停原生循环铃声（阶段二百四十七）
            // 阶段二百五十：主卡 + 无 FSI 兜底卡一并撤（cancelCallCards 归口）
            cancelCallCards(getSystemService(NotificationManager.class));
            teardown();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        if (self == this) self = null; // 阶段二百三十八：静态桥对称注销
        stopRingtone(); // 服务销毁停原生响铃（阶段二百四十七）
        // 阶段二百五十一：服务销毁（登出/换号）清桌面角标（未读计数随会话上下文失效）
        badgeCount.set(0);
        try {
            BadgeHelper.apply(this, 0);
        } catch (Exception ignored) {
        }
        // 阶段二百五十二：网络恢复侦测回调对称注销
        if (netCallback != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(netCallback);
            } catch (Exception ignored) {
            }
            netCallback = null;
        }
        main.removeCallbacksAndMessages(null);
        teardown();
        super.onDestroy();
    }

    // ===== 凭据 =====

    private void loadCreds() {
        SharedPreferences sp = getSharedPreferences(PREFS_FIELD, MODE_PRIVATE);
        try {
            String u = sp.getString("u", "");
            String p = sp.getString("p", "");
            username = u.isEmpty() ? "" : new String(Base64.decode(u, Base64.NO_WRAP), "UTF-8");
            password = p.isEmpty() ? "" : new String(Base64.decode(p, Base64.NO_WRAP), "UTF-8");
        } catch (Exception e) {
            username = "";
            password = "";
        }
        wsUrl = sp.getString("url", "");
        if (TextUtils.isEmpty(username) || TextUtils.isEmpty(wsUrl)) {
            // 凭据缺失（异常状态）：无法工作，自毁；下次登录时插件会重新拉起
            stopSelf();
        }
    }

    // ===== 连接 =====

    /** 阶段二百五十二：standby 复位兜底主体——被踢待命 5 秒后未见 HANDBACK 且页面非前台
     * （页面已被锁屏/息屏冻结，无人在线）时自动重连接管；onOpen 内的前台让位检查仍生效，
     * 页面前台场景不会误抢线 */
    private void standbyReclaim() {
        if (stopped || !handover || handBackSeen) return;
        if (BackgroundIMPlugin.isAppForeground()) return; // 前台交接正常进行中，等 handBack
        android.util.Log.i("BGIM", "standby reclaim: no handback & app bg -> retake");
        handover = false;
        connect();
    }

    private void connect() {
        if (stopped || handover || ws != null) return;
        if (TextUtils.isEmpty(username) || TextUtils.isEmpty(wsUrl)) return;
        loginRejected = false;
        android.util.Log.i("BGIM", "connect: " + wsUrl);
        Request req = new Request.Builder().url(wsUrl).build();
        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (webSocket != ws) return;
                android.util.Log.i("BGIM", "onOpen fg=" + BackgroundIMPlugin.isAppForeground());
                // 阶段二百四十四 P1 make-before-break 缺口修复：连接刚建立时若页面已回前台
                // （竞态：切后台瞬间插件 600ms 兜底 TAKEOVER 已入队，用户立即切回），此时发登录帧
                // 会被服务端同端互踢用于顶掉页面连接——与页面 bgEndHandover 的重连形成反向互踢
                // 乒乓。检测到页面在前台则让位：不发登录帧，进入待命态（等下次 TAKEOVER 再接管）
                if (BackgroundIMPlugin.isAppForeground()) {
                    handover = true;
                    teardown();
                    return;
                }
                sendLogin(webSocket);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (webSocket != ws) return;
                handleFrame(text);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (webSocket != ws) return;
                android.util.Log.i("BGIM", "onClosed code=" + code + " reason=" + reason);
                onLinkDown();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (webSocket != ws) return;
                android.util.Log.i("BGIM", "onFailure: " + t);
                onLinkDown();
            }
        });
    }

    private void onLinkDown() {
        ws = null;
        loggedIn = false;
        main.removeCallbacks(heartbeatTask);
        main.removeCallbacks(reconnectTask);
        if (!stopped && !handover && !loginRejected) {
            scheduleReconnect();
        }
    }

    private void teardown() {
        loggedIn = false;
        main.removeCallbacks(heartbeatTask);
        // 交还/停止：对称释放 WakeLock（回前台后 WebView 持连接，无需保 CPU）
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
            }
        }
        WebSocket w = ws;
        ws = null;
        if (w != null) {
            try {
                w.close(1000, "handback");
            } catch (Exception ignored) {
            }
        }
    }

    private void scheduleReconnect() {
        main.removeCallbacks(reconnectTask);
        main.postDelayed(reconnectTask, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60000); // 指数退避 3s→60s 封顶
    }

    private final Runnable reconnectTask = new Runnable() {
        @Override
        public void run() {
            connect();
        }
    };

    private void sendLogin(WebSocket webSocket) {
        try {
            JSONObject login = new JSONObject();
            login.put("msg_type", 7);
            login.put("from_user", username);
            login.put("content", password == null ? "" : password);
            login.put("platform", "app"); // app 端身份：与 WebView 同端互斥，保证同一时刻仅一条连接
            webSocket.send(login.toString());
        } catch (Exception ignored) {
        }
    }

    // 15s 应用层心跳（前端同款。阶段二百四十五：CDN 侧 WS 空闲超时已从 60s 收紧至 30s，
    // 原 30s 心跳与阈值零裕度压线——挂机 30s 后的首个上行帧即触发 CDN 1006 静默断连，
    // 帧发往死连接导致红包领取等操作超时误报「网络异常」。加密至 15s 留 2 倍裕度，
    // 仍远小于服务端 heartbeat_timeout 判死口径）
    private void startHeartbeat() {
        main.removeCallbacks(heartbeatTask);
        main.postDelayed(heartbeatTask, 15000);
    }

    private final Runnable heartbeatTask = new Runnable() {
        @Override
        public void run() {
            WebSocket w = ws;
            if (w != null && loggedIn) {
                try {
                    w.send(new JSONObject().put("msg_type", 4).toString());
                } catch (Exception ignored) {
                }
            }
            main.postDelayed(this, 15000);
        }
    };

    // ===== 帧处理与通知 =====

    private void handleFrame(String text) {
        JSONObject m;
        try {
            m = new JSONObject(text);
        } catch (Exception e) {
            return;
        }
        int t = m.optInt("msg_type", 0);
        String from = m.optString("from_user", "");
        switch (t) {
            case 8: { // LOGIN_RESP
                String content = m.optString("content", "");
                boolean ok = false;
                try {
                    ok = "ok".equals(new JSONObject(content).optString("result"));
                } catch (Exception e) {
                    ok = "ok".equals(content);
                }
                if (ok) {
                    android.util.Log.i("BGIM", "LOGIN_RESP ok");
                    loggedIn = true;
                    reconnectDelay = 3000;
                    startHeartbeat();
                } else {
                    // 登录被拒（密码错误/账号异常）：不再自动重连，提示用户回应用处理
                    android.util.Log.i("BGIM", "LOGIN_RESP rejected");
                    loginRejected = true;
                    teardown();
                    showSysNotice("后台消息服务已停止：登录失败，请打开应用重新登录");
                }
                break;
            }
            case 9: { // ERROR
                if (m.optBoolean("kick")) {
                    android.util.Log.i("BGIM", "kicked -> standby");
                    // 同端被踢：阶段二百四十四 P1 下为回前台交接的主路径——页面重连登录成功，
                    // 服务端同端互踢顶掉本连接（或他处新 app 登录）。置 handover 进入待命态：
                    // 断开且不自动重连，等下一次 TAKEOVER 再接管，页面登录回执还会补发一次
                    // HANDBACK（幂等），避免"本服务 ↔ 新登录端"双方自动重连互踢循环
                    handover = true;
                    // 阶段二百五十：锁屏来电页点接听 → 页面豁免重连互踢顶掉本连接时立即停铃
                    // （不等 HANDBACK 补停，消除互踢到 HANDBACK 之间铃声多响一小段的间隙）
                    stopRingtone();
                    teardown();
                    // 阶段二百五十二：standby 复位兜底——锁屏接听等场景页面互踢本连接后随即
                    // 被系统冻结（锁屏/息屏 WebView 冻结），切后台事件早已消费不会再产生
                    // TAKEOVER → 无人在线被服务端判死（息屏/后台下线根因）。5 秒后若未见
                    // HANDBACK 且页面非前台，自动重连接管（服务端同端互踢顶掉已冻结的页面
                    // 连接，单连接收敛）；页面在前台则维持原交接流程等 handBack 防互踢循环
                    handBackSeen = false;
                    main.removeCallbacks(standbyRetry);
                    main.postDelayed(standbyRetry, 5000L);
                } else if (!loggedIn) {
                    loginRejected = true;
                    teardown();
                    showSysNotice("后台消息服务已停止：" + m.optString("content", "登录被拒绝"));
                }
                // 已登录态的普通 ERROR 提示帧不处理
                break;
            }
            case 22: { // 好友列表全量同步 → 好友显示名映射（通知标题用）
                try {
                    JSONArray arr = new JSONArray(m.optString("content", "[]"));
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject f = arr.optJSONObject(i);
                        if (f == null) continue;
                        String un = f.optString("username", "");
                        if (un.isEmpty()) continue;
                        String name = f.optString("name", "");
                        if (name.isEmpty()) name = f.optString("nickname", "");
                        if (name.isEmpty()) name = f.optString("remark", "");
                        if (!name.isEmpty()) friendNames.put(un, name);
                        // 阶段二百三十八：头像相对路径同帧入库（来电卡片头像装载用）
                        String av = f.optString("avatar", "");
                        if (!av.isEmpty()) friendAvatars.put(un, av);
                    }
                } catch (Exception ignored) {
                }
                break;
            }
            case 73: { // 群列表全量同步 → 群名映射（通知标题用）
                try {
                    JSONArray gs = new JSONObject(m.optString("content", "{}")).optJSONArray("groups");
                    if (gs != null) {
                        for (int i = 0; i < gs.length(); i++) {
                            JSONObject g = gs.optJSONObject(i);
                            if (g == null) continue;
                            groupNames.put(g.optInt("group_id", 0), g.optString("name", ""));
                        }
                    }
                } catch (Exception ignored) {
                }
                break;
            }
            case 1:   // 群聊文本（to_user='gN'）
            case 2: { // 私聊文本
                if (username.equals(from)) break; // 自己消息的回显不通知
                notifyChat(m, textSummary(m.optString("content", "")));
                break;
            }
            case 3: { // WS 文件链路（仅头部帧带文件名；分片数据帧跳过）
                if (username.equals(from)) break;
                if (m.optInt("chunk_index", 0) != -1) break;
                notifyChat(m, "[文件] " + m.optString("file_name", "文件"));
                break;
            }
            case 34:  // 群聊图片（HTTP 上传广播）
            case 69: { // 群聊文件
                if (username.equals(from)) break;
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    String name = info.optString("name", "");
                    notifyChat(m, t == 34 ? "[图片]" : ("[文件] " + name));
                } catch (Exception ignored) {
                }
                break;
            }
            case 86: { // 红包消息
                if (username.equals(from)) break;
                String greeting = "[红包]";
                try {
                    JSONObject rp = new JSONObject(m.optString("content", "{}")).optJSONObject("rp");
                    if (rp != null) {
                        String gr = rp.optString("greeting", "");
                        if (!gr.isEmpty()) greeting = "[红包] " + gr;
                    }
                } catch (Exception ignored) {
                }
                notifyChat(m, greeting);
                break;
            }
            case 20: { // 好友申请
                showMsgNotice(from, from, "好友申请", from + "：" + m.optString("content", "请求加为好友"), 0);
                break;
            }
            case 75: { // 群邀请通知
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    String inviter = info.optString("from_name", from);
                    showMsgNotice(from, from, "群聊邀请", inviter + " 邀请你加入群聊「" + info.optString("name", "") + "」", 0);
                } catch (Exception ignored) {
                }
                break;
            }
            case 84: { // 公告发布推送
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    showMsgNotice("", "", "公告发布", info.optString("title", "") + "　" + info.optString("digest", ""), 0);
                } catch (Exception ignored) {
                }
                break;
            }
            case 45: { // AI 回复完成（流式增量 44 忽略，仅终态通知）
                if ("error".equals(m.optString("remark", ""))) break;
                showMsgNotice(from, from, displayName(from, null), truncate(m.optString("content", "")), 0);
                break;
            }
            case 70: { // 通话信令：邀请拉起接听画面（阶段二百三十七），其余动作前台 UI 归口
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    String sigAction = info.optString("action");
                    android.util.Log.i("BGIM", "call sig action=" + sigAction + " call_id=" + info.optString("call_id", "")
                            + " ringing=" + ringingCallId);
                    if ("invite".equals(sigAction) || "meet_invite".equals(sigAction)) {
                        showCallInvite(m, info, sigAction);
                    } else if (ringingCallId != null && ringingCallId.equals(info.optString("call_id", ""))
                            && ("cancel".equals(sigAction) || "dismiss".equals(sigAction)
                                || "timeout".equals(sigAction) || "error".equals(sigAction))) {
                        // 对方取消/他端已接/超时/异常：撤下来电通知（本端未点开过则响铃只留在通知层）
                        ringingCallId = null;
                        stopRingtone(); // 停息屏原生循环响铃
                        // 阶段二百四十八：转发页面清残留响铃条——连接归原生期间页面深链拉出的
                        // 等待画面收不到 WS cancel（页面可能已被锁屏冻结），经插件事件补送
                        // （页面冻结时事件排队，解锁恢复后送达）
                        BackgroundIMPlugin.notifyCallSignal(sigAction, info.optString("call_id", ""));
                        cancelCallCards(getSystemService(NotificationManager.class));
                    }
                } catch (Exception ignored) {
                }
                break;
            }
            default:
                break; // 其余帧（名单/会话/信令等）后台不需要处理
        }
    }

    /**
     * 聊天类消息通知归口：按 to_user 是否群编码（'gN'）分流私聊/群聊样式。
     * 私聊标题=好友显示名（降级账号）；群聊标题=群名（降级"群聊"），正文=发送者：摘要。
     */
    private void notifyChat(JSONObject m, String summary) {
        String from = m.optString("from_user", "");
        String to = m.optString("to_user", "");
        boolean isGroup = to != null && to.startsWith("g");
        String target = isGroup ? to : from; // 点击跳转会话目标
        String title;
        String body;
        if (isGroup) {
            title = groupNameOf(to);
            body = displayName(from, m.optString("from_name", "")) + "：" + summary;
        } else {
            title = displayName(from, m.optString("from_name", ""));
            body = summary;
        }
        showMsgNotice(from, target, title, body, m.optLong("timestamp", 0));
    }

    private void showMsgNotice(String from, String target, String title, String body, long ts) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        // 点击跳转会话：深链 imapp://chat?to=<target>，经 App 插件 appUrlOpen 送达前端
        Intent i = new Intent(Intent.ACTION_VIEW,
                Uri.parse("imapp://chat?to=" + Uri.encode(target == null ? "" : target)),
                this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this,
                (target == null ? "" : target).hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long when = ts > 0 ? ts * 1000 : System.currentTimeMillis();
        String key = target == null ? "" : target;
        // 微信同款：会话维度通知序号——连续消息顶替时作废在途头像回填，防旧内容覆盖新通知
        long seq = noticeSeqGen.incrementAndGet();
        noticeSeq.put(key, seq);
        Bitmap avatar = noticeAvatarCache.get(from); // 缓存命中直接带头像（连续消息免重复拉取）
        int id = MSG_ID_BASE + Math.abs(key.hashCode()) % 100000;
        try {
            nm.notify(id, buildMsgNotice(title, body, when, pi, avatar));
            // 阶段二百五十一：后台期间桌面角标累加（页面回前台后由会话未读总数精确校准）
            BadgeHelper.apply(this, badgeCount.incrementAndGet());
        } catch (Exception ignored) {
        }
        if (avatar == null) fetchNoticeAvatar(from, key, id, title, body, when, pi, seq);
    }

    // 阶段二百四十六：消息通知构建归口（正文先即时展示；头像到位后同 id 原位顶替补 largeIcon）
    private Notification buildMsgNotice(String title, String body, long when, PendingIntent pi, Bitmap avatar) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_MSG)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setWhen(when)
                .setContentIntent(pi);
        if (avatar != null) b.setLargeIcon(avatar); // 微信同款圆形头像（缓存位图已圆裁）
        return b.build();
    }

    // 阶段二百四十六：消息通知头像异步回填——3s 拉不到即放弃，不影响正文通知时效；
    // 序号校验保证连续消息只由最新一条完成回填；发言人非好友/无头像时优雅降级（仅应用图标）
    private void fetchNoticeAvatar(String from, String target, int id, String title, String body,
                                   long when, PendingIntent pi, long seq) {
        String path = friendAvatars.get(from);
        if (path == null || path.isEmpty()) return;
        String full = avatarFullUrl(path);
        if (full.isEmpty()) return;
        http.newBuilder().callTimeout(3, TimeUnit.SECONDS).build()
                .newCall(new Request.Builder().url(full).build()).enqueue(new okhttp3.Callback() {
                    @Override
                    public void onFailure(okhttp3.Call c, java.io.IOException e) {
                    }

                    @Override
                    public void onResponse(okhttp3.Call c, Response resp) throws java.io.IOException {
                        Bitmap bmp = null;
                        try (InputStream is = resp.body() != null ? resp.body().byteStream() : null) {
                            if (is != null && resp.isSuccessful()) bmp = BitmapFactory.decodeStream(is);
                        } catch (Exception ignored) {
                        } finally {
                            resp.close();
                        }
                        if (bmp == null) return;
                        Bitmap circle = circleBitmap(bmp);
                        noticeAvatarCache.put(from, circle); // 留存缓存，后续该好友消息免拉取
                        KeepAliveService s = self;
                        if (s == null) return;
                        Long cur = noticeSeq.get(target);
                        if (cur == null || cur.longValue() != seq) return; // 已有更新通知：本轮回填作废
                        NotificationManager nm = getSystemService(NotificationManager.class);
                        if (nm == null) return;
                        try {
                            nm.notify(id, buildMsgNotice(title, body, when, pi, circle));
                        } catch (Exception ignored) {
                        }
                    }
                });
    }

    /**
     * 阶段二百三十七：后台来电拉起接听画面（微信同款三级降级）
     * 一级：有悬浮窗权限（SYSTEM_ALERT_WINDOW）→ Android 10+ 后台启动豁免，直接 startActivity
     *       全屏拉起接听页（亮屏使用其他应用时也立即可见，无需经通知）；
     * 二级：有全屏意图权限（USE_FULL_SCREEN_INTENT）→ 发全屏意图通知：
     *       熄屏/锁屏系统自动全屏拉起；亮屏使用中以 heads-up 横幅置顶，点击进入；
     * 三级：都无权限 → 高优先级普通通知（文字提示，行为同旧版）。
     * 拉起载体统一深链 imapp://call?...（chat.js appUrlOpen/getLaunchUrl 路由到
     * web-call-bridge 响铃条）。invite 为实时帧不落库，WebView 重连后服务端不会重推——
     * 接听画面所需字段（from/call_id/call_type/meet/ICE 配置）全部随深链透传。
     */
    private void showCallInvite(JSONObject frame, JSONObject info, String action) {
        String from = frame.optString("from_user", "");
        String callId = info.optString("call_id", "");
        if (callId.isEmpty() || from.isEmpty() || from.equals(username)) return;
        String type = "video".equals(info.optString("call_type", "audio")) ? "video" : "audio";
        boolean meet = "meet_invite".equals(action);
        String name = displayName(from, frame.optString("from_name", ""));
        StringBuilder url = new StringBuilder("imapp://call?from=")
                .append(Uri.encode(from))
                .append("&name=").append(Uri.encode(name))
                .append("&type=").append(type)
                .append("&call_id=").append(Uri.encode(callId));
        if (meet) {
            url.append("&meet=1&group_id=").append(info.optInt("group_id", 0))
               .append("&meet_no=").append(Uri.encode(info.optString("meet_no", "")));
        }
        // invite 帧注入的 ICE 配置透传（接听后 buildPC 建连用，TURN 启用时必需）
        org.json.JSONArray ice = info.optJSONArray("ice");
        if (ice != null) {
            url.append("&ice=").append(Uri.encode(ice.toString()));
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url.toString()), this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this,
                Math.abs(callId.hashCode()), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 阶段二百三十八：接听钮 = 深链带 auto=1（页面登录完成后自动接听，免先进响铃条再点）；
        // 挂断钮 = 广播直达（原生连接在线直接上 reject 信令，交还前台时退化为深链忙态拒接）
        Intent ai = new Intent(Intent.ACTION_VIEW, Uri.parse(url.toString() + "&auto=1"), this, MainActivity.class);
        ai.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent piAccept = PendingIntent.getActivity(this,
                Math.abs(callId.hashCode()) + 1, ai,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent ri = new Intent(this, CallActionReceiver.class)
                .setAction(CallActionReceiver.ACTION_REJECT)
                .putExtra("call_id", callId)
                .putExtra("from", from)
                .putExtra("meet", meet)
                .putExtra("deep", url.toString());
        PendingIntent piReject = PendingIntent.getBroadcast(this,
                Math.abs(callId.hashCode()) + 2, ri,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        ringingCallId = callId;

        // 一级：悬浮窗已授权 → 直接拉起来电页（SYSTEM_ALERT_WINDOW 豁免 Android 10+ 后台
        // 启动限制）。阶段二百五十：息屏恢复直启——MainActivity 已
        // setShowWhenLocked/setTurnScreenOn，锁屏上直接亮屏显示来电页（vivo 等 ROM 对
        // 侧载应用 FSI 权限默认拒绝，仅靠 FSI 通知息屏不亮屏无画面，实测「来电无任何通知，
        // 挂断后才看到普通消息通知」；微信息屏来电即本路径）
        PowerManager pmScreen = (PowerManager) getSystemService(POWER_SERVICE);
        boolean screenOn = pmScreen != null && pmScreen.isInteractive();
        if (Settings.canDrawOverlays(this)) {
            try {
                startActivity(i);
            } catch (Exception ignored) {
            }
        }

        // 二级：来电通知（CallStyle + FSI，FSI 被拒时降级横幅/锁屏卡片）——直启成功时并存
        // 作保险（ROM 静默拦截直启时为唯一可见入口；接听 HANDBACK/cancel/超时归口撤销）

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        String body = meet ? "邀请你加入会议" : ("邀请你" + ("video".equals(type) ? "视频通话" : "语音通话"));
        // 阶段二百五十：来电通知一律静音渠道——CH_CALL 渠道铃声与原生铃声叠加双响
        // （实测「同样的铃声双重响」：亮屏直启/FSI 路径渠道铃 + 页面 ensureCallRing/
        // 原生 startCallRing 同响）。响铃统一归口原生单一路径（下方 startCallRing，
        // 页面 showRing→ensureCallRing 幂等续响），通知只承担显示职责
        String channel = CH_CALL_QUIET;
        try {
            nm.notify(CALL_NOTIFY_ID, buildCallCard(name, body, pi, piAccept, piReject, null, channel, true));
        } catch (Exception ignored) {
        }
        // 阶段二百五十：兜底卡直接复用消息渠道 CH_MSG——vivo 真机实测：消息通知（有声
        // 渠道）锁屏可显，而来电专用无声渠道（CH_CALL_QUIET/CH_CALL_FB）一律被系统归入
        // "静默通知"折叠不显示（用户锁屏截图：系统弹「要将通知设为静默吗」，无声渠道
        // 被 ROM 静默化处理）。渠道提示音仅起始"叮"一声，随后原生铃声循环接管；
        // 点卡片走接听深链（MainActivity 已 setShowWhenLocked，锁屏直接显示来电页自动接听）
        try {
            nm.notify(CALL_NOTIFY_FALLBACK_ID, buildFallbackCard(name, body, piAccept, CH_MSG));
        } catch (Exception ignored) {
        }
        // 诊断日志：兜底卡实际渠道（CH_MSG）重要度 / 通知总开关 / FSI 权限 / 悬浮窗权限
        // （用户真机导日志定位"来电不显示"）
        try {
            NotificationChannel chDbg = nm.getNotificationChannel(CH_MSG);
            boolean fsiDbg = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent();
            android.util.Log.i("BGIM", "call notify ch=" + channel
                    + " msgImp=" + (chDbg != null ? chDbg.getImportance() : -1)
                    + " chEnabled=" + nm.areNotificationsEnabled()
                    + " fsi=" + fsiDbg + " overlay=" + Settings.canDrawOverlays(this));
        } catch (Exception ignored) {
        }
        fetchAvatarAsync(from, callId, name, body, pi, piAccept, piReject, channel);
        // 阶段二百五十：响铃统一归口原生（亮屏/息屏一致，渠道已全部静音防双响；
        // 页面 showRing→ensureCallRing 幂等续响，接听/挂断/超时即停）
        startCallRing();
        if (!screenOn) {
            // 阶段二百五十：亮屏兜底——FSI 权限缺失（Android 14+ 默认不授予非通话类应用）
            // 时系统不亮屏不弹全屏，锁屏界面对通知静默，用户感知"只有铃声没有画面"。
            // 主动点亮屏幕 5 秒展示锁屏来电卡片（配合 MainActivity setShowWhenLocked/
            // setTurnScreenOn；FSI 正常生效时系统已亮屏，此处幂等无害）
            try {
                PowerManager pmWake = (PowerManager) getSystemService(POWER_SERVICE);
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock wl = pmWake.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                | PowerManager.ON_AFTER_RELEASE,
                        "im:callScreenWake");
                wl.acquire(5000L);
            } catch (Exception ignored) {
            }
        }
    }

    // 微信同款来电通知：整卡交由系统渲染（统一系统背景，无白边）。
    // 根因备注：旧版自定义 RemoteViews 黑色卡片会被系统模板在外层包一层系统装饰底板
    // （Android 12+ heads-up 为动态取色浅色底），黑卡浮在浅色底上出现白色边框部分；
    // CallStyle 来电模板（大圆头像 + 主叫名 + 副标题 + 系统红/绿挂断接听按钮）即微信效果。
    private Notification buildCallCard(String name, String body, PendingIntent pi, PendingIntent piAccept,
                                       PendingIntent piReject, Bitmap avatar, String channel, boolean fullScreen) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentText(body) // CallStyle 模板副标题（「邀请你视频通话/语音通话」）
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                // 阶段二百五十：锁屏显示完整来电卡片（默认 PRIVATE 在部分 ROM 锁屏设置下
                // 只显示"应用有通知"不显内容——FSI 未生效的降级场景通知会"看不到来电"）
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                // CallStyle 硬性要求：通知必须 ongoing，否则系统校验不通过、忽略来电模板，
                // 降级为标准通知（方形小头像 + 文字按钮）——首版实测即踩此坑
                .setOngoing(true)
                .setAutoCancel(true) // 点卡片主体仍自动消失（ongoing 仅禁滑动清除）
                .setContentIntent(pi);         // 卡片点按（非按钮）进入响铃条
        if (fullScreen) b.setFullScreenIntent(pi, true); // 熄屏/锁屏系统自动全屏拉起（兜底卡不带：
        // vivo 等 ROM FSI 消费通知后全屏页又被「锁屏显示」权限拦截 → 空亮屏无任何提示）
        if (avatar != null) b.setLargeIcon(avatar); // API <30 降级通知与人物头像共用
        if (Build.VERSION.SDK_INT >= 30) {
            Person caller = new Person.Builder()
                    .setName(name)
                    .setIcon(avatar != null ? IconCompat.createWithBitmap(avatar) : null)
                    .build();
            b.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, piReject, piAccept));
        } else {
            // Android 11 以下降级：标准通知 + 文字按钮（同样系统统一背景，无白边）
            b.setContentTitle(name);
            b.addAction(new NotificationCompat.Action.Builder(0, "挂断", piReject).build());
            b.addAction(new NotificationCompat.Action.Builder(0, "接听", piAccept).build());
        }
        return b.build();
    }

    /**
     * 阶段二百四十七：息屏来电原生循环响铃（微信同款）。息屏时 WebView 冻结、页内 WebAudio
     * 响铃不可用，且悬浮窗一级路径不落通知（渠道铃声从未播放）→ 息屏整程静音。改由原生
     * MediaPlayer 循环播放系统来电铃声（铃声音量流，息屏/后台可播）+ Vibrator 循环振动，
     * 接听交还/挂断广播/取消超时帧/兜底计时归口 stopRingtone 停止。
     */
    private synchronized void startCallRing() {
        if (ringPlayer != null) return; // 已在响铃（连续来电不重复起播）
        android.util.Log.i("BGIM", "startCallRing screen-off native ring begin");
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mp.setDataSource(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE));
            mp.setLooping(true);
            mp.setOnErrorListener((p, what, extra) -> {
                stopRingtone();
                return true;
            });
            mp.prepare(); // 本地系统铃声，同步 prepare 即可（WS 线程调用，无 UI 阻塞）
            mp.start();
            ringPlayer = mp;
        } catch (Exception e) {
            if (ringPlayer != null) {
                try {
                    ringPlayer.release();
                } catch (Exception ignored) {
                }
                ringPlayer = null;
            }
        }
        // 循环振动（振 600ms 停 500ms 三连后从头循环，与通知渠道振动同参数）
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            long[] pattern = new long[]{0, 600, 500, 600, 500, 600};
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    v.vibrate(pattern, 0);
                }
                ringVibrator = v;
            }
        } catch (Exception ignored) {
        }
        // 65s 兜底自停（正常由服务端 60s 超时帧/信令归口提前停，防连接异常时无限响铃耗电）
        main.postDelayed(ringStopTask, 65_000L);
    }

    /** 停止息屏原生响铃与振动（幂等，多来源并发调用安全） */
    private synchronized void stopRingtone() {
        android.util.Log.i("BGIM", "stopRingtone player=" + (ringPlayer != null) + " vibrator=" + (ringVibrator != null)
                + new Throwable("trace").fillInStackTrace());
        main.removeCallbacks(ringStopTask);
        if (ringPlayer != null) {
            MediaPlayer mp = ringPlayer;
            ringPlayer = null;
            try {
                mp.stop();
            } catch (Exception ignored) {
            }
            try {
                mp.release();
            } catch (Exception ignored) {
            }
        }
        if (ringVibrator != null) {
            try {
                ringVibrator.cancel();
            } catch (Exception ignored) {
            }
            ringVibrator = null;
        }
    }

    // ===== 阶段二百五十：页面侧铃声归口（web-call-bridge 经插件桥调用） =====

    /** 页面来电 UI 拉起时补起/续响原生系统铃声（已在响则幂等）。息屏来电原生已在循环响铃
     * （无缝续响），亮屏前台一级路径（startActivity 直启，不落通知）此前只有页内 WebAudio
     * 合成音——统一改由原生播系统铃声，消除"解锁进 APP 铃声突变"的音色跳变（微信全程同一种铃声） */
    static void ensureRingtone() {
        KeepAliveService s = self;
        if (s == null || s.ringPlayer != null) return;
        s.startCallRing();
    }

    /** 页面侧停铃归口（响铃条接听/挂断/60s 兜底清条时调用，幂等） */
    static void stopRingtoneStatic() {
        KeepAliveService s = self;
        if (s != null) s.stopRingtone();
    }

    /**
     * 阶段二百三十八：来电卡片头像异步装载——通知先以默认图标弹出（响铃零延迟），
     * 好友头像（好友列表帧 22 携带的 /static/avatar/ 相对路径）HTTP 拉取后圆形裁剪回填
     * 同一通知 id；拉取完成时响铃已结束（call_id 不匹配）则放弃回填，防旧头像顶替新来电
     */
    private void fetchAvatarAsync(String from, String callId, String name, String body,
                                  PendingIntent pi, PendingIntent piAccept, PendingIntent piReject,
                                  String channel) {
        String path = friendAvatars.get(from);
        if (path == null || path.isEmpty()) return;
        String full = avatarFullUrl(path);
        if (full.isEmpty()) return;
        Request req = new Request.Builder().url(full).build();
        // 独立短超时客户端：3s 拉不到即放弃，不影响保活长连接参数
        http.newBuilder().callTimeout(3, TimeUnit.SECONDS).build()
                .newCall(req).enqueue(new okhttp3.Callback() {
                    @Override
                    public void onFailure(okhttp3.Call c, java.io.IOException e) {
                    }

                    @Override
                    public void onResponse(okhttp3.Call c, Response resp) throws java.io.IOException {
                        Bitmap bmp = null;
                        try (InputStream is = resp.body() != null ? resp.body().byteStream() : null) {
                            if (is != null && resp.isSuccessful()) bmp = BitmapFactory.decodeStream(is);
                        } catch (Exception ignored) {
                        } finally {
                            resp.close();
                        }
                        if (bmp == null) return;
                        // 响铃已结束/已被新邀请顶替（call_id 不匹配）则放弃回填
                        KeepAliveService s = self;
                        if (s == null || !callId.equals(s.ringingCallId)) return;
                        NotificationManager nm = getSystemService(NotificationManager.class);
                        if (nm == null) return;
                        try {
                            nm.notify(CALL_NOTIFY_ID, buildCallCard(name, body, pi, piAccept, piReject,
                                    circleBitmap(bmp), channel, true));
                            // 阶段二百五十：兜底卡同步回填头像（普通样式，无 FSI）
                            nm.notify(CALL_NOTIFY_FALLBACK_ID,
                                    buildFallbackCard(name, body, piAccept, channel));
                        } catch (Exception ignored) {
                        }
                    }
                });
    }

    // 阶段二百三十八：好友头像相对路径 → 绝对 URL（保活 wsUrl 的 ws/wss 协议换 http/https 取源站）
    private String avatarFullUrl(String path) {
        if (path == null || path.isEmpty()) return "";
        if (path.startsWith("http://") || path.startsWith("https://")) return path;
        if (wsUrl == null) return "";
        String base = wsUrl.startsWith("wss://") ? "https://" + wsUrl.substring(6)
                : (wsUrl.startsWith("ws://") ? "http://" + wsUrl.substring(5) : "");
        if (base.isEmpty()) return "";
        int idx = base.indexOf('/', base.indexOf("://") + 3);
        String origin = idx > 0 ? base.substring(0, idx) : base;
        return origin + (path.startsWith("/") ? path : "/" + path);
    }

    // 阶段二百三十八：位图居中裁方后圆形遮罩（RemoteViews 头像圆形展示）
    private static Bitmap circleBitmap(Bitmap src) {
        try {
            int w = src.getWidth(), h = src.getHeight();
            int side = Math.min(w, h);
            Bitmap sq = Bitmap.createBitmap(src, (w - side) / 2, (h - side) / 2, side, side);
            Bitmap out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(out);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setShader(new BitmapShader(sq, BitmapShader.TileMode.CLAMP, BitmapShader.TileMode.CLAMP));
            canvas.drawCircle(side / 2f, side / 2f, side / 2f, paint);
            return out;
        } catch (Exception e) {
            return src;
        }
    }

    // ===== 阶段二百三十八：通知挂断钮直达信令（静态桥，CallActionReceiver 调用） =====

    /**
     * 原生保活连接在线（后台被叫态）→ 直接上行 reject/meet_decline，熄屏/后台秒拒；
     * 返回 false 表示连接不在线（已交还前台 WebView），调用方退化走深链忙态拒接。
     * 帧结构与页面 accept 分支同构（msg_type=70 + content JSON），服务端按登录名归口。
     */
    static boolean trySendCallReject(String callId, String fromUser, boolean meet) {
        KeepAliveService s = self;
        WebSocket w = s != null ? s.ws : null;
        if (s == null || w == null || !s.loggedIn || callId == null || callId.isEmpty()) return false;
        try {
            JSONObject content = new JSONObject();
            content.put("action", meet ? "meet_decline" : "reject");
            content.put("call_id", callId);
            if (!meet) content.put("reason", "declined");
            JSONObject frame = new JSONObject();
            frame.put("msg_type", 70);
            frame.put("from_user", s.username);
            frame.put("to_user", meet ? "" : (fromUser == null ? "" : fromUser));
            frame.put("content", content.toString());
            return w.send(frame.toString());
        } catch (Exception e) {
            return false;
        }
    }

    // 阶段二百三十八：通知挂断后清响铃标记（callId 为空或匹配当前响铃才清，防误清新邀请）
    static void clearRingingCall(String callId) {
        KeepAliveService s = self;
        if (s != null && (callId == null || callId.equals(s.ringingCallId))) {
            s.ringingCallId = null;
            s.stopRingtone(); // 挂断即停息屏原生循环响铃（阶段二百四十七）
        }
    }

    private void showSysNotice(String body) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CH_SYS)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("即时通讯")
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        try {
            nm.notify(SYS_ID, n);
        } catch (Exception ignored) {
        }
    }

    private Notification buildFgNotification() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 1, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CH_FG)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("即时通讯")
                .setContentText("后台保持在线，消息实时送达")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(pi)
                .build();
    }

    private void ensureChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel fg = new NotificationChannel(CH_FG, "后台在线", NotificationManager.IMPORTANCE_MIN);
        fg.setDescription("保持后台连接，保证消息实时送达");
        nm.createNotificationChannel(fg);
        NotificationChannel msg = new NotificationChannel(CH_MSG, "聊天消息", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("收到新消息时提醒");
        nm.createNotificationChannel(msg);
        NotificationChannel sys = new NotificationChannel(CH_SYS, "系统提示", NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(sys);
        // 阶段二百三十七：通话邀请渠道（微信来电同款：CATEGORY_CALL + 来电铃声循环 + 振动三连）
        NotificationChannel call = new NotificationChannel(CH_CALL, "通话邀请", NotificationManager.IMPORTANCE_HIGH);
        call.setDescription("收到语音/视频通话邀请时提醒");
        call.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        call.enableVibration(true);
        call.setVibrationPattern(new long[]{0, 600, 500, 600, 500, 600});
        nm.createNotificationChannel(call);
        // 阶段二百四十七：息屏来电专用静音渠道——铃声/振动改由应用原生循环播放（微信同款，
        // 渠道铃声只响一次且悬浮窗一级路径下从不播放），渠道自身静音避免与原生铃声叠加双响；
        // IMPORTANCE_HIGH 保持全屏意图（熄屏自动亮屏拉起）可用
        NotificationChannel callQuiet = new NotificationChannel(CH_CALL_QUIET, "来电通知", NotificationManager.IMPORTANCE_HIGH);
        callQuiet.setDescription("收到语音/视频通话邀请时由应用循环响铃（支持息屏响铃）");
        callQuiet.setSound(null, null);
        callQuiet.enableVibration(false);
        nm.createNotificationChannel(callQuiet);
    }

    // ===== 显示名与摘要 =====

    private String displayName(String username, String fromName) {
        if (fromName != null && !fromName.isEmpty()) return fromName;
        String name = friendNames.get(username);
        return (name == null || name.isEmpty()) ? username : name;
    }

    private String groupNameOf(String target) {
        // target 形如 'gN'，解析 N 查群名映射，降级"群聊"
        try {
            int gid = Integer.parseInt(target.substring(1));
            String name = groupNames.get(gid);
            return (name == null || name.isEmpty()) ? "群聊" : name;
        } catch (Exception e) {
            return "群聊";
        }
    }

    /**
     * 文本摘要归口：引用消息取回复正文；AI 图片信封显示[图片]；其余原样（截断 120 字）。
     * 与服务端 messageSummary 口径一致，JSON 原串不外泄到通知。
     */
    private String textSummary(String content) {
        String s = content == null ? "" : content.trim();
        try {
            JSONObject env = new JSONObject(s);
            if (env.has("quote") && env.has("text")) {
                s = env.optString("text", "");
            } else if (env.has("image")) {
                String note = env.optString("text", "");
                s = note.isEmpty() ? "[图片]" : "[图片] " + note;
            } else if ("call".equals(env.optString("type"))) {
                // 阶段二百三十八：通话信封消息渲染可读文案（此前未接来电通知裸显 JSON）
                String kind = "video".equals(env.optString("call", "audio")) ? "视频通话" : "语音通话";
                switch (env.optString("status", "")) {
                    case "missed": s = "未接" + kind; break;
                    case "rejected": s = "已拒绝" + kind; break;
                    case "canceled": s = "已取消" + kind; break;
                    case "timeout": s = "对方无人接听"; break;
                    case "completed":
                        int d = env.optInt("duration", 0);
                        s = "通话时长 " + String.format(java.util.Locale.CHINA, "%d:%02d", d / 60, d % 60);
                        break;
                    default: s = kind; break;
                }
            } else if (env.has("doc")) {
                String note = env.optString("text", "");
                s = note.isEmpty() ? "[文档]" : "[文档] " + note;
            }
        } catch (Exception ignored) {
            // 非信封 JSON：普通文本原样
        }
        return truncate(s);
    }

    private String truncate(String s) {
        if (s == null) return "";
        s = s.replace('\n', ' ');
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }
}
