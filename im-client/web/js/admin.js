/* ===== 阶段四十九：后台管理界面逻辑 =====
 * 设计归口：
 *  - 登录走 /admin/api/login（复用 IM 账号体系 + 管理员白名单校验），Token 存 localStorage
 *  - AI 模型服务 / AI 智能体的增删改查走 /admin/api/ai/*，服务端保存后热生效并广播在线客户端
 *  - 全部弹窗为自定义实现（禁用系统默认弹窗）；主题色复用聊天端 CSS 变量体系
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

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
    $('admin-theme-btn').addEventListener('click', function () {
        var cur = localStorage.getItem('im_theme') || 'light';
        var next = cur === 'light' ? 'dark' : (cur === 'dark' ? 'system' : 'light');
        applyTheme(next);
        showToast('主题：' + (next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统'));
        refreshDashChartsTheme(); // 图表文字/线条颜色跟随主题变量即时刷新
    });

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
            // 阶段八十一：进入 Agent 设置视图拉取当前生效参数
            else if (item.dataset.view === 'agentsettings') { loadAgentSettings(); loadGitPrompts(); }
            // 阶段七十八：进入积分管理视图拉取用户积分列表与流水
            else if (item.dataset.view === 'points') { loadPointsUsers(); loadPointsLogs(); }
            // 阶段八十九：进入 MCP 视图拉取服务器列表并启动状态轮询（连接中/断线状态实时可见）
            else if (item.dataset.view === 'mcp') { loadMCPServers(); startMCPPolling(); }
            // 阶段一百一十三：进入 MCP 插件库视图拉取插件清单（PC 端插件市场数据源）
            else if (item.dataset.view === 'mcpplugins') { loadMCPPlugins(); }
            // 阶段一百二十一：进入工具链市场视图拉取工具链清单（PC 端工具链市场数据源）
            else if (item.dataset.view === 'toolchains') { loadToolchains(); }
            else stopKBPolling();
        });
    });

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
            $('dash-upload-size').textContent = biz.upload_size_mb.toFixed(1) + ' MB';
            $('dash-upload-files').textContent = '文件数 ' + biz.upload_files;
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

    // ===== 启动：已有 Token 直接进主界面（会话失效由 API 统一回登录） =====
    if (getToken()) {
        showMain();
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
            { key: 'points', label: '积分余额', type: 'number', placeholder: '非负数，最多 2 位小数', hint: '绝对值设置（充值直接填新余额，支持小数），保存立即生效；AI 问答按 1000 tokens = 1 积分折算扣除' }
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
})();
