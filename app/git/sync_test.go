package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
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

func TestRemoteExists(t *testing.T) {
	_, localPath := createBareAndClone(t)

	exists, err := RemoteExists(localPath, "origin")
	if err != nil {
		t.Fatalf("RemoteExists failed: %v", err)
	}
	if !exists {
		t.Error("expected origin remote to exist")
	}

	exists, err = RemoteExists(localPath, "upstream")
	if err != nil {
		t.Fatalf("RemoteExists failed: %v", err)
	}
	if exists {
		t.Error("expected upstream remote to not exist")
	}
}

func TestListRemotes(t *testing.T) {
	_, localPath := createBareAndClone(t)

	remotes, err := ListRemotes(localPath)
	if err != nil {
		t.Fatalf("ListRemotes failed: %v", err)
	}

	if len(remotes) != 1 {
		t.Fatalf("expected 1 remote, got %d", len(remotes))
	}
	if remotes[0].Name != "origin" {
		t.Errorf("remote name = %q, want origin", remotes[0].Name)
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

	// PullRepo（只 fetch + 统计，不 merge）
	result, err := PullRepo(PullOptions{
		LocalPath: localPath,
	})
	if err != nil {
		t.Fatalf("PullRepo failed: %v", err)
	}

	if result.BeforeCount != 1 {
		t.Errorf("BeforeCount = %d, want 1", result.BeforeCount)
	}
	// fetch 后 HEAD 还是旧的（fetch 不 merge），所以 afterCount 可能还是 1
	// 但 fetch 拉取了新 refs，下次 pull/rebase 才会更新 HEAD
	// 这里验证函数不报错 + BeforeCount 正确即可
}
