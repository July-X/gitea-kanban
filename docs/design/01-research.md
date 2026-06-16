# 调研：gitea 生态能力 + 看板工具竞品 + timeline 方案

> 任务编号：research
> 输出时间：2026-06-10
> **调研时效声明**：调研时间 2026-06-10，结论有效期 6 个月（至 2026-12-10）。
> **重要**：本调研报告完成于用户决策 #1（Electron + TS）切换之前，本章 §1.2 / §5.2 / §5.3 / §5.4 的部分内容（推荐 Go + Gin + go-sdk + SQLite/PostgreSQL + 独立服务 + nginx 反代 + OAuth2）**已被用户决策否决作废**——最终方案见 `02-architecture.md §2` 与 `AGENTS.md §2`（Electron + TS + PAT + keychain，无 OAuth / 无 nginx / 无 Go SDK）。本调研的 gitea API endpoint 清单（§2.1）、timeline 库横评（§4）、X6 vs G6/vs D3 论证（§4）仍然有效，可作为后续 plan 的事实基础。
>
> **v1.4 polish 状态补充（2026-06-16）**：§4 timeline 库横评中"**选 X6**"的最终结论在 v1.4 已被推翻——v1.4 实际 TimelineView 用 Vue 3 + 自研 lane 渲染（**已删 `@antv/x6` + `@antv/x6-vue-shape`** devDep，0 文件引用）。§4 的 X6 论证仍可作为"为什么 v1 早期选 X6 / 为什么 v1.4 弃用"的历史决策档案保留；不要按本节结论去重装 X6。
> 目的：为后续架构设计、前端设计、技术选型提供事实基础。不写代码。

---

## 1. 调研摘要

我们要做的是**基于 gitea 的看板 + 时间轴工具**，核心差异点是：**强 git 集成**（多分支 / commit 节点 / PR 合并可视化）+ **轻量自托管**。通过本次调研得出三条关键结论：

1. **集成方式**：v1 调研时是"独立服务 + 反代"——已被用户 v2 决策（2026-06-08）改为 **Electron 桌面应用**。本次调研的 baseline（独立服务 / nginx 反代）**已作废**，保留作 audit trail；**最新决策以 02-architecture.md + AGENTS.md §2 为准**。gitea 自带的 issue + project 看板已能跑通基础场景，竞品 [qontu/gitea-kanban](https://github.com/qontu/gitea-kanban)（Vue 写的插件型）思路相近。
2. **技术栈**（v5 决策 2026-06-10 17:24 拍板 Vue 3 + Electron 桌面应用）：
   - 运行时：**Electron + Node 20 LTS**（v2 决策 2026-06-08）
   - 渲染进程：**Vue 3 + Vite + Pinia + Vue Router 4 + Radix Vue**（v5 决策 2026-06-10 17:24，团队技术栈匹配）
   - timeline：**AntV X6@3.1.7 + @antv/x6-vue-shape**（X6 框架无关，桥接 Vue 3）
   - 主进程：**Node + better-sqlite3 + Drizzle + keychain**（v2 决策）
   - 鉴权：**gitea PAT + 系统 keychain**（不走 OAuth 跳转，本地应用）
   - 打包：**electron-builder**（macOS dmg 优先）
   - 数据库：SQLite 文件（`app.getPath('userData')/kanban.db`）
3. **timeline 方案选 AntV X6**：vis-timeline / react-calendar-timeline 都是"甘特/日程"思维，**不适合多分支并行 + commit 节点 + PR 合并的图状结构**；dhtmlx-gantt 商业授权贵；AntV X6 本身就是"图编辑引擎"，多节点多边 + 自定义渲染 + 交互最契合 git graph 场景，且我们在 visualizer 项目里已用过，风险可控。

下文按 6 节展开，每节给"事实 + 判断 + 来源 URL"。

---

## 2. gitea 生态能力

### 2.1 官方 API 能力

gitea 提供完整的 RESTful API（与 GitHub 兼容），核心 endpoint 分组：

| 资源 | 关键 endpoints | 用途 |
|---|---|---|
| 用户 | `GET/POST /users/{name}/tokens`、`GET /user`、`PATCH /user/settings` | 生成/管理 API token、读当前用户 |
| 组织 | `GET /orgs/{org}`、`GET /orgs/{org}/teams`、`GET /orgs/{org}/members` | 读组织、团队、成员 |
| 仓库 | `GET /repos/{owner}/{repo}`、`GET /repos/search` | 读仓库元数据、搜索 |
| 分支 | `GET /repos/{owner}/{repo}/branches`、`POST /repos/{owner}/{repo}/branches` | 列/建分支 |
| 提交 | `GET /repos/{owner}/{repo}/commits`、`GET /repos/{owner}/{repo}/git/commits/{sha}` | 列 commit、读单 commit |
| PR | `GET /repos/{owner}/{repo}/pulls`、`GET /repos/{owner}/{repo}/pulls/{index}`、`POST .../pulls` | 列/读/建 PR |
| Release | `GET /repos/{owner}/{repo}/releases`、`GET .../releases/{id}` | 列/读 release |
| Issue | `GET /repos/{owner}/{repo}/issues`、`POST .../issues` | 列/建 issue |
| Webhook | `POST /repos/{owner}/{repo}/hooks`、`GET .../hooks` | 注册/列 webhook |
| 标签 | `GET /repos/{owner}/{repo}/labels` | 读标签（看板列的候选） |

- **认证方式**：HTTP Basic / `?token=` / `?access_token=` / `Authorization: token <key>` / SSH 公钥签名（draft-cavage-http-signatures）。
- **Token 权限粒度**：`activitypub / admin / issue / misc / notification / organization / package / repository / user`，每个可设 `read` 或 `write`。
- **分页**：`page` + `limit` 参数，`Link` + `x-total-count` 头返回分页信息。
- **Sudo**：管理员可用 `?sudo=` 或 `Sudo:` 头代理其他用户。
- **OpenAPI/Swagger**：每个实例自带 `/api/swagger` 与 `/swagger.v1.json`。
- **官方 SDK**：[go-sdk](https://gitea.com/gitea/go-sdk)（官方，MIT，Go）；社区 SDK 见 [awesome-gitea](https://gitea.com/gitea/awesome-gitea#sdk)，覆盖 TypeScript/Python/Java/.NET/Rust/Dart/PHP/R。

**来源**：
- API 文档根目录：https://docs.gitea.com/api/1.25/
- API Usage（含 auth/token/sudo/SDK 列表）：https://docs.gitea.com/development/api-usage
- awesome-gitea SDK 区：https://gitea.com/gitea/awesome-gitea#sdk
- go-sdk godoc：https://godoc.org/code.gitea.io/sdk/gitea

### 2.2 三种二次开发方式对比

| 方式 | 形态 | 优点 | 缺点 | 适配场景 |
|---|---|---|---|---|
| **独立服务 + 反代同域** | 独立部署，nginx 在 gitea.example.com/kanban/ 反代到本服务 | 技术栈完全自由、不受 gitea 框架约束、可独立演进、用户视角与 gitea 同 SSO | 需自己维护部署、auth 用 OAuth2 跨服务跳转 | **我们推荐**：做非平凡功能（多分支图、自定义看板列、timeline） |
| **gitea 插件 / 主题** | 嵌入 gitea 二进制，跟着 gitea 版本发布 | 天然同域、权限继承 gitea | 只能改模板 + 注册端点，受 gitea 模块限制；升级 gitea 要重新发布插件；前端只能用 gitea 渲染管线 | 小工具（额外菜单、定制首页） |
| **做成 gitea fork / 直接改源码** | 私有编译版 | 任意深度定制 | 升级 gitea 极痛苦、社区资源浪费、长期维护成本高 | **不推荐** |

推荐**方式 1**：我们核心需求是"git 数据可视化 + 自定义看板"，前端的自由度（X6 / vis-timeline / D3 任选）需要脱离 gitea 模板；用户态通过 OAuth2 接入 gitea，单点登录体验也能覆盖。

**来源**：
- Gitea Customizing Paths（说明模板可覆盖但框架受限）：https://docs.gitea.com/administration/customizing-gitea
- 集成目录（含已实现的第三方项目）：https://docs.gitea.com/development/integrations

### 2.3 权限模型如何在工具里被消费

gitea 角色层级：

```
Site Owner (全局管理员)
└── Organization Owner / Admin
    └── Team
        └── Repository Collaborator
            ├── Admin   (仓库全权)
            ├── Write   (push / 创建分支 / 创建 PR)
            ├── Read    (读仓库 + 读 issue)
            └── None    (无访问)
```

API token 还可叠加 `read:<scope>` / `write:<scope>` 二级权限。

**我们的消费思路**：
1. 后端**始终用最小权限 token**（如 `read:repository` + `read:issue`），不要求用户给我们 admin token。
2. 用户登录时通过 OAuth2 拿到当前用户的角色 → 缓存到 session / JWT → 前端按角色显示 UI（owner 看到组织级看板、write 才能拖卡片、read 只能看）。
3. 关键操作（写 API）走**"用户授权 + 我们用用户 token"**模式，不走后端长存 token，避免权限放大。
4. **不要**试图在 gitea 之外重建一套权限系统——所有"谁能动什么"都从 gitea 实时拉，缓存短 TTL 即可。

**风险点**：gitea 仓库的"protected branch"等细粒度规则在 API 层不会自动下放给我们，要看具体操作是否被 gitea 后端拒绝 → 我们做 UI 时先调 read API 探一下再决定按钮 enable/disable。

**来源**：
- Permissions 文档：https://docs.gitea.com/usage/permissions
- API Token scopes：https://docs.gitea.com/development/api-usage（"Generating and listing API tokens" 节）

### 2.4 webhook 事件

gitea webhook 在仓库、组织、系统三个层级都可配，支持的事件类型（基于 swagger + awesome-gitea 文档综合）：

| 事件 | 典型用途 | 对我们价值 |
|---|---|---|
| `push` | push 触发 | **高**：commit 节点增量更新，避免每次拉全量 |
| `pull_request` / `pull_request_sync` | PR 创建/同步/合并 | **高**：PR 合并事件触发时间轴"合并边"动画 |
| `create` / `delete` | 分支/标签创建删除 | 中：分支重绘触发 |
| `issues` / `issue_comment` | issue 评论 | 中：看板卡片评论流 |
| `release` | release 发布 | 低：可作为里程碑标记 |
| `repository` | 仓库被创建/删除 | 低：仅初始化用 |
| `package` | 包发布 | 我们不做包管理，可不订阅 |
| `fork` | fork | 低 |

**认证与重试**：
- 通过 `X-Gitea-Event` 头识别事件类型。
- 通过 `X-Gitea-Signature` 头（HMAC-SHA256，header 格式 `sha256=...`）校验 secret。
- 1.19+ 支持 Authorization 头注入。
- 失败重试由 gitea 端控制；我们后端**接收端要 idempotent**（按 delivery ID 去重）。

**来源**：
- Webhook 文档：https://docs.gitea.com/usage/webhooks
- Webhook 事件列表（auto-generated）：https://docs.gitea.com/api/1.25/#tag/webhook

---

## 3. 竞品分析

下表列出 7 个相关工具，覆盖"gitea 原生 + 通用开源 + git 集成专项"三档。每行说明核心定位、UI 范式、技术栈、与 gitea/git 关系、开源情况。

| # | 工具 | 定位 | UI 范式 | 技术栈 | git 集成方式 | 开源 | 核心优劣 |
|---|---|---|---|---|---|---|---|
| 1 | **Gitea 内置 Issue Board + Project** | 仓库/组织级 issue 看板 | Trello 式列拖拽 | gitea 自身（Go + Vue） | 原生 — 看板卡片=issue | MIT | ✅ 零部署成本；❌ 无 commit/分支视图，issue 状态依赖 label 手动维护 |
| 2 | **[qontu/gitea-kanban](https://github.com/qontu/gitea-kanban)** | gitea 插件型看板 | Trello 式 | Vue | gitea API + 仓库内静态托管 | MIT | ✅ 跟我们同名且思路相近；❌ 仍只做 issue 列拖拽，无 git 数据可视化 |
| 3 | **[GitKraken Board](https://www.gitkraken.com/)**（含 GitKraken Client 看板模块） | Git GUI 内嵌任务视图 | 列 + 提交图叠加 | Electron + TypeScript | 内嵌 Git 客户端，深 | 商业（部分免费） | ✅ git graph 行业标杆；❌ 闭源、订阅制、不开源、不能独立部署 |
| 4 | **[WeKan](https://github.com/wekan/wekan)** | Trello 开源翻版 | Trello 式 | Meteor（Node 全栈）+ MongoDB | 无 git 集成（手动关联） | MIT | ✅ 成熟看板功能；❌ Meteor 老栈、需 MongoDB、不碰 git |
| 5 | **[Plane](https://github.com/makeplane/plane)** | 开源 Jira/Linear 替代 | 看板 + 列表 + 日历 + 甘特 | Next.js + Django + Node + Postgres + Redis | 通过 GitHub/GitLab 集成拉 issue | AGPL-3.0 | ✅ 现代 UI、功能全；❌ 重（Docker compose 一大坨）、git 集成是只读 |
| 6 | **[Focalboard](https://github.com/mattermost/focalboard)** | 个人/团队任务管理 | 看板 + 表格 + 日历 + gallery | Go + React（TypeScript） + SQLite/Postgres | 无 git 集成 | NOASSERTION（Mattermost） | ✅ 桌面/WEB/插件三形态、轻量；❌ 不感知 git 数据 |
| 7 | **[OpenProject](https://www.openproject.org/)** | 企业级项目管理（含 GitLab 集成） | 看板 + 甘特 + 路线图 + Wiki | Ruby on Rails + Angular + Postgres | 有 GitLab 集成模块（[官方集成文档](https://www.openproject.org/docs/system-admin-guide/integrations/gitlab-integration/)） | GPL-3.0（社区版） | ✅ 企业级功能；❌ Rails 重、GitLab 集成 ≠ Gitea |
| 8 | **[Leantime](https://github.com/Leantime/leantime)** | 面向非项目经理的精益项目系统 | 看板 + 甘特 + 时间线 + 画布 + Wiki | PHP（Laravel）+ JS + MySQL | 无 git 集成 | GPL-2.0 | ✅ 功能广、学习成本低；❌ PHP 老栈、不碰 git |
| 9 | **[GitLens](https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens) / VS Code Timeline** | 编辑器内 git 可视化 | 提交图 + blame + timeline | TypeScript（VS Code 扩展） | Git CLI 直读 | 商业（部分免费） | ✅ 文件级 git 可视化行业标杆；❌ 桌面端不可独立部署、不做看板 |

### "我们要做 vs 不要做"边界建议

✅ **要做**（差异化竞争点）：
1. **git graph 实时可视化**：多分支 commit 节点 + PR 合并边 + 颜色/分组，业界除了 GitKraken/GitLens 没人做得深——这是我们最深的护城河。
2. **轻量自托管 + 极简部署**：单个二进制 + sqlite，跟 gitea 同域反代即用，比 Plane/OpenProject 轻量得多。
3. **gitea 原生数据回填**：用 webhook 增量同步，本地只存用户偏好和缓存，不重不漏。
4. **看板 + timeline 联动**：卡片可关联到一个或多个 commit/PR，timeline 视图里点击 commit 能跳到该卡片。

❌ **不要做**（避免范围爆炸）：
1. **不重做通用 PM**（不学 Plane/OpenProject 那一整套冲刺/路线图/Wiki/工时）——专注 git + 看板两个轴。
2. **不做任务评论/通知系统**——跳回 gitea 原生 issue/PR 评论区。
3. **不绑死 gitea**——API 层抽象成 git provider interface，理论能换 GitLab/Forgejo（Go 写的 gitea 软分叉），但 v1 只支持 gitea。
4. **不做文件 diff / blame / code review**——这是 GitLens 的领域，不是我们的。
5. **不做 gitea 后台管理 / 用户管理 UI**——通过 OAuth2 跳回 gitea 完成。
6. **不做实时协作（多人光标）**——v1 单用户视角够用，复杂度留给 v2。

**来源**：
- qontu/gitea-kanban：https://github.com/qontu/gitea-kanban
- WeKan：https://github.com/wekan/wekan
- Plane：https://github.com/makeplane/plane
- Focalboard：https://github.com/mattermost/focalboard
- OpenProject + GitLab 集成：https://www.openproject.org/docs/system-admin-guide/integrations/gitlab-integration/
- Leantime：https://github.com/Leantime/leantime
- GitKraken：https://www.gitkraken.com/
- GitLens：https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens
- Gitea 内置看板介绍：https://blog.csdn.net/qq_41174685/article/details/（搜"Gitea 看板功能：任务管理集成"）

---

## 4. timeline 方案对比

我们要做的是**多分支并行 + commit 节点 + PR 合并边 + 颜色/分组**的"git graph 风格时间轴"——不是 Gantt（任务依赖），也不是 calendar timeline（日程占位）。下表先按"是否能表达 git graph 场景"过滤。

| 候选 | 范式 | 多分支并行 | commit 节点 | PR 合并边 | 颜色/分组 | 性能（千节点） | 移动端降级 | 学习成本 | License |
|---|---|---|---|---|---|---|---|---|---|
| **AntV X6@3.1.7** | 图编辑引擎 | ✅（节点定位完全自定义） | ✅（任意形状 SVG） | ✅（自定义 connector） | ✅（节点 attrs + 边 attrs） | 中（~千级流畅，~万级需 virtualRender） | ✅（自适应 SVG） | 中（API 多，需读文档） | MIT |
| **AntV G6@5** | 关系图可视化引擎 | ✅（自带自动布局） | ✅ | ✅ | ✅（主题系统） | 中-高（内置虚拟化） | ✅ | 中 | MIT |
| **D3.js + custom SVG** | 自绘 | ✅（完全自定义） | ✅ | ✅ | ✅ | ✅（可达万级，看实现） | ✅ | **高**（要自己写 zoom/drag/状态管理） | ISC |
| **vis-timeline** | 日程时间轴 | ❌（单轨分组） | ❌（无节点概念） | ❌ | ⚠（item group） | 中-高 | ✅（触屏适配） | 低 | Apache-2.0/MIT 双许可 |
| **react-calendar-timeline** | React 日程时间轴 | ❌（单轨） | ❌ | ❌ | ⚠（group） | 中 | ⚠ | 低 | MIT |
| **dhtmlx-gantt** | Gantt 任务管理 | ❌（树形任务结构） | ❌ | ❌ | ⚠（任务色） | 高（专为万级任务优化） | ⚠（仅桌面体验） | 低 | GPL-2.0（社区版），商业版要付费 |

**分析**：
- vis-timeline / react-calendar-timeline 是"日程/排期"思维——时间轴是水平、时间是绝对度量，节点是"事件段"。**和 git graph 范式不符**（git graph 没有强时间概念，分支顺序是 DAG）。
- dhtmlx-gantt 同上是"项目管理甘特图"——任务依赖、开始/结束时间。**不是我们要的图状时间轴**。
- AntV X6 / G6 都是"图编辑引擎"——任意节点 + 任意边 + 自定义渲染，最契合"git graph + 时间轴"融合场景。
- D3 自绘性能最好但工作量大（zoom/pan/drag/highlight 都要自己造），适合 v2 性能优化期，v1 直接用 X6。

### 推荐方案：**AntV X6@3.1.7**

理由：
1. **场景契合**：图编辑引擎，天生为"节点 + 边 + 拖拽/缩放/选中/编辑"设计——git graph 的每一种元素都是 X6 的 first-class citizen。
2. **定制深度**：节点可以用 SVG 自定义（commit dot / 合并菱形 / PR tag），边可以用自定义 connector（分支折线、合并曲线、动画 flow）。
3. **生态成熟**：国内阿里 AntV 团队维护，中文文档齐全，React/Vue 都有集成示例；用户在前序 visualizer 项目中已用过此库，迁移成本为零。
4. **性能可控**：通过 `virtualRender` 插件支持千级节点虚拟化；如果未来要做大型 monorepo（万级 commit），加这个就行。
5. **License 友好**：MIT，可商用可改源码。

替代预案（如果 X6 出现 X6@3.1.7 后续不支持的 breaking change 或性能瓶颈）：
- v1 短期：**G6@5**——同样的图编辑哲学，但 v5 在自动布局和虚拟化上更强。
- 性能爆发期：**D3 + custom SVG**——完全控制渲染，但开发周期翻倍。

### "移动端降级"说明

X6 默认 SVG 渲染，移动端浏览器天然支持，但触控交互（pinch zoom / two-finger pan）需额外配置 `panning: { enabled: true }` + `mousewheel: false` + 监听 `touch` 事件。**v1 移动端降级方案**：单列竖向展示 commit 列表 + 折叠分支（类似 GitHub mobile），timeline 视图在 <768px 自动隐藏并提示"请在桌面端打开完整视图"。

**来源**：
- AntV X6 官网：https://x6.antv.antgroup.com/
- AntV G6 官网：https://g6.antv.antgroup.com/
- vis-timeline：https://github.com/visjs/vis-timeline
- react-calendar-timeline：https://github.com/namespace-ee/react-calendar-timeline
- dhtmlx-gantt 主页：https://dhtmlx.com/docs/products/dhtmlxGantt/

---

## 5. 技术决策候选

每项给出 4 列：候选 / 推荐 / 理由（2 句）/ 主要风险（1 句）。

### 5.1 前端框架

| 候选 | 推荐 | 理由 | 主要风险 |
|---|---|---|---|
| ~~React + Vite + TypeScript~~ | ❌ 已否决 | v1 推荐过；2026-06-10 17:24 v5 决策改 Vue 3（团队无 React 积累） | — |
| **Vue 3 + Vite + TypeScript** | ✅ **已选**（2026-06-10 17:24 v5 拍板） | qontu/gitea-kanban 用了 Vue、团队有 Vue 积累、Vue 3 Composition API 与 Pinia setup store 同源；X6 走官方 `@antv/x6-vue-shape` 桥接 | X6 Vue 例子少于 React，自定义复杂节点时文档量吃亏（@antv/x6-vue-shape 桥接后能复用 X6 React 文档的 80% 概念） |
| Svelte | 可选 | bundle 小、响应式直观 | X6 没有官方 Svelte wrapper，自己封一层工作量不小 |
| 纯 HTML + JS | ❌ | 无 build step，部署最简 | 失去 TS 类型保护、组件复用靠 copy-paste；v2 加复杂功能（虚拟滚动）会很难 |

**2026-06-10 17:24 拍板**：Vue 3 + Vite + TypeScript。**理由**：团队无 React 积累，Vue 3 在团队内有现成积累——是组织能力优先的决策，不是技术横评结果。**X6 Vue 集成**：走 `@antv/x6-vue-shape` 官方桥接包（X6 本身框架无关）。**风险**：X6 Vue 文档量 < React，但桥接后概念可复用。

### 5.2 后端框架

| 候选 | 推荐 | 理由 | 主要风险 |
|---|---|---|---|
| **Go + Gin + go-sdk** | ✅ **推荐** | gitea 自身用 Go、go-sdk 官方维护 → 数据结构一致、调用 API 无需手写 HTTP；Gin 是 gitea 同一 Web 框架；最终产出**单个二进制**，部署与 gitea 同形 | Go 没有内置 ORM，结构化数据落库要选 sqlc/ent/gorm——增加选型决策 |
| Node + Express + gitea-js | 可选 | 前端 React + 后端 Node 单一语言心智一致；gitea-js 是社区 TS SDK | Node 进程常驻内存 + npm 供应链安全运维成本高于 Go 单二进制 |
| Python + FastAPI + py-gitea | 可选 | FastAPI 写 API 极快；py-gitea 简单够用 | Python 性能/部署成本（venv / pip）在自托管场景不如 Go；与 gitea 同源弱 |
| Node + NestJS | ❌ | 企业级 DI 漂亮 | 杀鸡用牛刀，本项目 10 个 endpoint 内用不到 NestJS 的 decorator 体系 |

**推荐**：Go + Gin + go-sdk。**风险**：落库 ORM 选择会再分一次叉（建议默认 sqlc + SQLite，生成代码即可）。

### 5.3 数据库

| 候选 | 推荐 | 理由 | 主要风险 |
|---|---|---|---|
| **SQLite（默认）+ PostgreSQL（可选）** | ✅ **推荐** | 单二进制场景下 SQLite 零配置；本地数据量（用户偏好 + 卡片状态 + webhook delivery cache）小，SQLite 完全够；后期用户量大时 sqlc 代码几乎零改动切到 Postgres | SQLite 写并发不如 Postgres；自托管用户场景下做"全公司共享一个实例"时写并发可能撞 WAL 锁 |
| 纯走 gitea API 不落库 | 可选 | 最简部署、零数据一致性烦恼 | 每次打开页面都要拉一堆 API → 慢 + 触发 gitea rate limit；webhook delivery 无法去重（重复事件无法识别）；用户偏好无法保存 |
| PostgreSQL（默认） | 可选 | 写并发强、生态成熟 | 部署门槛高一截（要额外起 PG 容器），v1 不值 |

**推荐**：SQLite 为 v1 默认、PostgreSQL 作为 v2 配置项。**风险**：写并发撞墙时切换 PG 涉及 schema migration（sqlc 可以平滑过渡，但需要从一开始就严格用 sqlc）。

### 5.4 部署形态

| 候选 | 推荐 | 理由 | 主要风险 |
|---|---|---|---|
| **独立服务 + nginx 反代到 gitea 同域** | ✅ **推荐** | 用户体验上像 gitea 内嵌（gitea.example.com/kanban/）；技术栈独立、迭代独立；OAuth2 跨子域同站，体验顺 | 部署时多一步配 nginx；要给 OAuth2 callback 留位置 |
| 完全独立域名（kanban.example.com） | 可选 | 部署最简（一个独立服务） | 跨域 cookie / OAuth2 redirect_uri 要处理；用户视角割裂感强 |
| gitea 插件/主题 | ❌ | 看起来"原生"，实则被 gitea 模板限制——X6 在 gitea 模板里渲染要么 bundle 巨大要么要 hack 加载方式 | 升级 gitea 跟版本号强绑；前端不能用任意构建管线 |
| gitea fork 私有编译 | ❌ | 任意深度改 | 升级 gitea 极痛、社区资源浪费——**所有开源方案的反模式之首** |

**推荐**：独立服务 + nginx 反代。**风险**：运维侧多了一个服务要保活、监控、备份（虽然 SQLite 单文件备份就是 `cp`）。

---

## 6. 信息来源汇总

### 6.1 gitea 官方文档
- Gitea 官网：https://about.gitea.com/
- API 文档（1.25）：https://docs.gitea.com/api/1.25/
- API Usage（含 auth/token/sudo/SDK）：https://docs.gitea.com/development/api-usage
- Webhooks：https://docs.gitea.com/usage/webhooks
- Permissions：https://docs.gitea.com/usage/permissions
- Customizing Gitea：https://docs.gitea.com/administration/customizing-gitea
- Integrations：https://docs.gitea.com/development/integrations
- OAuth2 Provider：https://docs.gitea.com/development/oauth2-provider

### 6.2 gitea SDK / 生态
- Official go-sdk：https://gitea.com/gitea/go-sdk
- go-sdk godoc：https://godoc.org/code.gitea.io/sdk/gitea
- awesome-gitea：https://gitea.com/gitea/awesome-gitea
- gitea-js（TS SDK）：https://github.com/anbraten/gitea-js
- py-gitea：https://github.com/Langenfeld/py-gitea/
- Tea CLI（官方命令行工具）：https://gitea.com/gitea/tea

### 6.3 竞品
- gitea 内置 Project / Issue Boards：（Gitea 官方内置功能，无独立页 URL，可在每个仓库/组织的 Projects 标签页查看）
- qontu/gitea-kanban：https://github.com/qontu/gitea-kanban
- WeKan：https://github.com/wekan/wekan
- Plane：https://github.com/makeplane/plane
- Focalboard：https://github.com/mattermost/focalboard
- OpenProject：https://github.com/opf/openproject
- OpenProject GitLab 集成：https://www.openproject.org/docs/system-admin-guide/integrations/gitlab-integration/
- Leantime：https://github.com/Leantime/leantime
- GitKraken：https://www.gitkraken.com/
- GitKraken GitLab Issues：https://support.gitkraken.com/integrations/gitlab-issues/
- GitLens：https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens

### 6.4 可视化库
- AntV X6：https://x6.antv.antgroup.com/
- AntV X6 GitHub：https://github.com/antvis/X6
- AntV G6：https://g6.antv.antgroup.com/
- AntV 整套：https://antv.vision/zh/
- vis-timeline（vis.js）：https://github.com/visjs/vis-timeline
- vis.js 文档：https://visjs.github.io/vis-timeline/docs/timeline/
- react-calendar-timeline：https://github.com/namespace-ee/react-calendar-timeline
- dhtmlx-gantt：https://dhtmlx.com/docs/products/dhtmlxGantt/
- dhtmlx-gantt GitHub：https://github.com/DHTMLX/gantt
- D3.js：https://d3js.org/

### 6.5 周边参考（被引用为事实依据的博客）
- Gitea 看板功能深度解析（中文）：https://blog.csdn.net/qq_41174685/article/details/（搜索"Gitea 看板功能：任务管理集成"）
- Gitea 1.18 API 重大更新：https://zhuanlan.zhihu.com/p/595567466
- Gitea Webhook 中间件实现（Python）：https://blog.csdn.net/qq_33940224/article/details/（搜索"Gitea Webhook 中间件 Go 泛型 Context 超时控制实战"）
- vis-timeline 时间轴介绍：https://blog.csdn.net/gitblog_00649/article/details/（搜索"vis-timeline 时间轴的动态可视化神器"）
- AntV X6 在京东物流的应用：https://blog.csdn.net/yanzhitong_/article/details/（搜索"antv-x6 使用及总结 京东物流技术团队"）

---

> **stop condition**：本调研仅出事实 + 选型候选 + 边界建议，**不涉及**：
> - 具体 endpoint URL 拼接与 SDK 调用样例（留给架构任务）
> - 数据库 schema 设计（留给架构任务）
> - 前端组件拆解与 props 设计（留给前端任务）
> - 任何代码
>
> 如需进入下一步架构 / 前端设计，请创建对应任务（plan workspace 里应该已经有 tasks）。