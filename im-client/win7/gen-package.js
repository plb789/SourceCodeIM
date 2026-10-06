// gen-package.js - 从 ..\pc\package.json 派生 Win7 专用构建配置（每次构建重新生成，版本/配置与主工程自动同步）
// 关键差异：Electron 22.3.27（最后支持 Win7/8/8.1 的版本线）+ ia32 32 位（兼容 Win7 32/64 位）
//          extraResources 仅保留 app-update.yml（内嵌 node v24 / uv 等运行时均不支持 Win7，嵌入无意义，
//          客户端对应功能按既有降级逻辑自动处理）
// 注意：本文件仅写入 win7 目录自身，绝不修改 pc\ 内任何文件
const fs = require('fs');
const path = require('path');

const pcPkgPath = path.resolve(__dirname, '..', 'pc', 'package.json');
if (!fs.existsSync(pcPkgPath)) {
    console.error('[win7] 未找到主工程 package.json: ' + pcPkgPath);
    process.exit(1);
}
const pcPkg = JSON.parse(fs.readFileSync(pcPkgPath, 'utf8'));

const pkg = {
    name: pcPkg.name + '-win7',
    version: pcPkg.version,
    description: pcPkg.description,
    author: pcPkg.author,
    winExeMeta: pcPkg.winExeMeta,
    main: 'loader.min.js',
    scripts: {
        pack: 'electron-builder --win --ia32 --dir'
    },
    devDependencies: {
        // Electron 22.3.27：22.x 最终版（Chromium 108），Win7 可用；精确锁定版本保证可复现
        'electron': '22.3.27',
        'electron-builder': pcPkg.devDependencies['electron-builder'],
        'esbuild': pcPkg.devDependencies['esbuild']
    },
    dependencies: pcPkg.dependencies,
    build: JSON.parse(JSON.stringify(pcPkg.build))
};

// files 追加排除：win7 目录自有的辅助脚本不进 asar
pkg.build.files = (pkg.build.files || []).concat([
    '!*.bat',
    '!gen-package.js',
    '!patch-obfuscate.js',
    '!patch-main.js',
    '!api-test.js',
    '!*.log',
    '!*.md'
]);

// extraResources 仅保留更新器配置；内嵌运行时（node/uv/gcc/rclone/winfsp）均不支持 Win7，不嵌入
pkg.build.extraResources = [
    {
        from: 'app-update.yml',
        to: 'app-update.yml'
    }
];

fs.writeFileSync(path.join(__dirname, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
console.log('[win7] package.json 已生成: Electron 22.3.27 / ia32 / 版本 ' + pcPkg.version);
