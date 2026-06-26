package main

import (
	"context"
	"testing"

	"gitea-kanban/app/store"
)

func TestApp_GetUserPrefs_All(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// 写入 2 个 prefs
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Prefs["theme"] = "dark"
		s.Prefs["pollingMinutes"] = 5
	})

	// 不传 keys → 返全部
	got, err := app.GetUserPrefs(struct {
		Keys []string `json:"keys"`
	}{})
	if err != nil {
		t.Fatalf("GetUserPrefs failed: %v", err)
	}
	if got["theme"] != "dark" {
		t.Errorf("theme = %v, want 'dark'", got["theme"])
	}
	if got["pollingMinutes"] != 5 {
		t.Errorf("pollingMinutes = %v, want 5", got["pollingMinutes"])
	}
}

func TestApp_GetUserPrefs_ByKeys(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Prefs["theme"] = "dark"
		s.Prefs["pollingMinutes"] = 5
		s.Prefs["otherKey"] = "otherValue"
	})

	// 只取 theme + 不存在的 key
	got, err := app.GetUserPrefs(struct {
		Keys []string `json:"keys"`
	}{Keys: []string{"theme", "nonexistent"}})
	if err != nil {
		t.Fatalf("GetUserPrefs failed: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("expected 1 result, got %d: %v", len(got), got)
	}
	if got["theme"] != "dark" {
		t.Errorf("theme = %v, want 'dark'", got["theme"])
	}
	if _, ok := got["nonexistent"]; ok {
		t.Error("nonexistent should not appear in result")
	}
}

// TestApp_SetUserPrefs_ReconcilerForStatusbar 端到端模拟 "选仓库 → 持久化 → 重启 → 恢复"
//
// 这是 v2.4 "选择完仓库应用没记住" bug 的回归测试
func TestApp_SetUserPrefs_ReconcilerForStatusbar(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app1 := NewApp()
	app1.OnStartup(context.Background())
	defer app1.OnShutdown(context.Background())

	// 模拟前端 persistLastSelected：写 { giteaUrl, owner, name, projectId }
	wantValue := map[string]any{
		"giteaUrl":  "https://gitea.example.com",
		"owner":     "myorg",
		"name":      "myrepo",
		"projectId": "uuid-12345",
	}
	_, err := app1.SetUserPrefs(struct {
		Entries map[string]any `json:"entries"`
	}{
		Entries: map[string]any{
			"repo.last.selected": wantValue,
		},
	})
	if err != nil {
		t.Fatalf("SetUserPrefs failed: %v", err)
	}

	// 模拟"重启"：杀 app1，重建 app2
	app1.OnShutdown(context.Background())
	app2 := NewApp()
	app2.OnStartup(context.Background())
	defer app2.OnShutdown(context.Background())

	// 模拟前端 restoreLastSelected：读 prefs
	got, err := app2.GetUserPrefs(struct {
		Keys []string `json:"keys"`
	}{Keys: []string{"repo.last.selected"}})
	if err != nil {
		t.Fatalf("GetUserPrefs after restart failed: %v", err)
	}

	restored, ok := got["repo.last.selected"]
	if !ok {
		t.Fatalf("repo.last.selected not found in prefs after restart: %v", got)
	}
	// restored 是 map[string]any（前端 JSON 序列化的对象）
	restoredMap, ok := restored.(map[string]any)
	if !ok {
		t.Fatalf("restored is not a map: %T", restored)
	}
	if restoredMap["giteaUrl"] != "https://gitea.example.com" {
		t.Errorf("giteaUrl = %v, want https://gitea.example.com", restoredMap["giteaUrl"])
	}
	if restoredMap["owner"] != "myorg" {
		t.Errorf("owner = %v, want myorg", restoredMap["owner"])
	}
	if restoredMap["name"] != "myrepo" {
		t.Errorf("name = %v, want myrepo", restoredMap["name"])
	}
	if restoredMap["projectId"] != "uuid-12345" {
		t.Errorf("projectId = %v, want uuid-12345", restoredMap["projectId"])
	}
}

// TestApp_SetUserPrefs_DeleteKey 验证 null 值能删 key
func TestApp_SetUserPrefs_DeleteKey(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// 写入
	_, _ = app.SetUserPrefs(struct {
		Entries map[string]any `json:"entries"`
	}{
		Entries: map[string]any{"key1": "v1", "key2": "v2"},
	})

	// 删 key1（用 nil）
	res, err := app.SetUserPrefs(struct {
		Entries map[string]any `json:"entries"`
	}{
		Entries: map[string]any{"key1": nil, "key2": "v2-new"},
	})
	if err != nil {
		t.Fatalf("SetUserPrefs failed: %v", err)
	}
	if res["written"].(int) != 1 {
		t.Errorf("written = %v, want 1", res["written"])
	}
	if res["deleted"].(int) != 1 {
		t.Errorf("deleted = %v, want 1", res["deleted"])
	}

	// 验证
	got, _ := app.GetUserPrefs(struct {
		Keys []string `json:"keys"`
	}{})
	if _, ok := got["key1"]; ok {
		t.Error("key1 should be deleted")
	}
	if got["key2"] != "v2-new" {
		t.Errorf("key2 = %v, want v2-new", got["key2"])
	}
}
