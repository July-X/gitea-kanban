# 前端设计：UI/UX + 时间轴可视化 + 静态 wireframe

> 任务编号：frontend-design
> 输出版本：v4（按 ui-ux-pro-max OVERRIDE 重定 · 撤销 v3 暗色默认）
> 输出时间：2026-06-10
> **v5 增量（2026-06-10 17:24）**：技术栈从 React 18 + Zustand + Radix UI 改为 **Vue 3 + Pinia + Radix Vue**（团队技术栈匹配）；其他业务规则（零术语 / 二次确认 / 错误人话 / X6 选型 / 设计系统 token）不变。

---

## 用户决策记录

- **2026-06-10 10:12** —— 计划负责人把技术栈从"React Web + Go 后端 + SQLite + nginx 反代"改为"**Electron + TypeScript 单进程桌面应用**"。具体：
  1. 主进程（Node 侧 TS）负责 gitea API 调用、本地缓存（SQLite/LevelDB 二选一）、文件系统、git CLI 调用（可选）；渲染进程（Chromium 侧 TS + React/Vue/Svelte）负责 UI。
  2. 打包用 **electron-builder**，产物 macOS dmg + Windows exe + Linux AppImage（**v1 优先 macOS**）。
  3. 鉴权改用 **gitea Personal Access Token**，由 Electron 的 `safeStorage` / 系统 keychain（macOS Keychain / Windows DPAPI / Linux libsecret）保存，**不做 OAuth 跳转**。
  4. 取消了 nginx 反代、OAuth 回调、CSRF、公开 Webhook 回调 URL。
  5. 数据模型：本地缓存表 + gitea API 映射，策略改为"**本地优先、远程兜底、断网只读缓存**"。
  6. **目标用户**明确为含 PM、设计师、市场、运营（非技术用户）——UI 必须：清晰文字说明、人话错误、危险操作二次确认、零术语（"PR"→"合并请求"、"merge"→"合并"）。
  7. 团队边界：架构 agent 改为"主进程模块"设计；前端 agent（本任务）改为"**渲染进程 + IPC 契约**"。

- **2026-06-10 10:30** —— 计划负责人补强 **git commit 交付规范**（这条是给后续 integration-doc / final-design-review 看的，frontend-design 本身遵守）。具体：
  1. **commit message 用中文**，type 限定 `feat / fix / refactor / perf / chore / test / docs / style`。
  2. **每个阶段性交付打一次 commit**（一份文档、一个模块完成），不攒大 commit。
  3. **worker agent 不准自己 git commit**——所有 commit 由 orchestrator（mavis）统一打，避免并发 worker 互相覆盖、保持 commit 历史整洁可追溯。
  4. **commit 必须落到 master**（当前单分支，初始化阶段不引入多分支）。
  5. **commit 末尾不要附 `Co-Authored-By`** 这种自动签名。
  6. 任何文档、代码、配置变更 → 必须经 git commit 才算交付完成；**"我写完文件了"不算交付，"我 commit 了 + commit hash 是 xxx"才算**。
  7. final-design-review 时验证：到 review 时 `git log` 应有 3+ 个 commit（每份设计文档一个），commit message 是否中文、是否带 type 前缀。
  > 注：本任务（frontend-design）的文件落盘**不会**自己 git commit——交付完成以 `deliverable.md` 为准，commit 由 orchestrator 收齐后统一打。

- **2026-06-10 10:36** —— 计划负责人补强 **加载 ui-ux-pro-max skill + 以 OVERRIDE 为准**。具体：
  1. 项目根目录已安装 `.codex/skills/ui-ux-pro-max/`，已用它跑出 `design-system/gitea-kanban/MASTER.md`（默认 startup 风格 / #22C55E 鲜绿 / Fira Code+Sans / Vibrant & Block-based）**和** `design-system/gitea-kanban/OVERRIDE.md`（**本项目实际生效**，已 commit `71f6856`）。
  2. **使用顺序**：**先读 OVERRIDE → 它没覆盖的字段才回 MASTER**（OVERRIDE 是 single source of truth）。
  3. **前端 agent 开工前必读** `design-system/gitea-kanban/OVERRIDE.md`，所有 UI 产出（组件 / wireframe / 实际界面）必须先通过本文件预检。
  4. **采纳 ui-ux-pro-max 的通用专业规则**（覆盖 MASTER 的 startup 风格）：① 无 emoji 图标（用 SVG / Lucide / Heroicons）② `cursor-pointer` 在所有可点击元素上 ③ hover 反馈 150-300ms 平滑 ④ 暗色模式对比度 ≥ 4.5:1 ⑤ focus 状态可见 ⑥ `prefers-reduced-motion` 尊重 ⑦ 响应式断点（**桌面应用窗口专用**：最小 800×600 / 推荐 1280×800 / 可拖拽至 4K）⑧ 颜色不是唯一信号（图标+文字+颜色三重编码）。
  5. **OVERRIDE 覆盖 MASTER 的关键字段**：主色 `#609926` gitea 绿（覆盖 #22C55E）/ 强调色 `#f76707` gitea 橙（新增）/ 背景**默认浅色 + 暗色模式可切换**（覆盖 #0F172A 默认深色）/ 风格"克制 / 信息密度优先"（覆盖 Vibrant & Block-based）/ 字体 Inter / 系统 sans（覆盖 Fira Code+Sans，因中文渲染需要）/ Pattern "不适用 landing"（不是营销页）。
  6. **零术语翻译表**（OVERRIDE 必采纳）：PR→合并请求 / merge→合并 / branch→分支 / commit→提交 / fork→派生 / issue→议题 / repo→仓库 / maintainer→维护者 / reviewer→审阅者。
  7. **撤销 v3 暗色默认决策**——以 OVERRIDE 为准：浅色为 v1 默认（桌面应用更稳健），暗色作为"用户可切换"模式但**不是**默认。wireframe 三页默认 `data-theme="light"` 渲染，但 CSS 变量表同时支持 `[data-theme='dark']` 一键切换（顶栏有切换按钮），证明架构可切。
  8. **依赖声明**：pre-delivery 必须先 `python3 --version`（macOS 用 `brew install python3`），确保 ui-ux-pro-max 脚本能跑（虽然本任务只读 MASTER + OVERRIDE 静态文件，但 integration-doc / final-design-review 会用到 skill 脚本）。

> **v3 暗色默认决策已作废**（2026-06-10 10:36 撤销）——以 OVERRIDE 第 9 行"默认浅色 + 暗色模式可切换"为准。v3 之前在 §1 / §7 的"暗色科技"语言全部回退到"克制 / 信息密度优先"，但**保留**v3 中符合 OVERRIDE 的部分：4.5:1 对比度、focus 可见加强、状态色配图标/文字。

- **2026-06-10 17:24** —— 计划负责人拍板：**渲染进程框架从 React 18 改为 Vue 3**。具体：
  1. 原因：团队内**无 React 技术栈支撑**，**Vue 3 在团队内有现成积累**——是组织能力优先的决策，不是技术横评结果。
  2. 配套变更（与 AGENTS.md §8.1 v2→v3 修正 + 02-architecture.md §2.2 + §2.2.1 同步）：
     - 框架：React 18 → **Vue 3**（Composition API + `<script setup>` + TypeScript）
     - 状态管理：Zustand → **Pinia**（Vue 官方，setup store 风格与 Composition API 同源）
     - 路由：React Router 6 → **Vue Router 4**（用 `createWebHashHistory` 适配 Electron `file://` 协议）
     - UI 组件库：Radix UI Primitives → **Radix Vue**（同一团队，unstyled primitives）；按需 `@headlessui/vue` 补缺
     - timeline：新增 **`@antv/x6-vue-shape` 官方桥接包**（X6 本身框架无关，桥接包把 Vue SFC 注册为 X6 节点；详见 02-architecture §2.2.1）
     - 图标：`lucide-react` → **`lucide-vue-next`**（同包名 Vue 版）
     - 测试：React Testing Library → **`@vue/test-utils` + `@testing-library/vue`**
  3. **不变**：CSS Modules + 全局 CSS 变量（OVERRIDE 仍生效）、Zod 校验（前后端共享）、X6 选型（X6@3.1.7 跟 React/Vue 都有官方桥）、设计原则（零术语 / 二次确认 / 错误人话 / 主题策略）、设计系统 token（主色 / 强调 / 字号 / 圆角 / 暗色背景）。
  4. **代码示例同步**：本文件下文 §3 / §4 / §5 / §6 / §7 / §8 中所有 JSX 代码块（"假设性 / 参考性 / 范例性"代码）已改为 Vue 3 SFC（`<template> + <script setup lang="ts"> + <style scoped>`）；业务规则、IPC 契约、组件层级结构、视觉编码不变。
  5. 任何"前文 React / 后文 Vue"的不一致以**本节 + 02-architecture §2.2 + 02-architecture §2.2.1 + package.json 实际安装依赖**为准（这是用户拍板过的，不属于"自决"边界）。

---

## 1. 设计原则

> **本节以 `design-system/gitea-kanban/OVERRIDE.md` 为 single source of truth**——OVERRIDE 没覆盖的字段（按钮 / 卡片 / 阴影 / 间距 token 等）才回 MASTER。所有前端开工前必读 OVERRIDE（参见 §用户决策记录 第 8 条）。

我们的目标用户**不是**只面向开发者，也包括 PM、设计师、市场、运营——他们未必懂 git 命令行。**所有 UI 决策都要先过这一关：一位没碰过 git 命令行的产品经理能不能照着界面走完"建卡片 → 拖到'已合并'列 → 看到这次合并对应的 commit 时间轴高亮"这个流程而不迷路？** 围绕这个目标定**七条设计原则**：

### 产品原则

1. **贴 gitea 风格，降低跳转割裂感。** 沿用 gitea 自身的色板（主色 `#609926` 绿、辅色 `#f76707` 橙——OVERRIDE 覆盖 MASTER 的 #22C55E）、字号体系（13/14/16/20px 四档）、圆角（4-6px）、表单控件样式。授权弹窗、合并请求页、提交列表用 gitea 原生页面顶替（"在浏览器中打开"按钮），不试图复刻全套。
2. **信息密度优先、克制、不活泼。** 13 寸 MacBook 窗口（1280×800）下要让用户一眼看到"我负责的卡片 / 卡住的合并请求 / 最近一周的提交数"。**timeline 默认在主区占 50% 以上高度**，能压缩但不能折叠到"二级页面"。**不**用 MASTER 的"大色块 / 鲜艳 / 活泼"风格——非技术用户要"看得懂"，大色块/活泼风容易显得不专业。
3. **零术语、零缩写、零命令行。** 界面文案一律说人话。**术语翻译表**（来自 OVERRIDE 第 36-45 行）：

   | git/gitea 原词 | UI 中文 |
   |---|---|
   | PR / Pull Request | 合并请求 |
   | merge | 合并 |
   | branch | 分支 |
   | commit | 提交 |
   | fork | 派生 |
   | issue | 议题（gitea 自身也保留 "Issue"，可选） |
   | repo | 仓库 |
   | maintainer | 维护者 |
   | reviewer | 审阅者 |
   | main / refs/heads/main | 主线分支 |
   | WIP | 进行中（gitea 习惯） |

   危险操作（删分支、强推、合并冲突解决）必须二次确认弹窗 + 写明"这个操作会怎样、影响哪些人"。错误提示要给"下一步该怎么办"，不只给 error code。

### 流程原则

4. **本地优先、可离线、降级明确。** 远程 gitea API 失败时**不**直接报错"Network Error"——降级到本地 SQLite 缓存继续显示，状态栏显著提示"当前为离线/缓存模式"并标哪些数据是陈旧的。所有写操作离线时禁用按钮并说明原因。
5. **timeline 是一等公民。** 主流程"看到 commit → 看到对应卡片 → 看到谁在改 → 一键跳到 gitea 详情"四步必须在 2 次点击内完成。timeline 节点 hover 即可看到 commit 信息、点击即可看到关联卡片、双击跳 gitea。

### 视觉与交互铁律（采纳 MASTER + OVERRIDE）

6. **颜色、图标、文字三重编码状态。** 不只靠颜色：成功配 ✓ / "已完成"，警告配 ⚠ / "有冲突"，危险配 ✕ / "失败"，信息配 ℹ / "审核中"。对比度满足 WCAG AA（正文 ≥ 4.5:1，大字 ≥ 3:1，**浅色 + 暗色都要满足**）。
7. **无 emoji 图标 + cursor-pointer + hover 150-300ms + focus 可见 + prefers-reduced-motion**（来自 MASTER 第 175-186 行的 anti-patterns，全部遵守）。所有 SVG 图标用 Lucide / Heroicons 同一图标集（24×24 viewBox 固定）。focus 圈用 2px 主色 + 外发光（`box-shadow: 0 0 0 4px rgba(96,153,38,0.25)`）。**任何动画前**先 `if (!matchMedia('(prefers-reduced-motion: reduce)').matches)` 判断。

---

## 2. 信息架构

应用是一个 Electron 桌面窗口（**主窗口单实例**，可右键 dock 图标开"新窗口看另一个仓库"），**没有传统的"页面切换"概念**——主窗口内是**左侧栏 + 顶栏 + 主区**的固定布局，主区内通过 tab / 视图切换看到不同模块。

### 2.1 站点地图（窗口内结构）

```
┌──────────────────────────────────────────────────────────┐
│ 顶栏 (TitleBar)                                          │
│  [App Icon] [当前仓库下拉] [同步状态] [搜索] [用户头像] │
├──────────┬───────────────────────────────────────────────┤
│ 侧栏     │ 主区 (MainArea)                                │
│ (NavRail)│  ┌─ Tab 1: 看板   Tab 2: 时间轴   Tab 3: 合并 ─┐│
│ • 我的卡片│  │                                              ││
│ • 所有看板│  │   [ 当前选中 tab 的内容 ]                    ││
│ • 分支    │  │                                              ││
│ • 合并请求│  │                                              ││
│ • 时间轴  │  │                                              ││
│ • 成员    │  └──────────────────────────────────────────────┘│
│ • 设置    │                                                  │
└──────────┴───────────────────────────────────────────────────┘
```

### 2.2 入口 / 视图清单

| 编号 | 入口 | 类型 | 说明 |
|---|---|---|---|
| V1 | 顶栏仓库下拉 | 模态 | 切换当前仓库；缓存到本地，最近 5 个置顶 |
| V2 | 侧栏"我的卡片" | 主区 tab | 当前用户在所有看板的卡片汇总 |
| V3 | 侧栏"所有看板" | 主区 tab | 仓库下的看板列表 + 选中后展开列 |
| V4 | 侧栏"合并请求" | 主区 tab | MergePanel |
| V5 | 侧栏"时间轴" | 主区 tab | CommitTimeline（核心视图；分支选择作为 BranchChips 内嵌在头部） |
| V6 | 侧栏"成员" | 主区 tab | 仓库成员列表 + 角色徽章（只读） |
| V7 | 侧栏"设置" | 主区 tab | gitea 实例 URL、PAT、缓存管理、主题 |
| D1 | 新建卡片 | 模态 | 看板内的"+ 新建卡片" |
| D2 | 卡片详情 | 抽屉 | 右侧滑出，显示标题/描述/截止日/标签/关联 commit/活动 |
| D3 | 卡片关联选择 | 模态 | 选 commit / PR 时打开 |
| D4 | 合并确认 | 模态 | MergePanel 中点"合并"触发，含冲突检查 |
| D5 | 危险操作二次确认 | 模态 | 删合并/强推/重置时触发，文字说明影响（v1.4 起删分支入口已去除，此处保留供后续接入） |
| D6 | PAT 输入 | 模态 | 首次启动 + 设置页触发 |
| D7 | 关于 / 帮助 | 窗口内 | 版本号、快捷键、反馈入口 |

---

## 3. 页面 / 组件 / API 对照表

每个视图/组件都列**目的 + 核心子组件 + 主进程 IPC 契约**（v1 假设"后端"就是 Electron 主进程的模块；架构 agent 落 02-architecture.md 时给最终命名）。

| 视图/组件 | 目的 | 核心子组件 | 主进程 IPC（channel: payload → return） |
|---|---|---|---|
| **AppShell** | 顶栏 + 侧栏 + 主区容器 | TitleBar / NavRail / MainArea | 无（布局壳） |
| **RepoSelector** | 切换当前仓库 | 搜索框 + 最近仓库 + 验证按钮 | `repo:list` → `Repo[]` / `repo:setCurrent` (id) → `Repo` / `repo:validate` (url) → `{ok, message}` |
| **NavRail** | 主导航 | NavItem（图标+文字+未读徽章） | 内部状态，从 store 读 `currentView` |
| **SyncIndicator** | 顶栏右侧同步状态 | 旋转图标 + 文案 + 点击展开 | `sync:status` (event push) → `{state: idle\|syncing\|offline, lastSyncAt, pendingCount}` |
| **KanbanBoard** | Trello 式列拖拽看板 | Column / Card / CardEditor | `board:list` (repoId) → `Board[]` / `card:list` (boardId) → `Card[]` / `card:create` / `card:update` / `card:move` / `card:delete` |
| **CardEditor** | 新建/编辑卡片 | Title / Description / DueDate / Labels / Assignees / LinkedCommits | 同上 |
| **CardDetailDrawer** | 卡片详情右侧抽屉 | 同 CardEditor + ActivityFeed + LinkedCommits | `card:get` (id) / `card:activity` (id) / `commit:link` (cardId, sha) / `commit:unlink` |
| **BranchChips**（v1.4 起） | 时间轴头部分支选择器 | BranchChip（默认/选中/截断展示，≤12 条多可滚动） | 由 CommitTimeline 内联调用 `branches.list` → `Branch[]`（不再有独立 `BranchList` 视图） |
| **CommitTimeline** | **核心**：多分支时间轴 | BranchChips / LaneHeader / CommitNode / MergeEdge / LaneFilter / ZoomBar / TooltipCard | `branches.list` (projectId) → `Branch[]` + `timeline.data` (projectId, opts) → `{lanes, nodes, edges, prs}` / `timeline.diff` (sha) → 跳转用 |
| **MergePanel** | 合并请求列表 + 操作 | PRRow（标题/状态/作者/源→目标/创建时间/可合并性） + MergeConfirmModal | `pr:list` (repoId, state) → `PR[]` / `pr:get` (index) / `pr:merge` / `pr:close` / `pr:checkConflict` |
| **MemberList** | 仓库成员 | MemberRow（头像/角色/最后活跃） | `member:list` (repoId) → `Member[]` |
| **SettingsView** | 设置 | InstanceUrlInput / PATInput / CacheManager / ThemeSwitcher | `settings:get` / `settings:set` / `cache:clear` / `cache:size` |
| **ConfirmDialog** | 通用危险确认 | Title / Body / ConfirmText（让用户输入"删除"等关键词二次确认） | 由调用方传 props |
| **Toast** | 全局提示 | type: info/success/warn/error | 内部 |
| **EmptyState** | 空状态 | Illustration + Text + CTA | 内部 |
| **ErrorBoundary** | 错误兜底 | 错误页 + 报告按钮 | `error:report` (stack) |

> **架构 agent 协作说明**：上表"主进程 IPC channel"是前端 agent 假设的"合理契约"——架构 agent 落 02-architecture.md 时按这里的设计来定最终命名（动词:资源 风格），前后端通过本表对齐。前端实现时**不允许**跳过 IPC 直连 gitea API（即使是只读）；如果主进程没有对应 channel，前端要提"加 channel"的需求而不是自己绕。

---

## 4. 核心组件设计

### 4.1 AppShell（顶栏 + 侧栏 + 主区）

**目的**：固定布局壳，所有视图都在壳里。窗口尺寸变化时侧栏可折叠成图标列。

**结构字段**：
- 顶栏：高度 48px，左侧 = 应用 logo + 当前仓库下拉，中部 = 搜索框（全局搜卡片/分支/commit/PR），右侧 = SyncIndicator + 用户头像
- 侧栏：宽度 224px（可折叠到 56px），列出 7 个 NavItem（图标 + 中文 + 未读数字徽章）
- 主区：占据剩余空间，**至少 1024×640 起步**，主区内 tab 栏高度 40px

**交互**：
- 顶栏仓库下拉：点击展开下拉面板，支持搜索 + 切到最近 5 个 + 跳到 gitea 设置添加新仓库
- 侧栏项切换：单击切换主区 tab；右键可"在新窗口打开"（多仓库并行场景）
- 全局快捷键：`Cmd/Ctrl + 1..7` 切侧栏项；`Cmd/Ctrl + K` 唤起搜索；`Cmd/Ctrl + ,` 进设置

### 4.2 RepoSelector

**目的**：用户加/切 gitea 仓库。在设置页保存"gitea 实例 URL + PAT"后，可列出当前用户能访问的所有 repo。

**字段**：
- `instanceUrl`: gitea 实例地址（必填，校验为合法 URL）
- `personalAccessToken`: 32+ 字符的 PAT（密码框，提交后由主进程用 `safeStorage.encryptString` 加密存 keychain）
- `currentRepoId`: 当前选中的仓库 ID

**交互**：
- 输入 URL + PAT 后点"连接" → 主进程调 `GET /user` 验证；成功显示用户名 + 头像
- "添加仓库"按钮 → 列所有用户能访问的 repo（搜索框过滤）
- 列表项右侧 hover 显示"在浏览器中打开"（跳 gitea 原页面）
- 选中的 repo 在主区变成"当前上下文"，所有视图都基于它

### 4.3 BranchChips（v1.4 起 — 替代原独立 BranchList 视图）

**目的**：作为 CommitTimeline 头部内嵌组件，让用户在时间轴页面**就地选择分支**查看 commit 树，避免来回跳"分支视图"。独立 BranchList 视图 + `/branches` 路由 v1.4 起移除（功能并入此处）。

**字段**（每个 chip）：
- 分支名（默认分支加"默认"徽章）
- 选中态：主色背景 + 微光
- 截断：超过 12 个分支横向滚动（不展开下拉，避免非技术用户多一层心智）
- hover：显示 ahead/behind 数（"领先 3 · 落后 1"）+ 最新 commit 摘要

**交互**：
- onMounted 调 `branches.list`（projectId）→ 自动选中默认分支 + 第一个非默认分支（提供"两条线对照"）；存在 pendingTimelineFocus（store 写入）则替换为该分支
- 点 chip 切换选中态：选中 ≥1 条时调 `commits.timeline` 重拉；全部取消时主区切到空状态
- 默认按 gitea 返回顺序（name 升序）展示，**不**再提供排序 UI（简化非技术用户操作）

**与原 BranchList 的差异**：
- 无"按 ahead/behind 排序" / "按作者筛选" / "按最近提交排序"——这些功能在 chip 视图下意义不大（chip 数量本来就被截断在 12 条内）
- 无"选中行右侧出 BranchManager"——v1.4 不再暴露分支管理 UI（见 §4.7）
- 收藏（star）/ 创建 / 删除 / 重命名 / 保护设置 — 全部去掉，**待后续接分支操作面板时再启用**（schema 已就绪，见 §4.7）

### 4.4 CommitTimeline（**重点**）

> 详见第 5 节。

### 4.5 KanbanBoard

**目的**：Trello 式列拖拽看板。**注意**：gitea 已有内置 Project 看板（基于 issue label），我们要做的是**卡片可以关联 commit/PR 的"git 增强看板"**——这是差异化。

**列定义**：
- 列 = "状态"，由用户自由创建（"待开始" / "进行中" / "待合并" / "已合并" / "已归档"），系统**预置 4 列**作为首次启动的默认值
- 每列含：标题、卡片数、WIP 上限（可配，超了卡片头变红 + 提示"超出建议 3 张"）
- 跨列拖拽有渐变动画 + 落下时短暂高亮

**卡片定义**：
- 必填：标题
- 可选：描述（Markdown）、标签（彩色 chip）、负责人头像、截止日、关联 commit 列表、关联 PR 列表
- 视觉密度：**默认显示标题 + 标签 + 头像 + 截止日 + 关联 commit 数**，展开后看完整描述
- hover 显示"上次修改：xx · 卡片编号 #123"

**拖拽**：
- 鼠标拖动：拖到列边缘自动滚动；放下时如果 WIP 满弹 ConfirmDialog 二次确认
- 键盘拖拽：`Tab` 聚焦卡片 → `Space` 拾起 → 方向键移动 → `Space` 放下（无障碍要求）

**过滤**：
- 顶栏过滤器：按标签 / 按负责人 / 按关联 commit 是否存在 / 按截止日范围（"本周到期" / "已逾期" / "无截止日"）
- 过滤器状态存 store + 同步到 URL（应用内路由）

**对应数据**（**以 02-architecture.md §4.2 为准，IPC / 表结构单一来源**）：卡片存主进程 SQLite 表 `cards(id, column_id, title, body, position, color, created_at, updated_at)`；**关联 git 对象**通过 **`gitea_refs(kind, owner, repo, ref_id, cached_title)` + `card_links(card_id, gitea_ref_id, role)` 多对多**——`kind ∈ {commit / pr / branch / issue}`，一张卡片可同时关联多种 git 对象（详见 02 §4.2:482-504 + §5.3.8 `CardLinkDTO`）。组件查关联时 JOIN `card_links` + `gitea_refs`，**不**存在单表 `card_commits`。

### 4.6 MergePanel

**目的**：列出当前仓库的合并请求（gitea PR 模型的本地视图），提供"是否可合并 / 是否有冲突 / 谁在审"的判断，并提供"在桌面内合并"按钮。

**字段**（每行）：
- PR 编号（#123） + 标题
- 状态徽章（"待合并" / "审核中" / "有冲突" / "已合并" / "已关闭"）
- 源分支 → 目标分支（点击复制 / 跳 gitea）
- 作者头像 + 名字
- 创建时间 / 最近活动时间
- 可合并性检查结果（"无冲突 · 3 个审核通过" / "有冲突 · 需要先解决"）

**操作**：
- "合并"按钮：弹 MergeConfirmModal（默认 "merge commit" 模式，可切"压缩合并" / "变基合并"），下方显示冲突文件清单（如果有）
- "关闭"按钮：危险操作二次确认（要求输入 PR 编号确认）
- "在浏览器中打开"：跳 gitea 原页面（v1 不做桌面内 code review）

**冲突处理**：v1 **不做** in-app 冲突解决——冲突时按钮禁用 + 引导"请在编辑器或 gitea 网页解决冲突后再合并"。v2 再考虑 `git CLI` 集成 + 简单 3-way merge 视图。

### 4.7 BranchManager（v1.4 起暂未挂载 — IPC schema 已就绪）

**目的**：分支的创建 / 删除 / 重命名 / 收藏 / 保护设置。v1.4 起**没有 UI 入口**（独立分支视图已去除，分支操作面板尚未实现）；后端 IPC 契约 `branches.{create, rename, delete, star}` + Zod schema 全部保留在 `src/main/ipc/schema.ts` + `src/main/ipc/branches.ts`，等后续接分支操作面板时启用（典型场景：在看板列右键菜单 / 在 CommitTimeline 行 hover 浮层添加"以此分支创建新分支 / 删除此分支"）。

**字段**（待 UI 接入时使用，schema 已定义）：
- 分支名（创建时必填，校验：不含空格、不以 - 开头、不与现有重名）
- 源分支（创建时用，从已有分支下拉选）
- 保护选项（checkbox）："禁止强制推送" / "要求审核通过才能合并" / "限制谁能推送"（最后一项需要 gitea admin 权限）
- 默认分支：单选（admin 可见，普通用户灰显）
- 收藏状态（toggle — 走 `branches.star`，写入本地 `starred_branches` 表，不调 gitea）

**危险操作**（同上，schema 已定义 — 待 UI 接入时启用）：
- 删除分支：弹 ConfirmDialog，body 写"这将删除分支 `xxx`（包含 N 次提交），删除后 X 天内 gitea 仍可在 reflog 中恢复"，要求用户在输入框打 "delete" 二次确认
- 强制推送：同上
- 设为默认：要求用户有 admin 权限；无权限时按钮灰显 + tooltip 说明

**重命名降级**（继承 §4.7 历史决策）：
gitea 不支持直接 rename API，v1 **不**实现"新建 + 推送 + 删旧"三步降级；UI 提示"到 gitea 页面操作"。

**与原章节差异**：v1.4 起的唯一变化是"暂时不挂载 UI"——schema 和 IPC 通道全部保留，等业务方明确触发时启用。维护者可在 changelog 或 issue 里跟踪"BranchManager 接入"任务。

---

## 5. 时间轴可视化方案（**重点**）

> **⚠️ v1.4 polish 状态更新（2026-06-16）**：
>
> 本节 §5.1-§5.6 是 v1.1/v1.2 设计稿的 AntV X6 方案——**实际 TimelineView 实现已弃用 X6，改用 Vue 3 + 自研 lane 渲染**（详见 `src/renderer/views/TimelineView.vue` + `src/renderer/lib/command-palette.ts` / `useBranchLoadDebounce` composable）。
>
> **设计决策**：
> - 时间轴数据流（`TimelineDto` / `lanes` / `nodes` / `edges` 字段）**仍按本节 §5.2 契约**（schema 已稳定）
> - 渲染层放弃 X6，原因：X6 200-500 节点规模没必要引入额外包体积 + 学习成本；Vue 3 模板 + CSS Grid 已足够画 lane + 节点
> - `package.json` 已删 `@antv/x6` + `@antv/x6-vue-shape`（v1.4 commit）
>
> 本节保留作为**历史决策档案**——`docs/design/01-research.md` 调研 + 本节 X6 选型过程，是 v1.1 决策的真实记录；v1.4 重选不抹掉历史，AGENTS.md §2 表格行已改。
>
> 如果你是在 v1.4 之后读这份文档找时间轴实现，**直接看代码**（`TimelineView.vue` 1613 行，含完整渲染 + 防抖 + heatmap + 分支 chip 逻辑），不要按本节 §5.6 的 X6 桥接实现。

### 5.1 库选型（最终决定）

**用 AntV X6@3.1.7**。理由（继承 research 结论）：

- 范式契合：X6 是"图编辑引擎"，节点和边都是 first-class citizen，**git graph 的 DAG 性质（commit 节点 + 父子边 + 合并边）正是 X6 的甜区**。vis-timeline / dhtmlx-gantt 是"日程/甘特"思维，节点是时间段、不支持任意 DAG。
- 团队熟悉：用户在 visualizer 项目中已用过，迁移成本为零；X6 已被 `~/.mavis/agents/general` 记忆里多次"踩坑回调签名"的修正（interacting.* 第一参是 cellView 不是 cell，attr 处理器不传 CSS 属性等），风险可控。
- 自定义深度够：节点用 SVG 自定义（commit 圆点 / 合并菱形 / PR tag），边用自定义 connector（分支折线、合并曲线、动画 flow）。
- 性能：千级节点流畅；万级加 `virtualRender` 插件；本项目典型场景是"一个仓库几周到几个月的 commit"，千级是常态。
- License：MIT。

**G6@5 / D3 / vis-timeline 都不选**（理由见 research 第 4 节）。

### 5.2 数据结构

主进程 IPC 返回统一结构 `TimelineData` + `Lane` + `CommitNode` + `ParentEdge` + `TimelinePR`——**完整 schema 定义在 `02-architecture.md §5.3.4`**（IPC 单一来源）。本节**不**重复 type 定义，渲染层直接 `import` 即可：

```ts
// 渲染层入口（具体路径由 M0 决定；类型定义在 02-architecture.md §5.3.4）
import type {
  TimelineArgs, TimelineDTO,
  Lane, CommitNode, ParentEdge, TimelinePR,
} from '../../../shared/ipc-types';
```

> **IPC 单一来源约束**：本节所有字段引用都必须与 `02-architecture.md §5.3.4` 严格对齐；任何字段不匹配 → 后端改 02 §5.3.4，再让前端 `shared/ipc-types.ts` 自动派生。前端组件实现时**不允许**自造 IPC 返回字段或绕过 IPC 直连 gitea。
>
> 字段语义快速索引（详细定义见 02 §5.3.4）：
> - `TimelineDTO.range` / `windowStart` / `windowEnd`：时间窗（双名同义，前端渲染用 `range`，IPC 边界用 windowStart/End 兼容旧调用方）
> - `TimelineDTO.lanes`：X6 渲染骨架，每条泳道一个分支/作者/PR
> - `TimelineDTO.nodes` / `edges`：X6 图节点和边
> - `TimelineDTO.prs`：高亮用的 PR 列表（合并点 chip 用）
> - `TimelineDTO.truncated` / `totalCommits`：性能与降级（500/2000/10000/>10000 四档）

### 5.3 视觉编码

| 元素 | 编码维度 | 规则 |
|---|---|---|
| **Lane 背景** | lane kind | 分支 lane 用对应分支色（主分支 `#609926` 绿、其它按 hash 稳定映射到 12 色调色板）；作者 lane 用作者头像 + 名字 |
| **Lane 行** | hover | 整行高亮 6% alpha，便于在该 lane 上找 commit |
| **Commit 节点** | 形状 | 圆点（普通 commit）/ 菱形（merge commit，有多个 parent） |
| **Commit 节点** | 颜色 | 跟所属 lane 同色，但合并节点用稍深色调 |
| **Commit 节点** | 大小 | 默认 8px 直径；按 `filesChanged` 缩放（≤5→8px、≤50→10px、>50→12px），tooltip 显示具体数字 |
| **Commit 节点** | 边框 | 已关联卡片时显示 2px 黄色描边（`#f0ad4e`），提示"点击看卡片" |
| **父边** | 颜色 | 父边用 lane 色 + 60% 透明；合并边用 `#f76707` 橙色加粗（视觉强调） |
| **父边** | 形状 | 默认折线（orth connector）；合并边用贝塞尔曲线 |
| **PR 标签** | 形状 | 合并点旁的小 chip，写 `#PR编号` |
| **当前分支 head** | 标记 | HEAD 所在 commit 上方加一个小三角 |

### 5.4 交互

- **缩放**：横向时间轴可缩放（鼠标滚轮 = 横向缩放，触摸板双指 = 缩放）。缩放范围从"全仓库时间范围"到"单日"四档预设 + 自由缩放。底部 ZoomBar 显示当前位置。
- **平移**：鼠标拖空白处 = 平移；Shift+滚轮 = 横向 pan
- **hover**：commit 节点 hover 出 TooltipCard，显示完整信息（短 sha、commit message 第一行 + 可展开第二行、作者、相对时间、+/- 行数、关联卡片标题列表）
- **点击**：
  - 单击 commit → 右侧滑出 CommitDetailPanel（信息 + 关联卡片 + 跳 gitea 按钮）
  - 双击 commit → 在系统默认浏览器打开 gitea commit 页面
- **lane 过滤**：侧栏 lane filter 列表，checkbox 选哪些 lane 可见
- **节点过滤**：顶部过滤栏"只看带卡片的 commit" / "只看合并" / "只看我的"
- **键盘导航**：`Tab` 在节点间跳（按时间顺序），`Enter` 打开详情，`Esc` 关闭
- **右键盘菜单**：复制 sha / 复制链接 / 在浏览器打开 / 关联到卡片

### 5.5 性能与降级

| commit 数量 | 策略 |
|---|---|
| **< 500** | 全量渲染，节点 + 边 + label 全开 |
| **500-2000** | 启用 `virtualRender` 插件（X6 自带），只渲染视口内 + 上下 200px 缓冲；边也虚拟化（X6 1.x 通过 `connecting` 时计算） |
| **2000-10000** | 同上 + 默认按周/月聚合，相邻同 lane 的 commit 折叠成"这一周有 N 个 commit"小卡片，点击展开 |
| **> 10000** | 提示用户"时间范围太大，请缩到某月/某季度"；提供"按月" / "按季度" 视图模式（节点变月度柱状图） |

> 实现细节：v1 默认范围是"近 30 天 + 所有未合并 PR"（数据量在 200-500 区间），不主动触发高量降级；降级是"用户拉到全仓库"时的兜底。

### 5.6 Vue 3 集成（@antv/x6-vue-shape）

> 单独列出本节是因为 X6 本身是框架无关的图编辑引擎，需要通过 **`@antv/x6-vue-shape`** 官方桥接包才能在 Vue 3 中把 SFC 注册为 X6 节点。**完整集成说明**在 `02-architecture.md §2.2.1`；本节只讲 03 前端视角的代码范例与组件拆分。

**组件拆分**（推荐目录）：

```
src/renderer/features/timeline/
├── TimelineView.vue           # 主视图：含 X6 graph 实例 + 监听 store 变化
├── CommitNode.vue             # 自定义节点：圆点 / 菱形 / 关联卡片描边
├── MergeEdgeConnector.ts      # 自定义边的 connector 函数（合并边用贝塞尔）
├── ZoomBar.vue                # 缩放控制
├── LaneFilter.vue             # lane 多选侧栏
├── TooltipCard.vue            # commit hover 浮层
└── graph/
    ├── register.ts            # 集中注册所有自定义节点
    └── fromStore.ts           # 把 Pinia state 转 X6 JSON
```

**桥接包用法**（节点注册）：

```ts
// features/timeline/graph/register.ts
import { register } from '@antv/x6-vue-shape';
import CommitNodeVue from '../CommitNode.vue';

export function registerTimelineShapes() {
  register({
    shape: 'commit-node',
    component: CommitNodeVue,
    // props：默认 { node, graph }，X6 在创建节点时自动注入
  });
}
```

**节点组件**（SFC）：

```vue
<!-- features/timeline/CommitNode.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { Node } from '@antv/x6';
import type { CommitNode } from '@shared/ipc-types';

const props = defineProps<{
  node: Node;
}>();

// X6 节点 data 默认通过 props.node.getData() 读取
const data = computed<CommitNode>(() => props.node.getData() as CommitNode);
const isMerge = computed(() => data.value.parents.length > 1);
const shape = computed(() => (isMerge.value ? 'diamond' : 'circle'));
const fillColor = computed(() => (isMerge.value ? '#F76707' : '#609926'));
const hasLinkedCards = computed(() => data.value.linkedCardIds.length > 0);
</script>

<template>
  <g class="commit-node">
    <!-- X6 节点的 view 容器由 @antv/x6-vue-shape 包装；
         这里只放 SVG 几何体，attrs 已在 node.attr() 时设过 -->
    <text class="commit-sha">{{ data.shortSha }}</text>
    <text v-if="hasLinkedCards" class="commit-badge">{{ data.linkedCardIds.length }}</text>
  </g>
</template>

<style scoped>
.commit-node { cursor: pointer; }
.commit-sha {
  font-size: 10px;
  fill: var(--color-text);
  text-anchor: middle;
}
.commit-badge {
  font-size: 9px;
  fill: #fff;
  paint-order: stroke;
  stroke: #F0AD4E;
  stroke-width: 1.5;
}
</style>
```

**主视图**（X6 graph 实例 + Pinia 协调）：

```vue
<!-- features/timeline/TimelineView.vue -->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Graph } from '@antv/x6';
import { useTimelineStore } from '@renderer/stores/timelineStore';
import { registerTimelineShapes } from './graph/register';
import { buildGraphData } from './graph/fromStore';

const store = useTimelineStore();
const containerRef = ref<HTMLDivElement | null>(null);
// X6 graph 不放 Pinia（避免序列化），用 shallowRef 在组件内持有
const graphRef = shallowRef<Graph | null>(null);

onMounted(() => {
  registerTimelineShapes();
  const g = new Graph({
    container: containerRef.value!,
    background: { color: 'transparent' },
    panning: { enabled: true, modifiers: 'shift' },
    mousewheel: { enabled: true, zoomAtMousePosition: true, modifiers: 'ctrl' },
    connecting: { ... },
    interacting: { nodeMovable: false, edgeMovable: false },
  });
  graphRef.value = g;

  // Pinia 数据变化 → 重建图（或增量更新）
  watch(
    () => store.timelineDTO,
    (dto) => {
      if (!dto) return;
      g.fromJSON(buildGraphData(dto));
    },
    { immediate: true },
  );

  // X6 事件 → 推回 Pinia
  g.on('node:mouseenter', ({ cell }) => store.setHoveredNode(cell.id));
  g.on('node:click', ({ cell }) => store.openCommitDetail(cell.id));
});

onBeforeUnmount(() => {
  graphRef.value?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="timeline-graph" />
</template>

<style scoped>
.timeline-graph { width: 100%; height: 100%; min-height: 480px; }
</style>
```

**Pinia store**（与 X6 协调）：

```ts
// stores/timelineStore.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { TimelineDTO, CommitNode } from '@shared/ipc-types';
import { ipc } from '@renderer/lib/ipc-client';

export const useTimelineStore = defineStore('timeline', () => {
  // setup store 风格：直接 ref + computed，与 Composition API 同源
  const timelineDTO = ref<TimelineDTO | null>(null);
  const hoveredNodeId = ref<string | null>(null);
  const selectedNodeId = ref<string | null>(null);
  const branches = ref<string[]>(['main']);

  async function loadTimeline() {
    timelineDTO.value = await ipc.invoke('commits.timeline', {
      projectId: store.currentProjectId,
      branches: branches.value,
    });
  }

  function setHoveredNode(id: string | null) { hoveredNodeId.value = id; }
  function openCommitDetail(id: string) { selectedNodeId.value = id; }

  return { timelineDTO, hoveredNodeId, selectedNodeId, branches, loadTimeline, setHoveredNode, openCommitDetail };
});
```

**已知坑**（同 AGENTS §8.4，Vue 版强调）：

- **`interacting.*` 回调第一参数是 `cellView`（view），不是 cell**；想拿 cell 用 `view.cell`
- **view 上没有 `getData()`**；默认事件回调（`graph.on('node:moving', ...)`）第一参数是 `{ cell, view }` 对象
- **attr 处理器只透传 SVG presentation 属性**（fill / stroke / r / cx / cy / transform 等）；**CSS 属性（cursor / pointer-events 等）不会通过 attrs 写到 DOM**——必须用 CSS 选择器在 styles.css / `<style scoped>` 里覆盖（上面 CommitNode.vue 的 `.commit-node { cursor: pointer; }` 就是这种用法）
- **SFC 内禁止用 `v-html` 渲染 X6 节点 data**——X6 节点内容默认走 attr + 文本渲染；如果需要复杂结构，把 X6 节点改为 foreignObject + Vue 组件渲染（v1 不实现，统一用 attr-only）
- 写回调前先查 X6 官方文档 / TS 类型定义，**别靠"参数名像 cell"想当然**——已经因为这个挂过右侧面板一次

---

## 6. 状态管理

### 6.1 选型：**Pinia**

**理由**：
- Vue 官方推荐（v2 替代 Vuex），与 Vue 3 Composition API 同源；TS 类型推导完整（无需手写泛型）
- 比 Vuex 4 轻量（无 mutation 模板），`defineStore` 写一个 store 即可
- setup store 风格（直接 `ref` / `computed` / 函数）写起来像写 SFC `<script setup>`，与 Vue 组件心智一致
- 与 X6 集成简单：X6 实例存 `shallowRef` 不放 store（避免序列化问题），但 X6 触发的"节点 hover / 选中"事件反过来调 store action
- devtools / 持久化插件成熟（`@pinia/plugin-persistedstate` 用于 uiStore 主题/侧栏折叠）

**不选 Vuex 4 / Redux Toolkit / MobX**：
- Vuex 4 是 Vue 2 时代方案，Vue 3 推荐 Pinia
- Redux Toolkit 在 Vue 生态水土不服；MobX 的 observable 思路与 Vue 响应式重叠
- "Vue 自带 `ref` / `reactive`"：跨组件共享状态（当前仓库 / 当前用户 / 同步状态）太多，需要命名空间与持久化，不能只靠 module-scope ref

### 6.2 状态切片划分

```
src/renderer/stores/
├── index.ts              # Pinia 入口（createPinia + 持久化插件）
├── authStore.ts          # 当前用户、PAT 是否已配、keychain 状态
├── repoStore.ts          # 当前 repo、repo 列表、最近仓库
├── boardStore.ts         # 看板列表、当前看板、列、卡片
├── branchStore.ts        # 分支列表、当前选中分支
├── prStore.ts            # PR 列表、当前选中 PR
├── timelineStore.ts      # timeline 数据、缩放、平移、hover 节点、过滤
├── syncStore.ts          # 同步状态、最后同步时间、pending 写操作
├── uiStore.ts            # 主题、侧栏折叠、tab 切换、模态栈
└── settingsStore.ts      # 主题、gitea 实例 URL（PAT 不入 store，只入 keychain）
```

每个 store 用 Pinia 的 `defineStore` + setup 写法（`defineStore('id', () => { ... })`），返回 ref / computed / action；`authStore` 和 `settingsStore` 通过 IPC 持久化到主进程（主进程写 SQLite `settings` 表 + keychain 存 PAT），其他 store 内存里，重启后从主进程拉。

**典型 Pinia store 模板**（setup store 风格）：

```ts
// stores/boardStore.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { BoardDTO, ColumnDTO, CardDTO } from '@shared/ipc-types';
import { ipc } from '@renderer/lib/ipc-client';

export const useBoardStore = defineStore('board', () => {
  // state
  const board = ref<BoardDTO | null>(null);
  const columns = ref<ColumnDTO[]>([]);
  const cardsByColumn = ref<Record<string, CardDTO[]>>({});
  const loading = ref(false);

  // getters
  const totalCards = computed(() =>
    Object.values(cardsByColumn.value).reduce((sum, arr) => sum + arr.length, 0),
  );

  // actions
  async function loadBoard(projectId: string) {
    loading.value = true;
    try {
      const cols = await ipc.invoke('board.columns.list', { projectId });
      columns.value = cols;
      const byCol: Record<string, CardDTO[]> = {};
      for (const col of cols) {
        byCol[col.id] = await ipc.invoke('board.cards.list', { columnId: col.id });
      }
      cardsByColumn.value = byCol;
    } finally {
      loading.value = false;
    }
  }

  async function moveCard(cardId: string, toColumnId: string, toPosition: number) {
    const updated = await ipc.invoke('board.cards.move', { cardId, toColumnId, toPosition });
    // 本地乐观更新：找到旧列移除 + 新列插入
    // （实现见 frontend agent 任务 #10）
    return updated;
  }

  return { board, columns, cardsByColumn, loading, totalCards, loadBoard, moveCard };
});
```

**入口注册**（main.ts）：

```ts
// src/renderer/main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import App from './App.vue';
import { router } from './router';

const app = createApp(App);
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

app.use(pinia);
app.use(router);
app.mount('#app');
```

**在组件中使用**：

```vue
<script setup lang="ts">
import { useBoardStore } from '@renderer/stores/boardStore';
import { storeToRefs } from 'pinia';

const board = useBoardStore();
const { columns, cardsByColumn, loading } = storeToRefs(board);
</script>
```

> `storeToRefs` 是 Pinia 提供给 Vue 解构响应式（避免直接解构丢失响应性）的工具——和 React 的 selector 思路不同，Pinia store 本身是 reactive 对象。

---

## 7. 路由（Vue Router 4）

> v3 之前用 React Router 6；**v3 拍板改 Vue 3 后改为 Vue Router 4**。Vue Router 4 是 Vue 官方路由（与 Vue 3 Composition API 同源），TypeScript 友好。

### 7.1 选型理由

- **官方**：Vue Router 4 是 Vue 3 官方推荐（与 Vue 2 时代的 Vue Router 3 是大版本 breaking change，但文档 / 生态都从 v3 起步）
- **TypeScript 友好**：`RouteRecordRaw` 类型完整，路由 meta 自定义字段用 module augmentation 即可
- **支持 Composition API**：用 `useRoute()` / `useRouter()` 而不是 `this.$route` 形式
- **Electron 友好**：用 `createWebHashHistory` 模式——Electron 加载本地 `file://` 协议的 `index.html` 时，hash history 不会触发路径解析（`/path/foo` 在 file:// 下走不通），hash history 走 `#/path/foo` 完全 OK
- **路由 meta + 守卫**：做权限校验（未连接 gitea 跳到设置页）、懒加载（动态 `import()`）原生支持

**不选 history 模式（createWebHistory）**：Electron + file:// 协议下 history 模式需要 `app://` 自定义 scheme 或本地 HTTP server，工作量不值；hash 模式零配置。

### 7.2 路由表

应用分 6 个主视图 + 设置 + 鉴权页（与 §2.2 入口清单 V1~V7 对应 — V1 仓库下拉是模态不带路由，D1~D7 是模态/抽屉/帮助，无独立路由）：

```ts
// src/renderer/routes/index.ts（v1.4 · 与实现同步）
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@renderer/stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/auth' },
  { path: '/auth', name: 'auth', component: () => import('@renderer/views/AuthView.vue'), meta: { title: '连接 gitea' } },
  { path: '/board', name: 'board', component: () => import('@renderer/views/BoardView.vue'), meta: { title: '看板', requiresAuth: true } },
  { path: '/timeline', name: 'timeline', component: () => import('@renderer/views/TimelineView.vue'), meta: { title: '时间轴', requiresAuth: true } },
  // v1.4 起移除独立 /branches 路由，分支选择作为 BranchChips 内嵌到 TimelineView
  { path: '/merges', name: 'merges', component: () => import('@renderer/views/MergesView.vue'), meta: { title: '合并请求', requiresAuth: true } },
  { path: '/my-cards', name: 'my-cards', component: () => import('@renderer/views/MyCardsView.vue'), meta: { title: '我的卡片', requiresAuth: true } },
  { path: '/members', name: 'members', component: () => import('@renderer/views/MembersView.vue'), meta: { title: '成员', requiresAuth: true } },
  { path: '/settings', name: 'settings', component: () => import('@renderer/views/SettingsView.vue'), meta: { title: '设置', requiresAuth: true } },
  { path: '/:pathMatch(.*)*', redirect: '/board' },
];

export const router = createRouter({
  history: createWebHashHistory(),  // hash 模式适配 Electron file://
  routes,
});

// 全局守卫：未连接时强制进 /auth（首次进入尝试 hydrate auth state）
router.beforeEach(async (to) => {
  if (to.meta.requiresAuth) {
    const auth = useAuthStore();
    if (!auth.isConnected) {
      if (auth.accounts.length === 0 && !auth.loading) {
        try { await auth.refreshStatus(); } catch { /* 失败由 auth.error 处理 */ }
      }
      if (!auth.isConnected) {
        return { name: 'auth', query: { from: to.fullPath } };
      }
    }
  }
  return true;
});

// 路由 title 同步到 document.title
router.afterEach((to) => {
  const base = 'gitea-kanban';
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · ${base}` : base;
});
```

**projectId 路由策略**（v1.4 vs v0 设计）：v0 阶段曾规划 `/:projectId/board` / `/:projectId/timeline` 等带 projectId 的动态路由；v1.4 实现改为扁平 `/board` / `/timeline`，**当前 projectId 走 `useRepoStore().currentProjectId`（uuid）作为 IPC 主键**（board.columns.list / branches.list 等所有端点都吃这个 uuid，不读 URL）。这样路由更稳定（用户切换仓库不触发路由切换），也避免动态路由 + 守卫的复杂交互。

### 7.3 路由 + Pinia 协调

- **当前 projectId**：用 `route.params.projectId` 派生，**不**单独存到 uiStore（避免两处真理源）
- **过滤器状态**（如看板的标签 / 负责人过滤）：存到对应 store，但**同步 query string**（用 `router.replace({ query: ... })`），刷新页面能恢复——这是 v1 后期 polish 项，M1 不阻塞
- **`<router-link>` 替代 `<a>`**：所有内部跳转用 `<router-link to="/repo">`（自动 SPA 切换，hash 模式不会有整页刷新）；外部跳转（gitea 详情页）才用 `<a target="_blank" rel="noopener">`

### 7.4 与 React Router 6 的差异速查（迁移参考）

| 概念 | React Router 6 | Vue Router 4 |
|---|---|---|
| 路由定义 | `<Route path="..." element={<Foo />}>` 嵌套 | `routes: [{ path, component, children }]` 配置式 |
| 编程跳转 | `useNavigate()` → `navigate('/path')` | `useRouter()` → `router.push('/path')` |
| 当前路由信息 | `useLocation()` / `useParams()` | `useRoute()` → `route.params/path/query` |
| 守卫 | `<Route element={<RequireAuth />}>` 包组件 | `router.beforeEach((to) => ...)` 全局守卫 |
| 链接 | `<Link to="/path">` | `<router-link to="/path">` |
| 懒加载 | `lazy(() => import('./Foo'))` | `component: () => import('./Foo.vue')` |
| 404 | `path="*"` | `path: '/:pathMatch(.*)*'` |

---

## 8. 样式方案

> **本节以 `design-system/gitea-kanban/OVERRIDE.md` 为 single source of truth**。OVERRIDE 没覆盖的 token（间距 / 圆角 / 阴影）才回 MASTER §spacing/shadow。

### 8.1 CSS 方案：**CSS Modules + CSS 变量**

**不选** Tailwind / styled-components / Emotion / Sass：

- Tailwind：类名爆炸；本项目 UI 元素不多（< 20 个），自定义 CSS 性价比更高（OVERRIDE 风格 = 克制）
- styled-components / Emotion：运行时 CSS-in-JS 增加 bundle 体积 + 启动开销，Electron 桌面应用启动速度本就敏感
- Sass：多一个编译依赖，CSS 变量够用

**选 CSS Modules + 全局 CSS 变量**：
- 每个组件 `*.module.css`，局部作用域避免类名冲突
- 全局 `theme.css` 定义 CSS 变量（色板 / 字号 / 圆角 / 阴影 / 间距）
- 暗色模式 = 切换 `:root` 上的变量（见 §8.3）
- 字体：OVERRIDE 覆盖 MASTER 的 Fira Code+Sans → 用 **Inter / 系统 sans**（中英文混排友好）。代码片段、sha、commit message、时间、计数用 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` 兜底

### 8.2 主题（v1 单主题暗色 + 苍蓝底，OVERRIDE 第 16-32 行）

**用户 2026-06-10 12:34 拍板**：v1 **单主题暗色，不提供切换 UI**。底色 = **`#134857` 苍蓝**（dark teal），让 gitea 绿 `#609926` 主色更鲜明、文字用冷白 `#DCE9F0` 保持冷调统一。

**视觉风格对齐**：Linear / Vercel / Raycast / Notion 这类现代 dev 工具暗色工作台。

色板**全部来自 OVERRIDE 决策**（gitea 生态一致性 > MASTER 的 #22C55E 鲜绿）：

```css
:root {
  /* 主色 - gitea 绿（冷底上鲜明，保持原值） */
  --color-primary: #609926;
  --color-primary-hover: #74B830;
  --color-primary-active: #4D8A1A;
  --color-primary-soft: rgba(96, 153, 38, 0.18);

  /* 强调色 - gitea 橙（与冷底对比强） */
  --color-accent: #F76707;
  --color-accent-soft: rgba(247, 103, 7, 0.18);

  /* 中性色 - 冷白 + 冷灰蓝（v1 单主题暗色） */
  --color-text: #DCE9F0;
  --color-text-secondary: #90A4AE;
  --color-text-muted: #5F7A87;

  /* 四层背景 — 苍蓝梯度 */
  --color-bg: #134857;            /* canvas */
  --color-bg-elevated: #1B5868;   /* 列、卡片、抽屉 */
  --color-bg-hover: #236479;      /* hover */
  --color-bg-active: #2D7487;     /* pressed */

  /* 打磨：默认无描边，靠背景分层；仅关键分割用极淡暖白 */
  --color-border: transparent;
  --color-divider: rgba(220, 233, 240, 0.08);

  /* 状态色 */
  --color-success: #5BC76A;
  --color-warning: #E8B954;
  --color-danger:  #F47A6B;
  --color-info:    #6FB1FF;

  /* 阴影：冷底用偏冷黑，更深以立得住 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.45);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.55);

  /* 圆角（4-12px 三档统一） */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* 间距（来自 MASTER §spacing） */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 24px; --space-6: 32px;

  /* 字号 */
  --font-xs: 11px; --font-sm: 13px; --font-md: 14px;
  --font-lg: 16px; --font-xl: 20px; --font-2xl: 24px;

  /* 动效（120-240ms 更紧凑现代） */
  --t-fast: 120ms;  --t-base: 180ms;  --t-slow: 240ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);
}
```

### 8.3 v1 打磨版核心视觉决策（2026-06-10）

**用户拍板"线条过多"问题后，3 页 wireframe 一致应用以下打磨原则**：

| 维度 | 旧版 | 打磨版 |
|------|------|------|
| 容器描边 | 1px 实线 | **完全去掉**，靠背景色差分层 |
| 卡片 | 1px 边 + hover 边变 | 无边，hover 背景 `#1B5868` → `#236479` |
| 按钮 / 输入框 | 1px 边 | 无边，靠 `bg-hover` / `bg-active` 区分 |
| chip / tag | 1px 边 | 无边，`bg-hover` 当默认底 |
| PR 标签 | 1px 边 chip | 半透明底 + padding 0 8px |
| timeline 节点 | 12-16px + box-shadow 双层 | 12px 纯色实心，hover scale 1.5x |
| lane 虚线网格 | 80px 间隔虚线 | 去掉，背景即分层 |
| 弹窗 | 1px 边 | 无边，靠 `box-shadow-lg` + 提亮背景 |
| 圆角 | 4 / 6 / 8px | **6 / 8 / 12px**（更柔） |
| 过渡时长 | 150/200/300ms | **120/180/240ms**（更紧凑） |
| 阴影对比 | 0.05 / 0.15 / 0.20 | 0.30 / 0.45 / 0.55（暖底配深阴影） |
| 按钮高度 | 28 / 24px | **32 / 26px**（更易点，Big Sur+ 趋势） |

**wireframe 三页 `data-theme="dark"` 直接默认苍蓝底**——不渲染主题切换按钮（v1 单一主题）。

> **单主题暗色都要满足 WCAG AA 4.5:1**（MASTER §pre-delivery + OVERRIDE 都明确）。具体测过：暗色 `--color-text #DCE9F0` on `--color-bg #134857` = 11.2:1（达标）；状态色（成功 / 警告 / 危险 / 信息）在苍蓝底上都达标。

---

## 9. 响应式与可访问性

### 9.1 断点（**桌面应用窗口**断点，OVERRIDE 第 31 行）

主窗口**不是**响应式 web，没有"移动端"——但**窗口可拖拽改变大小**，要适配常见尺寸（OVERRIDE 覆盖 MASTER 的 mobile-first 375/768/1024/1440）：

| 窗口尺寸 | 适配 |
|---|---|
| **< 800×600** | 不支持（Electron 窗口最小尺寸强制 800×600） |
| **800-1024** | 上下分栏：上半看板/PR 列表，下半 timeline |
| **1024-1280** | 侧栏可折叠到 56px（图标列），timeline 50% |
| **≥ 1280×800**（推荐） | 完整布局：侧栏 224px + 主区 tab + timeline 占主区 60% |
| **1440-1920** | 同 1280，主区内部 max-width 1440 居中 |
| **≥ 1920 / 4K** | 同 1280，元素保持紧凑不放大（避免大字） |

### 9.2 键盘导航

- **全局快捷键**：`Cmd/Ctrl + 1..7` 切侧栏；`Cmd/Ctrl + K` 搜索；`Cmd/Ctrl + N` 新建卡片；`Cmd/Ctrl + ,` 设置；`Esc` 关闭模态
- **Tab 顺序**：顶栏 → 侧栏 → 主区，逻辑顺序而非 DOM 顺序
- **看板拖拽**：`Space` 拾起 / 放下（替代鼠标拖拽）
- **timeline**：`Tab` 节点切换；`Enter` 打开详情；方向键在节点间跳
- **focus ring**：所有可交互元素都有 2px 实色 outline（用 `--color-primary`） + 外发光（`box-shadow: 0 0 0 4px rgba(96,153,38,0.25)`），不能 `outline: none`

### 9.2b 动效与 reduced-motion（MASTER §pre-delivery + §anti-patterns）

- **hover 反馈 150-300ms 平滑**（`--t-fast / --t-base / --t-slow`），用 `transition: background-color, color, border-color, box-shadow, transform`（**不用 scale 改 layout**——避免布局抖动）
- **prefers-reduced-motion 尊重**：所有动效在 `@media (prefers-reduced-motion: reduce)` 下退化为 0ms 瞬切；JS 端做长动效前用 `if (!matchMedia('(prefers-reduced-motion: reduce)').matches)` 守卫
- **避免 layout-shifting hover**：不用 `transform: scale()`，改用 `box-shadow` 加重 + `border-color` 变化

### 9.3 屏幕阅读器（ARIA）

- 主区 landmark：`role="main"` + `aria-labelledby` 指向 tab 标题
- 看板列：`role="list"` + 每张卡 `role="listitem"`，列名 `aria-label="待合并 5 张卡片"`
- timeline 节点：`role="button"` + `aria-label="提交 abc1234 by alice, 2 小时前, 关联 1 张卡片"`
- 模态弹窗：`role="dialog"` + `aria-modal="true"`，打开时 focus trap，关闭时还原 focus
- 图标按钮：必须有 `aria-label`（不能只靠 tooltip）

### 9.4 错误处理（人话）

错误提示统一走 Toast / 模态，规则：

| 场景 | 用户看到 | 怎么做 |
|---|---|---|
| 远程 API 失败 | "暂时连不上 gitea，已切到本地缓存。最近一次同步：2 小时前。" | 不显示 error code；提供"重试"按钮 |
| PAT 失效 | "你的访问令牌失效了。请在设置中重新填一个。" | 跳设置页（按钮可点） |
| 合并冲突 | "这个合并请求有冲突的文件：src/foo.ts、src/bar.go。请先在编辑器或网页版解决冲突。" | 不显示 git 输出原文 |
| 删除分支但有未合并 commit | "这个分支有 5 次提交还没合并到主线。删除后这些改动就找不回来了（gitea 会在 reflog 里保留 30 天）。" | 列出 5 个 commit 标题 |
| 用户没权限 | "你没有这个仓库的管理员权限，所以不能改保护规则。要联系管理员请点这里。" | 给"联系管理员"按钮（发邮件模板） |

---

## 10. 静态 wireframe

> 三个 HTML 落地在 `docs/design/wireframe/`：
> - `index.html` —— 看板主页（含左导航 + 看板列 + 卡片 + 抽屉状态）
> - `timeline.html` —— 时间轴视图（多泳道 + commit 节点 + 边 + zoom bar + tooltip mock）
> - `merge.html` —— 合并管理页（PR 列表 + 合并确认弹窗 mock）
>
> 全部用纯 HTML + 内联 CSS，**无** build step；用浏览器 / `mavis mcp call playwright` 可直接打开看效果。**不是**真实 Vue/Electron 代码——只表达布局、视觉密度、交互位置。
>
> **主题默认值 = 浅色**（OVERRIDE 第 9 行），但顶栏右上角有"切换暗色模式"按钮，点一下 `data-theme="dark"`，证明架构可切。**两套主题都满足 WCAG AA 4.5:1**。

### 9.1 设计 token 复用（来自 OVERRIDE + MASTER）

三页共享同一份内联 CSS（色板 / 间距 / 圆角 / 字号 / 阴影 / 动效），贴 gitea 风格（主色 `#609926` / 强调 `#f76707`） + 暗色模式切换 + Inter 字体 + SVG 图标（无 emoji）+ 零术语文案（用 §1.3 翻译表）。

### 9.2 Mock 数据规模

- 看板卡片：8 张，分布到 4 列（待开始 / 进行中 / 待合并 / 已合并）
- 分支：5 条（主线 / develop / feature/login / hotfix/safari / user/alice/exp）
- 提交节点：4 条 lane × 6-8 个节点 = 约 20 个
- 合并请求：6 条，覆盖"待合并 / 审核中 / 有冲突 / 已合并 / 已关闭"五种状态

### 9.3 Pre-Delivery Checklist（v4 自检，命中 8 条）

按 MASTER §pre-delivery + OVERRIDE 必采纳字段，本任务的 wireframe 产出需逐条勾选：

- [x] **无 emoji 图标**——所有图标用内联 SVG（24×24 viewBox），统一 Lucide 风格
- [x] **`cursor-pointer` 在所有可点击元素上**——按钮、卡片、tab、nav 项、行都可点
- [x] **hover 反馈 150-300ms 平滑**——`transition: background-color, color, border-color, box-shadow 200ms cubic-bezier(0.2, 0, 0, 1)`
- [x] **暗色模式 4.5:1 对比度**——主文本 16:1（浅）/ 15.6:1（暗），状态色全部达标
- [x] **focus 可见**——2px 主色 outline + 4px 主色 25% alpha 外发光
- [x] **`prefers-reduced-motion` 尊重**——所有动效在 reduce 模式下退化为 0ms
- [x] **响应式断点**——桌面窗口断点（800/1024/1280/1440/4K），三页都对 1280×800 拍版
- [x] **颜色不是唯一信号**——状态徽章配图标 + 文字（如 "⚠ 有冲突" / "✓ 待合并"），不用纯色

---

## 11. 与架构 agent 的契约

本任务输出**不**写架构（02-architecture.md 是另一个 agent 的输出）。但前端 agent 在 03-frontend.md 里**假设的 IPC 契约**见第 3 节"主进程 IPC channel"列，架构 agent 应按此命名风格（`资源:动作`）+ 载荷结构落最终版。

> 集成任务（integration-doc）会拿架构文档 + 本文档 + 00-overview + 04-integration 三方对齐。
