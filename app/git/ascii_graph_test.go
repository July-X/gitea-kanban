package git

import (
	"os"
	"os/exec"
	"path/filepath"
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
