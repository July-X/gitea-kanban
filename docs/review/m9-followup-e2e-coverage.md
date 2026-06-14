# M9 followup — e2e coverage 重新规划（2026-06-14）

> M8 Phase 2 final integration gate 收口（plan_4fcfd20b 状态=completed, commit 73ab246 已落）后，
> 留给后续 plan 拍板的 e2e coverage 项。

## 背景

M7 commit `c1bd4eb` refactor TimelineView 时把 W1 老覆盖范围（repos/branches/commits 端到端）拆到
W2/W3/W4 内对应模块验证，并删除了 `scripts/e2e-verify-w1.ts`（526 行）。M8 final gate 跑 e2e:all 时
发现 `scripts/e2e.sh:73` 漏清理对 W1 脚本的死引用，e2e:all EXIT=1。

**owner 决策（M8 收口时拍板）**：走【清理死引用】路径而非【恢复 W1 脚本】路径，原因：
- W1 是 M7 有意识删的，恢复 526 行 = 回退 M7 部分 refactor + 引入新 fail 风险
- 删 dead ref = 1 行 run_one + 2 行注释改动（最终 4 行含 line 50 同款），scope 最小
- W2 (18/18) + W3 (9/9) + W4 (37/37) 4 次 attempt reproducible 锁死业务层无 regression

**当前状态**：`pnpm e2e:all` 跑 3 个 e2e（W2/W3/W4），全绿。

## M9 决策点

启动 M9 plan 前先问用户：

### 1. W1 脚本是否需要恢复？

W1 老覆盖范围（repos/branches/commits 端到端）当前分散在 W2/W3/W4 中：

| W1 老覆盖模块 | 当前落在 | 状态 |
|--------------|---------|------|
| repos.list IPC 端到端 | W2 board-context | ✅ 间接覆盖 |
| branches.list + switch IPC | W3 timeline | ✅ 间接覆盖 |
| commits.timeline IPC | W3 timeline | ✅ 核心覆盖 |
| 错误处理 / token 失效链路 | W4 auth.disconnect | ✅ 间接覆盖 |

**选项**：
- A. **不恢复 W1**（推荐）：现有 3 套件已覆盖核心 e2e 路径，恢复 W1 收益边际递减
- B. **恢复 W1 但缩 scope**：恢复部分模块（例如只验证 `repos.list` → `branches.list` → `commits.timeline` 链路，砍掉重复模块），避免与 W2/W3/W4 重复
- C. **完全恢复 W1 526 行**：回退 M7 refactor 决策（不推荐，违反"小改动"原则）

### 2. W2/W3/W4 内部是否需要新覆盖维度？

M7 refactor 后 TimelineView 整体重写（lane 色 / 分支 chip / meta 紧凑 / heatmap / 弹窗 footer / 复制按钮 / in-gitea 按钮 hover 等）— 这些是 renderer-only 改动，**e2e 不会自动覆盖**。

**当前覆盖盲区**：
- 时间轴视觉调参过程（lane 12px / heatmap 8min / meta tight 等）— 纯视觉，e2e 覆盖不实际
- 弹窗 footer 上移 + 复制按钮 — 交互层，Playwright 可补
- 弹窗 in-gitea 按钮 hover 样式 — 视觉，CSS 视觉回归可补
- 分支切换防抖（300ms）+ 分支级 commits 缓存 — 行为层，单元测试可补

**选项**：
- A. **不加新维度**（推荐）：renderer-only 改动小且局部，已在 type-check + build 验证范围
- B. **加 Playwright 视觉回归**：截时间轴默认/暗色/lane 调整前后等 5+ 截图（项目已有 notes/cap_timeline_v*.png 系列），代价 4-6 小时
- C. **加分支切换防抖单测**：vitest 覆盖 debounce + cache invalidation，代价 1-2 小时

### 3. W3 schema 警告 (Z1/Z2/Z3) 是否单独修？

W3 e2e 跑时 3 条 known issue schema 警告：
- Z1: `PullDtoSchema.parse(listPullsResp)` 失败（IsoDateSchema 时区）
- Z2: `PullDtoSchema.parse(getPull(11))` 失败（PullDtoSchema）
- Z3: `TimelineDtoSchema.parse(timeline)` 失败（TimelineDtoSchema）

**当前状态**：是 ⚠️ 不是 ❌，不阻塞 PASS verdict。详见 `gitea-js-wrap` memory + AGENTS §7.1。

**选项**：
- A. **M9 单独修**：抽 1-2 小时修 schema 时区 / 字段对齐，避免 tech debt 累积
- B. **M10+ 再修**：优先级低，warning 不影响功能
- C. **保持现状**：等到有用户反馈再修

## 建议

**M9 plan scope 建议**（如启动）：
- 选项 1.A（不恢复 W1）+ 选项 3.A（修 Z1/Z2/Z3 schema 警告）+ 选项 2.C（分支切换防抖单测）
- 总估时 4-6 小时，单 plan 跑完
- 不动 W2/W3/W4 既有 e2e 脚本

**注意事项**：
- M9 plan 启动前需 user 拍板这 3 条决策点（不要替 user 决定）
- Z1/Z2/Z3 schema 修要测 gitea-js 1.23 + PullDtoSchema 实际行为，不要凭记忆改
- 分支切换防抖单测需 mock debounce 计时，避免 flakiness
