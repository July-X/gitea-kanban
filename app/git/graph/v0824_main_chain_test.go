package graph

import (
	"fmt"
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// TestBuildGraphVscode_MainChainLaneZero v0.8.24 回归测试
//
// DAG (newest → oldest, row 0 = latest):
//
//	M0 (merge, parents=[M1, F1])   row 0   ← main chain head (primary ref)
//	M1                                row 1   ← main chain
//	M2                                row 2   ← main chain
//	...
//	M49                               row 49  ← main chain
//	M50                               row 50  ← main chain (root)
//	F1 (parent=F0)                    row 51
//	F0 (parent=M50)                   row 52
//
// 关键：M0 merge 的 second parent 是 F1（不是 M50）。F1 占用 lane 1 后，
// merge stitch 循环会从 row 0 一路下到 row 50+ 都试图给每个 curVertex 占
// lane，导致 first-parent 链 M1..M49 被推到 lane 2+。
//
// 复现 vscode-git-graph v1.30.0 原生 bug：没有 main chain lane 0 锚定时，
// M1..M49 落到 lane 2/3/4/5/6。v0.8.24 修复后：M0..M50 全部 Lane=0。
//
// SHA 用 hex 区分，避免 short SHA pad 后碰撞（"m1"+"0"*38 与 "m10"+"0"*37 相同）。
func TestBuildGraphVscode_MainChainLaneZero(t *testing.T) {
	t0 := time.Now()
	// 用 0xAA + 索引作为 40 char hex SHA 的前缀，避免 padding 碰撞
	mk := func(idx int, when time.Time, parents []int) git.CommitInfo {
		sha := fmt.Sprintf("%010x%030x", 0xAA, idx)
		fullParents := make([]string, len(parents))
		for i, p := range parents {
			fullParents[i] = fmt.Sprintf("%010x%030x", 0xAA, p)
		}
		return git.CommitInfo{
			SHA:        sha,
			ShortSHA:   fmt.Sprintf("%07x", idx),
			Subject:    fmt.Sprintf("commit-%d", idx),
			AuthorWhen: when,
			Parents:    fullParents,
		}
	}

	commits := []git.CommitInfo{}
	// M0..M50 first-parent 链
	for i := 0; i <= 50; i++ {
		var parents []int
		if i == 0 {
			parents = []int{1, 100} // M1 + F1
		} else if i < 50 {
			parents = []int{i + 1}
		}
		// M50: parents = nil (root)
		commits = append(commits, mk(i, t0.Add(-time.Duration(i)*time.Minute), parents))
	}
	commits = append(commits, mk(100, t0.Add(-51*time.Minute), []int{101}))   // F1
	commits = append(commits, mk(101, t0.Add(-52*time.Minute), []int{50}))    // F0 → M50

	// M0 带 primary ref（模拟 main / master 分支指向）
	commits[0].Refs = []string{"main"}
	commits[0].RefTypes = []git.RefType{git.RefTypeBranch}

	result := BuildGraphVscodeWithHead(commits, commits[0].SHA, false)

	// 断言：M0..M50 (idx 0..50) 全部 Lane=0
	for i := 0; i <= 50; i++ {
		found := false
		for _, n := range result.Nodes {
			if n.ShortSHA == fmt.Sprintf("%07x", i) {
				found = true
				if n.Lane != 0 {
					t.Errorf("commit[%d] (main chain) Lane=%d, want 0", i, n.Lane)
				}
				break
			}
		}
		if !found {
			t.Errorf("commit[%d] not found in result", i)
		}
	}

	// 断言：F1/F0 (idx 100/101) 不在 lane 0
	for _, idx := range []int{100, 101} {
		for _, n := range result.Nodes {
			if n.ShortSHA == fmt.Sprintf("%07x", idx) {
				if n.Lane == 0 {
					t.Errorf("feat commit[%d] Lane=%d, want != 0 (should not collide with main)", idx, n.Lane)
				}
				break
			}
		}
	}

	// 断言：Branch[0] (color=0 主干) 的所有 line 都在 lane 0（无幽灵 line）
	for _, b := range result.Branches {
		if b.Color != 0 {
			continue
		}
		for li, ln := range b.Lines {
			if ln.X1 != 0 || ln.X2 != 0 {
				t.Errorf("Branch[0] line[%d] endpoint x=%d/%d, both should be 0 (no ghost line)", li, ln.X1, ln.X2)
			}
		}
	}
}
