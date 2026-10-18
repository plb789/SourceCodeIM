#!/usr/bin/env bash
# =============================================================================
# deploy-supernode.sh —— 从开发机把 p2p/n2n_v2 源码发布到 Linux 服务器并编译/重启 supernode
#
# 用法（开发机执行；需 ssh/scp 可用且已配置服务器免密或愿意交互输密码）：
#   bash deploy-supernode.sh <user@host> [选项]
# 选项：
#   -p <ssh端口>          SSH 端口（默认 22）
#   --port <supernode端口> supernode 监听端口（默认 9527，与服务端 config.yaml 的
#                         vip_pool.supernodes 对齐）
#   --restart             编译成功后备份旧二进制、替换并重启服务（默认只上传+编译，
#                         不影响运行中的 supernode——首次部署建议先跑一次确认编译通过）
#   --install-unit        生成/更新 systemd 单元 im-supernode.service 并启用
#                         （重启方式：有单元走 systemctl，无单元走 nohup 兜底）
#   --dir <远端目录>      远端工作/安装目录（默认 /opt/im-sn）
#
# 示例：
#   bash deploy-supernode.sh root@39.98.206.195 --restart --install-unit
#
# 安全说明：本脚本不内嵌任何凭据；SSH 认证走密钥或交互输入。远端目录/端口可通过参数覆盖，
#           无硬编码路径（默认值均为本方案约定）。
# 冒烟验证：--restart 完成后自动做本机回环管理口（5645）help 查询，验证进程存活。
# =============================================================================
set -euo pipefail

# ---- 参数解析 ----
TARGET=""   # user@host
SSH_PORT=22
SN_PORT=9527
DO_RESTART=0
INSTALL_UNIT=0
REMOTE_DIR="/opt/im-sn"

while [ $# -gt 0 ]; do
  case "$1" in
    -p) SSH_PORT="$2"; shift 2;;
    --port) SN_PORT="$2"; shift 2;;
    --restart) DO_RESTART=1; shift;;
    --install-unit) INSTALL_UNIT=1; shift;;
    --dir) REMOTE_DIR="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) if [ -z "$TARGET" ]; then TARGET="$1"; shift; else echo "未知参数: $1" >&2; exit 1; fi;;
  esac
done
[ -n "$TARGET" ] || { echo "用法: bash deploy-supernode.sh <user@host> [选项]（-h 查看帮助）" >&2; exit 1; }

# ---- 本地源码目录（脚本所在目录的上两级，即 p2p/n2n_v2）----
SRC_DIR="$(cd "$(dirname "$0")/../n2n_v2" && pwd)"
BUILD_SH="$(cd "$(dirname "$0")" && pwd)/build-supernode.sh"
[ -d "$SRC_DIR" ] || { echo "[deploy] 未找到源码目录: $SRC_DIR" >&2; exit 1; }
[ -f "$BUILD_SH" ] || { echo "[deploy] 未找到编译脚本: $BUILD_SH" >&2; exit 1; }

SSH_OPTS="-p $SSH_PORT -o ConnectTimeout=10"
scp_opts="-P $SSH_PORT -o ConnectTimeout=10"

echo "[deploy] 目标: $TARGET (ssh端口 $SSH_PORT)"
echo "[deploy] supernode 端口: $SN_PORT / 远端目录: $REMOTE_DIR / 重启: $DO_RESTART / systemd单元: $INSTALL_UNIT"

# ---- 1) 打包源码（p2p/n2n_v2 顶层 .c/.h，排除 win32/wireshark/out 等子目录）----
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
(cd "$SRC_DIR" && tar czf "$STAGE/src.tgz" *.c *.h)
cp "$BUILD_SH" "$STAGE/build-supernode.sh"
echo "[deploy] 源码打包完成（$STAGE/src.tgz）"

# ---- 2) 上传 ----
scp $scp_opts "$STAGE/src.tgz" "$STAGE/build-supernode.sh" "$TARGET:/tmp/"
echo "[deploy] 上传完成"

# ---- 3) 远端解包 + 编译 ----
ssh $SSH_OPTS "$TARGET" "set -e; mkdir -p '$REMOTE_DIR/src' && cd '$REMOTE_DIR/src' && tar xzf /tmp/src.tgz && bash build-supernode.sh '$REMOTE_DIR/supernode.new'"
echo "[deploy] 远端编译完成"

# ---- 4) 重启（仅在 --restart 时动运行中的服务）----
if [ "$DO_RESTART" -eq 1 ]; then
  ssh $SSH_OPTS "$TARGET" "bash -s" <<REMOTE_SCRIPT
set -e
cd '$REMOTE_DIR'
# 备份旧二进制（带时间戳，保留最近 3 份）
if [ -f supernode ]; then
  ts=\$(date +%Y%m%d%H%M%S)
  cp supernode "supernode.bak.\$ts"
  ls -1t supernode.bak.* 2>/dev/null | tail -n +4 | xargs -r rm -f
fi
# 停旧进程：systemd 单元优先，否则按进程名兜底
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^im-supernode'; then
  systemctl stop im-supernode || true
else
  pkill -x supernode 2>/dev/null || true
  sleep 1
fi
# 替换二进制
mv -f supernode.new supernode
chmod +x supernode
# systemd 单元（可选）：前台进程交由 systemd 托管
if [ '$INSTALL_UNIT' -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/im-supernode.service <<UNIT
[Unit]
Description=IM supernode (n2n v2 virtual LAN rendezvous)
After=network.target

[Service]
ExecStart=$REMOTE_DIR/supernode -l $SN_PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now im-supernode
else
  # nohup 兜底：无 systemd 单元时后台拉起
  nohup ./supernode -l $SN_PORT >/var/log/im-supernode.log 2>&1 &
fi
sleep 1
# 冒烟：进程存活 + 管理口回环 help 查询
pgrep -x supernode >/dev/null || { echo '[smoke] 进程未存活' >&2; exit 1; }
resp=\$( (exec 3<>/dev/udp/127.0.0.1/5645; printf 'help' >&3; timeout 2 head -c 64 <&3) || true )
[ -n "\$resp" ] || { echo '[smoke] 管理口无回复' >&2; exit 1; }
echo '[smoke] supernode 存活且管理口应答正常'
REMOTE_SCRIPT
  echo "[deploy] 重启完成，冒烟验证通过"
else
  echo "[deploy] 编译产物已就位: $TARGET:$REMOTE_DIR/supernode.new（未重启；确认无误后追加 --restart 重新执行以切换）"
fi

# ---- 5) 清理远端临时文件 ----
ssh $SSH_OPTS "$TARGET" "rm -f /tmp/src.tgz /tmp/build-supernode.sh"
echo "[deploy] 全部完成"
