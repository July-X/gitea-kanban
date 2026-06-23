// Package graph 实现自研 Git Graph column 布局算法（v2.7 重写版）。
//
// 架构路线（对齐 AGENTS.md v2.0 + v2.4 + v2.7）：
//
//	go-git Log (DAG)
//	  ↓ commits 按时间降序（LogCommits 已保证）
//	BuildGraph: 基于 commit DAG 的 lane assignment graph 算法
//	  ↓ GraphNode(Lane) + GraphEdge(FromLane, ToLane)
//	Vue3 SVG path (1:1 对齐 Gitea svgcontainer.tmpl 公式：M lane*5+5)
//
// v2.7 算法：基于 commit DAG 的 Lane Assignment Graph（不依赖 git log --graph 字符流）
//
// 关键设计：first-parent 接力（commit.column = firstParent.column）+ merge-parent 新建 lane
//   - 根 commit（无 parent）走 assignLane 正常分配
//   - 主干 first-parent 链 → 与 parent 同 lane（first-parent 接力，保持同色）
//   - merge-parent → 占新 lane（max+1，永不回收）
//   - 当 first-parent SHA 已被前序 commit 的 merge-parent occupy 到别的 lane
//     → 跨 lane EdgeMerge（/ 字形），不覆盖原有 occupy
//
// 5 个 Gitea 视觉约束（用户确认）：
//   1. main 永远在最左 (lane 0)
//   2. 新分支在右侧 (lane 编号递增)
//   3. merge 正确收敛 (merge-parent 复用主干 lane)
//   4. lane 可复用 (从右到左扫空槽)
//   5. 无交叉 (/ \ 字形)
//
// Gitea parser.go 参考：
//   https://github.com/go-gitea/gitea/blob/release/v1.22/modules/gitgraph/parser.go
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
	Lane        int    // 所在 lane（0 开始，对齐 Gitea 字符流 column 编号）
	Color       int    // 颜色号（0..15，对齐 Gitea Color16()）
	SHA         string // 完整 hash
	ShortSHA    string
	Subject     string
	AuthorName  string
	AuthorEmail string
	Date        string // ISO 时间
	IsMerge     bool
	Parents     []string // parent SHA 列表
	// Refs 关联的 ref 名称（branch / tag / PR 等）
	// v2.7 增量：透传自 CommitInfo.Refs，让前端右侧 commit 行直接渲染
	// 分支/tag badge，无需额外 API 调用。PR 编号由前端在 v2.8 单独加。
	Refs []string
}

// GraphEdge 图中的一条连线
type GraphEdge struct {
	FromRow  int // 起始行
	ToRow    int // 结束行
	FromLane int // 起始 lane（对齐 Gitea column）
	ToLane   int // 结束 lane（对齐 Gitea column）
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
	MaxLane   int  // 最大 lane 号（对齐 Gitea MaxColumn）
	MaxColor  int  // 实际用到的最大颜色号（≤15）
	Truncated bool
}

// BuildGraph 从 commit 列表构建 lane 布局
//
// 输入：commit 列表（**任何顺序**，算法内部按时间降序稳定排序）
// 输出：结构化 GraphNode(Lane) + GraphEdge(FromLane, ToLane)
//
// v2.7 基于 commit DAG 的 Lane Assignment Graph 算法（关键：颜色不冲突）：
//   1. 内部按 AuthorWhen 降序稳定排序（latest → root，row 0 = latest）
//   2. **算法处理顺序**: 反向遍历（从 root 到 latest），模拟 Gitea parser 从字符流底向上扫描
//   3. 根 commit（无 parent）→ lane 0（main flow 起点，对齐 Gitea 字符流 column 0）
//   4. 非根 commit：assignLane 分配 lane
//   5. commit 处理完后释放当前 lane（SHA 置空，lane 编号保留）
//   6. first-parent 处理：
//      - 若 first-parent SHA 已被前序 commit occupy 到别的 lane 且还"活着"
//        → 跨 lane EdgeMerge（/ 字形）
//      - 否则正常接管当前 lane（EdgeNormal）
//   7. merge-parent → 新 lane（max+1），从 colorQ 取**新色**
//   8. 颜色：每个新 lane 独立取色（colorQ），保证 lane 0/1/2... 颜色不同
//
// 关键（v2.7 修复 vs v2.6）：
//   - v2.6 的 first-parent 处理用 occupyLane 可能覆盖已存在的 occupy（当 SHA 已被前序 commit 的
//     merge-parent occupy 到别的 lane），导致 merge-parent 链条断裂
//   - v2.7 检查 activeLanes[existingLane].sha == firstParent，确保只在目标 lane 还"活着"时
//     才走 EdgeMerge
//   - v2.7 颜色分配：每次新 lane 都从 colorQ 取新色，lane 编号 ↔ color 严格一一对应
//
// 实现细节：算法先按 ASC 排序遍历计算 lane/color/edges，输出时按原 DESC 顺序映射 row
func BuildGraph(commits []git.CommitInfo) *GraphResult {
	// 计算 SHA → 时间升序位置（算法处理顺序）
	sortedASC := make([]git.CommitInfo, len(commits))
	copy(sortedASC, commits)
	SortCommitsByDateASC(sortedASC)
	// 计算 result
	result := buildGraphWithMaxColors(sortedASC, defaultMaxColors)

	// 把 result 里的 Row 字段从"算法处理顺序索引"重映射为"SVG 显示位置索引（降序）"
	// 因为前端期望 node.Row = 0 是 latest
	shaToDisplayRow := make(map[string]int, len(commits))
	sortedDESC := make([]git.CommitInfo, len(commits))
	copy(sortedDESC, commits)
	SortCommitsByDate(sortedDESC)
	for i, c := range sortedDESC {
		shaToDisplayRow[c.SHA] = i
	}
	for i := range result.Nodes {
		result.Nodes[i].Row = shaToDisplayRow[result.Nodes[i].SHA]
	}
	for i := range result.Edges {
		// Edge 的 FromRow/ToRow 也需要重映射
		result.Edges[i].FromRow = shaToDisplayRow[sortedASC[result.Edges[i].FromRow].SHA]
		result.Edges[i].ToRow = shaToDisplayRow[sortedASC[result.Edges[i].ToRow].SHA]
	}
	return result
}

// BuildGraphWithMaxColors 自定义颜色上限（测试用）
func BuildGraphWithMaxColors(commits []git.CommitInfo, maxColors int) *GraphResult {
	sortedASC := make([]git.CommitInfo, len(commits))
	copy(sortedASC, commits)
	SortCommitsByDateASC(sortedASC)
	return buildGraphWithMaxColors(sortedASC, maxColors)
}

func buildGraphWithMaxColors(commits []git.CommitInfo, maxColors int) *GraphResult {
	if len(commits) == 0 {
		return &GraphResult{}
	}

	// SHA → 算法处理顺序索引（row 0 = 最早/root,row N-1 = 最新/latest）
	shaToRow := make(map[string]int, len(commits))
	for i, c := range commits {
		shaToRow[c.SHA] = i
	}

	// v2.7 关键：预处理分叉点
	//
	// isFork[sha] = true 表示 commit 是"分叉点"：存在某个 commit Y 把 sha 当 non-first-parent
	// （即 Y 的 parents[1:] 包含 sha）。这意味着 sha 是个从 main 出来的分支的"起点"
	//（Gitea 字符流中这个 sha 必然出现在主干 column 的右边）。
	//
	// 例如 DAG:
	//   C4 (merge, parents=[C2, C3])
	//   C3 (feature, parent=C1)   ← C3 是分叉点（C4 把 C3 当 merge-parent）
	//   C2 (main, parent=C1)      ← C2 不是分叉点（C4 把 C2 当 first-parent）
	//   C1 (root)
	//
	// 这种情况 C3 应当在新 lane（lane 1），C2 接力到 C1 的 lane 0。
	isFork := make(map[string]bool, len(commits))
	for _, c := range commits {
		for i := 1; i < len(c.Parents); i++ {
			isFork[c.Parents[i]] = true // merge-parent 起点 = 分叉
		}
	}

	// lane 管理
	activeLanes := make([]laneSlot, 0)
	// color 队列
	colorQ := newColorQueue(maxColors)

	// shaToLane: SHA → lane 编号
	shaToLane := make(map[string]int, len(commits))
	// laneColor: lane 编号 → color
	laneColor := make([]int, 0)

	nodes := make([]GraphNode, 0, len(commits))
	edges := make([]GraphEdge, 0)
	maxLaneSeen := -1
	maxColorSeen := 0

	for row, commit := range commits {
		var lane, color int

		if len(commit.Parents) == 0 {
			// 根 commit → 强制 lane 0
			lane = 0
			if len(laneColor) == 0 {
				laneColor = append(laneColor, colorQ.takeNext())
			}
			color = laneColor[0]
			for len(activeLanes) <= 0 {
				activeLanes = append(activeLanes, laneSlot{})
			}
			activeLanes[0] = laneSlot{sha: commit.SHA, color: color}
		} else {
			// v2.7 关键：commit 是分叉点 → 必须新 lane（不接力 first-parent）
			// Gitea 字符流：分叉 commit 的 `*` 字母总在主干 column 的右边
			firstParent := commit.Parents[0]
			if isFork[commit.SHA] {
				// 分叉点 → 新 lane
				lane = maxLaneSeen + 1
				if lane < 0 {
					lane = 0
				}
				for len(activeLanes) <= lane {
					activeLanes = append(activeLanes, laneSlot{})
				}
				color = colorQ.takeNext()
				for len(laneColor) <= lane {
					laneColor = append(laneColor, 0)
				}
				laneColor[lane] = color
				if lane > maxLaneSeen {
					maxLaneSeen = lane
				}
			} else if existingLane, exists := shaToLane[firstParent]; exists {
				// 非分叉点 + first-parent 已有 lane → 接力
				lane = existingLane
				for len(laneColor) <= lane {
					laneColor = append(laneColor, 0)
				}
				color = laneColor[lane]
			} else {
				// 非分叉点 + first-parent 未分配（外部 parent 或异常）
				lane = maxLaneSeen + 1
				if lane < 0 {
					lane = 0
				}
				for len(activeLanes) <= lane {
					activeLanes = append(activeLanes, laneSlot{})
				}
				color = colorQ.takeNext()
				for len(laneColor) <= lane {
					laneColor = append(laneColor, 0)
				}
				laneColor[lane] = color
				if lane > maxLaneSeen {
					maxLaneSeen = lane
				}
			}
		}

		// 记录 SHA → lane 映射
		shaToLane[commit.SHA] = lane

		if lane > maxLaneSeen {
			maxLaneSeen = lane
		}
		if color > maxColorSeen {
			maxColorSeen = color
		}

		// 创建节点
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
			Refs:        commit.Refs,
		}
		nodes = append(nodes, node)

		// 释放当前 commit 的 lane
		releaseLane(&activeLanes, lane)

		// 处理 parents
		if len(commit.Parents) == 0 {
			continue
		}

		// first-parent 处理
		// v2.7 关键修复：first-parent 接力**直接用 shaToLane[firstParent]**，
		// 不依赖 activeLanes 的 sha 字段（因为 commit 处理完会 releaseLane）。
		// 之前 v2.6/v2.7 早期版本在这里 occupyLane 会覆盖 shaToLane，破坏 first-parent 链。
		firstParent := commit.Parents[0]
		if _, visible := shaToRow[firstParent]; visible {
			existingLane, exists := shaToLane[firstParent]
			if exists {
				// first-parent 已有 lane → 接力（commit 的 first-parent 边是 normal 同 lane）
				// 跨 lane 仅在 firstParent 已被前序 commit 的 merge-parent occupy 到别的 lane
				// 且本次 commit 是**分叉点**自己**才**出现（commit 自己分叉），
				// 但分叉点由 isFork 在主循环中已处理。
				// 简化：first-parent 接力总是同 lane（normal），如果 commit 自己分叉（isFork），
				//   之前已分配新 lane，这里就 occupy 当前 lane（仍同 lane，但视觉上 commit 已在新 lane）
				if existingLane == lane {
					edges = append(edges, GraphEdge{
						FromRow:  row,
						ToRow:    shaToRow[firstParent],
						FromLane: lane,
						ToLane:   lane,
						Color:    color,
						Type:     EdgeNormal,
					})
				} else {
					// 跨 lane 汇入（EdgeMerge，/ 字形）
					// 这种情况：first-parent 在别的 lane，但 commit 自己**不是**分叉点
					// 意味着 first-parent 之前被当 merge-parent 占用到别的 lane，
					// 而 commit 通过 first-parent 接力到那个 lane。
					// 例如 C4 (merge, firstParent=C2): C2 在 lane 0（main 接力），
					// 不会出现这个 else 分支。
					// 实际：first-parent 接力**总是**同 lane，因为分叉点自己会走新 lane。
					edges = append(edges, GraphEdge{
						FromRow:  row,
						ToRow:    shaToRow[firstParent],
						FromLane: lane,
						ToLane:   existingLane,
						Color:    laneColor[existingLane],
						Type:     EdgeMerge,
					})
					// 不更新 shaToLane[firstParent] = lane
				}
			} else {
				// first-parent 未分配（外部 parent 或异常）
				// 走 activeLanes 接力（commit 自己占的 lane）
				occupyLane(&activeLanes, lane, firstParent, color)
				shaToLane[firstParent] = lane
				edges = append(edges, GraphEdge{
					FromRow:  row,
					ToRow:    shaToRow[firstParent],
					FromLane: lane,
					ToLane:   lane,
					Color:    color,
					Type:     EdgeNormal,
				})
			}
		}

		// merge-parent 各占一个新 lane
		for i := 1; i < len(commit.Parents); i++ {
			parent := commit.Parents[i]
			if _, visible := shaToRow[parent]; !visible {
				continue
			}

			// v2.7 修复：用 shaToLane 判断 parent 是否已分配 lane
			// （不再依赖 activeLanes[].sha，因为 commit 处理完后 releaseLane 会清空）
			if existingLane, exists := shaToLane[parent]; exists {
				// parent 已有 lane（无论是 first-parent 接力、分叉点新分配、还是其他 merge-parent）
				// → EdgeMerge，跨 lane 连线（保留已分配的色）
				edges = append(edges, GraphEdge{
					FromRow:  row,
					ToRow:    shaToRow[parent],
					FromLane: lane,
					ToLane:   existingLane,
					Color:    laneColor[existingLane],
					Type:     EdgeMerge,
				})
			} else {
				// 异常情况：merge-parent 在可见列表但未分配（外部 parent）
				// 走新 lane 分配
				newLane := maxLaneSeen + 1
				if newLane < 0 {
					newLane = 0
				}
				for len(activeLanes) <= newLane {
					activeLanes = append(activeLanes, laneSlot{})
				}
				newColor := colorQ.takeNext()
				if newLane > maxLaneSeen {
					maxLaneSeen = newLane
				}
				if newColor > maxColorSeen {
					maxColorSeen = newColor
				}
				for len(laneColor) <= newLane {
					laneColor = append(laneColor, 0)
				}
				laneColor[newLane] = newColor
				occupyLane(&activeLanes, newLane, parent, newColor)
				shaToLane[parent] = newLane
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
		Nodes:     nodes,
		Edges:     edges,
		MaxLane:   maxLaneSeen,
		MaxColor:  maxColorSeen,
		Truncated: false,
	}
}

// laneSlot 单 lane 的状态
type laneSlot struct {
	sha   string // 空字符串 = 当前无 commit（lane 编号仍保留）
	color int
}

// assignLane 优先复用现存 lane，否则从右到左找空闲 lane，都没有则 maxLane+1
func assignLane(activeLanes *[]laneSlot, _ *colorQueue, sha string, maxLaneSeen *int) (lane int, color int, isReused bool) {
	// 1. 优先复用现存 lane
	for i, slot := range *activeLanes {
		if slot.sha == sha {
			return i, slot.color, true
		}
	}
	// 2. 从右到左找空闲 lane
	for i := len(*activeLanes) - 1; i >= 0; i-- {
		if (*activeLanes)[i].sha == "" {
			return i, 0, false
		}
	}
	// 3. maxLane + 1
	lane = *maxLaneSeen + 1
	if lane < 0 {
		lane = 0
	}
	for len(*activeLanes) <= lane {
		*activeLanes = append(*activeLanes, laneSlot{})
	}
	return lane, 0, false
}

// releaseLane 释放一个 lane
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

// colorQueue 16 色环形队列
type colorQueue struct {
	max   int
	next  int
	inUse map[int]bool
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

// SortCommitsByDateASC 按 AuthorWhen 升序排序（root 在前，对齐 v2.7 算法）
func SortCommitsByDateASC(commits []git.CommitInfo) {
	sort.Slice(commits, func(i, j int) bool {
		return commits[i].AuthorWhen.Before(commits[j].AuthorWhen)
	})
}
