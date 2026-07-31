package graph

import (
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// layout_office_test.go — v0.8.34 移植：把 vscode-office 的 layoutEngine 1:1 移植
// 到 Go 后，端到端覆盖关键路径：
//   - linear history places every commit on lane 0
//   - branch-and-merge stitches lane 1 over the second parent
//   - multi-branch reuses lane 0 (trunk) and lane 1 (side branch)
//   - 17-commit DAG cycles colour index past 16 (recycling)
//   - angular-style LockedFirst flag is preserved on cross-lane transitions
//   - IsCommitted on each line = (lineIndex >= numUncommitted)
//   - empty input → empty GraphResult
//   - truncated flag is pass-through to GraphResult.Truncated
//
// 跟 layout_gitlens_test.go 风格保持一致：用 git.CommitInfo struct literal 构造
// DAG，断言 result.Nodes[i].Lane / result.Branches[i].Lines / result.Edges[i] 等
// 关键字段。

// officeTestCommit 构造 DAG fixture 的 helper（对齐 gitlens_test.go:34-41 mkRow）
func officeCommit(sha string, parents []string) git.CommitInfo {
	return git.CommitInfo{
		SHA:        sha,
		ShortSHA:   sha,
		Subject:    sha,
		AuthorWhen: time.Unix(0, 0),
		Parents:    parents,
	}
}

// fixtureOfficeLinear 4 commit 线性：A → B → C → D（最新在 row 0）
func fixtureOfficeLinear() []git.CommitInfo {
	return []git.CommitInfo{
		officeCommit("A", []string{"B"}),
		officeCommit("B", []string{"C"}),
		officeCommit("C", []string{"D"}),
		officeCommit("D", nil),
	}
}

// fixtureOfficeBranchAndMerge C 是 merge commit（parents=[A, B]，first=A 主线），
// B 是 A 上的分支，验证 B 在 lane 1 + C merge 斜切
func fixtureOfficeBranchAndMerge() []git.CommitInfo {
	return []git.CommitInfo{
		// row 0: C merge，先走 first parent A（主线），再 stitch B（lane 1）
		officeCommit("C", []string{"A", "B"}),
		// row 1: B branch off A
		officeCommit("B", []string{"A"}),
		// row 2: A main root
		officeCommit("A", nil),
	}
}

// fixtureOfficeMultiBranch F 是 merge（[E, C]），E 是 C 上的分支，D 是 C 上的分支
// 验证 lane 0 留给 trunk（A→B→C→E→F），D 走 lane 1 汇入 C
func fixtureOfficeMultiBranch() []git.CommitInfo {
	return []git.CommitInfo{
		officeCommit("F", []string{"E", "C"}),
		officeCommit("E", []string{"C"}),
		officeCommit("D", []string{"C"}),
		officeCommit("C", []string{"B"}),
		officeCommit("B", []string{"A"}),
		officeCommit("A", nil),
	}
}

// fixtureOfficeColourRecycling 构造 17 commit 跨越 16 色：每个 commit 都是独立 branch
// (新 root)，每开 16 个新 branch 后 colour index 必须回绕
func fixtureOfficeColourRecycling() []git.CommitInfo {
	commits := make([]git.CommitInfo, 0, 17)
	// row 0 是 head，parents 为空（独立 root）
	for i := 0; i < 17; i++ {
		sha := byte('A' + i)
		commits = append(commits, git.CommitInfo{
			SHA:        string(sha),
			ShortSHA:   string(sha),
			Subject:    string(sha),
			AuthorWhen: time.Unix(int64(i), 0),
			Parents:    nil, // 每个都是独立 root，强制开新 branch
		})
	}
	return commits
}

// fixtureOfficeCrossLaneTransition 跨 lane 转场 line：父 commit 与子 commit 不在同一 lane，
// 触发 LockedFirst 标志（lockedFirst = lastPoint.x < curPoint.x）
func fixtureOfficeCrossLaneTransition() []git.CommitInfo {
	// row 0: M merge (parents=[A, B])
	// row 1: A main
	// row 2: B branch off A 后的旁支（不通过 A 链）
	// 实际触发 office merge stitch：M 是 merge，A 已挂 branch0 时 B 触发 stitch
	// → stitch line (0,0)→(1,1) LockedFirst=true
	return []git.CommitInfo{
		officeCommit("M", []string{"A", "B"}),
		officeCommit("A", []string{"C"}),
		officeCommit("B", []string{"C"}),
		officeCommit("C", nil),
	}
}

// fixtureOfficeIsCommittedLines 构造一个 UNCOMMITTED + 4 commit 的 DAG，触发
// Branch.numUncommitted 累加（UNCOMMITTED segment 的 line.IsCommitted=false）
//
// 行号布局（git log 顺序：行号越大越早）：
//
//	row 0: UNC (UNCOMMITTED)         parents: [H]
//	row 1: H  head                   parents: [M]
//	row 2: M  merge                  parents: [B, P]
//	row 3: B  branch off P           parents: [P]
//	row 4: P  main trunk             parents: [R]
//	row 5: R  root                   parents: nil
//
// 注意 parents 数组顺序：office 处理时先走 first parent。每个 commit 的
// parent row 都 > child row（真实 git log 时序）。
func fixtureOfficeIsCommittedLines() []git.CommitInfo {
	return []git.CommitInfo{
		// row 0: UNCOMMITTED 虚拟 commit（first parent = HEAD）
		{
			SHA:        git.UNCOMMITTED_HASH,
			ShortSHA:   git.UNCOMMITTED_HASH,
			Subject:    "UNCOMMITTED",
			AuthorWhen: time.Unix(0, 0),
			Parents:    []string{"H"},
		},
		// row 1: H head
		officeCommit("H", []string{"M"}),
		// row 2: M merge（first parent = B 旁支，让 stitch 走 lane 1）
		officeCommit("M", []string{"B", "P"}),
		// row 3: B branch
		officeCommit("B", []string{"P"}),
		// row 4: P main
		officeCommit("P", []string{"R"}),
		// row 5: R root
		officeCommit("R", nil),
	}
}

// ----- Tests -----

// TestBuildGraphOffice_LinearHistory 对齐 office linear case：4 commit 全部 lane 0，
// 1 条 branch 3 条竖直线
func TestBuildGraphOffice_LinearHistory(t *testing.T) {
	commits := fixtureOfficeLinear()
	result := BuildGraphOffice(commits, "A", nil, false)

	if result.MaxLane != 0 {
		t.Errorf("linear history MaxLane=%d, want 0", result.MaxLane)
	}
	for _, n := range result.Nodes {
		if n.Lane != 0 {
			t.Errorf("linear history node %s Lane=%d, want 0", n.ShortSHA, n.Lane)
		}
	}
	// 1 条 branch（new branch 路径只开了 1 个）
	if len(result.Branches) != 1 {
		t.Errorf("linear branches=%d, want 1", len(result.Branches))
	}
	// 3 条 EdgeNormal
	if len(result.Edges) != 3 {
		t.Errorf("linear edges=%d, want 3", len(result.Edges))
	}
	for i, e := range result.Edges {
		if e.Type != EdgeNormal {
			t.Errorf("linear edge[%d] Type=%d, want EdgeNormal(0)", i, e.Type)
		}
	}
}

// TestBuildGraphOffice_BranchAndMerge A (main) → B (branch off A) → C (merge)：
// parents=[A, B] 让 office 先沿 A 主线走，再 stitch B 到 lane 1
func TestBuildGraphOffice_BranchAndMerge(t *testing.T) {
	commits := fixtureOfficeBranchAndMerge()
	result := BuildGraphOffice(commits, "C", nil, false)

	// 节点 lane：C=0 (main), B=1 (stitch 命中), A=0 (root)
	wantLane := map[string]int{"C": 0, "B": 1, "A": 0}
	for _, n := range result.Nodes {
		if got, ok := wantLane[n.ShortSHA]; ok && n.Lane != got {
			t.Errorf("node %s Lane=%d, want %d", n.ShortSHA, n.Lane, got)
		}
	}

	// C 是 merge（parents=2）
	cNode := result.Nodes[0]
	if !cNode.IsMerge {
		t.Errorf("C IsMerge=false, want true (parents=2)")
	}

	// 边：row0→row2 (C→A, lane 0→0 Normal), row0→row1 (C→B stitch, lane 0→1 Merge), row1→row2 (B→A, lane 1→0 Branch)
	wantEdgeTypes := map[string]EdgeType{
		"C->A": EdgeNormal,
		"C->B": EdgeMerge,
		"B->A": EdgeBranch,
	}
	gotEdgeTypes := map[string]EdgeType{}
	for _, e := range result.Edges {
		key := string(result.Nodes[e.FromRow].ShortSHA) + "->" + string(result.Nodes[e.ToRow].ShortSHA)
		gotEdgeTypes[key] = e.Type
	}
	for k, want := range wantEdgeTypes {
		if got := gotEdgeTypes[k]; got != want {
			t.Errorf("edge %s Type=%d, want %d", k, got, want)
		}
	}

	// 必须至少有 1 条 stitch line (LockedFirst=true) —— branch1 的 line 0 是 (0,0)→(1,1)
	foundStitch := false
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.Y1 == 0 && l.X1 == 0 && l.Y2 == 1 && l.X2 == 1 && l.LockedFirst {
				foundStitch = true
			}
		}
	}
	if !foundStitch {
		t.Errorf("merge stitch line (0,0)→(1,1) LockedFirst=true not found in branches")
	}

	// v0.8.37.1 回归：dot 颜色（node.Color）必须 = branch.color（即 edge.Color 槽位）。
	// 之前 v0.8.37 用 v.x % 16 当 node.Color，但 office 算法里 v.x 是 lane 编号不是 colour，
	// 跟 edge.Color = branch.colour % 16 分裂成两套色源 → 用户截图"绿 lane + 橙 dot"。
	// BuildGraphOffice 必须用 v.onBranch.getColour() % 16（office 算法一致性约束）。
	// 推导：每个 node 跟它的 outgoing edge（first parent）共享同一 branch.colour。
	branchColorByLane := map[int]int{}
	for _, e := range result.Edges {
		if e.Type == EdgeNormal { // first parent edge 是 branch 主色
			branchColorByLane[e.FromRow] = e.Color
		}
	}
	for _, n := range result.Nodes {
		if want, ok := branchColorByLane[n.Row]; ok && n.Color != want {
			t.Errorf("node %s (row=%d) Color=%d, want branch.Color=%d (dot/lane 色分裂)",
				n.ShortSHA, n.Row, n.Color, want)
		}
	}
}

// TestBuildGraphOffice_MultipleBranches F merge [E, C]，D 是 C 上的另一条 branch off，
// 验证 lane 复用（lane 0 留给 trunk，lane 1 给 D 那条支线）
func TestBuildGraphOffice_MultipleBranches(t *testing.T) {
	commits := fixtureOfficeMultiBranch()
	result := BuildGraphOffice(commits, "F", nil, false)

	wantLane := map[string]int{
		"F": 0, "E": 0, "D": 1, "C": 0, "B": 0, "A": 0,
	}
	for _, n := range result.Nodes {
		if got, ok := wantLane[n.ShortSHA]; ok && n.Lane != got {
			t.Errorf("node %s Lane=%d, want %d", n.ShortSHA, n.Lane, got)
		}
	}

	// F 是 merge（parents=2）
	fNode := result.Nodes[0]
	if !fNode.IsMerge {
		t.Errorf("F IsMerge=false, want true")
	}

	// D 必须不是 merge（parents=1）
	dNode := result.Nodes[2]
	if dNode.IsMerge {
		t.Errorf("D IsMerge=true, want false (parents=1)")
	}

	// 边：F→E (lane 0→0 Normal), F→C (lane 0→0 Normal), E→C (lane 0→0 Normal),
	// D→C (lane 1→0 Branch), C→B (0→0 Normal), B→A (0→0 Normal)
	wantEdges := map[string]struct {
		from, to int
		typ      EdgeType
	}{
		"F->E": {0, 1, EdgeNormal},
		"F->C": {0, 3, EdgeNormal},
		"E->C": {1, 3, EdgeNormal},
		"D->C": {2, 3, EdgeBranch},
	}
	gotEdges := map[string]struct {
		from, to int
		typ      EdgeType
	}{}
	for _, e := range result.Edges {
		key := string(result.Nodes[e.FromRow].ShortSHA) + "->" + string(result.Nodes[e.ToRow].ShortSHA)
		gotEdges[key] = struct {
			from, to int
			typ      EdgeType
		}{e.FromRow, e.ToRow, e.Type}
	}
	for k, want := range wantEdges {
		got, ok := gotEdges[k]
		if !ok {
			t.Errorf("expected edge %s missing", k)
			continue
		}
		if got.from != want.from || got.to != want.to || got.typ != want.typ {
			t.Errorf("edge %s got (row %d→%d, type %d), want (row %d→%d, type %d)",
				k, got.from, got.to, got.typ, want.from, want.to, want.typ)
		}
	}
}

// TestBuildGraphOffice_ColorRecycling 17 commit 跨越 16 色：getAvailableColour 回收
// 已结束 branch 的色（availableColours[i] < startAt），验证 colour index 回绕
func TestBuildGraphOffice_ColorRecycling(t *testing.T) {
	commits := fixtureOfficeColourRecycling()
	result := BuildGraphOffice(commits, "A", nil, false)

	// 17 个独立 root → 每个 vertex 触发 new branch path，colour index 应循环回 0
	// 取前 17 个 branch 的 Color 集合
	colors := make(map[int]bool)
	for _, b := range result.Branches {
		colors[b.Color] = true
	}
	if len(colors) > 16 {
		t.Errorf("distinct branch colors=%d, want ≤ 16 (recycle required)", len(colors))
	}
	// 必须出现 color=0 至少两次（一次给第一个 branch，回绕后再给第 17 个 branch）
	count0 := 0
	for _, b := range result.Branches {
		if b.Color == 0 {
			count0++
		}
	}
	if count0 < 2 {
		t.Errorf("color=0 reused %d times, want ≥ 2 (recycle test)", count0)
	}

	// MaxColor 必须是 16（对齐 Gitea Color16 队列）
	if result.MaxColor != 16 {
		t.Errorf("MaxColor=%d, want 16", result.MaxColor)
	}
}

// TestBuildGraphOffice_LockedFirstAngular 跨 lane 转场 line 的 LockedFirst 标志
// 对齐 office Branch.addLine：lockedFirst = lastPoint.x < curPoint.x
func TestBuildGraphOffice_LockedFirstAngular(t *testing.T) {
	commits := fixtureOfficeCrossLaneTransition()
	result := BuildGraphOffice(commits, "M", nil, false)

	// 必须有从 lane 0 → lane 1 的转场 line（lockedFirst = 0 < 1 = true）
	foundLocked := false
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.Y1 == 0 && l.Y2 == 1 && l.X1 != l.X2 {
				if l.X1 < l.X2 && l.LockedFirst {
					foundLocked = true
				}
				if l.X1 > l.X2 && !l.LockedFirst {
					foundLocked = true
				}
			}
		}
	}
	if !foundLocked {
		t.Errorf("cross-lane line with LockedFirst=true not found")
	}

	// 同时验证 LockedFirst=false 也存在：同 lane 竖直线
	foundUnlocked := false
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.X1 == l.X2 && !l.LockedFirst {
				foundUnlocked = true
				break
			}
		}
	}
	if !foundUnlocked {
		t.Errorf("same-lane vertical line with LockedFirst=false not found")
	}
}

// TestBuildGraphOffice_IsCommittedLineSplit 验证 UNCOMMITTED 触发的 numUncommitted 累加：
// Branch.addLine(isCommitted=false) → numUncommitted++；lineIndex >= numUncommitted 的 line
// 才算 committed（line.isCommitted = lineIndex >= numUncommitted）
func TestBuildGraphOffice_IsCommittedLineSplit(t *testing.T) {
	commits := fixtureOfficeIsCommittedLines()
	result := BuildGraphOffice(commits, git.UNCOMMITTED_HASH, nil, false)

	// vertices[0] (UNCOMMITTED) 必须 IsCommitted=false、IsCurrent=true
	uncNode := result.Nodes[0]
	if uncNode.IsCommitted {
		t.Errorf("UNCOMMITTED node IsCommitted=true, want false")
	}
	if !uncNode.IsCurrent {
		t.Errorf("UNCOMMITTED node IsCurrent=false, want true (set by setCurrent)")
	}

	// 至少有一个 branch 含混合 committed / uncommitted line
	foundMixed := false
	for _, b := range result.Branches {
		var committed, uncommitted bool
		for _, l := range b.Lines {
			if l.IsCommitted {
				committed = true
			} else {
				uncommitted = true
			}
		}
		if committed && uncommitted {
			foundMixed = true
		}
	}
	if !foundMixed {
		t.Errorf("no branch found with both committed and uncommitted lines (UNCOMMITTED → HEAD segment expected)")
	}
}

// TestBuildGraphOffice_EmptyCommits 空输入返回 &GraphResult{}（对齐 BuildGraphGitlens 边界）
func TestBuildGraphOffice_EmptyCommits(t *testing.T) {
	result := BuildGraphOffice(nil, "", nil, false)
	if result == nil {
		t.Fatalf("BuildGraphOffice returned nil, want empty GraphResult")
	}
	if len(result.Nodes) != 0 || len(result.Edges) != 0 || len(result.Branches) != 0 {
		t.Errorf("empty input produced non-empty result: %+v", result)
	}
	if result.MaxLane != 0 || result.MaxColor != 0 {
		t.Errorf("empty input MaxLane/MaxColor=%d/%d, want 0/0", result.MaxLane, result.MaxColor)
	}
}

// TestBuildGraphOffice_TruncatedPassesThrough truncated 标志必须从 BuildGraphOffice 入参
// 透传到 GraphResult.Truncated（与 layout_gitlens_test.go 的 truncated 行为一致）
func TestBuildGraphOffice_TruncatedPassesThrough(t *testing.T) {
	commits := fixtureOfficeLinear()
	result := BuildGraphOffice(commits, "A", nil, true)
	if !result.Truncated {
		t.Errorf("Truncated=false, want true (pass-through)")
	}

	result2 := BuildGraphOffice(commits, "A", nil, false)
	if result2.Truncated {
		t.Errorf("Truncated=true, want false (pass-through)")
	}
}

// TestBuildGraphOffice_UncommittedCurrent UNCOMMITTED 模式：commits[0] 触发 setNotCommitted
// + setCurrent，等价于 office 原版 layoutEngine.ts:322-329
func TestBuildGraphOffice_UncommittedCurrent(t *testing.T) {
	commits := []git.CommitInfo{
		{
			SHA:        git.UNCOMMITTED_HASH,
			ShortSHA:   git.UNCOMMITTED_HASH,
			Subject:    "UNCOMMITTED",
			AuthorWhen: time.Unix(0, 0),
			Parents:    []string{"H"},
		},
		officeCommit("H", []string{"R"}),
		officeCommit("R", nil),
	}
	result := BuildGraphOffice(commits, git.UNCOMMITTED_HASH, nil, false)

	// vertices[0] (UNCOMMITTED): IsCommitted=false, IsCurrent=true
	unc := result.Nodes[0]
	if unc.IsCommitted {
		t.Errorf("UNCOMMITTED node IsCommitted=true, want false")
	}
	if !unc.IsCurrent {
		t.Errorf("UNCOMMITTED node IsCurrent=false, want true")
	}
	// H/R 已 committed
	if !result.Nodes[1].IsCommitted {
		t.Errorf("H IsCommitted=false, want true")
	}
	if !result.Nodes[2].IsCommitted {
		t.Errorf("R IsCommitted=false, want true")
	}
}
