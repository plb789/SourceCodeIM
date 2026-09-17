// editor-page.js - 截图编辑器独立窗口桥接层（web/editor.html 专属，阶段一百四十）
// 承载方式：编辑器从主窗体迁出为独立 BrowserWindow（与图片查看器/长截图条窗同款方案）。
// 主进程推送编辑任务（editor:load {dataUrl, mode, callback}）→ 本页 dataURL 转 blob 喂给
// ScreenshotEditor（screenshot.js 零改动复用）；确认/取消经主进程转回主窗口渲染层分发：
//   freeze 模式：完成→裁剪图进待发送条（callback=pending）；选区后可点长截图移交主窗口状态机
//   open   模式：完成→直接走发送链路（callback=sendFile）
//   record 模式：倒计时结束→主窗口录屏链路（editor:rec-start）
(function () {
    'use strict';
    // 主题跟随：与主窗口同 origin 共享 localStorage（chat.js 键 im_theme：light/dark/system），
    // style.css 按 html[data-theme] 切换变量；system 模式由 CSS 媒体查询分支自行判定深浅
    try {
        var t = localStorage.getItem('im_theme') || 'light';
        document.documentElement.setAttribute('data-theme', t);
    } catch (err) { /* localStorage 不可用时保持默认浅色 */ }

    var settled = false;     // 本任务是否已终结（确认/取消/移交只发一次，防 close 与 confirm 双发）
    var confirming = false;  // 确认回调已同步进入（screenshot.js output 先 close 后 confirmCb 同 tick 顺序，见 requestCancel）
    var pendingCancel = 0;   // 取消延迟器（确认发送时 close 先于 confirm 触发 onClose，延时一拍让 confirm 反悔）

    // dataURL → Blob（与 chat.js dataUrlToBlob 同源：编辑器与发送链路均收 Blob）
    function dataUrlToBlob(dataUrl) {
        try {
            var arr = dataUrl.split(',');
            var mime = arr[0].match(/:(.*?);/)[1];
            var bin = atob(arr[1]);
            var buf = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            return Promise.resolve(new Blob([buf], { type: mime }));
        } catch (e) {
            return Promise.resolve(null);
        }
    }

    // Blob → dataURL（跨窗口回传必须 dataURL，objectURL 不跨渲染进程；arrayBuffer+btoa 分块拼接
    // 防 String.fromCharCode.apply 栈溢出，不用 FileReader——PptxViewJS 对 window.FileReader 的
    // 污染是全局永久的，chat.js stitchBlobToDataUrl 同款规避）
    function blobToDataUrl(blob, cb) {
        if (!blob) { cb(null); return; }
        blob.arrayBuffer().then(function (buf) {
            var bytes = new Uint8Array(buf);
            var bin = '';
            var CH = 0x8000;
            for (var i = 0; i < bytes.length; i += CH) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            }
            cb('data:image/png;base64,' + btoa(bin));
        }).catch(function () { cb(null); });
    }

    // 任务终结（幂等）：kind='done' 带裁剪结果回主窗口分发；'cancel' 通知主进程恢复主窗口
    function settle(kind, dataUrl) {
        if (settled) return;
        settled = true;
        if (kind === 'done' && window.desktop && window.desktop.editorDone) {
            window.desktop.editorDone(dataUrl);
        } else if (window.desktop && window.desktop.editorCancel) {
            window.desktop.editorCancel();
        }
    }

    // 取消（Esc/取消按钮/右键关闭统一入口）：延时一拍——screenshot.js 的 output() 确认时先 close()
    // 后 confirmCb（同步同 tick），onClose 先触发会把"确认"误判成"取消"；confirming 在 confirmCb
    // 同步进入时置位，定时器到点必须复查（实测踩坑：调度时 confirming 尚未置位，blob→dataURL 的
    // arrayBuffer 是真实异步任务，0ms 定时器可能抢先 settle('cancel') 把确认结果当取消丢弃——
    // 到点复查 confirming 才能放行确认语义，发送优先）
    function requestCancel() {
        if (settled || confirming || pendingCancel) return;
        pendingCancel = setTimeout(function () {
            pendingCancel = 0;
            if (confirming) return; // 确认回调已进入：跳过取消（done 链路稍后经 settle('done') 回传）
            settle('cancel');
        }, 0);
    }

    // 接收编辑任务（主进程在窗口加载完成后或复用窗口时推送）
    if (window.desktop && window.desktop.onEditorLoad) {
        window.desktop.onEditorLoad(function (data) {
            if (!data || !data.dataUrl) { settle('cancel'); return; }
            settled = false;
            confirming = false;
            if (pendingCancel) { clearTimeout(pendingCancel); pendingCancel = 0; }
            var mode = data.mode || 'freeze';
            dataUrlToBlob(data.dataUrl).then(function (blob) {
                if (settled) return; // 解码期间已被新任务/取消终结
                if (!blob) { settle('cancel'); return; }
                // 确认完成统一出口：先同步置位 confirming（screenshot.js output 的 close→confirmCb
                // 同 tick 顺序下 requestCancel 的取消定时器据此跳过），再异步转 dataURL 回传
                var done = function (outBlob) {
                    confirming = true;
                    blobToDataUrl(outBlob, function (du) { settle('done', du); });
                };
                if (mode === 'open') {
                    // 编辑器模式：窗口式居中缩放，默认全图选区（粘贴/截图按钮 open 链路）
                    // requestCancel=取消回调（Esc/工具栏取消按钮/右键关闭统一走 close→onCloseCb→
                    // settle('cancel')→editorCancel→主进程藏编辑器窗恢复主窗口；实测踩坑：未注入时
                    // close 只清画布，BrowserWindow 残留显示空白，表现为"点取消没关窗口只是图没了"）
                    ScreenshotEditor.open(blob, done, requestCancel);
                } else if (mode === 'record') {
                    // 录屏选区：选区交互复用冻结态，工具栏切换为 开始录制/取消；3-2-1 倒计时结束自动关闭并回调
                    ScreenshotEditor.freezeVideo(blob, {
                        onStart: function (sel, snapW, snapH) {
                            // 倒计时结束：主进程隐藏编辑器窗口并转主窗口录屏链路（退场→屏幕流→裁剪录制）
                            settled = true; // 选区移交即终结（录制收尾由主窗口链路负责，不再走 done/cancel）
                            if (window.desktop && window.desktop.editorRecStart) {
                                window.desktop.editorRecStart(sel, snapW, snapH);
                            }
                        },
                        onCancel: function () { settle('cancel'); }
                    });
                } else {
                    // 冻结模式：画面铺满窗口视口（窗口=全屏置顶，视觉=屏幕被冻结），拖拽框选 → 标注 → 完成
                    ScreenshotEditor.freeze(blob, done, requestCancel, function () {
                        // 首帧绘制就绪：通知主进程揭幕（此刻才 show 全屏窗口，第一帧即冻结画面无底色闪现）
                        if (window.desktop && window.desktop.editorReady) window.desktop.editorReady();
                    }, function (sel, snapW, snapH) {
                        // 长截图移交：选区坐标为冻结底图物理像素，主进程转主窗口长截图状态机
                        settled = true; // 移交即终结（完成/取消由长截图链路收尾，不走 done/cancel）
                        if (window.desktop && window.desktop.editorStitch) {
                            window.desktop.editorStitch(sel, snapW, snapH);
                        }
                    });
                }
            });
        });
    }
})();
