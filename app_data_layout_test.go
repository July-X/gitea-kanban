package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gitea-kanban/app/config"
)

// TestApp_OnStartup_DataLayout 验证 OnStartup 后数据目录布局正确（v2.2 user 拍板）
//
// 关键规则（user 强调 2026-06-22）：
//   - ${dataDir} = ~/.gitea-kanban 是根目录
//   - 直接子级 = 业务目录（state.json / logs/ / dev-tokens/ / workspace/）
//   - 禁止出现 ${dataDir}/workspace/workspace 这种嵌套
//
// 预期布局：
//
//	${dataDir}/
//	├── state.json
//	├── logs/main/main.log
//	├── dev-tokens/
//	└── workspace/                ← git repos 唯一目录（不可改）
//	    └── repos/owner__repo/.git
func TestApp_OnStartup_DataLayout(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("OnStartup PANIC: %v", r)
			}
		}()
		app.OnStartup(context.Background())
	}()
	defer app.OnShutdown(context.Background())

	// 1. ${dataDir}/logs/main/main-YYYY-MM-DD.log 必须存在
	//   v0.6.0 daily rotate 改文件名（user 拍板 2026-07-02）：main.log → main-YYYY-MM-DD.log
	//   (state.json 由 localStore 在第一次 Mutate 时才写盘，
	//    OnStartup 阶段只初始化内存默认值，不落盘)
	today := time.Now().UTC().Format("2006-01-02")
	logPath := filepath.Join(tmp, "logs", "main", "main-"+today+".log")
	if _, err := os.Stat(logPath); err != nil {
		t.Errorf("log file not created at %q: %v", logPath, err)
	}

	// 2. ${dataDir}/dev-tokens/ 必须存在
	devTokens := filepath.Join(tmp, "dev-tokens")
	if _, err := os.Stat(devTokens); err != nil {
		t.Errorf("dev-tokens dir not created: %v", err)
	}

	// 3. ${dataDir}/workspace/ 必须存在（git repos 唯一目录）
	wsPath := filepath.Join(tmp, "workspace")
	if _, err := os.Stat(wsPath); err != nil {
		t.Errorf("workspace dir not created: %v", err)
	}

	// 5. 关键：禁止出现 ${dataDir}/workspace/workspace 这种嵌套
	// （user 明确强调：根目录是 ~/.gitea-kanban，子级直接放业务目录）
	nested := filepath.Join(tmp, "workspace", "workspace")
	if _, err := os.Stat(nested); err == nil {
		t.Errorf("forbidden nested dir %q exists — v2.2 禁止嵌套 workspace", nested)
	}

	// 6. slog 内容验证：onStartup 阶段必须写日志
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	logContent := string(data)
	mustContain := []string{
		"gitea-kanban starting",
		"localStore initialized",
		"platform adapters initialized",
		"secret store: dev fallback",
	}
	for _, s := range mustContain {
		if !strings.Contains(logContent, s) {
			t.Errorf("log file missing %q\n--- log content ---\n%s", s, logContent)
		}
	}

	// 7. 日志路径里**不能**出现 "workspace/logs"（说明路径用错了）
	if strings.Contains(logContent, "workspace/logs") {
		t.Errorf("log path contains 'workspace/logs' (v2.2 禁止嵌套):\n%s", logContent)
	}
}

// TestApp_GetWorkspace_ReturnsRepoWorkspace 验证 GetWorkspace 返回的是 workspacePath
func TestApp_GetWorkspace_ReturnsRepoWorkspace(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// v2.x：用户选的是数据根目录 (DataRoot)，不是 workspace 子目录
	// WorkspacePath 是应用自动创建的内部子目录，前端展示用 DataRoot
	got := app.GetWorkspace()
	if got.DataRoot != tmp {
		t.Errorf("GetWorkspace().DataRoot = %q, want %q", got.DataRoot, tmp)
	}
	wantWs := filepath.Join(tmp, "workspace")
	if got.WorkspacePath != wantWs {
		t.Errorf("GetWorkspace().WorkspacePath = %q, want %q", got.WorkspacePath, wantWs)
	}
	if !got.IsDefault {
		t.Error("IsDefault should be true (数据根目录不可改 → 永远默认)")
	}
	if !got.Validated {
		t.Error("Validated should be true (default path exists & is dir)")
	}
}

// TestApp_SetWorkspace_AlwaysRejects 验证 v2.2 SetWorkspace 一律拒绝
func TestApp_SetWorkspace_AlwaysRejects(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	today := time.Now().UTC().Format("2006-01-02")
	logPath := filepath.Join(tmp, "logs", "main", "main-"+today+".log")

	// 任何 SetWorkspace 调用都应拒绝
	err := app.SetWorkspace(SetWorkspaceArgs{Cwd: "/some/other/path"})
	if err == nil {
		t.Fatal("SetWorkspace should always reject (v2.2: workspace 不可改)")
	}

	// slog 必须记到 Warn 级（"called but not allowed"）
	data, _ := os.ReadFile(logPath)
	logContent := string(data)
	if !strings.Contains(logContent, "level=WARN") {
		t.Errorf("expected WARN level log, got:\n%s", logContent)
	}
	if !strings.Contains(logContent, "workspace path is no longer user-configurable") {
		t.Errorf("expected 'workspace path is no longer user-configurable' message, got:\n%s", logContent)
	}
}

// TestApp_SetWorkspace_EmptyPath 验证空路径也拒绝（不再走原来的 error 分支）
func TestApp_SetWorkspace_EmptyPath(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	err := app.SetWorkspace(SetWorkspaceArgs{Cwd: ""})
	if err == nil {
		t.Fatal("SetWorkspace with empty cwd should fail (v2.2 不可改)")
	}
}

// TestApp_DataDir_ResolveConsistency 一致性：app.dataDir == config.ResolveDataDir()
func TestApp_DataDir_ResolveConsistency(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	if config.ResolveDataDir() != app.dataDir {
		t.Errorf("config.ResolveDataDir() = %q, app.dataDir = %q", config.ResolveDataDir(), app.dataDir)
	}
	// workspace 必须是 dataDir 的直接子目录（不能嵌套）
	if !strings.HasSuffix(app.workspacePath, string(filepath.Separator)+"workspace") {
		t.Errorf("workspacePath = %q, expected to end with /workspace", app.workspacePath)
	}
	// 防回归：workspace 不能是 dataDir 的子子目录
	if filepath.Dir(app.workspacePath) != app.dataDir {
		t.Errorf("workspacePath parent = %q, want = %q (dataDir direct child, no nesting)",
			filepath.Dir(app.workspacePath), app.dataDir)
	}
}
