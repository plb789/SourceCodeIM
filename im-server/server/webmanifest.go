package server

// ===== 阶段一百二十二：网页资源清单接口（PC 客户端本地缓存增量更新归口） =====
// PC 客户端改为 app:// 本地协议加载页面后，启动时拉取本清单与服务端 web 目录比对，
// 仅下载差异文件（服务端仍是资源归口，客户端缓存只做加速镜像）。
// 鉴权水位与静态文件同级（无鉴权）：清单只含代码资源相对路径/大小/修改时间，无敏感数据。
// 排除规则：static 整个子树（用户上传/头像/工作区数据 + 数百 MB 工具链 zip，绝不下发）、
// .git 等隐藏目录；仅收常规文件。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
)

// webManifestFile 清单条目：p=斜杠相对路径，s=字节数，t=修改时间（Unix 毫秒）
type webManifestFile struct {
	P string `json:"p"`
	S int64  `json:"s"`
	T int64  `json:"t"`
}

// HandleWebManifest GET /api/web-manifest：遍历 WebDir 生成 {version, files} 清单
// version 为清单规范化 JSON 的 sha256 前 12 位——目录内容不变则 version 稳定，
// 客户端可据此快速判断是否需要增量下载
func (s *Server) HandleWebManifest(w http.ResponseWriter, r *http.Request) {
	files := make([]webManifestFile, 0, 256)
	root := s.cfg.WebDir
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // 单个条目读取失败跳过，不让整个清单 500
		}
		name := d.Name()
		if d.IsDir() {
			// 阶段一百二十二：static 子树整段排除（avatar/upload/_git_extract/工具链 zip 归口用户数据）
			// .git 与隐藏目录同样跳过
			if name == "static" || strings.HasPrefix(name, ".") {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".") {
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		files = append(files, webManifestFile{
			P: filepath.ToSlash(rel),
			S: info.Size(),
			T: info.ModTime().UnixMilli(),
		})
		return nil
	})
	// 排序后参与版本哈希，保证遍历顺序不影响 version 稳定性
	sort.Slice(files, func(i, j int) bool { return files[i].P < files[j].P })

	// 版本号：规范化 JSON 的 sha256 前 12 位（目录内容不变则不变；mustJSON 复用 admin.go 同名归口）
	sum := sha256.Sum256(mustJSON(files))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"version": hex.EncodeToString(sum[:])[:12],
		"files":   files,
	})
}
