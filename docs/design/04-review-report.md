# 设计阶段最终独立 Review（PASS / FAIL gate）

> **审查者**：verifier（独立审查者，不参与任何上游设计任务）
> **审查时间**：2026-06-10
> **审查范围**：`AGENTS.md`、`docs/design/00-overview.md`、`01-research.md`、`02-architecture.md`、`03-frontend.md`、`wireframe/{index,timeline,merge}.html`
> **审查方法**：全量阅读 6 份文档 + 用 playwright 启动本地 http server 渲染 3 个 wireframe 截图核验 + grep 跨文档一致性扫描（tech stack 名 / IPC endpoint 名 / 数据表名 / agent 角色名 / 文件路径 / 术语翻译表）

---

## 1. 总评分

**5 维平均分：3.6 / 5**

**总评一句话**：4 个用户原始需求（多分支提交查看 / 分支管理 / 合并管理 / timeline）全覆盖且非敷衍，gitea 生态贴合度和技术选型质量在独立审视下也都站得住，但**跨文档一致性有 6 处真实不一致**（含 1 处 IPC 数据契约前后端定义不匹配、1 处数据表名前后端不一致、1 处技术栈条目跟其余文档冲突、1 处 "11 张表" 数字错误、2 处 v1→v2 决策残留），**整改清单 6 条 > PASS 阈值 3 条**，按 PASS 条件 → **FAIL**，需修复后重审。

---

## 2. 各维度评语

### 2.1 gitea 生态贴合度：**4 / 5**

**证据**：
- 鉴权借力 gitea 原生 PAT 流程（`02-architecture.md §2.6 + §6.1`），不绕 OAuth2、不另起 session 服务；token 存系统 keychain 而非自建加密。
- 数据源完全透传 gitea REST API（`02 §6.2` 列出 `GET /repos/.../branches|commits|pulls|hooks` 完整清单），不要求用户部署第二份数据源。
- UI 风格借力 gitea 官方色板（主色 `#609926` gitea 绿、强调 `#f76707` gitea 橙——`OVERRIDE.md` 第 18-19 行明确覆盖 MASTER 的 #22C55E 鲜绿），字号 / 圆角 / 表单控件都贴 gitea 视觉。
- 写操作"危险动作二次确认" + "失败跳 gitea 网页处理冲突"（`02 §7.1 第 11 行`）明确引导用户回 gitea 完成 gitea 擅长的部分，而不是另起一套。
- wireframe 截图验证：`merge.html` 的 PR 卡片用 "待合并 / 审核中 / 有冲突 / 已合并 / 已关闭" 五种状态徽章 + SVG 图标 + 文字三重编码（与 OVERRIDE §3 第 5 条"颜色不是唯一信号"一致）；`timeline.html` 多泳道 + commit 节点 + 合并菱形 + 橙色合并边的视觉范式与 gitea 自带 Git graph 保持同形。

**扣分点**：
- 设计 token 完全照搬 gitea 色板，但 gitea 自身的"暗黑模式 + 强调色在不同背景下的对比度"是 gitea 团队维护的；本项目自己写 `#f76707` 在 `--color-bg #ffffff` 和 `#0d1117` 上的对比度没有给具体计算（03 §7.3 第 519 行只算了主文本，状态色只口头说"达标"），可访问性论证不够严谨。
- 没有引用任何 gitea 官方 UI Kit（如 gitea 自己的 [WebKit 主题变量](https://github.com/go-gitea/gitea/blob/main/web_src/css/themes/theme-gitea-dark.css)），未来 gitea 改主色时本项目会脱节。

---

### 2.2 需求覆盖：**4 / 5**

**证据**（按 4 个原始需求逐项核验）：

| 用户原始需求 | 覆盖位置 | 深度评估 |
|---|---|---|
| **多分支提交记录查看** | `02 §5.3.4 commits.timeline`（`TimelineArgs` + `TimelineNode` + `TimelineEdge`）+ `03 §5 CommitTimeline`（4.1-4.5 详尽）+ `wireframe/timeline.html` 截图：4 lane × 6+ commit 节点 + 橙色合并边 | ✅ 完整：聚合多分支 DAG / PR 合并边 / lane 过滤 / hover tooltip / 双击跳 gitea |
| **分支管理** | `02 §5.3.2 branches.{list,create,rename,delete,star}` + `§7.1 第 3-5 行`（创建/重命名/删除的写流程 + 二次确认）+ `03 §4.3 BranchList + §4.7 BranchManager` | ✅ 完整：列表/收藏/创建/删除/重命名/保护设置，但**重命名** `02 §7.1 第 4 行` 写"gitea 实际不支持直接 rename API，v1 不实现，仅在 UI 提示'到 gitea 页面操作'"——这个降级方案用户需提前知道 |
| **合并管理** | `02 §5.3.5-6 pulls.{list,get,create,merge}` + `§7.1 第 9-12 行` + `03 §4.6 MergePanel` + `wireframe/merge.html` 截图：合并方式选择 + 二次确认 + 冲突禁用 + 跳 gitea | ✅ 完整：合并方式三选（普通/变基/压缩）+ hover 解释 + 冲突检查 + 二次确认 + 权限校验 |
| **timeline** | 已在"多分支提交记录查看"行覆盖；额外补 `03 §5.3 视觉编码表 + §5.4 交互 + §5.5 性能与降级（500/2000/10000/>10000 四档）` | ✅ 完整：性能降级方案成体系 |

**扣分点**：
- 用户原始需求里没明说"看板"，但设计文档把看板当作主轴（`00 §2 特性 2`、`02 §5.3.7-8`、`03 §4.5 KanbanBoard`），范围扩张了——好在 `02 §7.1 第 13-15 行` 把"卡片绑定 commit/PR"和"卡片可提升为 PR"做成了看板与 git 数据之间的桥，把扩张范围控制在合理半径内，但用户 review 时仍需拍板"看板是不是 v1 必做"。
- 4 个需求在文档里都覆盖到了，但**没有把"v1 必须做到什么程度"和"v2 再做的"明确切开**——除了 `00 §6 M0~M3 路线图` 给了大致阶段，但具体到"timeline 在 v1 是只渲染主分支 + 最近 30 天" vs "v2 才支持 author / PR 维度 lane" 这种切片，看不出。在用户决策"v1 半年内"约束下，会埋"什么都想做但什么都做不完"的风险。

---

### 2.3 技术选型合理性：**4 / 5**

**证据**：
- **Electron + TS**：合理；`02 §2.1` 给的三个理由（单二进制、跨平台、与本地资源零摩擦）都站得住。
- **React + Vite + Zustand + CSS Modules**：合理；`03 §7.1` 显式给出"不选 Tailwind/styled-components/Emotion/Sass"的 4 条理由（类名爆炸、运行时开销、编译依赖），不是凭感觉。
- **AntV X6@3.1.7**：合理；`01 §4 + §5` 给出 4 个候选库横评，理由（用户已熟悉栈 / git graph 是图编辑引擎甜区 / MIT / 性能可控）扎实。但**版本钉死 3.1.7** 留了个隐患——AntV X6 当前主线是 v2（v2.x 已发布），v3.x 是老稳定线（参考 https://x6.antv.antgroup.com/）；钉 3.1.7 意味着新功能不会进，v2 重写时是 breaking change。`01 §5.1` 最后一句"X6 v4 升级时要重新评估 React 适配深度" 也提示了这个风险，但没有行动项。
- **better-sqlite3 + Drizzle + drizzle-kit**：合理；同步 API + schema-first + 迁移工具链成熟是真实收益。`02 §2.3` 还给了 `keytar` 维护停滞的备选 `@napi-rs/keyring`——预案到位。
- **openapi-fetch 而非官方 Go SDK**：合理（决策记录里早就把 Go SDK 否决了），`02 §2.3` 给出"轻量、零运行时依赖膨胀、优先用 gitea 自带 OpenAPI 生成类型"三个理由。
- **keytar**：合理但**有维护风险**——keytar 上次 release 是 2022 年（参考 https://github.com/atom/node-keytar），已无人维护。`02 §2.3` 自己提了备选 `@napi-rs/keyring`，但没列入 v1 必做。
- **simple-git**：v1 默认不走，留口子——合理。

**扣分点**：
- AntV X6 v3 与 v2 主线的版本断层是真实风险，文档没给出"如果 X6 突然停更怎么办"的明确行动项（`01 §4` 只说"v2 短期 G6@5 替代 / 性能爆发期 D3 自绘"是模糊预案，没有责任人 / 触发条件）。
- keytar 维护停滞是已知事实，`02 §2.3` 提到"后续若 keytar 维护停滞可换 @napi-rs/keyring"——但**没有把"换 keyring"列入 M0/M1 的任务**，意味着开工后才会临时决策。
- 渲染进程状态管理选 Zustand（`03 §6.1` 给的 4 条理由没问题），但 `02 §2.2` 没说"Zustand 跟 IPC bridge 的中间层"——前端 agent 开工时会有"Zustand store 直接调 window.api 还是封一层"的设计岔路。

---

### 2.4 可落地性：**3 / 5**

**证据**：
- `02 §8.5` 给了 15 个 plan 子任务（已 grep 验证数量准确），每个子任务有输入 / 输出 / 负责 agent——这是 mavis team plan 的现成拆分骨架。
- `02 §3` 给了完整的目录树（与 AGENTS.md §3 完全一致），未来初始化仓库时可直接照搬。
- `02 §4` 给了 13 张 Drizzle schema（grep 验证），schema-first 风格可以直接 `drizzle-kit generate` 出 migration——**前提是前端 agent 知道是 13 张表不是 11 张**（见 §3 不一致 #1）。
- `02 §5.3` 给了完整的 IPC endpoint TS interface 草案（10 个 namespace），未来 Zod schema 编写有参照。
- 错误码表（`02 §5.4`）10 个业务错误码 + 中文 hint 模板齐全。
- 性能目标（`02 §9.1`）给了具体数字（启动 ≤3s / 仓库列表首屏 ≤1s / X6 2000 节点 ≤4s 等），未来压测有目标。

**扣分点**：
- **`02 §5.3.4 TimelineDTO` 和 `03 §5.2 TimelineData` 是两份不同的数据结构**——02 用 `nodes/edges/truncated/windowStart?/windowEnd?` + 内嵌 `branchHints[]`，03 用 `range/lanes/nodes/edges/prs` + 拆出 `Lane/CommitNode/ParentEdge`。**字段命名和层级都不一样**——前端 agent 按 03 接 IPC 后端会字段全无（`TimelineDTO` 没有 `lanes`，`TimelineData` 没有 `branchHints`）。这是**最严重的可落地性阻塞**。
- **`03 §4.5` 和 `03 §5.2` 用 `card_commits(card_id, sha, repo_id)` 单表**，`02 §4.2` 实际是 `gitea_refs + card_links` 多对多。前端 agent 如果按 03 的 `card_commits` 落代码会找不到表。
- `03 §3` 假设的 IPC channel（`repo:list` / `card:create` / `pr:merge` 等"资源:动作"风格）和 `02 §5.1` 定下来的（`repos.list` / `board.cards.create` / `pulls.merge` 等"namespace.method"风格）大量名字不同——AGENTS.md §6 第 356 行已显式说明这个差异，但 `03 §3` 表格本身没标"（最终命名以 02 §5.1 为准）"的提醒，前端 agent 抄写时大概率会按 03 假设去实现。
- `02 §2.2` 第 128 行写 "**Radix UI Primitives + Tailwind CSS**"——`03 §7.1` 明说"**不选** Tailwind"，AGENTS.md §43 明说"**不引** Tailwind"，00-overview §90 也写"CSS Modules"。**2/4 处文档已统一成"不引 Tailwind"，唯独 02 §2.2 一行没改**。前端 agent 看 02 §2.2 会装 Tailwind。
- `02 §1` 架构图第 49 行 `GitOps[gitea 集成<br/>go-sdk via HTTP / TS fetch]` 残留"go-sdk"——go-sdk 早被否决（决策记录 #1），应改为 `TS fetch + openapi-fetch`；第 222 行 `window.ts` 注释里"OAuth 窗预留"——决策记录 #3 明说不做 OAuth，应删除。
- 没有"验收清单 + 自动化验证脚本"——`02 §8.4` 给的 9 条验收项仍是手测/grep，没有"在 CI 跑什么命令失败就阻断 merge"的硬卡点（"零术语"靠 `pnpm check:no-jargon`，但这个脚本本身不存在，只是声明）。
- 移动端降级在 `01 §4` 提了，00 §6 M3 提了，但**没在 M0/M1/M2 任一阶段给具体动作**——M0/M1/M2 阶段实施时移动端会被忘掉。

---

### 2.5 AGENTS.md 完整性：**4 / 5**

**证据**：
- 318 行覆盖 9 节（项目概述 / 技术栈 / 目录树 / 开发规范 / 团队角色 / 接口契约锚点 / 文档索引 / 工作流约束 / 陷阱），未来 mavis team plan 的角色边界（后端 = 主进程 / 前端 = 渲染进程+IPC / verifier / orchestrator）写得很清楚。
- §4 开发规范（commit 中文 / type 限定 7 种 / worker 不准自己 commit / commit 必须落 master）很完整。
- §7 必走用户的 10 条"不决"事项 + §7.2 自决事项的划分精确。
- §8 7 条陷阱（X6 回调签名铁律、token 不出主进程、零术语 + 二次确认铁律、Edit tool 替换块不完整等）——都是前序 design 任务踩过的坑，写得很到位。
- §5.5 接口契约文件清单明确把 `src/shared/ipc-types.ts` 定为 single source of truth，并把前后端各自的可写边界（后端写 schema、前端只 import）讲清楚。

**扣分点**：
- `AGENTS.md §6 第 331 行` 和 `§7 第 369 行` 写"11 张表"——02 §4 实际有 **13 张表**（已 grep 验证 `users / gitea_accounts / repo_projects / boards / board_columns / cards / gitea_refs / card_links / starred_branches / prefs / undo_entries / cache_entries / hook_deliveries`）。AGENTS 是 mavis team plan 的合同之一，数字错了未来后端 agent 照着做会少建两张表。
- §3 目录树把 `src/main/notify/` 拆成 `os.ts` + `rules.ts` 两个文件，但 `02 §3` 目录树也写了 `notify/`——OK 一致。
- §6 第 356 行举的 IPC endpoint 例子 `'gitea.repos.list'` / `'board.cards.create'` 跟 §6 第 335 行举的 `'repos.list'` / `'board.cards.list'` 不一致（一个带 `gitea.` 前缀一个不带）——`02 §5.1` 命名约定清单里也没有 `gitea.` 前缀，仅 `02 §5.3.1` 第 670 行 `'gitea.repos.list'` 一处用了前缀（其余 endpoint 全部不带），这是 02 自己内部的不一致，AGENTS 转抄时把矛盾保留下来了。
- §8.1 "v1 → v2 修正（2026-06-10）：原计划是 React Web + Go 后端 + SQLite + nginx 反代，被用户改为 Electron + TS 桌面应用 + PAT + keychain"——但实际 `01-research.md §5.2 + §5.3 + §5.4` 整节还在推荐 "Go + Gin + go-sdk" + "SQLite 默认 + PostgreSQL 可选" + "独立服务 + nginx 反代到 gitea 同域"。AGENTS 自己说"如果看到老文档提到 Go 后端 / OAuth 跳转 / nginx 反代，**一律忽略**"——但 01 是设计阶段的调研报告（**不是老文档**），是这次交付物之一，verifier 看到的是**当前最新版本的 01 文档还在推荐 Go + nginx 反代**。这违反了"old doc vs new doc"假设。

---

## 3. 跨文档一致性扫描结果

| # | 不一致类型 | 文档 A | 文档 B | 详情 |
|---|---|---|---|---|
| 1 | **数据表数 vs 文档声明** | `AGENTS.md §6:331` + `§7:369`（"11 张表"） | `docs/design/02-architecture.md §4`（实际 13 张 sqliteTable：users / gitea_accounts / repo_projects / boards / board_columns / cards / gitea_refs / card_links / starred_branches / prefs / undo_entries / cache_entries / hook_deliveries） | AGENTS 数字错 |
| 2 | **技术栈条目冲突（最高严重度）** | `02-architecture.md §2.2:128`（"Radix UI Primitives + **Tailwind CSS**"） | `03-frontend.md §7.1:416`（"**不选 Tailwind**"） + `AGENTS.md §43`（"**不引 Tailwind**"） + `00-overview.md §90:90`（"CSS Modules"） | 02 一行未同步 |
| 3 | **IPC 契约前后端结构不匹配**（最高严重度） | `02-architecture.md §5.3.4 TimelineDTO` | `03-frontend.md §5.2 TimelineData + Lane + CommitNode + ParentEdge` | 字段 / 层级不一致，前端按 03 落地会字段全无 |
| 4 | **数据表名前后端不一致** | `03-frontend.md §4.5:230` + `§5.2:316`（"card_commits" 单表） | `02-architecture.md §4.2:482+495`（"gitea_refs + card_links" 多对多） | 前端落代码会找不到表 |
| 5 | **v1→v2 决策残留** | `02-architecture.md §1:49`（"gitea 集成 go-sdk via HTTP / TS fetch"） | 用户决策 #1（Electron+TS，已否决 Go SDK） | 旧方案残留 |
| 6 | **v1→v2 决策残留** | `02-architecture.md §3:222`（"BrowserWindow 管理（主窗 + 设置窗 + **OAuth 窗预留**）"） | 用户决策 #3（明说不做 OAuth 跳转） | 旧方案残留 |
| 7 | **IPC 命名风格冲突** | `02 §5.1`（"`<namespace>.<method>` 如 `repos.list`"）+ AGENTS §6:335 | `03 §3:135-150`（"资源:动作"如 `repo:list` / `card:create`） | AGENTS §6:356 已显式说明，但 03 §3 表格未标"以 02 §5.1 为准"提醒 |
| 8 | **IPC endpoint 示例不一致** | `02 §5.3.1:670`（`'gitea.repos.list'` 带前缀） | `02 §5.1:592-601` + `02 §5.3.2-9`（其余 endpoint 全部不带 `gitea.` 前缀） + AGENTS §6:335（无前缀） | 02 自己内部一处例外 |
| 9 | **术语翻译表覆盖不一致** | `OVERRIDE.md §36-45`（9 项：PR/merge/branch/commit/fork/issue/repo/maintainer/reviewer） | `02 §2.7:188-194`（6 项：PR/merge/rebase/squash/force push/protected branch） + `03 §1.3:54-69`（11 项） | 三处互为子集，无 single source of truth |
| 10 | **调研报告未与最终决策同步** | `01-research.md §1.2 + §5.2-5.4`（整篇推荐 Go+Gin+go-sdk+nginx 反代） | 用户决策 #1（Electron+TS+PAT+keychain，已改） | 调研时未和最终决策同步，AGENTS §8.1 说"old doc 一律忽略"是错的，01 是当前交付物 |

---

## 4. 必须整改的问题清单

> 整改清单共 **6 条**（PASS 阈值 3 条，超阈值）→ **FAIL**。
> 建议整改顺序：先修 #1 + #3 + #4（合同级阻塞）→ #2 + #5 + #6（一致性遗留）→ 复审。

| # | 文档路径 | 原文摘录 | 问题 | 建议改法 |
|---|---|---|---|---|
| **1** | `AGENTS.md §6:331` + `§7:369` | "11 张表 + 关系 + Drizzle schema"、"`docs/design/02-architecture.md` §4 的 **11 张表** schema 变更" | 02 §4 实际有 **13 张表**（users/gitea_accounts/repo_projects/boards/board_columns/cards/gitea_refs/card_links/starred_branches/prefs/undo_entries/cache_entries/hook_deliveries），AGENTS 数字错了 | 把 §6:331 和 §7:369 的 "11 张表" 改为 "13 张表" |
| **2** | `docs/design/02-architecture.md §2.2:128` | "**UI 组件库** \| **Radix UI Primitives + Tailwind CSS** \| 无样式强约束、易于做"零术语"自定义；不引 antd（视觉太重）" | 与 `03 §7.1` 明说"**不选** Tailwind"、`AGENTS §43` 明说"**不引** Tailwind"、`00 §90` 写"CSS Modules" 三处冲突 | 改为 "**UI 组件库** \| **Radix UI Primitives + CSS Modules** \| 无样式强约束、易于做零术语自定义；不引 antd（视觉太重）；不引 Tailwind（类名爆炸）" |
| **3** | `docs/design/03-frontend.md §5.2:286-329` | `TimelineData = { range, lanes, nodes, edges, prs }` + `Lane/CommitNode/ParentEdge` 类型定义 | 与 `02 §5.3.4:727-758` 的 `TimelineArgs/TimelineNode/TimelineEdge/TimelineDTO` 字段 / 层级不一致（02 没有 `lanes`、03 没有 `branchHints/truncated/windowStart?`），前端按 03 接 IPC 会字段全无 | 二选一：① 让 03 把 `TimelineData` 改为与 02 §5.3.4 `TimelineDTO` 兼容（添加 `branchHints/truncated/windowStart?`，删除 `lanes/prs` 或把它们移到独立 IPC），02 把 `TimelineEdge.kind` 仍保留 'parent' \| 'merge'；② 让 02 把 `TimelineDTO` 改为与 03 一致（添加 `range/lanes/prs` 顶层、删除 `branchHints/truncated/windowStart?`）；**推荐 ②**——03 §5.4 的 lane 过滤、节点过滤、PR 标签都依赖 `lanes/prs`，结构更贴合 X6 渲染 |
| **4** | `docs/design/03-frontend.md §4.5:230` + `§5.2:316` | "关联 commit 存 `card_commits(card_id, sha, repo_id)`"、"// 关联到本地卡片（来自 card_commits 表 join）" | `02 §4.2:482-504` 实际是 `gitea_refs` + `card_links` 多对多（`gitea_refs.kind` ∈ {commit/pr/branch/issue}，`card_links` 多对多到 cards），前端按 03 落代码会找不到表 | 把 §4.5 改为 "关联 git 对象存 `card_links` 多对多 + `gitea_refs(kind, owner, repo, ref_id, cachedTitle?)`；commit / PR / branch / issue 都通过 kind 字段统一"；把 §5.2 第 316 行 `linkedCardIds` 注释改为 "关联到本地卡片（来自 card_links JOIN gitea_refs）" |
| **5** | `docs/design/02-architecture.md §1:49` | `GitOps[gitea 集成<br/>go-sdk via HTTP / TS fetch]` | 用户决策 #1 否决 Go SDK，"go-sdk" 是旧方案残留 | 改为 `GitOps[gitea 集成<br/>openapi-fetch + 手写 TS 类型]` |
| **6** | `docs/design/02-architecture.md §3:222` | `├── window.ts                 # BrowserWindow 管理（主窗 + 设置窗 + OAuth 窗预留）` | 用户决策 #3 明说不做 OAuth 跳转，"OAuth 窗预留" 与决策冲突 | 改为 `├── window.ts                 # BrowserWindow 管理（主窗 + 设置窗 + 通知窗预留）` |

### 4.1 建议但非必须整改（次要）

| 文档路径 | 原文摘录 | 建议 |
|---|---|---|
| `docs/design/01-research.md §1.2 + §5.2-5.4` | 整篇推荐 "Go + Gin + go-sdk" + "SQLite 默认 + PostgreSQL 可选" + "独立服务 + nginx 反代" | 在 01 文档头部加一行"注意：本调研报告完成于 v1 决策切换前（2026-06-10），后续用户决策 #1 已将技术栈改为 Electron + TS + PAT + keychain；本章 §5 选型候选已作废，最终方案见 02-architecture §2 与 AGENTS §2" |
| `docs/design/02-architecture.md §5.3.1:670` | `'gitea.repos.list': ...` | 与 §5.1 命名约定和 §5.3.2-9 其余 endpoint 保持一致，删除 `gitea.` 前缀，改为 `'repos.list'` |
| `design-system/gitea-kanban/OVERRIDE.md §36-45` | 9 项翻译表 | 补充 rebase/squash/force push/protected branch/main/WIP（02 §2.7 翻译表已有），让 OVERRIDE 成为真正的 single source of truth；03 §1.3 翻译表也可合并 |
| `docs/design/02-architecture.md §2.3` 关于 keytar | "后续若 keytar 维护停滞可换 `@napi-rs/keyring`" | 把"评估并决策 keyring 替换"列入 M0 任务（02 §8.5 还没有这条），明确责任人和触发条件 |
| `AGENTS.md §8.1` | "如果看到老文档提到 Go 后端 / OAuth 跳转 / nginx 反代，**一律忽略**" | 改为"如果看到 01-research §5 提到 Go 后端 / nginx 反代 / OAuth 跳转，**一律忽略**——以本文件 §2 为准"，避免未来 verifier 误把 01 当"old doc" |
| `docs/design/02-architecture.md §1:54` | `OptionalWH[可选 webhook server<br/>仅高级用户开]` | 与 §6.3 "v1 默认不开 webhook server" + §6.4 "v2 才提供" 一致，但命名"可选"容易误解，改为 `WebhookServer[webhook server<br/>v2 才启用，v1 走轮询]` |

---

## 5. 最终 verdict

**FAIL**

理由（按 PASS 条件逐条核验）：

| PASS 条件 | 核验结果 |
|---|---|
| 4 个用户需求全覆盖 | ✅ 通过：多分支提交查看 / 分支管理 / 合并管理 / timeline 均覆盖 |
| 5 维平均分 ≥ 3.5 | ✅ 通过：3.6 / 5 |
| **无跨文档不一致** | ❌ **不通过**：发现 **10 处不一致**（6 条整改 + 4 条次要建议） |
| 整改清单 ≤ 3 条 | ❌ **不通过**：**6 条**必须整改（最高严重度 3 条：#1 表数错误 / #3 Timeline 契约 / #4 卡片关联表名；普通 3 条：#2 Tailwind / #5 go-sdk / #6 OAuth 窗） |

按 PASS 条件"4 项中任一不满足即 FAIL" → **FAIL**。

---

## 6. 给用户的下一步建议

**判定为 FAIL**，建议按以下顺序重跑：

1. **先把最高严重度 3 条修了**（这是 plan 开工就会卡的阻塞）：
   - 修 #3（Timeline 契约）：让后端 agent（`02` 维护者）和前端 agent（`03` 维护者）协商一个统一方案，**推荐把 02 §5.3.4 TimelineDTO 改为与 03 §5.2 TimelineData 兼容**——理由是 03 的 `lanes/prs` 结构更贴合 X6 渲染管线（lane 过滤、PR 标签、节点分组都依赖 lanes），且 02 现有的 `branchHints/truncated/windowStart?` 都可以作为 `TimelineData` 的扩展字段加进去；改完再让 02 §5.3.4 重写
   - 修 #4（card_commits → card_links+gitea_refs）：让 03 维护者把 §4.5 + §5.2 改为引用 02 §4.2 的表名和字段
   - 修 #1（11 → 13 张表）：让 AGENTS 维护者改 §6:331 + §7:369

2. **再修普通 3 条**（不影响 plan 启动，但开工后会成为埋雷）：
   - 修 #2（02 §2.2 Tailwind → CSS Modules）
   - 修 #5（02 §1 架构图 go-sdk → openapi-fetch）
   - 修 #6（02 §3 OAuth 窗预留 → 通知窗预留）

3. **次要建议 6 条**由维护者视情况处理；其中**01-research 加过时声明 + OVERRIDE 翻译表补全 rebase/squash 等**这两条强烈建议做，否则未来 oncall agent 翻 01 文档会按旧方案推荐。

4. **整改完后**回到我这里复审，我会在 1 小时内给出 PASS verdict。

5. **PASS 后建议用户 review 顺序**（如果未来走到 PASS）：
   1. 先看 `00-overview.md`（5 分钟大局）
   2. 再看 `01-research.md` §4 timeline 方案对比 + §5 技术决策（确认选型理由被说服）
   3. 然后看 `02-architecture.md` §5 IPC 契约 + §4 数据模型（确认 DTO 和表名符合预期）
   4. 最后看 `03-frontend.md` §1 设计原则 + §5 timeline 视觉编码（确认 UI 风格）
   5. 全程参考 `wireframe/{index,timeline,merge}.html` 视觉

---

> **reviewer 是 read-only**，本任务未修改任何其他文档；仅落盘 04-review-report.md。