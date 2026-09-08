// agent-executor.js - 阶段六十：Agent 本地执行器核心（纯 Node 模块，不依赖 Electron API，可独立测试）
// 职责：接收服务端下发的工具执行请求（read_file/write_file/edit_file/delete_file/list_dir/grep/run_command），在用户电脑本地执行并回传结果。
// 设计约束（与服务端 agentrun.go 语义对齐）：
//   1. 工作区隔离：所有文件操作严格限制在 <root>/<用户名消毒后>/ 内，拒绝绝对路径/盘符/.. 逃逸（与服务端 agentSafePath 同款双保险）
//   2. 结果约定：output 以"错误："前缀表示工具级失败（模型据此自纠）；执行器仅做本地执行，审批归口在服务端
//   3. 限额一致：read 50000 字符 / write 200000 字符 / 命令输出 8000 字符 / 命令超时上限 300 秒
// 注：PC 端无 GBK 解码依赖，命令输出统一 chcp 65001 切 UTF-8 后按 utf8 解码（与服务端同款策略）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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

// edit_file 阶段七十四：精确替换编辑（old_string→new_string），语义与服务端 agentToolEditFile 一致：
// old_string 须逐字一致；多处匹配要求唯一化或显式 replace_all；GBK 文件编辑后统一转存 UTF-8
function editFileSync(username, params) {
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
    return { ok: true, output: '已编辑 ' + p + '（+' + add + ' -' + del + '，替换 ' + count + ' 处）' };
}

// delete_file 阶段七十四：删除文件/目录（审批归口服务端；非空目录必须 recursive=true）
function deleteFileSync(username, params) {
    const p = params && params.path;
    const recursive = !!(params && params.recursive);
    const { full, err } = safePath(username, p);
    if (err) return { ok: false, output: '错误：' + err };
    let stat;
    try {
        stat = fs.statSync(full);
    } catch (e) {
        return { ok: false, output: '错误：目标不存在 ' + (e.message || e) };
    }
    if (stat.isDirectory()) {
        if (!recursive) {
            try {
                fs.rmdirSync(full); // 仅空目录；非空抛错走下方提示
            } catch (e) {
                return { ok: false, output: '错误：' + p + ' 是目录且非空，需传 recursive=true 递归删除' };
            }
            return { ok: true, output: '已删除目录 ' + p + '/（空目录）' };
        }
        let n = 1; // 统计口径含根目录本身（与服务端 WalkDir 一致）
        try {
            countEntries(full, function () { n++; });
        } catch (e) {}
        try {
            fs.rmSync(full, { recursive: true, force: false });
        } catch (e) {
            return { ok: false, output: '错误：删除失败 ' + (e.message || e) };
        }
        return { ok: true, output: '已删除目录 ' + p + '/（递归，含 ' + n + ' 个条目）' };
    }
    try {
        fs.unlinkSync(full);
    } catch (e) {
        return { ok: false, output: '错误：删除失败 ' + (e.message || e) };
    }
    return { ok: true, output: '已删除文件 ' + p + '（' + stat.size + ' 字节）' };
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
        case 'edit_file':
            done(editFileSync(username, params));
            return;
        case 'delete_file':
            done(deleteFileSync(username, params));
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
    execTool: execTool,
    requestBg: requestBg // 阶段七十五：长命令转后台请求入口
};
