# remote-sendinput.ps1 - Stage 155: remote assist input injection worker (resident process)
# Line protocol on stdin, one command per line:
#   m move <nx> <ny>            normalized mouse move, 0..1 fraction of primary screen
#   m down <btn> | m up <btn>   mouse button, btn: 0=left 1=middle 2=right
#   m wheel <delta>             vertical wheel, 120 = one notch (positive = scroll up)
#   k down <vk> <ext> | k up <vk> <ext>   virtual key event (ext: 1 = extended key)
#   k uni <down|up> <code>      unicode char event (utf-16 code unit, decimal)
# Handshake: writes "ready" on stdout after init. EOF (stdin closed) exits itself,
# so a crashed parent never leaves orphans behind. ASCII-only comments on purpose:
# Windows PowerShell 5.1 parses BOM-less UTF-8 Chinese comments as ANSI (mojibake).

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RemoteInputSender {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    private static void Send(INPUT[] list) { SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT))); }

    // Normalized (0..1) move targeting the primary screen, mapped into the virtual
    // desktop (primary screen is at global (0,0); multi-monitor desks stay correct).
    public static void MouseAbs(double nx, double ny) {
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        int cxP = GetSystemMetrics(0);   // SM_CXSCREEN primary width
        int cyP = GetSystemMetrics(1);   // SM_CYSCREEN primary height
        int vx = GetSystemMetrics(76);   // SM_XVIRTUALSCREEN left edge
        int vy = GetSystemMetrics(77);   // SM_YVIRTUALSCREEN top edge
        int cxV = GetSystemMetrics(78);  // SM_CXVIRTUALSCREEN width
        int cyV = GetSystemMetrics(79);  // SM_CYVIRTUALSCREEN height
        if (cxP <= 0 || cyP <= 0 || cxV <= 0 || cyV <= 0) return;
        double px = nx * cxP;
        double py = ny * cyP;
        int dx = (int)Math.Round((px - vx) * 65536.0 / cxV);
        int dy = (int)Math.Round((py - vy) * 65536.0 / cyV);
        if (dx < 0) dx = 0; if (dx > 65535) dx = 65535;
        if (dy < 0) dy = 0; if (dy > 65535) dy = 65535;
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.dx = dx;
        inp[0].U.mi.dy = dy;
        inp[0].U.mi.mouseData = 0;
        inp[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        Send(inp);
    }

    public static void Button(uint btn, bool up) {
        uint flag;
        if (btn == 1) flag = up ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN;
        else if (btn == 2) flag = up ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_RIGHTDOWN;
        else flag = up ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN;
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.dwFlags = flag;
        Send(inp);
    }

    public static void Wheel(int delta) {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.mouseData = unchecked((uint)delta);
        inp[0].U.mi.dwFlags = MOUSEEVENTF_WHEEL;
        Send(inp);
    }

    // Virtual key event; scan code resolved via MapVirtualKey so apps reading
    // scancodes (games, remote-aware apps) keep working. ext = extended key.
    public static void Key(ushort vk, bool up, bool ext) {
        uint sc = MapVirtualKey(vk, 0); // MAPVK_VK_TO_VSC
        uint flags = 0;
        if (ext) flags |= KEYEVENTF_EXTENDEDKEY;
        if (up) flags |= KEYEVENTF_KEYUP;
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].U.ki.wVk = vk;
        inp[0].U.ki.wScan = (ushort)sc;
        inp[0].U.ki.dwFlags = flags;
        Send(inp);
    }

    // Unicode char injection, layout independent (letters/digits/symbols/CJK
    // direct input; does not depend on the local keyboard state or IME).
    public static void Unicode(ushort code, bool up) {
        uint flags = KEYEVENTF_UNICODE;
        if (up) flags |= KEYEVENTF_KEYUP;
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].U.ki.wVk = 0;
        inp[0].U.ki.wScan = code;
        inp[0].U.ki.dwFlags = flags;
        Send(inp);
    }
}
"@

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }   # EOF: parent closed stdin, exit
    $line = $line.Trim()
    if ($line -eq '') { continue }
    try {
        $p = $line -split ' '
        switch ($p[0]) {
            'm' {
                switch ($p[1]) {
                    'move'  { [RemoteInputSender]::MouseAbs([double]$p[2], [double]$p[3]) }
                    'down'  { [RemoteInputSender]::Button([uint32]$p[2], $false) }
                    'up'    { [RemoteInputSender]::Button([uint32]$p[2], $true) }
                    'wheel' { [RemoteInputSender]::Wheel([int]$p[2]) }
                }
            }
            'k' {
                switch ($p[1]) {
                    'down' { [RemoteInputSender]::Key([uint16]$p[2], $false, ($p[3] -eq '1')) }
                    'up'   { [RemoteInputSender]::Key([uint16]$p[2], $true, ($p[3] -eq '1')) }
                    'uni'  { [RemoteInputSender]::Unicode([uint16]$p[3], ($p[2] -eq 'up')) }
                }
            }
        }
    } catch {
        # malformed line: skip it and keep the worker alive
    }
}
