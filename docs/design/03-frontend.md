# 前端设计：UI/UX + 时间轴可视化 + 静态 wireframe

> 任务编号：frontend-design
> 输出版本：v3（默认暗色科技风格重定）
> 输出时间：2026-06-10

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

- **2026-06-10 10:28** —— 计划负责人再补一条：**UX 默认暗色科技风格**（dark-first tech aesthetic）。具体：
  1. **不再以"贴 gitea 风格"为首要原则**——gitea 自身偏浅色、绿橙，与"科技感"视觉语言（深色背景 + 高饱和强调色 + 微光 glow / 网格 / 等宽字体 / 渐变 accent）不完全契合。改为"gitea **数据模型 + 配色方向**借鉴，但视觉走**暗色科技**路线"。
  2. **默认主题 = 暗色**（不再"跟随系统"或"用户三选一"作为默认值）。浅色作为可选 secondary，**默认不提供切换按钮**（v1 单主题聚焦，避免分散精力）。
  3. **科技风视觉元素**：深色面板（#0d1117 / #0a0e14 / #161b22 三层）+ 主色发光（gitea 绿 #609926 配 8-12% alpha glow）+ 等宽数字与代码片段（JetBrains Mono / Fira Code）+ 背景细网格 / 极淡渐变 + 焦点圈用 2px 实色 + 1px 外发光；按钮、状态徽章带 6% alpha 渐变；卡片、节点用 1px 描边 + 8% 内发光模拟"显示器像素"。
  4. **暗色优先的可达性**反而更要做：暗背景下对比度要 ≥ WCAG AA（正文 4.5:1，大字 3:1）；状态色（红/绿/黄）必须配图标或文字（不要只靠颜色）；focus ring 用 2px 主色 + 外发光。
  5. wireframe 三页**默认 `data-theme="dark"`** 渲染；同时验证浅色 fallback（同一份 CSS 变量表，靠 `[data-theme='light']` 切换），保证架构上仍可切，但不提供入口。

---

## 1. 设计原则

我们的目标用户**不是**只面向开发者，也包括 PM、设计师、市场、运营——他们未必懂 git 命令行。**所有 UI 决策都要先过这一关：一位没碰过 git 命令行的产品经理能不能照着界面走完"建卡片 → 拖到"已合并"列 → 看到这次合并对应的 commit 时间轴高亮"这个流程而不迷路？** 围绕这个目标定五条设计原则：

1. **贴 gitea 风格，降低跳转割裂感。** 沿用 gitea 自身的色板（主色 `#609926` 绿、辅色 `#f76707` 橙）、字号体系（13/14/16/20px 四档）、圆角（4px）、表单控件样式。授权弹窗、合并请求页、提交列表用 gitea 原生页面顶替（"在浏览器中打开"按钮），不试图复刻全套。
2. **信息密度优先，装饰靠后。** 一个 13 寸 MacBook 窗口（约 1280×800）下要让用户一眼看到"我负责的卡片有哪些？哪些 PR 卡住了？最近一周有多少 commit 合并进来"。**timeline 是核心视图，不是装饰**——默认在主区占 50% 以上高度，能压缩但不能折叠到"二级页面"。
3. **零术语、零缩写、零命令行。** 界面文案一律说人话（"合并请求"不写"PR"、"主线分支"不写"main/refs/heads/main"）。危险操作（删分支、强推、合并冲突解决）必须二次确认弹窗 + 写明"这个操作会怎样、影响哪些人"。错误提示要给"下一步该怎么办"，不只给 error code。
4. **本地优先、可离线、降级明确。** 远程 gitea API 失败时**不**直接报错"Network Error"——降级到本地 SQLite 缓存继续显示，状态栏显著提示"当前为离线/缓存模式"并标哪些数据是陈旧的。所有写操作离线时禁用按钮并说明原因。
5. **timeline 是一等公民。** 主流程"看到 commit → 看到对应卡片 → 看到谁在改 → 一键跳到 gitea 详情"四步必须在 2 次点击内完成。timeline 节点 hover 即可看到 commit 信息、点击即可看到关联卡片、双击跳 gitea。

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
| V4 | 侧栏"分支" | 主区 tab | BranchList + BranchManager |
| V5 | 侧栏"合并请求" | 主区 tab | MergePanel |
| V6 | 侧栏"时间轴" | 主区 tab | CommitTimeline（核心视图） |
| V7 | 侧栏"成员" | 主区 tab | 仓库成员列表 + 角色徽章（只读） |
| V8 | 侧栏"设置" | 主区 tab | gitea 实例 URL、PAT、缓存管理、主题 |
| D1 | 新建卡片 | 模态 | 看板内的"+ 新建卡片" |
| D2 | 卡片详情 | 抽屉 | 右侧滑出，显示标题/描述/截止日/标签/关联 commit/活动 |
| D3 | 卡片关联选择 | 模态 | 选 commit / PR 时打开 |
| D4 | 合并确认 | 模态 | MergePanel 中点"合并"触发，含冲突检查 |
| D5 | 危险操作二次确认 | 模态 | 删分支/强推/重置时触发，文字说明影响 |
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
| **BranchList** | 分支列表 | BranchRow（保护/默认/最新 commit/作者头像） | `branch:list` (repoId) → `Branch[]` / `branch:default` |
| **BranchManager** | 创建/删除/重命名/保护分支 | 表单 + 确认弹窗 | `branch:create` (name, from) / `branch:delete` (name) / `branch:rename` (old, new) / `branch:setProtection` |
| **CommitTimeline** | **核心**：多分支时间轴 | LaneHeader / CommitNode / MergeEdge / LaneFilter / ZoomBar / TooltipCard | `timeline:data` (repoId, opts) → `{lanes, nodes, edges, prs}` / `timeline:diff` (sha) → 跳转用 |
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

### 4.3 BranchList

**目的**：列出当前仓库所有分支，提供"哪个分支最新、谁是负责人、是否被保护"的一眼洞察。

**字段**（每行）：
- 分支名（带"默认" / "受保护" 徽章）
- 最新 commit 摘要 + 时间（"2 小时前" / "昨天 14:30"）
- 距离默认分支的 ahead/behind 数（"领先 3 · 落后 1"）
- 作者头像 + 名字
- 操作：复制分支名 / 跳 gitea / 设为默认（如果有权限）

**交互**：
- 默认按"最近提交"排序，可切到"按名称 / 按作者 / 按 ahead 落后"
- 选中行后右侧出 BranchManager 面板（创建/删除/重命名/保护）

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

**对应数据**：卡片存主进程 SQLite 表 `cards(id, repo_id, board_id, column_id, title, description, due_at, label_ids, assignee_ids, created_at, updated_at)`；关联 commit 存 `card_commits(card_id, sha, repo_id)`。

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

### 4.7 BranchManager

**目的**：分支的创建/删除/重命名/保护设置。

**字段**（表单）：
- 分支名（创建时必填，校验：不含空格、不以 - 开头、不与现有重名）
- 源分支（创建时用，从已有分支下拉选）
- 保护选项（checkbox）："禁止强制推送" / "要求审核通过才能合并" / "限制谁能推送"（最后一项需要 gitea admin 权限）
- 默认分支：单选（admin 可见，普通用户灰显）

**危险操作**：
- 删除分支：弹 ConfirmDialog，body 写"这将删除分支 `xxx`（包含 N 次提交），删除后 X 天内 gitea 仍可在 reflog 中恢复"，要求用户在输入框打 "delete" 二次确认
- 强制推送：同上
- 设为默认：要求用户有 admin 权限；无权限时按钮灰显 + tooltip 说明

---

## 5. 时间轴可视化方案（**重点**）

### 5.1 库选型（最终决定）

**用 AntV X6@3.1.7**。理由（继承 research 结论）：

- 范式契合：X6 是"图编辑引擎"，节点和边都是 first-class citizen，**git graph 的 DAG 性质（commit 节点 + 父子边 + 合并边）正是 X6 的甜区**。vis-timeline / dhtmlx-gantt 是"日程/甘特"思维，节点是时间段、不支持任意 DAG。
- 团队熟悉：用户在 visualizer 项目中已用过，迁移成本为零；X6 已被 `~/.mavis/agents/general` 记忆里多次"踩坑回调签名"的修正（interacting.* 第一参是 cellView 不是 cell，attr 处理器不传 CSS 属性等），风险可控。
- 自定义深度够：节点用 SVG 自定义（commit 圆点 / 合并菱形 / PR tag），边用自定义 connector（分支折线、合并曲线、动画 flow）。
- 性能：千级节点流畅；万级加 `virtualRender` 插件；本项目典型场景是"一个仓库几周到几个月的 commit"，千级是常态。
- License：MIT。

**G6@5 / D3 / vis-timeline 都不选**（理由见 research 第 4 节）。

### 5.2 数据结构

主进程 IPC 返回统一结构 `TimelineData`：

```ts
type TimelineData = {
  range: { from: string /* ISO date */; to: string };
  lanes: Lane[];          // 每条泳道代表"一个分支 / 一个作者 / 一个 PR"，由 laneMode 决定
  nodes: CommitNode[];    // 每个 commit / 合并点
  edges: ParentEdge[];    // 父子关系 / 合并关系
  prs: PR[];              // 高亮用的 PR 列表
};

type Lane = {
  id: string;             // "branch:main" / "author:alice" / "pr:42"
  label: string;          // 显示文本
  kind: 'branch' | 'author' | 'pr';
  color: string;          // #609926 绿（主分支）/ #f76707 橙（活跃开发）/ #6c757d 灰（archived）
  order: number;          // y 轴排序（默认 main 在最上、其它按活跃度）
  hidden?: boolean;
};

type CommitNode = {
  id: string;             // sha
  laneId: string;         // 归属到哪条 lane
  x: number;              // 横向时间位置（由 from/to 归一化）
  y: number;              // 纵向 lane 位置
  sha: string;
  shortSha: string;       // 7 位
  message: string;        // commit message 第一行
  author: { name: string; avatarUrl?: string };
  timestamp: string;      // ISO
  parents: string[];      // 父 commit sha 列表
  isMerge: boolean;       // parents 数量 > 1
  linkedCardIds: string[];// 关联到本地卡片（来自 card_commits 表 join）
  additions: number;
  deletions: number;
  filesChanged: number;
};

type ParentEdge = {
  id: string;
  source: string;         // source node id
  target: string;         // target node id
  kind: 'parent' | 'merge'; // parent = 直接父子；merge = 合并 PR 时产生
  prIndex?: number;       // merge 时填，链接到 PR
};
```

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

---

## 6. 状态管理

### 6.1 选型：**Zustand**

**理由**：
- 比 Redux 轻量（无 action/reducer 模板），写一个 slice 一份 store 即可
- 比 React Context 性能好（按 selector 订阅，避免无差别 re-render）
- TS 友好：`create<State>()(set => ...)` 写起来和写 interface 一样自然
- 与 X6 集成简单：X6 实例存 ref 不放 store（避免序列化问题），但 X6 触发的"节点 hover / 选中"事件反过来 dispatch store

**不选 Pinia / Redux Toolkit**：
- Pinia 是 Vue 生态专用；不选 Vue 的话不必引入
- Redux Toolkit 在"应用规模 < 50 个组件、状态切片 < 10 个"时**过度工程**

**不选"React 自带 useState + useReducer"**：
- 跨组件共享状态（当前仓库 / 当前用户 / 同步状态）太多，Context 嵌套地狱
- 没有时间旅行 / devtools 不致命，但 Zustand 也能装 devtools middleware

### 6.2 状态切片划分

```
src/renderer/store/
├── index.ts              # 组合 rootStore
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

每个 store 用 Zustand 的 `create` 工厂；`authStore` 和 `settingsStore` 通过 IPC 持久化到主进程（主进程写 SQLite `settings` 表 + keychain 存 PAT），其他 store 内存里，重启后从主进程拉。

---

## 7. 样式方案

### 7.1 CSS 方案：**CSS Modules + CSS 变量**

**不选** Tailwind / styled-components / Emotion / Sass：

- Tailwind：类名爆炸；本项目 UI 元素不多（< 20 个），自定义 CSS 性价比更高
- styled-components / Emotion：运行时 CSS-in-JS 增加 bundle 体积 + 启动开销，Electron 桌面应用启动速度本就敏感
- Sass：多一个编译依赖，CSS 变量够用

**选 CSS Modules + 全局 CSS 变量**：
- 每个组件 `*.module.css`，局部作用域避免类名冲突
- 全局 `theme.css` 定义 CSS 变量（色板 / 字号 / 圆角 / 阴影）
- 暗色模式 = 切换 `:root` 上的变量

### 7.2 主题（贴 gitea 风格）

色板取自 gitea 自身（参考 gitea web 端 `public/css/theme-*`）：

```css
:root {
  /* 主色 - gitea 绿 */
  --color-primary: #609926;
  --color-primary-hover: #54a31d;
  --color-primary-active: #4d8a1a;
  
  /* 辅色 - gitea 橙 */
  --color-accent: #f76707;
  
  /* 中性色 */
  --color-text: #1f2328;
  --color-text-secondary: #59636e;
  --color-text-muted: #8b949e;
  --color-bg: #ffffff;
  --color-bg-elevated: #f6f8fa;
  --color-border: #d0d7de;
  
  /* 状态色 */
  --color-success: #1a7f37;
  --color-warning: #9a6700;
  --color-danger: #cf222e;
  --color-info: #0969da;
  
  /* 阴影 */
  --shadow-sm: 0 1px 0 rgba(31, 35, 40, 0.04);
  --shadow-md: 0 3px 6px rgba(140, 149, 159, 0.15);
  --shadow-lg: 0 8px 24px rgba(140, 149, 159, 0.2);
  
  /* 圆角 / 间距 */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  
  /* 字号 */
  --font-xs: 11px;
  --font-sm: 13px;
  --font-md: 14px;
  --font-lg: 16px;
  --font-xl: 20px;
  --font-2xl: 24px;
}

[data-theme='dark'] {
  --color-text: #e6edf3;
  --color-text-secondary: #adbac7;
  --color-text-muted: #768390;
  --color-bg: #0d1117;
  --color-bg-elevated: #161b22;
  --color-border: #30363d;
  /* ... 其它色对应翻转 */
}
```

### 7.3 暗色模式

- 跟随系统：`prefers-color-scheme` 媒体查询
- 用户可手动切：设置页提供 "浅色 / 深色 / 跟随系统" 三选
- 暗色模式下不重新调色板，只翻转 + 降饱和度（保持 gitea 绿橙在暗背景上的对比度）
- timeline 节点色、边色在暗色模式下用 12 色调色板的较亮版本

---

## 8. 响应式与可访问性

### 8.1 断点（Electron 窗口尺寸）

主窗口**不是**响应式 web，没有"移动端"——但**窗口可拖拽改变大小**，要适配常见尺寸：

| 尺寸 | 适配 |
|---|---|
| **≥ 1280×800** | 完整布局：侧栏 224px + 主区 tab + timeline 占主区 60% |
| **1024-1280** | 侧栏可折叠到 56px（图标列）；timeline 50% |
| **800-1024** | 主区变成"上下分栏"：看板 / PR 列表占上半，timeline 占下半 |
| **< 800** | 不支持（Electron 窗口最小尺寸限制为 800×600） |

### 8.2 键盘导航

- **全局快捷键**：`Cmd/Ctrl + 1..7` 切侧栏；`Cmd/Ctrl + K` 搜索；`Cmd/Ctrl + N` 新建卡片；`Cmd/Ctrl + ,` 设置；`Esc` 关闭模态
- **Tab 顺序**：顶栏 → 侧栏 → 主区，逻辑顺序而非 DOM 顺序
- **看板拖拽**：`Space` 拾起 / 放下（替代鼠标拖拽）
- **timeline**：`Tab` 节点切换；`Enter` 打开详情；方向键在节点间跳
- **focus ring**：所有可交互元素都有 2px 实色 outline（用 `--color-primary`），不能 `outline: none`

### 8.3 屏幕阅读器（ARIA）

- 主区 landmark：`role="main"` + `aria-labelledby` 指向 tab 标题
- 看板列：`role="list"` + 每张卡 `role="listitem"`，列名 `aria-label="待合并 5 张卡片"`
- timeline 节点：`role="button"` + `aria-label="提交 abc1234 by alice, 2 小时前, 关联 1 张卡片"`
- 模态弹窗：`role="dialog"` + `aria-modal="true"`，打开时 focus trap，关闭时还原 focus
- 图标按钮：必须有 `aria-label`（不能只靠 tooltip）

### 8.4 错误处理（人话）

错误提示统一走 Toast / 模态，规则：

| 场景 | 用户看到 | 怎么做 |
|---|---|---|
| 远程 API 失败 | "暂时连不上 gitea，已切到本地缓存。最近一次同步：2 小时前。" | 不显示 error code；提供"重试"按钮 |
| PAT 失效 | "你的访问令牌失效了。请在设置中重新填一个。" | 跳设置页（按钮可点） |
| 合并冲突 | "这个合并请求有冲突的文件：src/foo.ts、src/bar.go。请先在编辑器或网页版解决冲突。" | 不显示 git 输出原文 |
| 删除分支但有未合并 commit | "这个分支有 5 次提交还没合并到主线。删除后这些改动就找不回来了（gitea 会在 reflog 里保留 30 天）。" | 列出 5 个 commit 标题 |
| 用户没权限 | "你没有这个仓库的管理员权限，所以不能改保护规则。要联系管理员请点这里。" | 给"联系管理员"按钮（发邮件模板） |

---

## 9. 静态 wireframe

> 三个 HTML 落地在 `docs/design/wireframe/`：
> - `index.html` —— 看板主页（含左导航 + 看板列 + 卡片 + 抽屉状态）
> - `timeline.html` —— 时间轴视图（多泳道 + commit 节点 + 边 + zoom bar + tooltip mock）
> - `merge.html` —— 合并管理页（PR 列表 + 合并确认弹窗 mock）
>
> 全部用纯 HTML + 内联 CSS，**无** build step；用浏览器 / `mavis mcp call playwright` 可直接打开看效果。**不是**真实 React/Electron 代码——只表达布局、视觉密度、交互位置。

### 9.1 设计 token 复用

三页共享同一份内联 CSS（色板 / 间距 / 圆角 / 字号 / 阴影），gitea 风格 + 暗色模式支持。

### 9.2 Mock 数据规模

- 看板卡片：8 张，分布到 4 列
- 分支：5 条（main / develop / feature/login / hotfix/xxx / user/alice/experiment）
- 提交节点：3 条 lane × 6-8 个节点 = 约 20 个
- PR：6 条，覆盖"待合并 / 审核中 / 有冲突 / 已合并 / 已关闭"五种状态

---

## 10. 与架构 agent 的契约

本任务输出**不**写架构（02-architecture.md 是另一个 agent 的输出）。但前端 agent 在 03-frontend.md 里**假设的 IPC 契约**见第 3 节"主进程 IPC channel"列，架构 agent 应按此命名风格（`资源:动作`）+ 载荷结构落最终版。

> 集成任务（integration-doc）会拿架构文档 + 本文档 + 00-overview + 04-integration 三方对齐。
