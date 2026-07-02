package graph

import (
	"testing"
	"time"

	"gitea-kanban/app/git"
)

// TestBuildGraphVscode_UncommittedVertex 验证 layout_vscode.go 的
// loadCommits 检测 UNCOMMITTED_HASH 调 setNotCommitted() 的逻辑。
//
// 准备：构造 [UNCOMMITTED, HEAD, HEAD's parent] 3 个 commit，UNCOMMITTED
// 指向 HEAD。期望：nodes[0].IsCommitted=false, nodes[1..].IsCommitted=true。
func TestBuildGraphVscode_UncommittedVertex(t *testing.T) {
	headSHA := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	parentSHA := "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"

	commits := []git.CommitInfo{
		{
			SHA:        git.UNCOMMITTED_HASH,
			ShortSHA:   git.UNCOMMITTED_HASH,
			// v0.3.0：UNCOMMITTED subject 改用 worktree dirty 语义，不再是 "N commits from origin ahead"
			Subject:    "Uncommitted changes (3 files)",
			AuthorName: "*",
			AuthorWhen: nowMinusHours(0),
			Parents:    []string{headSHA},
			IsMerge:    false,
		},
		{
			SHA:        headSHA,
			ShortSHA:   headSHA[:7],
			Subject:    "local HEAD",
			AuthorName: "tester",
			AuthorWhen: nowMinusHours(1),
			Parents:    []string{parentSHA},
			IsMerge:    false,
		},
		{
			SHA:        parentSHA,
			ShortSHA:   parentSHA[:7],
			Subject:    "parent of HEAD",
			AuthorName: "tester",
			AuthorWhen: nowMinusHours(2),
			Parents:    nil,
			IsMerge:    false,
		},
	}

	result := BuildGraphVscode(commits, false)
	if len(result.Nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(result.Nodes))
	}
	if result.Nodes[0].IsCommitted {
		t.Errorf("UNCOMMITTED vertex (row 0) IsCommitted 应该是 false，实际 true")
	}
	if result.Nodes[0].SHA != git.UNCOMMITTED_HASH {
		t.Errorf("row 0 SHA 应该是 %q，实际 %q", git.UNCOMMITTED_HASH, result.Nodes[0].SHA)
	}
	if !result.Nodes[1].IsCommitted {
		t.Errorf("local HEAD (row 1) IsCommitted 应该是 true，实际 false")
	}
	if !result.Nodes[2].IsCommitted {
		t.Errorf("parent (row 2) IsCommitted 应该是 true，实际 false")
	}
}

// TestBuildGraphVscode_UncommittedBranchLineIsCommittedFalse 验证
// buildResult 序列化 GraphBranchLine.IsCommitted 字段。UNCOMMITTED 段的 line
// （即 UNCOMMITTED → HEAD 那条 line）应该 IsCommitted=false。
func TestBuildGraphVscode_UncommittedBranchLineIsCommittedFalse(t *testing.T) {
	headSHA := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	parentSHA := "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"

	commits := []git.CommitInfo{
		{
			SHA:        git.UNCOMMITTED_HASH,
			ShortSHA:   git.UNCOMMITTED_HASH,
			// v0.3.0：UNCOMMITTED subject 改用 worktree dirty 语义
			Subject:    "Uncommitted changes (1 file)",
			AuthorName: "*",
			AuthorWhen: nowMinusHours(0),
			Parents:    []string{headSHA},
		},
		{
			SHA:        headSHA,
			ShortSHA:   headSHA[:7],
			Subject:    "local HEAD",
			AuthorName: "tester",
			AuthorWhen: nowMinusHours(1),
			Parents:    []string{parentSHA},
		},
		{
			SHA:        parentSHA,
			ShortSHA:   parentSHA[:7],
			Subject:    "parent",
			AuthorName: "tester",
			AuthorWhen: nowMinusHours(2),
			Parents:    nil,
		},
	}

	result := BuildGraphVscode(commits, false)
	if len(result.Branches) == 0 {
		t.Fatalf("至少应有 1 个 branch")
	}
	// 找一条从 row 0 → row 1 的 line
	foundUncommittedLine := false
	for _, b := range result.Branches {
		for _, ln := range b.Lines {
			if ln.Y1 == 0 && ln.Y2 == 1 {
				if ln.IsCommitted {
					t.Errorf("UNCOMMITTED → HEAD (row 0→1) line IsCommitted 应该是 false")
				}
				foundUncommittedLine = true
			}
			if ln.Y1 == 1 && ln.Y2 == 2 {
				if !ln.IsCommitted {
					t.Errorf("HEAD → parent (row 1→2) line IsCommitted 应该是 true")
				}
			}
		}
	}
	if !foundUncommittedLine {
		t.Errorf("未找到 row 0→1 的 UNCOMMITTED → HEAD line")
	}
}

// TestBuildGraph_GiteaStyle_UncommittedIsCommittedFalse 验证 layout.go
// (Gitea 风格) 也检测 UNCOMMITTED 并写 IsCommitted=false。
func TestBuildGraph_GiteaStyle_UncommittedIsCommittedFalse(t *testing.T) {
	headSHA := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	parentSHA := "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"

	commits := []git.CommitInfo{
		{
			SHA:        git.UNCOMMITTED_HASH,
			ShortSHA:   git.UNCOMMITTED_HASH,
			// v0.3.0：UNCOMMITTED subject 改用 worktree dirty 语义
			Subject:    "Uncommitted changes (1 file)",
			AuthorName: "*",
			AuthorWhen: nowMinusHours(0),
			Parents:    []string{headSHA},
		},
		{
			SHA:        headSHA,
			ShortSHA:   headSHA[:7],
			Subject:    "local HEAD",
			AuthorName: "tester",
			AuthorWhen: nowMinusHours(1),
			Parents:    []string{parentSHA},
		},
		{
			SHA:        parentSHA,
			ShortSHA:   parentSHA[:7],
			Subject:    "parent",
			AuthorName: "tester",
			AuthorWhen: nowMinusHours(2),
			Parents:    nil,
		},
	}

	result := BuildGraph(commits)
	if len(result.Nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(result.Nodes))
	}
	if result.Nodes[0].IsCommitted {
		t.Errorf("Gitea 风格：UNCOMMITTED vertex (row 0) IsCommitted 应该是 false")
	}
	if !result.Nodes[1].IsCommitted || !result.Nodes[2].IsCommitted {
		t.Errorf("Gitea 风格：row 1/2 IsCommitted 应该都是 true")
	}
}

func nowMinusHours(h int) (t time.Time) { return time.Now().Add(-time.Duration(h) * time.Hour) }
