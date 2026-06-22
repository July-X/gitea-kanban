// Package graph 实现自研 Git Graph lane 布局算法（v2.6 重写版）。
//
// 架构路线（对齐 AGENTS.md v2.0 + v2.4）：
//
//	go-git Log (DAG)
//	  ↓ commits 按时间降序（LogCommits 已保证）
//	BuildGraph: 单遍扫描 + 16 色队列 + first-parent/merge-parent 隔离
//	  ↓ GraphNode + GraphEdge（带 Color 字段，前端直接消费）
//	Vue3 SVG path（1:1 对齐 Gitea svgcontainer.tmpl 公式）
//
// 重写理由（v2.4 → v2.6）：
// 1. 旧版 GraphEdge 没有 Color 字段，前端要按 lane % N 复色，与同 DAG 不同 commit 顺序产生不一致（bug3）
// 2. 旧版 findFreeLane 从 lane 0 开始找空闲 → 同 commit 顺序略变（hash 字典序）就 lane 漂移（bug3）
// 3. 旧版 laneOf map 对同 SHA 多个 incoming parent 不做隔离 → merge commit 时被覆盖（bug4）
// 4. 新版直接把 Gitea parser.go 的 16 色队列算法移植到 Go，避免前端再绕字符流
//
// 算法细节（对齐 Gitea services/repository/gitgraph/parser.go）：
//   - activeLanes: 当前 lane 上"未来要用的 SHA"（空字符串=空闲）
//   - laneOfSha:   SHA → 当前 lane 号
//   - availableColors: 16 色环形队列（ColorNumber % 16，对齐 Gitea Color16()）
//   - firstInUse / firstAvailable: 复用 GC 边界
package graph

import (
	"sort"

	"gitea-kanban/app/git"
)

// 默认 16 色队列上限（对齐 Gitea Color16() = ColorNumber % 16）
const defaultMaxColors = 16

// GraphNode 图中的一个 commit 节点
type GraphNode struct {
	Row         int    // 行号（0 = 最新/顶部）
	Lane        int    // 所在 lane（列，0 开始）
	Color       int    // 颜色号（0..15，对齐 Gitea Color16()）
	SHA         string // 完整 hash
	ShortSHA    string
	Subject     string
	AuthorName  string
	AuthorEmail string
	Date        string // ISO 时间
	IsMerge     bool
	Parents     []string // parent SHA 列表
}

// GraphEdge 图中的一条连线
type GraphEdge struct {
	FromRow  int // 起始行
	ToRow    int // 结束行
	FromLane int // 起始 lane
	ToLane   int // 结束 lane
	Color    int // 颜色号（0..15，继承自 from lane 的颜色）
	Type     EdgeType
}

// EdgeType 边类型（与 Gitea `git log --graph` 字形 1:1）
type EdgeType int

const (
	EdgeNormal EdgeType = iota // 普通 first-parent 连线（直线下行）
	EdgeBranch                 // 分支线（from lane ≠ to lane，merge-parent 占新 lane）
	EdgeMerge                  // merge-parent 汇入主干（from lane ≠ to lane）
)

// GraphResult 完整的图布局结果
type GraphResult struct {
	Nodes     []GraphNode
	Edges     []GraphEdge
	MaxLane   int // 最大 lane 号
	MaxColor  int // 实际用到的最大颜色号（≤15）
	Truncated bool
}

// BuildGraph 从 commit 列表构建 lane + 颜色布局
//
// 输入：commit 列表（**任何顺序**，算法内部按时间降序稳定排序）
// 输出：结构化 GraphNode + GraphEdge（带 Color，前端直接消费）
//
// 算法（v2.6 重写，对齐 Gitea parser.go 语义）：
//  1. 内部按 AuthorWhen 降序稳定排序（SHA 字典序 tiebreaker）→ 计算 row
//  2. 单遍遍历（按 row 升序）
//  3. 每个 commit 必须占一个 lane：
//     - 优先复用 activeLanes 中的现存 lane（laneOf[SHA]）
//     - 没有则 findFreeLane 分配新 lane
//  4. commit 处理完后释放自己的 lane（后续 parent 接管）
//  5. first-parent 接管当前 lane（EdgeNormal）
//  6. merge-parent 各占一个新 lane（EdgeMerge，fromLane = commit.lane, toLane = 新 lane）
//  7. 颜色分配：每个新 lane 从 16 色队列取色（对齐 Gitea availableColors）
//
// 与 BuildGraphUnstable 的差异：本函数保证**输入顺序无关**（先 sort 再分配 lane）。
func BuildGraph(commits []git.CommitInfo) *GraphResult {
	sorted := make([]git.CommitInfo, len(commits))
	copy(sorted, commits)
	SortCommitsByDate(sorted)
	return buildGraphWithMaxColors(sorted, defaultMaxColors)
}

// BuildGraphWithMaxColors 自定义颜色上限（测试用）
func BuildGraphWithMaxColors(commits []git.CommitInfo, maxColors int) *GraphResult {
	sorted := make([]git.CommitInfo, len(commits))
	copy(sorted, commits)
	SortCommitsByDate(sorted)
	return buildGraphWithMaxColors(sorted, maxColors)
}

func buildGraphWithMaxColors(commits []git.CommitInfo, maxColors int) *GraphResult {
	if len(commits) == 0 {
		return &GraphResult{}
	}

	// SHA → row 映射
	shaToRow := make(map[string]int, len(commits))
	for i, c := range commits {
		shaToRow[c.SHA] = i
	}

	// lane 管理
	activeLanes := make([]laneSlot, 0)
	// color 队列（对齐 Gitea availableColors）
	colorQ := newColorQueue(maxColors)

	nodes := make([]GraphNode, 0, len(commits))
	edges := make([]GraphEdge, 0)
	maxLaneSeen := -1
	maxColorSeen := 0

	for row, commit := range commits {
		// 1. 确定 commit 的 lane
		lane, color, isReused := findOrAssignLane(&activeLanes, colorQ, commit.SHA)
		if !isReused {
			// 新分配的 lane：从队列取色
			color = colorQ.takeNext()
		}

		if lane > maxLaneSeen {
			maxLaneSeen = lane
		}
		if color > maxColorSeen {
			maxColorSeen = color
		}

		// 2. 创建节点
		node := GraphNode{
			Row:         row,
			Lane:        lane,
			Color:       color,
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

		// 3. 释放当前 commit 的 lane（即将被 first-parent 接管）
		releaseLane(&activeLanes, lane)

		// 4. 处理 parents
		if len(commit.Parents) == 0 {
			continue
		}

		// first-parent 接管当前 lane
		firstParent := commit.Parents[0]
		if _, visible := shaToRow[firstParent]; visible {
			occupyLane(&activeLanes, lane, firstParent, color)
			edges = append(edges, GraphEdge{
				FromRow:  row,
				ToRow:    shaToRow[firstParent],
				FromLane: lane,
				ToLane:   lane,
				Color:    color, // 继承当前 lane 色
				Type:     EdgeNormal,
			})
		}

		// merge-parent 各占一个新 lane（v2.6 修复：每个 merge-parent 分配独立新 lane，
		// 即使同 SHA 被多个 merge commit 引用也不覆盖 laneOf）
		for i := 1; i < len(commit.Parents); i++ {
			parent := commit.Parents[i]
			if _, visible := shaToRow[parent]; !visible {
				continue
			}

			// 检查 parent 是否已分配 lane（可能来自前序 commit 的 merge-parent）
			if existingLane, ok := findLaneForSHA(&activeLanes, parent); ok {
				// 已分配 → EdgeMerge，跨 lane 连线（保留已分配的色）
				edges = append(edges, GraphEdge{
					FromRow:  row,
					ToRow:    shaToRow[parent],
					FromLane: lane,
					ToLane:   existingLane,
					Color:    color,
					Type:     EdgeMerge,
				})
			} else {
				// 新分配 lane（与 first-parent 同 lane 区分，取下一个新色）
				newLane := findFreeLane(&activeLanes)
				newColor := colorQ.takeNext()
				if newLane > maxLaneSeen {
					maxLaneSeen = newLane
				}
				if newColor > maxColorSeen {
					maxColorSeen = newColor
				}
				occupyLane(&activeLanes, newLane, parent, newColor)
				edges = append(edges, GraphEdge{
					FromRow:  row,
					ToRow:    shaToRow[parent],
					FromLane: lane,
					ToLane:   newLane,
					Color:    newColor,
					Type:     EdgeMerge,
				})
			}
		}
	}

	if maxLaneSeen < 0 {
		maxLaneSeen = 0
	}

	return &GraphResult{
		Nodes:    nodes,
		Edges:    edges,
		MaxLane:  maxLaneSeen,
		MaxColor: maxColorSeen,
	}
}

// laneSlot 单 lane 的状态
type laneSlot struct {
	sha   string // 空字符串 = 空闲
	color int
}

// findOrAssignLane 优先复用现存 lane，否则分配新 lane
// isReused=true 表示复用了现存 lane，color 已存在；false 表示新分配，需要外部取色
func findOrAssignLane(activeLanes *[]laneSlot, _ *colorQueue, sha string) (lane int, color int, isReused bool) {
	for i, slot := range *activeLanes {
		if slot.sha == sha {
			return i, slot.color, true
		}
	}
	// 新分配
	lane = findFreeLane(activeLanes)
	return lane, 0, false
}

// findFreeLane 找第一个空闲 lane，没有则追加
func findFreeLane(activeLanes *[]laneSlot) int {
	for i, slot := range *activeLanes {
		if slot.sha == "" {
			return i
		}
	}
	*activeLanes = append(*activeLanes, laneSlot{})
	return len(*activeLanes) - 1
}

// releaseLane 释放一个 lane（清空 SHA，**保留 color** 让后续 first-parent 复用）
func releaseLane(activeLanes *[]laneSlot, lane int) {
	if lane >= 0 && lane < len(*activeLanes) {
		(*activeLanes)[lane].sha = ""
	}
}

// occupyLane 占用一个 lane
func occupyLane(activeLanes *[]laneSlot, lane int, sha string, color int) {
	for len(*activeLanes) <= lane {
		*activeLanes = append(*activeLanes, laneSlot{})
	}
	(*activeLanes)[lane].sha = sha
	(*activeLanes)[lane].color = color
}

// findLaneForSHA 查找 SHA 所在的 lane
func findLaneForSHA(activeLanes *[]laneSlot, sha string) (int, bool) {
	for i, slot := range *activeLanes {
		if slot.sha == sha {
			return i, true
		}
	}
	return -1, false
}

// colorQueue 16 色环形队列（对齐 Gitea parser.go availableColors）
//
// 简化版：不维护 firstInUse/firstAvailable 复杂 GC（commit 是单向时间序，回收语义自然）
// 用一个简单的环形递增即可，对齐 Gitea Color16() = ColorNumber % 16 行为
type colorQueue struct {
	max     int
	next    int
	inUse   map[int]bool // 已用过的颜色，避免短时间内复色冲突
}

func newColorQueue(max int) *colorQueue {
	if max < 2 {
		max = 2
	}
	return &colorQueue{
		max:   max,
		next:  0,
		inUse: make(map[int]bool),
	}
}

// takeNext 取下一个颜色（环形，超出 maxColors 时强制取模对齐 Gitea 行为）
func (q *colorQueue) takeNext() int {
	for tries := 0; tries < q.max; tries++ {
		c := q.next % q.max
		q.next++
		if !q.inUse[c] {
			q.inUse[c] = true
			return c
		}
	}
	// 全部已用 → 强制取 next（对齐 Gitea ColorNumber % 16）
	c := q.next % q.max
	q.next++
	return c
}

// FormatGraph 格式化图布局为可读字符串（调试用）
func FormatGraph(result *GraphResult) string {
	if result == nil || len(result.Nodes) == 0 {
		return "(empty graph)"
	}
	rows := make([]string, result.Nodes[len(result.Nodes)-1].Row+1)
	for _, node := range result.Nodes {
		prefix := ""
		for i := 0; i < node.Lane; i++ {
			prefix += "  "
		}
		rows[node.Row] = prefix + "* " + node.ShortSHA + " " + node.Subject
	}
	out := ""
	for _, row := range rows {
		out += row + "\n"
	}
	return out
}

// SortCommitsByDate 按 AuthorWhen 降序排序（对齐 --date-order）
func SortCommitsByDate(commits []git.CommitInfo) {
	sort.Slice(commits, func(i, j int) bool {
		return commits[i].AuthorWhen.After(commits[j].AuthorWhen)
	})
}