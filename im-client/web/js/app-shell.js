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

    // 阶段二百一十七：capacitor.config.json 已配置 server.url 直启远程域——
    // WebView 起始页即为服务器域（Capacitor 桥注入该域，isNative 恒真），
    // 这里同域直接放行，不再显示连接横幅、不再多余重载
    if (location.host === DEFAULT_SERVER.replace(/^https?:\/\//i, '')) return;

    function jump() {
        window.location.replace(DEFAULT_SERVER + '/?__app=1');
    }

    /* ---------- 连接提示横幅（主题色跟随 --primary，无修改入口） ---------- */
    var cssText =
        '.as-banner{position:fixed;top:0;left:0;right:0;z-index:99998;background:var(--primary,#07c160);color:#fff;font-size:13px;padding:10px 14px;text-align:center}';

    function boot() {
        var s = document.createElement('style');
        s.textContent = cssText;
        document.head.appendChild(s);
        var banner = document.createElement('div');
        banner.className = 'as-banner';
        banner.textContent = '正在连接 ' + DEFAULT_SERVER.replace(/^https?:\/\//i, '') + ' …';
        document.body.appendChild(banner);
        setTimeout(jump, 900);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
