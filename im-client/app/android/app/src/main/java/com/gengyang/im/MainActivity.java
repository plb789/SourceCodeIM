package com.gengyang.im;

import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.core.view.ViewCompat;
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
    private int adSbTop = 0; // 已采纳的状态栏避让高度 px（只增不减，见 showAdOverlay 注释）

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 阶段二百三十一：插件注册必须在 super.onCreate 之前（Capacitor 官方时序）——
        // super 内部启动 bridge 并加载页面，页面 bridge.js 初始化时从原生注册表生成
        // Capacitor.Plugins 快照；super 之后注册的插件不进快照，页面侧恒为 undefined，
        // startKeepAlive 等全部插件调用静默失效（保活/通知/状态栏全废，探针实测 PLG=false 铁证）。
        // 阶段二百二十五：注册后台保活插件（切后台/息屏由原生前台服务接管长连接收消息）
        registerPlugin(BackgroundIMPlugin.class);
        // 阶段二百六十：注册 APP 自动更新插件（检测/下载/校验/拉起系统安装页，弹窗 UI 归口前端自绘）
        registerPlugin(AppUpdaterPlugin.class);
        // 位置导航：调起外部地图 APP（@capacitor/app 6.x Android 无 launcher 方法，实测缺方法，
        // 前端回落整页跳转网页版致"黑屏"；本插件 ACTION_VIEW 调起 scheme，未安装返回 completed=false）
        registerPlugin(OpenUrlPlugin.class);
        super.onCreate(savedInstanceState);
        // 阶段二百五十：锁屏来电可见（微信同款息屏来电）——FSI 全屏意图拉起本 Activity 时
        // 直接在锁屏上显示来电页并点亮屏幕。缺省时 FSI 拉起的页面被锁屏覆盖，锁屏上又因
        // 通知被 FSI 消费而不显示卡片 → 息屏来电"只有铃声没有画面"（用户实测反馈）
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            //noinspection deprecation
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
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
                // 广告期间强制全屏（微信同款——广告页无时间电量条）：addFlags 须在内容
                // 挂载前设置，首次布局即全屏；切勿配合 setDecorFitsSystemWindows(false)——
                // Android 11+ 上那会令 FLAG_FULLSCREEN 被系统忽略（真机实测状态栏压字根因）
                getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN);
                LayoutInflater inf = LayoutInflater.from(MainActivity.this);
                adOverlay = inf.inflate(R.layout.activity_splash, (ViewGroup) findViewById(android.R.id.content), false);
                ImageView imgView = adOverlay.findViewById(R.id.splash_image);
                adSkip = adOverlay.findViewById(R.id.splash_skip);
                imgView.setImageBitmap(bmp);
                adRemain = Math.max(1, meta.optInt("duration", 3));
                addContentView(adOverlay, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                // 跳过按钮避开状态栏（兜底）：个别 ROM FLAG_FULLSCREEN/hide 假生效状态栏
                // 仍在显示——初始边距用系统 status_bar_height 兜底；inset 回调改「只增不减」，
                // 防 hide 成功后 top=0 的派发把边距缩回 32dp 再次被状态栏压住（真机复现）
                final float density = getResources().getDisplayMetrics().density;
                int sbRes = getResources().getIdentifier("status_bar_height", "dimen", "android");
                adSbTop = sbRes > 0 ? getResources().getDimensionPixelSize(sbRes) : 0;
                FrameLayout.LayoutParams lp0 = (FrameLayout.LayoutParams) adSkip.getLayoutParams();
                lp0.topMargin = adSbTop + (int) (32 * density);
                adSkip.setLayoutParams(lp0);
                ViewCompat.setOnApplyWindowInsetsListener(adOverlay, (v, insets) -> {
                    int sbTop = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top;
                    if (sbTop > adSbTop) {
                        adSbTop = sbTop;
                        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) adSkip.getLayoutParams();
                        lp.topMargin = sbTop + (int) (32 * density);
                        adSkip.setLayoutParams(lp);
                    }
                    return insets;
                });
                // insets hide 兜底（双保险）：延后到视图挂载后执行（未挂载时调用无效）
                getWindow().getDecorView().post(() -> {
                    if (!isDestroyed() && adOverlay != null) {
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                                .hide(WindowInsetsCompat.Type.statusBars());
                    }
                });
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
        // 摘除 inset 监听防残留派发（状态栏 show 后 insets 重派，不得再改按钮边距）
        ViewCompat.setOnApplyWindowInsetsListener(adOverlay, null);
        ((ViewGroup) adOverlay.getParent()).removeView(adOverlay);
        adOverlay = null;
        // 退出强制全屏：清除 FLAG_FULLSCREEN + 重新显示状态栏，主页面正常显示时间电量条
        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .show(WindowInsetsCompat.Type.statusBars());
    }

    @Override
    public void onBackPressed() {
        // 广告覆盖层期间返回键视为跳过（防卡死在广告页）；无覆盖层走 WebView 默认返回链路
        if (adOverlay != null) { dismissAd(); return; }
        super.onBackPressed();
    }

    /** 阶段二百四十九：回前台原生广播（通话媒体自愈，微信同款）——WebView 暂停期相机数据流
     * 被 ROM（vivo OriginOS 等）强制断开且 track 不置 ended，页面层需感知前台切换做重采自愈；
     * Capacitor 原生桥只注入主文档，通话 iframe 内拿不到 App 插件的 appStateChange——
     * 故由原生层统一广播，主文档 web-call-bridge 监听后转发给通话窗 iframe */
    @Override
    public void onResume() {
        super.onResume();
        if (bridge != null) bridge.triggerWindowJSEvent("im-resume");
    }
}
