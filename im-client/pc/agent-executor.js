// agent-executor.js - 阶段六十：Agent 本地执行器核心（纯 Node 模块，不依赖 Electron API，可独立测试）
// 职责：接收服务端下发的工具执行请求（read_file/write_file/edit_file/delete_file/list_dir/grep/run_command），在用户电脑本地执行并回传结果。
// 阶段九十：本机 MCP 工具（mcp_pc_ 前缀）经 mcp-manager 调用；阶段九十一：内置浏览器工具（browser_ 前缀）经 browser-manager 调用
// 设计约束（与服务端 agentrun.go 语义对齐）：
//   1. 工作区隔离：所有文件操作严格限制在 <root>/<用户名消毒后>/ 内，拒绝绝对路径/盘符/.. 逃逸（与服务端 agentSafePath 同款双保险）
//   2. 结果约定：output 以"错误："前缀表示工具级失败（模型据此自纠）；执行器仅做本地执行，审批归口在服务端
//   3. 限额一致：read 50000 字符 / write 200000 字符 / 命令输出 8000 字符 / 命令超时上限 300 秒
// 注：PC 端无 GBK 解码依赖，命令输出统一 chcp 65001 切 UTF-8 后按 utf8 解码（与服务端同款策略）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
// 阶段九十：本机 MCP 工具调用归口（用户自定义 stdio 服务器；配置反查由 main 注入 mcpCfgGetter）
const mcpManager = require('./mcp-manager.js');
// 阶段九十一：内置浏览器管理器（与主进程共用同一实例——main.js 亦 require 本模块的宿主进程）
const browserManager = require('./browser-manager.js');

// 与服务端一致的体积/次数上限
const READ_MAX_CHARS = 50000;
const WRITE_MAX_CHARS = 200000;
const CMD_OUT_MAX_CHARS = 8000;
const CMD_TIMEOUT_MAX = 300; // 秒

// 阶段七十四：文件工具补全（list_dir/grep/edit_file/delete_file）与 read_file 分段读取的限额（与服务端同值）
const GREP_MAX_RESULTS = 50;
const GREP_RESULTS_HARD = 200;
const GREP_FILE_MAX_HITS = 20;
const GREP_MAX_FILES = 2000;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_LINE_MAX_CHARS = 200;
const LISTDIR_MAX_ENTRIES = 500;
const SKIP_DIRS = { '.git': 1, '.idea': 1, '.vscode': 1, node_modules: 1, vendor: 1, __pycache__: 1, dist: 1, build: 1, bin: 1, obj: 1, target: 1 };

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

// read_file：读工作区文本文件（utf8，超长截断）。
// 阶段七十四：二进制检测（含 NUL 不灌上下文）、offset/limit 行级分段、字符计数统一 rune 口径（与服务端一致）
function readFileSync(username, params) {
    const { full, err } = safePath(username, params && params.path);
    if (err) return { ok: false, output: '错误：' + err };
    let buf;
    try {
        buf = fs.readFileSync(full);
    } catch (e) {
        return { ok: false, output: '错误：读取失败 ' + (e.message || e) };
    }
    if (buf.includes(0)) {
        return { ok: true, output: '（二进制文件，不支持文本读取，大小 ' + buf.length + ' 字节）' };
    }
    // UTF-8 严格解码失败回退 GBK（decodeOutput 与命令输出同款策略，服务端 read_file 同语义）
    const text = decodeOutput(buf);
    if (!text.length) return { ok: true, output: '（空文件）' };
    // offset/limit 行级分段（行号 1 起；limit<=0 视为读到文件尾）
    const lines = text.split('\n');
    let offset = 1;
    const ov = params && params.offset;
    if (typeof ov === 'number' && ov > 1) offset = Math.floor(ov);
    let end = lines.length;
    const lv = params && params.limit;
    if (typeof lv === 'number' && lv > 0) {
        const e2 = offset - 1 + Math.floor(lv);
        if (e2 < end) end = e2;
    }
    let seg = text;
    if (offset > 1 || end < lines.length) {
        if (offset > lines.length) {
            return { ok: true, output: '（文件共 ' + lines.length + ' 行，offset 超出范围）' };
        }
        seg = lines.slice(offset - 1, end).join('\n').replace(/\n+$/, '');
    }
    const runes = Array.from(seg);
    if (runes.length > READ_MAX_CHARS) {
        return {
            ok: true,
            output: '文件共 ' + runes.length + ' 字符，已截断显示前 ' + READ_MAX_CHARS + ' 字符：\n' + runes.slice(0, READ_MAX_CHARS).join('')
        };
    }
    return { ok: true, output: seg };
}

// ===== 阶段八十：本地执行文件变更审查（撤销/保留）=====
// 服务端审查链路（im_agent_change 表 + 下行 66 帧）仅覆盖服务端工作区；PC 本地执行的文件落在用户磁盘，
// 服务端读不到内容。本模块按「任务+路径」首触把原文件字节备份到本地备份目录（确定性文件名，执行器
// 重启后同路径不重复备份），并在回传结果中携带结构化 changes 数组：服务端据此登记变更（env=pc）并
// 推送审查条；用户点撤销时服务端把备份/本地路径原样下发，由本执行器还原字节（文件在用户磁盘只有本地能还原）。
const crypto = require('crypto');
let backupRoot = path.join(os.tmpdir(), 'im_agent_change_backups');
const PC_CHANGE_MAX_FILES = 200; // 递归删目录逐文件快照上限（与服务端 agentChangeMaxFiles 同值）

// 启动时由 main 进程注入备份根目录（userData/agent_change_backups），并顺手清理孤儿备份
function setBackupRoot(root) {
    backupRoot = String(root || backupRoot);
    pruneChangeBackups();
}

// 备份文件：<root>/<taskID>/<sha1(rel)前16>_<basename>——确定性命名让「首触已备份」可落盘判断
function pcBackupPath(taskId, rel, base) {
    const h = crypto.createHash('sha1').update(String(rel)).digest('hex').slice(0, 16);
    return path.join(backupRoot, String(taskId), h + '_' + base);
}

// 孤儿清理：删除 7 天前的任务备份目录（保留/撤销成功由服务端另行下发清理请求，此处仅兜底）
function pruneChangeBackups() {
    let dirs;
    try { dirs = fs.readdirSync(backupRoot); } catch (e) { return; }
    const week = 7 * 24 * 3600 * 1000;
    dirs.forEach(function (d) {
        const full = path.join(backupRoot, d);
        try { if (Date.now() - fs.statSync(full).mtimeMs > week) fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
    });
}

// 首触备份：本任务该路径未备份过且文件存在 → 备份当前字节，返回备份绝对路径（''=创建语义/读取失败）
function pcEnsureBackup(taskId, rel, full) {
    const bp = pcBackupPath(taskId, rel, path.basename(full));
    try {
        if (fs.existsSync(bp)) return bp; // 首触已备份（含执行器重启后）：复用最早 before
    } catch (e) {}
    let data;
    try { data = fs.readFileSync(full); } catch (e) { return ''; } // 原不存在=创建语义
    try {
        fs.mkdirSync(path.dirname(bp), { recursive: true });
        fs.writeFileSync(bp, data);
    } catch (e) { return ''; }
    return bp;
}

// 操作前调用：无 task_id（旧渲染层）不做审查；否则首触备份，返回备份路径供 pcReport 组装
function pcBegin(taskId, rel, full) {
    if (!taskId) return '';
    return pcEnsureBackup(taskId, rel, full);
}

// 累计行数统计：与任务前原始内容（备份）diff；备份为空=创建语义（全部为新增）；二进制（含 NUL）记 0/0
function pcDiffStat(backup, curText) {
    if (!backup) return { adds: String(curText || '').split('\n').length, dels: 0 };
    let buf;
    try { buf = fs.readFileSync(backup); } catch (e) { return { adds: 0, dels: 0 }; }
    if (buf.includes(0)) return { adds: 0, dels: 0 };
    const before = decodeOutput(buf);
    return { adds: lineDiffStat(before, curText), dels: lineDiffStat(curText, before) };
}

// 变更上报组装：kind=首触行语义（任务前已存在→opKind，不存在→create）；deleted=操作后文件已不在
function pcReport(taskId, rel, full, backup, opKind, curText, deleted) {
    if (!taskId) return null;
    const stat = pcDiffStat(backup, curText);
    return {
        path: String(rel).replace(/\\/g, '/'),
        local: full,
        kind: backup ? opKind : 'create',
        adds: stat.adds,
        dels: stat.dels,
        backup: backup,
        deleted: !!deleted
    };
}

// 撤销本地变更（服务端审查操作下行）：create→删除任务中新建的文件；modify/delete→还原任务前字节
function revertChangesSync(username, params) {
    const list = (params && params.changes) || [];
    let n = 0;
    const errs = [];
    list.forEach(function (c) {
        try {
            if (c && c.kind === 'create' && c.local) {
                fs.rmSync(c.local, { force: true });
            } else if (c && c.backup) {
                const data = fs.readFileSync(c.backup); // 还原任务前原始字节（GBK 原文件按字节还原不转码）
                fs.mkdirSync(path.dirname(c.local), { recursive: true });
                fs.writeFileSync(c.local, data);
            } else {
                return;
            }
            try { if (c.backup) fs.rmSync(c.backup, { force: true }); } catch (e) {}
            n++;
        } catch (e) {
            errs.push((c && c.path || '?') + '：' + (e.message || e));
        }
    });
    if (errs.length) return { ok: false, output: '错误：部分撤销失败\n' + errs.join('\n') };
    return { ok: true, output: '已撤销 ' + n + ' 项本地变更' };
}

// 保留后备份清理（fire-and-forget）：逐个删备份文件，空任务目录顺手移除
function cleanupBackupsSync(username, params) {
    const list = (params && params.backups) || [];
    list.forEach(function (b) {
        try { if (b) fs.rmSync(b, { force: true }); } catch (e) {}
    });
    try {
        const dirs = {};
        list.forEach(function (b) { if (b) dirs[path.dirname(path.resolve(String(b)))] = 1; });
        Object.keys(dirs).forEach(function (d) {
            if (!d.startsWith(path.resolve(backupRoot))) return; // 越界防护：仅清备份根内目录
            try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch (e) {}
        });
    } catch (e) {}
    return { ok: true, output: '已清理 ' + list.length + ' 项备份' };
}

// write_file：工作区写文件（自动建父目录；overwrite/append）
function writeFileSync(taskId, username, params) {
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
    const rel = String(p).replace(/\\/g, '/');
    const bak = pcBegin(taskId, rel, full); // 写前首触备份（''=任务前不存在，创建语义）
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
    // 变更统计口径：任务前原始内容（备份）vs 落盘后全文（覆盖追加链、create 后 append 等场景统一准确）
    let curText = content;
    if (taskId) {
        try { curText = decodeOutput(fs.readFileSync(full)); } catch (e) { curText = content; }
    }
    const change = pcReport(taskId, rel, full, bak, 'modify', curText, false);
    const verb = mode === 'append' ? '追加' : '写入';
    const res = { ok: true, output: '已' + verb + ' ' + p + '（' + Buffer.byteLength(content, 'utf8') + ' 字节）' };
    if (change) res.changes = [change];
    return res;
}

// edit_file 阶段七十四：精确替换编辑（old_string→new_string），语义与服务端 agentToolEditFile 一致：
// old_string 须逐字一致；多处匹配要求唯一化或显式 replace_all；GBK 文件编辑后统一转存 UTF-8
function editFileSync(taskId, username, params) {
    const p = params && params.path;
    const oldStr = String((params && params.old_string) || '');
    const newStr = String((params && params.new_string) || '');
    const replaceAll = !!(params && params.replace_all);
    if (!oldStr.trim()) return { ok: false, output: '错误：old_string 不能为空' };
    if (oldStr === newStr) return { ok: false, output: '错误：old_string 与 new_string 相同，无内容变化' };
    if (Array.from(oldStr).length > WRITE_MAX_CHARS || Array.from(newStr).length > WRITE_MAX_CHARS) {
        return { ok: false, output: '错误：替换内容超长（单次上限 ' + WRITE_MAX_CHARS + ' 字符）' };
    }
    const { full, err } = safePath(username, p);
    if (err) return { ok: false, output: '错误：' + err };
    const rel = String(p).replace(/\\/g, '/');
    const bak = pcBegin(taskId, rel, full); // 改前首触备份（''=任务前不存在——edit 目标必存在，此仅备份失败兜底）
    let buf;
    try {
        buf = fs.readFileSync(full);
    } catch (e) {
        return { ok: false, output: '错误：读取失败 ' + (e.message || e) };
    }
    if (buf.includes(0)) return { ok: false, output: '错误：不支持编辑二进制文件' };
    const text = decodeOutput(buf);
    const count = text.split(oldStr).length - 1;
    if (count === 0) {
        return { ok: false, output: '错误：未找到目标文本（old_string 须与文件内容精确一致，含缩进与换行；可先用 grep/read_file 确认原文）' };
    }
    if (count > 1 && !replaceAll) {
        return { ok: false, output: '错误：目标文本匹配 ' + count + ' 处，请扩大 old_string 上下文使其唯一，或传 replace_all=true 全部替换' };
    }
    const newText = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    try {
        fs.writeFileSync(full, newText, 'utf8');
    } catch (e) {
        return { ok: false, output: '错误：写入失败 ' + (e.message || e) };
    }
    const add = lineDiffStat(text, newText);
    const del = lineDiffStat(newText, text);
    const res = { ok: true, output: '已编辑 ' + p + '（+' + add + ' -' + del + '，替换 ' + count + ' 处）' };
    // 阶段八十：变更审查上报——统计口径与摘要行不同（摘要=本次替换 diff；上报=任务前原始内容整体 diff）
    const change = pcReport(taskId, rel, full, bak, 'modify', newText, false);
    if (change) res.changes = [change];
    return res;
}

// delete_file 阶段七十四：删除文件/目录（审批归口服务端；非空目录必须 recursive=true）
// 阶段八十：删前逐文件首触备份（递归目录与服务端同款 WalkDir 快照语义），回传 changes 供审查撤销
function deleteFileSync(taskId, username, params) {
    const p = params && params.path;
    const recursive = !!(params && params.recursive);
    const { full, err } = safePath(username, p);
    if (err) return { ok: false, output: '错误：' + err };
    const rel = String(p).replace(/\\/g, '/');
    let stat;
    try {
        stat = fs.statSync(full);
    } catch (e) {
        return { ok: false, output: '错误：目标不存在 ' + (e.message || e) };
    }
    const changes = [];
    if (stat.isDirectory()) {
        if (!recursive) {
            try {
                fs.rmdirSync(full); // 仅空目录；非空抛错走下方提示
            } catch (e) {
                return { ok: false, output: '错误：' + p + ' 是目录且非空，需传 recursive=true 递归删除' };
            }
            return { ok: true, output: '已删除目录 ' + p + '/（空目录）' };
        }
        // 与服务端同款：删前逐文件快照（上限 PC_CHANGE_MAX_FILES，超出不记变更不可撤销）
        const snap = [];
        try {
            (function walk(dir, relDir) {
                if (snap.length >= PC_CHANGE_MAX_FILES) return;
                let items;
                try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
                items.forEach(function (it) {
                    if (snap.length >= PC_CHANGE_MAX_FILES) return;
                    const fp = path.join(dir, it.name);
                    const rp = relDir ? relDir + '/' + it.name : it.name;
                    if (it.isDirectory()) walk(fp, rp);
                    else snap.push({ full: fp, rel: rp });
                });
            })(full, '');
        } catch (e) {}
        const backs = snap.map(function (f) { return pcBegin(taskId, rel + '/' + f.rel, f.full); });
        let n = 1; // 统计口径含根目录本身（与服务端 WalkDir 一致）；删前统计（删后目录已不存在读不到）
        try { countEntries(full, function () { n++; }); } catch (e) {}
        try {
            fs.rmSync(full, { recursive: true, force: false });
        } catch (e) {
            return { ok: false, output: '错误：删除失败 ' + (e.message || e) };
        }
        if (taskId) {
            snap.forEach(function (f, i) {
                if (backs[i]) changes.push(pcReport(taskId, rel + '/' + f.rel, f.full, backs[i], 'delete', '', true));
            });
        }
        const res = { ok: true, output: '已删除目录 ' + p + '/（递归，含 ' + n + ' 个条目）' };
        if (changes.length) res.changes = changes.filter(Boolean);
        return res;
    }
    const bak = pcBegin(taskId, rel, full); // 删前首触备份（撤销还原）
    try {
        fs.unlinkSync(full);
    } catch (e) {
        return { ok: false, output: '错误：删除失败 ' + (e.message || e) };
    }
    const res = { ok: true, output: '已删除文件 ' + p + '（' + stat.size + ' 字节）' };
    const change = pcReport(taskId, rel, full, bak, 'delete', '', true);
    if (change) res.changes = [change];
    return res;
}

// 递归统计条目数（delete_file 结果说明用；失败不阻断删除主流程）
function countEntries(dir, cb) {
    const items = fs.readdirSync(dir);
    items.forEach(function (name) {
        const fp = path.join(dir, name);
        const st = fs.statSync(fp);
        cb();
        if (st.isDirectory()) countEntries(fp, cb);
    });
}

// list_dir 阶段七十四：列目录（子目录在前、文件在后，各按名排序，含文件大小；与服务端同款输出）
function listDirSync(username, params) {
    let p = String((params && params.path) || '').trim();
    let full;
    if (!p || p === '.') {
        full = userRoot(username); // 缺省列工作区根目录
    } else {
        const r = safePath(username, p);
        if (r.err) return { ok: false, output: '错误：' + r.err };
        full = r.full;
    }
    let entries;
    try {
        entries = fs.readdirSync(full, { withFileTypes: true });
    } catch (e) {
        return { ok: false, output: '错误：' + (e.message || e) };
    }
    if (!entries.length) return { ok: true, output: '（空目录）' };
    const dirs = entries.filter(function (e) { return e.isDirectory(); }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    const files = entries.filter(function (e) { return !e.isDirectory(); }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    const lines = [];
    let truncated = false;
    dirs.concat(files).forEach(function (e) {
        if (lines.length >= LISTDIR_MAX_ENTRIES) { truncated = true; return; }
        if (e.isDirectory()) { lines.push(e.name + '/'); return; }
        let size = '';
        try {
            size = '（' + fs.statSync(path.join(full, e.name)).size + ' 字节）';
        } catch (err) {}
        lines.push(e.name + ' ' + size);
    });
    let head = '共 ' + entries.length + ' 个条目';
    if (truncated) head += '（仅显示前 ' + lines.length + ' 条）';
    return { ok: true, output: head + '：\n' + lines.join('\n') };
}

// grep 阶段七十四：内容搜索（文件:行号: 内容），字面/正则双模式，防护项与服务端一致
function grepSync(username, params) {
    const pattern = String((params && params.pattern) || '');
    if (!pattern.trim()) return { ok: false, output: '错误：pattern 不能为空' };
    const isRegex = !!(params && params.is_regex);
    let re;
    try {
        // 注：is_regex 模式下正则语法以运行时引擎为准（与服务端 Go regexp 存在少量语法差异）
        re = isRegex ? new RegExp(pattern) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    } catch (e) {
        return { ok: false, output: '错误：正则表达式无效 ' + (e.message || e) };
    }
    const include = String((params && params.include) || '').trim();
    let incRe = null;
    if (include) {
        try {
            incRe = new RegExp('^' + include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]') + '$', 'i');
        } catch (e) {
            return { ok: false, output: '错误：include 通配符无效 ' + (e.message || e) };
        }
    }
    let maxResults = GREP_MAX_RESULTS;
    const mv = params && params.max_results;
    if (typeof mv === 'number' && mv >= 1) maxResults = Math.min(Math.floor(mv), GREP_RESULTS_HARD);
    // 起点：path 缺省为工作区根；显式 path 走安全校验（可为文件或目录）
    let p = String((params && params.path) || '').trim();
    let root, isFileRoot = false;
    if (!p || p === '.') {
        root = userRoot(username);
    } else {
        const r = safePath(username, p);
        if (r.err) return { ok: false, output: '错误：' + r.err };
        root = r.full;
    }
    let st;
    try {
        st = fs.statSync(root);
    } catch (e) {
        return { ok: false, output: '错误：' + (e.message || e) };
    }
    isFileRoot = st.isFile();
    const hits = [];
    let fileCount = 0;
    let stop = false;
    function relPath(fp) {
        const base = isFileRoot ? path.dirname(root) : root;
        return path.relative(base, fp).replace(/\\/g, '/');
    }
    function walk(dir) {
        if (stop) return;
        let items;
        try {
            items = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) { return; }
        items.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        items.forEach(function (ent) {
            if (stop) return;
            const fp = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (SKIP_DIRS[ent.name]) return;
                walk(fp);
                return;
            }
            if (!ent.isFile()) return;
            if (hits.length >= maxResults || fileCount >= GREP_MAX_FILES) { stop = true; return; }
            fileCount++;
            if (incRe && !incRe.test(ent.name)) return;
            let fi;
            try { fi = fs.statSync(fp); } catch (e) { return; }
            if (fi.size > GREP_MAX_FILE_BYTES) return;
            let buf;
            try { buf = fs.readFileSync(fp); } catch (e) { return; }
            if (buf.includes(0)) return; // 二进制跳过
            const text = decodeOutput(buf);
            let fileHits = 0;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (hits.length >= maxResults) { stop = true; break; }
                if (fileHits >= GREP_FILE_MAX_HITS) break; // 单文件命中过多仅展示前缀
                if (!re.test(lines[i])) continue;
                let shown = lines[i].trim();
                const rr = Array.from(shown);
                if (rr.length > GREP_LINE_MAX_CHARS) shown = rr.slice(0, GREP_LINE_MAX_CHARS).join('') + '…';
                hits.push(relPath(fp) + ':' + (i + 1) + ': ' + shown);
                fileHits++;
            }
        });
    }
    if (isFileRoot) {
        fileCount = 1;
        if (incRe && !incRe.test(path.basename(root))) {
            /* 单文件起点也受 include 过滤 */
        } else {
            let buf;
            try { buf = fs.readFileSync(root); } catch (e) { buf = null; }
            if (buf && !buf.includes(0) && (!st || st.size <= GREP_MAX_FILE_BYTES)) {
                const text = decodeOutput(buf);
                let fileHits = 0;
                text.split('\n').forEach(function (line, i) {
                    if (hits.length >= maxResults || fileHits >= GREP_FILE_MAX_HITS) return;
                    if (!re.test(line)) return;
                    let shown = line.trim();
                    const rr = Array.from(shown);
                    if (rr.length > GREP_LINE_MAX_CHARS) shown = rr.slice(0, GREP_LINE_MAX_CHARS).join('') + '…';
                    hits.push(path.basename(root) + ':' + (i + 1) + ': ' + shown);
                    fileHits++;
                });
            }
        }
    } else {
        walk(root);
    }
    if (!hits.length) return { ok: true, output: '（无匹配结果）' };
    let tail = '';
    if (hits.length >= maxResults) tail = '\n…（已达 ' + maxResults + ' 条上限，结果可能不完整，可缩小 path/include 范围或提高 max_results）';
    else if (fileCount >= GREP_MAX_FILES) tail = '\n…（遍历文件数已达 ' + GREP_MAX_FILES + ' 上限，结果可能不完整）';
    return { ok: true, output: '共 ' + hits.length + ' 处匹配：\n' + hits.join('\n') + tail };
}

// 行级 diff 统计（多行集合交集近似，与服务端 agentLineDiffStat 同款；调用方按正反两方向各取 added/removed）
function lineDiffStat(a, b) {
    const setA = {};
    String(a).split('\n').forEach(function (l) { setA[l] = (setA[l] || 0) + 1; });
    let common = 0;
    let countB = 0;
    String(b).split('\n').forEach(function (l) {
        countB++;
        if (setA[l] > 0) { setA[l]--; common++; }
    });
    return countB - common;
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

// run_command：工作区目录执行命令（cmd /C，超时强杀，输出截断）。
// 阶段七十五：与服务端 agentToolRunCommand 同款语义——输出管道流式读取，行级聚合 200ms 节流
// 经 onFrame 回调上行（渲染层转发服务端转任务事件流，控制台实时可见）；执行期间可"转后台"
// （requestBg 触发）：立即回传"已转入后台"不阻塞模型，进程继续跑完，终帧 final=true 带退出码/耗时。
// 后台兜底 30 分钟强杀。行级字节缓冲转码（UTF-8 严格 + GBK 兜底），多字节字符跨块不断裂
const CMD_STREAM_MAX_BYTES = 64 * 1024; // 控制台流式下发累计上限（与服务端 agentCmdStreamMaxBytes 一致）
const CMD_STREAM_FLUSH_MS = 200;        // 输出聚合下发节流（毫秒，与服务端一致）
const CMD_BG_TIMEOUT_MS = 30 * 60 * 1000; // 转后台兜底强杀

// 每用户当前运行中命令登记（requestBg 归口；同用户同时至多一条命令——服务端任务队列串行派发）
const runningCmds = {};

// requestBg 阶段七十五：转后台请求入口（main 进程 IPC agent:bg 调用）。
// 命中运行中命令 → 触发其 bg 回调（runCommandSync 内立即 done 返回、进程继续）返回 true；无运行中命令返回 false
function requestBg(username) {
    const rc = runningCmds[username];
    if (rc && !rc.done) {
        rc.bgRequested = true;
        if (typeof rc.onBg === 'function') rc.onBg();
        return true;
    }
    return false;
}

function runCommandSync(username, params, done, onFrame) {
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
    let child;
    try {
        child = spawn('cmd', ['/C', 'chcp 65001 >nul 2>&1 & ' + command], {
            cwd: ws,
            windowsHide: true, // 不闪黑色控制台窗口
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (e) {
        done({ ok: false, output: '错误：' + (e.message || e) });
        return;
    }
    const startedAt = Date.now();

    // 输出泵：stdout/stderr 按行收口（\n 单字节不会切断多字节序列，行级整体转码安全）；
    // 累计超 CMD_STREAM_MAX_BYTES 停止下发增量（over 标记），模型结果仍全量另存（head+tail 环形）
    let lineBuf = Buffer.alloc(0);
    let total = 0;
    let over = false;
    let fullText = '';
    let pendingFrame = null; // 200ms 聚合窗口内的待下发行
    const pushFrame = function (chunk, isFinal) {
        if (typeof onFrame === 'function') {
            onFrame({
                chunk: chunk,
                total_bytes: total,
                over: over,
                final: !!isFinal,
                exit_code: isFinal ? exitCode : 0,
                duration_ms: Date.now() - startedAt
            });
        }
    };
    let exitCode = 0;
    let timedOut = false;
    let bgd = false;
    let finished = false;

    const addLine = function (raw) {
        total += raw.length;
        let text;
        try { text = utf8Strict.decode(raw); } catch (e) { text = gbkDecoder.decode(raw); }
        // 模型结果环形保留（上限 head 8KB + tail 56KB，与服务端同款语义）
        if (fullText.length <= CMD_OUT_FULL_MAX) {
            fullText += text;
            if (fullText.length > CMD_OUT_FULL_MAX) {
                fullText = fullText.slice(0, CMD_OUT_FULL_HEAD) + '\n…（中间输出已截断）…\n' + fullText.slice(-CMD_OUT_FULL_TAIL);
            }
        }
        if (total > CMD_STREAM_MAX_BYTES) { over = true; return; }
        pendingFrame = (pendingFrame || '') + text;
    };
    const pump = function (stream) {
        stream.on('data', function (buf) {
            let data = buf;
            while (data.length) {
                const nl = data.indexOf(0x0A);
                if (nl < 0) { lineBuf = Buffer.concat([lineBuf, data]); data = Buffer.alloc(0); break; }
                let line = data.slice(0, nl + 1);
                data = data.slice(nl + 1);
                if (lineBuf.length) { line = Buffer.concat([lineBuf, line]); lineBuf = Buffer.alloc(0); }
                addLine(line);
            }
        });
    };
    pump(child.stdout);
    pump(child.stderr);

    // 节流下发：200ms 聚合一次（与服务端一致，防逐行刷屏拖垮 WS/IPC）
    const tick = setInterval(function () {
        if (finished || !pendingFrame) return;
        const chunk = pendingFrame;
        pendingFrame = null;
        pushFrame(chunk, false);
    }, CMD_STREAM_FLUSH_MS);

    // 前台超时强杀（转后台时切换为 30 分钟兜底）
    let killTimer = setTimeout(function () { timedOut = true; try { child.kill('SIGKILL'); } catch (e) {} }, timeoutSec * 1000);

    const cleanup = function () {
        clearInterval(tick);
        clearTimeout(killTimer);
        delete runningCmds[username];
        finished = true;
    };

    // 转后台：立即回传"已转入后台"（不阻塞模型），进程继续，输出继续流，结束发 final 终帧
    runningCmds[username] = {
        onBg: function () {
            if (bgd || finished) return;
            bgd = true;
            clearTimeout(killTimer); // 停前台超时
            killTimer = setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} }, CMD_BG_TIMEOUT_MS);
            done({ ok: true, output: '命令已转入后台执行（输出在任务卡控制台实时展示；结束后控制台显示退出码，无需等待即可继续其他操作）' });
        }
    };

    const finish = function (code) {
        if (bgd) { // 转后台进程结束：仅发终帧（前端控制台显示退出码），不再回传结果
            cleanup();
            if (pendingFrame) { pushFrame(pendingFrame, false); pendingFrame = null; }
            exitCode = code;
            pushFrame('', true);
            return;
        }
        cleanup();
        if (pendingFrame) { pushFrame(pendingFrame, false); pendingFrame = null; }
        exitCode = code;
        pushFrame('', true);
        let text = fullText;
        if (text.length > CMD_OUT_MAX_CHARS) {
            text = text.slice(0, CMD_OUT_MAX_CHARS) + '\n…（输出过长已截断，共 ' + text.length + ' 字符）';
        }
        if (timedOut) {
            done({ ok: false, output: '错误：命令执行超时（' + timeoutSec + ' 秒），已终止\n输出：\n' + text });
            return;
        }
        if (code !== 0) {
            // 非零退出码也把已有输出带回（编译报错等场景输出比退出码更有价值）
            done({ ok: false, output: '命令退出码异常：' + code + '\n输出：\n' + text });
            return;
        }
        if (!text.trim()) {
            done({ ok: true, output: '（命令执行成功，无输出）' });
            return;
        }
        done({ ok: true, output: text });
    };
    child.on('error', function (e) {
        if (finished || bgd) return;
        cleanup();
        done({ ok: false, output: '错误：' + (e.message || e) });
    });
    child.on('close', function (code) {
        if (lineBuf.length) { addLine(lineBuf); lineBuf = Buffer.alloc(0); } // 无换行尾行收口
        finish(code === null ? (timedOut ? -1 : 0) : code);
    });
}

// 模型结果环形保留容量（head+tail，与服务端 fullHead/fullTail 语义一致）
const CMD_OUT_FULL_MAX = 64 * 1024;
const CMD_OUT_FULL_HEAD = 8 * 1024;
const CMD_OUT_FULL_TAIL = 56 * 1024;

// 工具执行入口：main 进程 IPC handler 调用。req = {username, tool, params, task_id}
// task_id 阶段八十：本地文件工具据此做首触备份并回传 changes（缺省=旧渲染层，不做变更审查）
function execTool(req, done) {
    const username = sanitizeUsername(req && req.username);
    const tool = req && req.tool;
    const params = req && req.params;
    const taskId = String((req && req.task_id) || '');
    switch (tool) {
        case 'read_file':
            done(readFileSync(username, params));
            return;
        case 'write_file':
            done(writeFileSync(taskId, username, params));
            return;
        case 'edit_file':
            done(editFileSync(taskId, username, params));
            return;
        case 'delete_file':
            done(deleteFileSync(taskId, username, params));
            return;
        case 'list_dir':
            done(listDirSync(username, params));
            return;
        case 'grep':
            done(grepSync(username, params));
            return;
        case 'run_command':
            runCommandSync(username, params, done);
            return;
        // 阶段八十：变更审查下行（撤销=还原字节并删备份；保留=仅清理备份），文件在用户磁盘只有本地能执行
        case 'agent_revert_change':
            done(revertChangesSync(username, params));
            return;
        case 'agent_cleanup_backups':
            done(cleanupBackupsSync(username, params));
            return;
        default:
            // 阶段九十：本机 MCP 工具（服务端注入命名空间 mcp_pc_<服务器>_<工具>），走 mcp-manager 常驻会话调用
            if (String(tool || '').indexOf('mcp_pc_') === 0) {
                callPcMcp(username, tool, params, done);
                return;
            }
            // 阶段九十一：内置浏览器工具（browser_navigate/snapshot/click/input/screenshot/eval/tabs/close），
            // browser-manager 与本执行器同在主进程，直调免二次 IPC
            if (String(tool || '').indexOf('browser_') === 0) {
                callBrowserTool(tool, params, done);
                return;
            }
            done({ ok: false, output: '错误：未知工具 ' + tool });
    }
}

// ===== 阶段九十一：内置浏览器工具调用 =====
// browser-manager.js 归口实现（WebContentsView 多标签页/快照/截图/脚本），这里仅 Promise→done 桥接
function callBrowserTool(tool, params, done) {
    browserManager.agentExecute(tool, params).then(function (r) {
        done(r || { ok: false, output: '错误：内置浏览器工具无返回' });
    }).catch(function (e) {
        done({ ok: false, output: '错误：内置浏览器调用异常——' + (e.message || e) });
    });
}

// ===== 阶段九十：本机 MCP 工具调用 =====
// 服务端注入的工具清单不含 env/command（凭据不出本机）；调用时按需反查配置兜底建连
let mcpCfgGetter = null;
function setMcpCfgGetter(fn) {
    mcpCfgGetter = fn;
}

function callPcMcp(username, tool, params, done) {
    if (!mcpCfgGetter) {
        done({ ok: false, output: '错误：本机 MCP 功能不可用' });
        return;
    }
    mcpManager.callTool(username, tool, params || {}, mcpCfgGetter).then(function (r) {
        done(r);
    }).catch(function (e) {
        done({ ok: false, output: '错误：本机 MCP 调用异常——' + (e.message || e) });
    });
}

// ===== 阶段七十六：工作区文件面板（web 右侧文件树/预览/编辑，经服务端 msg 64 转发到本地磁盘执行）=====
// 路径校验与 Agent 工具同源（safePath：相对路径→主工作区，绝对路径→沙箱授权目录），白名单外一律拒绝。
// 限额：单次读取 512KB（超出截断）；二进制检测（前 8KB 含 NUL）；非 UTF-8 按 GBK 兜底转码（与命令输出同款）。
const WS_FILE_READ_MAX = 512 * 1024;

// 一级目录列表（tree）：子目录在前文件在后，跳过噪音目录；返回真实工作区根路径供面板展示
function fileTreeLevel(username, p) {
    let full, ws;
    const pv = String(p || '').trim();
    if (!pv || pv === '.') {
        ws = userRoot(username);
        full = ws;
    } else {
        const r = safePath(username, pv);
        if (r.err) return { ok: false, error: r.err };
        full = r.full;
        ws = r.ws;
    }
    let entries;
    try {
        entries = fs.readdirSync(full, { withFileTypes: true });
    } catch (e) {
        return { ok: false, error: '无法读取目录：' + (e.message || e) };
    }
    const list = [];
    for (const it of entries) {
        if (SKIP_DIRS[it.name]) continue;
        try {
            if (it.isDirectory()) {
                list.push({ name: it.name, dir: true });
            } else {
                let size = 0;
                try { size = fs.statSync(path.join(full, it.name)).size; } catch (e) {}
                list.push({ name: it.name, dir: false, size: size });
            }
        } catch (e) { continue; } // 权限等异常条目直接跳过
    }
    list.sort(function (a, b) {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
    });
    let rootLabel = ws;
    try { rootLabel = fs.realpathSync(ws); } catch (e) {}
    return { ok: true, root: rootLabel, entries: list };
}

// 读文件（read）：文本内容（截断标记）；二进制只给标记不回传内容
function fileReadLevel(username, p) {
    const r = safePath(username, p);
    if (r.err) return { ok: false, error: r.err };
    let st;
    try { st = fs.statSync(r.full); } catch (e) {
        return { ok: false, error: '文件不存在或无法访问' };
    }
    if (st.isDirectory()) return { ok: false, error: '目标是目录，请展开浏览' };
    let fd = null;
    try {
        fd = fs.openSync(r.full, 'r');
        const buf = Buffer.alloc(Math.min(st.size, WS_FILE_READ_MAX));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const data = buf.subarray(0, n);
        const head = data.subarray(0, Math.min(n, 8000));
        const truncated = st.size > n;
        if (head.includes(0)) return { ok: true, binary: true, truncated: truncated };
        let text = decodeOutput(data); // UTF-8 严格解码失败回退 GBK（与命令输出同款）
        return { ok: true, content: text, truncated: truncated };
    } catch (e) {
        return { ok: false, error: '读取失败：' + (e.message || e) };
    } finally {
        try { if (fd !== null) fs.closeSync(fd); } catch (e) {}
    }
}

// 读二进制转 base64（readb，≤2MB）：供 web 前端解析 docx 等文档预览（经 65 上行回传，需在 WS 读限 4MB 内）
function fileReadB64Level(username, p) {
    const r = safePath(username, p);
    if (r.err) return { ok: false, error: r.err };
    let st;
    try { st = fs.statSync(r.full); } catch (e) {
        return { ok: false, error: '文件不存在或无法访问' };
    }
    if (st.isDirectory()) return { ok: false, error: '目标是目录，请展开浏览' };
    if (st.size > 2 * 1024 * 1024) return { ok: false, error: '文档过大（超过 2MB），暂不支持预览' };
    try {
        const buf = fs.readFileSync(r.full);
        return { ok: true, binary: true, content: buf.toString('base64') };
    } catch (e) {
        return { ok: false, error: '读取失败：' + (e.message || e) };
    }
}

// 写文件（save）：UTF-8 落盘，自动建父目录（与 write_file 工具同语义）
function fileSaveLevel(username, p, content) {
    const r = safePath(username, p);
    if (r.err) return { ok: false, error: r.err };
    try {
        fs.mkdirSync(path.dirname(r.full), { recursive: true });
        fs.writeFileSync(r.full, String(content == null ? '' : content), 'utf8');
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '保存失败：' + (e.message || e) };
    }
}

// ===== 工作区文件管理操作（右键菜单：delete/rename/newfile/newdir/reveal）=====
// 名字合法性：取末段文件名，禁路径分隔符/..、Windows 非法字符与控制字符
function wsEntryName(name) {
    name = String(name || '').trim().replace(/\\/g, '/');
    const i = name.lastIndexOf('/');
    if (i >= 0) name = name.slice(i + 1);
    if (!name || name === '.' || name === '..') return null;
    if (/[<>:"|?*\u0000-\u001f]/.test(name)) return null;
    return name;
}

// 删除文件/目录（递归）：根目录与工作区外一律拒绝
function fileDeleteLevel(username, p) {
    const r = safePath(username, p);
    if (r.err) return { ok: false, error: r.err };
    if (!r.full || path.resolve(r.full) === path.resolve(userRoot(username))) {
        return { ok: false, error: '不能删除工作区根目录' };
    }
    try {
        if (!fs.existsSync(r.full)) return { ok: false, error: '文件不存在或无法访问' };
        fs.rmSync(r.full, { recursive: true });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '删除失败：' + (e.message || e) };
    }
}

// 重命名（仅本级改名，不跨目录移动）：目标名冲突拒绝；Windows 大小写改名豁免存在性检查
function fileRenameLevel(username, p, newName) {
    const r = safePath(username, p);
    if (r.err) return { ok: false, error: r.err };
    newName = wsEntryName(newName);
    if (!newName) return { ok: false, error: '名称非法（不能包含路径分隔符与 <>:"|?* 等字符）' };
    if (!r.full || path.resolve(r.full) === path.resolve(userRoot(username))) {
        return { ok: false, error: '不能重命名工作区根目录' };
    }
    try {
        if (!fs.existsSync(r.full)) return { ok: false, error: '文件不存在或无法访问' };
        const dst = path.join(path.dirname(r.full), newName);
        const sameCase = dst.toLowerCase() === path.resolve(r.full).toLowerCase();
        if (!sameCase && fs.existsSync(dst)) return { ok: false, error: '同名文件已存在' };
        fs.renameSync(r.full, dst);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '重命名失败：' + (e.message || e) };
    }
}

// 新建文件/目录（path=父级目录，相对根；content=名称）；空父级=工作区根（与 fileTreeLevel 同款特判，safePath 不收空路径）
function fileCreateLevel(username, parent, name, isDir) {
    let full;
    const pv = String(parent || '').trim();
    if (!pv || pv === '.' || pv === '/') {
        full = userRoot(username);
    } else {
        const r = safePath(username, pv);
        if (r.err) return { ok: false, error: r.err };
        full = r.full;
    }
    name = wsEntryName(name);
    if (!name) return { ok: false, error: '名称非法（不能包含路径分隔符与 <>:"|?* 等字符）' };
    try {
        const st = fs.statSync(full);
        if (!st.isDirectory()) return { ok: false, error: '目标父级不是目录' };
    } catch (e) {
        return { ok: false, error: '父目录不存在' };
    }
    const dst = path.join(full, name);
    if (fs.existsSync(dst)) return { ok: false, error: '同名文件已存在' };
    try {
        if (isDir) fs.mkdirSync(dst);
        else fs.writeFileSync(dst, '', { flag: 'wx' });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: (isDir ? '创建目录失败：' : '创建文件失败：') + (e.message || e) };
    }
}

// 打开所在目录（仅 Windows 资源管理器）：文件定位选中（explorer /select），目录直接打开
function fileRevealLevel(username, p) {
    const r = safePath(username, p);
    if (r.err) return { ok: false, error: r.err };
    try {
        const st = fs.statSync(r.full);
        const { spawn } = require('child_process');
        if (st.isDirectory()) spawn('explorer', [r.full], { detached: true, stdio: 'ignore' }).unref();
        else spawn('explorer', ['/select,', r.full], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '打开目录失败：' + (e.message || e) };
    }
}

// ===== 源代码管理（Trae CN 同款）：git 子命令本地执行 =====
// execFile 异步执行（push/pull 可达分钟级，同步等待会阻塞主进程冻结客户端）；参数数组直传不经 shell，
// 无注入面；-c core.quotepath=off 让中文文件名原样输出而非八进制转义。结果契约与服务端一致：
// 成功/业务失败均 ok:true + content JSON（业务失败带 error 字段），仅 git 不存在等硬错误 ok:false。
const GIT_SUB_SPEC = {
    status:   { args: ['status', '--porcelain=v1', '-b'], timeout: 20000 },
    diff:     { args: ['diff', 'HEAD', '--'],             timeout: 20000, needPath: true },
    diffhead: { args: ['diff', 'HEAD'],                   timeout: 30000 },
    diffcached: { args: ['diff', '--cached'],             timeout: 30000 },
    diffrev:  { args: ['diff'],                           timeout: 60000, needTarget: true },
    add:      { args: ['add', '--'],                      timeout: 30000, needPaths: true },
    unstage:  { args: ['reset', '-q', 'HEAD', '--'],      timeout: 30000, needPaths: true },
    discard:  { args: ['checkout', '-q', '--'],           timeout: 30000, needPaths: true },
    commit:   { args: ['commit', '-q', '-m'],             timeout: 60000, needMsg: true },
    // log：31 条（多 1 条仅探测 has_more，截回 30）+ %b 多行正文 + --numstat 行级增删；
    // --skip 由 gitOp 按 r.skip 动态插入（首页 0 不发）。文件状态（M/A/D/R）numstat 不带，
    // 处理段另跑一条 --name-status 按 hash 合并（与服务端 wsGit 同口径，两 flag 同用 git 只认其一）
    log:      { args: ['log', '-31', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%b%x1e', '--numstat'], timeout: 30000 },
    show:     { args: ['show', '--no-color', '--format=__META__%H%x1f%h%x1f%s%x1f%an%x1f%at'], timeout: 30000, needPath: true },
    // 本地 + 远端跟踪分支：审查目标可选 origin/xxx（三点 diff 合法口径）；origin/HEAD 由前端过滤
    branches: { args: ['for-each-ref', 'refs/heads', 'refs/remotes', '--format=%(refname:short)'], timeout: 20000 },
    // 未跟踪文件全量清单（-z NUL 分隔防文件名解析错位）：git status 把未跟踪目录折叠为 "dir/"，前端用它展开
    untracked: { args: ['ls-files', '--others', '--exclude-standard', '-z'], timeout: 20000 },
    push:     { args: ['push'],                           timeout: 115000 },
    pushu:    { args: ['push', '-u', 'origin'],           timeout: 115000, needBranch: true },
    // 关联远程仓库（面板推送引导闭环）：git remote add origin <url>，url 走 target 字段
    remoteadd: { args: ['remote', 'add', 'origin'],       timeout: 20000, needUrl: true },
    // 读当前远程地址（未关联 origin 时 git 报 "No such remote"，前端静默视为未关联）/ 修改远程地址
    remoteurl: { args: ['remote', 'get-url', 'origin'],   timeout: 20000 },
    remoteseturl: { args: ['remote', 'set-url', 'origin'], timeout: 20000, needUrl: true },
    pull:     { args: ['pull', '--no-edit'],              timeout: 115000 },
    init:     { args: ['init', '-q'],                     timeout: 30000 }
};

// git status --porcelain=v1 -b 输出解析（与服务端 wsGitStatusParse 同口径）
function gitStatusParse(text) {
    const changes = [];
    let branch = '', upstream = '', ahead = 0, behind = 0, noCommits = false;
    String(text || '').split('\n').forEach(function (raw) {
        const ln = raw.replace(/\r$/, '');
        if (!ln) return;
        if (ln.indexOf('## ') === 0) {
            const b = ln.slice(3);
            if (b.indexOf('HEAD (no branch)') === 0) { branch = '(游离 HEAD)'; return; }
            // 全新仓库（无任何提交）：git 输出 "## No commits yet on master"，末段才是真实分支名
            const nc = b.match(/^No commits yet on (.+)$/);
            if (nc) { branch = nc[1].trim(); noCommits = true; return; }
            const j = b.indexOf('...');
            if (j >= 0) {
                branch = b.slice(0, j);
                const rest = b.slice(j + 3);
                const k = rest.search(/[\s\[]/);
                upstream = k >= 0 ? rest.slice(0, k) : rest;
            } else if (b) { branch = b; }
            const s = b.indexOf('['), e = b.indexOf(']');
            if (s >= 0 && e > s) {
                b.slice(s + 1, e).split(',').forEach(function (part) {
                    const f = part.trim().split(/\s+/);
                    if (f.length === 2) {
                        const n = parseInt(f[1], 10);
                        if (!isNaN(n)) { if (f[0] === 'ahead') ahead = n; else if (f[0] === 'behind') behind = n; }
                    }
                });
            }
            return;
        }
        if (ln.length < 4) return;
        const x = ln[0], y = ln[1];
        if (x === '!' && y === '!') return; // .gitignore 忽略项
        changes.push({ p: ln.slice(3), x: x, y: y });
    });
    return { branch: branch, upstream: upstream, ahead: ahead, behind: behind, no_commits: noCommits, changes: changes };
}

// 常见 git 失败场景中文引导：身份未配置（commit）/ 远程未配置（push/pull）——原文透传 + 追加可操作提示
function gitErrorHint(msg, sub) {
    if (/tell me who you are|user\.name/i.test(msg)) {
        return msg + '\n—— 请先在控制台终端配置 git 身份（全局一次即可）：\n' +
            'git config --global user.name "你的名字"\n' +
            'git config --global user.email "你的邮箱@example.com"';
    }
    if ((sub === 'push' || sub === 'pushu' || sub === 'pull') &&
        /does not appear to be a git repository|No configured push destination|could not read from remote repository| Repository does not exist/i.test(msg)) {
        return msg + '\n—— 仓库尚未关联远程地址，请先在控制台终端执行：\n' +
            'git remote add origin https://github.com/用户名/仓库名.git';
    }
    if (sub === 'remoteadd' && /already exists/i.test(msg)) {
        return msg + '\n—— 已关联过远程地址，如需修改请在控制台终端执行：\n' +
            'git remote set-url origin 新地址';
    }
    return msg;
}

// git 40 位 hash 判定（log 解析/状态解析共用）
const gitIsHex40 = (s) => /^[0-9a-f]{40}$/.test(s);

// git log 输出解析（format=%H\x1f%h\x1f%s\x1f%an\x1f%at\x1f%b\x1e + --numstat）——与服务端 wsGitLogParse 同口径。
// 结构：%b 是 \x1e 前最后字段（多行正文跨行无妨），\x1e 后跟该提交的 numstat 行（add\tdelete\tpath）。
// 状态机：meta 行（40hex+\x1f 开头）开新提交；其后普通行并入 body 直到 \x1e 行；
// \x1e 后按 tab 三段解析 numstat 求和 ins/del、计文件数。body 中 "数字\t数字\tx" 形状行
// 因仍在 inBody 阶段不会被误判（顺序保证）。head 标记由调用方按 skip 归口（这里不标）。
function gitLogParse(text) {
    const commits = [];
    let cur = null, inBody = false, ins = 0, del = 0, nfile = 0;
    const flush = function () {
        if (cur) {
            cur.body = cur.body.replace(/\n+$/, ''); // %b 尾部自带换行
            cur.ins = ins; cur.del = del; cur.n = nfile;
            commits.push(cur);
        }
        ins = 0; del = 0; nfile = 0;
    };
    String(text || '').split('\n').forEach(function (raw) {
        const ln = raw.replace(/\r$/, '');
        if (ln.length >= 41 && ln[40] === '\x1f' && gitIsHex40(ln.slice(0, 40))) { // meta 行：H\x1fsh\x1fs\x1fan\x1fat\x1f[body首行]
            flush();
            const f = ln.split('\x1f');
            if (f.length < 5) { cur = null; return; }
            let body = f.length >= 6 ? f[5] : '';
            // %b 为空时（无正文提交，实测 git 字节流）\x1e 紧贴 meta 行尾（at\x1f\x1e），
            // body 字段会带上 \x1e——此时本条 body 已结束，直接闭合，防后续 numstat 被并入 body；
            // %b 非空时 %b 尾部自带 \n，\x1e 独占一行，走正常 inBody 流程（与服务端 wsGitLog 同口径）
            if (body.slice(-1) === '\x1e') { body = body.slice(0, -1); inBody = false; } else { inBody = true; }
            cur = { h: f[0], sh: f[1], msg: f[2], an: f[3], at: parseInt(f[4], 10) || 0, body: body };
            return;
        }
        if (ln === '\x1e') { inBody = false; return; } // body 结束标记
        if (!cur) return;
        if (inBody) { cur.body += '\n' + ln; return; } // body 延续行（含空行，正文空行是合法内容）
        const p = ln.split('\t');
        if (p.length === 3) { // numstat 行（二进制文件为 -）
            nfile++;
            if (p[0] !== '-') ins += parseInt(p[0], 10) || 0;
            if (p[1] !== '-') del += parseInt(p[1], 10) || 0;
        }
    });
    flush();
    return commits;
}

// git log --name-status 输出解析（format=%H\x1e + 每文件状态行）：hash → [{p:路径, s:状态}]。
// 状态行：M/A/D 为 "S\tpath"；rename 为 "R100\told\tnew"（取新路径展示，状态记 R）——与服务端 wsGitLogStatus 同口径
function gitLogStatus(text) {
    const res = {};
    let curH = '';
    String(text || '').split('\n').forEach(function (raw) {
        const ln = raw.replace(/\r$/, '').replace(/\x1e$/, '');
        if (!ln) return;
        if (gitIsHex40(ln)) { curH = ln; return; }
        if (!curH) return;
        const p = ln.split('\t');
        if (p.length >= 2) {
            (res[curH] = res[curH] || []).push({ p: p[p.length - 1], s: p[0][0] });
        }
    });
    return res;
}

// git show 输出拆分：首行 __META__ 头 + diff 正文——与服务端 wsGitShowSplit 同口径
function gitShowSplit(text) {
    let out = String(text || '');
    if (out.indexOf('__META__') === 0) out = out.slice(8);
    const idx = out.indexOf('\n');
    if (idx < 0) return { meta: {}, diff: out };
    const f = out.slice(0, idx).split('\x1f');
    const meta = f.length >= 5
        ? { h: f[0], sh: f[1], msg: f[2], an: f[3], at: parseInt(f[4], 10) || 0 }
        : {};
    return { meta: meta, diff: out.slice(idx + 1).replace(/^\n/, '') };
}

function gitOp(username, content) {
    let r;
    try { r = JSON.parse(content || '{}'); } catch (e) {
        return Promise.resolve({ ok: false, error: 'git 请求解析失败' });
    }
    const spec = GIT_SUB_SPEC[r.sub];
    if (!spec) return Promise.resolve({ ok: false, error: '未知 git 子命令' });
    // 项目根归口：带 proj 时 git 的 cwd 指向工作区子目录（safePath 防穿越，与服务端同口径）
    let base = userRoot(username);
    const projName = String(r.proj || '').trim();
    if (projName) {
        const pr = safePath(username, projName);
        if (pr.err || !isDirectorySync(pr.full)) return Promise.resolve({ ok: false, error: '项目目录不存在' });
        base = pr.full;
    }
    if (spec.needPath && !String(r.path || '').trim()) return Promise.resolve({ ok: false, error: r.sub === 'show' ? '缺少提交 hash' : '缺少差异文件路径' });
    if (spec.needTarget && !String(r.target || '').trim()) return Promise.resolve({ ok: false, error: '请选择审查目标分支' });
    if (spec.needUrl && !String(r.target || '').trim()) return Promise.resolve({ ok: false, error: '请填写远程仓库地址' });
    if (spec.needPaths && (!r.paths || !r.paths.length)) return Promise.resolve({ ok: false, error: '缺少操作目标' });
    if (spec.needMsg && !String(r.msg || '').trim()) return Promise.resolve({ ok: false, error: '请填写提交信息' });
    if (spec.needBranch && !String(r.branch || '').trim()) return Promise.resolve({ ok: false, error: '缺少分支名' });
    // add/unstage/discard/commit 分支会重新赋值拼接参数，必须 let（const 重赋值抛 TypeError）
    let args = ['-c', 'core.quotepath=off'].concat(spec.args);
    if (r.sub === 'diff') args.push(String(r.path));
    if (r.sub === 'show') args.push(String(r.path));
    if (r.sub === 'diffrev') args.push(String(r.target) + '...HEAD');
    // discard：staged 变更走 checkout HEAD --（staged 删除/改名旧路径 index 中已不存在，checkout -- 必报 pathspec 不匹配，实测同服务端）
    if (r.sub === 'add' || r.sub === 'unstage') args = args.concat(r.paths.map(String));
    if (r.sub === 'discard') args = (r.staged ? ['-c', 'core.quotepath=off', 'checkout', '-q', 'HEAD', '--'] : args).concat(r.paths.map(String));
    if (r.sub === 'commit') args = args.concat(r.amend ? ['--amend'] : []).concat([String(r.msg)]);
    if (r.sub === 'pushu') args.push(String(r.branch));
    if (r.sub === 'remoteadd') args.push(String(r.target).trim()); // 远程地址是最后一个位置参数，缺失时 git 只会打印 usage
    if (r.sub === 'remoteseturl') args.push(String(r.target).trim());
    // log 需要二次执行拿未推送集合（origin/<branch>..HEAD）；失败=无上游 → 全部未推送
    // GIT_CEILING_DIRECTORIES 防护（与服务端 wsGitExec 同口径）：工作区根非仓库时阻断 git
    // 向上搜索父目录 .git（会窜到宿主目录仓库显示无关变更）；主工作区根自身/项目仓库不受影响
    const gitEnv = { env: Object.assign({}, process.env, { GIT_CEILING_DIRECTORIES: path.dirname(userRoot(username)) }) };
    function execGit(exArgs, timeout) {
        return new Promise(function (res2) {
            execFile('git', exArgs, {
                cwd: base, timeout: timeout,
                maxBuffer: 4 * 1024 * 1024, windowsHide: true,
                env: gitEnv.env
            }, function (err, stdout, stderr) {
                let buf;
                try { buf = Buffer.concat([Buffer.from(stdout || ''), Buffer.from(stderr || '')]); }
                catch (e) { buf = Buffer.alloc(0); }
                res2({ err: err, text: decodeOutput(buf) });
            });
        });
    }
    if (r.sub === 'log') {
        const branch = String(r.branch || '').trim();
        // 分页：--skip=N 动态插入（skip<0 视为 0；首页 0 不发参数，与服务端同口径）
        let skip = parseInt(r.skip, 10) || 0;
        if (skip < 0) skip = 0;
        if (skip > 0) {
            const li = args.indexOf('log');
            args.splice(li + 1, 0, '--skip=' + skip);
        }
        return execGit(args, spec.timeout).then(function (m) {
            if (m.err) {
                // 全新仓库 log 会报错：空历史静默返回（不算业务失败）
                return { ok: true, content: JSON.stringify({ sub: 'log', commits: [] }) };
            }
            const commits = gitLogParse(m.text);
            // 分页探测：多取的第 31 条只用于 has_more 判定，截回 30 条；
            // head 标记归口：首页（skip=0）首条，翻页页全部无 head
            let hasMore = false;
            if (commits.length > 30) {
                commits.length = 30;
                hasMore = true;
            }
            if (skip > 0) {
                commits.forEach(function (c) { c.head = false; });
            } else if (commits.length) {
                commits[0].head = true;
            }
            // 可展开文件清单：--name-status 按 hash 合并（numstat 不带状态字母）；
            // 每提交限 200 条防大提交 JSON 膨胀，截断置 fm 由前端提示（与服务端同口径）
            return execGit(['-c', 'core.quotepath=off', 'log', '--skip=' + skip, '-31', '--format=%H%x1e', '--name-status'], 30000).then(function (sm) {
                if (!sm.err) {
                    const stMap = gitLogStatus(sm.text);
                    commits.forEach(function (c) {
                        let list = stMap[c.h] || [];
                        if (list.length > 200) {
                            c.fm = true;
                            list = list.slice(0, 200);
                        }
                        c.files = list;
                    });
                }
                // 未推送集合（origin/<branch>..HEAD 输出的就是未推送提交）；失败=无上游 → 全部未推送
                const unArgs = ['-c', 'core.quotepath=off', 'log', 'origin/' + branch + '..HEAD', '--format=%H'];
                if (!branch) {
                    commits.forEach(function (c) { c.un = true; });
                    return { ok: true, content: JSON.stringify({ sub: 'log', commits: commits, has_more: hasMore }) };
                }
                return execGit(unArgs, 20000).then(function (um) {
                    if (um.err) {
                        commits.forEach(function (c) { c.un = true; });
                    } else {
                        const unpushed = {};
                        um.text.split('\n').forEach(function (ln) {
                            ln = ln.trim();
                            if (ln) unpushed[ln] = true;
                        });
                        commits.forEach(function (c) { c.un = !!unpushed[c.h]; });
                    }
                    return { ok: true, content: JSON.stringify({ sub: 'log', commits: commits, has_more: hasMore }) };
                });
            });
        });
    }
    return new Promise(function (resolve) {
        execFile('git', args, {
            cwd: base, timeout: spec.timeout,
            maxBuffer: 4 * 1024 * 1024, windowsHide: true,
            env: gitEnv.env
        }, function (err, stdout, stderr) {
            let buf;
            try { buf = Buffer.concat([Buffer.from(stdout || ''), Buffer.from(stderr || '')]); }
            catch (e) { buf = Buffer.alloc(0); }
            const outTxt = decodeOutput(buf);
            if (err && err.code === 'ENOENT') {
                resolve({ ok: false, error: '未检测到 git，请先安装 Git 并加入 PATH' });
                return;
            }
            if (err) {
                // status 下"不是仓库"是常态（引导前端初始化），不算失败
                if (r.sub === 'status' && outTxt.indexOf('not a git repository') >= 0) {
                    resolve({ ok: true, content: JSON.stringify({ sub: 'status', repo: false }) });
                    return;
                }
                // 全新仓库 log 报错 → 空历史
                if (r.sub === 'log') {
                    resolve({ ok: true, content: JSON.stringify({ sub: 'log', commits: [] }) });
                    return;
                }
                // 放弃变更降级：checkout -- 从 index 恢复，staged 删除等 index 无该文件场景必报 pathspec
                // 不匹配——自动改从 HEAD 恢复重试一次（与服务端 wsServerGit 同口径）
                if (r.sub === 'discard' && !r.staged && outTxt.indexOf('did not match any file(s) known to git') >= 0) {
                    execGit(['-c', 'core.quotepath=off', 'checkout', '-q', 'HEAD', '--'].concat(r.paths.map(String)), spec.timeout).then(function (m2) {
                        if (!m2.err) {
                            resolve({ ok: true, content: JSON.stringify({ sub: r.sub, output: m2.text.trim() }) });
                            return;
                        }
                        const msg2 = gitErrorHint(m2.text.trim() || (m2.err.message || String(m2.err)), r.sub);
                        resolve({ ok: true, content: JSON.stringify({ sub: r.sub, error: msg2.slice(0, 8192) }) });
                    });
                    return;
                }
                // staged 放弃对 HEAD 中不存在的文件（暂存的新增 A_）必失败：引导先取消暂存（不做自动删文件的危险动作）
                let msg = gitErrorHint(outTxt.trim() || (err.message || String(err)), r.sub);
                if (r.sub === 'discard' && r.staged && outTxt.indexOf('did not match any file(s) known to git') >= 0) {
                    msg += '\n—— 该文件在上次提交中不存在（暂存的新增文件）：请先「取消暂存」，再在更改区处理或通过文件树删除';
                }
                resolve({ ok: true, content: JSON.stringify({ sub: r.sub, error: msg.slice(0, 8192) }) });
                return;
            }
            if (r.sub === 'status') {
                const st = gitStatusParse(outTxt);
                st.sub = 'status'; st.repo = true;
                resolve({ ok: true, content: JSON.stringify(st) });
                return;
            }
            if (r.sub === 'diff' || r.sub === 'diffhead' || r.sub === 'diffcached' || r.sub === 'diffrev') {
                resolve({ ok: true, content: JSON.stringify({ sub: 'diff', diff: outTxt }) });
                return;
            }
            if (r.sub === 'show') {
                const sp = gitShowSplit(outTxt);
                sp.sub = 'show';
                resolve({ ok: true, content: JSON.stringify(sp) });
                return;
            }
            if (r.sub === 'branches') {
                // --format 全名输出归一为短名：本地分支剥 refs/heads/；远端须两层以上（origin/xxx），
                // 裸 remote 容器（refs/remotes/origin）剔除——与服务端 branches 响应段同口径
                const list = [];
                outTxt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (ln) {
                    if (ln.indexOf('refs/heads/') === 0) {
                        list.push(ln.slice('refs/heads/'.length));
                    } else if (ln.indexOf('refs/remotes/') === 0) {
                        const short = ln.slice('refs/remotes/'.length);
                        if (short.indexOf('/') >= 0) list.push(short);
                    }
                });
                resolve({ ok: true, content: JSON.stringify({ sub: 'branches', list: list }) });
                return;
            }
            if (r.sub === 'untracked') {
                // -z NUL 分隔；不 trim：文件名可能合法含首尾空格，仅滤空段（与服务端同口径）
                const files = outTxt.split('\x00').filter(Boolean);
                resolve({ ok: true, content: JSON.stringify({ sub: 'untracked', files: files }) });
                return;
            }
            resolve({ ok: true, content: JSON.stringify({ sub: r.sub, output: outTxt.trim() }) });
        });
    });
}

// ===== 项目体系（TRAE「打开文件夹/克隆 Git 仓库/最近」同款，与服务端同构）=====
// 项目 = 工作区根下的一个子目录。文件树根/请求 path 天然以 proj 为前缀（safePath 校验覆盖），
// PC 侧归口：项目元数据（userRoot/.im_proj.json）、git 的 cwd 指向、克隆/列表/切换 op。

function isDirectorySync(p) {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function projMetaPath(username) { return path.join(userRoot(username), '.im_proj.json'); }

function projMetaLoad(username) {
    const m = { cur: '', ts: {}, recents: [] };
    try {
        const d = JSON.parse(fs.readFileSync(projMetaPath(username), 'utf8'));
        if (d && typeof d === 'object') {
            m.cur = String(d.cur || '');
            if (d.ts && typeof d.ts === 'object') {
                Object.keys(d.ts).forEach(function (k) { m.ts[k] = Number(d.ts[k]) || 0; });
            }
            if (Array.isArray(d.recents)) m.recents = d.recents; // 最近克隆历史（与服務端 .im_proj.json 同构）
        }
    } catch (e) {}
    return m;
}

function projMetaSave(username, m) {
    try { fs.mkdirSync(userRoot(username), { recursive: true }); } catch (e) {}
    try { fs.writeFileSync(projMetaPath(username), JSON.stringify(m)); } catch (e) {}
}

// 更新项目最近使用时间并把 cur 设为该项目（proj 空串=回到工作区根）
function projTouch(username, projName) {
    const m = projMetaLoad(username);
    m.cur = String(projName || '').trim();
    if (m.cur) m.ts[m.cur] = Math.floor(Date.now() / 1000);
    projMetaSave(username, m);
}

// 项目列表：一级子目录（is_git 标记含 .git），按最近使用倒序，带当前项目与最近克隆历史（recents 供克隆弹窗回填）
function projListLevel(username) {
    const ws = userRoot(username);
    const m = projMetaLoad(username);
    let entries;
    try { entries = fs.readdirSync(ws, { withFileTypes: true }); } catch (e) {
        return { ok: true, content: JSON.stringify({ proj: m.cur, list: [], recents: m.recents || [] }) };
    }
    const list = [];
    for (const it of entries) {
        if (!it.isDirectory() || it.name.startsWith('.')) continue;
        list.push({ name: it.name, is_git: isDirectorySync(path.join(ws, it.name, '.git')), ts: m.ts[it.name] || 0 });
    }
    list.sort(function (a, b) { return b.ts - a.ts; });
    return { ok: true, content: JSON.stringify({ proj: m.cur, list: list, recents: m.recents || [] }) };
}

// 切换当前项目（content=JSON{proj}；空串=回到工作区根）
function projOpenLevel(username, content) {
    let projName = '';
    try { projName = String((JSON.parse(content || '{}').proj) || '').trim(); } catch (e) {}
    if (projName) {
        const r = safePath(username, projName);
        if (r.err || !isDirectorySync(r.full)) return { ok: false, error: '项目目录不存在' };
    }
    projTouch(username, projName);
    return { ok: true };
}

// ===== 克隆进度与取消（与服务端 wsProjClone/wsCloneProgressPump/wsProjCloneCancel 同构）=====

// 运行中克隆登记：key username消毒|req_id → {child, dest, canceled, timer}
const pcClones = {};

// Windows 杀进程树（git.exe 之下还有 git-remote-https 等传输子进程，child.kill 只杀主进程不够）
function killTree(child) {
    if (!child || !child.pid) return;
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
}

// git --progress stderr 行解析正则（与服务端同款）：
//   "Receiving objects:  45% (123/456), 1.23 MiB | 2.34 MiB/s"
const CLONE_RE_PCT = /(Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d+)%/;
const CLONE_RE_SPEED = /\|\s+([\d.]+\s+[KMG]?i?B\/s)/;
const CLONE_RE_SENT = /,\s+([\d.]+\s+[KMG]?i?B)/;
// 远端统计阶段（大仓库 Enumerating/Counting/Compressing 可持续数分钟，先于 Receiving objects）：
// 命中即推帧（pct 置 0、阶段透出远端行为），与服务端 wsCloneProgressPump 同构
const CLONE_RE_REMOTE = /remote:\s*(Enumerating objects|Counting objects|Compressing objects)(?::\s*(\d+)%)?/;

function cloneSentBytes(m) {
    const parts = m[1].split(/\s+/); // "1.23 MiB" → ["1.23", "MiB"]
    const v = parseFloat(parts[0]) || 0;
    const c = (parts[1] || '').charAt(0);
    if (c === 'G') return v * (1 << 30);
    if (c === 'M') return v * (1 << 20);
    if (c === 'K') return v * (1 << 10);
    return v;
}

// 克隆历史：URL 剥凭证后按 URL 去重置顶，上限 10 条（与服务端 wsProjRecentAdd 同构，PC 本地元数据一份）
function projRecentAdd(username, rawURL, name) {
    let u = String(rawURL || '').trim();
    if (u.indexOf('://') >= 0) {
        const pre = u.slice(0, u.indexOf('://') + 3);
        const rest = u.slice(pre.length);
        const at = rest.indexOf('@');
        if (at >= 0) u = pre + rest.slice(at + 1);
    }
    if (!u || !name) return;
    const m = projMetaLoad(username);
    const out = [Object.assign({ url: u, name: name, ts: Math.floor(Date.now() / 1000) })];
    for (const r of m.recents || []) {
        if (r.url === u || out.length >= 10) continue;
        out.push(r);
    }
    m.recents = out;
    projMetaSave(username, m);
}

// 克隆仓库到工作区子目录并自动切换（content=JSON{url,name,token}；token 仅内存拼接不落盘）。
// spawn --progress 流式解析 stderr → onProgress({pct,stage,speed,sent}) 节流 500ms 多帧回传；
// 登记句柄支持取消（proj_clone_cancel → taskkill /T /F → 半成品目录清理）；失败/取消均清理 dest
function projCloneLevel(username, content, reqId, onProgress) {
    let req;
    try { req = JSON.parse(content || '{}'); } catch (e) {
        return Promise.resolve({ ok: false, error: '请求解析失败' });
    }
    let url = String(req.url || '').trim();
    let name = String(req.name || '').trim();
    const token = String(req.token || '').trim();
    if (!name && url) name = url.slice(url.lastIndexOf('/') + 1).replace(/\.git$/, '');
    if (!name || name.length > 100 || /[\\/]/.test(name) || name.indexOf('..') >= 0 || name.indexOf(':') >= 0) {
        return Promise.resolve({ ok: false, error: '目录名不合法（仅限常规名称，不含路径分隔符）' });
    }
    if (!url || (!/^https:\/\//.test(url) && !/^git@/.test(url) && !/^ssh:\/\//.test(url))) {
        return Promise.resolve({ ok: false, error: '仓库地址需以 https:// 、git@ 或 ssh:// 开头' });
    }
    const rawURL = url;
    if (/^https:\/\//.test(url) && token) url = url.replace('://', '://' + token + '@'); // PAT 仅出现在本次进程参数
    const ws = userRoot(username);
    const dest = path.join(ws, name);
    if (fs.existsSync(dest)) return Promise.resolve({ ok: false, error: '目录已存在：' + name });
    return new Promise(function (resolve) {
        let done = false;
        const finish = function (res) {
            if (done) return;
            done = true;
            clearTimeout(proc.timer);
            if (pcClones[key] === proc) delete pcClones[key];
            resolve(res);
        };
        let child;
        try {
            child = spawn('git', ['-c', 'credential.helper=', '-c', 'core.quotepath=off', 'clone', '--progress', url, name], {
                cwd: ws, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
                // 禁用交互式凭据弹窗（实测 GCM 2.7.3 无视 GCM_INTERACTIVE，须 -c credential.helper= 置空）；
                // 凭据统一走弹窗 Token 字段（URL 内嵌），系统凭据库中已存的凭证经 helper 禁用后不再生效
                env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' })
            });
        } catch (e) {
            resolve({ ok: false, error: '未检测到 git，请先安装 Git 并加入 PATH' });
            return;
        }
        const key = sanitizeUsername(username) + '|' + String(reqId || '');
        const proc = { child: child, dest: dest, canceled: false, timer: null };
        pcClones[key] = proc;
        proc.timer = setTimeout(function () { killTree(child); }, 600000); // 与服务端 600s 超时对齐
        // stderr 流式进度解析：\r 单行刷写 → \r/\n 双分隔切行，行内正则提取，节流 500ms 回调
        let lineBuf = Buffer.alloc(0);
        let tail = '';
        let lastPush = 0;
        let pct = -1, stage = '', speed = '', sent = 0;
        let anySeen = false; // stderr 首行即推帧（"连接远端中"占位）：远端枚举对象阶段 git 无输出
        child.stderr.on('data', function (chunk) {
            lineBuf = Buffer.concat([lineBuf, chunk]);
            if (lineBuf.length > 256 * 1024) lineBuf = lineBuf.slice(lineBuf.length - 256 * 1024);
            for (;;) {
                let idx = -1;
                for (let j = 0; j < lineBuf.length; j++) {
                    const b = lineBuf[j];
                    if (b === 13 || b === 10) { idx = j; break; }
                }
                if (idx < 0) break;
                const lineBytes = lineBuf.slice(0, idx);
                lineBuf = lineBuf.slice(idx + 1);
                const line = decodeOutput(lineBytes).trim();
                if (!line) continue;
                if (!anySeen) {
                    anySeen = true;
                    if (!stage) stage = '连接远端中';
                }
                tail = (tail.length > 8192 ? '' : tail) + line + '\n';
                const m1 = CLONE_RE_PCT.exec(line);
                if (m1) { stage = m1[1]; pct = parseInt(m1[2], 10) || 0; }
                const m0 = CLONE_RE_REMOTE.exec(line);
                if (m0) { stage = m0[1] + (m0[2] ? ' ' + m0[2] + '%' : ''); }
                const m2 = CLONE_RE_SPEED.exec(line);
                if (m2) speed = m2[1];
                const m3 = CLONE_RE_SENT.exec(line);
                if (m3) sent = cloneSentBytes(m3);
                if (anySeen && onProgress && Date.now() - lastPush >= 500) {
                    lastPush = Date.now();
                    try { onProgress({ pct: Math.max(pct, 0), stage: stage, speed: speed, sent: Math.round(sent) }); } catch (e) {}
                }
            }
        });
        child.on('error', function (err) {
            finish({ ok: false, error: err && err.code === 'ENOENT' ? '未检测到 git，请先安装 Git 并加入 PATH' : String(err && err.message || err) });
        });
        child.on('close', function (code) {
            if (proc.canceled) {
                try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) {} // 取消：git 被杀不自清理，删半成品
                finish({ ok: false, error: '已取消' });
                return;
            }
            if (code !== 0) {
                let msg = (tail.trim() || 'git clone 退出码 ' + code).slice(0, 8192);
                if (/Authentication failed|403/.test(msg)) {
                    msg += '\n—— 私有仓库请在克隆弹窗填入访问 Token（GitHub：Settings → Developer settings → Personal access tokens）';
                } else if (/not an empty directory/.test(msg)) {
                    msg = '目录已存在：' + name;
                } else if (/Repository not found|not found/i.test(msg)) {
                    msg += '\n—— 仓库不存在或无权访问，请检查地址（私有仓库需填 Token）';
                }
                try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) {} // 失败兜底清理
                finish({ ok: false, error: msg });
                return;
            }
            projTouch(username, name);
            projRecentAdd(username, rawURL, name);
            finish({ ok: true });
        });
    });
}

// 取消运行中克隆（content=JSON{target:克隆请求的 req_id}）：taskkill /T /F → close 回调统一清理半成品
function projCloneCancelLevel(username, content) {
    let target = '';
    try { target = String((JSON.parse(content || '{}').target) || '').trim(); } catch (e) {}
    if (!target) return { ok: false, error: '缺少目标 req_id' };
    const p = pcClones[sanitizeUsername(username) + '|' + target];
    if (!p) return { ok: false, error: '克隆已结束或不在本机执行' };
    p.canceled = true;
    killTree(p.child);
    return { ok: true };
}

// 文件面板操作入口（main.js 经 IPC 调用；payload: {op, path, content, req_id}；git/clone 返回 Promise 由 IPC 层 await；
// onProgress 仅 proj_clone 用：进度回调 {pct,stage,speed,sent}，main.js 注入 req_id 后经 IPC 推帧回渲染层）
function fileOp(username, payload, onProgress) {
    const op = payload && payload.op;
    if (op === 'tree') return fileTreeLevel(username, payload.path);
    if (op === 'read') return fileReadLevel(username, payload.path);
    if (op === 'readb') return fileReadB64Level(username, payload.path);
    if (op === 'save') return fileSaveLevel(username, payload.path, payload.content);
    if (op === 'delete') return fileDeleteLevel(username, payload.path);
    if (op === 'rename') return fileRenameLevel(username, payload.path, payload.content);
    if (op === 'newfile') return fileCreateLevel(username, payload.path, payload.content, false);
    if (op === 'newdir') return fileCreateLevel(username, payload.path, payload.content, true);
    if (op === 'reveal') return fileRevealLevel(username, payload.path);
    if (op === 'proj_list') return projListLevel(username);
    if (op === 'proj_open') return projOpenLevel(username, payload.content);
    if (op === 'proj_clone') return projCloneLevel(username, payload.content, payload.req_id || '', onProgress);
    if (op === 'proj_clone_cancel') return projCloneCancelLevel(username, payload.content);
    if (op === 'git') return gitOp(username, payload.content);
    return { ok: false, error: '未知操作' };
}

// ===== 阶段七十七：控制台本地终端（Trae CN 同款多标签）=====
// 用户在控制台手敲命令：纯本地交互环路（渲染层 → IPC → 本执行器），不经服务端
// （任意命令不进服务端面，浏览器端无本地执行器天然不可用）。每标签一条会话：
// cwd 连续记账（cd/盘符切换不 spawn），普通命令逐条 spawn cmd /c 执行（同一会话同时只跑一条），
// 输出行级收口 200ms 聚合推帧（与 run_command 同款管道），结束回退出码/耗时/最终 cwd。

const TERM_STREAM_MAX = 512 * 1024;         // 单条命令输出流上限（超出停止下发，标记 over）
const TERM_IDLE_MS = 30 * 60 * 1000;        // 会话空闲回收（无运行中命令且 30 分钟无操作）

const termSessions = {}; // username消毒|term_id → {username, termId, cwd, child, lastUsed}

function termDefaultCwd(username) {
    const ws = userRoot(username);
    try { return fs.realpathSync(ws); } catch (e) { return ws; }
}

// 空闲会话清扫（termOp 每次调用顺带执行，免独立定时器）：无运行中命令且超时即回收
function termSweep() {
    const now = Date.now();
    Object.keys(termSessions).forEach(function (k) {
        const s = termSessions[k];
        if (!s.child && now - s.lastUsed > TERM_IDLE_MS) delete termSessions[k];
    });
}

// 打开会话（幂等）：cwd 默认落用户工作区根；已存在回传当前 cwd
function termOpen(username, termId) {
    termSweep();
    const id = String(termId || '').trim();
    if (!id) return { ok: false, error: '缺少终端标识' };
    const key = sanitizeUsername(username) + '|' + id;
    if (!termSessions[key]) {
        try { fs.mkdirSync(userRoot(username), { recursive: true }); } catch (e) {} // 工作区不存在时先建，保证 cwd 有效
        termSessions[key] = { username: sanitizeUsername(username), termId: id, cwd: termDefaultCwd(username), child: null, lastUsed: Date.now() };
    }
    return { ok: true, cwd: termSessions[key].cwd };
}

// cd/盘符切换本地记账（与 cmd.exe 语义对齐，不 spawn）：cd 回工作区根、cd .. / cd 路径、cd /d X:\dir、X: 切盘
// 返回 null=非 cd 命令；否则返回错误文本（失败）或 ''（成功，cwd 已更新）
function termApplyCd(s, line) {
    const m = /^cd(\s+(\/d\s+)?(.+))?$/i.exec(line);
    const driveM = /^[a-zA-Z]:$/.test(line);
    if (!m && !driveM) return null;
    const fail = function (msg) { return msg + '\r\n'; };
    let target;
    if (driveM) {
        target = line.slice(0, 2);
    } else if (m[3]) {
        target = m[3].trim().replace(/^"|"$/g, '');
        if (!target) target = '';
        else if (/^\/d\s+/i.test(target)) target = target.replace(/^\/d\s+/i, ''); // cd /d 已被正则吃掉，双保险
    } else {
        target = '';
    }
    if (!target) { s.cwd = termDefaultCwd(s.username); return ''; } // 裸 cd 回工作区根
    if (/^[a-zA-Z]:$/.test(target)) { // 仅盘符：切到该盘根（cmd 原语义为该盘上次目录，此处简化为根）
        const base = target + '\\';
        if (!fs.existsSync(base)) return fail('系统找不到指定的驱动器。');
        s.cwd = base;
        return '';
    }
    let np;
    if (/^[a-zA-Z]:/.test(target) || target.startsWith('\\') || target.startsWith('/')) np = path.resolve(target);
    else if (/^~/.test(target)) np = path.join(os.homedir(), target.slice(1).replace(/^[\\/]+/, ''));
    else np = path.resolve(s.cwd, target);
    let st;
    try { st = fs.statSync(np); } catch (e) { return fail('系统找不到指定的路径。'); }
    if (!st.isDirectory()) return fail('目标不是目录。');
    s.cwd = np;
    return '';
}

// 逐命令执行（input）：同步校验立即返回受理结果；输出经 onFrame 异步推帧，完成以 exit 帧收口
function termInput(s, cmd, onFrame) {
    const line = String(cmd == null ? '' : cmd).replace(/[\r\n]+/g, ' ').trim();
    if (!line) return { ok: true };
    s.lastUsed = Date.now();
    if (s.child) return { ok: false, error: '上一条命令仍在执行中（可点 ■ 停止）' };
    const push = function (chunk) { if (typeof onFrame === 'function') onFrame({ term_id: s.termId, type: 'out', chunk: chunk }); };
    push(s.cwd + '> ' + line + '\r\n'); // 命令回显（提示符风格，Trae 同款）
    const cdErr = termApplyCd(s, line);
    if (cdErr !== null) { // cd/切盘本地记账：不 spawn，回显新提示符
        if (cdErr) push(cdErr);
        else push(s.cwd + '>\r\n');
        s.lastUsed = Date.now();
        // sync 标记：本地记账命令无 exit 帧，前端须同步解除运行态（否则 running 卡死后续命令全部无反应）
        return { ok: true, cwd: s.cwd, sync: true };
    }
    const startedAt = Date.now();
    let child;
    try {
        child = spawn('cmd', ['/C', 'chcp 65001 >nul 2>&1 & ' + line], {
            cwd: s.cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (e) {
        push((e.message || e) + '\r\n');
        return { ok: true, cwd: s.cwd };
    }
    s.child = child;
    let lineBuf = Buffer.alloc(0);
    let pending = '';
    let total = 0;
    let over = false;
    let finished = false;
    const flush = function () {
        if (!pending) return;
        const chunk = pending;
        pending = '';
        if (typeof onFrame === 'function') onFrame({ term_id: s.termId, type: 'out', chunk: chunk, total_bytes: total, over: over });
    };
    const tick = setInterval(flush, CMD_STREAM_FLUSH_MS);
    const addChunk = function (buf) {
        let data = buf;
        while (data.length) {
            const nl = data.indexOf(0x0A);
            if (nl < 0) { lineBuf = Buffer.concat([lineBuf, data]); return; }
            let piece = data.slice(0, nl + 1);
            data = data.slice(nl + 1);
            if (lineBuf.length) { piece = Buffer.concat([lineBuf, piece]); lineBuf = Buffer.alloc(0); }
            total += piece.length;
            if (total > TERM_STREAM_MAX) { over = true; continue; }
            let text;
            try { text = utf8Strict.decode(piece); } catch (e) { text = gbkDecoder.decode(piece); }
            pending += text;
        }
    };
    child.stdout.on('data', addChunk);
    child.stderr.on('data', addChunk);
    const finish = function (code) {
        if (finished) return;
        finished = true;
        clearInterval(tick);
        if (lineBuf.length) { // 无换行尾行收口
            let text;
            try { text = utf8Strict.decode(lineBuf); } catch (e) { text = gbkDecoder.decode(lineBuf); }
            pending += text;
            lineBuf = Buffer.alloc(0);
        }
        flush();
        s.child = null;
        s.lastUsed = Date.now();
        if (typeof onFrame === 'function') {
            onFrame({ term_id: s.termId, type: 'exit', exit_code: code === null ? -1 : code, duration_ms: Date.now() - startedAt, cwd: s.cwd, over: over });
        }
    };
    child.on('error', function (e) {
        push((e.message || e) + '\r\n');
        finish(-1);
    });
    child.on('close', function (code) { finish(code); });
    return { ok: true };
}

// 终端操作入口（main.js 经 IPC 调用）：req={username, action, term_id, cmd}
// open/input/stop/close + ssh（阶段八十一：SSH 远程主机托管，快连弹窗 → 本地 ssh 进程 → 终端标签）；
// input 受理后命令异步执行，输出/完成经 onFrame 推回渲染层
function termOp(req, onFrame) {
    const username = sanitizeUsername((req && req.username) || '');
    const action = req && req.action;
    const id = String((req && req.term_id) || '').trim();
    termSweep();
    if (action === 'open') return termOpen((req && req.username) || '', id);
    if (action === 'ssh') return termSsh((req && req.username) || '', id, req, onFrame);
    const s = termSessions[username + '|' + id];
    if (action === 'input') {
        if (!s) return { ok: false, error: '会话已失效，请新建终端' };
        if (s.ssh) return termSshInput(s, req && req.cmd); // SSH 交互会话：input 直写远端 stdin
        return termInput(s, req && req.cmd, onFrame);
    }
    if (action === 'stop') {
        if (s && s.child) {
            if (s.ssh) killTree(s.child); else { try { s.child.kill(); } catch (e) {} }
            return { ok: true };
        }
        return { ok: false, error: '没有运行中的命令' };
    }
    if (action === 'close') {
        if (s) {
            if (s.child) { if (s.ssh) killTree(s.child); else { try { s.child.kill(); } catch (e) {} } }
            delete termSessions[username + '|' + id];
        }
        return { ok: true };
    }
    return { ok: false, error: '未知操作' };
}

// ===== 阶段八十一：SSH 远程主机（终端托管会话）=====
// 无 PTY 依赖方案：ssh -tt 强制分配远端伪终端（stdin 管道不回显，远端 TTY 回显即所见即所得），
// 提示符/行编辑/密码提示均由远端 TTY 提供；本地仅做字节流转发 + ANSI 控制序列清洗（textContent 渲染兼容）
const SSH_RE_ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function sshClean(text) {
    return String(text || '')
        .replace(SSH_RE_ANSI, '')       // CSI/OSC/杂项转义清洗（textContent 无法渲染颜色码）
        .replace(/\r\n/g, '\n')         // 统一换行
        .replace(/\r/g, '\n');          // 孤立 \r（进度刷写）转换行，避免长行覆盖
}

// 打开 SSH 会话（幂等）：req 携带 {host, port, user}；输出/退出经 onFrame 推帧
function termSsh(username, termId, req, onFrame) {
    termSweep();
    const id = String(termId || '').trim();
    if (!id) return { ok: false, error: '缺少终端标识' };
    const key = sanitizeUsername(username) + '|' + id;
    if (termSessions[key]) return { ok: true, cwd: termSessions[key].cwd || '' };
    const host = String((req && req.host) || '').trim();
    const user = String((req && req.user) || '').trim();
    const port = parseInt(req && req.port, 10) || 22;
    if (!host || !/^[A-Za-z0-9._-]+$/.test(host)) return { ok: false, error: '主机名不合法' };
    if (user && !/^[A-Za-z0-9._-]+$/.test(user)) return { ok: false, error: '用户名不合法' };
    let child;
    try {
        const args = ['-tt', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-p', String(port)];
        if (user) args.push(user + '@' + host); else args.push(host);
        child = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
        return { ok: false, error: 'SSH 启动失败（需系统安装 OpenSSH 客户端）' };
    }
    const s = { username: sanitizeUsername(username), termId: id, cwd: user ? user + '@' + host : host, child: child, lastUsed: Date.now(), ssh: { host: host, port: port, user: user } };
    termSessions[key] = s;
    // 输出转发：stdout/stderr 合并 → ANSI 清洗 → out 帧（无行缓冲：交互式会话需要即时回显）
    const forward = function (buf) {
        if (typeof onFrame === 'function') onFrame({ term_id: id, type: 'out', chunk: sshClean(decodeOutput(buf)) });
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', function (e) {
        if (typeof onFrame === 'function') onFrame({ term_id: id, type: 'out', chunk: '✕ SSH 启动失败：' + (e.message || e) + '（需系统安装 OpenSSH 客户端）\n' });
        child.emit('close', -1);
    });
    child.on('close', function (code) {
        if (termSessions[key] === s) delete termSessions[key];
        if (typeof onFrame === 'function') {
            onFrame({ term_id: id, type: 'exit', exit_code: code === null ? -1 : code, duration_ms: 0, cwd: s.cwd, ssh: true });
        }
    });
    return { ok: true, cwd: s.cwd, sync: true };
}

// SSH 会话输入：整行直写远端 stdin（sync 标记：无 exit 帧，前端立即解除运行态可继续输入）
function termSshInput(s, cmd) {
    const line = String(cmd == null ? '' : cmd);
    s.lastUsed = Date.now();
    if (!s.child) return { ok: false, error: 'SSH 连接已断开' };
    try { s.child.stdin.write(line + '\r'); } catch (e) {
        return { ok: false, error: 'SSH 连接已断开' };
    }
    return { ok: true, sync: true };
}

module.exports = {
    setRoot: setRoot,
    getRoot: getRoot,
    setBackupRoot: setBackupRoot, // 阶段八十：本地变更审查备份根目录（main 启动时注入并清理孤儿）
    setSandbox: setSandbox,
    getSandbox: getSandbox,
    setMcpCfgGetter: setMcpCfgGetter, // 阶段九十：本机 MCP 配置反查注入（main 启动时注入，按需建连兜底）
    safePath: safePath,
    sanitizeUsername: sanitizeUsername,
    execTool: execTool,
    requestBg: requestBg, // 阶段七十五：长命令转后台请求入口
    fileOp: fileOp, // 阶段七十六：工作区文件面板操作入口
    termOp: termOp // 阶段七十七：控制台本地终端（多标签）
};
