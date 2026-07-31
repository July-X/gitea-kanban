package graph

import (
	"sort"
	"testing"

	"gitea-kanban/app/git"
)

// layout_gitlens_test.go — v0.8.25.1：把 GitLens engine/__tests__/layout.test.ts
// 的关键 column 分配用例翻成 Go table test，钉住 v0.8.25.1 Go 移植与 GitLens
// 原版 layout.ts 行为一致。
//
// 移植范围（GitLens 原版测试 27 个 case，挑最高 ROI 的 8 个）：
//   - linear history places every commit on column 0
//   - merge fan puts the second-parent branch on its own lane
//   - a stash keeps its own lane and kind
//   - a WIP row never drags its anchor onto its own lane
//   - a WIP row on an unreserved anchor still shares its lane
//   - a claim on the lowest free lane pulls its parent chain down onto it
//   - assignPinnedColumns tags each head first-parent chain with its stack column
//   - a head not present in the loaded rows reserves no column
//
// fixtures 与 GitLens 原版保持同名同结构，方便交叉对比。

// fixtures gitlens-test 通用 fixture builder（GitLens 原版 layout.test.ts:18-27）
type gitlensTestRow struct {
	sha     string
	parents []string
	kind    gitlensCommitKind
	date    int64
}

func mkRow(sha string, parents []string, kind gitlensCommitKind, date int64) *gitlensGraphRow {
	return &gitlensGraphRow{
		sha:     sha,
		parents: parents,
		kind:    kind,
		date:    date,
	}
}

func fixtureLinear() []*gitlensGraphRow {
	return []*gitlensGraphRow{
		mkRow("A", []string{"B"}, gitlensKindCommit, 0),
		mkRow("B", []string{"C"}, gitlensKindCommit, 0),
		mkRow("C", []string{"D"}, gitlensKindCommit, 0),
		mkRow("D", nil, gitlensKindCommit, 0),
	}
}

func fixtureMergeFan() []*gitlensGraphRow {
	return []*gitlensGraphRow{
		mkRow("M", []string{"A", "B"}, gitlensKindMerge, 0),
		mkRow("A", []string{"C"}, gitlensKindCommit, 0),
		mkRow("B", []string{"C"}, gitlensKindCommit, 0),
		mkRow("C", nil, gitlensKindCommit, 0),
	}
}

func fixtureStashLane() []*gitlensGraphRow {
	return []*gitlensGraphRow{
		mkRow("A", []string{"C"}, gitlensKindCommit, 0),
		mkRow("S", []string{"C"}, gitlensKindStash, 0),
		mkRow("C", nil, gitlensKindCommit, 0),
	}
}

func fixtureWorkdirAnchorReserved() []*gitlensGraphRow {
	// A fresh claim landing BELOW its first parent's reservation — anchor stays on its own lane.
	return []*gitlensGraphRow{
		mkRow("C", []string{"A"}, gitlensKindCommit, 0),
		mkRow("W", []string{"A"}, gitlensKindWorkdir, 0),
		mkRow("A", nil, gitlensKindCommit, 0),
	}
}

func fixtureWorkdirAnchorFree() []*gitlensGraphRow {
	return []*gitlensGraphRow{
		mkRow("T", []string{"A"}, gitlensKindCommit, 0),
		mkRow("W", []string{"B"}, gitlensKindWorkdir, 0),
		mkRow("A", []string{"BASE"}, gitlensKindCommit, 0),
		mkRow("B", []string{"BASE"}, gitlensKindCommit, 0),
		mkRow("BASE", nil, gitlensKindCommit, 0),
	}
}

func fixtureLowestFreeChainDrag() []*gitlensGraphRow {
	// C0(merge [C1,C2]) C1(stash [C2]) C2([C4]) C3(stash [C4]) C4([]) → columns [0,0,1,0,0]
	return []*gitlensGraphRow{
		mkRow("C0", []string{"C1", "C2"}, gitlensKindMerge, 0),
		mkRow("C1", []string{"C2"}, gitlensKindStash, 0),
		mkRow("C2", []string{"C4"}, gitlensKindCommit, 0),
		mkRow("C3", []string{"C4"}, gitlensKindStash, 0),
		mkRow("C4", nil, gitlensKindCommit, 0),
	}
}

func columnOf(columns map[string]int, sha string) int {
	v, ok := columns[sha]
	if !ok {
		return -1
	}
	return v
}

func assertColumns(t *testing.T, columns map[string]int, expected map[string]int) {
	t.Helper()
	got := make([]string, 0, len(columns))
	for k := range columns {
		got = append(got, k)
	}
	sort.Strings(got)
	for _, sha := range got {
		want := expected[sha]
		got := columns[sha]
		if want != -1 && got != want {
			t.Errorf("column[%s]=%d, want %d", sha, got, want)
		}
	}
	// 校验 expected 里的 SHA 都在 columns 里
	for sha := range expected {
		if expected[sha] != -1 {
			if _, ok := columns[sha]; !ok {
				t.Errorf("expected sha %s missing from columns", sha)
			}
		}
	}
}

// ----- Tests -----

// 对齐 layout.test.ts:30-36 "linear history places every commit on column 0"
func TestGitLensLayout_LinearHistory_AllColumn0(t *testing.T) {
	rows := fixtureLinear()
	columns, _, _ := gitlensAssignColumns(rows, nil, false)
	assertColumns(t, columns, map[string]int{
		"A": 0, "B": 0, "C": 0, "D": 0,
	})
}

// 对齐 layout.test.ts:38-50 "merge fan puts the second-parent branch on its own lane"
func TestGitLensLayout_MergeFan_SecondParentOwnLane(t *testing.T) {
	rows := fixtureMergeFan()
	columns, _, _ := gitlensAssignColumns(rows, nil, false)
	assertColumns(t, columns, map[string]int{
		"M": 0, "A": 0, "B": 1, "C": 0,
	})
}

// 对齐 layout.test.ts:62-67 "a stash keeps its own lane and kind"
func TestGitLensLayout_Stash_OwnLane(t *testing.T) {
	rows := fixtureStashLane()
	columns, _, _ := gitlensAssignColumns(rows, nil, false)
	assertColumns(t, columns, map[string]int{
		"A": 0, "S": 1, "C": 0,
	})
}

// 对齐 layout.test.ts:71-78 "a WIP row never drags its anchor onto its own lane"
func TestGitLensLayout_Workdir_AnchorStays(t *testing.T) {
	rows := fixtureWorkdirAnchorReserved()
	columns, _, _ := gitlensAssignColumns(rows, nil, false)
	assertColumns(t, columns, map[string]int{
		"C": 0, "A": 0, "W": 1,
	})
}

// 对齐 layout.test.ts:80-91 "a WIP row on an unreserved anchor still shares its lane"
func TestGitLensLayout_Workdir_AnchorFree_Shares(t *testing.T) {
	rows := fixtureWorkdirAnchorFree()
	columns, _, _ := gitlensAssignColumns(rows, nil, false)
	// W 与 B 共 lane（unreserved anchor）；T 与 A 共 lane
	wCol := columnOf(columns, "W")
	bCol := columnOf(columns, "B")
	if wCol != bCol {
		t.Errorf("W (workdir) column=%d != B (anchor) column=%d, expected same", wCol, bCol)
	}
	tCol := columnOf(columns, "T")
	aCol := columnOf(columns, "A")
	if tCol != aCol {
		t.Errorf("T column=%d != A column=%d, expected same (first-parent 继承)", tCol, aCol)
	}
}

// 对齐 layout.test.ts:93-108 "a claim on the lowest free lane pulls its parent chain down onto it"
// 关键 lane compaction 用例：C0 merge, C1 stash, C2, C3 stash, C4 → columns [0,0,1,0,0]
// 这是验证 "lowest free column + reservation-replace" 联动压缩图宽
func TestGitLensLayout_LowestFreeLane_ChainDrag(t *testing.T) {
	rows := fixtureLowestFreeChainDrag()
	columns, _, _ := gitlensAssignColumns(rows, nil, false)
	assertColumns(t, columns, map[string]int{
		"C0": 0, "C1": 0, "C2": 1, "C3": 0, "C4": 0,
	})
}

// 对齐 layout.test.ts:171-180 "assignPinnedColumns tags each head first-parent chain with its stack column"
// 两个 stacked head（H1, H2），base 共享——base 留 lower lane（0）
func TestGitLensLayout_AssignPinnedColumns_StackedHeads(t *testing.T) {
	rows := []*gitlensGraphRow{
		mkRow("H1", []string{"X"}, gitlensKindCommit, 0),
		mkRow("H2", []string{"Y"}, gitlensKindCommit, 0),
		mkRow("X", []string{"base"}, gitlensKindCommit, 0),
		mkRow("Y", []string{"base"}, gitlensKindCommit, 0),
		mkRow("base", nil, gitlensKindCommit, 0),
	}
	cols := assignPinnedColumns(rows, []string{"H1", "H2"})
	expected := map[string]int{
		"H1": 0, "X": 0, "base": 0,
		"H2": 1, "Y": 1,
	}
	for sha, want := range expected {
		if got := cols[sha]; got != want {
			t.Errorf("pinned col[%s]=%d, want %d", sha, got, want)
		}
	}
}

// 对齐 layout.test.ts:182-187 "a head not present in the loaded rows reserves no column"
func TestGitLensLayout_AssignPinnedColumns_HeadMissing(t *testing.T) {
	rows := []*gitlensGraphRow{
		mkRow("H1", []string{"base"}, gitlensKindCommit, 0),
		mkRow("base", nil, gitlensKindCommit, 0),
	}
	cols := assignPinnedColumns(rows, []string{"H1", "missing"})
	if cols["H1"] != 0 {
		t.Errorf("H1 col=%d, want 0", cols["H1"])
	}
	if _, ok := cols["missing"]; ok {
		t.Errorf("missing head should not reserve column, but got %d", cols["missing"])
	}
}

// 额外的端到端测试：通过 BuildGraphGitlens 把 git.CommitInfo 喂入，验证与 GitLens 原版一致
func TestBuildGraphGitlens_FullPipeline_LinearHistory(t *testing.T) {
	commits := []git.CommitInfo{
		{SHA: "A", ShortSHA: "A", Subject: "A", Parents: []string{"B"}},
		{SHA: "B", ShortSHA: "B", Subject: "B", Parents: []string{"C"}},
		{SHA: "C", ShortSHA: "C", Subject: "C", Parents: []string{"D"}},
		{SHA: "D", ShortSHA: "D", Subject: "D", Parents: nil},
	}
	result := BuildGraphGitlens(commits, "A", nil)
	if result.MaxLane != 0 {
		t.Errorf("linear history MaxLane=%d, want 0", result.MaxLane)
	}
	for _, n := range result.Nodes {
		if n.Lane != 0 {
			t.Errorf("linear history node %s Lane=%d, want 0", n.ShortSHA, n.Lane)
		}
	}
}

func TestBuildGraphGitlens_FullPipeline_MergeFan(t *testing.T) {
	commits := []git.CommitInfo{
		{SHA: "M", ShortSHA: "M", Subject: "M", Parents: []string{"A", "B"}},
		{SHA: "A", ShortSHA: "A", Subject: "A", Parents: []string{"C"}},
		{SHA: "B", ShortSHA: "B", Subject: "B", Parents: []string{"C"}},
		{SHA: "C", ShortSHA: "C", Subject: "C", Parents: nil},
	}
	result := BuildGraphGitlens(commits, "M", nil)
	expected := map[string]int{"M": 0, "A": 0, "B": 1, "C": 0}
	for _, n := range result.Nodes {
		want, ok := expected[n.ShortSHA]
		if !ok {
			continue
		}
		if n.Lane != want {
			t.Errorf("merge fan node %s Lane=%d, want %d", n.ShortSHA, n.Lane, want)
		}
	}
}
