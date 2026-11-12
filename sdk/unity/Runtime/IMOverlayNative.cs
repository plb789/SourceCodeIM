// =====================================================================
//  IMOverlayNative.cs — P/Invoke 层（IMOverlay.dll 导出函数映射）
//  这个文件只做一件事：把 DLL 的纯 C 接口转成 C# 可调用的方法。
//  不做任何业务逻辑、不依赖 UnityEngine。
// =====================================================================

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace IMOverlay
{
    internal static class Native
    {
#if UNITY_EDITOR_WIN || UNITY_STANDALONE_WIN
        // Unity 会根据 Plugins/x64 / Plugins/x86 自动选择正确的 DLL
        private const string DLL = "IMOverlay";
#else
        private const string DLL = "__Internal"; // 移动端预留（暂未实现）
#endif

        // —— 生命周期 ——

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_Init(FrameCallback cb, IntPtr userData);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_Start();

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern void IMOVERLAY_Stop();

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_IsRunning();

        // —— 帧内渲染 ——

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_RenderPresent(IntPtr dev, IntPtr ctx, IntPtr backbuffer);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_RenderPresentVulkan(
            UInt64 device, UInt64 queue, UInt64 cmdBuffer,
            UInt64 renderPass, UInt64 framebuffer, int width, int height);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_RenderPresentGL();

        // —— 悬浮窗控制 ——

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SetOverlayOpen(int open);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_ShowPanel();

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SetOverlayRect(int x, int y, int w, int h);

        // —— 上行帧 ——

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
        public static extern int IMOVERLAY_SendChat(
            [MarshalAs(UnmanagedType.LPStr)] string to,
            [MarshalAs(UnmanagedType.LPStr)] string text);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SendRoomReady(int roomId);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SendRoomLeave(int roomId);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
        public static extern int IMOVERLAY_SendRoomChat(
            int roomId,
            [MarshalAs(UnmanagedType.LPStr)] string text);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SendPanelOpen(int open);

        // —— 样式定制 ——

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SetThemeColor(int r, int g, int b);

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall)]
        public static extern int IMOVERLAY_SetFont(IntPtr fontData, int dataLen, float size);

        // —— 工具 ——

        [DllImport(DLL, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
        public static extern IntPtr IMOVERLAY_GetVersion();

        // —— 回调委托（后台线程触发 → C# 用 GCHandle.Alloc 保活）——

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate void FrameCallback(ref NativeFrame frame, IntPtr userData);

        // —— POD 结构体（和 IMOverlay.h 定义 100% 对齐）——

        [StructLayout(LayoutKind.Sequential)]
        public struct NativeFrame
        {
            public int type;                // IMOVERLAY_FrameType enum

            // 通用字段
            public IntPtr u;                // const char*
            public IntPtr from;
            public IntPtr name;
            public IntPtr to;
            public IntPtr text;
            public IntPtr action;
            public IntPtr mode;

            public int room_id;
            public int vk, ctrl, shift, alt;
            public int w, h;

            // friends
            public IntPtr friends;          // const IMOVERLAY_Friend*
            public int friends_count;

            // room
            public int has_room;
            public IntPtr room_players;
            public int room_players_count;

            // follow
            public int follow_all;
            public IntPtr follow_list;      // const char**
            public int follow_list_count;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct NativeFriend
        {
            public IntPtr username;
            public IntPtr nickname;
            public int online;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct NativePlayer
        {
            public IntPtr username;
            public IntPtr nickname;
        }

        // —— 辅助：版本字符串 ——

        public static string GetVersion()
        {
            var ptr = IMOVERLAY_GetVersion();
            if (ptr == IntPtr.Zero) return "";
            return Marshal.PtrToStringAnsi(ptr);
        }
    }
}
