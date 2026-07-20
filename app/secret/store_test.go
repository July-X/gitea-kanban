package secret

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestStore_DevMode_SetGetDelete(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows: file perm 0666 vs 0600（windows 不支持 unix 0600 模式，跳过）")
	}
	dir := t.TempDir()
	store := NewStore(true, dir) // devMode=true

	cred := Credential{
		Platform: "gitea",
		HostURL:  "https://gitea.example.com",
		Username: "alice",
		Token:    "secret-token-123",
	}

	// Set
	if err := store.Set(cred); err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	// 验证文件创建
	files, _ := os.ReadDir(filepath.Join(dir, "dev-tokens"))
	if len(files) != 1 {
		t.Fatalf("expected 1 file in dev-tokens, got %d", len(files))
	}

	// 验证文件权限（0600）
	info, _ := os.Stat(filepath.Join(dir, "dev-tokens", files[0].Name()))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("file permission = %o, want 0600", info.Mode().Perm())
	}

	// Get
	token, err := store.Get("gitea", "https://gitea.example.com", "alice")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if token != "secret-token-123" {
		t.Errorf("token = %q, want 'secret-token-123'", token)
	}

	// Delete
	if err := store.Delete("gitea", "https://gitea.example.com", "alice"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	// 验证删除后 Get 失败
	_, err = store.Get("gitea", "https://gitea.example.com", "alice")
	if err == nil {
		t.Error("expected error after delete")
	}
}

func TestStore_DevMode_GetNotExist(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(true, dir)

	_, err := store.Get("gitea", "https://gitea.example.com", "nonexistent")
	if err == nil {
		t.Error("expected error for non-existent token")
	}
}

func TestStore_DevMode_DeleteNotExist(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(true, dir)

	// 删除不存在的 token 应该幂等成功
	err := store.Delete("gitea", "https://gitea.example.com", "nonexistent")
	if err != nil {
		t.Errorf("delete non-existent should be idempotent, got: %v", err)
	}
}

func TestKeyringService(t *testing.T) {
	got := KeyringService("gitea", "https://gitea.example.com")
	want := "gitea-kanban@https://gitea.example.com"
	if got != want {
		t.Errorf("KeyringService = %q, want %q", got, want)
	}
}

func TestStore_DevMode_GitHub(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(true, dir)

	cred := Credential{
		Platform: "github",
		HostURL:  "https://github.com",
		Username: "octocat",
		Token:    "ghp-token",
	}

	if err := store.Set(cred); err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	token, err := store.Get("github", "https://github.com", "octocat")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if token != "ghp-token" {
		t.Errorf("token = %q, want 'ghp-token'", token)
	}
}
