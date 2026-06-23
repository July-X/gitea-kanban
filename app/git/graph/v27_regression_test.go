package graph

import (
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// TestBuildGraph_FirstParentNotOverwriteMergeParent v2.7 回归测试
//
// DAG (新→旧):
//
//	C4 (merge, parents=[C2, C3])  row 0
//	C3 (feature, parent=[C1])     row 1
//	C2 (main, parent=[C1])        row 2
//	C1 (initial, parent=[])       row 3
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
	foundC3C1 := false
	for _, e := range result.Edges {
		if e.FromRow == c3.Row && e.ToRow == c1.Row {
			if e.Type != EdgeMerge {
				t.Errorf("C3→C1 edge type = %v, want EdgeMerge (cross-lane /)", e.Type)
			}
			if e.FromLane != 1 || e.ToLane != 0 {
				t.Errorf("C3→C1 edge lanes = %d→%d, want 1→0", e.FromLane, e.ToLane)
			}
			if e.Color != c3.Color {
				t.Errorf("C3→C1 edge color = %d, want feature flow color %d", e.Color, c3.Color)
			}
			if e.Color == c1.Color {
				t.Errorf("C3→C1 edge color should not collapse to main/root color %d", c1.Color)
			}
			foundC3C1 = true
		}
	}
	if !foundC3C1 {
		t.Error("C3→C1 edge not found")
	}

	if c3.Color == c1.Color {
		t.Errorf("feature node color = main/root color = %d, want distinct flow colors", c3.Color)
	}
}

// TestBuildGraph_LaneReuseConsecutiveForks v2.8 回归测试：连续独立分叉复用同一 lane
//
// DAG (新→旧):
//
//	C6 (merge fB, parents=[C5, C5b])   row 0
//	C5 (main, parent=[C4])              row 1
//	C5b (fB, parent=[C4])               row 2
//	C4 (merge fA, parents=[C3, C3a])   row 3
//	C3 (main, parent=[C2])              row 4
//	C3a (fA, parent=[C2])               row 5
//	C2 (main, parent=[C1])              row 6
//	C1 (root)                           row 7
//
// git log --graph 输出：C5b 和 C3a 都在第二个 column（复用），MaxColumn=1。
// v2.7 bug：lane 永不复用，C5b 在 lane 1、C3a 在 lane 2（偏右）。
// v2.8 修复：lane 复用，C5b 和 C3a 都在 lane 1，MaxLane=1。
func TestBuildGraph_LaneReuseConsecutiveForks(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		full := sha + "0000000000000000000000000000000000000000"[:40-len(sha)]
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = p + "0000000000000000000000000000000000000000"[:40-len(p)]
		}
		return git.CommitInfo{SHA: full, ShortSHA: sha, Subject: sha, AuthorWhen: when, Parents: fullParents}
	}
	commits := []git.CommitInfo{
		mk("c6", t0, []string{"c5", "c5b"}),
		mk("c5", t0.Add(-time.Minute), []string{"c4"}),
		mk("c5b", t0.Add(-2*time.Minute), []string{"c4"}),
		mk("c4", t0.Add(-3*time.Minute), []string{"c3", "c3a"}),
		mk("c3", t0.Add(-4*time.Minute), []string{"c2"}),
		mk("c3a", t0.Add(-5*time.Minute), []string{"c2"}),
		mk("c2", t0.Add(-6*time.Minute), []string{"c1"}),
		mk("c1", t0.Add(-7*time.Minute), []string{}),
	}
	result := BuildGraph(commits)

	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	// main 链全在 lane 0
	for _, sha := range []string{"c6", "c5", "c4", "c3", "c2", "c1"} {
		if nodeBySHA[sha].Lane != 0 {
			t.Errorf("%s lane = %d, want 0 (main chain)", sha, nodeBySHA[sha].Lane)
		}
	}

	// 两个 feature 分支都复用 lane 1（不递增到 lane 2）
	if nodeBySHA["c5b"].Lane != 1 {
		t.Errorf("C5b lane = %d, want 1 (reused lane)", nodeBySHA["c5b"].Lane)
	}
	if nodeBySHA["c3a"].Lane != 1 {
		t.Errorf("C3a lane = %d, want 1 (reused lane)", nodeBySHA["c3a"].Lane)
	}

	// MaxLane 应该是 1（只有 2 个 column：main + feature）
	if result.MaxLane != 1 {
		t.Errorf("MaxLane = %d, want 1 (lane reuse)", result.MaxLane)
	}
}

// TestBuildGraph_TruncatedSegmentMainStaysLane0 v2.8 回归测试：截断片段 main 稳定 lane 0
//
// 模拟 MaxCount 截断：只传入完整历史的一个中间片段。
// v2.7 bug：从 root 遍历，截断时 root 不在片段内，main 被分到高 lane。
// v2.8 修复：从 latest 遍历，main 起点是片段第一个 commit → lane 0 稳定。
func TestBuildGraph_TruncatedSegmentMainStaysLane0(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		full := sha + "0000000000000000000000000000000000000000"[:40-len(sha)]
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = p + "0000000000000000000000000000000000000000"[:40-len(p)]
		}
		return git.CommitInfo{SHA: full, ShortSHA: sha, Subject: sha, AuthorWhen: when, Parents: fullParents}
	}

	// 完整 DAG: M3 → M2 → M1 → R (main 线性)
	// 截断片段：只传 [M3, M2]（M1 和 R 不在片段，M2 的 parent M1 不可见）
	segment := []git.CommitInfo{
		mk("m3", t0, []string{"m2"}),
		mk("m2", t0.Add(-time.Minute), []string{"m1"}), // m1 不在片段
	}

	result := BuildGraph(segment)
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	// 片段第一个 commit (M3, 最新) 应该在 lane 0（main 起点）
	if nodeBySHA["m3"].Lane != 0 {
		t.Errorf("M3 (segment head) lane = %d, want 0", nodeBySHA["m3"].Lane)
	}

	// M2 也应该在 lane 0（first-parent 接力，即使 M1 不可见）
	if nodeBySHA["m2"].Lane != 0 {
		t.Errorf("M2 lane = %d, want 0 (first-parent relay)", nodeBySHA["m2"].Lane)
	}

	// MaxLane 应该是 0（线性历史，无分叉）
	if result.MaxLane != 0 {
		t.Errorf("MaxLane = %d, want 0 (linear segment)", result.MaxLane)
	}
}

// TestBuildGraph_MultipleChildrenOfSameParentSplitIntoIndependentLanes
// 验证同一个 parent 分叉出的多个子 flow 不会挤在同一 column。
//
// DAG (新→旧):
//
//	H1 (head of feature-b, parent=[B1])   row 0
//	B1 (feature-b, parent=[P])            row 1
//	A1 (feature-a, parent=[P])            row 2
//	P  (parent/main, parent=[R])          row 3
//	R  (root, parent=[])                  row 4
//
// 语义要求：
//   - P 是共同分叉点
//   - A1 / B1 是两条独立 flow，必须占两个独立 lane
//   - 不能因为都 first-parent 指向 P，就把 A1/B1 压到同一个 column
func TestBuildGraph_MultipleChildrenOfSameParentSplitIntoIndependentLanes(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		full := sha + "0000000000000000000000000000000000000000"[:40-len(sha)]
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = p + "0000000000000000000000000000000000000000"[:40-len(p)]
		}
		return git.CommitInfo{SHA: full, ShortSHA: sha, Subject: sha, AuthorWhen: when, Parents: fullParents}
	}

	commits := []git.CommitInfo{
		mk("h1", t0, []string{"b1"}),
		mk("b1", t0.Add(-time.Minute), []string{"p"}),
		mk("a1", t0.Add(-2*time.Minute), []string{"p"}),
		mk("p", t0.Add(-3*time.Minute), []string{"r"}),
		mk("r", t0.Add(-4*time.Minute), []string{}),
	}
	commits[0].Refs = []string{"feature-b"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}
	commits[2].Refs = []string{"feature-a"}
	commits[2].RefTypes = []git.RefType{git.RefTypeBranch}
	commits[3].Refs = []string{"main"}
	commits[3].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraph(commits)
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	p := nodeBySHA["p"]
	a1 := nodeBySHA["a1"]
	b1 := nodeBySHA["b1"]
	h1 := nodeBySHA["h1"]

	if p.Lane != 0 {
		t.Fatalf("P lane = %d, want 0 (main parent stays left)", p.Lane)
	}
	if h1.Lane != b1.Lane {
		t.Fatalf("H1 lane = %d, want same branch lane as B1 = %d", h1.Lane, b1.Lane)
	}
	if a1.Lane == p.Lane {
		t.Fatalf("A1 lane = %d, should split from parent lane %d", a1.Lane, p.Lane)
	}
	if b1.Lane == p.Lane {
		t.Fatalf("B1 lane = %d, should split from parent lane %d", b1.Lane, p.Lane)
	}
	if a1.Lane == b1.Lane {
		t.Fatalf("A1/B1 collapsed to same lane %d, want independent lanes", a1.Lane)
	}

	foundA1Branch := false
	foundB1Branch := false
	for _, e := range result.Edges {
		if e.FromRow == a1.Row && e.ToRow == p.Row {
			if e.FromLane == e.ToLane {
				t.Fatalf("A1→P should be cross-lane, got %d→%d", e.FromLane, e.ToLane)
			}
			foundA1Branch = true
		}
		if e.FromRow == b1.Row && e.ToRow == p.Row {
			if e.FromLane == e.ToLane {
				t.Fatalf("B1→P should be cross-lane, got %d→%d", e.FromLane, e.ToLane)
			}
			foundB1Branch = true
		}
	}
	if !foundA1Branch || !foundB1Branch {
		t.Fatalf("missing branch edges: A1=%v B1=%v", foundA1Branch, foundB1Branch)
	}
}

// TestBuildGraph_NonOverlappingBranchHeadsReuseLane
// 验证带 branch ref 的两个独立分支 head，如果纵向区间不重叠，应该尽量复用同一 column。
//
// DAG (新→旧):
//
//	M7  (main, parent=[M6])             row 0
//	F2H (feature2 head, parent=[F2A])   row 1
//	M6  (main, parent=[M5])             row 2
//	F2A (feature2, parent=[M5])         row 3
//	M5  (main, parent=[M4])             row 4
//	F1H (feature1 head, parent=[F1A])   row 5
//	M4  (main, parent=[M3])             row 6
//	F1A (feature1, parent=[M3])         row 7
//	M3  (main, parent=[M2])             row 8
//	M2  (main, parent=[M1])             row 9
//	M1  (root)                          row 10
//
// 语义要求：
//   - feature2 占用 lane 1，区间结束于 M5（row 4）
//   - feature1 从 row 5 才开始，和 feature2 不发生纵向重叠
//   - 因此 feature1 应复用 lane 1，而不是被预分配到 lane 2
func TestBuildGraph_NonOverlappingBranchHeadsReuseLane(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		full := sha + "0000000000000000000000000000000000000000"[:40-len(sha)]
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = p + "0000000000000000000000000000000000000000"[:40-len(p)]
		}
		return git.CommitInfo{SHA: full, ShortSHA: sha, Subject: sha, AuthorWhen: when, Parents: fullParents}
	}

	commits := []git.CommitInfo{
		mk("m7", t0, []string{"m6"}),
		mk("f2h", t0.Add(-time.Minute), []string{"f2a"}),
		mk("m6", t0.Add(-2*time.Minute), []string{"m5"}),
		mk("f2a", t0.Add(-3*time.Minute), []string{"m5"}),
		mk("m5", t0.Add(-4*time.Minute), []string{"m4"}),
		mk("f1h", t0.Add(-5*time.Minute), []string{"f1a"}),
		mk("m4", t0.Add(-6*time.Minute), []string{"m3"}),
		mk("f1a", t0.Add(-7*time.Minute), []string{"m3"}),
		mk("m3", t0.Add(-8*time.Minute), []string{"m2"}),
		mk("m2", t0.Add(-9*time.Minute), []string{"m1"}),
		mk("m1", t0.Add(-10*time.Minute), []string{}),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}
	commits[1].Refs = []string{"feature2"}
	commits[1].RefTypes = []git.RefType{git.RefTypeBranch}
	commits[5].Refs = []string{"feature1"}
	commits[5].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraph(commits)
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	if nodeBySHA["f2h"].Lane != 1 {
		t.Fatalf("F2H lane = %d, want 1", nodeBySHA["f2h"].Lane)
	}
	if nodeBySHA["f2a"].Lane != 1 {
		t.Fatalf("F2A lane = %d, want 1", nodeBySHA["f2a"].Lane)
	}
	if nodeBySHA["f1h"].Lane != 1 {
		t.Fatalf("F1H lane = %d, want 1 (reuse non-overlapping branch lane)", nodeBySHA["f1h"].Lane)
	}
	if nodeBySHA["f1a"].Lane != 1 {
		t.Fatalf("F1A lane = %d, want 1 (reuse non-overlapping branch lane)", nodeBySHA["f1a"].Lane)
	}
	if result.MaxLane != 1 {
		t.Fatalf("MaxLane = %d, want 1 (compact lane reuse)", result.MaxLane)
	}
}

// TestBuildGraph_FutureReferencedBranchMustReserveLaneAgainstOverlappingSibling
// 验证未来会出现的 branch head（带 ref）如果与当前 sibling branch 纵向区间重叠，
// 必须提前保留 lane，不能让上方无 ref 的 branch 抢进来，否则会出现：
// 1. 多分支错误走同一个 column
// 2. 同一 column 中途换色
//
// DAG (新→旧):
//
//	XH (branch-x head, parent=[XA])      row 0   无 ref
//	M3 (main, parent=[M2])               row 1
//	XA (branch-x, parent=[P])            row 2
//	YH (branch-y head, parent=[YA])      row 3   有 ref
//	M2 (main, parent=[M1])               row 4
//	YA (branch-y, parent=[P])            row 5
//	P  (main split point, parent=[M1])   row 6
//	M1 (root, parent=[])                 row 7
//
// branch-x 区间 [0..6]，branch-y 区间 [3..6]，两者显然重叠。
// 因此 X/YA 不允许共用同一 lane。
func TestBuildGraph_FutureReferencedBranchMustReserveLaneAgainstOverlappingSibling(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		full := sha + "0000000000000000000000000000000000000000"[:40-len(sha)]
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = p + "0000000000000000000000000000000000000000"[:40-len(p)]
		}
		return git.CommitInfo{SHA: full, ShortSHA: sha, Subject: sha, AuthorWhen: when, Parents: fullParents}
	}

	commits := []git.CommitInfo{
		mk("xh", t0, []string{"xa"}),
		mk("m3", t0.Add(-time.Minute), []string{"m2"}),
		mk("xa", t0.Add(-2*time.Minute), []string{"p"}),
		mk("yh", t0.Add(-3*time.Minute), []string{"ya"}),
		mk("m2", t0.Add(-4*time.Minute), []string{"m1"}),
		mk("ya", t0.Add(-5*time.Minute), []string{"p"}),
		mk("p", t0.Add(-6*time.Minute), []string{"m1"}),
		mk("m1", t0.Add(-7*time.Minute), []string{}),
	}
	commits[1].Refs = []string{"main"}
	commits[1].RefTypes = []git.RefType{git.RefTypeBranch}
	commits[3].Refs = []string{"feature-y"}
	commits[3].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraph(commits)
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	xh := nodeBySHA["xh"]
	xa := nodeBySHA["xa"]
	yh := nodeBySHA["yh"]
	ya := nodeBySHA["ya"]

	if xh.Lane != xa.Lane {
		t.Fatalf("X branch lane drift: XH=%d XA=%d", xh.Lane, xa.Lane)
	}
	if yh.Lane != ya.Lane {
		t.Fatalf("Y branch lane drift: YH=%d YA=%d", yh.Lane, ya.Lane)
	}
	if xh.Lane == yh.Lane {
		t.Fatalf("overlapping branches collapsed to same lane %d", xh.Lane)
	}
}

// TestBuildGraph_BranchMergedBackIntoAnotherBranchKeepsFlowColor
// 验证一个显式分支 head（branch-b）在 merge 回自己的目标分支后，
// 即使 merge commit 的 parent 顺序被反过来，[merged-in, branch-b]，
// branch-b 这条 flow 在 merge 点前后也必须保持同一 lane / color。
func TestBuildGraph_BranchMergedBackIntoAnotherBranchKeepsFlowColor(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
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
			IsMerge:    len(parents) >= 2,
		}
	}

	commits := []git.CommitInfo{
		mk("m4", t0, []string{"m3"}),
		mk("b4", t0.Add(-time.Minute), []string{"bm"}),
		mk("bm", t0.Add(-2*time.Minute), []string{"a2", "b2"}), // parent 顺序反转
		mk("a2", t0.Add(-3*time.Minute), []string{"a1"}),
		mk("b2", t0.Add(-4*time.Minute), []string{"b1"}),
		mk("a1", t0.Add(-5*time.Minute), []string{"b1"}),
		mk("b1", t0.Add(-6*time.Minute), []string{"m2"}),
		mk("m3", t0.Add(-7*time.Minute), []string{"m2"}),
		mk("m2", t0.Add(-8*time.Minute), []string{"m1"}),
		mk("m1", t0.Add(-9*time.Minute), []string{}),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}
	commits[1].Refs = []string{"branch-b"}
	commits[1].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraph(commits)
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	head := nodeBySHA["b4"]
	for _, sha := range []string{"b4", "bm", "b2", "b1"} {
		node := nodeBySHA[sha]
		if node.Lane != head.Lane {
			t.Fatalf("%s lane = %d, want branch-b lane %d", sha, node.Lane, head.Lane)
		}
		if node.Color != head.Color {
			t.Fatalf("%s color = %d, want branch-b color %d", sha, node.Color, head.Color)
		}
	}

	for _, sha := range []string{"a2", "a1"} {
		node := nodeBySHA[sha]
		if node.Color == head.Color {
			t.Fatalf("%s color collapsed into branch-b color %d", sha, head.Color)
		}
	}
}

// TestBuildGraph_MergeEdgeToMergedBranchUsesParentFlowColor
// 验证 merge commit 指向“被合入分支 parent”的那条边，颜色必须跟随 parent flow，
// 不能继承 merge commit 自己的颜色，否则 UI 上会把分支上半段误涂成主干色。
func TestBuildGraph_MergeEdgeToMergedBranchUsesParentFlowColor(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
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
			IsMerge:    len(parents) >= 2,
		}
	}

	commits := []git.CommitInfo{
		mk("m4", t0, []string{"m3", "f1"}),
		mk("m3", t0.Add(-time.Minute), []string{"m2"}),
		mk("f1", t0.Add(-2*time.Minute), []string{"m2"}),
		mk("m2", t0.Add(-3*time.Minute), []string{}),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraph(commits)
	nodeBySHA := map[string]GraphNode{}
	for _, n := range result.Nodes {
		nodeBySHA[n.ShortSHA] = n
	}

	mainColor := nodeBySHA["m4"].Color
	featureColor := nodeBySHA["f1"].Color
	if featureColor == mainColor {
		t.Fatalf("fixture invalid: feature color collapsed into main color %d", mainColor)
	}

	found := false
	for _, e := range result.Edges {
		if e.FromRow == nodeBySHA["m4"].Row && e.ToRow == nodeBySHA["f1"].Row {
			found = true
			if e.Color != featureColor {
				t.Fatalf("merge edge color = %d, want merged-branch color %d", e.Color, featureColor)
			}
		}
	}
	if !found {
		t.Fatal("merge edge m4 -> f1 not found")
	}
}
