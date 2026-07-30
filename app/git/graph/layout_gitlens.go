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
// 入口契约（与 BuildGraphVscodeWithHead 一致）：
//   BuildGraphGitlens(commits []git.CommitInfo, head string, pinnedHeadShas []string) *GraphResult
// 输出复用现有 GraphResult（前端 vscode-render.ts 兼容）。
//
// 旧 BuildGraphVscodeWithHead（vscode-git-graph 1:1 复刻）保留为 fallback。
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
	kind gitlensEdgeKind
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
	id         string   // tipSha
	tipSha     string
	forkSha    string   // 空字符串表示 end-of-rows 收尾
	mergeSha   string
	branchSha  string   // v0.8.25.3 新增：branch-off 源 commit sha
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
}

func newGitlensLayoutState(pinnedColumns map[string]int) *gitlensLayoutState {
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
func gitlensAssignColumns(rows []*gitlensGraphRow, pinnedHeadShas []string) (map[string]int, []gitlensLaneSegment, int) {
	pinnedColumns := assignPinnedColumns(rows, pinnedHeadShas)
	state := newGitlensLayoutState(pinnedColumns)

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
	// merge stitch 入口：跨 lane 转场首条 line
	if seg.mergeSha != "" {
		mergeCol, ok := colOf[seg.mergeSha]
		if !ok {
			// merge commit 不在可见行（被分页截断），兜底到相邻 lane
			if seg.column > 0 {
				mergeCol = seg.column - 1
			} else {
				mergeCol = 0
			}
		}
		mergeRow, _ := rowOf[seg.mergeSha]
		firstRow, _ := rowOf[seg.commitShas[0]]
		if mergeRow >= firstRow {
			mergeRow = firstRow - 1
		}
		lockedFirst := mergeCol < seg.column
		lines = append(lines, GraphBranchLine{
			X1: mergeCol, Y1: mergeRow,
			X2: seg.column, Y2: firstRow,
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
			// branch-off 线：从 branchSha 行 (X=branchCol) 到 firstRow (X=seg.column)
			// 方向：Y 从小到大（branchRow 通常 > firstRow，因为 branchSha 是祖先，
			// 在 latest-first 拓扑序中祖先 row 更大）
			lines = append(lines, GraphBranchLine{
				X1: branchCol, Y1: branchRow,
				X2: seg.column, Y2: firstRow,
				LockedFirst: false,
				IsCommitted: true,
			})
		}
	}
	// segment 内部 vertical lines
	for i := 0; i+1 < len(seg.commitShas); i++ {
		r1, ok1 := rowOf[seg.commitShas[i]]
		r2, ok2 := rowOf[seg.commitShas[i+1]]
		if !ok1 || !ok2 {
			continue
		}
		lines = append(lines, GraphBranchLine{
			X1: seg.column, Y1: r1,
			X2: seg.column, Y2: r2,
			LockedFirst: false,
			IsCommitted: true,
		})
	}
	return lines
}

// segmentsToBranches 按 segment 生成 GraphBranch
//
// v0.8.25.2 fix：End 改为 rowOf[seg.commitShas[len-1]]+1（行号+1，对齐 vscode
// branch 契约 layout.go:109 "branch 覆盖的最后一行 + 1"），不是 len(commitShas) commit 计数。
// Color 按 seg.column % 16（同 lane 同色，对齐 GitLens lane 着色），不再按 segIdx
// ——GitLens 同一 column 上多个 segment 共用颜色，前端按 lane 一致着色。
func segmentsToBranches(segments []gitlensLaneSegment, rowOf map[string]int, colOf map[string]int) []GraphBranch {
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
		branches = append(branches, GraphBranch{
			Color: seg.column % 16,
			End:   end,
			Lines: lines,
		})
	}
	return branches
}

// BuildGraphGitlens 公共入口（与 BuildGraphVscodeWithHead 签名对齐）
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

	columns, segments, maxCol := gitlensAssignColumns(rows, pinned)

	// rowOf：SHA → row 索引
	rowOf := make(map[string]int, len(commits))
	for i, c := range commits {
		rowOf[c.SHA] = i
	}
	colOf := make(map[string]int, len(commits))
	for sha, col := range columns {
		colOf[sha] = col
	}

	// Nodes
	// v0.8.25.2 fix：颜色按 column % 16 取（同 lane 同色），不再按 segIdx % 16
	// ——GitLens 同一 column 上多个 segment 共用颜色，前端按 lane 一致着色。
	// sha 命中后用 found flag 跳出双层循环（之前的 break 只 break 内层）。
	nodes := make([]GraphNode, len(commits))
	for i, c := range commits {
		col := colOf[c.SHA]
		color := col % 16
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
	// v0.8.25.2 fix：color 也按 lane（childLane % 16 / parentLane % 16），
	// 不再扫 segment 取色——更简单更稳。
	edges := make([]GraphEdge, 0, len(commits)*2)
	for i, c := range commits {
		if len(c.Parents) == 0 {
			continue
		}
		childRow := i
		childLane := colOf[c.SHA]
		childColor := childLane % 16
		for parentIdx, parentSHA := range c.Parents {
			parentRow, ok := rowOf[parentSHA]
			if !ok {
				continue
			}
			parentLane := colOf[parentSHA]
			parentColor := parentLane % 16

			edgeColor := childColor
			if childLane != parentLane && parentColor == 0 && parentIdx > 0 {
				edgeColor = childColor
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

	branches := segmentsToBranches(segments, rowOf, colOf)

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