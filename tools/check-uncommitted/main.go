// one-off: 用真实测试仓库跑 LogCommitsVscode，验证 UNCOMMITTED lane 数据正确
// 用法: go run ./tools/check-uncommitted <localRepoPath>
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: check-uncommitted <localRepoPath>")
		os.Exit(1)
	}
	localPath := os.Args[1]
	ctx := context.Background()
	res, err := git.LogCommitsVscode(ctx, git.LogOptions{
		LocalPath: localPath,
		MaxCount:  100,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "LogCommitsVscode err: %v\n", err)
		os.Exit(1)
	}
	if len(res.Commits) == 0 {
		fmt.Fprintln(os.Stderr, "no commits returned")
		os.Exit(1)
	}
	head := git.ResolveLocalHead(localPath)
	gr := graph.BuildGraphVscodeWithHead(res.Commits, head, res.Truncated)

	out := map[string]any{
		"uncommittedPresent":  res.Commits[0].SHA == git.UNCOMMITTED_HASH,
		"uncommittedNode":     res.Commits[0],
		"headSHA":             head,
		"totalCommits":        len(res.Commits),
		"maxLane":             gr.MaxLane,
		"maxColor":            gr.MaxColor,
		"first5Subjects":      firstSubjects(res.Commits, 5),
		"truncated":           res.Truncated,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}

func firstSubjects(cs []git.CommitInfo, n int) []string {
	out := make([]string, 0, n)
	for i := 0; i < n && i < len(cs); i++ {
		out = append(out, cs[i].Subject)
	}
	return out
}
