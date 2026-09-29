/* =========================================================================
 * 阶段二百二十四：拍摄相机页（微信同款自绘全屏相机，仅 APP 端入口）
 * -------------------------------------------------------------------------
 * 方案：纯 Web 链路——取景 getUserMedia、录像 MediaRecorder（与语音/视频通话
 * 共用 Capacitor WebView 的 onPermissionRequest 权限桥接，AndroidManifest 已有
 * CAMERA/RECORD_AUDIO，零新增原生插件、零配置改动；WEB/PC 因入口恒隐藏不受影响）。
 * 交互（微信同款）：点按快门=拍照、长按=录视频、录制中上滑取消、前后摄切换、
 * 闪光灯（torch 能力探测）、相册快捷入口；成片经预览确认后交由 chat.js 的
 * window.__imSendCameraFile 走既有图片/视频发送链路（零新协议）。
 * UI 约束：全自绘（无系统弹窗/系统滚动条）；语义色跟随主题变量（--primary）。
 * ========================================================================= */
(function () {
    'use strict';

    var T = (window.I18N && typeof window.I18N.t === 'function') ? function (s) { return window.I18N.t(s); } : function (s) { return s; };

    // ===== 常量（微信同款交互参数） =====
    var LONG_PRESS_MS = 450;  // 长按进入录像的判定时长（短于此松开=拍照）
    var REC_MAX_MS = 60000;   // 录像上限 60s（微信同款，到时自动收片）
    var CANCEL_PX = 80;       // 上滑取消位移阈值（与语音条上滑取消同量级）
    var PHOTO_LONG_EDGE = 1920; // 拍照长边上限（控制成片体积，上传链路友好）
    var RING_LEN = 301.6;     // 进度环周长 2πr（r=48）
    // 录像容器格式探测（依次回退；mp4 兼容性最优，webm 为 Chromium 兜底）
    var MIME_CANDS = [
        ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'mp4'],
        ['video/mp4', 'mp4'],
        ['video/webm;codecs=vp9,opus', 'webm'],
        ['video/webm;codecs=vp8,opus', 'webm'],
        ['video/webm', 'webm']
    ];

    // ===== 运行态 =====
    var page, video, flashLayer, torchBtn, recText, ringFg, cancelTip,
        pv, pvImg, pvVid, pvDur, toastEl;
    var stream = null;
    var state = 'closed';        // closed | viewfinder | recording | preview
    var facing = 'environment';  // 默认后摄（微信同款）
    var torchOn = false;
    var recorder = null, recChunks = [], recExt = 'webm', recCancelled = false;
    var recStartTs = 0, recTimer = null;
    var pressTimer = null, pressMoved = false, pressStartY = 0;
    var pendingBlob = null, pendingName = '', pendingUrl = '';
    var toastTimer = null;

    function $(id) { return document.getElementById(id); }

    // ===== 自绘 Toast（页内层级，避免全局 Toast 被黑色沉浸层覆盖） =====
    function toast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.classList.remove('hidden');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 1800);
    }

    // ===== 时间戳文件名（微信同款 IMG_/VID_ 前缀） =====
    function stamp() {
        var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
            p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    function fmtDur(ms) {
        var s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    // ===== DOM 构建（一次性；脚本于 body 尾加载，DOM 已就绪） =====
    function buildDom() {
        if (page) return;
        var wrap = document.createElement('div');
        wrap.innerHTML =
            '<div id="camera-page" class="camera-page hidden">' +
                '<video id="cam-video" autoplay playsinline muted></video>' +
                '<div class="cam-flash-layer"></div>' +
                '<div class="cam-topbar">' +
                    '<button id="cam-close" class="cam-ico-btn" aria-label="关闭"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
                    '<span style="flex:1"></span>' +
                    '<button id="cam-torch" class="cam-ico-btn hidden" aria-label="闪光灯"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 2v11h3v9l7-12h-4l4-8z"/></svg></button>' +
                '</div>' +
                '<div class="cam-cancel-tip"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="m12 4 7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z"/></svg>' + T('松开取消') + '</div>' +
                '<div class="cam-rec-timer"><span class="dot"></span><span id="cam-rec-text">0:00</span></div>' +
                '<div class="cam-bottom">' +
                    '<button id="cam-album" class="cam-side-btn" aria-label="相册"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M21 4H3a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zm-1 12.5-4.5-5-3.5 4-3-3.5L4 17.5V6h16v10.5zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg></button>' +
                    '<div class="cam-shutter-wrap">' +
                        '<svg class="cam-ring" viewBox="0 0 100 100"><circle class="cam-ring-bg" cx="50" cy="50" r="48"/><circle class="cam-ring-fg" id="cam-ring-fg" cx="50" cy="50" r="48"/></svg>' +
                        '<button id="cam-shutter" aria-label="快门"><span class="cam-shutter-core"></span></button>' +
                    '</div>' +
                    '<button id="cam-flip" class="cam-side-btn" aria-label="切换摄像头"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5 0 1-.3 1.94-.82 2.72l1.47 1.47A6.94 6.94 0 0 0 19 13c0-3.87-3.13-7-7-7zm0 12v3l4-4-4-4v3c-2.76 0-5-2.24-5-5 0-1 .3-1.94.82-2.72L6.35 7.81A6.94 6.94 0 0 0 5 13c0 3.87 3.13 7 7 7z"/></svg></button>' +
                '</div>' +
                '<div id="cam-preview" class="cam-preview hidden">' +
                    '<img id="cam-pv-img" class="cam-pv-media hidden" alt="">' +
                    '<video id="cam-pv-video" class="cam-pv-media hidden" autoplay loop muted playsinline></video>' +
                    '<div class="cam-pv-top"><button id="cam-pv-back" class="cam-ico-btn" aria-label="返回"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button><span id="cam-pv-dur" class="cam-pv-dur hidden"></span></div>' +
                    '<div class="cam-pv-bar">' +
                        '<button id="cam-pv-cancel" class="cam-pv-btn ghost">' + T('取消') + '</button>' +
                        '<button id="cam-pv-ok" class="cam-pv-btn ok">' + T('确认') + '</button>' +
                    '</div>' +
                '</div>' +
                '<div id="cam-toast" class="cam-toast hidden"></div>' +
            '</div>';
        document.body.appendChild(wrap.firstElementChild);
        page = $('camera-page');
        video = $('cam-video');
        flashLayer = page.querySelector('.cam-flash-layer');
        // WebView 经 innerHTML 注入的 muted 属性可能被忽略（Chromium 已知怪癖），显式置属性兜底
        video.muted = true;
        video.playsInline = true;
        pvVid = $('cam-pv-video');
        pvVid.muted = true;
        pvVid.playsInline = true;
        torchBtn = $('cam-torch');
        recText = $('cam-rec-text');
        ringFg = $('cam-ring-fg');
        pv = $('cam-preview');
        pvImg = $('cam-pv-img');
        pvVid = $('cam-pv-video');
        pvDur = $('cam-pv-dur');
        toastEl = $('cam-toast');

        // ---- 事件接线 ----
        $('cam-close').addEventListener('click', closeCamera);
        torchBtn.addEventListener('click', function () { setTorch(!torchOn); });
        $('cam-flip').addEventListener('click', flipCamera);
        $('cam-album').addEventListener('click', openAlbum);
        $('cam-pv-back').addEventListener('click', hidePreview);
        $('cam-pv-cancel').addEventListener('click', hidePreview);
        $('cam-pv-ok').addEventListener('click', confirmSend);
        bindShutter();
        // 长按屏蔽系统右键菜单/拖拽（微信同款无任何系统交互）
        page.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        page.addEventListener('dragstart', function (e) { e.preventDefault(); });
        // 页面切后台即收（释放摄像头，微信同款；避免后台占用相机）
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && page && !page.classList.contains('hidden')) closeCamera();
        });
    }

    // ===== 快门手势：点按拍照 / 长按录像 / 录制中上滑取消（微信同款） =====
    function bindShutter() {
        var shutter = $('cam-shutter');
        shutter.addEventListener('pointerdown', function (e) {
            if (state !== 'viewfinder') return;
            e.preventDefault();
            try { shutter.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败仅影响滑动手势 */ }
            pressStartY = e.clientY;
            pressMoved = false;
            pressTimer = setTimeout(function () {
                pressTimer = null;
                startRec();
            }, LONG_PRESS_MS);
        });
        shutter.addEventListener('pointermove', function (e) {
            var dy = pressStartY - e.clientY;
            if (state === 'recording') {
                var armed = dy > CANCEL_PX;
                page.classList.toggle('cancel-armed', armed);
                recCancelled = armed;
            } else if (pressTimer && dy > 12) {
                pressMoved = true; // 按下后明显滑动：松开不再判定为拍照
            }
        });
        function endPress() {
            if (pressTimer) { // 尚未进入录像 → 拍照（微信同款点按）
                clearTimeout(pressTimer);
                pressTimer = null;
                if (!pressMoved && state === 'viewfinder') takePhoto();
                return;
            }
            if (state === 'recording') stopRec(); // 松开收片
        }
        shutter.addEventListener('pointerup', endPress);
        shutter.addEventListener('pointercancel', function () {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; return; }
            if (state === 'recording') stopRec();
        });
    }

    // ===== 相机流生命周期 =====
    function openStream() {
        closeStreamOnly();
        video.classList.remove('live');
        var withAudio = true; // 先带麦请求（录像需要）；麦克风被拒时降级纯视频重试
        var tryGet = function () {
            return navigator.mediaDevices.getUserMedia({
                audio: withAudio,
                video: {
                    facingMode: { ideal: facing }, // ideal 而非 exact：桌面/模拟器无多摄不抛 OverconstrainedError
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            }).catch(function (err) {
                if (withAudio) { withAudio = false; return tryGet(); }
                throw err;
            });
        };
        tryGet().then(function (s) {
            stream = s;
            video.srcObject = s;
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* 自动播放被拦时首帧仍显示 */ });
            video.classList.add('live');
            probeTorch();
        }).catch(function (err) {
            toast(err && err.name === 'NotAllowedError' ? T('相机权限被拒绝，请在系统设置中开启') : T('无法访问相机'));
            closeCamera();
        });
    }

    function closeStreamOnly() {
        if (stream) {
            for (var i = 0; i < stream.getTracks().length; i++) {
                try { stream.getTracks()[i].stop(); } catch (e) { /* 轨道已止则忽略 */ }
            }
            stream = null;
        }
        try { video.pause(); } catch (e) { /* 未起播则忽略 */ }
        video.srcObject = null;
    }

    function probeTorch() {
        var caps = null;
        try {
            var track = stream && stream.getVideoTracks()[0];
            caps = (track && track.getCapabilities) ? track.getCapabilities() : null;
        } catch (e) { /* 能力查询失败按不支持处理 */ }
        torchBtn.classList.toggle('hidden', !(caps && caps.torch));
        torchOn = false;
        torchBtn.classList.remove('active');
    }

    function setTorch(on) {
        var track = stream && stream.getVideoTracks()[0];
        if (!track) return;
        track.applyConstraints({ advanced: [{ torch: !!on }] }).then(function () {
            torchOn = !!on;
            torchBtn.classList.toggle('active', torchOn);
        }).catch(function () {
            toast(T('此设备不支持闪光灯'));
        });
    }

    function flipCamera() {
        if (state !== 'viewfinder') return;
        facing = facing === 'environment' ? 'user' : 'environment';
        page.classList.toggle('front', facing === 'user');
        openStream(); // 换摄即重开流（轨道更换，闪光灯状态随之复位）
    }

    // ===== 拍照：canvas 抓帧 → JPEG → 预览确认 =====
    function takePhoto() {
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) { toast(T('相机未就绪，请稍候')); return; }
        var scale = Math.min(1, PHOTO_LONG_EDGE / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        var ctx = c.getContext('2d');
        if (facing === 'user') { // 前摄镜像成片（与预览一致，微信同款）
            ctx.translate(c.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, c.width, c.height);
        // 白闪反馈（微信同款快门观感）
        flashLayer.classList.remove('on');
        void flashLayer.offsetWidth;
        flashLayer.classList.add('on');
        c.toBlob(function (blob) {
            if (!blob) { toast(T('拍照失败，请重试')); return; }
            showPreview('image', blob, 'IMG_' + stamp() + '.jpg', 0);
        }, 'image/jpeg', 0.92);
    }

    // ===== 录像：MediaRecorder → 容器探测 → 预览确认 =====
    function pickMime() {
        if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
        for (var i = 0; i < MIME_CANDS.length; i++) {
            try { if (MediaRecorder.isTypeSupported(MIME_CANDS[i][0])) return MIME_CANDS[i]; } catch (e) { /* 探测失败试下一个 */ }
        }
        return null;
    }

    function startRec() {
        if (state !== 'viewfinder') return;
        if (typeof MediaRecorder === 'undefined') { toast(T('此设备不支持录像')); return; }
        var mime = pickMime();
        try {
            recorder = mime ? new MediaRecorder(stream, { mimeType: mime[0] }) : new MediaRecorder(stream);
            recExt = mime ? mime[1] : 'webm';
        } catch (e) {
            toast(T('录像启动失败'));
            return;
        }
        recChunks = [];
        recCancelled = false;
        recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) recChunks.push(ev.data); };
        recorder.onstop = function () {
            clearInterval(recTimer);
            recTimer = null;
            page.classList.remove('recording', 'cancel-armed');
            var dur = Date.now() - recStartTs;
            var cancelled = recCancelled;
            var chunks = recChunks;
            recorder = null;
            state = 'viewfinder';
            if (cancelled) { toast(T('已取消')); return; }
            if (dur < 500) { toast(T('录制时间太短')); return; }
            var blob = new Blob(chunks, { type: (mime ? mime[0] : 'video/webm') });
            showPreview('video', blob, 'VID_' + stamp() + '.' + recExt, dur);
        };
        recorder.start(200); // 200ms 分片：松开即时可用，进度平滑
        recStartTs = Date.now();
        recText.textContent = '0:00';
        ringFg.style.strokeDashoffset = RING_LEN;
        state = 'recording';
        page.classList.add('recording');
        recTimer = setInterval(function () {
            var el = Date.now() - recStartTs;
            recText.textContent = fmtDur(el);
            ringFg.style.strokeDashoffset = Math.max(0, RING_LEN * (1 - el / REC_MAX_MS));
            if (el >= REC_MAX_MS) stopRec(); // 60s 上限自动收片（微信同款）
        }, 100);
    }

    function stopRec() {
        if (!recorder) return;
        try { recorder.stop(); } catch (e) { /* 已停止则忽略 */ }
    }

    // 强制终止录像（关页等场景：不触发预览，直接丢弃）
    function killRec() {
        if (recorder) {
            recorder.onstop = null;
            recorder.ondataavailable = null;
            try { recorder.stop(); } catch (e) { /* 已停止则忽略 */ }
            recorder = null;
        }
        if (recTimer) { clearInterval(recTimer); recTimer = null; }
        page.classList.remove('recording', 'cancel-armed');
    }

    // ===== 成片预览（确认 / 重拍 / 取消） =====
    function showPreview(kind, blob, name, durMs) {
        pendingBlob = blob;
        pendingName = name;
        if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = ''; }
        pendingUrl = URL.createObjectURL(blob);
        if (kind === 'image') {
            pvImg.src = pendingUrl;
            pvImg.classList.remove('hidden');
            pvVid.classList.add('hidden');
            try { pvVid.pause(); } catch (e) { /* 未起播则忽略 */ }
        } else {
            pvVid.src = pendingUrl;
            pvVid.classList.remove('hidden');
            pvImg.classList.add('hidden');
            var pp = pvVid.play();
            if (pp && pp.catch) pp.catch(function () { /* 自动播放策略拦截时静默 */ });
        }
        pvDur.textContent = kind === 'video' ? fmtDur(durMs) : '';
        pvDur.classList.toggle('hidden', kind !== 'video');
        state = 'preview';
        pv.classList.remove('hidden');
    }

    function hidePreview() {
        pv.classList.add('hidden');
        pvImg.classList.add('hidden');
        pvVid.classList.add('hidden');
        try { pvVid.pause(); pvVid.removeAttribute('src'); pvVid.load(); } catch (e) { /* 未起播则忽略 */ }
        if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = ''; }
        pendingBlob = null;
        state = 'viewfinder';
    }

    function confirmSend() {
        if (!pendingBlob || !pendingName) return;
        var file;
        try {
            file = new File([pendingBlob], pendingName, { type: pendingBlob.type });
        } catch (e) { // 老内核 File 构造兜底
            file = new Blob([pendingBlob], { type: pendingBlob.type });
            file.name = pendingName;
        }
        // 清理后关页，再交由 chat.js 既有链路发送（会话归属以其为准）
        var send = window.__imSendCameraFile;
        closeCamera();
        if (typeof send === 'function') send(file);
        else toast(T('发送组件未就绪'));
    }

    // ===== 相册快捷入口（复用既有图片选择链路：先收相机再弹选择，避免占用） =====
    function openAlbum() {
        closeCamera();
        setTimeout(function () {
            var ii = document.getElementById('image-input');
            if (ii) ii.click();
        }, 240);
    }

    // ===== 开/关页 =====
    function openCamera() {
        buildDom();
        if (state !== 'closed') return; // 已开防重入
        state = 'viewfinder';
        facing = 'environment';
        page.classList.remove('front', 'recording', 'cancel-armed');
        torchOn = false;
        torchBtn.classList.add('hidden');
        torchBtn.classList.remove('active');
        pv.classList.add('hidden');
        page.classList.remove('hidden');
        openStream();
    }

    function closeCamera() {
        if (!page) return;
        killRec();
        closeStreamOnly();
        if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = ''; }
        pendingBlob = null;
        pv.classList.add('hidden');
        page.classList.add('hidden');
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        torchOn = false;
        state = 'closed';
    }

    // ===== 入口接线：工具栏 camera-btn（仅 APP 端可见，chat.js 显隐归口） =====
    var camBtn = document.getElementById('camera-btn');
    if (camBtn) camBtn.addEventListener('click', openCamera);

    // 调试/扩展挂载（与 IMDrive 等模块同风格全局暴露）
    window.IMCamera = { open: openCamera, close: closeCamera };
})();
