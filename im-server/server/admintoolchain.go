// ===== 阶段一百二十一：Agent 编译工具链市场管理（独立页级市场，服务端归口） =====
// 职责：
//  1. 清单表懒迁移 + 空表自动播种内置默认工具链（w64devkit 裁剪版 gcc，admin 可改可删可增）
//  2. admin CRUD：/admin/api/toolchains（adminGuard 归口，路由注册见 admin.go）
//  3. 用户端公开只读拉取：GET /api/toolchains（仅上架条目；清单为公开目录数据无敏感凭据）
//
// 与 MCP 插件市场（admintoolchain.go 上邻）最大区别：工具链非长驻 MCP 服务器，
//
//	无 command/args/env——核心是 zip 资源 + SHA256 + 安装目录；安装=下载→校验→解压到 ~/.im-mcp/<install_dir>。
//	PC 端设置页独立 [工具链] 页签展示卡片，点击安装走 toolchain-manager.installFromMarket（复用三通道下载）
package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// toolchainSeedOnce 播种只执行一次（并发请求下防重复播种）
var toolchainSeedOnce sync.Once

// toolchainEnsure 懒迁移 + 空表播种（首次访问工具链接口时执行，与 mcpPluginEnsure 同款模式）
func toolchainEnsure() {
	toolchainSeedOnce.Do(func() {
		if err := store.DB.AutoMigrate(&model.Toolchain{}); err != nil {
			logger.Error("工具链表迁移失败: %v", err)
			return
		}
		var count int64
		if err := store.DB.Model(&model.Toolchain{}).Count(&count).Error; err != nil {
			return // 查询失败不播种
		}
		if count == 0 {
			// 空表：全量播种内置工具链
			for i := range toolchainDefaults {
				rec := toolchainDefaults[i]
				if err := store.DB.Create(&rec).Error; err != nil {
					logger.Error("播种内置工具链 %s 失败: %v", rec.Name, err)
				}
			}
			logger.Info("内置工具链播种完成：共 %d 个（后台管理 → 工具链市场 可维护）", len(toolchainDefaults))
			return
		}
		// 非空表：按 name 补种缺失条目（幂等，不覆盖已有——老库升级时 clang/zig/java/rust/go/git 自动补齐）
		var existing []model.Toolchain
		if err := store.DB.Select("name").Find(&existing).Error; err != nil {
			return
		}
		existMap := make(map[string]bool, len(existing))
		for _, e := range existing {
			existMap[e.Name] = true
		}
		added := 0
		updated := 0
		for i := range toolchainDefaults {
			rec := toolchainDefaults[i]
			if existMap[rec.Name] {
				// 阶段一百二十一：已存在条目同步"服务端真相字段"（安装通道/脚本/声明/安装目录变更自动升级，
				//   如 zig 由 gcc 复用改为真 zip、install_dir gcc→zig），管理员手改的展示字段（title/category/icon/sort/enabled）不覆盖。
				//   注意 sha256/size_mb/install_dir 必须同步——否则老库用旧校验值验新包必失败、ExePaths 声明键与实际解压目录错位
				var old model.Toolchain
				if err := store.DB.Where("name = ?", rec.Name).First(&old).Error; err == nil {
					if old.InstallerScript != rec.InstallerScript || old.ZipURL != rec.ZipURL || old.ExePaths != rec.ExePaths ||
						old.SubCommands != rec.SubCommands || old.SHA256 != rec.SHA256 || old.SizeMB != rec.SizeMB ||
						old.Version != rec.Version || old.Description != rec.Description || old.InstallDir != rec.InstallDir {
						if err := store.DB.Model(&model.Toolchain{}).Where("name = ?", rec.Name).Updates(map[string]interface{}{
							"installer_script": rec.InstallerScript,
							"zip_url":          rec.ZipURL,
							"exe_paths":        rec.ExePaths,
							"sub_commands":     rec.SubCommands,
							"sha256":           rec.SHA256,
							"size_mb":          rec.SizeMB,
							"version":          rec.Version,
							"description":      rec.Description,
							"install_dir":      rec.InstallDir,
						}).Error; err != nil {
							logger.Error("同步内置工具链 %s 升级字段失败: %v", rec.Name, err)
						} else {
							updated++
						}
					}
				}
				continue
			}
			if err := store.DB.Create(&rec).Error; err != nil {
				logger.Error("补种内置工具链 %s 失败: %v", rec.Name, err)
			} else {
				added++
			}
		}
		if added > 0 || updated > 0 {
			logger.Info("内置工具链补种完成：新增 %d 个，脚本更新 %d 个（共 %d 个内置）", added, updated, len(toolchainDefaults))
		}
	})
}

// toolchainDefaults 内置默认工具链（gcc 全量 + clang/zig/Java/Rust 轻量实现；Android 本次不做）。
// 轻量实现：zig 不单独打包，SubCommands 声明 zig cc 子命令路由到 gcc（复用 gcc zip，避免重复下载 300MB）；
//
//	rustc 声明 rustup 走在线 rustup 引导器（非 zip，ensureCompiler 时下载 rustup-init.exe 执行）；
//	Java 复用系统已装 JDK（四级探测归口）；clang 与 gcc 同套件（w64devkit 的 gcc 内置 clang 能力，SubCommands 占位）。
var toolchainDefaults = []model.Toolchain{
	{
		Name:        "gcc",
		Title:       "C/C++ 编译工具链",
		Category:    "编译工具链",
		Version:     "16.2.0",
		Description: "为 Agent 提供 C/C++ 编译能力（gcc/g++/make/gdb/ccache，w64devkit 裁剪版）。系统已装 MSVC/gcc 时优先使用系统编译器，本工具链为兜底；下载约 89MB，解压后约 358MB，安装后 Agent 任务可直接调用编译命令。",
		// 相对路径：客户端拼服务端 base 得完整下载 URL（<SERVER_URL>static/gcc-toolchain.zip，静态托管归口零硬编码）
		ZipURL:     "static/gcc-toolchain.zip",
		SHA256:     "24D791013B375E02D7B4725BC2566AB91ED0F877570CB69BC2F57F847BBD271A",
		SizeMB:     89,
		InstallDir: "gcc",
		ExePaths:   `["bin/gcc.exe","bin/g++.exe","bin/make.exe","bin/gdb.exe","bin/ccache.exe"]`,
		Sort:       10,
		Enabled:    true,
	},
	{
		Name:        "clang",
		Title:       "Clang/LLVM 编译工具链",
		Category:    "编译工具链",
		Version:     "system",
		Description: "Clang/LLVM C/C++ 编译能力。优先使用系统已装 clang（LLVM/Visual Studio 均自带）；系统未装时可用内置 gcc 完成同等编译，或自行安装 LLVM。",
		ZipURL:      "", // 系统优先，无内置 zip（真包体积过大，不内置）
		SHA256:      "",
		SizeMB:      0,
		InstallDir:  "clang",
		ExePaths:    "",
		Sort:        20,
		Enabled:     true,
	},
	{
		Name:        "zig",
		Title:       "Zig 编译工具链",
		Category:    "编译工具链",
		Version:     "0.16.0",
		Description: "Zig 编译器（zig build/zig run/zig cc，含 C 交叉编译能力）。官方 windows-x86_64 便携包（约 93MB，解压后约 300MB），解压即用；系统已装 Zig 时优先使用系统版本。",
		ZipURL:      "static/zig-toolchain.zip",
		SHA256:      "68659EB5F1E4EB1437A722F1DD889C5A322C9954607F5EDCF337BC3684A75A7E",
		SizeMB:      93,
		InstallDir:  "zig",
		ExePaths:    `["zig-x86_64-windows-0.16.0/zig.exe"]`, // 官方 zip 解压含一层版本目录，exe 在其根
		Sort:        30,
		Enabled:     true,
	},
	{
		Name:        "java",
		Title:       "Java (JDK)",
		Category:    "语言运行时",
		Version:     "system",
		Description: "Java 编译运行能力。优先使用系统已装 JDK（四级探测归口）；系统未装时提示用户安装。",
		ZipURL:      "", // 系统优先，无内置 zip
		SHA256:      "",
		SizeMB:      0,
		InstallDir:  "java",
		SubCommands: `{"java":"system"}`,
		ExePaths:    `["bin/javac.exe","bin/java.exe"]`,
		Sort:        40,
		Enabled:     true,
	},
	{
		Name:        "rust",
		Title:       "Rust 编译工具链",
		Category:    "编译工具链",
		Version:     "1.80.0",
		Description: "Rust 编译器（rustc/cargo）。走在线 rustup 引导器：首次使用自动下载 rustup-init.exe（约 8MB）并静默安装到 ~/.cargo，需联网。",
		ZipURL:      "https://sh.rustup.rs/rustup-init.exe", // 在线 rustup 引导器，非 zip
		SHA256:      "",
		SizeMB:      8,
		InstallDir:  "rust",
		SubCommands: `{"rustc":"rustup"}`,
		// 按声明定位：rustup 实际装到 ~/.cargo（"~/" 前缀指向用户目录，非 install_dir）；
		// 客户端另有 ~/.cargo/bin 外部目录探测兜底，双保险
		ExePaths: `["~/.cargo/bin/rustc.exe","~/.cargo/bin/cargo.exe"]`,
		// 阶段一百二十一：Rust 脚本化安装示例——admin 零代码发布，客户端 vm 沙箱执行
		InstallerScript: `module.exports = async function(ctx) {
    const tmpExe = ctx.path.join(ctx.os.tmpdir(), 'rustup-init.exe');
    await ctx.download(ctx.url, tmpExe);
    await ctx.spawn(tmpExe, ['-y', '--default-toolchain', 'stable', '--profile', 'minimal']);
    const rustc = ctx.path.join(ctx.os.homedir(), '.cargo', 'bin', 'rustc.exe');
    return { ok: ctx.fs.existsSync(rustc), msg: ctx.fs.existsSync(rustc) ? 'Rust 已装到 ~/.cargo' : 'rustup 执行后未找到 rustc.exe' };
}`,
		Sort:    50,
		Enabled: true,
	},
	{
		Name:        "go",
		Title:       "Go 编译工具链",
		Category:    "编译工具链",
		Version:     "1.26.3",
		Description: "Go 编译器（go build/go run）。便携版从 go1.26.3.windows-amd64.msi 官方 MSI 提取（约 57MB，解压后约 63MB）；系统已装 Go 时优先使用系统版本。",
		ZipURL:      "static/go-toolchain.zip",
		SHA256:      "62B92A2C16FB18427BB67119E0D2B2577CFF06F800DE17712035D02D8EC4BED6",
		SizeMB:      57,
		InstallDir:  "go",
		SubCommands: `{"go":"zip"}`,
		ExePaths:    `["bin/go.exe","bin/gofmt.exe"]`,
		Sort:        60,
		Enabled:     true,
	},
	{
		Name:        "git",
		Title:       "Git 版本控制",
		Category:    "开发工具",
		Version:     "2.54.0",
		Description: "Git 版本控制（clone/commit/push/pull）。便携版打包自本机 C:\\Program Files\\Git（约 159MB，解压后约 299MB，含完整 mingw64 工具链）；系统已装 Git 时优先使用系统版本。",
		ZipURL:      "static/git-toolchain.zip",
		SHA256:      "AD1A9A1F95D359111F500FF9E738DC836FA9EF09641F62223D94B88B34764461",
		SizeMB:      159,
		InstallDir:  "git",
		SubCommands: `{"git":"zip"}`,
		ExePaths:    `["bin/git.exe","cmd/git.exe"]`,
		Sort:        70,
		Enabled:     true,
	},
}

// adminToolchainReq 工具链编辑请求体（字段与 model 一致）
type adminToolchainReq struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Version     string `json:"version"`
	ZipURL      string `json:"zip_url"`
	SHA256      string `json:"sha256"`
	SizeMB      int    `json:"size_mb"`
	InstallDir  string `json:"install_dir"`
	SubCommands string `json:"sub_commands"` // 阶段一百二十一：子命令路由/引导器声明（JSON，轻量实现多工具链并存）
	// 阶段一百二十一：自定义 JS 安装脚本（async function(ctx)，服务端下发，客户端 vm 沙箱执行；留空走默认 zip 解压）
	InstallerScript string `json:"installer_script"`
	// 阶段一百二十一：ExePaths 可执行文件声明（JSON 数组，相对 install_dir，支持 "~/" 前缀指向用户目录）。
	//   客户端 PATH 前置按此声明定位（按声明定位方案），留空回退客户端内置默认探测
	ExePaths string `json:"exe_paths"`
	Icon     string `json:"icon"`
	Sort     int    `json:"sort"`
	Enabled  bool   `json:"enabled"`
}

// toolchainValidate 编辑请求校验归口（新增与编辑共用；name 唯一性由 DB uniqueIndex 兜底）
func toolchainValidate(req *adminToolchainReq) string {
	req.Name = strings.TrimSpace(req.Name)
	req.Title = strings.TrimSpace(req.Title)
	req.Category = strings.TrimSpace(req.Category)
	req.Version = strings.TrimSpace(req.Version)
	req.ZipURL = strings.TrimSpace(req.ZipURL)
	req.SHA256 = strings.TrimSpace(req.SHA256)
	req.InstallDir = strings.TrimSpace(req.InstallDir)
	if req.Name == "" {
		return "工具链名不能为空（安装目标目录 ~/.im-mcp/<name>，仅限字母数字下划线连字符）"
	}
	if len(req.Name) > 64 {
		return "工具链名过长（≤64 字符）"
	}
	if req.Title == "" {
		return "展示标题不能为空"
	}
	if req.InstallDir == "" {
		req.InstallDir = req.Name // 安装目录缺省取 name（~/.im-mcp/<name>）
	}
	if len(req.Description) > 512 {
		return "描述过长（≤512 字符）"
	}
	// ZipURL：留空（客户端默认 <base>static/<name>.zip）、相对路径（拼 base）、完整 http/https 均可
	if req.ZipURL != "" && !strings.HasPrefix(req.ZipURL, "http://") && !strings.HasPrefix(req.ZipURL, "https://") && strings.HasPrefix(req.ZipURL, "/") {
		return "Zip 地址请填相对路径（如 static/gcc.zip，拼服务端 base）或完整 http/https 链接"
	}
	if req.ZipURL != "" && !strings.HasPrefix(req.ZipURL, "http://") && !strings.HasPrefix(req.ZipURL, "https://") && !strings.Contains(req.ZipURL, "/") {
		return "相对 Zip 地址需含目录层级（如 static/gcc.zip）"
	}
	if req.ZipURL != "" && len(req.ZipURL) > 512 {
		return "Zip 地址过长（≤512 字符）"
	}
	// SHA256：64 位十六进制（留空则客户端跳过校验，不推荐——防下载损坏/被替换靠它兜底）
	if req.SHA256 != "" && !isHex64(req.SHA256) {
		return "SHA256 须为 64 位十六进制（留空则不校验，不推荐）"
	}
	req.Icon = strings.TrimSpace(req.Icon)
	if req.Icon != "" && !strings.HasPrefix(req.Icon, "http://") && !strings.HasPrefix(req.Icon, "https://") {
		return "图标链接必须以 http:// 或 https:// 开头（留空则显示首字母徽标）"
	}
	if len(req.Icon) > 512 {
		return "图标链接过长（≤512 字符）"
	}
	// 阶段一百二十一：ExePaths 须为 JSON 字符串数组（相对 install_dir；支持 "~/" 前缀绝对路径），留空回退客户端默认探测
	req.ExePaths = strings.TrimSpace(req.ExePaths)
	if req.ExePaths != "" {
		if len(req.ExePaths) > 512 {
			return "ExePaths 过长（≤512 字符）"
		}
		var arr []string
		if err := json.Unmarshal([]byte(req.ExePaths), &arr); err != nil {
			return "ExePaths 须为 JSON 字符串数组（如 [\"bin/go.exe\",\"bin/gofmt.exe\"]）"
		}
	}
	return ""
}

// isHex64 判定 64 位十六进制串（SHA256 格式）
func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// handleAdminToolchainList 后台工具链清单（含未上架条目，编辑需要）
func (s *Server) handleAdminToolchainList(w http.ResponseWriter, r *http.Request) {
	toolchainEnsure()
	var list []model.Toolchain
	if err := store.DB.Order("sort ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询工具链清单失败")
		return
	}
	adminJSON(w, map[string]interface{}{"toolchains": list})
}

// handleAdminToolchainCreate 新增工具链
func (s *Server) handleAdminToolchainCreate(w http.ResponseWriter, r *http.Request) {
	toolchainEnsure()
	var req adminToolchainReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if msg := toolchainValidate(&req); msg != "" {
		adminFail(w, http.StatusBadRequest, msg)
		return
	}
	var dup int64
	store.DB.Model(&model.Toolchain{}).Where("name = ?", req.Name).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusConflict, "工具链名已存在："+req.Name)
		return
	}
	rec := model.Toolchain{
		Name: req.Name, Title: req.Title, Description: req.Description, Category: req.Category,
		Version: req.Version, ZipURL: req.ZipURL, SHA256: req.SHA256, SizeMB: req.SizeMB,
		InstallDir: req.InstallDir, SubCommands: req.SubCommands, InstallerScript: req.InstallerScript, ExePaths: req.ExePaths, Icon: req.Icon, Sort: req.Sort, Enabled: req.Enabled,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("新增工具链 %s 失败: %v", rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "新增工具链失败（名称可能重复）")
		return
	}
	logger.Info("后台管理：新增工具链 %s（%s）", rec.Name, rec.Version)
	adminJSON(w, map[string]interface{}{"id": rec.ID})
}

// handleAdminToolchainUpdate 编辑工具链
func (s *Server) handleAdminToolchainUpdate(w http.ResponseWriter, r *http.Request) {
	toolchainEnsure()
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.Toolchain
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "工具链不存在")
		return
	}
	var req adminToolchainReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if msg := toolchainValidate(&req); msg != "" {
		adminFail(w, http.StatusBadRequest, msg)
		return
	}
	var dup int64
	store.DB.Model(&model.Toolchain{}).Where("name = ? AND id <> ?", req.Name, rec.ID).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusConflict, "工具链名已存在")
		return
	}
	rec.Name, rec.Title, rec.Description, rec.Category = req.Name, req.Title, req.Description, req.Category
	rec.Version, rec.ZipURL, rec.SHA256, rec.SizeMB = req.Version, req.ZipURL, req.SHA256, req.SizeMB
	rec.InstallDir, rec.SubCommands, rec.InstallerScript, rec.ExePaths, rec.Icon, rec.Sort, rec.Enabled = req.InstallDir, req.SubCommands, req.InstallerScript, req.ExePaths, req.Icon, req.Sort, req.Enabled
	if err := store.DB.Save(&rec).Error; err != nil {
		logger.Error("编辑工具链 %s 失败: %v", rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "保存工具链失败")
		return
	}
	logger.Info("后台管理：编辑工具链 %s", rec.Name)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminToolchainDelete 删除工具链（仅删清单条目，不影响用户本机已安装的 ~/.im-mcp/<name> 目录）
func (s *Server) handleAdminToolchainDelete(w http.ResponseWriter, r *http.Request) {
	toolchainEnsure()
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.Toolchain
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "工具链不存在")
		return
	}
	if err := store.DB.Delete(&rec).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除工具链失败")
		return
	}
	logger.Info("后台管理：删除工具链 %s", rec.Name)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleToolchainPublicList 用户端公开只读拉取（仅上架条目；清单为公开目录数据，不含凭据）
func (s *Server) handleToolchainPublicList(w http.ResponseWriter, r *http.Request) {
	toolchainEnsure()
	var list []model.Toolchain
	if err := store.DB.Where("enabled = ?", true).Order("sort ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询工具链清单失败")
		return
	}
	adminJSON(w, map[string]interface{}{"toolchains": list})
}
