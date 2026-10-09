package com.gengyang.im;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 阶段二百七十三：自绘内置浏览器层原生插件（替代 @capacitor/browser 的 Chrome
 * Custom Tabs 实现——国产 ROM/模拟器无 Chrome 时 Custom Tabs 回落 ACTION_VIEW
 * 打开系统默认浏览器，违背"内置浏览器打开"语义）。
 *
 * open({url}) 直接拉起自带 WebView 的 InAppBrowserActivity，零外部浏览器依赖。
 */
@CapacitorPlugin(name = "InAppBrowser")
public class InAppBrowserPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }
        Intent intent = new Intent(getContext(), InAppBrowserActivity.class);
        intent.putExtra("url", url);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
