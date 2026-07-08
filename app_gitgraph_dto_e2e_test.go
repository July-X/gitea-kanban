package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gitpkg "gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	giteaAdapter "gitea-kanban/app/platform/gitea"
)

// TestGraphResultToAppDTO_UncommittedIsCommittedInJSON 端到端验证
// v3.x UNCOMMITTED 灰色虚线 lane 的 IsCommitted 字段在 App 层 DTO 链路完整
// 透传到 JSON。
//
// 链路：detectUncommittedChanges (git status --porcelain) → LogCommitsVscode
//
//	→ BuildGraphVscodeWithHead → giteaAdapter.graphResultToDTO
//	→ graphResultToAppDTO → json.Marshal
//
// 任何一环漏掉 IsCommitted 都会让 row 0 (UNCOMMITTED) 的 isCommitted=false
// 丢失，前端无法识别灰色虚线 lane。
func TestGraphResultToAppDTO_UncommittedIsCommittedInJSON(t *testing.T) {
	// 1. 准备 local 仓库：1 commit + 3 untracked files（worktree dirty）
	base := t.TempDir()
	localPath := filepath.Join(base, "local")
	mustMkdir(t, localPath)
	runGit(t, localPath, "init")
	runGit(t, localPath, "config", "user.email", "test@test.com")
	runGit(t, localPath, "config", "user.name", "Test")
	mustWrite(t, filepath.Join(localPath, "a.txt"), []byte("a"))
	runGit(t, localPath, "add", ".")
	envGitCommit(t, localPath, "initial", "2026-01-01T10:00:00Z")
	for i := 0; i < 3; i++ {
		fname := filepath.Join(localPath, "dirty_"+string(rune('a'+i))+".txt")
		mustWrite(t, fname, []byte("x"))
	}

	// 2. 走 LogCommitsVscode + BuildGraphVscodeWithHead (Go 端 layout)
	logResult, err := gitpkg.LogCommitsVscode(context.Background(), gitpkg.LogOptions{
		LocalPath: localPath,
		MaxCount:  100,
	})
	if err != nil {
		t.Fatalf("LogCommitsVscode: %v", err)
	}
	if len(logResult.Commits) == 0 || logResult.Commits[0].SHA != gitpkg.UNCOMMITTED_HASH {
		t.Fatalf("expected UNCOMMITTED at commits[0], got len=%d sha[0]=%q",
			len(logResult.Commits),
			func() string {
				if len(logResult.Commits) > 0 {
					return logResult.Commits[0].SHA
				}
				return ""
			}())
	}

	headSHA, err := localHeadSHA(localPath)
	if err != nil {
		t.Fatalf("localHeadSHA: %v", err)
	}
	graphResult := graph.BuildGraphVscodeWithHead(logResult.Commits, headSHA, logResult.Truncated)

	// 4. Gitea 适配器层 graphResultToDTO
	platformDTO := giteaAdapter.GraphResultToDTOForTest(graphResult)
	if platformDTO == nil {
		t.Fatal("Gitea adapter 返回 nil")
	}
	if platformDTO.Nodes[0].IsCommitted {
		t.Errorf("platform layer: UNCOMMITTED 节点 IsCommitted 应该 false，实际 true")
	}

	// 5. App 层 graphResultToAppDTO —— 这次是修复的目标
	appDTO := graphResultToAppDTO(platformDTO)

	// 6. JSON 序列化 —— 模拟 Wails 真正发到前端的 payload
	rawJSON, err := json.Marshal(appDTO)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	// 6a. raw 字符串断言:JSON 里必须含字面量 "isCommitted":false
	// (不能只靠 Unmarshal —— bool 缺省值是 false，缺字段也会 Unmarshal 成 false，假 PASS)
	// 前端用 `node.isCommitted === false` 区分 UNCOMMITTED，所以字段必须真出现在 JSON 里。
	if !strings.Contains(string(rawJSON), `"isCommitted":false`) {
		t.Errorf("JSON 缺少 \"isCommitted\":false 字面量（UNCOMMITTED 节点）。\n"+
			"这是 omitempty 吞掉 false 的典型坑 —— bool 字段不能加 omitempty。\nJSON: %s", string(rawJSON))
	}

	// 7. 关键断言:JSON 里 nodes[0].isCommitted == false
	var parsed struct {
		Nodes []struct {
			SHA         string `json:"sha"`
			IsCommitted bool   `json:"isCommitted"`
		} `json:"nodes"`
		Branches []struct {
			Lines []struct {
				IsCommitted bool `json:"isCommitted"`
			} `json:"lines"`
		} `json:"branches"`
	}
	if err := json.Unmarshal(rawJSON, &parsed); err != nil {
		t.Fatalf("json.Unmarshal: %v\nJSON: %s", err, string(rawJSON))
	}

	if len(parsed.Nodes) == 0 {
		t.Fatalf("JSON 里没有 nodes, JSON: %s", string(rawJSON))
	}
	if parsed.Nodes[0].SHA != "*" {
		t.Errorf("JSON nodes[0].sha 应该是 '*'，实际 %q", parsed.Nodes[0].SHA)
	}
	if parsed.Nodes[0].IsCommitted {
		t.Errorf("JSON nodes[0].isCommitted 应该是 false，实际 true —— DTO 链路漏字段")
	}

	// 8. 验证 branch lines:至少有一条 IsCommitted=false (UNCOMMITTED → HEAD 段)
	foundUncommittedLine := false
	for _, br := range parsed.Branches {
		for _, ln := range br.Lines {
			if !ln.IsCommitted {
				foundUncommittedLine = true
				break
			}
		}
	}
	if !foundUncommittedLine {
		t.Errorf("JSON branches[].lines[].isCommitted 没有 false 的行 —— DTO 链路漏字段")
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", p, err)
	}
}

func mustWrite(t *testing.T, p string, data []byte) {
	t.Helper()
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v (in %s): %v\n%s", args, dir, err, out)
	}
}

func envGitCommit(t *testing.T, dir, msg, date string) {
	t.Helper()
	cmd := exec.Command("git", "commit", "-m", msg)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_DATE="+date,
		"GIT_COMMITTER_DATE="+date,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit %q: %v\n%s", msg, err, out)
	}
}

func localHeadSHA(localPath string) (string, error) {
	cmd := exec.Command("git", "-C", localPath, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out[:len(out)-1]), nil // trim trailing newline
}

var _ = time.Second // keep "time" import available for future use
