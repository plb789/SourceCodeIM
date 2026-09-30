package com.gengyang.im;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.alibaba.sdk.android.push.MessageReceiver;
import com.alibaba.sdk.android.push.notification.CPushMessage;

import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONObject;

/**
 * 阶段二百二十六：EMAS 自有通道（ACCS 在线长连接）通知回调。
 * 服务端按账号推送的通知在设备在线时经阿里云自有通道到达，点击/清除回调在本类
 * （Manifest 注册 com.alibaba.push2.action.NOTIFICATION_OPENED/REMOVED action）。
 * 厂商离线通道点击不走本类，走 EmasPopupActivity 辅助弹窗。
 */
public class EmasMessageReceiver extends MessageReceiver {

    /** 通知点击：从自定义参数解析目标会话跳深链（与 KeepAliveService 通知同款编码） */
    @Override
    public void onNotificationOpened(Context context, String title, String summary, String extraMap) {
        jumpChat(context, parseTarget(extraMap));
    }

    /* 3.10.1 主 SDK 的 MessageReceiver 定义了 6 个抽象回调（javap 实测），除点击外均为
       空实现：通知的展示/清除由 SDK 内部（onReceive→showNotificationNow）完成，
       应用层仅在有自定义需求时覆写。 */

    /** 通知到达回调：默认展示已由 SDK 完成，应用层无附加处理 */
    @Override
    protected void onNotification(Context context, String title, String summary, Map<String, String> extraMap) {
    }

    /** 自有通道消息透传（PushType=MESSAGE 时到达；当前服务端只发 NOTICE 通知，预留） */
    @Override
    protected void onMessage(Context context, CPushMessage message) {
    }

    /** 通知点击无跳转动作回调（统一由 onNotificationOpened 承接跳转，预留） */
    @Override
    protected void onNotificationClickedWithNoAction(Context context, String title, String summary, String extraMap) {
    }

    /** 通知清除回调 */
    @Override
    protected void onNotificationRemoved(Context context, String messageId) {
    }

    /** 应用内通知到达回调 */
    @Override
    protected void onNotificationReceivedInApp(Context context, String title, String summary, Map<String, String> extraMap, int icon, String openActivity, String openUrl) {
    }

    /** extraMap（3.x 为字符串承载的自定义参数）解析 target：
     *  兼容 JSON（"target":"xxx"）与 k=v;k=v 两种承载格式，联调实测后归口 */
    private String parseTarget(String extraMap) {
        if (extraMap == null || extraMap.isEmpty()) {
            return null;
        }
        try {
            if (extraMap.trim().startsWith("{")) {
                String v = new JSONObject(extraMap).optString("target", "");
                return v.isEmpty() ? null : v;
            }
        } catch (Exception ignore) {
        }
        Matcher m = Pattern.compile("target=([^;]+)").matcher(extraMap);
        return m.find() ? m.group(1) : null;
    }

    /** 显式 Intent 跳 MainActivity 深链（imapp://chat?to=<target>，前端归口消费） */
    private void jumpChat(Context context, String target) {
        Intent it = new Intent(context, MainActivity.class);
        if (target != null && !target.isEmpty()) {
            it.setData(Uri.parse("imapp://chat?to=" + Uri.encode(target)));
        }
        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(it);
    }
}
