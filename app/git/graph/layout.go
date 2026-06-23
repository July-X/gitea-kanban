// Package graph 实现自研 Git Graph lane 布局算法（v2.8 重写版）。
//
// 架构路线（对齐 AGENTS.md v2.0 + v2.4 + v2.8）：
//
//	go-git Log (DAG)
//	  ↓ commits 按时间降序（LogCommits 已保证）
//	BuildGraph: lane assignment（从 latest 向 root 遍历，模拟 git log --graph）
//	  ↓ GraphNode(Lane) + GraphEdge(FromLane, ToLane)
//	Vue3 SVG path（1:1 对齐 Gitea svgcontainer.tmpl 公式：M lane*5+5）
//
// v2.8 算法：从 latest（顶部）向 root（底部）遍历，Gitea/git log --graph 语义
//
// 关键设计：
//   - main 分支起点（最新 commit / HEAD）→ lane 0（main 永远在最左）
//   - first-parent 接力：commit 与 first-parent 同 lane（保持 main 链同色）
//   - merge-parent：尝试复用已分配 lane；否则从右到左找空闲 lane；都没有则 max+1
//   - lane 可复用：commit 处理完后，若无其它分支还引用此 commit 的 lane，则释放
//   - 每条 lane 独立取色（lane 编号 ↔ color 严格一一对应）
//
// 5 个 Gitea 视觉约束：
//  1. main 永远在最左（lane 0）
//  2. 新分支在右侧（lane 编号递增）
//  3. merge 正确收敛（merge-parent 复用主干 lane）
//  4. lane 可复用（从右到左扫空槽，连续独立分叉复用同一 column）
//  5. 无交叉（/ \ 字形）
//
// 相比 v2.7 的修复：
//   - v2.7 从 root 向 latest 遍历（ASC），导致 main 起点依赖根 commit 恰好在 lane 0；
//     截断片段（MaxCount）时根不在片段内，main 被错误分到高 lane
//   - v2.8 从 latest 向 root 遍历（DESC），main 起点是最新 commit（一定在片段内）→ lane 0 稳定
//   - v2.7 分叉点/merge-parent 一律用 maxLaneSeen+1，永不复用 lane；
//     v2.8 实现从右到左找空闲 lane 的复用逻辑，连续独立分叉视觉上复用同一 column（对齐 git log --graph）
//
// Gitea parser.go 参考：
//
//	https://github.com/go-gitea/gitea/blob/release/v1.22/modules/gitgraph/parser.go
package graph

import (
	"sort"
	"strings"

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
	// 透传自 CommitInfo.Refs，让前端右侧 commit 行直接渲染
	// 分支/tag badge，无需额外 API 调用。
	Refs     []string
	RefTypes []git.RefType // v2.8：与 Refs 一一对应的 ref 类型（branch / remoteBranch / tag）
}

// GraphEdge 图中的一条连线
type GraphEdge struct {
	FromRow  int // 起始行
	ToRow    int // 结束行
	FromLane int // 起始 lane（对齐 Gitea column）
	ToLane   int // 结束 lane（对齐 Gitea column）
	Color    int // 颜色号（0..15，继承自 flow 所在 lane 的颜色）
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
	MaxLane   int // 最大 lane 号（对齐 Gitea MaxColumn）
	MaxColor  int // 实际用到的最大颜色号（≤15）
	Truncated bool
}

// BuildGraph 从 commit 列表构建 lane 布局
//
// 输入：commit 列表（**任何顺序**，算法内部按时间降序稳定排序）
// 输出：结构化 GraphNode(Lane) + GraphEdge(FromLane, ToLane)
//
// v2.8 算法（从 latest 向 root 遍历，对齐 git log --graph 语义）：
//  1. 内部按 AuthorWhen 降序稳定排序（latest → root，row 0 = latest）
//  2. 遍历顺序 = 显示顺序（row 0..N-1），无需二次重映射
//  3. 第一个 commit（最新，通常是 HEAD）→ lane 0（main 起点）
//  4. first-parent 接力：若 first-parent 在可见列表且已被分配 lane → 同 lane（EdgeNormal）
//     否则 occupy 当前 lane（EdgeNormal）
//  5. merge-parent：优先复用已分配 lane（EdgeMerge）；否则从右到左找空闲 lane，
//     都没有则 max+1（EdgeBranch）
//  6. commit 处理完后，释放"不再被引用"的 lane（lane 复用）
//  7. 每条 lane 独立取色（lane ↔ color 一一对应）
func BuildGraph(commits []git.CommitInfo) *GraphResult {
	return buildGraphWithMaxColors(commits, defaultMaxColors)
}

// BuildGraphWithMaxColors 自定义颜色上限（测试用）
func BuildGraphWithMaxColors(commits []git.CommitInfo, maxColors int) *GraphResult {
	return buildGraphWithMaxColors(commits, maxColors)
}

func buildGraphWithMaxColors(commits []git.CommitInfo, maxColors int) *GraphResult {
	if len(commits) == 0 {
		return &GraphResult{}
	}
	if maxColors < 2 {
		maxColors = 2
	}

	// 降序稳定排序（latest → root）。用 SHA 做 tie-breaker 保证稳定。
	sorted := make([]git.CommitInfo, len(commits))
	copy(sorted, commits)
	sort.SliceStable(sorted, func(i, j int) bool {
		if !sorted[i].AuthorWhen.Equal(sorted[j].AuthorWhen) {
			return sorted[i].AuthorWhen.After(sorted[j].AuthorWhen)
		}
		return sorted[i].SHA < sorted[j].SHA
	})

	// SHA → 显示行号（row 0 = latest）
	shaToRow := make(map[string]int, len(sorted))
	for i, c := range sorted {
		shaToRow[c.SHA] = i
	}

	// 预处理 main 链：优先从显式主分支 ref（main/master/origin/main/origin/master）
	// 对应的最新 commit 开始沿 first-parent 一路到底；找不到再退回当前列表第一个 commit。
	// main 链上的 commit 全部标记为 lane 0 候选，保证 main 永远在最左。
	// 这样 feature 分支的 first-parent 不会抢占 main 链上 commit 的 lane。
	isMainChain := make(map[string]bool, len(sorted))
	primaryHeadSHA := ""
	if len(sorted) > 0 {
		cur := sorted[0]
		for _, candidate := range sorted {
			if !hasPrimaryBranchRef(candidate) {
				continue
			}
			cur = candidate
			primaryHeadSHA = candidate.SHA
			break
		}
		if primaryHeadSHA == "" {
			primaryHeadSHA = cur.SHA
		}
		for {
			isMainChain[cur.SHA] = true
			if len(cur.Parents) == 0 {
				break
			}
			fp := cur.Parents[0]
			fpRow, ok := shaToRow[fp]
			if !ok {
				break // first-parent 不在可见列表（截断边界）
			}
			cur = sorted[fpRow]
		}
	}

	// 预处理 first-parent 子节点：
	// 一个 parent 的多个 first-parent 子节点里，只允许一个“主继续 flow”继承 parent lane。
	// 其余 sibling child 必须占独立 lane，否则会被错误压回同一个 column。
	firstParentChildren := make(map[string][]string, len(sorted))
	for _, commit := range sorted {
		if len(commit.Parents) == 0 {
			continue
		}
		firstParent := commit.Parents[0]
		if _, visible := shaToRow[firstParent]; !visible {
			continue
		}
		firstParentChildren[firstParent] = append(firstParentChildren[firstParent], commit.SHA)
	}
	primaryFirstParentChild := make(map[string]string, len(firstParentChildren))
	for parentSHA, children := range firstParentChildren {
		if len(children) == 0 {
			continue
		}
		chosen := ""
		for _, childSHA := range children {
			if isMainChain[childSHA] {
				chosen = childSHA
				break
			}
		}
		if chosen == "" && len(children) == 1 {
			chosen = children[0]
		}
		if chosen != "" {
			primaryFirstParentChild[parentSHA] = chosen
		}
	}

	nodes := make([]GraphNode, 0, len(sorted))
	maxLaneSeen := -1
	maxColorSeen := 0

	// ===== 第一遍：分配 lane（从 latest 向 root 遍历）=====
	// merge-parent 预分配 lane 时只写 shaToLane，不生成边。
	// 这样第二遍生成边时所有 commit 的 lane 已最终确定，避免顺序依赖。
	shaToLane := make(map[string]int, len(sorted))
	shaToColor := make(map[string]int, len(sorted))
	nextColor := 0

	assignNewFlowColor := func() int {
		c := nextColor % maxColors
		nextColor++
		if c > maxColorSeen {
			maxColorSeen = c
		}
		return c
	}
	mainColor := assignNewFlowColor()
	for sha := range isMainChain {
		shaToLane[sha] = 0
		shaToColor[sha] = mainColor
	}
	maxLaneSeen = 0

	// 非主分支 head 预占独立 lane：
	// 如果某个 commit 带分支 ref（feature/x 等）且不在 main chain，
	// 说明它是一个显式 branch head，应先固定到独立 column。
	//
	// 但这里不能简单 maxLaneSeen++，否则两个“纵向区间不重叠”的 branch head
	// 也会被永久推到更右侧，导致 flow2 / flow3 与主干的间距被空列撑大。
	// 预分配阶段同样要按 first-parent 链的可见区间做 lane 复用：
	//   - 区间重叠：不能复用（否则会纵向覆盖）
	//   - 区间不重叠：优先复用最靠左的已空闲 lane
	branchLaneOccupiedUntil := make(map[int]int)
	branchLaneReservedFrom := make(map[int]int)
	for _, commit := range sorted {
		if commit.SHA == primaryHeadSHA || isMainChain[commit.SHA] {
			continue
		}
		if !hasNonPrimaryBranchRef(commit) {
			continue
		}
		if _, exists := shaToLane[commit.SHA]; exists {
			continue
		}
		startRow := shaToRow[commit.SHA]
		endRow := branchSpanEndRow(commit.SHA, sorted, shaToRow, isMainChain)

		lane := -1
		for candidate := 1; candidate <= maxLaneSeen; candidate++ {
			if branchLaneOccupiedUntil[candidate] < startRow {
				lane = candidate
				break
			}
		}
		if lane < 0 {
			lane = maxLaneSeen + 1
		}
		if lane > maxLaneSeen {
			maxLaneSeen = lane
		}
		branchLaneReservedFrom[lane] = startRow
		branchLaneOccupiedUntil[lane] = endRow
		shaToLane[commit.SHA] = lane
		shaToColor[commit.SHA] = assignNewFlowColor()
	}

	// lane 引用计数：记录 lane 还有多少条"待处理 parent 连线"占用它，用于复用。
	laneRefCount := make(map[int]int)
	// cross-lane 的 first-parent 分叉需要把 child lane 一直占到 parent 收拢点，
	// 否则 sibling branch 会过早复用同一 column。
	laneBlockedUntil := make(map[int]int)

	findFreeLane := func(maxLane int, currentRow int, allowLaneZero bool) int {
		minLane := 1
		if allowLaneZero {
			minLane = 0
		}
		for l := maxLane; l >= minLane; l-- {
			if reservedFrom, reserved := branchLaneReservedFrom[l]; reserved {
				if reservedFrom > currentRow && branchLaneOccupiedUntil[l] >= currentRow {
					continue
				}
			}
			if laneRefCount[l] == 0 && laneBlockedUntil[l] <= currentRow {
				return l
			}
		}
		return -1
	}
	findFreeLaneExcept := func(maxLane int, forbidden int, currentRow int, allowLaneZero bool) int {
		minLane := 1
		if allowLaneZero {
			minLane = 0
		}
		for l := maxLane; l >= minLane; l-- {
			if l == forbidden {
				continue
			}
			if reservedFrom, reserved := branchLaneReservedFrom[l]; reserved {
				if reservedFrom > currentRow && branchLaneOccupiedUntil[l] >= currentRow {
					continue
				}
			}
			if laneRefCount[l] == 0 && laneBlockedUntil[l] <= currentRow {
				return l
			}
		}
		return -1
	}

	for row, commit := range sorted {
		var lane int

		if isMainChain[commit.SHA] {
			// main 链 commit → lane 0（显式主分支及其 first-parent 链，保证 main 永远最左）
			lane = 0
		} else if selfLane, ok := shaToLane[commit.SHA]; ok {
			// commit 自己已被前序 commit 当 merge-parent 预分配了 lane → 复用
			lane = selfLane
		} else {
			// first-parent 接力：只有 parent 的“主继续 child”才允许继承同一 lane；
			// 其余 sibling child 视为真正分叉，必须占独立 lane。
			firstParent := ""
			if len(commit.Parents) > 0 {
				firstParent = commit.Parents[0]
			}
			if fpLane, ok := shaToLane[firstParent]; ok && firstParent != "" {
				if primaryFirstParentChild[firstParent] == commit.SHA {
					lane = fpLane
				} else {
					free := findFreeLaneExcept(maxLaneSeen, fpLane, row, false)
					if free >= 0 {
						lane = free
					} else {
						lane = max(maxLaneSeen+1, 1)
					}
				}
			} else {
				// first-parent 未分配 → 从右到左找空闲 lane；都没有则 max+1
				free := findFreeLane(maxLaneSeen, row, false)
				if free >= 0 {
					lane = free
				} else {
					lane = max(maxLaneSeen+1, 1)
				}
			}
		}

		shaToLane[commit.SHA] = lane
		color, hasColor := shaToColor[commit.SHA]
		if !hasColor {
			color = assignNewFlowColor()
			shaToColor[commit.SHA] = color
		}
		if lane > maxLaneSeen {
			maxLaneSeen = lane
		}

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
			RefTypes:    commit.RefTypes,
		}
		nodes = append(nodes, node)

		// 释放当前 commit 占用的 lane 引用
		if laneRefCount[lane] > 0 {
			laneRefCount[lane]--
		}

		// 为 parents 增加 lane 引用（用于 lane 复用判断）
		if len(commit.Parents) == 0 {
			continue
		}

		// first-parent
		firstParent := commit.Parents[0]
		if _, visible := shaToRow[firstParent]; visible {
			if fpLane, exists := shaToLane[firstParent]; exists {
				laneRefCount[fpLane]++
				if fpLane != lane {
					if parentRow := shaToRow[firstParent]; parentRow > laneBlockedUntil[lane] {
						laneBlockedUntil[lane] = parentRow
					}
				}
			} else {
				// first-parent 未分配 → occupy 当前 lane（接力）
				// main 链的 first-parent 也在 lane 0（main 链预处理已覆盖），这里统一 occupy
				shaToLane[firstParent] = lane
				shaToColor[firstParent] = color
				laneRefCount[lane]++
			}
		}

		// merge-parents：各占一条 lane（预分配）
		for i := 1; i < len(commit.Parents); i++ {
			parent := commit.Parents[i]
			if _, visible := shaToRow[parent]; !visible {
				continue
			}
			if existingLane, exists := shaToLane[parent]; exists {
				laneRefCount[existingLane]++
			} else {
				free := findFreeLane(maxLaneSeen, row, false)
				var newLane int
				if free >= 0 {
					newLane = free
				} else {
					newLane = max(maxLaneSeen+1, 1)
				}
				if newLane > maxLaneSeen {
					maxLaneSeen = newLane
				}
				shaToLane[parent] = newLane
				shaToColor[parent] = assignNewFlowColor()
				laneRefCount[newLane]++
			}
		}
	}

	// ===== 第二遍：生成边（所有 lane 已确定，无顺序依赖）=====
	edges := make([]GraphEdge, 0)
	for row, commit := range sorted {
		if len(commit.Parents) == 0 {
			continue
		}
		childLane := shaToLane[commit.SHA]

		// first-parent
		firstParent := commit.Parents[0]
		if parentRow, visible := shaToRow[firstParent]; visible {
			parentLane := shaToLane[firstParent]
			if parentLane == childLane {
				edges = append(edges, GraphEdge{
					FromRow: row, ToRow: parentRow,
					FromLane: childLane, ToLane: parentLane,
					Color: shaToColor[commit.SHA], Type: EdgeNormal,
				})
			} else {
				edgeType := EdgeMerge
				if parentLane > childLane {
					edgeType = EdgeBranch
				}
				edges = append(edges, GraphEdge{
					FromRow: row, ToRow: parentRow,
					FromLane: childLane, ToLane: parentLane,
					Color: shaToColor[commit.SHA], Type: edgeType,
				})
			}
		}

		// merge-parents
		for i := 1; i < len(commit.Parents); i++ {
			parent := commit.Parents[i]
			parentRow, visible := shaToRow[parent]
			if !visible {
				continue
			}
			parentLane := shaToLane[parent]
			if parentLane == childLane {
				edges = append(edges, GraphEdge{
					FromRow: row, ToRow: parentRow,
					FromLane: childLane, ToLane: parentLane,
					Color: shaToColor[commit.SHA], Type: EdgeNormal,
				})
			} else {
				edges = append(edges, GraphEdge{
					FromRow: row, ToRow: parentRow,
					FromLane: childLane, ToLane: parentLane,
					Color: shaToColor[commit.SHA], Type: EdgeMerge,
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

func hasPrimaryBranchRef(commit git.CommitInfo) bool {
	for i, refName := range commit.Refs {
		refType := git.RefType("")
		if i < len(commit.RefTypes) {
			refType = commit.RefTypes[i]
		}
		if refType != git.RefTypeBranch && refType != git.RefTypeRemoteBranch {
			continue
		}
		short := refName
		if slash := strings.LastIndex(short, "/"); slash >= 0 {
			short = short[slash+1:]
		}
		switch short {
		case "main", "master":
			return true
		}
	}
	return false
}

func hasNonPrimaryBranchRef(commit git.CommitInfo) bool {
	for i, refName := range commit.Refs {
		refType := git.RefType("")
		if i < len(commit.RefTypes) {
			refType = commit.RefTypes[i]
		}
		if refType != git.RefTypeBranch && refType != git.RefTypeRemoteBranch {
			continue
		}
		short := refName
		if slash := strings.LastIndex(short, "/"); slash >= 0 {
			short = short[slash+1:]
		}
		if short != "main" && short != "master" {
			return true
		}
	}
	return false
}

func branchSpanEndRow(
	sha string,
	sorted []git.CommitInfo,
	shaToRow map[string]int,
	isMainChain map[string]bool,
) int {
	row, ok := shaToRow[sha]
	if !ok {
		return -1
	}

	endRow := row
	seen := map[string]bool{}
	curSHA := sha
	for {
		if seen[curSHA] {
			return endRow
		}
		seen[curSHA] = true

		curRow, ok := shaToRow[curSHA]
		if !ok {
			return endRow
		}
		endRow = curRow

		commit := sorted[curRow]
		if len(commit.Parents) == 0 {
			return endRow
		}

		firstParent := commit.Parents[0]
		parentRow, visible := shaToRow[firstParent]
		if !visible {
			return endRow
		}
		endRow = parentRow
		if isMainChain[firstParent] {
			return endRow
		}
		curSHA = firstParent
	}
}

// FormatGraph 格式化图布局为可读字符串（调试用）
func FormatGraph(result *GraphResult) string {
	if result == nil || len(result.Nodes) == 0 {
		return "(empty graph)"
	}
	// 找最大 Row 防止越界（nodes 不保证按 Row 排序）
	maxRow := 0
	for _, node := range result.Nodes {
		if node.Row > maxRow {
			maxRow = node.Row
		}
	}
	rows := make([]string, maxRow+1)
	for i := range rows {
		rows[i] = "" // 初始化空行（某些 row 可能无 node）
	}
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
	sort.SliceStable(commits, func(i, j int) bool {
		if !commits[i].AuthorWhen.Equal(commits[j].AuthorWhen) {
			return commits[i].AuthorWhen.After(commits[j].AuthorWhen)
		}
		return commits[i].SHA < commits[j].SHA
	})
}

// SortCommitsByDateASC 按 AuthorWhen 升序排序（root 在前，保留供测试使用）
func SortCommitsByDateASC(commits []git.CommitInfo) {
	sort.SliceStable(commits, func(i, j int) bool {
		if !commits[i].AuthorWhen.Equal(commits[j].AuthorWhen) {
			return commits[i].AuthorWhen.Before(commits[j].AuthorWhen)
		}
		return commits[i].SHA < commits[j].SHA
	})
}
