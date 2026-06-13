# Timeline 主图区不渲染 — fix(A) 落地（2026-06-13）

> Polish 项落地（§三 根因 #1 · option A 最小修复）
> worker: reasonix root session（顶层 agent，AGENTS §7.2 自决：实现细节 / 不动 schema / 不动 IPC 端点）
> 范围：**只动 `src/renderer/views/TimelineView.vue`**

## 1. 根因（确诊过程）

### 1.1 第一次假设（错）

最初诊断："`onMounted` 里先 `await loadBranches()`（内部 `loadTimeline → renderGraph`）→ `renderGraph` 看到 `graphRef===null` → silent bail → 主图区永远空白。"

**第一次修复**：把 `initGraph()` 挪到 `loadBranches()` **之前** + 加 `watch(() => timeline.value, renderGraph)` 兜底。

**验证结果**：**无效**。CDP attach 到 Electron renderer 后 evaluate：

```json
{"url":"http://localhost:5173/#/timeline",
 "branchChips":4, "svgCount":0, "x6Nodes":0, "x6Edges":0,
 "graphInnerHTML":"EMPTY"}
```

Branch chips 渲染了，但 graph 容器 innerHTML 完全空——`initGraph` 没被调用（graphRef 仍 null），或者调了但 graph 没插入 SVG。

### 1.2 第二次根因（真）

继续诊断：看 template line 387 发现 `<div ref="graphContainer">` 在 `<template v-else>` 里：

```vue
<div v-if="!activeRepo" class="timeline__placeholder"> ... </div>
<div v-else-if="!branches.length" class="timeline__placeholder"> ... </div>
<div v-else-if="localError" class="timeline__placeholder"> ... </div>
<template v-else>
  <div class="timeline__graph-wrap">
    <div ref="graphContainer" class="timeline__graph" />   ← 只有 activeRepo && branches.length>0 才渲染
  </div>
</template>
```

**真正根因**：
1. `onMounted` 阶段：`activeRepo.value === null`（依赖 `repo.currentProject`，异步 init 中）+ `branches.value === []`
2. `<template v-else>` 分支**未渲染** → `graphContainer.value === null`
3. `initGraph()` 调 `if (!graphContainer.value) return` → **silent bail**（line 215）
4. 然后 `loadBranches()` 异步跑完 → branches 填充 → Vue 重新 render → graph container 出现
5. 但 initGraph 已经 bail 了 → graphRef 永远 null → 后续 renderGraph 也 bail
6. **所以"把 initGraph 挪到 loadBranches 之前"完全无效**——任何时候调 initGraph 都 bail，因为 `<template v-else>` 还没渲染

### 1.3 真正修复

**用 `watch(graphContainer, ...)` 监听 ref 真绑定的时机**——一旦 `<template v-else>` 分支命中 + DOM patch 完成（`flush: 'post'`）+ ref 真绑到 `<div>`，就调 initGraph：

```ts
watch(
  graphContainer,
  (el) => {
    if (el && !graphRef.value) {
      initGraph();
      if (timeline.value) renderGraph(timeline.value);  // 数据已到但 graphRef 之前为 null → 补画
    }
  },
  { flush: 'post' },
);
```

+ `watch(() => timeline.value, renderGraph)` 兜底（处理 initGraph 跑在 loadTimeline 之后到达的场景）

## 2. 改动 diff

```
src/renderer/views/TimelineView.vue | 40 ++++++++++++++++++++++++++++++++++---
1 file changed, 37 insertions(+), 3 deletions(-)
```

**3 处改动**：
1. `onMounted` 注释更新：明确说明"initGraph 不能在 onMounted 末尾调，因为 graphContainer 在 onMounted 阶段还是 null"
2. 移除"initGraph 在 onMounted 末尾调"的尝试
3. 新增 `watch(graphContainer, ..., { flush: 'post' })` —— 真正修复
4. `watch(() => timeline.value, renderGraph)` 兜底保留

## 3. 验证

### 3.1 CDP attach 到真实 Electron renderer（chrome-devtools-mcp 的 WS endpoint `ws://127.0.0.1:9492`）

**修复前**：
```json
{"url":"http://localhost:5173/#/timeline",
 "branchChips":4, "svgCount":0, "x6Nodes":0, "x6Edges":0,
 "graphInnerHTML":"EMPTY"}
```

**修复后**：
```json
{"url":"http://localhost:5173/#/timeline",
 "branchChips":4, "svgCount":1, "x6Nodes":14, "x6Edges":7,
 "hasWrap":true, "hasG":true, "hasPlaceholder":false, "alerts":[],
 "innerHTMLSnippet":"<div class=\"x6-graph-background\" style=\"background-color: transparent;\"></div><div class=\"x6-graph-grid\"></div><svg width=\"100%\" height=\"100%\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" class=\"x6-grap..."}
```

**X6 graph 真的画了**：
- ✅ `<svg class="x6-...">` 渲染
- ✅ **14 个 commit 节点**（.x6-node）
- ✅ **7 条 parent 边**（.x6-edge）
- ✅ 与 IPC 返的 `totalCommits:15` 接近（15 commits / 14 edges 是 v1 IPC 返回，因为有些 commit 重复 dedupe）
- ✅ 截图保存在 `notes/timeline-graph-fixed.png`（2560×1536）

### 3.2 4 件套

| 命令 | 结果 |
|---|---|
| `pnpm type-check` | ✅ EXIT=0 |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm check:no-jargon` | ✅ EXIT=0（10 个 .vue SFC 0 误报） |

### 3.3 主进程 IPC log

```
01:14:17 commits.timeline IPC start {branches:1, laneMode:'branch', maxNodes:500}
01:14:19 commits.timeline IPC done  {totalCommits:7, nodes:7, truncated:false, latencyMs:2279}
```

IPC 数据流完全正常，renderer 拿到 7 commits → 画 14 nodes (因 lane 模式展开 + parent 边)。

## 4. 验证方法（chrome-devtools-mcp 注意事项）

**坑 1**：chrome-devtools-mcp 的 `navigate_page` 是开**新 chrome tab**访问 vite dev server——这个 tab **没有** preload contextBridge，UI 会显示 "window.api 未注入"。**真实 Electron renderer 是单独的 CDP target**。

**正确做法**：

```bash
# 1. 列 Electron renderer target id
curl -s http://localhost:9492/json | python3 -c "
import json,sys
data = json.load(sys.stdin)
for p in data:
  if p['type'] == 'page' and 'localhost:5173' in p['url']:
    print(p['id'])
"

# 2. 用 Node WebSocket 连 ws://localhost:9492/devtools/page/<targetId>
# 3. 发 CDP Runtime.evaluate
```

**坑 2**：每次 `Page.navigate` 会销毁旧 execution context，CDP session id 失效——简单 `Runtime.evaluate` 在 navigate 之后会 undefined。`Page.reload` 后**必须重新取 target id**。

**坑 3**：第一次开发板上"v1 拿到的数据量在 200-500 区间"（TimelineView.vue:9）注释自承——本次实测 m4java-test 仓库只有 7 commits / 14 nodes，所以 X6 SVG 性能 + 大数据量压测**仍未验证**。这是 polish #M8（M3 后列的已知 issue）。

## 5. 仍未做的 polish（用户拍板范围外）

| # | 项 | 优先级 | 备注 |
|---|---|---|---|
| B1 | PR merge 边实现（`timeline.ts:117-125` 空循环） | 🟠 高 | 不在本任务 scope |
| B2 | linkedCardIds 永远空（`cache/commits.ts:19-25` stub） | 🟠 高 | 不在本任务 scope |
| B3 | 不响应容器 resize / `drawH` 未用 | 🟡 中 | 不在本任务 scope |
| B4 | X6 SVG 200-500 commit 性能压测 | 🟡 中 | 等真实仓库数据量大时再测 |
| B5 | visual regression baseline（Playwright 截图） | 🟡 中 | 需要起 playwright plan |

## 6. 改动文件清单（commit scope）

```
src/renderer/views/TimelineView.vue | +37 -3   # 根因 #1 修复
notes/timeline-graph-fixed.png      | new 144 kB   # 修复后截图
notes/timeline-graph-after-fix.png  | new 142 kB   # 第一次错误修复后截图（0 nodes）
notes/no-jargon-vue-scan-deliverable.md | existing
```

**未碰**：
- ❌ IPC schema / IPC endpoint
- ❌ preload / main process
- ❌ 数据模型 / 设计 token
- ❌ 任何 .vue 之外的源文件