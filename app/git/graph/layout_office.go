// layout_office.go — v0.8.34 移植：把 vscode-office 1:1 移植到 Go。
//
// vscode-office 走的算法范式跟 vscode-git-graph 原版一致：
//
//   - 每个 vertex 有 nextX（"下一个空位"），addToBranch(x) 后固定 x 坐标
//   - addLine 时碰到 vertex 的 getPointConnectingTo 命中就 stitch 到那个 column
//   - 不维护 columnsUsed Set，按 vertex.nextX 单调递增分配 lane
//   - getAvailableColour 回收 availableColours[i] < startAt 的颜色
//
// 与 layout_gitlens.go（GKC columnsUsed + claimNextColumn 紧凑算法）的核心区别：
//
//   - office 没有"找最低空 lane"的概念，vertex.nextX 只增不减 → 图宽会膨胀
//   - office 用 Branch + Line（按 p1/p2/lockedFirst 串）来画线，GitLens 用 Segment
//   - office 把 UNCOMMITTED 直接并入 commit[0] 节点（setNotCommitted + setCurrent）
//
// 与 layout_gitlens.go 共用 GraphResult DTO（types.go），前端 vscode-render.ts 不变。
//
// 算法源：~/2026/github/vscode-office/src/react/view/gitHistory/graph/layoutEngine.ts
// 字段语义 1:1 复刻，包括 Branch.numUncommitted + Vertex.connections[]。
//
// pinnedHeadShas 接口兼容 BuildGraphGitlens；office 算法本身不消费 pinnedHeadShas
// （head 由 commits[0] 推到 determinePath），但保留入参方便 adapter 一键切换。
package graph

import (
	"gitea-kanban/app/git"
)

// officeNullVertexID 对应 layoutEngine.ts:78 NULL_VERTEX_ID = -1
const officeNullVertexID = -1

// officeVertex 对应 layoutEngine.ts:195 Vertex 类
type officeVertex struct {
	id          int
	isStash     bool
	x           int
	children    []*officeVertex
	parents     []*officeVertex
	nextParent  int
	onBranch    *officeBranch // nil 表示未挂
	isCommitted bool
	isCurrent   bool
	nextX       int
	connections []*officeUnavailablePoint
}

type officeUnavailablePoint struct {
	connectsTo *officeVertex
	onBranch   *officeBranch
}

func newOfficeVertex(id int, isStash bool) *officeVertex {
	return &officeVertex{
		id:          id,
		isStash:     isStash,
		x:           0,
		children:    nil,
		parents:     nil,
		nextParent:  0,
		onBranch:    nil,
		isCommitted: true,
		isCurrent:   false,
		nextX:       0,
		connections: nil,
	}
}

func (v *officeVertex) addChild(c *officeVertex)  { v.children = append(v.children, c) }
func (v *officeVertex) addParent(p *officeVertex) { v.parents = append(v.parents, p) }
func (v *officeVertex) getNextParent() *officeVertex {
	if v.nextParent < len(v.parents) {
		return v.parents[v.nextParent]
	}
	return nil
}
func (v *officeVertex) registerParentProcessed() { v.nextParent++ }
func (v *officeVertex) isMerge() bool            { return len(v.parents) > 1 }

// addToBranch 对应 Vertex.addToBranch：onBranch 为空时固定 vertex 的 x
func (v *officeVertex) addToBranch(b *officeBranch, x int) {
	if v.onBranch == nil {
		v.onBranch = b
		v.x = x
	}
}
func (v *officeVertex) isNotOnBranch() bool { return v.onBranch == nil }
func (v *officeVertex) isOnThisBranch(b *officeBranch) bool {
	return v.onBranch == b
}
func (v *officeVertex) getBranch() *officeBranch { return v.onBranch }
func (v *officeVertex) getPoint() officePoint {
	return officePoint{x: v.x, y: v.id}
}
func (v *officeVertex) getNextPoint() officePoint {
	return officePoint{x: v.nextX, y: v.id}
}

// getPointConnectingTo 对应 Vertex.getPointConnectingTo：在 connections 里找
// connectsTo == vertex 且 onBranch == onBranch 的连接点；返回 x = i（连接序号）。
func (v *officeVertex) getPointConnectingTo(target *officeVertex, onBranch *officeBranch) *officePoint {
	for i, conn := range v.connections {
		if conn.connectsTo == target && conn.onBranch == onBranch {
			return &officePoint{x: i, y: v.id}
		}
	}
	return nil
}

// registerUnavailablePoint 对应 Vertex.registerUnavailablePoint：占掉 vertex.nextX 位置
func (v *officeVertex) registerUnavailablePoint(x int, connectsTo *officeVertex, onBranch *officeBranch) {
	if x == v.nextX {
		v.nextX = x + 1
		// 扩张 connections 到 x 索引
		for len(v.connections) <= x {
			v.connections = append(v.connections, nil)
		}
		v.connections[x] = &officeUnavailablePoint{connectsTo: connectsTo, onBranch: onBranch}
	}
}
func (v *officeVertex) getColour() int {
	if v.onBranch != nil {
		return v.onBranch.getColour()
	}
	return 0
}
func (v *officeVertex) getIsCommitted() bool { return v.isCommitted }
func (v *officeVertex) setNotCommitted()     { v.isCommitted = false }
func (v *officeVertex) setCurrent()          { v.isCurrent = true }

// officePoint 对应 GraphPoint（x: lane, y: row）
type officePoint struct {
	x int
	y int
}

// officeLine 对应 Branch.addLine 入参：p1, p2, lockedFirst
type officeLine struct {
	p1          officePoint
	p2          officePoint
	lockedFirst bool
}

// officeBranch 对应 layoutEngine.ts:80 Branch 类
type officeBranch struct {
	colour         int
	end            int
	lines          []officeLine
	numUncommitted int
}

// addLine 对应 Branch.addLine：lines 追加 + numUncommitted 维护
//
//	numUncommitted 规则（layoutEngine.ts:87-94）：
//	  - isCommitted=true 且 p2.x == 0 且 p2.y < numUncommitted → 把 numUncommitted 往小推
//	  - isCommitted=false → numUncommitted++
func (b *officeBranch) addLine(p1, p2 officePoint, isCommitted bool, lockedFirst bool) {
	b.lines = append(b.lines, officeLine{p1: p1, p2: p2, lockedFirst: lockedFirst})
	if isCommitted {
		if p2.x == 0 && p2.y < b.numUncommitted {
			b.numUncommitted = p2.y
		}
	} else {
		b.numUncommitted++
	}
}

func (b *officeBranch) getColour() int { return b.colour }
func (b *officeBranch) getEnd() int    { return b.end }
func (b *officeBranch) setEnd(end int) { b.end = end }

// officeGraphEngine 对应 layoutEngine.ts:267 GraphEngine 类
type officeGraphEngine struct {
	vertices         []*officeVertex
	branches         []*officeBranch
	availableColours []int
}

// compute 对应 GraphEngine.compute：跑 office 算法，返回 *officeGraphEngine + maxLane。
func (e *officeGraphEngine) compute(commits []git.CommitInfo, commitHead string) (maxLane int, ok bool) {
	e.vertices = nil
	e.branches = nil
	e.availableColours = nil

	if len(commits) == 0 {
		return 0, false
	}

	// commitLookup: SHA → row index
	commitLookup := make(map[string]int, len(commits))
	for i, c := range commits {
		commitLookup[c.SHA] = i
	}

	nullVertex := newOfficeVertex(officeNullVertexID, false)
	vertices := make([]*officeVertex, len(commits))
	for i := range commits {
		// office 用 stash !== null 决定 isStash；我们的 CommitInfo 没有 stash 字段，
		// 仅用 row==0 是否为 UNCOMMITTED 触发 setCurrent / setNotCommitted。
		vertices[i] = newOfficeVertex(i, false)
	}
	e.vertices = vertices

	for i := range commits {
		c := commits[i]
		for _, parentHash := range c.Parents {
			parentIdx, found := commitLookup[parentHash]
			if found {
				vertices[i].addParent(vertices[parentIdx])
				vertices[parentIdx].addChild(vertices[i])
			} else {
				// parent 不在当前 commit 集（被截断 / 远端不可见），挂到 nullVertex
				vertices[i].addParent(nullVertex)
			}
		}
	}

	// UNCOMMITTED 模式：commits[0] 触发 setNotCommitted + setCurrent
	if commits[0].SHA == git.UNCOMMITTED_HASH {
		vertices[0].setNotCommitted()
		vertices[0].setCurrent()
	} else if commitHead != "" {
		if idx, ok := commitLookup[commitHead]; ok {
			vertices[idx].setCurrent()
		}
	}

	// 主循环（layoutEngine.ts:331-338 1:1 复刻）
	//
	// 死循环保护：office 主循环只在 vertex.getNextParent() 被消费（返回 null）或
	// vertex 挂到 branch（isNotOnBranch 返回 false）时 i++。如果 determinePath
	// 返回时 vertex 仍没消费掉 nextParent 且没挂 branch（比如真实 git 数据下
	// parent row < child row 这种被 office 原版假设排除的乱序输入），主循环会
	// 死循环。Go 里没有 TS 栈溢出兜底，必须显式保护。
	for i := 0; i < len(vertices); {
		if vertices[i].getNextParent() != nil || vertices[i].isNotOnBranch() {
			prevNextParent := vertices[i].getNextParent()
			prevOnBranch := vertices[i].getBranch()
			e.determinePath(i)
			// 进度判定：determinePath 必须让 vertex 消费 nextParent 或挂到 branch
			// 中之一，否则 i 不动 → 死循环风险
			advanced := vertices[i].getNextParent() != prevNextParent ||
				vertices[i].getBranch() != prevOnBranch
			if !advanced {
				i++ // 跳过这个 vertex（office 原版假设下不会触发；保护用）
			}
		} else {
			i++
		}
	}

	// maxLane = 所有 vertex.x 中最大（图布局占用的最远 lane 编号，对齐 task 4.2 + Gitea MaxColumn 语义）
	maxX := 0
	for _, v := range vertices {
		if v.x > maxX {
			maxX = v.x
		}
	}
	return maxX, true
}

// determinePath 对应 GraphEngine.determinePath（layoutEngine.ts:367-422）
//
// 两分支：
//   - merge stitch（line 373-393）：merge vertex 已挂 branch 且 parent 也挂 branch 时，
//     沿 column 找 parent branch 上的命中点斜切
//   - new branch（line 394-422）：开新 Branch + 沿 parent 走到底
func (e *officeGraphEngine) determinePath(startAt int) {
	i := startAt
	vertex := e.vertices[i]
	parentVertex := vertex.getNextParent()
	lastPoint := officePoint{}
	if vertex.isNotOnBranch() {
		lastPoint = vertex.getNextPoint()
	} else {
		lastPoint = vertex.getPoint()
	}

	if parentVertex != nil && parentVertex.id != officeNullVertexID &&
		vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch() {
		// ----- merge stitch 分支 -----
		foundPointToParent := false
		parentBranch := parentVertex.getBranch()
		for i = startAt + 1; i < len(e.vertices); i++ {
			curVertex := e.vertices[i]
			var curPoint officePoint
			connectPoint := curVertex.getPointConnectingTo(parentVertex, parentBranch)
			if connectPoint != nil {
				foundPointToParent = true
				curPoint = *connectPoint
			} else {
				curPoint = curVertex.getNextPoint()
			}
			parentBranch.addLine(
				lastPoint,
				curPoint,
				vertex.getIsCommitted(),
				!foundPointToParent && curVertex != parentVertex && lastPoint.x < curPoint.x,
			)
			curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch)
			lastPoint = curPoint
			if foundPointToParent {
				vertex.registerParentProcessed()
				break
			}
		}
	} else {
		// ----- new branch 分支 -----
		branch := newOfficeBranch(e.getAvailableColour(startAt))
		vertex.addToBranch(branch, lastPoint.x)
		vertex.registerUnavailablePoint(lastPoint.x, vertex, branch)
		for i = startAt + 1; i < len(e.vertices); i++ {
			curVertex := e.vertices[i]
			var curPoint officePoint
			if parentVertex == curVertex && !parentVertex.isNotOnBranch() {
				curPoint = curVertex.getPoint()
			} else {
				curPoint = curVertex.getNextPoint()
			}
			branch.addLine(
				lastPoint,
				curPoint,
				vertex.getIsCommitted(),
				lastPoint.x < curPoint.x,
			)
			curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch)
			lastPoint = curPoint

			if parentVertex == curVertex {
				vertex.registerParentProcessed()
				parentOnBranch := !parentVertex.isNotOnBranch()
				parentVertex.addToBranch(branch, curPoint.x)
				vertex = parentVertex
				parentVertex = vertex.getNextParent()
				if parentVertex == nil || parentOnBranch {
					break
				}
			}
		}
		// nullVertex 兜底（对应 layoutEngine.ts:416-418）
		if i == len(e.vertices) && parentVertex != nil && parentVertex.id == officeNullVertexID {
			vertex.registerParentProcessed()
		}
		branch.setEnd(i)
		e.branches = append(e.branches, branch)
		e.availableColours[branch.getColour()] = i
	}
}

// getAvailableColour 对应 GraphEngine.getAvailableColour（layoutEngine.ts:425-431）
//
// 回收 availableColours[i] < startAt 的颜色（即 branch 已在 startAt 之前结束），
// 没可回收就 push 新槽位。
func (e *officeGraphEngine) getAvailableColour(startAt int) int {
	for i, v := range e.availableColours {
		if startAt > v {
			return i
		}
	}
	e.availableColours = append(e.availableColours, 0)
	return len(e.availableColours) - 1
}

func newOfficeBranch(colour int) *officeBranch {
	return &officeBranch{
		colour:         colour,
		end:            0,
		lines:          nil,
		numUncommitted: 0,
	}
}

// BuildGraphOffice 把 []git.CommitInfo 用 vscode-office layoutEngine 算法
// 1:1 转 GraphResult。签名与 BuildGraphGitlens 完全一致，方便 adapter 一键切换。
//
// pinnedHeadShas 入参保留兼容（office 算法本身不消费），兜底 head = commits[0].SHA。
//
// truncated 透传到 GraphResult.Truncated。
func BuildGraphOffice(commits []git.CommitInfo, head string, pinnedHeadShas []string, truncated bool) *GraphResult {
	_ = pinnedHeadShas // office 算法不消费，仅接口兼容
	if len(commits) == 0 {
		return &GraphResult{}
	}

	// office 算法把 commits[0] 视为 head；真实 head 不在 commits[0] 时，setCurrent
	// 会通过 commitLookup[commitHead] 在 setCurrent 阶段单独标（layoutEngine.ts:327-329）。
	engine := &officeGraphEngine{}
	maxLane, ok := engine.compute(commits, head)
	if !ok {
		return &GraphResult{}
	}

	// rowOf: SHA → row index
	rowOf := make(map[string]int, len(commits))
	for i, c := range commits {
		rowOf[c.SHA] = i
	}

	// ----- Nodes -----
	nodes := make([]GraphNode, len(commits))
	for i, c := range commits {
		v := engine.vertices[i]
		lane := v.x
		color := lane % 16
		nodes[i] = GraphNode{
			Row:         i,
			Lane:        lane,
			Color:       color,
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
			IsCommitted: c.SHA != git.UNCOMMITTED_HASH,
			IsCurrent:   c.SHA == head,
		}
	}

	// ----- Edges -----
	edges := make([]GraphEdge, 0, len(commits)*2)
	for i, c := range commits {
		if len(c.Parents) == 0 {
			continue
		}
		childRow := i
		childLane := engine.vertices[i].x
		childColor := childLane % 16
		for parentIdx, parentSHA := range c.Parents {
			parentRow, ok := rowOf[parentSHA]
			if !ok {
				continue
			}
			parentLane := engine.vertices[parentRow].x
			parentColor := parentLane % 16

			edgeColor := childColor
			if parentIdx > 0 {
				// merge 边（second+ parent）颜色 = parent 链色，对齐 gitlens 现有逻辑
				edgeColor = parentColor
			}
			edgeType := EdgeNormal
			if childLane != parentLane {
				if parentLane > childLane {
					edgeType = EdgeMerge
				} else {
					edgeType = EdgeBranch
				}
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

	// ----- Branches -----
	branches := make([]GraphBranch, 0, len(engine.branches))
	for _, b := range engine.branches {
		lines := make([]GraphBranchLine, 0, len(b.lines))
		for lineIdx, l := range b.lines {
			// line.isCommitted = (lineIndex >= numUncommitted)（Branch.toPaths 逻辑）
			isCommitted := lineIdx >= b.numUncommitted
			lines = append(lines, GraphBranchLine{
				X1:          l.p1.x,
				Y1:          l.p1.y,
				X2:          l.p2.x,
				Y2:          l.p2.y,
				LockedFirst: l.lockedFirst,
				IsCommitted: isCommitted,
			})
		}
		branches = append(branches, GraphBranch{
			Color: b.colour % 16,
			End:   b.end,
			Lines: lines,
		})
	}

	return &GraphResult{
		Nodes:     nodes,
		Edges:     edges,
		Branches:  branches,
		MaxLane:   maxLane,
		MaxColor:  16,
		Truncated: truncated,
	}
}
