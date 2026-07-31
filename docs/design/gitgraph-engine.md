# GitGraph 布局算法：vscode-office 1:1 移植（v0.8.36 起）+ GitLens 历史对照

> **生效版本**：v0.8.36 起（master commit `98df580`）
> **历史版本**：v0.8.25 起（master commit `54d1850`）首次引入 GitLens GKC 算法
> **当前生效入口**：`BuildGraphOffice`（`app/git/graph/layout_office.go`）
> **历史 reference 入口**：`BuildGraphGitlens`（`app/git/graph/layout_gitlens.go`，v0.8.36 起保留为 dead code，便于回退）
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
| **为什么前端渲染器复用 vscode-git-graph 而不是自己写** | GitLens TS 原版的渲染层是 React 组件，不能直接复用；vscode-git-graph `Branch.draw` 1:1 复刻到 TS（`vscode-render.ts`）能输出稳定 SVG path；用同一套 DTO（X1/Y1/X2/Y2 像素坐标 + LockedFirst）算法可换渲染器不变 |
| **v0.8.26 入口统一后的 graph 包结构** | `types.go`（237 行共享 DTO）+ `layout_gitlens.go`（896 行主算法）+ 5 个测试文件 / dump 工具；`BuildGraphGitlens` 是唯一公开入口，layout.go / layout_vscode.go 与 pickGraphBuilder env 开关全删 |
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
   │     2. gitlensAssignColumns(rows, pinned)  ─→ 唯一 lane（位置 + 颜色）
   │     3. segmentToLines(seg)     ─→ fork / merge 转场线 (LockedFirst)
   │     4. DTO 转换（rows + edges + branches + pinned）→ Wails binding
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

### 2.2 单跑：v0.8.33 取消双跑，对齐 GitLens 原版 lane 分配

```go
columns, segments, maxCol := gitlensAssignColumns(rows, pinned)   // 唯一一次：位置 = 颜色
```

**v0.8.33 决策**：实测 DeepSeek-Reasonix 301 commits 与 GitLens commit-graph 截图对比，发现 v0.8.25.7 引入的「lane 左移压缩」与 GitLens 原版算法不符——GitLens 真实行为：

- lane 释放后**只**从 `columnsUsed` 集合中移除空 column
- **不动**现有 reservation/segment 的 column
- 后续 commit 走 `claimNextColumn()` 复用**最低空** column

v0.8.25.7 的 compact 模式（`compact=true`）错误地假设 GitLens 在 lane 释放后会做"立即填坑"——右侧所有 reservation/segment 整体左移一格。DeepSeek-Reasonix 301 commits 实测显示该假设导致长分支链被挤到左侧少数 lane、右侧 lane 几乎全空，与 GitLens 截图不一致。

v0.8.25.7 同窗口期引入的"位置用压缩 lane + 颜色用未压缩逻辑 lane"双轨也随之证伪——既然压缩本身是错的，颜色的"未压缩逻辑 lane"概念就没有意义。位置和颜色现在用同一套 lane 分配（`colOf[c.SHA] % 16`）。

| 指标 | v0.8.25.7 双跑 | v0.8.33 单跑 |
|---|---|---|
| BuildGraphGitlens 主跑次数 | 2 次（compact + non-compact） | 1 次 |
| Color 字段语义 | 未压缩逻辑 lane（与位置不同） | 位置 lane（Color == Lane%16） |
| Lane 编号稳定性 | lane 释放后右侧整体左移 | lane 释放后保留空位，由后续 commit 复用 |
| Long branch chain 渲染 | 跨 lane 斜线（被挤到左侧） | 稳定 lane 竖线（保留原 lane） |
| DeepSeek-Reasonix maxLane | 14（巧合） | 14 |
| DeepSeek-Reasonix lane 1 commits | 115 | 128（释放 lane 被后续 commit 复用） |
| DeepSeek-Reasonix lane 7 commits | 26 | 2（长分支链不再被压到 lane 7） |
| DeepSeek-Reasonix lane 9 commits | 4 | 28（长分支链回到原 lane） |

**取舍**：取消双跑后 `Color == Lane%16`（v0.8.25.7 之前就是这样），v0.8.25.7 的"位置与颜色分离"特殊视觉效果（"b2139fe 视觉在 lane 2、颜色 lane 1"那种矛盾情况）消失。`segmentsToBranches` 内部仍接受 `colorColOf` 参数（但调用方传 `colOf`，行为等价），保留函数签名减少 diff 噪音。

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

`Commits[i].Lane` = 唯一一次 `gitlensAssignColumns` 产出的 lane（位置 = 颜色）。
`Branches[i].Lines[*].X1/X2/Y1/Y2` 全部基于此 lane。
merge edge 颜色从 `colOf[parent] % VSCODE_COLORS.length` 取（**parent 色，不是 child 色**）。

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
| v0.8.36 | **算法对标从 vscode-gitlens 切到 vscode-office**：`BuildGraphOffice` 1:1 移植 `layoutEngine.ts` Branch/Vertex/Line 范式，`BuildGraphGitlens` 降级为 dead code 保留 | `98df580` |
| v0.8.37 | **前端 UI 复刻 vscode-office 视觉**：去掉 shadow 双层 + GRID_Y 28→24 + offsetX 16→8 + HEAD dot 4→6 + stash 双圈 + 保留手风琴。`BuildGraphOffice` + 9 office 测试 + 17 gitlens 老测试 + 4 dump 工具 = 30 测试全 PASS | `dd19295` |
| v0.8.38（计划） | 清理 `layout_gitlens.go` 871 行 dead code（用户确认后） | — |

---

## 10. v0.8.36 算法对标切换：vscode-gitlens → vscode-office

### 10.1 用户原意

CLAUDE.md 长期记录 v0.8.25~v0.8.35 一直在对标 `vscode-gitlens`（`packages/plus/commit-graph/src/engine/layout.ts` GKC 算法）。但用户的真实对标意愿是 `vscode-office`（`src/react/view/gitHistory/graph/layoutEngine.ts` 455 行 Branch/Vertex/Line 范式）—— 之前的 gitgraph-engine.md 文档与现实工作目标不一致。v0.8.36 做算法对标切换（`98df580`），前置章节 §1-9 保留为「GitLens 移植历史 reference」，本节是当前生效算法的入口。

### 10.2 范式对比

| 维度 | vscode-gitlens（v0.8.25-v0.8.35） | vscode-office（v0.8.36 起） |
|---|---|---|
| **lane 数据结构** | `state.columnsUsed: Set<int>` + `state.columnsToFreeWhenFound: Map<SHA, int[]>` | `vertex.connections: Map<int, Connection>` + `vertex.nextX` 单调游标 |
| **column 分配** | `state.claimNextColumn()` 从 `pinnedColumnCount` 起找最低空闲 | `vertex.getNextPoint()` 沿用 office 简单 `nextX++` 累加 |
| **颜色回收** | `availableColours[i] > startAt` 简单判断 | `branch.end` 设定后 + new branch 重新 `getAvailableColour()` 复用 |
| **merge stitch** | `visitPath` 状态机 + `mergeSha` 锚点 | `determinePath` 沿 column 找 `getPointConnectingTo` 命中点斜切 |
| **代码规模** | 871 行 Go（layout_gitlens.go） | 479 行 Go（layout_office.go）/ 455 行 TS（layoutEngine.ts） |
| **范式归类** | GitLens 桌面端的 reference graph 风格 | vscode-git-graph v1.30.0 原版（layoutEngine.ts 注释反复写 `graph.ts:50-60` 等行号对齐） |

vscode-office 跟 vscode-git-graph v1.30.0 原版几乎一致，跟 vscode-gitlens 范式有本质差异。**两者不是同一类算法** —— 切对标仓库是切换实现范式，不是同范式下换个 implementation。

### 10.3 vscode-office 核心算法

**三件类**（`app/git/graph/layout_office.go`）：

- `officeVertex`（对齐 `Vertex` class）：id + isStash + x + children + parents + nextParent + onBranch + isCommitted + isCurrent + nextX + connections[]
- `officeBranch`（对齐 `Branch` class）：colour + lines[] + end + numUncommitted
- `officeGraphEngine`（对齐 `GraphEngine` class）：vertices[] + branches[] + availableColours[] + onCurrentBranch[]

**三件算法**（`layoutEngine.ts:267-432` 1:1 复刻）：

- `compute(commits, commitHead, config, ...)`：主入口，建图 + 跑主循环 + 出 `maxX`
- `determinePath(startAt)`：两分支——
  - **merge stitch**（line 373-393）：merge vertex 已挂 branch 且 parent 也挂 branch 时，沿 column 找 `getPointConnectingTo` 命中点斜切
  - **new branch**（line 394-422）：开新 Branch + 沿 parent 走到底
- `getAvailableColour(startAt)`：回收 `availableColours[i] < startAt` 的颜色槽位

**主循环**（layoutEngine.ts:331-338 1:1 复刻）：

```go
for i := 0; i < len(vertices); {
    if vertices[i].getNextParent() != nil || vertices[i].isNotOnBranch() {
        // 死循环保护：Go 版特有，TS 原版主循环假设 commit 时序倒序
        // 乱序输入下 vertex 不会消费 nextParent 也未挂 branch → 主循环死循环
        // Go 没有 TS 栈溢出兜底，必须显式判定进度
        prevNextParent := vertices[i].getNextParent()
        prevOnBranch := vertices[i].getBranch()
        e.determinePath(i)
        advanced := vertices[i].getNextParent() != prevNextParent ||
            vertices[i].getBranch() != prevOnBranch
        if !advanced {
            i++ // 跳过这个 vertex（office 原版假设下不会触发；保护用）
        }
    } else {
        i++
    }
}
```

### 10.4 DTO 转换层（同文件内）

跟 `BuildGraphGitlens` 一样输出 `GraphResult`：

- `Nodes[i].Lane = officeVertex.x`，`Color = Lane % 16`（对齐 Gitea Color16 + 现有 gitlens 路由）
- `Edges[i].Color` 跟 gitlens 现行一致（merge 边用 parent 色），`Type = EdgeNormal/Branch/Merge` 由 lane 差决定
- `Branches[i].Lines[i].IsCommitted = (lineIndex >= numUncommitted)`（office `Branch.addLine` 维护规则 line 89-93）
- `MaxLane = max(vertex.x)`，`MaxColor = 16`，`Truncated` 透传

### 10.5 关键不变量（vscode-office 视角）

跟 §5.1 既有 GitLens 不变量**都等价**（同一 DTO 协议），但 root cause 不一样：

- **每行必有 commit**：跟 gitlens 一样，靠 `git.Log` 倒序保证
- **first-parent 链不打断**：office 走 `vertex.nextX` 单调（不释放），gitlens 走 `claimNextColumn` 复用最低空位 —— **前者偏左对齐（新 branch 立即占最低空位），后者偏右平均分配（pinned trunk 占定 lane 0 后剩下的按出现顺序分配）**
- **merge edge 颜色 = parent 色**：跟 gitlens 修过的 v0.8.26.x fix 一致
- **pinned head 兼容**：office 主算法只用 `commits[0].SHA` 当 head，但 `pinnedHeadShas` 入参保留以便 adapter 一键切换

### 10.6 已知风险（v0.8.36 实测）

1. **深历史仓库 lane 分布差异**：office 走 `vertex.nextX` 单调游标，gitlens 走 `columnsUsed` Set 真正回收。深历史仓库（>300 commit 旁支密集）实测会有 lane 差异——office 偏左（左对齐新 branch），gitlens 偏右平均分配。需要用户真仓库验证是否符合预期。
2. **color 维度**：office 走 `branch.getColour() % 16`（branch end 后的颜色回收），gitlens 走 `colOf[sha] % 16`（SHA → column 映射）。两条路径在常见 DAG 上等价，但极端拓扑（如 16+ 同时活着的 branch）会有细微差异。
3. **乱序输入死循环保护**：实测真实 git log 倒序不会触发。但子代理测试中构造乱序 fixture 时发现 office 主循环潜在死循环——已加 `prevNextParent` / `prevOnBranch` 进度判定兜底。

### 10.7 不要做的事

- **不要**修改 `layout_gitlens.go` 任何一行（已 v0.8.36 标记为 dead code，便于回退）
- **不要**修改 `types.go` 任何一行（DTO `GraphResult` / `GraphBranch` / `GraphBranchLine` 是 gitlens/office 双算法共用契约）
- **不要**在前端 UI 改动时**顺手**调 office 后端算法（v0.8.37 独立任务）
- **不要**把「v0.8.25-v0.8.35 GitLens 移植」细节从 §1-9 删除（保留为历史 reference，便于未来 AI/工程师理解双算法演进）

### 10.8 后续 commit 计划

| 版本 | 任务 | 范围 |
|---|---|---|
| v0.8.37 | ~~前端 UI 复刻 vscode-office 视觉~~ ✅ 已完成（commit `dd19295`） | 详见 [§11](#11-vscode-office-对标重新检查-audit-报告-v0837) |
| v0.8.38 | 清理 `layout_gitlens.go` 871 行 dead code | 用户确认后删 |

详细 release note 见 [../releases/v0.8.36.md](../releases/v0.8.36.md) + [../releases/v0.8.37.md](../releases/v0.8.37.md)。

---

## 11. vscode-office 对标重新检查 audit 报告（v0.8.37）

### 11.1 算法层（`layoutEngine.ts` 1:1 复刻）

| vscode-office 关键算法 | gitea-kanban 实现 | 对标状态 |
|---|---|---|
| `Branch` class（lines + colour + end + numUncommitted） | `officeBranch` struct（line 80-193） | ✅ 1:1 字段对齐 |
| `Vertex` class（id + x + onBranch + nextX + connections） | `officeVertex` struct（line 195-265） | ✅ 1:1 字段对齐 |
| `GraphEngine.compute`（line 273-365） | `officeGraphEngine.compute`（layout_office.go:228-244） | ✅ 1:1 主循环 |
| `determinePath` merge stitch（line 373-393） | layout_office.go:265-290 | ✅ 1:1 沿 column 找命中点 |
| `determinePath` new branch（line 394-422） | layout_office.go:291-331 | ✅ 1:1 + 死循环保护 |
| `getAvailableColour` 颜色回收 | layout_office.go:338-345 | ✅ 1:1 |
| `Vertex.registerUnavailablePoint` nextX++ | layout_office.go 字段 | ✅ 1:1 |
| `Branch.addLine` numUncommitted 维护 | layout_office.go addLine | ✅ 1:1 |

### 11.2 SVG 渲染（`GraphSvg.tsx` 视觉对齐）

| vscode-office 渲染行为 | gitea-kanban 实现 | 对标状态 |
|---|---|---|
| 普通 dot r=4 | `c.r = 4`（非 HEAD） | ✅ |
| HEAD dot r=6 + stroke-width=2.5 | `c.r = 6` + `c.strokeWidth = 2.5` | ✅ |
| 普通 dot 无 stroke（实色填充） | `stroke="rgba(30, 30, 30, 0.75)"` 微描边 | ⚠️ 微差异（深色背景下看不到，普通背景下提升可见性） |
| HEAD dot fill=bg + stroke=lane 色 | `fill="transparent"` + stroke=色 | ✅ 视觉等价 |
| Stash 外圈 r=5 stroke-only + 内圈 r=4 | v0.8.37 双圈实现 | ✅ |
| Path 单一 stroke-width=2（无 shadow 双层） | v0.8.37 去 shadow 双层 | ✅ |
| UNCOMMITTED 段 color=灰色 + dasharray | `isCommitted=false` 走 `#808080` + `2px` | ⚠️ `4 2` vs `2px` 微差异 |
| dimmed 灰化（class） | `flow-group--dimmed` class | ✅ 视觉等价 |

### 11.3 几何参数（`gitHistory.css:47-50` `DEFAULT_GRAPH_GRID`）

| 参数 | vscode-office | gitea-kanban v0.8.37 | 对标状态 |
|---|---|---|---|
| `grid.x` | 16 | `VSCODE_GRID_X = 16` | ✅ |
| `grid.y` | 24 | `VSCODE_GRID_Y = 24` | ✅ |
| `offsetX` | 8 | `VSCODE_OFFSET_X = 8` | ✅ |
| `offsetY` | 12 | `VSCODE_OFFSET_Y = 12` | ✅ |
| HEAD dot stroke-width | 2.5 | `c.strokeWidth = 2.5` | ✅ |
| 普通 dot stroke-width | 0（无） | `c.strokeWidth = 1` | ⚠️ 微差异 |

### 11.4 row 视觉（`CommitTable.tsx` 4 列 layout）

| vscode-office 行为 | gitea-kanban 实现 | 对标状态 |
|---|---|---|
| 4 列 flex：desc / date / author / hash | 5 列 grid：graph（占位）/ desc / date / author / hash | ⚠️ 多 1 列 graph 占位让 SVG 透出，前端需求 |
| `display: flex` 容器 | `display: grid` + `grid-template-columns` | ⚠️ 容器布局不同（gitea-kanban 用 grid 让 5 列对齐） |
| 行高 24px（`rowHeight` 注入 style） | `ROW_H + 'px'` 注入 `--git-graph-row-height` | ✅ 等价 |
| ref badge 走 `--git-graph-color` CSS var | 走 `var(--row-lane-color)` | ✅ 等价（绑定到 row） |
| 行不内联手风琴（vscode-office 走 popup） | 内联手风琴（`expandedSha` + `activeExpandY`） | ✅ 保留（用户拍板要求） |
| `commit-head-dot` 单独组件展示 pin | 不展示（HEAD 由 dot 自身 r=6 标识） | ⚠️ 视觉差异（gitea-kanban 省略 HEAD pin 标签） |

### 11.5 总体对标完成度

- **算法层**：100% 1:1 复刻（BuildGraphOffice 479 行 = layoutEngine.ts 455 行 + 跨语言转换层）
- **几何层**：100% 对齐（DEFAULT_GRAPH_GRID 4 个参数全部 1:1）
- **dot 视觉**：95% 对齐（dot 默认 stroke 是 office 原文没有的微优化）
- **path 渲染**：100% 对齐（去掉 shadow 双层 + stroke-width=2）
- **row 布局**：85% 对齐（列结构 / 容器布局 / HEAD pin 标签 3 项微差异）

### 11.6 已知未对齐差异（用户拍板保留）

1. **内联手风琴 vs 走 popup**：vscode-office 走 `CommitDetailPopup.tsx` 弹窗，gitea-kanban 走 inline 展开面板（用户拍板保留手风琴交互体验）
2. **5 列 vs 4 列**：gitea-kanban 多 1 列 graph 占位列（让 SVG dot 精确对齐每行 row 中心，需要 grid 布局）
3. **CSS var 命名**：office 用 `--git-graph-color`，gitea-kanban 用 `--row-lane-color`（绑定到 row 而非全局）
4. **dot 默认 stroke**：office 普通 dot 无 stroke（依赖 bg 透明度），gitea-kanban 加 `rgba(30, 30, 30, 0.75)` 微描边（深色背景隐约可见，浅色背景提升可读性）
5. **dasharray 数值**：office 用 `'4 2'`（dash 4px gap 2px），gitea-kanban 用 `'2px'`（CSS 缩写，浏览器默认 dash:gap 1:1）。视觉接近

### 11.7 验证

```bash
cd ~/2026/code/gitea-kanban
go test ./app/git/graph/...   # 30 测试 PASS（v0.8.36 + v0.8.37 持续）
frontend $ pnpm typecheck      # 干净
frontend $ pnpm vitest run     # 62/62 PASS（v0.8.37 把 10 个失败 hardcode 测试修好）
```

### 11.8 后续可优化项（v0.8.38+）

- v0.8.38：清理 `layout_gitlens.go` 871 行 dead code（用户确认后）
- v0.8.39（可选）：把 dot 默认 stroke 改 office 风格（去掉微描边）
- v0.8.40（可选）：dasharray 改 `'4 2'`
- v0.8.41（可选）：把 graph 占位列合并到 desc 列（4 列 vs 5 列简化）
