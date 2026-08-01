package graph

import (
	"encoding/json"
	"os"
	"testing"

	"gitea-kanban/app/git"
)

// TestDumpBranches: dump BuildGraphGitlens 的 branches/edges 用于连线分析
func TestDumpBranches(t *testing.T) {
	repoPath := os.Getenv("GRAPH_DEBUG_REPO")
	if repoPath == "" {
		t.Skip("set GRAPH_DEBUG_REPO")
	}
	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath, MaxCount: 30})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	var pinned []string
	for _, c := range logResult.Commits {
		if HasPrimaryBranchRef(c) {
			pinned = append(pinned, c.SHA)
			break
		}
	}
	head := ""
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
	if head != "" && (len(pinned) == 0 || pinned[0] != head) {
		pinned = append(pinned, head)
	}

	result := BuildGraphGitlens(logResult.Commits, head, pinned, false)
	rowOf := map[string]int{}
	for i, n := range result.Nodes {
		rowOf[n.SHA] = i
	}
	t.Logf("=== Branches (%d) ===", len(result.Branches))
	for bi, br := range result.Branches {
		t.Logf("branch#%d color=%d end=%d lines=%d", bi, br.Color, br.End, len(br.Lines))
		for _, ln := range br.Lines {
			t.Logf("  line (%d,%d) -> (%d,%d) lockedFirst=%v committed=%v",
				ln.X1, ln.Y1, ln.X2, ln.Y2, ln.LockedFirst, ln.IsCommitted)
		}
	}
	t.Logf("=== Edges (non lane0->0) ===")
	for _, e := range result.Edges {
		if e.FromLane == 0 && e.ToLane == 0 {
			continue
		}
		t.Logf("edge (%d,L%d) -> (%d,L%d) color=%d type=%d",
			e.FromRow, e.FromLane, e.ToRow, e.ToLane, e.Color, e.Type)
	}
}

// TestDumpGraphResultJSON: 导出完整 GraphResult JSON 供前端渲染验证
func TestDumpGraphResultJSON(t *testing.T) {
	repoPath := os.Getenv("GRAPH_DEBUG_REPO")
	outPath := os.Getenv("GRAPH_RESULT_JSON")
	if repoPath == "" || outPath == "" {
		t.Skip("set GRAPH_DEBUG_REPO and GRAPH_RESULT_JSON")
	}
	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath, MaxCount: 60})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	var pinned []string
	for _, c := range logResult.Commits {
		if HasPrimaryBranchRef(c) {
			pinned = append(pinned, c.SHA)
			break
		}
	}
	head := ""
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
	if head != "" && (len(pinned) == 0 || pinned[0] != head) {
		pinned = append(pinned, head)
	}
	result := BuildGraphGitlens(logResult.Commits, head, pinned, false)
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	t.Logf("wrote %s: nodes=%d branches=%d edges=%d", outPath, len(result.Nodes), len(result.Branches), len(result.Edges))
}
