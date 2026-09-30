package com.gengyang.im;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 阶段二百三十一：插件注册必须在 super.onCreate 之前（Capacitor 官方时序）——
        // super 内部启动 bridge 并加载页面，页面 bridge.js 初始化时从原生注册表生成
        // Capacitor.Plugins 快照；super 之后注册的插件不进快照，页面侧恒为 undefined，
        // startKeepAlive 等全部插件调用静默失效（保活/通知/状态栏全废，探针实测 PLG=false 铁证）。
        // 阶段二百二十五：注册后台保活插件（切后台/息屏由原生前台服务接管长连接收消息）
        registerPlugin(BackgroundIMPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
