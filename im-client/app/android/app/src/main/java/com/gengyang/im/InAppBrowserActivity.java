package com.gengyang.im;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 阶段二百七十三：自绘原生内置浏览层（微信内置浏览器同款）。
 *
 * 背景：@capacitor/browser 的 Android 实现是 Chrome Custom Tabs，要求设备存在提供
 * CustomTabsService 的浏览器（Chrome/Edge）；国产 ROM 与模拟器普遍无 Chrome，
 * CustomTabsIntent 回落 ACTION_VIEW → 打开系统默认浏览器（用户实测：选了"内置浏览器
 * 打开"却弹出系统浏览器）。本 Activity 用自带 WebView + 自绘顶栏彻底摆脱外部浏览器依赖。
 *
 * 附带根治工作台外链（百度等）自动深链拉起 baiduboxapp:// 之类未知协议时
 * WebView 报 net::ERR_UNKNOWN_URL_SCHEME 错误页的问题：非 http/https 一律
 * ACTION_VIEW 交外部 APP 消费并 return true，无处理器静默忽略。
 *
 * 全程序化布局（无 XML 资源）：顶栏(← 返回/标题/✕ 关闭) + 进度条 + WebView；
 * 物理返回键与顶栏返回键均为"WebView 可后退则后退，否则关闭"（微信同款逐级回退）。
 */
public class InAppBrowserActivity extends Activity {

    private static final int BAR_COLOR = 0xFF1F1F1F;   // 顶栏/状态栏深色（APP 深色主题同款）
    private static final int PROGRESS_COLOR = 0xFF07C160; // 进度条微信绿

    private WebView webView;
    private TextView titleView;
    private ProgressBar progressBar;
    private TextView backBtn;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent() == null ? null : getIntent().getStringExtra("url");
        if (url == null || url.isEmpty()) { finish(); return; }

        // 状态栏与顶栏同色无缝（微信同款，API 21+）
        Window w = getWindow();
        w.setStatusBarColor(BAR_COLOR);
        w.setNavigationBarColor(BAR_COLOR);

        float density = getResources().getDisplayMetrics().density;
        int dp = (int) (density + 0.5f);

        // ===== 根布局：垂直线性 =====
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);
        setContentView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // ===== 顶栏：← | 标题 | ✕（高 48dp，深色白字） =====
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(BAR_COLOR);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 48 * dp));

        backBtn = makeBarBtn("←", 22);
        backBtn.setOnClickListener(v -> goBackOrClose());
        bar.addView(backBtn, new LinearLayout.LayoutParams(48 * dp, ViewGroup.LayoutParams.MATCH_PARENT));

        titleView = new TextView(this);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(16);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        titleView.setGravity(Gravity.CENTER);
        titleView.setPadding(8 * dp, 0, 8 * dp, 0);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(titleView, tp);

        TextView closeBtn = makeBarBtn("✕", 16);
        closeBtn.setOnClickListener(v -> finish());
        bar.addView(closeBtn, new LinearLayout.LayoutParams(48 * dp, ViewGroup.LayoutParams.MATCH_PARENT));

        // ===== 水平进度条（3dp，加载完隐藏） =====
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(PROGRESS_COLOR));
        progressBar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(0x33FFFFFF));
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 3 * dp);
        root.addView(progressBar, pp);

        // ===== WebView（占满剩余空间） =====
        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        webView.setBackgroundColor(Color.WHITE);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        webView.loadUrl(url);
    }

    /** 顶栏按钮统一构造（白字、居中、按压半透明高亮） */
    private TextView makeBarBtn(String text, int sizeSp) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setTextSize(sizeSp);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    /** 微信同款逐级回退：WebView 有历史则后退，否则关闭本层回聊天页 */
    private void goBackOrClose() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    @Override
    public void onBackPressed() {
        goBackOrClose();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * 核心路由：http/https 站内继续加载；其余协议（baiduboxapp://、intent://、
     * alipays:// 等深链）ACTION_VIEW 调起外部 APP 并 return true 消费——绝不让
     * WebView 尝试加载未知协议（根治 ERR_UNKNOWN_URL_SCHEME 错误页）；
     * 设备无对应处理器时静默忽略（不弹错页不跳转）。
     */
    private class Client extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return route(request.getUrl().toString());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            // 兼容重载：API 24 以下系统只回调 String 版（Capacitor 6 minSdk 22 仍会走到）
            return route(url);
        }

        private boolean route(String urlStr) {
            Uri uri = Uri.parse(urlStr);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
            if (scheme.equals("http") || scheme.equals("https")) return false;
            try {
                Intent intent;
                if (scheme.equals("intent")) {
                    intent = Intent.parseUri(urlStr, Intent.URI_INTENT_SCHEME);
                    // 防 component/selector 注入（微信同款防护）：intent:// 可携带
                    // component 指向任意 exported 组件，清空后仅按 package/action 调起
                    intent.setComponent(null);
                    intent.setSelector(null);
                } else {
                    intent = new Intent(Intent.ACTION_VIEW, uri);
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception ignored) { /* 无处理器/解析失败：静默忽略 */ }
            return true;
        }
    }

    /** 顶栏标题=网页标题；进度条 0-100 显示，加载完成隐藏 */
    private class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (title != null && !title.trim().isEmpty()) {
                titleView.setText(title.trim());
            }
        }
    }
}
