# Git Graph 设计（当前实现）

> 本文档只描述 **当前生效** 的 Git Graph 实现。
> 旧版 Electron / `git log --graph` 字符流 / 前端 Parser 方案已经废弃，不再作为实现依据。
> 如与历史文档冲突，以 `AGENTS.md`、`app/git/graph/layout_gitlens.go`、`frontend/src/lib/gitgraph/vscode-render.ts` 为准。

---

## 1. 当前架构

Git Graph 当前走 **Go 端结构化布局 + 前端 vscode-office 风格 SVG 渲染**：

```text
go-git LogCommits / refs
  ↓
app/git/graph/layout_gitlens.go (GitLens GKC 算法 1:1 移植)
  ↓  GraphResult { nodes, edges, branches, maxLane, truncated }
App.GetGitGraph
  ↓
frontend/src/views/TimelineNewView.vue
  ↓
frontend/src/lib/gitgraph/vscode-render.ts (vscode-office 风格 SVG 渲染)
  ↓
SVG paths + commit dots + commit rows
```

关键点：

- Go 端不输出 ASCII 字符流。
- 前端不再解析 `git log --graph` glyph。
- 布局算法：`BuildGraphGitlens`（GitLens GKC 算法 1:1 移植，唯一公开入口）。
- 渲染风格：对齐 vscode-office `GitHistory.tsx` 视觉规范。

---

## 2. 后端职责

### 2.1 数据来源

- `app/git/log.go` / 平台 adapter 提供 commit DAG、parents、refs。
- `app/git/graph/layout_gitlens.go` 负责 lane 分配、颜色分配、edge 生成。

### 2.2 输出模型

Go 端输出：

- `GraphNode`
  - `row`
  - `lane`
  - `color`
  - `sha` / `shortSha`
  - `subject`
  - `authorName` / `authorEmail`
  - `date`
  - `parents`
  - `refs` / `refTypes`
- `GraphEdge`
  - `fromRow` / `toRow`
  - `fromLane` / `toLane`
  - `color`
  - `type` (`normal` / `branch` / `merge`)

### 2.3 当前 lane 规则（GitLens GKC 算法）

以当前实现为准（`layout_gitlens.go`）：

- `columnsUsed` Set + `columnsToFreeWhenFound` Map 实现真正回收 column（vs vscode 原版 `vertex.nextX` 单调递增永不回收）。
- main chain 锚定：primary branch ref head → 沿 first-parent 标记。
- lane 0 是主干专用列。
- 非主干 flow 默认从 `lane 1` 往右分配。
- 非重叠分支复用已释放的 column（非紧凑压缩，跟随 GitLens 原版行为）。

### 2.4 当前颜色规则

- 颜色由 Go 端分配（`color` 字段 0-15）。
- 同一条 flow 的 node / edge 使用同一个 `color` 编号。
- 前端只消费 `color`，通过 `VSCODE_COLORS[color % 16]` 转 hex。
- 调色板排除红色系（用户拍板）。

---

## 3. 前端职责

### 3.1 渲染入口

- 视图：`frontend/src/views/TimelineNewView.vue`
- 渲染器：`frontend/src/lib/gitgraph/vscode-render.ts`

### 3.2 核心几何参数（v0.8.37.5 固定）

| 参数 | 值 | 来源 | 说明 |
|---|---|---|---|
| `VSCODE_GRID_X` | `16` | vscode-office DEFAULT_GRAPH_GRID | lane 间距（水平像素） |
| `VSCODE_GRID_Y` | `28` | vscode-office `ROW_HEIGHT=28` | **行高**（`computeGraphLayout` 的 `rowHeight` 覆盖 `grid.y`） |
| `VSCODE_OFFSET_X` | `8` | vscode-office `offsetX=8` | dot 左偏移 |
| `VSCODE_OFFSET_Y` | `12` | vscode-office `offsetY=12` | dot 顶偏移（row 中心 = offsetY + gridY/2） |
| `VSCODE_VERTEX_RADIUS` | `4` | vscode-office `vertexRadius` | 普通 dot 半径 |
| `VSCODE_EXPAND_Y` | `250` | vscode config.ts:278 | 手风琴展开高度 |

### 3.3 lane 颜色调色板（16 色，排除红色系）

```typescript
export const VSCODE_COLORS = [
  '#0085d9', // 0  亮蓝
  '#e8890c', // 1  亮橙（原 #d9008f 玫红，用户拍板排除红色系）
  '#00d90a', // 2  亮绿
  '#d98500', // 3  深橙
  '#a300d9', // 4  紫
  // ... 其余与 vscode-git-graph 默认一致
];
```

### 3.4 commit row 布局

#### 3.4.1 行结构（5 列 grid）

```
| graph 占位 | desc（refs + subject） | date | author | sha |
```

- `grid-template-columns: var(--grid-template-columns, 96px 1fr 128px 128px 80px)`
- 第一列 graph 占位透明，让背景 SVG dot 透出
- 后 4 列各自有 `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` 截断超长文本

#### 3.4.2 字体大小

| 元素 | 字体大小 | 说明 |
|---|---|---|
| `.commit-row` 主体 | **14px** | 行基础字体（v0.8.38 +1px） |
| `.ref-badge` | **14px** | badge 文字 |
| `.ref-badge__label` | **14px** | badge label 文字 |
| `.commit-author` | **13px** | 作者名（v0.8.38 +1px） |
| `.commit-time` | **13px** | 时间（v0.8.38 +1px） |
| `.commit-sha` | **12px** | 短 SHA（v0.8.38 +1px） |

#### 3.4.3 行高与 line-height

- **行高**：28px（`VSCODE_GRID_Y`，对齐 vscode-office `ROW_HEIGHT`）
- `.commit-row` line-height: `var(--git-graph-row-height, 28px)`
- `.commit-row__col--desc` line-height: `var(--git-graph-row-height, 28px)`

#### 3.4.4 文本截断规则

| 列 | overflow | 截断方式 | 说明 |
|---|---|---|---|
| desc | `hidden visible` | x=hidden ellipsis, y=visible | 超长 subject 省略号；ref-badge 底边线不被裁 |
| author | `hidden` | ellipsis | 超长作者名省略号 |
| date | `hidden` | ellipsis | 超长日期省略号 |
| sha | `hidden` | ellipsis | 超长 SHA 省略号 |

> **重要**：`overflow: hidden visible` 是 x=hidden + y=visible（不是 visible hidden）。
> 之前曾误写为 `visible hidden` 导致横向滚动条 + 文字被裁。

### 3.5 ref badge 设计

#### 3.5.1 视觉规范

| 属性 | 值 | 说明 |
|---|---|---|
| border-radius | `5px` | 小圆角 |
| border | `1px solid var(--row-lane-color)` | lane 色边框 |
| background-color | `var(--row-lane-color-bg)` | lane 色 20% alpha tint 底 |
| color | `var(--color-text-muted, #E6EDF3)` | 浅字 |
| font-size | `14px` | |
| line-height | `20px` | |
| height | `auto` | |
| margin-top | `2px` | |
| margin-right | `6px` | |
| **无 hover 反相** | — | v0.8.37.4 用户拍板「不要 hover 效果」→ 默认态 = 唯一态 |

#### 3.5.2 ref-badge__icon（squircle 色块）

| 属性 | 值 | 说明 |
|---|---|---|
| width / height | `20px / 20px` | |
| padding | `3px` | |
| border-top-left-radius | `5px` | 跟父 badge 左圆角衔接 |
| border-bottom-left-radius | `5px` | |
| background-color | `var(--row-lane-color)` | lane 色实色 |
| fill | `#ffffff` | 白色 icon |
| SVG | Octicons `git-branch-fill` / `tag` | 实色 fill 模式 |

#### 3.5.3 ref-badge__label

| 属性 | 值 |
|---|---|
| padding | `1px 8px` |
| line-height | `20px` |
| font-size | `14px` |

### 3.6 dot（commit vertex）视觉

- 普通 dot：`r=4`，fill = lane 色 hex
- HEAD dot：`r=6`（当前分支 HEAD），stroke `2.5px`
- stash dot：`r=4.5` + 外圈 `r=5` stroke-only ring（双圈）
- 默认 stroke：`rgba(30, 30, 30, 0.75)` 微描边

### 3.7 path 渲染

- 单层 stroke（去掉 vscode 原版 shadow 双层）
- stroke-width: `2`
- 路径风格：Rounded（C 贝塞尔）/ Angular（L 折线 + 38% 拐点）
- uncommitted 段：`#808080` + dasharray `2px`

### 3.8 dot hover 交互

- hover dot 时给 `.git-graph-body` 注入 `--active-lane-color` CSS var
- 该行 graph 列显示 lane 色软底渐变（`linear-gradient` 右淡出，38% → 18% → transparent）
- ref-badge **不随 hover 变化**（v0.8.37.4 拍板）

### 3.9 commit 详情面板（手风琴）

#### 3.9.1 展开机制

- 点击 commit row → `expandedSha` 切换 → inline 手风琴展开
- 展开高度 = `ROW_H + activeExpandY`（动态测量实际面板高度）
- 手风琴 max-height: `min(70vh, 610px)`，超出时内部滚动

#### 3.9.2 面板布局

- 双栏 grid: `5fr 5fr`（左: commit message + meta，右: files + cards）
- 左栏 `overflow-y: auto` + `overflow-x: hidden`
- 右栏 `overflow-y: auto` + `overflow-x: hidden`

#### 3.9.3 文本换行规则

| 区域 | white-space | word-break | overflow-wrap | 说明 |
|---|---|---|---|---|
| commit 标题 | `normal` | `break-word` | `anywhere` | 自动换行，超长 URL/SHA 也折行 |
| commit 正文 | `pre-wrap` | `break-word` | `anywhere` | 保留原始换行 + 超长行折行 |
| 文件名 | `nowrap` | — | — | 截断省略（text-overflow: ellipsis） |
| meta 信息 | — | — | — | flex-wrap: wrap |

> **重要**：`.cd-panel__message` 的 `overflow` 必须是 `hidden visible`（x=hidden 防横向滚动，y=visible 让换行文本完整可见），不能用 `hidden`（会裁掉换行后的文本）。

---

## 4. 当前约束

- Git Graph 只以当前结构化实现为准，不再接受"字符流协议必须兼容"的前提。
- 任何关于 lane / color / merge path 的调整，都必须同时看：
  - `app/git/graph/layout_gitlens.go`
  - `app/git/graph/types.go`
  - `frontend/src/lib/gitgraph/vscode-render.ts`
  - `frontend/src/views/TimelineNewView.vue`
- ref-badge 无 hover 反相效果（v0.8.37.4 用户拍板）。
- 行高固定 28px（对齐 vscode-office `ROW_HEIGHT`）。
- 调色板排除红色系（用户拍板）。

---

## 5. 调试与回归

当前最重要的回归入口：

- 后端：
  - `go test ./app/git/graph/...`
- 前端：
  - `cd frontend && pnpm vitest run`（gitgraph 测试）
  - `cd frontend && pnpm typecheck`
  - `cd frontend && pnpm build`

发生以下现象时，优先怀疑 lane 分配而不是 UI 样式：

- 多分支错误进入同一个 column
- 同一 column 中途变色
- 分支明明不重叠却被迫占更右侧空列
- 同一 parent 的多条 merge 线互相覆盖

---

## 6. 相关文档

| 文档 | 路径 | 用途 |
|---|---|---|
| GitGraph 算法技术文档 | `docs/design/gitgraph-engine.md` | GitLens GKC 算法 Go 移植原理 + 数据结构 |
| GitGraph 引擎演进历程 | `docs/design/gitgraph-engine-history.md` | 四阶段演进 + 5 个 bug 修复记录 |
| git / gh / go-git 规范 | `docs/adr/0010-go-git-vs-git-cli.md` | 写操作按平台分，读 DAG 全 go-git |
| 版本索引 | `docs/releases/INDEX.md` | 全部 release note 索引 |

---

## 7. 非当前实现

以下内容都属于历史方案，不再作为实现依据：

- `git log --graph` 字符流解析
- 前端 `parser.ts` 作为主渲染链路
- `src/main/gitgraph/*` 旧 Electron 路径
- `layout.go`（v0.8.26 删除，被 `layout_gitlens.go` 替代）
- `layout_vscode.go`（v0.8.26 删除，vscode-git-graph 1:1 复刻 fallback）
- `structured.ts`（被 `vscode-render.ts` 替代）
