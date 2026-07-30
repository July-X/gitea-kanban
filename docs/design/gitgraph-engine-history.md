# GitGraph 引擎历程：四阶段演进 + 5 个具体 bug 修复

> **本文件是 GitGraph 引擎演进的事实时间线**，按 commit 倒序记录每个版本的根因 + 修复策略 + 回归测试。
> **配套设计文档**：[./gitgraph-engine.md](./gitgraph-engine.md)（当前生效算法的「为什么这样做」+ AI 借鉴指南）
> **前置了解**：[./06-gitgraph.md](./06-gitgraph.md)（数据流高层设计）

---

## 时间线一览

```text
v0.7.21  v1.x 字符流 → ──────→ layout.go 结构化 ──────→ vscode 1:1 复刻 ──→ GitLens GKC 移植
                                                                                  ↓
                                        ┌──────────────────── GitLens 算法 ─────────────────┐
                                        │  5 bug fix (v0.8.25.x) ＋ lane 配色优化         │
                                        ↓                                                  ↓
                                            gitgraph-engine.md（当前实现）       Releases v0.8.25 系列
```

---

## 阶段 1 — 字符流时代（v0.7.21 之前）

**实现**：`git log --graph` 把 lane 信息塞进文本字符（`*` `|` `/` `\` 等），前端再 parse。

**坑**：

- 中文 commit 消息宽度变化导致 lane 对齐错位
- RTL 语言 display order 与 git log 输出顺序相反
- 多分支 col width 与 commit message width 耦合，前端 SVG 渲染需二次重排
- 24 色色彩信息完全丢失（字符流不带颜色）

**结论**：所有 commit 都得自己写 lane 分配算法 — 字符流只能当输入。

---

## 阶段 2 — `layout.go` 结构化（v2.7 拍板）

**实现**：`app/git/graph/layout.go:BuildGraph`（~720 行 Go 代码）。

**核心算法**：
- 排序键：AuthorDate（`v0.8.25.6` 改成 committer date）
- lane 分配：`findFreeLane(minLane=1)` 集中调度 → main chain commit 强制 lane 0
- 边模型：`GraphEdge{FromRow, ToRow, FromLane, ToLane, Color}` 4 元组

**第一个 bug 修复（v2.7）**：first-parent 链 commit 被 merge-parent 抢占 lane。

```text
DAG:
  master → A → B → C   (first-parent chain)
              ↘ from feature

bug 前:
  C → lane 0
  B → lane 0
  A → lane 2（B 已 merge 上来了）

bug 后（main chain 强制 lane 0）:
  C → lane 0
  B → lane 0
  A → lane 0      ← main chain 永远在 lane 0
```

**新增测试**：`TestBuildGraph_FirstParentNotOverwriteMergeParent` + `TestBuildGraph_TruncatedSegmentMainStaysLane0`。

**剩余问题**：lane 膨胀。仓库旁支多时 lane 数仍达 ~25，视觉不紧凑。

---

## 阶段 3 — vscode-git-graph v1.30.0 1:1 复刻（v0.8.24 入口）

**动机**：v2.7 layout.go lane 太宽，期望 vscode-git-graph 那种 ~15 lane 紧凑效果。

**实现**：`app/git/graph/layout_vscode.go`（~700 行）1:1 移植 vscode `web/graph.ts:determinePath` + `Branch.draw`。

### v0.8.24 bug — 幽灵 line + lane 错位

**User 截图**：`docs/releases/v0.8.24.md` 有详细对比表。

```text
现象：
  lane 0（蓝色 master） 中段 49 行穿透"幽灵 line"（沿线无 dot）
  main chain 30+ commit 散落在 lane 2/3/4/5/6 边缘
```

**根因排查（v0.8.24 release note 完整记录）**：

| 步骤 | 发现 |
|---|---|
| 1. 1:1 对照 TS 原版与 Go 复刻 | 算法完全等价（变量名 + 流程） |
| 2. 在 Python 里 1:1 复刻 TS 算法跑同一 DAG | **TS 原版也有同样幽灵 line + lane 错位** |
| 3. 定位根因 | `vertex.nextX` 单调递增；merge stitch 大循环把 first-parent vertex 的 nextX 推到 2+，但 merge stitch 在 lane 0 已画了 line → 幽灵 line |

**修复**：复用 `layout.go` 的 main chain 锚定策略，给 `layout_vscode.go` 加上同样机制。

| 文件 | 修改 |
|---|---|
| `app/git/graph/layout_vscode.go:191-199` | 新增 `mainChain map[string]bool` 字段 |
| `app/git/graph/layout_vscode.go:305-323` | `determinePath` normal 分支：main chain vertex 强制 `cp.x=0`；非 main 在 `cp.x=0` 时强制 `cp.x=1` |
| `app/git/graph/layout_vscode.go:268-275` | merge stitch 分支同上 |
| `app/git/v0824_main_chain_test.go` | 新增 `TestBuildGraphVscode_MainChainLaneZero` 构造 M0/M1..M50/F1/F0 DAG 钉住 |

**commit**：`aa3b599`（v0.8.24 release note 完整记录）。

### v0.8.24 没解决的：lane 数

| 仓库 | vscode 原版 lane 数 | 主链干净度 |
|---|---|---|
| gitea-kanban 8 月真实数据 | ~35 lane | ✅（v0.8.24 后） |
| 用户期望 | ~15 lane | —— |

**v0.8.24 后尝试**：`compactLanesForBuildResult` post-process pass。**结论**：只能压掉 merge stitch 穿过的 ghost lane，**无法**压缩 sibling branch 间已被 `vertex.nextX` 推到 10/12/14/16 的 raw 值。**回滚**。

### v0.8.24 → v0.8.25 决策

| 方案 | 工作量 | 评估 |
|---|---|---|
| A. 替换为 GitLens 算法 | 4-6h | 离开 vscode 1:1 复刻；lane 数大幅收敛（~35 → ~15） |
| B. 重构 vertex.nextX 为 Set | 2-3h | 保留 vscode 骨架；部分收敛 |
| C. 保留现状（v0.8.24） | 0h | 不收敛但主链干净 |

**拍板**：方案 A — 移植 GitLens 算法。

---

## 阶段 4 — GitLens GKC 算法 Go 移植（v0.8.25 - v0.8.25.x）

**入口 commit**：`5caa347` feat: 默认切换到 GitLens GKC 算法布局

**实现**：`app/git/graph/layout_gitlens.go`（896 行新增）。Go 移植官方 `vscode-gitlens/packages/plus/commit-graph/src/engine/layout.ts` + `edges.ts`。

**关键数据结构移植**：

| GitLens TS | Go 移植 |
|---|---|
| `columnsUsed: Set<number>` | `map[int]bool` |
| `columnsToFreeWhenFound: Map<SHA, number[]>` | `map[string][]int` |
| `segmentByColumn: Map<number, LaneSegmentBuilder>` | `map[int]*gitlensSegmentBuilder` |
| `finalizedSegments: LaneSegment[]` | `[]gitlensLaneSegment` |
| `pinnedColumnCount: number` | `int` |
| `nextFreeColumn: () => number` | `func claimNextColumn()` |

### 双跑决策（v0.8.25 中段）

**问题**：GitLens compact 模式在 `assignColumnForRow` 末尾会调 `compactLanes` 把右侧活跃 lane 左移。但颜色是按 segment **首次 claim column 时**绑定的。

```go
// 第一遍：视觉 lane（紧凑）
columns, segments, maxCol := gitlensAssignColumns(rows, pinned, compact=true)

// 第二遍：颜色 lane（按 claim 顺序 —— 给 segment 取色用）
colorCols, _, _ := gitlensAssignColumns(rows, pinned, compact=false)

// 渲染：positions 走 columns，颜色按 colorCols % 16 取
for _, row := range commits {
    row.lane = columns[sha]
    row.color = colorCols[sha] % len(VSCODE_COLORS)
}
```

实测（v0.8.25 release 调研）：压缩能给 lane 编号从 14 → 8，但**同 segment 内 commit 在两个 pass 的 lane 不一致**，所以二解耦。

---

## 阶段 5 — v0.8.25.x 5 个具体 bug 修

下面 5 个 bug 是 GitLens 移植过程中暴露的（TS 原版也无，但 GitLens 测试用例没覆盖到位）。

### Bug #1 — 单 commit lane 不画线（`b2139fe` 幽灵 commit）

**commit**：`1bc9fbc` fix: GitLens 单 commit lane 不画线 + branch-off 跨 lane 转场线缺失

**现象**：孤立 commit `b2139fe` 在画面上完全消失（无 dot）。

**根因**：`segmentToLines` 第一行有 `< 2` 早退。

```go
// 旧
if len(seg.commitShas) < 2 {
    return nil
}

// 新
if seg.mergeSha != "" {
    // 单 commit segment 但有 merge stitch 仍要画
}
return nil
```

**回归测试**：`TestBuildGraphGitlens_SingleCommitSegmentWithMergeStitch`。

### Bug #2 — `e9ed576` GitLens fresh claim 路径不记录 branchSha

**现象**：新创建的 segment（无 parent）的 `branchSha` 字段为空，导致 segment 模型不知道自己的「起点」。

```go
// 旧：new segment 时 branchSha 没赋值
seg := &gitlensLaneSegment{column: col}

// 新：claim 时记录到 state.segmentsByCommit[firstSha] 做反向索引
seg.branchSha = row.parents[0]  // 第一行 segment 的 fork 起点
```

**commit**：`e9ed576`（同 bug 列表）

### Bug #3 — DTO 转换层 4 个 bug + segment 漏加

**commit**：`1acdfcb` fix: GitLens DTO 转换层 4 个 bug + 1 个算法层 segment 漏加 bug

**修复明细**：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 3.1 | merge stitch 偶现漏画 | branchType 判定时把 `crossBranch` 误归类成 `Local` | 严格按 segment.mergeSha 字段判断 |
| 3.2 | uncommitted row 不画连接线 | DTO uncommitted 字段被吞 | 显式 round-trip |
| 3.3 | 行高计算 zoomLevel 失效 | 转换时丢失 layout rows 数 | 用 `result.maxLane + 1` 作分母 |
| 3.4 | pinned lane indicator 颜色错 | 取色用 baseCol 而不是 userCol | 区分 colorFor render vs colorFor label |

### Bug #4 — Uncommitted 与 HEAD 同 lane 渲染（`b86a0fd`）

**commit**：`b86a0fd` fix: Uncommitted 与 HEAD 同 lane 渲染，修 lane 泄漏导致的图错乱

**现象**：工作区 uncommitted file（node `*` 占据 row 0）后，HEAD 在 lane 1，原本应在 lane 1 的子节点 commit 出现在 lane 0 与 lane 1 之间插入「lane 0.5」（视觉上撞主线）。

**根因**：`assignColumnForRow` 没有把 uncommitted row 当作「pinned/uncommitted」特殊处理，导致其 lane 在下一 row 被 first-parent 接力占用。

**修复**：
```go
if row.kind == "uncommitted" {
    return s.uncommittedColumn  // 固定 lane，不参与接力
}
```

### Bug #5 — DAG 排序从 author date 改为 committer date（`b989f9f`）

**commit**：`b989f9f` fix: DAG 排序从 author date 改为 committer date，修 cherry-pick commit 行序错位

**现象**：cherry-pick 操作链的 commit 行序错位。

**根因**：cherry-pick 保留**原始 author date**（不是 cherry-pick 操作时间），author date 排序时这些 commit 会沉到底。但 committer date 是 cherry-pick 操作时间，保留正确时间序。

```go
// 旧
sort.SliceStable(rows, func(i, j int) bool {
    return rows[i].authorWhen.After(rows[j].authorWhen)
})

// 新
sort.SliceStable(rows, func(i, j int) bool {
    return rows[i].committerWhen.After(rows[j].committerWhen)
})
```

---

## 阶段 6 — lane 左移压缩（`24368ab`）

**commit**：`24368ab` feat: Git Graph lane 左移压缩对齐 GitLens 实测布局

**改进**：在双跑前增加 `compactLanes` 一遍，确保 lane 0/1/2 优先填满，左侧的视觉间距统一。

---

## 阶段 7 — v0.8.25.x 后段：fork / merge 连线修复（`64499be`）

**commit**：`64499be` fix: Git Graph 补 fork 汇入线与 merge 合入线，连线形态 1:1 复刻 GitLens

这是 `gitgraph-engine.md` 主要描述的修复（**最关键一轮**）：

### 7.1 fork 汇入线整段缺失（v0.8.25.x 中段尚未生成）

**根因**：`segmentToLines` 不处理 `seg.forkSha`，所有「分支汇回主线」斜插线没生成 — 分支 lane 看起来无限延伸。

**修复**：
```go
// segmentToLines: 末尾新增 fork stitch
if seg.forkSha != "" {
    forkRow := rowOf[seg.forkSha]
    lines = append(lines, GraphBranchLine{
        X1: lastCol, Y1: lastRow,
        X2: forkCol, Y2: forkRow,
        LockedFirst: false,  // fork 线转场在下端
    })
}
```

### 7.2 pinned parent 汇入不触发 lane 释放

**根因**：尾端 first parent 是 pinned commit 且无 reservation 时，segment 永不 finalize，连 fork 数据都没有。

**修复**（`assignColumnForRow` else-if 分支）：
```go
} else if !hasParentRes {
    if row.parents[parentIdx] == headSha {  // pinned parent
        s.columnsToFreeWhenFound[row.parents[parentIdx]] = []int{column}
    }
    column = -1
}
```

### 7.3 merge 合入线丢失（`1348ba6 → cfcf339`）

**根因**：second parent 已在主线时，`branches` 里这条边完全不存在。

**修复**：补充「merge incoming line」生成（补 branch 数组 + 单线 graphBranch）：
```go
for i, c := range commits {
    if len(c.Parents) < 2 { continue }
    for _, parentSha := range c.Parents[1:] {
        // 已有 stitch 跳过；否则补单线 branch
        branches = append(branches, GraphBranch{
            Color: colorColOf[parentSha] % 16,
            Lines: []GraphBranchLine{{
                X1: colOf[c.SHA], Y1: i,
                X2: colOf[parentSha], Y2: rowOf[parentSha],
                LockedFirst: true,  // 转场在上端
            }},
        })
    }
}
```

### 7.4 merge 边颜色反了

**修复**：merge 边 child→parent 方向 = parent 链色（被合入方），不再恒为 child 色。

### 7.5 跨 lane 长线不 pushSplit

**修复**：`vscode-render.ts:renderBranchLines` 加 `splitLockFirst` 处理（按 LockedFirst 决定斜切段位置）。

### 7.6 验证

| 命令 | 结果 |
|---|---|
| `go test ./app/...` | 全绿（含 4 个新增 layout_gitlens 测试文件） |
| `go vet ./...` | 无 error |
| `go build -o /dev/null .` | OK |
| `cd frontend && pnpm vitest run src/lib/gitgraph` | 21 测试全过 |
| `pnpm typecheck` | 干净 |
| `pnpm build` | OK |

真实 TRex 仓库数据端到端：BuildGraphGitlens dump 的 17 条边与 GitLens 实测逐条对应；SVG 渲染截图逐行像素扫描一致。

---

## 阶段 8 — 配色优化（`1075a95` + `07f3fb6`）

| commit | 主题 |
|---|---|
| `1075a95` | 玫红 `#d9008f` → 草绿 `#7cb342`（原则：lane 排除红色系） |
| `07f3fb6` | 草绿 `#7cb342` → 亮橙 `#e8890c`（实测：橙与蓝互补、与绿强对比，对齐 GitLens 高区分） |

**核心思路**：lane 0/1/2 的色相散布在 120° 等距空间（蓝 200°、橙 33°、绿 114°），确保前 3 条 lane 视觉一眼可分。

---

## 阶段 9 — 算法入口统一收敛（v0.8.26，user 拍板）

**动机**：v0.8.25 默认切到 GitLens GKC 后，vscode-git-graph 1:1 复刻 fallback 成为「历史包袱」—— 2 周内没触发，但仍然占 ~1700 行代码 + 一堆测试维护成本。graph 包从「两条算法并存」收敛为「BuildGraphGitlens 唯一入口」。

**User 拍板**：全删干净一刀（不保留 hidden fallback、不保留代码只删 env 开关）。

### 9.1 改动范围

| 资产 | 处置 |
|---|---|
| `app/git/graph/layout_vscode.go`（650 行） | 删 |
| `app/git/graph/layout.go`（749 行孤儿代码） | 删 |
| `app/git/graph/v0824_main_chain_test.go` | 删 |
| `app/git/graph/layout_uncommitted_test.go` | 删 |
| `app/git/graph/layout_test.go` | 删 |
| `app/git/graph/v27_regression_test.go` | 删 |
| `layout_gitlens_e2e_test.go:220` vscode baseline 对照块 | 删 |
| `app/platform/gitea/adapter.go:pickGraphBuilder` | 收敛为 `BuildGraphGitlens` 单调用 |
| `app/platform/github/adapter.go:pickGitHubGraphBuilder` | 同上 |
| `GITEA_KANBAN_GRAPH_ALGO` env 开关 | 删 |
| `os` import 在两 adapter 中 | 删 |
| `app/git/graph/types.go`（新建 237 行） | 承载共享 DTO（GraphNode / GraphEdge / GraphBranchLine / GraphBranch / EdgeType 常量 / GraphResult）+ `HasPrimaryBranchRef` 函数 |

### 9.2 净代码量

```text
删 -1700 行：
  layout_vscode.go          -650
  layout.go                 -749
  v0824_main_chain_test.go  (-v0.8.24 main chain 测试)
  layout_uncommitted_test.go (-Uncommitted 行渲染测试)
  layout_test.go            (BuildGraph 单元测试)
  v27_regression_test.go    (v2.7 first-parent 回归)
  layout_gitlens_e2e_test.go:220  (-vscode baseline 对照块)
  2 个 adapter pickGraphBuilder 函数 (-30)
  ───────────────────────
  约 -1700

加 +237 行：
  types.go (共享 DTO + HasPrimaryBranchRef)
```

### 9.3 v0.8.24 幽灵 line 修复的延续性

| 修复点 | v0.8.24 实现 | v0.8.26 中等价实现 |
|---|---|---|
| main chain 锚定 | `layout_vscode.go:191-199` 新增 `mainChain map[string]bool` 字段 | `layout_gitlens.go` 的 `assignColumnForRow` main chain reservation |
| ghost line 消除 | `determinePath` 强制 `cp.x=0` | `columnsToFreeWhenFound[parentSha]` 显式释放 lane |
| 回归测试 | `TestBuildGraphVscode_MainChainLaneZero` | `TestBuildGraphGitlens_*` 系列覆盖等价拓扑 |

**v0.8.24 release note 不删除** — 它仍是 vscode-git-graph 原版幽灵 line bug 的事实记录 + 调研过程。但 v0.8.26 中相关代码 + 测试都删除，故 v0.8.24 是「对历史问题的修复」，v0.8.26 是「用更好的算法重新实现等价逻辑」。

### 9.4 改动后 graph 包结构（终极态）

```text
app/git/graph/
├── types.go                     # 共享 DTO + HasPrimaryBranchRef
├── layout_gitlens.go            # 主算法（BuildGraphGitlens / gitlensAssignColumns 等 60+ 函数）
├── layout_gitlens_test.go       # 单元测试
├── layout_gitlens_dto_test.go   # DTO 转换测试
├── layout_gitlens_e2e_test.go   # 真实 TRex 仓库端到端
├── debug_dump_test.go           # 调试 dump
└── dump_branches_test.go        # 调试 dump
```

`BuildGraphGitlens(commits []git.CommitInfo, head string, pinnedHeadShas []string) *GraphResult` 是 graph 包**唯一公开入口**。

---

## 完整 commit 列表（v0.8.25 → v0.8.26.x）

| commit | 类型 | 主题 |
|---|---|---|
| `5caa347` | feat | feat: 默认切换到 GitLens GKC 算法布局 |
| `1acdfcb` | fix | GitLens DTO 转换层 4 个 bug + 1 个算法层 segment 漏加 |
| `1bc9fbc` | fix | GitLens 单 commit lane 不画线 + branch-off 跨 lane 转场线缺失 |
| `e9ed576` | fix | GitLens fresh claim 路径不记录 branchSha 导致孤立 commit |
| `b86a0fd` | fix | Uncommitted 与 HEAD 同 lane 渲染，修 lane 泄漏导致的图错乱 |
| `b989f9f` | fix | DAG 排序从 author date 改为 committer date，修 cherry-pick commit 行序错位 |
| `24368ab` | feat | Git Graph lane 左移压缩对齐 GitLens 实测布局 |
| `64499be` | fix | Git Graph 补 fork 汇入线与 merge 合入线，连线形态 1:1 复刻 GitLens |
| `1075a95` | style | lane 调色板移除玫红 `#d9008f`，替换为草绿 `#7cb342` |
| `07f3fb6` | style | lane 1 草绿换亮橙 `#e8890c`，与蓝/绿 lane 拉开对比度 |

外加在 `feat/git-graph-gitlens-algorithm` 分支上有：

| 文件 | 行数 | 用途 |
|---|---|---|
| `app/git/graph/layout_gitlens.go` | 896 | 主算法（Go 移植自 GitLens layout.ts + edges.ts） |
| `app/git/graph/layout_gitlens_test.go` | 270 | 单元测试（DAG 拓扑、lane 分配、reservation） |
| `app/git/graph/layout_gitlens_dto_test.go` | 692 | DTO 转换测试（rows → segments → branches / edges） |
| `app/git/graph/layout_gitlens_e2e_test.go` | 247 | 端到端测试（真实 TRex 仓库 → 与 GitLens 数据逐行比较） |
| `app/git/graph/dump_branches_test.go` | 109 | 调试 dump（-run TestDumpBranches 调出 lane / branches / edges） |
| `app/git/graph/debug_dump_test.go` | 106 | 调试 dump（中等规模 DAG） |

---

## 决策表（按时间倒序）

| 决策 | 选项 | 拍板方 | 时间 | commit |
|---|---|---|---|---|
| lane 1 改亮橙（vs 草绿） | 草绿 / 亮橙 / 玫红 | user 实测反馈 | 2026-07-30 | `07f3fb6` |
| lane 配色：移除红色系 | 保留 / 移除 | user 实测反馈 | 2026-07-30 | `1075a95` |
| merge edge 颜色 | child / parent / 双色 | 实测（GitLens 原版） | 2026-07-30 | `64499be` |
| 跨 lane 长线渲染 | 整条对角线 / pushSplit | 实测（GitLens 形态） | 2026-07-30 | `64499be` |
| 移植算法选型 | 现状改善 / GitLens | 实测数据驱动 | 2026-07-30 | `5caa347` |
| 双跑 vs 单跑 | 双跑（visual + color） | 性能可接受（< 150ms @ 3000 commits） | 2026-07-30 | `5caa347` |
| 排序键 | authorDate / committerDate | cherry-pick 行序 bug | 2026-07-30 | `b989f9f` |
| lane 算法 | vscode 原版 / GitLens 移植 | GitLens 1:1 实测更好 | 2026-07-30 | `5caa347` |

---

## 后续工作（建议）

- [x] `layout.go`（Gitea 风格 `BuildGraph`）是否真正切换到 GitLens 输出？**v0.8.26 完成**：layout.go / layout_vscode.go / pickGraphBuilder env 开关全删；`BuildGraphGitlens` 作为 graph 包唯一公开入口；DTO 共享类型迁到 `types.go`。详情见「阶段 9 算法入口统一收敛」段。
- [ ] `compact=true` vs `compact=false` 调度改为「segment 首次 claim 时取色，全图渲染时按 compact 后 lane 找最近 segment claim」单跑方案 — 当 commit 数 > 5000 时启用
- [ ] 给 `layout_gitlens.go` 加更全面的 property-based test（`testing/quick`）覆盖随机 DAG 形态

---

## 相关文档

- [./gitgraph-engine.md](./gitgraph-engine.md) - 当前生效算法的"为什么这样做"
- [./06-gitgraph.md](./06-gitgraph.md) - 高层设计/数据流
- [../adr/0010-go-git-vs-git-cli.md](../adr/0010-go-git-vs-git-cli.md) - GitLens 移植的 go-git 选型
- [../releases/v0.8.24.md](../releases/v0.8.24.md) - vscode 原版幽灵 line bug fix
- [../releases/INDEX.md](../releases/INDEX.md) - 全版本索引
