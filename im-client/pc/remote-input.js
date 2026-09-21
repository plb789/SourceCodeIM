// remote-input.js - 阶段一百五十五：QQ 同款远程协助——被控端输入注入管理（仅主进程 require）
// 职责：管理常驻 PowerShell SendInput 工作进程（remote-sendinput.ps1，stdin 行协议 + stdout
//      'ready' 握手 + EOF 自退，照 shotPickerProc 模式）；VK 虚拟键映射（e.code → VK 码，
//      仅非打印键；可打印字符走 UNICODE 注入布局无关）；滚轮步进换算
// 非职责：授权校验（grant=view 双保险由引擎与观看窗各自拦截）；信令（chat.js 归口）
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let proc = null;        // PowerShell 工作子进程（懒启动，协助期间存活）
let ready = false;      // 子进程就绪标记（Add-Type 编译约 0.5~1s；就绪前 stdin 写入由管道自然缓冲）
let idleTimer = null;   // 协助结束后延迟回收（频繁协助不反复起停 PowerShell）

// ===== VK 虚拟键映射表（仅非打印键；可打印字符走 UNICODE 注入不吃布局） =====
const VK_BY_CODE = {};
(function () {
    function add(code, vk, ext) { VK_BY_CODE[code] = { vk: vk, ext: !!ext }; }
    for (var f = 1; f <= 24; f++) add('F' + f, 0x70 + f - 1); // F1~F24
    add('Backspace', 0x08); add('Tab', 0x09); add('Enter', 0x0D);
    add('ShiftLeft', 0xA0); add('ShiftRight', 0xA1);
    add('ControlLeft', 0xA2); add('ControlRight', 0xA3, true);
    add('AltLeft', 0xA4); add('AltRight', 0xA5, true);
    add('MetaLeft', 0x5B, true); add('MetaRight', 0x5C, true);
    add('CapsLock', 0x14); add('Escape', 0x1B); add('NumLock', 0x90);
    add('PageUp', 0x21, true); add('PageDown', 0x22, true);
    add('End', 0x23, true); add('Home', 0x24, true);
    add('ArrowLeft', 0x25, true); add('ArrowUp', 0x26, true);
    add('ArrowRight', 0x27, true); add('ArrowDown', 0x28, true);
    add('Insert', 0x2D, true); add('Delete', 0x2E, true);
    add('PrintScreen', 0x2C, true); add('ScrollLock', 0x91); add('Pause', 0x13);
    add('NumpadMultiply', 0x6A); add('NumpadAdd', 0x6B); add('NumpadSubtract', 0x6D);
    add('NumpadDecimal', 0x6E); add('NumpadDivide', 0x6F, true); add('NumpadEnter', 0x0D, true);
    add('ContextMenu', 0x5D, true);
})();

function write(line) {
    if (!proc) return;
    try { proc.stdin.write(line + '\n'); } catch (e) { /* 管道断开等 exit 事件回收，下次事件懒启重建 */ }
}

// 懒启动工作进程（照 shotPickerEnsure：就绪握手 + exit 自清理，事件到来时再次懒启）
function ensure() {
    if (proc) return;
    try {
        // 打包态 ps1 在 asar 内子进程读不到，asarUnpack 后取 app.asar.unpacked 同名文件（开发态无 asar 不替换）
        var ps1 = path.join(__dirname, 'remote-sendinput.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
        proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        ready = false;
        var buf = '';
        proc.stdout.on('data', function (d) {
            buf += d.toString();
            var idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                var line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (line === 'ready') ready = true;
            }
        });
        proc.stderr.on('data', function () { /* 编译告警等静默 */ });
        proc.on('exit', function () {
            proc = null;
            ready = false;
        });
    } catch (err) {
        console.warn('远程协助输入注入服务启动失败:', err);
        proc = null;
    }
}

// 协助结束后延迟回收（30s，与截图窗口识别服务同水位；期间无事件即自动收进程）
function scheduleStop() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, 30000);
}

// 主动回收（协助结束后延迟调用 + 应用退出 will-quit 归口；EOF 自退为主，kill 为兜底强杀）
function stop() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!proc) return;
    var p = proc;
    try { p.stdin.end(); } catch (e) { /* stdin 已断开视为退出中 */ }
    setTimeout(function () { try { p.kill(); } catch (e) { /* 已退出 */ } }, 500);
    proc = null;
    ready = false;
}

// ===== 滚轮步进换算：浏览器 deltaY≈100/格，Windows WHEEL_DELTA=120/格（小步累积到整格再发） =====
var wheelAcc = 0;
function pushWheel(dy) {
    wheelAcc += dy * 1.2;
    var steps = Math.trunc(wheelAcc / 120);
    if (steps !== 0) {
        wheelAcc -= steps * 120;
        write('m wheel ' + (steps * 120));
    }
}

// 键盘事件 → 注入行：先查 VK 表（非打印键 + 扫描码由被控端 MapVirtualKey 解析），
// 未命中且为可打印字符走 UNICODE（布局无关，含大写/符号/中文直注——不依赖被控端键盘
// 状态，无需合成 Shift）；代理对按 UTF-16 码元成对下发
function keyEvent(act, code, key) {
    var m = VK_BY_CODE[code];
    if (m) { write('k ' + act + ' ' + m.vk + ' ' + (m.ext ? 1 : 0)); return; }
    if (typeof key === 'string' && key.length > 0 && key !== 'Dead') {
        var n = Math.min(key.length, 4);
        for (var i = 0; i < n; i++) write('k uni ' + act + ' ' + key.charCodeAt(i));
    }
}

// 事件入口（main.js IPC 'remote:input' 调用；evt 来自被控端主窗口 remote-engine.js DataChannel 桥）
// 格式：{t:'m',act:'move|down|up|wheel',x,y,btn,dy} / {t:'k',act:'down|up',code,key}
function dispatch(evt) {
    if (!evt || !evt.t) return;
    ensure();
    if (!proc) return;
    scheduleStop(); // 活跃期顺延回收
    if (evt.t === 'm') {
        if (evt.act === 'move') {
            // 就绪前高频 move 直接丢（Add-Type 编译窗口期），flush 后首帧即到位
            if (!ready) return;
            write('m move ' + (+evt.x || 0).toFixed(4) + ' ' + (+evt.y || 0).toFixed(4));
        } else if (evt.act === 'down' || evt.act === 'up') {
            write('m ' + evt.act + ' ' + (evt.btn | 0)); // 点击低频，管道缓冲即可，无需等就绪
        } else if (evt.act === 'wheel') {
            if (!ready) return;
            pushWheel(+evt.dy || 0);
        }
    } else if (evt.t === 'k' && (evt.act === 'down' || evt.act === 'up')) {
        if (!ready && evt.act === 'down') return; // 编译窗口期按键丢弃（按键无"最新帧"语义）
        keyEvent(evt.act, evt.code, evt.key);
    }
}

module.exports = { dispatch: dispatch, stop: stop };
