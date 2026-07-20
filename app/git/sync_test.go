package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"gitea-kanban/app/ipc"

	gogit "github.com/go-git/go-git/v5"
)

// createBareAndClone 创建一个 bare 仓库 + clone 到本地，返回本地路径和 bare 路径
func createBareAndClone(t *testing.T) (barePath, localPath string) {
	t.Helper()
	tmpDir := t.TempDir()
	barePath = filepath.Join(tmpDir, "remote.git")
	localPath = filepath.Join(tmpDir, "local")

	// 创建 bare 远程
	runGit := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit(tmpDir, "init", "--bare", "remote.git")

	// 创建源仓库并 push
	srcPath := filepath.Join(tmpDir, "src")
	os.MkdirAll(srcPath, 0o755)
	runGit(srcPath, "init")
	runGit(srcPath, "config", "user.email", "test@test.com")
	runGit(srcPath, "config", "user.name", "Test")
	os.WriteFile(filepath.Join(srcPath, "a.txt"), []byte("a"), 0o644)
	runGit(srcPath, "add", ".")
	runGit(srcPath, "commit", "-m", "C1")
	runGit(srcPath, "remote", "add", "origin", barePath)
	runGit(srcPath, "push", "origin", "master")

	// clone 到 localPath
	cmd := exec.Command("git", "clone", barePath, localPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}

	return barePath, localPath
}

func TestCountCommits(t *testing.T) {
	_, localPath := createBareAndClone(t)

	count, err := CountCommits(localPath)
	if err != nil {
		t.Fatalf("CountCommits failed: %v", err)
	}

	if count != 1 {
		t.Errorf("expected 1 commit, got %d", count)
	}
}

func TestFetchRepo_AlreadyUpToDate(t *testing.T) {
	_, localPath := createBareAndClone(t)

	result, err := FetchRepo(PullOptions{
		LocalPath: localPath,
	})
	if err != nil {
		t.Fatalf("FetchRepo failed: %v", err)
	}

	if result.Updated {
		t.Error("expected Updated=false for already up-to-date repo")
	}
}

func TestFetchRepo_WithNewCommits(t *testing.T) {
	barePath, localPath := createBareAndClone(t)

	// 在 bare 仓库中添加新 commit（通过另一个 clone）
	tmpDir := filepath.Dir(barePath)
	otherClone := filepath.Join(tmpDir, "other")
	cmd := exec.Command("git", "clone", barePath, otherClone)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = otherClone
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")
	os.WriteFile(filepath.Join(otherClone, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "C2")
	runGit("push", "origin", "master")

	// 现在 fetch localPath 应该有更新
	result, err := FetchRepo(PullOptions{
		LocalPath: localPath,
	})
	if err != nil {
		t.Fatalf("FetchRepo failed: %v", err)
	}
	if !result.Updated {
		t.Error("expected Updated=true after new commits pushed")
	}
}

func TestPullRepo(t *testing.T) {
	barePath, localPath := createBareAndClone(t)

	// 先在 remote 添加一个 commit
	tmpDir := filepath.Dir(barePath)
	otherClone := filepath.Join(tmpDir, "other2")
	cmd := exec.Command("git", "clone", barePath, otherClone)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = otherClone
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")
	os.WriteFile(filepath.Join(otherClone, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "C2-pull")
	runGit("push", "origin", "master")

	// PullRepo（v2.4 适配 NoCheckout：fetch + 更新 HEAD 指向新 commit + 统计）
	result, err := PullRepo(PullOptions{
		LocalPath: localPath,
	})
	if err != nil {
		t.Fatalf("PullRepo failed: %v", err)
	}

	if result.BeforeCount != 1 {
		t.Errorf("BeforeCount = %d, want 1 (old HEAD)", result.BeforeCount)
	}
	if result.AfterCount != 2 {
		t.Errorf("AfterCount = %d, want 2 (new HEAD includes both C1 + C2-pull)", result.AfterCount)
	}
	if result.AddedCommits != 1 {
		t.Errorf("AddedCommits = %d, want 1", result.AddedCommits)
	}
	if !result.HeadChanged {
		t.Error("HeadChanged should be true after pulling new commits")
	}
	if result.HeadBefore == result.HeadAfter {
		t.Errorf("HeadBefore == HeadAfter (%q), should differ", result.HeadBefore)
	}
}

func TestPullRepo_RepairsMissingHeadTarget(t *testing.T) {
	barePath, _ := createBareAndClone(t)
	localPath := filepath.Join(t.TempDir(), "partial.git")

	runGit := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit(t.TempDir(), "init", "--bare", localPath)
	runGit(localPath, "remote", "add", "origin", barePath)

	result, err := PullRepo(PullOptions{LocalPath: localPath})
	if err != nil {
		t.Fatalf("PullRepo failed: %v", err)
	}
	if result.BeforeCount != 0 {
		t.Errorf("BeforeCount = %d, want 0", result.BeforeCount)
	}
	if result.AfterCount != 1 {
		t.Errorf("AfterCount = %d, want 1", result.AfterCount)
	}

	count, err := CountCommits(localPath)
	if err != nil {
		t.Fatalf("CountCommits after repair failed: %v", err)
	}
	if count != 1 {
		t.Errorf("CountCommits after repair = %d, want 1", count)
	}
}

func TestCountCommitsWithLimit_TreatsShallowBoundaryAsStop(t *testing.T) {
	tmpDir := t.TempDir()
	remotePath := filepath.Join(tmpDir, "remote.git")
	srcPath := filepath.Join(tmpDir, "src")
	localPath := filepath.Join(tmpDir, "local")

	runGit := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit(tmpDir, "init", "--bare", "remote.git")
	os.MkdirAll(srcPath, 0o755)
	runGit(srcPath, "init")
	runGit(srcPath, "config", "user.email", "test@test.com")
	runGit(srcPath, "config", "user.name", "Test")
	runGit(srcPath, "remote", "add", "origin", remotePath)
	for i := 1; i <= 3; i++ {
		if err := os.WriteFile(filepath.Join(srcPath, "a.txt"), []byte{byte('0' + i)}, 0o644); err != nil {
			t.Fatal(err)
		}
		runGit(srcPath, "add", ".")
		runGit(srcPath, "commit", "-m", "C"+string(rune('0'+i)))
	}
	runGit(srcPath, "push", "origin", "master")

	runGit(tmpDir, "clone", "--depth=1", "file://"+remotePath, localPath)

	repo, err := gogit.PlainOpen(localPath)
	if err != nil {
		t.Fatalf("PlainOpen failed: %v", err)
	}
	head, err := repo.Head()
	if err != nil {
		t.Fatalf("Head failed: %v", err)
	}

	count, err := countCommitsWithLimit(repo, head.Hash(), 5000)
	if err != nil {
		t.Fatalf("countCommitsWithLimit failed: %v", err)
	}
	if count != 1 {
		t.Fatalf("countCommitsWithLimit = %d, want 1", count)
	}
}

// TestFetchWithFilter_GhNotInstalled v0.7.20 回归测试：
//
//   - gh 未安装时 FetchWithFilter 返回 *ipc.IpcError{Code: "gh_not_installed"}
//   - 前端捕获后展示"打开安装页"按钮
//
// 测试方法：临时清空 PATH 中的 gh（通过 t.Setenv 隔离，不影响主进程）
func TestFetchWithFilter_GhNotInstalled(t *testing.T) {
	barePath, localPath := createBareAndClone(t)
	origPath := os.Getenv("PATH")
	cleanPath := "/usr/bin:/bin"
	t.Setenv("PATH", cleanPath)

	if _, err := exec.LookPath("gh"); err == nil {
		t.Skip("gh is in PATH even after clearing it, cannot test gh-not-found path")
	}

	err := FetchWithFilter(localPath, 0, "")
	if err == nil {
		t.Fatal("FetchWithFilter should return error when gh is not found")
	}

	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("expected *ipc.IpcError, got %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeGhNotInstalled {
		t.Errorf("error code = %q, want %q", ipcErr.Code, ipc.CodeGhNotInstalled)
	}
	if ipcErr.Message == "" {
		t.Error("error message should not be empty")
	}
	if ipcErr.Hint == "" {
		t.Error("error hint should not be empty")
	}

	t.Cleanup(func() { os.Setenv("PATH", origPath) })
	_ = barePath
}
