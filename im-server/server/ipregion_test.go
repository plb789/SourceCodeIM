package server

// IP 属地显示回归测试（displayRegion 纯函数矩阵，零外部环境依赖）
// 数据格式口径（2026-10 实测 24 样本 100% 命中新格式，见 docs/IP属地显示设计方案.md §4.2）：
//   3.x：国家|省份|城市|ISP|国家码（尾段两位大写国家码为判别特征）
//   2.x 旧式：国家|区域|省份|城市|ISP
// 显示口径：国内省-市两级（直辖市/省同市去重）、海外仅国家、内网「内网」、无效空串

import "testing"

func TestDisplayRegion(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		// 3.x 新格式（实测段序：国家|省份|城市|ISP|国家码）
		{"新格式_省市", "中国|江苏省|南京市|0|CN", "江苏省-南京市"},
		{"新格式_省市_ISP中文", "中国|浙江省|杭州市|阿里|CN", "浙江省-杭州市"},
		{"新格式_太原", "中国|山西省|太原市|0|CN", "山西省-太原市"},
		{"新格式_直辖市去重", "中国|北京市|北京市|0|CN", "北京市"},
		{"新格式_直辖市去重_ISP", "中国|上海市|上海市|电信|CN", "上海市"},
		{"新格式_市缺失仅省", "中国|山西省|0|0|CN", "山西省"},
		{"新格式_省缺失空串", "中国|0|0|0|CN", ""},
		// 2.x 旧格式（区域段为 0 或大区）
		{"旧格式_省市", "中国|0|广东省|深圳市|电信", "广东省-深圳市"},
		{"旧格式_市缺失仅省", "中国|0|广东省|0|电信", "广东省"},
		{"旧格式_全零空串", "中国|0|0|0|0", ""},
		// 海外（两种格式均只显示国家，不拼省/州/城市）
		{"海外_旧格式", "美国|0|0|0|0", "美国"},
		{"海外_新格式英文", "United States|California|0|Google LLC|US", "United States"},
		{"海外_新格式带城市", "Australia|Queensland|Brisbane|0|AU", "Australia"},
		{"海外_日文国家", "日本|东京都|东京|0|JP", "日本"},
		// 内网兜底（防御性，正常已被 isPrivateIP 拦截）
		{"内网_旧格式", "0|0|0|内网IP|0", "内网"},
		{"内网_新格式", "中国|0|0|内网IP|CN", "内网"},
		// 异常输入
		{"空串", "", ""},
	}
	for _, c := range cases {
		if got := displayRegion(c.in); got != c.want {
			t.Errorf("displayRegion(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsCountryCode(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"CN", true}, {"US", true}, {"AU", true},
		{"cn", false},  // 小写不命中
		{"CHN", false}, // 三位不命中
		{"C", false},   // 单字符不命中
		{"", false},    // 空串不命中（0 空化后的尾段缺失行回退旧格式分支）
		{"电信", false},  // 中文 ISP 不命中
		{"C1", false},  // 非纯字母不命中
	}
	for _, c := range cases {
		if got := isCountryCode(c.in); got != c.want {
			t.Errorf("isCountryCode(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestIsPrivateIP(t *testing.T) {
	private := []string{"127.0.0.1", "192.168.1.5", "10.0.0.2", "172.16.0.1", "172.31.255.255", "::1", "fe80::1", "fc00::1", "169.254.1.1", "0.0.0.0"}
	public := []string{"8.8.8.8", "114.114.114.114", "223.5.5.5", "2400:3200::1", "2606:4700:4700::1111"}
	for _, ip := range private {
		if !isPrivateIP(ip) {
			t.Errorf("isPrivateIP(%s) = false, want true", ip)
		}
	}
	for _, ip := range public {
		if isPrivateIP(ip) {
			t.Errorf("isPrivateIP(%s) = true, want false", ip)
		}
	}
	// 非法串：ParseIP 失败返回 false（走 searcher 二层 ParseIP 防线）
	if isPrivateIP("not-an-ip") {
		t.Error("isPrivateIP(非法串) = true, want false")
	}
}
