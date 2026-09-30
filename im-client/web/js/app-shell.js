/**
 * app-shell.js —— 手机版 APP 壳引导脚本（Capacitor 打包专用）
 *
 * 原理：APP 本地页面（http://localhost 域）加载后，整页跳转到硬编码的
 * 服务器地址并携带 __app=1 标记；服务器域下的业务页面（socket.js 等以
 * location.host 归口连接）无需任何相对路径改造即可正常工作。
 *
 * 死循环防护：带 __app=1 标记的页面视为服务器域业务页，不再执行跳转逻辑。
 *
 * 阶段二百一十六：服务器地址硬编码（用户不可修改）——移除地址配置弹窗与
 * 横幅"更改"入口，仅保留连接提示横幅。
 *
 * 阶段二百三十一：恢复跳转模式并静默跳转——
 * 1. server.url 直启模式实测 Capacitor 桥未注入远程域页面（window.Capacitor
 *    不存在 → nativeBG=false → 保活服务/通知/状态栏等原生插件功能全部静默
 *    失效，切后台进程失保被 ROM 掐网下线），跳转模式（localhost 起始 →
 *    replace 远程域）下桥注入远程页实测可靠，故回退；
 * 2. 原跳转路径先画 900ms"正在连接"横幅再跳——用户反馈登录时横幅反复出现，
 *    改为立即静默跳转（内嵌闪屏页本身已有品牌过渡，无信息损失）。
 */
(function () {
    'use strict';
    // 仅 Capacitor 原生环境生效，浏览器直接访问 web 页不受影响
    var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (!isNative) return;
    // 已在服务器域（跳转后带标记），属于业务页面运行态，直接放行
    if (location.search.indexOf('__app=1') !== -1) return;

    // 服务器地址硬编码，禁止用户修改
    var DEFAULT_SERVER = 'https://im.sxgyxny.com';

    // 同域（server.url 直启态）放行，不跳转
    if (location.host === DEFAULT_SERVER.replace(/^https?:\/\//i, '')) return;

    // 静默跳转：不画横幅（闪屏页即视觉过渡），跳转后 __app=1 标记防死循环
    window.location.replace(DEFAULT_SERVER + '/?__app=1');
})();
