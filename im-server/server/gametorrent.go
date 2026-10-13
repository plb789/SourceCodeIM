package server

// 方案 A 一期：BT/P2SP 混合下载服务端归口。
// 下载方式字段（game.download_method）由 admin 归口（gameadmin.go），本文件只做种子链路：
//   GET /api/game/torrent/{id}?username=&version=
//     → 与 manifest 同水位鉴权（库归属校验）→ 版本文件清单 → 多文件 .torrent 生成（磁盘缓存）→ 下发。
// 种子规范对齐客户端安装布局：info.name = slug（安装锚点名），files 路径 = 版本内 rel_path，
// 配合 DLBT_Downloader_Initialize(rootPathName=slug) 落盘为 <installDir>/<slug>/<rel_path>。
// 一期无 tracker 依赖：announce 留空，peer 发现走公网 DHT（引擎 DLBT_DHT_Start），速度保底走
// P2SP——同一任务叠加 /api/game/file/{fid} HTTP 直链源（DLBT_Downloader_AddHttpDownload）。
// 缓存：LocalDir/torrents/<slug>-<manifestHash 前 16 位>.torrent，版本文件变化 → 清单哈希变化
// → 缓存名变化自动失效重建。

import (
	"crypto/sha1"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"im-server/model"
	"im-server/store"
)

// —— bencode 最小编码器（种子生成专用，无需通用解析） ——

// bencodeStr 编码字符串/字节串：len + ":" + bytes
func bencodeStr(s string) []byte {
	return []byte(strconv.Itoa(len(s)) + ":" + s)
}

// bencodeBytes 同 bencodeStr（二进制段语义显式化：pieces 哈希串）
func bencodeBytes(b []byte) []byte {
	return bencodeStr(string(b))
}

// bencodeMark bencode 结构标记（d/l/e 等控制符必须裸字节输出，严禁走 bencodeStr——
// 那会编码成 "1:d" 破坏整个字典结构，E2E 实测曾抓到此 bug）
func bencodeMark(m string) []byte { return []byte(m) }

// bencodeInt 整数：i<dec>e
func bencodeInt(v int64) []byte {
	return []byte("i" + strconv.FormatInt(v, 10) + "e")
}

// bencodeConcat 按序拼接（list/dict 值序列拼接即编码）
func bencodeConcat(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// torrentEscPrefix 种子内转义文件名前缀：DLBT 引擎创建落盘文件时把种子内文件名字节按系统
// ANSI 代码页（中文系统=GBK）解释而非 UTF-8（实测：UTF-8 的"快捷方式"落盘成"蹇嵎鏂瑰紡"，
// 内容/校验/速度均正常仅名字 mojibake，且引擎无编码设置口）。故种子内含非 ASCII 的 rel 一律
// 转义为纯 ASCII 安全名，使引擎完全不依赖系统区域设置；P2SP 端点按同规则反查，客户端完成后
// 按清单 rename 回真实 rel_path。
const torrentEscPrefix = "__x__"

// torrentEscName rel_path 转义名（归口）：含非 ASCII 字节 → "__x__"+sha1(utf8(rel)) 前 16 hex
// （纯 ASCII 保持原样返回空串，调用方走原 path 分段）；无斜杠、Windows 文件名合法、长度恒定
func torrentEscName(rel string) string {
	esc := false
	for i := 0; i < len(rel); i++ {
		if rel[i] > 0x7F {
			esc = true
			break
		}
	}
	if !esc {
		return ""
	}
	sum := sha1.Sum([]byte(rel))
	return torrentEscPrefix + hex.EncodeToString(sum[:8])
}

// torrentFileItem 种子内单文件项（rel_path 以 / 分隔，size 字节）
type torrentFileItem struct {
	relPath string
	size    int64
}

// gameTorrentBuild 生成多文件种子 bytes。
// baseDir = 版本目录根（LocalDir/games/<slug>/<version>），items 按 rel_path 升序（清单同序直传）。
// info.name 固定 slug；piece 长度 1MiB，总大小 >1GiB 自动升 4MiB（控 piece 数量防种子过大）。
// trackers = 全局 BT Tracker 地址（config game.trackers，见下方 root 组装注释）
func gameTorrentBuild(slug string, items []torrentFileItem, baseDir string, trackers []string) ([]byte, error) {
	if len(items) == 0 {
		return nil, errGame("版本文件清单为空")
	}
	var total int64
	for _, it := range items {
		total += it.size
	}
	pieceLen := int64(1 << 20) // 1MiB
	if total > 1<<30 {         // >1GiB → 4MiB
		pieceLen = 4 << 20
	}

	// 分片哈希：文件按序连续拼流，跨文件边界的 piece 合并哈希（BitTorrent 多文件规范）。
	// 逐块喂 hasher（64KiB），满一片出哈希并重置——任意大版本内存占用恒定。
	// 注意消费指针必须推进（p = p[take:]）：单次 Read 跨 piece 边界时若重复从 buf[0] 写，
	// 哈希错位且引擎逐分片校验永失败（E2E 实测：表现为 HTTP 流量正常但进度卡死无限重下）
	pieces := make([]byte, 0, (total/pieceLen+2)*sha1.Size)
	hasher := sha1.New()
	buf := make([]byte, 64*1024)
	var inPiece int64
	for _, it := range items {
		if it.size <= 0 {
			continue
		}
		fp, err := os.Open(filepath.Join(baseDir, filepath.FromSlash(it.relPath)))
		if err != nil {
			return nil, errGame("版本文件缺失，无法生成种子: " + it.relPath)
		}
		var read int64
		for read < it.size {
			n := it.size - read
			if n > int64(len(buf)) {
				n = int64(len(buf))
			}
			rn, rerr := fp.Read(buf[:n])
			p := buf[:rn]
			for len(p) > 0 {
				need := pieceLen - inPiece
				take := int64(len(p))
				if take > need {
					take = need
				}
				hasher.Write(p[:take])
				inPiece += take
				p = p[take:]
				if inPiece == pieceLen {
					pieces = append(pieces, hasher.Sum(nil)...)
					hasher.Reset()
					inPiece = 0
				}
			}
			read += int64(rn)
			if rerr != nil {
				fp.Close()
				return nil, errGame("版本文件读取失败: " + it.relPath)
			}
		}
		fp.Close()
	}
	if inPiece > 0 { // 尾片（不足 pieceLen 也入库）
		pieces = append(pieces, hasher.Sum(nil)...)
	}

	// info.files：路径按 / 切段成 BT path 列表；含非 ASCII 的整条 rel 转义为单段安全名
	// （引擎按系统 ANSI 代码页解释种子文件名字节，实测见 torrentEscPrefix 注释）
	fileEntries := make([][]byte, 0, len(items))
	for _, it := range items {
		pathList := bencodeMark("l")
		if esc := torrentEscName(it.relPath); esc != "" {
			pathList = bencodeConcat(pathList, bencodeStr(esc))
		} else {
			for _, seg := range strings.Split(it.relPath, "/") {
				pathList = bencodeConcat(pathList, bencodeStr(seg))
			}
		}
		pathList = bencodeConcat(pathList, bencodeMark("e"))
		fileEntries = append(fileEntries, bencodeConcat(
			bencodeMark("d"),
			bencodeStr("length"), bencodeInt(it.size),
			bencodeStr("path"), pathList,
			bencodeMark("e"),
		))
	}
	filesList := bencodeConcat(bencodeMark("l"), bencodeConcat(fileEntries...), bencodeMark("e"))

	// info 字典（键按 BT 规范字典序：files < name < piece length < pieces）
	info := bencodeConcat(
		bencodeMark("d"),
		bencodeStr("files"), filesList,
		bencodeStr("name"), bencodeStr(slug),
		bencodeStr("piece length"), bencodeInt(pieceLen),
		bencodeStr("pieces"), bencodeBytes(pieces),
		bencodeMark("e"),
	)
	// 根字典（键按 BT 规范字典序：announce < announce-list < info）：
	// announce = 首个全局 Tracker（config game.trackers；留空=不写该键，仅公网 DHT 发现 peer），
	// announce-list = BEP12 多 tracker 列表（每地址一个 tier；仅 >1 个时写，单地址与 announce 重复无意义）
	parts := [][]byte{bencodeMark("d")}
	if len(trackers) > 0 {
		parts = append(parts, bencodeStr("announce"), bencodeStr(trackers[0]))
		if len(trackers) > 1 {
			list := bencodeMark("l")
			for _, tr := range trackers {
				list = bencodeConcat(list, bencodeMark("l"), bencodeStr(tr), bencodeMark("e"))
			}
			list = bencodeConcat(list, bencodeMark("e"))
			parts = append(parts, bencodeStr("announce-list"), list)
		}
	}
	root := bencodeConcat(append(parts, bencodeStr("info"), info, bencodeMark("e"))...)
	return root, nil
}

// gameTorrentCachePath 种子缓存路径（manifestHash 前 16 位 + tracker 指纹做失效锚点：
// 版本文件变化或全局 tracker 配置变化 → 缓存名变化自动失效重建，无需人工清缓存）
func gameTorrentCachePath(s *Server, slug, manifestHash string) string {
	hashTag := manifestHash
	if len(hashTag) > 16 {
		hashTag = hashTag[:16]
	}
	if hashTag == "" {
		hashTag = "nohash"
	}
	return filepath.Join(s.cfg.Game.LocalDir, "torrents", slug+"-"+hashTag+"-"+s.gameTrackerTag()+".torrent")
}

// gameTrackerTag 全局 tracker 列表指纹（sha1 前 8 hex；空列表为 "notracker"，用作种子缓存锚点之一）
func (s *Server) gameTrackerTag() string {
	if len(s.cfg.Game.Trackers) == 0 {
		return "notracker"
	}
	sum := sha1.Sum([]byte(strings.Join(s.cfg.Game.Trackers, "\n")))
	return hex.EncodeToString(sum[:4])
}

// gameUploadedTorrentDir 上传种子存放目录（LocalDir/torrents/uploaded/，仅下载方式=2 使用）
func (s *Server) gameUploadedTorrentDir() string {
	return filepath.Join(s.cfg.Game.LocalDir, "torrents", "uploaded")
}

// gameUploadedTorrentFile 上传种子的磁盘绝对路径（TorrentPath 为文件名，经 Base 归一防穿越）；
// 非法/未配置返回空串
func (s *Server) gameUploadedTorrentFile(g *model.Game) string {
	name := strings.TrimSpace(g.TorrentPath)
	if name == "" || name != filepath.Base(name) {
		return ""
	}
	return filepath.Join(s.gameUploadedTorrentDir(), name)
}

// gameServeUploadedTorrent 下载方式=2：直发管理员上传的种子（与版本清单无关，客户端 URL 不变）
func (s *Server) gameServeUploadedTorrent(w http.ResponseWriter, g *model.Game) {
	fp := s.gameUploadedTorrentFile(g)
	if fp == "" {
		adminFail(w, http.StatusNotFound, "下载方式为上传种子，但尚未上传种子文件")
		return
	}
	data, err := os.ReadFile(fp)
	if err != nil {
		adminFail(w, http.StatusNotFound, "上传的种子文件缺失，请在后台重新上传")
		return
	}
	w.Header().Set("Content-Type", "application/x-bittorrent")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+g.Slug+".torrent\"")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Write(data)
}

// —— 上传种子轻解析（下载方式=2 专用）：只取 info.name（安装锚点，必须与客户端落盘根一致）
// 与文件总大小/文件数（列表展示与选盘弹窗体积）。非通用 bencode 解析器：只按 BT 规范走
// 顶层 dict → info dict → name/files/length，其余键一律跳过；任何越界/异常返回已解析部分，
// 由调用方回退（宁缺毋滥，绝不 panic） ——

type torrentReader struct {
	b   []byte
	pos int
}

// peek 取当前字节（不推进）
func (t *torrentReader) peek() (byte, bool) {
	if t.pos >= len(t.b) {
		return 0, false
	}
	return t.b[t.pos], true
}

// str 读 bencode 字节串（<len>:<bytes>）；长度上限 1<<28 防异常种子拖内存
func (t *torrentReader) str() (string, bool) {
	n, digits := 0, 0
	for {
		if t.pos >= len(t.b) {
			return "", false
		}
		c := t.b[t.pos]
		t.pos++
		if c == ':' {
			if digits == 0 {
				return "", false
			}
			break
		}
		if c < '0' || c > '9' {
			return "", false
		}
		n = n*10 + int(c-'0')
		digits++
		if digits > 9 || n > 1<<28 {
			return "", false
		}
	}
	if t.pos+n > len(t.b) {
		return "", false
	}
	s := string(t.b[t.pos : t.pos+n])
	t.pos += n
	return s, true
}

// int 读 bencode 整数（i<dec>e）
func (t *torrentReader) int() (int64, bool) {
	if c, ok := t.peek(); !ok || c != 'i' {
		return 0, false
	}
	t.pos++
	var v int64
	for i := 0; ; i++ {
		if t.pos >= len(t.b) {
			return 0, false
		}
		c := t.b[t.pos]
		t.pos++
		if c == 'e' {
			return v, true
		}
		if c < '0' || c > '9' || i > 18 {
			return 0, false
		}
		v = v*10 + int64(c-'0')
	}
}

// skip 跳过任意 bencode 值（depth 限 32 层防恶意嵌套爆栈）
func (t *torrentReader) skip(depth int) bool {
	if depth > 32 {
		return false
	}
	c, ok := t.peek()
	if !ok {
		return false
	}
	switch c {
	case 'i':
		_, ok2 := t.int()
		return ok2
	case 'l', 'd':
		t.pos++
		for {
			cur, ok2 := t.peek()
			if !ok2 {
				return false
			}
			if cur == 'e' {
				t.pos++
				return true
			}
			if c == 'd' {
				if _, ok3 := t.str(); !ok3 { // dict 键
					return false
				}
			}
			if !t.skip(depth + 1) {
				return false
			}
		}
	default:
		_, ok2 := t.str()
		return ok2
	}
}

// infoDict 读 info 字典：取 name / files[].length（多文件）或 length（单文件）
func (t *torrentReader) infoDict() (string, int64, int) {
	if c, ok := t.peek(); !ok || c != 'd' {
		return "", 0, 0
	}
	t.pos++
	var name string
	var total int64
	var count int
	for {
		c, ok := t.peek()
		if !ok || c == 'e' {
			if ok {
				t.pos++
			}
			return name, total, count
		}
		k, ok := t.str()
		if !ok {
			return name, total, count
		}
		switch k {
		case "name":
			name, _ = t.str()
		case "length": // 单文件种子（无 files 列表）
			if v, ok := t.int(); ok {
				total = v
				count = 1
			}
		case "files":
			if c2, ok := t.peek(); !ok || c2 != 'l' {
				if !t.skip(1) {
					return name, total, count
				}
				continue
			}
			t.pos++
			for {
				c3, ok := t.peek()
				if !ok {
					return name, total, count
				}
				if c3 == 'e' {
					t.pos++
					break
				}
				if c3 != 'd' {
					if !t.skip(1) {
						return name, total, count
					}
					continue
				}
				t.pos++
				var ln int64
				for {
					c4, ok2 := t.peek()
					if !ok2 {
						return name, total, count
					}
					if c4 == 'e' {
						t.pos++
						break
					}
					k4, ok4 := t.str()
					if !ok4 {
						return name, total, count
					}
					if k4 == "length" {
						if v, ok5 := t.int(); ok5 {
							ln = v
						}
					} else if !t.skip(1) {
						return name, total, count
					}
				}
				total += ln
				count++
			}
		default:
			if !t.skip(1) {
				return name, total, count
			}
		}
	}
}

// torrentInfoScan 解析种子取 info.name / 总大小 / 文件数（异常种子返回零值，不报错）
func torrentInfoScan(data []byte) (string, int64, int) {
	t := &torrentReader{b: data}
	if c, ok := t.peek(); !ok || c != 'd' {
		return "", 0, 0
	}
	t.pos++
	for {
		c, ok := t.peek()
		if !ok || c == 'e' {
			return "", 0, 0
		}
		k, ok := t.str()
		if !ok {
			return "", 0, 0
		}
		if k == "info" {
			return t.infoDict()
		}
		if !t.skip(1) {
			return "", 0, 0
		}
	}
}

// gameUploadedTorrentMeta 读上传种子元信息（下载方式=2 靠 info.name 作为安装锚点下发清单）
func (s *Server) gameUploadedTorrentMeta(g *model.Game) (string, int64, int, error) {
	fp := s.gameUploadedTorrentFile(g)
	if fp == "" {
		return "", 0, 0, errGame("尚未上传种子文件")
	}
	data, err := os.ReadFile(fp)
	if err != nil {
		return "", 0, 0, errGame("上传的种子文件缺失，请在后台重新上传")
	}
	name, total, count := torrentInfoScan(data)
	if name == "" {
		name = g.Slug // 解析失败回退 slug（种子内 info.name 缺失/异常）
	}
	return name, total, count, nil
}

// HandleGameTorrent 种子下发（与 manifest 同水位鉴权）：库归属校验 → 缓存命中直发 → 未命中生成落盘再发。
// version 查询参数缺省取最新版（与清单接口同语义）
func (s *Server) HandleGameTorrent(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var cnt int64
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", username, id).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusForbidden, "请先将游戏加入库")
		return
	}
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	// 下载方式=2（管理员上传种子）：直发上传的 .torrent，与版本清单无关（客户端 URL 不变，无感）
	if g.DownloadMethod == 2 {
		s.gameServeUploadedTorrent(w, &g)
		return
	}
	manifest, err := s.gameManifest(&g, strings.TrimSpace(r.URL.Query().Get("version")))
	if err != nil {
		adminFail(w, http.StatusNotFound, "该游戏暂无可下载版本")
		return
	}
	manifestHash, _ := manifest["manifest_hash"].(string)
	slug, _ := manifest["slug"].(string)
	version, _ := manifest["version"].(string)

	cachePath := gameTorrentCachePath(s, slug, manifestHash)
	data, err := os.ReadFile(cachePath)
	if err != nil {
		rawList, _ := manifest["files"].([]map[string]interface{})
		items := make([]torrentFileItem, 0, len(rawList))
		for _, f := range rawList {
			rp, _ := f["rel_path"].(string)
			sz, _ := f["size"].(int64)
			if rp == "" || sz <= 0 {
				continue
			}
			items = append(items, torrentFileItem{relPath: rp, size: sz})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].relPath < items[j].relPath })
		baseDir := filepath.Join(s.cfg.Game.LocalDir, "games", slug, version)
		data, err = gameTorrentBuild(slug, items, baseDir, s.cfg.Game.Trackers)
		if err != nil {
			adminFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if mkErr := os.MkdirAll(filepath.Dir(cachePath), os.ModePerm); mkErr == nil {
			_ = os.WriteFile(cachePath, data, 0644)
		}
	}
	w.Header().Set("Content-Type", "application/x-bittorrent")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+slug+"-"+version+".torrent\"")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Write(data)
}

// HandleGameP2SP P2SP HTTP 直链源端点（路径式鉴权：DLBT 引擎把追加路径拼在 query 之后，
// query 鉴权必坏，E2E 实测；故 username/gid/version 全走路径段）。
//
//	GET /api/game/p2sp/{username}/{gid}/{version}/{slug}/{rel...}
//
// 引擎 AddHttpDownload 传 base（不含尾斜杠）后自动追加 <info.name>/<rel 或转义段>。
// rel 段两种形态：纯 ASCII 原名（可含子目录多段）/ __x__<hex> 转义名（非 ASCII 文件，反查还原）。
// 响应走 http.ServeContent：Range/206 原生支持（引擎逐分片断点续传依赖）。
func (s *Server) HandleGameP2SP(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username := strings.TrimSpace(r.PathValue("username"))
	gid, _ := strconv.ParseUint(r.PathValue("gid"), 10, 64)
	version := gameVersionClean(r.PathValue("version"))
	if username == "" || gid == 0 || version == "" {
		adminFail(w, http.StatusNotFound, "路径不完整")
		return
	}
	var cnt int64
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", username, gid).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusForbidden, "请先将游戏加入库")
		return
	}
	var g model.Game
	if err := store.DB.First(&g, gid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	// 下载方式=2 为纯 BT（不加 P2SP 直链源）：本端点一律拒绝，防客户端误叠加
	if g.DownloadMethod == 2 {
		adminFail(w, http.StatusNotFound, "该游戏为纯 BT 下载，无直链源")
		return
	}
	manifest, err := s.gameManifest(&g, version)
	if err != nil {
		adminFail(w, http.StatusNotFound, "该游戏暂无可下载版本")
		return
	}
	slug, _ := manifest["slug"].(string)
	segs := strings.Split(strings.TrimPrefix(r.PathValue("rest"), "/"), "/")
	if slug == "" || len(segs) < 2 || segs[0] != slug {
		adminFail(w, http.StatusNotFound, "资源路径不合法")
		return
	}
	var rel string
	if len(segs) == 2 && strings.HasPrefix(segs[1], torrentEscPrefix) {
		// 转义名反查（O(n) 现算 sha1，n=版本文件数，短串哈希成本可忽略；带缓存收益低）
		rawList, _ := manifest["files"].([]map[string]interface{})
		for _, f := range rawList {
			rp, _ := f["rel_path"].(string)
			if rp != "" && torrentEscName(rp) == segs[1] {
				rel = rp
				break
			}
		}
	} else {
		rel = gameRelPathClean(strings.Join(segs[1:], "/"))
	}
	if rel == "" {
		adminFail(w, http.StatusNotFound, "资源不存在")
		return
	}
	// 清单内存在性校验（防清单外路径枚举读盘；转义名反查天然在清单内）
	if !gameManifestHasFile(manifest, rel) {
		adminFail(w, http.StatusNotFound, "资源不存在")
		return
	}
	fp, err := os.Open(filepath.Join(s.cfg.Game.LocalDir, "games", slug, version, filepath.FromSlash(rel)))
	if err != nil {
		adminFail(w, http.StatusNotFound, "资源不存在")
		return
	}
	defer fp.Close()
	st, err := fp.Stat()
	if err != nil || !st.Mode().IsRegular() {
		adminFail(w, http.StatusNotFound, "资源不存在")
		return
	}
	http.ServeContent(w, r, filepath.Base(rel), st.ModTime(), fp)
}

// gameManifestHasFile 清单内文件存在性校验（线性扫，n=版本文件数，短字符串比较成本可忽略）
func gameManifestHasFile(manifest map[string]interface{}, rel string) bool {
	rawList, _ := manifest["files"].([]map[string]interface{})
	for _, f := range rawList {
		if rp, _ := f["rel_path"].(string); rp == rel {
			return true
		}
	}
	return false
}
