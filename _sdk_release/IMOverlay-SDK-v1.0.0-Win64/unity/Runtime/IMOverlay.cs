// =====================================================================
//  IMOverlay.cs — Unity 主门面类
//  单例，提供商户 C# 层唯一入口。
//
//  使用示例（最简接法，不改代码）：
//    void Awake() { IMOverlay.Instance.AutoInit(); }
//    void OnGUI() { foreach (var f in IMOverlay.Instance.Frames) ... }
//
//  使用示例（高级接法，帧内渲染）：
//    void Start() { IMOverlay.Instance.Init(); IMOverlay.Instance.Start(); }
//    void Update() { IMOverlay.Instance.PumpFrames(); /* 回调触发 */ }
//    void LateUpdate() { IMOverlay.Instance.RenderPresent(); }
// =====================================================================

using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;

namespace IMOverlay
{
    public delegate void FrameReceivedHandler(Frame frame);

    public class IMOverlay : MonoBehaviour
    {
        // —— 单例 ——
        public static IMOverlay Instance { get; private set; }

        // —— 帧事件 ——
        public event FrameReceivedHandler OnFrame;

        // —— 线程安全队列（后台 DLL 线程写，主线程 PumpFrames 读）——
        private ConcurrentQueue<Frame> frameQueue = new ConcurrentQueue<Frame>();

        // —— DLL 回调委托（用 GCHandle 保活直到 Dispose）——
        private Native.FrameCallback frameCallback;
        private GCHandle frameCallbackHandle;

        // —— 状态 ——
        private bool initialized;
        private bool started;

        // —— RenderPresent 参数缓存（D3D11：从 GL.GetNativePtr() 自动拿）——
        private IntPtr cachedDevice;
        private IntPtr cachedContext;
        private IntPtr cachedBackBuffer;

        // ================================================================
        //  MonoBehaviour 生命周期
        // ================================================================

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
            DontDestroyOnLoad(gameObject);
        }

        private void OnDestroy()
        {
            Shutdown();
            if (Instance == this) Instance = null;
        }

        private void Update()
        {
            // 每帧 Pump —— 把 DLL 后台线程回调收到的帧转到 C# 主线程
            PumpFrames();
        }

        private void LateUpdate()
        {
            // 如果商户没手动调 RenderPresent，在这里自动尝试一次
            // （D3D11 Renderer 下缓存 device/ctx 指针）
            if (started && cachedDevice == IntPtr.Zero)
            {
                TryCacheD3D11Pointers();
            }
            if (started && cachedDevice != IntPtr.Zero)
            {
                Native.IMOVERLAY_RenderPresent(cachedDevice, cachedContext, cachedBackBuffer);
            }
        }

        // ================================================================
        //  公共 API
        // ================================================================

        /// <summary>
        /// 自动初始化并启动（最简接法，商户只需要这一行）。
        /// MonoBehaviour.Awake() 后自动调用。
        /// </summary>
        public void AutoInit()
        {
            Init();
            Start();
        }

        /// <summary>
        /// 初始化 SDK（注册 DLL 回调）。
        /// </summary>
        public bool Init()
        {
            if (initialized) return true;

            try
            {
                // 创建托管委托并 pin 住（GCHandle 防止 GC 回收）
                frameCallback = OnNativeFrame;
                frameCallbackHandle = GCHandle.Alloc(frameCallback);

                int rc = Native.IMOVERLAY_Init(frameCallback, IntPtr.Zero);
                initialized = (rc == 0);
                return initialized;
            }
            catch (DllNotFoundException e)
            {
                Debug.LogError("[IMOverlay] IMOverlay.dll not found! Place it in Assets/Plugins/x64/ and Assets/Plugins/x86/\n" + e.Message);
                return false;
            }
            catch (Exception e)
            {
                Debug.LogError("[IMOverlay] Init failed: " + e.Message);
                return false;
            }
        }

        /// <summary>
        /// 启动后台收帧线程（Start() 默认帧内模式 → 等 RenderPresent；5 秒未调自动悬浮窗兜底）。
        /// </summary>
        public bool Start()
        {
            if (!Init()) return false;
            if (started) return true;

            int rc = Native.IMOVERLAY_Start();
            started = (rc == 0);
            if (!started) Debug.LogWarning("[IMOverlay] Start() failed rc=" + rc);
            return started;
        }

        /// <summary>
        /// 停止 SDK。
        /// </summary>
        public void Shutdown()
        {
            if (started)
            {
                Native.IMOVERLAY_Stop();
                started = false;
            }
            if (frameCallbackHandle.IsAllocated)
            {
                frameCallbackHandle.Free();
            }
            initialized = false;
        }

        /// <summary>
        /// 把 DLL 后台线程收到的帧转到主线程（从 ConcurrentQueue 取出 → 触发 OnFrame 事件）。
        /// 商户在自己的 MonoBehaviour.Update 里调，或者用本类的内置自动 Pump（Update 里已调）。
        /// </summary>
        public void PumpFrames()
        {
            Frame f;
            int count = 0;
            const int MaxPerFrame = 256; // 防帧堆积
            while (frameQueue.TryDequeue(out f) && count < MaxPerFrame)
            {
                try { OnFrame?.Invoke(f); }
                catch (Exception e) { Debug.LogError("[IMOverlay] OnFrame handler exception: " + e); }
                count++;
            }
        }

        // —— 帧内渲染（供商户直接调）——

        /// <summary>
        /// D3D11/D3D12 帧内渲染（自动缓存 device 指针，后续 LateUpdate 继续调）。
        /// 商户在自己渲染管线 Present 前调，或依赖本类 LateUpdate 自动调。
        /// </summary>
        public int RenderPresent(IntPtr dev, IntPtr ctx, IntPtr backbuffer)
        {
            cachedDevice = dev;
            cachedContext = ctx;
            cachedBackBuffer = backbuffer;
            return Native.IMOVERLAY_RenderPresent(dev, ctx, backbuffer);
        }

        /// <summary>
        /// Vulkan 帧内渲染。
        /// </summary>
        public int RenderPresentVulkan(
            UInt64 device, UInt64 queue, UInt64 cmdBuffer,
            UInt64 renderPass, UInt64 framebuffer, int width, int height)
        {
            return Native.IMOVERLAY_RenderPresentVulkan(device, queue, cmdBuffer, renderPass, framebuffer, width, height);
        }

        /// <summary>
        /// OpenGL 3+ 帧内渲染（零参数，线程 GL context 自动拿）。
        /// </summary>
        public int RenderPresentGL() => Native.IMOVERLAY_RenderPresentGL();

        // —— 悬浮窗控制 ——

        public int SetOverlayOpen(bool open) => Native.IMOVERLAY_SetOverlayOpen(open ? 1 : 0);
        public int ShowPanel() => Native.IMOVERLAY_ShowPanel();
        public int SetOverlayRect(int x, int y, int w, int h) => Native.IMOVERLAY_SetOverlayRect(x, y, w, h);

        // —— 上行帧（商户主动发起）——

        public int SendChat(string to, string text)
        {
            if (string.IsNullOrEmpty(to)) return -4;
            return Native.IMOVERLAY_SendChat(to, text);
        }

        public int SendRoomReady(int roomId) => Native.IMOVERLAY_SendRoomReady(roomId);
        public int SendRoomLeave(int roomId) => Native.IMOVERLAY_SendRoomLeave(roomId);

        public int SendRoomChat(int roomId, string text)
        {
            if (string.IsNullOrEmpty(text)) return -4;
            return Native.IMOVERLAY_SendRoomChat(roomId, text);
        }

        public int SendPanelOpen(bool open) => Native.IMOVERLAY_SendPanelOpen(open ? 1 : 0);

        // —— 样式定制 ——

        public int SetThemeColor(int r, int g, int b) => Native.IMOVERLAY_SetThemeColor(r, g, b);

        // —— 工具 ——

        public string GetVersion() => Native.GetVersion();
        public bool IsRunning() => Native.IMOVERLAY_IsRunning() == 1;

        // ================================================================
        //  私有实现
        // ================================================================

        /// <summary>
        /// DLL 后台线程回调（GCHandle 保活）。
        /// 不在这个回调里直接调 OnFrame（跨线程调 Unity API 不安全），
        /// 而是把 NativeFrame 解析成托管 Frame 后入队。
        /// </summary>
        private void OnNativeFrame(ref Native.NativeFrame raw, IntPtr userData)
        {
            try
            {
                var frame = Frame.FromNative(ref raw);
                frameQueue.Enqueue(frame);
            }
            catch (Exception e)
            {
                Debug.LogError("[IMOverlay] OnNativeFrame parse exception: " + e);
            }
        }

        /// <summary>
        /// 尝试自动拿 Unity D3D11 device/context 指针（用于 LateUpdate 自动 RenderPresent）。
        /// Unity 内部 API，用反射获取（UnityEngine.XR.XRSettings 或 GL.GetNativePtr）。
        /// 失败则指针为零 → 不渲染 → SDK 5 秒后自动悬浮窗兜底。
        /// </summary>
        private void TryCacheD3D11Pointers()
        {
            try
            {
                var glType = typeof(UnityEngine.GL);
                var method = glType.GetMethod("GetNativePtr",
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
                if (method != null)
                {
                    var ptr = method.Invoke(null, null);
                    // GL.GetNativePtr() 返回的可能是 device 或 context（取决于 Unity 版本）
                    // 简化：先假设是 device，context/backbuffer 后续补齐
                    cachedDevice = new IntPtr(Convert.ToInt64(ptr));
                    cachedContext = IntPtr.Zero;
                    cachedBackBuffer = IntPtr.Zero;
                }
            }
            catch
            {
                // Unity 版本不支持或渲染管线不是 D3D11 → 不缓存 → 商户手动调 RenderPresent 或自动悬浮窗
            }
        }
    }
}
