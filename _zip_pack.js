const fs = require('fs');
const path = require('path');

function zipDir(srcDir, zipPath) {
    return new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        const ps = [
            '-NoProfile', '-NonInteractive', '-Command',
            `Compress-Archive -Path '${srcDir}' -DestinationPath '${zipPath}' -Force -CompressionLevel Optimal`
        ];
        const p = execFile('powershell', ps, { maxBuffer: 1024 * 1024 * 100, timeout: 600000 }, (err, stdout, stderr) => {
            if (err) reject(new Error('PowerShell Compress-Archive 失败: ' + stderr));
            else resolve(zipPath);
        });
    });
}

(async () => {
    const outDir = 'E:\\SourceCodeIM\\im-client\\web\\static';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    console.log('打包 Go...');
    await zipDir('C:\\go', path.join(outDir, 'go-toolchain.zip'));
    console.log('Go zip 完成: ' + (fs.statSync(path.join(outDir, 'go-toolchain.zip')).size / 1024 / 1024).toFixed(1) + 'MB');

    console.log('打包 Git...');
    await zipDir('C:\\Program Files\\Git', path.join(outDir, 'git-toolchain.zip'));
    console.log('Git zip 完成: ' + (fs.statSync(path.join(outDir, 'git-toolchain.zip')).size / 1024 / 1024).toFixed(1) + 'MB');
})().catch(e => { console.error(e.message); process.exit(1); });
