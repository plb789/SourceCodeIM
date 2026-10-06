// loader.js —— 阶段一百三十七：app.asar 唯一明文入口（薄启动器）
// 职责：1) 还原加密密钥（secure-key.js 掩码异或，dev 回退服务端 config.yaml）
//      2) 挂载 .enc 模块重定向钩子：打包版业务模块仅存 <name>.js.enc（IMEF1 容器），
//         require('./xxx.js') 原生解析失败时重定向到密文文件，解密后内存编译，明文不落盘
//      3) 加载真实入口 main.js（dev 为明文直跑，打包版为 main.js.enc）
// 保留明文的文件及原因：preload.js / viewer-preload.js（渲染进程桥接，无业务逻辑）；
// mcp-computer-use.js（被 mcp-manager 以独立 Node 子进程启动，子进程无法走本钩子）；
// secure-key.js（掩码扰乱存储，无可 grep 明文密钥）
// 构建期本文件经 obfuscate.js esbuild 压缩为 loader.min.js（package.json main 归口）进 asar
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');

// SECURE_HEADER_LEN 容器头长：IMEF1 魔数 5B + IV 12B；SECURE_OVERHEAD 定长开销 = 头 17 + 认证标签 16
const SECURE_MAGIC = 'IMEF1';
const SECURE_HEADER_LEN = 17;
const SECURE_OVERHEAD = 33;

// resolveSecureKey 还原 AES-256-GCM 密钥（32 字节）：优先 secure-key.js 掩码异或，
// dev 未打包形态回退读 im-server/bin/config.yaml；IM_SECURE=0 或均不可得时返回 null
function resolveSecureKey() {
    if (process.env.IM_SECURE === '0') return null;
    try {
        const sk = require('./secure-key.js');
        const m = Buffer.from(sk.m, 'hex');
        const k = Buffer.from(sk.k, 'hex');
        if (m.length === 32 && k.length === 32) {
            const key = Buffer.alloc(32);
            for (let i = 0; i < 32; i++) key[i] = m[i] ^ k[i];
            return key;
        }
    } catch (e) { /* secure-key.js 缺失（dev 裸目录形态）走 config.yaml 回退 */ }
    try {
        const cfg = fs.readFileSync(path.resolve(__dirname, '..', '..', 'im-server', 'bin', 'config.yaml'));
        const m = cfg.toString('utf8').match(/secure_file_key:\s*"([0-9a-fA-F]{64})"/);
        if (m) return Buffer.from(m[1], 'hex');
    } catch (e) { /* 开发机外无 config.yaml，按无密钥处理 */ }
    return null;
}

// decryptContainer 解密 IMEF1 密文容器（魔数5 + IV12 + GCM 密文+标签16），失败抛异常
function decryptContainer(buf, key) {
    if (!buf || buf.length <= SECURE_OVERHEAD || buf.subarray(0, 5).toString('ascii') !== SECURE_MAGIC) {
        throw new Error('主进程密文容器格式不符');
    }
    const sealed = buf.subarray(SECURE_HEADER_LEN);
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(5, SECURE_HEADER_LEN));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

const encKey = resolveSecureKey();

// 钩子一：模块名解析重定向——原生解析失败（MODULE_NOT_FOUND）且存在同名 .enc 时改回密文路径。
// dev 形态明文文件存在、原生解析成功，钩子完全不触发；仅打包版生效
if (encKey) {
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        try {
            return origResolve.call(this, request, parent, isMain, options);
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND' || !/^\.\.?[\\/]/.test(request)) throw err;
            const fromDir = parent ? path.dirname(parent.filename) : __dirname;
            const base = path.resolve(fromDir, request);
            const encPath = /\.enc$/i.test(base) ? base : base + '.enc';
            if (!fs.existsSync(encPath)) throw err; // 非 .enc 场景维持原异常（真实缺模块等）
            return encPath;
        }
    };

    // 钩子二：.enc 自定义扩展——读密文 → 解密 → 内存 CommonJS 编译（不落盘明文）
    // 解密失败直接抛异常终止启动：宁可不启动也不降级（明文本就不在包内）
    Module._extensions['.enc'] = function (module, filename) {
        const plain = decryptContainer(fs.readFileSync(filename), encKey);
        module._compile(plain.toString('utf8'), filename);
    };
} else if (!fs.existsSync(path.join(__dirname, 'main.js'))) {
    // 无密钥且明文入口缺失（打包版被误关加密链路）：给出明确提示后退出，不静默半死
    console.error('[loader] 加密密钥不可用且明文入口缺失（检查 IM_SECURE 环境变量与 secure-key.js），无法启动');
    process.exit(1);
}

require('./main.js');
