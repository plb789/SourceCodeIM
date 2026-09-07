// agent-executor.js - 阶段六十：Agent 本地执行器核心（纯 Node 模块，不依赖 Electron API，可独立测试）
// 职责：接收服务端下发的工具执行请求（read_file/write_file/run_command），在用户电脑本地执行并回传结果。
// 设计约束（与服务端 agentrun.go 语义对齐）：
//   1. 工作区隔离：所有文件操作严格限制在 <root>/<用户名消毒后>/ 内，拒绝绝对路径/盘符/.. 逃逸（与服务端 agentSafePath 同款双保险）
//   2. 结果约定：output 以"错误："前缀表示工具级失败（模型据此自纠）；执行器仅做本地执行，审批归口在服务端
//   3. 限额一致：read 50000 字符 / write 200000 字符 / 命令输出 8000 字符 / 命令超时上限 300 秒
// 注：PC 端无 GBK 解码依赖，命令输出统一 chcp 65001 切 UTF-8 后按 utf8 解码（与服务端同款策略）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// 与服务端一致的体积/次数上限
const READ_MAX_CHARS = 50000;
const WRITE_MAX_CHARS = 200000;
const CMD_OUT_MAX_CHARS = 8000;
const CMD_TIMEOUT_MAX = 300; // 秒

let workRoot = ''; // 工作区根目录（main 进程启动时 setRoot 注入，默认 userData/agent_workspace）

// 阶段六十一：用户自选工作区/沙箱白名单（按用户名隔离）。
// primary=主工作区（相对路径落盘根目录，空=默认工作区）；dirs=授权目录列表（绝对路径操作仅允许落在这此目录内）。
// 归属校验均在本地执行时强校验（realpath 归一化防符号链接/大小写/分隔符绕过），服务端不感知本地路径细节
const sandboxes = {}; // username → {primary, dirs}

// 用户名 → 子目录名消毒（与服务端 usernameSanitizeRe 同规则：仅保留字母数字下划线中划线与常用中文）
function sanitizeUsername(username) {
    return String(username || '').replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5]/g, '_');
}

// 启动时注入工作区根目录（main.js 调用一次）
function setRoot(root) {
    workRoot = root;
}

function getRoot() {
    return workRoot || path.join(os.tmpdir(), 'agent_workspace');
}

// 阶段六十一：注入用户沙箱白名单（main 进程在每次执行前按请求用户名调用；cfg=null/空=清除回默认语义）
function setSandbox(username, cfg) {
    const key = sanitizeUsername(username);
    if (!cfg || (!cfg.primary && (!cfg.dirs || !cfg.dirs.length))) {
        delete sandboxes[key];
        return;
    }
    sandboxes[key] = {
        primary: String(cfg.primary || ''),
        dirs: (cfg.dirs || []).map(function (d) { return String(d); })
    };
}

function getSandbox(username) {
    return sandboxes[sanitizeUsername(username)] || null;
}

// 用户相对路径的落盘根目录：主工作区（用户自选）优先，未配置回退默认工作区
function userRoot(username) {
    const sb = sandboxes[sanitizeUsername(username)];
    if (sb && sb.primary) return sb.primary;
    return path.join(getRoot(), sanitizeUsername(username));
}

// 阶段六十一：realpath 尽力归一化——目标不存在（write_file 新建场景）时逐级向上归一化最深存在祖先，
// 再按字面拼回不存在尾部（path.resolve 已消化 .. 分量），防符号链接/junction 经不存在的中间目录绕过校验
function realpathBestEffort(p) {
    const cur = path.resolve(String(p));
    try { return fs.realpathSync(cur); } catch (e) {}
    const tail = [];
    let probe = cur;
    for (;;) {
        const parent = path.dirname(probe);
        if (parent === probe) break; // 到达盘符根仍无存在祖先
        tail.unshift(path.basename(probe));
        probe = parent;
        try { return path.join.apply(path, [fs.realpathSync(probe)].concat(tail)); } catch (e) {}
    }
    return null;
}

// 阶段六十一：绝对路径白名单校验归口——realpath 归一化后必须是授权目录（realpath 后）之内。
// 大小写不敏感比较（Windows 盘符/目录名大小写不敏感），分隔符兼容 \ 与 /
function safeAbsPath(username, p) {
    const sb = sandboxes[sanitizeUsername(username)];
    const dirs = (sb && sb.dirs) || [];
    if (!dirs.length) {
        return { err: '未授权任何本地目录（沙箱白名单为空），仅允许工作区内的相对路径' };
    }
    const real = realpathBestEffort(p);
    if (!real) {
        return { err: '路径不存在或无法访问' };
    }
    const realLc = real.toLowerCase();
    for (let i = 0; i < dirs.length; i++) {
        const rd = realpathBestEffort(dirs[i]); // 目录同样 realpath 归一化（防白名单项本身是符号链接）
        if (!rd) continue; // 授权目录当前不可访问，跳过
        const rdLc = rd.toLowerCase();
        if (realLc === rdLc || realLc.startsWith(rdLc.replace(/[\\/]+$/, '') + path.sep)) {
            return { full: real, ws: rd };
        }
    }
    return { err: '路径不在授权目录（沙箱白名单）内：' + real };
}

// 路径安全归口（阶段六十一升级）：
// 相对路径 → 主工作区（用户自选，未配置回退默认工作区）内解析，拒绝 .. 逃逸（与服务端 agentSafePath 双保险同款）；
// 绝对路径 → 沙箱白名单校验（授权目录内才放行）
function safePath(username, p) {
    p = String(p || '').trim();
    if (!p) return { err: '路径不能为空' };
    if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) {
        return safeAbsPath(username, p);
    }
    const clean = path.normalize(p);
    if (clean === '.' || clean === '..' || clean.startsWith('..')) {
        return { err: '路径不允许包含 .. 上级引用' };
    }
    const ws = userRoot(username);
    const full = path.join(ws, clean);
    const rel = path.relative(ws, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { err: '路径越界' };
    }
    return { full: full, ws: ws };
}

// read_file：读工作区文本文件（utf8，超长截断）
function readFileSync(username, params) {
    const { full, err } = safePath(username, params && params.path);
    if (err) return { ok: false, output: '错误：' + err };
    let text;
    try {
        text = fs.readFileSync(full, 'utf8');
    } catch (e) {
        return { ok: false, output: '错误：读取失败 ' + (e.message || e) };
    }
    if (!text.length) return { ok: true, output: '（空文件）' };
    if (text.length > READ_MAX_CHARS) {
        return {
            ok: true,
            output: '文件共 ' + text.length + ' 字符，已截断显示前 ' + READ_MAX_CHARS + ' 字符：\n' + text.slice(0, READ_MAX_CHARS)
        };
    }
    return { ok: true, output: text };
}

// write_file：工作区写文件（自动建父目录；overwrite/append）
function writeFileSync(username, params) {
    const p = params && params.path;
    const content = String((params && params.content) || '');
    let mode = String((params && params.mode) || 'overwrite');
    if (mode !== 'overwrite' && mode !== 'append') {
        return { ok: false, output: '错误：mode 仅支持 overwrite/append' };
    }
    if (content.length > WRITE_MAX_CHARS) {
        return { ok: false, output: '错误：内容超长（' + content.length + ' 字符，上限 ' + WRITE_MAX_CHARS + '）' };
    }
    const { full, err } = safePath(username, p);
    if (err) return { ok: false, output: '错误：' + err };
    try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (mode === 'append') {
            fs.appendFileSync(full, content, 'utf8');
        } else {
            fs.writeFileSync(full, content, 'utf8');
        }
    } catch (e) {
        return { ok: false, output: '错误：写入失败 ' + (e.message || e) };
    }
    const verb = mode === 'append' ? '追加' : '写入';
    return { ok: true, output: '已' + verb + ' ' + p + '（' + Buffer.byteLength(content, 'utf8') + ' 字节）' };
}

// 输出 Buffer 解码归口：UTF-8 严格解码失败则 GBK 兜底（与服务端 agentToolRunCommand 同款策略）。
// 关键教训：windowsHide:true 的隐藏控制台下 chcp 65001 实际不生效，cmd 输出仍为系统 OEM 编码（中文 Windows=GBK），
// 不能假定 chcp 后输出必为 UTF-8，必须按字节检测（UTF-8 严格模式抛错即回退 GBK）
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbkDecoder = new TextDecoder('gbk');
function decodeOutput(buf) {
    try {
        return utf8Strict.decode(buf);
    } catch (e) {
        return gbkDecoder.decode(buf);
    }
}

// run_command：工作区目录执行命令（cmd /C，chcp 65001 统一 UTF-8 输出，超时强杀，输出截断）
function runCommandSync(username, params, done) {
    const command = String((params && params.command) || '').trim();
    if (!command) {
        done({ ok: false, output: '错误：command 不能为空' });
        return;
    }
    let timeoutSec = 60; // 与服务端 agentToolTimeout 默认一致
    const tv = params && params.timeout;
    if (typeof tv === 'number' && tv > 0) {
        timeoutSec = Math.min(tv, CMD_TIMEOUT_MAX);
    }
    const ws = userRoot(username); // 阶段六十一：命令工作目录跟随主工作区（用户自选优先，未配置回退默认），与相对路径写文件落点一致
    try {
        fs.mkdirSync(ws, { recursive: true });
    } catch (e) {
        done({ ok: false, output: '错误：' + (e.message || e) });
        return;
    }
    // chcp 65001 先切控制台代码页（有真实控制台的场景生效；windowsHide 隐藏控制台下不生效，
    // 编码正确性由 decodeOutput 按字节检测兜底，与 Go 服务端同款）
    const cp = exec('chcp 65001 >nul 2>&1 & ' + command, {
        cwd: ws,
        timeout: timeoutSec * 1000,
        killSignal: 'SIGKILL',
        windowsHide: true, // 不闪黑色控制台窗口
        encoding: 'buffer',
        maxBuffer: 4 * 1024 * 1024
    }, function (error, stdout, stderr) {
        let text = decodeOutput(Buffer.concat([Buffer.from(stdout || []), Buffer.from(stderr || [])]));
        if (text.length > CMD_OUT_MAX_CHARS) {
            text = text.slice(0, CMD_OUT_MAX_CHARS) + '\n…（输出过长已截断，共 ' + text.length + ' 字符）';
        }
        if (error) {
            if (error.killed || error.signal === 'SIGKILL') {
                done({ ok: false, output: '错误：命令执行超时（' + timeoutSec + ' 秒），已终止\n输出：\n' + text });
                return;
            }
            // 非零退出码也把已有输出带回（编译报错等场景输出比退出码更有价值）
            done({ ok: false, output: '命令退出码异常：' + (error.code || error.message) + '\n输出：\n' + text });
            return;
        }
        if (!text.trim()) {
            done({ ok: true, output: '（命令执行成功，无输出）' });
            return;
        }
        done({ ok: true, output: text });
    });
    // exec timeout 触发后仍会回调（error.killed=true），无需额外处理
}

// 工具执行入口：main 进程 IPC handler 调用。req = {username, tool, params}
function execTool(req, done) {
    const username = sanitizeUsername(req && req.username);
    const tool = req && req.tool;
    const params = req && req.params;
    switch (tool) {
        case 'read_file':
            done(readFileSync(username, params));
            return;
        case 'write_file':
            done(writeFileSync(username, params));
            return;
        case 'run_command':
            runCommandSync(username, params, done);
            return;
        default:
            done({ ok: false, output: '错误：未知工具 ' + tool });
    }
}

module.exports = {
    setRoot: setRoot,
    getRoot: getRoot,
    setSandbox: setSandbox,
    getSandbox: getSandbox,
    safePath: safePath,
    sanitizeUsername: sanitizeUsername,
    execTool: execTool
};
