package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewLocalStore_CreatesDefault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s, err := NewLocalStore(path)
	if err != nil {
		t.Fatalf("NewLocalStore failed: %v", err)
	}

	state := s.Get()
	if state.SchemaVersion != StateSchemaVersion {
		t.Errorf("SchemaVersion = %d, want %d", state.SchemaVersion, StateSchemaVersion)
	}
	if len(state.Accounts) != 0 {
		t.Errorf("Accounts should be empty, got %d", len(state.Accounts))
	}
	if len(state.Users) != 1 || state.Users[0].ID != "local-user" {
		t.Errorf("Users should have 1 local-user seed, got %v", state.Users)
	}
	if state.Prefs == nil {
		t.Error("Prefs should be non-nil map")
	}
}

func TestLocalStore_MutateAndPersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s, err := NewLocalStore(path)
	if err != nil {
		t.Fatalf("NewLocalStore failed: %v", err)
	}

	// 写入一个 account
	err = s.Mutate(func(st *LocalState) {
		st.Accounts = append(st.Accounts, GiteaAccount{
			ID:       "test-1",
			Platform: "gitea",
			GiteaURL: "https://gitea.example.com",
			Username: "alice",
		})
	})
	if err != nil {
		t.Fatalf("Mutate failed: %v", err)
	}

	// 验证文件写盘
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state.json not written: %v", err)
	}

	// 重新加载验证持久化
	s2, err := NewLocalStore(path)
	if err != nil {
		t.Fatalf("reload failed: %v", err)
	}
	state := s2.Get()
	if len(state.Accounts) != 1 {
		t.Fatalf("expected 1 account, got %d", len(state.Accounts))
	}
	if state.Accounts[0].Username != "alice" {
		t.Errorf("Username = %s, want alice", state.Accounts[0].Username)
	}
	if state.Accounts[0].Platform != "gitea" {
		t.Errorf("Platform = %s, want gitea", state.Accounts[0].Platform)
	}
}

func TestLocalStore_Migration_PlatformDefault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	// 写一个无 Platform 字段的旧格式 state.json
	oldJSON := `{
		"schemaVersion": 1,
		"accounts": [{"id":"a1","giteaUrl":"https://g.example.com","username":"bob","createdAt":1000}],
		"users": [],
		"prefs": {},
		"projects": [],
		"columns": [],
		"labelMaps": [],
		"starredBranches": []
	}`
	if err := os.WriteFile(path, []byte(oldJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	s, err := NewLocalStore(path)
	if err != nil {
		t.Fatalf("load old format failed: %v", err)
	}

	state := s.Get()
	if len(state.Accounts) != 1 {
		t.Fatalf("expected 1 account, got %d", len(state.Accounts))
	}
	if state.Accounts[0].Platform != "gitea" {
		t.Errorf("Platform migration failed: got %q, want gitea", state.Accounts[0].Platform)
	}
}

// TestGetWorkspacePath removed in v0.6: workspacePath derives from config.ResolveDataDir;
// WorkspacePathPrefKey + GetWorkspacePath were deleted by ponytail cleanup.
