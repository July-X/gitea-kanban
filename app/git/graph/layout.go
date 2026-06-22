// Package graph 实现自研 Git Graph lane 布局算法。
//
// 背景（对齐 AGENTS.md 迁移计划 §4.3）：
// go-git 不提供 `git log --graph` 的 ASCII 字形生成——字形是 git 二进制的 UI 功能。
// 本包直接生成结构化 GraphNode + GraphEdge，前端直接画线，无需解析字形。
//
// 算法（对齐 Gitea graph.go 的 lane 分配策略 + git log --date-order 语义）：
//  1. 按时间降序遍历 commits（LogCommits 已保证）
//  2. 每个 commit 分配一个 lane（列）
//  3. 分支点（一个 parent 产生新分支）：parent 占用 commit 的 lane
//  4. 合并点（多个 parents）：第一个 parent 占用 commit 的 lane，其余 parents 各占新 lane
//  5. lane 回收：commit 处理完后，如果没有后续 commit 需要 lane，则释放
package graph

import (
	"fmt"
	"sort"

	"gitea-kanban/app/git"
)

// GraphNode 图中的一个 commit 节点
type GraphNode struct {
	Row       int    // 行号（0 = 最新/顶部）
	Lane      int    // 所在 lane（列，0 开始）
	SHA       string // 完整 hash
	ShortSHA  string
	Subject   string
	AuthorName  string
	AuthorEmail string
	Date        string // ISO 时间
	IsMerge   bool
	Parents   []string // parent SHA 列表
}

// GraphEdge 图中的一条连线（从一个 commit 到另一个 commit）
type GraphEdge struct {
	FromRow int // 起始行
	ToRow   int // 结束行
	FromLane int // 起始 lane
	ToLane   int // 结束 lane
	Type     EdgeType
}

// EdgeType 边类型
type EdgeType int

const (
	EdgeNormal EdgeType = iota // 普通 parent 连线（直线下行）
	EdgeBranch                 // 分支线（从主干分出）
	EdgeMerge                  // 合并线（汇入主干）
)

// GraphResult 完整的图布局结果
type GraphResult struct {
	Nodes     []GraphNode
	Edges     []GraphEdge
	MaxLane   int // 最大 lane 数（用于前端确定宽度）
	Truncated bool
}

// BuildGraph 从 commit 列表构建 lane 布局
//
// 输入：按时间降序排列的 commits（LogCommits 输出）
// 输出：结构化 GraphNode + GraphEdge
func BuildGraph(commits []git.CommitInfo) *GraphResult {
	if len(commits) == 0 {
		return &GraphResult{}
	}

	// SHA → row 映射（快速查找 commit 在第几行）
	shaToRow := make(map[string]int, len(commits))
	for i, c := range commits {
		shaToRow[c.SHA] = i
	}

	// lane 管理：
	// - activeLanes: 当前各 lane 占用的 SHA（空字符串 = 空闲）
	// - laneOf: 某 SHA 当前在哪个 lane
	activeLanes := []string{}
	laneOf := make(map[string]int)

	nodes := make([]GraphNode, 0, len(commits))
	edges := make([]GraphEdge, 0)

	for row, commit := range commits {
		// 1. 确定 commit 的 lane
		lane, ok := laneOf[commit.SHA]
		if !ok {
			// 新 commit 不在任何 lane → 分配新 lane
			lane = findFreeLane(&activeLanes)
			activeLanes[lane] = commit.SHA
		}

		// 2. 创建节点
		node := GraphNode{
			Row:         row,
			Lane:        lane,
			SHA:         commit.SHA,
			ShortSHA:    commit.ShortSHA,
			Subject:     commit.Subject,
			AuthorName:  commit.AuthorName,
			AuthorEmail: commit.AuthorEmail,
			Date:        commit.AuthorWhen.Format("2006-01-02T15:04:05Z07:00"),
			IsMerge:     commit.IsMerge,
			Parents:     commit.Parents,
		}
		nodes = append(nodes, node)

		// 3. 释放当前 commit 的 lane（即将被 parent 接管或释放）
		activeLanes[lane] = ""

		// 4. 处理 parents
		if len(commit.Parents) == 0 {
			// 无 parent（根 commit）→ lane 释放
			continue
		}

		// 第一个 parent 接管当前 lane（直线下行）
		firstParent := commit.Parents[0]
		if _, exists := shaToRow[firstParent]; exists {
			activeLanes[lane] = firstParent
			laneOf[firstParent] = lane
			edges = append(edges, GraphEdge{
				FromRow: row,
				ToRow:   shaToRow[firstParent],
				FromLane: lane,
				ToLane:   lane,
				Type:     EdgeNormal,
			})
		}

		// 其余 parents（merge commit 的额外 parents）各占新 lane
		for i := 1; i < len(commit.Parents); i++ {
			parent := commit.Parents[i]
			if _, exists := shaToRow[parent]; !exists {
				continue // parent 不在可见范围内
			}

			// 检查 parent 是否已在某个 lane
			if pLane, ok := laneOf[parent]; ok {
				// parent 已有 lane → 画 merge 边
				edges = append(edges, GraphEdge{
					FromRow: row,
					ToRow:   shaToRow[parent],
					FromLane: lane,
					ToLane:   pLane,
					Type:     EdgeMerge,
				})
			} else {
				// parent 需要新 lane
				pLane := findFreeLane(&activeLanes)
				activeLanes[pLane] = parent
				laneOf[parent] = pLane
				edges = append(edges, GraphEdge{
					FromRow: row,
					ToRow:   shaToRow[parent],
					FromLane: pLane,
					ToLane:   pLane,
					Type:     EdgeMerge,
				})
			}
		}
	}

	// 计算 maxLane
	maxLane := 0
	for _, n := range nodes {
		if n.Lane > maxLane {
			maxLane = n.Lane
		}
	}

	return &GraphResult{
		Nodes:   nodes,
		Edges:   edges,
		MaxLane: maxLane,
	}
}

// findFreeLane 找到第一个空闲 lane，没有则追加新 lane
func findFreeLane(activeLanes *[]string) int {
	for i, sha := range *activeLanes {
		if sha == "" {
			return i
		}
	}
	// 没有空闲 → 追加
	*activeLanes = append(*activeLanes, "")
	return len(*activeLanes) - 1
}

// FormatGraph 格式化图布局为可读字符串（调试用）
func FormatGraph(result *GraphResult) string {
	if result == nil || len(result.Nodes) == 0 {
		return "(empty graph)"
	}

	// 按行排列节点
	rows := make([]string, result.Nodes[len(result.Nodes)-1].Row+1)
	for i := range rows {
		rows[i] = ""
	}

	// 画节点
	for _, node := range result.Nodes {
		prefix := ""
		for i := 0; i < node.Lane; i++ {
			prefix += "  "
		}
		rows[node.Row] = fmt.Sprintf("%s%s %s", prefix, "*", node.ShortSHA+" "+node.Subject)
	}

	result2 := ""
	for _, row := range rows {
		result2 += row + "\n"
	}
	return result2
}

// SortCommitsByDate 按 AuthorWhen 降序排序（对齐 --date-order）
func SortCommitsByDate(commits []git.CommitInfo) {
	sort.Slice(commits, func(i, j int) bool {
		return commits[i].AuthorWhen.After(commits[j].AuthorWhen)
	})
}
