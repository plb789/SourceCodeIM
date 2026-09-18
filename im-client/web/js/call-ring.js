/* ===== 阶段一百四十一：来电响铃条逻辑（微信同款顶部小条） =====
   职责：来电展示（头像/昵称/邀请文案）+ 合成振铃音 + 接听/拒绝动作上报 + 超时/取消自收口。
   信令归口：接受/拒绝由主窗口 chat.js 发 reject/开通话窗；本页只上报动作不直接发信令。
   铃声收口三通道：按钮点击（自身停）/ 主进程 call:ring:stop 推送（窗口被隐藏时页面无法自感知）/
   60s 自兜底（信令丢失场景，正常由服务端 timeout 归口） */
(function () {
    'use strict';
    var d = window.desktop || {};

    var cur = null;          // 当前来电 {call_id, from, from_name, from_avatar, call_type}
    var timeoutId = null;    // 60s 自兜底计时器

    var $ = function (id) { return document.getElementById(id); };
    var elAvatar = $('rgAvatar'), elName = $('rgName'), elDesc = $('rgDesc');
    var btnAccept = $('btnAccept'), btnDecline = $('btnDecline');
    var icoAudio = $('icoAudio'), icoVideo = $('icoVideo');

    // ===== 合成振铃音（WebAudio，零资源文件：双音"叮咚"脉冲，每 2.2s 一轮） =====
    var actx = null, ringTimer = null;
    function ringStart() {
        ringStop();
        try {
            if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
            if (actx.state === 'suspended') actx.resume();
            var beep = function () {
                var t0 = actx.currentTime;
                // 双音序列：880Hz 短脉冲 + 660Hz 长脉冲（音量包络防爆音）
                [[880, 0, 0.16], [660, 0.2, 0.42]].forEach(function (seg) {
                    var o = actx.createOscillator();
                    var g = actx.createGain();
                    o.frequency.value = seg[0];
                    g.gain.setValueAtTime(0.0001, t0 + seg[1]);
                    g.gain.exponentialRampToValueAtTime(0.16, t0 + seg[1] + 0.02);
                    g.gain.exponentialRampToValueAtTime(0.0001, t0 + seg[1] + seg[2]);
                    o.connect(g); g.connect(actx.destination);
                    o.start(t0 + seg[1]);
                    o.stop(t0 + seg[1] + seg[2] + 0.02);
                });
            };
            beep();
            ringTimer = setInterval(beep, 2200);
        } catch (e) { }
    }
    function ringStop() {
        if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    }

    // ===== 自收口（停铃 + 上报主进程隐藏窗口） =====
    function hideSelf() {
        ringStop();
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        cur = null;
        d.callRingSelfHide && d.callRingSelfHide();
    }

    // ===== 60s 自兜底（正常由服务端 timeout → 主窗口清铃归口，此处防信令丢失） =====
    function armTimeout() {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(function () {
            timeoutId = null;
            if (cur) hideSelf();
        }, 60000);
    }

    // ===== 来电展示 =====
    function letterAvatar() {
        elAvatar.innerHTML = '';
        var ph = document.createElement('div');
        ph.className = 'rg-avatar-ph';
        ph.textContent = ((cur && (cur.from_name || cur.from)) || '?').charAt(0).toUpperCase();
        elAvatar.appendChild(ph);
    }
    function fillProfile() {
        elName.textContent = cur.from_name || cur.from || '';
        // 会议来电（阶段一百四十四）：meet 标记显示会议文案，图标按类型仍切听筒/摄像头
        elDesc.textContent = cur.meet
            ? (cur.call_type === 'video' ? '邀请你加入视频会议' : '邀请你加入语音会议')
            : (cur.call_type === 'video' ? '邀请你视频通话' : '邀请你语音通话');
        // 接听钮图标按类型切换：语音=听筒 / 视频=摄像头
        icoAudio.classList.toggle('hidden', cur.call_type === 'video');
        icoVideo.classList.toggle('hidden', cur.call_type !== 'video');
        if (cur.from_avatar) {
            elAvatar.innerHTML = '';
            var img = document.createElement('img');
            img.src = cur.from_avatar;
            img.onerror = letterAvatar;
            elAvatar.appendChild(img);
        } else {
            letterAvatar();
        }
    }

    // ===== 来电推送（每次展示重置 UI 与计时，窗口为常驻单例复用） =====
    d.onRingShow(function (data) {
        if (!data || !data.call_id) return;
        cur = data;
        fillProfile();
        ringStart();
        armTimeout();
    });

    // ===== 主进程停铃推送（窗口被接听/拒绝/超时/取消等路径隐藏时触发） =====
    if (d.onRingStop) {
        d.onRingStop(function () {
            ringStop();
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            cur = null;
        });
    }

    // ===== 信令兜底（主进程仅响铃条可见时转发；cancel/timeout/dismiss 自收口） =====
    if (d.onCallSignal) {
        d.onCallSignal(function (frame) {
            if (!frame || !cur) return;
            var p;
            try { p = JSON.parse(frame.content); } catch (e) { return; }
            if (!p || p.call_id !== cur.call_id) return;
            if (p.action === 'cancel' || p.action === 'timeout' || p.action === 'dismiss') hideSelf();
        });
    }

    // ===== 按钮动作上报（接受/拒绝语义由主窗口 chat.js 归口处理） =====
    btnAccept.addEventListener('click', function () {
        if (!cur) return;
        ringStop();
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        d.callRingAction && d.callRingAction({ action: 'accept', call_id: cur.call_id });
        cur = null;
    });
    btnDecline.addEventListener('click', function () {
        if (!cur) return;
        ringStop();
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        d.callRingAction && d.callRingAction({ action: 'decline', call_id: cur.call_id });
        cur = null;
    });
})();
