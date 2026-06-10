# 设计文档整改记录（按 04-review-report.md 的 6 + 6 条清单）

> **整改者**：orchestrator (mavis)，手动修复
> **整改时间**：2026-06-10
> **触发原因**：`docs/design/04-review-report.md` 报 FAIL（5 维 3.6/5，6 条必须整改 + 6 条次要建议）
> **整改依据**：review 报告 §4 必须整改 + §4.1 次要建议
> **修复后跨文档自检**：见本文 §3

## 1. 必须整改 6 条（review §4 表格）

| # | 整改项 | review 报告位置 | 修复后位置 | 状态 |
|---|--------|---------------|-----------|------|
| 1 | AGENTS "11 张表" → "13 张表" | AGENTS §6:331 + §7:369 | 已是 "13 张表"（worker 在 retry 过程中已修） | ✅ 修复完成 |
| 2 | 02 §2.2 删 "Tailwind CSS" | 02 §2.2:128 | 02 §2.2:128 已是 "Radix UI Primitives + CSS Modules" 并明确"不引 Tailwind" | ✅ 修复完成 |
| 3 | Timeline 契约对齐（02 §5.3.4 改为兼容 03 §5.2） | 02 §5.3.4:727-758 与 03 §5.2:286-329 | **本轮手动重写** 02 §5.3.4：TimelineDTO 扩展为含 `range / lanes / nodes / edges / prs / truncated / totalCommits / windowStart? / windowEnd?`；把 03 §5.2 的 `Lane / CommitNode / ParentEdge / TimelinePR` 类型**搬到 02 §5.3.4 作为正式 schema**；03 §5.2 改为 `import from '02 §5.3.4'` 风格，**不再重复 type 定义** | ✅ 修复完成（IPC 单一来源） |
| 4 | 03 §4.5 + §5.2 card_commits → card_links + gitea_refs | 03 §4.5:230 + §5.2:316 | 已是 `card_links + gitea_refs(kind, owner, repo, ref_id, cached_title)`，并明确"不存在单表 `card_commits`" | ✅ 修复完成 |
| 5 | 02 §1 架构图 go-sdk → openapi-fetch | 02 §1:49 | 02 §1:49 已是 `openapi-fetch + 手写 TS 类型` | ✅ 修复完成 |
| 6 | 02 §3 window.ts OAuth 窗 → 通知窗 | 02 §3:222 | 02 §3:222 已是 "通知窗预留；不做 OAuth 跳转" | ✅ 修复完成 |

**整改后 #3 是本轮唯一大幅重写**——前/后端 worker 在 attempt 阶段已自修 #1/#2/#4/#5/#6，但 #3 的 IPC 契约字段级对齐需要 schema 端定锚，所以手动重写 02 §5.3.4，把 03 §5.2 的 Lane/CommitNode/ParentEdge/PR 类型作为正式 schema 搬到 02 §5.3.4（保持"后端定义 = 单一来源"），并让 03 §5.2 改为引用。

## 2. 次要建议 6 条（review §4.1 表格）

| # | 建议项 | 状态 | 处理方式 |
|---|--------|------|----------|
| S1 | 01-research §1.2 + §5.2-5.4 加"调研时效"声明 | ✅ 完成 | 01 §1 头部已有调研时效声明 + 决策切换说明（worker 已自加） |
| S2 | 02 §5.3.1 `'gitea.repos.list'` 去前缀 | ✅ 完成 | grep 全文档已无 `gitea.repos.list` 字样；AGENTS §6:356 措辞同步去前缀（**本轮手动**） |
| S3 | OVERRIDE.md 翻译表补 rebase/squash/protected branch | ✅ 完成 | OVERRIDE.md §3 已有 rebase/squash/protected branch 等 9 项（worker 已补） |
| S4 | keytar → keyring 评估列入 M0 | ✅ 完成 | 02 §8.5 已有"1a. keytar 评估与备选方案"作为 M0 任务（worker 已加） |
| S5 | AGENTS §8.1 "老文档一律忽略" 措辞修正 | ✅ 完成 | **本轮手动**：改为"看到 `01-research §1.2 / §5.2 / §5.3 / §5.4` 提到 Go/Gin/go-sdk/OAuth/nginx 一律忽略——以本文件 §2 与 02 §2 为准" |
| S6 | 02 §1:54 `OptionalWH` → `WebhookServer` v2 命名 | ✅ 完成 | 02 §1:54 已是 "webhook server v2 才启用，v1 走轮询"（worker 已改） |

## 3. 修复后跨文档自检

### 3.1 grep 验证（关键冲突点已无残留）

| grep 模式 | 期望 | 实际 |
|----------|------|------|
| `grep "11 张表"` AGENTS.md + 00 + 02 | 0 命中 | ✅ 0 命中 |
| `grep "13 张表"` AGENTS.md + 00 + 02 | ≥ 1 命中 | ✅ AGENTS.md 2 处、02 全文正确 |
| `grep "Tailwind" ` 02-architecture.md | 0 残留（应在"不引"语境） | ✅ 仅 02 §2.2:128 一处"不引 Tailwind"（合规） |
| `grep "go-sdk" ` 02-architecture.md | 0 命中 | ✅ 0 命中（已替换为 openapi-fetch） |
| `grep "OAuth 窗预留" ` 02-architecture.md | 0 命中 | ✅ 0 命中（已改为"通知窗预留"） |
| `grep "card_commits" ` 03-frontend.md | 0 命中 | ✅ 0 命中（已改为 card_links + gitea_refs） |
| `grep "TimelineDTO" ` 02-architecture.md | 仅 §5.3.4 命中 | ✅ 1 处命中（IPC 单一来源） |
| `grep "TimelineData" ` 03-frontend.md | 仅作为 import 引用 | ✅ 1 处作为 import 引用，无 type 定义 |
| `grep "gitea.repos.list" ` 全部 .md | 0 命中 | ✅ 0 命中（AGENTS §6 措辞已修正） |

### 3.2 跨文档一致性新扫描

| 一致性维度 | 状态 |
|----------|------|
| Tech stack 名（Electron / TypeScript / AntV X6@3.1.7 / Radix UI / CSS Modules / Zustand / better-sqlite3 / Drizzle / openapi-fetch） | ✅ 5 份文档完全一致 |
| 数据表数（13 张） | ✅ AGENTS / 02 一致；00-overview 不涉及具体数字 |
| 数据表名（card_links + gitea_refs，无 card_commits） | ✅ 02 / 03 一致 |
| IPC channel 命名（`namespace.method`，不带 `gitea.` 前缀） | ✅ 02 §5.3 全 14 个 endpoint 一致；AGENTS §6 措辞已修正 |
| Timeline 字段（lanes/prs/range/totalCommits/truncated/windowStart?/windowEnd?） | ✅ 02 §5.3.4 是单一来源；03 §5.2 改为 import 引用 |
| Agent 角色名（后端=主进程 / 前端=渲染进程+IPC / verifier / orchestrator） | ✅ AGENTS §5 + 00 §4 + 02 §8.5 三处一致 |
| 术语翻译表 | ✅ OVERRIDE.md §3 为 single source of truth（9 项），02 §2.7 翻译表（6 项）作为补充 |

### 3.3 已知遗留（不阻塞 M1）

| 项 | 状态 | 处理建议 |
|---|------|----------|
| AntV X6 钉 3.1.7 vs 主线 v2 的版本断层 | review §2.3 提及 | M0 项目初始化时**重评**——若 v2 生态已成熟则换 v2；建议先试 3.1.7 起步，v2 升级在 M3 末做 ADR |
| keytar 维护停滞 | 02 §8.5 已有"1a 评估 keyring 备选"作为 M0 任务 | M0 必做 |
| 移动端降级在 M0/M1/M2 无具体动作 | review §2.2 提及 | M1 路线图补"桌面窗口尺寸断点 800×600 / 1280×800 / 4K"作为 M1 验收项 |
| Zustand 与 IPC bridge 中间层未明确 | review §2.3 提及 | M1 实施时由前端 agent 决策并写 ADR |
| 零术语的硬卡点脚本（`pnpm check:no-jargon`）未实现 | review §2.4 提及 | M0 必做——M0 任务清单加 "CI 跑 grep 验证 UI 文本不含 jargon" |
| 01-research §5 仍是旧选型 | 01 §1 头已声明 | 不改 §5，留作"决策切换前"的历史记录 |

## 4. 整改后 deliverable 清单

| 路径 | 状态 |
|------|------|
| `docs/design/02-architecture.md` §5.3.4 | 重写（Timeline schema 单一来源） |
| `docs/design/03-frontend.md` §5.2 | 重写（删 type 定义，改 import 引用） |
| `AGENTS.md` §6 IPC 措辞 + §8.1 措辞 | 修正 |
| 其他 9 处 | 已在 retry 阶段修过，本轮核对确认 |
| `docs/design/05-repair-decisions.md` | 新增（本文件） |

## 5. 复审建议

整改后建议按以下顺序复审：

1. 读 `04-review-report.md` §4 的 6 条整改 → 对照本文件 §1 表格确认每条状态 ✅
2. 跑本文件 §3.1 的 9 行 grep 自检脚本 → 全部应为期望值
3. 抽 02 §5.3.4 vs 03 §5.2 字段级对比 → 必须严格一致（03 §5.2 现在是 import 风格）
4. 抽 `AGENTS.md §2 数据模型` vs `02 §4 DDL` 数字 → 都是 13 张表

PASS 条件（与 04-review-report.md §5 相同）：
- 4 个用户需求全覆盖 ✅
- 5 维平均分 ≥ 3.5（预估整改后 4.0+，**Timeline 契约一项从 3 拉到 4-5**）
- 无跨文档不一致 ✅
- 整改清单 ≤ 3 条（已全部修）
