// ===== 阶段二百六十：客户端版本管理数据模型（APP/PC 自动更新，服务端归口） =====
// 职责：记录各平台（android=APK / win=PC 安装包）的发布版本，供客户端版本检查接口比对，
//
//	admin 后台上传安装包后落库；安装包本体静态托管于 <WebDir>/static/download/<platform>/，
//	URL 可直接访问（复用服务端静态服务，零新增下载路由）。PC 端 electron-updater 依赖的
//	latest.yml 由上传/启停时按当前生效版本动态生成（见 server/appversion.go writeWinLatestYml）。
package model

import "time"

// AppVersion 客户端发布版本记录（一个平台可存多条历史，enabled 标记当前对外生效版本）
type AppVersion struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Platform string `gorm:"column:platform;type:varchar(16);index;not null" json:"platform"` // android / win
	// VersionName 语义化版本展示名（如 1.2.0）；win 端比对以此为准（semver），electron-updater latest.yml 同用
	VersionName string `gorm:"column:version_name;type:varchar(32);not null" json:"version_name"`
	// VersionCode Android 整型版本号（与 build.gradle versionCode 对应，APP 端比对以此为准）；win 端可留 0
	VersionCode  int       `gorm:"column:version_code;default:0" json:"version_code"`
	FileName     string    `gorm:"column:file_name;type:varchar(255);default:''" json:"file_name"`   // 落盘文件名
	URL          string    `gorm:"column:url;type:varchar(512);default:''" json:"url"`               // 下载相对 URL（/static/download/...）
	Size         int64     `gorm:"column:size;default:0" json:"size"`                                // 文件字节数
	SHA256       string    `gorm:"column:sha256;type:varchar(64);default:''" json:"sha256"`          // 下载完整性校验（APP 端）
	SHA512Base64 string    `gorm:"column:sha512_b64;type:varchar(128);default:''" json:"sha512_b64"` // electron-updater latest.yml 校验（PC 端）
	Notes        string    `gorm:"column:notes;type:varchar(2000);default:''" json:"notes"`          // 更新说明
	Force        bool      `gorm:"column:force;default:false" json:"force"`                          // 强制更新（客户端不更新不可继续使用）
	Enabled      bool      `gorm:"column:enabled;default:true" json:"enabled"`                       // 是否对外生效（下架后检查接口忽略）
	Creator      string    `gorm:"column:creator;type:varchar(64);default:''" json:"creator"`        // 发布管理员
	CreateTime   time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime   time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AppVersion) TableName() string { return "im_app_version" }
