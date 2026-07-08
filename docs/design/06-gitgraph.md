# Git Graph 设计（当前实现）

> 本文档只描述 **当前生效** 的 Git Graph 实现。
> 旧版 Electron / `git log --graph` 字符流 / 前端 Parser 方案已经废弃，不再作为实现依据。
> 如与历史文档冲突，以 `AGENTS.md`、`app/git/graph/layout.go`、`frontend/src/lib/gitgraph/structured.ts` 为准。

---

## 1. 当前架构

Git Graph 当前走 **Go 端结构化布局 + 前端直接渲染**：

```text
go-git LogCommits / refs
  ↓
app/git/graph/layout.go
  ↓  GraphResult { nodes, edges, maxLane, truncated }
App.GetGitGraph
  ↓
frontend/lib/ipc-client.ts -> commits.gitgraph.lines
  ↓
frontend/src/views/TimelineNewView.vue
  ↓
frontend/src/lib/gitgraph/structured.ts
  ↓
SVG paths + commit dots + commit rows
```

关键点：

- Go 端不输出 ASCII 字符流。
- 前端不再解析 `git log --graph` glyph。
- `commits.gitgraph.lines` 这个 IPC 名称只是历史沿用，**返回值实际是结构化 `GraphResultDto`**。

---

## 2. 后端职责

### 2.1 数据来源

- `app/git/log.go` / 平台 adapter 提供 commit DAG、parents、refs。
- `app/git/graph/layout.go` 负责 lane 分配、颜色分配、edge 生成。

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

### 2.3 当前 lane 规则

以当前实现为准：

- `lane 0` 是主干专用列。
- 主链优先从显式 `main/master` 引用锚定。
- 同一个 parent 的多个 first-parent 子分支，只有一个“主继续 flow”允许继承 parent lane。
- 非主干 flow 默认从 `lane 1` 往右分配。
- 非重叠分支尽量复用已有 lane。
- 未来已知的 branch head 会提前占位，避免上方 sibling branch 错误复用同一 column。
- 同一 column 不允许出现不同 flow 的纵向混叠，否则会出现“中途变色”。

### 2.4 当前颜色规则

- 颜色由 Go 端分配。
- 同一条 flow 的 node / edge 使用同一个 `color` 编号。
- 前端只消费 `color`，不自行推断 flow 颜色。

---

## 3. 前端职责

### 3.1 渲染入口

- 视图：`frontend/src/views/TimelineNewView.vue`
- 渲染器：`frontend/src/lib/gitgraph/structured.ts`

### 3.2 当前渲染规则

- lane 间距：`LANE_WIDTH = 10`
- 行高：`ROW_HEIGHT = 28`
- 主干在左，分支在右。
- 向右分叉：先斜出，再沿目标 lane 下行。
- 向左回收：先沿当前 lane 下行，再斜回主干。
- 同一 parent 的多条 merge 线会错层回收，避免斜线覆盖。
- 同 lane 被后续其它 flow 复用时，旧 flow 的竖线会在外来节点前截断，避免不同颜色强行连成一根线。

---

## 4. 当前约束

- Git Graph 只以当前结构化实现为准，不再接受“字符流协议必须兼容”的前提。
- 任何关于 lane / color / merge path 的调整，都必须同时看：
  - `app/git/graph/layout.go`
  - `app/git/graph/v27_regression_test.go`
  - `frontend/src/lib/gitgraph/structured.ts`
  - `frontend/src/lib/gitgraph/__tests__/structured.test.ts`

---

## 5. 调试与回归

当前最重要的回归入口：

- 后端：
  - `go test ./app/git/graph/...`
- 前端：
  - `node --test --experimental-strip-types frontend/src/lib/gitgraph/__tests__/structured.test.ts`
  - `pnpm build`

发生以下现象时，优先怀疑 lane 分配而不是 UI 样式：

- 多分支错误进入同一个 column
- 同一 column 中途变色
- 分支明明不重叠却被迫占更右侧空列
- 同一 parent 的多条 merge 线互相覆盖

---

## 6. 非当前实现

以下内容都属于历史方案，不再作为实现依据：

- `git log --graph` 字符流解析
- 前端 `parser.ts` 作为主渲染链路
- `src/main/gitgraph/*` 旧 Electron 路径
- `/timeline-new` 与旧时间轴双轨对比设计
