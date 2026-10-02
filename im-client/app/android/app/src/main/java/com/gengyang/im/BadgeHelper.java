package com.gengyang.im;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

/**
 * 阶段二百五十一：桌面图标未读角标（微信同款 +99）。
 *
 * Android 无官方角标 API，按厂商私有通道逐一适配，无角标能力的桌面（原生 Pixel/
 * MuMu 模拟器等）所有通道静默失败即忽略，不影响功能：
 * 1. vivo / OriginOS / iQOO：launcher.action.CHANGE_APPLICATION_NOTIFICATION_NUM 广播
 *    （vivo 官方开放方式，微信同款数字角标）
 * 2. 华为 / 荣耀（EMUI/HarmonyOS）：com.huawei.android.launcher.settings BadgeProvider
 * 3. 三星（One UI）：com.badgemotor.badge BadgeProvider
 * 4. 索尼：com.sonyericsson.home.action.UNREAD_INTEGER 广播
 *
 * 计数归口：后台期间服务收消息累加（KeepAliveService.showMsgNotice），页面回前台后
 * 以会话未读总数经插件 setBadgeCount 精确校准；登出/服务销毁归零。
 */
final class BadgeHelper {

    private BadgeHelper() {
    }

    /** 更新桌面角标（count=0 清除）。所有通道独立 try-catch 静默容错 */
    static void apply(Context ctx, int count) {
        if (ctx == null || count < 0) count = 0;
        String pkg = ctx.getPackageName();
        // 阶段二百五十一：桌面图标组件动态解析——LAUNCHER 入口是 SplashActivity（启动广告页，
        // 阶段二百四十一），角标广播 className 必须与桌面图标组件一致否则 launcher 匹配
        // 不到（MainActivity 写法角标必不显示）；解析失败兜底 SplashActivity
        String cls = pkg + ".SplashActivity";
        try {
            Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (launch != null && launch.getComponent() != null) {
                cls = launch.getComponent().getClassName();
            }
        } catch (Exception ignored) {
        }
        try {
            // vivo / OriginOS / iQOO 旧广播接口（Funtouch 兼容保留）：需 BADGE_ICON 权限 +
            // FLAG_RECEIVER_INCLUDE_BACKGROUND（Android 8+ 后台广播限制，vivo 官方文档
            // 要求），显式（setPackage）+ 隐式双发；其他 ROM 桌面包名不同走隐式
            // （AndroidManifest queries 已声明 HOME 可见性）
            Intent vi = new Intent("launcher.action.CHANGE_APPLICATION_NOTIFICATION_NUM");
            vi.putExtra("packageName", pkg);
            vi.putExtra("className", cls);
            vi.putExtra("notificationNum", count);
            // FLAG_RECEIVER_INCLUDE_BACKGROUND 为 hidden API（vivo 文档注明需反射获取），
            // 编译期不可见，直接用固定字面值 0x01000000（Intent 源码常量，各版本未变）
            vi.addFlags(0x01000000);
            try {
                vi.setPackage("com.bbk.launcher2");
                ctx.sendBroadcast(vi);
            } catch (Exception ignored) {
            }
            try {
                vi.setPackage(null);
                ctx.sendBroadcast(vi);
            } catch (Exception ignored) {
            }
        } catch (Exception ignored) {
        }
        try {
            // vivo OriginOS 新接口（官方持续维护）：ContentProvider call，需
            // com.vivo.abe.permission.launcher.notification.num 权限；官方要求必须用
            // 非稳连接 acquireUnstableContentProviderClient（直调 getContentResolver.call
            // 有 Server 端崩溃带崩 Client 端风险）
            android.content.ContentProviderClient client = null;
            try {
                Uri vp = Uri.parse("content://com.vivo.abe.provider.launcher.notification.num");
                android.os.Bundle extra = new android.os.Bundle();
                extra.putString("package", pkg);
                extra.putString("class", cls);
                extra.putInt("badgenumber", count);
                client = ctx.getContentResolver().acquireUnstableContentProviderClient(vp);
                if (client != null) {
                    client.call("change_badge", null, extra);
                }
            } finally {
                if (client != null) client.close();
            }
        } catch (Exception ignored) {
        }
        try {
            // 华为 / 荣耀（BadgeProvider，侧载应用通用）
            ContentValues cv = new ContentValues();
            cv.put("package", pkg);
            cv.put("class", cls);
            cv.put("badgenumber", count);
            Uri hw = Uri.parse("content://com.huawei.android.launcher.settings/badge/");
            if (count <= 0) {
                ctx.getContentResolver().delete(hw, "package=?", new String[]{pkg});
            } else {
                ctx.getContentResolver().insert(hw, cv);
            }
        } catch (Exception ignored) {
        }
        try {
            // 三星（BadgeProvider）
            ContentValues cv = new ContentValues();
            cv.put("package", pkg);
            cv.put("class", cls);
            cv.put("badgecount", count);
            Uri ss = Uri.parse("content://com.badgemotor.badge/badge");
            if (count <= 0) {
                ctx.getContentResolver().delete(ss, "package=?", new String[]{pkg});
            } else {
                ctx.getContentResolver().insert(ss, cv);
            }
        } catch (Exception ignored) {
        }
        try {
            // 索尼（Xperia Home）
            Intent si = new Intent("com.sonyericsson.home.action.UNREAD_INTEGER");
            si.putExtra("com.sonyericsson.home.intent.extra.badge.PACKAGE_NAME", pkg);
            si.putExtra("com.sonyericsson.home.intent.extra.badge.ACTIVITY_NAME", cls);
            si.putExtra("com.sonyericsson.home.intent.extra.badge.SHOW_MESSAGE", count > 0);
            si.putExtra("com.sonyericsson.home.intent.extra.badge.MESSAGE", count);
            ctx.sendBroadcast(si);
        } catch (Exception ignored) {
        }
    }
}
