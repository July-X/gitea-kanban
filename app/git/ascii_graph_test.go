package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunGraphLog(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not found: %v", err)
	}
	dir := t.TempDir()
	runGit(t, dir, "init")
	runGit(t, dir, "config", "user.name", "Test User")
	runGit(t, dir, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "README.md")
	runGit(t, dir, "commit", "-m", "initial commit")

	result, err := RunGraphLog(dir, RunGraphLogOptions{MaxCount: 10})
	if err != nil {
		t.Fatal(err)
	}
	if result.TotalCommits != 1 {
		t.Fatalf("TotalCommits = %d, want 1", result.TotalCommits)
	}
	if got := result.Lines[0].Glyph; got != "* " {
		t.Fatalf("glyph = %q, want %q", got, "* ")
	}
	if result.Lines[0].Commit == nil || result.Lines[0].Commit.Subject != "initial commit" {
		t.Fatalf("commit = %#v", result.Lines[0].Commit)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
}

func TestParseGraphLogOutput(t *testing.T) {
	raw := []byte("* DATA:HEAD -> refs/heads/main, tag: refs/tags/v1.0|abcdef123456|2026-06-26T10:00:00+08:00|abcdef1|1111111 2222222|Alice|alice@example.com|merge feature|with pipe\n" +
		"|\\\n" +
		"| * DATA:refs/remotes/origin/feature|2222222|2026-06-25T10:00:00+08:00|2222222|1111111|Bob|bob@example.com|feature work\n" +
		"| * DATA:|3333333|2026-06-24T10:00:00+08:00|3333333|2222222|Carol|carol@example.com|plain work\n")

	result := parseGraphLogOutput(raw, 2)
	if result.TotalCommits != 3 {
		t.Fatalf("TotalCommits = %d, want 3", result.TotalCommits)
	}
	if !result.Truncated {
		t.Fatalf("Truncated = false, want true")
	}
	if got := len(result.Lines); got != 4 {
		t.Fatalf("len(lines) = %d, want 4", got)
	}
	first := result.Lines[0].Commit
	if first == nil {
		t.Fatalf("first commit is nil")
	}
	if !first.IsMerge {
		t.Fatalf("first IsMerge = false, want true")
	}
	if first.Subject != "merge feature|with pipe" {
		t.Fatalf("subject = %q", first.Subject)
	}
	if len(first.Refs) != 2 {
		t.Fatalf("len(refs) = %d, want 2", len(first.Refs))
	}
	if first.Refs[0].RefGroup != "heads" || first.Refs[0].ShortName != "main" {
		t.Fatalf("first ref = %#v", first.Refs[0])
	}
	if first.Refs[1].RefGroup != "tags" || first.Refs[1].ShortName != "v1.0" {
		t.Fatalf("second ref = %#v", first.Refs[1])
	}
	plain := result.Lines[3].Commit
	if plain == nil {
		t.Fatalf("plain commit is nil")
	}
	if plain.Refs == nil {
		t.Fatalf("plain refs = nil, want empty slice")
	}
	if len(plain.Refs) != 0 {
		t.Fatalf("len(plain refs) = %d, want 0", len(plain.Refs))
	}
	if result.Range.From != "2026-06-24T10:00:00+08:00" || result.Range.To != "2026-06-26T10:00:00+08:00" {
		t.Fatalf("range = %#v", result.Range)
	}
}

func TestParseGraphDecorationsRemote(t *testing.T) {
	refs := parseGraphDecorations("refs/remotes/origin/main, origin/dev")
	if len(refs) != 2 {
		t.Fatalf("len(refs) = %d, want 2", len(refs))
	}
	if refs[0].RefGroup != "remotes" || refs[0].ShortName != "origin/main" {
		t.Fatalf("refs[0] = %#v", refs[0])
	}
	if refs[1].Name != "refs/remotes/origin/dev" || refs[1].ShortName != "origin/dev" {
		t.Fatalf("refs[1] = %#v", refs[1])
	}
}

// TestMaxLineLaneWidth 验证超宽 graph 检测：单行非空格 glyph 数 = 并发 lane 宽度。
// UnrealEngine release 中段单行可达 1407 lane，超过 maxGraphLaneWidth(64) 应触发回退。
func TestMaxLineLaneWidth(t *testing.T) {
	lines := []GraphLine{
		{Row: 0, Glyph: "* "},            // 1 lane
		{Row: 1, Glyph: "|\\  "},         // 2 lane（| + \）
		{Row: 2, Glyph: "* | * | * | *"}, // 7 lane
	}
	if got := maxLineLaneWidth(lines); got != 7 {
		t.Fatalf("maxLineLaneWidth = %d, want 7", got)
	}

	// 模拟 UnrealEngine 超宽行：1407 个非空格字符
	wide := strings.Repeat("*", 1407)
	lines = append(lines, GraphLine{Row: 3, Glyph: wide})
	if got := maxLineLaneWidth(lines); got != 1407 {
		t.Fatalf("maxLineLaneWidth = %d, want 1407", got)
	}
	if maxLineLaneWidth(lines) <= maxGraphLaneWidth {
		t.Fatalf("超宽行应超过阈值 %d，实际 %d", maxGraphLaneWidth, maxLineLaneWidth(lines))
	}
}

// TestRunGraphLogWideFallback 验证超宽 graph 自动回退 --first-parent。
// 构造一条主线 + 大量未合并的分叉分支，让 --graph 单行出现超 64 lane，触发回退。
func TestRunGraphLogWideFallback(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not found: %v", err)
	}
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.name", "Test")
	runGit(t, dir, "config", "user.email", "test@example.com")

	commit := func(msg string) {
		// 每个分支用独立文件避免 merge 冲突
		if err := os.WriteFile(filepath.Join(dir, msg+".txt"), []byte(msg+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		runGit(t, dir, "add", "-A")
		runGit(t, dir, "commit", "-m", msg)
	}

	commit("m1")
	// 开 70 个分叉分支（不合并）：--graph 会把它们画成 70 条并排 lane，单行 lane 数 > 64 触发回退。
	// 不 merge 避免每次 merge 的子进程开销，测试快很多。
	for i := 0; i < 70; i++ { // 70 > maxGraphLaneWidth(64)
		runGit(t, dir, "checkout", "-b", fmt.Sprintf("b%d", i))
		commit(fmt.Sprintf("b%d", i))
		runGit(t, dir, "checkout", "main")
	}
	runGit(t, dir, "checkout", "main")

	result, err := RunGraphLog(dir, RunGraphLogOptions{MaxCount: 200})
	if err != nil {
		t.Fatal(err)
	}
	// 回退后应是 first-parent 单列：每行最多 1-2 个非空格 glyph
	if w := maxLineLaneWidth(result.Lines); w > 3 {
		t.Fatalf("回退后最大 lane 宽度 = %d，应 ≤3（first-parent 单列）", w)
	}
}
