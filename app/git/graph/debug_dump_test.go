package graph

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"gitea-kanban/app/git"
)

// TestDumpRealRepoLanes 临时 debug 工具（不随 CI 跑）：用真实仓库数据跑
// GitLens 布局算法，打印每行的 lane 分配 + parents，用于和 GitLens 截图逐行对照。
//
// 用法：
//
//	GRAPH_DEBUG_REPO=<repo path> GRAPH_DEBUG_MAX_COUNT=<n> go test -v -run TestDumpRealRepoLanes ./app/git/graph/
//	GRAPH_DEBUG_JSON=<output path> GRAPH_DEBUG_REPO=<repo path> GRAPH_DEBUG_MAX_COUNT=<n> go test -v -run TestDumpRealRepoLanes
//
// GRAPH_DEBUG_MAX_COUNT 默认 40；DeepSeek-Reasonix 截图覆盖 301 条，需要设 301。
func TestDumpRealRepoLanes(t *testing.T) {
	repoPath := os.Getenv("GRAPH_DEBUG_REPO")
	if repoPath == "" {
		t.Skip("GRAPH_DEBUG_REPO 未设置，跳过")
	}

	maxCount := 40
	if v := os.Getenv("GRAPH_DEBUG_MAX_COUNT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxCount = n
		}
	}
	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath, MaxCount: maxCount})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// 复刻 adapter pickGraphBuilder 的 pinned 逻辑
	var pinned []string
	for _, c := range logResult.Commits {
		if HasPrimaryBranchRef(c) {
			pinned = append(pinned, c.SHA)
			break
		}
	}
	head := ""
	if len(logResult.Commits) > 0 {
		// head 取 master ref 所指 commit（真实 HEAD）
		for _, c := range logResult.Commits {
			for _, rt := range c.RefTypes {
				if rt == git.RefTypeBranch {
					head = c.SHA
					break
				}
			}
			if head != "" {
				break
			}
		}
	}
	if head != "" && (len(pinned) == 0 || pinned[0] != head) {
		pinned = append(pinned, head)
	}

	result := BuildGraphGitlens(logResult.Commits,  head,  pinned, logResult.Truncated)

	// 导出 rows JSON 供 GitLens 原版 TS 算法对照（D:\2026\github\vscode-gitlens）
	if outPath := os.Getenv("GRAPH_DEBUG_JSON"); outPath != "" {
		type jsonRow struct {
			SHA     string   `json:"sha"`
			Parents []string `json:"parents"`
			Kind    string   `json:"kind"`
			Date    int64    `json:"date"`
		}
		jsonRows := make([]jsonRow, 0, len(logResult.Commits))
		for _, c := range logResult.Commits {
			kind := "commit"
			if len(c.Parents) >= 2 {
				kind = "merge"
			}
			if c.SHA == git.UNCOMMITTED_HASH {
				kind = "workdir"
			}
			var dateMs int64
			if !c.SortTime().IsZero() {
				dateMs = c.SortTime().UnixMilli()
			}
			jsonRows = append(jsonRows, jsonRow{SHA: c.SHA, Parents: c.Parents, Kind: kind, Date: dateMs})
		}
		data, _ := json.MarshalIndent(jsonRows, "", "  ")
		if err := os.WriteFile(outPath, data, 0644); err != nil {
			t.Fatalf("write json: %v", err)
		}
		t.Logf("exported %d rows to %s", len(jsonRows), outPath)
	}

	t.Logf("head=%s pinned=%v nodes=%d maxLane=%d truncated=%v", head[:7], pinned, len(result.Nodes), result.MaxLane, result.Truncated)
	for i, node := range result.Nodes {
		parents := make([]string, len(node.Parents))
		for j, p := range node.Parents {
			if len(p) > 7 {
				parents[j] = p[:7]
			} else {
				parents[j] = p
			}
		}
		t.Logf("row %2d lane %d %s %-40s parents=%v refs=%v",
			i, node.Lane, node.ShortSHA, truncate(node.Subject, 40), parents, node.Refs)
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
