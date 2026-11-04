package server

// ===== 商户独立后台·网关部署包下发（商户独立后台开发文档 §3.5，merchantGuard 鉴权） =====
//
// 包内容（拍板 5：所有商户同一通用包）：
//   im-gateway-2008r2.exe —— 服务端构建产物（build-gateway-2008r2.bat → bin/），运行期按候选路径定位
//   gateway.yaml          —— 代码内生成模板（占位符，绝不携带服务端真实 token_secret/网关密钥）
//   部署说明.txt          —— 代码内生成（2008R2/2012 兼容版部署步骤）
// 首次请求打包缓存至 <Game.LocalDir>/gateway/im-gateway-2008r2.zip，源 exe 更新后自动重建。

import (
	"archive/zip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"im-server/logger"
)

// gatewayExeCandidates 2008R2 网关 exe 候选路径（与 config.Load 同款：工作目录 / bin 目录，不硬编码绝对路径）
func gatewayExeCandidates() []string {
	return []string{"bin/im-gateway-2008r2.exe", "im-gateway-2008r2.exe"}
}

// gatewayTemplateYAML gateway.yaml 模板（占位符版；真实密钥由部署者自行填写，
// 服务端任何密钥不经本包下发）
const gatewayTemplateYAML = `# im-gateway 配置模板（占位符，自行填写后保存为本文件再启动）
# listen      : 网关公网监听地址（玩家客户端直连端口）
# admin_listen: 网关本机管理后台地址（仅内网访问）
# token_secret: 与 im-server 后台「网关地址簿」该条目专属密钥一致（64 位 hex，勿用本模板示例值）
# dbwrite     : 积分兑换充值写库配置（按游戏逐条配置，详见部署说明）
listen: "0.0.0.0:30100"
admin_listen: "127.0.0.1:30101"
token_secret: "请填写64位十六进制密钥_与服务端网关地址簿条目一致"
dbwrite:
  poll_interval: 3s
  games: []
`

// gatewayDeployDoc 部署说明（随包下发）
const gatewayDeployDoc = `im-gateway 2008R2 兼容版部署说明
================================

一、适用环境
  Windows Server 2008 R2 / 2012（64 位）；其他新版系统建议使用标准版 im-gateway.exe。

二、部署步骤
  1. 解压本包至任意目录（如 D:\im-gateway\）。
  2. 将 gateway.yaml 中的 token_secret 替换为服务端后台「网关地址簿」为贵司游戏
     分配的专属密钥（64 位十六进制；模板示例值不可直接使用）。
  3. 按贵司游戏的数据库信息填写 dbwrite.games（写库账号请仅授予所需最小权限）。
  4. 双击或命令行运行 im-gateway-2008r2.exe；防火墙放行 listen 端口。
  5. 在 im-server 管理后台「网关地址簿」确认本网关条目地址/指纹正确并启用。

三、安全须知
  1. token_secret 泄露等同于放弃网关鉴权，请妥善保管；疑似泄露立即在服务端
     地址簿中轮换（换后需同步本文件并重启网关）。
  2. 数据库账号使用强密码；网关机仅开放必要端口。
  3. 管理后台（admin_listen）仅限内网访问，严禁绑定公网。

四、常见问题
  Q: 启动报端口占用？——修改 listen 端口后重启。
  Q: 服务端拉取验签失败？——token_secret 与地址簿条目不一致，核对后重启。
  Q: 充值执行失败？——检查 dbwrite 数据源连通性与 SQL 配置。
`

// handleMerchantGatewayPackage 网关包下载：首次打包缓存，之后直接下发（ServeContent 支持断点续传）
func (s *Server) handleMerchantGatewayPackage(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	var exePath string
	for _, p := range gatewayExeCandidates() {
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			exePath = p
			break
		}
	}
	if exePath == "" {
		adminFail(w, http.StatusNotFound, "网关包尚未就绪（请联系管理员放置 im-gateway-2008r2.exe 构建产物）")
		return
	}
	zipDir := filepath.Join(s.cfg.Game.LocalDir, "gateway")
	zipPath := filepath.Join(zipDir, "im-gateway-2008r2.zip")
	// 源 exe 更新（mtime 比对）或缓存缺失/损坏时自动重建
	needBuild := false
	if st, err := os.Stat(zipPath); err != nil || !st.Mode().IsRegular() {
		needBuild = true
	} else if st.ModTime().Before(mtimeOf(exePath)) {
		needBuild = true
	}
	if needBuild {
		if err := os.MkdirAll(zipDir, os.ModePerm); err != nil {
			adminFail(w, http.StatusInternalServerError, "缓存目录创建失败")
			return
		}
		if err := gatewayZipBuild(zipPath, exePath); err != nil {
			logger.Error("网关包打包失败：%v", err)
			adminFail(w, http.StatusInternalServerError, "网关包打包失败")
			return
		}
		logger.Info("网关部署包已生成: %s（请求者=%s）", zipPath, merchantUserFromCtx(r))
	}
	f, err := os.Open(zipPath)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "网关包读取失败")
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="im-gateway-2008r2.zip"`)
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	http.ServeContent(w, r, "im-gateway-2008r2.zip", st.ModTime(), f)
}

// mtimeOf 取文件修改时间（不存在返回零值）
func mtimeOf(p string) time.Time {
	if st, err := os.Stat(p); err == nil {
		return st.ModTime()
	}
	return time.Time{}
}

// gatewayZipBuild 打包三文件到 zip（exe + 无密钥模板 + 说明）
func gatewayZipBuild(zipPath, exePath string) error {
	out, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	defer zw.Close()
	// exe（流式拷贝，版本包可达数十 MB 不落额外内存）
	src, err := os.Open(exePath)
	if err != nil {
		return err
	}
	defer src.Close()
	w, err := zw.Create("im-gateway-2008r2.exe")
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, src); err != nil {
		return err
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
