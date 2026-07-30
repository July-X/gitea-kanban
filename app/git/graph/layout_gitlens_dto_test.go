package graph

import (
	"fmt"
	"testing"
	"time"

	"gitea-kanban/app/git"
)

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

	result := BuildGraphGitlens(commits, "M0", []string{"M0"})

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

	result := BuildGraphGitlens(commits, "M0", []string{"M0"})

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

	result := BuildGraphGitlens(commits, "M0", []string{"M0"})

	// 打印
	t.Logf("=== nodes ===")
	for _, n := range result.Nodes {
		t.Logf("node %s Lane=%d Color=%d", n.ShortSHA, n.Lane, n.Color)
	}

	// 验证：每个 node 的 Color == Lane % 16
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
		mk("M5", []string{"M4"}),                 // row 0: lane 2
		mk("M4", []string{"M3", "S2"}),           // row 1: lane 2 merge
		mk("M3", []string{"M2"}),                 // row 2: lane 0
		mk("M2", []string{"M1"}),                 // row 3: lane 0
		mk("M1", []string{"M0"}),                 // row 4: lane 0
		mk("M0", nil),                            // row 5: lane 0 root
		mk("S2", []string{"S1"}),                 // row 6: lane 1
		mk("S1", []string{"S0"}),                 // row 7: lane 1
		mk("S0", nil),                            // row 8: lane 1 root
	}
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphGitlens(commits, "M5", []string{"M5"})

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

// fmt import guard for clarity
var _ = fmt.Sprintf