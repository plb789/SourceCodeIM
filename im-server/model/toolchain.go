// ===== 阶段一百二十一：Agent 编译工具链市场清单数据模型（独立页级市场，与 MCP 插件市场解耦） =====
// 职责：工具链市场条目 ORM——一次性下载解压即用的编译环境（非长驻 MCP 服务器），
//
//	与 MCPPlugin 最大区别：无 command/args/env，核心是 zip 资源地址 + SHA256 + 安装目标目录，
//	安装即下载→校验→解压到 ~/.im-mcp/<install_dir>，Agent 任务 run_command 通过 PATH 前置即可调用编译器。
//	前端设置页独立 [工具链] 页签展示；admin 后台 → 工具链市场 CRUD 维护。
package model

import "time"

// Toolchain Agent 编译工具链市场条目（一次性下载解压即可用，区别于长驻 MCP 插件）
type Toolchain struct {
	ID          uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Name        string `gorm:"column:name;type:varchar(64);uniqueIndex;not null" json:"name"` // 唯一标识（安装目标目录名，~/.im-mcp/<name>）
	Title       string `gorm:"column:title;type:varchar(128);default:''" json:"title"`        // 展示标题
	Description string `gorm:"column:description;type:varchar(512);default:''" json:"description"`
	Category    string `gorm:"column:category;type:varchar(32);default:''" json:"category"` // 分类页签（编译工具链/调试器…）
	Version     string `gorm:"column:version;type:varchar(64);default:''" json:"version"`   // 版本号（卡片展示用）
	// ZipURL 下载地址：相对路径（static/gcc-toolchain.zip，拼服务端 base）或完整 http/https（外置 CDN/镜像）。
	// 留空时客户端默认取 <SERVER_URL>static/<name>.zip——服务端静态托管归口，零新增硬编码
	ZipURL string `gorm:"column:zip_url;type:varchar(512);default:''" json:"zip_url"`
	// SHA256 解压前强校验（防下载损坏/被替换；重打 zip 包时同步更新此值与 toolchain-manager.js 内置常量）
	SHA256 string `gorm:"column:sha256;type:varchar(64);default:''" json:"sha256"`
	SizeMB int    `gorm:"column:size_mb;default:0" json:"size_mb"` // 下载体积（MB，卡片体积感知提示）
	// InstallDir 安装目标目录（相对 ~/.im-mcp，如 gcc；留空默认取 name）。当前仅 gcc 通道，
	// 字段预留给将来多工具链（clang/musl/android-ndk…）各自独立目录
	InstallDir string `gorm:"column:install_dir;type:varchar(64);default:''" json:"install_dir"`
	// SubCommands 子命令路由/引导器声明（JSON：{"zig":"gcc -target x86_64-windows","rustc":"rustup"}）。
	//   轻量实现：一个 zip 支持多工具链入口——如 zig 不单独打包，安装 gcc 后 zig cc 子命令路由到 gcc；
	//   rustc 声明 rustup 表示走在线 rustup 引导器（非 zip，ensureCompiler 时下载 rustup-init.exe 执行）。
	//   留空表示常规 zip 安装；当前用于 zig/rust 轻量通道验证多工具链并存机制
	SubCommands string `gorm:"column:sub_commands;type:varchar(512);default:''" json:"sub_commands"`
	// InstallerScript 自定义 JS 安装脚本（async function(ctx)，服务端下发，客户端 vm.runInNewContext 沙箱执行）。
	//   留空走默认 zip 解压通道；非 zip 安装（如 rustup-init.exe）用脚本解耦——admin 零代码发布新工具链安装逻辑。
	//   ctx 提供：url/destDir/sha256/fs/path/os/http/https/spawn/download/logger。沙箱超时 10 分钟防死循环
	InstallerScript string `gorm:"column:installer_script;type:text" json:"installer_script"`
	// ExePaths 可执行文件相对路径（JSON 数组，相对 install_dir）：如 ["bin/go.exe","bin/gofmt.exe"]。
	//   客户端 PATH 前置按此定位（而非盲扫 bin 目录）；支持 "~/" 前缀指向用户目录（如 rust 的 "~/.cargo/bin/rustc.exe"）。
	//   留空时客户端回退默认探测（bin/<name>.exe、bin/、cmd/ 等）
	ExePaths   string    `gorm:"column:exe_paths;type:varchar(512);default:''" json:"exe_paths"`
	Icon       string    `gorm:"column:icon;type:varchar(512);default:''" json:"icon"` // 图标链接（http/https，留空降级首字母徽标）
	Sort       int       `gorm:"column:sort;default:0" json:"sort"`                    // 展示排序（小在前）
	Enabled    bool      `gorm:"column:enabled;default:true" json:"enabled"`           // 上架状态（下架后用户端不显示）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (Toolchain) TableName() string { return "im_toolchain" }
