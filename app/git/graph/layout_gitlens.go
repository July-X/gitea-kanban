// layout_gitlens.go — v0.8.25.1 feat 分支：1:1 移植 GitLens commit-graph engine/layout.ts
// (GitLens v18.2.0 GKC GraphContainer.getColumns 算法) 到 Go。
//
// 设计目标：
//   - 与 vscode-git-graph v1.30.0 的 vertex.nextX 单调递增策略彻底分离
//   - 保留 columnsUsed Set + columnsToFreeWhenFound Map + claimNextColumn 最低空位
//   - assignPinnedColumns 用 base-first pinnedShas 让 trunk 落 column 0
//   - canReplaceReservation 严格按 GitLens 规则（多 parent / merge-child / pinned parent → 不可替换）
//   - commit kind 含 'stash' / 'workdir' / 'commit' / 'merge'；date 用于 stash tie-break
//
// 入口契约：
//
//	BuildGraphGitlens(commits []git.CommitInfo, head string, pinnedHeadShas []string) *GraphResult
//
// 输出复用 GraphResult（前端 vscode-render.ts 兼容，DTO 见 types.go）。
//
// v0.8.26：layout_vscode.go / layout.go / pickGraphBuilder env 开关全删，
// 本文件为 graph 包唯一入口。
package graph

import (
	"sort"

	"gitea-kanban/app/git"
)

// gitlensCommitKind 对齐 GitLens engine/types.ts:10 CommitKind
type gitlensCommitKind string

const (
	gitlensKindCommit  gitlensCommitKind = "commit"
	gitlensKindMerge   gitlensCommitKind = "merge"
	gitlensKindStash   gitlensCommitKind = "stash"
	gitlensKindWorkdir gitlensCommitKind = "workdir"
)

// gitlensGraphRow 对齐 GitLens engine/types.ts:60 GraphRow
type gitlensGraphRow struct {
	sha     string
	parents []string
	kind    gitlensCommitKind
	date    int64 // unix ms; 0 when unknown
}

// gitlensEdgeKind 对齐 GitLens engine/types.ts:16 EdgeKind
type gitlensEdgeKind gitlensCommitKind

const (
	gitlensEdgeKindSynthetic gitlensEdgeKind = "synthetic-edge"
)

// gitlensRowEdge 对齐 GitLens engine/types.ts RowEdges（单条 edge）
type gitlensRowEdge struct {
	toSha string
	kind  gitlensEdgeKind
}

// gitlensReserverInfo 对齐 layout.ts:11-16 ReserverInfo
type gitlensReserverInfo struct {
	kind       gitlensCommitKind
	newestDate int64
	column     int
}

// gitlensSegmentBuilder 对齐 layout.ts:18-26 SegmentBuilder
type gitlensSegmentBuilder struct {
	column     int
	mergeSha   string // 空字符串表示 own-row claim（不是 merge 入口）
	branchSha  string // v0.8.25.3 新增：branch-off 源 commit sha（空字符串表示无 branch-off）
	commitShas []string
}

// gitlensLaneSegment 对齐 layout.ts LaneSegment（finalizeSegment 输出）
type gitlensLaneSegment struct {
	id         string // tipSha
	tipSha     string
	forkSha    string // 空字符串表示 end-of-rows 收尾
	mergeSha   string
	branchSha  string // v0.8.25.3 新增：branch-off 源 commit sha
	column     int
	commitShas []string
}

// gitlensLayoutState 对齐 layout.ts:28-45 LayoutState
type gitlensLayoutState struct {
	columnsUsed            map[int]bool
	columnsToFreeWhenFound map[string][]int
	reserverInfoBySha      map[string]*gitlensReserverInfo
	hasMergeNodeChildBySha map[string]bool
	pinnedColumns          map[string]int
	pinnedColumnCount      int
	segmentByColumn        map[int]*gitlensSegmentBuilder
	finalizedSegments      []gitlensLaneSegment
	// compact v0.8.25.7：lane 释放后是否做「左移压缩」（GitLens/GKC 实测行为——
	// 空出的 lane 立即由更右侧的 reservation/segment 递补，长分支链自动靠左、
	// 孤立 commit 靠右）。只调整「未来」状态，已渲染行的 column 不变。
	compact bool
}

func newGitlensLayoutState(pinnedColumns map[string]int, compact bool) *gitlensLayoutState {
	pinnedColumnCount := 0
	for _, c := range pinnedColumns {
		if c+1 > pinnedColumnCount {
			pinnedColumnCount = c + 1
		}
	}
	return &gitlensLayoutState{
		columnsUsed:            make(map[int]bool),
		columnsToFreeWhenFound: make(map[string][]int),
		reserverInfoBySha:      make(map[string]*gitlensReserverInfo),
		hasMergeNodeChildBySha: make(map[string]bool),
		pinnedColumns:          pinnedColumns,
		pinnedColumnCount:      pinnedColumnCount,
		segmentByColumn:        make(map[int]*gitlensSegmentBuilder),
		compact:                compact,
	}
}

// compactLanes v0.8.25.7：lane 释放后把更右的活跃 lane 整体左移一格（lane 压缩）。
//
// 背景：对照 GitLens Commit Graph 实测渲染（用户 xdolphin/TRex 仓库逐像素比对）发现，
// GKC 的 lane 在释放后不会留空洞——更右侧的 reservation/segment 立即左移递补。
// 效果：长分支链自动占据靠左 lane（视觉稳定），孤立 commit（无 first-parent 延续的
// segment）被挤到靠右 lane。不压缩时孤立 commit 会抢刚释放的 lane 1，把长链挤到
// lane 2，lane 1/2 角色与 GitLens 正好相反。
//
// 只调整「未来」状态（columnsUsed / reserverInfoBySha / columnsToFreeWhenFound /
// segmentByColumn 的 key 与 builder.column）；已渲染行的 column 固定不变，连线
// 自然形成斜跨（segmentToLines 按 commit 各自 column 画线）。
//
// pinned 保护区（lane < pinnedColumnCount，trunk 主链）不参与压缩。
func (s *gitlensLayoutState) compactLanes(freedLane int) {
	if !s.compact || freedLane < s.pinnedColumnCount {
		return
	}
	shift := func(lane int) int {
		if lane > freedLane {
			return lane - 1
		}
		return lane
	}

	// 1) columnsUsed 重建（map key 无法原地改，整体重放）
	used := make([]int, 0, len(s.columnsUsed))
	for col := range s.columnsUsed {
		used = append(used, col)
	}
	for _, col := range used {
		delete(s.columnsUsed, col)
	}
	for _, col := range used {
		s.columnsUsed[shift(col)] = true
	}

	// 2) reservation column 同步（未来行的占位左移）
	for _, res := range s.reserverInfoBySha {
		res.column = shift(res.column)
	}

	// 3) columnsToFreeWhenFound 待释放 lane 值同步（历史决策的 lane 编号已变）
	for sha, lanes := range s.columnsToFreeWhenFound {
		for i, col := range lanes {
			lanes[i] = shift(col)
		}
		s.columnsToFreeWhenFound[sha] = lanes
	}

	// 4) segmentByColumn key + builder.column 同步（segment 延续不断链；
	//    shift 是双射，不会撞 key）
	if len(s.segmentByColumn) > 0 {
		rebuilt := make(map[int]*gitlensSegmentBuilder, len(s.segmentByColumn))
		for col, builder := range s.segmentByColumn {
			nc := shift(col)
			builder.column = nc
			rebuilt[nc] = builder
		}
		s.segmentByColumn = rebuilt
	}
}

// finalizeSegment 对齐 layout.ts:65-77
func finalizeSegment(builder *gitlensSegmentBuilder, forkSha string) *gitlensLaneSegment {
	// v0.8.25.3 fix：原版 < 2 直接丢，导致单 commit lane（feature branch 孤立 commit /
	// merge commit 顶点 / stash / tag head）不生成 segment，前端画线缺孤立点 + merge 弧线。
	// 现在改成 < 1 才丢（空 segment 才丢）。
	if len(builder.commitShas) < 1 {
		return nil
	}
	return &gitlensLaneSegment{
		id:         builder.commitShas[0],
		tipSha:     builder.commitShas[0],
		forkSha:    forkSha,
		mergeSha:   builder.mergeSha,
		branchSha:  builder.branchSha,
		column:     builder.column,
		commitShas: append([]string(nil), builder.commitShas...),
	}
}

// claimNextColumn 对齐 layout.ts:88-95 —— 找最低空闲 column
func (s *gitlensLayoutState) claimNextColumn() int {
	col := s.pinnedColumnCount
	for s.columnsUsed[col] {
		col++
	}
	s.columnsUsed[col] = true
	return col
}

// canReplaceReservation 对齐 layout.ts:104-108
// 多 parent / 已有 merge node child / parent 已 pinned → 不可替换（true 表示"允许替换"）
func (s *gitlensLayoutState) canReplaceReservation(rowKind gitlensCommitKind, rowParents int, parentSha string) bool {
	if rowParents > 1 {
		return false
	}
	if s.hasMergeNodeChildBySha[parentSha] {
		return false
	}
	if _, pinned := s.pinnedColumns[parentSha]; pinned {
		return false
	}
	return true
}

// pickParentColumn 对齐 layout.ts:114-118
func (s *gitlensLayoutState) pickParentColumn(parentSha string, parentIndex int, childColumn int) int {
	if pinned, ok := s.pinnedColumns[parentSha]; ok {
		return pinned
	}
	if parentIndex == 0 {
		return childColumn
	}
	return s.claimNextColumn()
}

// stashReserved 对齐 layout.ts:316-322（assignColumnForRow 内 inline 逻辑）
func (s *gitlensLayoutState) stashReserved(rowKind gitlensCommitKind, ownRes *gitlensReserverInfo, rowDate int64, parentRes *gitlensReserverInfo) bool {
	if ownRes == nil {
		return false
	}
	if parentRes.kind != gitlensKindStash {
		return false
	}
	if rowKind == gitlensKindStash {
		return false
	}
	return ownRes.newestDate > parentRes.newestDate
}

// assignColumnForRow 对齐 layout.ts:242-364 核心 single-row 分配
func (s *gitlensLayoutState) assignColumnForRow(row *gitlensGraphRow) int {
	// 1) 释放 columnsToFreeWhenFound 标记的 column
	if toFree, ok := s.columnsToFreeWhenFound[row.sha]; ok {
		for _, col := range toFree {
			if builder, ok := s.segmentByColumn[col]; ok {
				if seg := finalizeSegment(builder, row.sha); seg != nil {
					s.finalizedSegments = append(s.finalizedSegments, *seg)
				}
				delete(s.segmentByColumn, col)
			}
			delete(s.columnsUsed, col)
		}
		delete(s.columnsToFreeWhenFound, row.sha)

		// v0.8.25.7：lane 压缩——释放后更右的活跃 lane 左移填坑（GitLens 实测行为）。
		// 多个 freed lane 按升序逐个压缩：每压一格右侧整体左移，下一个 freed lane
		// 的编号相应减 delta（与先行释放造成的位移对齐）。
		if s.compact {
			sorted := append([]int(nil), toFree...)
			sort.Ints(sorted)
			for delta, col := range sorted {
				s.compactLanes(col - delta)
			}
		}
	}

	// 2) 选 column
	ownReservation, hasOwnRes := s.reserverInfoBySha[row.sha]
	pinnedCol, hasPinned := s.pinnedColumns[row.sha]

	var column int
	if hasPinned {
		column = pinnedCol
		s.columnsUsed[column] = true
		delete(s.reserverInfoBySha, row.sha)
	} else if hasOwnRes {
		column = ownReservation.column
		delete(s.reserverInfoBySha, row.sha)
	} else {
		column = s.claimNextColumn()
	}

	// 3) ensure segment exists for this column (always create when missing)
	// v0.8.25.2 fix：原版 if isOwnRowFreshClaim 漏了 pinned / own-reservation 路径
	// ——pinned head 不会进 segment，lane 0 上的 pinned head 没有 line 渲染，
	// 导致 main chain 在前端显示成"孤立 commit"。
	if _, ok := s.segmentByColumn[column]; !ok {
		// v0.8.25.3 fix：新开的 segment 如果当前 row 有 first parent 且 first parent
		// 不在同一 column，记录 branchSha（branch-off 源 commit sha），后续
		// segmentToLines 用 branchSha 画跨 lane 转场线（branch 分离线）。
		//
		// 注意：仅当当前 column 不是 pinned head 的主 trunk（lane 0）才记录 branchSha。
		// pinned head 自己就是 trunk 起点，first parent 跟它在同一 lane，不需要
		// branch-off 线。
		var branchSha string
		if len(row.parents) > 0 && column > 0 {
			// v0.8.25.3 扩展：fresh claim 路径也记录 branchSha ——
			// feature branch 第一个 commit 走 claimNextColumn()，没有 own-reservation，
			// 但也需要 branch-off 线（从 first parent 所在 lane 连过来）。
			branchSha = row.parents[0]
		}
		s.segmentByColumn[column] = &gitlensSegmentBuilder{
			column:     column,
			mergeSha:   "",
			branchSha:  branchSha,
			commitShas: []string{},
		}
	}

	// 4) 追加本 commit 到对应 segment
	if tracker, ok := s.segmentByColumn[column]; ok {
		tracker.commitShas = append(tracker.commitShas, row.sha)
	}

	rowDate := row.date
	isMerge := len(row.parents) > 1

	// 5) 对每个 parent 处理
	for index, parentSha := range row.parents {
		if isMerge {
			s.hasMergeNodeChildBySha[parentSha] = true
		}

		parentReservation, hasParentRes := s.reserverInfoBySha[parentSha]

		if index == 0 && hasParentRes && parentReservation.column != column {
			// first-parent 已 reserve 不同 column —— 决定谁抢谁
			pendingFrees := s.columnsToFreeWhenFound[parentSha]
			var ownNewestDate int64
			if ownReservation != nil {
				ownNewestDate = ownReservation.newestDate
			} else {
				ownNewestDate = rowDate
			}

			shouldReplace := parentReservation.column > column ||
				s.stashReserved(row.kind, ownReservation, rowDate, parentReservation)

			if shouldReplace && s.canReplaceReservation(row.kind, len(row.parents), parentSha) {
				s.reserverInfoBySha[parentSha] = &gitlensReserverInfo{
					kind:       row.kind,
					newestDate: ownNewestDate,
					column:     column,
				}
				pendingFrees = append(pendingFrees, parentReservation.column)
			} else {
				pendingFrees = append(pendingFrees, column)
			}
			s.columnsToFreeWhenFound[parentSha] = pendingFrees
		} else if !hasParentRes {
			_, isParentPinned := s.pinnedColumns[parentSha]

			// v0.8.26.x fix：非 pinned lane 的 first-parent 链汇入 pinned 主线时，
			// 原版 GKC edge 状态机里这条边自然存在（ending @ child lane 斜入主线 dot），
			// 但本实现的渲染靠 segment 线 —— 必须在这里标记 lane 释放，让 segment
			// 在 parent 行 finalize 出 forkSha，否则 fork 汇入线整段缺失
			// （实测症状：feature 分支链尾端「断头」，看不到汇回主线的斜插线）。
			if index == 0 && isParentPinned && column >= s.pinnedColumnCount {
				s.columnsToFreeWhenFound[parentSha] = append(s.columnsToFreeWhenFound[parentSha], column)
			}

			var ownReservationNewest int64
			if hasOwnRes && ownReservation.column == column {
				if ownReservation != nil {
					ownReservationNewest = ownReservation.newestDate
				}
			} else {
				ownReservationNewest = rowDate
			}

			parentColumn := s.pickParentColumn(parentSha, index, column)
			s.reserverInfoBySha[parentSha] = &gitlensReserverInfo{
				kind:       row.kind,
				newestDate: ownReservationNewest,
				column:     parentColumn,
			}

			// 额外 parent on non-pinned column → genuine branch-off，开 segment
			if index > 0 && !isParentPinned {
				s.segmentByColumn[parentColumn] = &gitlensSegmentBuilder{
					column:     parentColumn,
					mergeSha:   row.sha,
					commitShas: []string{},
				}
			}
		}
	}

	delete(s.hasMergeNodeChildBySha, row.sha)
	return column
}

// identifyFirstParentChain 对齐 layout.ts:129-152
// 沿 first-parent 从每个 head 一路走到 shared base，返回 chain SHA 集合
func identifyFirstParentChain(rows []*gitlensGraphRow, headShas []string) map[string]bool {
	chain := make(map[string]bool)
	if len(headShas) == 0 {
		return chain
	}
	remaining := make(map[string]bool)
	for _, h := range headShas {
		remaining[h] = true
	}
	bySha := make(map[string]*gitlensGraphRow, len(rows))
	for _, r := range rows {
		bySha[r.sha] = r
	}
	for _, row := range rows {
		if !remaining[row.sha] {
			continue
		}
		chain[row.sha] = true
		delete(remaining, row.sha)
		if len(row.parents) > 0 {
			remaining[row.parents[0]] = true
		}
	}
	return chain
}

// assignPinnedColumns 对齐 layout.ts:205-236
// 按 base-first pinnedShas 顺序分配 dense column（head 不在 rows / 已被更早 head 占用 → 不分配）
func assignPinnedColumns(rows []*gitlensGraphRow, pinnedHeadShas []string) map[string]int {
	columns := make(map[string]int)
	if len(pinnedHeadShas) == 0 {
		return columns
	}
	bySha := make(map[string]*gitlensGraphRow, len(rows))
	for _, r := range rows {
		bySha[r.sha] = r
	}

	nextColumn := 0
	for _, head := range pinnedHeadShas {
		if _, ok := bySha[head]; !ok {
			continue
		}
		if _, owned := columns[head]; owned {
			continue
		}
		col := nextColumn
		nextColumn++
		// v0.8.25.5 fix：Uncommitted（工作区虚拟 commit）是 HEAD 的附属，
		// 必须与 HEAD 同 lane —— 否则它 fresh claim 会从 pinnedColumnCount 起扫
		// 拿到 lane 1；且其 first parent 被 pinned 时无冲突、不触发
		// columnsToFreeWhenFound，lane 1 永不释放（lane 泄漏），后续 branch
		// lane 分配连锁偏移（用户实测：绿线 lane 长斜跨、顶部多紫色斜线）。
		// 对齐 GitLens 渲染：Uncommitted 空心圆与 HEAD 同 lane 0。
		for _, r := range rows {
			if r.kind == gitlensKindWorkdir && len(r.parents) > 0 && r.parents[0] == head {
				columns[r.sha] = col
			}
		}
		cur := head
		safety := len(rows) + 1
		for cur != "" && safety > 0 {
			safety--
			if _, owned := columns[cur]; owned {
				break
			}
			columns[cur] = col
			parent := bySha[cur]
			if parent == nil || len(parent.parents) == 0 {
				break
			}
			cur = parent.parents[0]
		}
	}
	return columns
}

// gitlensAssignColumns 对齐 layout.ts:493-510 computeColumnsAndSegments
//
// v0.8.25.7：compact 参数控制是否启用「lane 左移压缩」（GitLens 实测视觉行为）。
// BuildGraphGitlens 双跑：compact=false 产出逻辑 lane（颜色语义），compact=true
// 产出视觉 lane（渲染位置）。
func gitlensAssignColumns(rows []*gitlensGraphRow, pinnedHeadShas []string, compact bool) (map[string]int, []gitlensLaneSegment, int) {
	pinnedColumns := assignPinnedColumns(rows, pinnedHeadShas)
	state := newGitlensLayoutState(pinnedColumns, compact)

	columns := make(map[string]int, len(rows))
	for _, row := range rows {
		col := state.assignColumnForRow(row)
		columns[row.sha] = col
	}

	// drain end-of-rows segments
	for col, builder := range state.segmentByColumn {
		if seg := finalizeSegment(builder, ""); seg != nil {
			state.finalizedSegments = append(state.finalizedSegments, *seg)
		}
		delete(state.segmentByColumn, col)
	}

	maxCol := 0
	for _, c := range columns {
		if c > maxCol {
			maxCol = c
		}
	}

	sort.SliceStable(state.finalizedSegments, func(i, j int) bool {
		if state.finalizedSegments[i].column != state.finalizedSegments[j].column {
			return state.finalizedSegments[i].column < state.finalizedSegments[j].column
		}
		return state.finalizedSegments[i].tipSha < state.finalizedSegments[j].tipSha
	})

	return columns, state.finalizedSegments, maxCol
}

// toGitlensRows 把 git.CommitInfo 数组转成 *gitlensGraphRow，按输入顺序（rows 必须
// 是 latest-first 拓扑序：child 先于 parent；这是 LogCommits CommitterTime 默认行为）
func toGitlensRows(commits []git.CommitInfo) []*gitlensGraphRow {
	rows := make([]*gitlensGraphRow, 0, len(commits))
	for _, c := range commits {
		kind := gitlensKindCommit
		if len(c.Parents) >= 2 {
			kind = gitlensKindMerge
		}
		var dateMs int64
		// v0.8.25.6：reservation 的新旧比较必须和全局排序同时间源（committer date），
		// 否则 author date 远老的 cherry-pick commit 会被当成「更旧的 lane 候选」错误复用。
		if !c.SortTime().IsZero() {
			dateMs = c.SortTime().UnixMilli()
		}
		// UNCOMMITTED 虚拟 commit 标为 workdir
		if c.SHA == git.UNCOMMITTED_HASH {
			kind = gitlensKindWorkdir
		}
		rows = append(rows, &gitlensGraphRow{
			sha:     c.SHA,
			parents: append([]string(nil), c.Parents...),
			kind:    kind,
			date:    dateMs,
		})
	}
	return rows
}

// ============== DTO 转换 ==============

// segmentToLines 把 GitLens segment 转成 vscode-git-graph Branch.draw 兼容的 line 序列
// segment 是「column X 上的连续 commit 列表」，需要拆成 (p1,p2) line 段。
//
// v0.8.25.2 fix：planner 已证 lookupColumn 假实现（查 sha+"__col" 永远 miss），
// 改用 colOf[mergeSha] 真实列号 + rowOf[mergeSha] 真实行号；mergeSha 缺失时
// 兜底 seg.column-1（merge 来自相邻 lane）。
func segmentToLines(seg gitlensLaneSegment, rowOf map[string]int, colOf map[string]int) []GraphBranchLine {
	// v0.8.25.3 fix：原版 < 2 直接丢，导致单 commit lane 没有 vertical line 渲染，
	// 孤立 commit 完全消失。现在改成：单 commit 时也至少画 merge stitch 跨 lane 转场线
	// （如果 mergeSha != ""），否则返回空 lines（让 commit 自己显示成孤立点，由 edges 兜底）。
	var lines []GraphBranchLine
	// v0.8.25.7：lane 压缩后 segment 可能跨 lane（历史 commit 的视觉 column 固定、
	// segment 后续 commit 落在压缩后的新 lane），线的 X 一律用 commit 各自的
	// 视觉 column（colOf[sha]），不再用 seg.column——同 lane 竖线、跨 lane 斜线，
	// 对齐 GitLens 实测渲染（7783396 lane2 → 34b10d6 lane1 的绿色斜线）。
	firstCol := seg.column
	if c, ok := colOf[seg.commitShas[0]]; ok {
		firstCol = c
	}
	// merge stitch 入口：跨 lane 转场首条 line
	if seg.mergeSha != "" {
		mergeCol, ok := colOf[seg.mergeSha]
		if !ok {
			// merge commit 不在可见行（被分页截断），兜底到相邻 lane
			if firstCol > 0 {
				mergeCol = firstCol - 1
			} else {
				mergeCol = 0
			}
		}
		mergeRow, _ := rowOf[seg.mergeSha]
		firstRow, _ := rowOf[seg.commitShas[0]]
		if mergeRow >= firstRow {
			mergeRow = firstRow - 1
		}
		lockedFirst := mergeCol < firstCol
		lines = append(lines, GraphBranchLine{
			X1: mergeCol, Y1: mergeRow,
			X2: firstCol, Y2: firstRow,
			LockedFirst: lockedFirst,
			IsCommitted: true,
		})
	} else if seg.branchSha != "" {
		// v0.8.25.3 fix：branch-off 入口（HEAD/tip 从某条 lane 分离出来）——
		// 画一条从 branchSha 所在 column 到本 segment 第一行的跨 lane 线。
		branchCol, ok := colOf[seg.branchSha]
		if !ok {
			// branch 源 commit 不在可见行（被分页截断），兜底到 lane 0
			branchCol = 0
		}
		branchRow, branchRowOk := rowOf[seg.branchSha]
		firstRow, firstRowOk := rowOf[seg.commitShas[0]]
		if branchRowOk && firstRowOk {
			// v0.8.27 fix：branch-off 入线（HEAD/tip 从某条 lane 分离出来）——
			// 几何与 merge stitch 完全等价：parent 在上端（branchSha row），
			// child 在下端（firstCol commit row）。LockedFirst 用 branchCol<firstCol
			// 计算，与 merge stitch `mergeCol<firstCol` 同语义，与 GitLens 实测一致
			// （main 在左 feature 在右 → 转场在上端 / child 端 LockedFirst=true）。
			// v0.8.25.3 写死 false 与 merge stitch 几何相反，已被实测对标修复。
			lockedFirst := branchCol < firstCol
			lines = append(lines, GraphBranchLine{
				X1: branchCol, Y1: branchRow,
				X2: firstCol, Y2: firstRow,
				LockedFirst: lockedFirst,
				IsCommitted: true,
			})
		}
	}
	// segment 内部 vertical lines
	// v0.8.25.7：X 用相邻 commit 各自的视觉 column（lane 压缩可能跨 lane 形成斜线）
	for i := 0; i+1 < len(seg.commitShas); i++ {
		r1, ok1 := rowOf[seg.commitShas[i]]
		r2, ok2 := rowOf[seg.commitShas[i+1]]
		if !ok1 || !ok2 {
			continue
		}
		c1, cok1 := colOf[seg.commitShas[i]]
		c2, cok2 := colOf[seg.commitShas[i+1]]
		if !cok1 {
			c1 = seg.column
		}
		if !cok2 {
			c2 = seg.column
		}
		lines = append(lines, GraphBranchLine{
			X1: c1, Y1: r1,
			X2: c2, Y2: r2,
			// v0.8.26.x fix：跨 lane 内线（lane 压缩造成的转场）锁 p1 ——
			// GitLens 实测转场在上端（child 行下方一个行高内完成 lane 切换，
			// 然后竖直进入 parent 行）；之前 LockedFirst=false 画成「先竖后斜」，
			// 与 GitLens 形态相反。
			LockedFirst: c1 != c2,
			IsCommitted: true,
		})
	}

	// fork 端 stitch：向下汇入其它 lane（通常主线）的斜插线。
	// v0.8.26.x fix：之前整段缺失 —— seg.forkSha 有值但没生成线，导致
	// 所有「分支汇回主线」的斜插线在前端消失（用户实测：lane 看起来一直延伸，
	// 看不到汇入点）。颜色跟随本 segment（child 端链色），与 GitLens 实测一致
	// （fork 边 = child branch 色；merge 边才是 parent 色）。
	// LockedFirst=false：转场在下端 —— 线沿本 lane 竖直下行，在 parent 行上方
	// 一个行高内斜切到 parent lane（GitLens「先竖后斜」形态）。
	if seg.forkSha != "" && len(seg.commitShas) > 0 {
		// v0.8.30 fix：跳过自指 / 重复情况。单 commit segment + forkSha 与
		// branchSha 双重存在时（int-test 这种 fresh claim：parent=main_head
		// 同时是 branch-off 源 + fork 汇入目标）会重复画同一坐标的两条反向 line
		// （branch-off + fork stitch 视觉叠加 stroke 2 倍），导致用户反馈
		// "绘制多次 lane 的 bug"。
		//
		// 跳过条件：
		//   - forkSha == branchSha（branch-off 起点与 fork 汇入目标重合）
		//   - forkSha == tipSha（fork 自己）
		//   - forkSha == tip commit（单 commit segment 时是该 fork 等于 tip commit
		//     自身任何父项，即 tip = branchSha = forkSha 同时成立）
		//
		// 真实场景：fresh claim segment 只该画 1 条 branch-off line，fork stitch
		// 等真正 merge 入主线时才有意义。
		isSelfRef := seg.forkSha == seg.branchSha ||
			seg.forkSha == seg.tipSha ||
			seg.forkSha == seg.commitShas[0]
		if !isSelfRef {
			last := seg.commitShas[len(seg.commitShas)-1]
			lastRow, okLast := rowOf[last]
			forkRow, okFork := rowOf[seg.forkSha]
			if okLast && okFork && forkRow > lastRow {
				lastCol := seg.column
				if c, ok := colOf[last]; ok {
					lastCol = c
				}
				forkCol := 0
				if c, ok := colOf[seg.forkSha]; ok {
					forkCol = c
				}
				lines = append(lines, GraphBranchLine{
					X1:          lastCol,
					Y1:          lastRow,
					X2:          forkCol,
					Y2:          forkRow,
					LockedFirst: false,
					IsCommitted: true,
				})
			}
		}
	}

	return lines
}

// segmentsToBranches 按 segment 生成 GraphBranch
//
// v0.8.25.2 fix：End 改为 rowOf[seg.commitShas[len-1]]+1（行号+1，对齐 vscode
// branch 契约 layout.go:109 "branch 覆盖的最后一行 + 1"），不是 len(commitShas) commit 计数。
//
// v0.8.25.7：颜色改用 colorColOf[首个 commit]（未压缩逻辑 lane），不再用 seg.column
// ——lane 压缩后 seg.column 是视觉位置，GitLens 的颜色语义是「segment 首次 claim 的 lane」
// （如 34b10d6 链视觉左移到 lane 1，但保留 claim 时 lane 2 的绿色）。
func segmentsToBranches(segments []gitlensLaneSegment, rowOf map[string]int, colOf map[string]int, colorColOf map[string]int) []GraphBranch {
	branches := make([]GraphBranch, 0, len(segments))
	for _, seg := range segments {
		lines := segmentToLines(seg, rowOf, colOf)
		// End: 最后一行 row 号 + 1（行号 + 1，对齐 vscode branch.draw 契约）
		var end int
		if n := len(seg.commitShas); n > 0 {
			if r, ok := rowOf[seg.commitShas[n-1]]; ok {
				end = r + 1
			} else {
				// fallback: sha 不在 rowOf（极端情况），用第一个 sha 的行 + n
				if r, ok := rowOf[seg.commitShas[0]]; ok {
					end = r + n
				} else {
					end = n
				}
			}
		}
		// v0.8.25.7：segment 颜色 = 首个 commit 的逻辑 lane；fallback 到视觉 lane
		colorLane := seg.column
		if len(seg.commitShas) > 0 {
			if cl, ok := colorColOf[seg.commitShas[0]]; ok {
				colorLane = cl
			}
		}
		branches = append(branches, GraphBranch{
			Color: colorLane % 16,
			End:   end,
			Lines: lines,
		})
	}
	return branches
}

// BuildGraphGitlens graph 包公共入口（v0.8.26 唯一）
// pinnedHeadShas 由 caller 提供（base-first：trunk head 最先）。
// 典型用法：trunk head (main/master) + 当前 branch head。
func BuildGraphGitlens(commits []git.CommitInfo, head string, pinnedHeadShas []string) *GraphResult {
	if len(commits) == 0 {
		return &GraphResult{}
	}
	rows := toGitlensRows(commits)

	// pinned heads 兜底：trunk head（main/master）放在最前
	var pinned []string
	for _, ph := range pinnedHeadShas {
		pinned = append(pinned, ph)
	}
	if len(pinned) == 0 {
		for _, c := range commits {
			if HasPrimaryBranchRef(c) {
				pinned = append(pinned, c.SHA)
				break
			}
		}
		if len(pinned) == 0 {
			pinned = []string{commits[0].SHA}
		}
	}

	columns, segments, maxCol := gitlensAssignColumns(rows, pinned, true)

	// v0.8.25.7：双轨布局——再跑一遍「未压缩」GKC 原版，产出逻辑 lane（颜色语义）。
	// 逐像素比对 GitLens 实测渲染证实：位置按压缩后 lane（columns），但颜色按
	// segment 首次 claim 时的未压缩 lane（例：孤立 commit b2139fe 视觉在 lane 2，
	// 颜色却是 lane 1 的橙——它原版 claim 的就是 lane 1）。
	colorCols, _, _ := gitlensAssignColumns(rows, pinned, false)

	// rowOf：SHA → row 索引
	rowOf := make(map[string]int, len(commits))
	for i, c := range commits {
		rowOf[c.SHA] = i
	}
	colOf := make(map[string]int, len(commits))
	for sha, col := range columns {
		colOf[sha] = col
	}
	// colorColOf：SHA → 未压缩逻辑 lane（仅用于取色）
	colorColOf := make(map[string]int, len(commits))
	for sha, col := range colorCols {
		colorColOf[sha] = col
	}

	// Nodes
	// v0.8.25.7：Lane 用视觉 lane（colOf），Color 用逻辑 lane（colorColOf）——
	// 位置与颜色分离，对齐 GitLens 实测（孤立 commit 位置靠右但保留原 claim lane 的颜色）。
	nodes := make([]GraphNode, len(commits))
	for i, c := range commits {
		col := colOf[c.SHA]
		color := colorColOf[c.SHA] % 16
		nodes[i] = GraphNode{
			Row:         i,
			Lane:        col,
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

	// Edges
	// v0.8.25.7：lane 位置用视觉 lane（colOf），edge 颜色用逻辑 lane（colorColOf）。
	edges := make([]GraphEdge, 0, len(commits)*2)
	for i, c := range commits {
		if len(c.Parents) == 0 {
			continue
		}
		childRow := i
		childLane := colOf[c.SHA]
		childColor := colorColOf[c.SHA] % 16
		for parentIdx, parentSHA := range c.Parents {
			parentRow, ok := rowOf[parentSHA]
			if !ok {
				continue
			}
			parentLane := colOf[parentSHA]
			parentColor := colorColOf[parentSHA] % 16

			edgeColor := childColor
			if parentIdx > 0 {
				// v0.8.26.x fix：merge 边（second+ parent）颜色 = parent（被合入方）链色，
				// 对齐 GitLens 实测（例：1348ba6→cfcf339 汇入主线，边为主线蓝色而非
				// child 的绿色）。之前恒为 childColor，方向反了。
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

	branches := segmentsToBranches(segments, rowOf, colOf, colorColOf)

	// v0.8.26.x fix：merge 合入线补全 —— merge commit 的 second+ parent 已经在
	// 其它 lane 有归属（如「Merge branch 'master'」把主线 cfcf339 合入 feature
	// 分支 1348ba6）时，segment 模型不会为它开新 segment，也就没有任何 stitch，
	// 这条边在 branches 里完全丢失（edges 里有但前端优先用 branches 渲染）。
	// GitLens 实测这条边存在：从 merge dot 斜切到 parent lane 后竖直到 parent dot，
	// 颜色 = parent 链色。这里按 edge 数据补成独立单线 branch。
	for i, c := range commits {
		if len(c.Parents) < 2 {
			continue
		}
		for _, parentSHA := range c.Parents[1:] {
			parentRow, ok := rowOf[parentSHA]
			if !ok {
				continue
			}
			// 已有 merge stitch 的（parent 是本 merge 新开 segment 的 tip）跳过
			covered := false
			for _, seg := range segments {
				if seg.mergeSha == c.SHA && seg.tipSha == parentSHA {
					covered = true
					break
				}
			}
			if covered {
				continue
			}
			childLane := colOf[c.SHA]
			parentLane := colOf[parentSHA]
			if childLane == parentLane {
				// 同 lane：与既有竖线重叠，视觉无增量，跳过
				continue
			}
			branches = append(branches, GraphBranch{
				Color: colorColOf[parentSHA] % 16,
				End:   parentRow + 1,
				Lines: []GraphBranchLine{{
					X1: childLane, Y1: i,
					X2: parentLane, Y2: parentRow,
					LockedFirst: true, // 转场在上端：merge dot 下方立即斜切到 parent lane
					IsCommitted: true,
				}},
			})
		}
	}

	if maxCol < 0 {
		maxCol = 0
	}

	return &GraphResult{
		Nodes:     nodes,
		Edges:     edges,
		Branches:  branches,
		MaxLane:   maxCol,
		MaxColor:  16,
		Truncated: false,
	}
}
