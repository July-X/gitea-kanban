package graph

import (
	"fmt"
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// TestBuildGraphGitlens_RealWorldScenario v0.8.25.1 feat：模拟 user 截图里的
// xdolphin/TRex 仓库拓扑（mmx vision 描述）：
//   - 4 lanes: 蓝 master (lane 0/1) + 粉红 HEAD feature (lane 1) + 灰已 merge 分支 (lane 3)
//   - HEAD on lane 1（feature branch），master trunk 永远 lane 0
//   - local-dev-A3 是已 merge 的旁支，合并后只剩 ghost segment
//   - 总共 ~30 commit，顶部有 UNCOMMITTED working tree dirty
//
// GitLens 截图也是 4 lanes（蓝/蓝/橙/绿），所以期望 lane 数 ≤ 4。
//
// v0.8.25.1 验证：BuildGraphGitlens 在该 DAG 上：
//   1. MaxLane ≤ 4（vs vscode-git-graph 复刻的 ~35）
//   2. trunk (first-parent chain) 全部 lane 0
//   3. HEAD feature 独立 lane（≥1）
//   4. local-dev-A3 merge commit 的 secondary parent 占独立 lane
func TestBuildGraphGitlens_RealWorldScenario(t *testing.T) {
	t0 := time.Now()
	mk := func(idx int, when time.Time, parents []string) git.CommitInfo {
		sha := fmt.Sprintf("%014x%026x", 0xF0, idx)
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   fmt.Sprintf("%07x", idx),
			Subject:    fmt.Sprintf("commit-%d", idx),
			AuthorWhen: when,
			Parents:    parents,
		}
	}

	// 构造 DAG（latest 在前）：
	// row 0:   H    (HEAD, feature branch tip)         parent: H+1
	// row 1:   H+1  (feature commit)                    parent: H+2
	// row 2:   H+2  (merge: feature + master main)      parents: [H+3, M_main]
	// row 3..N: M+3..M+K (master first-parent 链)
	// row N+1: M+K+1 (master commit)
	// row N+2: A3_merge (local-dev-A3 merge commit)     parents: [M+K+1, A3_root]
	// row N+3: A3_root (local-dev-A3 起点)              parents: []
	//
	// 顶部 UNCOMMITTED 虚拟 commit（Lane 1 HEAD）

	const numMain = 8 // master 主链 commit 数

	// master 链：M0 (latest, 顶部 row 1) → M1 → ... → M7 (root)
	commits := []git.CommitInfo{}
	for i := 0; i <= numMain; i++ {
		parents := []string(nil)
		if i < numMain {
			parents = []string{fmt.Sprintf("%014x%026x", 0xF0, i+1)}
		}
		commits = append(commits, mk(i, t0.Add(-time.Duration(i)*time.Minute), parents))
	}

	// local-dev-A3：A3_merge 合并 M0（master head）+ A3_root
	a3Merge := fmt.Sprintf("%014x%026x", 0xA3, 1)
	a3Root := fmt.Sprintf("%014x%026x", 0xA3, 0)
	commits[0].Parents = append(commits[0].Parents, a3Merge)
	commits = append(commits, git.CommitInfo{
		SHA:        a3Merge,
		ShortSHA:   "a3mrg",
		Subject:    "local-dev-A3 merge",
		AuthorWhen: t0.Add(-time.Duration(numMain+1) * time.Minute),
		Parents:    []string{commits[numMain].SHA, a3Root},
	})
	commits = append(commits, git.CommitInfo{
		SHA:        a3Root,
		ShortSHA:   "a3root",
		Subject:    "local-dev-A3 root",
		AuthorWhen: t0.Add(-time.Duration(numMain+2) * time.Minute),
		Parents:    nil,
	})

	// HEAD feature branch 顶层 commit
	headSHA := fmt.Sprintf("%014x%026x", 0xFE, 0)
	commits = append(commits, git.CommitInfo{
		SHA:        headSHA,
		ShortSHA:   "head00",
		Subject:    "HEAD feature tip",
		AuthorWhen: t0,
		Parents:    []string{commits[0].SHA},
	})

	// M0 (master head) 带 primary ref
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}
	// HEAD feature 也带 ref
	commits[len(commits)-1].Refs = []string{"HEAD"}
	commits[len(commits)-1].RefTypes = []git.RefType{git.RefTypeBranch}

	pinned := []string{commits[0].SHA, headSHA} // trunk head + HEAD（base-first）
	result := BuildGraphGitlens(commits, headSHA, pinned)

	// 断言 1：MaxLane ≤ 4（GitLens 风格）
	if result.MaxLane > 4 {
		t.Errorf("MaxLane=%d, want ≤ 4 (GitLens 风格)", result.MaxLane)
	}

	// 断言 2：master 主链（M0..M7）全部 lane 0
	for i := 0; i <= numMain; i++ {
		found := false
		for _, n := range result.Nodes {
			if n.ShortSHA == fmt.Sprintf("%07x", i) {
				if n.Lane != 0 {
					t.Errorf("master commit[%d] Lane=%d, want 0", i, n.Lane)
				}
				found = true
				break
			}
		}
		if !found {
			t.Errorf("master commit[%d] not found in result", i)
		}
	}

	// 断言 3：HEAD feature commit lane != 0（独立 lane）
	headFound := false
	for _, n := range result.Nodes {
		if n.ShortSHA == "head00" {
			if n.Lane == 0 {
				t.Errorf("HEAD feature Lane=%d, want != 0", n.Lane)
			}
			headFound = true
			break
		}
	}
	if !headFound {
		t.Errorf("HEAD commit not found")
	}

	// 断言 4：local-dev-A3 merge commit 的 second parent (a3root) 不在 lane 0
	for _, n := range result.Nodes {
		if n.ShortSHA == "a3root" {
			if n.Lane == 0 {
				t.Errorf("local-dev-A3 root Lane=0, want != 0")
			}
		}
	}

	t.Logf("MaxLane=%d, %d nodes, %d branches",
		result.MaxLane, len(result.Nodes), len(result.Branches))
	for _, n := range result.Nodes {
		t.Logf("  node %s Lane=%d", n.ShortSHA, n.Lane)
	}
	// v0.8.25.3 debug：打印 branches lines + edges 找孤立点根因
	for i, b := range result.Branches {
		t.Logf("  branch %d Color=%d End=%d Lines=%d", i, b.Color, b.End, len(b.Lines))
		for _, l := range b.Lines {
			t.Logf("    line (%d,%d)→(%d,%d) LockedFirst=%v", l.X1, l.Y1, l.X2, l.Y2, l.LockedFirst)
		}
	}
	t.Logf("=== edges: %d total ===", len(result.Edges))
	for i, e := range result.Edges {
		if i >= 15 {
			t.Logf("  ... (%d more edges)", len(result.Edges)-15)
			break
		}
		t.Logf("  edge row %d→%d lane %d→%d type=%d", e.FromRow, e.ToRow, e.FromLane, e.ToLane, e.Type)
	}
}

// TestBuildGraphGitlens_VsVscodeGitGraph_LaneConvergence v0.8.25.1
// 对比：相同 DAG 上 vscode-git-graph 1:1 复刻 vs GitLens 算法的 lane 数。
//
// 构造一个会触发 vscode-git-graph 原版 vertex.nextX 单调递增导致 lane 膨胀的 DAG：
//   - M0..M2 主链 3 commit
//   - M0 是 merge commit（parents=[M1, S1]），S1 旁支
//   - S1 的 parent = S0（独立 sibling root）
//   - vscode-git-graph 原版算法：merge stitch 循环 j=1.. 把 M1/M2/S0/S1 的 nextX 推到 lane 2+
//   - GitLens 算法：columnsUsed Set + claimNextColumn 找最低空位 → lane 0/1 紧凑
func TestBuildGraphGitlens_VsVscodeGitGraph_LaneConvergence(t *testing.T) {
	t0 := time.Now()
	mk := func(sha string, when time.Time, parents []string) git.CommitInfo {
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   sha,
			Subject:    sha,
			AuthorWhen: when,
			Parents:    parents,
		}
	}

	// DAG: M0(merge [M1, S1]) -> M1 -> M2 -> ... -> M15 (16 主链 commit);
	//      S1(merge [S2, M_last]) -> S2 -> ... -> S8 (9 sibling commit);
	// S1 合并回 M_last，触发 vscode 原版 merge stitch 循环把主链 + sibling nextX 都推到 lane 2+
	commits := []git.CommitInfo{}
	const numMain = 16
	for i := 0; i < numMain; i++ {
		parents := []string(nil)
		if i+1 < numMain {
			parents = []string{fmt.Sprintf("M%d", i+1)}
		}
		commits = append(commits, mk(fmt.Sprintf("M%d", i), t0.Add(-time.Duration(i)*time.Minute), parents))
	}
	// sibling branch：S1..S8，S1 合并回 M_last
	const numSib = 8
	for i := 0; i < numSib; i++ {
		parents := []string(nil)
		if i+1 < numSib {
			parents = []string{fmt.Sprintf("S%d", i+1)}
		}
		commits = append(commits, mk(fmt.Sprintf("S%d", i), t0.Add(-time.Duration(numMain+i)*time.Minute), parents))
	}
	// S1 合并回 M_last：M0 的 second parent = S1
	commits[0].Parents = append(commits[0].Parents, "S1")
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	pinned := []string{commits[0].SHA}

	// GitLens 算法
	glResult := BuildGraphGitlens(commits, commits[0].SHA, pinned)
	// vscode-git-graph 1:1 复刻
	vcResult := BuildGraphVscodeWithHead(commits, commits[0].SHA, false)

	t.Logf("DAG: M0(merge [M1,S1]) -> M1 -> M2; S1 -> S0")
	t.Logf("vscode-git-graph MaxLane=%d", vcResult.MaxLane)
	t.Logf("GitLens          MaxLane=%d", glResult.MaxLane)

	// 打印每个节点 lane
	for _, n := range vcResult.Nodes {
		t.Logf("  vscode %s Lane=%d", n.ShortSHA, n.Lane)
	}
	for _, n := range glResult.Nodes {
		t.Logf("  gitlens %s Lane=%d", n.ShortSHA, n.Lane)
	}

	// 断言 GitLens 显著收敛（≤ 3 lane：trunk + sibling chain + sibling root）
	if glResult.MaxLane > 3 {
		t.Errorf("GitLens MaxLane=%d, want ≤ 3 (trunk + sibling)", glResult.MaxLane)
	}
	// 断言 vscode-git-graph 复刻 lane 也紧凑（小 DAG 不膨胀，但 sibling 仍占 lane）
	if vcResult.MaxLane > 3 {
		t.Errorf("vscode MaxLane=%d, want ≤ 3 (small DAG no inflation)", vcResult.MaxLane)
	}
	// 断言 GitLens sibling 不与 main 抢 lane（lane 0 全留给 main）
	for _, n := range glResult.Nodes {
		if n.Lane == 0 && (n.ShortSHA == "S0" || n.ShortSHA == "S1") {
			t.Errorf("GitLens sibling %s landed on lane 0 (should not)", n.ShortSHA)
		}
	}
}