// check-uncommitted —— 一行命令验证 UNCOMMITTED lane 数据正确性
//
// 历史（v0.3.0 收口后保留）：
//   - v0.3.0 之前是 one-off 验证脚本（commit `dbf8ba4 chore(tools): 加 check-uncommitted` 引入）
//   - 用于在 v0.3.0 merge 收口前快速验证 `LogCommitsVscode` 返回的 UNCOMMITTED 虚拟 commit 数据
//   - v0.3.0 收口后保留作 future debug 工具：任何时候怀疑 UNCOMMITTED lane 数据有问题
//     （dirty 检测 / IsCommitted 透传 / lane 布局），用此工具跑真实仓库验证
//
// 何时归档（v0.6+ 视情况决定）：
//   - 如果长期没人调用 → 归档到 legacy/tools-check-uncommitted/
//   - 如果发现是常用 debug 入口 → 加 README + 配套测试
//
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
		"uncommittedPresent": res.Commits[0].SHA == git.UNCOMMITTED_HASH,
		"uncommittedNode":    res.Commits[0],
		"headSHA":            head,
		"totalCommits":       len(res.Commits),
		"maxLane":            gr.MaxLane,
		"maxColor":           gr.MaxColor,
		"first5Subjects":     firstSubjects(res.Commits, 5),
		"truncated":          res.Truncated,
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
