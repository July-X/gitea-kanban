package graph

import (
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// TestBuildGraph_FirstParentNotOverwriteMergeParent v2.7 回归测试
//
// DAG (新→旧):
//   C4 (merge, parents=[C2, C3])  row 0
//   C3 (feature, parent=[C1])     row 1
//   C2 (main, parent=[C1])        row 2
//   C1 (initial, parent=[])       row 3
//
// 旧 bug：C3 的 first-parent C1 被 occupy 到 lane 1（C3→C1 EdgeNormal 1→1），
// 随后 C2 的 first-parent C1 **覆盖** occupy 到 lane 0（C2→C1 EdgeNormal 0→0），
// 导致 C1 最终在 lane 0，C3→C1 的边变成断裂的跨行直线。
//
// v2.7 修复：C2 的 first-parent C1 已在 lane 1，生成 EdgeMerge(0→1) 而非覆盖。
// 预期结果：
//   - C1 在 lane 1（被 C3 先 occupy）
//   - C2→C1 是 EdgeMerge（0→1）
//   - C3→C1 是 EdgeNormal（1→1）
func TestBuildGraph_FirstParentNotOverwriteMergeParent(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		// 补齐到 40 字符（go-git LogCommits 用完整 SHA）
		full := sha + "0000000000000000000000000000000000000000"[:40-len(sha)]
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = p + "0000000000000000000000000000000000000000"[:40-len(p)]
		}
		return git.CommitInfo{
			SHA:        full,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: when,
			Parents:    fullParents,
		}
	}
	commits := []git.CommitInfo{
		mk("c4", t0, []string{"c2", "c3"}),
		mk("c3", t0.Add(-time.Minute), []string{"c1"}),
		mk("c2", t0.Add(-2*time.Minute), []string{"c1"}),
		mk("c1", t0.Add(-3*time.Minute), []string{}),
	}
	result := BuildGraph(commits)

	// 找每个 SHA 的 node
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	c1, ok := nodeBySHA["c1"]
	if !ok {
		t.Fatal("C1 node not found")
	}
	c2 := nodeBySHA["c2"]
	c3 := nodeBySHA["c3"]
	c4 := nodeBySHA["c4"]

	// v2.7 最终版：根 commit (C1) 永远在 lane 0（main 起点），对齐 Gitea 字符流 column 0
	if c1.Lane != 0 {
		t.Errorf("C1 (root) lane = %d, want 0 (root commit must be in lane 0)", c1.Lane)
	}

	// C2 (main) 在 lane 0 (与 C1 同 lane, first-parent 直传)
	if c2.Lane != 0 {
		t.Errorf("C2 (main) lane = %d, want 0 (main 链保持 lane 0)", c2.Lane)
	}

	// C3 (feature) 在 lane 1 (新分叉)
	if c3.Lane != 1 {
		t.Errorf("C3 (feature) lane = %d, want 1 (new branch occupies new lane)", c3.Lane)
	}

	// C4 (merge) 在 lane 0 (与 first-parent C2 同 lane)
	if c4.Lane != 0 {
		t.Errorf("C4 (merge) lane = %d, want 0 (merge 与 first-parent 同 lane)", c4.Lane)
	}

	// C2→C1 应该是 EdgeNormal（0→0 同 lane,main 链）
	foundC2C1Normal := false
	for _, e := range result.Edges {
		if e.FromRow == c2.Row && e.ToRow == c1.Row {
			if e.Type != EdgeNormal {
				t.Errorf("C2→C1 edge type = %v, want EdgeNormal (main chain)", e.Type)
			}
			if e.FromLane != 0 || e.ToLane != 0 {
				t.Errorf("C2→C1 edge lanes = %d→%d, want 0→0", e.FromLane, e.ToLane)
			}
			foundC2C1Normal = true
		}
	}
	if !foundC2C1Normal {
		t.Error("C2→C1 edge not found")
	}

	// C3→C1 应该是 EdgeNormal（1→0 跨 lane,但 root 已在 lane 0,所以是 1→0）
	// 但因为 C1 强制 lane 0,这里 C3 first-parent 看到 C1 已在 lane 0 → EdgeMerge 1→0
	for _, e := range result.Edges {
		if e.FromRow == c3.Row && e.ToRow == c1.Row {
			if e.Type != EdgeMerge {
				t.Errorf("C3→C1 edge type = %v, want EdgeMerge (cross-lane /)", e.Type)
			}
			if e.FromLane != 1 || e.ToLane != 0 {
				t.Errorf("C3→C1 edge lanes = %d→%d, want 1→0", e.FromLane, e.ToLane)
			}
		}
	}
}
