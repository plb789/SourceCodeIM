// 阶段一百一十四：内置 Computer Use MCP 服务器（TRAE 同款架构：随 PC 客户端分发的本地 stdio MCP Server）
// 让 AI 操作桌面 GUI：截图（多模态视觉）+ 键鼠控制 + 窗口管理，全部在本机执行，凭据与画面不出电脑
// 协议：JSON-RPC over stdin/stdout（与 mcp-manager.js 拉起的普通 MCP 服务器一致，由 mcp-manager 作为客户端调用）
// 执行原理：每次工具调用 spawn PowerShell，Add-Type 内嵌 C#（user32 SendInput/SetCursorPos/GDI 截图）一次定义全部原语
'use strict';

const readline = require('readline');

const SERVER_INFO = { name: 'computer-use', version: '1.0.0' };
// 截图压缩参数：max 宽 1280 + JPEG 质量 55——单张 base64 约 80~150KB，多模态视觉输入可承受
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_JPEG_QUALITY = 55;

// ============================ 工具定义（对齐 TRAE Computer Use 命名与语义） ============================
const TOOLS = [
  {
    name: 'screenshot',
    description: '截取当前屏幕（全虚拟屏，压缩为 JPEG 并以图像返回，多模态模型可直接查看画面内容）。GUI 操作前的第一步：先截图看清界面，再决定点击坐标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_app_state',
    description: '获取当前桌面状态：屏幕截图（图像返回）+ 活动窗口标题与进程信息（文本返回）。比 screenshot 多输出当前焦点窗口信息。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'click',
    description: '在屏幕像素坐标 (x,y) 处单击鼠标左键。坐标来自 screenshot/get_app_state 返回的图像（图像已按比例压缩，绝对不要自行换算——直接使用你在图像上看到的坐标除以缩放比例后的原屏幕坐标；若不确定请重新截图对照）。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer', description: '屏幕 X 像素坐标' }, y: { type: 'integer', description: '屏幕 Y 像素坐标' } },
      required: ['x', 'y'],
      additionalProperties: false
    }
  },
  {
    name: 'double_click',
    description: '在屏幕像素坐标 (x,y) 处双击鼠标左键（打开文件/选中词句等）。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
      additionalProperties: false
    }
  },
  {
    name: 'right_click',
    description: '在屏幕像素坐标 (x,y) 处单击鼠标右键（弹出上下文菜单）。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
      additionalProperties: false
    }
  },
  {
    name: 'scroll',
    description: '在屏幕像素坐标 (x,y) 处滚动鼠标滚轮。delta 为正值向上滚动、负值向下滚动，每格约 120（一格滚轮刻度）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        delta: { type: 'integer', description: '滚动量，正值向上/负值向下，一格约 120' }
      },
      required: ['x', 'y', 'delta'],
      additionalProperties: false
    }
  },
  {
    name: 'drag',
    description: '从屏幕坐标 (from_x,from_y) 按住左键拖拽到 (to_x,to_y) 后释放（移动窗口/框选/滑块等）。duration_ms 为按下到释放的总时长，默认 400ms。',
    inputSchema: {
      type: 'object',
      properties: {
        from_x: { type: 'integer' },
        from_y: { type: 'integer' },
        to_x: { type: 'integer' },
        to_y: { type: 'integer' },
        duration_ms: { type: 'integer', description: '拖拽总时长毫秒，默认 400' }
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
      additionalProperties: false
    }
  },
  {
    name: 'type_text',
    description: '向当前焦点窗口输入文本（SendInput Unicode 序列，完整支持中文/表情/任意字符）。输入前请先点击目标输入框确保焦点正确。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要输入的完整文本（可含换行 \n）' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'press_key',
    description: '向当前焦点窗口发送按键/组合键。key 为按键描述，支持：enter、tab、esc、backspace、delete、home、end、pageup、pagedown、up/down/left/right、f1~f12、space、单个字符或组合（如 ctrl+c、alt+f4、ctrl+shift+t，加号连接）。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: '按键描述，如 enter、ctrl+c、alt+tab' } },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'select_text',
    description: '选中屏幕上的文本：给两组坐标 (from_x,from_y)→(to_x,to_y) 时从起点按住左键拖拽到终点选中（配合 release 前不点击其他处）；只给单个坐标 (x,y) 时双击选中该处词句。选中后可接 type_text 覆盖输入或 press_key ctrl+c 复制。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: '单词选中模式：双击选中 (x,y) 处的词句' },
        y: { type: 'integer' },
        from_x: { type: 'integer', description: '拖拽选中模式：起点 X' },
        from_y: { type: 'integer', description: '拖拽选中模式：起点 Y' },
        to_x: { type: 'integer', description: '拖拽选中模式：终点 X' },
        to_y: { type: 'integer', description: '拖拽选中模式：终点 Y' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_apps',
    description: '列出当前所有可见的顶层窗口（标题 + PID + 进程名 + 窗口位置），用于找到目标应用窗口。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'launch_app',
    description: '启动一个应用程序或打开文件/URL（等价于 Win+R 执行：支持 exe 路径、应用名、文档路径、http(s) 链接等）。启动后建议 wait 1~2 秒再截图确认。',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: '程序路径/名称/URL，如 notepad、calc、D:\\a.txt、https://example.com' } },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    name: 'wait',
    description: '等待指定毫秒数（等待应用启动/界面加载/动画完成）。',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', description: '等待毫秒数，默认 1000，最大 10000' } },
      properties_order: ['ms'],
      additionalProperties: false
    }
  }
];

// ============================ PowerShell 执行桥 ============================
// C# 原语类（一次 Add-Type 覆盖全部工具：SendInput 键鼠/SetCursorPos/GDI 截图/EnumWindows）
const CU_CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CUCore {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, int lp);
  public delegate bool EnumProc(IntPtr h, int lp);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; public uint pad1, pad2; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  public static void SendUnicodeText(string text) {
    var list = new List<INPUT>();
    foreach (char ch in text) {
      if (ch == '\\n') { // 回车键独立发送（键盘事件，不作为 Unicode 字符）
        var e = new INPUT(); e.type = INPUT_KEYBOARD; e.u.ki.wScan = 13; e.u.ki.dwFlags = 0; list.Add(e);
        var e2 = new INPUT(); e2.type = INPUT_KEYBOARD; e2.u.ki.wScan = 13; e2.u.ki.dwFlags = KEYEVENTF_KEYUP; list.Add(e2);
        continue;
      }
      ushort scan = ch;
      var d = new INPUT(); d.type = INPUT_KEYBOARD; d.u.ki.wScan = scan; d.u.ki.dwFlags = KEYEVENTF_UNICODE; list.Add(d);
      var u = new INPUT(); u.type = INPUT_KEYBOARD; u.u.ki.wScan = scan; u.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; list.Add(u);
    }
    var arr = list.ToArray(); if (arr.Length > 0) SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static List<string> ListWindows() {
    var result = new List<string>();
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      string title = sb.ToString(); if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L <= 0 || r.B - r.T <= 0) return true; // 跳过零尺寸隐藏窗口
      result.Add(pid + "\\t" + r.L + "," + r.T + "," + r.R + "," + r.B + "\\t" + title);
      return true;
    }, 0);
    return result;
  }
  public static string ForegroundInfo() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return pid + "\\t" + sb.ToString();
  }
}`;

// PowerShell 脚本模板：args JSON 从环境变量注入（避免命令行注入与长度限制），$cmd 分发子命令
function buildScript(cmd) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8 # 输出统一 UTF8（Node 端按 UTF8 解码，防中文乱码）
$arg = $env:CU_ARGS | ConvertFrom-Json
Add-Type -TypeDefinition @'
${CU_CSHARP}
'@ -Language CSharp
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Get-ShotB64 {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $scale = [Math]::Min(1.0, ${SCREENSHOT_MAX_WIDTH} / [double]$bmp.Width)
  $w = [int]($bmp.Width * $scale); $h = [int]($bmp.Height * $scale)
  $small = New-Object System.Drawing.Bitmap $w, $h
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $w, $h)
  $ms = New-Object System.IO.MemoryStream
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${SCREENSHOT_JPEG_QUALITY})
  $small.Save($ms, $codec, $ep)
  [Convert]::ToBase64String($ms.ToArray())
  $g.Dispose(); $g2.Dispose(); $ms.Dispose(); $bmp.Dispose(); $small.Dispose()
}
switch ('${cmd}') {
  'screenshot' { Write-Output 'IMAGE_B64_BELOW'; Get-ShotB64 }
  'get_app_state' { Write-Output ('FOREGROUND|' + [CUCore]::ForegroundInfo()); Write-Output 'IMAGE_B64_BELOW'; Get-ShotB64 }
  'click' {
    [void][CUCore]::SetCursorPos([int]$arg.x, [int]$arg.y); Start-Sleep -Milliseconds 60
    [CUCore]::mouse_event(2,0,0,0,0); [CUCore]::mouse_event(4,0,0,0,0)
    Write-Output ('OK 已在 (' + $arg.x + ',' + $arg.y + ') 单击左键')
  }
  'double_click' {
    [void][CUCore]::SetCursorPos([int]$arg.x, [int]$arg.y); Start-Sleep -Milliseconds 60
    1..2 | ForEach-Object { [CUCore]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 40; [CUCore]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 40 }
    Write-Output ('OK 已在 (' + $arg.x + ',' + $arg.y + ') 双击')
  }
  'right_click' {
    [void][CUCore]::SetCursorPos([int]$arg.x, [int]$arg.y); Start-Sleep -Milliseconds 60
    [CUCore]::mouse_event(8,0,0,0,0); [CUCore]::mouse_event(16,0,0,0,0)
    Write-Output ('OK 已在 (' + $arg.x + ',' + $arg.y + ') 右键单击')
  }
  'scroll' {
    [void][CUCore]::SetCursorPos([int]$arg.x, [int]$arg.y); Start-Sleep -Milliseconds 50
    [CUCore]::mouse_event(0x800,0,0,[uint32]([int]$arg.delta),0)
    Write-Output ('OK 已在 (' + $arg.x + ',' + $arg.y + ') 滚动 ' + $arg.delta)
  }
  'drag' {
    $dur = 400; if ($arg.duration_ms) { $dur = [Math]::Max(60, [int]$arg.duration_ms) }
    [void][CUCore]::SetCursorPos([int]$arg.from_x, [int]$arg.from_y); Start-Sleep -Milliseconds 80
    [CUCore]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60
    $steps = [Math]::Max(6, [int]($dur / 40))
    for ($i = 1; $i -le $steps; $i++) {
      $cx = [int]($arg.from_x + ($arg.to_x - $arg.from_x) * $i / $steps)
      $cy = [int]($arg.from_y + ($arg.to_y - $arg.from_y) * $i / $steps)
      [void][CUCore]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds ([Math]::Max(1, [int]($dur / $steps)))
    }
    Start-Sleep -Milliseconds 40
    [CUCore]::mouse_event(4,0,0,0,0)
    Write-Output ('OK 已从 (' + $arg.from_x + ',' + $arg.from_y + ') 拖拽到 (' + $arg.to_x + ',' + $arg.to_y + ')')
  }
  'type_text' {
    [CUCore]::SendUnicodeText([string]$arg.text)
    Write-Output ('OK 已输入 ' + $arg.text.Length + ' 个字符')
  }
  'press_key' {
    # 组合键解析：ctrl/alt/shift 前缀 + 主键（SendKeys 语法）
    $k = [string]$arg.key
    $mods = @{ ctrl = '^'; alt = '%'; shift = '+' }
    $prefix = ''
    foreach ($name in @('ctrl','alt','shift')) {
      if ($k -match ('(?i)^' + $name + '\+(.+)$')) { $prefix += $mods[$name]; $k = $Matches[1] }
    }
    $map = @{
      enter='{ENTER}'; tab='{TAB}'; esc='{ESC}'; escape='{ESC}'; backspace='{BACKSPACE}'; bs='{BACKSPACE}'
      delete='{DEL}'; del='{DEL}'; home='{HOME}'; end='{END}'; pageup='{PGUP}'; pagedown='{PGDN}'
      up='{UP}'; down='{DOWN}'; left='{LEFT}'; right='{RIGHT}'; space=' '
    }
    if ($k -match '^(f([1-9]|1[0-2]))$') { $k = '{' + $k.ToUpper() + '}' }
    elseif ($map.ContainsKey($k.ToLower())) { $k = $map[$k.ToLower()] }
    [System.Windows.Forms.SendKeys]::SendWait($prefix + $k)
    Write-Output ('OK 已发送按键 ' + $arg.key)
  }
  'select_text' {
    if ($null -ne $arg.from_x -and $null -ne $arg.to_x) {
      # 拖拽选中：从起点按住左键平滑拖到终点释放
      [void][CUCore]::SetCursorPos([int]$arg.from_x, [int]$arg.from_y); Start-Sleep -Milliseconds 60
      [CUCore]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60
      $steps = 14
      for ($i = 1; $i -le $steps; $i++) {
        $cx = [int]($arg.from_x + ($arg.to_x - $arg.from_x) * $i / $steps)
        $cy = [int]($arg.from_y + ($arg.to_y - $arg.from_y) * $i / $steps)
        [void][CUCore]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 25
      }
      Start-Sleep -Milliseconds 40
      [CUCore]::mouse_event(4,0,0,0,0)
      Write-Output ('OK 已从 (' + $arg.from_x + ',' + $arg.from_y + ') 拖拽选中到 (' + $arg.to_x + ',' + $arg.to_y + ')')
    } else {
      # 单点：双击选中该处词句
      [void][CUCore]::SetCursorPos([int]$arg.x, [int]$arg.y); Start-Sleep -Milliseconds 60
      1..2 | ForEach-Object { [CUCore]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 40; [CUCore]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 40 }
      Write-Output ('OK 已双击选中 (' + $arg.x + ',' + $arg.y + ') 处词句')
    }
  }
  'list_apps' {
    $rows = [CUCore]::ListWindows()
    foreach ($r in $rows) { Write-Output $r }
    Write-Output ('共 ' + $rows.Count + ' 个可见窗口')
  }
  'launch_app' {
    Start-Process ([string]$arg.target)
    Write-Output ('OK 已启动 ' + $arg.target)
  }
  'wait' {
    $ms = 1000; if ($arg.ms) { $ms = [Math]::Min(10000, [Math]::Max(0, [int]$arg.ms)) }
    Start-Sleep -Milliseconds $ms
    Write-Output ('OK 已等待 ' + $ms + 'ms')
  }
}
`;
}

// 执行一个工具子命令：resolve 返回 {text, imageB64?}
function runTool(cmd, args) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildScript(cmd)],
      { env: Object.assign({}, process.env, { CU_ARGS: JSON.stringify(args || {}) }), windowsHide: true }
    );
    let out = '', err = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch (e) {} }, 30000); // 单工具 30 秒兜底（含截图/拖拽）
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', () => {
      clearTimeout(timer);
      // get_app_state 约定：首行 FOREGROUND 元信息 + 分隔行 + base64
      let imageB64 = null;
      const sep = out.indexOf('IMAGE_B64_BELOW');
      if (sep >= 0) {
        imageB64 = out.slice(sep + 'IMAGE_B64_BELOW'.length).trim();
        out = out.slice(0, sep).trim();
      }
      if (err && !out) { resolve({ text: '错误：' + err.trim().split('\n')[0] }); return; }
      resolve(imageB64 ? { text: out, imageB64 } : { text: out });
    });
    ps.on('error', (e) => { clearTimeout(timer); resolve({ text: '错误：无法启动 PowerShell：' + e.message }); });
  });
}

// ============================ MCP stdio 协议实现 ============================
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function listToolsResult() {
  return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
}

// 工具调用 → MCP content 数组（文本 + 可选图像）；图像以 ImageContent 返回，
// mcp-manager.js / 服务端 mcp.go 转发时统一转为 [[MCP_IMAGE:...]] 标记注入模型
async function callTool(id, name, args) {
  if (!TOOLS.some((t) => t.name === name)) {
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: '未知工具：' + name } });
    return;
  }
  const r = await runTool(name, args || {});
  const content = [{ type: 'text', text: r.text }];
  if (r.imageB64) content.push({ type: 'image', data: r.imageB64, mimeType: 'image/jpeg' });
  send({ jsonrpc: '2.0', id, result: { content, isError: r.text.startsWith('错误') } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { return; }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
      break;
    case 'notifications/initialized':
      break; // 客户端确认，无需回包
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: listToolsResult() });
      break;
    case 'tools/call':
      callTool(id, params.name, params.arguments);
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      break;
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知方法：' + method } });
  }
});
rl.on('close', () => process.exit(0));
process.on('error', () => process.exit(1));
