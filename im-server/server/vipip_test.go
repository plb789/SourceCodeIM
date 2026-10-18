// vipip_test.go —— 虚拟 IP 内存池单元测试（设计文档 §10 验收项的自动化部分：
// MAC 映射可逆、分配唯一/多端沿用/释放复用/预留跳过、社区名格式纯数字）
package server

import (
	"context"
	"regexp"
	"testing"

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
