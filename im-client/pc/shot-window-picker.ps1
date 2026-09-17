$sig = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct SPR { public int L; public int T; public int R; public int B; }
public static class SPW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out SPR r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  // hit test below our own fullscreen frozen overlay: WindowFromPoint always lands on the overlay
  // itself (topmost), so enumerate top-level windows in Z order instead, skip our own pid and
  // hidden / minimized / cloaked (UWP ghost) windows, return the first visible window whose rect
  // contains the point -- i.e. the topmost real window under the overlay (QQ/Snipaste approach)
  public static string QueryPoint(int x, int y, int ownerPid) {
    List<IntPtr> ws = new List<IntPtr>(256);
    EnumWindows(delegate(IntPtr h, IntPtr l) { ws.Add(h); return true; }, IntPtr.Zero);
    foreach (IntPtr h in ws) {
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)ownerPid) continue;
      if (!IsWindowVisible(h) || IsIconic(h)) continue;
      int cloak = 0;
      if (DwmGetWindowAttribute(h, 14, out cloak, 4) == 0 && cloak != 0) continue;
      SPR r;
      if (!GetWindowRect(h, out r)) continue;
      if (r.R - r.L <= 0 || r.B - r.T <= 0) continue;
      if (x >= r.L && x < r.R && y >= r.T && y < r.B) return r.L + "," + r.T + "," + r.R + "," + r.B;
    }
    return "none";
  }
}
"@
Add-Type -TypeDefinition $sig
# DPI aware: all coordinates are physical pixels (renderer sends clientX * devicePixelRatio)
[void][SPW]::SetProcessDPIAware()
$ownerPid = [int]$args[0]
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $pp = $line.Split(',')
  if ($pp.Count -ne 2) { [Console]::Out.WriteLine("none"); [Console]::Out.Flush(); continue }
  $out = "none"
  try { $out = [SPW]::QueryPoint([int]$pp[0], [int]$pp[1], $ownerPid) } catch { $out = "none" }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
