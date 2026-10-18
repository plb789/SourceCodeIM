// vipip_test.go —— 虚拟 IP 内存池单元测试（设计文档 §10 验收项的自动化部分：
// MAC 映射可逆、分配唯一/多端沿用/释放复用/预留跳过、社区名格式纯数字）
package server

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"im-server/model"
	"im-server/store"
)

// newTestPool 构建测试池（绕过 store.DB——内存池只消费 store.VipPool 种子）
func newTestPool(t *testing.T) *vipPool {
	t.Helper()
	seed := &store.VipPoolSeed{
		IPs:      []string{"10.28.1.1", "10.28.1.2", "10.28.1.3"},
		Reserved: map[string]bool{"10.28.1.2": true},
		Base:     vipIPToU32("10.28.1.1"),
		Size:     3,
		Gateway:  "10.28.0.1",
		Mask:     "255.255.0.0",
	}
	old := store.VipPool
	store.VipPool = seed
	t.Cleanup(func() { store.VipPool = old })
	return newVipPool(nil)
}

// TestVipMacOf MAC 与 IP 同生映射：02:00:0A:1C:AA:BB（IP 四字节逐段 hex 编码——第二字节 28
// 十进制 = 0x1C，MAC 段必须为合法 hex，故 10.28 前缀编码为 0A:1C 而非字面 "10:28"）
func TestVipMacOf(t *testing.T) {
	cases := map[string]string{
		"10.28.1.5":     "02:00:0A:1C:01:05",
		"10.28.255.254": "02:00:0A:1C:FF:FE",
	}
	for ip, want := range cases {
		if got := vipMacOf(ip); got != want {
			t.Errorf("vipMacOf(%s) = %s, want %s", ip, got, want)
		}
	}
	if got := vipMacOf("not-an-ip"); got != "" {
		t.Errorf("非法 IP 应返回空串，got %s", got)
	}
}

// TestVipPoolAllocRelease 分配唯一 → 多端沿用同租约 → 释放回池 → 复用；预留位永不分配
// 池容量 3（10.28.1.1~1.3，其中 1.2 预留）→ 可分配仅 2 个
func TestVipPoolAllocRelease(t *testing.T) {
	p := newTestPool(t)

	l1, err := p.Alloc("alice")
	if err != nil || l1.IP == "" {
		t.Fatalf("首次分配失败: %v", err)
	}
	if l1.IP == "10.28.1.2" {
		t.Fatalf("预留位被分配: %s", l1.IP)
	}
	if l1.MAC != vipMacOf(l1.IP) {
		t.Errorf("租约 MAC 与 IP 不配套: %s/%s", l1.IP, l1.MAC)
	}
	// 多端第二设备：沿用同一 IP
	l1b, _ := p.Alloc("alice")
	if l1b.IP != l1.IP {
		t.Errorf("多端登录应沿用同 IP: %s != %s", l1b.IP, l1.IP)
	}
	// 第二用户分配不同 IP，且不得命中预留位 10.28.1.2
	l2, err := p.Alloc("bob")
	if err != nil {
		t.Fatalf("第二用户分配失败: %v", err)
	}
	if l2.IP == l1.IP || l2.IP == "10.28.1.2" {
		t.Errorf("分配重复或命中预留位: %s", l2.IP)
	}
	// 可分配仅 2 个（3 减 1 预留）→ 第三用户即耗尽
	if _, err := p.Alloc("carol"); err != errVipExhausted {
		t.Errorf("池耗尽应返回 errVipExhausted, got %v", err)
	}
	// alice 全设备下线释放 → dave 复用其 IP；bob 仍占用
	p.Release("alice")
	l4, err := p.Alloc("dave")
	if err != nil || l4.IP != l1.IP {
		t.Errorf("释放后应复用 IP %s, got %s err %v", l1.IP, l4.IP, err)
	}
	st := p.Stats()
	if st.Used != 2 || st.Free != 0 || st.Reserved != 1 || st.Total != 3 {
		t.Errorf("统计不符: %+v", st)
	}
	// 未绑定用户释放 no-op 不增空闲（防重复释放双 push）
	p.Release("nobody")
	if got := p.Stats(); got.Free != 0 {
		t.Errorf("no-op 释放不得改变空闲数: %+v", got)
	}
}

// TestVipPoolBypass 旁路态（种子 nil）：分配返回空租约无错误，统计恒零
func TestVipPoolBypass(t *testing.T) {
	old := store.VipPool
	store.VipPool = nil
	t.Cleanup(func() { store.VipPool = old })
	p := newVipPool(nil)
	if p.enabled {
		t.Fatal("种子为 nil 应为旁路态")
	}
	l, err := p.Alloc("alice")
	if err != nil || l.IP != "" {
		t.Errorf("旁路态应返回空租约无错误: %+v %v", l, err)
	}
	if got := p.Supernodes(); got == nil || len(got) != 0 {
		t.Errorf("旁路态 Supernodes 应为空数组: %v", got)
	}
}

// TestVipStaticBind 静态绑定全语义（设计 §8.4）：绑定独占/登录优先/下线保留/重上线回原 IP/
// 解绑回池/换绑释放旧 IP/冲突拒绝
func TestVipStaticBind(t *testing.T) {
	p := newTestPool(t) // 池 3 地址：1.1/1.3 可分配，1.2 预留

	// 绑定 1.1 → alice（空闲 IP 预绑：Check 无旧绑定 → Apply 移出空闲栈）
	if old, err := p.CheckBind("10.28.1.1", "alice"); err != nil || old != "" {
		t.Fatalf("首次绑定校验失败: old=%s err=%v", old, err)
	} else {
		p.ApplyBind("10.28.1.1", "alice", old)
	}
	// alice 登录直接拿绑定 IP
	if l, err := p.Alloc("alice"); err != nil || l.IP != "10.28.1.1" {
		t.Fatalf("绑定用户登录应拿绑定 IP: %+v err=%v", l, err)
	}
	// bob 动态分配不得命中 1.1（已出栈独占）
	l2, err := p.Alloc("bob")
	if err != nil || l2.IP == "10.28.1.1" || l2.IP == "10.28.1.2" {
		t.Fatalf("动态分配命中绑定/预留位: %+v", l2)
	}
	// 可分配仅剩 0 个 → carol 耗尽
	if _, err := p.Alloc("carol"); err != errVipExhausted {
		t.Fatalf("应耗尽, got %v", err)
	}
	// alice 全设备下线：绑定 IP 不回池（独占保留）
	p.Release("alice")
	if _, err := p.Alloc("dave"); err != errVipExhausted {
		t.Fatalf("绑定 IP 下线后不得回池, got %v", err)
	}
	// alice 重上线即回绑定 IP
	if l, _ := p.Alloc("alice"); l.IP != "10.28.1.1" {
		t.Fatalf("重上线应回绑定 IP, got %s", l.IP)
	}
	// 冲突拒绝：绑定已绑他人的 IP
	if _, err := p.CheckBind("10.28.1.1", "bob"); err == nil {
		t.Fatal("绑定他人绑定 IP 应被拒绝")
	}
	// 在线占用中解绑：IP 不立即回池（owner 占用），下线后经动态分支回池
	if u, err := p.CheckUnbind("10.28.1.1"); err != nil || u != "alice" {
		t.Fatalf("解绑校验失败: %s %v", u, err)
	}
	p.ApplyUnbind("10.28.1.1") // alice 仍在线占用 → 不回池
	if _, err := p.Alloc("carol"); err != errVipExhausted {
		t.Fatal("在线占用中解绑不得立即回池")
	}
	p.Release("alice") // 下线：static 映射已删 → 动态分支回池
	lc, err := p.Alloc("carol")
	if err != nil || lc.IP != "10.28.1.1" {
		t.Fatalf("解绑+下线后 1.1 应回池被动态分配: %+v err=%v", lc, err)
	}
	// 换绑序列：bob 先下线（1.3 回池）→ alice 绑 1.3 → 再改绑 1.1 → 旧 IP 1.3 回池（泄漏防护）
	p.Release("bob")
	if old, err := p.CheckBind("10.28.1.3", "alice"); err != nil || old != "" {
		t.Fatalf("绑定 1.3 校验失败: old=%s err=%v", old, err)
	} else {
		p.ApplyBind("10.28.1.3", "alice", old)
	}
	// carol 先下线释放 1.1（否则被其动态占用，换绑被拒）
	p.Release("carol")
	if old, err := p.CheckBind("10.28.1.1", "alice"); err != nil || old != "10.28.1.3" {
		t.Fatalf("换绑应返回旧绑定 1.3: old=%s err=%v", old, err)
	} else {
		p.ApplyBind("10.28.1.1", "alice", old)
	}
	// 换绑泄漏防护：旧 IP 1.3 已回池（无在线占用），可被动态分配
	ld, err := p.Alloc("dave")
	if err != nil || ld.IP != "10.28.1.3" {
		t.Fatalf("换绑后旧 IP 1.3 应回池复用: %+v err=%v", ld, err)
	}
	// 当前态：alice 静态绑 1.1（离线保留——绑定 IP 出栈，Free 不含它）、dave 动态占 1.3、1.2 纯预留
	// 口径：Used=在线占用+绑定未在线=2；Free=0（仅剩预留位不入栈）；Reserved=纯预留=1
	st := p.Stats()
	if st.Used != 2 || st.Free != 0 || st.Reserved != 1 {
		t.Fatalf("统计不符: %+v", st)
	}
	// 绑定列表含 alice 条目（未在线）
	bs := p.Bindings()
	if len(bs) != 1 || bs[0].IP != "10.28.1.1" || bs[0].Username != "alice" || bs[0].Online {
		t.Fatalf("绑定列表不符: %+v", bs)
	}
	// 解绑（离线态）：绑定列表清空（1.1 已在上一步回池，统计不变）
	if u, err := p.CheckUnbind("10.28.1.1"); err != nil || u != "alice" {
		t.Fatalf("解绑校验失败: %s %v", u, err)
	}
	p.ApplyUnbind("10.28.1.1")
	if b := p.Bindings(); len(b) != 0 {
		t.Fatalf("解绑后绑定列表应为空: %+v", b)
	}
	// 解绑后 1.1 回池：Used=1（dave 1.3）、Free=1（1.1）、Reserved=1（1.2）
	if st := p.Stats(); st.Used != 1 || st.Free != 1 || st.Reserved != 1 {
		t.Fatalf("解绑后统计不符: %+v", st)
	}
}

// TestClaimCommunityFormat 社区名/密钥格式（-c 5 位纯数字 10000~99999 / -k 6 位纯数字 100000~999999）
func TestClaimCommunityFormat(t *testing.T) {
	re5 := regexp.MustCompile(`^\d{5}$`)
	re6 := regexp.MustCompile(`^\d{6}$`)
	for i := 0; i < 50; i++ {
		comm, err := vipRandDigits(10000, 99999)
		if err != nil || !re5.MatchString(comm) {
			t.Fatalf("社区名格式不符: %s err %v", comm, err)
		}
		key, err := vipRandDigits(100000, 999999)
		if err != nil || !re6.MatchString(key) {
			t.Fatalf("密钥格式不符: %s err %v", key, err)
		}
	}
	_ = context.Background()
}

// TestVipSupValidate supernode 候选校验：host:port 格式/多行逗号混排归一/去重/非法拒绝/空串清空
func TestVipSupValidate(t *testing.T) {
	norm, err := vipSupValidate("1.2.3.4:7654\nsupernode.example.com:7654, 1.2.3.4:7654")
	if err != nil || norm != "1.2.3.4:7654,supernode.example.com:7654" {
		t.Fatalf("归一结果不符: %s err %v", norm, err)
	}
	for _, bad := range []string{"1.2.3.4", "1.2.3.4:", ":7654", "1.2.3.4:0", "1.2.3.4:99999", "ht tp:7654", "a[b.com:7654"} {
		if _, err := vipSupValidate(bad); err == nil {
			t.Errorf("非法候选应被拒绝: %q", bad)
		}
	}
	// 总长超限对齐 KV 列容量（varchar(512)）：254 字节 host × 2 条 + 逗号 > 512
	long := strings.Repeat("a", 254) + ":7654"
	if _, err := vipSupValidate(long + "," + long); err == nil {
		t.Error("候选总长超限应被拒绝")
	}
	if norm, err := vipSupValidate(""); err != nil || norm != "" {
		t.Fatalf("空串应清空: %s err %v", norm, err)
	}
}

// TestVipSupHotUpdate supernode 候选热更轮转（需 DB——AgentWhitelist KV 行，测后清理+重置内存态）：
// 未接管=config 兜底 → Set 接管 → 清空=显式空（不回退 config，接管标记语义）→ 模拟重启保持空态
func TestVipSupHotUpdate(t *testing.T) {
	if err := store.DB.AutoMigrate(&model.AgentWhitelist{}); err != nil {
		t.Skip("无库环境跳过")
	}
	defer func() {
		store.DB.Where("kind = ?", vipSupKind).Delete(&model.AgentWhitelist{})
		// 重置懒初始化态：防残留接管状态影响同包其他测试（vipSup 为包级单例）
		vipSupMu.Lock()
		vipSupKnow, vipSupRow, vipSupRaw = false, false, ""
		vipSupMu.Unlock()
	}()
	// 重置懒初始化态并注入 config 兜底（模拟启动后未接管）
	vipSupMu.Lock()
	vipSupKnow, vipSupRow, vipSupRaw = false, false, ""
	vipSupFb = []string{"10.0.0.1:7654"}
	vipSupMu.Unlock()

	// 1. 未接管：config 兜底生效
	if l := vipSupList(); len(l) != 1 || l[0] != "10.0.0.1:7654" {
		t.Fatalf("未接管应回退 config 兜底: %v", l)
	}
	// 2. 后台保存 → 接管，热更值生效
	if err := vipSupSet("5.6.7.8:7654"); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if l := vipSupList(); len(l) != 1 || l[0] != "5.6.7.8:7654" {
		t.Fatalf("接管后应热更生效: %v", l)
	}
	// 3. 清空（DB 行存在且空）：显式空，不回退 config 兜底（接管标记语义）
	if err := vipSupSet(""); err != nil {
		t.Fatalf("清空失败: %v", err)
	}
	if l := vipSupList(); len(l) != 0 {
		t.Fatalf("清空后应显式空不回退兜底: %v", l)
	}
	// 4. 模拟重启（重置内存态，DB 行仍在 value=""）→ 接管空态保持
	vipSupMu.Lock()
	vipSupKnow, vipSupRow, vipSupRaw = false, false, ""
	vipSupMu.Unlock()
	if l := vipSupList(); len(l) != 0 {
		t.Fatalf("重启后接管空态应保持: %v", l)
	}
}
