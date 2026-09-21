// obfuscate.js - 阶段一百二十三：构建期 JS 混淆打包归口（TRAE CN 同款防线：压缩 + 变量名混淆）
// 背景：PC 安装包内置网页快照（resources/web-snapshot），前端源码随包明文可见；实测 TRAE CN 的做法
//       是 workbench 17.8MB 单文件 minify+mangle（明文可读性极低），据此对自研 js 构建期混淆——
//       esbuild transform 逐文件压缩 + 变量名 mangle，阅读门槛大幅提高。这是"提高逆向门槛"而非
//       加密（前端代码在浏览器必须明文执行，本质上无法真正加密，TRAE 亦然）。
//       实测修正：混淆范围限定 web\js\ 子树（26 个自研文件）——web\lib\ 下 101 个第三方库本身
//       已是 min 压缩形态，重复混淆零收益且有兼容风险（AMD loader 等），原样复制。
// 阶段一百二十四：html 注释剥离——快照中 7 个 html 的 <!-- --> 注释（阶段备注/旧结构存档等
//       160 处约 24.3KB）构建期统一删除，降低可读性与体积；源 web\ 目录不动，仅产物生效。
//       剥离前实测扫描：无条件注释、无内联 script/style 段内 <!--、无未闭合注释，可安全全删；
//       剥离实现仍按段切分保护（script/style 段原样），防后续源码新增脚本字符串 <!-- 被误删。
// 关键约束：mangle 只作用于函数内部局部变量（toplevel 默认不动）——跨文件全局函数/全局变量
//       名全部保留，页面 script 标签按原文件名加载，全局通信零影响，html/css 零适配。
// 用法：node obfuscate.js（build.bat [5/8] 混淆步骤调用，也可手动执行）
// 输出：bundled/web-obfuscated（混淆 js + 原样其他资源）+ snapshot-manifest.json（源属性清单）
//       —— build.bat 快照步骤以 web-obfuscated 为复制源嵌入安装包；
//       客户端 web-cache.js 打包模式按清单记录的"源文件 size/mtime"与服务端清单比对
//       （混淆产物自身属性与源不同，不能直接比对），保证出厂快照零下载、服务端更新才增量。
// 排除规则：static 整段（用户数据+工具链）、zip、隐藏文件——与 web-cache.js walkFiles/服务端清单一致

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const srcRoot = path.resolve(__dirname, '..', 'web');              // 网页源目录
const outRoot = path.join(__dirname, 'bundled', 'web-obfuscated'); // 混淆输出目录（快照复制源）

// ===== 阶段一百三十六：加密链路路径归口 =====
const blobOut = path.join(__dirname, 'web-snapshot.enc');          // 加密快照 blob（pc 根目录，随 app.asar 打包）
const keyModuleOut = path.join(__dirname, 'secure-key.js');        // 密钥模块（掩码扰乱存储，main.js 运行时还原）

// ===== 阶段一百三十七：主进程模块加密清单（薄启动器方案） =====
// 这些文件加密为 <name>.enc 随 asar 打包，明文源码经 package.json files 规则排除出安装包；
// 运行时由 loader.js 重定向钩子解密后内存编译。保留明文：preload.js / viewer-preload.js
// （渲染桥接无业务逻辑）、mcp-computer-use.js（独立 Node 子进程脚本，无法走解密钩子）
const MAIN_MODULES = [
    'main.js',
    'web-cache.js',
    'agent-executor.js',
    'browser-manager.js',
    'toolchain-manager.js',
    'mcp-manager.js',
    'node-runtime.js',
    'lsp-manager.js',
    'remote-input.js'
];
const serverCfgPath = path.resolve(__dirname, '..', '..', 'im-server', 'bin', 'config.yaml'); // 密钥同源配置
const loaderOut = path.join(__dirname, 'loader.min.js'); // 薄启动器压缩产物（package.json main 归口进 asar）

// collect 递归收集待处理文件清单（与缓存/服务端清单排除规则对齐）
function collect(dir, rel, out) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
        var ent = entries[i];
        var name = ent.name;
        if (name.indexOf('.') === 0) continue; // 隐藏文件/目录排除
        if (name === 'static') continue;       // 用户数据与工具链目录排除
        if (ent.isDirectory()) {
            collect(path.join(dir, name), rel ? rel + '/' + name : name, out);
            continue;
        }
        if (/\.zip$/i.test(name)) continue;    // zip 排除
        out.push({
            rel: rel ? rel + '/' + name : name,
            src: path.join(dir, name),
            out: path.join(outRoot, (rel ? rel + '/' + name : name).replace(/\//g, path.sep)),
            // 仅 web\js\ 子树的自研代码混淆；lib 第三方库（已是 min 形态）与 css 等原样复制；
            // html 走注释剥离（阶段一百二十四）
            isJs: (rel === 'js' || rel.indexOf('js/') === 0) && /\.js$/i.test(name),
            isHtml: /\.html?$/i.test(name)
        });
    }
}

// stripHtmlComments 删除 HTML 注释（阶段一百二十四）：按交替段匹配——script/style 段优先整段
// 匹配并原样返回（段内 <!-- 不被误判为注释），其余 <!-- --> 完整块删除；未闭合注释不匹配
// 自然保留（宁可漏删不可误删）。实测扫描：现 7 个 html 无条件注释、无段内 <!--、无未闭合。
function stripHtmlComments(code) {
    return code.replace(
        /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi,
        function (m) {
            var head = m.slice(0, 6).toLowerCase();
            if (head.indexOf('<scrip') === 0 || head.indexOf('<style') === 0) return m; // 脚本/样式段原样
            return ''; // HTML 注释删除
        }
    );
}

// ===== 阶段一百三十六：加密快照 blob + 密钥注入（PC 端安装目录/userData 磁盘零明文） =====
// 快照以单一加密 blob（web-snapshot.enc）随 app.asar 打包：安装目录不再有明文/混淆快照文件；
// 密钥与服务端 config.yaml secure_file_key 同源（构建期读取），经随机掩码异或扰乱后生成
// secure-key.js 打入 asar，源码与产物中均无明文密钥可 grep（运行时 main.js 异或还原）。

// resolveOrCreateKey 读取服务端 config.yaml 的 secure_file_key（64 位 hex）；未配置时生成
// 随机密钥并回写配置（UTF-8 无 BOM），保证构建链与服务端密文接口密钥天然一致
function resolveOrCreateKey() {
    var txt = '';
    try { txt = fs.readFileSync(serverCfgPath, 'utf8'); } catch (e) { txt = ''; }
    var m = /secure_file_key:\s*"?([0-9a-fA-F]{64})"?/.exec(txt);
    if (m) return m[1].toLowerCase();
    var keyHex = crypto.randomBytes(32).toString('hex');
    var comment = '\n# 阶段一百三十六：PC 前端资源密文下发密钥（AES-256-GCM，64 位 hex = 32 字节）\n'
        + '# 由构建脚本 obfuscate.js 自动生成；留空 = /api/secure-file 停用，PC 端回退明文链路\n'
        + 'secure_file_key: "' + keyHex + '"\n';
    var out;
    if (/^recall_window:[^\n]*$/m.test(txt)) {
        out = txt.replace(/^recall_window:[^\n]*$/m, function (l) { return l + comment; });
    } else {
        out = txt.replace(/\s*$/, '') + '\n' + comment;
    }
    fs.writeFileSync(serverCfgPath, out, { encoding: 'utf8' }); // utf8 写入无 BOM
    console.log('[混淆] 服务端未配置 secure_file_key，已生成并写入 config.yaml');
    return keyHex;
}

// sealRaw blob 密文条目（IV12 + 密文 + tag16，无魔数——魔数由 blob 头统一承载，web-cache secureDecryptRaw 对应）
function sealRaw(plain, key) {
    var iv = crypto.randomBytes(12); // 每文件独立随机 IV
    var c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

// sealContainer IMEF1 完整密文容器（魔数5 + IV12 + 密文 + tag16）——主进程 .enc 独立文件用
// （loader.js decryptContainer 对应；与服务端 securefile.go secureSeal 同格式）
function sealContainer(plain, key) {
    var iv = crypto.randomBytes(12); // 每文件独立随机 IV
    var c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([Buffer.from('IMEF1', 'ascii'), iv, c.update(plain), c.final(), c.getAuthTag()]);
}

// buildEncryptedBlob 将混淆产物（outRoot）逐文件 AES-256-GCM 加密打包为单一 blob：
// IMSB1 魔数(5B) + 索引长度 u32LE(4B) + 索引 JSON（{相对路径:{o,l,s,t}}，o/l 相对密文区
// 起点/长度，s/t 源文件属性供客户端增量比对）+ 密文区（每文件 IV12+密文+tag16）
function buildEncryptedBlob(manifest, keyHex) {
    var key = Buffer.from(keyHex, 'hex');
    var blocks = [];
    var index = {};
    var cursor = 0, srcBytes = 0, encBytes = 0;
    var rels = Object.keys(manifest).sort();
    for (var i = 0; i < rels.length; i++) {
        var rel = rels[i];
        var fp = path.join(outRoot, rel.replace(/\//g, path.sep));
        var st = fs.statSync(fp);
        if (!st.isFile()) continue;
        var enc = sealRaw(fs.readFileSync(fp), key);
        index[rel] = { o: cursor, l: enc.length, s: manifest[rel].s, t: manifest[rel].t };
        blocks.push(enc);
        cursor += enc.length;
        srcBytes += st.size;
        encBytes += enc.length;
    }
    var idxBuf = Buffer.from(JSON.stringify({ v: 1, files: index }), 'utf8');
    var head = Buffer.alloc(9);
    head.write('IMSB1', 0, 'ascii');
    head.writeUInt32LE(idxBuf.length, 5);
    fs.writeFileSync(blobOut, Buffer.concat([head, idxBuf].concat(blocks)));
    return { files: rels.length, srcBytes: srcBytes, encBytes: encBytes, indexLen: idxBuf.length };
}

// writeSecureKeyModule 生成 secure-key.js：密钥逐字节异或随机掩码后嵌入（掩码每次构建随机，
// 产物中无可 grep 的明文密钥），main.js 运行时异或还原后注入 web-cache.js 加密链路
function writeSecureKeyModule(keyHex) {
    var mask = crypto.randomBytes(32);
    var key = Buffer.from(keyHex, 'hex');
    var scr = Buffer.alloc(key.length);
    for (var i = 0; i < key.length; i++) scr[i] = key[i] ^ mask[i % mask.length];
    fs.writeFileSync(keyModuleOut,
        '// 阶段一百三十六：构建期自动生成（obfuscate.js）——前端资源加密密钥（掩码异或扰乱存储），勿手改\n'
        + 'module.exports={m:"' + mask.toString('hex') + '",k:"' + scr.toString('hex') + '"};\n');
}

// buildMainModules 阶段一百三十七：主进程业务模块逐文件加密为 <name>.enc（IMEF1 容器，与 web
// 快照同一密钥），产物落 pc 根随 asar 打包；明文源文件保留在开发机（asar 由 files 规则排除）
function buildMainModules(keyHex) {
    var key = Buffer.from(keyHex, 'hex');
    var srcBytes = 0, encBytes = 0;
    for (var i = 0; i < MAIN_MODULES.length; i++) {
        var f = MAIN_MODULES[i];
        var fp = path.join(__dirname, f);
        var plain = fs.readFileSync(fp);
        var enc = sealContainer(plain, key);
        fs.writeFileSync(path.join(__dirname, f + '.enc'), enc);
        srcBytes += plain.length;
        encBytes += enc.length;
    }
    return { count: MAIN_MODULES.length, srcBytes: srcBytes, encBytes: encBytes };
}

// buildLoaderMin 阶段一百三十七：薄启动器构建期压缩（esbuild minify 与 web 层同款：去注释+变量名
// mangle），产物 loader.min.js 进 asar；开发机 loader.js 源码保留维护，asar 内不再可读实现细节
async function buildLoaderMin() {
    var code = fs.readFileSync(path.join(__dirname, 'loader.js'), 'utf8');
    var r = await esbuild.transform(code, {
        minify: true,
        charset: 'utf8',
        legalComments: 'none',
        sourcefile: 'loader.js',
        logLevel: 'silent'
    });
    fs.writeFileSync(loaderOut, r.code);
    return r.code.length;
}

async function main() {
    var t0 = Date.now();
    // 0. 清空输出目录：保证产物纯净无上轮残留（旧文件若残留会随快照入库成为死资源）
    fs.rmSync(outRoot, { recursive: true, force: true });
    fs.mkdirSync(outRoot, { recursive: true });

    var files = [];
    collect(srcRoot, '', files);
    if (!files.length) throw new Error('源目录为空: ' + srcRoot);

    var manifest = {}; // {相对路径: {s: 源size, t: 源mtimeMs 取整}}——增量同步比对归口
    var obfCount = 0, copyCount = 0, htmlCount = 0, srcBytes = 0, outBytes = 0, htmlBefore = 0, htmlAfter = 0;

    // js 逐文件混淆（并行，esbuild 内部 Go 池调度）；html 剥离注释后写入；其他文件原样复制
    var tasks = files.map(function (f) {
        return function () {
            var st = fs.statSync(f.src);
            manifest[f.rel] = { s: st.size, t: Math.floor(st.mtimeMs) };
            fs.mkdirSync(path.dirname(f.out), { recursive: true });
            if (f.isHtml) {
                // 阶段一百二十四：html 注释剥离（源目录不动，仅产物生效；编码保持 UTF-8 无 BOM）
                var raw = fs.readFileSync(f.src, 'utf8');
                var stripped = stripHtmlComments(raw);
                fs.writeFileSync(f.out, stripped);
                htmlCount++;
                htmlBefore += Buffer.byteLength(raw, 'utf8');
                htmlAfter += Buffer.byteLength(stripped, 'utf8');
                return Promise.resolve();
            }
            if (!f.isJs) {
                fs.copyFileSync(f.src, f.out);
                copyCount++;
                return Promise.resolve();
            }
            var code = fs.readFileSync(f.src, 'utf8');
            return esbuild.transform(code, {
                minify: true,           // 压缩：去空白换行 + 局部变量名 mangle（toplevel 默认不动→全局名保留）
                charset: 'utf8',        // 保留中文字符（默认 ascii 会把中文转义为 \uXXXX 使体积膨胀）
                legalComments: 'none',
                sourcefile: f.rel,
                logLevel: 'silent'
            }).then(function (r) {
                fs.writeFileSync(f.out, r.code);
                obfCount++;
                srcBytes += st.size;
                outBytes += Buffer.byteLength(r.code, 'utf8');
            });
        };
    });

    var failed = null;
    var queue = tasks.slice();
    async function worker() {
        while (queue.length && !failed) {
            try { await queue.shift()(); } catch (e) { if (!failed) failed = e; }
        }
    }
    var workers = [];
    for (var i = 0; i < 8; i++) workers.push(worker());
    await Promise.all(workers);
    if (failed) throw failed;

    // 源属性清单：客户端增量同步用它替代快照实扫（混淆产物属性不可用于比对）
    fs.writeFileSync(path.join(outRoot, 'snapshot-manifest.json'), JSON.stringify(manifest));

    // ===== 阶段一百三十六：加密快照 blob + 密钥注入 =====
    var keyHex = resolveOrCreateKey();
    var blobStat = buildEncryptedBlob(manifest, keyHex);
    writeSecureKeyModule(keyHex);
    var mainStat = buildMainModules(keyHex); // 阶段一百三十七：主进程模块加密（薄启动器配套）
    var loaderLen = await buildLoaderMin(); // 阶段一百三十七：薄启动器压缩（明文入口不可读）

    function kb(n) { return (n / 1024).toFixed(1) + 'KB'; }
    console.log('[混淆] 完成：js 混淆 ' + obfCount + ' 个（' + kb(srcBytes) + ' → ' + kb(outBytes) +
        '，压缩率 ' + (srcBytes ? Math.round(outBytes / srcBytes * 100) : 0) + '%），html 注释剥离 ' +
        htmlCount + ' 个（' + kb(htmlBefore) + ' → ' + kb(htmlAfter) + '），原样复制 ' + copyCount +
        ' 个，清单 ' + Object.keys(manifest).length + ' 条，耗时 ' + (Date.now() - t0) + 'ms');
    console.log('[混淆] 加密快照 blob: ' + blobStat.files + ' 个文件（' + kb(blobStat.srcBytes) + ' → ' +
        kb(blobStat.encBytes) + '，含索引 ' + kb(blobStat.indexLen) + '）→ web-snapshot.enc；密钥已扰乱注入 secure-key.js');
    console.log('[混淆] 主进程模块加密: ' + mainStat.count + ' 个（' + kb(mainStat.srcBytes) + ' → ' +
        kb(mainStat.encBytes) + '）→ loader.js 薄启动器配套；启动器压缩 ' + kb(loaderLen) + ' → loader.min.js');
}

main().catch(function (e) {
    console.error('[混淆] 失败:', e && e.message);
    process.exit(1);
});
