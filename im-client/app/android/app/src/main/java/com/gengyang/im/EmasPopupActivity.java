package com.gengyang.im;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.alibaba.sdk.android.push.AndroidPopupActivity;

import java.util.Map;

/**
 * 阶段二百二十六：EMAS 厂商离线通道辅助弹窗（3.x 标准 AndroidPopupActivity）。
 * 小米/华为/OPPO/vivo 等厂商通道的离线推送由厂商系统代发，点击后先进本 Activity
 * （服务端推送须带 AndroidPopupActivity=<本类全名> + AndroidPopupTitle/Body 参数，
 * 缺一则厂商通道不可达），再中转跳 MainActivity 深链打开对应会话。
 * 自有通道（ACCS 在线）点击不走本类，走 EmasMessageReceiver。
 */
public class EmasPopupActivity extends AndroidPopupActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    /** 厂商通道通知点击回调：从自定义参数取目标会话，显式 Intent 跳 MainActivity 深链 */
    @Override
    protected void onSysNoticeOpened(String title, String summary, Map<String, String> extMap) {
        String target = extMap == null ? null : extMap.get("target");
        Intent it = new Intent(this, MainActivity.class);
        if (target != null && !target.isEmpty()) {
            // 与 KeepAliveService 通知深链同款：imapp://chat?to=<target>（target=用户名 / g+群ID）
            it.setData(Uri.parse("imapp://chat?to=" + Uri.encode(target)));
        }
        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(it);
        finish();
    }
}
