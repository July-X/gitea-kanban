package graph

import (
	"strings"

	"gitea-kanban/app/git"
)

// defaultMaxColors 默认 16 色队列上限（对齐 Gitea Color16() = ColorNumber % 16）
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
	// IsCurrent 是否 HEAD 节点 (vscode Vertex.draw 画成空心 stroke-only)
	IsCurrent bool
	// IsStash 是否 stash 节点 (vscode Vertex.draw 画成 r=4.5 外圈 + r=2 内圈)
	IsStash bool
	// IsCommitted 是否已提交 (true) 还是未提交的 worktree 变更 (false)
	// 对齐 vscode graph.ts Vertex.draw：uncommitted 时 dot stroke = #808080
	// 目前 NoCheckout:true 模式工作区永远为空，此字段始终为 true
	IsCommitted bool
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

// GraphBranchLine 一段 branch 上的 line (1:1 复刻 vscode Branch.Line)
//
// 坐标以 row/lane 为单位 (像素 = row*GRID_Y + offsetY, lane*GRID_X + offsetX)
// 渲染时 (前端) 直接读这个列表拼 path d
type GraphBranchLine struct {
	X1, Y1      int  // 起点 (lane, row)
	X2, Y2      int  // 终点 (lane, row)
	LockedFirst bool // 跨 lane 转场方向(true=锁 p1, false=锁 p2)
	// IsCommitted 标记该 line 是否落在「已提交」commit 段。对齐 vscode Branch.draw
	// (graph.ts:119-145)：line.isCommitted = (lineIndex >= this.numUncommitted)。
	//   - true:  走 lane 颜色（彩色）
	//   - false: 走 #808080 + stroke-dasharray=2px（灰色虚线）
	// UNCOMMITTED 虚拟 commit 触发的 line 段（UNCOMMITTED → HEAD 一段）会传 false。
	IsCommitted bool
}

// GraphBranch 一条贯通 column 的 path (1:1 复刻 vscode Branch)
//
// 这是 vscode-git-graph 的核心渲染单位: 一条 branch = 一条完整 SVG path
// 包含若干 line 段, 沿 column 顺时针串行。column 0 主线贯通正是这个机制。
type GraphBranch struct {
	Color int               // 颜色号
	End   int               // branch 覆盖的最后一行 + 1
	Lines []GraphBranchLine // 沿 column 顺时针的 line 列表 (p1 接前 line p2)
}

// EdgeType 边类型（与 Gitea `git log --graph` 字形 1:1）
type EdgeType int

const (
	EdgeNormal EdgeType = iota // 普通 first-parent 连线（直线下行）
	EdgeBranch                 // 分支线（from lane ≠ to lane，merge-parent 占新 lane）
	EdgeMerge                  // merge-parent 汇入主干（from lane ≠ to lane）
)

// GraphResult 完整的图布局结果
//
// v0.8.26：layout 算法统一走 GitLens GKC（layout_gitlens.go），本结构为全包
// 唯一 layout 出口，前端 vscode-render.ts + DTO adapter 都按此结构对齐。
type GraphResult struct {
	Nodes []GraphNode
	Edges []GraphEdge
	// Branches 1:1 复刻 vscode-git-graph 的 Branch 对象列表
	// 渲染时按 branch 画 path, 保留"column 0 主线贯通" 的几何
	// (vscode 真实: 每条 branch 一条 path, line 沿 column 顺时针)
	Branches []GraphBranch
	MaxLane  int // 最大 lane 号（对齐 Gitea MaxColumn）
	MaxColor int // 实际用到的最大颜色号（≤15）
	// Truncated 是否截断（commit 数 > 上限，需 deepen 加载后续）
	Truncated bool
	// LocalExhausted 本地 commit 已全部取出，远端可能有更多（需 deepen）。
	LocalExhausted bool
	// DeepenTriggered 后端已启动后台增量 deepen 拉取远端 commit。
	DeepenTriggered bool
}

// HasPrimaryBranchRef 判断 commit 是否挂在 main/master（不分本地还是 remote ref），
// 由 BuildGraphGitlens 在选 pinned head 时调用。trunk ref → lane 0，
// feature ref fallback → 第二 pinned。
//
// v0.8.26：从 layout.go 迁出，graph 包内统一可见。
func HasPrimaryBranchRef(commit git.CommitInfo) bool {
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
