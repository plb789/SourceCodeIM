// patch-main.js - 给 win7 目录同步来的主进程源码打 Electron 22 兼容补丁（仅修改 win7 副本，幂等）
// 补丁点（pc 原文件永不改动）：
//   web-cache.js: 注入 win7-compat 依赖；protocol.handle → installInterceptor22；
//                 net.fetch → __w7.netFetch（Node 直连防递归）；Readable.toWeb → 直传 Node 流
//   main.js:      net.fetch → win7-compat.netFetch（文档查看器下载）
const fs = require('fs');
const path = require('path');

function patchFile(file, patches) {
    var f = path.join(__dirname, file);
    if (!fs.existsSync(f)) {
        console.error('[win7] 未找到 ' + file + '，请先执行源码同步');
        process.exit(1);
    }
    var s = fs.readFileSync(f, 'utf8');
    var changed = false;
    for (var i = 0; i < patches.length; i++) {
        var p = patches[i];
        if (s.indexOf(p.marker) >= 0) { // 已打补丁（幂等跳过）
            continue;
        }
        if (s.indexOf(p.oldStr) < 0) {
            console.error('[win7] 补丁定位失败: ' + file + ' ← ' + p.desc);
            process.exit(1);
        }
        s = p.all ? s.split(p.oldStr).join(p.newStr) : s.replace(p.oldStr, p.newStr);
        changed = true;
        console.log('[win7] ' + file + ' 补丁: ' + p.desc);
    }
    if (changed) fs.writeFileSync(f, s, 'utf8');
}

// ===== web-cache.js =====
patchFile('web-cache.js', [
    {
        desc: '注入 win7-compat 依赖（Response 本地实现归口）',
        marker: "var __w7 = require('./win7-compat.js');",
        oldStr: "const { Readable } = require('stream');",
        newStr: "const { Readable } = require('stream');\nvar __w7 = require('./win7-compat.js'); var Response = __w7.Response;"
    },
    {
        desc: 'protocol.handle(http) → installInterceptor22（Electron 22 等价实现，https 同批注册）',
        marker: "__w7.installInterceptor22(session, handler);",
        oldStr: "session.defaultSession.protocol.handle('http', handler);",
        newStr: "__w7.installInterceptor22(session, handler);"
    },
    {
        desc: 'protocol.handle(https) → 注释归并（installInterceptor22 已同批注册）',
        marker: "installInterceptor22 已同批注册",
        oldStr: "session.defaultSession.protocol.handle('https', handler);",
        newStr: "/* https 同批注册于 installInterceptor22 */"
    },
    {
        desc: '增量同步跳过（22 无拦截无缓存，避免无效下载）',
        marker: 'async function sync() { return null;',
        oldStr: 'async function sync() {',
        newStr: 'async function sync() { return null; /* win7: 无拦截无缓存，跳过增量同步 */'
    },
    {
        desc: 'net.fetch → __w7.netFetch（Node 直连，22 无 bypass 选项防递归）',
        marker: '__w7.netFetch(',
        oldStr: 'net.fetch(',
        newStr: '__w7.netFetch(',
        all: true
    },
    {
        desc: 'Readable.toWeb(stream) → Node 流直传（22 无 toWeb）',
        marker: 'new Response(stream,',
        oldStr: 'Readable.toWeb(stream)',
        newStr: 'stream'
    },
    {
        desc: 'Readable.toWeb(part) → Node 流直传',
        marker: 'new Response(part,',
        oldStr: 'Readable.toWeb(part)',
        newStr: 'part'
    }
]);

// ===== main.js =====
patchFile('main.js', [
    {
        desc: '文档查看器下载 net.fetch → win7-compat.netFetch',
        marker: "require('./win7-compat.js').netFetch(u)",
        oldStr: 'var resp = await net.fetch(u);',
        newStr: "var resp = await require('./win7-compat.js').netFetch(u);"
    },
    {
        desc: 'userData 独立目录（Chromium 108 与 134 配置格式冲突隔离 + 单实例锁隔离）',
        marker: "im-client-win7",
        oldStr: "app.setAppUserModelId('com.im.client');",
        newStr: "app.setAppUserModelId('com.im.client');\n// win7: 独立 userData——Chromium 108 与 134 共用配置目录有缓存格式冲突风险，单实例锁互不影响\ntry { app.setPath('userData', path.join(app.getPath('appData'), 'im-client-win7')); } catch (e) { }"
    }
]);

// ===== 补丁后语法校验 =====
['web-cache.js', 'main.js'].forEach(function (f) {
    try {
        new Function(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    } catch (e) {
        // new Function 对 CommonJS 顶层 return 敏感？main.js 无顶层 return；语法错误才抛
        // 注：require 等在 Function 体中是自由变量，不影响语法校验
        console.error('[win7] ' + f + ' 补丁后语法异常: ' + e.message);
        process.exit(1);
    }
});
console.log('[win7] Electron 22 兼容补丁全部完成');
