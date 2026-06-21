# Gitea Commit Graph 技术方案

> **来源对照**：本文档记录两套实现方案——
>
> 1. **Gitea Web 原生方案**：`/Users/zhongxingxing/2026/code/gitea` 仓库中 `services/repository/gitgraph/` + `templates/repo/graph/` + `routers/web/repo/commit.go` 的真实实现
> 2. **gitea-kanban 复刻方案**：`gitea-kanban` 项目中 `src/main/gitgraph/` + `src/renderer/views/TimelineNewView.vue` + IPC 端点 `commits.gitgraph` 的实现
>
> **设计目的**：为 gitea-kanban 的"新时间轴"（`/timeline-new` 路由）提供完整的 git graph 渲染能力，**视觉上 1:1 对齐 Gitea Web** 的 `/{owner}/{repo}/graphs/commits` 页面。

---

## 1. 整体架构对比

### 1.1 Gitea Web（原生方案）

```
用户浏览器
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│              routers/web/repo/commit.go                      │
│                      Graph() handler                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ 1. 解析请求参数
                           ▼
┌─────────────────────────────────────────────────────────────┐
│           services/repository/gitgraph/                       │
│   graph.go (执行 git log --graph, 流式解析)                    │
│   parser.go (ASCII 字形状态机解析)                              │
│   graph_models.go (数据模型)                                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ Flow / Graph / Commit / Glyph
                           ▼
┌─────────────────────────────────────────────────────────────┐
│             templates/repo/graph/                             │
│   svgcontainer.tmpl → SVG <path> (左)                         │
│   commits.tmpl       → commit 行 (右)                          │
│   graph.tmpl         → 整页容器                                  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
用户浏览器
    ├─ SVG：左侧分支线图（<svg><path> + <circle>）
    ├─ HTML：右侧 commit 信息列表
    └─ JS：AJAX 局部刷新、颜色切换、branch 筛选
```

### 1.2 gitea-kanban（复刻方案）

```
gitea-kanban 渲染端
    │
    ▼ (NavRail → "新时间轴" → /timeline-new)
┌─────────────────────────────────────────────────────────────┐
│           src/renderer/views/TimelineNewView.vue              │
│   顶部栏：仓库名 + 分支 chips + 刷新                            │
│   SVG 区域：sticky 左侧 + SVG 渲染（dot + 线条）               │
│   列表区域：与 SVG 行对齐的 commit 列表                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ window.api.commits.gitgraph
                           ▼ (IPC)
┌─────────────────────────────────────────────────────────────┐
│              src/main/ipc/commits.ts                           │
│                commitsGitGraphHandler()                       │
│   1. resolveProject → giteaUrl / owner / repo                 │
│   2. listGiteaCommits(sha=branch[0], limit=200)               │
│   3. buildGitGraph(items) → GitGraphDto                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ gitgraph.GetCommitGraph
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              src/main/gitgraph/                               │
│   models.ts    (Flow / Graph / Commit / Glyph)                │
│   parser.ts    (DAG Layout + SVG Path 生成)                   │
│   index.ts     (buildGitGraph 入口 + GitGraphDto)              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心模块详解

### 2.1 Gitea Web 的 gitgraph 入口（`services/repository/gitgraph/graph.go`）

**关键设计**：使用 Go 管道（Pipeline）流式处理 `git log --graph` 输出。

```go
// 执行的完整命令：
git log --graph --date-order --decorate=full \
        [-C] [-M] [--date=iso-strict] \
        [-n N] [--pretty=format:DATA:%D|%H|%ad|%h|%s] \
        [--tags] [--branches]  // 或指定分支
```

**`--pretty=format` 解析格式**：

```
DATA:%D|%H|%ad|%h|%s
  |   |  |   | └── Subject (commit 消息第一行)
  |   |  | └── 短 SHA (%h)
  |   |  └── 作者日期 ISO 格式 (%ad)
  |   └── 完整 SHA (%H)
  └── Ref 名称装饰 (%d)，如 "tag: v1.0, HEAD -> main"
```

**分页处理逻辑**（`graph.go` 第 45-75 行）：

```go
// 跳过上一页的 commit 数量
commitsToSkip := setting.UI.GraphMaxCommitNum * (page - 1)  // 每页 commit 数 × (页码-1)

for commitsToSkip > 0 && scanner.Scan() {
    // 找到 "DATA:" 前的第一个 '*' 字符，计为一次 commit
    if starIdx >= 0 && starIdx < dataIdx {
        commitsToSkip--
    }
    // 同时需要解析 glyph 以维护 Parser 状态
    parser.ParseGlyphs(line[:dataIdx])
}
```

**管道函数设计**（`graph.go` 第 49-99 行）：

```go
// 关键：stdout 通过 pipe 传递，scanner 逐行读取
// 每个 pipeline 步骤之间无中间内存缓冲，内存占用 O(1)
graphCmd.WithPipelineFunc(func(ctx gitcmd.Context) error {
    scanner := bufio.NewScanner(stdoutReader)
    // ... 逐行解析 ...
    return scanner.Err()
})
```

### 2.2 Gitea Web 的 Parser 状态机（`services/repository/gitgraph/parser.go`）

#### 2.2.1 Parser 状态机字段

```go
type Parser struct {
    glyphs          []byte    // 当前行字形（不含空格的部分）
    oldGlyphs       []byte    // 上一行字形（用于判断 flow 延续）
    flows           []int64   // 当前行每列对应的 flow ID
    oldFlows        []int64   // 上一行每列对应的 flow ID
    maxFlow         int64     // 全局最大 flow ID
    colors          []int     // 当前行每列对应的颜色编号
    oldColors       []int     // 上一行每列对应的颜色编号
    availableColors []int     // 可用颜色池（循环数组）
    nextAvailable   int       // 下一个可用颜色位置
    firstInUse      int       // 颜色池中"正在使用"区间起点
    firstAvailable  int       // 颜色池中"可用"区间起点
    maxAllowedColors int      // 最大允许颜色数（0=无限制）
}
```

#### 2.2.2 字形（Glyph）到 Flow 的映射规则

Git `--graph` 输出的 ASCII 字形共有 7 种，每种对应不同的分支线语义：

| 字形 | 含义 | 处理函数 | Flow 逻辑 |
|------|------|-----------|-----------|
| `*` | Commit 所在 | `setUpFlow()` | 继承上方 flow，或开新 flow |
| `\|` | Flow 向上延伸 | `setUpFlow()` | 继承上方 flow |
| `/` | Flow 合并到其他列 | `setOutFlow()` | 从右列的 flow 汇入 |
| `\` | Flow 分叉到新列 | `setInFlow()` | 从左列的 flow 分出 |
| `_` | Flow 水平向右延伸 | `setRightFlow()` | 继承当前行右方的 flow |
| `-` `.` | Flow 水平向左延伸 | `setLeftFlow()` | 继承当前行左方的 flow |
| 空格 | 无操作 | — | 不处理 |
| 其他 | 新 flow 起始 | `newFlow()` | 分配新 flow ID |

#### 2.2.3 `setUpFlow` 优先级逻辑（处理 `*` 和 `|`）

```go
// parser.go 第 242-257 行：优先级从高到低
// 场景：当前行 i 列是 '*' 或 '|'

1. 左上方是 '\' → takePreviousFlow(i, i-1)
   // |\
   // * |   → '*' 继承 '\' 所在的 flow

2. 正上方是 '|' 或 '*' → takePreviousFlow(i, i)
   // |
   // *   → 直接继承

3. 右上方是 '/' → takePreviousFlow(i, i+1)
   //  /
   // *   → 从 '/' 位置继承 flow

4. 以上都不满足 → newFlow(i)
   // 开新 flow（flow 结束重新开始）
```

#### 2.2.4 颜色分配算法（Color Pool）

**目标**：保证相邻 flow 不使用相同颜色，同时颜色可循环复用。

```
availableColors = [1, 2, 3, 4, 5, ...]  // 颜色池（可动态扩展）
                                    ↑
                              firstInUse（已用区间起点）
                                    ↑
                              firstAvailable（可用区间起点）
                                    ↑
                              nextAvailable（下一个分配给新 flow 的颜色）

分配规则：
1. 新 flow 时：从 nextAvailable 取颜色
2. 取完后 nextAvailable = (nextAvailable + 1) % len(availableColors)
3. firstAvailable 同步前移
4. 当所有颜色都在用时，动态扩展颜色池
5. flow 结束时，释放其颜色到可用池
```

**颜色池释放逻辑**（`parser.go` `releaseUnusedColors`）：扫描 `oldColors`（上一行的颜色），找到仍在"使用中"区间的颜色，将"使用中"和"可用"区间重新排列，使已结束的 flow 对应的颜色进入可用区间。效果：flow 结束后，其颜色尽快可以被新 flow 复用。

#### 2.2.5 `AddLineToGraph` 处理流程

```go
// parser.go 第 46-98 行
func (parser *Parser) AddLineToGraph(graph *Graph, row int, line []byte) error {
    // 1. 分割 line：before=字形部分，after=DATA:后的元数据
    before, after, ok := bytes.Cut(line, []byte("DATA:"))

    // 2. 解析字形，构建 parser.glyphs / flows / colors
    parser.ParseGlyphs(before)

    // 3. 遍历每一列
    for column, glyph := range parser.glyphs {
        if glyph == ' ' { continue }

        flowID := parser.flows[column]

        // 4. 添加字形到 flow 的 glyph 列表
        graph.AddGlyph(row, column, flowID, parser.colors[column], glyph)

        // 5. 如果是 '*'，则创建 Commit 节点
        if glyph == '*' {
            graph.AddCommit(row, column, flowID, after)
            // 解析 after 内容：
            //   Refs | SHA | Date | ShortSHA | Subject
        }
    }

    // 6. 如果行中没有 '*'（纯关系行），添加 RelationCommit 占位
    if !commitDone {
        graph.Commits = append(graph.Commits, RelationCommit)
    }
}
```

### 2.3 Gitea Web 的数据模型（`services/repository/gitgraph/graph_models.go`）

```
Graph
├── Flows: map[int64]*Flow          // key = flowID
│   └── Flow
│       ├── ID, ColorNumber
│       ├── Glyphs: []Glyph        // 该分支线上的所有字形
│       │   └── Glyph: {Row, Column, Glyph}
│       ├── Commits: []*Commit     // 该分支线上的所有 commit
│       └── Min/MaxRow/Column     // 包围盒
│
├── Commits: []*Commit             // 按 row 顺序的所有 commit
│   └── Commit
│       ├── Commit: *git.Commit   // 完整 git 对象
│       ├── User: *user_model.User // 作者
│       ├── Verification          // GPG 签名状态
│       ├── Status                 // CI 状态
│       ├── AvatarStackData       // 头像信息
│       ├── Flow: int64            // 所属 flow ID
│       ├── Row, Column            // 在图中的坐标
│       ├── Rev                    // SHA
│       ├── ShortRev               // 短 SHA
│       ├── Date                   // 作者日期
│       ├── Subject               // commit 消息
│       └── Refs: []git.Reference  // 关联的分支/tag
│
└── MinRow/MaxRow/MinColumn/MaxColumn  // 全局包围盒（用于 SVG viewBox）
```

**关键设计**：
- `Flow.ID` 是全局递增的 ID，从 1 开始
- `Flow.ColorNumber` 是分配的颜色编号（无上限）
- `Flow.Color16()` = `ColorNumber % 16`，对应 CSS 中的 16 种预设颜色
- `Commit.Flow` 关联到具体是哪条分支线上的 commit

### 2.4 Gitea Web 的 HTTP Handler（`routers/web/repo/commit.go`）

```go
// 第 108-177 行：Graph() 函数完整流程
func Graph(ctx *context.Context) {
    // 1. 解析参数
    //    mode: "color" | "monochrome"
    //    hidePRRefs: bool
    //    branch: []string
    //    file: []string
    //    page: int

    // 2. 获取总 commit 数（用于分页，缓存）
    graphCommitsCount := ctx.Repo.GetCommitGraphsCount(...)

    // 3. 核心：获取 Graph 对象
    graph := gitgraph.GetCommitGraph(
        ctx.Repo.GitRepo,
        page,           // 分页页码
        0,              // maxAllowedColors=0 表示不限制
        hidePRRefs,
        branches,
        files,
    )

    // 4. 补充元数据
    graph.LoadAndProcessCommits(ctx, repo, gitRepo)
    //    - git.Commit 对象
    //    - User（通过 email 匹配）
    //    - AvatarStackData
    //    - Verification（GPG 签名）
    //    - Status（CI 状态）

    // 5. 获取所有 refs 用于下拉筛选
    gitRefs := ctx.Repo.GitRepo.GetRefs()

    // 6. 分页
    paginator := context.NewPagination(graphCommitsCount,
        setting.UI.GraphMaxCommitNum, page, 5)

    // 7. 渲染
    if divOnly {
        ctx.HTML(tplGraphDiv)   // AJAX 局部刷新：只返回图+列表+分页
    } else {
        ctx.HTML(tplGraph)      // 完整页面
    }
}
```

---

## 3. SVG 渲染：Gitea Web vs gitea-kanban 对比

### 3.1 Gitea Web 的 SVG 渲染（`templates/repo/graph/svgcontainer.tmpl`）

**字形 → SVG path 指令的映射**：

| 字形 | SVG path（M=moveto, l=lineto, v=vertical, h=horizontal） |
|------|----------------------------------------------------------|
| `*` `\|` | `M col*5+5 row*12+0 v 12` — 垂直线（高度 12px） |
| `/` | `M col*5+10 row*12+0 l -10 12` — 左上斜线 |
| `\` | `M col*5+0 row*12+0 l 10 12` — 右上斜线 |
| `-` `.` | `M col*5+0 row*12+12 h 5` — 短水平线 |
| `_` | `M col*5+0 row*12+12 h 10` — 长水平线 |

**SVG viewBox 计算**：

```go
viewBox = "MinColumn*5 MinRow*12 Width*5+5 Height*12"
width   = "Width*10 + 10px"
```

- 每个字形宽度 = 5px，commit 圆点直径 = 5px（r=2.5）
- 每个 commit 行高 = 12px
- `Width = MaxColumn - MinColumn + 1`
- `Height = MaxRow - MinRow + 1`

### 3.2 Gitea Web 的布局结构

```
┌────────────────────────────────────────────────────────────────┐
│ #git-graph-container                                          │
│                                                                │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐│
│  │   #rel-container    │  │        #rev-container            ││
│  │   max-width: 30%    │  │        width: 100%               ││
│  │   float: left       │  │                                  ││
│  │                     │  │  <ul id="rev-list">              ││
│  │   <svg>             │  │    <li data-flow="1">            ││
│  │     <path />  ←── Flow 线  │      [签章][消息][分支][头像][时间]│
│  │     <circle/> ←── Commit点│    </li>                        ││
│  │   </svg>             │  │  </ul>                           ││
│  └─────────────────────┘  └──────────────────────────────────┘│
│                                                                │
│  [分页器]                                                       │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 gitea-kanban 的 SVG 渲染（`TimelineNewView.vue`）

**坐标系**：复用 Gitea 的 SVG 单位系统（5 列宽 / 12 行高），用 `viewBox + preserveAspectRatio="none"` 在前端做缩放：

```typescript
// 列方向 ×2（5 unit → 10px）、行方向 ×3（12 unit → 36px = ROW_H）
const ROW_H = 36;
const svgViewBox = `0 0 ${cols * 5 + 5} ${commits.length * 12}`;
const svgWidthPx = `${cols * 10 + 10}px`;
const svgHeightPx = `${commits.length * ROW_H}px`;
```

**SVG path 生成**（`parser.ts` `generateSvgPaths`）：

| 类型 | SVG path | 说明 |
|------|---------|------|
| 同列相邻 | `M x (aY+R) L x (bY-R)` | dot 边缘到 dot 边缘的竖线 |
| 跨列 merge | `M sx sy C sx (sy+gap) tx (ty-gap) tx ty` | cubic bezier 曲线 |

### 3.4 gitea-kanban 的布局结构

```
┌────────────────────────────────────────────────────────────────┐
│ #timeline-new                                                   │
│                                                                │
│  [Git Graph]  [kanban_demo/m4java-test]   [刷新]                │
│  [分支: main cx-multi-... cx-delete-... ...]                     │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐│
│  │  .git-graph-svg-area │  │  .git-graph-list                 ││
│  │  position: sticky   │  │  flex: 1                         ││
│  │  min-width: 120px   │  │                                  ││
│  │  ┌────────────────┐ │  │  [ref badge] message  author  SHA││
│  │  │ <svg>          │ │  │  ─────────────────────────────────││
│  │  │  <path>    ←───│─│──│── Flow 竖线（sticky 对齐）         ││
│  │  │  <circle>  ←───│─│──│── Commit dot                       ││
│  │  │  <path>        │ │  │  ─────────────────────────────────││
│  │  │  ...           │ │  │  ...                              ││
│  │  └────────────────┘ │  │                                  ││
│  └─────────────────────┘  └──────────────────────────────────┘│
└────────────────────────────────────────────────────────────────┘
```

**关键点**：SVG 行 = ROW_H 36px，commit row 行高也是 36px，逐行对齐。

---

## 4. 颜色系统

### 4.1 Gitea Web 的颜色方案

```css
/* 单色模式：所有 flow 统一灰色 */
#git-graph-container.monochrome #rel-container .flow-group {
    stroke: var(--color-secondary-dark-5);
    fill: var(--color-secondary-dark-5);
}

/* 彩色模式：16 种预设颜色（flow-color-16-0 ~ flow-color-16-15）*/
#git-graph-container:not(.monochrome) #rel-container .flow-group.flow-color-16-0 {
    stroke: var(--color-series-16-0);  fill: var(--color-series-16-0);
}
#git-graph-container:not(.monochrome) .flow-color-16-1 { ... }
/* ... 16-2 ~ 16-15 */
```

### 4.2 gitea-kanban 的颜色方案

gitea-kanban v1.5 风格对齐：所有 commit dot 和 lane 线条统一用 `var(--color-primary)`（主色 #74B830 绿），通过 x 坐标区分 lane，merge edge 用 `var(--color-danger)` 红色单独区分。

```css
.git-graph-svg path {
  stroke: var(--color-primary);
  fill: none;
}
.git-graph-svg circle {
  fill: var(--color-primary);
}
```

---

## 5. gitea-kanban 复刻方案的关键差异

| 维度 | Gitea Web（原生） | gitea-kanban（复刻） |
|---|---|---|
| **数据来源** | 本地 `git log --graph` 输出 | Gitea REST API (`/commits?sha=...`) |
| **Graph 结构** | `git --graph` ASCII 解析 → 真实 Flow | DAG-aware Layout（基于 parents + timestamp） |
| **线条走向** | 真实 parent 关系决定连哪列 | 同 column 复用，跨 column 用 bezier |
| **Merge 边** | `\` 字形 → 分叉曲线 | cubic bezier 连到 parent column |
| **颜色** | 每条分支线独立颜色池（16 种） | 统一主色 + 红色 merge edge |
| **获取方式** | `git log --graph --date-order` | Gitea `/repos/{owner}/{repo}/commits` |
| **分页** | 跳过前 N 行 git 输出 | `page` + `limit` query param |
| **分页大小** | `setting.UI.GraphMaxCommitNum`（默认 50）| 默认 200，上限 500 |

### 5.1 核心障碍：本地 git 访问缺失

gitea-kanban 是桌面客户端，只能通过 HTTP API 连接远程 Gitea，无法直接执行 git 命令。

**解决方案**：用 Gitea API 的 commit + parents 数据，在 gitea-kanban 端**复刻 Gitea 的 graph layout 算法**。

### 5.2 DAG Layout 算法（`parser.ts`）

**核心思路**：不依赖 `git log --graph` 的 ASCII 输出，直接基于 commit DAG（parents + timestamp）重建等效布局。

```typescript
// 阶段 1: 按时间倒序分配 row（最新 = row 0，最旧 = row N-1）
const sortedDesc = [...commits].sort((a, b) => b.timestamp - a.timestamp);
const rowMap = new Map<string, number>();
sortedDesc.forEach((c, i) => rowMap.set(c.sha, i));

// 阶段 2: 按时间正序分配 column（最旧先入 → 最新后入）
// 这样 parent 一定先入 shaColumn，子 commit 后入能正确继承 column
const sortedAsc = [...commits].sort((a, b) => a.timestamp - b.timestamp);

for (const c of sortedAsc) {
  const firstParentSha = c.parents[0];

  if (!firstParentSha || !shaColumn.has(firstParentSha)) {
    // 没有 parent，或 parent 不在本次结果里：分配新 flow
    maxFlow++;
    column = maxFlow;
    flowId = maxFlow;
  } else {
    const parentColumn = shaColumn.get(firstParentSha)!;
    const tip = columnTip.get(parentColumn);
    if (tip === firstParentSha) {
      // lane 空闲（parent 是该 column 的最新 commit）
      column = parentColumn;
      flowId = parentColumn;
    } else {
      // lane 已被更新的 commit 占用 → 开新 lane
      maxFlow++;
      column = maxFlow;
      flowId = maxFlow;
    }
  }

  shaColumn.set(c.sha, column);
  columnTip.set(column, c.sha);
  rowData.set(row, { column, flowId });
}
```

**关键设计**：
- **行号**（row）= commit 在时间排序中的位置（最新=0）
- **列号**（column）= 分配给该 commit 的分支泳道编号
- **复用策略**：如果第一 parent 的 lane 仍"指向"parent（未被子 commit 占用），则复用；否则开新 lane

### 5.3 SVG Path 生成（`parser.ts` `generateSvgPaths`）

```typescript
// 同 column 内相邻 commit 之间画竖线
for (const colCommits of byColumn.values()) {
  const sorted = colCommits.sort((a, b) => a.row - b.row);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (b.row === a.row + 1) {
      const x = a.column * 5 + 5;
      const y1 = a.row * 12 + 6 + 2.5;  // a dot 下边缘
      const y2 = b.row * 12 + 6 - 2.5;  // b dot 下边缘
      paths.push({ d: `M ${x} ${y1} L ${x} ${y2}` });
    }
  }
}

// 画 merge/fork 边（跨 column 的 bezier 曲线）
for (const c of commits) {
  for (let p = 1; p < c.parents.length; p++) {
    const parent = commitBySha.get(c.parents[p]!);
    if (!parent || parent.column === c.column) continue;
    const sx = parent.column * 5 + 5;
    const sy = parent.row * 12 + 6 + 2.5;
    const tx = c.column * 5 + 5;
    const ty = c.row * 12 + 6 - 2.5;
    const halfGap = Math.max(5, Math.abs(ty - sy) / 2);
    paths.push({ d: `M ${sx} ${sy} C ${sx} ${sy + halfGap}, ${tx} ${ty - halfGap}, ${tx} ${ty}` });
  }
}
```

---

## 6. IPC 契约

### 6.1 gitea-kanban 的 commits.gitgraph IPC

**Channel**: `commits.gitgraph`

**Schema**（`src/main/ipc/schema.ts`）：

```typescript
export const GitGraphArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  branches: z.array(NonEmptyStringSchema).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const GitGraphDtoSchema = z.object({
  commits: z.array(GitGraphCommitSchema),  // 带 row/column/flowId 坐标
  svgPaths: z.array(GitGraphSvgPathSchema),// SVG path 数据
  svg: GitGraphSvgSchema,                  // viewBox / width / height
  totalCommits: z.number().int().min(0),
  truncated: z.boolean(),
  range: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
});
```

**Handler 流程**（`src/main/ipc/commits.ts`）：

```typescript
async function commitsGitGraphHandler(args: GitGraphArgs): Promise<GitGraphDto> {
  // 1. resolve project → giteaUrl / owner / repo
  const proj = resolveProject(args.projectId);

  // 2. 拉分支 commits（注意：当前只取 branches[0]）
  const r = await listGiteaCommits({
    giteaUrl: proj.giteaUrl, username: proj.username,
    owner: proj.owner, repo: proj.repo,
    sha: args.branches?.[0], page: 1, limit: args.limit,
  });

  // 3. buildGitGraph(items) → DAG Layout → GitGraphDto
  const dto = buildGitGraph(r.items, args.branches ?? []);
  return dto;
}
```

### 6.2 preload 暴露（`src/preload/index.ts`）

```typescript
commits: {
  list: invoke(IpcChannel.COMMITS_LIST),
  get: invoke(IpcChannel.COMMITS_GET),
  timeline: invoke(IpcChannel.COMMITS_TIMELINE),
  gitgraph: invoke(IpcChannel.COMMITS_GITGRAPH),  // 新增
},
```

### 6.3 渲染端调用（`TimelineNewView.vue`）

```typescript
const resp = (await (window.api as ...).commits.gitgraph({
  projectId: activeProjectId.value,
  branches: [...selectedBranches.value],
  limit: 200,
})) as GitGraphDto;
graphData.value = resp;
```

---

## 7. 渲染层（TimelineNewView.vue）

### 7.1 模板结构

```vue
<template v-else>
  <div class="git-graph-wrapper">
    <!-- 左侧 SVG 区域（sticky） -->
    <div class="git-graph-svg-area">
      <svg
        class="git-graph-svg"
        :viewBox="svgViewBox"
        :width="svgWidthPx"
        :height="svgHeightPx"
        preserveAspectRatio="none"
      >
        <!-- Flow paths -->
        <path
          v-for="(p, i) in graphData.svgPaths"
          :key="`p-${i}`"
          :d="p.d"
          stroke="var(--color-primary)"
          stroke-width="1.5"
          fill="none"
          :stroke-dasharray="p.dashed ? '4,3' : undefined"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <!-- Commit dots -->
        <circle
          v-for="c in graphData.commits"
          :key="c.sha"
          :cx="dotCx(c.column)"
          :cy="dotCy(c.row)"
          r="2.5"
          fill="var(--color-primary)"
          stroke="var(--color-canvas)"
          stroke-width="1"
        />
      </svg>
    </div>

    <!-- 右侧 commit 列表（与 SVG 等高） -->
    <div class="git-graph-list" :style="{ minHeight: svgHeightPx }">
      <div v-for="c in graphData.commits" :key="c.sha" class="commit-row">
        <span v-for="ref in c.refs.slice(0, 3)" class="ref-badge" ...>{{ ref.shortName }}</span>
        <span class="commit-subject">{{ c.subject }}</span>
        <span class="commit-meta">
          <span class="commit-author">{{ c.authorName }}</span>
          <span class="commit-time">{{ formatRelative(c.date) }}</span>
        </span>
        <span class="commit-sha">{{ c.shortSha }}</span>
      </div>
    </div>
  </div>

  <div v-if="graphData.truncated" class="git-graph-truncated">
    已截断显示 {{ graphData.commits.length }} / {{ graphData.totalCommits }} 条提交
  </div>
</template>
```

### 7.2 关键 CSS

```css
.git-graph-wrapper {
  display: flex;
  align-items: flex-start;
}

.git-graph-svg-area {
  position: sticky;
  left: 0;
  z-index: 2;
  min-width: 120px;
  max-width: 240px;
  background: var(--color-canvas);
  border-right: 1px solid var(--color-border);
  overflow: hidden;
  flex-shrink: 0;
}

.git-graph-svg { display: block; }

.git-graph-list { flex: 1; overflow-x: auto; }

.commit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;       /* 与 SVG ROW_H 对齐 */
  padding: 0 12px;
  white-space: nowrap;
  overflow: hidden;
  border-bottom: 1px solid var(--color-border);
}
```

---

## 8. 修复记录（v1.5 关键 bug fix）

### 8.1 Bug 1：每个 commit 都开新 column

**症状**：50 个线性 commit 全部 column 递增（col=1, 2, 3, ..., 50），没有 lane 复用。

**根因**：dagLayout 第一版按时间倒序处理 commits，parent 还没入 `shaColumn` 全部找不到，判定为孤儿 commit → 新 column。

**修复**：分两阶段处理

```typescript
// 阶段 1: 按时间倒序分配 row（保持 row=0=最新）
const sortedDesc = [...commits].sort((a, b) => b.timestamp - a.timestamp);

// 阶段 2: 按时间正序分配 column（parent 先入，child 后入能正确继承 column）
const sortedAsc = [...commits].sort((a, b) => a.timestamp - b.timestamp);
```

**验证**：50 个线性 commit 全部正确复用 column 1，row 0-49 线性递增。

### 8.2 Bug 2：loadBranches 后没自动 loadGraph

**症状**：进入 `/timeline-new` 路由后永远显示"加载中..."或"没有提交记录"。

**根因**：`loadBranches()` 设置 `selectedBranches` 后没有 `await loadGraph()`。

**修复**：

```typescript
async function loadBranches(): Promise<void> {
  // ... 加载 branches ...
  if (branches.value.length > 0 && selectedBranches.value.size === 0) {
    selectedBranches.value = new Set([...]);
  }
  // 默认选完分支后自动加载 graph
  void loadGraph();
}
```

### 8.3 Bug 3：SVG 区域宽度跳动

**修复**：`.git-graph-svg-area` 加 `min-width: 120px; max-width: 240px`。

### 8.4 视图问题修复（前置）

1. `useBranchStore is not defined` → 补 import
2. `EmptyState` 引号错误 → 修正为 `'` 开头 `'` 结尾
3. `branches.length` 空指针 → 改为 `branches?.length`

---

## 9. 交付清单（gitea-kanban 实际落地的文件）

| 文件 | 职责 |
|---|---|
| `src/main/gitgraph/models.ts` | Flow / GitGraphCommit / Glyph / FlowColorClass 等数据模型 |
| `src/main/gitgraph/parser.ts` | **核心**：DAG Layout 算法 + SVG Path 生成 |
| `src/main/gitgraph/index.ts` | `buildGitGraph()` 入口：API → DAG Layout → GitGraphDto |
| `src/renderer/views/TimelineNewView.vue` | 新视图：SVG Graph + Commit 列表双栏布局 |
| `src/shared/ipc-channels.ts` | 加 `COMMITS_GITGRAPH: 'commits.gitgraph'` |
| `src/main/ipc/schema.ts` | 加 `GitGraphArgsSchema / GitGraphDto / GitGraphSvg / GitGraphCommit` |
| `src/main/ipc/commits.ts` | 加 `commits.gitgraph` handler |
| `src/preload/index.ts` | 加 `commits.gitgraph` API 暴露 |
| `src/renderer/routes/index.ts` | 加 `/timeline-new` 路由 |
| `src/renderer/components/NavRail.vue` | 加"新时间轴"导航入口 |

**验证结果**：
- `pnpm type-check` — 0 errors
- `pnpm build` — 成功，TimelineNewView.js (13 kB) 进入产物
- CDP 验证：50 个 commit 全部 col=1，row 0-49 线性；48 条 path + 50 个 circle 正确显示

---

## 10. 已知限制与未来工作

### 10.1 当前限制

1. **多分支支持不完整**：`commitsGitGraphHandler` 只用 `branches[0]` 一个 ref 拉 commits，其他 branch 过滤被忽略
2. **refs 列表为空**：当前 `GitGraphCommit.refs` 始终为空（后端没有从 gitea refs API 拉取）
3. **CSS 颜色方案简化**：用单一主色，未实现 Gitea 16 色 `flow-color-16-N` 系统
4. **DAG Layout 简化**：Gitea 原生 parser 处理复杂的 `\`/`/`/` `-`/`.` 字符组合，gitea-kanban 只处理简化场景

### 10.2 未来工作

- [ ] 多 branch 合并拉取（参考 `commits.timeline` 的多 branch 拉取逻辑）
- [ ] Gitea refs API 集成：补全 `refs` 字段
- [ ] 完整颜色池：实现 `flow-color-16-N` 16 色循环
- [ ] commit 详情弹窗（参考 TimelineView 的 `loadDetailDetail`）
- [ ] 单/彩色模式切换（参考 Gitea `#flow-color-monochrome` 按钮）
- [ ] PR ref 高亮：已合并的 PR 在对应 commit 行高亮
- [ ] AJAX 分页（参考 Gitea `?div-only=true`）

---

## 11. 与 TimelineView（v1.4）的对比

| 维度 | TimelineView（v1.4） | TimelineNewView（v1.5 Git Graph） |
|---|---|---|
| **数据源** | `commits.timeline` | `commits.gitgraph` |
| **聚合方式** | 聚合 gitea commits + pulls + card_links | 只聚合 commits |
| **Lane 模式** | branch / author / pr 三种模式可选 | 只有 branch |
| **图结构** | Lane-based（每 branch 一条 swimlane）| DAG-aware（基于 parents 关系）|
| **线条走向** | 所有 parent 连回 main lane | 真实跨 column 关系 |
| **颜色** | 三色（主/活跃/归档）| 统一主色 + 红色 merge edge |
| **应用场景** | 看整体进度、lane 筛选 | 看真实 commit DAG、merge 历史 |

两者**独立显示**，`/timeline`（旧）vs `/timeline-new`（新），可在 NavRail 直接切换对比。

---

## 12. v1.4 重构（2026-06-18 mid-turn steer）—— 对齐 Gitea parser.go

### 12.1 动机

v1.3 之前 `src/main/gitgraph/` 自研"DAG 反推布局"算法（`dagLayout()`）从 commit DAG 反推
(row, column) + 直接生成 SVG path。问题：

1. **fork bug**：`columnTip` 判断顺序导致 fork 时错误复用 parent 的 column
2. **算法语义偏离 Gitea**：Gitea parser.go 是**字符流解析器**（输入 `git log --graph`
   输出），我们的反推器自己实现了一套 `git log --graph` 的语义，长期维护会偏离
3. **不可重用**：换 Gitea 版本 / 换 gitea-js 后端，无法验证视觉一致性

### 12.2 重构目标

**字符流协议对齐 Gitea**：

```
main 端：gitea commit[] ─→ 字符流（* | / \ _ - .）──┐
                                                   ├── Gitea parser.go 输入格式
前端：GraphLine[] ──→ parseLines() ──→ Graph ─┘
                       └── 1:1 移植 Gitea parser.go
```

### 12.3 重构后模块布局

| 模块 | 位置 | 职责 |
|---|---|---|
| `src/renderer/lib/gitgraph/models.ts` | 前端 | Graph / Flow / Glyph / GitGraphCommit 类型（对齐 Gitea graph_models.go） |
| `src/renderer/lib/gitgraph/types.ts` | 前端 | IPC 协议 DTO（GitRef / GraphLine / GraphLinesDto） |
| `src/renderer/lib/gitgraph/parser.ts` | 前端 | **1:1 移植 Gitea parser.go**：状态机 + 颜色环形池 + ParseGlyphs + AddLineToGraph + parseLines |
| `src/renderer/lib/gitgraph/svg.ts` | 前端 | Glyph → SVG path d（对齐 Gitea svgcontainer.tmpl:5-16） |
| `src/main/gitgraph/gitProcess.ts` | main | `runGraphLog(cwd, opts)` 调 `git log --graph` 子进程（v1.5 启用） |
| `src/main/ipc/commits.ts` | main | `commits.gitgraph.lines` handler（v1.4 placeholder；v1.5 接 gitProcess） |
| `src/renderer/views/TimelineNewView.vue` | 前端 | view 重构：调前端 Parser + 本地 SVG 渲染 |

### 12.4 IPC 契约变更

| 旧（v1.3） | 新（v1.4） |
|---|---|
| `commits.gitgraph` | `commits.gitgraph.lines` |
| `GitGraphArgs` + `GitGraphDto`（含 svgPaths / svg / commits） | `GitGraphLinesArgs` + `GraphLinesDto`（仅含 lines / totalCommits / truncated / range） |
| main 直接产 SVG path（反推布局） | main 产字符流 + commit metadata（前端的 Parser 解析） |

### 12.5 测试覆盖

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `src/renderer/lib/gitgraph/__tests__/parser.test.ts` | 26 | 线性 / fork / merge / 颜色池 / SVG path / viewBox / Parser 状态机 / Gitea testglyphs 子集 |
| `src/renderer/lib/gitgraph/__tests__/git-log-e2e.test.ts` | 6 | 真实 `git log --graph` 输出端到端解析（Hello-World octocat 仓库） |

### 12.6 v1.4 状态 vs v1.5 落地

- ✅ v1.4（本轮）：前端 Parser 体系完整、IPC 契约对齐、main handler placeholder、view 接入
- ⏳ v1.5（待落地）：
  1. 仓库本地路径（clone 或指定 path）— 用户拍板
  2. 启用 `gitProcess.runGraphLog()` 调 git 子进程
  3. 加上 `listGiteaRefsBySha` 关联 ref 装饰（与 graph.go `%D` 等价）
  4. 写 gitgraph cache（30s TTL）
  5. main handler 去掉 placeholder throw，改为调 gitProcess + listGiteaRefsBySha
  6. 加 authorName / authorEmail / authorAvatar 填充（git log 走 `--pretty=format:"%D|%H|%ad|%h|%s|%an|%ae|%P"`）

### 12.7 v1.5 实际落地（2026-06-21 · commit `3fdefdc`）

用户拍板：v1.5 路径 = gitea-kanban 帮用户 git clone 仓库到本地 → 调 git 子进程拿字符流。

**新增 IPC `commits.gitgraph.cloneRepo`**：
- 优先复用 `localStore.prefs.gitgraph.localPath.${projectId}` 已存路径
- 否则走 `suggestLocalRepoPath`（`${tmpdir}/gitea-kanban/repos/${owner}__${repo}.git`）
- 调 `gitProcess.cloneRepo`：URL 临时塞 `oauth2:${token}@...` → clone --bare → 立即 `git remote set-url` 去 token
- 路径写回 localStore（prefs 子键，按 projectId 索引）

**main handler（`commits.gitgraph.lines`）真正接 git 子进程**：
- 读 localStore 看 projectId 有 localPath？
  - 有 → `runGraphLog(cwd, opts)` 跑 `git log --graph --date-order --decorate=full` → 字符流 → `dto{disabled:false, lines, ...}`
  - 没有 → `dto{disabled:true, reason:'需要先点启用 Git Graph'}`

**TimelineNewView 加「启用 Git Graph」按钮**：
- `featureDisabled` 占位里加按钮（`enableGitGraph()`）
- 调 `commits.gitgraph.cloneRepo` IPC → 完成后 `loadGraph()` 一次
- `cloning` / `cloneProgress` 状态显示在按钮下方

**安全**：
- token 仅在 clone 子进程 argv 瞬时存在 → `remote set-url` 清掉
- 持久化只存**路径**，不存 token
- `bare=true`（桌面端不编辑代码，裸仓库省一半磁盘）

### 12.8 v1.5.1 · bug 修复（commits `4ecfdbf` / `e01f4e7` / `8535ad7`）

**commit `4ecfdbf`**：SVG 容器 + commit-row 行高修复
- `.git-graph-svg-area` 去掉 `max-width: 240px + overflow: hidden` → 改 `overflow-x: auto`（多列不再被压缩）
- `.git-graph-wrapper` 加 `min-width: max-content`（整体横向滚动）
- `.commit-row` padding `8px → 0 + box-sizing: border-box`（严格 24px 行高，与 SVG ×2 缩放对齐）

**commit `8535ad7`**：dot 与 commit-row 行节奏对齐
- 新增 `allRows` computed：row 0..maxRow 全铺满，commit + relation 交错
- commit-row v-for 改用 `allRows`（merge edge transition 行也占位）
- SVG path `stroke-width: 1 → 1.5`（linecap 圆头覆盖 subpath 端点间隙）
- 去掉 `stroke-linejoin: round`（与 Gitea 原版一致）

**commit `e01f4e7`**：渲染坐标契约测试
- 用真实 git log --graph 输出端到端验证
- dot 圆心 (col-minCol)×10+10 = (col-minCol)×5×2 + 5×2（×2 缩放 1:1）
- dot 圆心 row×24+12 = row×12×2 + 6×2
- svgWidthPx / svgHeightPx = svgViewBox ×2

### 12.9 测试现状（v1.5.1）

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `src/renderer/lib/gitgraph/__tests__/parser.test.ts` | 26 | Gitea parser.go 1:1 状态机 + 颜色环形池 |
| `src/renderer/lib/gitgraph/__tests__/git-log-e2e.test.ts` | 6 | 真实 git log --graph 端到端 |
| `src/renderer/lib/gitgraph/__tests__/graph-lines-disabled.test.ts` | 3 | GraphLinesDto.disabled 契约 |
| `src/renderer/views/__tests__/TimelineNewView-css.test.ts` | 3 | CSS 布局回归（max-width / overflow / padding / min-width） |
| `src/renderer/views/__tests__/TimelineNewView-coords.test.ts` | 3 | 渲染坐标契约（dot + viewBox 1:1） |
| `src/renderer/views/__tests__/TimelineNewView-allrows.test.ts` | 4 | allRows + relation 占位 |
| **总计** | **45** | — |
