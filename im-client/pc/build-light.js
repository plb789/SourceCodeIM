// build-light.js —— 阶段三百：轻量增量打包（秒级，复用完整加密链路）
// 核心流程：临时目录 npm install --omit=dev → 复制源码（按 files 白名单）→ asar pack → zip
// 这样 node_modules 自动和 electron-builder 完整打包一致（只生产依赖）
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'light-dist');
const TMP_DIR = path.join(ROOT, '.asar-tmp');

// ===== 0. 清理 =====
function rimraf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
rimraf(OUT_DIR);
rimraf(TMP_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ===== 1. 临时目录 npm install --omit=dev（精简生产依赖）=====
console.log('[build-light] npm install --omit=dev in .asar-tmp ...');
fs.mkdirSync(TMP_DIR, { recursive: true });
// 先复制 package.json 和 package-lock.json
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(TMP_DIR, 'package.json'));
if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) {
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(TMP_DIR, 'package-lock.json'));
}
// 在临时目录装生产依赖
try {
    execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
        cwd: TMP_DIR,
        stdio: 'inherit',
        timeout: 600000,
        shell: 'powershell.exe'
    });
} catch (e) {
    console.error('[build-light] npm install failed');
    process.exit(1);
}
const nmStat = fs.statSync(path.join(TMP_DIR, 'node_modules'));
const nmFiles = (function(){ let n=0; function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if(e.isDirectory()) walk(p); else n++; } } walk(path.join(TMP_DIR,'node_modules')); return n; })();
console.log('[build-light] node_modules:', nmFiles, 'files');

// ===== 2. 读取 package.json files 白名单 =====
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const filesPatterns = pkg.build.files || [];
const excludeList = filesPatterns.filter(p => p.startsWith('!')).map(p => p.slice(1));

// ===== 3. 复制源码文件到临时目录（跳过 node_modules 已装过）=====
function minimatchSimple(str, pattern) {
    let re = '^';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
            else { re += '[^/]*'; }
        } else if (c === '?') { re += '.'; }
        else if ('.+^${}()|[]\\'.indexOf(c) !== -1) { re += '\\' + c; }
        else { re += c; }
    }
    re += '$';
    return new RegExp(re).test(str);
}

// 递归扫描 pc 根目录，跳过 node_modules/.asar-tmp/light-dist/dist
function walkDir(dir, baseDir, collector) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.asar-tmp' ||
                entry.name === 'light-dist' || entry.name === 'dist' ||
                entry.name === 'builder-cache' || entry.name === '.git') continue;
            walkDir(fullPath, baseDir, collector);
        } else if (entry.isFile()) {
            collector.push(relPath);
        }
    }
}

const allFiles = [];
walkDir(ROOT, ROOT, allFiles);

// 只排除（files 全是 ! 前缀）
// 加上 electron-builder 默认排除项（它隐式排除但不写在 files 里）
const extraExclude = [
    '.gitignore', 'code-build.json', 'app-update.yml', '.asar-tmp/**',
    'build-light.js', 'build-light.bat', 'build-updater.bat',
    'package-lock.json',                   // electron-builder 默认排除
    'build/**',                            // electron-builder 默认排除 build/ 资源目录
    'node_modules/**/.cache/**',           // 常见缓存
    'node_modules/**/test/**',             // 测试目录
    'node_modules/**/tests/**',
    'node_modules/**/__tests__/**',
    'node_modules/**/example/**',
    'node_modules/**/examples/**',
    'node_modules/**/doc/**',
    'node_modules/**/docs/**',
    'node_modules/**/LICENSE*',
    'node_modules/**/README*',
    'node_modules/**/CHANGELOG*',
    'node_modules/**/*.md',
    'node_modules/**/*.txt',
    'node_modules/**/*.ts',                // 源码类型声明（运行时不需要）
    'node_modules/**/*.map',               // source map
    'node_modules/**/node-gyp/**',
    'node_modules/**/binding.gyp',
    'node_modules/.bin/**',                // npm bin 链接（运行时不用）
    'node_modules/**/prebuilds/android-arm*/**',  // 非 win 平台原生 .node
    'node_modules/**/prebuilds/darwin*/**',
    'node_modules/**/prebuilds/linux*/**',
    'node_modules/**/src/**/CMakeLists.txt',
    'node_modules/**/src/**/*.cpp',
    'node_modules/**/src/**/*.c',
    'node_modules/**/src/**/*.h'
];
const allExcludes = excludeList.concat(extraExclude);

const selectedFiles = allFiles.filter(f => {
    for (const pat of allExcludes) {
        if (minimatchSimple(f, pat)) return false;
    }
    return true;
});
console.log('[build-light] 源码文件选中:', selectedFiles.length, '个');

// 复制到临时目录
for (const relPath of selectedFiles) {
    const src = path.join(ROOT, relPath);
    const dst = path.join(TMP_DIR, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.copyFileSync(src, dst); } catch (e) {}
}

// ===== 4. 复制 asarUnpack 目录 =====
console.log('[build-light] 复制 asarUnpack ...');
const asarUnpack = pkg.build.asarUnpack || [];
for (const pat of asarUnpack) {
    const srcDir = path.join(ROOT, pat);
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        const dstDir = path.join(TMP_DIR, pat);
        function copyDir(src, dst) {
            fs.mkdirSync(dst, { recursive: true });
            for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                const s = path.join(src, entry.name);
                const d = path.join(dst, entry.name);
                if (entry.isDirectory()) copyDir(s, d);
                else fs.copyFileSync(s, d);
            }
        }
        copyDir(srcDir, dstDir);
        console.log('  unpack:', pat);
    }
}
for (const f of ['shot-window-picker.ps1', 'remote-sendinput.ps1']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP_DIR, f));
}

// ===== 5. asar pack =====
console.log('[build-light] asar packing ...');
const asarOut = path.join(OUT_DIR, 'app.asar');
try {
    execSync('npx asar pack "' + TMP_DIR + '" "' + asarOut + '"', {
        stdio: 'inherit', cwd: ROOT, timeout: 300000
    });
} catch (e) {
    console.error('[build-light] asar pack failed');
    rimraf(TMP_DIR);
    process.exit(1);
}
const asarSize = fs.statSync(asarOut).size;
console.log('[build-light] app.asar:', (asarSize / 1024 / 1024).toFixed(1), 'MB');

// ===== 6. SHA-512 =====
function sha512Hex(p) {
    return crypto.createHash('sha512').update(fs.readFileSync(p)).digest('hex');
}
const asarHash = sha512Hex(asarOut);
console.log('[build-light] sha512:', asarHash);

// ===== 7. asar-info.json + zip =====
const codeBuild = JSON.parse(fs.readFileSync(path.join(ROOT, 'code-build.json'), 'utf-8'));
const info = {
    buildId: codeBuild.buildId,
    buildTime: codeBuild.buildTime,
    productVersion: codeBuild.productVersion,
    asarSize: asarSize,
    asarHash: asarHash,
    asarHashFormat: 'sha512_hex_lowercase'
};
fs.writeFileSync(path.join(OUT_DIR, 'asar-info.json'), JSON.stringify(info, null, 2));

// ===== 8. zip 压缩（优先 7z.exe，兜底 PowerShell）=====
const zipOut = path.join(OUT_DIR, 'app-update.zip');
try {
    // 优先用 extraResources 的 7z.exe
    const sevenZip = path.join(ROOT, '7z', '7z.exe');
    if (fs.existsSync(sevenZip)) {
        execSync(`"${sevenZip}" a -tzip -mx=5 "${zipOut}" "${asarOut}"`, {
            stdio: 'pipe', timeout: 120000
        });
    } else {
        // PowerShell 兜底（Join-Path 避免转义）
        const psScript = `Compress-Archive -Path '${asarOut.replace(/'/g, "''")}' -DestinationPath '${zipOut.replace(/'/g, "''")}' -Force`;
        execSync(`powershell -NoProfile -Command "${psScript}"`, {
            stdio: 'pipe', timeout: 120000
        });
    }
    const zipSize = fs.statSync(zipOut).size;
    console.log('[build-light] app-update.zip:', (zipSize / 1024 / 1024).toFixed(1), 'MB');
} catch (e) {
    console.warn('[build-light] zip skipped, 请手动压缩 app.asar');
}

// ===== 9. 清理临时目录 =====
rimraf(TMP_DIR);

// ===== 9. 汇总 =====
console.log('');
console.log('========================================');
console.log('  [DONE] build-light');
console.log('========================================');
console.log('  buildId: ', info.buildId);
console.log('  product: v' + info.productVersion);
console.log('  asar:    ', (info.asarSize / 1024 / 1024).toFixed(1), 'MB');
console.log('  sha512:  ', info.asarHash);
console.log('  产物:    ', OUT_DIR);
console.log('========================================');
