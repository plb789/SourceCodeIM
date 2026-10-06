// patch-obfuscate.js - 给复制到 win7 目录的 obfuscate.js 打"密钥只读"补丁
// 背景：pc\obfuscate.js 在服务端 config.yaml 未配置 secure_file_key 时会自动生成并【回写】config.yaml；
//       Win7 构建铁律是不触碰任何现有文件，故将回写行为改为直接报错退出（正常情况密钥已由主工程
//       构建配置好，此处只会读取）
// 幂等：已打补丁时跳过（robocopy 同步源文件变化后会重新打补丁）
const fs = require('fs');
const path = require('path');

const f = path.join(__dirname, 'obfuscate.js');
if (!fs.existsSync(f)) {
    console.error('[win7] 未找到 obfuscate.js，请先执行源码同步步骤');
    process.exit(1);
}

let s = fs.readFileSync(f, 'utf8');
if (s.indexOf('[win7-build]') >= 0) {
    console.log('[win7] obfuscate.js 已是只读密钥版本，跳过补丁');
    process.exit(0);
}

const oldStr = "fs.writeFileSync(serverCfgPath, out, { encoding: 'utf8' });";
const newStr = "throw new Error('[win7-build] im-server config.yaml missing secure_file_key; run the standard build once first');";
if (s.indexOf(oldStr) < 0) {
    console.error('[win7] 补丁定位失败：未找到写入 config.yaml 的语句（obfuscate.js 可能已更新，请检查）');
    process.exit(1);
}
s = s.replace(oldStr, newStr);
fs.writeFileSync(f, s, 'utf8');
console.log('[win7] obfuscate.js 补丁完成：secure_file_key 只读，绝不回写 im-server config.yaml');
