package com.gengyang.im;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * AdCache —— 阶段二百四十一：启动广告缓存读写归口（工具类，全静态）
 *
 * 广告链路两方共用：
 *   1. SplashActivity（后台预下载方）：GET /api/splash/ads 拉配置 → 下载新图原子替换缓存；
 *   2. MainActivity（显示方）：读缓存盖全屏广告层（与 WebView 页面加载并行，广告结束即揭幕）。
 *
 * 缓存形态：filesDir/splash_ad.jpg（图）+ filesDir/splash_ad.json（元数据 url/duration），
 * 服务端 config.yaml splash_ad 节归口（enabled=false 清缓存）。
 */
public final class AdCache {

    public static final String AD_IMG = "splash_ad.jpg";
    public static final String AD_META = "splash_ad.json";

    private AdCache() {}

    /** hasAd 判断缓存是否可用（图 + 元数据齐备；损坏按无广告处理由调用方兜底） */
    public static boolean hasAd(File filesDir) {
        return new File(filesDir, AD_IMG).exists() && new File(filesDir, AD_META).exists();
    }

    /** readMeta 读元数据（url/duration）；损坏返回 null */
    public static JSONObject readMeta(File filesDir) {
        try {
            return new JSONObject(readText(new File(filesDir, AD_META)));
        } catch (Exception e) {
            return null;
        }
    }

    /** decodeSampled 按目标上限采样解码（防超大广告图整图驻内存 OOM） */
    public static Bitmap decodeSampled(File f, int maxW, int maxH) {
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

    /** clear 清空广告缓存（服务端关停 enabled=false 时调用） */
    public static void clear(File filesDir) {
        new File(filesDir, AD_IMG).delete();
        new File(filesDir, AD_META).delete();
    }

    public static String readText(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        byte[] b = new byte[(int) f.length()];
        int off = 0, n;
        while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
        in.close();
        return new String(b, StandardCharsets.UTF_8);
    }

    public static void writeText(File f, String s) throws Exception {
        FileOutputStream out = new FileOutputStream(f);
        out.write(s.getBytes(StandardCharsets.UTF_8));
        out.close();
    }

    public static String readStream(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    public static void downloadTo(String url, File dst) throws Exception {
        java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
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
}
