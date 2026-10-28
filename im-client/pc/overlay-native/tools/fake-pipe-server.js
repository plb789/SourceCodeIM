// fake-pipe-server.js - 裸测假主进程（模拟客户端 pipe 协议下发名单/好友，验证子进程跟随注入）
// 用法：node fake-pipe-server.js <pid>   （pid = --launch 的启动器进程）
// 行为：建 pipe im-overlay-<pid> → 收 hello → 回 hello-ack + follow 名单帧；
//       收 child 帧（跟随注入成功上报）→ 自动为子进程建 pipe im-overlay-<childPid> 并推好友/回显
const net = require('net');
const pid = Number(process.argv[2]) || 0;
const FOLLOW_LIST = ['gamecdonl.exe']; // 跟随名单（子进程 exe 名小写匹配）
const servers = new Map(); // pipeName -> server

function handleFrame(sock, line, pname) {
    console.log(`[RX ${pname}] ${line}`);
    try {
        const f = JSON.parse(line);
        if (f.t === 'hello') {
            sock.write(JSON.stringify({ t: 'hello-ack' }) + '\n');
            sock.write(JSON.stringify({ t: 'me', u: 'tester' }) + '\n');
            sock.write(JSON.stringify({ t: 'msg', from: '', name: '系统', text: '假主进程已连接' }) + '\n');
            sock.write(JSON.stringify({ t: 'friends', list: [{ u: 'alice', n: 'Alice', on: 1 }, { u: 'bob', n: 'Bob', on: 0 }] }) + '\n');
            // 关键：下发跟随名单（DLL 收到才挂 CreateProcess 钩）
            sock.write(JSON.stringify({ t: 'follow', mode: 'list', list: FOLLOW_LIST }) + '\n');
            console.log(`[TX ${pname}] hello-ack + me + msg + friends + follow`);
        } else if (f.t === 'child') {
            const cpid = Number(f.pid) || 0;
            if (cpid && !servers.has(pnameOf(cpid))) {
                console.log(`[FOLLOW] 启动器拉起子进程 pid=${cpid} → 建子 pipe`);
                startServer(cpid);
            }
        }
    } catch (e) { /* 非 JSON 行忽略 */ }
}
function pnameOf(p) { return `\\\\.\\pipe\\im-overlay-${p}`; }
function startServer(p) {
    const pname = pnameOf(p);
    if (servers.has(pname)) return;
    const srv = net.createServer(function (sock) {
        console.log(`[CONN ${pname}] DLL connected`);
        sock.setNoDelay(true);
        let buf = '';
        sock.on('data', function (d) {
            buf += d.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (line) handleFrame(sock, line, pname);
            }
        });
        sock.on('error', function () { });
    });
    srv.listen(pname, function () { console.log(`[LISTEN] ${pname}`); });
    servers.set(pname, srv);
}
startServer(pid);
console.log(`fake pipe server ready for pid=${pid}（等待 DLL 连接…）`);
