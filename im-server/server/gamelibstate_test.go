package server

// libStateForView 库状态展示映射单测：待更新（4）映射的命中/豁免矩阵——
// 已安装+版本落后 → 4；其余状态（未安装/下载中/暂停）与空 latest_version（防误报）原样透传

import "testing"

func TestLibStateForView(t *testing.T) {
	cases := []struct {
		name              string
		state             int8
		installed, latest string
		want              int8
	}{
		{"已安装版本落后→待更新", 3, "1.0", "1.1", 4},
		{"已安装版本一致→保持3", 3, "1.1", "1.1", 3},
		{"已安装latest为空→保持3（防误报）", 3, "1.0", "", 3},
		{"已安装installed为空→待更新（版本未知视为可能落后，提示一次后归位）", 3, "", "1.1", 4},
		{"未安装→原样", 0, "", "1.1", 0},
		{"下载中→原样", 1, "1.0", "1.1", 1},
		{"暂停→原样", 2, "1.0", "1.1", 2},
		{"待更新→原样（幂等）", 4, "1.0", "1.1", 4},
	}
	for _, c := range cases {
		if got := libStateForView(c.state, c.installed, c.latest); got != c.want {
			t.Fatalf("[%s] libStateForView(%d,%q,%q)=%d，期望 %d",
				c.name, c.state, c.installed, c.latest, got, c.want)
		}
	}
}
