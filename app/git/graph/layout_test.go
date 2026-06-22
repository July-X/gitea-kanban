package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// createRepoWithMerge 创建一个有分支+合并的测试仓库
//
// 历史 DAG：
//
//	*   merge commit (C4)
//	|\
//	| * feature commit (C3)
//	* | main commit (C2)
//	|/
//	* initial commit (C1)
func createRepoWithMerge(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init", "-b", "main")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")

	// C1: initial
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "C1 initial")

	// C2: main branch commit
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "C2 main work")

	// 创建 feature 分支并提交 C3
	runGit("checkout", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "C3 feature work")

	// 合并 feature 到 main → C4
	runGit("checkout", "main")
	runGit("merge", "--no-ff", "feature", "-m", "C4 merge feature")

	return dir
}

func TestBuildGraph_LinearHistory(t *testing.T) {
	commits := []git.CommitInfo{
		{SHA: "c3", ShortSHA: "c3", Subject: "third", AuthorWhen: time.Now(), Parents: []string{"c2"}},
		{SHA: "c2", ShortSHA: "c2", Subject: "second", AuthorWhen: time.Now().Add(-time.Minute), Parents: []string{"c1"}},
		{SHA: "c1", ShortSHA: "c1", Subject: "first", AuthorWhen: time.Now().Add(-2 * time.Minute), Parents: []string{}},
	}

	result := BuildGraph(commits)

	if len(result.Nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(result.Nodes))
	}

	// 线性历史所有 commit 在 lane 0
	for i, node := range result.Nodes {
		if node.Lane != 0 {
			t.Errorf("node %d lane = %d, want 0 (linear)", i, node.Lane)
		}
	}

	// 应该有 2 条 normal 边（c3→c2, c2→c1）
	if len(result.Edges) != 2 {
		t.Errorf("expected 2 edges, got %d", len(result.Edges))
	}
	for _, e := range result.Edges {
		if e.Type != EdgeNormal {
			t.Errorf("expected all edges normal, got %v", e.Type)
		}
	}
}

func TestBuildGraph_MergeHistory(t *testing.T) {
	repoPath := createRepoWithMerge(t)

	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	result := BuildGraph(logResult.Commits)

	if len(result.Nodes) != 4 {
		t.Fatalf("expected 4 nodes, got %d", len(result.Nodes))
	}

	// 找到 merge commit（C4，有 2 个 parents）
	var mergeNode *GraphNode
	for i := range result.Nodes {
		if result.Nodes[i].IsMerge {
			mergeNode = &result.Nodes[i]
			break
		}
	}
	if mergeNode == nil {
		t.Fatal("no merge commit found")
	}

	// merge commit 应该在 lane 0
	if mergeNode.Lane != 0 {
		t.Errorf("merge commit lane = %d, want 0", mergeNode.Lane)
	}

	// 应该至少有一条 merge 边
	hasMergeEdge := false
	for _, e := range result.Edges {
		if e.Type == EdgeMerge {
			hasMergeEdge = true
			break
		}
	}
	if !hasMergeEdge {
		t.Error("expected at least one merge edge")
	}

	// maxLane 应该 >= 1（合并会产生至少 2 个 lane）
	if result.MaxLane < 1 {
		t.Errorf("MaxLane = %d, expected >= 1 for merge history", result.MaxLane)
	}
}

func TestBuildGraph_Empty(t *testing.T) {
	result := BuildGraph([]git.CommitInfo{})
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.Nodes) != 0 {
		t.Errorf("expected 0 nodes, got %d", len(result.Nodes))
	}
}

func TestFindFreeLane(t *testing.T) {
	activeLanes := []string{"a", "", "c"}

	// 第二个 lane 空闲
	lane := findFreeLane(&activeLanes)
	if lane != 1 {
		t.Errorf("expected lane 1, got %d", lane)
	}

	// 填满后再找 → 追加新 lane
	activeLanes = []string{"a", "b", "c"}
	lane = findFreeLane(&activeLanes)
	if lane != 3 {
		t.Errorf("expected lane 3 (appended), got %d", lane)
	}
	if len(activeLanes) != 4 {
		t.Errorf("expected 4 lanes after append, got %d", len(activeLanes))
	}
}

func TestSortCommitsByDate(t *testing.T) {
	now := time.Now()
	commits := []git.CommitInfo{
		{SHA: "old", AuthorWhen: now.Add(-2 * time.Hour)},
		{SHA: "new", AuthorWhen: now},
		{SHA: "mid", AuthorWhen: now.Add(-time.Hour)},
	}

	SortCommitsByDate(commits)

	if commits[0].SHA != "new" {
		t.Errorf("expected new first, got %s", commits[0].SHA)
	}
	if commits[2].SHA != "old" {
		t.Errorf("expected old last, got %s", commits[2].SHA)
	}
}
