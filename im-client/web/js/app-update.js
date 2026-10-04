/**
 * app-update.js —— 阶段二百六十：客户端自动更新（APP 原生壳 + PC 客户端前端接线）
 *
 * 三形态分流：
 *  1. Capacitor 原生 APP：经 AppUpdater 插件检测（服务端 /api/app/version 归口判定）→
 *     自绘更新弹窗 → 原生下载（SHA256 校验 + 进度事件）→ 拉起系统安装页（Android 无法
 *     静默安装，系统安装页为强制环节；未授权"安装未知应用"时引导跳系统设置）；
 *  2. PC Electron：更新窗由主进程 updater.js + update.html 归口，本脚本仅在设置页"关于"
 *     补「检查更新」按钮接线（desktop.updaterCheck 触发手动检查）；
 *  3. 纯浏览器 WEB：服务端托管部署即全员生效，无壳更新概念，整体旁路。
 *
 * 弹窗为自绘浮层（遵守禁系统弹窗规则），样式挂 im-up- 前缀、颜色全走主题 CSS 变量跟随深浅；
 * 强制更新（服务端 force）无关闭入口、遮罩不可点散、Android 返回键优先消费。
 * 依赖：mobile.js 先于本脚本加载（isNative 同源判定）；chat.js 的 #toast 元素复用提示。
 */
(function () {
    'use strict';

    var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    var isPC = !!(window.desktop && window.desktop.updaterCheck);
    if (!isNative && !isPC) return;

    var PLG = isNative && window.Capacitor.Plugins ? window.Capacitor.Plugins.AppUpdater : null;
    var modalEl = null;      // 弹窗根节点（null=未打开）
    var curInfo = null;      // {version_name, version_code, size, sha256, url, notes, force, file_name}
    var curVersion = '';     // 当前版本显示串
    var downloading = false; // 下载进行中（防重复触发）
    var lastPath = '';       // 已下载 APK 路径（install 用）

    /* ---------- 1. 自绘弹窗 ---------- */
    function ensureStyle() {
        if (document.getElementById('im-up-style')) return;
        var css = [
            '.im-up-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:3410;display:flex;align-items:center;justify-content:center;padding:24px;}',
            '.im-up-box{width:100%;max-width:340px;background:var(--panel-bg);border-radius:12px;padding:20px 18px 16px;box-shadow:0 8px 32px rgba(0,0,0,.35);animation:im-up-in .18s ease-out;display:flex;flex-direction:column;max-height:80vh;}',
            '@keyframes im-up-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}',
            '.im-up-title{font-size:17px;font-weight:600;text-align:center;margin-bottom:6px;color:var(--text);}',
            '.im-up-meta{font-size:12px;color:var(--text-secondary, #888);text-align:center;margin-bottom:10px;}',
            '.im-up-force-tag{display:inline-block;font-size:11px;color:#fff;background:var(--primary);border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:1px;}',
            '.im-up-notes{font-size:13px;line-height:1.6;color:var(--text);background:var(--hover);border-radius:8px;padding:10px 12px;margin-bottom:14px;max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;flex-shrink:1;min-height:0;}',
            '.im-up-progress-wrap{height:6px;border-radius:3px;background:var(--hover);overflow:hidden;margin-bottom:8px;display:none;}',
            '.im-up-progress{height:100%;width:0;border-radius:3px;background:var(--primary);transition:width .25s;}',
            '.im-up-state{font-size:12px;color:var(--text-secondary, #888);text-align:center;min-height:16px;margin-bottom:10px;}',
            '.im-up-btns{display:flex;gap:10px;}',
            '.im-up-btn{flex:1;height:40px;border:none;border-radius:8px;font-size:15px;cursor:pointer;background:var(--hover);color:var(--text);}',
            '.im-up-btn.primary{background:var(--primary);color:#fff;font-weight:500;}',
            '.im-up-btn:disabled{opacity:.55;cursor:default;}',
            'html.m .im-up-mask{padding:0;align-items:flex-end;justify-content:center;}',
            'html.m .im-up-box{max-width:none;width:100%;border-radius:16px 16px 0 0;max-height:78vh;padding-bottom:calc(16px + env(safe-area-inset-bottom));animation:im-up-sheet .2s ease-out;}',
            '@keyframes im-up-sheet{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}'
        ].join('\n');
        var st = document.createElement('style');
        st.id = 'im-up-style';
        st.textContent = css;
        document.head.appendChild(st);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function fmtSize(n) {
        n = +n || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
        return n + ' B';
    }

    function openModal() {
        if (modalEl) return;
        ensureStyle();
        var m = document.createElement('div');
        m.id = 'im-up-mask';
        m.className = 'im-up-mask';
        var force = !!(curInfo && curInfo.force);
        var html = '<div class="im-up-box">' +
            '<div class="im-up-title">发现新版本' + (force ? '<span class="im-up-force-tag">需更新</span>' : '') + '</div>' +
            '<div class="im-up-meta">v' + esc(curInfo && curInfo.version_name) +
            (curVersion ? '　·　当前 ' + esc(curVersion) : '') +
            (curInfo && curInfo.size ? '　·　' + fmtSize(curInfo.size) : '') + '</div>' +
            '<div class="im-up-notes" id="im-up-notes">' + (esc(curInfo && curInfo.notes) || '优化体验，修复已知问题。') + '</div>' +
            '<div class="im-up-progress-wrap" id="im-up-pwrap"><div class="im-up-progress" id="im-up-pbar"></div></div>' +
            '<div class="im-up-state" id="im-up-state"></div>' +
            '<div class="im-up-btns">' +
            (force ? '' : '<button class="im-up-btn" id="im-up-later">以后再说</button>') +
            '<button class="im-up-btn primary" id="im-up-go">立即更新</button>' +
            '</div></div>';
        m.innerHTML = html;
        document.body.appendChild(m);
        modalEl = m;
        // 限高说明区挂全局自绘悬浮滑块（桌面悬停浮现；触屏端原生滚动不受影响）
        var notes = document.getElementById('im-up-notes');
        if (notes && window._osbInit) window._osbInit(notes);
        var later = document.getElementById('im-up-later');
        if (later) later.addEventListener('click', closeModal);
        document.getElementById('im-up-go').addEventListener('click', onGo);
    }

    function closeModal() {
        if (!modalEl) return;
        if (curInfo && curInfo.force) return; // 强制更新不可关闭
        modalEl.remove();
        modalEl = null;
        downloading = false;
        lastPath = ''; // 关闭弹窗清空已下载路径（防跨版本误装：下次检查按新 curInfo 重新走下载，
                       // 同文件由原生 download 的 SHA256 复用逻辑免重下，不同文件才重新下载）
    }

    function setState(text) {
        var el = document.getElementById('im-up-state');
        if (el) el.textContent = text || '';
    }

    function setProgress(percent, show) {
        var wrap = document.getElementById('im-up-pwrap');
        var bar = document.getElementById('im-up-pbar');
        if (!wrap || !bar) return;
        wrap.style.display = show ? 'block' : 'none';
        bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    }

    function setGoText(t, disabled) {
        var go = document.getElementById('im-up-go');
        if (go) {
            go.textContent = t;
            go.disabled = !!disabled;
        }
    }

    /* ---------- 2. 检查 ---------- */
    function toast(text) {
        var el = document.getElementById('toast');
        if (!el) return;
        el.textContent = text;
        el.classList.remove('hidden');
        clearTimeout(el._imUpTimer);
        el._imUpTimer = setTimeout(function () { el.classList.add('hidden'); }, 2500);
    }

    function runCheck(manual) {
        if (!PLG) return;
        PLG.getInfo().then(function (info) {
            curVersion = 'v' + (info.version_name || '?') + '(' + (info.version_code || 0) + ')';
            return PLG.check({ baseUrl: location.origin });
        }).then(function (d) {
            if (!d || !d.has_update) {
                if (manual) toast('已是最新版本');
                return;
            }
            curInfo = d;
            openModal();
        }).catch(function (e) {
            if (manual) toast('检查更新失败：' + ((e && e.message) || '网络异常'));
        });
    }

    /* ---------- 3. 下载 + 安装（原生） ---------- */
    function onGo() {
        if (!PLG || !curInfo) return;
        if (lastPath) { doInstall(lastPath); return; }
        if (downloading) return;
        downloading = true;
        setGoText('下载中…', true);
        setProgress(0, true);
        setState('正在下载新版本（' + fmtSize(curInfo.size) + '）');
        var url = curInfo.url;
        if (url && url.charAt(0) === '/') url = location.origin + url;
        Promise.resolve(PLG.addListener('downloadProgress', function (p) {
            setProgress(p.percent || 0, true);
            setState('已下载 ' + fmtSize(p.received) + (p.total ? ' / ' + fmtSize(p.total) : ''));
        })).then(function (handle) {
            return PLG.download({ url: url, sha256: curInfo.sha256 || '', fileName: curInfo.file_name || 'imapp-update.apk' })
                .then(function (r) { if (handle && handle.remove) handle.remove(); return r; })
                .catch(function (e) { if (handle && handle.remove) handle.remove(); throw e; });
        }).then(function (r) {
            downloading = false;
            lastPath = (r && r.path) || '';
            setProgress(100, true);
            setGoText('立即安装', false);
            setState('下载完成，点击安装');
        }).catch(function (e) {
            downloading = false;
            setGoText('重试下载', false);
            setProgress(0, false);
            setState((e && e.message) || '下载失败，请重试');
        });
    }

    function doInstall(path) {
        setGoText('安装中…', true);
        PLG.install({ path: path }).then(function () {
            // 系统安装页已拉起；弹窗保持（用户取消安装可再次点击），页面回来后可重试
            setGoText('重新安装', false);
            setState('请在系统安装页完成安装');
        }).catch(function (e) {
            setGoText('立即安装', false);
            if (e && e.code === 'NEED_PERM') {
                setState('需授予「安装未知应用」权限');
                PLG.openInstallSetting().catch(function () { /* 个别 ROM 无此设置页 */ });
            } else {
                setState((e && e.message) || '拉起安装页失败');
            }
        });
    }

    /* ---------- 4. 启动自动检查（原生：延迟静默检查，仅弹窗不打扰） ---------- */
    if (isNative && PLG) {
        setTimeout(function () { runCheck(false); }, 6000);
    }

    /* ---------- 4.5 设置页"关于"检查更新入口（APP/PC 显示，浏览器 WEB 旁路） ---------- */
    function bindAboutBtn() {
        var btn = document.getElementById('settings-check-update');
        if (!btn) return;
        btn.style.display = '';
        btn.addEventListener('click', function () {
            if (isPC) window.desktop.updaterCheck();
            else runCheck(true);
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindAboutBtn);
    } else {
        bindAboutBtn();
    }

    /* ---------- 5. 对外接口 ---------- */
    // isOpen/tryClose：mobile.js Android 返回键分级链消费（强制更新不可关=返回键不可退）
    window.IMAppUpdate = {
        isOpen: function () { return !!modalEl; },
        tryClose: function () {
            if (!modalEl) return false;
            if (curInfo && curInfo.force) return true; // 已消费返回键但不关（强制）
            closeModal();
            return true;
        },
        check: function () {
            if (isPC) { window.desktop.updaterCheck(); return; }
            runCheck(true);
        }
    };
})();
