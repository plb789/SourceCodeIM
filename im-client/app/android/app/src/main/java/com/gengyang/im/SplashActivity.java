package com.gengyang.im;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * SplashActivity —— 阶段二百四十一：启动广告页（服务端下发可运营广告图；保底品牌图展示已按用户要求移除）
 *
 * 职责与归口：
 *   1. 无广告缓存：本页立即跳转主界面（系统启动屏黑底图标为 Android 12 系统行为，其后再无停留层）；
 *   2. 广告显示：本地缓存命中（filesDir/splash_ad.jpg + splash_ad.json 元数据）时全屏显示
 *      广告图 + 右上角「跳过 N」倒计时按钮（1 秒后可点，点击立即进主界面；倒计时归零自动进）；
 *   3. 运营更新：每次启动后台拉取 GET <server>/api/splash/ads（配置归口服务端 config.yaml 的
 *      splash_ad 节）——enabled=false 清空缓存；URL 变化自动预下载新图原子替换缓存（下次启动生效，
 *      不打断当前显示，微信同款「预下载下次看」）；下载失败静默（不阻塞启动）；
 *   4. 服务器地址读取 assets/capacitor.config.json 的 server.url（Capacitor 同源配置归口，
 *      不在原生层硬编码任何域名，遵循项目不硬编码路径规则）。
 *
 * 线程与生命周期：网络/IO 全在子线程；倒计时走主线程 Handler，onDestroy 统一移除防泄漏；
 * goMain 幂等（went 标记），跳过点击与倒计时归零与异常兜底三路互斥只进一次主界面。
 */
public class SplashActivity extends Activity {

    private static final String AD_IMG = "splash_ad.jpg";
    private static final String AD_META = "splash_ad.json";
    private static final long CLICK_DELAY_MS = 1000; // 跳过按钮延迟可点时长（防误触）

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private TextView skipBtn;
    private int remain = 0;
    private boolean went = false;
    private boolean showSkip = false; // 仅运营广告图显示跳过按钮；保底图纯品牌展示不打扰（阶段二百四十一）

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 阶段二百四十一补：代码级隐藏标题栏（主题 android:windowNoTitle 的双保险，
        // 原生 Activity 必须在 setContentView 前调用）
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        // 阶段二百四十一补：全屏隐藏状态栏（微信同款——启动/广告页无时间电量条；
        // androidx 兼容实现覆盖全部 API，进主界面后主主题无 fullscreen 自动恢复）
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .hide(WindowInsetsCompat.Type.statusBars());
        setContentView(R.layout.activity_splash);
        skipBtn = findViewById(R.id.splash_skip);
        ImageView imgView = findViewById(R.id.splash_image);

        File img = new File(getFilesDir(), AD_IMG);
        File meta = new File(getFilesDir(), AD_META);
        boolean shown = false;
        if (img.exists() && meta.exists()) {
            try {
                JSONObject m = new JSONObject(readText(meta));
                int duration = Math.max(1, m.optInt("duration", 3));
                Bitmap bmp = decodeSampled(img, 1440, 2560);
                if (bmp != null) {
                    imgView.setImageBitmap(bmp);
                    remain = duration;
                    showSkip = true;
                    // 跳过按钮 1 秒后出现（防启动瞬间误触），倒计时每秒刷新文案
                    mainHandler.postDelayed(() -> {
                        skipBtn.setVisibility(View.VISIBLE);
                        skipBtn.setOnClickListener(v -> goMain());
                        tick();
                    }, CLICK_DELAY_MS);
                    shown = true;
                }
            } catch (Exception e) {
                // 缓存损坏：按无广告处理，直接进主界面
            }
        }
        if (!shown) {
            // 阶段二百四十一补：保底品牌图展示已按用户要求移除——无运营广告时立即进入主界面
            // （系统启动屏黑底图标为 Android 12 系统行为不可去，其后再无停留层，最快抵达页面）
            goMain();
        }
        refreshAdInBackground(meta.exists() ? readTextSafe(meta) : "");
    }

    /** tick 每秒刷新「跳过 N」并递减，归零自动进入主界面（保底图分支不显按钮只倒计时） */
    private void tick() {
        if (went) return;
        if (remain <= 0) { goMain(); return; }
        if (showSkip) skipBtn.setText("跳过 " + remain);
        remain--;
        mainHandler.postDelayed(this::tick, 1000);
    }

    /** goMain 进入主界面（幂等） */
    private void goMain() {
        if (went) return;
        went = true;
        mainHandler.removeCallbacksAndMessages(null);
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    @Override
    public void onBackPressed() {
        // 广告页按返回视为跳过，直接进主界面（避免返回键卡死在广告页）
        goMain();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /**
     * refreshAdInBackground 后台拉取服务端广告配置并按需预下载：
     * enabled=false 清缓存；URL 变化下载新图原子替换（下次启动生效）；全程异常静默
     */
    private void refreshAdInBackground(String oldMetaJson) {
        new Thread(() -> {
            try {
                String base = serverBase();
                if (base == null || base.isEmpty()) return;
                HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/splash/ads").openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                String body = readStream(conn.getInputStream());
                conn.disconnect();
                JSONObject cfg = new JSONObject(body);
                File img = new File(getFilesDir(), AD_IMG);
                File meta = new File(getFilesDir(), AD_META);
                if (!cfg.optBoolean("enabled", false)) {
                    // 服务端关停：清空本地缓存（下次启动回到保底图直进）
                    if (img.exists()) img.delete();
                    if (meta.exists()) meta.delete();
                    return;
                }
                String url = cfg.optString("image_url", "");
                int duration = Math.max(1, cfg.optInt("duration", 3));
                String oldUrl = "";
                try { oldUrl = new JSONObject(oldMetaJson).optString("url", ""); } catch (Exception ignore) { }
                if (url.isEmpty() || url.equals(oldUrl)) return; // 未变化无需下载
                File tmp = new File(getFilesDir(), AD_IMG + ".tmp");
                downloadTo(url, tmp);
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(tmp.getAbsolutePath(), o);
                if (o.outWidth <= 0 || o.outHeight <= 0) { tmp.delete(); return; } // 非法图丢弃
                // 原子替换：图与元数据先后落盘，中途断电至多多显示一帧旧图/退回保底，不会半图
                File newMeta = new File(getFilesDir(), AD_META + ".tmp");
                writeText(newMeta, new JSONObject().put("url", url).put("duration", duration).toString());
                if (img.exists()) img.delete();
                tmp.renameTo(img);
                if (meta.exists()) meta.delete();
                newMeta.renameTo(meta);
            } catch (Exception e) {
                // 静默：广告拉取失败不影响启动（保底图兜底）
            }
        }, "splash-ad").start();
    }

    /** serverBase 从 assets/capacitor.config.json 读 server.url（Capacitor 配置归口，不硬编码域名） */
    private String serverBase() {
        try {
            InputStream in = getAssets().open("capacitor.config.json");
            String s = readStream(in);
            in.close();
            return new JSONObject(s).getJSONObject("server").optString("url", "");
        } catch (Exception e) {
            return null;
        }
    }

    /** decodeSampled 按目标上限采样解码（防超大广告图整图驻内存 OOM） */
    private Bitmap decodeSampled(File f, int maxW, int maxH) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getAbsolutePath(), o);
        int sample = 1;
        while (o.outHeight / (sample * 2) >= maxH / 2 || o.outWidth / (sample * 2) >= maxW / 2) {
            sample *= 2;
        }
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = sample;
        return BitmapFactory.decodeFile(f.getAbsolutePath(), o2);
    }

    private static void downloadTo(String url, File dst) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(10000);
        InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(dst);
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.close();
        in.close();
        conn.disconnect();
    }

    private static String readStream(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String readText(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        byte[] b = new byte[(int) f.length()];
        int off = 0, n;
        while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
        in.close();
        return new String(b, StandardCharsets.UTF_8);
    }

    /** readTextSafe 读元数据容错版（供旧缓存 URL 对比用，损坏返回空串） */
    private String readTextSafe(File f) {
        try { return readText(f); } catch (Exception e) { return ""; }
    }

    private static void writeText(File f, String s) throws Exception {
        FileOutputStream out = new FileOutputStream(f);
        out.write(s.getBytes(StandardCharsets.UTF_8));
        out.close();
    }
}
