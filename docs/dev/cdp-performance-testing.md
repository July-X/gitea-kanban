# 时间轴性能 CDP 测试手册

> 用 Chrome DevTools Protocol（CDP）attach Electron 渲染进程，对 TimelineView 做可复现的性能测量。
> 本手册面向 AI agent 和开发者：排查“时间轴加载慢 / 点击多个分支后卡顿”时使用。

---

## 1. 前置条件

1. 开发模式启动 Electron（会打开 remote debugging 端口 `9492`）：

   ```bash
   pnpm dev
   ```

2. 确认端口可用：

   ```bash
   curl -s http://127.0.0.1:9492/json/list | head -40
   ```

3. 导航到“时间轴”页面（若未自动进入，可从 NavRail 点击）。

---

## 2. 脚本清单（`scripts/`）

所有脚本都是 `.mjs`，直接 `node scripts/xxx.mjs` 运行，**不需要修改业务代码**。

### 2.1 真实分支场景基线

```bash
node scripts/cdp-timeline-perf.mjs
```

- 在当前页面实际存在的分支 chip 上逐一点击。
- 输出：每个分支点击耗时、longtask 列表、Performance metrics。
- 用途：小仓库真实场景下的基线测量。

### 2.2 computed 重算耗时

```bash
node scripts/cdp-measure-computed.mjs
```

- 向 `TimelineView` 注入 500 节点的 mock 数据。
- 输出：`sortedNodes` / `laneXMap` / `heatmap` / `graphPaths` / `commitRows` 等 computed 的首次执行耗时。
- 用途：判断慢是不是 Vue reactive 计算导致。

### 2.3 不同数据规模渲染耗时

```bash
node scripts/cdp-perf-by-size.mjs <节点数>

# 示例
node scripts/cdp-perf-by-size.mjs 500
```

- 注入指定节点数的 mock timeline，测量从 `timeline.value = data` 到 DOM 渲染完成的耗时。
- 输出：`{ size, ms, rows, paths }`。
- 用途：找出前端渲染随数据量增长的趋势。

### 2.4 多分支累加渲染

```bash
node scripts/cdp-perf-multi-branches-v2.mjs
```

- 模拟选中 1/2/4/6/8 个分支，每个分支 200 个 commit，测量总渲染耗时。
- 输出：每个分支数对应的节点总数和渲染毫秒数。
- 用途：验证“点击多个分支后变慢”的前端渲染上限。

### 2.5 IPC / loadTimeline 耗时

```bash
node scripts/cdp-measure-ipc.mjs
```

- 直接调用 `vm.loadTimeline()`，测量 IPC round-trip。
- 输出：`{ ms, nodes, error }`。
- 用途：判断慢是不是主进程 / 网络请求导致。

### 2.6 给 Gitea demo 注入测试分支

```bash
# 默认创建 timeline-test-<timestamp> 分支，30 个 commit
node scripts/cdp-seed-timeline-data.mjs

# 自定义分支前缀和 commit 数量
node scripts/cdp-seed-timeline-data.mjs my-perf-branch 50
```

- 在 `kanban_demo/m4java-test` 仓库创建一个新分支，并基于 main 生成指定数量的 commit。
- 需要本地 Gitea 实例已启动在 `localhost:3000`（任何 Docker 部署 / 自托管实例均可）。
- 环境变量：
  - `GITEA_URL`：默认 `http://localhost:3000`
  - `GITEA_TOKEN`：默认脚本里已填入给 `kanban_demo` 生成的 token；如果 token 过期，可到容器内执行：
    ```bash
    docker compose exec -u git server gitea admin user generate-access-token --username kanban_demo --token-name cdp-test-token --scopes all --raw
    ```
- 用途：给 TimelineView 提供真实、可重复的测试分支，验证“点击多个分支后”的性能。
- **注意**：测试数据会保留在 Gitea 中，不会自动删除。

### 2.7 捕获 Performance Trace

```bash
node scripts/cdp-trace-timeline-v2.mjs
```

- 注入 500 节点 mock 数据，同时用 CDP `Tracing.start/end` 捕获主线程事件。
- 产物：`/tmp/timeline-trace-500.json`。
- 用法：把 json 拖到 Chrome DevTools Performance 面板，或用 `chrome://tracing` 打开。
- 用途：需要火焰图级别分析时使用。

---

## 3. 快速定位流程

```
用户反馈“时间轴点击多个分支后慢”
        │
        ▼
┌─────────────────────────────┐
│ 1. cdp-measure-computed.mjs │
│    computed 是否 > 100ms？   │
└─────────────┬───────────────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
   是                 否
     │                 │
     ▼                 ▼
┌─────────────┐  ┌──────────────────────────┐
│ 优化 computed │  │ 2. cdp-perf-by-size.mjs  │
│ 或虚拟滚动    │  │ 渲染是否随节点数线性暴涨？│
└─────────────┘  └────────────┬─────────────┘
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
                  是                    否
                    │                    │
                    ▼                    ▼
           ┌─────────────┐       ┌──────────────────┐
           │ 虚拟滚动 /  │       │ 3. cdp-measure-  │
           │ 限制首次加载 │       │    ipc.mjs       │
           └─────────────┘       │ IPC 是否很慢？   │
                                 └────────┬─────────┘
                                          │
                                ┌─────────┴──────────┐
                                ▼                    ▼
                              是                    否
                                │                    │
                                ▼                    ▼
                       ┌─────────────┐      ┌─────────────┐
                       │ 加缓存 /    │      │ 检查后端    │
                       │ 减少请求量  │      │ 算法复杂度  │
                       └─────────────┘      └─────────────┘
```

---

## 4. 关键结论（截至 2026-06-13）

- **前端 computed 不慢**：500 节点下 `commitRows` 约 10ms，其余 < 2ms。
- **前端渲染 500 节点约 250ms**，1600 节点约 1s，可接受。
- **真实瓶颈在请求层**：
  - 每次切换分支都会触发 `commits.timeline` IPC。
  - 后端对每个选中分支拉取最多 500 条 commits + 200 条 pulls。
  - `TimelineView.toggleBranch` 原先没有防抖，快速点击多个分支会产生多个并行/排队请求。
- **已做优化**：
  - `TimelineView` 增加 250ms 防抖，合并连续分支切换。
  - `commits.timeline` handler 内增加分支级 commits 缓存（2min TTL）和 pulls 缓存（30s TTL）。

---

## 5. 注意事项

- 这些脚本依赖 `window.__timelineVm` 等内部暴露，**只用于本地性能测试**，不要提交到生产。
- `cdp-perf-by-size.mjs` 注入大数据后，Electron 可能短暂卡顿；建议先在 100/300/500 规模验证。
- 如果 `pnpm dev` 端口不是 `9492`，检查 `src/main/index.ts` 中 `GITEA_KANBAN_DISABLE_REMOTE_DEBUG` 是否被设置。
