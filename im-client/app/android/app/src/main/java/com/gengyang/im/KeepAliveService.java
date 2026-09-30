package com.gengyang.im;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.text.TextUtils;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

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
 *   切后台/息屏：WebView 主动断开（socket.js 带交接标记防重连循环），本服务用同一协议
 *               （登录帧 msg_type=7 platform='app' + 30s 心跳 msg_type=4）重新登录，
 *               实时接收消息帧并弹系统通知（文本直显、媒体类显示摘要）；
 *   回前台：插件层 handBack 通知本服务断开交还，WebView 立即重连（socket.js），
 *           交接窗口内到达的消息由服务端登录补推/历史拉取归口，不丢失。
 * 同一时刻仅一条 app 端连接，天然规避同端互踢（hub.go platform 相等即踢）。
 * 服务端零改动：本服务就是一个普通 app 端客户端。
 */
public class KeepAliveService extends Service {

    // 通知渠道：前台常驻（静音）/ 聊天消息（高优先级横幅）/ 系统提示（默认）
    private static final String CH_FG = "im_keepalive_fg";
    private static final String CH_MSG = "im_messages";
    private static final String CH_SYS = "im_system";
    private static final int FG_ID = 1001;
    private static final int SYS_ID = 1002;
    private static final int MSG_ID_BASE = 10000;
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

    @Override
    public void onCreate() {
        super.onCreate();
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
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopped = false;
        android.util.Log.i("BGSvc", "onStartCommand action=" + (intent == null ? "null(STICKY)" : intent.getAction()));
        // 每次 startForegroundService 调用都必须立即进入前台态（Android 8+ 硬性要求）
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0;
        ServiceCompat.startForeground(this, FG_ID, buildFgNotification(), type);

        if (intent == null) {
            // START_STICKY 系统重启（进程被杀后拉起）：WebView 已不在，立即接管连接
            loadCreds();
            handover = false;
            connect();
            return START_STICKY;
        }
        String action = intent.getAction();
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

    private void connect() {
        if (stopped || handover || ws != null) return;
        if (TextUtils.isEmpty(username) || TextUtils.isEmpty(wsUrl)) return;
        loginRejected = false;
        android.util.Log.i("BGSvc", "connect() 发起 user=" + username);
        Request req = new Request.Builder().url(wsUrl).build();
        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                android.util.Log.i("BGSvc", "onOpen owner=" + (webSocket == ws) + " handover=" + handover + " stopped=" + stopped);
                if (webSocket != ws) return;
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
                onLinkDown();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (webSocket != ws) return;
                onLinkDown();
            }
        });
    }

    private void onLinkDown() {
        ws = null;
        loggedIn = false;
        android.util.Log.i("BGSvc", "onLinkDown handover=" + handover + " stopped=" + stopped + " rejected=" + loginRejected);
        main.removeCallbacks(heartbeatTask);
        main.removeCallbacks(reconnectTask);
        if (!stopped && !handover && !loginRejected) {
            scheduleReconnect();
        }
    }

    private void teardown() {
        loggedIn = false;
        android.util.Log.i("BGSvc", "teardown 有连接=" + (ws != null));
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
        android.util.Log.i("BGSvc", "sendLogin 发出 user=" + username);
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

    // 30s 应用层心跳（与服务端 heartbeat_timeout 判死口径一致，前端同款）
    private void startHeartbeat() {
        main.removeCallbacks(heartbeatTask);
        main.postDelayed(heartbeatTask, 30000);
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
            main.postDelayed(this, 30000);
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
                    loggedIn = true;
                    android.util.Log.i("BGSvc", "LOGIN_RESP ok 在线");
                    reconnectDelay = 3000;
                    startHeartbeat();
                } else {
                    android.util.Log.i("BGSvc", "LOGIN_RESP fail");
                    // 登录被拒（密码错误/账号异常）：不再自动重连，提示用户回应用处理
                    loginRejected = true;
                    teardown();
                    showSysNotice("后台消息服务已停止：登录失败，请打开应用重新登录");
                }
                break;
            }
            case 9: { // ERROR
                if (m.optBoolean("kick")) {
                    android.util.Log.i("BGSvc", "被同端踢下线（kick）");
                    // 同端被踢：正常为回前台交接时 WebView 登录顶掉本连接（或他处新 app 登录）。
                    // 置 handover 进入待命态：断开且不自动重连，等下一次 TAKEOVER 再接管，
                    // 避免"本服务 ↔ 新登录端"双方自动重连互踢循环
                    handover = true;
                    teardown();
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
                showMsgNotice(from, "好友申请", from + "：" + m.optString("content", "请求加为好友"), 0);
                break;
            }
            case 75: { // 群邀请通知
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    String inviter = info.optString("from_name", from);
                    showMsgNotice(from, "群聊邀请", inviter + " 邀请你加入群聊「" + info.optString("name", "") + "」", 0);
                } catch (Exception ignored) {
                }
                break;
            }
            case 84: { // 公告发布推送
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    showMsgNotice("", "公告发布", info.optString("title", "") + "　" + info.optString("digest", ""), 0);
                } catch (Exception ignored) {
                }
                break;
            }
            case 45: { // AI 回复完成（流式增量 44 忽略，仅终态通知）
                if ("error".equals(m.optString("remark", ""))) break;
                showMsgNotice(from, displayName(from, null), truncate(m.optString("content", "")), 0);
                break;
            }
            case 70: { // 通话信令：仅邀请弹通知（其余动作前台 UI 归口）
                try {
                    JSONObject info = new JSONObject(m.optString("content", "{}"));
                    if ("invite".equals(info.optString("action"))) {
                        boolean video = "video".equals(info.optString("call_type", "audio"));
                        showMsgNotice(from, "通话邀请", from + " 邀请你" + (video ? "视频通话" : "语音通话"), 0);
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
        showMsgNotice(target, title, body, m.optLong("timestamp", 0));
    }

    private void showMsgNotice(String target, String title, String body, long ts) {
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
        Notification n = new NotificationCompat.Builder(this, CH_MSG)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setWhen(ts > 0 ? ts * 1000 : System.currentTimeMillis())
                .setContentIntent(pi)
                .build();
        // 同会话通知复用同一 id 顶替（微信同款：连续消息不堆积，显示最新一条）
        int id = MSG_ID_BASE + Math.abs((target == null ? "" : target).hashCode()) % 100000;
        try {
            nm.notify(id, n);
        } catch (Exception ignored) {
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
