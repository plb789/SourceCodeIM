package server

// ===== 阶段一百三十六：前端资源密文下发接口（PC 端磁盘零明文归口） =====
// PC 客户端启用加密链路后，静态资源不再走明文静态服务下载，改由本接口按 AES-256-GCM
// 密文下发（容器：IMEF1 魔数 5B + IV 12B + 密文+认证标签 16B），客户端本地只落密文，
// 进程内存解密后响应页面——安装目录（asar 内加密 blob）、userData（.enc 缓存）、网络抓包
// 三条通道均无明文。WEB 浏览器端无解密能力，明文静态服务保持不变（双通道并存）。
// 鉴权水位与 /api/web-manifest 同级（无鉴权）：接口只回密文，密钥不参与传输，
// 无密钥的抓包方拿到的仅是不可解密的随机字节，密文本身即屏障。
// 排除规则与清单一致：static 子树（用户数据/工具链）、隐藏文件、zip 一律 404。

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// secureContainerMagic 密文容器魔数（客户端按该格式解析，便于磁盘审计与格式升级）
const secureContainerMagic = "IMEF1"

// secureSeal 将明文封装为密文容器：magic(5) + iv(12) + GCM sealed(密文||tag16)
func secureSeal(plain []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, gcm.NonceSize()) // 12 字节随机数，每文件每次加密独立生成
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, iv, plain, nil)
	out := make([]byte, 0, len(secureContainerMagic)+len(iv)+len(sealed))
	out = append(out, secureContainerMagic...)
	out = append(out, iv...)
	return append(out, sealed...), nil
}

// secureKeyBytes 解析配置中的 64 位 hex 密钥，非法/未配置返回 nil（调用方按停用处理）
func (s *Server) secureKeyBytes() []byte {
	k := strings.TrimSpace(s.cfg.SecureFileKey)
	if len(k) != 64 {
		return nil
	}
	b, err := hex.DecodeString(k)
	if err != nil || len(b) != 32 {
		return nil
	}
	return b
}

// HandleSecureFile GET /api/secure-file?path=相对路径：读取 WebDir 内文件并密文下发
func (s *Server) HandleSecureFile(w http.ResponseWriter, r *http.Request) {
	// 密钥未配置：明确停用（客户端感知 503 后自动回退明文链路，不阻塞启动）
	key := s.secureKeyBytes()
	if key == nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "密文接口未配置密钥"})
		return
	}

	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	// 路径合法性：拒绝空路径/反斜杠/绝对路径/含 .. 段；Clean 后必须与原值一致（防 %2e%2e 等编码绕过）
	if rel == "" || strings.Contains(rel, "\\") || strings.HasPrefix(rel, "/") || path.Clean(rel) != rel {
		http.NotFound(w, r)
		return
	}
	// 排除规则与清单归口一致：static 子树（用户数据+工具链）、隐藏文件、zip 绝不下发
	for _, seg := range strings.Split(rel, "/") {
		if seg == "static" || strings.HasPrefix(seg, ".") {
			http.NotFound(w, r)
			return
		}
	}
	if strings.HasSuffix(rel, ".zip") {
		http.NotFound(w, r)
		return
	}
	fp := filepath.Join(s.cfg.WebDir, filepath.FromSlash(rel))
	// 越界二防：解析结果必须仍位于 WebDir 内
	rootAbs, _ := filepath.Abs(s.cfg.WebDir)
	fpAbs, _ := filepath.Abs(fp)
	if fpAbs != rootAbs && !strings.HasPrefix(fpAbs, rootAbs+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}

	// 整文件读取后加密（静态代码资源最大数 MB 级；32MB 护栏防异常超大请求拖垮内存）
	data, err := os.ReadFile(fp)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if len(data) > 32<<20 {
		http.Error(w, "文件过大", http.StatusRequestEntityTooLarge)
		return
	}
	out, err := secureSeal(data, key)
	if err != nil {
		http.Error(w, "加密失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(out)))
	_, _ = w.Write(out)
}
