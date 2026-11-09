// ============= 阶段二百九十三：服务号管理（管理员后台前端） =============
// 微信同款公众号服务 · 服务号 CRUD / 菜单 / 模板 / API 密钥管理
// 归口面板：#admin-view-official（admin.html 中通过 data-view="official" 进入）
// 后端路由：/admin/api/official/*（official_admin.go，全部走 adminGuard 鉴权）
//
// 本文件独立于 admin.js IIFE，自行封装 $/api/showToast 工具，避免与主脚本耦合。
// admin.js 导航点击分发处通过 window.loadOfficial 钩子调用，保证视图切换时数据刷新。

(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var tokenKey = 'admin_token';
    var getToken = function () {
        try { return localStorage.getItem(tokenKey) || ''; } catch (e) { return ''; }
    };

    function api(method, path, body) {
        var opts = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + getToken()
            }
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        return fetch(path, opts).then(function (resp) {
            return resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; }).then(function (result) {
                if (resp.status === 401) {
                    try { localStorage.removeItem(tokenKey); } catch (e) { }
                    return { ok: false, msg: '登录已过期，请重新登录' };
                }
                if (!result.ok && !result.code) result.ok = false;
                if (result.code === 0) result.ok = true;
                // adminJSON 统一返回 {"ok":true, "data":{业务字段}}；把 data 平铺到顶层，
                // 这样 result.list / result.account / result.app_secret 都能直接取，
                // 避免每个调用点都写 result.data.xxx
                if (result.ok && result.data && typeof result.data === 'object') {
                    var flat = {};
                    for (var k in result.data) {
                        if (Object.prototype.hasOwnProperty.call(result.data, k)) flat[k] = result.data[k];
                    }
                    flat.ok = true;
                    if (result.msg) flat.msg = result.msg;
                    return flat;
                }
                return result;
            });
        });
    }

    // 轻提示（复用 admin.js 的 toast 元素，避免重复造 DOM）
    function showToast(msg) {
        var el = $('admin-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'admin-toast';
            el.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);' +
                'background:rgba(0,0,0,0.75);color:#fff;padding:8px 18px;border-radius:22px;' +
                'font-size:14px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.remove('hidden');
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(function () {
            el.style.opacity = '0';
            setTimeout(function () { el.classList.add('hidden'); }, 200);
        }, 2000);
    }

    function confirmBox(text, cb) {
        if (window.confirm) {
            if (window.confirm(text)) cb();
            return;
        }
        cb();
    }

    function fmtTime(t) {
        if (!t) return '-';
        try { return new Date(t).toLocaleString(); } catch (e) { return String(t); }
    }

    function fmtBool(v) { return v ? '是' : '否'; }

    // ==================== 列表加载 ====================

    var offEditingId = 0;     // 编辑中的服务号 ID（0=新建）
    var offCurrentAccount = 0; // 菜单/模板管理的服务号 ID
    var offTplEditingId = 0;

    window.loadOfficial = function () {
        loadOfficialList();
        bindOfficialEvents();
    };

    function loadOfficialList() {
        var kw = $('off-kw').value.trim();
        var owner = $('off-owner').value;
        var status = $('off-status').value;
        var q = '?page=1&size=100';
        if (kw) q += '&keyword=' + encodeURIComponent(kw);
        if (owner === 'system') q += '&owner=' + encodeURIComponent('');
        else if (owner === 'merchant') q += '&owner=__notempty__';
        if (status !== '') q += '&status=' + status;

        api('GET', '/admin/api/official/accounts' + q).then(function (result) {
            // api() 已自动把 adminJSON 的 data 层平铺，此处直接取 result.list
            if (!result || !result.ok) {
                renderOfficialList({ list: [] });
                return;
            }
            if (owner === 'merchant' && result.list) {
                result.list = result.list.filter(function (x) { return x.owner && x.owner !== ''; });
                result.total = result.list.length;
            }
            renderOfficialList(result);
        });
    }

    function renderOfficialList(result) {
        var tbody = $('off-tbody');
        var list = result.list || [];
        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="vec-empty">暂无服务号，点击右上角「+ 创建服务号」开始</td></tr>';
            return;
        }
        var rows = '';
        list.forEach(function (a) {
            var owner = !a.owner ? '<span style="color:var(--admin-accent)">系统级</span>' : ('<span>' + escHtml(a.owner) + '</span>');
            var statusHtml = a.status === 0 ? '<span style="color:#2ecc71">● 正常</span>' :
                             a.status === 1 ? '<span style="color:#e74c3c">● 已停用</span>' :
                             '<span style="color:#f39c12">● 审核中</span>';
            var auditHtml = a.need_audit ? '<span style="color:#f39c12">需审核</span>' : '<span style="color:var(--admin-field-hint)">直通</span>';
            rows += '<tr>' +
                '<td>' + a.id + '</td>' +
                '<td><strong>' + escHtml(a.display_name || '') + '</strong><div style="font-size:12px;color:var(--admin-field-hint);margin-top:2px">' + escHtml(a.description || '') + '</div></td>' +
                '<td><code>' + escHtml(a.app_id || '') + '</code></td>' +
                '<td>' + owner + '</td>' +
                '<td>' + statusHtml + '</td>' +
                '<td>' + auditHtml + '</td>' +
                '<td>' + (a.subscribe_count || 0) + '</td>' +
                '<td style="font-size:12px">' + fmtTime(a.create_time) + '</td>' +
                '<td>' +
                '<button class="admin-btn small" data-off-op="menu" data-id="' + a.id + '">菜单</button> ' +
                '<button class="admin-btn small" data-off-op="kw" data-id="' + a.id + '">关键词</button> ' +
                '<button class="admin-btn small" data-off-op="tpl" data-id="' + a.id + '">模板</button> ' +
                '<button class="admin-btn small" data-off-op="edit" data-id="' + a.id + '">编辑</button> ' +
                '<button class="admin-btn small" data-off-op="secret" data-id="' + a.id + '">密钥</button> ' +
                '<button class="admin-btn small danger" data-off-op="del" data-id="' + a.id + '">删除</button>' +
                '</td>' +
                '</tr>';
        });
        tbody.innerHTML = rows;
        // 行级操作绑定（事件委托）
        tbody.querySelectorAll('[data-off-op]').forEach(function (el) {
            el.addEventListener('click', function () {
                var op = el.getAttribute('data-off-op');
                var id = Number(el.getAttribute('data-id'));
                handleOfficialRowOp(op, id);
            });
        });
    }

    function handleOfficialRowOp(op, id) {
        if (op === 'edit') return openOfficialEdit(id);
        if (op === 'del') return confirmDeleteOfficial(id);
        if (op === 'menu') return openOfficialMenu(id);
        if (op === 'kw') return openOfficialKwList(id);
        if (op === 'tpl') return openOfficialTplList(id);
        if (op === 'secret') return resetOfficialSecret(id);
    }

    // ==================== 事件绑定（只绑一次） ====================

    var bound = false;
    function bindOfficialEvents() {
        if (bound) return;
        bound = true;
        $('off-refresh').addEventListener('click', loadOfficialList);
        $('off-new').addEventListener('click', function () { openOfficialEdit(0); });
        $('off-kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadOfficialList(); });
        $('off-owner').addEventListener('change', loadOfficialList);
        $('off-status').addEventListener('change', loadOfficialList);

        // 编辑弹窗
        $('off-edit-close').addEventListener('click', function () { $('off-edit-mask').classList.add('hidden'); });
        $('off-edit-ok').addEventListener('click', saveOfficialEdit);

        // 菜单弹窗
        $('off-menu-close').addEventListener('click', function () { $('off-menu-mask').classList.add('hidden'); });
        $('off-menu-ok').addEventListener('click', saveOfficialMenu);

        // 模板弹窗
        $('off-tpl-close').addEventListener('click', function () { $('off-tpl-mask').classList.add('hidden'); });
        $('off-tpl-add').addEventListener('click', function () { openTplEdit(0); });
        $('off-te-close').addEventListener('click', function () { $('off-tpl-edit-mask').classList.add('hidden'); });
        $('off-te-ok').addEventListener('click', saveTplEdit);

        // 密钥弹窗
        $('off-secret-close').addEventListener('click', function () { $('off-secret-mask').classList.add('hidden'); });
    }

    // ==================== 编辑 / 创建 ====================

    function openOfficialEdit(id) {
        offEditingId = id;
        var row = $('off-e-status-row');
        if (row) row.style.display = id ? '' : 'none';
        var title = $('off-edit-title');
        if (title) title.textContent = id ? '编辑服务号 #' + id : '创建服务号';
        $('off-e-name').value = '';
        $('off-e-owner').value = '';
        $('off-e-desc').value = '';
        $('off-e-avatar').value = '';
        $('off-e-max').value = '';
        $('off-e-audit').checked = false;
        $('off-e-status').value = '0';
        if (id) {
            api('GET', '/admin/api/official/accounts/' + id).then(function (result) {
                if (!result.account) return showToast('加载失败');
                var a = result.account;
                $('off-e-name').value = a.display_name || '';
                $('off-e-owner').value = a.owner || '';
                $('off-e-desc').value = a.description || '';
                $('off-e-avatar').value = a.avatar || '';
                $('off-e-max').value = a.max_per_day || '';
                $('off-e-audit').checked = !!a.need_audit;
                $('off-e-status').value = String(a.status !== undefined ? a.status : 0);
            });
        }
        $('off-edit-mask').classList.remove('hidden');
    }

    function saveOfficialEdit() {
        var body = {
            display_name: $('off-e-name').value.trim(),
            owner: $('off-e-owner').value.trim(),
            description: $('off-e-desc').value.trim(),
            avatar: $('off-e-avatar').value.trim(),
            need_audit: $('off-e-audit').checked,
            max_per_day: Number($('off-e-max').value) || 0
        };
        if (!body.display_name) return showToast('展示名不能为空');
        var p;
        if (offEditingId === 0) {
            p = api('POST', '/admin/api/official/accounts', body);
        } else {
            if ($('off-e-status-row').style.display !== 'none') {
                body.status = Number($('off-e-status').value);
            }
            p = api('PUT', '/admin/api/official/accounts/' + offEditingId, body);
        }
        p.then(function (result) {
            if (result.app_secret) {
                // 创建时返回了密钥，提示用户立即复制
                showToast('创建成功！请立即复制 AppSecret（仅显示一次）');
                var msg = 'AppID: ' + result.app_id + '\nAppSecret: ' + result.app_secret;
                setTimeout(function () {
                    if (window.prompt) window.prompt('新服务号凭证（请立即复制保存）：', msg);
                }, 200);
            } else if (!result.ok) {
                return showToast(result.msg || '保存失败');
            } else {
                showToast('保存成功');
            }
            $('off-edit-mask').classList.add('hidden');
            loadOfficialList();
        });
    }

    function confirmDeleteOfficial(id) {
        confirmBox('确定删除该服务号？\n· 菜单、模板、订阅关系、推送记录、审核记录将一并删除\n· 此操作不可撤销', function () {
            api('DELETE', '/admin/api/official/accounts/' + id).then(function (result) {
                if (!result.ok) return showToast(result.msg || '删除失败');
                showToast('已删除');
                loadOfficialList();
            });
        });
    }

    function resetOfficialSecret(id) {
        confirmBox('重置后旧密钥立即失效，企业系统需要更新调用凭证。确定继续？', function () {
            api('PUT', '/admin/api/official/accounts/' + id + '/secret').then(function (result) {
                if (!result.app_secret) return showToast(result.msg || '重置失败');
                $('off-secret-val').textContent = 'AppID: ' + result.app_id + '\nAppSecret: ' + result.app_secret;
                $('off-secret-mask').classList.remove('hidden');
            });
        });
    }

    // ==================== 菜单管理 ====================

    function openOfficialMenu(id) {
        offCurrentAccount = id;
        $('off-menu-json').value = '';
        api('GET', '/admin/api/official/accounts/' + id).then(function (res) {
            if (res.account) $('off-menu-title').textContent = res.account.display_name;
        });
        api('GET', '/admin/api/official/accounts/' + id + '/menu').then(function (res) {
            var trees = res.menus || [];
            // 转成前端需要的格式（保留 name/action/value/children）
            var convert = function (nodes) {
                return nodes.map(function (n) {
                    var o = { name: n.name, action: n.action, value: n.value };
                    if (n.children && n.children.length > 0) o.children = convert(n.children);
                    return o;
                });
            };
            $('off-menu-json').value = JSON.stringify(convert(trees), null, 2);
        });
        $('off-menu-mask').classList.remove('hidden');
    }

    function saveOfficialMenu() {
        var txt = $('off-menu-json').value.trim();
        if (!txt) {
            // 空数组清空所有菜单
            txt = '[]';
        }
        var menus;
        try { menus = JSON.parse(txt); } catch (e) {
            return showToast('JSON 格式错误：' + e.message);
        }
        if (!Array.isArray(menus)) return showToast('必须为数组');
        api('POST', '/admin/api/official/accounts/' + offCurrentAccount + '/menu', { menus: menus }).then(function (res) {
            if (!res.ok) return showToast(res.msg || '保存失败');
            showToast('菜单已保存');
            $('off-menu-mask').classList.add('hidden');
        });
    }

    // ==================== 模板管理 ====================

    function openOfficialTplList(id) {
        offCurrentAccount = id;
        api('GET', '/admin/api/official/accounts/' + id).then(function (res) {
            if (res.account) $('off-tpl-title').textContent = res.account.display_name;
        });
        loadTplList();
        $('off-tpl-mask').classList.remove('hidden');
    }

    function loadTplList() {
        api('GET', '/admin/api/official/accounts/' + offCurrentAccount + '/templates').then(function (list) {
            var tbody = $('off-tpl-tbody');
            if (!list || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="vec-empty">暂无模板，点击上方「+ 新增模板」开始</td></tr>';
                return;
            }
            var html = '';
            list.forEach(function (t) {
                html += '<tr>' +
                    '<td><code>' + escHtml(t.template_id || '') + '</code></td>' +
                    '<td>' + escHtml(t.name || '') + '</td>' +
                    '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(t.content || '') + '">' + escHtml(t.content || '') + '</td>' +
                    '<td>' +
                    '<button class="admin-btn small" data-tpl-op="edit" data-id="' + t.id + '">编辑</button> ' +
                    '<button class="admin-btn small danger" data-tpl-op="del" data-id="' + t.id + '">删除</button>' +
                    '</td>' +
                    '</tr>';
            });
            tbody.innerHTML = html;
            tbody.querySelectorAll('[data-tpl-op]').forEach(function (el) {
                el.addEventListener('click', function () {
                    var op = el.getAttribute('data-tpl-op');
                    var id = Number(el.getAttribute('data-id'));
                    if (op === 'edit') openTplEdit(id);
                    else confirmDeleteTpl(id);
                });
            });
        });
    }

    function openTplEdit(id) {
        offTplEditingId = id;
        $('off-te-id').value = '';
        $('off-te-name').value = '';
        $('off-te-content').value = '';
        $('off-te-example').value = '';
        $('off-tpl-edit-title').textContent = id ? '编辑模板 #' + id : '新增模板';
        if (id) {
            api('GET', '/admin/api/official/templates/' + id).then(function (t) {
                if (!t) return;
                $('off-te-id').value = t.template_id || '';
                $('off-te-name').value = t.name || '';
                $('off-te-content').value = t.content || '';
                $('off-te-example').value = t.example || '';
            });
        }
        $('off-tpl-edit-mask').classList.remove('hidden');
    }

    function saveTplEdit() {
        var body = {
            template_id: $('off-te-id').value.trim(),
            name: $('off-te-name').value.trim(),
            content: $('off-te-content').value.trim(),
            example: $('off-te-example').value.trim()
        };
        if (!body.name || !body.content) return showToast('名称和正文不能为空');
        var p;
        if (offTplEditingId === 0) {
            p = api('POST', '/admin/api/official/accounts/' + offCurrentAccount + '/templates', body);
        } else {
            var patch = {};
            if (body.name) patch.name = body.name;
            if (body.content) patch.content = body.content;
            if (body.example) patch.example = body.example;
            p = api('PUT', '/admin/api/official/templates/' + offTplEditingId, patch);
        }
        p.then(function (res) {
            if (!res.ok) return showToast(res.msg || '保存失败');
            showToast('模板已保存');
            $('off-tpl-edit-mask').classList.add('hidden');
            loadTplList();
        });
    }

    function confirmDeleteTpl(id) {
        confirmBox('确定删除该模板？', function () {
            api('DELETE', '/admin/api/official/templates/' + id).then(function (res) {
                if (!res.ok) return showToast(res.msg || '删除失败');
                showToast('已删除');
                loadTplList();
            });
        });
    }

    // ==================== 关键词自动回复（P7） ====================

    var offKwAccount = 0;

    function openOfficialKwList(id) {
        offCurrentAccount = id;
        offKwAccount = id;
        $('off-kw-mask').classList.remove('hidden');
        loadKwList();
    }

    function loadKwList() {
        api('GET', '/admin/api/official/accounts/' + offKwAccount + '/keywords').then(function (list) {
            var tbody = $('off-kw-tbody');
            if (!list || !list.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="vec-empty">暂无关键词，在上方输入触发词和回复内容后点 + 新增</td></tr>';
                return;
            }
            var rows = '';
            list.forEach(function (kw) {
                var mtLabel = kw.match_type === 'exact' ? '精确匹配' : '包含匹配';
                rows += '<tr>' +
                    '<td>' + kw.id + '</td>' +
                    '<td>' + mtLabel + '</td>' +
                    '<td>' + escHtml(kw.keyword || '') + '</td>' +
                    '<td>' + escHtml((kw.reply_text || '').slice(0, 80)) + '</td>' +
                    '<td>' + (kw.enabled ? '✓' : '✗') + '</td>' +
                    '<td>' +
                    '<button class="admin-btn small" data-kw-op="toggle" data-id="' + kw.id + '" data-en="' + (kw.enabled ? '0' : '1') + '">' +
                    (kw.enabled ? '禁用' : '启用') + '</button> ' +
                    '<button class="admin-btn small danger" data-kw-op="del" data-id="' + kw.id + '">删除</button>' +
                    '</td>' +
                    '</tr>';
            });
            tbody.innerHTML = rows;
            tbody.querySelectorAll('[data-kw-op]').forEach(function (el) {
                el.addEventListener('click', function () {
                    var op = el.getAttribute('data-kw-op');
                    var kid = Number(el.getAttribute('data-id'));
                    if (op === 'del') confirmDeleteKw(kid);
                    else if (op === 'toggle') toggleKw(kid, el.getAttribute('data-en') === '1');
                });
            });
        });
    }

    function saveKw() {
        var keyword = $('off-kw-new-keyword').value.trim();
        var reply = $('off-kw-new-reply').value.trim();
        var match = $('off-kw-new-match').value;
        if (!keyword || !reply) return showToast('触发词和回复内容不能为空');
        api('POST', '/admin/api/official/accounts/' + offKwAccount + '/keywords', {
            keyword: keyword, reply_text: reply, match_type: match, enabled: true, sort_order: 0
        }).then(function (res) {
            if (!res.ok) return showToast(res.msg || '保存失败');
            showToast('已添加');
            $('off-kw-new-keyword').value = '';
            $('off-kw-new-reply').value = '';
            loadKwList();
        });
    }

    function toggleKw(id, enable) {
        api('PUT', '/admin/api/official/keywords/' + id, { enabled: enable }).then(function (res) {
            if (!res.ok) return showToast(res.msg || '操作失败');
            showToast(enable ? '已启用' : '已禁用');
            loadKwList();
        });
    }

    function confirmDeleteKw(id) {
        confirmBox('确定删除该关键词？', function () {
            api('DELETE', '/admin/api/official/keywords/' + id).then(function (res) {
                if (!res.ok) return showToast(res.msg || '删除失败');
                showToast('已删除');
                loadKwList();
            });
        });
    }

    // 事件绑定（关键词弹窗）
    var boundKw = false;
    function bindKwEvents() {
        if (boundKw) return;
        boundKw = true;
        document.getElementById('off-kw-close').addEventListener('click', function () {
            document.getElementById('off-kw-mask').classList.add('hidden');
        });
        document.getElementById('off-kw-new-btn').addEventListener('click', saveKw);
        document.getElementById('off-kw-new-reply').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') saveKw();
        });
    }
    // 注入到已有的 bindOfficialEvents（避免在 DOMContentLoaded 之前调用）
    var _prevBind = bindOfficialEvents;
    bindOfficialEvents = function () {
        _prevBind();
        bindKwEvents();
    };

})();
