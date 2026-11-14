package server

// ===== 阶段二百九十七：Redis 管理后台 =====
// 设计归口：
//   1. 仅 adminGuard 鉴权后可访问（管理员专属）
//   2. 独立 Redis Client + 独立连接池（与 store.RDB 业务连接完全隔离）
//      → 关键：SELECT 命令是连接级别的，如果直接用 store.RDB.Do("SELECT", db) 会污染
//        连接池中某条连接的 DB 状态，导致后续 adminGuard / AI 限流 / 在线用户等
//        业务代码读到错误的 DB。因此必须创建独立 Client。
//   3. 使用 SCAN 而非 KEYS（生产安全，不阻塞 Redis）
//   4. 值预览有长度上限（500 字符 / 50 元素），大 value 截断展示
//   5. 多 DB 支持：遍历 0~15 各 DB 的 key 数量统计
//   6. 批量操作有上限（单次最多 100 key），防误删

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"im-server/logger"
	"im-server/store"
)

const (
	redisAdminMaxDB        = 15  // Redis 默认 DB 范围 0-15
	redisAdminScanCount    = 100 // SCAN 单次期望返回数
	redisAdminDefaultPage  = 50  // 默认每页数量
	redisAdminMaxPage      = 200 // 每页最大数量
	redisAdminMaxValuePrev = 500 // value 预览最大字符数
	redisAdminBatchMax     = 100 // 单次批量删除上限
)

// ========== 独立 Redis Client（与 store.RDB 完全隔离） ==========

var (
	redisAdminOnce sync.Once
	redisAdminRDB  *redis.Client
	redisAdminErr  error
)

// redisAdminClient 返回 Redis 管理专用的独立 Client。
// 从 store.RDB.Options() 拷贝连接参数，新建独立连接池（PoolSize=4）。
// 这样即使 SELECT 切换 DB 粘住，也只污染管理专用的 4 条连接，
// 不会影响 store.RDB 业务连接池中的任何连接。
func redisAdminClient() (*redis.Client, error) {
	redisAdminOnce.Do(func() {
		if store.RDB == nil {
			redisAdminErr = fmt.Errorf("Redis 未连接")
			return
		}
		opt := store.RDB.Options()
		redisAdminRDB = redis.NewClient(&redis.Options{
			Addr:         opt.Addr,
			Password:     opt.Password,
			Username:     opt.Username,
			DB:           0, // 默认 DB 无所谓，每次操作前都会 SELECT 到目标 DB
			PoolSize:     4, // 管理功能低频，4 条连接足够
			MinIdleConns: 1,
			DialTimeout:  5 * time.Second,
			ReadTimeout:  3 * time.Second,
			WriteTimeout: 3 * time.Second,
		})
		// 快速探测连通性（失败不阻塞首次请求，下次请求会自己报错）
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = redisAdminRDB.Ping(ctx).Err()
	})
	return redisAdminRDB, redisAdminErr
}

// ========== 数据结构 ==========

type redisAdminDBStat struct {
	DB   int   `json:"db"`
	Keys int64 `json:"keys"`
}

type redisAdminKeyItem struct {
	Key      string `json:"key"`
	Type     string `json:"type"`
	TTL      int64  `json:"ttl"`
	Size     int64  `json:"size"`
	ExpireAt int64  `json:"expire_at"`
}

type redisAdminKeyDetail struct {
	redisAdminKeyItem
	Value       interface{} `json:"value"`
	ValueLen    int         `json:"value_len"`
	Truncated   bool        `json:"truncated"`
	MemoryUsage int64       `json:"memory_usage"`
}

type redisAdminKeyListResp struct {
	DB       int                 `json:"db"`
	Keys     []redisAdminKeyItem `json:"keys"`
	Total    int64               `json:"total"`
	Page     int                 `json:"page"`
	PageSize int                 `json:"page_size"`
}

// redisSwitchDB 在管理专用 Client 上执行 SELECT（不影响 store.RDB）
func redisSwitchDB(ctx context.Context, db int) (*redis.Client, error) {
	rdb, err := redisAdminClient()
	if err != nil {
		return nil, err
	}
	if db >= 0 {
		if err := rdb.Do(ctx, "SELECT", db).Err(); err != nil {
			return nil, fmt.Errorf("SELECT DB %d 失败: %v", db, err)
		}
	}
	return rdb, nil
}

// ========== API 实现 ==========

// handleAdminRedisDBs GET /admin/api/redis/dbs
func (s *Server) handleAdminRedisDBs(w http.ResponseWriter, r *http.Request) {
	rdb, err := redisAdminClient()
	if err != nil {
		adminFail(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	stats := make([]redisAdminDBStat, 0, redisAdminMaxDB+1)
	for db := 0; db <= redisAdminMaxDB; db++ {
		if err := rdb.Do(ctx, "SELECT", db).Err(); err != nil {
			stats = append(stats, redisAdminDBStat{DB: db, Keys: -1})
			continue
		}
		size, err := rdb.DBSize(ctx).Result()
		if err != nil {
			stats = append(stats, redisAdminDBStat{DB: db, Keys: -1})
			continue
		}
		stats = append(stats, redisAdminDBStat{DB: db, Keys: size})
	}

	adminJSON(w, stats)
}

// handleAdminRedisKeyList GET /admin/api/redis/keys
func (s *Server) handleAdminRedisKeyList(w http.ResponseWriter, r *http.Request) {
	if store.RDB == nil {
		adminFail(w, http.StatusServiceUnavailable, "Redis 未连接")
		return
	}

	db := int(adminQueryUint(r.URL.Query().Get("db")))
	if db > redisAdminMaxDB {
		db = 0
	}
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	if search == "" {
		search = "*"
	} else {
		if !strings.ContainsAny(search, "*?[]") {
			search = "*" + search + "*"
		}
	}

	page := adminQueryUint(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize := adminQueryUint(r.URL.Query().Get("page_size"))
	if pageSize < 1 {
		pageSize = redisAdminDefaultPage
	}
	if pageSize > redisAdminMaxPage {
		pageSize = redisAdminMaxPage
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rdb, err := redisSwitchDB(ctx, db)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}

	// SCAN 全量遍历（生产安全，不阻塞）
	allKeys, err := scanAllKeys(ctx, rdb, search)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "扫描 Redis keys 失败")
		return
	}

	total := int64(len(allKeys))
	start := int((page - 1) * pageSize)
	if start > len(allKeys) {
		start = len(allKeys)
	}
	end := start + int(pageSize)
	if end > len(allKeys) {
		end = len(allKeys)
	}
	pageKeys := allKeys[start:end]

	items := make([]redisAdminKeyItem, 0, len(pageKeys))
	for _, key := range pageKeys {
		item := redisAdminKeyItem{Key: key}
		t, err := rdb.Type(ctx, key).Result()
		if err != nil {
			continue
		}
		item.Type = t

		ttl, _ := rdb.TTL(ctx, key).Result()
		switch {
		case ttl == -2:
			item.TTL = -2
		case ttl == -1:
			item.TTL = -1
		default:
			item.TTL = int64(ttl.Seconds())
			item.ExpireAt = time.Now().Unix() + item.TTL
		}
		item.Size = getKeySize(ctx, rdb, key, t)
		items = append(items, item)
	}

	adminJSON(w, redisAdminKeyListResp{
		DB:       db,
		Keys:     items,
		Total:    total,
		Page:     int(page),
		PageSize: int(pageSize),
	})
}

func scanAllKeys(ctx context.Context, rdb *redis.Client, pattern string) ([]string, error) {
	var all []string
	var cursor uint64
	for {
		keys, nextCursor, err := rdb.Scan(ctx, cursor, pattern, redisAdminScanCount).Result()
		if err != nil {
			return nil, err
		}
		all = append(all, keys...)
		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}
	return all, nil
}

func getKeySize(ctx context.Context, rdb *redis.Client, key, keyType string) int64 {
	switch keyType {
	case "string":
		n, _ := rdb.StrLen(ctx, key).Result()
		return n
	case "hash":
		n, _ := rdb.HLen(ctx, key).Result()
		return int64(n)
	case "list":
		n, _ := rdb.LLen(ctx, key).Result()
		return n
	case "set":
		n, _ := rdb.SCard(ctx, key).Result()
		return int64(n)
	case "zset":
		n, _ := rdb.ZCard(ctx, key).Result()
		return n
	case "stream":
		n, _ := rdb.XLen(ctx, key).Result()
		return n
	default:
		return 0
	}
}

// handleAdminRedisKeyDetail GET /admin/api/redis/key
func (s *Server) handleAdminRedisKeyDetail(w http.ResponseWriter, r *http.Request) {
	if store.RDB == nil {
		adminFail(w, http.StatusServiceUnavailable, "Redis 未连接")
		return
	}

	db := int(adminQueryUint(r.URL.Query().Get("db")))
	if db > redisAdminMaxDB {
		db = 0
	}
	key := r.URL.Query().Get("key")
	if key == "" {
		adminFail(w, http.StatusBadRequest, "key 参数不能为空")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rdb, err := redisSwitchDB(ctx, db)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}

	keyType, err := rdb.Type(ctx, key).Result()
	if err != nil || keyType == "none" {
		adminFail(w, http.StatusNotFound, "key 不存在")
		return
	}

	detail := redisAdminKeyDetail{
		redisAdminKeyItem: redisAdminKeyItem{Key: key, Type: keyType},
	}

	ttl, _ := rdb.TTL(ctx, key).Result()
	switch {
	case ttl == -2:
		detail.TTL = -2
	case ttl == -1:
		detail.TTL = -1
	default:
		detail.TTL = int64(ttl.Seconds())
		detail.ExpireAt = time.Now().Unix() + detail.TTL
	}
	detail.Size = getKeySize(ctx, rdb, key, keyType)

	if mem, err := rdb.MemoryUsage(ctx, key).Result(); err == nil {
		detail.MemoryUsage = mem
	} else {
		detail.MemoryUsage = -1
	}

	previewValue, totalLen, truncated := getKeyPreview(ctx, rdb, key, keyType)
	detail.Value = previewValue
	detail.ValueLen = totalLen
	detail.Truncated = truncated

	adminJSON(w, detail)
}

func getKeyPreview(ctx context.Context, rdb *redis.Client, key, keyType string) (interface{}, int, bool) {
	switch keyType {
	case "string":
		val, err := rdb.Get(ctx, key).Result()
		if err != nil {
			return fmt.Sprintf("<error: %v>", err), 0, false
		}
		totalLen := len(val)
		truncated := false
		if totalLen > redisAdminMaxValuePrev {
			val = val[:redisAdminMaxValuePrev] + "...(已截断)"
			truncated = true
		}
		return val, totalLen, truncated

	case "hash":
		all, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return fmt.Sprintf("<error: %v>", err), 0, false
		}
		preview := make(map[string]string)
		totalLen := len(all)
		count := 0
		for k, v := range all {
			if count >= 50 {
				break
			}
			if len(v) > 200 {
				v = v[:200] + "..."
			}
			preview[k] = v
			count++
		}
		return preview, totalLen, totalLen > 50

	case "list":
		vals, err := rdb.LRange(ctx, key, 0, 49).Result()
		if err != nil {
			return fmt.Sprintf("<error: %v>", err), 0, false
		}
		totalLen, _ := rdb.LLen(ctx, key).Result()
		return truncateStrings(vals), int(totalLen), totalLen > 50

	case "set":
		vals, err := rdb.SMembers(ctx, key).Result()
		if err != nil {
			return fmt.Sprintf("<error: %v>", err), 0, false
		}
		totalLen := len(vals)
		if len(vals) > 50 {
			vals = vals[:50]
		}
		return truncateStrings(vals), totalLen, totalLen > 50

	case "zset":
		vals, err := rdb.ZRangeWithScores(ctx, key, 0, 49).Result()
		if err != nil {
			return fmt.Sprintf("<error: %v>", err), 0, false
		}
		totalLen, _ := rdb.ZCard(ctx, key).Result()
		type zsetItem struct {
			Member string  `json:"member"`
			Score  float64 `json:"score"`
		}
		preview := make([]zsetItem, 0, len(vals))
		for _, v := range vals {
			member := fmt.Sprintf("%v", v.Member)
			if len(member) > 200 {
				member = member[:200] + "..."
			}
			preview = append(preview, zsetItem{Member: member, Score: v.Score})
		}
		return preview, int(totalLen), totalLen > 50

	case "stream":
		vals, err := rdb.XRange(ctx, key, "-", "+").Result()
		if err != nil {
			return fmt.Sprintf("<error: %v>", err), 0, false
		}
		totalLen := len(vals)
		if len(vals) > redisAdminScanCount {
			vals = vals[:redisAdminScanCount]
		}
		return vals, totalLen, totalLen > redisAdminScanCount

	default:
		return "<unsupported type>", 0, false
	}
}

func truncateStrings(vals []string) []string {
	out := make([]string, len(vals))
	for i, v := range vals {
		if len(v) > 200 {
			out[i] = v[:200] + "..."
		} else {
			out[i] = v
		}
	}
	return out
}

// handleAdminRedisKeyDelete DELETE /admin/api/redis/key
func (s *Server) handleAdminRedisKeyDelete(w http.ResponseWriter, r *http.Request) {
	if store.RDB == nil {
		adminFail(w, http.StatusServiceUnavailable, "Redis 未连接")
		return
	}

	db := int(adminQueryUint(r.URL.Query().Get("db")))
	if db > redisAdminMaxDB {
		db = 0
	}
	key := r.URL.Query().Get("key")
	if key == "" {
		adminFail(w, http.StatusBadRequest, "key 参数不能为空")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rdb, err := redisSwitchDB(ctx, db)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := rdb.Del(ctx, key).Result()
	if err != nil {
		logger.Error("Redis 删除 key 失败（db=%d, key=%s）: %v", db, key, err)
		adminFail(w, http.StatusInternalServerError, "删除失败")
		return
	}

	adminName := adminUserFromCtx(r)
	logger.Info("管理员 %s 删除 Redis key（db=%d, key=%s）", adminName, db, key)
	adminJSON(w, map[string]interface{}{"deleted": result})
}

// handleAdminRedisBatchDelete POST /admin/api/redis/batch-delete
func (s *Server) handleAdminRedisBatchDelete(w http.ResponseWriter, r *http.Request) {
	if store.RDB == nil {
		adminFail(w, http.StatusServiceUnavailable, "Redis 未连接")
		return
	}

	var req struct {
		DB   int      `json:"db"`
		Keys []string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}

	if req.DB < 0 || req.DB > redisAdminMaxDB {
		adminFail(w, http.StatusBadRequest, "DB 编号无效")
		return
	}
	if len(req.Keys) == 0 {
		adminFail(w, http.StatusBadRequest, "keys 列表不能为空")
		return
	}
	if len(req.Keys) > redisAdminBatchMax {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("单次最多删除 %d 个 key", redisAdminBatchMax))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rdb, err := redisSwitchDB(ctx, req.DB)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := rdb.Del(ctx, req.Keys...).Result()
	if err != nil {
		logger.Error("Redis 批量删除失败（db=%d, count=%d）: %v", req.DB, len(req.Keys), err)
		adminFail(w, http.StatusInternalServerError, "批量删除失败")
		return
	}

	adminName := adminUserFromCtx(r)
	logger.Info("管理员 %s 批量删除 Redis keys（db=%d, count=%d）", adminName, req.DB, len(req.Keys))
	adminJSON(w, map[string]interface{}{"deleted": result})
}

// handleAdminRedisInfo GET /admin/api/redis/info
// INFO 是服务器级别的，不依赖 DB，走 redisAdminClient 默认连接即可
func (s *Server) handleAdminRedisInfo(w http.ResponseWriter, r *http.Request) {
	if store.RDB == nil {
		adminFail(w, http.StatusServiceUnavailable, "Redis 未连接")
		return
	}

	rdb, err := redisAdminClient()
	if err != nil {
		adminFail(w, http.StatusServiceUnavailable, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	info := make(map[string]map[string]string)
	sections := []string{"server", "clients", "memory", "persistence", "stats", "replication"}
	for _, sec := range sections {
		raw, err := rdb.Info(ctx, sec).Result()
		if err != nil {
			continue
		}
		info[sec] = parseRedisInfo(raw)
	}

	pong, _ := rdb.Ping(ctx).Result()
	info["ping"] = map[string]string{"result": pong}

	adminJSON(w, info)
}

func parseRedisInfo(raw string) map[string]string {
	result := make(map[string]string)
	lines := strings.Split(raw, "\r\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			result[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	return result
}

// handleAdminRedisTTLUpdate POST /admin/api/redis/ttl
func (s *Server) handleAdminRedisTTLUpdate(w http.ResponseWriter, r *http.Request) {
	if store.RDB == nil {
		adminFail(w, http.StatusServiceUnavailable, "Redis 未连接")
		return
	}

	var req struct {
		DB  int    `json:"db"`
		Key string `json:"key"`
		TTL int64  `json:"ttl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}

	if req.DB < 0 || req.DB > redisAdminMaxDB {
		adminFail(w, http.StatusBadRequest, "DB 编号无效")
		return
	}
	if req.Key == "" {
		adminFail(w, http.StatusBadRequest, "key 不能为空")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rdb, err := redisSwitchDB(ctx, req.DB)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}

	exists, err := rdb.Exists(ctx, req.Key).Result()
	if err != nil || exists == 0 {
		adminFail(w, http.StatusNotFound, "key 不存在")
		return
	}

	var ok bool
	if req.TTL == -1 {
		ok, err = rdb.Persist(ctx, req.Key).Result()
	} else if req.TTL > 0 {
		ok, err = rdb.Expire(ctx, req.Key, time.Duration(req.TTL)*time.Second).Result()
	} else {
		adminFail(w, http.StatusBadRequest, "ttl 必须为 -1（永久）或正整数秒")
		return
	}

	if err != nil || !ok {
		adminFail(w, http.StatusInternalServerError, "更新过期时间失败")
		return
	}

	adminName := adminUserFromCtx(r)
	logger.Info("管理员 %s 更新 Redis key TTL（db=%d, key=%s, ttl=%d）", adminName, req.DB, req.Key, req.TTL)
	adminJSON(w, map[string]interface{}{"ok": true})
}
