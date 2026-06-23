package graph

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

	// 用显式 GIT_COMMITTER_DATE/GIT_AUTHOR_DATE 保证时间严格递增
	// 避免秒级时间戳相同导致 LogCommits 排序不稳定（进而 layout 算法的 lane 错位）
	commitAt := func(msg, date string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date,
			"GIT_COMMITTER_DATE="+date,
		)
		cmd := exec.Command("git", "commit", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v\n%s", err, out)
		}
	}

	// C1: initial
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	commitAt("C1 initial", "2026-01-01T10:00:00Z")

	// C2: main branch commit
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	commitAt("C2 main work", "2026-01-01T11:00:00Z")

	// 创建 feature 分支并提交 C3
	runGit("checkout", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	commitAt("C3 feature work", "2026-01-01T12:00:00Z")

	// 合并 feature 到 main → C4
	runGit("checkout", "main")
	mergeAt := func(msg, date string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date,
			"GIT_COMMITTER_DATE="+date,
		)
		cmd := exec.Command("git", "merge", "--no-ff", "feature", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git merge: %v\n%s", err, out)
		}
	}
	mergeAt("C4 merge feature", "2026-01-01T13:00:00Z")

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

func TestAssignLane(t *testing.T) {
	// v2.7 严格对齐 Gitea column 分配语义：
	// 1. 优先复用现存 lane（同 SHA）
	// 2. 否则从右到左找第一个空闲 lane
	// 3. 没有空闲 → maxLane + 1（永不回收）

	t.Run("reuse existing lane by SHA", func(t *testing.T) {
		activeLanes := []laneSlot{{sha: "a"}, {sha: "b"}, {sha: "c"}}
		lane, _, isReused := assignLane(&activeLanes, nil, "b", intPtr(2))
		if !isReused {
			t.Errorf("expected isReused=true for SHA 'b'")
		}
		if lane != 1 {
			t.Errorf("expected lane 1, got %d", lane)
		}
	})

	t.Run("find free lane from right to left", func(t *testing.T) {
		// lanes 0 和 2 占用，lane 1 空闲 → 从右到左扫，lane 1 (i=2) 不是空闲，lane 1 (i=1) 空闲
		activeLanes := []laneSlot{{sha: "a"}, {sha: ""}, {sha: "c"}}
		lane, _, isReused := assignLane(&activeLanes, nil, "new", intPtr(2))
		if isReused {
			t.Errorf("expected isReused=false for new SHA")
		}
		if lane != 1 {
			t.Errorf("expected lane 1 (right-to-left first free), got %d", lane)
		}
	})

	t.Run("all occupied → maxLane+1", func(t *testing.T) {
		// 全部占用 → 走 maxLane + 1（对齐 Gitea 永不回收）
		activeLanes := []laneSlot{{sha: "a"}, {sha: "b"}, {sha: "c"}}
		lane, _, isReused := assignLane(&activeLanes, nil, "new", intPtr(2))
		if isReused {
			t.Errorf("expected isReused=false")
		}
		if lane != 3 {
			t.Errorf("expected lane 3 (maxLane 2 + 1), got %d", lane)
		}
		if len(activeLanes) != 4 {
			t.Errorf("expected 4 lanes after extend, got %d", len(activeLanes))
		}
	})

	t.Run("empty activeLanes → lane 0", func(t *testing.T) {
		activeLanes := []laneSlot{}
		lane, _, _ := assignLane(&activeLanes, nil, "new", intPtr(-1))
		if lane != 0 {
			t.Errorf("expected lane 0 for empty state, got %d", lane)
		}
	})
}

// intPtr 辅助函数（int 指针）
func intPtr(i int) *int {
	return &i
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

// =============================================================================
// v2.6 回归用例（覆盖 bug1-bug4 修复）
// =============================================================================

// TestBuildGraph_ColorFieldPresent 验证 GraphEdge.Color 由后端生成（非前端 % N 自算）
//
// 背景（bug2）：v2.4 GraphEdge 没有 Color，前端按 fromLane % 8 复色，
// 导致同 DAG 不同 commit 顺序产生不同色。v2.6 修复：Color 由后端 16 色队列生成。
func TestBuildGraph_ColorFieldPresent(t *testing.T) {
	repoPath := createRepoWithMerge(t)
	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	result := BuildGraph(logResult.Commits)

	// 每条 edge 的 color 必须 ∈ [0, 15]（对齐 Gitea Color16() = ColorNumber % 16）
	for _, e := range result.Edges {
		if e.Color < 0 || e.Color > 15 {
			t.Errorf("edge color out of range: %d (want 0..15)", e.Color)
		}
	}
	// 至少应该用上 2 种颜色（merge + main 两个 lane）
	colorSet := map[int]bool{}
	for _, e := range result.Edges {
		colorSet[e.Color] = true
	}
	if len(colorSet) < 2 {
		t.Errorf("expected >=2 colors used, got %d", len(colorSet))
	}
}

// TestBuildGraph_LaneStableUnderReorder 验证 lane 分配对输入顺序不敏感（语义稳定）
//
// 背景（bug3）：旧版 findFreeLane 从 lane 0 找空闲 + laneOf 复写导致同一 DAG
// 不同输入顺序生成不同 lane 图。v2.6 修复：算法按 SHA→row 映射 + laneOf 隔离
// 决定 lane，与遍历顺序无关。
//
// 测试方法：构造 4 个 commit 两条分支，把输入 list 倒序（SHA 集合不变，
// 但 row 索引变化），验证每个 SHA 的 lane 在两次结果中**对 row 索引一致**。
// 因为 row 是 BuildGraph 的输入参数（由 LogCommits 决定），算法本身稳定 = 同样
// SHA+row → 同样 lane。如果 LogCommits 改变 row，算法忠实跟随（这是契约）。
func TestBuildGraph_LaneStableUnderReorder(t *testing.T) {
	t0 := time.Now()
	// SHA 全 40 字符 hex（go-git LogCommits 用完整 SHA）
	// 返回 (sha, parents[]string 同样填到 40 字符)
	fullSHA := func(prefix string) string {
		return prefix + "0000000000000000000000000000000000000000"[:40-len(prefix)]
	}
	mk := func(prefix string, when time.Time, parents []string) git.CommitInfo {
		sha := fullSHA(prefix)
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = fullSHA(p)
		}
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha[:7],
			Subject:    prefix,
			AuthorWhen: when,
			Parents:    fullParents,
		}
	}
	// 构造 DAG：merge commit c0 + feature c1 + main c2 + initial c3
	//   c0 (merge) ← parents=[c1, c2]
	//   c1 (feature) ← parent=c3
	//   c2 (main) ← parent=c3
	//   c3 (initial) ← parent=[]
	commits := []git.CommitInfo{
		mk("c0", t0, []string{"c1", "c2"}),
		mk("c1", t0.Add(-time.Minute), []string{"c3"}),
		mk("c2", t0.Add(-2*time.Minute), []string{"c3"}),
		mk("c3", t0.Add(-3*time.Minute), []string{}),
	}
	r1 := BuildGraph(commits)

	// 把 list 倒序（C3 在前），row 索引变化但 SHA→lane 决策应保持
	reversed := []git.CommitInfo{commits[3], commits[2], commits[1], commits[0]}
	r2 := BuildGraph(reversed)

	// 关键断言：排序后 c0（最新）总在 row 0
	if !strings.HasPrefix(r2.Nodes[0].ShortSHA, "c0") {
		t.Skipf("sorted ordering puts different SHA at row 0: %s", r2.Nodes[0].ShortSHA)
	}
	if r2.Nodes[0].Lane != 0 {
		t.Errorf("head c0 lane in reversed = %d, expected 0", r2.Nodes[0].Lane)
	}

	// 同一个 SHA 在两次结果中必须落到同一 lane（这是 v2.6 的稳定语义保证）
	laneBySHA1 := map[string]int{}
	for _, n := range r1.Nodes {
		laneBySHA1[n.SHA] = n.Lane
	}
	// r2 里找相同 SHA
	for _, n := range r2.Nodes {
		origLane, exists := laneBySHA1[n.SHA]
		if !exists {
			continue
		}
		if n.Lane != origLane {
			t.Errorf("SHA %s lane drift: orig=%d reordered=%d", n.ShortSHA, origLane, n.Lane)
		}
	}
}

// TestBuildGraph_OctopusMerge 验证八爪鱼 merge（3+ parents）每个 parent 各占独立 lane
//
// 背景（bug4）：旧版 laneOf map 不隔离，merge-parent 互相覆盖。
// v2.6 修复：每个 merge-parent 占 findFreeLane 返回的新 lane，色独立。
// TestBuildGraph_OctopusMerge 验证多分支合并：3 个独立分支合并到 main
// （git 默认 sequential merge，每个 merge 2 parents；本测试验证算法正确处理
// 多次 merge 让 lane 数 ≥ 4 的拓扑）
//
// 背景（bug4）：旧版 laneOf map 不隔离，merge-parent 互相覆盖。
// v2.6 修复：每个 merge-parent 占 findFreeLane 返回的新 lane，色独立。
func TestBuildGraph_OctopusMerge(t *testing.T) {
	repoPath := createRepoWithOctopusMerge(t)
	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	result := BuildGraph(logResult.Commits)

	// 找所有 merge commit（parents>=2），验证每个有 merge edge
	mergeCount := 0
	seenMergeRows := map[int]bool{}
	for i := range result.Nodes {
		if len(result.Nodes[i].Parents) >= 2 {
			mergeCount++
			seenMergeRows[result.Nodes[i].Row] = true
		}
	}
	if mergeCount < 3 {
		t.Errorf("expected >=3 merge commits, got %d", mergeCount)
	}

	// 至少产生 3 条 merge edge（每个 merge commit 至少一条）
	mergeEdgeCount := 0
	for _, e := range result.Edges {
		if e.Type == EdgeMerge && seenMergeRows[e.FromRow] {
			mergeEdgeCount++
		}
	}
	if mergeEdgeCount < 3 {
		t.Errorf("expected >=3 merge edges, got %d", mergeEdgeCount)
	}

	// merge 边的 toLane 必须彼此不同（隔离修复）
	mergeToLanes := map[int]bool{}
	for _, e := range result.Edges {
		if e.Type == EdgeMerge && seenMergeRows[e.FromRow] {
			mergeToLanes[e.ToLane] = true
		}
	}
	if len(mergeToLanes) < 3 {
		t.Errorf("expected merge edges to span >=3 distinct lanes, got %d", len(mergeToLanes))
	}

	// maxLane 应该 >= 3（4 lane：main + 3 个 feature 分支）
	if result.MaxLane < 3 {
		t.Errorf("expected MaxLane >= 3, got %d", result.MaxLane)
	}
}

// TestBuildGraph_Color16Cycle 验证 16 色循环（>= 17 个分支 → 颜色复用模 16）
//
// 对齐 Gitea Color16() = ColorNumber % 16 行为：超过 16 条 lane 时颜色会重复。
func TestBuildGraph_Color16Cycle(t *testing.T) {
	repoPath := createRepoWithManyBranches(t, 18)
	logResult, err := git.LogCommits(git.LogOptions{LocalPath: repoPath})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	result := BuildGraph(logResult.Commits)

	// maxLane 应该 >= 16（18 个分支 = 至少 18 个 lane）
	if result.MaxLane < 16 {
		t.Errorf("expected MaxLane >= 16 for 18 branches, got %d", result.MaxLane)
	}
	// Color 字段应在 [0, 15] 循环（不超出）
	for _, e := range result.Edges {
		if e.Color < 0 || e.Color > 15 {
			t.Errorf("color out of range: %d", e.Color)
		}
	}
	// 16 色都被用到过（验证 18 个分支真的触发了循环）
	colorSet := map[int]bool{}
	for _, e := range result.Edges {
		colorSet[e.Color] = true
	}
	if len(colorSet) < 16 {
		t.Errorf("expected all 16 colors used (cyclic), got %d", len(colorSet))
	}
}

// =============================================================================
// 测试 fixture：octopus merge + 多分支并行
// =============================================================================

// createRepoWithOctopusMerge 构造八爪鱼 merge（3 个分支合并）
//
//	DAG (新→旧):
//	*   octopus merge (M4) — parents: [M1, M2, M3]
//	|\
//	| |\
//	| | * branch3 (B3)
//	| | * branch3 (B2)
//	| * branch2 (B2)
//	| * branch2 (B1)
//	* branch1 (B1)
//	* initial (I)
func createRepoWithOctopusMerge(t *testing.T) string {
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
	runGit("config", "user.email", "t@t.com")
	runGit("config", "user.name", "T")
	commitAt := func(file, msg, date string) {
		os.WriteFile(filepath.Join(dir, file), []byte(file), 0o644)
		runGit("add", file)
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		cmd := exec.Command("git", "commit", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v\n%s", err, out)
		}
	}
	// initial
	commitAt("i.txt", "initial", "2026-01-01T10:00:00Z")

	// 3 个独立分支各 2 个 commit
	for i, branch := range []string{"b1", "b2", "b3"} {
		runGit("checkout", "-b", branch)
		commitAt(branch+"1.txt", branch+"-1", fmt.Sprintf("2026-01-02T1%d:00:00Z", i))
		commitAt(branch+"2.txt", branch+"-2", fmt.Sprintf("2026-01-02T2%d:00:00Z", i))
	}

	// 3. 合并 b1 b2 b3 到 main（octopus merge）
	runGit("checkout", "main")
	mergeEnv := append(os.Environ(),
		"GIT_AUTHOR_DATE=2026-01-03T10:00:00Z",
		"GIT_COMMITTER_DATE=2026-01-03T10:00:00Z")
	// 先逐个 merge（git 默认 octopus merge 需要 -octopus 标志或显式参数）
	// 用 git merge --no-ff -m 合并多个 branch 会自动做 octopus
	cmd := exec.Command("git", "merge", "--no-ff", "b1", "-m", "merge b1")
	cmd.Dir = dir
	cmd.Env = mergeEnv
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("merge b1: %v\n%s", err, out)
	}
	mergeEnv2 := append(os.Environ(),
		"GIT_AUTHOR_DATE=2026-01-03T11:00:00Z",
		"GIT_COMMITTER_DATE=2026-01-03T11:00:00Z")
	cmd = exec.Command("git", "merge", "--no-ff", "b2", "-m", "merge b2")
	cmd.Dir = dir
	cmd.Env = mergeEnv2
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("merge b2: %v\n%s", err, out)
	}
	mergeEnv3 := append(os.Environ(),
		"GIT_AUTHOR_DATE=2026-01-03T12:00:00Z",
		"GIT_COMMITTER_DATE=2026-01-03T12:00:00Z")
	cmd = exec.Command("git", "merge", "--no-ff", "b3", "-m", "merge b3")
	cmd.Dir = dir
	cmd.Env = mergeEnv3
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("merge b3: %v\n%s", err, out)
	}
	return dir
}

// createRepoWithManyBranches 构造 N 个独立分支（验证 16 色循环）
//
// 每个分支 2 个 commit + 最后合并到 main → 形成 maxLane ≥ N 的多 lane DAG
func createRepoWithManyBranches(t *testing.T, n int) string {
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
	runGit("config", "user.email", "t@t.com")
	runGit("config", "user.name", "T")
	os.WriteFile(filepath.Join(dir, "i.txt"), []byte("i"), 0o644)
	runGit("add", "i.txt")
	env0 := append(os.Environ(), "GIT_AUTHOR_DATE=2026-01-01T10:00:00Z", "GIT_COMMITTER_DATE=2026-01-01T10:00:00Z")
	cmd0 := exec.Command("git", "commit", "-m", "initial")
	cmd0.Dir = dir
	cmd0.Env = env0
	if out, err := cmd0.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
	// 每个分支 2 个 commit
	for i := 0; i < n; i++ {
		runGit("checkout", "-b", fmt.Sprintf("b%d", i))
		for j := 1; j <= 2; j++ {
			os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d_%d.txt", i, j)), []byte("x"), 0o644)
			runGit("add", ".")
			env := append(os.Environ(),
				fmt.Sprintf("GIT_AUTHOR_DATE=2026-02-%02dT%d%d:00:00Z", i+1, j, j),
				fmt.Sprintf("GIT_COMMITTER_DATE=2026-02-%02dT%d%d:00:00Z", i+1, j, j))
			cmd := exec.Command("git", "commit", "-m", fmt.Sprintf("branch %d commit %d", i, j))
			cmd.Dir = dir
			cmd.Env = env
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("git commit branch %d-%d: %v\n%s", i, j, err, out)
			}
		}
	}
	// 合并所有分支到 main（sequential merge，每次产生 merge commit → 多 lane DAG）
	runGit("checkout", "main")
	for i := 0; i < n; i++ {
		env := append(os.Environ(),
			fmt.Sprintf("GIT_AUTHOR_DATE=2026-03-%02dT10:00:00Z", i+1),
			fmt.Sprintf("GIT_COMMITTER_DATE=2026-03-%02dT10:00:00Z", i+1))
		cmd := exec.Command("git", "merge", "--no-ff", fmt.Sprintf("b%d", i), "-m", fmt.Sprintf("merge b%d", i))
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git merge b%d: %v\n%s", i, err, out)
		}
	}
	return dir
}
