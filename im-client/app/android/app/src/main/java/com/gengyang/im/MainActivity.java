package com.gengyang.im;

import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.File;

public class MainActivity extends BridgeActivity {

    // ===== 阶段二百四十一：启动广告覆盖层（与 WebView 页面加载并行） =====
    // 广告层原在 SplashActivity（原生停留页，串行等待 3 秒后才进主界面）；迁入本 Activity 后，
    // super.onCreate 内 bridge 启动+WebView 加载照常进行，广告图仅作为视图覆盖（addContentView
    // 盖在 WebView 上层）——广告倒计时 3 秒 = 页面加载时间，归零/跳过后移除覆盖层即揭幕，
    // 页面若已加载完直接是登录页（消除原串行链路的整段等待）。无缓存广告时零覆盖零开销。
    private final Handler adHandler = new Handler(Looper.getMainLooper());
    private View adOverlay;   // 广告覆盖层根视图（null=未显示）
    private TextView adSkip;  // 「跳过 N」按钮
    private int adRemain = 0;
    private boolean adSkipArmed = false; // 1 秒后可点（防启动瞬间误触）

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 阶段二百三十一：插件注册必须在 super.onCreate 之前（Capacitor 官方时序）——
        // super 内部启动 bridge 并加载页面，页面 bridge.js 初始化时从原生注册表生成
        // Capacitor.Plugins 快照；super 之后注册的插件不进快照，页面侧恒为 undefined，
        // startKeepAlive 等全部插件调用静默失效（保活/通知/状态栏全废，探针实测 PLG=false 铁证）。
        // 阶段二百二十五：注册后台保活插件（切后台/息屏由原生前台服务接管长连接收消息）
        registerPlugin(BackgroundIMPlugin.class);
        super.onCreate(savedInstanceState);
        showAdOverlay();
    }

    /** showAdOverlay 缓存命中时盖上全屏广告层（解码在子线程，视图操作归主线程）。
     * 深链/通知点击直达（imapp://）不弹广告——微信同款：点通知秒进聊天，
     * 广告仅限桌面图标冷启动的品牌曝光场景 */
    private void showAdOverlay() {
        if (getIntent() != null && getIntent().getData() != null) return;
        File filesDir = getFilesDir();
        if (!AdCache.hasAd(filesDir)) return;
        final File imgFile = new File(filesDir, AdCache.AD_IMG);
        final JSONObject meta = AdCache.readMeta(filesDir);
        if (meta == null) { AdCache.clear(filesDir); return; } // 元数据损坏按无广告直进
        new Thread(() -> {
            final Bitmap bmp = AdCache.decodeSampled(imgFile, 1440, 2560);
            if (bmp == null) { AdCache.clear(filesDir); return; } // 图损坏清缓存直进
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                LayoutInflater inf = LayoutInflater.from(MainActivity.this);
                adOverlay = inf.inflate(R.layout.activity_splash, (ViewGroup) findViewById(android.R.id.content), false);
                ImageView imgView = adOverlay.findViewById(R.id.splash_image);
                adSkip = adOverlay.findViewById(R.id.splash_skip);
                imgView.setImageBitmap(bmp);
                adRemain = Math.max(1, meta.optInt("duration", 3));
                addContentView(adOverlay, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                // 广告期间全屏隐藏状态栏（微信同款——广告页无时间电量条），揭幕后恢复
                WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                        .hide(WindowInsetsCompat.Type.statusBars());
                // 跳过按钮 1 秒后出现（防误触），倒计时每秒刷新文案
                adHandler.postDelayed(() -> {
                    if (adOverlay == null) return;
                    adSkipArmed = true;
                    adSkip.setVisibility(View.VISIBLE);
                    adSkip.setOnClickListener(v -> dismissAd());
                    tickAd();
                }, 1000);
            });
        }, "ad-decode").start();
    }

    /** tickAd 每秒刷新「跳过 N」并递减，归零自动揭幕（Activity 已销毁时自停防回调悬空） */
    private void tickAd() {
        if (adOverlay == null || isDestroyed() || isFinishing()) return;
        if (adRemain <= 0) { dismissAd(); return; }
        adSkip.setText("跳过 " + adRemain);
        adRemain--;
        adHandler.postDelayed(this::tickAd, 1000);
    }

    /** dismissAd 移除广告覆盖层并恢复状态栏（幂等；点击跳过/倒计时归零共用） */
    private void dismissAd() {
        if (adOverlay == null) return;
        adHandler.removeCallbacksAndMessages(null);
        ((ViewGroup) adOverlay.getParent()).removeView(adOverlay);
        adOverlay = null;
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .show(WindowInsetsCompat.Type.statusBars());
    }

    @Override
    public void onBackPressed() {
        // 广告覆盖层期间返回键视为跳过（防卡死在广告页）；无覆盖层走 WebView 默认返回链路
        if (adOverlay != null) { dismissAd(); return; }
        super.onBackPressed();
    }
}
