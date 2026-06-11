# ADR-0002: Board 数据模型 reset — 弃用 gitea projects API，改用 gitea-kanban 本地概念 + gitea issues 当卡片源

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-06-11 |
| 决策者 | xingxing.zhong + Mavis |
| 替代 ADR | 无 |

## 背景

gitea-kanban 设计文档（`02-architecture.md §4` / `§5.3` + AGENTS §5.5）拍板的"13 张表" + "12 个 board.* IPC 端点"**假设 gitea 有 REST API 暴露项目看板功能**（projects / columns / cards）。在 2026-06-11 实测验证 gitea 1.26.2 真实情况后，**这个假设不成立**。

## 实测证据（2026-06-11）

1. **gitea 1.26.2 swagger 300 个 path，0 个 project/board/column 端点**——通过 `GET /swagger.v1.json` 拉全量，grep `project|board|column` 命中 0。
2. **gitea 官方 1.26.2 yaml 文档**（`docs/plugin-redoc-2.yaml` 22413 行 / 615KB）只有 `has_projects` / `projects_mode` / `repo.projects` 这种**配置 / 权限字段**，无 projects REST endpoint。
3. **web UI"项目"页签存在**（截图验证 m4java-test 仓库有"项目"导航）——gitea 上游把项目看板功能**保留在 web 前端**（直接读 DB 渲染），但**没暴露 HTTP API**。
4. **直 curl 试 `/repos/kanban_demo/m4java-test/projects` 返回 404 page not found**（三种 owner 拼法都试过）。
5. gitea-js（[github.com/anbraten/gitea-js](https://github.com/anbraten/gitea-js)）是 swagger 生成器，**swagger 都没端点，生成出来一样没有**——gitea-js 不能解决这个问题。

## 结论

**gitea 1.26 社区版不再暴露 projects REST API**（项目看板功能被官方降级到 web-only）。gitea-kanban **不能依赖 gitea 端的 project 概念**当看板数据源。

## 旧设计（reset 前的 AGENTS §5.5 / 02-arch §4）

| 维度 | 旧设计 |
|---|---|
| 数据源 | gitea project / column / card（端点：`/repos/{owner}/{repo}/projects` 等） |
| 看板列 | gitea `ProjectColumn`，存 gitea DB，gitea-kanban 缓存 |
| 卡片 | gitea `ProjectCard`，引用 gitea issue |
| 卡片状态 | 卡片在哪个 gitea column |
| IPC 端点 | `board.columns.list/create/update/delete` / `board.cards.list/create/move/update/delete` / `board.projects.list/create` |
| 数据库 | 13 张表（含 `project_boards` / `project_columns` / `project_cards`） |
| 后端调用 | openapi-fetch（手写 TS 类型） |

## 新设计

### 核心思路

**gitea-kanban 的"看板"是 gitea-kanban 自己的产品形态，不是 gitea web 端"项目"的镜像复制**（AGENTS §1 已定调：gitea-kanban 关注 commit/分支/PR 维度的可视化，不是替换 gitea web）。

- **看板列 = gitea-kanban 本地概念**，存本地 sqlite，**完全独立于 gitea**
- **卡片 = gitea issue**（gitea API 完备 + 全量），gitea-kanban 不存"卡片"实体，只存"列 ↔ issue 关联"
- **列 ↔ issue 关联 = 通过 gitea label 表达**——看板列映射到一个 gitea repo label，issue 带这个 label 就属于这个列

### 数据模型（reset 后的 sqlite schema）

| 表 | 用途 |
|---|---|
| `users` | gitea 用户（不变） |
| `gitea_accounts` | gitea PAT + keychain 引用（不变） |
| `repo_projects` | gitea-kanban 视角下的"项目"——一个 gitea repo 选 gitea-kanban 看板视图（不变） |
| `board_columns` | **新表**——gitea-kanban 本地的看板列；列标题自定（"待办/进行中/已完成"），与 gitea label name 解耦 |
| `column_label_mapping` | **新表**——`(column_id, gitea_label_id)` 多对多映射；一个列可绑多个 label，一个 label 只能绑一个列 |
| `card_issue_link` | **新表**——`(column_id, gitea_issue_id, board_project_id)` 派生缓存，gitea issue 被哪条 gitea-kanban 列"看到" |
| `gitea_refs` | gitea issue / PR / commit 引用缓存（不变） |
| `starred_branches` | 收藏分支（不变） |
| `prefs` | 用户偏好（不变） |
| `undo_entries` | 撤销栈（保留） |
| `cache_entries` | 通用 TTL 缓存（保留） |
| `hook_deliveries` | webhook 投递记录（v2，保留） |
| `giteaUser` | 远端用户信息缓存（保留） |

**业务实体表 12 张**（比原 13 张少 1：删了 `project_boards` 的 gitea 镜像版）+ 基础设施表 2 张（giteaUser / cacheEntries + hookDeliveries v2）

### IPC 端点（reset 后的 `02-architecture §5.3`）

**删除的旧 board.* 端点**（共 12 个）：
- `board.projects.list/create`（无 project 概念）
- `board.columns.list/create/update/delete`（列是本地概念但走新端点）
- `board.cards.list/create/move/update/delete`（无 card 实体）

**新增的端点**（与 gitea issues / labels / branches / commits / pulls 真实端点对齐）：

| 命名空间 | 端点 | 用途 |
|---|---|---|
| `board.columns` | `list(boardProjectId)` / `create({ boardProjectId, title, position })` / `update({ id, title?, position? })` / `delete({ id })` / `mapLabel({ columnId, giteaLabelId })` / `unmapLabel({ columnId, giteaLabelId })` | 看板列 CRUD + label 映射 |
| `issues` | `list({ boardProjectId, columnId?, state?, labelIds?, q?, page, limit })` / `get({ boardProjectId, issueId })` / `create({ boardProjectId, title, body, labelIds })` / `update({ boardProjectId, issueId, title?, body?, state? })` / `addLabel({ boardProjectId, issueId, labelId })` / `removeLabel({ boardProjectId, issueId, labelId })` | gitea issue CRUD + label 操作（按 gitea-js issue API 包装） |
| `pulls` | `list({ boardProjectId, state, page })` / `get({ boardProjectId, pullId })` / `merge({ boardProjectId, pullId, method })` | 合并请求（不变） |
| `branches` | `list({ boardProjectId })` / `get({ boardProjectId, name })` / `star({ boardProjectId, name })` / `unstar({ boardProjectId, name })` / `delete({ boardProjectId, name })`（含二次确认提示） | 分支（不变） |
| `commits` | `list({ boardProjectId, ref, page })` / `get({ boardProjectId, sha })` / `timeline({ boardProjectId, branches, since?, until? })` | 提交（不变） |
| `repos` | `list()` / `get({ boardProjectId })` / `addProject({ repoFullName })` / `removeProject({ boardProjectId })` | 仓库（不变） |
| `labels` | `list({ boardProjectId })` / `create({ boardProjectId, name, color })` | gitea label 列表 + 创建（看板列映射用） |
| `auth` | `connect({ giteaUrl, token })` / `disconnect()` / `status()` | 鉴权（不变） |
| `prefs` | `get()` / `update({ ... })` | 偏好（新增；v1 暂用 localStorage 不上 IPC） |

### gitea-js 引入

- 引入 `gitea-js`（gitea swagger 自动生成 TS client）替换 `openapi-fetch` + 手写 `gitea/*.ts` 文件
- **gitea-js 只能生成 swagger 里有的端点**（issues/labels/commits/branches/pulls/repos/orgs/users 全有；projects 没有）
- 引入是 §7.1 拍板（换底层 SDK），用户 2026-06-11 已拍板

## 影响范围

- **后端**：
  - `package.json` 加 `gitea-js` / 删 `openapi-fetch`
  - `src/main/gitea/*.ts`（repos / branches / commits / pulls / issues / labels）改走 gitea-js
  - `src/main/board/` 重写为"本地列 + label 映射"业务层
  - `src/main/cache/schema/` 改：删 `project_boards/columns/cards` 3 张表，加 `board_columns / column_label_mapping / card_issue_link` 3 张表
  - `src/main/ipc/schema.ts` 改 12 个 board.* 端点
  - `src/preload/index.ts` 更新 `window.api` 暴露的 namespace
- **前端**：
  - `src/renderer/stores/board.ts` 重写——`board.columns.*` 调本地列 API，`board.cards.*` 改 `issues.list({ columnId })` 调 issue API
  - `src/renderer/views/BoardView.vue` 适配——卡片从 issue 数据源渲染，列标题来自本地 sqlite
  - 零术语不变（"看板/卡片/列"是 gitea-kanban 自己概念，原词就是中文）
- **设计文档**：
  - `AGENTS.md §5.5` "13 张表" → "12 张业务表"（业务表计数规则：giteaUser / cacheEntries / hookDeliveries 是基础设施表不计入）
  - `02-architecture.md §4` 数据模型 ER 图重画
  - `02-architecture.md §5.3` IPC 端点清单重写

## 不做的事

- ❌ 不引入 OAuth2 / webhook server（v1 范围外）
- ❌ 不做实时协作 / 多人光标
- ❌ 不绑死 issues——抽象成 git provider interface，v2 支持 GitLab/Forgejo 时再抽
- ❌ 不恢复 project_boards 表（gitea 端没 API，缓存了也用不了）

## 验证标准（M2 收口）

1. `pnpm dev` 起来，连 gitea_demo/m4java-test
2. 看板视图能渲染 3 列（待办/进行中/已完成）+ 5 个 issue 卡片按 label 分布
3. 拖拽 issue 跨列 → 走 gitea issues API 加/去 label → 本地 column_label_mapping 同步
4. 时间轴 / 合并边 / 分支列表走 gitea-js 包装的对应 API 全 PASS
5. `pnpm check:no-jargon` 通过
6. `pnpm build` 打包通过
7. ADR-0002 引用本文档的索引在 AGENTS §6 加上

## 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| gitea-js 类型生成失败（path 写错 / 拼写漂移） | 写 wrapper 时加 `giteaFetch(path, init)` 兜底，wrapper 失败可绕过 gitea-js 直接调原生 fetch |
| gitea-js 打包进 sandboxed preload 触发 `module not found: gitea-js` | gitea-js **只能 main 端用**，preload 不引；走 ipc-handle 中转（已 AGENTS §8.10.1 铁律） |
| 看板列 ↔ label 双向同步漂移（gitea 端 label 被删/重命名） | column_label_mapping 缓存 `gitea_label_id`，启动时校验 label 是否存在；不存在 → 弹"label 已失效"提示，列保留但不再过滤 issue |
| 老 board.* IPC 端点被前端误调 | schema.ts 保留旧端点但 deprecated 注释，下个版本删 |
| 跨平台（darwin arm64 / Linux）gitea-js 兼容性 | ADR-0001 已有 §"待补" 段记 darwin x86_64 实测通过；arm64 / Linux 推迟到 M3 复测 |

## 替代方案（已排除）

### 替代 1：升 gitea 1.27+ 看 projects API 是否回来
- 排除原因：gitea 上游在 1.22+ 已经决定把项目看板功能降级（保留 web UI 但砍 API），升上去大概率还是没 API；用户调研时间成本高

### 替代 2：把看板数据完全本地化（不调 gitea API）
- 排除原因：违背 AGENTS §1 "强 git 集成" 原则；用户希望看到 commit 节点 / PR 合并边 等 gitea 数据

### 替代 3：调 gitea admin API 绕过 projects 限制
- 排除原因：admin API 不暴露 projects 端点；除非自己 hack gitea 源码（不现实）

## 决策记录

- 2026-06-11 用户拍板"引入 gitea-js 对接 gitea 接口"，**该决策**已隐式同意 board 数据模型 reset
- 2026-06-11 orchestrator（mavis）提 ADR-0002，把"为什么 reset + 怎么 reset + 范围影响"写清楚
- 2026-06-11 用户二次确认"我认同你的 reset 方案，开干"，正式 accept
