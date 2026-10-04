package com.gengyang.im;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 阶段二百六十：APP 自动更新原生插件（检测 / 下载 / 校验 / 拉起系统安装页）
 *
 * 职责（Web 层 app-update.js 经 Capacitor 桥调用，弹窗 UI 归口前端自绘——遵守禁系统弹窗规则）：
 * 1. getInfo：返回当前 versionName/versionCode（PackageManager 读取，不依赖 BuildConfig 开关）；
 * 2. check(baseUrl)：GET <baseUrl>/api/app/version?platform=android&code=<versionCode>，
 *    服务端比对生效版本返回 has_update/url/size/sha256/notes/force（服务端归口判定，客户端零版本逻辑）；
 * 3. download(url, sha256, fileName)：OkHttp 流式下载至内部存储 filesDir/updates/（私有目录，
 *    FileProvider files-path 可达），进度经 downloadProgress 事件推送（500ms 节流），
 *    落盘同步计算 SHA256 校验，不符即删并报错；同名文件已存在且校验通过直接复用（断点重进免重下）；
 * 4. install(path)：Android 8+ 先查 canRequestPackageInstalls()——未授权则跳"安装未知应用"
 *    系统设置页并回 needPerm 错误（授权后用户重点一次即可）；已授权经 FileProvider
 *    content:// URI + ACTION_VIEW 拉起系统安装页（Android 无法静默安装，系统安装页为强制环节）。
 *
 * 注意：插件注册必须在 MainActivity super.onCreate 之前（阶段二百三十一时序铁律）。
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build();
    private volatile boolean downloading = false;

    /** 当前应用版本信息 {version_name, version_code} */
    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject o = new JSObject();
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            o.put("version_name", pi.versionName == null ? "" : pi.versionName);
            if (Build.VERSION.SDK_INT >= 28) {
                o.put("version_code", (int) pi.getLongVersionCode());
            } else {
                //noinspection deprecation
                o.put("version_code", pi.versionCode);
            }
        } catch (Exception e) {
            o.put("version_name", "");
            o.put("version_code", 0);
        }
        call.resolve(o);
    }

    /** 版本检查：GET <baseUrl>/api/app/version?platform=android&code=<当前 versionCode> */
    @PluginMethod
    public void check(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        if (baseUrl.isEmpty() || !baseUrl.startsWith("http")) {
            call.reject("baseUrl 不合法");
            return;
        }
        String url = baseUrl.replaceAll("/+$", "") + "/api/app/version?platform=android&code=" + currentVersionCode();
        new Thread(() -> {
            try {
                Request req = new Request.Builder().url(url).get().build();
                try (Response resp = http.newCall(req).execute()) {
                    ResponseBody body = resp.body();
                    if (!resp.isSuccessful() || body == null) {
                        call.reject("检查失败 HTTP " + resp.code());
                        return;
                    }
                    JSONObject json = new JSONObject(body.string());
                    JSONObject data = json.optJSONObject("data");
                    if (!json.optBoolean("ok", false) || data == null) {
                        call.reject("检查失败：响应异常");
                        return;
                    }
                    JSObject o = new JSObject(data.toString());
                    o.put("current_code", currentVersionCode());
                    call.resolve(o);
                }
            } catch (Exception e) {
                call.reject("检查失败：" + (e.getMessage() == null ? "网络异常" : e.getMessage()));
            }
        }, "app-update-check").start();
    }

    /** 下载安装包：filesDir/updates/<fileName>，SHA256 校验，进度事件 downloadProgress */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "");
        String fileName = safeName(call.getString("fileName", "imapp-update.apk"));
        if (url.isEmpty() || !url.startsWith("http")) {
            call.reject("下载地址不合法");
            return;
        }
        if (downloading) {
            call.reject("下载已在进行中");
            return;
        }
        File dir = new File(getContext().getFilesDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("下载目录创建失败");
            return;
        }
        File dst = new File(dir, fileName);
        // 已下载且校验通过：直接复用（强制更新中断重进免重复耗流量）
        if (dst.exists() && !sha256.isEmpty() && sha256.equals(sha256Of(dst))) {
            JSObject o = new JSObject();
            o.put("path", dst.getAbsolutePath());
            o.put("reused", true);
            call.resolve(o);
            return;
        }
        downloading = true;
        new Thread(() -> {
            try {
                Request req = new Request.Builder().url(url).get().build();
                try (Response resp = http.newCall(req).execute()) {
                    ResponseBody body = resp.body();
                    if (!resp.isSuccessful() || body == null) {
                        downloading = false;
                        call.reject("下载失败 HTTP " + resp.code());
                        return;
                    }
                    long total = body.contentLength();
                    long received = 0;
                    long lastPush = 0;
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    try (InputStream in = body.byteStream();
                         OutputStream out = new FileOutputStream(dst)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            digest.update(buf, 0, n);
                            received += n;
                            long now = System.currentTimeMillis();
                            if (now - lastPush >= 500) {
                                lastPush = now;
                                JSObject p = new JSObject();
                                p.put("received", received);
                                p.put("total", total);
                                p.put("percent", total > 0 ? Math.min(99, received * 100 / total) : 0);
                                notifyListeners("downloadProgress", p);
                            }
                        }
                    }
                    String got = hex(digest.digest());
                    if (!sha256.isEmpty() && !sha256.equals(got)) {
                        dst.delete();
                        downloading = false;
                        call.reject("安装包校验失败，已删除");
                        return;
                    }
                    downloading = false;
                    JSObject done = new JSObject();
                    done.put("received", received);
                    done.put("total", total);
                    done.put("percent", 100);
                    notifyListeners("downloadProgress", done);
                    JSObject o = new JSObject();
                    o.put("path", dst.getAbsolutePath());
                    o.put("reused", false);
                    call.resolve(o);
                }
            } catch (Exception e) {
                if (dst.exists()) dst.delete();
                downloading = false;
                call.reject("下载失败：" + (e.getMessage() == null ? "网络异常" : e.getMessage()));
            }
        }, "app-update-download").start();
    }

    /** 拉起系统安装页（Android 8+ 需"安装未知应用"授权，未授权跳设置页并回 needPerm） */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path", "");
        if (path.isEmpty()) {
            call.reject("缺少安装包路径");
            return;
        }
        File f = new File(path);
        if (!f.exists()) {
            call.reject("安装包不存在，请重新下载");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject err = new JSObject();
            err.put("needPerm", true);
            call.reject("未授予安装未知应用权限", "NEED_PERM", err);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", f);
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(it);
            JSObject o = new JSObject();
            o.put("ok", true);
            call.resolve(o);
        } catch (Exception e) {
            call.reject("拉起安装页失败：" + (e.getMessage() == null ? "" : e.getMessage()));
        }
    }

    /** 跳"安装未知应用"系统设置页（NEED_PERM 后引导用户授权） */
    @PluginMethod
    public void openInstallSetting(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent it = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(it);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("打开系统设置失败");
        }
    }

    // ===== 内部工具 =====

    private int currentVersionCode() {
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return (int) pi.getLongVersionCode();
            //noinspection deprecation
            return pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    /** 文件名净化（防路径穿越：仅取 basename 且限白名单字符） */
    private static String safeName(String name) {
        String base = new File(name).getName();
        if (base.isEmpty() || !base.matches("[A-Za-z0-9._-]+") || !base.endsWith(".apk")) {
            return "imapp-update.apk";
        }
        return base;
    }

    private static String sha256Of(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) digest.update(buf, 0, n);
            return hex(digest.digest());
        } catch (Exception e) {
            return "";
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
