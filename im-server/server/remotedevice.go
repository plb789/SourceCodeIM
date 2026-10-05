package server

// ===== 阶段二百六十一：向日葵同款远程控制——设备注册与验证码归口（remotedevice.go） =====
// 职责划分（服务端数据归口）：
//   1. 设备注册：每台 PC 客户端登录成功后经 POST /api/rc/device/register 上报 install_uuid
//      （Electron userData 持久化），服务端按 (username, install_uuid) 分配/复用 9-10 位数字
//      设备ID——同机重装凭 uuid 找回原ID；同账号多台 PC 各自一行（对齐向日葵"一台设备一个ID"）
//   2. 验证码：动态码 6 位数字（rc_connect 校验时惰性刷新，TTL 内有效，经 rc_ready/rc_info 推送展示）
//      + 静态访问密码（用户自设，sha256 存 static_pw_hash，与账号密码同哈希水位 auth.go）
//   3. 防爆破：内存计数 device_id→连续失败次数，达上限锁定一段时间（重启清空可接受——
//      锁定只是限速，验证码本身仍是凭据门槛）
//   4. 信令面在 remote.go rc_connect 分支（复用 MsgTypeRemoteSignal=90 会话状态机/话单/忙互斥）
// 鉴权水位：/api/rc/* 与网盘同模式——username 查询参数 + 在线校验 + 带 X-Drive-Token 时强校验归属
// （远程控制入口仅本人账号可管理自己的设备；连接他人设备走 WS 信令 rc_connect，验证码即授权凭证）

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// rcDeviceIDRe 设备ID格式：9-10 位纯数字（向日葵同款对外标识）
var rcDeviceIDRe = regexp.MustCompile(`^[0-9]{9,10}$`)

// rcInstallUUIDRe 安装标识格式（客户端生成 uuid，宽松校验防注入即可）
var rcInstallUUIDRe = regexp.MustCompile(`^[A-Za-z0-9\-]{8,64}$`)

// rcCodeRe 验证码输入消毒（动态码 6 位数字或静态密码；长度上限防超长 payload）
var rcCodeRe = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)

// rcLockEntry 防爆破计数条目
type rcLockEntry struct {
	Fails     int
	LockUntil time.Time
}

var (
	rcLockMu  sync.Mutex
	rcLockMap = map[string]*rcLockEntry{} // device_id -> 失败计数
)

// rcCheckLock 设备ID是否处于爆破锁定期（返回剩余锁定秒，0=未锁定）
func rcCheckLock(deviceID string) int {
	rcLockMu.Lock()
	defer rcLockMu.Unlock()
	e := rcLockMap[deviceID]
	if e == nil || time.Now().Before(e.LockUntil) {
		if e != nil {
			return int(time.Until(e.LockUntil).Seconds() + 1)
		}
		return 0
	}
	return 0
}

// rcRecordFail 记录一次验证码失败；达上限置锁并返回是否刚触发锁定
func rcRecordFail(deviceID string, maxFails, lockSec int) bool {
	rcLockMu.Lock()
	defer rcLockMu.Unlock()
	e := rcLockMap[deviceID]
	if e == nil {
		e = &rcLockEntry{}
		rcLockMap[deviceID] = e
	}
	// 仅"曾锁定且锁已过期"才重新计数——新条目 LockUntil 为零值（0001-01-01），
	// 无条件 After 判断会把每次失败计数清零，导致锁定永不触发（实测抓出的真 bug）
	if !e.LockUntil.IsZero() && time.Now().After(e.LockUntil) {
		e.Fails = 0 // 锁过期后重新计数
	}
	e.Fails++
	if e.Fails >= maxFails {
		e.LockUntil = time.Now().Add(time.Duration(lockSec) * time.Second)
		e.Fails = 0
		logger.Warn("远程控制防爆破锁定：设备 %s 连续验证失败 %d 次，锁定 %ds", deviceID, maxFails, lockSec)
		return true
	}
	return false
}

// rcClearFail 验证成功清零计数
func rcClearFail(deviceID string) {
	rcLockMu.Lock()
	defer rcLockMu.Unlock()
	delete(rcLockMap, deviceID)
}

// rcPurgeLocks 锁表 GC（防恶意刷不存在设备ID撑爆内存）：过期条目定期清理
func rcPurgeLocks() {
	rcLockMu.Lock()
	defer rcLockMu.Unlock()
	now := time.Now()
	for k, e := range rcLockMap {
		if now.After(e.LockUntil) && e.Fails == 0 {
			delete(rcLockMap, k)
		}
	}
}

// rcRandomDigits 生成 n 位随机数字字符串（crypto/rand，首位非零保证位数稳定）
func rcRandomDigits(n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		max := big.NewInt(9)
		if i == 0 {
			max = big.NewInt(8) // 首位 1-9
		}
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			return ""
		}
		b.WriteByte(byte('1' + v.Int64()))
	}
	return b.String()
}

// rcNewDeviceID 生成全局唯一设备ID（9-10 位随机，碰撞重试；唯一索引兜底）
func rcNewDeviceID() string {
	for i := 0; i < 10; i++ {
		id := rcRandomDigits(9 + i%2)
		if id == "" {
			continue
		}
		var cnt int64
		store.DB.Model(&model.Device{}).Where("device_id = ?", id).Count(&cnt)
		if cnt == 0 {
			return id
		}
	}
	return ""
}

// rcEnsureDevice 设备注册归口：按 (username, install_uuid) 查找或分配设备行，
// 刷新 last_seen/device_name，并确保动态码可用（过期重生成）。返回设备行（含最新动态码）
func rcEnsureDevice(username, installUUID, deviceName string) (*model.Device, error) {
	var dev model.Device
	err := store.DB.Where("username = ? AND install_uuid = ?", username, installUUID).First(&dev).Error
	if err != nil {
		// 新设备：分配全局唯一 device_id（uniqueIndex 冲突重试）
		id := rcNewDeviceID()
		if id == "" {
			return nil, &rcError{"设备ID分配失败，请重试"}
		}
		dev = model.Device{
			Username:    username,
			InstallUUID: installUUID,
			DeviceID:    id,
			DeviceName:  deviceName,
			LastSeen:    time.Now(),
		}
		if derr := store.DB.Create(&dev).Error; derr != nil {
			// 极端竞态（同 uuid 并发注册）：回读既有行
			if e2 := store.DB.Where("username = ? AND install_uuid = ?", username, installUUID).First(&dev).Error; e2 != nil {
				return nil, &rcError{"设备注册失败"}
			}
		} else {
			logger.Info("远程控制设备注册：%s（用户 %s，device_id=%s）", deviceName, username, dev.DeviceID)
		}
	} else {
		upd := map[string]interface{}{"last_seen": time.Now()}
		if deviceName != "" && deviceName != dev.DeviceName {
			upd["device_name"] = deviceName
		}
		store.DB.Model(&model.Device{}).Where("id = ?", dev.ID).Updates(upd)
		dev.LastSeen = time.Now()
		if deviceName != "" {
			dev.DeviceName = deviceName
		}
	}
	// 动态码惰性确保可用（TTL 内原样返回，过期重生成）
	rcEnsureDynCode(&dev)
	return &dev, nil
}

// rcError 设备模块业务错误（HTTP 处理器统一回 JSON error）
type rcError struct{ Msg string }

func (e *rcError) Error() string { return e.Msg }

// rcEnsureDynCode 动态码惰性刷新：TTL 内有效原样返回；过期/缺失重生成 6 位码并落库
func rcEnsureDynCode(dev *model.Device) string {
	if dev.DynCode != "" && time.Now().Before(dev.DynExpire) {
		return dev.DynCode
	}
	code := rcRandomDigits(6)
	expire := time.Now().Add(time.Duration(rcDynTTL()) * time.Second)
	store.DB.Model(&model.Device{}).Where("id = ?", dev.ID).Updates(map[string]interface{}{
		"dyn_code": code, "dyn_expire": expire,
	})
	dev.DynCode = code
	dev.DynExpire = expire
	return code
}

// rcDynTTL 动态码有效期秒（配置归口，兜底段已保证 >0）
func rcDynTTL() int {
	if CfgRC.DynCodeTTL > 0 {
		return CfgRC.DynCodeTTL
	}
	return 300
}

// CfgRC 远程控制配置节（RegisterRCRoutes 注入；nil 视为启用走兜底默认）
var CfgRC rcConfigView

// rcConfigView 配置只读视图（避免 config 包字段变更扩散到信令面）
type rcConfigView struct {
	Disabled       bool
	DynCodeTTL     int
	MaxFails       int
	LockSec        int
	StaticPWMinLen int
}

// rcVerifyCode 验证码校验归口：动态码（TTL 内）或静态密码（sha256 比对）任一匹配即通过。
// via 返回实际匹配方式："dyn" 动态码 / "static" 静态密码 / "" 未通过——阶段二百六十二信任
// 机制据 via 决定是否建立信任对（仅 static 建，dyn 绝不建，防一次性窥视升级永久权限）。
// 通过返回 true 并清零爆破计数；失败记录计数（调用方据返回的 locked 提示锁定）
func rcVerifyCode(dev *model.Device, code string) (ok bool, locked bool, via string) {
	if !rcCodeRe.MatchString(code) {
		locked = rcRecordFail(dev.DeviceID, rcMaxFails(), rcLockSec())
		return false, locked, ""
	}
	// 动态码：仅 TTL 内有效（过期即失效，下次校验惰性刷新新码）
	if dev.DynCode != "" && code == dev.DynCode && time.Now().Before(dev.DynExpire) {
		rcClearFail(dev.DeviceID)
		return true, false, "dyn"
	}
	// 静态密码：用户自设长期有效（空=未启用；新存 bcrypt，存量 sha256 双路兼容+校验通过惰性升级）
	if dev.StaticPWHash != "" {
		if ok, needUpgrade := verifyPassword(dev.StaticPWHash, code); ok {
			if needUpgrade {
				store.DB.Model(&model.Device{}).Where("id = ?", dev.ID).Update("static_pw_hash", hashPassword(code))
			}
			rcClearFail(dev.DeviceID)
			return true, false, "static"
		}
	}
	locked = rcRecordFail(dev.DeviceID, rcMaxFails(), rcLockSec())
	return false, locked, ""
}

func rcMaxFails() int {
	if CfgRC.MaxFails > 0 {
		return CfgRC.MaxFails
	}
	return 5
}

func rcLockSec() int {
	if CfgRC.LockSec > 0 {
		return CfgRC.LockSec
	}
	return 600
}

func rcDisabled() bool {
	return CfgRC.Disabled
}

// ===== HTTP 接口（/api/rc/*，鉴权仿 guardDrive：username 在线 + token 归属强校验） =====

// guardRC 远程控制管理接口统一包装：功能开关/用户名/在线校验归口
func (s *Server) guardRC(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rcDisabled() {
			driveFail(w, http.StatusForbidden, "远程控制功能未启用")
			return
		}
		username := r.URL.Query().Get("username")
		if !driveUsernameRe.MatchString(username) {
			driveFail(w, http.StatusUnauthorized, "非法用户名")
			return
		}
		if s.hub.Count(username) == 0 {
			driveFail(w, http.StatusUnauthorized, "用户未在线，请先登录")
			return
		}
		// 安全收口（审计修复）：token 强校验必选——远程控制设备管理接口回传动态验证码，
		// 旧"空 token 放行"水位可被冒名在线用户拉取他人 device_id+dyn_code，配合
		// rc_connect"验证码即授权"实现免确认静默接管。所有合法调用方（rc-panel.js）
		// 均随登录回执持久化并携带 X-Drive-Token，无旧客户端兼容负担（RC 为新增功能）
		tk := r.Header.Get("X-Drive-Token")
		if tk == "" {
			driveFail(w, http.StatusUnauthorized, "缺少身份凭证，请重新登录")
			return
		}
		if tu, ok := DriveTokenVerify(tk); !ok || tu != username {
			driveFail(w, http.StatusUnauthorized, "身份校验失败，请重新登录")
			return
		}
		h(w, r)
	}
}

// RegisterRCRoutes 注册远程控制模块路由（main.go 调用归口；Go 1.22+ 方法+路径模式）
func RegisterRCRoutes(s *Server, cfg config.RCConfig) {
	CfgRC = rcConfigView{
		Disabled:       cfg.Disabled,
		DynCodeTTL:     cfg.DynCodeTTL,
		MaxFails:       cfg.MaxFails,
		LockSec:        cfg.LockSec,
		StaticPWMinLen: cfg.StaticPWMinLen,
	}
	http.HandleFunc("POST /api/rc/device/register", s.guardRC(s.handleRCDeviceRegister))
	http.HandleFunc("GET /api/rc/device/my", s.guardRC(s.handleRCDeviceMy))
	http.HandleFunc("POST /api/rc/device/static_pw", s.guardRC(s.handleRCStaticPW))
	http.HandleFunc("POST /api/rc/device/refresh_code", s.guardRC(s.handleRCRefreshCode))
	http.HandleFunc("GET /api/rc/records", s.guardRC(s.handleRCRecords))
	// 阶段二百六十二：信任名单 / 自定义远程卡片 / 历史访问（一键直连配套）
	http.HandleFunc("GET /api/rc/trust", s.guardRC(s.handleRCTrustList))
	http.HandleFunc("POST /api/rc/trust/remove", s.guardRC(s.handleRCTrustRemove))
	http.HandleFunc("GET /api/rc/card/list", s.guardRC(s.handleRCCardList))
	http.HandleFunc("POST /api/rc/card/add", s.guardRC(s.handleRCCardAdd))
	http.HandleFunc("POST /api/rc/card/remove", s.guardRC(s.handleRCCardRemove))
	http.HandleFunc("GET /api/rc/visits", s.guardRC(s.handleRCVisits))
	// 防爆破锁表 GC（每小时一轮，防不存在设备ID刷计数撑爆内存）
	go func() {
		for {
			time.Sleep(time.Hour)
			rcPurgeLocks()
		}
	}()
	logger.Info("远程控制（设备ID+验证码）路由已注册")
}

// handleRCDeviceRegister 设备注册 POST /api/rc/device/register?username=xxx
// 入参 {install_uuid, device_name}；返回 {device_id, device_name, dyn_code, dyn_expire, static_pw_enabled}
// 客户端（PC）登录成功后调用；手机控制端不调用（无被控语义）
func (s *Server) handleRCDeviceRegister(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		InstallUUID string `json:"install_uuid"`
		DeviceName  string `json:"device_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !rcInstallUUIDRe.MatchString(body.InstallUUID) {
		driveFail(w, http.StatusBadRequest, "安装标识无效")
		return
	}
	name := strings.TrimSpace(body.DeviceName)
	if len([]rune(name)) > 64 {
		name = string([]rune(name)[:64])
	}
	dev, err := rcEnsureDevice(username, body.InstallUUID, name)
	if err != nil {
		driveFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	rcWriteJSON(w, map[string]interface{}{
		"device_id":         dev.DeviceID,
		"device_name":       dev.DeviceName,
		"dyn_code":          dev.DynCode,
		"dyn_expire":        dev.DynExpire.Unix(),
		"static_pw_enabled": dev.StaticPWHash != "",
	})
}

// handleRCDeviceMy 我的设备列表 GET /api/rc/device/my?username=xxx
// 返回本账号全部已注册设备（含在线状态：归属账号 PC 端在线=在线）与动态码
func (s *Server) handleRCDeviceMy(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var devs []model.Device
	store.DB.Where("username = ?", username).Order("id asc").Find(&devs)
	items := make([]map[string]interface{}, 0, len(devs))
	online := s.hub.HasPC(username)
	for _, d := range devs {
		code := d.DynCode
		expire := d.DynExpire
		// 在线设备的动态码惰性刷新（离线设备保留旧码，重连后由 register 刷新）
		if online {
			tmp := d
			code = rcEnsureDynCode(&tmp)
			expire = tmp.DynExpire
		}
		items = append(items, map[string]interface{}{
			"device_id":         d.DeviceID,
			"device_name":       d.DeviceName,
			"online":            online,
			"dyn_code":          code,
			"dyn_expire":        expire.Unix(),
			"static_pw_enabled": d.StaticPWHash != "",
			"last_seen":         d.LastSeen.Unix(),
		})
	}
	rcWriteJSON(w, map[string]interface{}{"items": items})
}

// handleRCStaticPW 设置/清除静态访问密码 POST /api/rc/device/static_pw?username=xxx
// 入参 {install_uuid, password}；password 空=清除静态密码。服务端 hashPassword（bcrypt）存 hash，存量 sha256 校验通过时惰性升级（与账号密码同水位）
func (s *Server) handleRCStaticPW(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		InstallUUID string `json:"install_uuid"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	var dev model.Device
	if err := store.DB.Where("username = ? AND install_uuid = ?", username, body.InstallUUID).First(&dev).Error; err != nil {
		driveFail(w, http.StatusBadRequest, "设备未注册")
		return
	}
	pw := body.Password
	if pw == "" {
		store.DB.Model(&model.Device{}).Where("id = ?", dev.ID).Update("static_pw_hash", "")
		rcWriteJSON(w, map[string]interface{}{"ok": true, "static_pw_enabled": false})
		return
	}
	if len(pw) < rcStaticPWMinLen() || !rcCodeRe.MatchString(pw) {
		driveFail(w, http.StatusBadRequest, "访问密码需为 "+strconv.Itoa(rcStaticPWMinLen())+"-32 位字母或数字")
		return
	}
	store.DB.Model(&model.Device{}).Where("id = ?", dev.ID).Update("static_pw_hash", hashPassword(pw))
	rcWriteJSON(w, map[string]interface{}{"ok": true, "static_pw_enabled": true})
}

func rcStaticPWMinLen() int {
	if CfgRC.StaticPWMinLen >= 4 {
		return CfgRC.StaticPWMinLen
	}
	return 6
}

// handleRCRefreshCode 立即刷新动态码 POST /api/rc/device/refresh_code?username=xxx
// 入参 {install_uuid}；返回新码（面板"刷新验证码"按钮）
func (s *Server) handleRCRefreshCode(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		InstallUUID string `json:"install_uuid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	var dev model.Device
	if err := store.DB.Where("username = ? AND install_uuid = ?", username, body.InstallUUID).First(&dev).Error; err != nil {
		driveFail(w, http.StatusBadRequest, "设备未注册")
		return
	}
	// 强制过期重生成
	store.DB.Model(&model.Device{}).Where("id = ?", dev.ID).Update("dyn_expire", time.Now().Add(-time.Second))
	dev.DynExpire = time.Now().Add(-time.Second)
	code := rcEnsureDynCode(&dev)
	rcWriteJSON(w, map[string]interface{}{"dyn_code": code, "dyn_expire": dev.DynExpire.Unix()})
}

// handleRCRecords 远程控制历史话单 GET /api/rc/records?username=xxx
// 仅 Mode=rc 话单（好友协助历史归 remote.go 旧链路），按时间倒序最多 200 条
func (s *Server) handleRCRecords(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var logs []model.RemoteLog
	store.DB.Where("mode = ? AND (requester = ? OR peer = ?)", "rc", username, username).
		Order("id desc").Limit(200).Find(&logs)
	items := make([]map[string]interface{}, 0, len(logs))
	for _, l := range logs {
		items = append(items, map[string]interface{}{
			"session_id":  l.SessionID,
			"requester":   l.Requester,
			"peer":        l.Peer,
			"device_id":   l.DeviceID,
			"status":      l.Status,
			"duration":    l.Duration,
			"create_time": l.CreateTime.Unix(),
		})
	}
	rcWriteJSON(w, map[string]interface{}{"items": items})
}

// rcWriteJSON JSON 响应归口（成功帧统一 ok:true）
func rcWriteJSON(w http.ResponseWriter, data map[string]interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// ===== 阶段二百六十二：信任名单 / 自定义远程卡片 / 历史访问（一键直连配套） =====

// rcTrusted 信任对查询归口：controller 是否获 owner 的 device 免码直连信任
func rcTrusted(owner, deviceID, controller string) bool {
	var cnt int64
	store.DB.Model(&model.RemoteTrust{}).Where("owner_username = ? AND device_id = ? AND controller_username = ?",
		owner, deviceID, controller).Count(&cnt)
	return cnt > 0
}

// rcDevicesByID 批量取设备行归口（ids 顺序无关），返回 map[device_id]Device
func rcDevicesByID(ids []string) map[string]model.Device {
	out := make(map[string]model.Device, len(ids))
	if len(ids) == 0 {
		return out
	}
	var devs []model.Device
	store.DB.Where("device_id IN ?", ids).Find(&devs)
	for _, d := range devs {
		out[d.DeviceID] = d
	}
	return out
}

// handleRCTrustList 信任名单 GET /api/rc/trust?username=xxx
// 返回本人全部设备的信任记录（谁可免码控制我的哪台设备），被控端面板"信任名单"按钮数据源
func (s *Server) handleRCTrustList(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var trusts []model.RemoteTrust
	store.DB.Where("owner_username = ?", username).Order("id desc").Limit(200).Find(&trusts)
	ids := make([]string, 0, len(trusts))
	for _, t := range trusts {
		ids = append(ids, t.DeviceID)
	}
	devMap := rcDevicesByID(ids)
	items := make([]map[string]interface{}, 0, len(trusts))
	for _, t := range trusts {
		items = append(items, map[string]interface{}{
			"device_id":   t.DeviceID,
			"device_name": devMap[t.DeviceID].DeviceName,
			"controller":  t.ControllerUsername,
			"create_time": t.CreateTime.Unix(),
		})
	}
	rcWriteJSON(w, map[string]interface{}{"items": items})
}

// handleRCTrustRemove 移除信任 POST /api/rc/trust/remove?username=xxx
// 入参 {device_id, controller}；仅设备归属账号可移除（归属校验，防冒名删他人信任），移除即时生效
func (s *Server) handleRCTrustRemove(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		DeviceID   string `json:"device_id"`
		Controller string `json:"controller"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !rcDeviceIDRe.MatchString(body.DeviceID) || !driveUsernameRe.MatchString(body.Controller) {
		driveFail(w, http.StatusBadRequest, "参数格式错误")
		return
	}
	// 归属校验：仅设备主人可移除信任
	var cnt int64
	store.DB.Model(&model.Device{}).Where("username = ? AND device_id = ?", username, body.DeviceID).Count(&cnt)
	if cnt == 0 {
		driveFail(w, http.StatusForbidden, "仅设备主人可管理信任名单")
		return
	}
	store.DB.Where("owner_username = ? AND device_id = ? AND controller_username = ?",
		username, body.DeviceID, body.Controller).Delete(&model.RemoteTrust{})
	rcWriteJSON(w, map[string]interface{}{"ok": true})
}

// handleRCCardList 我的远程卡片 GET /api/rc/card/list?username=xxx
// 返回卡片+目标设备实时信息（设备名/账号级在线/是否已信任），点击卡片直连或引导输码
func (s *Server) handleRCCardList(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var cards []model.RemoteCard
	store.DB.Where("username = ?", username).Order("id desc").Limit(50).Find(&cards)
	ids := make([]string, 0, len(cards))
	for _, c := range cards {
		ids = append(ids, c.DeviceID)
	}
	devMap := rcDevicesByID(ids)
	items := make([]map[string]interface{}, 0, len(cards))
	for _, c := range cards {
		dev, ok := devMap[c.DeviceID]
		item := map[string]interface{}{
			"device_id":   c.DeviceID,
			"remark":      c.Remark,
			"create_time": c.CreateTime.Unix(),
			"device_name": "",
			"online":      false,
			"trusted":     false,
		}
		if ok {
			item["device_name"] = dev.DeviceName
			item["online"] = s.hub.HasPC(dev.Username) // 在线为账号级（多 PC 账号以主账号 PC 登录为准）
			item["trusted"] = rcTrusted(dev.Username, c.DeviceID, username)
		}
		items = append(items, item)
	}
	rcWriteJSON(w, map[string]interface{}{"items": items})
}

// handleRCCardAdd 添加/更新卡片 POST /api/rc/card/add?username=xxx
// 入参 {device_id, remark}；设备须已注册（跨账号连接目标）；同 device_id 重复添加=改备注；
// 每账号上限 50 张防滥用。仅存 ID+备注不存凭据（凭据走信任机制）
func (s *Server) handleRCCardAdd(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		DeviceID string `json:"device_id"`
		Remark   string `json:"remark"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	body.DeviceID = strings.TrimSpace(body.DeviceID)
	body.Remark = strings.TrimSpace(body.Remark)
	if !rcDeviceIDRe.MatchString(body.DeviceID) {
		driveFail(w, http.StatusBadRequest, "设备ID格式无效（9-10 位数字）")
		return
	}
	if len([]rune(body.Remark)) > 32 {
		driveFail(w, http.StatusBadRequest, "备注最多 32 个字")
		return
	}
	var dev model.Device
	if err := store.DB.Where("device_id = ?", body.DeviceID).First(&dev).Error; err != nil {
		driveFail(w, http.StatusBadRequest, "设备不存在或未注册")
		return
	}
	var cnt int64
	store.DB.Model(&model.RemoteCard{}).Where("username = ?", username).Count(&cnt)
	var card model.RemoteCard
	err := store.DB.Where("username = ? AND device_id = ?", username, body.DeviceID).First(&card).Error
	if err == nil {
		// 同设备重复添加：更新备注（upsert 语义）
		store.DB.Model(&model.RemoteCard{}).Where("id = ?", card.ID).Update("remark", body.Remark)
		rcWriteJSON(w, map[string]interface{}{"ok": true, "updated": true})
		return
	}
	if cnt >= 50 {
		driveFail(w, http.StatusBadRequest, "卡片数量已达上限（50 张）")
		return
	}
	store.DB.Create(&model.RemoteCard{Username: username, DeviceID: body.DeviceID, Remark: body.Remark})
	rcWriteJSON(w, map[string]interface{}{"ok": true})
}

// handleRCCardRemove 删除卡片 POST /api/rc/card/remove?username=xxx
// 入参 {device_id}；仅卡片主人可删（where 带 username 双保险）
func (s *Server) handleRCCardRemove(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !rcDeviceIDRe.MatchString(body.DeviceID) {
		driveFail(w, http.StatusBadRequest, "参数格式错误")
		return
	}
	store.DB.Where("username = ? AND device_id = ?", username, body.DeviceID).Delete(&model.RemoteCard{})
	rcWriteJSON(w, map[string]interface{}{"ok": true})
}

// handleRCVisits 历史访问 GET /api/rc/visits?username=xxx
// 派生查询无新表：im_remote_log 中我作为控制方成功接通的 rc 会话按设备去重（最后时间倒序
// 最多 50 台），补设备名/账号级在线/信任标记——面板"历史访问"区块一键重连数据源
func (s *Server) handleRCVisits(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	type visitRow struct {
		DeviceID string    `gorm:"column:device_id"`
		LastTime time.Time `gorm:"column:last_time"`
		Times    int64     `gorm:"column:times"`
	}
	var rows []visitRow
	store.DB.Model(&model.RemoteLog{}).
		Select("device_id, MAX(create_time) AS last_time, COUNT(*) AS times").
		Where("mode = ? AND requester = ? AND status = ? AND device_id <> ''", "rc", username, "connected").
		Group("device_id").Order("last_time desc").Limit(50).Scan(&rows)
	ids := make([]string, 0, len(rows))
	for _, v := range rows {
		ids = append(ids, v.DeviceID)
	}
	devMap := rcDevicesByID(ids)
	items := make([]map[string]interface{}, 0, len(rows))
	for _, v := range rows {
		dev, ok := devMap[v.DeviceID]
		item := map[string]interface{}{
			"device_id":   v.DeviceID,
			"last_time":   v.LastTime.Unix(),
			"times":       v.Times,
			"device_name": "",
			"online":      false,
			"trusted":     false,
		}
		if ok {
			item["device_name"] = dev.DeviceName
			item["online"] = s.hub.HasPC(dev.Username)
			item["trusted"] = rcTrusted(dev.Username, v.DeviceID, username)
		}
		items = append(items, item)
	}
	rcWriteJSON(w, map[string]interface{}{"items": items})
}
