package server

import (
	"strings"
	"testing"
)

func TestWsProjValidName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"my-repo", true},
		{"cheshi", true},
		{"a_b.c", true},
		{"", false},
		{"../evil", false},
		{"a/b", false},
		{`a\b`, false},
		{"C:", false},
		{"..", false},
		{strings.Repeat("x", 101), false},
	}
	for _, c := range cases {
		if got := wsProjValidName(c.name); got != c.ok {
			t.Errorf("wsProjValidName(%q) = %v, want %v", c.name, got, c.ok)
		}
	}
}

func TestWsProjNameFromContent(t *testing.T) {
	if v := wsProjNameFromContent("proj_open", `{"proj":"demo"}`); v != "demo" {
		t.Errorf("proj_open = %q, want demo", v)
	}
	if v := wsProjNameFromContent("proj_clone", `{"name":"repo","url":"https://x"}`); v != "repo" {
		t.Errorf("proj_clone = %q, want repo", v)
	}
	if v := wsProjNameFromContent("proj_clone", `{}`); v != "" {
		t.Errorf("empty = %q, want empty", v)
	}
}
