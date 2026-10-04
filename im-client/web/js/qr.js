/**
 * qr.js —— 二维码名片与扫一扫（阶段二百一十）
 *
 * 职责与归口：
 *   1. 我的二维码名片：qrcode-generator（js/lib）把 im://u/<账号> 绘制成二维码，
 *      名片数据（头像/昵称/账号）从个人资料面板 DOM 读取，零数据复制；
 *   2. 扫一扫：getUserMedia 后摄取景 + jsQR 解码循环；解析出 im://u/ 协议码后
 *      调 chat.js 既有"添加好友"弹窗与查询链路（window.__imAddFriendByCode），
 *      非本应用二维码仅提示，不做任何跳转；
 *   3. 入口：PC/WEB 个人资料面板"二维码名片"按钮 + 移动端个人页功能卡转发 +
 *      首页「+」菜单"扫一扫"条目（data-target 转发到隐藏锚点 #scan-entry）。
 *
 * PC/WEB 无摄像头场景打开扫码仅提示不支持；移动 APP 已具备 CAMERA 权限链路。
 */
(function () {
    'use strict';

    var PROTOCOL = 'im://u/';
    var scanStream = null;
    var scanRaf = null;

    /* ---------- 通用提示：归口 chat.js 全局 toast（阶段二百四十一：统一过 I18N.t，英文模式显示对应译文） ---------- */
    function toast(msg) {
        if (window.__imToast) window.__imToast(window.I18N ? I18N.t(msg) : msg);
    }

    /* ---------- 1. 我的二维码名片 ---------- */
    // 当前账号：优先信令层（不依赖资料面板是否打开过），兜底资料面板 DOM
    function currentAccount() {
        if (window.IMSocket && typeof IMSocket.getUsername === 'function') {
            var u = (IMSocket.getUsername() || '').trim();
            if (u) return u;
        }
        var acc = document.getElementById('profile-username');
        return acc ? acc.textContent.trim() : '';
    }

    function fillCard() {
        var av = document.getElementById('profile-avatar');
        var ph = document.getElementById('profile-avatar-ph');
        var cardAv = document.getElementById('qr-card-avatar');
        var cardPh = document.getElementById('qr-card-avatar-ph');
        if (av && av.style.display !== 'none' && av.src) {
            cardAv.src = av.src;
            cardAv.style.display = '';
            cardPh.style.display = 'none';
        } else {
            cardAv.style.display = 'none';
            cardAv.removeAttribute('src');
            cardPh.style.display = '';
            cardPh.textContent = ph ? ph.textContent : '';
        }
        var nick = document.getElementById('profile-nickname');
        var account = currentAccount();
        document.getElementById('qr-card-name').textContent = (nick && nick.value) || account;
        document.getElementById('qr-card-id').textContent = I18N.t('账号：') + account;

        var box = document.getElementById('qr-code-box');
        box.innerHTML = '';
        if (!account || typeof window.qrcode !== 'function') return;
        var qr = window.qrcode(0, 'M');
        qr.addData(PROTOCOL + account);
        qr.make();
        // 注意：createImgTag 返回 HTML 字符串（非元素），须 innerHTML 注入后再补 alt
        box.innerHTML = qr.createImgTag(6, 8); // 模块 6px、留白 8 模块，微信名片同款大码
        var img = box.querySelector('img');
        if (img) img.alt = '我的二维码';
    }

    function showCard() {
        fillCard();
        var m = document.getElementById('qr-card-mask');
        if (m) m.classList.remove('hidden');
    }

    function hideCard() {
        var m = document.getElementById('qr-card-mask');
        if (m) m.classList.add('hidden');
    }

    /* ---------- 2. 扫一扫 ---------- */
    function stopScan() {
        if (scanRaf) { cancelAnimationFrame(scanRaf); scanRaf = null; }
        if (scanStream) {
            scanStream.getTracks().forEach(function (t) { t.stop(); });
            scanStream = null;
        }
        var v = document.getElementById('qr-video');
        if (v) {
            v.srcObject = null;
            v.classList.remove('live');
        }
    }

    function closeScanner() {
        stopScan();
        var m = document.getElementById('qr-scan-mask');
        if (m) m.classList.add('hidden');
    }

    // 阶段二百一十九：切后台/回桌面自动释放摄像头（微信同款离开即停）——
    // 否则流持续占用，下次扫码触发系统"相机被占用"弹窗，且页面回到前台时
    // 扫码视图与死流状态错乱
    document.addEventListener('visibilitychange', function () {
        if (document.hidden && scanStream) closeScanner();
    });

    function scanLoop(video) {
        var canvas = document.getElementById('qr-scan-canvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        function tick() {
            if (!scanStream) return;
            if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
                if (code && code.data) {
                    closeScanner();
                    handleResult(code.data);
                    return;
                }
            }
            scanRaf = requestAnimationFrame(tick);
        }
        scanRaf = requestAnimationFrame(tick);
    }

    function openScanner() {
        var mask = document.getElementById('qr-scan-mask');
        if (!mask) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast('当前环境不支持扫码');
            return;
        }
        // 阶段二百一十九：幂等清残留——上次扫码流未释放（切后台/系统强断）时先停干净，
        // 避免 vivo 等系统弹"相机被占用"且新流失败导致"点了没反应"
        if (scanStream) stopScan();
        mask.classList.remove('hidden');
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
            scanStream = stream;
            var v = document.getElementById('qr-video');
            // 首帧就绪才淡入（loadeddata = 首帧已解码；400ms 兜底幂等）——
            // visibility 切换瞬间原生层无首帧会闪现默认播放器海报
            var shown = false;
            var showFrame = function () {
                if (shown) return;
                shown = true;
                v.classList.add('live');
            };
            v.addEventListener('loadeddata', showFrame, { once: true });
            setTimeout(showFrame, 400);
            v.srcObject = stream;
            v.setAttribute('playsinline', 'true');
            v.play();
            scanLoop(v);
            // 系统强断流自愈（用户在 vivo 弹窗点"关闭"等）：自动收起扫码视图并提示
            var vt = stream.getVideoTracks()[0];
            if (vt && vt.addEventListener) {
                vt.addEventListener('ended', function () {
                    if (scanStream === stream) {
                        closeScanner();
                        toast('相机已断开');
                    }
                });
            }
        }).catch(function () {
            closeScanner();
            toast('无法打开摄像头');
        });
    }

    function handleResult(data) {
        if (typeof data !== 'string' || !data) {
            toast('未识别的二维码');
            return;
        }
        // 阶段二百四十：扫码登录分支——识别 PC/WEB 登录页二维码（/qrl?t=<qr_id> 链接），
        // 命中后走手机端确认授权流程（showQrLoginConfirm）
        var qid = parseQrLoginUrl(data);
        if (qid) {
            handleQRLoginScan(qid);
            return;
        }
        if (data.indexOf(PROTOCOL) !== 0) {
            toast('未识别的二维码');
            return;
        }
        var u = data.slice(PROTOCOL.length).trim();
        if (!u) { toast('二维码内容为空'); return; }
        // 扫到自己的码：账号归口信令层（扫码场景资料面板未必打开过）
        var me = (window.IMSocket && typeof IMSocket.getUsername === 'function') ? (IMSocket.getUsername() || '').trim() : '';
        if (me && me === u) { toast('这是你自己的二维码'); return; }
        if (typeof window.__imAddFriendByCode === 'function') {
            window.__imAddFriendByCode(u); // 归口 chat.js 既有添加好友弹窗+查询链路
        } else {
            toast('添加好友功能未就绪');
        }
    }

    /* ---------- 2.5 扫码登录确认（阶段二百四十：PC/WEB 登录页二维码 → 手机确认授权） ---------- */
    var qrLoginPendingId = ''; // 在途确认的二维码 ID（回执匹配 + 按钮 action 归口）

    // parseQrLoginUrl 识别登录码链接（https://<域名>/qrl?t=<qr_id>），非登录码返回空串
    function parseQrLoginUrl(data) {
        try {
            var u = new URL(data);
            if (u.pathname === '/qrl') {
                return (u.searchParams.get('t') || '').trim();
            }
        } catch (e) { /* 非标准 URL（协议串等）按非登录码处理 */ }
        return '';
    }

    // handleQRLoginScan 发起扫描上报（97 scan）——回执 ok 后弹确认授权卡
    function handleQRLoginScan(qrId) {
        var me = (window.IMSocket && typeof IMSocket.getUsername === 'function') ? (IMSocket.getUsername() || '').trim() : '';
        if (!me) { toast('请先登录后再扫码'); return; }
        qrLoginPendingId = qrId;
        var sent = IMSocket.send({
            msg_type: IMSocket.MSG.QR_SIGN,
            from_user: me,
            content: JSON.stringify({ action: 'scan', qr_id: qrId })
        });
        if (!sent) toast('连接未就绪，请稍后重试');
    }

    // showQrLoginConfirm 弹出微信同款授权卡（头像/昵称取当前登录账号，端别文案服务端下发）
    function showQrLoginConfirm(platform) {
        var mask = document.getElementById('qr-login-mask');
        if (!mask) return;
        // 头像归口左上角当前账号头像（与名片同款降级链路：无头像/加载失败显示首字母占位）
        var av = document.getElementById('current-avatar');
        var ph = document.getElementById('current-avatar-ph');
        var dlgAv = document.getElementById('qr-login-avatar');
        var dlgPh = document.getElementById('qr-login-avatar-ph');
        if (av && av.style.display !== 'none' && av.src) {
            dlgAv.src = av.src;
            // 关键：CSS 中 .qr-login-avatar 默认为 display:none，置空串会回落到样式表导致头像不显示（黑圈），必须显式 block
            dlgAv.style.display = 'block';
            dlgPh.style.display = 'none';
        } else {
            dlgAv.style.display = 'none';
            dlgAv.removeAttribute('src');
            dlgPh.style.display = '';
            dlgPh.textContent = ph ? ph.textContent : '';
        }
        var nick = document.getElementById('profile-nickname');
        var account = (window.IMSocket && typeof IMSocket.getUsername === 'function') ? (IMSocket.getUsername() || '').trim() : '';
        document.getElementById('qr-login-name').textContent = (nick && nick.value) || account;
        document.getElementById('qr-login-platform').textContent = I18N.t(platform === 'pc' ? '电脑' : '网页');
        document.getElementById('qr-login-ok').disabled = false;
        mask.classList.remove('hidden');
    }

    function hideQrLoginConfirm() {
        var mask = document.getElementById('qr-login-mask');
        if (mask) mask.classList.add('hidden');
        qrLoginPendingId = '';
    }

    // 97 号回执监听（服务端 scan/confirm/cancel 应答归口；纯信令帧不落库不转发）
    if (window.IMSocket && IMSocket.on) {
        IMSocket.on(IMSocket.MSG.QR_SIGN, function (msg) {
            // 阶段二百四十修复：服务端回执字段在帧顶层（{msg_type:97, action, ok, reason?, platform?}），
            // content 为空串——原实现按 content JSON 解析，JSON.parse('') 抛异常静默 return，
            // 回执被整体丢弃，手机扫码后确认授权卡永远不弹出（实测复现）
            var action = msg.action;
            if (action === 'scan') {
                if (msg.ok) {
                    showQrLoginConfirm(msg.platform);
                } else {
                    qrLoginPendingId = '';
                    toast(msg.reason || '扫码失败，请重新扫描');
                }
            } else if (action === 'confirm') {
                if (msg.ok) {
                    toast('已确认，请在电脑上查看');
                    hideQrLoginConfirm();
                } else {
                    toast(msg.reason || '确认失败');
                    var okBtn = document.getElementById('qr-login-ok');
                    if (okBtn) okBtn.disabled = false;
                }
            } else if (action === 'cancel') {
                hideQrLoginConfirm();
            }
        });
    }

    /* ---------- 3. 入口绑定（DOM 就绪后） ---------- */
    document.addEventListener('DOMContentLoaded', function () {
        var entry = document.getElementById('qr-card-entry');       // PC/WEB 资料面板按钮
        if (entry) entry.addEventListener('click', showCard);
        var scanAnchor = document.getElementById('scan-entry');     // 移动端「+」菜单转发锚点
        if (scanAnchor) scanAnchor.addEventListener('click', openScanner);
        var close1 = document.getElementById('qr-card-close');
        if (close1) close1.addEventListener('click', hideCard);
        var mask = document.getElementById('qr-card-mask');
        if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) hideCard(); });
        var close2 = document.getElementById('qr-scan-cancel');
        if (close2) close2.addEventListener('click', closeScanner);
        var scanMask = document.getElementById('qr-scan-mask');
        if (scanMask) scanMask.addEventListener('click', function (e) { if (e.target === scanMask) closeScanner(); });
        // 阶段二百四十：扫码登录确认弹窗按钮（取消=上报 cancel 回退待扫描态；确认=上报 confirm 授权登录）
        var qlOk = document.getElementById('qr-login-ok');
        var qlCancel = document.getElementById('qr-login-cancel');
        if (qlOk) qlOk.addEventListener('click', function () {
            if (!qrLoginPendingId) return;
            qlOk.disabled = true; // 防连点：等服务端回执后关弹窗或复位按钮
            IMSocket.send({
                msg_type: IMSocket.MSG.QR_SIGN,
                from_user: (IMSocket.getUsername() || '').trim(),
                content: JSON.stringify({ action: 'confirm', qr_id: qrLoginPendingId })
            });
        });
        if (qlCancel) qlCancel.addEventListener('click', function () {
            if (qrLoginPendingId) {
                IMSocket.send({
                    msg_type: IMSocket.MSG.QR_SIGN,
                    from_user: (IMSocket.getUsername() || '').trim(),
                    content: JSON.stringify({ action: 'cancel', qr_id: qrLoginPendingId })
                });
            }
            hideQrLoginConfirm();
        });
    });

    window.IMQR = { showCard: showCard, openScanner: openScanner };
})();
