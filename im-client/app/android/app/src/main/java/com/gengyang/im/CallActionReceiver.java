package com.gengyang.im;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

/**
 * 阶段二百三十八：来电通知「挂断」按钮广播归口（微信同款通知上直接拒接）
 *
 * 通知卡片挂断钮 → 本接收器：
 *   1. 撤下来电通知 + 清响铃标记（无论后续走哪条拒接路径）；
 *   2. 原生保活连接仍在线（后台被叫态）→ KeepAliveService.trySendCallReject 直达上行
 *      reject/meet_decline 信令，不经 WebView 拉起，熄屏/后台秒拒；
 *   3. 连接已交还前台（WebView 持连接，原生 ws 已断）→ 退化为深链拉起，由 chat.js
 *      忙态分支（callOpenId/pendingRing 在挂即拒）完成拒接；冷启动无态时为无害空操作。
 */
public class CallActionReceiver extends BroadcastReceiver {
    public static final String ACTION_REJECT = "com.gengyang.im.call.REJECT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_REJECT.equals(intent.getAction())) return;
        String callId = intent.getStringExtra("call_id");
        String from = intent.getStringExtra("from");
        boolean meet = intent.getBooleanExtra("meet", false);
        String deep = intent.getStringExtra("deep");

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(KeepAliveService.CALL_NOTIFY_ID);
        KeepAliveService.clearRingingCall(callId);

        if (KeepAliveService.trySendCallReject(callId, from, meet)) return;
        if (deep != null && !deep.isEmpty()) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(deep), context, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                context.startActivity(i);
            } catch (Exception ignored) {
            }
        }
    }
}
