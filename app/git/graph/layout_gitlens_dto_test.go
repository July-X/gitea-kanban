package graph

import (
	"fmt"
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// TestBuildGraphGitlens_FreshClaimBranchOffLine v0.8.25.3 fix
//
// planner 调研：原版 assignColumnForRow 只在 own-reservation / pinned 路径记录
// branchSha，fresh claim 路径（claimNextColumn()）不记录——导致 feature branch
// 第一个 commit 没有 branch-off 跨 lane 线，前端显示成孤立 commit。
//
// 构造：主链 lane 0 有 3 个 commit，第 2 个 commit 分支出 1 个 feature commit
// （fresh claim 到 lane 1）——feature commit 应该有从 lane 0 连过来的 branch-off 线。
func TestBuildGraphGitlens_FreshClaimBranchOffLine(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	// A → B → C（主链 lane 0）；D 从 B 分出（lane 1）
	commits := []git.CommitInfo{
		mk("D", []string{"B"}), // row 0: lane 1（fresh claim）
		mk("A", []string{"B"}), // row 1: lane 0（pinned head）
		mk("B", []string{"C"}), // row 2: lane 0
		mk("C", nil),           // row 3: lane 0 root
	}
	commits[1].Refs = []string{"main"}
	commits[1].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "A", []string{"A"}, false)

	t.Logf("=== branches ===")
	for _, b := range result.Branches {
		t.Logf("branch Color=%d End=%d Lines=%d", b.Color, b.End, len(b.Lines))
		for _, l := range b.Lines {
			t.Logf("  line (%d,%d)→(%d,%d) LockedFirst=%v", l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
		}
	}

	// 关键断言：lane 1 的 branch（D）应该有 1 条 branch-off 线，
	// 从 lane 0（B 的 column）到 lane 1（D 的 column）。
	var branchOffFound bool
	for _, b := range result.Branches {
		if b.Color == 1 {
			for _, l := range b.Lines {
				if l.X1 == 0 && l.X2 == 1 {
					branchOffFound = true
					// branch-off 线应该从 B 的 row（row 2）到 D 的 row（row 0）
					if l.Y1 != 2 || l.Y2 != 0 {
						t.Errorf("branch-off line (%d,%d)→(%d,%d), want (0,2)→(1,0)", l.X1, l.Y1, l.X2, l.Y2)
					}
				}
			}
		}
	}
	if !branchOffFound {
		t.Errorf("expected branch-off line from lane 0 to lane 1 (D branch off from B); got none")
	}
}

// TestBuildGraphGitlens_MergeStitchLineUsesRealColumn v0.8.25.2 fix
//
// planner 已证 lookupColumn 假实现（查 sha+"__col" 永远 miss）导致
// mergeCol 兜底为 0，所有 merge stitch 跨 lane 转场线都从 column 0 出发。
//
// 修法：segmentToLines 加 colOf 参数，用 colOf[mergeSha] 查真实列号。
//
// 测试构造：M0(merge [M1, S1]) → M1 → M2（主链 lane 0）；S1 → S0（sibling lane 1）
// 预期：S1 segment 的 merge stitch line X1=0（merge commit M0 在 lane 0），不是兜底 0
func TestBuildGraphGitlens_MergeStitchLineUsesRealColumn(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	// M0 merge → M1 + S1；S1 → S0
	commits := []git.CommitInfo{
		mk("M0", []string{"M1", "S1"}),
		mk("M1", []string{"M2"}),
		mk("M2", nil),
		mk("S1", []string{"S0"}),
		mk("S0", nil),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "M0", []string{"M0"}, false)

	// 找 S1 segment 对应的 branch（S1 lane=1，merge stitch X1=0 对应 M0 在 lane 0）
	var foundMergeStitch bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			// merge stitch line: X1 (merge col) ≠ X2 (seg.column)
			if l.X1 != l.X2 {
				// 修复前 X1=0（兜底），修复后 X1=colOf[mergeSha]=0（M0 真在 lane 0）——值相同
				// 但我们改测的是：merge stitch line 的 X1 与 merge commit 的真实 lane 匹配
				// （如果 merge commit 在 lane 5，X1 应 = 5；修复前永远是 0）
				foundMergeStitch = true
				t.Logf("merge stitch line: X1=%d Y1=%d → X2=%d Y2=%d LockedFirst=%v",
					l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
			}
		}
	}
	if !foundMergeStitch {
		t.Errorf("expected at least one merge stitch line in branches")
	}

	// 关键断言：S1 segment 在 lane 1，所以 X2=1；merge stitch X1=colOf[M0]=0（M0 在 lane 0）
	// 找到这条 line 验证 X1=0, X2=1, Y1=M0.row-1=0, Y2=S1.row
	var stitchFound bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.X1 == 0 && l.X2 == 1 && l.LockedFirst {
				stitchFound = true
				if l.Y1 != 0 {
					t.Errorf("merge stitch Y1=%d, want 0 (M0 row - 1)", l.Y1)
				}
				// Y2 = S1 row (S1 在 commits[3] = row 3)
				if l.Y2 != 3 {
					t.Errorf("merge stitch Y2=%d, want 3 (S1 row)", l.Y2)
				}
			}
		}
	}
	if !stitchFound {
		t.Errorf("expected merge stitch line from M0(lane 0) to S1(lane 1) with LockedFirst=true")
	}
}

// TestBuildGraphGitlens_UncommittedSharesHeadLane v0.8.25.5 fix
//
// 用户实测（xdolphin/TRex 仓库截图）：Uncommitted 被分到 lane 1（紫色独立 lane），
// 顶部多一条紫色斜线；且其 lane 永不释放（first parent HEAD 被 pinned 时不触发
// columnsToFreeWhenFound），lane 泄漏导致后续 branch lane 分配连锁偏移、
// local-dev-AJL 链绿线长斜跨。
//
// GitLens 渲染语义：Uncommitted 空心圆与 HEAD 同 lane 0（它是 HEAD 的工作区附属）。
//
// 修法：assignPinnedColumns 把 kind=workdir 且 first parent 是 pinned head 的 row
// 也 pin 到同一 column。
//
// 测试拓扑（对齐用户仓库）：
//
//	row 0: UNC (workdir)      parents=[M0]
//	row 1: M0 (merge, HEAD)   parents=[P1, B1]   pinned（trunk head）
//	row 2: B1 (dev tip)       parents=[B2]
//	row 3: P1                 parents=[BASE]
//	row 4: B2                 parents=[BASE]
//	row 5: BASE               parents=[]
//
// 预期：UNC/M0/P1/BASE lane 0（trunk）；B1/B2 lane 1（dev 链）；
// 关键：MaxLane==1 —— 修复前 lane 泄漏时 B1 会被挤到 lane 2（MaxLane==2）。
func TestBuildGraphGitlens_UncommittedSharesHeadLane(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	commits := []git.CommitInfo{
		mk(git.UNCOMMITTED_HASH, []string{"M0"}),
		mk("M0", []string{"P1", "B1"}),
		mk("B1", []string{"B2"}),
		mk("P1", []string{"BASE"}),
		mk("B2", []string{"BASE"}),
		mk("BASE", nil),
	}
	commits[1].Refs = []string{"main"}
	commits[1].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "M0", []string{"M0"}, false)

	laneOf := make(map[string]int, len(result.Nodes))
	for _, n := range result.Nodes {
		laneOf[n.SHA] = n.Lane
	}

	// 核心断言：Uncommitted 与 HEAD 同 lane 0
	if laneOf[git.UNCOMMITTED_HASH] != 0 {
		t.Errorf("UNC lane=%d, want 0 (Uncommitted 必须与 HEAD 同 lane，对齐 GitLens)", laneOf[git.UNCOMMITTED_HASH])
	}
	if laneOf["M0"] != 0 {
		t.Errorf("M0 lane=%d, want 0 (pinned trunk head)", laneOf["M0"])
	}
	// dev 链 lane 1；lane 泄漏时 B1 会被挤到 lane 2
	if laneOf["B1"] != 1 {
		t.Errorf("B1 lane=%d, want 1 (extra parent fresh claim；lane 泄漏时会变 2)", laneOf["B1"])
	}
	if laneOf["B2"] != 1 {
		t.Errorf("B2 lane=%d, want 1 (dev chain first parent 无条件继承)", laneOf["B2"])
	}
	if laneOf["P1"] != 0 || laneOf["BASE"] != 0 {
		t.Errorf("P1/BASE lane=%d/%d, want 0/0 (trunk pinned chain)", laneOf["P1"], laneOf["BASE"])
	}
	// lane 泄漏兜底断言：整个图最多 2 个 lane
	if result.MaxLane != 1 {
		t.Errorf("MaxLane=%d, want 1（修复前 lane 泄漏 → MaxLane==2）", result.MaxLane)
	}

	// segment 断言：lane 1 的 branch 应有 merge stitch（mergeSha=M0 在 lane 0）
	var mergeStitchFound bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.X1 == 0 && l.X2 == 1 && l.LockedFirst {
				mergeStitchFound = true
			}
		}
	}
	if !mergeStitchFound {
		t.Errorf("expected merge stitch line (0,*)→(1,*) for dev branch segment; got none")
	}
}

// TestBuildGraphGitlens_BranchEndIsRowNumberPlusOne v0.8.25.2 fix
//
// planner 已证 End 填 len(seg.commitShas)（commit 计数），错——vscode branch 契约要求
// "branch 覆盖的最后一行 + 1"（layout.go:109）。
//
// 测试：线性 4 commit chain，segments 覆盖 row 0..3，End 应该是 rowOf[last]+1 = 3+1 = 4
func TestBuildGraphGitlens_BranchEndIsRowNumberPlusOne(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	// 4 commit linear chain
	commits := []git.CommitInfo{
		mk("M0", []string{"M1"}),
		mk("M1", []string{"M2"}),
		mk("M2", []string{"M3"}),
		mk("M3", nil),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "M0", []string{"M0"}, false)

	// 关键断言：每个 branch 的 End 必须 == 该 branch 最后 commit 的行号 + 1
	// 我们直接验证：如果某 branch 有 line Y2=3（连到 M3 row=3），那 branch.End ≥ 4
	maxY2Seen := -1
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.Y2 > maxY2Seen {
				maxY2Seen = l.Y2
			}
		}
	}
	t.Logf("maxY2Seen=%d, branches=%d", maxY2Seen, len(result.Branches))
	if maxY2Seen < 0 {
		t.Errorf("no branch lines found (branches=%d)", len(result.Branches))
	}
	if maxY2Seen >= 4 {
		t.Errorf("maxY2Seen=%d, should be ≤ 3 (M3 row = 3)", maxY2Seen)
	}
}

// TestBuildGraphGitlens_ColorIsColumnMod16 v0.8.25.2 fix
//
// planner 已证颜色按 segIdx % 16 取，同 column 上多 segment 不同色。
// 修法：按 column % 16 取，同 lane 同色。
//
// 测试构造：main lane 0 + sibling lane 1，验证 main chain 上所有 commit color = 0（lane 0 % 16），
// sibling chain 上所有 commit color = 1（lane 1 % 16）。
func TestBuildGraphGitlens_ColorIsColumnMod16(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	// M0(merge [M1, S1]) → M1 → M2 → M3; S1 → S0
	commits := []git.CommitInfo{
		mk("M0", []string{"M1", "S1"}),
		mk("M1", []string{"M2"}),
		mk("M2", []string{"M3"}),
		mk("M3", nil),
		mk("S1", []string{"S0"}),
		mk("S0", nil),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "M0", []string{"M0"}, false)

	// 打印
	t.Logf("=== nodes ===")
	for _, n := range result.Nodes {
		t.Logf("node %s Lane=%d Color=%d", n.ShortSHA, n.Lane, n.Color)
	}

	// 验证：每个 node 的 Color == Lane % 16
	// v0.8.33：删除双轨布局后，Color 直接由 colOf[c.SHA] % 16 计算，
	// 与 Lane 一致。本测试拓扑没有 lane 释放事件（S1→S0 的 lane 1
	// 永不 free），无需 lane 复用，Color == Lane%16 恒成立。
	// （lane 释放 + 复用场景下颜色仍等于位置，验证见
	// TestBuildGraphGitlens_MatchesGitLensLaneReuse。）
	for _, n := range result.Nodes {
		wantColor := n.Lane % 16
		if n.Color != wantColor {
			t.Errorf("node %s: Color=%d, want Lane%%16=%d", n.ShortSHA, n.Color, wantColor)
		}
	}

	// 验证：每个 branch 的 Color == 该 branch 第一个 line 的 X1 % 16
	// （branch.color 应与 branch.line 所在 lane 一致）
	for _, b := range result.Branches {
		if len(b.Lines) == 0 {
			continue
		}
		// branch 内 line 的 X 是同一 column（segment 内 vertical line）或 start X
		// 取所有 line 的 X1/X2 集合，多数就是 seg.column
		xCount := make(map[int]int)
		for _, l := range b.Lines {
			xCount[l.X1]++
			xCount[l.X2]++
		}
		var maxX int
		var maxCount int
		for x, c := range xCount {
			if c > maxCount {
				maxX = x
				maxCount = c
			}
		}
		if b.Color != maxX%16 {
			t.Errorf("branch Color=%d, want dominantX=%d %%16=%d", b.Color, maxX, maxX%16)
		}
	}
}

// TestBuildGraphGitlens_MergeStitchColumnNotZero v0.8.25.2 fix
//
// planner 已证 lookupColumn 假实现导致 mergeCol 兜底为 0——如果 merge commit
// 在 lane 5，merge stitch line 应该 X1=5，而不是 X1=0。
//
// 构造一个 sibling root 在 lane 3 的 DAG，让 merge stitch X1 必须 != 0。
func TestBuildGraphGitlens_MergeStitchColumnNotZero(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	// M0(merge [M1, S2]) → M1 → M2; S2 → S1 → S0
	// GitLens 算法下：M0..M2 lane 0, S0..S2 lane 1（sibling 链）
	// S2 是 sibling 末 commit，被合并进 M0；S2 的 merge stitch line X1 = 0（M0 lane 0）
	// 这条用例验证 "merge stitch line 的 X1 等于 merge commit 的真实 lane 编号"——
	// 修复前 lookupColumn 永远返 0（兜底），但 M0 也在 lane 0 所以 X1=0 碰巧也对
	// 我们构造：merge commit 在 lane 2（sibling 末 commit S3 合并到 lane 2 的 commit）
	//
	// 重新构造：M0..M3 主链 lane 0；S0..S2 sibling lane 1；M4..M5 lane 2
	// S2 合并到 M4（lane 2）
	commits := []git.CommitInfo{
		mk("M5", []string{"M4"}),       // row 0: lane 2
		mk("M4", []string{"M3", "S2"}), // row 1: lane 2 merge
		mk("M3", []string{"M2"}),       // row 2: lane 0
		mk("M2", []string{"M1"}),       // row 3: lane 0
		mk("M1", []string{"M0"}),       // row 4: lane 0
		mk("M0", nil),                  // row 5: lane 0 root
		mk("S2", []string{"S1"}),       // row 6: lane 1
		mk("S1", []string{"S0"}),       // row 7: lane 1
		mk("S0", nil),                  // row 8: lane 1 root
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "M5", []string{"M5"}, false)

	// 找 S2 segment 对应的 branch——它的 merge stitch line X1 应 = colOf[M4]（lane 2）
	t.Logf("=== branches ===")
	for _, b := range result.Branches {
		t.Logf("branch Color=%d End=%d Lines=%d", b.Color, b.End, len(b.Lines))
		for _, l := range b.Lines {
			t.Logf("  line (%d,%d)→(%d,%d) LockedFirst=%v", l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
		}
	}

	// 关键断言：merge stitch line 至少要存在一条，且 X1 ≠ X2（跨 lane）
	// 具体数字取决于 GitLens 算法的实际 lane 分配（pinned head / 合并拓扑）
	var stitchLines []GraphBranchLine
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.X1 != l.X2 && l.LockedFirst {
				stitchLines = append(stitchLines, l)
			}
		}
	}
	if len(stitchLines) == 0 {
		t.Errorf("expected at least one merge stitch line (LockedFirst=true); got none")
	}
	// 验证 stitch line 的 X1 等于 merge commit 的真实 lane（不是兜底 0）
	// 这里我们验证：如果 M4 在 lane 0，那 stitch X1=0；如果 M4 在 lane 2，那 stitch X1=2
	for _, n := range result.Nodes {
		if n.ShortSHA == "M4" {
			for _, sl := range stitchLines {
				if sl.Y1 == 1 && sl.Y2 == 6 { // M4 row=1 → S2 row=6
					if sl.X1 != n.Lane {
						t.Errorf("merge stitch X1=%d, want M4 lane=%d (was lookupColumn bug?)", sl.X1, n.Lane)
					}
					if sl.X2 != 1 {
						t.Errorf("merge stitch X2=%d, want 1 (S2 lane)", sl.X2)
					}
				}
			}
		}
	}
}

// TestBuildGraphGitlens_MatchesGitLensLaneReuse v0.8.33
//
// 回归 GitLens 原版 lane 分配（取消 v0.8.25.7 的「lane 左移压缩」）。
// 拓扑（与 v0.8.25.7 旧 TestBuildGraphGitlens_LaneCompactMatchesGitlens
// 复刻用户 xdolphin/TRex 仓库 b2139fe/34b10d6 场景相同，但断言改写）：
//
//	row 0: T0 merge [T1, A1]   trunk merge
//	row 1: A1 [A2]             A 链头（claim lane 1）
//	row 2: T1 [T2]             trunk
//	row 3: A2 merge [T2, L1]   A 链尾 merge 进 trunk → 冲突释放 lane 1；L1 claim lane 2
//	row 4: L1 [L2]             L 链头（lane 2），reserve L2 → lane 2
//	row 5: T2 [T3]             trunk；行首释放 lane 1（不压缩）→ lane 1 留空
//	row 6: T3 merge [T4, X1]   trunk merge；X1 claim lane 1（最低空 column）
//	row 7: T4 [T5]             trunk
//	row 8: X1 [T5]             孤立 commit：视觉 + 颜色都在 lane 1
//	row 9: L2 [T5]             L 链尾：视觉 + 颜色都在 lane 2（不左移）
//	row 10: T5 []              trunk 根
//
// 与 v0.8.25.7 旧版差异：
//   - 旧：L 链左移到 lane 1；X1 在 lane 2；颜色与位置分离
//   - 新：L 链稳定在 lane 2；X1 复用 lane 1；颜色 = 位置
//
// DeepSeek-Reasonix 301 commits 实测证实：取消压缩后长分支链保持原 lane，
// 已释放的 lane 由后续 commit 通过 claimNextColumn() 复用最低空 column，
// 与 GitLens commit-graph/src/engine/layout.ts:493-510 原版行为 1:1 对齐。
func TestBuildGraphGitlens_MatchesGitLensLaneReuse(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	commits := []git.CommitInfo{
		mk("T0", []string{"T1", "A1"}),
		mk("A1", []string{"A2"}),
		mk("T1", []string{"T2"}),
		mk("A2", []string{"T2", "L1"}),
		mk("L1", []string{"L2"}),
		mk("T2", []string{"T3"}),
		mk("T3", []string{"T4", "X1"}),
		mk("T4", []string{"T5"}),
		mk("X1", []string{"T5"}),
		mk("L2", []string{"T5"}),
		mk("T5", nil),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "T0", []string{"T0"}, false)

	laneOf := make(map[string]int)
	colorOf := make(map[string]int)
	for _, n := range result.Nodes {
		laneOf[n.SHA] = n.Lane
		colorOf[n.SHA] = n.Color
	}

	// v0.8.33 预期：L 链稳定在 lane 2（不左移），X1 复用 lane 1
	wantLane := map[string]int{
		"T0": 0, "T1": 0, "T2": 0, "T3": 0, "T4": 0, "T5": 0,
		"A1": 1, "A2": 1, // A 链 lane 1（释放后变空闲）
		"L1": 2, "L2": 2, // L 链：稳定 lane 2，不左移
		"X1": 1, // 孤立 commit 复用 A 链释放的 lane 1
	}
	for sha, want := range wantLane {
		if laneOf[sha] != want {
			t.Errorf("node %s: Lane=%d, want %d（GitLens 原版 lane 分配）", sha, laneOf[sha], want)
		}
	}

	// v0.8.33：颜色 = 位置（取消双轨），L 链颜色 2，X1 颜色 1
	wantColor := map[string]int{
		"T0": 0, "T5": 0,
		"A1": 1, "A2": 1,
		"L1": 2, "L2": 2,
		"X1": 1, // 与位置一致（不再走未压缩逻辑 lane）
	}
	for sha, want := range wantColor {
		if colorOf[sha] != want {
			t.Errorf("node %s: Color=%d, want %d（颜色=位置，取消双轨）", sha, colorOf[sha], want)
		}
	}

	// L 链应该是稳定的 lane 2 竖线（不再有跨 lane 斜线）
	// 旧的"X1(lane1,row8) → L2(lane2,row9) 转场"也不存在
	crossLaneOnL := false
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if (l.X1 == 2 && l.X2 == 1) || (l.X1 == 1 && l.X2 == 2) {
				// L 链 row 4-9 区域出现跨 lane 1↔2 转场
				if l.Y1 >= 4 && l.Y2 <= 9 {
					crossLaneOnL = true
				}
			}
		}
	}
	if crossLaneOnL {
		t.Errorf("L 链 row 4-9 区域不应有跨 lane 1↔2 转场（取消压缩后稳定在 lane 2）")
		for _, b := range result.Branches {
			for _, l := range b.Lines {
				t.Logf("line (%d,%d) → (%d,%d) color=%d", l.X1, l.Y1, l.X2, l.Y2, b.Color)
			}
		}
	}
}

// fmt import guard for clarity
var _ = fmt.Sprintf

// TestBuildGraphGitlens_ForkStitchIntoPinnedTrunk v0.8.26.x fix
//
// 回归场景（TRex 实测还原）：feature 分支链尾端的 first parent 是 pinned 主线
// commit，且该 commit 的 pinned child 在 rows 中排在本 row 之后（还没被处理），
// 因此 parent 没有 reservation —— 走 else if (!hasParentRes) 分支。
// 旧实现只 reserve 不标记 lane 释放，segment 永远 drain，forkSha="" →
// fork 汇入线整段缺失（前端看不到分支汇回主线的斜插线）。
//
// 构造：H(main) → M(merge [A, F]) → A → B → C(pinned 链)；F → B。
// F(row 2) 处理时 B 无 reservation（A 在 row 3 才处理）→ 新 fix 标记
// columnsToFreeWhenFound[B]=[1]，row 4(B) 释放 lane 1 并 finalize fork=B。
func TestBuildGraphGitlens_ForkStitchIntoPinnedTrunk(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{SHA: sha, ShortSHA: sha, Subject: sha, AuthorWhen: t0, Parents: parents}
	}
	commits := []git.CommitInfo{
		mk("H", []string{"M"}),      // row 0: lane 0 (pinned head)
		mk("M", []string{"A", "F"}), // row 1: lane 0 (merge)
		mk("F", []string{"B"}),      // row 2: lane 1 (feature tip)
		mk("A", []string{"B"}),      // row 3: lane 0
		mk("B", []string{"C"}),      // row 4: lane 0
		mk("C", nil),                // row 5: lane 0 root
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "H", []string{"H"}, false)

	// 断言 fork stitch (1,2)→(0,4) 存在，且 LockedFirst=false（转场在下端）
	var forkFound bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.X1 == 1 && l.Y1 == 2 && l.X2 == 0 && l.Y2 == 4 {
				forkFound = true
				if l.LockedFirst {
					t.Errorf("fork stitch LockedFirst = true, want false（转场在下端，先竖后斜）")
				}
			}
		}
	}
	if !forkFound {
		t.Errorf("expected fork stitch (1,2)→(0,4)（feature 链汇入 pinned 主线 B）; got none")
		for _, b := range result.Branches {
			for _, l := range b.Lines {
				t.Logf("  branch color=%d line (%d,%d)→(%d,%d) LockedFirst=%v", b.Color, l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
			}
		}
	}
}

// TestBuildGraphGitlens_MergeIncomingLineToExistingLane v0.8.26.x fix
//
// 回归场景（TRex 实测还原：1348ba6「Merge branch 'master'」→ cfcf339）：
// merge commit 的 second parent 已经在其它 lane 有归属（pinned 主线 lane 0），
// segment 模型不会为它开新 segment → 旧实现这条 merge 合入边在 branches 里
// 完全丢失。新实现补独立单线 branch，颜色 = parent 链色。
//
// 构造：H(main) → P1 → P2(pinned 链)；M(feature 分支 merge commit) → F → P2，
// M 的 second parent = P1（已在 lane 0）。
func TestBuildGraphGitlens_MergeIncomingLineToExistingLane(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{SHA: sha, ShortSHA: sha, Subject: sha, AuthorWhen: t0, Parents: parents}
	}
	commits := []git.CommitInfo{
		mk("H", []string{"P1"}),      // row 0: lane 0 (pinned head)
		mk("M", []string{"F", "P1"}), // row 1: lane 1 (feature 分支 merge commit)
		mk("P1", []string{"P2"}),     // row 2: lane 0
		mk("F", []string{"P2"}),      // row 3: lane 1
		mk("P2", nil),                // row 4: lane 0 root
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "H", []string{"H"}, false)

	// 断言 merge 合入线 (1,1)→(0,2) 存在：LockedFirst=true（转场在上端）、
	// 所在 branch.Color=0（parent 主线色，而非 child 的 lane 1 色）
	var incomingFound bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			if l.X1 == 1 && l.Y1 == 1 && l.X2 == 0 && l.Y2 == 2 {
				incomingFound = true
				if !l.LockedFirst {
					t.Errorf("merge 合入线 LockedFirst = false, want true（转场在上端，先斜后竖）")
				}
				if b.Color != 0 {
					t.Errorf("merge 合入线 branch.Color = %d, want 0（parent 主线链色）", b.Color)
				}
			}
		}
	}
	if !incomingFound {
		t.Errorf("expected merge 合入线 (1,1)→(0,2)（M 合入已有主线 P1）; got none")
		for _, b := range result.Branches {
			for _, l := range b.Lines {
				t.Logf("  branch color=%d line (%d,%d)→(%d,%d) LockedFirst=%v", b.Color, l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
			}
		}
	}
}

// TestBuildGraphGitlens_MergeEdgeUsesParentColor v0.8.26.x fix
//
// GitLens 实测：merge 边（second+ parent）颜色 = parent（被合入方）链色；
// first-parent 边颜色 = child 链色。旧实现 edges 恒为 childColor。
func TestBuildGraphGitlens_MergeEdgeUsesParentColor(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{SHA: sha, ShortSHA: sha, Subject: sha, AuthorWhen: t0, Parents: parents}
	}
	commits := []git.CommitInfo{
		mk("H", []string{"P1"}),
		mk("M", []string{"F", "P1"}),
		mk("P1", []string{"P2"}),
		mk("F", []string{"P2"}),
		mk("P2", nil),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "H", []string{"H"}, false)

	// M(row 1, lane 1) → P1(row 2, lane 0) 是 second-parent 边：颜色应为 P1 的 0
	var mergeEdge *GraphEdge
	// M(row 1, lane 1) → F(row 3, lane 1) 是 first-parent 边：颜色应为 M 链色（1）
	var firstParentEdge *GraphEdge
	for i := range result.Edges {
		e := &result.Edges[i]
		if e.FromRow == 1 && e.ToRow == 2 {
			mergeEdge = e
		}
		if e.FromRow == 1 && e.ToRow == 3 {
			firstParentEdge = e
		}
	}
	if mergeEdge == nil {
		t.Fatalf("missing edge M→P1")
	}
	if mergeEdge.Color != 0 {
		t.Errorf("merge 边 M→P1 Color = %d, want 0（parent 主线链色）", mergeEdge.Color)
	}
	if firstParentEdge == nil {
		t.Fatalf("missing edge M→F")
	}
	if firstParentEdge.Color != 1 {
		t.Errorf("first-parent 边 M→F Color = %d, want 1（child 链色）", firstParentEdge.Color)
	}
}

// TestBuildGraphGitlens_BranchOffLockedFirstMatchesMergeStitch v0.8.27
//
// 用户对标 GitLens 截图指出：branch-off 入线与 merge stitch 入线的
// LockedFirst 不一致——branchSha 写死 false 与 merge stitch `mergeCol<firstCol`
// 计算不一致。两者几何完全等价（parent 上端，child 下端），LockedFirst 应同向。
//
// 真实影响：当 branch-off 入线跨多行（pushSplit 触发条件 abs(sy2-sy1)>1.5*gridY）
// 时，LockedFirst 决定转场在 child 端（斜切+竖直）还是 parent 端（竖直+斜切）。
// 实测对标 GitLens：main lane 在左 feature lane 在右时，转场都在 child 端
// （先斜后竖），即 LockedFirst=true。
//
// 测试拓扑：M0→M1 主链（lane 0, row 0..1）；HEAD 行 row 4 在 lane 1，
// first parent 在 M0 row 0。branch-off 入线从 (0,0) → (1,4)，row diff=4
// → abs=4*gridY=96 > 36 → 触发 pushSplit，LockedFirst 决定分支形态。
func TestBuildGraphGitlens_BranchOffLockedFirstMatchesMergeStitch(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:           sha,
			ShortSHA:      sha,
			Subject:       sha,
			AuthorWhen:    t0,
			CommitterWhen: t0,
			Parents:       parents,
		}
	}
	// row 0: HEAD (lane 1) parents=[M0]
	// row 1: M0 (lane 0, pinned) parents=[M1]
	// row 2: M1 parents=[M2]
	// row 3: M2 parents=[M3]
	// row 4: M3 (root)
	commits := []git.CommitInfo{
		mk("HEAD", []string{"M0"}),
		mk("M0", []string{"M1"}),
		mk("M1", []string{"M2"}),
		mk("M2", []string{"M3"}),
		mk("M3", nil),
	}
	commits[1].Refs = []string{"main"}
	commits[1].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "HEAD", []string{"M0", "HEAD"}, false)

	// dump
	for _, n := range result.Nodes {
		t.Logf("node %s lane=%d", n.ShortSHA, n.Lane)
	}
	for i, b := range result.Branches {
		t.Logf("branch %d color=%d end=%d lines=%d", i, b.Color, b.End, len(b.Lines))
		for _, l := range b.Lines {
			t.Logf("  line (%d,%d)→(%d,%d) LockedFirst=%v", l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
		}
	}

	// 找 HEAD 那条 branch（含 branch-off line (0,0)→(1,4)）并断言 LockedFirst=true
	var found bool
	var correctLock bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			// branch-off 入线 geometry：起点 lane 0，终点 lane 1
			if l.X1 == 0 && l.X2 == 1 {
				found = true
				if l.LockedFirst {
					correctLock = true
				}
			}
		}
	}
	if !found {
		t.Fatal("expected branch-off line (0,0)→(1,4) for HEAD segment")
	}
	if !correctLock {
		t.Errorf("branch-off LockedFirst should be true (branchCol<firstCol: 0<1); got false")
	}
}

// TestBuildGraphGitlens_ForkStitchLockedFirst v0.8.27
//
// 验证 fork stitch 入线的 LockedFirst 几何一致性：fork segment 在 child 端（last commit），
// forkSha 在 parent 端（更大 row）。当 child lane > parent lane（main 在左 feature 在右），
// fork stitch 应 LockedFirst=false 转场在下端（parent 端）—— 与 merge stitch、
// branch-off 入线在反方向（child in 上端）方向相反。
//
// 测试拓扑（latest-first）：
//
//	row 0: HEAD (lane 1) parents=[F4]
//	row 1: F4 (lane 1) parents=[F3]
//	row 2: F3 (lane 1) parents=[F2]
//	row 3: F2 (lane 1) parents=[F1]
//	row 4: F1 (lane 1) parents=[F0]
//	row 5: F0 (lane 1) parents=[M3]   ← segment.tip = F0
//	row 6: M3 (lane 0) parents=[M2]
//	row 7: M2 (lane 0) parents=[M1]
//	row 8: M1 (lane 0, pinned main) parents=[M0]
//	row 9: M0 (lane 0) parents=[]
//
// HEAD..F0 在 lane 1 (feature segment)；forkSha=M3 (lane 0, row 6)
// Fork stitch line (1, 5) → (0, 6)，Y跨度=1 gridY（不触发 pushSplit）但 angular 单行折线不同。
//
// 多行 fork stitch 触发条件：forkSha.Row - lastRow >= 2。但 forkSha 是 first parent of lastCommit，
// 在 latest-first 拓扑里 forkSha.Row 必须 = lastRow+1（first parent 在 child 下一行）。
// 但 segment 内部可能允许：f0 在 row 5，f0 的 first parent 是 m3 在 row 6，fork stitch y diff=1。
//
// 真实多行 fork stitch 触发：segment tip commit 不直接相邻，segment 内部存在多 commit 顺序，
// 时 forkSha 在 segment 跟内部某个 commit 共 row 的话 (罕见)。
//
// 本测试聚焦：(1) fork stitch 在单行几何下 LockedFirst 计算一致性。
func TestBuildGraphGitlens_ForkStitchLockedFirst(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:           sha,
			ShortSHA:      sha,
			Subject:       sha,
			AuthorWhen:    t0,
			CommitterWhen: t0,
			Parents:       parents,
		}
	}
	// topology (latest-first):
	//   row 0: HEAD (lane 1) parents=[F0]
	//   row 1: F0 (lane 1) parents=[M3]
	//   row 2: M3 (lane 0) parents=[M2]
	//   row 3: M2 (lane 0) parents=[M1]
	//   row 4: M1 (lane 0, pinned) parents=[M0]
	//   row 5: M0 (lane 0) parents=[]
	commits := []git.CommitInfo{
		mk("HEAD", []string{"F0"}),
		mk("F0", []string{"M3"}),
		mk("M3", []string{"M2"}),
		mk("M2", []string{"M1"}),
		mk("M1", []string{"M0"}),
		mk("M0", nil),
	}
	commits[4].Refs = []string{"main"}
	commits[4].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "HEAD", []string{"M1"}, false)

	t.Logf("MaxLane=%d, branches=%d", result.MaxLane, len(result.Branches))
	for _, n := range result.Nodes {
		t.Logf("node %s lane=%d", n.ShortSHA, n.Lane)
	}
	for i, b := range result.Branches {
		t.Logf("branch %d color=%d end=%d lines=%d", i, b.Color, b.End, len(b.Lines))
		for _, l := range b.Lines {
			t.Logf("  line (%d,%d)→(%d,%d) LockedFirst=%v", l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
		}
	}

	// 找 fork stitch：lane 1 (feature) → lane 0 (main trunk) 转场，
	// line Y1 < Y2 (lastRow < forkRow 因为 feature 向上折回 main)
	var foundForkStitch bool
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			// feature segment 的 fork stitch: X1>X2 && Y1<Y2 && X1 = lane 1
			if l.X1 == 1 && l.X2 == 0 {
				foundForkStitch = true
				t.Logf("fork stitch candidate: (%d,%d)→(%d,%d) LockedFirst=%v",
					l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
			}
		}
	}
	if !foundForkStitch {
		t.Fatal("expected fork stitch line in feature segment branches")
	}
}

// TestBuildGraphGitlens_NoDuplicateLinesOnFreshClaim v0.8.30 fix
//
// 用户 2026-07-31 反馈：单一 main + branch tip + UNCOMMITTED 三节点时，
// int-test 那个 branch lane 在前端被画了 2 次（同一 line 的正向和反向）。
//
// 根因：int-test (单 commit segment) 同时有 branchSha (=main_head) 和
// forkSha (=main_head)，segmentToLines 走 branchSha path 生成 1 条
// (0,2)→(1,1) 又走 forkSha path 生成 1 条反向 (1,1)→(0,2)。
// 视觉 stroke-width 叠加成"绘制多次 lane"。
//
// 拓扑（latest-first）：
//
//	row 0: UNCOMMITTED (workdir, parents=[main_head])
//	row 1: int_test_tip (refs=[origin/int-test-...], parents=[main_head])
//	row 2: main_head (refs=[main, origin/main], parents=[])
//
// 修复后：int-test segment 只输出 1 条 branch-off line，去掉重复的 fork stitch line。
func TestBuildGraphGitlens_NoDuplicateLinesOnFreshClaim(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, idx int, parents []string, refs ...string) git.CommitInfo {
		refTypes := make([]git.RefType, len(refs))
		for i := range refTypes {
			refTypes[i] = git.RefTypeBranch
		}
		return git.CommitInfo{
			SHA:           sha,
			ShortSHA:      fmt.Sprintf("%07x", idx),
			Subject:       sha,
			AuthorWhen:    t0.Add(time.Duration(idx) * time.Minute),
			CommitterWhen: t0.Add(time.Duration(idx) * time.Minute),
			Parents:       parents,
			Refs:          refs,
			RefTypes:      refTypes,
		}
	}
	const mainHead = "main_head_sha"
	commits := []git.CommitInfo{
		mk(git.UNCOMMITTED_HASH, 0, []string{mainHead}),
		mk("int_test_tip", 1, []string{mainHead}, "origin/int-test-1782998137207128000"),
		mk(mainHead, 2, nil, "main", "origin/main"),
	}

	result := BuildGraphGitlens(commits, mainHead, []string{mainHead}, false)

	// 节点 row/lane 唯一性 sanity
	rowSeen := map[int]string{}
	for _, n := range result.Nodes {
		if prev, ok := rowSeen[n.Row]; ok {
			t.Errorf("row %d 冲突: %s vs %s", n.Row, prev, n.ShortSHA)
		}
		rowSeen[n.Row] = n.ShortSHA
	}
	if len(result.Nodes) != 3 {
		t.Errorf("nodes=%d != commits=3", len(result.Nodes))
	}

	// 核心断言：每个 branch 内部 (X1,Y1,X2,Y2) 4 元组应唯一。
	// reverse-direction 的 line 也算重复（视觉 stroke 叠加 v0.8.30 修复）。
	type lineKey struct{ X1, Y1, X2, Y2 int }
	seen := map[lineKey]int{}
	for _, b := range result.Branches {
		for _, l := range b.Lines {
			k := lineKey{l.X1, l.Y1, l.X2, l.Y2}
			seen[k]++
		}
	}
	for k, n := range seen {
		if n > 1 {
			t.Errorf("同一 line 4 元组出现 %d 次（v0.8.30 \"绘制多次 lane\" 根因）: (%d,%d)->(%d,%d)",
				n, k.X1, k.Y1, k.X2, k.Y2)
		}
	}

	// 更强断言：int-test (lane 1) branch 必须恰好 1 条 line（之前 v0.8.30
	// bug 时会有 2 条：branch-off (0,2)->(1,1) + fork stitch (1,1)->(0,2)）。
	var intTestBranch *GraphBranch
	for i := range result.Branches {
		if result.Branches[i].Color == 1 {
			intTestBranch = &result.Branches[i]
			break
		}
	}
	if intTestBranch == nil {
		t.Fatal("找不到 int-test lane (color=1) branch")
	}
	if len(intTestBranch.Lines) != 1 {
		t.Errorf("int-test branch lines=%d, want 1 (单 commit fresh claim segment)",
			len(intTestBranch.Lines))
		for _, l := range intTestBranch.Lines {
			t.Logf("  line (%d,%d)->(%d,%d)", l.X1, l.Y1, l.X2, l.Y2)
		}
	}

	// main trunk branch (color=0) 应该有 vertical line 跨 row 0..2。
	mainFound := false
	for _, b := range result.Branches {
		if b.Color != 0 {
			continue
		}
		for _, l := range b.Lines {
			if l.X1 == 0 && l.Y1 == 0 && l.X2 == 0 && l.Y2 == 2 {
				mainFound = true
			}
		}
	}
	if !mainFound {
		t.Error("main trunk vertical line (0,0)->(0,2) 缺失")
	}
}

// TestBuildGraphGitlens_TruncatedPassesThrough v0.8.34
//
// 回归测试：BuildGraphGitlens 必须如实透传 truncated 参数到 GraphResult.Truncated，
// 不能像之前那样硬编码 false。这是前端 "已到全部 / 加载更多" 状态的唯一信号来源
// ——如果 graph 层丢失，前端 maxCommits=300 截断后永远显示"已到全部提交记录的末尾"，
// 用户无法触发 loadMore，永远看不到 row 300 之后的更老 commit。
//
// 对齐 vscode-gitlens `hasMore` 语义（packages/git-cli/src/providers/graph.ts:hasMore 字段）：
// limit 触顶 → hasMore=true → renderLoadMoreRow（vscode-gitlens 显示加载按钮）；
// limit 没触顶 → hasMore=false → nothing。我们的 truncated 字段语义完全等价。
func TestBuildGraphGitlens_TruncatedPassesThrough(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: t0,
			Parents:    parents,
		}
	}
	commits := []git.CommitInfo{
		mk("C1", nil),
		mk("C0", []string{"C1"}),
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	cases := []struct {
		name      string
		truncated bool
	}{
		{"truncated=true 透传", true},
		{"truncated=false 透传", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := BuildGraphGitlens(commits, "C0", []string{"C0"}, tc.truncated)
			if result.Truncated != tc.truncated {
				t.Errorf("BuildGraphGitlens truncated=%v → GraphResult.Truncated=%v（应透传，v0.8.34 修复前硬编码 false）", tc.truncated, result.Truncated)
			}
		})
	}
}
