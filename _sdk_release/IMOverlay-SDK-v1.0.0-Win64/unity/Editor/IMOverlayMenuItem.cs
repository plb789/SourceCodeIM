// =====================================================================
//  IMOverlayMenuItem.cs — Unity Editor 菜单
//  一键把 IMOverlay MonoBehaviour 加到场景 GameObject 上。
//  菜单位置：Tools → IM Overlay → Add Overlay
// =====================================================================

#if UNITY_EDITOR

using UnityEditor;
using UnityEngine;

namespace IMOverlay.Editor
{
    public static class IMOverlayMenuItem
    {
        [MenuItem("Tools/IM Overlay/Add Overlay")]
        public static void AddOverlay()
        {
            var go = new GameObject("IMOverlay");
            if (Camera.main != null)
            {
                go.transform.SetParent(Camera.main.transform, false);
                go.transform.localPosition = Vector3.zero;
                go.transform.localRotation = Quaternion.identity;
            }
            go.AddComponent<IMOverlay.IMOverlay>();
            go.tag = "MainCamera";

            Selection.activeGameObject = go;
            EditorGUIUtility.PingObject(go);
        }

        [MenuItem("Tools/IM Overlay/Add Overlay", true)]
        public static bool AddOverlayValidate()
        {
            return Object.FindObjectOfType<IMOverlay.IMOverlay>() == null;
        }

        [MenuItem("Tools/IM Overlay/Documentation")]
        public static void OpenDocs()
        {
            System.Diagnostics.Process.Start("https://docs.im-client.dev/sdk/unity");
        }

        [MenuItem("Tools/IM Overlay/About")]
        public static void ShowAbout()
        {
            EditorUtility.DisplayDialog(
                "IM Overlay SDK",
                "IMOverlay.dll v1.0.0\n" +
                "游戏内 IM 聊天 / 好友 / 房间 Overlay\n\n" +
                "IM-Client 项目内置 SDK\n" +
                "docs/sdk/sdk-design.md",
                "OK");
        }
    }
}

#endif
