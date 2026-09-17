// screenshot.js - 截图编辑器模块（阶段三十五：第一期）
// 功能：接收底图（blob/File），全屏遮罩展示，支持选区裁剪 + 矩形/椭圆/箭头/画笔/文字/马赛克标注 + 撤销，
//       确认后按选区裁剪输出 PNG blob，由 chat.js 走既有图片上传链路发送（服务端零改动）
// 对外接口：window.ScreenshotEditor.open(blob, onConfirm) / isOpen()
(function () {
    // ===== DOM 元素（惰性创建，全局仅一份） =====
    var editorEl = null, wrapEl = null, toolbarEl = null, textInputEl = null;
    var baseCanvas = null, drawCanvas = null, maskCanvas = null;
    var hintEl = null;         // 冻结态操作提示条（自绘，禁止系统弹窗）
    var bctx = null, dctx = null, mctx = null;

    // ===== 编辑器状态 =====
    var img = null;            // 底图 Image 对象
    var imgW = 0, imgH = 0;    // 原图尺寸（画布坐标系）
    var scale = 1;             // 显示缩放比例（适配视口，画布始终为原图分辨率）
    var sel = null;            // 当前选区（图像坐标 {x,y,w,h}）
    var tool = 'select';       // 当前工具：select/rect/ellipse/arrow/brush/text/mosaic
    var color = '#fa5151';     // 当前标注颜色（默认微信红）
    var drawing = false;       // 是否正在拖拽（选区/图形/画笔）
    var sx = 0, sy = 0;        // 拖拽起点（图像坐标）
    var lx = 0, ly = 0;        // 画笔/马赛克上一个点（图像坐标）
    var strokeSnapshot = null; // 图形类工具笔画起始快照（用于拖拽预览回擦）
    var undoStack = [];        // 撤销栈（标注层 ImageData 快照）
    var UNDO_MAX = 10;         // 撤销栈上限（控制内存）
    var mosaicCanvas = null;   // 马赛克底图（原图降采样再放大，像素块效果）
    var onConfirm = null;      // 确认回调：function(blob)
    var imgUrl = '';           // 底图 blob URL（关闭时释放）
    var mode = 'editor';       // 当前模式：editor（编辑器）/freeze（伪冻结遮罩，第二期）/record（录屏选区，阶段一百三十九）
    // ===== 阶段一百三十九：QQ 同款录屏（选区复用冻结交互，工具栏切换为 开始录制/取消） =====
    var recToolbarEl = null;   // 录屏工具栏（尺寸+开始录制+取消，与标注工具栏互斥显示）
    var recSizeEl = null;      // 录屏选区尺寸显示（"1280×720"）
    var recCountEl = null;     // 3-2-1 倒计时层（大数字居中，冻结画面上）
    var recHandlers = null;    // 录屏回调 { onStart(sel), onCancel() }（渲染层注入）
    var recStarted = false;    // 倒计时结束录制已启动标记（关闭时区分 取消/启动 两种语义）
    var sizeLabel = null;      // 选区尺寸标签（伪冻结模式：拖拽时实时显示 宽×高）
    // ===== 阶段一百三十九：QQ 同款窗口识别（悬停高亮 + 单击选窗 + 双击截窗） =====
    var winHoverEl = null;     // 悬停窗口高亮框（QQ 同款红色焦点框，pointer-events:none 不挡操作）
    var winHoverImg = null;    // 当前悬停窗口矩形（图像坐标 {x,y,w,h}，null=未识别到）
    var winSelImg = null;      // 单击选窗时的窗口矩形缓存（供双击发送用）
    var winClickTimer = null;  // 单击选窗后的双击判定窗（350ms 内二次点击=双击发送）
    var hoverPending = false;  // 命中查询在途标记（单飞，丢帧无感）
    var hoverLast = 0;         // 悬停查询节流时间戳（40ms ≈ 25fps 跟手且不刷爆 IPC）
    // ===== 阶段一百三十九：提取文字/屏幕翻译（服务端视觉 OCR + AI 翻译，浮层展示） =====
    var ocrCardEl = null;      // 结果浮层卡片（自绘，禁止系统弹窗）
    var ocrTitleEl = null;     // 浮层标题（提取结果/翻译结果/识别中…）
    var ocrBodyEl = null;      // 浮层内容区（loading/行文本/原文+译文）
    var ocrCopyBtn = null;     // 复制按钮（_text 挂当前可复制全文）
    var ocrBusy = false;       // 识别/翻译请求在途标记（防重复点击）
    // ===== 阶段一百三十九：长截图（滚动拼接：冻结选区移交 chat.js 长截图状态机） =====
    var stitchBtn = null;      // 长截图按钮（仅冻结态且 PC 端可用时显示，编辑器/录屏/浏览器态隐藏）
    var stitchCb = null;       // 长截图回调 onStitch(sel, snapW, snapH)（chat.js 长截图状态机经 freeze 注入）

    // 随图尺寸自适应的笔触参数（大图笔触更粗，视觉一致）
    var strokeWidth = 4, fontSize = 20, mosaicR = 24;

    // ===== 工具图标（内联 SVG，跟随 currentColor） =====
    var ICONS = {
        select: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3" d="M4 4h16v16H4z"/></svg>',
        rect: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 5h16v14H4z"/></svg>',
        ellipse: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
        arrow: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M5 19L19 5M11 5h8v8"/></svg>',
        brush: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
        text: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 4v3h5.5v13h3V7H19V4z"/></svg>',
        mosaic: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>',
        undo: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
        // 阶段一百三十九：提取文字（OCR 取景框样式）/ 屏幕翻译（A/文 翻译样式）
        ocr: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path fill="currentColor" d="M7.4 15l2.8-6.5h1.3L14.3 15h-1.4l-.65-1.6H9.45L8.8 15H7.4zm2.45-2.8h2L10.85 9.7 9.85 12.2zM14.6 15V8.5h4.3v1.2h-2.9v1.6h2.6v1.2h-2.6V15h-1.4z"/></svg>',
        translate: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>',
        // 阶段一百三十九：长截图（屏幕区域 + 向下滚动箭头）
        stitch: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 3h16v10H4z"/><path fill="currentColor" d="M11 8h2v7.2l2.1-2.1 1.4 1.4-4.5 4.5-4.5-4.5 1.4-1.4 2.1 2.1z"/></svg>'
    };

    // 标注颜色（微信同款：红/黄/蓝/绿/黑）
    var COLORS = ['#fa5151', '#ffb02e', '#1485ee', '#07c160', '#333333'];

    // ===== 构建 DOM（一次性） =====
    function build() {
        editorEl = document.createElement('div');
        editorEl.className = 'shot-editor hidden';

        wrapEl = document.createElement('div');
        wrapEl.className = 'shot-canvas-wrap';
        baseCanvas = document.createElement('canvas');
        drawCanvas = document.createElement('canvas');
        maskCanvas = document.createElement('canvas');
        wrapEl.appendChild(baseCanvas);
        wrapEl.appendChild(drawCanvas);
        wrapEl.appendChild(maskCanvas);

        toolbarEl = document.createElement('div');
        toolbarEl.className = 'shot-toolbar';
        // 工具按钮：选区/矩形/椭圆/箭头/画笔/文字/马赛克/撤销
        ['select', 'rect', 'ellipse', 'arrow', 'brush', 'text', 'mosaic'].forEach(function (t) {
            var btn = document.createElement('button');
            btn.className = 'shot-tool';
            btn.dataset.tool = t;
            btn.title = { select: '选区', rect: '矩形', ellipse: '椭圆', arrow: '箭头', brush: '画笔', text: '文字', mosaic: '马赛克' }[t];
            btn.innerHTML = ICONS[t];
            toolbarEl.appendChild(btn);
        });
        var undoBtn = document.createElement('button');
        undoBtn.className = 'shot-tool';
        undoBtn.dataset.tool = 'undo';
        undoBtn.title = '撤销';
        undoBtn.innerHTML = ICONS.undo;
        toolbarEl.appendChild(undoBtn);

        // 阶段一百三十九：提取文字 / 屏幕翻译（动作按钮，非绘制工具——dataset.action 区分，不参与 setTool 激活态）
        var ocrBtn = document.createElement('button');
        ocrBtn.className = 'shot-tool';
        ocrBtn.dataset.action = 'ocr';
        ocrBtn.title = '提取文字';
        ocrBtn.innerHTML = ICONS.ocr;
        toolbarEl.appendChild(ocrBtn);
        var trBtn = document.createElement('button');
        trBtn.className = 'shot-tool';
        trBtn.dataset.action = 'translate';
        trBtn.title = '屏幕翻译';
        trBtn.innerHTML = ICONS.translate;
        toolbarEl.appendChild(trBtn);
        // 阶段一百三十九：长截图（滚动拼接）——动作按钮，dataset.action 区分；仅 PC 冻结态显示（load 里控制显隐）
        stitchBtn = document.createElement('button');
        stitchBtn.className = 'shot-tool';
        stitchBtn.dataset.action = 'stitch';
        stitchBtn.title = '长截图';
        stitchBtn.innerHTML = ICONS.stitch;
        toolbarEl.appendChild(stitchBtn);

        // 颜色点
        COLORS.forEach(function (c, i) {
            var dot = document.createElement('span');
            dot.className = 'shot-color-dot' + (i === 0 ? ' active' : '');
            dot.dataset.color = c;
            dot.style.background = c;
            toolbarEl.appendChild(dot);
        });

        var sep = document.createElement('span');
        sep.className = 'shot-sep';
        toolbarEl.appendChild(sep);

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'shot-btn';
        cancelBtn.textContent = '取消';
        var sendBtn = document.createElement('button');
        sendBtn.className = 'shot-btn primary';
        sendBtn.textContent = '发送';
        toolbarEl.appendChild(cancelBtn);
        toolbarEl.appendChild(sendBtn);

        // 文字工具自定义输入框（禁止系统默认弹窗）
        textInputEl = document.createElement('input');
        textInputEl.className = 'shot-text-input hidden';
        textInputEl.placeholder = '输入文字，回车确认';

        // 选区尺寸标签（伪冻结模式：拖拽时实时显示 宽×高，微信同款）
        sizeLabel = document.createElement('div');
        sizeLabel.className = 'shot-size-label hidden';

        // 冻结态操作提示条（自绘非系统弹窗）：告知用户需拖拽框选（微信 Alt+A 同款引导）
        hintEl = document.createElement('div');
        hintEl.className = 'shot-hint hidden';
        hintEl.textContent = '拖拽框选截图区域 · Enter 发送 · Esc 取消';

        // 阶段一百三十九：悬停窗口高亮框（QQ 同款）——置顶于画布之上但不挡鼠标事件
        winHoverEl = document.createElement('div');
        winHoverEl.className = 'shot-win-hover hidden';

        // 阶段一百三十九：录屏工具栏（选区完成后出现，与标注工具栏互斥；开始录制为绿色主按钮）
        recToolbarEl = document.createElement('div');
        recToolbarEl.className = 'shot-rec-toolbar hidden';
        recSizeEl = document.createElement('span');
        recSizeEl.className = 'shot-rec-size';
        var recStartBtn = document.createElement('button');
        recStartBtn.className = 'shot-btn rec-start';
        recStartBtn.textContent = '开始录制';
        var recCancelBtn = document.createElement('button');
        recCancelBtn.className = 'shot-btn';
        recCancelBtn.textContent = '取消';
        recStartBtn.addEventListener('click', function () { startRecCountdown(); });
        recCancelBtn.addEventListener('click', function () { close(); });
        recToolbarEl.appendChild(recSizeEl);
        recToolbarEl.appendChild(recStartBtn);
        recToolbarEl.appendChild(recCancelBtn);

        // 阶段一百三十九：录屏倒计时层（3-2-1 大数字居中，冻结画面之上，期间不可操作）
        recCountEl = document.createElement('div');
        recCountEl.className = 'shot-rec-count hidden';

        // 阶段一百三十九：提取文字/屏幕翻译结果浮层（自绘卡片，禁止系统弹窗）
        ocrCardEl = document.createElement('div');
        ocrCardEl.className = 'shot-ocr-card hidden';
        var ocrHead = document.createElement('div');
        ocrHead.className = 'shot-ocr-head';
        ocrTitleEl = document.createElement('span');
        ocrTitleEl.className = 'shot-ocr-title';
        var ocrClose = document.createElement('button');
        ocrClose.className = 'shot-ocr-close';
        ocrClose.textContent = '×';
        ocrClose.title = '关闭';
        ocrClose.addEventListener('click', function () { hideOcrCard(); });
        ocrHead.appendChild(ocrTitleEl);
        ocrHead.appendChild(ocrClose);
        ocrBodyEl = document.createElement('div');
        ocrBodyEl.className = 'shot-ocr-body';
        var ocrFoot = document.createElement('div');
        ocrFoot.className = 'shot-ocr-foot';
        ocrCopyBtn = document.createElement('button');
        ocrCopyBtn.className = 'shot-btn';
        ocrCopyBtn.textContent = '复制全部';
        ocrCopyBtn.addEventListener('click', function () {
            var txt = ocrCopyBtn._text || '';
            if (!txt) return;
            // 项目规则：程序化剪贴板（禁选环境下不依赖选区）
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt).then(function () {
                    ocrCopyBtn.textContent = '已复制';
                    setTimeout(function () { ocrCopyBtn.textContent = '复制全部'; }, 1200);
                });
            }
        });
        ocrFoot.appendChild(ocrCopyBtn);
        ocrCardEl.appendChild(ocrHead);
        ocrCardEl.appendChild(ocrBodyEl);
        ocrCardEl.appendChild(ocrFoot);

        editorEl.appendChild(wrapEl);
        editorEl.appendChild(toolbarEl);
        editorEl.appendChild(textInputEl);
        editorEl.appendChild(sizeLabel);
        editorEl.appendChild(hintEl);
        editorEl.appendChild(winHoverEl);
        editorEl.appendChild(recToolbarEl); // 阶段一百三十九：录屏工具栏（与标注工具栏互斥显示）
        editorEl.appendChild(recCountEl);   // 阶段一百三十九：录屏倒计时层
        editorEl.appendChild(ocrCardEl);

        // ===== 阶段一百三十九：悬停窗口识别（mousemove 节流 → 主进程 Win32 命中 → 高亮框跟随） =====
        // 仅冻结态 + 选区工具 + 未框选（sel 空）+ 非拖拽中生效；PC 端无 desktop API（浏览器回退）自动跳过
        document.addEventListener('mousemove', function (e) {
            if (!isOpen() || (mode !== 'freeze' && mode !== 'record') || tool !== 'select' || drawing || sel) { hideWinHover(); return; }
            if (!window.desktop || !window.desktop.shotWindowAt) return;
            var now = Date.now();
            if (now - hoverLast < 40 || hoverPending) return; // 节流 + 单飞
            hoverLast = now;
            hoverPending = true;
            var dpr = window.devicePixelRatio || 1;
            // 视口全屏=主屏逻辑坐标：物理屏幕坐标 = 逻辑 × devicePixelRatio
            window.desktop.shotWindowAt(Math.round(e.clientX * dpr), Math.round(e.clientY * dpr)).then(function (r) {
                hoverPending = false;
                // 响应回来时状态可能已变（关闭/开始框选/已选定）：一并作废
                if (!isOpen() || (mode !== 'freeze' && mode !== 'record') || drawing || sel) { hideWinHover(); return; }
                if (!r) { hideWinHover(); winHoverImg = null; return; }
                var cr = drawCanvas.getBoundingClientRect();
                // 窗口物理矩形 → 逻辑视口坐标 → 定位高亮框；换算图像坐标缓存（供单击/双击选窗裁剪）
                var vx = r.left / dpr, vy = r.top / dpr;
                var vw = (r.right - r.left) / dpr, vh = (r.bottom - r.top) / dpr;
                winHoverEl.style.left = vx + 'px';
                winHoverEl.style.top = vy + 'px';
                winHoverEl.style.width = vw + 'px';
                winHoverEl.style.height = vh + 'px';
                winHoverEl.classList.remove('hidden');
                winHoverImg = {
                    x: (vx - cr.left) / scale,
                    y: (vy - cr.top) / scale,
                    w: vw / scale,
                    h: vh / scale
                };
            }).catch(function () { hoverPending = false; });
        });
        document.body.appendChild(editorEl);

        bctx = baseCanvas.getContext('2d');
        dctx = drawCanvas.getContext('2d');
        mctx = maskCanvas.getContext('2d');

        bindEvents();
    }

    // ===== 工具函数 =====
    // 屏幕坐标 -> 图像坐标
    function toImg(e) {
        var rect = drawCanvas.getBoundingClientRect();
        return {
            x: Math.min(Math.max(0, (e.clientX - rect.left) / scale), imgW),
            y: Math.min(Math.max(0, (e.clientY - rect.top) / scale), imgH)
        };
    }

    // 在选区裁剪内绘制（标注只落在选区内）
    function withSelClip(fn) {
        dctx.save();
        dctx.beginPath();
        dctx.rect(sel.x, sel.y, sel.w, sel.h);
        dctx.clip();
        fn();
        dctx.restore();
    }

    // 重绘遮罩层：选区外半透明压暗 + 选区边框
    function drawMask() {
        mctx.clearRect(0, 0, imgW, imgH);
        mctx.fillStyle = 'rgba(0,0,0,0.5)';
        mctx.fillRect(0, 0, imgW, imgH);
        if (sel && sel.w > 0 && sel.h > 0) {
            mctx.clearRect(sel.x, sel.y, sel.w, sel.h);
            mctx.strokeStyle = '#07c160';
            mctx.lineWidth = 2;
            mctx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2);
        }
    }

    // 撤销栈：压入标注层快照
    function pushUndo() {
        if (undoStack.length >= UNDO_MAX) undoStack.shift();
        undoStack.push(dctx.getImageData(0, 0, imgW, imgH));
    }

    function undo() {
        if (!undoStack.length) return;
        dctx.putImageData(undoStack.pop(), 0, 0);
    }

    // 生成马赛克底图：降采样 1/8 后关平滑放大回原尺寸，形成像素块
    function buildMosaic() {
        var small = document.createElement('canvas');
        var sw = Math.max(1, Math.floor(imgW / 8));
        var sh = Math.max(1, Math.floor(imgH / 8));
        small.width = sw;
        small.height = sh;
        var sctx = small.getContext('2d');
        sctx.drawImage(img, 0, 0, sw, sh);
        mosaicCanvas = document.createElement('canvas');
        mosaicCanvas.width = imgW;
        mosaicCanvas.height = imgH;
        var mc = mosaicCanvas.getContext('2d');
        mc.imageSmoothingEnabled = false;
        mc.drawImage(small, 0, 0, imgW, imgH);
    }

    // 画箭头：主线 + 双翼箭头头
    function drawArrow(x1, y1, x2, y2) {
        dctx.beginPath();
        dctx.moveTo(x1, y1);
        dctx.lineTo(x2, y2);
        dctx.stroke();
        var ang = Math.atan2(y2 - y1, x2 - x1);
        var head = strokeWidth * 4 + 8;
        dctx.beginPath();
        dctx.moveTo(x2, y2);
        dctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
        dctx.moveTo(x2, y2);
        dctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
        dctx.stroke();
    }

    // 隐藏选区尺寸标签
    function hideSizeLabel() {
        if (sizeLabel) sizeLabel.classList.add('hidden');
    }

    // 更新选区尺寸标签：显示 宽×高，位置跟随选区右下角（伪冻结模式，微信同款）
    function updateSizeLabel() {
        if (!sel || (mode !== 'freeze' && mode !== 'record') || sel.w < 4 || sel.h < 4) { hideSizeLabel(); return; }
        var rect = wrapEl.getBoundingClientRect();
        var px = rect.left + (sel.x + sel.w) * scale;  // 选区右下角屏幕坐标
        var py = rect.top + (sel.y + sel.h) * scale;
        sizeLabel.textContent = Math.round(sel.w) + ' × ' + Math.round(sel.h);
        sizeLabel.classList.remove('hidden');
        var tw = sizeLabel.offsetWidth, th = sizeLabel.offsetHeight;
        var left = Math.min(Math.max(4, px - tw / 2), window.innerWidth - tw - 4);
        var top = py + 8;
        if (top + th > window.innerHeight - 4) top = py - th - 8; // 超出视口底部则显示在选区上方
        sizeLabel.style.left = left + 'px';
        sizeLabel.style.top = top + 'px';
    }

    // ===== 打开编辑器（编辑器模式：居中缩放，默认全图选区） =====
    // 阶段一百四十：第三参 onClose——编辑器模式取消回调（独立窗口承载后取消/Esc 需通知主进程藏窗，
    // 缺省 null 兼容浏览器主窗体内嵌回退路径：close 仅清 DOM，无窗口概念）
    function open(blob, confirmCb, onClose) {
        load(blob, confirmCb, 'editor', onClose);
    }

    // ===== 打开伪冻结遮罩（第二期：画面铺满视口、空选区，拖拽框选后工具栏出现） =====
    // 阶段三十八：第三参 onClose——编辑器关闭（发送或取消）时回调（PC 端用于通知主进程退出全屏冻结态）
    // 阶段三十八：第四参 onReady——冻结画面首帧绘制完成回调（PC 端用于"编辑器就绪后再揭幕"，消除聊天界面闪现）
    var onCloseCb = null; // 冻结模式关闭回调（一次性，close 时消费）
    var onReadyCb = null; // 冻结画面就绪回调（一次性，首帧绘制后消费）
    function freeze(blob, confirmCb, onClose, onReady, onStitch) {
        onCloseCb = onClose || null;
        onReadyCb = onReady || null;
        stitchCb = onStitch || null; // 阶段一百三十九：长截图回调（null=入口不可用，工具栏按钮隐藏）
        load(blob, confirmCb, 'freeze');
    }

    // ===== 阶段一百三十九：QQ 同款录屏选区（选区交互与冻结截图完全同构，工具栏换录屏版） =====
    // handlers = { onStart(sel), onCancel() }：onStart 在 3-2-1 倒计时结束、编辑器自动关闭后触发
    // （渲染层接手：主窗口退场 → 拿屏幕流 → 裁剪选区录制）；onCancel 在选区阶段取消（Esc/取消按钮）时触发
    function freezeVideo(blob, handlers, onReady) {
        recHandlers = handlers || null;
        recStarted = false;
        onCloseCb = null;
        onReadyCb = onReady || null;
        load(blob, null, 'record');
    }

    // 录屏倒计时：点"开始录制"后 3-2-1 每秒一跳（大数字冻结画面居中），结束自动关闭编辑器并回调 onStart
    function startRecCountdown() {
        if (!sel || sel.w < 2 || sel.h < 2) return;
        recToolbarEl.classList.add('hidden');
        var n = 3;
        var tick = function () {
            if (n > 0) {
                recCountEl.textContent = n;
                recCountEl.classList.remove('hidden');
                // 重启动画（同一元素连续数字缩放跳动）
                recCountEl.classList.remove('pop');
                void recCountEl.offsetWidth;
                recCountEl.classList.add('pop');
                n--;
                setTimeout(tick, 1000);
                return;
            }
            recCountEl.classList.add('hidden');
            recStarted = true; // 关闭语义切换：此后 close 不再触发 onCancel
            var s = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
            var snapW = imgW, snapH = imgH; // 冻结底图=全屏快照物理分辨率（选区坐标归口，屏幕流裁剪按此换算）
            // 先缓存回调再关闭：close() 会清空 recHandlers，关闭后再读恒为 null（实测踩坑）
            var startCb = recHandlers && recHandlers.onStart ? recHandlers.onStart : null;
            close();
            if (startCb) startCb(s, snapW, snapH);
        };
        tick();
    }

    // 录屏选区尺寸文本刷新（选区完成/重新框选时同步）
    function updateRecSize() {
        if (recSizeEl && sel) recSizeEl.textContent = Math.round(sel.w) + '×' + Math.round(sel.h);
    }

    // 阶段一百三十九：伪冻结 cover 布局（freeze/record 共用）。
    // 竞态修复：主进程 setFullScreen(true) 异步生效，渲染层 load 时视口可能还是旧尺寸
    // （实测：连续截图时画布按旧视口 1100×722 布局，底图未铺满全屏），故监听 resize 重算——
    // 仅未起选区时重算（起选区后重算会让选区与图坐标错位）
    function layoutFreezeCover() {
        scale = Math.max(window.innerWidth / imgW, window.innerHeight / imgH);
        var cw = Math.round(imgW * scale), ch = Math.round(imgH * scale);
        var ox = Math.round((window.innerWidth - cw) / 2), oy = Math.round((window.innerHeight - ch) / 2);
        [baseCanvas, drawCanvas, maskCanvas].forEach(function (c) {
            c.style.width = cw + 'px';
            c.style.height = ch + 'px';
            c.style.left = ox + 'px';
            c.style.top = oy + 'px';
        });
        wrapEl.style.width = window.innerWidth + 'px';
        wrapEl.style.height = window.innerHeight + 'px';
    }
    window.addEventListener('resize', function () {
        if ((mode === 'freeze' || mode === 'record') && !sel && editorEl && !editorEl.classList.contains('hidden')) layoutFreezeCover();
    });

    function load(blob, confirmCb, m, onClose) {
        if (!editorEl) build();
        onConfirm = confirmCb || null;
        if (m !== 'freeze' && m !== 'record') { onCloseCb = onClose || null; onReadyCb = null; stitchCb = null; } // 编辑器模式：取消回调由调用方注入（独立窗口承载后取消需通知主进程藏窗，实测踩坑：置 null 会让取消/Esc 只清画布不关窗口）；record 的 onReady 由 freezeVideo 注入；长截图回调仅冻结态有效
        imgUrl = URL.createObjectURL(blob);
        var image = new Image();
        image.onload = function () {
            img = image;
            imgW = image.naturalWidth;
            imgH = image.naturalHeight;
            // 笔触随图尺寸自适应
            strokeWidth = Math.max(3, Math.round(imgW / 400));
            fontSize = Math.max(16, Math.round(imgW / 60));
            mosaicR = Math.max(12, Math.round(imgW / 80));
            // 画布保持原图分辨率，CSS 缩放适配视口（输出不损失清晰度）
            [baseCanvas, drawCanvas, maskCanvas].forEach(function (c) {
                c.width = imgW;
                c.height = imgH;
            });
            mode = m;
            if (mode === 'freeze' || mode === 'record') {
                // 伪冻结：cover 铺满视口（居中，溢出部分裁剪），贴近"屏幕被冻结"的观感
                layoutFreezeCover();
                sel = null; // 冻结态无选区：必须拖拽框选（微信同款）
                editorEl.classList.add('freeze');
                // 阶段一百三十四：冻结截图期间隐藏自绘标题栏——标题栏 z-index(12000) 故意压过全部浮层，
                // 比编辑器遮罩(3000)高，冻结揭幕后顶部会露出聊天 header（实测 2026-09-16）；
                // 微信/QQ 截图时标题栏同样同步消失。根节点挂 shot-freeze 类，CSS 据此隐藏，close() 时移除
                document.documentElement.classList.add('shot-freeze');
                toolbarEl.classList.remove('visible'); // 选区完成后工具栏才出现
                recToolbarEl.classList.add('hidden');  // 阶段一百三十九：录屏工具栏复位隐藏
                recCountEl.classList.add('hidden');    // 阶段一百三十九：倒计时层复位隐藏
                hintEl.textContent = mode === 'record' ? '拖拽框选录屏区域 · Esc 取消' : '拖拽框选截图区域 · Enter 发送 · Esc 取消';
                hintEl.classList.remove('hidden');     // 顶部操作提示：告知拖拽框选
                // 阶段一百三十九：长截图按钮仅 PC 冻结态显示（录屏/浏览器无 stitchCb 时隐藏）
                if (stitchBtn) stitchBtn.classList.toggle('hidden', !(mode === 'freeze' && stitchCb));
            } else {
                // 编辑器模式：contain 居中缩放（与第一期一致）
                var maxW = window.innerWidth * 0.9;
                var maxH = window.innerHeight * 0.78;
                scale = Math.min(maxW / imgW, maxH / imgH, 1);
                [baseCanvas, drawCanvas, maskCanvas].forEach(function (c) {
                    c.style.width = Math.round(imgW * scale) + 'px';
                    c.style.height = Math.round(imgH * scale) + 'px';
                    c.style.left = '0px';
                    c.style.top = '0px';
                });
                wrapEl.style.width = Math.round(imgW * scale) + 'px';
                wrapEl.style.height = Math.round(imgH * scale) + 'px';
                sel = { x: 0, y: 0, w: imgW, h: imgH }; // 默认全图选区（粘贴后可直接发送）
                editorEl.classList.remove('freeze');
                hintEl.classList.add('hidden'); // 编辑器模式无冻结提示
                if (stitchBtn) stitchBtn.classList.add('hidden'); // 阶段一百三十九：长截图仅冻结态可用
            }
            bctx.drawImage(img, 0, 0);
            dctx.clearRect(0, 0, imgW, imgH);
            buildMosaic();
            undoStack = [];
            hideSizeLabel();
            setTool('select');
            drawMask();
            editorEl.classList.remove('hidden');
            // 冻结画面首帧已绘制完毕（编辑器就绪）：通知 PC 端主进程可以揭幕（窗口透明度归位）
            if (onReadyCb) {
                var rcb = onReadyCb;
                onReadyCb = null;
                rcb();
            }
        };
        image.onerror = function () {
            if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = ''; }
        };
        image.src = imgUrl;
    }

    // 编辑器 UI 复位（close/closeSilent 共用）：隐藏浮层、清状态；不触发任何回调
    function resetEditorUI() {
        editorEl.classList.add('hidden');
        editorEl.classList.remove('freeze');
        // 阶段一百三十四：退出冻结截图恢复自绘标题栏（与 load() freeze 分支的 add 配对）
        document.documentElement.classList.remove('shot-freeze');
        resetWinHover(); // 阶段一百三十九：窗口识别状态清理（判定定时器/缓存/高亮框）
        hideOcrCard();   // 阶段一百三十九：识别/翻译结果浮层同步收起
        toolbarEl.classList.remove('visible');
        recToolbarEl.classList.add('hidden'); // 阶段一百三十九：录屏工具栏收起
        recCountEl.classList.add('hidden');   // 阶段一百三十九：倒计时层收起（倒计时中途取消兜底）
        hideSizeLabel();
        hintEl.classList.add('hidden');
        hideTextInput();
        undoStack = [];
        sel = null;
        mode = 'editor';
        img = null;
        if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = ''; }
        stitchCb = null;
    }

    function close() {
        if (!editorEl) return;
        var wasRecord = (mode === 'record'); // 复位前捕获模式（resetEditorUI 会把 mode 归位 editor）
        resetEditorUI();
        // 阶段一百三十九：录屏模式关闭语义分流——倒计时已结束（录制已启动）只做清理；
        // 选区阶段取消（Esc/取消按钮）触发 onCancel 交渲染层退出冻结态
        var recCancelCb = null;
        if (wasRecord) {
            if (!recStarted && recHandlers && recHandlers.onCancel) recCancelCb = recHandlers.onCancel;
            recHandlers = null;
        }
        // 阶段三十八：冻结模式关闭回调（发送/取消/Esc 关闭统一触发，PC 端通知主进程退出全屏冻结）
        if (onCloseCb) {
            var cb = onCloseCb;
            onCloseCb = null;
            cb();
        }
        if (recCancelCb) recCancelCb();
    }

    // 阶段一百三十九：静默关闭（长截图移交专用）——仅复位编辑器 UI，不触发 onClose/recCancel 回调：
    // 主进程冻结态由长截图链路接管（窗口收缩为悬浮小条而非退全屏恢复，exit-freeze 语义不适用）
    function closeSilent() {
        if (!editorEl) return;
        resetEditorUI();
    }

    // ===== 阶段一百三十九：长截图入口 =====
    // 冻结选区完成后点"长截图"：校验选区 → 静默关闭编辑器 → 回调 chat.js 长截图状态机
    // （主进程 stitch:begin 把窗口收缩为选区下方悬浮小条，渲染层抓屏幕流做滚动对齐拼接）
    var STITCH_MIN_W = 60;   // 选区最小宽（过窄无对齐特征）
    var STITCH_MIN_H = 100;  // 选区最小高（底部条带对齐模板需要足够高度）
    function startStitch() {
        if (mode !== 'freeze' || !sel || !stitchCb) return;
        if (sel.w < STITCH_MIN_W || sel.h < STITCH_MIN_H) {
            // 选区过小：提示后保留编辑器现状（不关闭），用户可重新框选
            hintEl.textContent = '选区太小，无法长截图（请框选更高的区域）';
            hintEl.classList.remove('hidden');
            return;
        }
        var s = { x: Math.round(sel.x), y: Math.round(sel.y), w: Math.round(sel.w), h: Math.round(sel.h) };
        var snapW = imgW, snapH = imgH; // 冻结底图=全屏快照物理分辨率（选区坐标归口）
        // 先缓存回调再关闭：closeSilent 会清 stitchCb（close 清回调的坑，录屏同款）
        var cb = stitchCb;
        closeSilent();
        if (cb) cb(s, snapW, snapH);
    }

    function isOpen() {
        return !!editorEl && !editorEl.classList.contains('hidden');
    }

    // 阶段一百三十九：隐藏悬停窗口高亮框（QQ 同款窗口识别配套）
    function hideWinHover() {
        if (winHoverEl) winHoverEl.classList.add('hidden');
    }

    // 阶段一百三十九：窗口识别相关状态清理（编辑器关闭 / 冻结底图重载时调用）
    function resetWinHover() {
        if (winClickTimer) { clearTimeout(winClickTimer); winClickTimer = null; }
        winSelImg = null;
        winHoverImg = null;
        hideWinHover();
    }

    // ===== 阶段一百三十九：提取文字/屏幕翻译（服务端视觉 OCR + AI 翻译） =====
    // 裁剪当前选区为 PNG dataURL（仅底图不含标注层——识别的是屏幕原始内容）
    function cropSelDataUrl() {
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(sel.w));
        c.height = Math.max(1, Math.round(sel.h));
        c.getContext('2d').drawImage(baseCanvas, sel.x, sel.y, sel.w, sel.h, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
    }

    // 浮层 loading 态（withTranslate：true=屏幕翻译，false=提取文字）
    function showOcrCard(loading, withTranslate) {
        ocrTitleEl.textContent = loading ? (withTranslate ? '屏幕翻译' : '提取文字') : (withTranslate ? '翻译结果' : '提取结果');
        ocrBodyEl.innerHTML = '';
        var tip = document.createElement('div');
        tip.className = 'shot-ocr-loading';
        tip.textContent = loading ? (withTranslate ? '识别并翻译中，请稍候…' : '识别中，请稍候…') : '';
        ocrBodyEl.appendChild(tip);
        ocrCopyBtn._text = '';
        ocrCopyBtn.classList.add('hidden');
        ocrCardEl.classList.remove('hidden');
    }

    // 浮层结果渲染：translated 为 null 表示纯提取模式（仅原文行）
    function renderOcrResult(lines, translated) {
        ocrTitleEl.textContent = translated === null ? '提取结果' : '翻译结果';
        ocrBodyEl.innerHTML = '';
        if (!lines.length) {
            var empty = document.createElement('div');
            empty.className = 'shot-ocr-empty';
            empty.textContent = '未识别到文字';
            ocrBodyEl.appendChild(empty);
            return;
        }
        var full = lines.join('\n');
        if (translated !== null) {
            var srcLabel = document.createElement('div');
            srcLabel.className = 'shot-ocr-label';
            srcLabel.textContent = '原文';
            var src = document.createElement('div');
            src.className = 'shot-ocr-text src';
            src.textContent = full; // textContent 防 XSS 归口
            var dstLabel = document.createElement('div');
            dstLabel.className = 'shot-ocr-label';
            dstLabel.textContent = '译文';
            var dst = document.createElement('div');
            dst.className = 'shot-ocr-text dst';
            dst.textContent = translated;
            ocrBodyEl.appendChild(srcLabel);
            ocrBodyEl.appendChild(src);
            ocrBodyEl.appendChild(dstLabel);
            ocrBodyEl.appendChild(dst);
            ocrCopyBtn._text = translated;
        } else {
            var body = document.createElement('div');
            body.className = 'shot-ocr-text';
            body.textContent = full;
            ocrBodyEl.appendChild(body);
            ocrCopyBtn._text = full;
        }
        ocrCopyBtn.classList.remove('hidden');
    }

    // 浮层错误态（识别/翻译失败统一从浮层出，不弹系统框）
    function renderOcrError(msg) {
        ocrTitleEl.textContent = '提示';
        ocrBodyEl.innerHTML = '';
        var err = document.createElement('div');
        err.className = 'shot-ocr-empty';
        err.textContent = msg;
        ocrBodyEl.appendChild(err);
    }

    function hideOcrCard() {
        if (ocrCardEl) ocrCardEl.classList.add('hidden');
    }

    // 入口：框选完成后的提取/翻译动作（withTranslate=true 时识别后追加服务端翻译）
    function runScreenOCR(withTranslate) {
        if (ocrBusy) return; // 请求在途防重入
        if (!sel || sel.w < 2 || sel.h < 2) {
            // 未框选：从浮层出引导提示（交互与结果展示一致，不混用 hintEl）
            ocrTitleEl.textContent = '提示';
            ocrBodyEl.innerHTML = '';
            var tip = document.createElement('div');
            tip.className = 'shot-ocr-empty';
            tip.textContent = '请先拖拽框选要识别的文字区域';
            ocrBodyEl.appendChild(tip);
            ocrCopyBtn._text = '';
            ocrCopyBtn.classList.add('hidden');
            ocrCardEl.classList.remove('hidden');
            return;
        }
        var user = (typeof IMSocket !== 'undefined' && IMSocket.getUsername) ? IMSocket.getUsername() : '';
        ocrBusy = true;
        showOcrCard(true, withTranslate);
        fetch('/api/ocr?username=' + encodeURIComponent(user), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: cropSelDataUrl() })
        }).then(function (r) { return r.json(); }).then(function (j) {
            if (!j.ok) throw new Error(j.msg || '识别失败');
            var lines = (j.data && j.data.lines) || [];
            if (!withTranslate) { ocrBusy = false; renderOcrResult(lines, null); return null; }
            if (!lines.length) { ocrBusy = false; renderOcrResult(lines, null); return null; }
            // 屏幕翻译：OCR 文本 → 服务端 AI 翻译（自动判向：中文→英文，否则→中文）
            return fetch('/api/translate?username=' + encodeURIComponent(user), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: lines.join('\n') })
            }).then(function (r2) { return r2.json(); }).then(function (j2) {
                if (!j2.ok) throw new Error(j2.msg || '翻译失败');
                renderOcrResult(lines, (j2.data && j2.data.translated) || '');
            });
        }).catch(function (e) {
            renderOcrError((e && e.message) || '请求失败');
        }).then(function () { ocrBusy = false; });
    }

    // ===== 输出：按选区裁剪 底图+标注层 合成 PNG =====
    function output() {
        if (!sel || sel.w < 2 || sel.h < 2) return;
        var out = document.createElement('canvas');
        out.width = Math.round(sel.w);
        out.height = Math.round(sel.h);
        var octx = out.getContext('2d');
        octx.drawImage(baseCanvas, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);
        octx.drawImage(drawCanvas, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);
        out.toBlob(function (blob) {
            var cb = onConfirm;
            close();
            if (blob && cb) cb(blob);
        }, 'image/png');
    }

    // ===== 文字工具：自定义浮动输入框（禁止系统弹窗） =====
    function showTextInput(pt) {
        var rect = wrapEl.getBoundingClientRect();
        textInputEl.style.left = Math.min(rect.left + pt.x * scale, window.innerWidth - 200) + 'px';
        textInputEl.style.top = Math.min(rect.top + pt.y * scale, window.innerHeight - 40) + 'px';
        textInputEl.value = '';
        textInputEl.classList.remove('hidden');
        textInputEl._pt = pt; // 记录落点（图像坐标）
        setTimeout(function () { textInputEl.focus(); }, 0);
    }

    function commitText() {
        var pt = textInputEl._pt;
        var value = textInputEl.value.trim();
        hideTextInput();
        if (!pt || !value || !sel) return;
        pushUndo();
        withSelClip(function () {
            dctx.fillStyle = color;
            dctx.font = fontSize + 'px "Microsoft YaHei", sans-serif';
            dctx.textBaseline = 'top';
            dctx.fillText(value, pt.x, pt.y);
        });
    }

    function hideTextInput() {
        textInputEl.classList.add('hidden');
        textInputEl._pt = null;
    }

    // ===== 工具切换 =====
    function setTool(t) {
        tool = t;
        var btns = toolbarEl.querySelectorAll('.shot-tool');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', btns[i].dataset.tool === t);
        }
        drawCanvas.style.cursor = t === 'text' ? 'text' : 'crosshair';
    }

    // ===== 事件绑定 =====
    function bindEvents() {
        // 工具栏点击
        toolbarEl.addEventListener('click', function (e) {
            var toolBtn = e.target.closest('.shot-tool');
            if (toolBtn) {
                if (toolBtn.dataset.tool === 'undo') { undo(); return; }
                // 阶段一百三十九：动作按钮（提取文字/屏幕翻译/长截图）不参与 setTool 工具切换
                if (toolBtn.dataset.action === 'ocr') { runScreenOCR(false); return; }
                if (toolBtn.dataset.action === 'translate') { runScreenOCR(true); return; }
                if (toolBtn.dataset.action === 'stitch') { startStitch(); return; }
                setTool(toolBtn.dataset.tool);
                return;
            }
            var dot = e.target.closest('.shot-color-dot');
            if (dot) {
                color = dot.dataset.color;
                var dots = toolbarEl.querySelectorAll('.shot-color-dot');
                for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('active', dots[i] === dot);
                return;
            }
            if (e.target.classList.contains('shot-btn')) {
                if (e.target.classList.contains('primary')) output();
                else close();
            }
        });

        // 原实现：drawCanvas.addEventListener('mousedown', ...)——但遮罩层 maskCanvas 绝对定位位于最上层
        // 且未放行鼠标事件，真实点击被其拦截导致冻结态无法框选、工具栏永不出现（第二期实测反馈）
        // drawCanvas.addEventListener('mousedown', function (e) {
        //     if (e.button !== 0) return;
        //     var pt = toImg(e);
        //     if (tool === 'select') {
        //         // 选区工具：允许在空选区（冻结态）下直接拖拽框选
        //         drawing = true;
        //         sx = pt.x; sy = pt.y;
        //         if (mode === 'freeze') {
        //             toolbarEl.classList.remove('visible'); // 重新框选期间隐藏工具栏
        //             hideSizeLabel();
        //         }
        //         return;
        //     }
        //     if (!sel) return; // 标注类工具需要先有选区
        //     if (tool === 'text') {
        //         showTextInput(pt);
        //         return;
        //     }
        //     if (tool === 'rect' || tool === 'ellipse' || tool === 'arrow') {
        //         pushUndo();
        //         strokeSnapshot = dctx.getImageData(0, 0, imgW, imgH);
        //         drawing = true;
        //         sx = pt.x; sy = pt.y;
        //     } else if (tool === 'brush' || tool === 'mosaic') {
        //         pushUndo();
        //         drawing = true;
        //         sx = pt.x; sy = pt.y;
        //         lx = pt.x; ly = pt.y;
        //         strokeSegment(pt.x, pt.y, pt.x, pt.y);
        //     }
        // });
        // 修复：mousedown 改绑容器 wrapEl——三画布的按下事件均冒泡至此统一接收，不依赖层叠顺序
        wrapEl.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            // 阶段三十八修复：阻止浏览器原生拖拽文字选择——否则框选时工具栏"取消/发送"文字被一起选中（蓝色高亮）
            e.preventDefault();
            // 阶段三十八修复：双击的第二段按下（e.detail>=2）不再重新起选区——
            // 否则双击间微小移动会把 sel 重置成 1~2px 微小选区，dblclick 里 output() 因 sel.w<2 拒发，双击发送失效
            // if (e.button !== 0) return;（原实现：未拦截双击第二段按下，导致双击起选区破坏已有选区）
            if (e.detail >= 2) return;
            var pt = toImg(e);
            if (tool === 'select') {
                // 阶段一百三十九：重新框选时收起识别/翻译结果浮层（框选动作优先级高于浮层展示）
                hideOcrCard();
                // 阶段一百三十九：QQ 同款单击选窗——悬停识别到窗口时按下直接按窗口矩形选定，
                // 出工具栏可继续标注/Enter 发送；350ms 内二次点击由 dblclick 处理为直接发送
                if ((mode === 'freeze' || mode === 'record') && winHoverEl && !winHoverEl.classList.contains('hidden') && winHoverImg) {
                    sel = { x: winHoverImg.x, y: winHoverImg.y, w: winHoverImg.w, h: winHoverImg.h };
                    winSelImg = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
                    winHoverImg = null;
                    hideWinHover();
                    drawMask();
                    hintEl.classList.add('hidden');
                    if (mode === 'record') { updateRecSize(); recToolbarEl.classList.remove('hidden'); } // 录屏：录屏工具栏出现
                    else toolbarEl.classList.add('visible');
                    updateSizeLabel();
                    if (winClickTimer) clearTimeout(winClickTimer);
                    winClickTimer = setTimeout(function () { winClickTimer = null; }, 350); // 双击判定窗（超时=单纯单击，选区保留可编辑）
                    return;
                }
                // 选区工具：允许在空选区（冻结态）下直接拖拽框选
                drawing = true;
                sx = pt.x; sy = pt.y;
                if (mode === 'freeze' || mode === 'record') {
                    toolbarEl.classList.remove('visible'); // 重新框选期间隐藏工具栏
                    recToolbarEl.classList.add('hidden');  // 阶段一百三十九：重新框选期间隐藏录屏工具栏
                    hideSizeLabel();
                    hintEl.classList.add('hidden'); // 开始框选即收起操作提示
                }
                return;
            }
            if (!sel) return; // 标注类工具需要先有选区
            if (tool === 'text') {
                showTextInput(pt);
                return;
            }
            if (tool === 'rect' || tool === 'ellipse' || tool === 'arrow') {
                pushUndo();
                strokeSnapshot = dctx.getImageData(0, 0, imgW, imgH);
                drawing = true;
                sx = pt.x; sy = pt.y;
            } else if (tool === 'brush' || tool === 'mosaic') {
                pushUndo();
                drawing = true;
                sx = pt.x; sy = pt.y;
                lx = pt.x; ly = pt.y;
                strokeSegment(pt.x, pt.y, pt.x, pt.y);
            }
        });

        // 拖拽过程绑在 document 上：鼠标移出画布后选区/笔画仍跟随（坐标已钳制在图内）
        document.addEventListener('mousemove', function (e) {
            if (!drawing) return;
            var pt = toImg(e);
            if (tool === 'select') {
                // 归一化选区（支持任意方向拖拽）
                sel = {
                    x: Math.min(sx, pt.x), y: Math.min(sy, pt.y),
                    w: Math.abs(pt.x - sx), h: Math.abs(pt.y - sy)
                };
                drawMask();
                if (mode === 'freeze' || mode === 'record') updateSizeLabel(); // 拖拽期间实时显示尺寸（微信同款）
            } else if (tool === 'rect' || tool === 'ellipse' || tool === 'arrow') {
                dctx.putImageData(strokeSnapshot, 0, 0);
                withSelClip(function () {
                    dctx.strokeStyle = color;
                    dctx.lineWidth = strokeWidth;
                    dctx.lineCap = 'round';
                    dctx.lineJoin = 'round';
                    if (tool === 'rect') dctx.strokeRect(sx, sy, pt.x - sx, pt.y - sy);
                    else if (tool === 'ellipse') {
                        dctx.beginPath();
                        dctx.ellipse((sx + pt.x) / 2, (sy + pt.y) / 2, Math.abs(pt.x - sx) / 2, Math.abs(pt.y - sy) / 2, 0, 0, Math.PI * 2);
                        dctx.stroke();
                    } else drawArrow(sx, sy, pt.x, pt.y);
                });
            } else if (tool === 'brush' || tool === 'mosaic') {
                strokeSegment(lx, ly, pt.x, pt.y);
                lx = pt.x; ly = pt.y;
            }
        });

        document.addEventListener('mouseup', function () {
            // 冻结态选区完成：工具栏出现（微信同款），尺寸标签保持显示；录屏模式切换录屏工具栏
            if (drawing && (mode === 'freeze' || mode === 'record') && tool === 'select' && sel && sel.w > 4 && sel.h > 4) {
                if (mode === 'record') {
                    updateRecSize();
                    recToolbarEl.classList.remove('hidden');
                } else {
                    toolbarEl.classList.add('visible');
                    updateSizeLabel();
                }
            }
            drawing = false;
            strokeSnapshot = null;
        });

        // 选区工具下双击选区内 = 快捷发送（微信同款；冻结态双击选区内生效，避免连续两次框选误触发送）
        // 原实现绑在 drawCanvas 上（同 mousedown，会被最上层 maskCanvas 拦截），改绑 wrapEl 冒泡接收
        // drawCanvas.addEventListener('dblclick', function (e) {
        //     if (tool !== 'select' || !sel || sel.w < 2 || sel.h < 2) return;
        //     var pt = toImg(e);
        //     if (pt.x >= sel.x && pt.x <= sel.x + sel.w && pt.y >= sel.y && pt.y <= sel.y + sel.h) output();
        // });
        wrapEl.addEventListener('dblclick', function (e) {
            // 阶段三十八修复：阻止双击原生选词（否则双击处文字被选中，观感异常）
            e.preventDefault();
            // 阶段一百三十九：录屏模式双击不发送——双击选窗仅选定窗口矩形出录屏工具栏，双击选区内无动作
            if (mode === 'record') {
                if (tool === 'select' && winClickTimer != null && winSelImg) {
                    clearTimeout(winClickTimer);
                    winClickTimer = null;
                    sel = { x: winSelImg.x, y: winSelImg.y, w: winSelImg.w, h: winSelImg.h };
                    winSelImg = null;
                    drawMask();
                    updateRecSize();
                    recToolbarEl.classList.remove('hidden');
                }
                return;
            }
            // 阶段一百三十九：QQ 同款双击截窗——单击选窗后的双击判定窗内二次点击，直接按窗口矩形
            // 完成截图发送（与"双击选区内发送"同语义）；winSelImg 仅为选窗缓存，普通框选不受影响
            if (tool === 'select' && winClickTimer != null && winSelImg) {
                clearTimeout(winClickTimer);
                winClickTimer = null;
                sel = { x: winSelImg.x, y: winSelImg.y, w: winSelImg.w, h: winSelImg.h };
                winSelImg = null;
                drawMask();
                output();
                return;
            }
            if (tool !== 'select' || !sel || sel.w < 2 || sel.h < 2) return;
            var pt = toImg(e);
            if (pt.x >= sel.x && pt.x <= sel.x + sel.w && pt.y >= sel.y && pt.y <= sel.y + sel.h) output();
        });

        // 文字输入框：回车提交、Esc 取消（阻止冒泡避免触发编辑器快捷键）
        textInputEl.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') commitText();
            else if (e.key === 'Escape') hideTextInput();
        });

        // 编辑器快捷键：Esc 取消 / Enter 发送（文字输入框内已 stopPropagation）
        document.addEventListener('keydown', function (e) {
            if (!isOpen()) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                // 阶段一百三十九：识别/翻译结果浮层打开时 Esc 先关浮层（不退出整个截图）
                if (ocrCardEl && !ocrCardEl.classList.contains('hidden')) { hideOcrCard(); return; }
                close();
            }
            else if (e.key === 'Enter' && !textInputEl.classList.contains('hidden') === false && mode !== 'record') {
                // 文字输入框隐藏时 Enter 才触发发送（录屏模式 Enter 无发送语义，避免误触截图发送）
                e.preventDefault();
                output();
            }
        });

        // 阶段一百三十九：QQ 同款右键退出截图（与 Esc 同效果）——必须阻止系统默认右键菜单；
        // 文字输入框打开时右键先收起输入框（与 Esc 在输入框内的语义一致，不直接退出整个截图）
        document.addEventListener('contextmenu', function (e) {
            if (!isOpen()) return;
            e.preventDefault();
            // 阶段一百三十九：结果浮层打开时右键先关浮层（层级优先：浮层 > 输入框 > 编辑器）
            if (ocrCardEl && !ocrCardEl.classList.contains('hidden')) { hideOcrCard(); return; }
            if (!textInputEl.classList.contains('hidden')) { hideTextInput(); return; }
            close();
        });
    }

    // 画笔/马赛克线段绘制（逐段落笔）
    function strokeSegment(x1, y1, x2, y2) {
        if (!sel) return;
        withSelClip(function () {
            if (tool === 'brush') {
                dctx.strokeStyle = color;
                dctx.lineWidth = strokeWidth * 2;
                dctx.lineCap = 'round';
                dctx.lineJoin = 'round';
                dctx.beginPath();
                dctx.moveTo(x1, y1);
                dctx.lineTo(x2, y2);
                dctx.stroke();
            } else {
                // 马赛克：圆形裁剪内重贴马赛克底图
                var midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
                dctx.save();
                dctx.beginPath();
                dctx.arc(midX, midY, mosaicR, 0, Math.PI * 2);
                dctx.clip();
                dctx.drawImage(mosaicCanvas, 0, 0);
                dctx.restore();
            }
        });
    }

    // ===== 对外接口 =====
    window.ScreenshotEditor = {
        open: open,
        freeze: freeze,
        freezeVideo: freezeVideo, // 阶段一百三十九：QQ 同款录屏选区（选区交互复用冻结态，倒计时后回调 onStart）
        close: close,
        isOpen: isOpen
    };
})();
