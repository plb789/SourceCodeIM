package server

import (
	"encoding/json"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
	"net/http"
	"strings"
	"sync"
)

// 阶段二百七十五：链接域名白名单（后台 admin 配置 → 客户端拉取 → 命中免安全确认直接打开）
//
// 背景：阶段二百七十四起所有外域链接点击均弹自绘安全确认面板。对可信站点（公司官网、
// 常用协作平台等）逐次确认体验繁琐，本模块支持管理员在后台配置通配域名白名单：
//   - `*`                放行一切外域链接（全部不再弹安全确认）
//   - `*.example.com`    放行 example.com 及其任意层级子域（a.example.com / a.b.example.com）
//   - `example.com`      与 *.example.com 同语义（裸域名匹配自身+所有子域）
//   - `www.example.com`  放行 www.example.com 及其子域
//
// 存储与生效策略（与网盘黑名单同模式）：DB 全局 KV 行为真源（重启不丢）+ 内存直更
// （保存即热生效，无需重启）；客户端侧 60s TTL 缓存拉取，管理员保存后全端最迟一个
// 缓存周期生效。刻意不回写 config.yaml（注释会丢，与历史压缩设置同策略）。

// linkWlKind 全局 KV 行类型（model.AgentWhitelist 表 kind 列；username="" 为全局行）
const linkWlKind = "link_whitelist"

// linkWlMaxItems 白名单最大条目数（防滥用配置撑爆缓存与匹配开销）
const linkWlMaxItems = 100

// linkWlMaxLen 单条域名最大长度（DNS 域名规范 253 字符）
const linkWlMaxLen = 253

var (
	linkWlMu   sync.Mutex
	linkWlRaw  string   // 当前生效归一串（逗号分隔）
	linkWlList []string // 解析后的匹配项（小写，*. 前缀已剥平）
	linkWlKnow bool     // 懒初始化标记（首读 DB 后置 true）
)

// linkWlInitLocked 懒初始化：首次访问从 DB 读全局 KV 行（与 driveBlock 同策略）
func linkWlInitLocked() {
	if linkWlKnow {
		return
	}
	linkWlKnow = true
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", linkWlKind, "").First(&row).Error; err == nil {
		linkWlRaw = row.Value
		linkWlList = linkWlParse(linkWlRaw)
	}
}

// linkWlSnapshot 当前生效归一串（admin GET / 公开拉取归口）
func linkWlSnapshot() string {
	linkWlMu.Lock()
	defer linkWlMu.Unlock()
	linkWlInitLocked()
	return linkWlRaw
}

// linkWlSet 保存归口：DB 落库（失败返回错误且内存不更，避免重启回退）+ 内存直更（热生效）
func linkWlSet(norm string) error {
	linkWlMu.Lock()
	defer linkWlMu.Unlock()
	linkWlInitLocked()
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", linkWlKind, "").First(&row).Error; err == nil {
		if err := store.DB.Model(&row).Update("value", norm).Error; err != nil {
			return err
		}
	} else if err := store.DB.Create(&model.AgentWhitelist{Kind: linkWlKind, Value: norm}).Error; err != nil {
		return err
	}
	linkWlRaw = norm
	linkWlList = linkWlParse(norm)
	return nil
}

// linkWlParse 归一串 → 匹配项列表：换行归一为逗号、逐项 trim/小写/去重、剥 *. 前缀
// （*.example.com 与 example.com 统一存为 example.com，匹配时"自身+任意层级子域"同语义）
func linkWlParse(norm string) []string {
	norm = strings.ReplaceAll(norm, "\n", ",")
	seen := make(map[string]bool, 8)
	list := make([]string, 0, 8)
	for _, item := range strings.Split(norm, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		item = strings.TrimPrefix(item, "*.")
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		list = append(list, item)
	}
	return list
}

// linkWlValidate 后台保存校验：支持 `*` 单独一项、`*.` 前缀、裸域名；仅允许域名安全字符集
// （字母数字点横线），逐项限长、去重、总量限制；返回归一串与错误
func linkWlValidate(raw string) (string, error) {
	raw = strings.ReplaceAll(strings.TrimSpace(raw), "\n", ",")
	if raw == "" {
		return "", nil
	}
	seen := make(map[string]bool, 8)
	items := make([]string, 0, 8)
	for _, item := range strings.Split(raw, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if item == "" {
			continue
		}
		// `*` 单独一项=放行一切，合法且去重后仅保留一个
		if item == "*" {
			if !seen["*"] {
				seen["*"] = true
				items = append(items, "*")
			}
			continue
		}
		host := strings.TrimPrefix(item, "*.")
		if host == "" || len(host) > linkWlMaxLen {
			return "", &linkWlErr{msg: "域名长度超限: " + item}
		}
		// 域名字符集校验（字母数字点横线；不允许协议/路径/端口/下划线）
		for _, c := range host {
			if !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '.' || c == '-') {
				return "", &linkWlErr{msg: "域名含非法字符: " + item}
			}
		}
		if strings.HasPrefix(host, "-") || strings.HasPrefix(host, ".") ||
			strings.Contains(host, "..") || strings.HasSuffix(host, "-") || strings.HasSuffix(host, ".") {
			return "", &linkWlErr{msg: "域名格式错误: " + item}
		}
		if !seen[item] {
			seen[item] = true
			items = append(items, item)
		}
	}
	if len(items) > linkWlMaxItems {
		return "", &linkWlErr{msg: "白名单条目过多（上限 100 条）"}
	}
	return strings.Join(items, ","), nil
}

// linkWlErr 白名单校验错误（文案直出 admin 面板）
type linkWlErr struct{ msg string }

func (e *linkWlErr) Error() string { return e.msg }

// linkWlMatched host 是否命中白名单：`*` 放行一切；其余项匹配"项自身或以 .项 结尾的
// 任意层级子域"（解析期已剥 *. 前缀）。host 须为小写 hostname（无端口，url.Hostname() 产出）
func linkWlMatched(host string, list []string) bool {
	if host == "" {
		return false
	}
	for _, item := range list {
		if item == "*" || host == item || strings.HasSuffix(host, "."+item) {
			return true
		}
	}
	return false
}

// handleAdminLinkWhitelistGet GET /admin/api/link/whitelist：当前生效白名单（归一串/是否默认）
func (s *Server) handleAdminLinkWhitelistGet(w http.ResponseWriter, r *http.Request) {
	raw := linkWlSnapshot()
	adminJSON(w, map[string]interface{}{
		"list":       raw,
		"is_default": raw == "",
	})
}

// handleAdminLinkWhitelistSave PUT /admin/api/link/whitelist：保存白名单（空串=清空恢复全确认模式）。
// 保存即热生效 + 落库持久化。请求体 {"list": "*.baidu.com,*.github.com"}
func (s *Server) handleAdminLinkWhitelistSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		List string `json:"list"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	norm, err := linkWlValidate(req.List)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := linkWlSet(norm); err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
		return
	}
	logger.Info("后台管理：管理员 %s 修改链接域名白名单（%s）", adminUserFromCtx(r), func() string {
		if norm == "" {
			return "清空（全部弹安全确认）"
		}
		return norm
	}())
	adminJSON(w, map[string]interface{}{"ok": true, "list": norm})
}

// handleLinkWhitelistPublic GET /api/link/whitelist：用户端公开只读拉取（客户端登录后预热
// 缓存 + 点击时 60s TTL 刷新；命中白名单的链接免安全确认直接打开）
func (s *Server) handleLinkWhitelistPublic(w http.ResponseWriter, r *http.Request) {
	adminJSON(w, map[string]interface{}{"list": linkWlSnapshot()})
}
