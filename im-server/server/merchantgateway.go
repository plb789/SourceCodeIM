package server

// ===== 商户独立后台·网关部署包下发（商户独立后台开发文档 §3.5，merchantGuard 鉴权） =====
//
// 包内容（拍板 5：所有商户同一通用包；多平台一次下载，商户按服务器系统自行选用）：
//   im-gateway.exe          —— Windows 标准版（Win10/Server2016+，build-gateway.bat → bin/）
//   im-gateway-2008r2.exe   —— Windows 2008R2/2012 兼容版（build-gateway-2008r2.bat → bin/）
//   im-gateway-linux        —— Linux amd64 静态版（build-gateway-linux.bat → bin/）
//   im-gateway-linux-arm64  —— Linux ARM64 静态版（可选，存在才打包）
//   gateway.yaml            —— 代码内生成模板（占位符，绝不携带服务端真实 token_secret/网关密钥）
//   部署说明.txt            —— 代码内生成（双平台部署步骤速览，详细教程见商户后台「使用说明」页）
// 缺哪个二进制跳哪个（至少一个，否则 404）；首次请求打包缓存至 <Game.LocalDir>/gateway/im-gateway.zip，
// 任一源二进制更新（mtime 比对）后自动重建。

import (
	"archive/zip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
)

// gatewayExeCandidates 2008R2 网关 exe 候选路径（与 config.Load 同款：工作目录 / bin 目录，不硬编码绝对路径）
func gatewayExeCandidates() []string {
	return []string{"bin/im-gateway-2008r2.exe", "im-gateway-2008r2.exe"}
}

// gatewayBinSrc 部署包内一个网关二进制（zip 条目名 → 本地源文件）
type gatewayBinSrc struct {
	ZipName string
	Path    string
}

// gatewayBinarySources 包内二进制清单（多平台一次下载，商户按系统选用；缺哪个跳哪个）
var gatewayBinarySources = []struct {
	ZipName    string
	Candidates []string
}{
	// Windows 标准版（Win10/Server2016+；主版本工具链构建）
	{"im-gateway.exe", []string{"bin/im-gateway.exe", "im-gateway.exe"}},
	// Windows 2008R2/2012 兼容版（Go 1.20 工具链构建）
	{"im-gateway-2008r2.exe", gatewayExeCandidates()},
	// Linux amd64 静态版（无扩展名，Linux 上 chmod +x 后直接运行）
	{"im-gateway-linux", []string{"bin/im-gateway-linux", "im-gateway-linux"}},
	// Linux ARM64 静态版（可选，构建了才打包）
	{"im-gateway-linux-arm64", []string{"bin/im-gateway-linux-arm64", "im-gateway-linux-arm64"}},
}

// gatewayCollectSources 归集当前可用的网关二进制（按清单顺序取首个存在的候选）；
// 返回空切片=一个产物都没有（调用方 404）
func gatewayCollectSources() []gatewayBinSrc {
	var out []gatewayBinSrc
	for _, b := range gatewayBinarySources {
		for _, p := range b.Candidates {
			if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
				out = append(out, gatewayBinSrc{ZipName: b.ZipName, Path: p})
				break
			}
		}
	}
	return out
}

// gatewayTemplateYAML gateway.yaml 模板（占位符版；真实密钥由部署者自行填写，
// 服务端任何密钥不经本包下发）。字段必须与网关 normalize 实际认的键一致
// （listen_tcp/allow_targets 为启动必需项；listen: 不是合法键，写了会被忽略）
const gatewayTemplateYAML = `# im-gateway 配置模板（占位符，自行填写后保存为本文件再启动）
# 网关两大用途（可只用其一，详见部署说明与商户后台「使用说明」）：
#   1) 游戏联机加密隧道：listen_tcp 监听 + allow_targets 转发白名单（仅允许转发到本机 127.0.0.1 端口）
#   2) 积分赞助充值写库：dbwrite/recharge（无需手改本文件，启动后在管理后台在线配置）
# token_secret: 两类用途共用的验签密钥（与 im-server 后台「网关地址簿」条目一致，64 位 hex）
listen_tcp: "0.0.0.0:30100"      # 隧道监听端口（联机用；TLS 证书缺省自动生成 gateway.crt/key）
allow_targets: [7777]            # 转发白名单：改成你游戏服务端在本机监听的端口（127.0.0.1），可多个
admin_listen: "127.0.0.1:30101"  # 本机管理后台地址（保持仅内网；需自行新增 admin_password 行才会启动）
token_secret: "请填写64位十六进制密钥_与服务端网关地址簿条目一致"
dbwrite:
  poll_interval: 3s
  games: []                      # 保持为空即可：充值/写库配置在管理后台在线填写并自动写回本文件
`

// gatewayDeployDoc 部署说明（随包下发；详细图文教程见商户后台「使用说明」页）
const gatewayDeployDoc = `im-gateway 部署说明（Windows + Linux 多平台包）
================================================

一、网关三大用途（可只用其一）
  1. 游戏联机加密隧道：玩家 PC 客户端经网关 TLS 加密隧道连到你服务器本机的游戏端口，
     只需配置 listen_tcp 监听与 allow_targets 转发白名单（仅允许 127.0.0.1 目标端口），
     不需要数据库；不用充值时 dbwrite/recharge 保持默认关闭即可。
     安全好处：防火墙只放行网关监听端口这一个端口，游戏服务端端口、数据库端口等
     全部可对公网封闭（游戏服务端绑定 127.0.0.1 最安全）——公网只见一个网关入口，
     且白名单外的一律转发不了，攻击面缩到最小。
  2. 积分赞助充值写库：玩家积分兑换游戏币，网关周期拉取订单并参数化 SQL 写入你的游戏数据库
     （管理后台在线配置，见下文第三步）。
  3. 带参启动免登录进游戏：配合「游戏账号写库」把玩家的 IM 账号与平台专属密码写入游戏库，
     平台按游戏编辑页的启动参数模板（{0}=账号 {1}=专属密码）带参数拉起客户端，
     玩家无需手动输账号密码；前提是游戏客户端支持带账号/密码参数启动。
  token_secret 为隧道与充值共用的验签密钥（网关地址簿条目专属）。

二、包内容与选用
  im-gateway.exe          Windows 标准版（Windows 10 / Server 2016 及以上）
  im-gateway-2008r2.exe   Windows 兼容版（Windows Server 2008 R2 / 2012 专用）
  im-gateway-linux        Linux 版（amd64，静态编译零依赖，chmod +x 后直接运行）
  im-gateway-linux-arm64  Linux ARM 版（如服务器为 ARM 架构则用它）
  gateway.yaml            配置模板（占位符，不含任何密钥）
  按你的服务器系统选用对应程序即可；配置文件两端通用。

三、部署步骤（Windows）
  1. 解压本包至任意目录（如 D:\im-gateway\）。
  2. 编辑 gateway.yaml：token_secret 换成「网关地址簿」分配的专属密钥（64 位 hex）；
     allow_targets 改成你游戏服务端在本机监听的端口（隧道联机用，可多个）；
     自行新增一行 admin_password（本机管理后台登录密码，强密码）。
  3. 运行所选网关程序；防火墙放行 listen_tcp 端口（TLS 证书首次启动自动生成）。
  4. 浏览器打开 http://127.0.0.1:30101 登录管理后台：需要充值写库就在线配置并「保存并热生效」；
     白名单端口也可在后台在线调整（热生效）。
  5. 在 im-server 管理后台「网关地址簿」确认本网关条目地址/指纹正确并启用。

四、部署步骤（Linux）
  1. scp/sftp（二进制方式）上传 im-gateway-linux 至服务器（如 /opt/im-gateway/）。
  2. chmod +x im-gateway-linux；同目录放 gateway.yaml（填法同上）。
  3. ./im-gateway-linux 启动（建议注册 systemd 常驻）；防火墙放行 listen_tcp 端口。
  4. 管理后台仅监听 127.0.0.1：远程用 SSH 隧道访问（ssh -L 30101:127.0.0.1:30101 用户@服务器），
     本机浏览器打开 http://127.0.0.1:30101 在线配置。
  5. 平台侧连通验证同上。

五、安全须知
  1. token_secret 泄露等同于放弃网关鉴权，请妥善保管；疑似泄露立即在服务端
     地址簿中轮换（换后需同步本文件并重启网关）。
  2. 数据库账号使用强密码；网关机仅开放必要端口。
  3. 走隧道时防火墙只需放行网关 listen_tcp 端口（listen_udp 不同号则一并放行），
     游戏服务端端口与数据库端口全部对公网封闭（游戏服务端绑定 127.0.0.1 最安全）。
  4. 管理后台（admin_listen）仅限内网访问，严禁绑定公网。

六、常见问题
  Q: 启动报 allow_targets 白名单不能为空？——模板默认给了 [7777]，改/增删成你游戏
     实际的本机端口即可（必须有至少一个）。
  Q: 启动报端口占用？——修改 listen_tcp 端口后重启。
  Q: 服务端拉取验签失败？——token_secret 与地址簿条目不一致，核对后重启。
  Q: Linux 报 cannot execute binary file？——FTP 文本模式损坏二进制（改用二进制上传）
     或服务器为 ARM 架构（改用 arm64 版）。
  Q: 充值执行失败？——检查写库配置连通性与 SQL 模板（管理后台「测试连接」可验证）。

完整图文教程：商户后台 → 网关部署 → 「使用说明」。
`

// handleMerchantGatewayPackage 网关包下载：首次打包缓存，之后直接下发（ServeContent 支持断点续传）；
// 任一源二进制更新（mtime 归集比对）后自动重建，商户永远拿到最新全平台包
func (s *Server) handleMerchantGatewayPackage(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	sources := gatewayCollectSources()
	if len(sources) == 0 {
		adminFail(w, http.StatusNotFound, "网关包尚未就绪（请联系管理员放置网关构建产物）")
		return
	}
	// 缺产物告警（不打进包也不静默）：提醒管理员补齐对应平台构建，避免商户拿到缺平台版本的包
	if len(sources) < len(gatewayBinarySources) {
		have := map[string]bool{}
		for _, s := range sources {
			have[s.ZipName] = true
		}
		var missing []string
		for _, b := range gatewayBinarySources {
			if !have[b.ZipName] {
				missing = append(missing, b.ZipName)
			}
		}
		logger.Warn("网关部署包缺少部分平台产物（未打进包）：%s——请运行对应 build-gateway*.bat 补齐", strings.Join(missing, ", "))
	}
	zipDir := filepath.Join(s.cfg.Game.LocalDir, "gateway")
	zipPath := filepath.Join(zipDir, "im-gateway.zip")
	// 源二进制任一更新或服务端自身更新（模板/部署说明是随服务端编译的常量，也要跟着重建）
	// 或缓存缺失/损坏时自动重建
	selfExe, _ := os.Executable()
	needBuild := false
	if st, err := os.Stat(zipPath); err != nil || !st.Mode().IsRegular() {
		needBuild = true
	} else {
		for _, src := range sources {
			if st.ModTime().Before(mtimeOf(src.Path)) {
				needBuild = true
				break
			}
		}
		if !needBuild && selfExe != "" && st.ModTime().Before(mtimeOf(selfExe)) {
			needBuild = true
		}
	}
	if needBuild {
		if err := os.MkdirAll(zipDir, os.ModePerm); err != nil {
			adminFail(w, http.StatusInternalServerError, "缓存目录创建失败")
			return
		}
		if err := gatewayZipBuild(zipPath, sources); err != nil {
			logger.Error("网关包打包失败：%v", err)
			adminFail(w, http.StatusInternalServerError, "网关包打包失败")
			return
		}
		logger.Info("网关部署包已生成: %s（含 %d 个平台版本，请求者=%s）", zipPath, len(sources), merchantUserFromCtx(r))
	}
	f, err := os.Open(zipPath)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "网关包读取失败")
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="im-gateway.zip"`)
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	http.ServeContent(w, r, "im-gateway.zip", st.ModTime(), f)
}

// mtimeOf 取文件修改时间（不存在返回零值）
func mtimeOf(p string) time.Time {
	if st, err := os.Stat(p); err == nil {
		return st.ModTime()
	}
	return time.Time{}
}

// gatewayZipBuild 打包多平台二进制 + 无密钥模板 + 说明到 zip（二进制流式拷贝，版本包可达
// 数十 MB 不落额外内存）
func gatewayZipBuild(zipPath string, sources []gatewayBinSrc) error {
	out, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	defer zw.Close()
	// 各平台网关二进制（流式拷贝）
	for _, src := range sources {
		f, err := os.Open(src.Path)
		if err != nil {
			return err
		}
		w, err := zw.Create(src.ZipName)
		if err != nil {
			f.Close()
			return err
		}
		if _, err := io.Copy(w, f); err != nil {
			f.Close()
			return err
		}
		f.Close()
	}
	// gateway.yaml 模板（无密钥）
	if w, err := zw.Create("gateway.yaml"); err != nil {
		return err
	} else if _, err := w.Write([]byte(gatewayTemplateYAML)); err != nil {
		return err
	}
	// 部署说明
	if w, err := zw.Create("部署说明.txt"); err != nil {
		return err
	} else if _, err := w.Write([]byte(gatewayDeployDoc)); err != nil {
		return err
	}
	return nil
}
