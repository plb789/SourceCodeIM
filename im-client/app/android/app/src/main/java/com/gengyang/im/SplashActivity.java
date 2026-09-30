package com.gengyang.im;

import android.app.Activity;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.Bundle;

import org.json.JSONObject;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * SplashActivity —— 阶段二百四十一：启动入口（极薄壳）
 *
 * 演进：本页原为广告停留页（全屏广告图+跳过倒计时）；改为广告层内嵌 MainActivity 后，
 * 本页仅剩两个职责，冷启动零停留（系统启动屏黑底图标后直接进主界面）：
 *   1. 立即跳转 MainActivity（广告显示由 MainActivity 内嵌覆盖层承担——广告 3 秒与
 *      WebView 页面加载并行，广告结束揭幕即登录页，消除串行等待）；
 *   2. 后台预下载运营广告：GET <server>/api/splash/ads（配置归口服务端 config.yaml 的
 *      splash_ad 节）——enabled=false 清缓存；URL 变化预下载新图原子替换（下次启动生效，
 *      微信同款「预下载下次看」）；全程子线程+ApplicationContext（本页立即 finish，
 *      不得持有 Activity 上下文）。
 *
 * 服务器地址读取 assets/capacitor.config.json 的 server.url（Capacitor 同源配置归口，
 * 不在原生层硬编码任何域名，遵循项目不硬编码路径规则）。
 */
public class SplashActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 零 UI 零停留：直接进主界面（广告层见 MainActivity.showAdOverlay）
        startActivity(new Intent(this, MainActivity.class));
        finish();
        refreshAdInBackground();
    }

    /**
     * refreshAdInBackground 后台拉取服务端广告配置并按需预下载：
     * enabled=false 清缓存；URL 变化下载新图原子替换（下次启动生效）；全程异常静默。
     * 用 ApplicationContext——本 Activity 已 finish，线程回调不得持有其上下文
     */
    private void refreshAdInBackground() {
        final android.content.Context app = getApplicationContext();
        new Thread(() -> {
            try {
                String base = serverBase(app);
                if (base == null || base.isEmpty()) return;
                HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/splash/ads").openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                String body = AdCache.readStream(conn.getInputStream());
                conn.disconnect();
                JSONObject cfg = new JSONObject(body);
                File filesDir = app.getFilesDir();
                if (!cfg.optBoolean("enabled", false)) {
                    // 服务端关停：清空本地缓存（下次启动直进主界面）
                    AdCache.clear(filesDir);
                    return;
                }
                String url = cfg.optString("image_url", "");
                int duration = Math.max(1, cfg.optInt("duration", 3));
                String oldUrl = "";
                JSONObject oldMeta = AdCache.readMeta(filesDir);
                if (oldMeta != null) oldUrl = oldMeta.optString("url", "");
                if (url.isEmpty() || url.equals(oldUrl)) return; // 未变化无需下载
                File tmp = new File(filesDir, AdCache.AD_IMG + ".tmp");
                AdCache.downloadTo(url, tmp);
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(tmp.getAbsolutePath(), o);
                if (o.outWidth <= 0 || o.outHeight <= 0) { tmp.delete(); return; } // 非法图丢弃
                // 原子替换：图与元数据先后落盘，中途断电至多多显示一帧旧图/退回直进，不会半图
                File newMeta = new File(filesDir, AdCache.AD_META + ".tmp");
                AdCache.writeText(newMeta, new JSONObject().put("url", url).put("duration", duration).toString());
                File img = new File(filesDir, AdCache.AD_IMG);
                File meta = new File(filesDir, AdCache.AD_META);
                if (img.exists()) img.delete();
                tmp.renameTo(img);
                if (meta.exists()) meta.delete();
                newMeta.renameTo(meta);
            } catch (Exception e) {
                // 静默：广告拉取失败不影响启动（下次启动仍按现有缓存/直进）
            }
        }, "splash-ad").start();
    }

    /** serverBase 从 assets/capacitor.config.json 读 server.url（Capacitor 配置归口，不硬编码域名） */
    private String serverBase(android.content.Context ctx) {
        try {
            java.io.InputStream in = ctx.getAssets().open("capacitor.config.json");
            String s = AdCache.readStream(in);
            in.close();
            return new JSONObject(s).getJSONObject("server").optString("url", "");
        } catch (Exception e) {
            return null;
        }
    }
}
