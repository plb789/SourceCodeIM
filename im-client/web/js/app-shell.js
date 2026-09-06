/**
 * app-shell.js —— 手机版 APP 壳引导脚本（Capacitor 打包专用）
 *
 * 原理：APP 本地页面（capacitor://localhost 或 http://localhost 域）加载后，
 * 读取本域 localStorage 中保存的服务器地址，整页跳转到服务器页面并携带
 * __app=1 标记；服务器域下的业务页面（socket.js 等以 location.host 归口连接）
 * 无需任何相对路径改造即可正常工作。
 *
 * 死循环防护：带 __app=1 标记的页面视为服务器域业务页，不再执行跳转逻辑。
 *
 * 服务器地址配置弹窗为自实现 UI（跟随主题色 --primary），不使用系统默认弹窗。
 */
(function () {
    'use strict';
    // 仅 Capacitor 原生环境生效，浏览器直接访问 web 页不受影响
    var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (!isNative) return;
    // 已在服务器域（跳转后带标记），属于业务页面运行态，直接放行
    if (location.search.indexOf('__app=1') !== -1) return;

    var STORE_KEY = 'im_server_url';

    function readSaved() {
        try { return (localStorage.getItem(STORE_KEY) || '').trim(); } catch (e) { return ''; }
    }

    function saveServer(u) {
        try { localStorage.setItem(STORE_KEY, u); } catch (e) {}
    }

    // 规范化服务器地址：补协议、去尾部斜杠
    function normalizeServer(u) {
        u = (u || '').trim();
        if (!u) return '';
        if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u.replace(/\/+$/, '');
    }

    function jump(u) {
        window.location.replace(normalizeServer(u) + '/?__app=1');
    }

    /* ---------- 自实现 UI（遮罩 + 卡片，主题色跟随 --primary） ---------- */
    var cssText =
        '.as-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:inherit}' +
        '.as-card{background:#fff;border-radius:12px;width:82%;max-width:360px;padding:22px 20px 18px;box-shadow:0 8px 30px rgba(0,0,0,.2)}' +
        '.as-title{font-size:17px;font-weight:600;color:#111;margin:0 0 6px;text-align:center}' +
        '.as-sub{font-size:12px;color:#888;margin:0 0 14px;text-align:center;line-height:1.6}' +
        '.as-input{width:100%;box-sizing:border-box;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:14px;outline:none;color:#111;background:#f7f7f7}' +
        '.as-input:focus{border-color:var(--primary,#07c160);background:#fff}' +
        '.as-btn{display:block;width:100%;height:42px;margin-top:14px;border:none;border-radius:8px;background:var(--primary,#07c160);color:#fff;font-size:15px;cursor:pointer}' +
        '.as-btn:active{opacity:.85}' +
        '.as-err{font-size:12px;color:#fa5151;margin:10px 0 0;min-height:16px;text-align:center}' +
        '.as-banner{position:fixed;top:0;left:0;right:0;z-index:99998;background:var(--primary,#07c160);color:#fff;font-size:13px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between}' +
        '.as-banner a{color:#fff;text-decoration:underline;margin-left:12px;white-space:nowrap;cursor:pointer}';

    function injectStyle() {
        var s = document.createElement('style');
        s.textContent = cssText;
        document.head.appendChild(s);
    }

    function showServerDialog(errMsg) {
        var mask = document.createElement('div');
        mask.className = 'as-mask';
        mask.innerHTML =
            '<div class="as-card">' +
            '  <p class="as-title">服务器设置</p>' +
            '  <p class="as-sub">首次使用请填写服务器地址，例如<br>192.168.1.100:8080 或 http://im.example.com</p>' +
            '  <input class="as-input" type="text" placeholder="服务器地址" autocomplete="off">' +
            '  <button class="as-btn">保存并连接</button>' +
            '  <p class="as-err"></p>' +
            '</div>';
        var input = mask.querySelector('.as-input');
        var btn = mask.querySelector('.as-btn');
        var err = mask.querySelector('.as-err');
        if (errMsg) err.textContent = errMsg;
        function submit() {
            var u = normalizeServer(input.value);
            if (!u || !/^https?:\/\/.+/i.test(u)) { err.textContent = '请输入有效的服务器地址'; return; }
            // 连通性探测：能取到任意响应（含 4xx）即视为可达
            err.textContent = '正在连接…';
            fetch(u + '/?__app_probe=' + Date.now(), { method: 'GET', cache: 'no-store' })
                .then(function () { saveServer(u); jump(u); })
                .catch(function () { err.textContent = '无法连接该服务器，请检查地址与网络'; });
        }
        btn.addEventListener('click', submit);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        document.body.appendChild(mask);
        setTimeout(function () { input.focus(); }, 100);
    }

    // 已保存地址：显示连接横幅（期间可点击"更改"重新配置），短暂后自动跳转
    function startWithBanner(u) {
        var banner = document.createElement('div');
        banner.className = 'as-banner';
        banner.innerHTML = '<span>正在连接 ' + normalizeServer(u).replace(/^https?:\/\//i, '') + ' …</span><a>更改</a>';
        var canceled = false;
        banner.querySelector('a').addEventListener('click', function () {
            canceled = true;
            banner.remove();
            showServerDialog();
        });
        document.body.appendChild(banner);
        setTimeout(function () {
            if (!canceled) jump(u);
        }, 900);
    }

    function boot() {
        injectStyle();
        var saved = readSaved();
        if (saved) startWithBanner(saved);
        else showServerDialog();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
