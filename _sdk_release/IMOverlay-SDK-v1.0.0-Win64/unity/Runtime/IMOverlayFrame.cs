// =====================================================================
//  IMOverlayFrame.cs — Unity 端托管帧数据结构
//  从 Native.NativeFrame（C 端 POD）解析出来的纯 C# 类。
//  所有字符串已 Marshal 到托管堆，不依赖 native 内存。
// =====================================================================

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace IMOverlay
{
    public enum FrameType
    {
        Unknown = 0,
        HelloAck = 1,
        Me = 2,
        Friends = 3,
        Msg = 4,
        Room = 5,
        RoomChat = 6,
        Avatar = 7,
        Hotkey = 8,
        Follow = 9,
    }

    public class Friend
    {
        public string Username;
        public string Nickname;
        public bool Online;
    }

    public class Player
    {
        public string Username;
        public string Nickname;
    }

    public class Frame
    {
        public FrameType Type;

        // 通用
        public string U;
        public string From;
        public string Name;
        public string To;
        public string Text;
        public string Action;
        public string Mode;

        public int RoomId;
        public int Vk, Ctrl, Shift, Alt;
        public int W, H;

        // friends
        public List<Friend> Friends = new List<Friend>();

        // room
        public bool HasRoom;
        public List<Player> RoomPlayers = new List<Player>();

        // follow
        public bool FollowAll;
        public List<string> FollowList = new List<string>();

        // —— 内部：从 NativeFrame 解析 ——

        internal static Frame FromNative(ref Native.NativeFrame raw)
        {
            var f = new Frame();
            f.Type = (FrameType)raw.type;

            f.U = PtrStr(raw.u);
            f.From = PtrStr(raw.from);
            f.Name = PtrStr(raw.name);
            f.To = PtrStr(raw.to);
            f.Text = PtrStr(raw.text);
            f.Action = PtrStr(raw.action);
            f.Mode = PtrStr(raw.mode);

            f.RoomId = raw.room_id;
            f.Vk = raw.vk; f.Ctrl = raw.ctrl; f.Shift = raw.shift; f.Alt = raw.alt;
            f.W = raw.w; f.H = raw.h;

            // friends
            if (raw.friends != IntPtr.Zero && raw.friends_count > 0)
            {
                int size = Marshal.SizeOf(typeof(Native.NativeFriend));
                for (int i = 0; i < raw.friends_count; i++)
                {
                    var p = new IntPtr(raw.friends.ToInt64() + i * size);
                    var nf = Marshal.PtrToStructure<Native.NativeFriend>(p);
                    f.Friends.Add(new Friend
                    {
                        Username = PtrStr(nf.username),
                        Nickname = PtrStr(nf.nickname),
                        Online = nf.online != 0
                    });
                }
            }

            // room players
            f.HasRoom = raw.has_room != 0;
            if (f.HasRoom && raw.room_players != IntPtr.Zero && raw.room_players_count > 0)
            {
                int size = Marshal.SizeOf(typeof(Native.NativePlayer));
                for (int i = 0; i < raw.room_players_count; i++)
                {
                    var p = new IntPtr(raw.room_players.ToInt64() + i * size);
                    var np = Marshal.PtrToStructure<Native.NativePlayer>(p);
                    f.RoomPlayers.Add(new Player
                    {
                        Username = PtrStr(np.username),
                        Nickname = PtrStr(np.nickname),
                    });
                }
            }

            // follow list
            if (raw.follow_list != IntPtr.Zero && raw.follow_list_count > 0)
            {
                var arr = new IntPtr[raw.follow_list_count];
                Marshal.Copy(raw.follow_list, arr, 0, raw.follow_list_count);
                for (int i = 0; i < raw.follow_list_count; i++)
                {
                    f.FollowList.Add(PtrStr(arr[i]));
                }
                f.FollowAll = raw.follow_all != 0;
            }

            return f;
        }

        private static string PtrStr(IntPtr p)
        {
            if (p == IntPtr.Zero) return null;
            return Marshal.PtrToStringAnsi(p);
        }
    }
}
