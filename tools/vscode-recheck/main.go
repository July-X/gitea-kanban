// Command gitgraph-recheck 把 BuildGraphVscode 的输出序列化为 JSON,
// 与 Python 端 vscode-git-graph 参考实现 (vscode_graph.py) 对比 lane/color/edges。
//
// 用法:
//   go run ./tools/vscode-recheck <repo_path> [max_commits] > go-result.json
//
// 然后:
//   python3 tools/vscode-recheck/compare.py go-result.json
//
// JSON 格式:
//   {
//     "meta": {"max_commits": N, "head": "..."},
//     "commits": [{"sha": "...", "row": N, "lane": N, "color": N, "is_merge": bool, "parents": ["sha", ...]}],
//     "edges":   [{"from_row": N, "to_row": N, "from_lane": N, "to_lane": N, "color": N, "type": "normal|branch|merge"}],
//     "max_lane": N
//   }
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	gogit "github.com/go-git/go-git/v5"
	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
)

type commitOut struct {
	SHA     string   `json:"sha"`
	Row     int      `json:"row"`
	Lane    int      `json:"lane"`
	Color   int      `json:"color"`
	IsMerge bool     `json:"is_merge"`
	Parents []string `json:"parents"`
}

type edgeOut struct {
	FromRow  int    `json:"from_row"`
	ToRow    int    `json:"to_row"`
	FromLane int    `json:"from_lane"`
	ToLane   int    `json:"to_lane"`
	Color    int    `json:"color"`
	Type     string `json:"type"` // normal / branch / merge
}

type out struct {
	Meta struct {
		MaxCommits int    `json:"max_commits"`
		Head       string `json:"head"`
		Algorithm  string `json:"algorithm"`
	} `json:"meta"`
	Commits []commitOut `json:"commits"`
	Edges   []edgeOut   `json:"edges"`
	MaxLane int         `json:"max_lane"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: recheck <repo_path> [max_commits] [algorithm=vscode|gitea]")
		os.Exit(2)
	}
	repo := os.Args[1]
	maxCommits := 0
	if len(os.Args) >= 3 {
		n, err := strconv.Atoi(os.Args[2])
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid max_commits: %v\n", err)
			os.Exit(2)
		}
		maxCommits = n
	}
	algorithm := "vscode"
	if len(os.Args) >= 4 {
		algorithm = os.Args[3]
	}

	logOpts := git.LogOptions{LocalPath: repo}
	if maxCommits > 0 {
		logOpts.MaxCount = maxCommits
	}
	logRes, err := git.LogCommits(logOpts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "LogCommits failed: %v\n", err)
		os.Exit(1)
	}

	head := resolveHeadSHA(repo)

	var g *graph.GraphResult
	switch algorithm {
	case "vscode":
		g = graph.BuildGraphVscodeWithHead(logRes.Commits, head)
	case "gitea":
		g = graph.BuildGraph(logRes.Commits)
	default:
		fmt.Fprintf(os.Stderr, "unknown algorithm %q (use vscode|gitea)\n", algorithm)
		os.Exit(2)
	}
	if g == nil {
		fmt.Fprintln(os.Stderr, "BuildGraph returned nil")
		os.Exit(1)
	}

	result := out{}
	result.Meta.MaxCommits = maxCommits
	result.Meta.Head = head
	result.Meta.Algorithm = algorithm
	result.MaxLane = g.MaxLane

	for _, n := range g.Nodes {
		result.Commits = append(result.Commits, commitOut{
			SHA:     n.SHA,
			Row:     n.Row,
			Lane:    n.Lane,
			Color:   n.Color,
			IsMerge: n.IsMerge,
			Parents: n.Parents,
		})
	}
	for _, e := range g.Edges {
		t := "normal"
		switch e.Type {
		case graph.EdgeBranch:
			t = "branch"
		case graph.EdgeMerge:
			t = "merge"
		}
		result.Edges = append(result.Edges, edgeOut{
			FromRow:  e.FromRow,
			ToRow:    e.ToRow,
			FromLane: e.FromLane,
			ToLane:   e.ToLane,
			Color:    e.Color,
			Type:     t,
		})
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(result); err != nil {
		fmt.Fprintf(os.Stderr, "encode failed: %v\n", err)
		os.Exit(1)
	}
}

func resolveHeadSHA(repo string) string {
	r, err := gogit.PlainOpen(repo)
	if err != nil {
		return ""
	}
	head, err := r.Head()
	if err != nil {
		return ""
	}
	return head.Hash().String()
}
