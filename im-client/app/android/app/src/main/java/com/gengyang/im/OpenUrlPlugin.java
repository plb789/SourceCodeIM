package com.gengyang.im;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 位置导航调起外部地图 APP（微信同款"选择地图"导航）——@capacitor/app 6.x Android 端
 * 只有 exitApp/getInfo/getLaunchUrl/getState/minimizeApp，无 launcher 方法
 * （真机 CDP 实测 Plugins.App.launcher 恒 undefined），自实现 ACTION_VIEW 调起：
 * 地图 scheme（amapuri:// 等）在未安装目标 APP 时 startActivity 抛异常 →
 * completed=false，前端据此提示未安装并保持本页面（此前回落 window.open 网页版
 * 被 mobile.js 覆盖为整页跳转，WebView 整页替换成高德 H5，用户视角即"黑屏"） */
@CapacitorPlugin(name = "OpenUrl")
public class OpenUrlPlugin extends Plugin {

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            JSObject res = new JSObject();
            res.put("completed", true);
            call.resolve(res);
        } catch (Exception e) {
            // 未安装目标 APP / 系统拒绝调起：返回 completed=false，不抛 reject 防 Promise 走 reject 分支
            JSObject res = new JSObject();
            res.put("completed", false);
            res.put("reason", String.valueOf(e));
            call.resolve(res);
        }
    }
}
