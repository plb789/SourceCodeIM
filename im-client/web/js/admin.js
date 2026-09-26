/* ===== 阶段四十九：后台管理界面逻辑 =====
 * 设计归口：
 *  - 登录走 /admin/api/login（复用 IM 账号体系 + 管理员白名单校验），Token 存 localStorage
 *  - AI 模型服务 / AI 智能体的增删改查走 /admin/api/ai/*，服务端保存后热生效并广播在线客户端
 *  - 全部弹窗为自定义实现（禁用系统默认弹窗）；主题色复用聊天端 CSS 变量体系
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    // ===== 左侧导航图标（纯静态映射：data-view -> Material 填充 path，currentColor 跟随按钮文字色；
    //      本脚本在 body 底部加载，DOM 已就绪可直接注入；缺失映射的项保持纯文字不报错） =====
    (function () {
        var NAV_ICONS = {
            dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
            calllogs: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
            providers: 'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
            agents: 'M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zm-9-5.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5S9.5 5.83 9.5 5s.67-1.5 1.5-1.5z',
            mcp: 'M4 4h7v7H4V4zm0 9h7v7H4v-7zm9 0h7v7h-7v-7zm0-9h7v7h-7V4z',
            mcpplugins: 'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z',
            toolchains: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
            knowledge: 'M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z',
            vecdata: 'M4 4h7v7H4V4zm0 9h7v7H4v-7zm9 0h7v7h-7v-7zm4-9l3 3-3 3-3-3 3-3z',
            agenttasks: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
            accounts: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
            announcements: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
            workbench: 'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',
            points: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
            billing: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z',
            compress: 'M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4zm0 4h7V5H4v2zm16 0v2h-7V5h7z',
            drive: 'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
            filemgr: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
            fileshares: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z',
            uploads: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
            agentsettings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z'
        };
        var nav = document.querySelector('.admin-nav');
        if (!nav) return;
        nav.querySelectorAll('.admin-nav-item').forEach(function (btn) {
            var d = NAV_ICONS[btn.getAttribute('data-view')];
            if (!d || btn.querySelector('svg')) return;
            var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            s.setAttribute('viewBox', '0 0 24 24');
            s.setAttribute('width', '15');
            s.setAttribute('height', '15');
            s.style.flex = 'none';
            var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            p.setAttribute('fill', 'currentColor');
            p.setAttribute('d', d);
            s.appendChild(p);
            btn.insertBefore(s, btn.firstChild);
        });
    })();

    // ===== Toast 轻提示（复用聊天端 .toast 样式） =====
    var toastTimer = null;
    function showToast(msg) {
        var el = $('admin-toast');
        el.textContent = msg;
        el.classList.remove('hidden');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.classList.add('hidden');
        }, 2400);
    }

    // ===== 主题切换（与聊天端共享 im_theme 约定：light → dark → system 循环） =====
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('im_theme', theme);
    }
    // 主题按钮三态图标（与聊天端左下角切换同款 path：浅色=太阳 深色=月亮 跟随系统=显示器；
    // 15px 适配 28px 方形按钮，SVG 内联 admin.html 的调色板仅作无 JS 兜底，此处加载后覆盖）
    var THEME_ICONS = {
        light: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>',
        dark: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 12 3z"/></svg>',
        system: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z"/></svg>'
    };
    function syncThemeBtn() {
        var cur = localStorage.getItem('im_theme') || 'system';
        var btn = $('admin-theme-btn');
        btn.innerHTML = THEME_ICONS[cur] || THEME_ICONS.system;
        btn.title = '当前主题：' + (cur === 'light' ? '浅色' : cur === 'dark' ? '深色' : '跟随系统') + '（点击切换）';
    }
    $('admin-theme-btn').addEventListener('click', function () {
        var cur = localStorage.getItem('im_theme') || 'light';
        var next = cur === 'light' ? 'dark' : (cur === 'dark' ? 'system' : 'light');
        applyTheme(next);
        syncThemeBtn();
        showToast('主题：' + (next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统'));
        refreshDashChartsTheme(); // 图表文字/线条颜色跟随主题变量即时刷新
    });
    syncThemeBtn(); // 初始按已存偏好渲染（登录前后按钮均存在，直接执行）

    // ===== API 封装 =====
    var tokenKey = 'admin_token';
    function getToken() { return localStorage.getItem(tokenKey) || ''; }
    function setToken(t) {
        if (t) localStorage.setItem(tokenKey, t);
        else localStorage.removeItem(tokenKey);
    }
    // 统一请求归口：携带会话 Token；401 时清除本地态回登录页
    function api(method, path, body) {
        return fetch(path, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + getToken()
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        }).then(function (resp) {
            return resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; }).then(function (result) {
                if (resp.status === 401) {
                    setToken('');
                    showLogin();
                    return { ok: false, msg: result.msg || '登录已过期，请重新登录' };
                }
                return result;
            });
        });
    }

    // ===== 视图切换（登录/主界面） =====
    function showLogin() {
        $('admin-login').classList.remove('hidden');
        $('admin-main').classList.add('hidden');
        $('admin-login-password').value = '';
        stopDashboardPolling(); // 离开主界面停止仪表盘轮询
        stopKBPolling(); // 阶段五十一：同步停止知识文件处理状态轮询
        stopMCPPolling(); // 阶段八十九：同步停止 MCP 状态轮询
    }
    function showMain() {
        $('admin-login').classList.add('hidden');
        $('admin-main').classList.remove('hidden');
        loadProviders();
        startDashboardPolling(); // 仪表盘为默认视图，登录即开始轮询
    }

    // ===== 登录 / 退出 =====
    function doLogin() {
        var username = $('admin-login-username').value.trim();
        var password = $('admin-login-password').value;
        if (!username || !password) {
            showToast('请输入账号和密码');
            return;
        }
        api('POST', '/admin/api/login', { username: username, password: password })
            .then(function (result) {
                if (!result.ok) {
                    showToast(result.msg || '登录失败');
                    return;
                }
                setToken(result.data.token);
                $('admin-current-user').textContent = result.data.nickname || result.data.username;
                showMain();
                restoreViewFromHash(); // 与刷新恢复同归口：URL 带 hash 时登录后直达对应视图，行为一致
            })
            .catch(function (e) { showToast(e.message || '网络异常'); });
    }
    $('admin-login-btn').addEventListener('click', doLogin);
    $('admin-login-password').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
    });
    $('admin-login-username').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') $('admin-login-password').focus();
    });
    $('admin-logout-btn').addEventListener('click', function () {
        api('POST', '/admin/api/logout').catch(function () { });
        setToken('');
        showLogin();
    });

    // ===== 侧边导航切换 =====
    var navItems = document.querySelectorAll('.admin-nav-item');
    navItems.forEach(function (item) {
        item.addEventListener('click', function () {
            navItems.forEach(function (n) { n.classList.remove('active'); });
            item.classList.add('active');
            document.querySelectorAll('.admin-view').forEach(function (v) { v.classList.remove('active'); });
            var view = $('admin-view-' + item.dataset.view);
            if (view) view.classList.add('active');
            stopMCPPolling(); // 阶段八十九：切换视图统一切断 MCP 状态轮询，mcp 分支按需重启
            // 进入列表页时刷新数据（agents 依赖 providers 下拉数据，串行加载避免竞态）
            if (item.dataset.view === 'providers') loadProviders();
            if (item.dataset.view === 'agents') loadProviders().then(loadAgents);
            // 原实现：仅处理 providers/agents 两视图，knowledge 视图未触发加载，列表永久卡在占位"加载中…"
            // 阶段五十一：进入知识库视图拉取服务状态与库列表；离开该视图停止处理中文件轮询
            // 阶段五十四：量化数据管理视图同样依赖 embedding 状态（编辑重嵌校验）与库下拉数据
            if (item.dataset.view === 'knowledge') { loadKBStatus(); loadKBList(); }
            else if (item.dataset.view === 'vecdata') { loadKBStatus(); loadVecKbOptions(); loadVecData(); }
            // 阶段六十四：进入 Agent 任务审计视图拉取任务列表
            else if (item.dataset.view === 'agenttasks') { loadAgentTasks(); }
            // 阶段一百三十四：进入账号管理视图拉取账号列表
            else if (item.dataset.view === 'accounts') { loadAccounts(); }
            // 阶段八十一：进入 Agent 设置视图拉取当前生效参数
            else if (item.dataset.view === 'agentsettings') { loadAgentSettings(); loadGitPrompts(); }
            // 阶段一百三十八：进入 AI 计费设置视图拉取当前生效计费配置
            else if (item.dataset.view === 'billing') { loadBillingSettings(); }
            // 阶段一百三十九：进入历史压缩设置视图拉取当前生效压缩配置
            else if (item.dataset.view === 'compress') { loadCompressSettings(); }
            else if (item.dataset.view === 'drive') { loadDriveBlockExts(); }
            // 阶段七十八：进入积分管理视图拉取用户积分列表与流水
            else if (item.dataset.view === 'points') { loadPointsUsers(); loadPointsLogs(); }
            // 阶段八十九：进入 MCP 视图拉取服务器列表并启动状态轮询（连接中/断线状态实时可见）
            else if (item.dataset.view === 'mcp') { loadMCPServers(); startMCPPolling(); }
            // 阶段一百一十三：进入 MCP 插件库视图拉取插件清单（PC 端插件市场数据源）
            else if (item.dataset.view === 'mcpplugins') { loadMCPPlugins(); }
            // 阶段一百二十一：进入工具链市场视图拉取工具链清单（PC 端工具链市场数据源）
            else if (item.dataset.view === 'toolchains') { loadToolchains(); }
            // 阶段一百四十四：进入公告管理视图拉取公告列表
            else if (item.dataset.view === 'announcements') { annLoadList(); }
            // 阶段一百四十七：进入通话统计视图拉取话单列表（重置到第一页）
            else if (item.dataset.view === 'calllogs') { calllogsPage = 1; loadCallLogs(); }
            // 阶段一百四十五：进入工作台管理视图拉取应用清单
            else if (item.dataset.view === 'workbench') { wbLoadList(); }
            // 阶段一百六十七：进入文件存储管理视图拉取存储总览与文件列表（重置到第一页）
            else if (item.dataset.view === 'filemgr') { stopKBPolling(); fmPage = 1; fmLoadStats(); fmLoadFiles(); }
            // 阶段一百六十七：进入分享管理视图拉取全站分享列表（重置到第一页）
            else if (item.dataset.view === 'fileshares') { stopKBPolling(); fsPage = 1; fsLoadShares(); }
            // 阶段一百六十八：进入聊天附件管理视图（总览 + 文件级明细）
            else if (item.dataset.view === 'uploads') { stopKBPolling(); upPage = 1; upLoadStats(); upLoadFiles(); }
            else stopKBPolling();
            // 阶段一百六十七：hash 记忆当前视图——刷新浏览器后原位恢复（replaceState 不产生历史条目；
            // file:// 等特殊环境失败不影响视图切换本身）
            try { history.replaceState(null, '', '#' + item.dataset.view); } catch (e) { /* 忽略 */ }
        });
    });

    // ===== 阶段一百六十七：刷新后视图原位恢复 =====
    // 读 location.hash 匹配导航项并模拟点击（完整复用点击分发：active 态/视图切换/数据加载/轮询归口）；
    // hash 缺失或非法（含 #logout 等历史残留）时保持默认仪表盘不动
    function restoreViewFromHash() {
        var hv = (location.hash || '').replace(/^#/, '');
        if (!hv) return false;
        var hit = null;
        navItems.forEach(function (item) {
            if (item.dataset.view === hv) hit = item;
        });
        if (hit) { hit.click(); return true; }
        return false;
    }

    // ===== 确认弹窗（自定义，禁用系统弹窗） =====
    var confirmCb = null;
    function confirmBox(text, cb) {
        $('admin-confirm-text').textContent = text;
        confirmCb = cb;
        $('admin-confirm-mask').classList.remove('hidden');
    }
    $('admin-confirm-cancel').addEventListener('click', function () {
        $('admin-confirm-mask').classList.add('hidden');
        confirmCb = null;
    });
    $('admin-confirm-ok').addEventListener('click', function () {
        $('admin-confirm-mask').classList.add('hidden');
        if (confirmCb) { var cb = confirmCb; confirmCb = null; cb(); }
    });

    // ===== 编辑弹窗（动态表单） =====
    // fields: [{key,label,type,default,hint,options,placeholder}]
    var editSaveCb = null;
    function openEditModal(title, fields, values, onSave) {
        $('admin-edit-title').textContent = title;
        var form = $('admin-edit-form');
        form.innerHTML = '';
        fields.forEach(function (f) {
            var wrap = document.createElement('div');
            var val = values && values[f.key] !== undefined ? values[f.key] : (f.default !== undefined ? f.default : '');
            if (f.type === 'checkbox') {
                wrap.className = 'admin-field admin-field-check';
                var input = document.createElement('input');
                input.type = 'checkbox';
                input.id = 'af_' + f.key;
                input.checked = !!val;
                var label = document.createElement('label');
                label.htmlFor = 'af_' + f.key;
                label.textContent = f.label;
                wrap.appendChild(input);
                wrap.appendChild(label);
            } else {
                wrap.className = 'admin-field';
                var label2 = document.createElement('label');
                label2.textContent = f.label;
                wrap.appendChild(label2);
                var input2;
                if (f.type === 'textarea') {
                    input2 = document.createElement('textarea');
                } else if (f.type === 'select') {
                    input2 = document.createElement('select');
                    (f.options || []).forEach(function (opt) {
                        var o = document.createElement('option');
                        o.value = opt.value;
                        o.textContent = opt.label;
                        input2.appendChild(o);
                    });
                } else if (f.type === 'multiselect') {
                    // 阶段五十一：多选下拉（智能体绑定知识库 kb_ids 用）
                    // 预选中在 option 生成时按值匹配处理（val 为逗号分隔 ID 串）
                    input2 = document.createElement('select');
                    input2.multiple = true;
                    var selArr = String(val || '').split(',').filter(function (s) { return s.trim(); });
                    (f.options || []).forEach(function (opt) {
                        var o = document.createElement('option');
                        o.value = opt.value;
                        o.textContent = opt.label;
                        if (selArr.indexOf(String(opt.value)) !== -1) o.selected = true;
                        input2.appendChild(o);
                    });
                } else {
                    input2 = document.createElement('input');
                    input2.type = f.type || 'text';
                }
                input2.id = 'af_' + f.key;
                if (f.placeholder) input2.placeholder = f.placeholder;
                // multiselect 预选中已在 option 生成时处理，value 赋值与补选项逻辑均不适用
                // 原实现：统一走 value 赋值 + 原值补选项，对 multiple select 语义不成立
                if (f.type === 'multiselect') { /* 已处理，跳过 */ }
                else {
                    if (f.type !== 'select') input2.value = val;
                    else input2.value = val;
                    // select 当前值不在选项中（如绑定的服务已停用被过滤）时补一个原值选项，避免保存后静默丢失绑定
                    if (f.type === 'select' && val && input2.value !== String(val)) {
                        var keep = document.createElement('option');
                        keep.value = val;
                        keep.textContent = val + '（当前值，选项已不可见）';
                        input2.appendChild(keep);
                        input2.value = val;
                    }
                }
                if (f.hint) {
                    var hint = document.createElement('span');
                    hint.className = 'admin-field-hint';
                    hint.textContent = f.hint;
                    wrap.appendChild(input2);
                    wrap.appendChild(hint);
                } else {
                    wrap.appendChild(input2);
                }
            }
            form.appendChild(wrap);
        });
        editSaveCb = onSave;
        $('admin-edit-mask').classList.remove('hidden');
        var first = form.querySelector('input, textarea, select');
        if (first) first.focus();
    }
    function collectEditForm() {
        var data = {};
        $('admin-edit-form').querySelectorAll('input, textarea, select').forEach(function (el) {
            if (!el.id || el.id.indexOf('af_') !== 0) return;
            var key = el.id.slice(3);
            if (el.multiple) {
                // 阶段五十一：多选下拉归并为逗号分隔 ID 串（与服务端 kb_ids 字段格式一致）
                data[key] = Array.prototype.filter.call(el.options, function (o) { return o.selected; })
                    .map(function (o) { return o.value; }).join(',');
            } else if (el.type === 'checkbox') data[key] = el.checked;
            else data[key] = el.value;
        });
        return data;
    }
    function closeEditModal() {
        $('admin-edit-mask').classList.add('hidden');
        editSaveCb = null;
    }
    $('admin-edit-cancel').addEventListener('click', closeEditModal);
    // 保存回调不在此处清空：校验失败时保留回调支持再次点击保存，closeEditModal 归口清理
    $('admin-edit-ok').addEventListener('click', function () {
        if (!editSaveCb) return;
        editSaveCb(collectEditForm());
    });
    // Escape 关闭弹窗
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!$('admin-edit-mask').classList.contains('hidden')) closeEditModal();
        if (!$('admin-confirm-mask').classList.contains('hidden')) {
            $('admin-confirm-mask').classList.add('hidden');
            confirmCb = null;
        }
        // 阶段五十二：切片查看弹窗同步支持 Escape 关闭
        if (!$('admin-chunks-mask').classList.contains('hidden')) {
            $('admin-chunks-mask').classList.add('hidden');
        }
        // 阶段八十九：MCP 工具/日志弹窗与 JSON 导入弹窗同步支持 Escape 关闭
        if (!$('mcp-tools-mask').classList.contains('hidden')) {
            $('mcp-tools-mask').classList.add('hidden');
            mcpToolsCtx = null;
        }
        if (!$('mcp-import-mask').classList.contains('hidden')) {
            $('mcp-import-mask').classList.add('hidden');
        }
    });

    // ===== AI 模型服务管理 =====
    var providers = [];
    // loadProviders 返回 Promise：agents 视图（下拉数据依赖）串行等待，避免加载竞态
    function loadProviders() {
        return api('GET', '/admin/api/ai/providers').then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载失败'); return; }
            providers = result.data || [];
            renderProviders();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }
    function renderProviders() {
        var box = $('provider-list');
        box.innerHTML = '';
        if (!providers.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '暂无模型服务，点击右上角新增';
            box.appendChild(empty);
            return;
        }
        providers.forEach(function (p) {
            var card = document.createElement('div');
            card.className = 'admin-card' + (p.enabled ? '' : ' disabled');

            var main = document.createElement('div');
            main.className = 'admin-card-main';
            var name = document.createElement('div');
            name.className = 'admin-card-name';
            name.textContent = p.name;
            var tagModel = document.createElement('span');
            tagModel.className = 'admin-card-tag';
            tagModel.textContent = p.model;
            name.appendChild(tagModel);
            if (p.supports_image) {
                var tagImg = document.createElement('span');
                tagImg.className = 'admin-card-tag';
                tagImg.textContent = '支持图片';
                name.appendChild(tagImg);
            }
            if (!p.enabled) {
                var tagOff = document.createElement('span');
                tagOff.className = 'admin-card-tag off';
                tagOff.textContent = '已停用';
                name.appendChild(tagOff);
            }
            var desc = document.createElement('div');
            desc.className = 'admin-card-desc';
            desc.textContent = p.api_url;
            desc.title = p.api_url;
            main.appendChild(name);
            main.appendChild(desc);
            card.appendChild(main);

            var actions = document.createElement('div');
            actions.className = 'admin-card-actions';
            var editBtn = document.createElement('button');
            editBtn.className = 'admin-btn small';
            editBtn.textContent = '编辑';
            editBtn.addEventListener('click', function () { openProviderModal(p); });
            var delBtn = document.createElement('button');
            delBtn.className = 'admin-btn small danger';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                confirmBox('确定删除模型服务「' + p.name + '」吗？', function () {
                    api('DELETE', '/admin/api/ai/providers/' + p.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除并热生效');
                        loadProviders();
                    });
                });
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            card.appendChild(actions);
            box.appendChild(card);
        });
    }
    function openProviderModal(p) {
        var fields = [
            { key: 'name', label: '服务名称（智能体绑定锚点，全局唯一）', placeholder: '如：deepseek' },
            { key: 'api_url', label: '接口地址（OpenAI 兼容 chat/completions 完整 URL）', placeholder: 'https://api.deepseek.com/v1/chat/completions' },
            { key: 'api_key', label: 'API 密钥（仅存服务端数据库）', type: 'password', placeholder: 'sk-...' },
            { key: 'model', label: '模型名（文本对话用）', placeholder: '如：deepseek-v4-flash' },
            { key: 'vision_model', label: '视觉模型名（选填，发图提问时自动启用）', placeholder: '如：deepseek-v4-flash-vision-exp' },
            { key: 'supports_image', label: '支持图片识别（多模态模型勾选）', type: 'checkbox' },
            { key: 'enabled', label: '启用（停用后绑定的智能体降级本地演示应答）', type: 'checkbox', default: true }
        ];
        openEditModal(p ? '编辑模型服务' : '新增模型服务', fields, p || {}, function (data) {
            if (!data.name.trim() || !data.api_url.trim() || !data.model.trim()) {
                showToast('名称、接口地址、模型名均不能为空');
                return; // 弹窗保留，可修正后再次保存
            }
            saveProvider(p, data);
        });
    }
    function saveProvider(p, data) {
        var req = p ? api('PUT', '/admin/api/ai/providers/' + p.id, data) : api('POST', '/admin/api/ai/providers', data);
        req.then(function (result) {
            if (!result.ok) { showToast(result.msg || '保存失败'); return; }
            closeEditModal();
            showToast(p ? '已保存并热生效' : '已新增并热生效');
            loadProviders();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }
    $('provider-add').addEventListener('click', function () { openProviderModal(null); });

    // ===== AI 智能体管理 =====
    function providerOptions() {
        var opts = [{ value: '', label: '不绑定（本地演示应答）' }];
        providers.forEach(function (p) {
            if (p.enabled) opts.push({ value: p.name, label: p.name + '（' + p.model + '）' });
        });
        return opts;
    }
    function loadAgents() {
        api('GET', '/admin/api/ai/agents').then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载失败'); return; }
            renderAgents(result.data || []);
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }
    function renderAgents(list) {
        var box = $('agent-list');
        box.innerHTML = '';
        if (!list.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '暂无智能体，点击右上角新增';
            box.appendChild(empty);
            return;
        }
        list.forEach(function (a) {
            var card = document.createElement('div');
            card.className = 'admin-card' + (a.enabled ? '' : ' disabled');

            // 头像：配置图片优先，缺失回退 🤖（与聊天端规则一致）
            var avatar = document.createElement('div');
            avatar.className = 'admin-card-avatar';
            if (a.avatar) {
                var img = document.createElement('img');
                img.src = a.avatar;
                img.addEventListener('error', function () { img.remove(); avatar.textContent = '🤖'; });
                avatar.appendChild(img);
            } else {
                avatar.textContent = '🤖';
            }
            card.appendChild(avatar);

            var main = document.createElement('div');
            main.className = 'admin-card-main';
            var name = document.createElement('div');
            name.className = 'admin-card-name';
            name.textContent = a.name;
            var tagProv = document.createElement('span');
            tagProv.className = 'admin-card-tag' + (a.provider ? '' : ' off');
            tagProv.textContent = a.provider || '本地演示';
            name.appendChild(tagProv);
            if (!a.enabled) {
                var tagOff = document.createElement('span');
                tagOff.className = 'admin-card-tag off';
                tagOff.textContent = '已停用';
                name.appendChild(tagOff);
            }
            var desc = document.createElement('div');
            desc.className = 'admin-card-desc';
            desc.textContent = a.system_prompt || '（未设置系统提示词）';
            desc.title = a.system_prompt;
            main.appendChild(name);
            main.appendChild(desc);
            card.appendChild(main);

            var actions = document.createElement('div');
            actions.className = 'admin-card-actions';
            var editBtn = document.createElement('button');
            editBtn.className = 'admin-btn small';
            editBtn.textContent = '编辑';
            editBtn.addEventListener('click', function () { editAgent(a); });
            var delBtn = document.createElement('button');
            delBtn.className = 'admin-btn small danger';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                confirmBox('确定删除智能体「' + a.name + '」吗？', function () {
                    api('DELETE', '/admin/api/ai/agents/' + a.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除并热生效');
                        loadAgents();
                    });
                });
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            card.appendChild(actions);
            box.appendChild(card);
        });
    }
    function openAgentModal(a) {
        var fields = [
            { key: 'name', label: '智能体名称（全局唯一，会话列表展示名）', placeholder: '如：AI助手' },
            { key: 'provider', label: '绑定模型服务', type: 'select', options: providerOptions() },
            { key: 'system_prompt', label: '系统提示词（人设/能力定义）', type: 'textarea', placeholder: '你是一个即时通讯软件内的智能助手...' },
            { key: 'avatar', label: '头像 URL（留空显示 🤖 占位）', placeholder: 'https://... 或 /static/avatar/...' },
            // 阶段五十一：绑定知识库多选（RAG 检索注入；公共库对全体用户生效，个人库仅归属者生效）
            // 原实现：fields 漏配 kb_ids 字段，导致表单无知识库绑定入口（服务端与收集逻辑均已就绪）
            { key: 'kb_ids', label: '绑定知识库（可多选，Ctrl+点击 加选/取消）', type: 'multiselect', options: kbOptions(), default: '',
                hint: kbList.length ? '公共库绑定后对所有用户生效；个人库仅归属者与该智能体对话时参与检索' : '暂无知识库，请先到"知识库"页新建' },
            { key: 'sort_id', label: '排序号（越小越靠前）', type: 'text', default: 0 },
            { key: 'enabled', label: '启用（停用后不再下发客户端）', type: 'checkbox', default: true }
        ];
        openEditModal(a ? '编辑智能体' : '新增智能体', fields, a || {}, function (data) {
            if (!data.name.trim()) {
                showToast('智能体名称不能为空');
                return;
            }
            data.sort_id = parseInt(data.sort_id, 10) || 0;
            var req = a ? api('PUT', '/admin/api/ai/agents/' + a.id, data) : api('POST', '/admin/api/ai/agents', data);
            req.then(function (result) {
                if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                closeEditModal();
                showToast(a ? '已保存并热生效' : '已新增并热生效');
                loadAgents();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }
    $('agent-add').addEventListener('click', function () {
        // 新增前确保 provider 与知识库下拉数据就绪（串行加载避免竞态）
        loadProviders().then(loadKBList).then(function () { openAgentModal(null); });
    });
    // 编辑智能体同样先拉取知识库列表（kb_ids 预选中依赖最新数据）
    function editAgent(a) {
        loadProviders().then(loadKBList).then(function () { openAgentModal(a); });
    }

    // ===== 知识库管理（阶段五十一：库 CRUD/文件向量化/命中测试） =====
    var kbList = [];          // 库列表（含 file_count/chunk_count 聚合）
    var kbEmbedOn = false;    // embedding 通道是否可用（服务端状态归口）
    var kbSelectedId = 0;     // 当前选中的库（文件管理面板）
    var kbSelectedName = '';
    var kbPollTimer = null;   // 处理中文件轮询定时器

    // kbOptions 智能体表单的知识库下拉选项归口（标注范围与归属者）
    function kbOptions() {
        return kbList.map(function (k) {
            var label = k.name + (k.scope === 'user' ? '（个人·' + k.owner + '）' : '（公共）');
            return { value: String(k.id), label: label };
        });
    }

    function loadKBStatus() {
        return api('GET', '/admin/api/kb/status').then(function (result) {
            if (!result.ok) { $('kb-status').textContent = result.msg || '加载失败'; return; }
            kbEmbedOn = !!result.data.embed_enabled;
            if (!kbEmbedOn) {
                $('kb-status').textContent = 'embedding 未配置（config.yaml ai.embedding），可建库但文件无法向量化';
                return;
            }
            // 阶段五十二：状态行归口展示检索阈值（0=不过滤）与引用溯源开关说明
            var th = Number(result.data.score_threshold) || 0;
            var thText = th > 0 ? ' · 相似度阈值 ' + th : ' · 阈值不过滤';
            $('kb-status').textContent = '向量模型 ' + result.data.model + ' · 切片 ' + result.data.chunk_size
                + ' 字 · 注入 ' + result.data.top_k + ' 条' + thText;
        }).catch(function () { $('kb-status').textContent = '网络异常'; });
    }

    function loadKBList() {
        return api('GET', '/admin/api/kb/list').then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载知识库失败'); return; }
            kbList = result.data || [];
            renderKBList();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    function renderKBList() {
        var box = $('kb-list');
        box.innerHTML = '';
        if (!kbList.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '暂无知识库，点击右上角新增';
            box.appendChild(empty);
            return;
        }
        kbList.forEach(function (k) {
            var card = document.createElement('div');
            card.className = 'admin-card' + (k.id === kbSelectedId ? ' selected' : '');

            var main = document.createElement('div');
            main.className = 'admin-card-main';
            var name = document.createElement('div');
            name.className = 'admin-card-name';
            name.textContent = k.name;
            var tagScope = document.createElement('span');
            tagScope.className = 'admin-card-tag';
            tagScope.textContent = k.scope === 'user' ? '个人·' + k.owner : '公共';
            name.appendChild(tagScope);
            if (k.dim > 0) {
                var tagDim = document.createElement('span');
                tagDim.className = 'admin-card-tag';
                tagDim.textContent = '维度 ' + k.dim;
                name.appendChild(tagDim);
            }
            var stat = document.createElement('div');
            stat.className = 'admin-card-desc';
            stat.textContent = k.desc || (k.file_count + ' 个文件 · ' + k.chunk_count + ' 个切片');
            main.appendChild(name);
            main.appendChild(stat);
            card.appendChild(main);

            var actions = document.createElement('div');
            actions.className = 'admin-card-actions';
            var fileBtn = document.createElement('button');
            fileBtn.className = 'admin-btn small';
            fileBtn.textContent = '文件管理';
            fileBtn.addEventListener('click', function () { selectKB(k); });
            var editBtn = document.createElement('button');
            editBtn.className = 'admin-btn small';
            editBtn.textContent = '编辑';
            editBtn.addEventListener('click', function () { openKBModal(k); });
            var delBtn = document.createElement('button');
            delBtn.className = 'admin-btn small danger';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                confirmBox('确定删除知识库「' + k.name + '」吗？库内文件与向量数据将一并清理。', function () {
                    api('DELETE', '/admin/api/kb/' + k.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('知识库已删除');
                        if (kbSelectedId === k.id) { kbSelectedId = 0; $('kb-detail').classList.add('hidden'); }
                        loadKBList();
                    }).catch(function (e) { showToast(e.message || '网络异常'); });
                });
            });
            actions.appendChild(fileBtn);
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            card.appendChild(actions);
            box.appendChild(card);
        });
    }

    function openKBModal(k) {
        var fields = [
            { key: 'name', label: '知识库名称（同范围下唯一）', placeholder: '如：产品手册' },
            {
                key: 'scope', label: '库范围', type: 'select', options: [
                    { value: 'public', label: '公共库（绑定智能体后对所有用户生效）' },
                    { value: 'user', label: '个人库（仅归属者与智能体对话时生效）' }
                ]
            },
            { key: 'owner', label: '归属用户名（个人库必填，公共库留空）', placeholder: '如：zhangsan' },
            { key: 'desc', label: '库描述（用途说明）', placeholder: '选填' }
        ];
        openEditModal(k ? '编辑知识库' : '新增知识库', fields, k || {}, function (data) {
            if (!data.name.trim()) { showToast('知识库名称不能为空'); return; }
            var req = k ? api('PUT', '/admin/api/kb/' + k.id, data) : api('POST', '/admin/api/kb', data);
            req.then(function (result) {
                if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                closeEditModal();
                showToast(k ? '知识库已更新' : '知识库已创建');
                loadKBList();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }
    $('kb-add').addEventListener('click', function () { openKBModal(null); });

    // ===== 文件管理（选中库后展示：上传/状态轮询/删除） =====
    function selectKB(k) {
        kbSelectedId = k.id;
        kbSelectedName = k.name;
        $('kb-detail').classList.remove('hidden');
        $('kb-detail-title').textContent = '文件管理 — ' + k.name;
        $('kb-test-result').innerHTML = '';
        $('kb-test-query').value = '';
        renderKBList(); // 高亮选中卡片
        loadKBFiles();
    }

    function loadKBFiles() {
        if (!kbSelectedId) return;
        return api('GET', '/admin/api/kb/' + kbSelectedId + '/files').then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载文件列表失败'); return; }
            renderKBFiles(result.data || []);
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // kbFileStatusTag 文件状态标签归口：processing 处理中 / ready 已就绪 / failed 失败
    function kbFileStatusTag(status, chunks, errText) {
        if (status === 'ready') return '已就绪 · ' + chunks + ' 个切片';
        if (status === 'failed') return '失败：' + (errText || '未知原因');
        return '处理中…';
    }

    function renderKBFiles(files) {
        var box = $('kb-file-list');
        box.innerHTML = '';
        if (!files.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '暂无文件，上传后将自动解析、切片并向量化';
            box.appendChild(empty);
        }
        var hasProcessing = false;
        files.forEach(function (f) {
            if (f.status === 'processing') hasProcessing = true;
            var row = document.createElement('div');
            row.className = 'admin-kb-file-row';

            var info = document.createElement('div');
            info.className = 'admin-kb-file-info';
            var nm = document.createElement('div');
            nm.className = 'admin-kb-file-name';
            nm.textContent = f.name;
            var st = document.createElement('div');
            st.className = 'admin-kb-file-status ' + f.status;
            st.textContent = kbFileStatusTag(f.status, f.chunks, f.error) + ' · ' + (f.size / 1024).toFixed(1) + ' KB';
            info.appendChild(nm);
            info.appendChild(st);
            row.appendChild(info);

            // 阶段五十二：操作按钮区（切片查看 / 单文件重建 / 删除）
            var btnBox = document.createElement('div');
            btnBox.className = 'admin-kb-file-btns';

            // 切片查看：仅已就绪且有切片的文件可看（验证切片质量与入库内容）
            if (f.status === 'ready' && f.chunks > 0) {
                var chunkBtn = document.createElement('button');
                chunkBtn.className = 'admin-btn small';
                chunkBtn.textContent = '切片';
                chunkBtn.addEventListener('click', function () { kbViewChunks(f); });
                btnBox.appendChild(chunkBtn);
            }
            // 阶段五十三：源文编辑（仅纯文本类文件，docx/xlsx 为二进制容器无法回写）
            if (f.status !== 'processing' && kbIsSourceEditable(f.name)) {
                var srcBtn = document.createElement('button');
                srcBtn.className = 'admin-btn small';
                srcBtn.textContent = '源文';
                srcBtn.addEventListener('click', function () { kbOpenSourceModal(f); });
                btnBox.appendChild(srcBtn);
            }
            // 单文件重新向量化：处理中禁用（服务端防双流水线并发，前端同步隐藏入口）
            if (f.status !== 'processing') {
                var rebuildBtn = document.createElement('button');
                rebuildBtn.className = 'admin-btn small';
                rebuildBtn.textContent = '重建';
                rebuildBtn.addEventListener('click', function () {
                    if (!kbEmbedOn) { showToast('embedding 服务未配置，无法重建（config.yaml ai.embedding）'); return; }
                    confirmBox('确定重新向量化文件「' + f.name + '」吗？将清空其现有向量后按磁盘原文件重跑流水线。', function () {
                        api('POST', '/admin/api/kb/file/' + f.id + '/rebuild').then(function (result) {
                            if (!result.ok) { showToast(result.msg || '重建失败'); return; }
                            showToast('已发起重建，异步向量化中');
                            loadKBFiles();
                        }).catch(function (e) { showToast(e.message || '网络异常'); });
                    });
                });
                btnBox.appendChild(rebuildBtn);
            }

            var delBtn = document.createElement('button');
            delBtn.className = 'admin-btn small danger';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                confirmBox('确定删除文件「' + f.name + '」吗？其向量数据将一并清理。', function () {
                    api('DELETE', '/admin/api/kb/file/' + f.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('文件已删除');
                        loadKBFiles();
                        loadKBList(); // 刷新文件/切片计数
                    }).catch(function (e) { showToast(e.message || '网络异常'); });
                });
            });
            btnBox.appendChild(delBtn);
            row.appendChild(btnBox);
            box.appendChild(row);
        });
        // 有处理中文件时 2 秒轮询刷新状态，全部完成后自动停止
        if (hasProcessing) {
            if (!kbPollTimer) kbPollTimer = setInterval(loadKBFiles, 2000);
        } else if (kbPollTimer) {
            clearInterval(kbPollTimer);
            kbPollTimer = null;
        }
    }

    // kbUploadFile 上传归口：FormData 走 multipart，Authorization 会话头与 api() 同规则
    function kbUploadFile() {
        var input = $('kb-file-input');
        if (!kbSelectedId) { showToast('请先在上方选择知识库'); return; }
        if (!input.files || !input.files.length) { showToast('请先选择要上传的文件'); return; }
        if (!kbEmbedOn) { showToast('embedding 服务未配置，文件无法向量化（config.yaml ai.embedding）'); return; }
        var fd = new FormData();
        fd.append('file', input.files[0]);
        $('kb-file-tip').textContent = '上传中…';
        fetch('/admin/api/kb/' + kbSelectedId + '/files', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + getToken() },
            body: fd
        }).then(function (resp) {
            // 会话失效与 api() 同规则：清 Token 回登录页（401 状态在响应对象上，解析后归口判断）
            return resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; }).then(function (result) {
                if (resp.status === 401) { setToken(''); showLogin(); return { ok: false, msg: '登录已过期，请重新登录' }; }
                return result;
            });
        }).then(function (result) {
            if (!result.ok) { $('kb-file-tip').textContent = ''; showToast(result.msg || '上传失败'); return; }
            input.value = '';
            $('kb-file-tip').textContent = '已上传，异步向量化中';
            loadKBFiles();
            loadKBList();
        }).catch(function (e) {
            $('kb-file-tip').textContent = '';
            showToast(e.message || '网络异常');
        });
    }
    $('kb-file-upload').addEventListener('click', kbUploadFile);
    $('kb-file-refresh').addEventListener('click', loadKBFiles);

    // ===== 阶段五十二：知识维护增强（文本直贴 / 切片查看 / 重新向量化） =====

    // kbOpenTextModal 文本直贴建知识：内容提交服务端落盘为 .txt 后复用现有向量化流水线（零特殊化）
    function kbOpenTextModal() {
        if (!kbSelectedId) { showToast('请先在上方选择知识库'); return; }
        if (!kbEmbedOn) { showToast('embedding 服务未配置，无法向量化（config.yaml ai.embedding）'); return; }
        openEditModal('文本直贴 — ' + kbSelectedName, [
            { key: 'name', label: '条目名称（回答引用时的来源标注名，留空默认「文本条目」）', placeholder: '如：退货政策' },
            { key: 'content', label: '知识内容（支持多行，空行分段有助于提升切片质量）', type: 'textarea', placeholder: '在此粘贴知识文本…' }
        ], {}, function (data) {
            if (!data.content.trim()) { showToast('知识内容不能为空'); return; }
            api('POST', '/admin/api/kb/' + kbSelectedId + '/text', { name: data.name.trim(), content: data.content }).then(function (result) {
                if (!result.ok) { showToast(result.msg || '提交失败'); return; }
                closeEditModal();
                showToast('已提交，异步向量化中');
                loadKBFiles();
                loadKBList();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }
    $('kb-file-text').addEventListener('click', kbOpenTextModal);

    // ===== 阶段五十三：源文编辑（读取磁盘源文本 → 弹窗编辑 → 保存后服务端覆写并触发单文件重建） =====

    // kbIsSourceEditable 前端侧文本类文件判定（与服务端 kbSourceEditable 同规：txt/md/csv）
    function kbIsSourceEditable(name) {
        return /\.(txt|md|csv)$/i.test(name || '');
    }

    // kbOpenSourceModal 源文编辑弹窗：回显磁盘源文本，保存触发重新切片+向量化
    function kbOpenSourceModal(f) {
        if (!kbEmbedOn) { showToast('embedding 服务未配置，保存后无法重建（config.yaml ai.embedding）'); return; }
        api('GET', '/admin/api/kb/file/' + f.id + '/source').then(function (result) {
            if (!result.ok) { showToast(result.msg || '读取源文件失败'); return; }
            openEditModal('编辑源文 — ' + f.name, [
                { key: 'content', label: '源文本内容（保存后将覆写源文件并重新切片、向量化）', type: 'textarea' }
            ], { content: result.data.content }, function (data) {
                if (!data.content.trim()) { showToast('源文件内容不能为空'); return; }
                api('PUT', '/admin/api/kb/file/' + f.id + '/source', { content: data.content }).then(function (res) {
                    if (!res.ok) { showToast(res.msg || '保存失败'); return; }
                    closeEditModal();
                    showToast('源文已保存，重新向量化中');
                    loadKBFiles();
                }).catch(function (e) { showToast(e.message || '网络异常'); });
            });
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // 整库重建：embedding 模型变更后使用，服务端清空向量集合后串行重跑全部文件
    $('kb-rebuild-btn').addEventListener('click', function () {
        if (!kbSelectedId) { showToast('请先在上方选择知识库'); return; }
        if (!kbEmbedOn) { showToast('embedding 服务未配置，无法重建（config.yaml ai.embedding）'); return; }
        confirmBox('确定对知识库「' + kbSelectedName + '」整库重建吗？全部文件将清空现有向量并串行重新向量化，期间检索结果可能不全。', function () {
            api('POST', '/admin/api/kb/' + kbSelectedId + '/rebuild').then(function (result) {
                if (!result.ok) { showToast(result.msg || '重建失败'); return; }
                showToast('整库重建已启动（' + ((result.data && result.data.files) || 0) + ' 个文件，串行处理）');
                loadKBFiles();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    });

    // kbViewChunks 切片查看弹窗：展示文件已入库的全部切片内容、字数与向量摘要（阶段五十三：支持单切片编辑/删除）
    function kbViewChunks(f) {
        $('admin-chunks-title').textContent = '切片详情 — ' + f.name;
        var box = $('admin-chunks-list');
        box.innerHTML = '<div class="admin-card-empty">加载中…</div>';
        $('admin-chunks-mask').classList.remove('hidden');
        api('GET', '/admin/api/kb/file/' + f.id + '/chunks').then(function (result) {
            if (!result.ok) {
                box.innerHTML = '';
                $('admin-chunks-mask').classList.add('hidden');
                showToast(result.msg || '查询切片失败');
                return;
            }
            var list = (result.data && result.data.chunk_list) || [];
            box.innerHTML = '';
            if (!list.length) {
                var empty = document.createElement('div');
                empty.className = 'admin-card-empty';
                empty.textContent = '暂无已入库切片（文件未就绪或向量已清空，可点击「重建」重新向量化）';
                box.appendChild(empty);
                return;
            }
            list.forEach(function (c) {
                var item = document.createElement('div');
                item.className = 'admin-chunk-item';
                // 头行：序号/字数/向量摘要 + 右侧编辑删除按钮区
                var headRow = document.createElement('div');
                headRow.className = 'admin-chunk-head-row';
                var head = document.createElement('div');
                head.className = 'admin-chunk-head';
                head.textContent = '切片 #' + c.chunk + ' · ' + c.chars + ' 字 · ' + c.dim + ' 维 · 范数 ' + Number(c.norm).toFixed(4);
                var actions = document.createElement('div');
                actions.className = 'admin-chunk-actions';
                // 编辑：删旧片 → 服务端重嵌新文 → 同 ID 写回（立即生效；整库/单文件重建会覆盖）
                var editBtn = document.createElement('button');
                editBtn.className = 'admin-btn small';
                editBtn.textContent = '编辑';
                editBtn.addEventListener('click', function () {
                    if (!kbEmbedOn) { showToast('embedding 服务未配置，无法重嵌切片'); return; }
                    openEditModal('编辑切片 #' + c.chunk + ' — ' + f.name, [
                        { key: 'content', label: '切片内容（保存后自动重新向量化；源文件不改动，重建时将被覆盖）', type: 'textarea' }
                    ], { content: c.content }, function (data) {
                        if (!data.content.trim()) { showToast('切片内容不能为空'); return; }
                        api('PUT', '/admin/api/kb/file/' + f.id + '/chunk/' + c.chunk, { content: data.content }).then(function (res) {
                            if (!res.ok) { showToast(res.msg || '保存失败'); return; }
                            closeEditModal();
                            showToast('切片已更新并重新向量化');
                            kbViewChunks(f);
                        }).catch(function (e) { showToast(e.message || '网络异常'); });
                    });
                });
                // 删除：向量库层面移除该切片（末片删除联动收缩计数）
                var delBtn = document.createElement('button');
                delBtn.className = 'admin-btn small danger';
                delBtn.textContent = '删除';
                delBtn.addEventListener('click', function () {
                    confirmBox('确定删除切片 #' + c.chunk + ' 吗？该切片将从向量库移除，不再参与检索。', function () {
                        api('DELETE', '/admin/api/kb/file/' + f.id + '/chunk/' + c.chunk).then(function (res) {
                            if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                            showToast('切片已删除');
                            kbViewChunks(f);
                            loadKBFiles();
                            loadKBList();
                        }).catch(function (e) { showToast(e.message || '网络异常'); });
                    });
                });
                actions.appendChild(editBtn);
                actions.appendChild(delBtn);
                headRow.appendChild(head);
                headRow.appendChild(actions);
                // 向量前 8 维预览（健康检查：归一化向量范数应≈1）
                var vec = document.createElement('div');
                vec.className = 'admin-chunk-vec';
                vec.textContent = '向量前 8 维：' + (c.head || []).map(function (v) { return Number(v).toFixed(4); }).join(', ');
                var body = document.createElement('div');
                body.className = 'admin-chunk-content';
                body.textContent = c.content;
                item.appendChild(headRow);
                item.appendChild(vec);
                item.appendChild(body);
                box.appendChild(item);
            });
        }).catch(function (e) {
            box.innerHTML = '';
            $('admin-chunks-mask').classList.add('hidden');
            showToast(e.message || '网络异常');
        });
    }
    $('admin-chunks-close').addEventListener('click', function () {
        $('admin-chunks-mask').classList.add('hidden');
    });

    // ===== 检索调试（阶段五十三：单库返回全部候选命中并标注阈值过滤/注入判定，调参可视化） =====
    function kbTestSearch() {
        if (!kbSelectedId) { showToast('请先在上方选择知识库'); return; }
        var q = $('kb-test-query').value.trim();
        if (!q) { showToast('请输入测试问题'); return; }
        var box = $('kb-test-result');
        box.innerHTML = '<div class="admin-card-empty">检索中…</div>';
        api('POST', '/admin/api/kb/' + kbSelectedId + '/debug', { query: q }).then(function (result) {
            if (!result.ok) { box.innerHTML = ''; showToast(result.msg || '检索失败'); return; }
            var d = result.data || {};
            var hits = d.hits || [];
            box.innerHTML = '';
            // 库参数摘要行：调参依据归口展示（维度/模型/阈值/注入条数/切片总数）
            var meta = document.createElement('div');
            meta.className = 'admin-kb-debug-meta';
            var th = Number(d.threshold) || 0;
            meta.textContent = '库「' + d.kb_name + '」· ' + d.embed_model + ' · 维度 ' + d.dim
                + ' · 阈值 ' + (th > 0 ? th : '不过滤') + ' · 注入 top' + d.top_k + ' · 库内切片 ' + d.chunk_total;
            box.appendChild(meta);
            if (!hits.length) {
                var none = document.createElement('div');
                none.className = 'admin-card-empty';
                none.textContent = '无命中（未上传文件 / 文件未就绪 / 语义不相关）';
                box.appendChild(none);
                return;
            }
            // 统计：注入 / 被阈值过滤 / 被 topK 截断
            var injectCnt = 0, filterCnt = 0, truncCnt = 0;
            hits.forEach(function (h) {
                if (!h.pass_threshold) filterCnt++;
                else if (h.inject) injectCnt++;
                else truncCnt++;
            });
            var sum = document.createElement('div');
            sum.className = 'admin-kb-debug-meta';
            sum.textContent = '候选 ' + hits.length + ' 条：注入 ' + injectCnt + ' · 被阈值过滤 ' + filterCnt + ' · 超出 topK 截断 ' + truncCnt;
            box.appendChild(sum);
            hits.forEach(function (h, i) {
                var item = document.createElement('div');
                item.className = 'admin-kb-hit' + (h.inject ? ' hit-inject' : '');
                var head = document.createElement('div');
                head.className = 'admin-kb-hit-head';
                head.textContent = '[' + (i + 1) + '] ' + h.file + ' · 切片 #' + h.chunk + ' · 相似度 ' + h.similarity.toFixed(4);
                // 判定徽标：注入 / 被阈值过滤 / 超出 topK（一眼看清该条命中的最终归宿）
                var badge = document.createElement('span');
                badge.className = 'admin-kb-hit-badge ' + (h.inject ? 'inject' : (h.pass_threshold ? 'trunc' : 'filter'));
                badge.textContent = h.inject ? '注入' : (h.pass_threshold ? '超出 topK' : '被阈值过滤');
                head.appendChild(badge);
                var body = document.createElement('div');
                body.className = 'admin-kb-hit-content';
                body.textContent = h.content;
                item.appendChild(head);
                item.appendChild(body);
                box.appendChild(item);
            });
        }).catch(function (e) { box.innerHTML = ''; showToast(e.message || '网络异常'); });
    }
    $('kb-test-btn').addEventListener('click', kbTestSearch);
    $('kb-test-query').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') kbTestSearch();
    });

    // ===== 量化数据管理（阶段五十四：全库向量切片统一视图 / 跨库聚合搜索 / 行内微调） =====
    var VEC_SIZE = 20; // 每页条数（服务端上限 100）
    var vecPage = 1;   // 当前页码
    var vecTotal = 0;  // 匹配总条数

    // loadVecKbOptions 库筛选下拉（含各库切片数；刷新时保留当前选择，原库被删则回退"全部"）
    function loadVecKbOptions() {
        api('GET', '/admin/api/kb/list').then(function (result) {
            if (!result.ok) return;
            var list = result.data || [];
            var sel = $('vec-kb-filter');
            var cur = sel.value;
            sel.innerHTML = '<option value="0">全部知识库</option>';
            list.forEach(function (k) {
                var opt = document.createElement('option');
                opt.value = k.id;
                opt.textContent = k.name + '（' + (k.chunk_count || 0) + ' 片）';
                sel.appendChild(opt);
            });
            sel.value = cur || '0';
            if (sel.value !== (cur || '0')) sel.value = '0';
        }).catch(function () { /* 下拉加载失败不阻断主列表 */ });
    }

    // loadVecData 主列表：跨库切片聚合 + 分页（筛选与关键词取自工具条；空数据显示"暂无数据"）
    function loadVecData() {
        var kbId = $('vec-kb-filter').value || '0';
        var q = $('vec-search').value.trim();
        var url = '/admin/api/kb/chunks?kb_id=' + encodeURIComponent(kbId) + '&page=' + vecPage + '&size=' + VEC_SIZE;
        if (q) url += '&q=' + encodeURIComponent(q);
        var body = $('vec-tbody');
        body.innerHTML = '<tr><td colspan="8" class="vec-empty">加载中…</td></tr>';
        api('GET', url).then(function (result) {
            if (!result.ok) {
                body.innerHTML = '<tr><td colspan="8" class="vec-empty">加载失败</td></tr>';
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data || {};
            vecTotal = d.total || 0;
            var pages = Math.max(1, Math.ceil(vecTotal / VEC_SIZE));
            if (vecPage > pages) { vecPage = pages; loadVecData(); return; } // 删除后当前页越界的兜底
            renderVecTable(d.items || []);
            $('vec-page-info').textContent = '共 ' + vecTotal + ' 条 · 第 ' + vecPage + ' / ' + pages + ' 页';
            $('vec-prev').disabled = vecPage <= 1;
            $('vec-next').disabled = vecPage >= pages;
            $('vec-status').textContent = '共 ' + vecTotal + ' 条已向量化切片';
        }).catch(function (e) {
            body.innerHTML = '<tr><td colspan="8" class="vec-empty">加载失败</td></tr>';
            showToast(e.message || '网络异常');
        });
    }

    // vecTd 单元格构造辅助（统一 class 与纯文本写入，防注入）
    function vecTd(text, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        return td;
    }

    // renderVecTable 表格行渲染：内容列截断 60 字（title 悬浮全文）+ 向量前 8 维预览；操作列编辑/删除/源文
    function renderVecTable(items) {
        var body = $('vec-tbody');
        body.innerHTML = '';
        if (!items.length) {
            body.innerHTML = '<tr><td colspan="8" class="vec-empty">暂无数据</td></tr>';
            return;
        }
        items.forEach(function (c) {
            var tr = document.createElement('tr');
            tr.appendChild(vecTd(c.kb_name || ('库#' + c.kb_id), 'vec-td-nowrap'));
            tr.appendChild(vecTd(c.file, 'vec-td-file'));
            tr.appendChild(vecTd('#' + c.chunk, 'vec-td-nowrap'));
            tr.appendChild(vecTd(String(c.chars), 'vec-td-num'));
            tr.appendChild(vecTd(String(c.dim), 'vec-td-num'));
            tr.appendChild(vecTd(Number(c.norm).toFixed(4), 'vec-td-num'));
            // 内容列：截断主文本 + 向量健康预览
            var tdContent = document.createElement('td');
            tdContent.className = 'vec-td-content';
            var main = document.createElement('div');
            main.className = 'vec-content-main';
            main.textContent = c.content.length > 60 ? c.content.slice(0, 60) + '…' : c.content;
            main.title = c.content;
            var vec8 = document.createElement('div');
            vec8.className = 'vec-dim8';
            vec8.textContent = '前8维：' + (c.head || []).map(function (v) { return Number(v).toFixed(3); }).join(', ');
            tdContent.appendChild(main);
            tdContent.appendChild(vec8);
            tr.appendChild(tdContent);
            // 操作列：编辑 / 删除 / 源文（仅文本类文件显示源文入口）
            var tdAct = document.createElement('td');
            tdAct.className = 'vec-td-actions';
            var editBtn = document.createElement('button');
            editBtn.className = 'admin-btn small';
            editBtn.textContent = '编辑';
            editBtn.addEventListener('click', function () { vecEditChunk(c); });
            var delBtn = document.createElement('button');
            delBtn.className = 'admin-btn small danger';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                confirmBox('确定删除「' + c.file + '」切片 #' + c.chunk + ' 吗？该切片将从向量库移除，不再参与检索。', function () {
                    api('DELETE', '/admin/api/kb/file/' + c.file_id + '/chunk/' + c.chunk).then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('切片已删除');
                        loadVecData();
                    }).catch(function (e) { showToast(e.message || '网络异常'); });
                });
            });
            tdAct.appendChild(editBtn);
            tdAct.appendChild(delBtn);
            if (kbIsSourceEditable(c.file)) {
                var srcBtn = document.createElement('button');
                srcBtn.className = 'admin-btn small';
                srcBtn.textContent = '源文';
                srcBtn.addEventListener('click', function () { vecOpenSourceModal({ id: c.file_id, name: c.file }); });
                tdAct.appendChild(srcBtn);
            }
            tr.appendChild(tdAct);
            body.appendChild(tr);
        });
    }

    // vecEditChunk 行内编辑：复用单切片编辑归口（保存后服务端重嵌新文同 ID 写回；源文件不改动）
    function vecEditChunk(c) {
        if (!kbEmbedOn) { showToast('embedding 服务未配置，无法重嵌切片（config.yaml ai.embedding）'); return; }
        openEditModal('编辑切片 #' + c.chunk + ' — ' + c.file, [
            { key: 'content', label: '切片内容（保存后自动重新向量化；源文件不改动，重建时将被覆盖）', type: 'textarea' }
        ], { content: c.content }, function (data) {
            if (!data.content.trim()) { showToast('切片内容不能为空'); return; }
            api('PUT', '/admin/api/kb/file/' + c.file_id + '/chunk/' + c.chunk, { content: data.content }).then(function (res) {
                if (!res.ok) { showToast(res.msg || '保存失败'); return; }
                closeEditModal();
                showToast('切片已更新并重新向量化');
                loadVecData();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }

    // vecOpenSourceModal 源文编辑（仅 txt/md/csv 显示入口）：保存后服务端覆写源文件并重切片+重向量化
    function vecOpenSourceModal(f) {
        if (!kbEmbedOn) { showToast('embedding 服务未配置，保存后无法重建（config.yaml ai.embedding）'); return; }
        api('GET', '/admin/api/kb/file/' + f.id + '/source').then(function (result) {
            if (!result.ok) { showToast(result.msg || '读取源文件失败'); return; }
            openEditModal('编辑源文 — ' + f.name, [
                { key: 'content', label: '源文本内容（保存后将覆写源文件并重新切片、向量化）', type: 'textarea' }
            ], { content: result.data.content }, function (data) {
                if (!data.content.trim()) { showToast('源文件内容不能为空'); return; }
                api('PUT', '/admin/api/kb/file/' + f.id + '/source', { content: data.content }).then(function (res) {
                    if (!res.ok) { showToast(res.msg || '保存失败'); return; }
                    closeEditModal();
                    showToast('源文已保存，重新向量化中');
                    loadVecData();
                }).catch(function (e) { showToast(e.message || '网络异常'); });
            });
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // 工具条事件：库筛选 / 关键词搜索（按钮+回车）/ 刷新 / 分页
    $('vec-kb-filter').addEventListener('change', function () { vecPage = 1; loadVecData(); });
    $('vec-search-btn').addEventListener('click', function () { vecPage = 1; loadVecData(); });
    $('vec-search').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { vecPage = 1; loadVecData(); }
    });
    $('vec-refresh').addEventListener('click', function () { loadVecKbOptions(); loadVecData(); });
    $('vec-prev').addEventListener('click', function () { if (vecPage > 1) { vecPage--; loadVecData(); } });
    $('vec-next').addEventListener('click', function () {
        var pages = Math.max(1, Math.ceil(vecTotal / VEC_SIZE));
        if (vecPage < pages) { vecPage++; loadVecData(); }
    });

    // ===== Agent 任务审计（阶段六十四：/admin/api/agent/tasks 全量任务分页 + 用户名/状态筛选 + 详情弹窗） =====
    var AT_SIZE = 20;  // 每页条数（服务端上限 100）
    var atPage = 1;    // 当前页码
    var atTotal = 0;   // 匹配总条数

    // atStateLabel 状态中文标签映射（与用户端口径一致）
    function atStateLabel(s) {
        return { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[s] || s;
    }

    // atFormatTime 时间展示归口：yyyy-MM-dd HH:mm
    function atFormatTime(ts) {
        var d = new Date(ts);
        if (!ts || isNaN(d.getTime())) return '-';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
            ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    // loadAgentTasks 主列表：全量任务分页（筛选取自工具条；空数据显示"暂无数据"）
    function loadAgentTasks() {
        var user = $('at-user-filter').value.trim();
        var status = $('at-status-filter').value;
        var url = '/admin/api/agent/tasks?page=' + atPage + '&size=' + AT_SIZE;
        if (user) url += '&user=' + encodeURIComponent(user);
        if (status) url += '&status=' + encodeURIComponent(status);
        var body = $('at-tbody');
        body.innerHTML = '<tr><td colspan="9" class="vec-empty">加载中…</td></tr>';
        api('GET', url).then(function (result) {
            if (!result.ok) {
                body.innerHTML = '<tr><td colspan="9" class="vec-empty">加载失败</td></tr>';
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data || {};
            atTotal = d.total || 0;
            var pages = Math.max(1, Math.ceil(atTotal / AT_SIZE));
            if (atPage > pages) { atPage = pages; loadAgentTasks(); return; } // 筛选后页码越界兜底
            renderAgentTasks(d.tasks || []);
            $('at-page-info').textContent = '共 ' + atTotal + ' 条 · 第 ' + atPage + ' / ' + pages + ' 页';
            $('at-prev').disabled = atPage <= 1;
            $('at-next').disabled = atPage >= pages;
            $('at-status').textContent = '共 ' + atTotal + ' 条任务记录';
        }).catch(function (e) {
            body.innerHTML = '<tr><td colspan="9" class="vec-empty">加载失败</td></tr>';
            showToast(e.message || '网络异常');
        });
    }

    // ===== Agent 运行参数设置（阶段八十一/八十二：后台热更新） =====
    var agentSetCmds = []; // 全局命令白名单工作副本（增删后随保存一并全量提交）
    // 阶段八十三：用户个人白名单（按用户隔离，来自审批弹窗"同意并加白"；后台仅查看/收回）
    var agentSetUserCmds = {};  // { username: [前缀, ...] }
    var agentSetUserWrite = []; // [username, ...] 已开启个人写免审批的用户

    // 命令白名单标签渲染（× 可删，保存时全量提交）
    function agentSetCmdsRender() {
        var box = $('agentset-cmds');
        box.innerHTML = '';
        if (!agentSetCmds.length) {
            var empty = document.createElement('span');
            empty.className = 'agentset-cmd-empty';
            empty.textContent = '（空——所有命令均需审批）';
            box.appendChild(empty);
            return;
        }
        agentSetCmds.forEach(function (c, i) {
            var chip = document.createElement('span');
            chip.className = 'agentset-cmd-chip';
            chip.appendChild(document.createTextNode(c));
            var del = document.createElement('button');
            del.className = 'agentset-cmd-del';
            del.textContent = '×';
            del.title = '移除 ' + c;
            del.addEventListener('click', function () {
                agentSetCmds.splice(i, 1);
                agentSetCmdsRender();
            });
            chip.appendChild(del);
            box.appendChild(chip);
        });
    }

    // 阶段八十三：个人白名单渲染（命令：用户›前缀；写免审批：用户名）。× 即时收回（服务端同步删行）
    function agentSetUserWlRender() {
        var cmdBox = $('agentset-user-cmds');
        var writeBox = $('agentset-user-write');
        cmdBox.innerHTML = '';
        writeBox.innerHTML = '';
        var users = Object.keys(agentSetUserCmds).sort();
        var cmdCount = 0;
        users.forEach(function (u) { cmdCount += (agentSetUserCmds[u] || []).length; });
        if (!cmdCount) {
            var empty = document.createElement('span');
            empty.className = 'agentset-cmd-empty';
            empty.textContent = '（暂无——各用户在审批弹窗点"同意并加白"后在此显示，仅对其本人生效）';
            cmdBox.appendChild(empty);
        } else {
            users.forEach(function (u) {
                (agentSetUserCmds[u] || []).forEach(function (c) {
                    cmdBox.appendChild(agentSetUserChip(u, c, false));
                });
            });
        }
        if (!agentSetUserWrite.length) {
            var empty2 = document.createElement('span');
            empty2.className = 'agentset-cmd-empty';
            empty2.textContent = '（暂无——各用户在审批弹窗加白后在此显示，仅对其本人生效）';
            writeBox.appendChild(empty2);
        } else {
            agentSetUserWrite.slice().sort().forEach(function (u) {
                writeBox.appendChild(agentSetUserChip(u, '', true));
            });
        }
    }

    // agentSetUserChip 个人白名单条目标签（user 高亮用户名，cmd 为空=写免审批条目）
    function agentSetUserChip(user, cmd, isWrite) {
        var chip = document.createElement('span');
        chip.className = 'agentset-cmd-chip agentset-user-chip';
        var u = document.createElement('span');
        u.className = 'agentset-user-chip-name';
        u.textContent = user;
        chip.appendChild(u);
        if (!isWrite) {
            chip.appendChild(document.createTextNode('›'));
            chip.appendChild(document.createTextNode(' ' + cmd));
        } else {
            chip.appendChild(document.createTextNode(' 写文件免审批'));
        }
        var del = document.createElement('button');
        del.className = 'agentset-cmd-del';
        del.textContent = '×';
        del.title = isWrite ? '收回 ' + user + ' 的写文件免审批' : '移除 ' + user + ' 的 ' + cmd + ' 白名单';
        del.addEventListener('click', function () {
            var body = isWrite ? { user_autowrite_off: user } : { user_cmd_remove: { username: user, command: cmd } };
            api('PUT', '/admin/api/agent/settings', body).then(function (result) {
                if (!result.ok) {
                    showToast(result.msg || '操作失败');
                    return;
                }
                if (isWrite) {
                    agentSetUserWrite = agentSetUserWrite.filter(function (x) { return x !== user; });
                } else {
                    var list = (agentSetUserCmds[user] || []).filter(function (x) { return x !== cmd; });
                    if (list.length) agentSetUserCmds[user] = list; else delete agentSetUserCmds[user];
                }
                agentSetUserWlRender();
                agentSetApplyKeyHint(result.data || {});
                showToast(isWrite ? '已收回该用户的写文件免审批' : '已移除该用户的个人白名单条目');
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
        chip.appendChild(del);
        return chip;
    }

    function agentSetApplyKeyHint(d) {
        // 密钥脱敏：不回显明文，仅提示配置状态；留空=保持不变
        $('agentset-key-hint').textContent = d.search_key_set ? d.search_key_hint : '未配置';
        $('agentset-search-key').placeholder = d.search_key_set ? '留空保持不变' : 'tavily/bocha 的 API Key';
    }

    // 读取当前生效值（内存值，含热改未重启部分）回填表单
    function loadAgentSettings() {
        api('GET', '/admin/api/agent/settings').then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data;
            $('agentset-max-steps').value = d.max_steps;
            $('agentset-tool-timeout').value = d.tool_timeout;
            $('agentset-approve-timeout').value = d.approve_timeout;
            $('agentset-concurrency').value = d.concurrency;
            $('agentset-queue-size').value = d.queue_size;
            $('agentset-enabled').checked = !!d.enabled;
            $('agentset-pc-exec').checked = !!d.pc_executor;
            $('agentset-autowrite').checked = !!d.auto_write;
            agentSetCmds = (d.auto_commands || []).slice();
            agentSetCmdsRender();
            // 阶段八十三：个人白名单视图回填（查看/收回，不随"保存全部"提交）
            agentSetUserCmds = d.user_commands || {};
            agentSetUserWrite = d.user_autowrite || [];
            agentSetUserWlRender();
            $('agentset-http-enabled').checked = !!d.http_enabled;
            $('agentset-http-private').checked = !!d.http_allow_private;
            $('agentset-search-enabled').checked = !!d.search_enabled;
            $('agentset-search-provider').value = d.search_provider || '';
            $('agentset-search-key').value = '';
            $('agentset-search-endpoint').value = d.search_endpoint || '';
            agentSetApplyKeyHint(d);
            $('agentset-tip').textContent = '已加载当前生效值';
            $('agentset-status').textContent = '';
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // ===== AI 计费设置（阶段一百三十八：usage 按量 / percall 按次 TRAE CN 同款；保存即热生效） =====

    // 单价行显隐联动：仅按次计费时需要配置单价
    function billingCostRowSync() {
        var percall = document.querySelector('input[name="billing-mode"][value="percall"]').checked;
        $('billing-cost-row').style.display = percall ? '' : 'none';
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="billing-mode"]'), function (r) {
        r.addEventListener('change', billingCostRowSync);
    });

    // 读取当前生效计费配置回填表单（含来源标注：后台设置=DB 真源 / config=config.yaml 初始默认）
    function loadBillingSettings() {
        api('GET', '/admin/api/billing/settings').then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data;
            var mode = d.mode === 'percall' ? 'percall' : 'usage';
            document.querySelector('input[name="billing-mode"][value="' + mode + '"]').checked = true;
            $('billing-percall-cost').value = d.percall_cost;
            billingCostRowSync();
            $('billing-source-tip').textContent = d.source === 'override' ? '当前值来源：后台设置（持久化）' : '当前值来源：config.yaml 初始默认（后台保存后转为持久化）';
            $('billing-status').textContent = '';
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // 保存：服务端落库 + 内存直更（下一次模型调用即按新模式扣费，无需重启）
    $('billing-save').addEventListener('click', function () {
        var mode = document.querySelector('input[name="billing-mode"]:checked').value;
        var body = { mode: mode };
        if (mode === 'percall') {
            var cost = parseFloat($('billing-percall-cost').value);
            if (!(cost > 0)) {
                showToast('请输入有效的按次计费单价');
                return;
            }
            body.percall_cost = cost;
        }
        api('PUT', '/admin/api/billing/settings', body).then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '保存失败');
                return;
            }
            showToast('计费设置已保存并热生效');
            loadBillingSettings(); // 回读刷新来源标注
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    });

    // ===== 阶段一百三十九：历史压缩方式设置（tokens 估算 / kb 字节双口径可选，保存即热生效）=====
    // 与计费设置同款交互：单选切换显示对应阈值行；保存落库 + 服务端内存直更，下一轮模型调用即生效
    function compressModeRowSync() {
        var kb = document.querySelector('input[name="compress-mode"]:checked').value === 'kb';
        $('compress-kb-row').style.display = kb ? '' : 'none';
        $('compress-tokens-row').style.display = kb ? 'none' : '';
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="compress-mode"]'), function (r) {
        r.addEventListener('change', compressModeRowSync);
    });

    // 读取当前生效压缩配置回填表单（含来源标注：后台设置=DB 真源 / config=config.yaml 初始默认）
    function loadCompressSettings() {
        api('GET', '/admin/api/compress/settings').then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data;
            var mode = d.mode === 'tokens' ? 'tokens' : 'kb';
            document.querySelector('input[name="compress-mode"][value="' + mode + '"]').checked = true;
            $('compress-kb').value = d.kb;
            $('compress-tokens').value = d.tokens;
            compressModeRowSync();
            $('compress-source-tip').textContent = d.source === 'override' ? '当前值来源：后台设置（持久化）' : '当前值来源：config.yaml 初始默认（后台保存后转为持久化）';
            $('compress-status').textContent = '';
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // 保存：两个阈值一并提交（隐藏行的已加载值原样回传，切换口径不丢对方修改）；
    // 服务端落库 + 内存直更（执行中的任务下一轮模型调用即按新口径判断，无需重启）
    $('compress-save').addEventListener('click', function () {
        var mode = document.querySelector('input[name="compress-mode"]:checked').value;
        var kb = parseInt($('compress-kb').value, 10);
        var tk = parseInt($('compress-tokens').value, 10);
        if (!(kb > 0)) { showToast('请输入有效的 KB 阈值'); return; }
        if (!(tk > 0)) { showToast('请输入有效的 Token 阈值'); return; }
        api('PUT', '/admin/api/compress/settings', { mode: mode, tokens: tk, kb: kb }).then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '保存失败');
                return;
            }
            showToast('压缩设置已保存并热生效');
            loadCompressSettings(); // 回读刷新来源标注
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    });

    // ===== 网盘设置：上传扩展名黑名单（阶段一百六十六，保存即热生效 + 持久化） =====
    // 读取当前生效黑名单回填表单（含内置默认值提示与来源标注）
    function loadDriveBlockExts() {
        api('GET', '/admin/api/drive/blockexts').then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data;
            $('drive-blockexts').value = d.exts || '';
            $('drive-default-tip').textContent = '内置默认黑名单：' + d.default;
            $('drive-elf').checked = !!d.elf;
            // 处置方式回显（rename=隔离改名 .im 默认 / deny=直接拦截）
            var mode = d.mode === 'deny' ? 'drive-mode-deny' : 'drive-mode-rename';
            document.getElementById(mode).checked = true;
            $('drive-source-tip').textContent = d.source === 'override' ? (d.is_default ? '当前值来源：后台已设为内置默认（持久化）' : '当前值来源：后台设置（持久化）') : '当前值来源：config.yaml 初始默认（后台保存后转为持久化）';
            $('drive-status').textContent = '';
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // 保存：空串=恢复内置默认黑名单；服务端逐项校验归一后落库 + 内存直更（挂载盘与网页上传同时生效）
    $('drive-save').addEventListener('click', function () {
        var raw = $('drive-blockexts').value.trim();
        var mode = $('drive-mode-deny').checked ? 'deny' : 'rename';
        api('PUT', '/admin/api/drive/blockexts', { exts: raw, elf: $('drive-elf').checked, mode: mode }).then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '保存失败');
                return;
            }
            showToast('上传黑名单已保存并热生效');
            loadDriveBlockExts(); // 回读刷新归一值与来源标注
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    });

    function agentSetAddCmd() {
        var input = $('agentset-cmd-input');
        var v = input.value.trim().toLowerCase();
        if (!v) return;
        if (agentSetCmds.indexOf(v) >= 0) {
            showToast('该前缀已在白名单');
            return;
        }
        agentSetCmds.push(v);
        agentSetCmdsRender();
        input.value = '';
    }
    $('agentset-cmd-add').addEventListener('click', agentSetAddCmd);
    $('agentset-cmd-input').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            agentSetAddCmd();
        }
    });

    // 保存：服务端内存原子写入立即热生效（运行中任务下一步即按新值判定）+ 落库重启不丢
    $('agentset-save').addEventListener('click', function () {
        var num = function (id, lo, hi) {
            var raw = $(id).value.trim();
            var v = parseInt(raw, 10);
            if (raw === '' || String(v) !== raw || v < lo || v > hi) {
                showToast('存在超出允许范围的数值，请检查标有范围提示的输入项');
                return null;
            }
            return v;
        };
        var maxSteps = num('agentset-max-steps', 1, 500);
        var toolTimeout = num('agentset-tool-timeout', 5, 300);
        var approveTimeout = num('agentset-approve-timeout', 10, 3600);
        var concurrency = num('agentset-concurrency', 1, 10);
        var queueSize = num('agentset-queue-size', 1, 50);
        if (maxSteps === null || toolTimeout === null || approveTimeout === null || concurrency === null || queueSize === null) return;
        var body = {
            max_steps: maxSteps,
            tool_timeout: toolTimeout,
            approve_timeout: approveTimeout,
            concurrency: concurrency,
            queue_size: queueSize,
            enabled: $('agentset-enabled').checked,
            pc_executor: $('agentset-pc-exec').checked,
            auto_write: $('agentset-autowrite').checked,
            auto_commands: agentSetCmds.slice(),
            http_enabled: $('agentset-http-enabled').checked,
            http_allow_private: $('agentset-http-private').checked,
            search_enabled: $('agentset-search-enabled').checked,
            search_provider: $('agentset-search-provider').value,
            search_endpoint: $('agentset-search-endpoint').value.trim()
        };
        var keyVal = $('agentset-search-key').value.trim();
        if (keyVal !== '') body.search_key = keyVal; // 留空=保持不变（不传该字段）
        api('PUT', '/admin/api/agent/settings', body).then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '保存失败');
                return;
            }
            $('agentset-search-key').value = '';
            agentSetApplyKeyHint(result.data);
            // 阶段八十三：保存回执附带个人白名单快照，同步刷新（保存主体不影响个人白名单）
            if (result.data && result.data.user_commands) {
                agentSetUserCmds = result.data.user_commands;
                agentSetUserWrite = result.data.user_autowrite || [];
                agentSetUserWlRender();
            }
            $('agentset-tip').textContent = '已保存并热生效（' + new Date().toLocaleTimeString() + '）';
            showToast('Agent 设置已保存并热生效');
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    });

    // ===== 阶段一百零六：Git 助手提示词后台管理（admin 可配置热更新） =====
    // 读取当前生效提示词回填（有自定义回自定义，否则回内置默认全文）与来源标记
    function loadGitPrompts() {
        api('GET', '/admin/api/gitprompt').then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '加载失败');
                return;
            }
            var d = result.data || {};
            $('agentset-git-commitmsg').value = d.commitmsg || '';
            $('agentset-git-review').value = d.review || '';
            gitPromptStateRender(d);
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // 来源标记渲染（提交信息/审查报告各自标注 默认/自定义）
    function gitPromptStateRender(d) {
        $('agentset-gitprompt-state').textContent =
            '当前：提交信息 ' + (d.commitmsg_custom ? '自定义' : '内置默认') +
            '，审查报告 ' + (d.review_custom ? '自定义' : '内置默认');
    }

    // 保存：服务端内存热更新（下一次 AI 生成立即按新提示词执行）+ 落库重启不丢
    $('agentset-gitprompt-save').addEventListener('click', function () {
        var body = {
            commitmsg: $('agentset-git-commitmsg').value.trim(),
            review: $('agentset-git-review').value.trim()
        };
        api('PUT', '/admin/api/gitprompt', body).then(function (result) {
            if (!result.ok) {
                showToast(result.msg || '保存失败');
                return;
            }
            gitPromptStateRender(result.data || {});
            $('agentset-gitprompt-state').textContent += '（已保存并热生效 ' + new Date().toLocaleTimeString() + '）';
            showToast('Git 助手提示词已保存并热生效');
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    });

    // 恢复默认：清空两栏并按空串保存（服务端删记录回内置默认），确认后执行
    $('agentset-gitprompt-reset').addEventListener('click', function () {
        confirmBox('确定恢复内置默认提示词？两栏自定义内容将被清除。', function () {
            api('PUT', '/admin/api/gitprompt', { commitmsg: '', review: '' }).then(function (result) {
                if (!result.ok) {
                    showToast(result.msg || '操作失败');
                    return;
                }
                loadGitPrompts(); // 重新拉取默认全文回填
                showToast('已恢复内置默认提示词');
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    });

    // atTd 单元格构造辅助（统一 class 与纯文本写入，防注入）
    function atTd(text, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        return td;
    }

    // renderAgentTasks 表格行渲染：目标列截断（title 悬浮全文）；操作列详情（全文弹窗）
    function renderAgentTasks(tasks) {
        var body = $('at-tbody');
        body.innerHTML = '';
        if (!tasks.length) {
            body.innerHTML = '<tr><td colspan="9" class="vec-empty">暂无数据</td></tr>';
            return;
        }
        tasks.forEach(function (t) {
            var tr = document.createElement('tr');
            tr.appendChild(atTd(t.task_id, 'vec-td-nowrap'));
            tr.appendChild(atTd(t.username, 'vec-td-nowrap'));
            tr.appendChild(atTd(t.agent_name, 'vec-td-nowrap'));
            // 目标列：截断主文本（title 悬浮列表截断文本）
            var tdGoal = document.createElement('td');
            tdGoal.className = 'vec-td-file';
            tdGoal.textContent = t.goal || '-';
            tdGoal.title = t.goal || '';
            tr.appendChild(tdGoal);
            // 状态徽标
            var tdSt = document.createElement('td');
            var badge = document.createElement('span');
            badge.className = 'at-badge at-st-' + t.status;
            badge.textContent = atStateLabel(t.status);
            tdSt.appendChild(badge);
            tr.appendChild(tdSt);
            tr.appendChild(atTd(String(t.steps || 0), 'vec-td-num'));
            tr.appendChild(atTd(atFormatTime(t.create_time), 'vec-td-nowrap'));
            tr.appendChild(atTd(atFormatTime(t.update_time), 'vec-td-nowrap'));
            // 操作列：详情（全文弹窗，按需拉取）
            var tdAct = document.createElement('td');
            tdAct.className = 'vec-td-actions';
            var btn = document.createElement('button');
            btn.className = 'admin-btn small';
            btn.textContent = '详情';
            btn.addEventListener('click', function () { atOpenDetail(t.task_id); });
            tdAct.appendChild(btn);
            tr.appendChild(tdAct);
            body.appendChild(tr);
        });
    }

    // atOpenDetail 任务详情弹窗：按需拉取全文（目标/总结/失败原因，pre-wrap 保留换行）
    function atOpenDetail(taskID) {
        var mask = $('admin-atdetail-mask');
        var title = $('admin-atdetail-title');
        var bodyEl = $('admin-atdetail-body');
        title.textContent = '任务详情 ' + taskID;
        bodyEl.innerHTML = '<div class="vec-empty">加载中…</div>';
        mask.classList.remove('hidden');
        api('GET', '/admin/api/agent/task/' + encodeURIComponent(taskID)).then(function (result) {
            if (!result.ok) { bodyEl.textContent = result.msg || '详情加载失败'; return; }
            var d = result.data || {};
            bodyEl.innerHTML = '';
            function row(label, text) {
                if (!text) return;
                var lab = document.createElement('div');
                lab.className = 'at-detail-label';
                lab.textContent = label;
                var body = document.createElement('div');
                body.className = 'at-detail-body';
                body.textContent = text;
                bodyEl.appendChild(lab);
                bodyEl.appendChild(body);
            }
            var meta = document.createElement('div');
            meta.className = 'at-detail-meta';
            meta.textContent = '用户：' + d.username + ' · 智能体：' + d.agent_name + ' · 状态：' + atStateLabel(d.status) +
                ' · ' + (d.steps || 0) + ' 步 · 发起 ' + atFormatTime(d.create_time) + ' · 最近活动 ' + atFormatTime(d.update_time);
            bodyEl.appendChild(meta);
            row('任务目标', d.goal);
            if (d.status === 'completed') row('最终总结', d.result);
            if (d.status === 'failed') row('失败原因', d.error);
            if (d.status === 'cancelled') row('取消说明', d.error);
            // 阶段六十五：详情渲染完成后追加执行轨迹区块
            atLoadSteps(bodyEl, taskID);
        }).catch(function (e) { bodyEl.textContent = e.message || '网络异常'; });
    }

    // ===== 执行轨迹（阶段六十五：单任务全量步骤留痕时间线） =====
    // atApprovalLabel 审批情况标签文案归口
    function atApprovalLabel(a) {
        return { none: '免审批', approved: '审批通过', rejected: '用户拒绝', cancelled: '用户取消', timeout: '审批超时' }[a] || a || '—';
    }
    // atEnvLabel 执行环境标签文案归口
    function atEnvLabel(e) {
        return e === 'pc' ? '本地执行' : '服务端';
    }
    // atLoadSteps 执行轨迹拉取与渲染（详情回调内触发，避免并行竞态清空）
    function atLoadSteps(bodyEl, taskID) {
        var box = document.createElement('div');
        box.className = 'at-steps';
        box.innerHTML = '<div class="at-detail-label">执行轨迹</div><div class="vec-empty">加载中…</div>';
        bodyEl.appendChild(box);
        api('GET', '/admin/api/agent/task/' + encodeURIComponent(taskID) + '/steps').then(function (result) {
            if (!result.ok) {
                box.innerHTML = '<div class="at-detail-label">执行轨迹</div><div class="vec-empty">' + (result.msg || '加载失败') + '</div>';
                return;
            }
            var steps = result.data.steps || [];
            box.innerHTML = '<div class="at-detail-label">执行轨迹（' + steps.length + ' 步）</div>';
            if (!steps.length) {
                var empty = document.createElement('div');
                empty.className = 'vec-empty';
                empty.textContent = '无工具调用';
                box.appendChild(empty);
                return;
            }
            steps.forEach(function (s) {
                var item = document.createElement('div');
                item.className = 'at-step' + (s.ok ? '' : ' fail');
                var head = document.createElement('div');
                head.className = 'at-step-head';
                var seq = document.createElement('span');
                seq.className = 'at-step-seq';
                seq.textContent = s.seq;
                var tool = document.createElement('span');
                tool.className = 'at-step-tool';
                tool.textContent = s.tool;
                var meta = document.createElement('span');
                meta.className = 'at-step-meta';
                meta.textContent = atEnvLabel(s.env) + ' · ' + atApprovalLabel(s.approval) + ' · ' + (s.duration_ms || 0) + 'ms · ' + atFormatTime(s.create_time);
                head.appendChild(seq);
                head.appendChild(tool);
                head.appendChild(meta);
                item.appendChild(head);
                if (s.params) {
                    var p = document.createElement('div');
                    p.className = 'at-step-body';
                    p.textContent = '参数：' + s.params;
                    p.title = s.params;
                    item.appendChild(p);
                }
                if (s.result) {
                    var r = document.createElement('div');
                    r.className = 'at-step-body';
                    r.textContent = (s.ok ? '结果：' : '错误：') + s.result;
                    r.title = s.result;
                    item.appendChild(r);
                }
                box.appendChild(item);
            });
        }).catch(function (e) {
            box.innerHTML = '<div class="at-detail-label">执行轨迹</div><div class="vec-empty">' + (e.message || '网络异常') + '</div>';
        });
    }

    // 工具条事件：用户名搜索（按钮+回车）/ 状态筛选 / 刷新 / 分页 / 详情关闭
    $('at-search-btn').addEventListener('click', function () { atPage = 1; loadAgentTasks(); });
    $('at-user-filter').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { atPage = 1; loadAgentTasks(); }
    });
    $('at-status-filter').addEventListener('change', function () { atPage = 1; loadAgentTasks(); });
    $('at-refresh').addEventListener('click', loadAgentTasks);
    $('at-prev').addEventListener('click', function () { if (atPage > 1) { atPage--; loadAgentTasks(); } });
    $('at-next').addEventListener('click', function () {
        var pages = Math.max(1, Math.ceil(atTotal / AT_SIZE));
        if (atPage < pages) { atPage++; loadAgentTasks(); }
    });
    $('admin-atdetail-close').addEventListener('click', function () { $('admin-atdetail-mask').classList.add('hidden'); });

    // stopKBPolling 离开知识库视图/退出登录时停止处理中文件轮询
    function stopKBPolling() {
        if (kbPollTimer) { clearInterval(kbPollTimer); kbPollTimer = null; }
    }

    // ===== 性能仪表盘（阶段五十：/admin/api/metrics 5 秒轮询 + ECharts 本地渲染） =====
    var DASH_POLL_MS = 5000;
    var DASH_WINDOW = 120; // 实时曲线窗口：120 点 × 5 秒 = 10 分钟
    var dashTimer = null;
    var dashMemChart = null;
    var dashMsgChart = null;
    var dashMemHistory = { times: [], heap: [], goroutines: [] };
    var dashLastHourly = null; // 最近一次今日分布（主题切换重绘用）

    // 读取主题 CSS 变量（图表颜色归口：全部取自 style.css 变量体系，随明暗主题联动）
    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function isDashboardActive() {
        return $('admin-view-dashboard').classList.contains('active');
    }
    function formatUptime(sec) {
        sec = Math.floor(sec);
        if (sec < 60) return sec + ' 秒';
        if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
        if (sec < 86400) return Math.floor(sec / 3600) + ' 小时 ' + Math.floor(sec % 3600 / 60) + ' 分';
        return Math.floor(sec / 86400) + ' 天 ' + Math.floor(sec % 86400 / 3600) + ' 小时';
    }
    function nowHMS() {
        var d = new Date();
        function p(n) { return n < 10 ? '0' + n : n; }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function initDashCharts() {
        if (typeof echarts === 'undefined' || dashMemChart) return;
        dashMemChart = echarts.init($('dash-chart-mem'));
        dashMsgChart = echarts.init($('dash-chart-msg'));
        window.addEventListener('resize', function () {
            if (dashMemChart) dashMemChart.resize();
            if (dashMsgChart) dashMsgChart.resize();
        });
    }

    // 内存/Goroutine 实时曲线（双 Y 轴）
    function renderMemChart() {
        if (!dashMemChart) return;
        var primary = cssVar('--primary') || '#07c160';
        var warn = '#e6a23c';
        var textLight = cssVar('--text-light') || '#8a8a8a';
        var splitLine = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
        dashMemChart.setOption({
            animation: false,
            color: [primary, warn],
            grid: { left: 50, right: 46, top: 32, bottom: 24 },
            legend: { top: 0, textStyle: { color: textLight, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
            tooltip: { trigger: 'axis' },
            xAxis: {
                type: 'category', data: dashMemHistory.times, boundaryGap: false,
                axisLabel: { color: textLight, fontSize: 10 }, axisLine: { lineStyle: { color: splitLine } }
            },
            yAxis: [
                { type: 'value', name: 'MB', nameTextStyle: { color: textLight }, axisLabel: { color: textLight, fontSize: 10 }, splitLine: { lineStyle: { color: splitLine } } },
                { type: 'value', name: '协程', nameTextStyle: { color: textLight }, axisLabel: { color: textLight, fontSize: 10 }, splitLine: { show: false } }
            ],
            series: [
                { name: '堆内存 MB', type: 'line', showSymbol: false, data: dashMemHistory.heap, smooth: true },
                { name: 'Goroutines', type: 'line', yAxisIndex: 1, showSymbol: false, data: dashMemHistory.goroutines, smooth: true, lineStyle: { type: 'dashed' } }
            ]
        });
    }

    // 今日消息按小时分布柱状图
    function renderMsgChart(hourly) {
        if (!dashMsgChart || !hourly) return;
        var primary = cssVar('--primary') || '#07c160';
        var textLight = cssVar('--text-light') || '#8a8a8a';
        var splitLine = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
        var hours = [], counts = [];
        for (var i = 0; i < hourly.length; i++) {
            hours.push(hourly[i].hour + '时');
            counts.push(hourly[i].count);
        }
        dashMsgChart.setOption({
            animation: false,
            grid: { left: 44, right: 16, top: 20, bottom: 24 },
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: hours, axisLabel: { color: textLight, fontSize: 10, interval: 3 }, axisLine: { lineStyle: { color: splitLine } } },
            yAxis: { type: 'value', axisLabel: { color: textLight, fontSize: 10 }, splitLine: { lineStyle: { color: splitLine } } },
            series: [{ type: 'bar', data: counts, barMaxWidth: 14, itemStyle: { color: primary, borderRadius: [3, 3, 0, 0] } }]
        });
    }

    // 主题切换后图表配色即时刷新（重设全部文字/线条/柱色）
    function refreshDashChartsTheme() {
        renderMemChart();
        renderMsgChart(dashLastHourly);
    }

    function fetchMetrics() {
        if (!isDashboardActive() || !getToken()) return;
        api('GET', '/admin/api/metrics').then(function (result) {
            if (!result.ok) {
                $('dash-status').textContent = result.msg || '加载失败';
                return;
            }
            var sys = result.data.system, biz = result.data.business, db = result.data.db;
            // 核心业务卡片
            $('dash-online-users').textContent = biz.online_users;
            $('dash-online-conns').textContent = '连接数 ' + biz.online_conns;
            $('dash-today-msgs').textContent = biz.today_msgs;
            $('dash-total-msgs').textContent = '总量 ' + biz.total_msgs;
            $('dash-total-users').textContent = biz.total_users;
            $('dash-ai-count').textContent = 'AI 智能体 ' + biz.ai_agents + ' / 服务 ' + biz.ai_providers;
            // 阶段一百六十八：积分总量卡片（服务端 SUM 实时聚合；人均 = 总量/注册用户数，fmtPts 统一格式化）
            $('dash-points-total').textContent = fmtPts(biz.points_total || 0);
            $('dash-points-avg').textContent = biz.total_users ? ('人均 ' + fmtPts((biz.points_total || 0) / biz.total_users)) : '人均 -';
            $('dash-upload-size').textContent = biz.upload_size_mb.toFixed(1) + ' MB';
            $('dash-upload-files').textContent = '文件数 ' + biz.upload_files;
            // 阶段一百六十八：网盘占用卡片（与文件存储管理「总占用」同源，60 秒服务端缓存）
            $('dash-drive-size').textContent = fmFormatSize(biz.drive_total_size || 0);
            $('dash-drive-files').textContent = '文件数 ' + (biz.drive_file_count || 0);
            // 阶段一百四十七：通话链路统计卡片（直连率=P2P 直连占已接通比例，链路未知=旧客户端/未接通）
            $('dash-calls-today').textContent = biz.today_calls;
            $('dash-calls-total').textContent = biz.total_calls;
            $('dash-calls-p2p').textContent = biz.call_p2p;
            $('dash-calls-relay').textContent = biz.call_relay;
            var unknown = biz.call_completed - biz.call_p2p - biz.call_relay;
            $('dash-calls-unknown').textContent = unknown > 0 ? unknown : 0;
            $('dash-calls-rate').textContent = biz.call_completed > 0 ?
                (biz.call_p2p * 100 / biz.call_completed).toFixed(1) + '%' : '-';
            // 运行环境小卡片
            $('dash-heap').textContent = sys.heap_alloc_mb.toFixed(1) + ' MB';
            $('dash-goroutines').textContent = sys.goroutines;
            $('dash-gc').textContent = sys.gc_count + ' 次';
            $('dash-uptime').textContent = formatUptime(sys.uptime_sec);
            $('dash-mysql').textContent = db.mysql_in_use + ' / ' + db.mysql_max_open;
            $('dash-mysql').title = '空闲 ' + db.mysql_idle + ' · 累计等待 ' + db.mysql_wait_count;
            $('dash-redis').textContent = db.redis_ok ? db.redis_ping_ms.toFixed(2) + ' ms' : '不可用';
            // 元信息行
            $('dash-meta').textContent = 'Go ' + sys.go_version + ' · CPU ' + sys.num_cpu + ' 核 · 堆对象 ' +
                sys.heap_objects + ' · 距上次 GC ' + sys.gc_last_ago_sec.toFixed(1) + ' 秒 · 上传目录扫描于 ' +
                (biz.upload_scan_at ? new Date(biz.upload_scan_at * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '-');
            $('dash-status').textContent = '更新于 ' + nowHMS();
            // 实时曲线追加采样点（超窗口滚动淘汰）
            dashMemHistory.times.push(nowHMS());
            dashMemHistory.heap.push(Number(sys.heap_alloc_mb.toFixed(2)));
            dashMemHistory.goroutines.push(sys.goroutines);
            if (dashMemHistory.times.length > DASH_WINDOW) {
                dashMemHistory.times.shift();
                dashMemHistory.heap.shift();
                dashMemHistory.goroutines.shift();
            }
            dashLastHourly = biz.hourly_today;
            renderMemChart();
            renderMsgChart(dashLastHourly);
        }).catch(function () {
            $('dash-status').textContent = '网络异常，重试中…';
        });
    }

    function startDashboardPolling() {
        initDashCharts();
        fetchMetrics();
        if (dashTimer) clearInterval(dashTimer);
        dashTimer = setInterval(fetchMetrics, DASH_POLL_MS);
    }
    function stopDashboardPolling() {
        if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
    }

    // ===== 阶段一百四十七：通话统计（全量话单 + 链路类型筛选，数据源 /admin/api/calllogs） =====
    // 空数据显示"暂无话单"，仅请求出错时显示"加载失败"（用户偏好归口）
    var CALLLOGS_PAGE_SIZE = 20;
    var calllogsPage = 1;
    var calllogsTotalPages = 1; // 最近一次查询的总页数（next 翻页边界）

    // 话单文案映射（服务端归口状态/链路枚举，前端仅展示格式化）
    function callStatusText(s) {
        return { completed: '已接通', rejected: '已拒绝', canceled: '已取消', missed: '无人接听', busy: '对方忙' }[s] || s || '-';
    }
    function callLinkText(lt) {
        if (lt === 'p2p') return 'P2P 直连';
        if (lt === 'relay') return 'TURN 中继';
        return '未统计';
    }
    function callTypeText(t) {
        return { audio: '语音', video: '视频' }[t] || t || '-';
    }
    // 时长格式化：秒 → mm:ss / hh:mm:ss
    function callDurText(sec) {
        sec = Number(sec) || 0;
        var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return h > 0 ? p(h) + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
    }

    function loadCallLogs() {
        if (!getToken()) return;
        var filter = $('calllogs-link-filter').value || '';
        $('calllogs-status').textContent = '加载中…';
        api('GET', '/admin/api/calllogs?page=' + calllogsPage + '&page_size=' + CALLLOGS_PAGE_SIZE +
            (filter ? '&link_type=' + filter : '')).then(function (result) {
            if (!result.ok) {
                $('calllogs-status').textContent = result.msg || '加载失败';
                return;
            }
            // 管理接口信封约定：业务数据在 result.data（与其他 admin 接口一致，原误按顶层读取致恒显"暂无话单"）
            var d = result.data || {};
            var rows = d.list || [];
            if (!rows.length) {
                $('calllogs-tbody').innerHTML = '<tr><td colspan="7" class="vec-empty">暂无话单</td></tr>';
                $('calllogs-page-info').textContent = '共 0 条';
                $('calllogs-status').textContent = '更新于 ' + nowHMS();
                return;
            }
            var html = '';
            rows.forEach(function (r) {
                var t = r.create_time ? new Date(r.create_time).toLocaleString('zh-CN', { hour12: false }) : '-';
                html += '<tr>' +
                    '<td>' + t + '</td>' +
                    '<td>' + (r.caller || '-') + '</td>' +
                    '<td>' + (r.callee || '-') + '</td>' +
                    '<td>' + callTypeText(r.call_type) + '</td>' +
                    '<td>' + callStatusText(r.status) + '</td>' +
                    '<td>' + (r.status === 'completed' ? callDurText(r.duration) : '-') + '</td>' +
                    '<td>' + callLinkText(r.link_type) + '</td>' +
                    '</tr>';
            });
            $('calllogs-tbody').innerHTML = html;
            calllogsTotalPages = Math.max(1, Math.ceil((d.total || 0) / CALLLOGS_PAGE_SIZE));
            $('calllogs-page-info').textContent = '共 ' + (d.total || 0) + ' 条 · 第 ' + (d.page || 1) + ' / ' + calllogsTotalPages + ' 页';
            $('calllogs-status').textContent = '更新于 ' + nowHMS();
        }).catch(function () {
            $('calllogs-status').textContent = '加载失败';
        });
    }
    $('calllogs-refresh').addEventListener('click', function () { calllogsPage = 1; loadCallLogs(); });
    $('calllogs-link-filter').addEventListener('change', function () { calllogsPage = 1; loadCallLogs(); });
    $('calllogs-prev').addEventListener('click', function () {
        if (calllogsPage > 1) { calllogsPage--; loadCallLogs(); }
    });
    $('calllogs-next').addEventListener('click', function () {
        if (calllogsPage < calllogsTotalPages) { calllogsPage++; loadCallLogs(); }
    });

    // ===== 文件存储管理（阶段一百六十七：/admin/api/drive/* 全站文件/回收站统一管理） =====
    // 删除/还原全走服务端归口（引用计数保护：共享对象只清元数据），前端零计算只展示
    var FM_PAGE_SIZE = 20;
    var fmPage = 1, fmTotalPages = 1;
    var fmRows = [];        // 当前页数据（全选本页用）
    var fmSelected = {};    // 勾选集合（id -> true）；加载新列表即重置——防止跨筛选/翻页误操作不可见文件
    function fmFormatSize(n) {
        if (n === null || n === undefined || isNaN(n)) return '-';
        if (n < 1024) return n + ' B';
        var units = ['KB', 'MB', 'GB', 'TB'], v = n, i = -1;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
    }
    function fmFormatTime(t) {
        return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-';
    }
    function fmLoadStats() {
        if (!getToken()) return;
        api('GET', '/admin/api/drive/stats').then(function (result) {
            if (!result.ok) return;
            var d = result.data || {};
            $('fm-total-size').textContent = fmFormatSize(d.total_size || 0);
            $('fm-file-count').textContent = '文件数 ' + (d.file_count || 0);
            $('fm-user-count').textContent = d.user_count || 0;
            $('fm-share-total').textContent = '分享数 ' + (d.share_total || 0);
            $('fm-trash-size').textContent = fmFormatSize(d.trash_size || 0);
            $('fm-trash-count').textContent = '文件数 ' + (d.trash_count || 0);
            $('fm-backend').textContent = d.backend === 'minio' ? 'MinIO' : d.backend === 'local' ? '本地磁盘' : (d.backend || '-');
        }).catch(function () { /* 静默：总览卡片保持上次值 */ });
    }
    function fmQuery() {
        var params = 'page=' + fmPage + '&page_size=' + FM_PAGE_SIZE;
        if ($('fm-trash-filter').value) params += '&trash=' + $('fm-trash-filter').value;
        if ($('fm-shared-filter').value) params += '&shared=1';
        var kw = $('fm-keyword').value.trim();
        if (kw) params += '&keyword=' + encodeURIComponent(kw);
        var ow = $('fm-owner').value.trim();
        if (ow) params += '&owner=' + encodeURIComponent(ow);
        params += '&sort=' + ($('fm-sort').value || 'time_desc');
        return params;
    }
    function fmLoadFiles() {
        if (!getToken()) return;
        fmSelected = {}; fmSyncSel();
        $('fm-status').textContent = '加载中…';
        api('GET', '/admin/api/drive/files?' + fmQuery()).then(function (result) {
            if (!result.ok) {
                $('fm-status').textContent = result.msg || '加载失败';
                return;
            }
            var d = result.data || {};
            fmRows = d.list || [];
            fmRender(fmRows);
            fmTotalPages = Math.max(1, Math.ceil((d.total || 0) / FM_PAGE_SIZE));
            $('fm-page-info').textContent = '共 ' + (d.total || 0) + ' 条 · 第 ' + (d.page || 1) + ' / ' + fmTotalPages + ' 页';
            $('fm-status').textContent = '更新于 ' + nowHMS();
        }).catch(function () {
            $('fm-status').textContent = '加载失败';
        });
    }
    function fmCell(text, cls, title) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        if (title) td.title = title;
        return td;
    }
    function fmBadge(text, badgeCls) {
        var span = document.createElement('span');
        span.className = 'at-badge ' + badgeCls;
        span.textContent = text;
        return span;
    }
    function fmActBtn(text, danger, cb) {
        var b = document.createElement('button');
        b.className = 'admin-btn small' + (danger ? ' danger' : '');
        b.textContent = text;
        b.addEventListener('click', cb);
        return b;
    }
    function fmRender(rows) {
        var body = $('fm-tbody');
        body.innerHTML = '';
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="10" class="vec-empty">暂无文件</td></tr>';
            return;
        }
        rows.forEach(function (r) {
            var tr = document.createElement('tr');
            // 勾选列
            var tdCk = document.createElement('td');
            tdCk.className = 'fm-td-ck';
            var ck = document.createElement('input');
            ck.type = 'checkbox';
            ck.checked = !!fmSelected[r.id];
            ck.addEventListener('change', function () {
                if (ck.checked) fmSelected[r.id] = true; else delete fmSelected[r.id];
                fmSyncSel();
            });
            tdCk.appendChild(ck);
            tr.appendChild(tdCk);
            // 文件名 / 归属用户 / 大小 / 类型 / 上传时间 / 引用 / 分享
            tr.appendChild(fmCell(r.name, 'vec-td-file', r.name));
            tr.appendChild(fmCell(r.owner || '-', 'vec-td-nowrap'));
            tr.appendChild(fmCell(fmFormatSize(r.size), 'vec-td-num'));
            tr.appendChild(fmCell(r.mime_type || '-', 'vec-td-nowrap'));
            tr.appendChild(fmCell(fmFormatTime(r.create_time), 'vec-td-nowrap'));
            // 引用列：>1 悬浮提示共享来源（秒传/受让副本）
            tr.appendChild(fmCell(String(r.ref_count || 0), 'vec-td-num',
                (r.ref_count || 0) > 1 ? r.ref_count + ' 条记录共享同一存储对象（秒传/受让副本），彻底删除仅清元数据' : ''));
            // 分享列：有分享记录显示条数徽标
            var tdShare = document.createElement('td');
            if ((r.share_count || 0) > 0) {
                tdShare.appendChild(fmBadge('已分享 · ' + r.share_count, 'at-st-completed'));
            } else {
                tdShare.textContent = '-';
            }
            tr.appendChild(tdShare);
            // 状态列：正常 / 回收站
            var tdSt = document.createElement('td');
            if (r.deleted_at) {
                tdSt.appendChild(fmBadge('回收站', 'at-st-cancelled'));
                tdSt.title = '删除于 ' + fmFormatTime(r.deleted_at);
            } else {
                tdSt.appendChild(fmBadge('正常', 'at-st-completed'));
            }
            tr.appendChild(tdSt);
            // 操作列：正常行=删除+彻底删除；回收站行=还原+彻底删除
            var tdAct = document.createElement('td');
            tdAct.className = 'vec-td-actions';
            if (r.deleted_at) {
                tdAct.appendChild(fmActBtn('还原', false, function () { fmOp([r.id], 'restore'); }));
            } else {
                tdAct.appendChild(fmActBtn('删除', true, function () { fmAskDelete([r.id], false); }));
            }
            tdAct.appendChild(fmActBtn('彻底删除', true, function () { fmAskDelete([r.id], true); }));
            tr.appendChild(tdAct);
            body.appendChild(tr);
        });
        $('fm-check-all').checked = rows.length > 0 && rows.every(function (r) { return fmSelected[r.id]; });
    }
    function fmSyncSel() {
        var n = Object.keys(fmSelected).length;
        $('fm-sel-tip').textContent = n ? '已选 ' + n + ' 项' : '未选中文件';
    }
    // fmOp 操作归口：delete=移入回收站 / purge=彻底删除 / restore=还原；成功后列表与总览联动刷新
    function fmOp(ids, op) {
        var req;
        if (op === 'restore') {
            req = api('POST', '/admin/api/drive/restore', { ids: ids });
        } else {
            req = api('POST', '/admin/api/drive/delete', { ids: ids, purge: op === 'purge' });
        }
        req.then(function (result) {
            if (!result.ok) { showToast(result.msg || '操作失败'); return; }
            var d = result.data || {};
            if (op === 'restore') {
                showToast('已还原 ' + (d.restored || 0) + ' 项');
            } else {
                showToast('已删除 ' + (d.deleted || 0) + ' 条记录' + (d.purged ? '，清理对象 ' + d.purged + ' 个' : ''));
            }
            fmLoadFiles();
            fmLoadStats();
        }).catch(function () { showToast('操作失败'); });
    }
    // fmAskDelete 删除确认归口（自绘弹窗）：彻底删除明确提示不可恢复与共享对象保护
    function fmAskDelete(ids, purge) {
        var n = ids.length;
        if (purge) {
            confirmBox('彻底删除后不可恢复（仍被其他记录共享引用的存储对象仅清元数据、对象保留）。确定彻底删除所选 ' + n + ' 项？', function () { fmOp(ids, 'purge'); });
        } else {
            confirmBox('确定将所选 ' + n + ' 项移入回收站？相关分享将同时失效。', function () { fmOp(ids, 'delete'); });
        }
    }
    function fmSelIds() { return Object.keys(fmSelected).map(Number); }
    $('fm-search').addEventListener('click', function () { fmPage = 1; fmLoadFiles(); });
    $('fm-refresh').addEventListener('click', function () { fmPage = 1; fmLoadFiles(); fmLoadStats(); });
    $('fm-keyword').addEventListener('keydown', function (e) { if (e.key === 'Enter') { fmPage = 1; fmLoadFiles(); } });
    $('fm-owner').addEventListener('keydown', function (e) { if (e.key === 'Enter') { fmPage = 1; fmLoadFiles(); } });
    $('fm-trash-filter').addEventListener('change', function () { fmPage = 1; fmLoadFiles(); });
    $('fm-shared-filter').addEventListener('change', function () { fmPage = 1; fmLoadFiles(); });
    $('fm-sort').addEventListener('change', function () { fmPage = 1; fmLoadFiles(); });
    $('fm-prev').addEventListener('click', function () { if (fmPage > 1) { fmPage--; fmLoadFiles(); } });
    $('fm-next').addEventListener('click', function () { if (fmPage < fmTotalPages) { fmPage++; fmLoadFiles(); } });
    $('fm-check-all').addEventListener('change', function () {
        var on = $('fm-check-all').checked;
        fmRows.forEach(function (r) {
            if (on) fmSelected[r.id] = true; else delete fmSelected[r.id];
        });
        fmSyncSel();
        fmRender(fmRows);
    });
    $('fm-batch-delete').addEventListener('click', function () {
        var ids = fmSelIds();
        if (!ids.length) { showToast('请先勾选文件'); return; }
        fmAskDelete(ids, false);
    });
    $('fm-batch-restore').addEventListener('click', function () {
        var ids = fmSelIds();
        if (!ids.length) { showToast('请先勾选文件'); return; }
        confirmBox('确定还原所选 ' + ids.length + ' 项？文件在其已删除目录内时将整树连带还原。', function () { fmOp(ids, 'restore'); });
    });
    $('fm-batch-purge').addEventListener('click', function () {
        var ids = fmSelIds();
        if (!ids.length) { showToast('请先勾选文件'); return; }
        fmAskDelete(ids, true);
    });

    // ===== 分享管理（阶段一百六十七：/admin/api/drive/shares 全站分享审计 + 强制取消） =====
    var FS_PAGE_SIZE = 20;
    var fsPage = 1, fsTotalPages = 1;
    var FS_STATE_TEXT = { valid: '有效', canceled: '已取消', expired: '已过期', deleted: '源文件已删除' };
    var FS_STATE_BADGE = { valid: 'at-st-completed', canceled: 'at-st-cancelled', expired: 'at-st-queued', deleted: 'at-st-failed' };
    function fsLoadShares() {
        if (!getToken()) return;
        $('fs-status').textContent = '加载中…';
        var params = 'page=' + fsPage + '&page_size=' + FS_PAGE_SIZE;
        if ($('fs-status-filter').value) params += '&status=' + $('fs-status-filter').value;
        var kw = $('fs-keyword').value.trim();
        if (kw) params += '&keyword=' + encodeURIComponent(kw);
        api('GET', '/admin/api/drive/shares?' + params).then(function (result) {
            if (!result.ok) {
                $('fs-status').textContent = result.msg || '加载失败';
                return;
            }
            var d = result.data || {};
            var rows = d.list || [];
            var body = $('fs-tbody');
            body.innerHTML = '';
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="11" class="vec-empty">暂无分享</td></tr>';
                $('fs-page-info').textContent = '共 0 条';
                $('fs-status').textContent = '更新于 ' + nowHMS();
                return;
            }
            rows.forEach(function (r) {
                var tr = document.createElement('tr');
                tr.appendChild(fsCell(r.from || '-', 'vec-td-nowrap'));
                var name = (r.is_dir ? '[目录] ' : '') + (r.file_name || '-');
                tr.appendChild(fsCell(name, 'vec-td-file', name));
                tr.appendChild(fsCell(r.is_dir ? '-' : fmFormatSize(r.size), 'vec-td-num'));
                tr.appendChild(fsCell(r.has_extract ? '有' : '无'));
                tr.appendChild(fsCell(r.expire_at ? new Date(r.expire_at * 1000).toLocaleString('zh-CN', { hour12: false }) : '永久', 'vec-td-nowrap'));
                tr.appendChild(fsCell(String(r.view_count || 0), 'vec-td-num'));
                tr.appendChild(fsCell(String(r.download_count || 0), 'vec-td-num'));
                tr.appendChild(fsCell(String(r.save_count || 0), 'vec-td-num'));
                // 状态徽标（服务端 state 归口四态）
                var tdSt = document.createElement('td');
                var badge = document.createElement('span');
                badge.className = 'at-badge ' + (FS_STATE_BADGE[r.state] || 'at-st-cancelled');
                badge.textContent = FS_STATE_TEXT[r.state] || r.state;
                tdSt.appendChild(badge);
                tr.appendChild(tdSt);
                tr.appendChild(fsCell(fmFormatTime(r.create_time), 'vec-td-nowrap'));
                // 操作列：有效分享可强制取消（已取消/已失效项无可操作动作）
                var tdAct = document.createElement('td');
                tdAct.className = 'vec-td-actions';
                if (r.state !== 'canceled') {
                    var btn = document.createElement('button');
                    btn.className = 'admin-btn small danger';
                    btn.textContent = '强制取消';
                    btn.addEventListener('click', function () {
                        confirmBox('确定强制取消该分享？站内链接与聊天卡片将立即失效。', function () {
                            api('POST', '/admin/api/drive/share/cancel', { ids: [r.id] }).then(function (res) {
                                if (!res.ok) { showToast(res.msg || '操作失败'); return; }
                                showToast('已取消 ' + ((res.data || {}).canceled || 0) + ' 条分享');
                                fsLoadShares();
                            }).catch(function () { showToast('操作失败'); });
                        });
                    });
                    tdAct.appendChild(btn);
                }
                tr.appendChild(tdAct);
                body.appendChild(tr);
            });
            fsTotalPages = Math.max(1, Math.ceil((d.total || 0) / FS_PAGE_SIZE));
            $('fs-page-info').textContent = '共 ' + (d.total || 0) + ' 条 · 第 ' + (d.page || 1) + ' / ' + fsTotalPages + ' 页';
            $('fs-status').textContent = '更新于 ' + nowHMS();
        }).catch(function () {
            $('fs-status').textContent = '加载失败';
        });
    }
    function fsCell(text, cls, title) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        if (title) td.title = title;
        return td;
    }
    $('fs-search').addEventListener('click', function () { fsPage = 1; fsLoadShares(); });
    $('fs-refresh').addEventListener('click', function () { fsPage = 1; fsLoadShares(); });
    $('fs-keyword').addEventListener('keydown', function (e) { if (e.key === 'Enter') { fsPage = 1; fsLoadShares(); } });
    $('fs-status-filter').addEventListener('change', function () { fsPage = 1; fsLoadShares(); });
    $('fs-prev').addEventListener('click', function () { if (fsPage > 1) { fsPage--; fsLoadShares(); } });
    $('fs-next').addEventListener('click', function () { if (fsPage < fsTotalPages) { fsPage++; fsLoadShares(); } });

    // ===== 聊天附件管理（阶段一百六十八：/admin/api/upload/* static/upload 目录文件级明细） =====
    // 口径：分类（聊天文件=im_file 命中 / 功能文件=公告与工作台前缀 / 未关联=孤儿）与保留期倒计时
    // 由服务端归口；删除=物理删除（与定期清理同语义），不删 im_file 审计记录
    var UP_PAGE_SIZE = 20;
    var upPage = 1, upTotalPages = 1;
    var upSelected = {};          // 跨页勾选集合（key=磁盘文件名）
    var UP_CAT_TEXT = { chat: '聊天文件', feature: '功能文件', orphan: '未关联' };
    var UP_CAT_BADGE = { chat: 'at-st-completed', feature: 'at-st-queued', orphan: 'at-st-failed' };

    function upLoadStats() {
        if (!getToken()) return;
        api('GET', '/admin/api/upload/stats').then(function (result) {
            if (!result.ok) return;
            var d = result.data || {};
            $('up-total-size').textContent = fmFormatSize(d.total_size || 0);
            $('up-file-count').textContent = '文件数 ' + (d.file_count || 0);
            $('up-chat-count').textContent = String(d.chat_count || 0);
            $('up-image-count').textContent = '图片 ' + (d.image_count || 0);
            $('up-feature-count').textContent = String(d.feature_count || 0);
            $('up-orphan-count').textContent = String(d.orphan_count || 0);
            var rd = d.retention_days;
            $('up-retention').textContent = rd < 0 ? '清理未启用' : '保留 ' + rd + ' 天';
        }).catch(function () { /* 总览失败不阻断列表 */ });
    }

    function upLoadFiles() {
        if (!getToken()) return;
        $('up-status').textContent = '加载中…';
        var params = 'page=' + upPage + '&page_size=' + UP_PAGE_SIZE;
        if ($('up-cat-filter').value) params += '&category=' + $('up-cat-filter').value;
        if ($('up-sort').value) params += '&sort=' + $('up-sort').value;
        var kw = $('up-keyword').value.trim();
        if (kw) params += '&keyword=' + encodeURIComponent(kw);
        api('GET', '/admin/api/upload/files?' + params).then(function (result) {
            if (!result.ok) {
                $('up-status').textContent = result.msg || '加载失败';
                return;
            }
            var d = result.data || {};
            var rows = d.list || [];
            var body = $('up-tbody');
            body.innerHTML = '';
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="9" class="vec-empty">暂无文件</td></tr>';
                $('up-page-info').textContent = '共 0 条';
                $('up-status').textContent = '更新于 ' + nowHMS();
                upSyncSel();
                return;
            }
            rows.forEach(function (r) {
                var tr = document.createElement('tr');
                // 勾选列（跨页保留）
                var tdCk = document.createElement('td');
                tdCk.className = 'fm-td-ck';
                var ck = document.createElement('input');
                ck.type = 'checkbox';
                ck.checked = !!upSelected[r.name];
                ck.addEventListener('change', function () {
                    if (ck.checked) upSelected[r.name] = true; else delete upSelected[r.name];
                    upSyncSel();
                });
                tdCk.appendChild(ck);
                tr.appendChild(tdCk);
                var img = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].indexOf((r.ext || '').replace('.', '')) !== -1;
                tr.appendChild(upCell(r.name, 'vec-td-file', r.name));
                tr.appendChild(upCell(r.orig_name || '—', 'vec-td-nowrap'));
                tr.appendChild(upCell(r.owner || '—', 'vec-td-nowrap'));
                tr.appendChild(upCell(fmFormatSize(r.size), 'vec-td-num'));
                // 分类徽标（图片文件追加图片标记）
                var tdCat = document.createElement('td');
                var catBadge = document.createElement('span');
                catBadge.className = 'at-badge ' + (UP_CAT_BADGE[r.category] || 'at-st-cancelled');
                catBadge.textContent = UP_CAT_TEXT[r.category] || r.category;
                tdCat.appendChild(catBadge);
                if (img) {
                    var imgTag = document.createElement('span');
                    imgTag.className = 'admin-card-tag';
                    imgTag.style.marginLeft = '4px';
                    imgTag.textContent = '图';
                    tdCat.appendChild(imgTag);
                }
                tr.appendChild(tdCat);
                tr.appendChild(upCell(r.mod_time || '—', 'vec-td-nowrap'));
                // 保留期列：>=0 剩余天数；-1 不适用；-2 清理未启用
                tr.appendChild(upCell(r.retain_days >= 0 ? ('剩 ' + r.retain_days + ' 天') : (r.retain_days === -2 ? '未启用' : '—'), 'vec-td-nowrap'));
                // 操作列：图片可预览；全部可删除
                var tdAct = document.createElement('td');
                tdAct.className = 'vec-td-actions';
                if (img) {
                    var pv = document.createElement('button');
                    pv.className = 'admin-btn small';
                    pv.textContent = '预览';
                    pv.addEventListener('click', function () { upPreview(r.name); });
                    tdAct.appendChild(pv);
                }
                var del = document.createElement('button');
                del.className = 'admin-btn small danger';
                del.textContent = '删除';
                del.addEventListener('click', function () { upAskDelete([r.name]); });
                tdAct.appendChild(del);
                tr.appendChild(tdAct);
                body.appendChild(tr);
            });
            upTotalPages = Math.max(1, Math.ceil((d.total || 0) / UP_PAGE_SIZE));
            $('up-page-info').textContent = '共 ' + (d.total || 0) + ' 条 · 第 ' + (d.page || 1) + ' / ' + upTotalPages + ' 页';
            $('up-status').textContent = '更新于 ' + nowHMS();
            upSyncSel();
        }).catch(function () {
            $('up-status').textContent = '加载失败';
        });
    }
    function upCell(text, cls, title) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        if (title) td.title = title;
        return td;
    }
    // 批量条与全选框状态同步（与 FM 同款：勾选计数 + 全选框三态）
    function upSyncSel() {
        var n = Object.keys(upSelected).length;
        $('up-sel-tip').textContent = n ? '已选 ' + n + ' 个文件' : '未选中文件';
        var boxes = $('up-tbody').querySelectorAll('input[type="checkbox"]');
        var checked = 0;
        boxes.forEach(function (b) { if (b.checked) checked++; });
        $('up-check-all').checked = boxes.length > 0 && checked === boxes.length;
        $('up-check-all').indeterminate = checked > 0 && checked < boxes.length;
    }
    // 删除确认（自绘弹窗归口 confirmBox）：物理删除强警示
    function upAskDelete(names) {
        if (!names || !names.length) { showToast('未选择文件'); return; }
        confirmBox('确定永久删除 ' + names.length + ' 个聊天附件？物理删除不可恢复，历史消息将无法查看对应文件（消息卡片按「文件已过期」灰显）。', function () {
            api('POST', '/admin/api/upload/delete', { names: names }).then(function (res) {
                if (!res.ok) { showToast(res.msg || '操作失败'); return; }
                var d = res.data || {};
                names.forEach(function (n) { delete upSelected[n]; });
                showToast('已删除 ' + (d.deleted || 0) + ' 个文件' + (d.failed ? '，失败 ' + d.failed : ''));
                upLoadFiles();
                upLoadStats();
            }).catch(function () { showToast('操作失败'); });
        });
    }
    // 图片预览：自绘遮罩浮层（点击任意处关闭；图片直连静态目录原尺寸自适应展示）
    function upPreview(name) {
        var mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:3000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        var img = document.createElement('img');
        img.src = '/static/upload/' + encodeURIComponent(name);
        img.alt = name;
        img.style.cssText = 'max-width:88vw;max-height:88vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.45);background:#fff;';
        mask.appendChild(img);
        mask.addEventListener('click', function () { document.body.removeChild(mask); });
        document.body.appendChild(mask);
    }
    $('up-search').addEventListener('click', function () { upPage = 1; upLoadFiles(); });
    $('up-refresh').addEventListener('click', function () { upPage = 1; upLoadFiles(); upLoadStats(); });
    $('up-keyword').addEventListener('keydown', function (e) { if (e.key === 'Enter') { upPage = 1; upLoadFiles(); } });
    $('up-cat-filter').addEventListener('change', function () { upPage = 1; upLoadFiles(); });
    $('up-sort').addEventListener('change', function () { upPage = 1; upLoadFiles(); });
    $('up-prev').addEventListener('click', function () { if (upPage > 1) { upPage--; upLoadFiles(); } });
    $('up-next').addEventListener('click', function () { if (upPage < upTotalPages) { upPage++; upLoadFiles(); } });
    $('up-check-all').addEventListener('change', function () {
        var on = $('up-check-all').checked;
        $('up-tbody').querySelectorAll('input[type="checkbox"]').forEach(function (b) {
            // 反推文件名：勾选框位于行首列，行内文件名列 title 即磁盘名
            var name = b.closest('tr').querySelector('.vec-td-file').title;
            if (on) upSelected[name] = true; else delete upSelected[name];
            b.checked = on;
        });
        upSyncSel();
    });
    $('up-batch-delete').addEventListener('click', function () {
        var names = Object.keys(upSelected);
        upAskDelete(names);
    });
    $('up-orphan-cleanup').addEventListener('click', function () {
        confirmBox('确定清理全部「未关联」文件？这些文件无任何传输记录关联（多为 AI 文件等直接落盘内容），物理删除不可恢复。', function () {
            api('POST', '/admin/api/upload/delete', { orphans: true }).then(function (res) {
                if (!res.ok) { showToast(res.msg || '操作失败'); return; }
                var d = res.data || {};
                showToast('已清理 ' + (d.deleted || 0) + ' 个未关联文件，释放 ' + fmFormatSize(d.freed_bytes || 0));
                upLoadFiles();
                upLoadStats();
            }).catch(function () { showToast('操作失败'); });
        });
    });

    // ===== 启动：已有 Token 直接进主界面（会话失效由 API 统一回登录） =====
    if (getToken()) {
        showMain();
        restoreViewFromHash(); // 刷新后原位恢复刷新前视图（hash 记忆），无 hash 保持默认仪表盘
    } else {
        showLogin();
    }

    // ===== 阶段七十八：积分管理（AI 积分 = TRAE CN 同款问答积分） =====
    // 数据归口：积分余额/扣减全部在服务端（aipoints.go），后台仅做查询展示与绝对值调整；
    // 空数据显示"暂无用户"，仅请求出错时显示"加载失败"
    var pointsAll = [];        // 全量用户（含积分）
    var pointsFiltered = [];   // 搜索过滤后（分页数据源）
    var pointsPage = 1;        // 当前页（1 起）

    // 双精度积分显示格式化：最多 2 位小数、去尾零（95 → "95"，94.506 → "94.51"，0.5 → "0.5"）；
    // 数值计算/存储归口服务端（保留 3 位小数），前端仅展示格式化
    function fmtPts(n) {
        var v = Math.round(Number(n) * 100) / 100;
        return String(v);
    }
    var POINTS_PAGE_SIZE = 10;

    function loadPointsUsers() {
        $('points-status').textContent = '加载中…';
        api('GET', '/admin/api/users').then(function (result) {
            if (!result.ok) {
                $('points-status').textContent = result.msg || '加载失败';
                showToast(result.msg || '积分列表加载失败');
                return;
            }
            pointsAll = result.data.users || [];
            $('points-status').textContent = '共 ' + pointsAll.length + ' 个用户，更新于 ' + new Date().toLocaleTimeString();
            applyPointsFilter(true);
        }).catch(function (e) {
            $('points-status').textContent = e.message || '网络异常';
        });
    }

    // 搜索过滤 + 回到第一页（reset=true 时重算统计卡片）
    function applyPointsFilter(resetStats) {
        var kw = ($('points-search').value || '').trim().toLowerCase();
        pointsFiltered = pointsAll.filter(function (u) {
            if (!kw) return true;
            return (u.username || '').toLowerCase().indexOf(kw) !== -1 ||
                   (u.nickname || '').toLowerCase().indexOf(kw) !== -1;
        });
        pointsPage = 1;
        if (resetStats) renderPointsStats();
        renderPointsTable();
    }

    // 统计卡片：用户总数/管理员数/积分总量/平均/低积分人数（低积分阈值 10 与表格红色警示一致）
    function renderPointsStats() {
        var admins = 0, total = 0, low = 0;
        pointsAll.forEach(function (u) {
            if (u.role === 1) admins++;
            total += (u.points || 0);
            if ((u.points || 0) < 10) low++;
        });
        $('points-stat-users').textContent = String(pointsAll.length);
        $('points-stat-admins').textContent = '管理员 ' + admins;
        $('points-stat-total').textContent = fmtPts(total);
        $('points-stat-avg').textContent = pointsAll.length ? fmtPts(total / pointsAll.length) : '-';
        $('points-stat-low').textContent = String(low);
    }

    function renderPointsTable() {
        var tbody = $('points-tbody');
        var pages = Math.max(1, Math.ceil(pointsFiltered.length / POINTS_PAGE_SIZE));
        if (pointsPage > pages) pointsPage = pages;
        if (!pointsFiltered.length) {
            // 搜索无命中显示"暂无用户"（区别于加载失败的错误态）
            tbody.innerHTML = '<tr><td colspan="7" class="vec-empty">' +
                (pointsAll.length ? '暂无匹配用户' : '暂无用户') + '</td></tr>';
            $('points-page-info').textContent = '-';
            return;
        }
        var start = (pointsPage - 1) * POINTS_PAGE_SIZE;
        var rows = pointsFiltered.slice(start, start + POINTS_PAGE_SIZE);
        var html = '';
        rows.forEach(function (u) {
            var pts = u.points || 0;
            // 低积分（<10）红色警示；0 分额外标注"已拦截"（AI 提问被服务端拒绝）
            var numCls = pts <= 0 ? 'points-num points-zero' : (pts < 10 ? 'points-num points-low' : 'points-num');
            var zeroTag = pts <= 0 ? ' <span class="at-badge at-st-failed">已拦截</span>' : '';
            html += '<tr>' +
                '<td class="points-uid">' + (u.id || '-') + '</td>' +
                '<td class="points-username">' + escHtml(u.username || '') + '</td>' +
                '<td>' + escHtml(u.nickname || u.username || '') + '</td>' +
                '<td>' + (u.role === 1 ? '<span class="at-badge at-st-completed">管理员</span>' : '<span class="points-role-normal">普通用户</span>') + '</td>' +
                '<td><strong class="' + numCls + '">' + fmtPts(pts) + '</strong>' + zeroTag + '</td>' +
                '<td class="points-time">' + escHtml(u.create_time || '-') + '</td>' +
                '<td><button class="admin-btn small points-edit-btn" data-username="' + escAttr(u.username || '') + '">调整</button>' +
                ' <button class="admin-btn small points-log-btn" data-username="' + escAttr(u.username || '') + '" title="查看该用户积分流水">流水</button></td>' +
                '</tr>';
        });
        tbody.innerHTML = html;
        $('points-page-info').textContent = '第 ' + pointsPage + ' / ' + pages + ' 页（共 ' + pointsFiltered.length + ' 人）';
    }

    // HTML 转义（表格单元格内容由用户数据拼出，防注入）
    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escAttr(s) { return escHtml(s); }

    // 调整积分弹窗：绝对值设置（充值=直接填新余额），服务端归口校验非负
    function openPointsEdit(username) {
        var u = null;
        for (var i = 0; i < pointsAll.length; i++) {
            if (pointsAll[i].username === username) { u = pointsAll[i]; break; }
        }
        if (!u) { showToast('用户数据已过期，请刷新后重试'); return; }
        openEditModal('调整积分 - ' + u.username + (u.nickname && u.nickname !== u.username ? '（' + u.nickname + '）' : ''), [
            { key: 'points', label: '积分余额', type: 'number', placeholder: '非负数，最多 2 位小数', hint: '绝对值设置（充值直接填新余额，支持小数），保存立即生效；AI 扣费按"AI 计费设置"生效模式执行（按量：1000 tokens=1 积分 / 按次：每次调用固定积分）' }
        ], { points: u.points || 0 }, function (data) {
            // 双精度：允许最多 2 位小数（如 12.5 / 0.88），服务端归口再次四舍五入到 2 位
            var raw = String(data.points).trim();
            var n = Math.round(Number(raw) * 100) / 100;
            if (isNaN(n) || n < 0 || !/^\d+(\.\d{1,2})?$/.test(raw)) {
                showToast('积分必须为非负数（最多 2 位小数）');
                return; // 弹窗保留，可修正后再次保存
            }
            api('PUT', '/admin/api/users/' + encodeURIComponent(u.username) + '/points', { points: n })
                .then(function (result) {
                    if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                    closeEditModal();
                    showToast('已将 ' + u.username + ' 积分调整为 ' + fmtPts(n));
                    loadPointsUsers(); // 重拉列表刷新统计与表格（余额以服务端为准）
                    loadPointsLogs();  // 阶段七十八：流水表同步刷新，本轮调整记录即时可见
                }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }

    // 表格内"调整"/"流水"按钮：事件委托（重渲染无需重复绑定）
    $('points-tbody').addEventListener('click', function (e) {
        var editBtn = e.target.closest('.points-edit-btn');
        if (editBtn) { openPointsEdit(editBtn.getAttribute('data-username')); return; }
        // "流水"：填充流水区用户名过滤条件并定位到流水表（清掉可能冲突的用户 ID 筛选）
        var logBtn = e.target.closest('.points-log-btn');
        if (logBtn) {
            $('plog-username').value = logBtn.getAttribute('data-username');
            $('plog-userid').value = '';
            plogPage = 1;
            loadPointsLogs();
            document.getElementById('plog-tbody').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
    // 搜索实时过滤 + 刷新重拉
    $('points-search').addEventListener('input', function () { applyPointsFilter(false); });
    $('points-refresh').addEventListener('click', loadPointsUsers);
    // 分页
    $('points-prev').addEventListener('click', function () {
        if (pointsPage > 1) { pointsPage--; renderPointsTable(); }
    });
    $('points-next').addEventListener('click', function () {
        var pages = Math.ceil(pointsFiltered.length / POINTS_PAGE_SIZE);
        if (pointsPage < pages) { pointsPage++; renderPointsTable(); }
    });

    // ===== 阶段七十八：积分流水记录（审计视图，服务端分页归口） =====
    // 数据源：AI 问答扣除 / 管理员调整 / 注册赠送（服务端 aipoints.recordPointsLog 统一落库）
    var plogPage = 1;
    var plogTotal = 0; // 最近一次查询的总条数（计算总页数用）
    var PLOG_PAGE_SIZE = 15;

    // 流水筛选参数（用户名/用户 ID/类型/时间范围）：查询与导出共用，保证所见即所导；
    // datetime-local 值形如 2026-09-12T00:05，T 换空格后服务端按 "2006-01-02 15:04" 解析；
    // user_id 服务端解析为用户名后过滤，同时传用户名时两者叠加（以服务端口径为准）
    function pointsLogFilterQuery() {
        var start = ($('plog-start').value || '').trim().replace('T', ' ');
        var end = ($('plog-end').value || '').trim().replace('T', ' ');
        return 'username=' + encodeURIComponent(($('plog-username').value || '').trim()) +
            '&user_id=' + encodeURIComponent(($('plog-userid').value || '').trim()) +
            '&reason=' + encodeURIComponent($('plog-reason').value || '') +
            '&start=' + encodeURIComponent(start) +
            '&end=' + encodeURIComponent(end);
    }

    // 类型徽标映射（与 admin.css 中 .plog-badge-* 配色一一对应）
    var PLOG_REASON_TEXT = {
        ai_deduct: 'AI 问答扣除',
        admin_adjust: '管理员调整',
        register_grant: '注册赠送'
    };
    var PLOG_REASON_CLS = {
        ai_deduct: 'plog-badge-ai',
        admin_adjust: 'plog-badge-admin',
        register_grant: 'plog-badge-reg'
    };

    function loadPointsLogs() {
        $('plog-tbody').innerHTML = '<tr><td colspan="7" class="vec-empty">加载中…</td></tr>';
        var path = '/admin/api/points/logs?' + pointsLogFilterQuery() +
            '&page=' + plogPage + '&page_size=' + PLOG_PAGE_SIZE;
        api('GET', path).then(function (result) {
            if (!result.ok) {
                $('plog-tbody').innerHTML = '<tr><td colspan="7" class="vec-empty">' + escHtml(result.msg || '加载失败') + '</td></tr>';
                $('plog-page-info').textContent = '-';
                return;
            }
            var logs = result.data.logs || [];
            plogTotal = result.data.total || 0;
            var pages = Math.max(1, Math.ceil(plogTotal / PLOG_PAGE_SIZE));
            if (plogPage > pages) plogPage = pages;
            if (!logs.length) {
                // 有过滤条件时提示无匹配，无过滤时提示暂无记录（区别于加载失败）
                var filtered = ($('plog-username').value || '').trim() || ($('plog-userid').value || '').trim() ||
                    $('plog-reason').value ||
                    ($('plog-start').value || '').trim() || ($('plog-end').value || '').trim();
                $('plog-tbody').innerHTML = '<tr><td colspan="7" class="vec-empty">' + (filtered ? '暂无匹配流水' : '暂无流水记录') + '</td></tr>';
                $('plog-page-info').textContent = '-';
                return;
            }
            var html = '';
            logs.forEach(function (l) {
                var pos = l.change > 0;
                var reasonText = PLOG_REASON_TEXT[l.reason] || l.reason;
                var reasonCls = PLOG_REASON_CLS[l.reason] || 'plog-badge-admin';
                html += '<tr>' +
                    '<td class="points-time">' + escHtml(l.create_time || '-') + '</td>' +
                    '<td class="points-username">' + escHtml(l.username || '') + '</td>' +
                    '<td><span class="at-badge ' + reasonCls + '">' + escHtml(reasonText) + '</span></td>' +
                    '<td class="' + (pos ? 'plog-change-plus' : 'plog-change-minus') + '">' + (pos ? '+' : '') + fmtPts(l.change) + '</td>' +
                    '<td class="points-num-cell">' + fmtPts(l.balance_after) + '</td>' +
                    '<td class="points-time">' + escHtml(l.operator || 'system') + '</td>' +
                    '<td class="plog-detail">' + escHtml(l.detail || '') + '</td>' +
                    '</tr>';
            });
            $('plog-tbody').innerHTML = html;
            $('plog-page-info').textContent = '第 ' + plogPage + ' / ' + pages + ' 页（共 ' + plogTotal + ' 条）';
        }).catch(function (e) {
            $('plog-tbody').innerHTML = '<tr><td colspan="7" class="vec-empty">' + escHtml(e.message || '网络异常') + '</td></tr>';
        });
    }

    // 查询（回第一页）/ 类型切换 / 分页
    $('plog-refresh').addEventListener('click', function () { plogPage = 1; loadPointsLogs(); });
    $('plog-reason').addEventListener('change', function () { plogPage = 1; loadPointsLogs(); });
    $('plog-prev').addEventListener('click', function () {
        if (plogPage > 1) { plogPage--; loadPointsLogs(); }
    });
    $('plog-next').addEventListener('click', function () {
        var pages = Math.max(1, Math.ceil(plogTotal / PLOG_PAGE_SIZE));
        if (plogPage < pages) { plogPage++; loadPointsLogs(); }
    });

    // 导出 CSV：带 Token 的 fetch + blob 下载（<a> 直下无法携带 Authorization 头）；
    // 导出范围 = 当前筛选条件下的全部流水（服务端流式生成，无行数上限）
    $('plog-export').addEventListener('click', function () {
        showToast('正在导出流水…');
        fetch('/admin/api/points/logs/export?' + pointsLogFilterQuery(), {
            headers: { 'Authorization': 'Bearer ' + getToken() }
        }).then(function (resp) {
            if (!resp.ok) { throw new Error('导出失败（HTTP ' + resp.status + '）'); }
            // 从 Content-Disposition 取服务端生成的中文文件名（filename* RFC 5987 编码）
            var cd = resp.headers.get('Content-Disposition') || '';
            var m = cd.match(/filename\*=UTF-8''([^;]+)/);
            var fname = m ? decodeURIComponent(m[1]) : 'points_logs.csv';
            return resp.blob().then(function (blob) {
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = fname;
                document.body.appendChild(a);
                a.click();
                setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                showToast('流水已导出：' + fname);
            });
        }).catch(function (e) {
            showToast(e.message || '导出失败，请重试');
        });
    });

    // ===== 阶段一百三十四：账号管理（资料修改/密码重置，管理员归口） =====
    // 数据源复用 GET /admin/api/users（列表已含资料字段）；资料修改 PUT /admin/api/users/{u}/profile、
    // 密码重置 PUT /admin/api/users/{u}/password；空数据显示"暂无账号"，仅请求出错时显示"加载失败"
    var accountsAll = [];       // 全量账号（含资料字段）
    var accountsFiltered = [];  // 搜索过滤后（分页数据源）
    var accountsPage = 1;       // 当前页（1 起）
    var ACCOUNTS_PAGE_SIZE = 10;
    var ACCOUNT_GENDER_TEXT = { 0: '未知', 1: '男', 2: '女' };

    function loadAccounts() {
        $('accounts-status').textContent = '加载中…';
        api('GET', '/admin/api/users').then(function (result) {
            if (!result.ok) {
                $('accounts-status').textContent = result.msg || '加载失败';
                showToast(result.msg || '账号列表加载失败');
                return;
            }
            accountsAll = result.data.users || [];
            $('accounts-status').textContent = '共 ' + accountsAll.length + ' 个账号，更新于 ' + new Date().toLocaleTimeString();
            applyAccountsFilter();
        }).catch(function (e) {
            $('accounts-status').textContent = e.message || '网络异常';
        });
    }

    // 搜索实时过滤（用户名/昵称），过滤后回到第一页
    function applyAccountsFilter() {
        var kw = ($('accounts-search').value || '').trim().toLowerCase();
        accountsFiltered = accountsAll.filter(function (u) {
            if (!kw) return true;
            return (u.username || '').toLowerCase().indexOf(kw) !== -1 ||
                   (u.nickname || '').toLowerCase().indexOf(kw) !== -1;
        });
        accountsPage = 1;
        renderAccountsTable();
    }

    function renderAccountsTable() {
        var tbody = $('accounts-tbody');
        var pages = Math.max(1, Math.ceil(accountsFiltered.length / ACCOUNTS_PAGE_SIZE));
        if (accountsPage > pages) accountsPage = pages;
        if (!accountsFiltered.length) {
            tbody.innerHTML = '<tr><td colspan="9" class="vec-empty">' +
                (accountsAll.length ? '暂无匹配账号' : '暂无账号') + '</td></tr>';
            $('accounts-page-info').textContent = '-';
            return;
        }
        var start = (accountsPage - 1) * ACCOUNTS_PAGE_SIZE;
        var rows = accountsFiltered.slice(start, start + ACCOUNTS_PAGE_SIZE);
        var html = '';
        rows.forEach(function (u) {
            // 阶段一百三十五：状态列（正常/已封禁，已注销账号不在列表展示；封禁原因悬停提示）
            var statusCell = u.status === 1
                ? '<span class="at-badge at-st-failed" title="封禁原因：' + escAttr(u.lock_reason || '未填写') + '">已封禁</span>'
                : '<span class="points-role-normal">正常</span>';
            html += '<tr>' +
                '<td class="points-uid">' + (u.id || '-') + '</td>' +
                '<td class="points-username">' + escHtml(u.username || '') + '</td>' +
                '<td>' + escHtml(u.nickname || '') + '</td>' +
                '<td>' + (u.role === 1 ? '<span class="at-badge at-st-completed">管理员</span>' : '<span class="points-role-normal">普通用户</span>') + '</td>' +
                '<td>' + statusCell + '</td>' +
                '<td>' + escHtml(ACCOUNT_GENDER_TEXT[u.gender] || '未知') + '</td>' +
                '<td>' + escHtml(u.region || '-') + '</td>' +
                '<td class="plog-detail">' + escHtml(u.signature || '-') + '</td>' +
                '<td class="points-time">' + escHtml(u.create_time || '-') + '</td>' +
                '<td><button class="admin-btn small acc-profile-btn" data-username="' + escAttr(u.username || '') + '">编辑资料</button>' +
                ' <button class="admin-btn small acc-password-btn" data-username="' + escAttr(u.username || '') + '">重置密码</button>' +
                ' <button class="admin-btn small acc-lock-btn" data-username="' + escAttr(u.username || '') + '">' + (u.status === 1 ? '解锁' : '锁定') + '</button>' +
                ' <button class="admin-btn small acc-delete-btn" data-username="' + escAttr(u.username || '') + '">删除</button></td>' +
                '</tr>';
        });
        tbody.innerHTML = html;
        $('accounts-page-info').textContent = '第 ' + accountsPage + ' / ' + pages + ' 页（共 ' + accountsFiltered.length + ' 人）';
    }

    function findAccount(username) {
        for (var i = 0; i < accountsAll.length; i++) {
            if (accountsAll[i].username === username) return accountsAll[i];
        }
        return null;
    }

    // 编辑资料弹窗（性别下拉/签名多行文本；字段留空=清空，与服务端空串覆盖一致；校验失败弹窗保留可改后重存）
    function openAccountProfileEdit(username) {
        var u = findAccount(username);
        if (!u) { showToast('账号数据已过期，请刷新后重试'); return; }
        openEditModal('编辑资料 - ' + u.username, [
            { key: 'nickname', label: '昵称', type: 'text', placeholder: '留空则展示用户名', hint: '最长 32 字' },
            { key: 'gender', label: '性别', type: 'select', options: [
                { value: 0, label: '未知' },
                { value: 1, label: '男' },
                { value: 2, label: '女' }
            ] },
            { key: 'region', label: '地区', type: 'text', placeholder: '如：山西 太原', hint: '最长 64 字' },
            { key: 'signature', label: '个性签名', type: 'textarea', placeholder: '最长 128 字' },
            { key: 'avatar', label: '头像地址', type: 'text', placeholder: '图片 URL，留空使用首字母徽标', hint: '最长 255 字符' }
        ], {
            nickname: u.nickname || '',
            gender: u.gender || 0,
            region: u.region || '',
            signature: u.signature || '',
            avatar: u.avatar || ''
        }, function (data) {
            var body = {
                nickname: String(data.nickname || '').trim(),
                gender: Number(data.gender) || 0,
                region: String(data.region || '').trim(),
                signature: String(data.signature || '').trim(),
                avatar: String(data.avatar || '').trim()
            };
            if (body.nickname.length > 32) { showToast('昵称不能超过 32 个字'); return; }
            if (body.region.length > 64) { showToast('地区不能超过 64 个字'); return; }
            if (body.signature.length > 128) { showToast('个性签名不能超过 128 个字'); return; }
            if (body.avatar.length > 255) { showToast('头像地址不能超过 255 个字符'); return; }
            api('PUT', '/admin/api/users/' + encodeURIComponent(u.username) + '/profile', body)
                .then(function (result) {
                    if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                    closeEditModal();
                    showToast('已保存 ' + u.username + ' 的资料（在线用户实时同步）');
                    loadAccounts(); // 重拉列表刷新表格（数据以服务端为准）
                }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }

    // 重置密码弹窗：双输入一致性校验（服务端仅要求非空，与注册同口径；在线会话不受影响，下次登录生效）
    function openAccountPasswordReset(username) {
        var u = findAccount(username);
        if (!u) { showToast('账号数据已过期，请刷新后重试'); return; }
        openEditModal('重置密码 - ' + u.username, [
            { key: 'password', label: '新密码', type: 'password', placeholder: '请输入新密码' },
            { key: 'password2', label: '确认新密码', type: 'password', placeholder: '再次输入新密码', hint: '重置后用户下次登录使用新密码，当前在线会话不受影响' }
        ], {}, function (data) {
            var p1 = String(data.password || '');
            var p2 = String(data.password2 || '');
            if (!p1) { showToast('新密码不能为空'); return; }
            if (p1 !== p2) { showToast('两次输入的密码不一致'); return; }
            api('PUT', '/admin/api/users/' + encodeURIComponent(u.username) + '/password', { password: p1 })
                .then(function (result) {
                    if (!result.ok) { showToast(result.msg || '重置失败'); return; }
                    closeEditModal();
                    showToast('已重置 ' + u.username + ' 的密码');
                }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }

    // 锁定/解锁弹窗（阶段一百三十五）：锁定必填封禁原因（用户登录与在线踢出时提示）；
    // 解锁为恢复性低风险操作，直接执行；已封禁账号按钮显示"解锁"
    function openAccountLockModal(username) {
        var u = findAccount(username);
        if (!u) { showToast('账号数据已过期，请刷新后重试'); return; }
        if (u.status === 1) {
            // 解锁：恢复 normal 并清空封禁原因
            api('PUT', '/admin/api/users/' + encodeURIComponent(u.username) + '/lock', { locked: false })
                .then(function (result) {
                    if (!result.ok) { showToast(result.msg || '解锁失败'); return; }
                    showToast('已解锁 ' + u.username + '，该账号可正常登录');
                    loadAccounts();
                }).catch(function (e) { showToast(e.message || '网络异常'); });
            return;
        }
        openEditModal('锁定账号 - ' + u.username, [
            { key: 'reason', label: '封禁原因', type: 'textarea', placeholder: '将展示给该用户（登录时提示原因）', hint: '必填，最长 200 字；锁定后该账号全部在线设备立即被踢出' }
        ], {}, function (data) {
            var reason = String(data.reason || '').trim();
            if (!reason) { showToast('封禁原因不能为空'); return; }
            if (reason.length > 200) { showToast('封禁原因不能超过 200 个字'); return; }
            api('PUT', '/admin/api/users/' + encodeURIComponent(u.username) + '/lock', { locked: true, reason: reason })
                .then(function (result) {
                    if (!result.ok) { showToast(result.msg || '锁定失败'); return; }
                    closeEditModal();
                    showToast('已锁定 ' + u.username + '，其在线设备已被踢出');
                    loadAccounts();
                }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }

    // 删除（注销）弹窗（阶段一百三十五）：输入用户名确认（不可逆语义）；软删除，用户名保留防冒用
    function openAccountDeleteModal(username) {
        var u = findAccount(username);
        if (!u) { showToast('账号数据已过期，请刷新后重试'); return; }
        openEditModal('删除账号 - ' + u.username, [
            { key: 'confirm', label: '确认删除', type: 'text', placeholder: '请输入用户名 ' + u.username + ' 以确认', hint: '删除后该账号无法登录、列表不再展示（用户名保留防冒用）；该账号在线设备立即被踢出' }
        ], {}, function (data) {
            if (String(data.confirm || '').trim() !== u.username) { showToast('输入的用户名不一致，请重新输入'); return; }
            api('PUT', '/admin/api/users/' + encodeURIComponent(u.username) + '/delete', {})
                .then(function (result) {
                    if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                    closeEditModal();
                    showToast('已删除（注销）账号 ' + u.username);
                    loadAccounts();
                }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }

    // 表格内"编辑资料"/"重置密码"/"锁定"/"删除"按钮：事件委托（重渲染无需重复绑定）
    $('accounts-tbody').addEventListener('click', function (e) {
        var profileBtn = e.target.closest('.acc-profile-btn');
        if (profileBtn) { openAccountProfileEdit(profileBtn.getAttribute('data-username')); return; }
        var pwdBtn = e.target.closest('.acc-password-btn');
        if (pwdBtn) { openAccountPasswordReset(pwdBtn.getAttribute('data-username')); return; }
        // 阶段一百三十五：锁定封禁（填原因）/解锁、删除注销
        var lockBtn = e.target.closest('.acc-lock-btn');
        if (lockBtn) { openAccountLockModal(lockBtn.getAttribute('data-username')); return; }
        var delBtn = e.target.closest('.acc-delete-btn');
        if (delBtn) { openAccountDeleteModal(delBtn.getAttribute('data-username')); return; }
    });
    // 搜索实时过滤 + 刷新重拉
    $('accounts-search').addEventListener('input', applyAccountsFilter);
    $('accounts-refresh').addEventListener('click', loadAccounts);
    // 分页
    $('accounts-prev').addEventListener('click', function () {
        if (accountsPage > 1) { accountsPage--; renderAccountsTable(); }
    });
    $('accounts-next').addEventListener('click', function () {
        var pages = Math.ceil(accountsFiltered.length / ACCOUNTS_PAGE_SIZE);
        if (accountsPage < pages) { accountsPage++; renderAccountsTable(); }
    });

    // ===== 阶段八十九：MCP 服务器管理（TRAE CN 同款，服务端归口建连与调用） =====
    var mcpServers = [];
    var mcpSettingsInfo = null;
    var mcpPollTimer = null;
    var mcpToolsCtx = null;  // 工具管理弹窗上下文 { server }
    var mcpModalMode = 'tools'; // 弹窗壳复用：'tools'=工具启停（保存生效）/'log'=stderr 日志（只读）

    // 状态轮询：仅 MCP 视图激活期间运行，实时反映 connecting/connected/error 变化
    function startMCPPolling() {
        stopMCPPolling();
        mcpPollTimer = setInterval(function () { loadMCPServers(true); }, 5000);
    }
    function stopMCPPolling() {
        if (mcpPollTimer) { clearInterval(mcpPollTimer); mcpPollTimer = null; }
    }

    function loadMCPServers(quiet) {
        return api('GET', '/admin/api/mcp/servers').then(function (result) {
            if (!result.ok) {
                if (!quiet) showToast(result.msg || '加载失败');
                return;
            }
            mcpServers = (result.data && result.data.servers) || [];
            mcpSettingsInfo = (result.data && result.data.settings) || null;
            renderMCPServers();
        }).catch(function (e) {
            if (!quiet) showToast(e.message || '网络异常');
        });
    }

    var MCP_STATUS_TEXT = {
        connected: '已连接',
        connecting: '连接中',
        disconnected: '未连接',
        error: '错误'
    };

    function renderMCPServers() {
        // 全局设置提示（config.yaml 归口，只读展示）
        if (mcpSettingsInfo) {
            $('mcp-global-tip').textContent = '总开关 ' + (mcpSettingsInfo.enabled ? '开启' : '关闭') +
                ' · 用户级开关 ' + (mcpSettingsInfo.user_enabled ? '开启' : '关闭') +
                ' · 建连超时 ' + mcpSettingsInfo.connect_timeout_s + 's / 工具超时 ' + mcpSettingsInfo.tool_timeout_s + 's（config.yaml）';
        }
        var box = $('mcp-server-list');
        box.innerHTML = '';
        $('mcp-status').textContent = mcpServers.length ? ('共 ' + mcpServers.length + ' 个服务器') : '';
        if (!mcpServers.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '暂无 MCP 服务器，点击右上角新增或导入 mcp.json';
            box.appendChild(empty);
            return;
        }
        mcpServers.forEach(function (sv) {
            var card = document.createElement('div');
            card.className = 'admin-card' + (sv.enabled ? '' : ' disabled');

            var main = document.createElement('div');
            main.className = 'admin-card-main';
            var name = document.createElement('div');
            name.className = 'admin-card-name';
            var dot = document.createElement('span');
            dot.className = 'mcp-status-dot ' + (sv.status || 'disconnected');
            dot.title = MCP_STATUS_TEXT[sv.status] || sv.status;
            name.appendChild(dot);
            name.appendChild(document.createTextNode(' ' + sv.name));
            var tagT = document.createElement('span');
            tagT.className = 'admin-card-tag';
            tagT.textContent = sv.transport;
            name.appendChild(tagT);
            if (sv.auto_approve) {
                var tagAuto = document.createElement('span');
                tagAuto.className = 'admin-card-tag';
                tagAuto.textContent = '免审批';
                name.appendChild(tagAuto);
            }
            if (!sv.enabled) {
                var tagOff = document.createElement('span');
                tagOff.className = 'admin-card-tag off';
                tagOff.textContent = '已停用';
                name.appendChild(tagOff);
            }
            var desc = document.createElement('div');
            desc.className = 'admin-card-desc';
            desc.textContent = sv.transport === 'stdio'
                ? (sv.command + ' ' + (sv.args || []).join(' '))
                : (sv.url || '-');
            desc.title = desc.textContent;
            var tools = document.createElement('div');
            tools.className = 'admin-card-desc';
            tools.textContent = '工具 ' + (sv.tool_count || 0) + ' 个 · ' + (MCP_STATUS_TEXT[sv.status] || sv.status);
            main.appendChild(name);
            main.appendChild(desc);
            main.appendChild(tools);
            if (sv.status_msg && (sv.status === 'error' || sv.status === 'connecting')) {
                var msg = document.createElement('div');
                msg.className = 'mcp-status-msg';
                msg.textContent = sv.status_msg;
                main.appendChild(msg);
            }
            card.appendChild(main);

            var actions = document.createElement('div');
            actions.className = 'admin-card-actions';
            function addBtn(text, cls, fn) {
                var b = document.createElement('button');
                b.className = 'admin-btn small' + (cls ? ' ' + cls : '');
                b.textContent = text;
                b.addEventListener('click', fn);
                actions.appendChild(b);
            }
            addBtn('工具', '', function () { openMCPToolsModal(sv); });
            addBtn('编辑', '', function () { openMCPServerModal(sv); });
            if (sv.enabled) addBtn('重连', '', function () {
                api('POST', '/admin/api/mcp/servers/' + sv.id + '/reconnect').then(function (result) {
                    if (!result.ok) { showToast(result.msg || '重连失败'); return; }
                    showToast('已发起重连');
                    loadMCPServers(true);
                }).catch(function (e) { showToast(e.message || '网络异常'); });
            });
            addBtn(sv.enabled ? '停用' : '启用', '', function () {
                var payload = mcpFullPayload(sv, { enabled: !sv.enabled });
                api('PUT', '/admin/api/mcp/servers/' + sv.id, payload).then(function (result) {
                    if (!result.ok) { showToast(result.msg || '操作失败'); return; }
                    showToast(sv.enabled ? '已停用并断开连接' : '已启用并开始建连');
                    loadMCPServers(true);
                }).catch(function (e) { showToast(e.message || '网络异常'); });
            });
            if (sv.stderr_log && sv.stderr_log.length) {
                addBtn('日志', '', function () { openMCPLogModal(sv); });
            }
            addBtn('删除', 'danger', function () {
                confirmBox('确定删除 MCP 服务器「' + sv.name + '」吗？连接将立即断开。', function () {
                    api('DELETE', '/admin/api/mcp/servers/' + sv.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除并断开连接');
                        loadMCPServers(true);
                    }).catch(function (e) { showToast(e.message || '网络异常'); });
                });
            });
            card.appendChild(actions);
            box.appendChild(card);
        });
    }

    // mcpFullPayload 以列表视图缓存为基底构建完整配置（启停/工具清单保存复用，
    // 仅覆盖指定字段，避免PUT 请求丢字段导致配置被重置）
    function mcpFullPayload(sv, overrides) {
        var p = {
            name: sv.name,
            transport: sv.transport,
            command: sv.command || '',
            args: sv.args || [],
            env: sv.env || {},
            url: sv.url || '',
            headers: sv.headers || {},
            enabled: !!sv.enabled,
            auto_approve: !!sv.auto_approve,
            disabled_tools: sv.disabled_tools || []
        };
        if (overrides) {
            Object.keys(overrides).forEach(function (k) { p[k] = overrides[k]; });
        }
        return p;
    }

    // ===== 编辑/新增弹窗（复用通用动态表单 + 追加"测试连接"按钮） =====
    function mcpParseLines(t) {
        return String(t || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    }
    // kvText → 对象：每行 KEY=VALUE（env）或 KEY: VALUE（headers），首个分隔符切分
    function mcpParseKVText(t, sep) {
        var kv = {};
        mcpParseLines(t).forEach(function (line) {
            var idx = line.indexOf(sep);
            if (idx <= 0) return;
            kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        });
        return kv;
    }

    function mcpPayloadFromForm(data, base) {
        var transport = data.transport || 'stdio';
        return {
            name: (data.name || '').trim(),
            transport: transport,
            command: (data.command || '').trim(),
            args: mcpParseLines(data.args),
            env: mcpParseKVText(data.env, '='),
            url: (data.url || '').trim(),
            headers: mcpParseKVText(data.headers, ':'),
            enabled: !!data.enabled,
            auto_approve: !!data.auto_approve,
            disabled_tools: base ? (base.disabled_tools || []) : []
        };
    }

    function openMCPServerModal(sv) {
        var fields = [
            { key: 'name', label: '服务器名称（全局唯一，工具将以 mcp_名称_工具名 注入）', placeholder: '如：everything' },
            {
                key: 'transport', label: '传输类型', type: 'select',
                options: [
                    { value: 'stdio', label: 'stdio（服务端本机拉起子进程）' },
                    { value: 'sse', label: 'sse（远程 SSE 端点）' },
                    { value: 'http', label: 'http（远程 Streamable HTTP 端点）' }
                ]
            },
            { key: 'command', label: '启动命令（stdio）', placeholder: '如：npx 或 C:\bin\server.exe' },
            { key: 'args', label: '命令参数（stdio，每行一个）', type: 'textarea', placeholder: '-y\n@modelcontextprotocol/server-everything' },
            { key: 'url', label: '服务地址（sse / http）', placeholder: 'https://example.com/mcp' },
            { key: 'headers', label: '请求头（sse / http，每行一条，格式 KEY: VALUE）', type: 'textarea', placeholder: 'Authorization: Bearer sk-xxx' },
            { key: 'env', label: '环境变量（每行一条，格式 KEY=VALUE）', type: 'textarea', placeholder: 'API_KEY=xxx' },
            { key: 'enabled', label: '启用（保存即建连；总开关关闭时不建连）', type: 'checkbox', default: true },
            { key: 'auto_approve', label: '免审批（勾选后该服务器工具调用不再逐次人工确认，请谨慎）', type: 'checkbox' }
        ];
        var values = {};
        if (sv) {
            values = {
                name: sv.name,
                transport: sv.transport || 'stdio',
                command: sv.command || '',
                args: (sv.args || []).join('\n'),
                url: sv.url || '',
                headers: Object.keys(sv.headers || {}).map(function (k) { return k + ': ' + sv.headers[k]; }).join('\n'),
                env: Object.keys(sv.env || {}).map(function (k) { return k + '=' + sv.env[k]; }).join('\n'),
                enabled: sv.enabled,
                auto_approve: sv.auto_approve
            };
        }
        openEditModal(sv ? '编辑 MCP 服务器' : '新增 MCP 服务器', fields, values, function (data) {
            var payload = mcpPayloadFromForm(data, sv);
            if (!payload.name) { showToast('服务器名称不能为空'); return; }
            if (payload.transport === 'stdio' && !payload.command) { showToast('stdio 传输必须填写启动命令'); return; }
            if (payload.transport !== 'stdio' && !payload.url) { showToast('sse / http 传输必须填写服务地址'); return; }
            var req = sv
                ? api('PUT', '/admin/api/mcp/servers/' + sv.id, payload)
                : api('POST', '/admin/api/mcp/servers', payload);
            req.then(function (result) {
                if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                closeEditModal();
                showToast(sv ? '已保存，配置变更自动重建连接' : '已新增，正在建连');
                loadMCPServers(true);
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
        // 追加"测试连接"按钮与结果区（保存前验证，TRAE 同款；stdio 会真实拉起子进程用完即收）
        var form = $('admin-edit-form');
        // 阶段九十：生产可用模板一键填充（官方维护实例，与 config.yaml 生产示例同源；
        // 仅新增时展示——编辑态一键覆盖会误伤既有配置）
        if (!sv) {
            var mcpTemplates = [
                { label: '文件系统 filesystem', name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/workspace'], env: {}, hint: '官方文件读写；末尾目录为允许访问的根，务必改成实际业务目录' },
                { label: '网页抓取 fetch', name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], env: {}, hint: '官方网页抓取，网页转 Markdown 供模型阅读（需本机 uv）' },
                { label: '长期记忆 memory', name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: './data/memory.json' }, hint: '官方知识图谱记忆，落点建议改到数据目录' },
                { label: 'GitHub', name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxx' }, hint: '官方仓库/Issue/PR 操作；令牌需替换为个人访问令牌' }
            ];
            var tplWrap = document.createElement('div');
            tplWrap.className = 'admin-field';
            var tplLabel = document.createElement('label');
            tplLabel.textContent = '生产模板（点击一键填充，填后按提示改参数）';
            tplWrap.appendChild(tplLabel);
            var tplRow = document.createElement('div');
            tplRow.className = 'admin-mcp-tpl-row';
            mcpTemplates.forEach(function (tpl) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'admin-btn small';
                b.title = tpl.hint;
                b.textContent = tpl.label;
                b.addEventListener('click', function () {
                    var setv = function (key, v) { var el = $('af_' + key); if (el) el.value = v; };
                    setv('name', tpl.name);
                    setv('transport', 'stdio');
                    setv('command', tpl.command);
                    setv('args', tpl.args.join('\n'));
                    setv('url', '');
                    setv('headers', '');
                    setv('env', Object.keys(tpl.env || {}).map(function (k) { return k + '=' + tpl.env[k]; }).join('\n'));
                    var en = $('af_enabled'); if (en) en.checked = true;
                    showToast('模板已填充：' + tpl.hint);
                });
                tplRow.appendChild(b);
            });
            tplWrap.appendChild(tplRow);
            form.appendChild(tplWrap);
        }
        var wrap = document.createElement('div');
        wrap.className = 'admin-field';
        var testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'admin-btn small';
        testBtn.textContent = '测试连接';
        var out = document.createElement('div');
        out.className = 'admin-field-hint';
        testBtn.addEventListener('click', function () {
            var payload = mcpPayloadFromForm(collectEditForm(), sv);
            if (!payload.name) { out.textContent = '请先填写服务器名称'; return; }
            if (payload.transport === 'stdio' && !payload.command) { out.textContent = 'stdio 传输必须填写启动命令'; return; }
            if (payload.transport !== 'stdio' && !payload.url) { out.textContent = 'sse / http 传输必须填写服务地址'; return; }
            testBtn.disabled = true;
            out.textContent = '连接中…（stdio 将临时拉起子进程）';
            api('POST', '/admin/api/mcp/test', payload).then(function (result) {
                testBtn.disabled = false;
                if (!result.ok) { out.textContent = result.msg || '连接失败'; return; }
                var d = result.data || {};
                out.textContent = '连接成功：' + (d.server_name || '未知服务') +
                    (d.server_version ? ' v' + d.server_version : '') +
                    '，协议 ' + (d.protocol_version || '-') +
                    '，发现 ' + (d.tool_count || 0) + ' 个工具，耗时 ' + (d.elapsed_ms || 0) + 'ms';
            }).catch(function (e) {
                testBtn.disabled = false;
                out.textContent = e.message || '网络异常';
            });
        });
        wrap.appendChild(testBtn);
        wrap.appendChild(out);
        form.appendChild(wrap);
    }
    $('mcp-add').addEventListener('click', function () { openMCPServerModal(null); });
    $('mcp-refresh').addEventListener('click', function () { loadMCPServers(); });

    // ===== 阶段一百二十一：工具链市场 CRUD（与 MCP 插件库同构；无 command/args/env，核心是 zip + SHA256 + 安装目录） =====
    var toolchains = [];

    function loadToolchains() {
        return api('GET', '/admin/api/toolchains').then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载失败'); return; }
            toolchains = (result.data && result.data.toolchains) || [];
            renderToolchains();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    function renderToolchains() {
        var box = $('toolchains-list');
        box.innerHTML = '';
        $('toolchains-status').textContent = toolchains.length ? ('共 ' + toolchains.length + ' 个工具链') : '';
        if (!toolchains.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '工具链清单为空，点击右上角新增（首次访问服务端会自动播种内置 gcc 工具链）';
            box.appendChild(empty);
            return;
        }
        toolchains.forEach(function (tc) {
            var card = document.createElement('div');
            card.className = 'admin-card' + (tc.enabled ? '' : ' disabled');
            var main = document.createElement('div');
            main.className = 'admin-card-main';
            var name = document.createElement('div');
            name.className = 'admin-card-name';
            if (tc.icon) {
                var ico = document.createElement('img');
                ico.src = tc.icon;
                ico.className = 'admin-plugin-icon';
                ico.alt = '';
                ico.addEventListener('error', function () { ico.remove(); });
                name.appendChild(ico);
            }
            name.appendChild(document.createTextNode(tc.title || tc.name));
            var tagN = document.createElement('span');
            tagN.className = 'admin-card-tag';
            tagN.textContent = tc.name;
            name.appendChild(tagN);
            if (tc.version) {
                var tagV = document.createElement('span');
                tagV.className = 'admin-card-tag';
                tagV.textContent = 'v' + tc.version;
                name.appendChild(tagV);
            }
            if (tc.category) {
                var tagC = document.createElement('span');
                tagC.className = 'admin-card-tag';
                tagC.textContent = tc.category;
                name.appendChild(tagC);
            }
            if (tc.size_mb) {
                var tagS = document.createElement('span');
                tagS.className = 'admin-card-tag';
                tagS.textContent = '≈' + tc.size_mb + 'MB';
                name.appendChild(tagS);
            }
            if (!tc.enabled) {
                var tagOff = document.createElement('span');
                tagOff.className = 'admin-card-tag off';
                tagOff.textContent = '已下架';
                name.appendChild(tagOff);
            }
            var desc = document.createElement('div');
            desc.className = 'admin-card-desc';
            desc.textContent = tc.description || '-';
            desc.title = desc.textContent;
            var meta = document.createElement('div');
            meta.className = 'admin-card-desc';
            // 阶段一百二十一：系统优先条目（无 zip/安装脚本，如 clang）如实标注，不显示 static/<名>.zip 兜底地址（必然 404）
            meta.textContent = '安装目录 ~/.im-mcp/' + (tc.install_dir || tc.name) + ' · '
                + (tc.zip_url || tc.installer_script ? (tc.zip_url || ('static/' + tc.name + '.zip')) : '系统组件（无安装包，用系统已装版本）')
                + (tc.sha256 ? ' · SHA256' : '');
            meta.title = meta.textContent;
            main.appendChild(name);
            main.appendChild(desc);
            main.appendChild(meta);
            card.appendChild(main);
            var ops = document.createElement('div');
            ops.className = 'admin-card-ops';
            var btnEdit = document.createElement('button');
            btnEdit.className = 'admin-btn small';
            btnEdit.textContent = '编 辑';
            btnEdit.addEventListener('click', function () { openToolchainModal(tc); });
            var btnDel = document.createElement('button');
            btnDel.className = 'admin-btn small danger';
            btnDel.textContent = '删 除';
            btnDel.addEventListener('click', function () {
                confirmBox('确认删除工具链「' + (tc.title || tc.name) + '」？仅删清单条目，不影响用户本机已安装目录。', function () {
                    api('DELETE', '/admin/api/toolchains/' + tc.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除');
                        loadToolchains();
                    }).catch(function (e) { showToast(e.message || '网络异常'); });
                });
            });
            ops.appendChild(btnEdit);
            ops.appendChild(btnDel);
            card.appendChild(ops);
            box.appendChild(card);
        });
    }

    function openToolchainModal(tc) {
        openEditModal(tc ? '编辑工具链' : '新增工具链', [
            { key: 'name', label: '工具链名（唯一，安装目录 ~/.im-mcp/<名>，仅限字母数字下划线连字符）', type: 'text', placeholder: 'gcc' },
            { key: 'title', label: '展示标题', type: 'text', placeholder: 'C/C++ 编译工具链' },
            { key: 'category', label: '分类页签', type: 'text', placeholder: '编译工具链' },
            { key: 'version', label: '版本号', type: 'text', placeholder: '16.2.0' },
            { key: 'description', label: '描述', type: 'textarea', placeholder: '为 Agent 提供 C/C++ 编译能力（gcc/g++/make/gdb/ccache…）' },
            { key: 'zip_url', label: 'Zip 下载地址（相对路径拼服务端 base，或完整 http/https 外置 CDN；留空默认 static/<名>.zip）', type: 'text', placeholder: 'static/gcc-toolchain.zip' },
            { key: 'sha256', label: 'SHA256（64 位十六进制，留空不校验不推荐）', type: 'text', placeholder: '24D791013B375E02D7B4725BC2566AB91ED0F877570CB69BC2F57F847BBD271A' },
            { key: 'size_mb', label: '下载体积（MB，卡片体积感知提示）', type: 'number', default: 0 },
            { key: 'install_dir', label: '安装目录（相对 ~/.im-mcp，留空默认取工具链名）', type: 'text', placeholder: 'gcc' },
            { key: 'sub_commands', label: '子命令路由/引导器声明（JSON：值为安装引导标记，如 {"rustc":"rustup"} 表示走 rustup 安装器；注意：声明仅作元数据，客户端无执行期命令重写）', type: 'text', placeholder: '{"rustc":"rustup"}' },
            { key: 'installer_script', label: '自定义安装脚本（JS async function(ctx)，留空走默认 zip 解压；非 zip 安装如 rustup-init 用脚本解耦）', type: 'textarea', placeholder: 'module.exports = async function(ctx) { await ctx.download(ctx.url, ...); await ctx.spawn(...); return {ok:true}; }' },
            { key: 'exe_paths', label: 'ExePaths 可执行文件声明（JSON 数组，相对安装目录；支持 "~/" 前缀如 rust 的 ~/.cargo/bin；留空回退客户端默认探测）', type: 'text', placeholder: '["bin/go.exe","bin/gofmt.exe"]' },
            { key: 'icon', label: '图标链接（http/https 图片 URL，留空显示首字母徽标）', type: 'text', placeholder: 'https://example.com/logo.png' },
            { key: 'sort', label: '排序（小在前）', type: 'number', default: 0 },
            { key: 'enabled', label: '上架（下架后用户端不再展示）', type: 'checkbox', default: true }
        ], tc || {}, function (data) {
            var payload = {
                name: String(data.name || '').trim(),
                title: String(data.title || '').trim(),
                description: String(data.description || ''),
                category: String(data.category || '').trim(),
                version: String(data.version || '').trim(),
                zip_url: String(data.zip_url || '').trim(),
                sha256: String(data.sha256 || '').trim(),
                size_mb: parseInt(data.size_mb, 10) || 0,
                install_dir: String(data.install_dir || '').trim(),
                sub_commands: String(data.sub_commands || '').trim(),
                installer_script: String(data.installer_script || ''),
                exe_paths: String(data.exe_paths || '').trim(),
                icon: String(data.icon || '').trim(),
                sort: parseInt(data.sort, 10) || 0,
                enabled: !!data.enabled
            };
            var req = tc ? api('PUT', '/admin/api/toolchains/' + tc.id, payload)
                : api('POST', '/admin/api/toolchains', payload);
            req.then(function (result) {
                if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                closeEditModal();
                showToast('已保存');
                loadToolchains();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }
    $('toolchains-add').addEventListener('click', function () { openToolchainModal(null); });

    // ===== 阶段一百一十三：MCP 插件库管理（阶段一百一十三：插件市场清单 CRUD，PC 端设置页"插件市场"数据源） =====
    var mcpPlugins = [];

    function loadMCPPlugins() {
        return api('GET', '/admin/api/mcp/plugins').then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载失败'); return; }
            mcpPlugins = (result.data && result.data.plugins) || [];
            renderMCPPlugins();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    function renderMCPPlugins() {
        var box = $('mcpplugins-list');
        box.innerHTML = '';
        $('mcpplugins-status').textContent = mcpPlugins.length ? ('共 ' + mcpPlugins.length + ' 个插件') : '';
        if (!mcpPlugins.length) {
            var empty = document.createElement('div');
            empty.className = 'admin-card-empty';
            empty.textContent = '插件清单为空，点击右上角新增（首次访问服务端会自动播种 8 个内置默认插件）';
            box.appendChild(empty);
            return;
        }
        mcpPlugins.forEach(function (p) {
            var card = document.createElement('div');
            card.className = 'admin-card' + (p.enabled ? '' : ' disabled');

            var main = document.createElement('div');
            main.className = 'admin-card-main';
            var name = document.createElement('div');
            name.className = 'admin-card-name';
            // 图标链接（阶段一百一十三增补）：有则显示小图标，加载失败自动隐藏降级文字标题
            if (p.icon) {
                var ico = document.createElement('img');
                ico.src = p.icon;
                ico.className = 'admin-plugin-icon';
                ico.alt = '';
                ico.addEventListener('error', function () { ico.remove(); });
                name.appendChild(ico);
            }
            name.appendChild(document.createTextNode(p.title || p.name));
            var tagN = document.createElement('span');
            tagN.className = 'admin-card-tag';
            tagN.textContent = p.name;
            name.appendChild(tagN);
            if (p.category) {
                var tagC = document.createElement('span');
                tagC.className = 'admin-card-tag';
                tagC.textContent = p.category;
                name.appendChild(tagC);
            }
            if (p.needs_config) {
                var tagCf = document.createElement('span');
                tagCf.className = 'admin-card-tag';
                tagCf.textContent = '需配置';
                name.appendChild(tagCf);
            }
            if (!p.enabled) {
                var tagOff = document.createElement('span');
                tagOff.className = 'admin-card-tag off';
                tagOff.textContent = '已下架';
                name.appendChild(tagOff);
            }
            var desc = document.createElement('div');
            desc.className = 'admin-card-desc';
            desc.textContent = p.description || '-';
            desc.title = desc.textContent;
            var cmd = document.createElement('div');
            cmd.className = 'admin-card-desc';
            cmd.textContent = p.command + ' ' + String(p.args || '').split('\n').filter(function (s) { return s.trim(); }).join(' ');
            cmd.title = cmd.textContent;
            main.appendChild(name);
            main.appendChild(desc);
            main.appendChild(cmd);
            card.appendChild(main);

            var actions = document.createElement('div');
            actions.className = 'admin-card-actions';
            function addBtn(text, cls, fn) {
                var b = document.createElement('button');
                b.className = 'admin-btn small' + (cls ? ' ' + cls : '');
                b.textContent = text;
                b.addEventListener('click', fn);
                actions.appendChild(b);
            }
            addBtn('编辑', '', function () { openMCPPluginModal(p); });
            addBtn('删除', 'danger', function () {
                confirmBox('确定删除插件「' + (p.title || p.name) + '」？仅删除市场清单，不影响用户已安装的本机配置。', function () {
                    api('DELETE', '/admin/api/mcp/plugins/' + p.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除');
                        loadMCPPlugins();
                    }).catch(function (e) { showToast(e.message || '网络异常'); });
                });
            });
            card.appendChild(actions);
            box.appendChild(card);
        });
    }

    // 插件编辑弹窗（复用通用编辑弹窗；Args/Env 为多行文本，与 PC 端表单格式一致）
    function openMCPPluginModal(p) {
        openEditModal(p ? '编辑插件 - ' + p.name : '新增插件', [
            { key: 'name', label: '插件名（唯一，安装时作为本机服务器名）', type: 'text', placeholder: '如 mysql' },
            { key: 'title', label: '展示标题', type: 'text', placeholder: '如 MySQL 数据库查询' },
            { key: 'category', label: '分类页签', type: 'text', placeholder: '如 数据库 / 网络 / 文件系统 / 工具' },
            { key: 'description', label: '描述', type: 'textarea', placeholder: '插件功能说明（建议注明 Node 系 / Python 系及安装注意）' },
            { key: 'command', label: '启动命令', type: 'text', placeholder: 'npx / uvx / node / python' },
            { key: 'args', label: '命令参数（每行一个）', type: 'textarea', placeholder: '-y\n@benborla29/mcp-server-mysql' },
            { key: 'env', label: '环境变量模板（每行 KEY=VALUE，占位值由用户安装时补填）', type: 'textarea', placeholder: 'MYSQL_HOST=127.0.0.1\nMYSQL_PASS=你的密码' },
            { key: 'needs_config', label: '含占位参数（用户安装时打开表单补填）', type: 'checkbox' },
            { key: 'icon', label: '图标链接（http/https 图片 URL，留空显示首字母徽标）', type: 'text', placeholder: 'https://example.com/logo.png' },
            { key: 'sort', label: '排序（小在前）', type: 'number', default: 0 },
            { key: 'enabled', label: '上架（下架后用户端不再展示）', type: 'checkbox', default: true }
        ], p || {}, function (data) {
            var payload = {
                name: String(data.name || '').trim(),
                title: String(data.title || '').trim(),
                description: String(data.description || ''),
                category: String(data.category || '').trim(),
                command: String(data.command || '').trim(),
                args: String(data.args || ''),
                env: String(data.env || ''),
                needs_config: !!data.needs_config,
                icon: String(data.icon || '').trim(),
                sort: parseInt(data.sort, 10) || 0,
                enabled: !!data.enabled
            };
            var req = p ? api('PUT', '/admin/api/mcp/plugins/' + p.id, payload)
                : api('POST', '/admin/api/mcp/plugins', payload);
            req.then(function (result) {
                if (!result.ok) { showToast(result.msg || '保存失败'); return; }
                closeEditModal();
                showToast('已保存');
                loadMCPPlugins();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        });
    }
    $('mcpplugins-add').addEventListener('click', function () { openMCPPluginModal(null); });

    // ===== 工具启停弹窗（per-tool 开关，保存走 PUT 完整配置） =====
    function openMCPToolsModal(sv) {
        mcpModalMode = 'tools';
        mcpToolsCtx = { server: sv };
        $('mcp-tools-title').textContent = '工具管理 - ' + sv.name;
        var list = $('mcp-tools-list');
        list.innerHTML = '';
        var disabled = {};
        (sv.disabled_tools || []).forEach(function (n) { disabled[n] = true; });
        if (!sv.tools || !sv.tools.length) {
            var tip = document.createElement('div');
            tip.className = 'admin-card-empty';
            tip.textContent = '未发现工具（服务器可能未连接或未提供工具）';
            list.appendChild(tip);
        } else {
            sv.tools.forEach(function (t) {
                var item = document.createElement('label');
                item.className = 'admin-mcp-tool-item';
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !disabled[t.name];
                cb.setAttribute('data-tool', t.name);
                var txt = document.createElement('div');
                var nm = document.createElement('div');
                nm.className = 'admin-mcp-tool-name';
                nm.textContent = t.name;
                var de = document.createElement('div');
                de.className = 'admin-mcp-tool-desc';
                de.textContent = t.description || '（无描述）';
                de.title = t.description || '';
                txt.appendChild(nm);
                txt.appendChild(de);
                item.appendChild(cb);
                item.appendChild(txt);
                list.appendChild(item);
            });
        }
        $('mcp-tools-ok').textContent = '保 存';
        $('mcp-tools-mask').classList.remove('hidden');
    }

    function openMCPLogModal(sv) {
        mcpModalMode = 'log';
        mcpToolsCtx = null;
        $('mcp-tools-title').textContent = 'stderr 日志 - ' + sv.name;
        var list = $('mcp-tools-list');
        list.innerHTML = '';
        (sv.stderr_log || []).forEach(function (line) {
            var item = document.createElement('div');
            item.className = 'admin-mcp-tool-desc';
            item.style.maxHeight = 'none';
            item.textContent = line;
            list.appendChild(item);
        });
        if (!list.children.length) {
            var tip = document.createElement('div');
            tip.className = 'admin-card-empty';
            tip.textContent = '暂无日志';
            list.appendChild(tip);
        }
        $('mcp-tools-ok').textContent = '关 闭';
        $('mcp-tools-mask').classList.remove('hidden');
    }

    $('mcp-tools-cancel').addEventListener('click', function () {
        $('mcp-tools-mask').classList.add('hidden');
        mcpToolsCtx = null;
    });
    $('mcp-tools-ok').addEventListener('click', function () {
        if (mcpModalMode === 'log') { // 日志只读，按钮即关闭
            $('mcp-tools-mask').classList.add('hidden');
            return;
        }
        if (!mcpToolsCtx) return;
        var disabled = [];
        $('mcp-tools-list').querySelectorAll('input[type=checkbox][data-tool]').forEach(function (cb) {
            if (!cb.checked) disabled.push(cb.getAttribute('data-tool'));
        });
        var payload = mcpFullPayload(mcpToolsCtx.server, { disabled_tools: disabled });
        api('PUT', '/admin/api/mcp/servers/' + mcpToolsCtx.server.id, payload).then(function (result) {
            if (!result.ok) { showToast(result.msg || '保存失败'); return; }
            $('mcp-tools-mask').classList.add('hidden');
            mcpToolsCtx = null;
            showToast('工具启停已保存并热生效');
            loadMCPServers(true);
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    });

    // ===== mcp.json 导入（兼容 TRAE / Claude / Cursor 格式） =====
    $('mcp-import').addEventListener('click', function () {
        $('mcp-import-text').value = '';
        $('mcp-import-mask').classList.remove('hidden');
        $('mcp-import-text').focus();
    });
    $('mcp-import-cancel').addEventListener('click', function () {
        $('mcp-import-mask').classList.add('hidden');
    });
    $('mcp-import-ok').addEventListener('click', function () {
        var text = $('mcp-import-text').value.trim();
        if (!text) { showToast('请先粘贴 mcp.json 内容'); return; }
        var obj;
        try { obj = JSON.parse(text); } catch (e) { showToast('JSON 解析失败：' + e.message); return; }
        if (obj && obj.mcpServers && typeof obj.mcpServers === 'object') obj = obj.mcpServers;
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { showToast('格式不正确：应为 {"mcpServers": {...}} 或服务器对象'); return; }
        var names = Object.keys(obj).filter(function (k) {
            return obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]);
        });
        if (!names.length) { showToast('未找到可导入的服务器配置'); return; }
        var okCount = 0, failMsgs = [];
        function next(i) {
            if (i >= names.length) {
                $('mcp-import-mask').classList.add('hidden');
                if (okCount) showToast('导入完成：成功 ' + okCount + ' 个' + (failMsgs.length ? '，失败 ' + failMsgs.length + ' 个' : ''));
                else showToast(failMsgs[0] || '导入失败');
                loadMCPServers(true);
                return;
            }
            var name = names[i], e = obj[name];
            var transport = String(e.type || e.transport || '').toLowerCase();
            if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
                transport = e.command ? 'stdio' : 'http';
            }
            var args = e.args || [];
            if (!Array.isArray(args)) args = String(args).split(/\s+/).filter(Boolean);
            var env = e.env || {};
            if (Array.isArray(env)) { // Claude 变体：["K=V", ...]
                var kv = {};
                env.forEach(function (s) { var j = String(s).indexOf('='); if (j > 0) kv[String(s).slice(0, j)] = String(s).slice(j + 1); });
                env = kv;
            }
            var payload = {
                name: name,
                transport: transport,
                command: String(e.command || ''),
                args: args.map(String),
                env: env,
                url: String(e.url || ''),
                headers: e.headers || {},
                enabled: true,
                auto_approve: false,
                disabled_tools: []
            };
            api('POST', '/admin/api/mcp/servers', payload).then(function (result) {
                if (result.ok) okCount++;
                else failMsgs.push(name + '：' + (result.msg || '导入失败'));
                next(i + 1);
            }).catch(function () {
                failMsgs.push(name + '：网络异常');
                next(i + 1);
            });
        }
        next(0);
    });

    // ===== 阶段一百四十四：公告管理（公司公告/动态/红头文件发布归口） =====
    var annPage = 1;
    var annTotal = 0;
    var annEditingId = 0;              // 0=新建，>0=编辑中的公告 ID
    var annAttachItems = [];           // 编辑中的附件列表 [{name,url,size}]

    var ANN_STATUS_TEXT = { 0: '草稿', 1: '已发布', 2: '已撤回' };
    var ANN_CAT_TEXT = { notice: '公告', news: '动态', red: '红头文件' };

    // 文件大小格式化（列表/附件条共用）
    function annFormatSize(n) {
        if (!n || n < 1024) return (n || 0) + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    // ===== 列表 =====
    function annLoadList() {
        $('ann-status').textContent = '加载中…';
        var qs = '?page=' + annPage + '&size=20';
        var category = $('ann-filter-category').value;
        var status = $('ann-filter-status').value;
        var kw = $('ann-search').value.trim();
        if (category) qs += '&category=' + category;
        if (status !== '') qs += '&status=' + status;
        if (kw) qs += '&keyword=' + encodeURIComponent(kw);
        api('GET', '/admin/api/announcements' + qs).then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载失败'); $('ann-status').textContent = '加载失败'; return; }
            annTotal = result.data.total || 0;
            $('ann-status').textContent = '共 ' + annTotal + ' 条';
            $('ann-page-info').textContent = '第 ' + annPage + ' 页 / 共 ' + Math.max(1, Math.ceil(annTotal / 20)) + ' 页';
            annRenderList(result.data.list || []);
        }).catch(function (e) { $('ann-status').textContent = '加载失败'; showToast(e.message || '网络异常'); });
    }

    function annRenderList(list) {
        var tbody = $('ann-tbody');
        tbody.innerHTML = '';
        if (!list.length) {
            var tr = document.createElement('tr');
            var td = document.createElement('td');
            td.colSpan = 10;
            td.className = 'vec-empty';
            td.textContent = '暂无公告';
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }
        list.forEach(function (a) {
            var tr = document.createElement('tr');
            // ID
            var tdId = document.createElement('td'); tdId.textContent = a.id; tr.appendChild(tdId);
            // 标题（置顶加标记）
            var tdTitle = document.createElement('td');
            tdTitle.textContent = (a.stick ? '[置顶] ' : '') + a.title;
            tdTitle.title = a.digest || a.title;
            tdTitle.style.maxWidth = '260px';
            tdTitle.style.overflow = 'hidden';
            tdTitle.style.textOverflow = 'ellipsis';
            tdTitle.style.whiteSpace = 'nowrap';
            tr.appendChild(tdTitle);
            // 分类
            var tdCat = document.createElement('td');
            var cat = document.createElement('span');
            cat.className = 'ann-cat-tag ann-cat-' + a.category;
            cat.textContent = ANN_CAT_TEXT[a.category] || a.category;
            tdCat.appendChild(cat);
            tr.appendChild(tdCat);
            // 状态
            var tdSt = document.createElement('td');
            var st = document.createElement('span');
            st.className = 'ann-status-dot ann-status-' + (a.status === 1 ? 'published' : a.status === 0 ? 'draft' : 'withdrawn');
            st.textContent = ANN_STATUS_TEXT[a.status] || a.status;
            tdSt.appendChild(st);
            tr.appendChild(tdSt);
            // 附件/已读/签收
            var tdAtt = document.createElement('td'); tdAtt.textContent = a.attach_count || 0; tr.appendChild(tdAtt);
            var tdRead = document.createElement('td'); tdRead.textContent = a.read_count || 0; tr.appendChild(tdRead);
            var tdConf = document.createElement('td'); tdConf.textContent = a.require_confirm ? (a.confirm_count || 0) : '—'; tr.appendChild(tdConf);
            // 发布人/时间
            var tdPub = document.createElement('td'); tdPub.textContent = a.publisher || '—'; tr.appendChild(tdPub);
            var tdTime = document.createElement('td');
            tdTime.textContent = a.publish_time && a.publish_time.indexOf && a.publish_time.indexOf('0001-') !== 0
                ? String(a.publish_time).replace('T', ' ').slice(0, 16) : '—';
            tr.appendChild(tdTime);
            // 操作
            var tdOp = document.createElement('td');
            function opBtn(text, cls, fn) {
                var b = document.createElement('button');
                b.className = 'admin-btn small' + (cls ? ' ' + cls : '');
                b.textContent = text;
                b.addEventListener('click', fn);
                return b;
            }
            tdOp.appendChild(opBtn('编辑', '', function () { annOpenEditor(a.id); }));
            if (a.status !== 1) {
                tdOp.appendChild(opBtn('发布', 'primary', function () {
                    api('POST', '/admin/api/announcements/' + a.id + '/publish').then(function (result) {
                        if (!result.ok) { showToast(result.msg || '发布失败'); return; }
                        showToast('已发布，在线用户已收到提醒');
                        annLoadList();
                    });
                }));
            }
            if (a.status === 1) {
                tdOp.appendChild(opBtn('撤回', '', function () {
                    confirmBox('撤回后用户端立即不可见，确定撤回「' + a.title + '」？', function () {
                        api('POST', '/admin/api/announcements/' + a.id + '/withdraw').then(function (result) {
                            if (!result.ok) { showToast(result.msg || '撤回失败'); return; }
                            showToast('已撤回');
                            annLoadList();
                        });
                    });
                }));
            }
            tdOp.appendChild(opBtn('已读名单', '', function () { annOpenReads(a.id, a.title); }));
            tdOp.appendChild(opBtn('删除', '', function () {
                confirmBox('删除后数据不可恢复（含已读记录），确定删除「' + a.title + '」？', function () {
                    api('DELETE', '/admin/api/announcements/' + a.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除');
                        annLoadList();
                    });
                });
            }));
            tr.appendChild(tdOp);
            tbody.appendChild(tr);
        });
    }

    // ===== 编辑弹窗 =====
    // 阶段一百四十四三期：正文类型（html/doc/link）/卡牌样式/封面上传/链接设置联动
    function annOpenEditor(id) {
        annEditingId = id || 0;
        annAttachItems = [];
        $('ann-modal-title').textContent = id ? '编辑公告' : '新建公告';
        $('ann-title').value = '';
        $('ann-category').value = 'notice';
        $('ann-digest').value = '';
        $('ann-stick').checked = false;
        $('ann-confirm').checked = false;
        $('ann-cover').value = '';
        $('ann-cover-preview').classList.add('hidden');
        $('ann-content-type').value = 'html';
        $('ann-card-style').value = 'standard';
        $('ann-external-url').value = '';
        $('ann-open-browser').checked = true;
        var editor = $('ann-editor');
        editor.innerHTML = '';
        editor.setAttribute('data-placeholder', '输入正文…支持加粗/标题/引用/列表，可插入图片');
        $('ann-html-source').value = '';
        annSyncHtmlToggle(false); // 每次打开回到可视编辑态
        annApplyTypeUI();
        annRenderAttachList();
        $('ann-modal-mask').classList.remove('hidden');
        if (id) {
            // 编辑回填：正文与附件从详情接口取（列表不携带正文，避免分页载荷过大）
            api('GET', '/admin/api/announcements/' + id).then(function (result) {
                if (!result.ok) { showToast(result.msg || '加载失败'); return; }
                var a = result.data.announcement || {};
                $('ann-title').value = a.title || '';
                $('ann-category').value = a.category || 'notice';
                $('ann-digest').value = a.digest || '';
                $('ann-stick').checked = !!a.stick;
                $('ann-confirm').checked = !!a.require_confirm;
                $('ann-cover').value = a.cover || '';
                annRenderCoverPreview(a.cover || '');
                $('ann-content-type').value = a.content_type || 'html';
                $('ann-card-style').value = a.card_style || 'standard';
                $('ann-external-url').value = a.external_url || '';
                $('ann-open-browser').checked = a.open_in_browser !== false;
                $('ann-editor').innerHTML = a.content_html || '';
                annApplyTypeUI();
                annAttachItems = (result.data.attachments || []).map(function (t) {
                    return { name: t.name, url: t.url, size: t.size };
                });
                annRenderAttachList();
            }).catch(function (e) { showToast(e.message || '网络异常'); });
        }
    }

    // 封面预览归口（URL 变化统一走这里；空值隐藏）
    function annRenderCoverPreview(url) {
        var img = $('ann-cover-preview');
        if (url) {
            img.src = url;
            img.classList.remove('hidden');
        } else {
            img.removeAttribute('src');
            img.classList.add('hidden');
        }
    }

    // 正文类型联动：html=富文本编辑器 / doc=文档型（以附件为主，正文可空）/ link=链接地址+打开方式
    function annApplyTypeUI() {
        var t = $('ann-content-type').value;
        var isLink = t === 'link';
        var isHtml = t === 'html';
        $('ann-link-row').classList.toggle('hidden', !isLink);
        // html 型下编辑区显隐还受源码模式影响（annHtmlMode=true 时 editor 隐藏、textarea 显示），避免两者同时可见
        $('ann-editor').classList.toggle('hidden', !isHtml || annHtmlMode);
        document.querySelector('.ann-modal-box .ann-toolbar').classList.toggle('hidden', !isHtml);
        $('ann-html-source').classList.toggle('hidden', !isHtml || !annHtmlMode);
        var editor = $('ann-editor');
        editor.setAttribute('data-placeholder', isHtml
            ? '输入正文…支持加粗/标题/引用/列表，可插入图片'
            : (isLink ? '' : '文档型公告以附件为主，正文可留空'));
    }

    // 源码/可视模式切换归口（双向同步：可视→源码取 innerHTML；源码→可视回填 innerHTML）
    var annHtmlMode = false;
    function annSyncHtmlToggle(on) {
        annHtmlMode = !!on;
        var editor = $('ann-editor');
        var src = $('ann-html-source');
        if (annHtmlMode) {
            src.value = editor.innerHTML;
            editor.classList.add('hidden');
            src.classList.remove('hidden');
        } else {
            editor.innerHTML = src.value;
            src.classList.add('hidden');
            editor.classList.remove('hidden');
        }
        $('ann-html-toggle').classList.toggle('on', annHtmlMode);
        // 非富文本类型时工具条/编辑区整体由 annApplyTypeUI 控制显隐，这里仅在 html 型下生效
        if ($('ann-content-type').value === 'html') {
            src.classList.toggle('hidden', !annHtmlMode);
            editor.classList.toggle('hidden', annHtmlMode);
        }
    }

    function annRenderAttachList() {
        var ul = $('ann-attach-list');
        ul.innerHTML = '';
        annAttachItems.forEach(function (at, idx) {
            var li = document.createElement('li');
            li.className = 'ann-attach-item';
            var name = document.createElement('span');
            name.className = 'ann-attach-name';
            name.textContent = at.name;
            name.title = at.name;
            var size = document.createElement('span');
            size.className = 'ann-attach-size';
            size.textContent = annFormatSize(at.size);
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'ann-attach-del';
            del.textContent = '移除';
            del.addEventListener('click', function () {
                annAttachItems.splice(idx, 1);
                annRenderAttachList();
            });
            li.appendChild(name);
            li.appendChild(size);
            li.appendChild(del);
            ul.appendChild(li);
        });
    }

    // 附件上传（FormData 走管理端专用端点；逐个串行防竞态）
    function annUploadFile(file) {
        var fd = new FormData();
        fd.append('file', file);
        return fetch('/admin/api/announcement/attach', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + getToken() },
            body: fd
        }).then(function (resp) {
            return resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; });
        });
    }

    // 保存归口（publish=true 表示"保存并发布"；编辑态发布走幂等 publish 端点触发实时推送）
    // 阶段一百四十四三期：提交前从当前编辑态取正文（源码模式取 textarea），link 型服务端校验 http(s)
    function annSave(publish) {
        var title = $('ann-title').value.trim();
        if (!title) { showToast('请填写标题'); return; }
        var contentType = $('ann-content-type').value;
        var externalUrl = $('ann-external-url').value.trim();
        if (contentType === 'link' && !/^https?:\/\//i.test(externalUrl)) {
            showToast('链接型公告请填写 http:// 或 https:// 地址');
            return;
        }
        if (annHtmlMode) annSyncHtmlToggle(false); // 源码模式切回可视（textarea 内容回填 editor）
        var payload = {
            title: title,
            category: $('ann-category').value,
            cover: $('ann-cover').value.trim(),
            digest: $('ann-digest').value.trim(),
            content_html: $('ann-editor').innerHTML,
            content_type: contentType,
            card_style: $('ann-card-style').value,
            external_url: externalUrl,
            open_in_browser: $('ann-open-browser').checked,
            stick: $('ann-stick').checked,
            require_confirm: $('ann-confirm').checked,
            attachments: annAttachItems,
            status: publish ? 1 : 0
        };
        var req;
        if (annEditingId) {
            req = api('PUT', '/admin/api/announcements/' + annEditingId, payload).then(function (result) {
                if (!result.ok) return result;
                if (publish) {
                    return api('POST', '/admin/api/announcements/' + annEditingId + '/publish');
                }
                return result;
            });
        } else {
            req = api('POST', '/admin/api/announcements', payload);
        }
        req.then(function (result) {
            if (!result.ok) { showToast(result.msg || '保存失败'); return; }
            $('ann-modal-mask').classList.add('hidden');
            showToast(publish ? '已发布，在线用户已收到提醒' : '已保存草稿');
            annLoadList();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // ===== 已读/签收名单弹窗 =====
    function annOpenReads(id, title) {
        $('ann-reads-title').textContent = '已读名单 - ' + title;
        var tbody = $('ann-reads-tbody');
        tbody.innerHTML = '<tr><td colspan="3" class="vec-empty">加载中…</td></tr>';
        $('ann-reads-mask').classList.remove('hidden');
        api('GET', '/admin/api/announcements/' + id + '/reads').then(function (result) {
            if (!result.ok) { tbody.innerHTML = '<tr><td colspan="3" class="vec-empty">' + (result.msg || '加载失败') + '</td></tr>'; return; }
            var reads = result.data.reads || [];
            tbody.innerHTML = '';
            if (!reads.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="vec-empty">暂无人阅读</td></tr>';
                return;
            }
            reads.forEach(function (rd) {
                var tr = document.createElement('tr');
                var tdU = document.createElement('td'); tdU.textContent = rd.username; tr.appendChild(tdU);
                var tdC = document.createElement('td'); tdC.textContent = rd.confirmed ? '已确认' : '—'; tr.appendChild(tdC);
                var tdT = document.createElement('td'); tdT.textContent = String(rd.create_time || '').replace('T', ' ').slice(0, 19); tr.appendChild(tdT);
                tbody.appendChild(tr);
            });
        }).catch(function () { tbody.innerHTML = '<tr><td colspan="3" class="vec-empty">加载失败</td></tr>'; });
    }

    // ===== 事件绑定 =====
    $('ann-create').addEventListener('click', function () { annOpenEditor(0); });
    $('ann-refresh').addEventListener('click', function () { annLoadList(); });
    $('ann-search').addEventListener('input', function () { annPage = 1; annLoadList(); });
    $('ann-filter-category').addEventListener('change', function () { annPage = 1; annLoadList(); });
    $('ann-filter-status').addEventListener('change', function () { annPage = 1; annLoadList(); });
    $('ann-prev').addEventListener('click', function () { if (annPage > 1) { annPage--; annLoadList(); } });
    $('ann-next').addEventListener('click', function () { if (annPage * 20 < annTotal) { annPage++; annLoadList(); } });
    $('ann-modal-mask').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });
    $('ann-save-draft').addEventListener('click', function () { annSave(false); });
    $('ann-save-publish').addEventListener('click', function () { annSave(true); });

    // 富文本工具条（execCommand 零依赖；data-block 走 formatBlock 段落格式）
    document.querySelectorAll('.ann-tool-btn[data-cmd]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            document.execCommand(btn.getAttribute('data-cmd'), false, null);
            $('ann-editor').focus();
        });
    });
    document.querySelectorAll('.ann-tool-btn[data-block]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            document.execCommand('formatBlock', false, '<' + btn.getAttribute('data-block') + '>');
            $('ann-editor').focus();
        });
    });
    // 插入图片：选择文件 → 上传 → insertImage 到光标处
    $('ann-insert-image').addEventListener('click', function () { $('ann-image-file').click(); });
    $('ann-attach-btn').addEventListener('click', function () { $('ann-attach-file').click(); });
    function annHandleFilePicked(input, isImage) {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return;
        var busy = false;
        function next(i) {
            if (i >= files.length) { input.value = ''; return; }
            annUploadFile(files[i]).then(function (result) {
                if (!result.ok) { showToast(result.msg || '上传失败'); return next(i + 1); }
                if (isImage) {
                    document.execCommand('insertImage', false, result.data.url);
                } else {
                    annAttachItems.push({ name: result.data.name, url: result.data.url, size: result.data.size });
                    annRenderAttachList();
                }
                next(i + 1);
            }).catch(function () { showToast('网络异常'); next(i + 1); });
        }
        next(0);
        if (busy === false) busy = true; // 串行标记仅防重复点击提示，逻辑上逐个收口
    }
    $('ann-attach-file').addEventListener('change', function () { annHandleFilePicked(this, false); });
    var imgInput = document.createElement('input');
    imgInput.type = 'file';
    imgInput.accept = 'image/*';
    imgInput.id = 'ann-image-file';
    imgInput.className = 'hidden';
    imgInput.addEventListener('change', function () { annHandleFilePicked(this, true); });
    $('ann-modal-mask').querySelector('.ann-modal-box').appendChild(imgInput);
    // 阶段一百四十四三期：字号/颜色/表格/源码切换/封面上传/正文类型联动
    $('ann-font-size').addEventListener('change', function () {
        if (!this.value) return;
        document.execCommand('fontSize', false, this.value);
        this.value = '';
        $('ann-editor').focus();
    });
    $('ann-fore-color').addEventListener('change', function () {
        document.execCommand('foreColor', false, this.value);
        $('ann-editor').focus();
    });
    $('ann-bg-color').addEventListener('change', function () {
        document.execCommand('hiliteColor', false, this.value);
        $('ann-editor').focus();
    });
    // 插入 3×3 表格（insertHTML 经消毒白名单保留 table/tr/td）
    $('ann-insert-table').addEventListener('click', function () {
        var html = '<table style="width:100%;border-collapse:collapse"><tbody>';
        for (var r = 0; r < 3; r++) {
            html += '<tr>';
            for (var c = 0; c < 3; c++) {
                html += '<td style="border:1px solid #ccc;padding:6px 10px">&nbsp;</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table><p><br></p>';
        document.execCommand('insertHTML', false, html);
        $('ann-editor').focus();
    });
    $('ann-html-toggle').addEventListener('click', function () { annSyncHtmlToggle(!annHtmlMode); });
    $('ann-content-type').addEventListener('change', annApplyTypeUI);
    // 封面上传：复用公告附件上传端点（图片扩展白名单内），回填 URL + 预览
    $('ann-cover-btn').addEventListener('click', function () { $('ann-cover-file').click(); });
    $('ann-cover-file').addEventListener('change', function () {
        var file = (this.files || [])[0];
        this.value = '';
        if (!file) return;
        annUploadFile(file).then(function (result) {
            if (!result.ok) { showToast(result.msg || '封面上传失败'); return; }
            $('ann-cover').value = result.data.url;
            annRenderCoverPreview(result.data.url);
            showToast('封面已上传');
        }).catch(function () { showToast('网络异常'); });
    });
    $('ann-cover').addEventListener('change', function () { annRenderCoverPreview(this.value.trim()); });
    $('ann-reads-close').addEventListener('click', function () { $('ann-reads-mask').classList.add('hidden'); });

    // ===== 阶段一百四十五：工作台管理（企业办公应用统一入口，后台维护网站清单） =====
    var wbPage = 1;
    var wbTotal = 0;
    var wbEditingId = 0; // 0=新建，>0=编辑中的应用 ID

    var WB_CAT_TEXT = { office: '办公应用', biz: '业务系统', hr: '人事行政', it: 'IT服务', other: '其他' };
    var WB_MODE_TEXT = { embed: '内置浏览器', window: '内置窗体', system: '系统浏览器' };

    // ===== 列表 =====
    function wbLoadList() {
        $('wb-status').textContent = '加载中…';
        var qs = '?page=' + wbPage + '&size=50';
        var category = $('wb-filter-category').value;
        var status = $('wb-filter-status').value;
        var kw = $('wb-search').value.trim();
        if (category) qs += '&category=' + category;
        if (status !== '') qs += '&status=' + status;
        if (kw) qs += '&keyword=' + encodeURIComponent(kw);
        api('GET', '/admin/api/workbench' + qs).then(function (result) {
            if (!result.ok) { showToast(result.msg || '加载失败'); $('wb-status').textContent = '加载失败'; return; }
            wbTotal = result.data.total || 0;
            $('wb-status').textContent = '共 ' + wbTotal + ' 条';
            $('wb-page-info').textContent = '第 ' + wbPage + ' 页 / 共 ' + Math.max(1, Math.ceil(wbTotal / 50)) + ' 页';
            wbRenderList(result.data.list || []);
        }).catch(function (e) { $('wb-status').textContent = '加载失败'; showToast(e.message || '网络异常'); });
    }

    function wbRenderList(list) {
        var tbody = $('wb-tbody');
        tbody.innerHTML = '';
        if (!list.length) {
            var tr = document.createElement('tr');
            var td = document.createElement('td');
            td.colSpan = 9;
            td.className = 'vec-empty';
            td.textContent = '暂无应用，点击"新建应用"添加公司内部办公网站';
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }
        list.forEach(function (a) {
            var tr = document.createElement('tr');
            // ID
            var tdId = document.createElement('td'); tdId.textContent = a.id; tr.appendChild(tdId);
            // 图标（有图标显示小图，无则名称首字占位）
            var tdIcon = document.createElement('td');
            if (a.icon) {
                var img = document.createElement('img');
                img.src = a.icon;
                img.className = 'wb-list-icon';
                tdIcon.appendChild(img);
            } else {
                var ph = document.createElement('span');
                ph.className = 'wb-list-icon wb-list-icon-ph';
                ph.textContent = (a.name || '?').charAt(0).toUpperCase();
                tdIcon.appendChild(ph);
            }
            tr.appendChild(tdIcon);
            // 名称（备注悬浮提示）
            var tdName = document.createElement('td');
            tdName.textContent = a.name;
            tdName.title = a.remark || a.name;
            tr.appendChild(tdName);
            // 分类
            var tdCat = document.createElement('td');
            tdCat.textContent = WB_CAT_TEXT[a.category] || a.category;
            tr.appendChild(tdCat);
            // 地址（超长省略，悬浮看全文）
            var tdUrl = document.createElement('td');
            tdUrl.textContent = a.url;
            tdUrl.title = a.url;
            tdUrl.className = 'wb-url-cell';
            tr.appendChild(tdUrl);
            // 打开方式
            var tdMode = document.createElement('td');
            tdMode.textContent = WB_MODE_TEXT[a.open_mode] || a.open_mode;
            tr.appendChild(tdMode);
            // 排序
            var tdSort = document.createElement('td'); tdSort.textContent = a.sort_order; tr.appendChild(tdSort);
            // 状态
            var tdSt = document.createElement('td');
            var st = document.createElement('span');
            st.className = 'ann-status-dot ' + (a.status === 1 ? 'ann-status-published' : 'ann-status-draft');
            st.textContent = a.status === 1 ? '启用' : '禁用';
            tdSt.appendChild(st);
            tr.appendChild(tdSt);
            // 操作
            var tdOp = document.createElement('td');
            function opBtn(text, cls, fn) {
                var b = document.createElement('button');
                b.className = 'admin-btn small' + (cls ? ' ' + cls : '');
                b.textContent = text;
                b.addEventListener('click', fn);
                return b;
            }
            tdOp.appendChild(opBtn('编辑', '', function () { wbOpenEditor(a); }));
            tdOp.appendChild(opBtn(a.status === 1 ? '禁用' : '启用', '', function () {
                a.status = a.status === 1 ? 0 : 1;
                api('PUT', '/admin/api/workbench/' + a.id, a).then(function (result) {
                    if (!result.ok) { showToast(result.msg || '操作失败'); return; }
                    showToast(a.status === 1 ? '已启用' : '已禁用');
                    wbLoadList();
                }).catch(function () { showToast('网络异常'); });
            }));
            tdOp.appendChild(opBtn('删除', '', function () {
                confirmBox('删除后客户端工作台立即不可见，确定删除「' + a.name + '」？', function () {
                    api('DELETE', '/admin/api/workbench/' + a.id).then(function (result) {
                        if (!result.ok) { showToast(result.msg || '删除失败'); return; }
                        showToast('已删除');
                        wbLoadList();
                    }).catch(function () { showToast('网络异常'); });
                });
            }));
            tr.appendChild(tdOp);
            tbody.appendChild(tr);
        });
    }

    // ===== 编辑弹窗 =====
    function wbOpenEditor(a) {
        wbEditingId = a ? (a.id || 0) : 0;
        $('wb-modal-title').textContent = wbEditingId ? '编辑应用' : '新建应用';
        $('wb-name').value = a ? a.name : '';
        $('wb-category').value = a ? a.category : 'office';
        $('wb-url').value = a ? a.url : '';
        $('wb-icon').value = a ? a.icon : '';
        wbRenderIconPreview(a ? a.icon : '');
        $('wb-open-mode').value = a ? a.open_mode : 'embed'; // 新建默认内置浏览器（PC 浏览区面板新标签，体验最顺）
        $('wb-sort').value = a ? a.sort_order : 0;
        $('wb-enabled').checked = a ? a.status === 1 : true;
        $('wb-remark').value = a ? a.remark : '';
        $('wb-modal-mask').classList.remove('hidden');
    }

    // 图标预览（有 URL 显示图，无则隐藏）
    function wbRenderIconPreview(url) {
        var img = $('wb-icon-preview');
        if (url) {
            img.src = url;
            img.classList.remove('hidden');
        } else {
            img.classList.add('hidden');
        }
    }

    // ===== 保存归口 =====
    function wbSave() {
        var name = $('wb-name').value.trim();
        var url = $('wb-url').value.trim();
        if (!name) { showToast('请填写应用名称'); return; }
        if (!/^https?:\/\//i.test(url)) {
            showToast('地址请以 http:// 或 https:// 开头');
            return;
        }
        var payload = {
            name: name,
            url: url,
            icon: $('wb-icon').value.trim(),
            category: $('wb-category').value,
            open_mode: $('wb-open-mode').value,
            sort_order: parseInt($('wb-sort').value, 10) || 0,
            status: $('wb-enabled').checked ? 1 : 0,
            remark: $('wb-remark').value.trim()
        };
        var req = wbEditingId
            ? api('PUT', '/admin/api/workbench/' + wbEditingId, payload)
            : api('POST', '/admin/api/workbench', payload);
        req.then(function (result) {
            if (!result.ok) { showToast(result.msg || '保存失败'); return; }
            $('wb-modal-mask').classList.add('hidden');
            showToast('已保存');
            wbLoadList();
        }).catch(function (e) { showToast(e.message || '网络异常'); });
    }

    // ===== 事件绑定 =====
    $('wb-create').addEventListener('click', function () { wbOpenEditor(null); });
    $('wb-refresh').addEventListener('click', function () { wbLoadList(); });
    $('wb-search').addEventListener('input', function () { wbPage = 1; wbLoadList(); });
    $('wb-filter-category').addEventListener('change', function () { wbPage = 1; wbLoadList(); });
    $('wb-filter-status').addEventListener('change', function () { wbPage = 1; wbLoadList(); });
    $('wb-prev').addEventListener('click', function () { if (wbPage > 1) { wbPage--; wbLoadList(); } });
    $('wb-next').addEventListener('click', function () { if (wbPage * 50 < wbTotal) { wbPage++; wbLoadList(); } });
    $('wb-modal-mask').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });
    $('wb-modal-cancel').addEventListener('click', function () { $('wb-modal-mask').classList.add('hidden'); });
    $('wb-modal-ok').addEventListener('click', wbSave);
    // 图标上传（FormData 走工作台专用端点，回填 URL 并预览）
    $('wb-icon-btn').addEventListener('click', function () { $('wb-icon-file').click(); });
    $('wb-icon-file').addEventListener('change', function () {
        var file = (this.files || [])[0];
        this.value = '';
        if (!file) return;
        var fd = new FormData();
        fd.append('file', file);
        fetch('/admin/api/workbench/icon', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + getToken() },
            body: fd
        }).then(function (resp) {
            return resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; });
        }).then(function (result) {
            if (!result.ok) { showToast(result.msg || '图标上传失败'); return; }
            $('wb-icon').value = result.data.url;
            wbRenderIconPreview(result.data.url);
            showToast('图标已上传');
        }).catch(function () { showToast('网络异常'); });
    });
    $('wb-icon').addEventListener('change', function () { wbRenderIconPreview(this.value.trim()); });
})();
