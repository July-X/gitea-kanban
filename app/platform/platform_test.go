package platform

import "testing"

func TestIsValid(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"gitea", true},
		{"github", true},
		{"", false},
		{"gitlab", false},
		{"GITEA", false}, // 大小写敏感
	}
	for _, c := range cases {
		if got := IsValid(c.value); got != c.want {
			t.Errorf("IsValid(%q) = %v, want %v", c.value, got, c.want)
		}
	}
}

func TestDefault(t *testing.T) {
	if d := Default(); d != Gitea {
		t.Errorf("Default() = %q, want %q", d, Gitea)
	}
}
