package com.gengyang.im;

import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.text.TextUtils;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.alibaba.sdk.android.push.CloudPushService;
import com.alibaba.sdk.android.push.CommonCallback;
import com.alibaba.sdk.android.push.noonesdk.PushServiceFactory;

/**
 * 阶段二百二十六：阿里云 EMAS 移动推送初始化（聚合推送，方案 B 主路线）。
 * 在 Application.onCreate 直接初始化（官方要求：不得包在任何进程/条件判断内）：
 * SDK 注册读 AndroidManifest 的 meta-data 凭据（com.alibaba.app.appkey/appsecret），
 * 两项均为空时跳过初始化——凭据未配置阶段全链路直通，不影响现有功能。
 * 账号绑定经 BackgroundIMPlugin.emasBindAccount（前端登录成功后调用）按用户名绑定，
 * 服务端离线推送按账号（Target=ACCOUNT）定向，无需 regId 注册表。
 */
public class MainApplication extends Application {

    private static final String TAG = "MainApplication";

    @Override
    public void onCreate() {
        super.onCreate();
        initEmasIfConfigured(this);
        resumeKeepAliveIfCredentialed(this);
    }

    /**
     * 阶段二百三十一：保活服务启动自愈——上次登录未登出（prefs 有凭据）时在进程启动
     * 即拉起前台服务。覆盖此前只依赖前端 startKeepAlive 链路的缺口：token 自动登录
     * /桥未就绪竞态等场景服务从未拉起，进程失去前台保护，切后台即被 ROM 掐网下线
     * （实测 dumpsys 佐证：服务不在运行列表、进程 oom_adj=700 CACHED）。
     * 凭据为空（未登录/已登出）不拉起；服务 onStartCommand 自身会再校验凭据。
     */
    private void resumeKeepAliveIfCredentialed(Context context) {
        try {
            SharedPreferences sp = context.getSharedPreferences(KeepAliveService.PREFS_FIELD, Context.MODE_PRIVATE);
            String u = sp.getString("u", "");
            if (TextUtils.isEmpty(u)) return;
            Intent it = new Intent(context, KeepAliveService.class);
            it.setAction(KeepAliveService.ACTION_START);
            it.putExtra("app_fg", true);
            ContextCompat.startForegroundService(context, it);
            Log.i(TAG, "保活凭据存在，启动自愈拉起 KeepAliveService");
        } catch (Throwable t) {
            Log.w(TAG, "保活服务自愈拉起失败（不阻断启动）", t);
        }
    }

    /** EMAS 凭据（Manifest meta-data）均已配置时初始化推送 SDK，否则直通返回 */
    private void initEmasIfConfigured(Context context) {
        String appKey = getMetaValue(context, "com.alibaba.app.appkey");
        String appSecret = getMetaValue(context, "com.alibaba.app.appsecret");
        if (appKey == null || appKey.isEmpty() || appSecret == null || appSecret.isEmpty()) {
            Log.i(TAG, "EMAS 凭据未配置（Manifest meta-data 为空），跳过推送 SDK 初始化");
            return;
        }
        try {
            PushServiceFactory.init(context);
            CloudPushService pushService = PushServiceFactory.getCloudPushService();
            pushService.register(context, new CommonCallback() {
                @Override
                public void onSuccess(String response) {
                    Log.i(TAG, "EMAS 推送注册成功 deviceId=" + PushServiceFactory.getCloudPushService().getDeviceId());
                }

                @Override
                public void onFailed(String errorCode, String errorMessage) {
                    Log.w(TAG, "EMAS 推送注册失败 code=" + errorCode + " msg=" + errorMessage);
                }
            });
        } catch (Throwable t) {
            // SDK 初始化异常不阻断应用启动（推送为兜底通道，失败仅记日志）
            Log.w(TAG, "EMAS 推送 SDK 初始化异常", t);
        }
    }

    /** 读 application 级 meta-data（缺省返回空串） */
    private String getMetaValue(Context context, String key) {
        try {
            ApplicationInfo info = context.getPackageManager()
                    .getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
            return info.metaData == null ? "" : info.metaData.getString(key, "");
        } catch (Exception e) {
            return "";
        }
    }
}
