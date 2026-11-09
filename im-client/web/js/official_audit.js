// ============= 阶段二百九十三：服务号审核面板前端（P5 · 单人审批） =============
// 归口 admin.html #admin-view-official 视图第二 Tab
// 后端路由：/admin/api/official/audit/*（official_admin.go，adminGuard 鉴权）
//          /api/merchant/official/audit/*（official_merchant.go，merchantGuard 鉴权）
// 审批模型：单人审批。通过 → 直接 approved（触发发送）；驳回 → 单人即生效（remark 必填）。

(function () {
    'use strict';

    if (window.__offAuditLoaded) return;
    window.__offAuditLoaded = true;

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
                // adminJSON 统一返回 {"ok":true, "data":{业务字段}}；把 data 平铺到顶层
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

    function fmtTime(t) {
        if (!t) return '-';
        try { return new Date(t).toLocaleString(); } catch (e) { return String(t); }
    }

    // ==================== 状态 ====================

    var auditSegMode = 'pending';
    var auditCurrentPage = 1;

    // ==================== Tab / Segmented 切换 ====================

    function bindTabs() {
        document.querySelectorAll('[data-otab]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('[data-otab]').forEach(function (t) { t.classList.remove('active'); });
                btn.classList.add('active');
                var key = btn.getAttribute('data-otab');
                document.querySelectorAll('[data-opane]').forEach(function (p) {
                    p.classList.toggle('hidden', p.getAttribute('data-opane') !== key);
                });
                if (key === 'audit') {
                    loadAuditList(true);
                    refreshPendingBadge();
                }
            });
        });
    }

    function bindSeg() {
        var seg = $('off-audit-seg');
        if (!seg) return;
        seg.querySelectorAll('.admin-seg-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                seg.querySelectorAll('.admin-seg-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                auditSegMode = btn.getAttribute('data-seg');
                auditCurrentPage = 1;
                loadAuditList(true);
            });
        });
    }

    // ==================== 列表 ====================

    function refreshPendingBadge() {
        api('GET', '/admin/api/official/audit/pending?page=1&size=1').then(function (r) {
            if (r && typeof r.total === 'number') {
                var badge = $('off-audit-badge');
                if (r.total > 0) {
                    badge.textContent = r.total > 99 ? '99+' : r.total;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        });
    }

    function loadAuditList(resetPage) {
        if (resetPage) auditCurrentPage = 1;
        var kw = ($('off-audit-kw') ? $('off-audit-kw').value : '').trim();
        var st = ($('off-audit-status') ? $('off-audit-status').value : '');
        var q = '?page=' + auditCurrentPage + '&size=20';
        api('GET', auditSegMode === 'pending'
            ? '/admin/api/official/audit/pending' + q
            : '/admin/api/official/audit/all' + q).then(function (result) {
            if (!result || !result.list) { renderAuditList([], 0); return; }
            var list = result.list;
            // 前端二次过滤（后端未提供 status/keyword 参数）
            if (st && auditSegMode === 'all') list = list.filter(function (x) { return x.status === st; });
            if (kw) {
                var kwL = kw.toLowerCase();
                list = list.filter(function (x) {
                    var m = x.message || {};
                    return (x.account_name || '').toLowerCase().indexOf(kwL) >= 0 ||
                        ((m.title || m.content || '').toString().toLowerCase().indexOf(kwL) >= 0);
                });
            }
            renderAuditList(list, result.total || list.length);
        });
    }

    function renderAuditList(list, total) {
        var tbody = $('off-audit-tbody');
        if (!tbody) return;
        if (!list || list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="vec-empty">暂无审核记录</td></tr>';
            return;
        }
        var rows = '';
        list.forEach(function (item) {
            var m = item.message || {};

            var title = (m.title || m.content || '').toString();
            if (title.length > 30) title = title.slice(0, 30) + '…';

            var ctypeLabel = m.content_type || '-';
            var triggerMap = { api: 'API 网关', manual: '后台手动', menu: '菜单自动', event: '事件' };
            var triggerLabel = triggerMap[m.trigger_type] || (m.trigger_type || '-');

            var statusLabel = '', statusColor = '';
            if (item.status === 'pending')   { statusLabel = '待审核';    statusColor = '#faad14'; }
            else if (item.status === 'approved') { statusLabel = '已通过'; statusColor = 'var(--primary,#07c160)'; }
            else if (item.status === 'rejected') { statusLabel = '已驳回'; statusColor = '#fa5151'; }

            var isPending = item.status === 'pending';
            var actionHtml = '<button class="admin-btn" data-aud="view" data-id="' + item.id + '">查看</button> ';
            if (isPending) {
                actionHtml += '<button class="admin-btn primary" data-aud="approve" data-id="' + item.id + '">通过</button> ';
                actionHtml += '<button class="admin-btn danger" data-aud="reject" data-id="' + item.id + '">驳回</button>';
            } else {
                actionHtml += '<button class="admin-btn" data-aud="view" data-id="' + item.id + '">详情</button>';
            }

            rows += '<tr>' +
                '<td>' + item.id + '</td>' +
                '<td>' + escHtml(item.account_name || '-') + '</td>' +
                '<td title="' + escHtml(m.title || m.content || '') + '">' + escHtml(title) + '</td>' +
                '<td>' + escHtml(ctypeLabel) + '<div style="font-size:11px;color:#999">' + escHtml(triggerLabel) + '</div></td>' +
                '<td><span style="color:' + statusColor + ';font-weight:500">' + statusLabel + '</span></td>' +
                '<td>' + fmtTime(item.create_time) + '</td>' +
                '<td>' + actionHtml + '</td>' +
                '</tr>';
        });
        tbody.innerHTML = rows;
        bindAuditRowActions();
    }

    function bindAuditRowActions() {
        var tbody = $('off-audit-tbody');
        if (!tbody) return;
        tbody.querySelectorAll('button[data-aud]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var action = btn.getAttribute('data-aud');
                var id = parseInt(btn.getAttribute('data-id'), 10);
                if (!id) return;
                if (action === 'view') openAuditDetail(id, false);
                else if (action === 'approve') doAuditAct(id, true, '');
                else if (action === 'reject') openAuditReject(id);
            });
        });
    }

    // ==================== 审核详情弹窗 ====================

    var _currentAuditId = 0;

    function openAuditDetail(id) {
        _currentAuditId = id;
        api('GET', '/admin/api/official/audit/all?page=1&size=500').then(function (result) {
            var item = null;
            if (result && result.list) {
                for (var i = 0; i < result.list.length; i++) {
                    if (result.list[i].id === id) { item = result.list[i]; break; }
                }
            }
            if (!item) { showToast('未找到审核记录'); return; }

            var m = item.message || {};
            $('off-ad-id').textContent = item.id;
            $('off-ad-acc').textContent = (item.account_name || '-') + ' (' + (item.account_app_id || '') + ')';
            $('off-ad-title2').textContent = m.title || '(无标题)';
            $('off-ad-ctype').textContent = m.content_type || '-';
            var triggerMap = { api: 'API 网关', manual: '后台手动', menu: '菜单自动', event: '事件' };
            $('off-ad-trigger').textContent = triggerMap[m.trigger_type] || (m.trigger_type || '-');
            $('off-ad-progress').textContent = '单人审批';

            var statusLabel = '';
            if (item.status === 'pending')   statusLabel = '<span style="color:#faad14">待审核</span>';
            else if (item.status === 'approved') statusLabel = '<span style="color:var(--primary,#07c160)">已通过</span>';
            else if (item.status === 'rejected') statusLabel = '<span style="color:#fa5151">已驳回</span>';
            $('off-ad-status').innerHTML = statusLabel;

            if (item.status === 'rejected') {
                $('off-ad-remark-row').style.display = 'flex';
                $('off-ad-remark').textContent = item.audit_remark || m.audit_remark || '(无)';
            } else {
                $('off-ad-remark-row').style.display = 'none';
            }

            var content = m.content || '';
            if (m.url) content += (content ? '\n\n' : '') + '链接: ' + m.url;
            $('off-ad-content').textContent = content || '(空)';

            // 按钮区
            var btns = $('off-ad-btns');
            if (item.status === 'pending') {
                btns.innerHTML =
                    '<button id="off-ad-close2" class="modal-btn">关 闭</button>' +
                    '<button id="off-ad-reject" class="modal-btn danger">驳回</button>' +
                    '<button id="off-ad-approve" class="modal-btn primary">通过</button>';
                btns.querySelector('#off-ad-close2').addEventListener('click', function () {
                    $('off-audit-mask').classList.add('hidden');
                });
                btns.querySelector('#off-ad-approve').addEventListener('click', function () {
                    $('off-audit-mask').classList.add('hidden');
                    doAuditAct(id, true, '');
                });
                btns.querySelector('#off-ad-reject').addEventListener('click', function () {
                    $('off-audit-mask').classList.add('hidden');
                    openAuditReject(id);
                });
            } else {
                btns.innerHTML = '<button id="off-ad-close" class="modal-btn">关 闭</button>';
                btns.querySelector('#off-ad-close').addEventListener('click', function () {
                    $('off-audit-mask').classList.add('hidden');
                });
            }

            $('off-audit-mask').classList.remove('hidden');
        });
    }

    function openAuditReject(id) {
        _currentAuditId = id;
        $('off-rj-reason').value = '';
        $('off-audit-reject-mask').classList.remove('hidden');
        setTimeout(function () { $('off-rj-reason').focus(); }, 50);
    }

    function doAuditAct(id, approve, remark) {
        var path = '/admin/api/official/audit/' + id + '/' + (approve ? 'approve' : 'reject');
        var body = {};
        if (remark) body.remark = remark;
        api('POST', path, body).then(function (result) {
            if (!result || !result.ok) {
                showToast((result && result.msg) || '操作失败');
                return;
            }
            showToast(approve ? '已通过，消息进入发送队列' : '已驳回');
            loadAuditList(false);
            refreshPendingBadge();
        });
    }

    // ==================== 事件绑定 ====================

    function bindAll() {
        bindTabs();
        bindSeg();
        var refreshBtn = $('off-audit-refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', function () { loadAuditList(true); });
        var kwInput = $('off-audit-kw');
        if (kwInput) kwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadAuditList(false); });
        var stSel = $('off-audit-status');
        if (stSel) stSel.addEventListener('change', function () { loadAuditList(false); });

        // 驳回弹窗
        var cancelBtn = $('off-rj-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
            $('off-audit-reject-mask').classList.add('hidden');
        });
        var okBtn = $('off-rj-ok');
        if (okBtn) okBtn.addEventListener('click', function () {
            var reason = $('off-rj-reason').value.trim();
            if (!reason) { showToast('驳回必须填写原因'); return; }
            $('off-audit-reject-mask').classList.add('hidden');
            doAuditAct(_currentAuditId, false, reason);
        });
    }

    // ==================== 对外暴露 ====================

    window.loadOfficialAudit = function () {
        loadAuditList(true);
        refreshPendingBadge();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindAll);
    } else {
        bindAll();
    }

})();
