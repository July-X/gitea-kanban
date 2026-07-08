// dump-vscodecommits: 从 git repo 提取 commit 列表, 输出 vscode-git-graph 兼容的 JSON
// 格式: { commits: [{hash, parents, author, email, date(ms), message, heads, tags, remotes, stash}], head }
// 用于喂给 vscode-git-graph 真实 TS 算法, 跟我自己的 Go BuildGraphVscode 对比
//
// 用法: dump-vscodecommits <repo_path> [max_commits] > vscode-commits.json

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"gitea-kanban/app/git"
	gogit "github.com/go-git/go-git/v5"
)

type vscodeCommit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	Date    int64    `json:"date"`
	Message string   `json:"message"`
	Heads   []string `json:"heads"`
	Tags    []any    `json:"tags"`
	Remotes []any    `json:"remotes"`
	Stash   any      `json:"stash"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dump-vscodecommits <repo_path> [max_commits]")
		os.Exit(2)
	}
	repoPath := os.Args[1]
	maxCommits := 0
	if len(os.Args) >= 3 {
		n, err := strconv.Atoi(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, "invalid max_commits:", err)
			os.Exit(2)
		}
		maxCommits = n
	}

	logOpts := git.LogOptions{LocalPath: repoPath, MaxCount: maxCommits}
	logRes, err := git.LogCommits(logOpts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "LogCommits failed:", err)
		os.Exit(1)
	}

	// 解析 head (用 git 命令直接调)
	r, err := gogit.PlainOpen(repoPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "PlainOpen failed:", err)
		os.Exit(1)
	}
	head, _ := r.Head()
	headSHA := ""
	if head != nil {
		headSHA = head.Hash().String()
	}

	commits := make([]vscodeCommit, 0, len(logRes.Commits))
	for _, c := range logRes.Commits {
		// 注意: go-git log 按时间倒序返回; vscode 期望 row 0 是最新
		// (跟 go-git LogCommits 内部排序一致,这里直接传)
		commits = append(commits, vscodeCommit{
			Hash:    c.SHA,
			Parents: c.Parents,
			Author:  c.AuthorName,
			Email:   c.AuthorEmail,
			Date:    c.AuthorWhen.UnixMilli(),
			Message: c.Subject,
			Heads:   []string{},
			Tags:    []any{},
			Remotes: []any{},
			Stash:   nil,
		})
	}

	out := struct {
		Commits []vscodeCommit `json:"commits"`
		Head    string         `json:"head"`
	}{
		Commits: commits,
		Head:    headSHA,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "encode failed:", err)
		os.Exit(1)
	}
}
