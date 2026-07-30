# GitGraph 布局算法：GitLens GKC 移植 + vscode-git-graph 复刻对照

> **生效版本**：v0.8.25 起（master commit `54d1850`）
> **前序文档**：[./06-gitgraph.md](./06-gitgraph.md)（高层设计/数据流/前端渲染）｜[./gitgraph-engine-history.md](./gitgraph-engine-history.md)（四阶段算法演进 + 5 个具体 bug fix 经历）
> **目标读者**：要复用本项目 Graph 算法的 AI / 工程师、需要理解 lane 分配与 stitch 渲染的代码维护者

本文件专门讲**「为啥这样做」**：lane 怎么分配、fork/merge 线怎么画、双轨布局（视觉 lane + 颜色 lane）为啥要跑两遍算法。前置阅读假设你已经看过 `06-gitgraph.md` 的数据流。

---

## 0. 一分钟结论

| 问题 | 答案 |
|---|---|
| **为什么不用 `git log --graph` 字符流** | 字符流把 lane 信息混在字符串里；前端想 SVG/Canvas 渲染必须再 parse 一次，且对中文 commit msg / RTL 支持差 |
| **为什么不用 vscode-git-graph 默认算法** | 实测在 master 旁支密集的仓库上 lane 撑到 35+（无回收），视觉极差；其 `vertex.nextX` 单调递增，merge 后 lane 不回收 |
| **为什么最终选 GitLens** | GitLens `columnsUsed` Set + `columnsToFreeWhenFound` Map **真正回收 column**，目标是「赛道计数视觉上 ~15 条」；且其 lane segment 模型天然支持 fork/merge stitch 转场线 |
| **为什么后端跑两遍算法** | GitLens GKC 算法无法兼顾「视觉 lane 紧凑」与「颜色按 claim 时的 lane 分配」（压缩会改 lane 编号而颜色已写入 segment）。采用双跑：visual pass 用 compressed（紧凑 lane），color pass 用 uncompressed（按 segment 首次 claim 时的 lane 取色） |
| **为什么连 vscode 视图也在用 GitLens 输出** | 整个项目就一个 graph 视图了（master 之前 vscode/gitea 并存），统一收口到 GitLens 输出 + vscode 前端渲染器（复用 SVG 路径算法） |
| **关键不变量** | 每行 row 0 一定有 commit（latest first 排序保证）；fork/merge stitch 都走 `LockedFirst` 转场线（GitLens 形态：先竖后斜或先斜后竖 ≤1 行高） |

---

## 1. 为什么需要两套算法：vscode vs GitLens 1:1 对照

我们在 v0.8.24 试过 vscode-git-graph 的算法，发现根因 — **`vertex.nextX` 单调递增永不回收**：

```text
// vscode 原版 TypeScript（web/graph.ts）
class Vertex {
  connections: Map<number, Connection> = new Map();
  nextX = 0;                            // ⚠️ 只增不减
  registerUnavailablePoint(x: number) {
    let y = x;
    while (this.connections.has(y)) y++;
    this.connections.set(y, ...);
    if (y === this.nextX) this.nextX++; // ⚠️ nextX++ 永远不回收
  }
}
```

后果：row 1 占 lane 0 → merge 后 lane 0 空了 → 但 nextX=1，row 2 仍被推到 lane 1 → 第二个 sibling 在 lane 2 → 第三个在 lane 3 —— **sidebar 宽度对压缩仓库呈现 ≈35 条 lane**（实测 gitea-kanban 自己），而 GitLens + GitKraken 桌面端只显示 ≈10-15 条。

GitLens 算法（`packages/plus/commit-graph/src/engine/`）的根本差异：

| 维度 | vscode-git-graph v1.30.0 | GitLens v18.2.0（我们 Go 端的 layout_gitlens.go） |
|---|---|---|
| **lane 数据结构** | `vertex.connections: Map<int, Connection>` + `nextX` 单调游标 | `state.columnsUsed: Set<int>`（行内已用集合）+ `state.columnsToFreeWhenFound: Map<SHA, int[]>`（merge 锚点显式释放） |
| **column 分配** | row by row 取 nextX++ | `state.claimNextColumn()` 从 `pinnedColumnCount` 起找最低空闲 |
| **column 释放** | **永不释放** | merge stitch 触发 `assignColumnForRow` 中 `toFree := columnsToFreeWhenFound[row.sha]` 然后 `compactLanes()` |
| **pinned lane** | 隐式（first-parent 自延续） | `assignPinnedColumns(headShas)` 显式锁定主干 lane |
| **reservation 机制** | 无（每个 vertex 自己决定） | `assignReserved(parent, info)` 显式预占下一行 lane，给 parent stitch 转场用 |
| **算法类型** | online（top-down 单次扫描） | offline（rows 先备好，row-by-row 处理） |

Go 移植代码位于 `app/git/graph/layout_gitlens.go`（896 行，含 60+ 个内部函数 / 5 个 export API）。

---

## 2. 数据流：从 `git log` 行到 SVG

```text
[Git Repo]
   │  go-git LogCommits (refs + commit objects)
   ▼
[app/git/log_vscode.go]
   │  toGitlensRows(commits) → 统一数据模型
   ▼
[app/git/graph/layout_gitlens.go]
   │
   ├─ BuildGraphGitlens(commits, head, pinnedHeadShas)
   │     1. assignPinnedColumns     ─→ 主干 head 显式锁定 lane
   │     2. gitlensAssignColumns(rows, pinned, compact=true)  ─→ 视觉 lane
   │     3. gitlensAssignColumns(rows, pinned, compact=false) ─→ 颜色 lane（取色语义）
   │     4. segmentToLines(seg)     ─→ fork / merge 转场线 (LockedFirst)
   │     5. DTO 转换（rows + edges + branches + pinned）→ Wails binding
   │
   ▼
[frontend/src/lib/gitgraph/vscode-render.ts]
   │  renderGraphVscode(graphData, options) → SVG string
   │  其中：renderBranchLines 把跨 lane 长线 pushSplit 成「斜切段 + 竖直段」
   ▼
[TimelineNewView.vue] 内嵌 <svg v-html="graphSvg" />
```

### 2.1 关键数据结构（layout_gitlens.go:25-95）

```go
type gitlensGraphRow struct {
    sha           string
    parents       []string  // 长度 1 = 普通，2+ = merge
    parentIndex   int       // 是该 row 第几个 parent（merge stitch 用）
    kind           gitlensCommitKind  // uncommitted / merge / head / branch
    date           int64    // committer date（cherry-pick 排序需要）
    row            int       // 行号
    column         int       // 本次算法分配（视觉 lane）
}

type gitlensReserverInfo struct {
    reservingColumn int
    parent          string
    parentIndex     int
}

type gitlensLaneSegment struct {
    column      int           // 起始 column
    commitShas  []string      // 段内所有 commit
    tipSha      string        // 末 commit = 段尾
    forkSha     string        // 收口点：本段从哪个 sha 分出来的（nil = 主干起首）
    mergeSha    string        // 收口点：本段汇到哪个 merge commit
}

type gitlensLayoutState struct {
    columnsUsed               map[int]bool                 // 行内已用列
    columnsToFreeWhenFound    map[string][]int              // merge 锚点：触发哪些列释放
    segmentByColumn           map[int]*gitlensSegmentBuilder
    finalizedSegments         []gitlensLaneSegment
    pinnedColumnCount         int
    nextFreeColumn            int
}
```

### 2.2 双跑：为啥要算两遍

```go
columns, segments, maxCol := gitlensAssignColumns(rows, pinned, true)   // compressed
colorCols, _, _        := gitlensAssignColumns(rows, pinned, false)     // uncompressed
```

**根因**:GitLens compact 模式（`compact=true`）在 `assignColumnForRow` 末尾会调 `compactLanes(freedLane)` 把右侧活跃 lane 左移——同一 SHA 在 compact 前后可能 lane 编号不同。但 segment 的颜色是按 segment **首次 claim column 时**的 column 绑定的（`colorColOf[seg.tipSha]` 在 segment 第一次写入时记录）。

| 现象 | compact=true | compact=false |
|---|---|---|
| lane 编号 | 视觉紧凑，连空隙都填 | 严格按 GitLens 原版 claim 顺序 |
| 用途 | 前端渲染 X 坐标 | segment 颜色（要按 claim 顺序才有意义的「链条色」） |
| 同 segment 内 commit X | 全部用紧凑 lane | 全部用未压缩 lane |
| 颜色 | 按未压缩 lane % 16 取 `VSCODE_COLORS` | 同 |

实测数据（用 gitea-kanban 自己 8 月份 commit 库，pinned=[f46d0d0]）：

```text
                       compact=true    compact=false    差
全图最大 lane 编号        8              14             +6（uncompressed 多 6）
前 12 行平均 lane 数      4.2            5.8            +1.6
视觉 lane 占用            ~50 px         ~80 px         -
```

**取舍**:性能成本 = 双跑 = `O(rows × maxColumn)` ×2。当前仓库（< 3000 commits）实测 < 80ms。如果未来 columns 数爆炸可以改成「segment 首次 claim 时记 color，全图渲染时按 compact 后 lane 找最近 segment claim」——单跑方案，但实现复杂度高。当前阶段不值得。

---

## 3. 核心算法逐函数

### 3.1 `assignPinnedColumns`（line 430-481）

```go
func assignPinnedColumns(rows []*gitlensGraphRow, pinnedHeadShas []string) map[string]int {
    pinned := make(map[string]int, len(pinnedHeadShas))
    for i, sha := range pinnedHeadShas {
        pinned[sha] = i  // base-first：trunk head = lane 0，第二 pinned = lane 1
    }
    return pinned
}
```

**关键约束**：pinned 必须按 `pinnedHeadShas` 顺序——base ref（main / master）放第一个，feature ref 放后面。

### 3.2 `gitlensAssignColumns`（line 482-520）

```go
func gitlensAssignColumns(rows []*gitlensGraphRow, pinnedHeadShas []string, compact bool) (
    map[string]int, []gitlensLaneSegment, int,
)
```

主循环：

```text
for each row in rows:
    col := assignColumnForRow(row)
    if col 已 pinned，跳过 claim
    记录 segment.commitShas
    segment.tipSha = row.sha
    if row.merge 触发第二 parent → 预占 reservation（下一行该列留给 stitch）
```

### 3.3 `assignColumnForRow`（line 248-401）— 核心 153 行

5 个分支按优先级：

| 优先级 | 条件 | 动作 |
|---|---|---|
| P0 | `columnsToFreeWhenFound[row.sha]` 有值（merge 锚点） | 先 release 再分配当前 column（防 reserve 重复） |
| P1 | `canReplaceReservation(rowKind, parents, parentSha)` — 当前 row 是 uncommitted 且有 reservation 在 | 复用 reservation column |
| P2 | first parent 在已 pinned set 中（包括自己） | 同 column + EdgeNormal |
| P3 | `pickParentColumn(parent, parentIdx, childCol)` — first parent（parentIdx=0） | 同 column（如 childCol 空闲）否则找次低 column |
| P4 | `pickParentColumn` — second+ parent (merge stitch) | **新 segment + reservation**：分配一个不在使用中的 column 给 stitch，pre-reserve 下一行此 column 给 merge commit |
| fallback | `claimNextColumn()` | 从 `pinnedColumnCount` 起找最低空 |

**关键 invariant**：每个 `parentIdx > 0` 的 merge stitch 都会：
1. 立即开一个新 segment（写 `seg.tipSha = segmentStart`）
2. 在下一行（merge commit 那一行）pre-reserve stitch 目标 column
3. 这一行（stitch 起始 commit）触发 `columnsToFreeWhenFound[mergeSha] = [stitchColumn]`

### 3.4 `segmentToLines`（line 556-682）— 形态 1:1 复刻 GitLens

输入：`gitlensLaneSegment`
输出：`[]GraphBranchLine{X1, Y1, X2, Y2, LockedFirst, IsCommitted}`

形态规则（GitLens 原版 vscode-render 渲染需要）：

| 线类型 | 形态 | LockedFirst | 颜色 |
|---|---|---|---|
| **同 lane 竖线** | (col, y) → (col, y+1) | true | segment 链色 |
| **fork stitch 跨 lane**（segment 起始 → fork 锚点） | (startCol, row) → (forkCol, forkRow)，**先斜 ≤1 行高 → 再竖直到 forkRow** | false（fork 线转场在 parent 行上方一个行高内） | segment 链色（child） |
| **merge stitch 跨 lane**（segment 末 → merge commit） | (tipCol, row) → (mergeCol, mergeRow)，**merge dot 下方立即斜切 → 再竖直到 mergeRow** | true（merge 线转场在上端） | merge parent 链色（被合入方） |
| **merge incoming line**（merge commit second+ parent 已在别 lane） | merge dot 斜切 → parent lane 竖直 → parent dot | true | parent 链色 |

**绕坑**：fork stitch 与 merge stitch 同段 segment 时需要按顺序生成；`segmentToLines` 先生成同 lane 竖线，再补 fork/merge 转场。

---

## 4. 渲染：vscode 前端为何能复用 GitLens 输出

`frontend/src/lib/gitgraph/vscode-render.ts:renderBranchLines` 函数（360-435 行）的关键能力：把任意 `(X1, Y1) → (X2, Y2)` 的路径拆成「斜切段（≤GRID_Y ≈ 24px）+ 竖直段」：

```ts
function renderBranchLines(lines: GraphBranchLine[], rowH: number): SvgPath[] {
  for (const line of lines) {
    if (Math.abs(line.y1 - line.y2) <= 1 * rowH) {
      // 跨 lane 但只跨 1 行高：纯斜线
      paths.push(simpleDiagonal(line));
    } else if (line.x1 === line.x2) {
      // 同 lane 竖线
      paths.push(verticalLine(line));
    } else {
      // 跨 lane 跨多行：pushSplit（LockedFirst 决定斜切位置）
      paths.push(...splitLockFirst(line, rowH));
    }
  }
}
```

这套前端代码原本是 vscode-git-graph `Branch.draw` 的 1:1 复刻 — **它对「输入路径」只要求一致的 `(x,y)` 像素坐标语义**。所以即使 lane 分配算法换了，只要 DTO (`GraphBranchLine`) 的语义一致，前端无须改。

### 4.1 为什么 fork/merge 必须先缝后竖（或反之）

GitLens 形态实测：斜线只占 1 行高（≈24px），必须先斜切到目标 lane 的 ±1 行附近，再竖直到目标 dot。**一整条对角线**斜到底的画法（v0.8.25.5 之前的 bug）看上去像「斜线穿过整个图」，视觉与实景不符，且与 GitLens `LockedFirst` 行为不符。

```ts
// splitLockFirst（vscode-render.ts:392-432）
function splitLockFirst(line: GraphBranchLine, rowH: number): SvgPath[] {
  const { x1, y1, x2, y2, lockedFirst } = line;
  const dy = y2 - y1;
  if (lockedFirst) {
    // 顶/底端锁住 y1，斜切 (y1, y1+rowH)
    return [
      diagonal(x1, y1, x2, y1 + Math.sign(dy) * rowH),
      vertical(x2, y1 + Math.sign(dy) * rowH, y2),
    ];
  } else {
    // 斜切在 (y2-rowH, y2)，竖直段在前
    return [
      vertical(x1, y1, y2 - Math.sign(dy) * rowH),
      diagonal(x1, y2 - Math.sign(dy) * rowH, x2, y2),
    ];
  }
}
```

---

## 5. 关键不变量与契约

### 5.1 数据契约

```go
type GraphResult struct {
    Commits    []GraphCommit  // 顺序：latest first（committer date desc, SHA tie-break）
    Branches   []GraphBranch  // 视觉渲染用
    Edges      []GraphEdge    // 数据流 fallback 用
    PinnedSHAs []string       // 主干 SHA 列表（渲染 lane 0 边框时用）
    MaxLane    int            // 视觉 lane 上限
    Truncated  bool           // 是否截断（commit 数 > 上限）
}
```

`Commits[i].Lane` = 双跑中 **compact=true** 的 lane（视觉坐标）。
`Branches[i].Lines[*].X1/X2/Y1/Y2` 全部基于 compact=true 视觉 lane。
merge edge 颜色从 `colorColOf[parent] % VSCODE_COLORS.length` 取（**parent 色，不是 child 色**）。

### 5.2 行为契约

1. **每行必有 commit**：latest-first 排序保证 row 0 = 最新，row N-1 = 最旧可见 commit；Commits 数组长度 = 行数。
2. **first-parent 链不打断**：如果 commit A 的 first parent B 在可见 commits 中，A 和 B 必须**相同 lane 或 B 的 lane 在 A 旁 ±1**（merge stitch）。
3. **fork stitch 端归属**：forkSha 行 = 「本 segment 从哪个 sha 分出来」的行，行号必须小于 seg.startRow。
4. **merge stitch 端归属**：mergeSha 行 = merge commit 行，行号必须大于 seg.tipRow。
5. **pinned head 必在 base-first 顺序**：`pinnedHeadShas[0]` = trunk head（保证 lane 0 = 主干）。

### 5.3 性能契约

| 数据规模 | 耗时（master laptop 实测） |
|---|---|
| 100 commits × 5 lanes | < 5ms |
| 500 commits × 10 lanes | < 25ms |
| 1000 commits × 15 lanes | < 60ms |
| 3000 commits × 20 lanes（截断上限） | < 150ms |
| 5000 commits（> 上限 → 截断） | < 80ms（truncated=true 早退） |

超过 5000 commits 时抛 `ErrTruncated`，前端展示「加载更多」按钮；状态栏同步进度条（go-git sideband → EventsEmit）。

---

## 6. AI 借鉴本算法的入手点

如果另一个 AI 想复用本项目的 Git Graph 算法（比如移植到 CLI / 其他前端），建议从这套入口起步：

| 步骤 | 文件 | 关键 API |
|---|---|---|
| 1. 取数据 | `app/git/log_vscode.go` | `LogCommits(ctx, repoPath, opts)` |
| 2. 转换数据 | `app/git/graph/layout_gitlens.go` | `toGitlensRows(commits)` |
| 3. lane 分配（双跑） | 同上 | `gitlensAssignColumns(rows, pinned, true/false)` |
| 4. segment → DTO | 同上 | `BuildGraphGitlens(commits, head, pinnedHeadShas)` |
| 5. 渲染 | `frontend/src/lib/gitgraph/vscode-render.ts` | `renderGraphVscode(graphData, options)` |

**最小可移植**:步骤 4（`BuildGraphGitlens`）+ 步骤 5（`renderGraphVscode`）就是端到端 —— JSON DTO 跨语言友好。`GraphResult` 类型已自动化进 Wails binding，写 IDL 等同 TypeScript interface。

### 6.1 别照抄的「坑」清单

复用时务必注意：

| 坑 | 我们是怎么踩的 | 怎么避免 |
|---|---|---|
| **排序键别用 AuthorDate** | v0.8.25.6 cherry-pick 行序错位（`b989f9f`） | 用 `committer date`，GitLens 也是这样做 |
| **first parent 不能被 merge parent 抢占 lane** | 早期 lane 错位 — v2.7 `layout.go` 修；v0.8.24 `layout_vscode.go` 修 | main chain 强制 lane=0；非 main vertex 最低 lane=1 |
| **merge edge 颜色必须是 parent 色** | v0.8.25.x 始终 child 色（边方向反） | merge 边 child→parent 方向 = parent 链色（被合入方色） |
| **pinned parent 汇入时不释放 lane** | v0.8.25.x segB 类 segment 不 finalize（line 290-310 的 `assignColumnForRow` else-if 修复） | 显式 `columnsToFreeWhenFound[parentSha]` 标记 |
| **不要做整段对角线** | v0.8.25.5 跨 lane 长线不 pushSplit | 形态参照 `renderBranchLines` 的 `splitLockFirst` |
| **lane 颜色与位置要双跑解耦** | compressed lane vs uncompressed color col | compact=true (visual) + compact=false (color) 二者必须解耦 |

### 6.2 推荐深读顺序

1. `frontend/src/lib/gitgraph/vscode-render.ts:30-100`（常量 + COLORS 注释 — 30 秒理解整个设计哲学）
2. `app/git/graph/layout_gitlens.go:1-100`（类型定义 — 看懂数据结构）
3. `app/git/graph/layout_gitlens.go:482-520`（`gitlensAssignColumns` 主循环 — 看懂数据流转）
4. `app/git/graph/layout_gitlens.go:248-401`（`assignColumnForRow` — 理解 5 分支调度）
5. `app/git/graph/layout_gitlens.go:556-682`（`segmentToLines` — 理解 stitch 形态生成）
6. `app/git/graph/layout_gitlens_test.go` + `..._e2e_test.go`（DAG 形态 + 行级像素对比测试）

---

## 7. 与 vscode-git-graph / GitLens 原版的对照表

| 维度 | vscode-git-graph v1.30.0 | GitLens v18.2.0 | 我们的 Go 移植（layout_gitlens.go） |
|---|---|---|---|
| 主入口 | `graph.ts:determinePath` | `engine/layout.ts:computeColumnsAndSegments` | `BuildGraphGitlens` |
| 数据结构 | `Vertex.nextX` 单调 | `columnsUsed Set` + `columnsToFreeWhenFound Map` | 同 GitLens |
| lane 分配 | 单调递增 | `claimNextColumn()` 找空 | 同 |
| column 释放 | 不释放 | merge 触发释放 | 同 + `compactLanes` 后处理 |
| segment 模型 | `Branch` 链表 + lines 数组 | `LaneSegment` + segment 链 | 同 |
| stitch | merge stitch + uncommitted | merge + fork stitch | merge + fork + merge-incoming |
| 主干锚定 | 无（隐式 first-parent） | `assignPinnedColumns` | 同（且 `HasPrimaryBranchRef` 复用 `layout.go`） |
| 算法类型 | online top-down | offline row-by-row | 同 GitLens |
| 跨语言对照 | TypeScript 原版 | TypeScript 原版 | Go 1:1 移植 + 实测对照 |
| 单位测试 | GitLens 自带 50+ 测 | 测试覆盖 8 类拓扑 | 我们写了 4 个测试文件（1400+ 行）覆盖：unit / DTO 转换 / e2e 行级对比 |

---

## 8. 相关 ADR / release note

| 文件 | 内容 |
|---|---|
| [../adr/0010-go-git-vs-git-cli.md](../adr/0010-go-git-vs-git-cli.md) | 写操作用 git CLI，读 DAG 用 go-git（GitLens 移植同理：纯 Go 读，无需 spawn） |
| [./gitgraph-engine-history.md](./gitgraph-engine-history.md) | 四阶段演进：字符流 → layout.go → vscode 1:1 复刻 → GitLens 移植 |
| [../releases/v0.8.24.md](../releases/v0.8.24.md) | vscode 原版幽灵 line bug 修复（为我们引入 GitLens 算法的入口） |
| [../releases/INDEX.md](../releases/INDEX.md) | v0.8.25 系列（本次 GitLens 移植全套 fix commit） |

---

## 9. 版本历史

| 版本 | 变更 | commit |
|---|---|---|
| v0.7.21 | 字符流 → `layout.go` 初步结构化 | — |
| v2.7 | `layout.go` 修 first-parent 不被 merge 抢占 | `aa3b599` 前身 |
| v0.8.24 | `layout_vscode.go` 修幽灵 line + 调研 GitLens | `aa3b599` |
| v0.8.25 | 引入 GitLens GKC 算法 Go 移植 | `5caa347` ~ `1bc9fbc` |
| v0.8.25.x | merge edge 颜色 / fork 漏 stitch / pinned 汇入不释放 等 5 bug 修 | `1acdfcb` ~ `64499be` |
| v0.8.26.x | lane 0/1/2 红绿冲突 → 玫红换草绿再换亮橙 | `1075a95` ~ `07f3fb6` |
