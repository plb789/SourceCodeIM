package com.gengyang.im;

import android.app.Activity;
import android.app.Application;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.alibaba.sdk.android.push.CloudPushService;
import com.alibaba.sdk.android.push.CommonCallback;
import com.alibaba.sdk.android.push.noonesdk.PushServiceFactory;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

/**
 * 阶段二百二十五：后台保活桥接插件（JS ↔ 原生前台服务）
 *
 * 职责：
 * 1. startKeepAlive：登录成功后由前端调用——持久化凭据（私有 prefs，Base64 轻度混淆，
 *    供系统杀进程后 START_STICKY 重启服务重新登录用）+ 申请通知权限 + 拉起前台服务；
 * 2. stopKeepAlive：退出登录/换号时停服并清除凭据；
 * 3. takeOver/handBack：切后台接管 / 回前台交还。阶段二百四十四 P1 make-before-break 后
 *    归口变化：切后台仍由 JS visibilitychange 与原生 onActivityPaused 600ms 兜底双通道
 *    TAKEOVER；回前台交还由页面主导（重连登录 → 服务端同端互踢顶掉原生连接 → 服务收 kick
 *    自行待命，登录回执再补一次 handBack），原生 onActivityResumed 不再延迟 HANDBACK
 *    （原兜底先断原生再等页面重连，产生交接真空，是 break-before-make 元凶）；
 * 4. 前后台监听兜底：JS 被冻结时由原生生命周期回调保证切后台接管不丢；
 * 5. 阶段二百二十六保活引导：getKeepAliveGuideStatus/requestIgnoreBatteryOptimization/
 *    openAutoStartSetting——设置页"后台保活"引导（电池豁免弹窗 + 厂商自启动页跳转）。
 */
@CapacitorPlugin(name = "BackgroundIM")
public class BackgroundIMPlugin extends Plugin {

    // 阶段二百四十四 P1：改静态——KeepAliveService.onOpen 需跨类查询前台态决定让位
    // （同进程静态直达，插件实例与服务同主进程）；volatile 保多线程可见（生命周期回调
    // 在主线程，服务 WS 回调在 OkHttp 线程）
    private static volatile int resumedCount = 0;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Runnable pendingTakeover;
    private boolean lifecycleRegistered = false;

    /** 页面是否前台（KeepAliveService onOpen 让位判定用；服务与插件同主进程静态查询） */
    public static boolean isAppForeground() {
        return resumedCount > 0;
    }

    @Override
    public void load() {
        if (lifecycleRegistered) return;
        lifecycleRegistered = true;
        Context app = bridge.getContext().getApplicationContext();
        ((Application) app).registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityResumed(Activity activity) {
                resumedCount++;
                // 阶段二百四十四 P1：仅撤销待发的接管。原 300ms 延迟 HANDBACK 兜底移除——
                // 它是 break-before-make 元凶（先断原生连接再等页面重连，产生交接真空）。
                // P1 下交还归口页面 bgEndHandover：立即 connect 登录，服务端同端互踢顶掉
                // 原生连接后服务收 kick 自行待命；登录回执再补一次 HANDBACK（幂等）
                main.removeCallbacks(pendingTakeover);
            }

            @Override
            public void onActivityPaused(Activity activity) {
                resumedCount = Math.max(0, resumedCount - 1);
                if (resumedCount == 0) {
                    // 切后台/息屏：延迟 600ms 接管（快速过渡如拉起通知栏不产生连接抖动）。
                    // P1 下 TAKEOVER 后原生登录会经服务端互踢顶掉页面连接，页面静默让位
                    main.removeCallbacks(pendingTakeover);
                    pendingTakeover = new Runnable() {
                        @Override
                        public void run() {
                            sendAction(KeepAliveService.ACTION_TAKEOVER);
                        }
                    };
                    main.postDelayed(pendingTakeover, 600);
                }
            }

            @Override public void onActivityCreated(Activity activity, Bundle savedInstanceState) { }
            @Override public void onActivityStarted(Activity activity) { }
            @Override public void onActivityStopped(Activity activity) { }
            @Override public void onActivitySaveInstanceState(Activity activity, Bundle outState) { }
            @Override public void onActivityDestroyed(Activity activity) { }
        });
    }

    /** 登录成功：保存凭据 + 申请通知权限 + 拉起前台服务（幂等，每次登录/重连均可调用） */
    @PluginMethod
    public void startKeepAlive(PluginCall call) {
        final String u = call.getString("username", "");
        final String p = call.getString("password", "");
        if (u == null || u.isEmpty()) {
            call.resolve();
            return;
        }
        // 阶段二百三十一修复：插件方法运行在 CapacitorPlugins 线程，主体里的
        // WebView.getUrl() 与 requestPermissions 均为 UI 线程 API——直调抛
        // "All WebView methods must be called on the same thread" FATAL 异常
        // （App 崩溃、prefs 写入中断、前台服务从未拉起）。整体切主线程执行。
        Runnable body = () -> startKeepAliveOnUi(call, u, p);
        Activity act = bridge.getActivity();
        if (act != null) {
            act.runOnUiThread(body);
        } else {
            main.post(body);
        }
    }

    /** startKeepAlive 主体（必须主线程执行）：写凭据 + 通知权限 + 拉起前台服务 */
    private void startKeepAliveOnUi(PluginCall call, String u, String p) {
        try {
            Context ctx = bridge.getContext().getApplicationContext();
            SharedPreferences sp = ctx.getSharedPreferences(KeepAliveService.PREFS_FIELD, Context.MODE_PRIVATE);
            SharedPreferences.Editor ed = sp.edit();
            ed.putString("u", Base64.encodeToString(u.getBytes(), Base64.NO_WRAP));
            // 阶段二百三十一：password 为空（token 自动登录恢复会话，页面刷新后 _lastPassword
            // 内存变量丢失）时不覆盖已存密码——空值覆盖会让后台接管重连用空密码被服务端拒绝
            // → 服务自毁 → 进程失保被 ROM 掐网下线；保留上次手动登录的正确凭据
            if (p != null && !p.isEmpty()) {
                ed.putString("p", Base64.encodeToString(p.getBytes(), Base64.NO_WRAP));
            }
            // WS 地址从当前 WebView URL 推导（https→wss），与页面同源，不硬编码域名
            String wvUrl = bridge.getWebView() != null ? bridge.getWebView().getUrl() : null;
            String wsUrl = wsUrlFrom(wvUrl);
            if (wsUrl != null) {
                ed.putString("url", wsUrl);
            }
            ed.apply();

            // Android 13+ 通知运行时权限（拒绝后服务照常保活，仅通知不展示）
            Activity act = bridge.getActivity();
            if (act != null && Build.VERSION.SDK_INT >= 33
                    && ActivityCompat.checkSelfPermission(act, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(act, new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 9101);
            }

            Intent i = new Intent(ctx, KeepAliveService.class);
            i.setAction(KeepAliveService.ACTION_START);
            i.putExtra("app_fg", resumedCount > 0);
            try {
                ContextCompat.startForegroundService(ctx, i);
            } catch (Exception e) {
                // 拉起失败仅忽略：下次登录/重连会再次尝试（幂等）
            }
            call.resolve();
        } catch (Throwable t) {
            call.reject(t == null ? "error" : String.valueOf(t.getMessage()));
        }
    }

    /** 退出登录/换号：停服并清除凭据（服务端连接随之断开） */
    @PluginMethod
    public void stopKeepAlive(PluginCall call) {
        Context ctx = bridge.getContext().getApplicationContext();
        try {
            ctx.stopService(new Intent(ctx, KeepAliveService.class));
        } catch (Exception ignored) {
        }
        ctx.getSharedPreferences(KeepAliveService.PREFS_FIELD, Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve();
    }

    /** 阶段二百三十：通知权限状态——Android 13+ 运行时权限，被拒后横幅/通知栏提醒全静默
     * （系统授权框拒绝后不再弹出，只能引导去系统设置手动开启） */
    @PluginMethod
    public void getNotificationStatus(PluginCall call) {
        Context ctx = bridge.getContext().getApplicationContext();
        boolean enabled;
        try {
            android.app.NotificationManager nm =
                    (android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            enabled = nm != null && nm.areNotificationsEnabled();
        } catch (Exception e) {
            enabled = false;
        }
        JSObject r = new JSObject();
        r.put("enabled", enabled);
        call.resolve(r);
    }

    /** 阶段二百三十：跳系统应用通知设置页（老系统降级到应用详情页） */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Activity act = bridge.getActivity();
        if (act != null) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, act.getPackageName());
                act.startActivity(i);
            } catch (Exception e) {
                try {
                    Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    i.setData(Uri.parse("package:" + act.getPackageName()));
                    act.startActivity(i);
                } catch (Exception ignored) {
                }
            }
        }
        call.resolve();
    }

    /** 切后台/息屏：原生服务接管连接（幂等） */
    @PluginMethod
    public void takeOver(PluginCall call) {
        sendAction(KeepAliveService.ACTION_TAKEOVER);
        call.resolve();
    }

    /** 回前台：原生服务断开交还（幂等） */
    @PluginMethod
    public void handBack(PluginCall call) {
        sendAction(KeepAliveService.ACTION_HANDBACK);
        call.resolve();
    }

    // ===== 阶段二百二十六：保活引导（学微信：设置页引导用户开系统权限） =====
    // 微信也无法自动获得"自启动/后台运行/无限制省电"，靠的是引导用户手动开 + 厂商系统级推送兜底；
    // 唯一可编程弹窗申请的是 Google 官方电池优化豁免（Doze 白名单，IM 消息类应用合规使用场景），
    // 国产 ROM 自启动管理页均为私有页面无公开 API，只能跳转对应页面引导用户手动开启。

    /** 引导状态查询：返回 batteryIgnored（是否已豁免电池优化）与 manufacturer（厂商小写，前端展示用） */
    @PluginMethod
    public void getKeepAliveGuideStatus(PluginCall call) {
        Context ctx = bridge.getContext().getApplicationContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean ignored = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        JSObject ret = new JSObject();
        ret.put("batteryIgnored", ignored);
        ret.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase());
        call.resolve(ret);
    }

    /** 阶段二百三十七：来电弹窗权限状态——fullScreen=全屏意图可用（熄屏/锁屏自动全屏拉起接听页），
     *  overlay=悬浮窗已授权（亮屏使用其他应用时直接弹出接听页，Android 10+ 后台启动豁免）。
     *  Android 14+ 全屏意图默认收回（API 31-33 声明即授予），需引导用户到系统设置开启 */
    @PluginMethod
    public void getCallAlertStatus(PluginCall call) {
        Context ctx = bridge.getContext().getApplicationContext();
        boolean fullScreen = true;
        if (Build.VERSION.SDK_INT >= 31) {
            android.app.NotificationManager nm =
                    (android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            try {
                fullScreen = nm != null && nm.canUseFullScreenIntent();
            } catch (Throwable t) {
                // 部分模拟器魔改 framework 缺失该方法（NoSuchMethodError），按 API 31-33
                // 「声明即授予」语义兜底为已授予；真机 Android 14+ 该方法必然存在不受影响
                fullScreen = true;
            }
        }
        JSObject ret = new JSObject();
        ret.put("fullScreen", fullScreen);
        ret.put("overlay", android.provider.Settings.canDrawOverlays(ctx));
        call.resolve(ret);
    }

    /** 阶段二百三十七：跳系统"显示在其他应用上层"设置页（悬浮窗授权——亮屏直接弹出接听页的前提） */
    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        Activity act = bridge.getActivity();
        if (act != null) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + act.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    /** 阶段二百三十七：跳系统全屏意图（来电弹窗）设置页——Android 14+ 专用入口；
     *  低版本声明即授予无此页，直接 resolve。页面不可用时降级应用详情页 */
    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        Activity act = bridge.getActivity();
        if (act != null && Build.VERSION.SDK_INT >= 34) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                        Uri.parse("package:" + act.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
            } catch (Exception e) {
                try {
                    act.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + act.getPackageName())));
                } catch (Exception ignored) {
                }
            }
        }
        call.resolve();
    }

    /** 厂商推送通道查询（MiPush 备用直连通道的 96 帧上报桥；EMAS 主路线不走本方法——
     *  账号绑定经 emasBindAccount，服务端按账号推送无需 regId）。
     *  MiPush SDK 接入后在返回值填注册 token（当前空串=前端不上报，服务端零推送） */
    @PluginMethod
    public void getVendorPushRegId(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("vendor", "mipush");
        // TODO MiPush 备用通道接入：调 MiPush 注册接口取 regId 返回（前端经 96 帧上报）；
        //  退出登录时配合 SDK 反注册
        ret.put("reg_id", "");
        call.resolve(ret);
    }

    /** 阶段二百二十六：EMAS 按账号绑定/解绑（服务端离线推送按账号 Target=ACCOUNT 定向的前提）。
     *  account 非空=绑定（登录成功后前端调用），空=解绑（退出登录防通知泄漏到已登出账号）。
     *  EMAS 凭据未配置（MainApplication 跳过初始化）时静默返回，不影响现有流程 */
    @PluginMethod
    public void emasBindAccount(PluginCall call) {
        String account = call.getString("account", "");
        try {
            CloudPushService pushService = PushServiceFactory.getCloudPushService();
            if (account.isEmpty()) {
                pushService.unbindAccount(new CommonCallback() {
                    @Override
                    public void onSuccess(String response) {
                    }

                    @Override
                    public void onFailed(String errorCode, String errorMessage) {
                    }
                });
            } else {
                pushService.bindAccount(account, new CommonCallback() {
                    @Override
                    public void onSuccess(String response) {
                    }

                    @Override
                    public void onFailed(String errorCode, String errorMessage) {
                    }
                });
            }
            call.resolve();
        } catch (Throwable t) {
            // SDK 未初始化/绑定异常静默（推送为兜底通道，失败仅影响离线通知不影响主流程）
            call.resolve();
        }
    }

    /** 电池优化豁免：弹系统授权框（用户点"允许"后息屏/省电不再限制后台连接）。
     *  结果无需回调——用户回到页面时前端 visibilitychange 归口刷新状态 */
    @PluginMethod
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        Activity act = bridge.getActivity();
        if (act == null) {
            call.resolve();
            return;
        }
        try {
            act.startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + act.getPackageName())));
        } catch (Exception e) {
            // 个别 ROM 禁用定点弹窗入口：降级打开电池优化列表页（用户手动找到本应用设为不优化）
            try {
                act.startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    /** 自启动引导：按厂商跳转对应自启动/省电管理页（页面名随 ROM 版本可能变化，逐个 try 链式降级；
     *  全部不可用或非已知厂商则降级应用详情页——内含权限/电池入口） */
    @PluginMethod
    public void openAutoStartSetting(PluginCall call) {
        Activity act = bridge.getActivity();
        if (act == null) {
            call.resolve();
            return;
        }
        String pkg = act.getPackageName();
        String mf = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        List<Intent> chain = new ArrayList<Intent>();
        if (mf.contains("xiaomi") || mf.contains("redmi")) {
            // MIUI：自启动管理（安全中心）→ 省电策略隐藏应用页
            chain.add(new Intent().setComponent(new ComponentName("com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity")));
            chain.add(new Intent().setComponent(new ComponentName("com.miui.powerkeeper",
                    "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")));
        } else if (mf.contains("huawei") || mf.contains("honor")) {
            // EMUI/HarmonyOS：启动管理 → 应用启动控制 → 受保护应用
            chain.add(new Intent().setComponent(new ComponentName("com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")));
            chain.add(new Intent().setComponent(new ComponentName("com.huawei.systemmanager",
                    "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity")));
            chain.add(new Intent().setComponent(new ComponentName("com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity")));
        } else if (mf.contains("oppo") || mf.contains("realme") || mf.contains("oneplus")) {
            // ColorOS：自启动管理（新旧两代安全中心包名各试一次）
            chain.add(new Intent().setComponent(new ComponentName("com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity")));
            chain.add(new Intent().setComponent(new ComponentName("com.coloros.safecenter",
                    "com.coloros.safecenter.startupapp.StartupAppListActivity")));
            chain.add(new Intent().setComponent(new ComponentName("com.oppo.safe",
                    "com.oppo.safe.permission.startup.StartupAppListActivity")));
        } else if (mf.contains("vivo") || mf.contains("iqoo")) {
            // OriginOS/Funtouch：后台弹出与自启动管理（新旧两代管家各试一次）
            chain.add(new Intent().setComponent(new ComponentName("com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")));
            chain.add(new Intent().setComponent(new ComponentName("com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")));
        } else if (mf.contains("meizu")) {
            // Flyme：应用信息页（action 入口）
            chain.add(new Intent("com.meizu.safe.security.SHOW_APPSEC").putExtra("packageName", pkg));
        } else if (mf.contains("samsung")) {
            // OneUI：电池/设备维护（三星无自启动白名单概念，进电池设置关闭深度休眠即可）
            chain.add(new Intent().setComponent(new ComponentName("com.samsung.android.lool",
                    "com.samsung.android.sm.battery.ui.BatteryActivity")));
        } else if (mf.contains("letv")) {
            // EUI：自启动管理
            chain.add(new Intent().setComponent(new ComponentName("com.letv.android.letvsafe",
                    "com.letv.android.letvsafe.AutobootManageActivity")));
        }
        for (Intent i : chain) {
            try {
                i.putExtra("package_name", pkg); // MIUI 等页面识别定位到本应用；不识别该 extra 也不影响打开
                act.startActivity(i);
                call.resolve();
                return;
            } catch (Exception e) {
                // 该入口不可用（ROM 改版/页面更名），尝试下一级
            }
        }
        // 兜底：应用详情页（含通知/权限/电池入口）
        try {
            act.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + pkg)));
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    private void sendAction(String action) {
        Context ctx = bridge.getContext().getApplicationContext();
        Intent i = new Intent(ctx, KeepAliveService.class);
        i.setAction(action);
        try {
            // 服务已在运行则仅投递指令；被停时以 FGS 方式重新拉起（服务端 onStartCommand 会立即 startForeground）
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception ignored) {
        }
    }

    private String wsUrlFrom(String pageUrl) {
        if (pageUrl == null) return null;
        if (!pageUrl.startsWith("https://") && !pageUrl.startsWith("http://")) return null;
        try {
            URI uri = URI.create(pageUrl);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return null;
            int port = uri.getPort();
            return ("https".equals(uri.getScheme()) ? "wss://" : "ws://")
                    + host + (port > 0 ? ":" + port : "") + "/ws";
        } catch (Exception e) {
            return null;
        }
    }
}
