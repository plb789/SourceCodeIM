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
    var mode = 'editor';       // 当前模式：editor（编辑器）/freeze（伪冻结遮罩，第二期）
    var sizeLabel = null;      // 选区尺寸标签（伪冻结模式：拖拽时实时显示 宽×高）

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
        undo: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>'
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

        editorEl.appendChild(wrapEl);
        editorEl.appendChild(toolbarEl);
        editorEl.appendChild(textInputEl);
        editorEl.appendChild(sizeLabel);
        editorEl.appendChild(hintEl);
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
        if (!sel || mode !== 'freeze' || sel.w < 4 || sel.h < 4) { hideSizeLabel(); return; }
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
    function open(blob, confirmCb) {
        load(blob, confirmCb, 'editor');
    }

    // ===== 打开伪冻结遮罩（第二期：画面铺满视口、空选区，拖拽框选后工具栏出现） =====
    // 阶段三十八：第三参 onClose——编辑器关闭（发送或取消）时回调（PC 端用于通知主进程退出全屏冻结态）
    // 阶段三十八：第四参 onReady——冻结画面首帧绘制完成回调（PC 端用于"编辑器就绪后再揭幕"，消除聊天界面闪现）
    var onCloseCb = null; // 冻结模式关闭回调（一次性，close 时消费）
    var onReadyCb = null; // 冻结画面就绪回调（一次性，首帧绘制后消费）
    function freeze(blob, confirmCb, onClose, onReady) {
        onCloseCb = onClose || null;
        onReadyCb = onReady || null;
        load(blob, confirmCb, 'freeze');
    }

    function load(blob, confirmCb, m) {
        if (!editorEl) build();
        onConfirm = confirmCb || null;
        if (m !== 'freeze') { onCloseCb = null; onReadyCb = null; } // 编辑器模式无冻结回调
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
            if (mode === 'freeze') {
                // 伪冻结：cover 铺满视口（居中，溢出部分裁剪），贴近"屏幕被冻结"的观感
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
                sel = null; // 冻结态无选区：必须拖拽框选（微信同款）
                editorEl.classList.add('freeze');
                // 阶段一百三十四：冻结截图期间隐藏自绘标题栏——标题栏 z-index(12000) 故意压过全部浮层，
                // 比编辑器遮罩(3000)高，冻结揭幕后顶部会露出聊天 header（实测 2026-09-16）；
                // 微信/QQ 截图时标题栏同样同步消失。根节点挂 shot-freeze 类，CSS 据此隐藏，close() 时移除
                document.documentElement.classList.add('shot-freeze');
                toolbarEl.classList.remove('visible'); // 选区完成后工具栏才出现
                hintEl.classList.remove('hidden');     // 顶部操作提示：告知拖拽框选
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

    function close() {
        if (!editorEl) return;
        editorEl.classList.add('hidden');
        editorEl.classList.remove('freeze');
        // 阶段一百三十四：退出冻结截图恢复自绘标题栏（与 load() freeze 分支的 add 配对）
        document.documentElement.classList.remove('shot-freeze');
        toolbarEl.classList.remove('visible');
        hideSizeLabel();
        hintEl.classList.add('hidden');
        hideTextInput();
        undoStack = [];
        sel = null;
        mode = 'editor';
        img = null;
        if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = ''; }
        // 阶段三十八：冻结模式关闭回调（发送/取消/Esc 关闭统一触发，PC 端通知主进程退出全屏冻结）
        if (onCloseCb) {
            var cb = onCloseCb;
            onCloseCb = null;
            cb();
        }
    }

    function isOpen() {
        return !!editorEl && !editorEl.classList.contains('hidden');
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
                // 选区工具：允许在空选区（冻结态）下直接拖拽框选
                drawing = true;
                sx = pt.x; sy = pt.y;
                if (mode === 'freeze') {
                    toolbarEl.classList.remove('visible'); // 重新框选期间隐藏工具栏
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
                if (mode === 'freeze') updateSizeLabel(); // 拖拽期间实时显示尺寸（微信同款）
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
            // 冻结态选区完成：工具栏出现（微信同款），尺寸标签保持显示
            if (drawing && mode === 'freeze' && tool === 'select' && sel && sel.w > 4 && sel.h > 4) {
                toolbarEl.classList.add('visible');
                updateSizeLabel();
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
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'Enter' && !textInputEl.classList.contains('hidden') === false) {
                // 文字输入框隐藏时 Enter 才触发发送
                e.preventDefault();
                output();
            }
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
        close: close,
        isOpen: isOpen
    };
})();
