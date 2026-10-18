#!/usr/bin/env bash
# =============================================================================
# build-supernode.sh —— 在 Linux 服务器上编译 supernode（本仓库 p2p/n2n_v2 源码）
#
# 用法（在解包后的源码目录内执行）：
#   bash build-supernode.sh [输出文件路径]     # 默认 ./supernode
#
# 说明：
#   - 源文件清单与仓库 CMakeLists.txt 对齐（n2n 库 + sn.c + unix-scm.c），
#     直编一条 gcc 命令，服务器无需安装 cmake；
#   - 不定义 N2N_HAVE_AES（transform_aes.c 整体条件编译，空转）：
#     Windows 端 p2p-host.exe 未编 AES，实际加密协商走 null/twofish，
#     免去服务器安装 OpenSSL 开发库的依赖；
#   - 不定义 N2N_HAVE_DAEMON：supernode 前台运行，交由 systemd/nohup 托管
#     （与既有部署行为一致）；
#   - 本源码已含修复：共享内存门槛移除、recvfrom 瞬态错误不再自退。
# =============================================================================
set -euo pipefail

OUT="${1:-./supernode}"

command -v gcc >/dev/null 2>&1 || { echo "[build] 未找到 gcc，请先安装（apt install gcc / yum install gcc）" >&2; exit 1; }

# supernode 链接所需源文件（对齐 CMakeLists.txt：n2n 库 + scm + sn.c）
SRCS="sn.c n2n.c n2n_keyfile.c wire.c minilzo.c twofish.c \
transform_null.c transform_tf.c transform_aes.c \
tuntap_freebsd.c tuntap_netbsd.c tuntap_linux.c tuntap_osx.c \
version.c unix-scm.c"

for f in $SRCS; do
  [ -f "$f" ] || { echo "[build] 缺少源文件: $f（请在 p2p/n2n_v2 解包目录内执行）" >&2; exit 1; }
done

echo "[build] 编译 supernode -> $OUT"
gcc -O2 -DNDEBUG -Wall \
    -DN2N_VERSION='"2.1.0"' \
    -DN2N_OSNAME='"Linux"' \
    -o "$OUT" $SRCS

echo "[build] 完成: $OUT"
echo "[build] 运行方式: $OUT -l <监听端口>   （本项目 supernode 端口见服务端 config.yaml 的 vip_pool.supernodes，如 9527；管理口固定 5645 仅回环）"
