package graph

// vscode-style lane 分配 (1:1 复刻 vscode-git-graph web/graph.ts)
//
// 对应源码 web/graph.ts(参考版本:1.30.0):
//   - Branch    : graph.ts:38-160
//   - Vertex    : graph.ts:164-332
//   - Graph     : graph.ts:337-913
//
// 算法核心:
//   1. 排序后从 top (row 0) 开始逐行处理
//   2. 对每个未"处理完 parents"或"未上 branch"的 vertex 调 determinePath
//   3. lane 由 vertex.nextX 推进 + connections 跟踪
//   4. merge stitch: 当 merge commit + 父节点都已上 branch 时,不开新 branch,
//      而是把 parent 的 branch 沿列插值连到 merge commit
//
// 入口: BuildGraphVscode / BuildGraphVscodeWithHead
// 与原 BuildGraph 并行存在,后端 adapter 切换到 BuildGraphVscode 前不影响
// Gitea 风格的 BuildGraph 路径。

import (
	"sort"

	"gitea-kanban/app/git"
)

// vsNULL_VERTEX_ID mirrors graph.ts:2 (NULL_VERTEX_ID = -1)
const vsNULL_VERTEX_ID = -1

// vsPoint mirrors graph.ts:7-10
type vsPoint struct {
	x int // lane (column)
	y int // row
}

// vsLine mirrors graph.ts:21-26 (PlacedLine 之前的 Line + lockedFirst)
type vsLine struct {
	p1, p2     vsPoint
	lockedFirst bool
}

// vsUnavailablePoint mirrors graph.ts:28-31
type vsUnavailablePoint struct {
	connectsTo *vsVertex
	onBranch   *vsBranch
}

// vsBranch mirrors graph.ts:38-55
type vsBranch struct {
	colour         int   // 颜色索引(全局)
	end            int   // branch 覆盖的最后一行 + 1
	lines          []vsLine
	numUncommitted int
}

// addLine mirrors graph.ts:48-55
func (b *vsBranch) addLine(p1, p2 vsPoint, isCommitted, lockedFirst bool) {
	b.lines = append(b.lines, vsLine{p1: p1, p2: p2, lockedFirst: lockedFirst})
	if isCommitted {
		if p2.x == 0 && p2.y < b.numUncommitted {
			b.numUncommitted = p2.y
		}
	} else {
		b.numUncommitted++
	}
}

// vsVertex mirrors graph.ts:164-332
type vsVertex struct {
	id          int
	sha         string
	isStash     bool
	x           int // 落在第几 lane
	nextX       int // 下一个"空闲" lane(从 0 开始扫)
	parents     []*vsVertex
	children    []*vsVertex
	nextParent  int                          // 还没处理完的 parent 索引
	onBranch    *vsBranch                    // 当前 vertex 挂在哪个 branch 上(nil = 未挂)
	isCommitted bool                         // true 表示 commit 已落地
	isCurrent   bool                         // HEAD 标记
	connections map[int]*vsUnavailablePoint   // 该 vertex 的哪些 lane 已被 branch 占用
}

// addChild mirrors graph.ts:187-189
func (v *vsVertex) addChild(c *vsVertex) {
	v.children = append(v.children, c)
}

// addParent mirrors graph.ts:198-201
func (v *vsVertex) addParent(p *vsVertex) {
	v.parents = append(v.parents, p)
}

// getNextParent mirrors graph.ts:210-213
func (v *vsVertex) getNextParent() *vsVertex {
	if v.nextParent < len(v.parents) {
		return v.parents[v.nextParent]
	}
	return nil
}

// registerParentProcessed mirrors graph.ts:220-222
func (v *vsVertex) registerParentProcessed() {
	v.nextParent++
}

// isMerge mirrors graph.ts:224-226
func (v *vsVertex) isMerge() bool { return len(v.parents) > 1 }

// isNotOnBranch mirrors graph.ts:238-240
func (v *vsVertex) isNotOnBranch() bool { return v.onBranch == nil }

// isOnThisBranch mirrors graph.ts:242-244
func (v *vsVertex) isOnThisBranch(b *vsBranch) bool { return v.onBranch == b }

// getBranch mirrors graph.ts:246-248
func (v *vsVertex) getBranch() *vsBranch { return v.onBranch }

// getPoint mirrors graph.ts:253-255
func (v *vsVertex) getPoint() vsPoint { return vsPoint{x: v.x, y: v.id} }

// getNextPoint mirrors graph.ts:257-259
func (v *vsVertex) getNextPoint() vsPoint { return vsPoint{x: v.nextX, y: v.id} }

// getPointConnectingTo mirrors graph.ts:261-268
func (v *vsVertex) getPointConnectingTo(vertex *vsVertex, onBranch *vsBranch) *vsPoint {
	for x, conn := range v.connections {
		if conn.connectsTo == vertex && conn.onBranch == onBranch {
			return &vsPoint{x: x, y: v.id}
		}
	}
	return nil
}

// registerUnavailablePoint mirrors graph.ts:269-274
//
// 关键点:只有当传入 x === vertex.nextX 时,才推进 nextX(等于 v.nextX++
// 后把 v.nextX 置为 x+1)。这是 vscode 算法的"每行从左到右扫,谁先用归谁"
// 行级状态的核心,保证行内 lane 紧凑且不冲突。
func (v *vsVertex) registerUnavailablePoint(x int, connectsTo *vsVertex, onBranch *vsBranch) {
	if x == v.nextX {
		v.nextX = x + 1
		if v.connections == nil {
			v.connections = make(map[int]*vsUnavailablePoint)
		}
		v.connections[x] = &vsUnavailablePoint{connectsTo: connectsTo, onBranch: onBranch}
	}
}

// addToBranch mirrors graph.ts:231-236
func (v *vsVertex) addToBranch(branch *vsBranch, x int) {
	if v.onBranch == nil {
		v.onBranch = branch
		v.x = x
	}
}

// getColour mirrors graph.ts:279-281
func (v *vsVertex) getColour() int {
	if v.onBranch != nil {
		return v.onBranch.colour
	}
	return 0
}

// graphVscode mirrors graph.ts:337-... Graph class
type graphVscode struct {
	maxColors    int
	sorted       []git.CommitInfo
	shaToRow     map[string]int
	vertices     []*vsVertex
	branches     []*vsBranch
	availableColours []int // graph.ts:342; size = 已用颜色数,每元素是该颜色最后一次被使用时的行
	nextColor    int      // 顺序取色计数器 (g.nextColor)
	maxColorSeen int
}

// newGraphVscode mirrors graph.ts: initial state
func newGraphVscode(maxColors int) *graphVscode {
	if maxColors < 2 {
		maxColors = 2
	}
	return &graphVscode{
		maxColors:       maxColors,
		availableColours: make([]int, 0),
	}
}

// assignNewFlowColor 在 buildResult 阶段为每条新开的 branch 选色
// 颜色从 0..maxColors-1 循环,跟 lane 无关
func (g *graphVscode) assignNewFlowColor() int {
	c := g.nextColor % g.maxColors
	g.nextColor++
	if c > g.maxColorSeen {
		g.maxColorSeen = c
	}
	return c
}

// getAvailableColour mirrors graph.ts:765-773
//
// 注意:TS 版本里每个新 branch 调 getAvailableColour(startAt),
// 优先复用"在 startAt 之前已经结束"的颜色(在 colourUsedAt 数组中记录每个颜色
// 的最后使用行);都没有再 append 新颜色。这跟我们的 assignNewFlowColor 策略
// 不一样(我们是按 nextColor 顺序取色)。
//
// 为了 1:1 复刻,这里改成跟 TS 一致的 getAvailableColour + colourUsedAt 策略。
// 在 buildResult 完成后,我们会再把 availableColours 数组里记录的颜色号直接
// 写到对应 branch,不再用 assignNewFlowColor。
func (g *graphVscode) getAvailableColour(startAt int) int {
	for i, usedAt := range g.availableColours {
		if startAt > usedAt {
			return i
		}
	}
	g.availableColours = append(g.availableColours, 0)
	return len(g.availableColours) - 1
}

// determinePath mirrors graph.ts:705-763
//
// 两种情况:
//   - canDoMergeStitch(merge commit + 父节点都已上 branch):
//     不开新 branch,直接复用 parent branch 沿列插值连到 merge commit
//   - 正常情况:开新 branch,沿 commit 数组往下走,直到遇到当前 commit 的
//     父节点;在每个 commit 处记下 (lastPoint → curPoint),锁定方向
func (g *graphVscode) determinePath(startAt int) {
	vertex := g.vertices[startAt]
	parentVertex := vertex.getNextParent()

	var lastPoint vsPoint
	if vertex.isNotOnBranch() {
		lastPoint = vsPoint{x: vertex.nextX, y: vertex.id}
	} else {
		lastPoint = vsPoint{x: vertex.x, y: vertex.id}
	}

	isMerge := vertex.isMerge()
	parentIsNull := parentVertex != nil && parentVertex.id == vsNULL_VERTEX_ID
	canDoMergeStitch := parentVertex != nil && !parentIsNull && isMerge &&
		!vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()

	if canDoMergeStitch {
		// === Merge stitch: both endpoints already on branches ===
		// graph.ts:712-729
		foundPointToParent := false
		parentBranch := parentVertex.getBranch()
		for j := startAt + 1; j < len(g.vertices); j++ {
			curVertex := g.vertices[j]
			curPoint := curVertex.getPointConnectingTo(parentVertex, parentBranch)
			if curPoint != nil {
				foundPointToParent = true
			} else {
				cp := vsPoint{x: curVertex.nextX, y: curVertex.id}
				curPoint = &cp
			}
			lockedFirst := !foundPointToParent && curVertex != parentVertex && lastPoint.x < curPoint.x
			parentBranch.addLine(lastPoint, *curPoint, vertex.isCommitted, lockedFirst)
			curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch)
			lastPoint = *curPoint
			if foundPointToParent {
				vertex.registerParentProcessed()
				break
			}
		}
		return
	}

	// === Normal: open a new branch ===
	// graph.ts:731-762
	branch := &vsBranch{colour: g.getAvailableColour(startAt)}
	vertex.addToBranch(branch, lastPoint.x)
	vertex.registerUnavailablePoint(lastPoint.x, vertex, branch)
	lastJ := startAt
	for j := startAt + 1; j < len(g.vertices); j++ {
		curVertex := g.vertices[j]
		var curPoint vsPoint
		if parentVertex == curVertex && !parentVertex.isNotOnBranch() {
			curPoint = vsPoint{x: curVertex.x, y: curVertex.id}
		} else {
			curPoint = vsPoint{x: curVertex.nextX, y: curVertex.id}
		}
		branch.addLine(lastPoint, curPoint, vertex.isCommitted, lastPoint.x < curPoint.x)
		curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch)
		lastPoint = curPoint
		lastJ = j
		if parentVertex == curVertex {
			// reached the parent — continue along it
			vertex.registerParentProcessed()
			parentVertexOnBranch := !parentVertex.isNotOnBranch()
			parentVertex.addToBranch(branch, curPoint.x)
			vertex = parentVertex
			if vertex.nextParent < len(vertex.parents) {
				parentVertex = vertex.parents[vertex.nextParent]
			} else {
				parentVertex = nil
			}
			if parentVertex == nil || parentVertexOnBranch {
				break
			}
		}
	}
	// graph.ts:755-758: 如果到末尾且 parent 仍是 null vertex,标记为 processed
	if lastJ == len(g.vertices)-1 && parentVertex != nil && parentVertex.id == vsNULL_VERTEX_ID {
		vertex.registerParentProcessed()
	}
	branch.end = lastJ + 1
	g.branches = append(g.branches, branch)
	g.availableColours[branch.colour] = branch.end
}

// loadCommits mirrors graph.ts:393-440
func (g *graphVscode) loadCommits(commits []git.CommitInfo, head string) {
	if len(commits) == 0 {
		return
	}

	// 1) Stable sort by author date desc, SHA tie-breaker
	g.sorted = make([]git.CommitInfo, len(commits))
	copy(g.sorted, commits)
	sort.SliceStable(g.sorted, func(i, j int) bool {
		if !g.sorted[i].AuthorWhen.Equal(g.sorted[j].AuthorWhen) {
			return g.sorted[i].AuthorWhen.After(g.sorted[j].AuthorWhen)
		}
		return g.sorted[i].SHA < g.sorted[j].SHA
	})

	// 2) SHA → row
	g.shaToRow = make(map[string]int, len(g.sorted))
	for i, c := range g.sorted {
		g.shaToRow[c.SHA] = i
	}

	// 3) Create vertices; use a single null vertex for off-graph parents
	g.vertices = make([]*vsVertex, len(g.sorted))
	for i, c := range g.sorted {
		g.vertices[i] = &vsVertex{
			id:          i,
			sha:         c.SHA,
			isStash:     false, // 当前数据源不传 stash
			connections: make(map[int]*vsUnavailablePoint),
		}
	}
	nullVertex := &vsVertex{id: vsNULL_VERTEX_ID, sha: "<null>", nextX: -1, connections: make(map[int]*vsUnavailablePoint)}

	for i, c := range g.sorted {
		for _, parentSHA := range c.Parents {
			if parentRow, ok := g.shaToRow[parentSHA]; ok {
				parent := g.vertices[parentRow]
				g.vertices[i].addParent(parent)
				parent.addChild(g.vertices[i])
			} else {
				// Off-graph parent → null vertex (mirrors vscode's NULL_VERTEX_ID)
				g.vertices[i].addParent(nullVertex)
			}
		}
	}

	// 4) Mark isCurrent
	if head != "" {
		if row, ok := g.shaToRow[head]; ok {
			g.vertices[row].isCurrent = true
		}
	}

	// 5) Main loop: walk top-down, call determinePath on un-resolved vertices
	// graph.ts:432-439
	i := 0
	safety := 0
	for i < len(g.vertices) {
		safety++
		if safety > len(g.vertices)*8 {
			// pathological input — bail out instead of infinite-looping
			break
		}
		v := g.vertices[i]
		nextParent := v.getNextParent()
		if nextParent != nil || v.isNotOnBranch() {
			g.determinePath(i)
		} else {
			i++
		}
	}
}

// buildResult assembles the public GraphResult from internal state
func (g *graphVscode) buildResult() *GraphResult {
	if len(g.vertices) == 0 {
		return &GraphResult{}
	}

	// 0) 序列化 branches (vscode 风格)
	// 这是 column 0 主线"贯通"的关键: 前端按 branch 画 path,
	// 而不是按 color/edge 画, 完整保留 vscode Branch.draw 的几何。
	branches := make([]GraphBranch, 0, len(g.branches))
	for _, b := range g.branches {
		lines := make([]GraphBranchLine, 0, len(b.lines))
		for _, ln := range b.lines {
			lines = append(lines, GraphBranchLine{
				X1: ln.p1.x, Y1: ln.p1.y,
				X2: ln.p2.x, Y2: ln.p2.y,
				LockedFirst: ln.lockedFirst,
			})
		}
		branches = append(branches, GraphBranch{
			Color: b.colour,
			End:   b.end,
			Lines: lines,
		})
	}

	// 收集每个 commit 的最终 lane / color
	commitLane := make(map[int]int, len(g.vertices))
	commitColor := make(map[int]int, len(g.vertices))
	maxLane := 0
	for i := range g.sorted {
		v := g.vertices[i]
		lane := v.x
		if v.isNotOnBranch() {
			lane = 0
		}
		if lane > maxLane {
			maxLane = lane
		}
		color := 0
		if v.onBranch != nil {
			color = v.onBranch.colour
		}
		commitLane[i] = lane
		commitColor[i] = color
	}

	// 输出 Node 列表
	nodes := make([]GraphNode, len(g.sorted))
	for i := range g.sorted {
		c := &g.sorted[i]
		v := g.vertices[i]
		nodes[i] = GraphNode{
			Row:         i,
			Lane:        commitLane[i],
			Color:       commitColor[i],
			SHA:         c.SHA,
			ShortSHA:    c.ShortSHA,
			Subject:     c.Subject,
			AuthorName:  c.AuthorName,
			AuthorEmail: c.AuthorEmail,
			Date:        c.AuthorWhen.Format("2006-01-02T15:04:05Z07:00"),
			IsMerge:     len(c.Parents) >= 2,
			Parents:     append([]string(nil), c.Parents...),
			Refs:        append([]string(nil), c.Refs...),
			RefTypes:    append([]git.RefType(nil), c.RefTypes...),
			IsCurrent:   v.isCurrent,
			IsStash:     v.isStash,
		}
	}

	// 边集合: 从 commit → parent 重建"逻辑边",对齐前端 EdgeNormal / EdgeBranch / EdgeMerge 三种类型
	edges := make([]GraphEdge, 0, len(g.sorted)*2)
	for i, c := range g.sorted {
		if len(c.Parents) == 0 {
			continue
		}
		childRow := i
		childLane := commitLane[childRow]
		childColor := commitColor[childRow]
		for _, parentSHA := range c.Parents {
			parentRow, ok := g.shaToRow[parentSHA]
			if !ok {
				continue
			}
			parentLane := commitLane[parentRow]
			parentColor := commitColor[parentRow]

			// 边类型与 layout.go v2.8 保持一致(注意方向):
			//   - 同 lane: EdgeNormal
			//   - 异 lane:
			//       parent lane > child lane → child 在向左侧汇入 parent = EdgeMerge
			//       parent lane < child lane → child 从右侧分叉 = EdgeBranch
			edgeType := EdgeNormal
			if childLane != parentLane {
				if parentLane > childLane {
					edgeType = EdgeMerge
				} else {
					edgeType = EdgeBranch
				}
			}

			// 边颜色: 优先用 childColor(同 lane 表示同一 flow 接力);
			// parent 默认色 0 时若不在 main 链则继承 child 色,保证 merge 边有可见色
			edgeColor := childColor
			if childLane != parentLane && parentColor == 0 && parentRow != 0 {
				edgeColor = childColor
			}

			edges = append(edges, GraphEdge{
				FromRow:  childRow,
				ToRow:    parentRow,
				FromLane: childLane,
				ToLane:   parentLane,
				Color:    edgeColor,
				Type:     edgeType,
			})
		}
	}

	return &GraphResult{
		Nodes:    nodes,
		Edges:    edges,
		Branches: branches,
		MaxLane:  maxLane,
		MaxColor: g.maxColorSeen,
	}
}

// BuildGraphVscode is the vscode-style entry point. Used by recheck tooling
// and the frontend comparison.
func BuildGraphVscode(commits []git.CommitInfo) *GraphResult {
	return BuildGraphVscodeWithHead(commits, "")
}

// BuildGraphVscodeWithHead is the vscode-style entry point with HEAD info.
func BuildGraphVscodeWithHead(commits []git.CommitInfo, head string) *GraphResult {
	g := newGraphVscode(defaultMaxColors)
	g.loadCommits(commits, head)
	return g.buildResult()
}
