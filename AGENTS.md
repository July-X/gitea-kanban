<!-- AGENTS.md — gitea-kanban -->
# AGENTS.md — gitea-kanban (v2.0 → v0.7.5)

> **本文件给所有 AI coding agent 和开发者读**。它是项目实现的入口规范；如果本文件与仓库里其它文档冲突，**以本文件为准**。
>
> 最后更新：2026-07-12（**v0.7.5 发版** — 系统事件 UX 文案对齐 Gitea web：22+ 种 CommentType 全部有具体 verb、PR 动作加 "此合并请求" 限定词、时间格式从 "X verb  ·  Y 天前" 改成 "X 于 Y verb"、移除 v0.7.x "事件" 通用 fallback、push event 数量解析 "推送了 N 个提交"）

>

> - **v0.6.0** (2026-07-08)：Gitea 平台深化 + PR 模块重构 + 代码瘦身。
>   1. **app.go 9 文件拆分**：主文件从 3563 行拆分为 app_auth / app_pull / app_gitgraph / app_repo / app_issue / app_sync / app_prefs / app_log / app_gitbinary 共 9 个领域文件，主文件精简到 226 行。
>   2. **MergesView.vue 三 Tab 重构**：概览 / 文件评论 / 对话流三 Tab；文件评论 Tab 按文件分组 + 折叠展开；对话 Tab 融合 review 事件（approval/request_changes/commented）用绿/橙/灰虚线边框卡片。
>   3. **PR 属性编辑器**：Milestone 全链路（列表/选择/展示/过滤）；Review 行内评论完整化（CreatePullReview 带行内评论）；Assignee 多选（`<select multiple>`）。
>   4. **Store-first 封装**：pull store 新增 updateLabels / updateAssignees / updateReviewers / updateMilestone actions；MergesView.vue 删掉直接 IPC 调用；attr-editor loading 状态。
>   5. **提交签名验证**：CommitGpgStatus DTO + 9 种状态（Good/Bad/U/X/Y/R/B/N/E）+ Shield 徽章 + 签名者 + 指纹。
>   6. **commit 计数 badge**：activeCommitCount computed + 已加载 N 条徽章。
>   7. **GitHub PR 闭环已完整实现**：v0.5.0 ADR-0008 计划内做，后端 + 前端全链路打通（ListPulls / GetPull / Merge / Close / Comments / Reviews / Files / Diff / Reactions）；README/CLAUDE 已同步更新产品文档对齐现状。
>   8. **wails-api-shim 兼容层**：window.api 桥接到 Wails bindings；ipc-client.ts 底层调用；不可删除。
>   相关 commit：`cbf4dda`（Phase 1 board 清理+Milestones）/ `11a6454`（Phase 2 Review 完整化）/ `18a9f11`（Phase 2 收尾 Assignee 多选）/ `61b1464`（Phase 3 store 封装）/ `6e1069f`（app.go 拆分）/ `8009720`（提交签名+commit 计数）/ `855122f`（review 5 项修复）/ `b977906`（v0.6.0 发版聚合 commit）。

> - **v0.7.5** (2026-07-12)：系统事件 UX 文案 + 时间格式对齐 Gitea web（接续 v0.7.4 Timeline 细节补全，把"事件/时间表述"做实）。
>   1. **systemEventVerb 字典重写**：覆盖 22+ 种 Gitea CommentType 全部 case（之前 18 种 + "事件" fallback → 现在全部具体 verb）。PR 动作加 "此合并请求" 限定词："关闭了此合并请求" / "重新开启了此合并请求" / "置顶了此合并请求" / "锁定了此合并请求" 等。Time tracking / project / auto merge / ref 类 4 个之前缺失的 type 补全具体 verb。
>   2. **移除 "事件" 通用 fallback**：未识别 type 返回空字符串（不显示 verb），不再有 "kanban_demo 事件" 这种不专业的回退。
>   3. **时间格式重构**：`X verb  ·  Y 天前`（时间独立在右 + "于" 介词缺失）改成 `X 于 Y verb`（时间融进行内）。评审事件 + 系统事件两种 timeline-item 都调整。CSS：新增 `.pr-detail__event-prep`（"于" 介词样式），去掉 `.pr-detail__event-time` 的 `margin-left: auto`。
>   4. **push event 数量解析**：`systemEventVerb(item)` 处理 `push` (29) type 时正则抠 body 里的 commit 数量（regex `/(\d+)\s*(commits?|个?提交|个?个提交)/i`），输出 "推送了 1 个提交" / "推送了 3 个提交" / fallback "推送了新提交"。
>
> - **v0.7.4** (2026-07-12)：Timeline 细节补全（接续 v0.7.3 动态视觉，把 7 处细节做实）。
>   1. **DisplayName 全链路**：后端 `platform.PullUserDTO` 加 `FullName` 字段；`giteaUserRaw` 解析 `full_name`；`githubUserRaw` 解析 `name`；11 处 `PullUserDTO` 构造同步。前端新增 `displayName(user)` helper（优先 fullName，回退 username）。对齐 Gitea web `shared/user/authorlink` 模板的 display name 优先显示。
>   2. **"评论于" 动词 + 时间链接**：评论 header 改成 `username 评论于 时间` 格式（Gitea web `repo.issues.commented_at` 中文翻译）；时间变成 `<a>` 链接，hover 变主色 + underline。
>   3. **系统事件 verb item 级别化**：新增 `systemEventVerb(item)` helper，根据 `item.removedAssignee` 区分 "添加了指派" / "移除了指派"；review_request 同理 "请求评审" / "移除了评审请求"。之前是通用 verb（"修改了指派人"），不精确。
>   4. **系统事件 inline 详情 3 类**：
>      - `review_request` (27): `UserPlus/UserMinus icon + assignee displayName + "请求评审"`
>      - `assignees` (9): `+ / - 圆点 + assignee displayName + "添加了/移除了指派"`
>      - `merge` (28): `GitMerge icon + "到" + base ref + 7 位短 SHA`（从 body regex 抠 "merged commit {sha}" 格式）
>   5. **评论 header 右侧 3 件套**（Gitea web 标准元素）：
>      - `[所有者]` 角色标签（PR 作者评论时显示，浅蓝底 + 主色字）
>      - `Smile` 表情按钮 + 8 emoji popover（对齐 Gitea / GitHub 体系）
>      - `MoreHorizontal` ... 按钮 + dropdown 菜单（按权限动态：引用/复制链接/编辑/删除）
>   6. **timeline 竖线颜色提亮**：新增 `--color-timeline` token（暗色 18% / 亮色 16% alpha），比 `--color-divider` 亮 80%，确保暗色背景下序列感可见。
>   7. **互斥 + click-outside**：表情选择器 / ... 菜单互斥打开（开一个关另一个）；全局 document mousedown 监听点击非 action-wrap 区域时关闭所有 popover。
>
> - **v0.7.3** (2026-07-12)：Timeline 视觉对齐 Gitea web（接续 v0.7.2 静态视觉，把动态 timeline 视觉做实）。
>   1. **系统事件紧凑单行布局**（v0.7.2 套了跟 comment 一样的 flex side + bubble 框，看上又大又重；Gitea web 截图对比显示 system event 是**单行紧凑**）：去掉 bubble 框，纯 icon + 单行文字（作者 + 事件 + 时间）。5 档颜色从文字色升级到 **dot 边框色 + icon 色**（更明显）。
>   2. **左侧贯穿 timeline 竖线**（Gitea web `web_src/css/repo.css: .repository.view.issue .comment-list::before` 的 2px vertical line 模式）：`.pr-detail__timeline::before` 画 2px 灰色竖线（top: 14px; bottom: 14px; left: 14px），avatar/dot 节点用 `position: absolute; left: -32px` 定位到竖线上 + 圆形背景把竖线"切断"在节点位置。
>   3. **评审 state 独立 dot 颜色**（v0.7.2 用了 border card + 3 个 state class；v0.7.3 改用 dot 颜色）：approved → 绿 / changes_requested → 红 / commented → 灰。
>   4. **二级详情拆 inline / block 两层**（v0.7.2 是单一 `.comment-event-detail` 混合）：inline（小信息同行：label chip / milestone / branch / assignees / title 旧新）+ block（链接换行：ref issue / dependency 链接 + 标题）。
>   5. **4 个分支结构大改**：`<ul class="pr-detail__timeline">` 替代 `pr-detail__comment-list`，每个 li 改用 `pr-detail__timeline-item {--comment | --event --system | --event --review}` 修饰。
>
> - **v0.7.2** (2026-07-12)：视觉 1:1 对齐 Gitea web（接续 v0.7.1 结构层对齐，把视觉/细节层做实）。
>   1. **5 档颜色 token**（对齐 Gitea web `.badge` 语义色）：`success` (绿: reopen/push) / `danger` (红: close) / `merge` (紫: merge_pull) / `warn` (橙: due_date / time tracking) / `neutral` (灰: 其他系统事件 + dismiss_review + 评审请求 + 锁/解锁/引脚)。系统事件卡左 border + 头像色 + badge 背景/文字 三个层次都按颜色档走。
>   2. **lucide-vue-next icon 体系**（21 个 octicon 全部对齐映射）：从 Unicode 字符（↻ ✕ ⚐ 🔒）迁到 lucide（RotateCcw / X / Tag / Lock ...），对齐 Gitea web `octicon-*` SVG 视觉风格。
>   3. **7 类系统事件二级详情块**（对齐 Gitea web `.detail flex-text-block`）：
>      - type=7 label:        label chip（hex 颜色 + 22 透明底）
>      - type=8 milestone:    oldMilestone → milestone（带删除线 + 箭头）
>      - type=9 assignees:    +/− 圆点徽章 + username + 提示语
>      - type=10 change_title: oldTitle → newTitle（删除线 + 箭头）
>      - type=11 delete_branch: GitBranch 图标 + ref 名 code chip
>      - type=25 change_target_branch: oldRef → newRef
>      - type=3/5/6/33 issue_ref + type=19/20 dependency: 跨仓 issue 链接（走 `auth.getAccountUrlByPlatform` 自动处理 GitHub `api.github.com` → `github.com`）+ 标题 + PR/Issue 图标
>   4. **气泡左箭头 CSS**（对齐 Gitea web `.avatar-content-left-arrow`）：`.pr-detail__comment-bubble::before` 加 6px CSS 三角形，指向左侧 avatar；event / system-event 卡 `--event` variant 显式 `display: none` 隐藏。
>   5. **Dismiss review 拆 2 卡**（Gitea web Type=32 在 body 非空时拆）：event 卡 + 独立 reason comment 卡（独立 avatar + bubble + "驳回原因" tag + body markdown 渲染）。v0.7.1 单卡时 reason 内容被吞了。
>   6. **后端 DTO 扩展**：`platform.TimelineItem` 加 12 个二级详情字段；`IssueDTO` 加 3 个字段支持跨仓 ref 引用；`giteaTimelineRaw` 解析这些字段；新增 `giteaIssueRefRaw` 子结构解析跨仓 issue 引用。`TestGiteaAdapter_ListPullTimeline_DetailFields` 覆盖 7 类解析。
>
> - **v0.7.1** (2026-07-12)：v0.7.0 收尾 patch——PR 对话区对齐 Gitea web + Timeline 数据源切换 + pnpm typecheck 全清（60 → 0 错）。
>   1. **PR 对话区对齐 Gitea web**：调研 Gitea 1.26 源码（templates/repo/issue/view_content/comments.tmpl + routers/web/repo/issue_view.go）后发现 3 处关键差异——
>      - server 端不再按 type 过滤（旧版 `c.Type != 0` 过滤把 type=21/22/1/2/28/4/7/8/9/10/27/29 等系统事件全丢），改为透传 type 字段给前端
>      - 评审拆 2 卡：review 事件卡 + body 评论卡独立渲染（Gitea 端同时落 `/pulls/{index}/reviews` + `/issues/{index}/comments` 两条记录）
>      - 系统事件卡独立：20+ type（reopen/close/label/milestone/assignee/title/delete_branch/due_date/lock/change_target_branch/review_request/merge/push/move/dismiss_review/pin/unpin...）按零术语 + 中文 + emoji 图标渲染
>   2. **Timeline 数据源切换**：`Gitea /comments` 端点只返 `type=0` 普通评论；新增 `PlatformAdapter.ListPullTimeline` 调 `/issues/{index}/timeline` 端点拿全 type。后端 `app_pull.go` 加 `App.ListPullTimeline` binding；前端 store 去 `commentPanels + reviewPanels` 双 Map，改为 `timelinePanels: Map<index, TimelinePanel>` 单一数据源 + `fetchTimeline(p)`。
>   3. **合并检查警告区 toggle**（Wails WebView 痛点）：`<details>` 在系统 WebView 下二次点击不响应，**4 次 revert** 后最终方案是标题行整体作为 toggle 入口 + Vue 受控 toggle + `@click.prevent` 拦截 WebKit default + 收起时红框整体变矮（`collapsed` class 缩小 padding + 标题字号）。
>   4. **类型契约收尾**：v0.7.0 (49f0172) TimelineItemDto 重构后残留 60 个 TS 错，本版 5 个 fix 提交全清——
>      - shim `WailsApp` interface 补 v0.5.0+ 13 个 PR 评论/评审方法（`UpdatePullComment` / `DeletePullComment` / `ListPullCommentReactions` / `AddPullCommentReaction` / `RemovePullCommentReaction` / `ListPullReviews` / `CreatePullReview` 补 `commitId` 字段 / `ListPullFiles` / `ListPullCommits` / `ListPullReviewComments` / `CreatePullReviewComment` / `GetPullFileDiff` / `OpenDesktopFolder`）
>      - 4 个属性编辑器 store action 重构为三参 wrap + 乐观更新（v0.7.0 49f0172 修得不彻底，IPC 引用直传导致 MergesView 三参调用报 TS2554）
>      - MergesView `systemEventLabel / systemEventIcon` 接收 string 映射表（对齐 TimelineItemDto.type 字面量）
>      - TimelineNewView 删 64 行死代码（`springScrollTo` Q 弹 spring 滚动函数 / `svgMaskGradient` computed / `clampColWidth` 函数）
>      - `waitForDeepenAndRetry` 用 `(client as any).on` + `(off as () => void)()` 强转兜底 vue-tsc 跨 try/finally 控制流分析 bug
>      - CommitDetailPanel `CommitDetail.files` 类型从内嵌 interface 改为引用 DTO 的 `CommitFileChangeDto[]`（vue-tsc 内嵌类型推断 never 的 bug）
>      - `env.d.ts` 把 `window.api` 类型放开允许顶层 `on()` 事件订阅方法
>   5. **TimelinePanel.posting 字段**：store 新增 `posting: boolean` 控制 textarea + send 按钮 disabled 态，`postComment` 改为设置 `posting`。
>   6. **PR 评论 3 个 bug**（v0.7.x 早期）：对话区首次进入不显示（`ref(Map)` 需 `triggerRef`）/ 时间排序错乱 / 图片上传失败，全部修复。
>   7. **Gitea 提交评审后同步刷新 issue comments**：避免 review event + body 评论卡显示 stale 数据。
>   8. **评审 state 大小写归一化**：Gitea 用小写（approved / changes_requested / commented），GitHub 用大写（APPROVED / CHANGES_REQUESTED / COMMENTED），adapter 归一化为小写。
>   9. **Gitea 评论相对路径改写为绝对 URL**：图片/头像在 Wails WebView 能渲染（评论 markdown 里 `![avatar](/avatars/xx.png)` 改为 `https://gitea.example.com/avatars/xx.png`）。
>   10. **macOS 本地 build 验证**：`wails build` 出 amd64 .app 21MB / 37s。
>   相关 commit：`e6b4d7f`（ListPullTimeline 后端）/ `e06b693`（v0.7.0 发版合入）/ `b988472` + `49f0172`（store TimelinePanel 重构）/ `09a3571`（Gitea web 对齐——type 透传 + 系统事件卡）/ `349734b`（评审拆 2 卡）/ `8bb900e` + `2611fb9` + `6478f5f`（合并检查警告区 toggle 收尾）/ `105e0d0`（PR 评论 3 bug）/ `1dc86a3`（Gitea 评论相对路径）/ `c7f3def`（review state 归一化）/ `bcb9d63` + `ff0ffa8` + `3c50040` + `eb528bd` + `955772d`（v0.7.1 typecheck 收尾 5 commit）。
>   发版 notes：`docs/releases/v0.7.1.md`（176 行 / 9 段 / 验证清单 + 红线维持 + 改动统计 + 关键 commit 列表 + 不做清单）。

> - **v0.7.0** (2026-07-09)：GitHub PR 属性编辑器数据补全。GitHub adapter 后端补全 5 个方法——`ListLabels` / `ListMembers` / `ListMilestones` / `UpdatePullMilestone` / `ListPullCommits`；放开 MergesView.vue:477 的 `v-if="currentPlatform === 'gitea'"` 锁；修复 v0.6.0 Phase 3 (commit `61b1464`) 潜伏的 5 个 store action 缺失 bug（`d0957b2` 必修，但本版 v0.7.1 才发现 49f0172 修得不彻底，再修一次）；GitHub milestone 进入 PR 详情显示（`PullDetailDTO.Milestone` 字段 + `Milestone.Number → DTO.ID` 映射）；`CreatePullReview` 透传 `opts.Comments` 支持行内评论；`.github/workflows/build.yml` 跨平台 build CI（macOS / Windows / Linux 三并行 jobs）。
>   相关 commit：`86f9caf`（ListLabels）/ `94e93a1`（ListMembers）/ `06f7d63`（ListMilestones）/ `72f4197`（UpdatePullMilestone + ListPullCommits）/ `d0957b2`（修 v0.6.0 潜伏 bug）/ `b6a5550`（放开 attr-editor v-if + GitHub 数据加载）/ `9539ea8`（GitHub Milestone + 行内评论）/ `4be51d4`（跨平台 build CI）/ `0ef6cec`（重写 v0.7.0-plan.md）。
>   发版 notes：`docs/releases/v0.7.0.md`（GitHub adapter 5 方法 + 属性编辑器 v-if 放开 + GitHub milestone + 行内评论 + 跨平台 CI）。

> - **v0.6.4** (2026-07-04)：滚动按需 deepen，替代 v0.6.3 的全量 unshallow。





> - **v0.6.3** (2026-07-04)：产品架构调整：去掉 fetch depth 硬限制，用户掌控本地 commit 元数据深度。
>   1. **修复 shim offset 透传 bug**：v0.6.1+ `gitgraphLines` shim 处理器只提取 `projectId/branches/limit` 三个字段，**丢失 `offset`**，导致前端滚动加载更多每次都拿到首屏前 300 条 + 永远 `truncated=true` → 用户看到「闪一下又消失」的 loading 循环 + 永远看不到「已是末尾」提示。修复：`shim.ts:438-484` 补 `offset?: number` 类型 + 透传给 `app.GetGitGraph` / `app.GetGitGraphAscii`。
>   2. **去掉 fetch depth=2000 硬限制**：`app.go:2524-2550` PullRepoByProjectId 改为显式 `Depth=0/CountLimit=0/SingleBranch=false/NoTags=false`；`app/git/sync.go` FetchRepo 与 `app/git/clone.go` CloneRepo 去掉 `isHugeRepo` 启发式判断（unreal/chromium/linux/webkit 关键词）+ `if opts.Depth <= 0 { return error }` 防御检查；`sync.go` fetch timeout 从 2 分钟改 30 分钟适配全量 fetch。
>   3. **新语义**：用户点击「刷新」后，`loadMoreGraph` 首次可以拉完整 264k commits 元数据（UnrealEngine 实测 ~28 GB，blobless 拦下 ~1.5 GB blob）；本地拉多少 commit 完全由用户决定，UI 不再有「只能看 2000 条」硬限制。loadMoreGraph 动态加载继续保留——用户点 loadMore 时，本地全量下后端 offset 分页直接走完，不需二次 fetch。
>   4. **shallow clone → 全量元数据自动 unshallow**：UnrealEngine 仓库由 `gh repo clone --depth=2000` 初始化为 shallow clone，`.git/shallow` 有记录。**关键坑**：`git fetch` 在 shallow repo 状态下**默认不会 deepen**——必须显式 `--unshallow`。不传 `--unshallow` 的话，本地 commit 数永远停在浅克隆的 4492 条（GitHub 实际 264k），用户滚到底加载完全部本地 4492 后看到「已是末尾」，但远端其实还有 ~26 万条没拉下来。修复：`app/git/native.go:fetchRemoteWithFilter` 检测到 shallow + depth<=0 时自动加 `--unshallow` 参数；新增 `repoIsShallow()` helper + 回归测试 `TestRepoIsShallow`。
>   5. **代价**：首次同步 UnrealEngine 类超大仓库会持续 30~60 分钟（gh partial fetch + blobless + --unshallow）；本机磁盘吃 ~28 GB 元数据（实测本仓库 4492 commits + ue6-main 2173 commits 已占 731 MB，去掉 104 条散落 blob 后元数据 660 MB；264k 全量理论上 ~28 GB）。fetch 阶段失败时需用户重试。
>   6. **生效条件**：现有 UnrealEngine 仓库需要用户重新点一次「刷新」按钮触发 fetch 走 `--unshallow` 路径才能深化成全克隆（下次 sync 时生效）。本地未深化的仓库 UI 上仍会显示「已是末尾」（因为本地确实没有更多 commit），但实际远端还有 26 万条未拉。
>   7. **改动文件**：`frontend/src/lib/wails-api-shim.ts`（offset 透传）、`app/git/sync.go`（FetchRepo 限制去掉）、`app/git/clone.go`（CloneRepo 限制去掉）、`app/git/native.go`（fetchRemoteWithFilter 自动 `--unshallow`）、`app/git/clone_test.go`（TestRepoIsShallow 回归测试）、`app.go`（PullRepoByProjectId 调用改全量）。
>
> - **v0.6.2** (2026-07-04)：Git Graph 右上角按钮语义重定义（UI 改名「刷新」，内部函数 `goToLatest` 保留）。
>   1. **旧痛点**：右上角「同步」按钮只调 `commitsGitgraphPull` + `loadGraph(0)`，loadGraph(0) 重置 graphDto 让用户滚动加载到的更深历史 commit 全部丢失；用户还得手动滚回顶部看最新 commit，两个动作割裂。
>   2. **新语义**：「刷新」（`goToLatest`），三合一：① 拉远端最新 commit（已 clone → `commitsGitgraphPull`；未 clone → `commitsGitgraphCloneRepo`）；② `loadGraph()` 重新渲染顶部 300 条 + 完整 layout；③ `nextTick` 后 `mainScrollEl.scrollTo({ top: 0, behavior: 'smooth' })` 平滑滚顶。
>   3. **UI vs 内部命名分层**：按钮文案「刷新」对齐用户心智（与 StatusBar 全局刷新、仓库行末「更新」属同一组「把图谱拉到最新」）；内部函数 `goToLatest` / `goToLatestLabel` 保留英文，更准确表达「拉远端 + 跳到顶部」组合动作，避免无谓 churn。
>   4. **与「滚动加载更多」互补不冲突**：IntersectionObserver 自动追加载历史；用户主动点「刷新」= 预期会跳走。
>   5. **三档粒度分工保留**：「刷新」（pull + 重渲染 + 滚顶）/ StatusBar 仓库行末「更新」（仅 pull）/ StatusBar 全局刷新（仅重渲染本地数据）。
>   6. **改动文件**：仅 `frontend/src/views/TimelineNewView.vue`（加 `mainScrollEl` ref + 改 `syncRepo → goToLatest` + 改 `syncButtonLabel → goToLatestLabel` + 按钮 title/Toast 文案围绕「刷新」语义）。
>
> - **v0.5.0** (2026-07-04)：PR 评论模块 M1-M4 完整交付。
>   1. **文件评论**：新增 PullFileComments.vue 组件 + ListPullFiles / GetPullFileDiff / ListPullReviewComments / CreatePullReviewComment 4 个 platform adapter 方法，Gitea/GitHub 双端实现，PR 详情顶部「文件评论」Tab 按文件分组、折叠展开、行号 reaction 展示。
>   2. **对话流融合 Review 事件**：PullStore.timelineItems（`comment` + `review` 按时间升序合并），对话 Tab 中为 approval/request_changes/commented 状态渲染虚线边框系统卡片（绿/橙/灰）。
>   3. **三 Tab 布局**：概览（保留 v1.x meta+审查区） / 文件评论（PullFileComments 组件） / 对话（timelineItems 混合时间线），默认 Tab = overview。
>   4. **零术语**：Diff/Hunk 等技术原词仅在代码/DTO 中展示，UI 文案保持中文（"文件评论"、"已批准"、"请求修改"、"已评论"）。
>
>   相关文件：
>   - Go: `app/platform/adapter.go`（4 DTO + 4 接口方法）、`app/platform/gitea/adapter.go`、`app/platform/github/adapter.go`、`app.go`（4 bindings）
>   - TS: `frontend/src/types/dto.ts`（+3 interface）、`frontend/src/lib/ipc-client.ts`（+4 方法）、`frontend/src/stores/pull.ts`（重构 timelineItems）
>   - Vue: `frontend/src/components/PullFileComments.vue`（新增 383 行）、`frontend/src/views/MergesView.vue`（三 Tab 改造 + 对话流 review 卡片 CSS）
>   - 文档: `docs/adr/0008-pr-comment-v05-enhancement.md`、`docs/releases/v0.5.0.md`
>
> - **v0.4.0** (2026-07-02)：3 件用户拍板工作。
>   1. **Git Graph 加载更多 UI 收敛**：GitHub 仓库 UI 顶部「加载更多」按钮 + 滚动监听彻底删除（与 Gitea UI 对齐），含后端 `App.DepenRepo` binding、`app/git/deepen.go`、`frontend/src/lib/ipc-client.ts` 的 `deepenRepo` 全栈清理。Graph DTO `truncated` 字段保留兼容。
>   2. **StatusBar 顺序调整**：仓库 dropdown 与 api URL 位置对调，最终顺序 `chip → api URL → 仓库 dropdown → 刷新仓库 → 主题`。
>   3. **Git 二进制内嵌（macos + windows）**：默认应用内嵌 `git 2.55.0` 二进制（`go:embed` 到 Go binary，`${dataDir}/tools/git/git-2.55.0-${GOOS}-${GOARCH}[.exe]` 释放），Linux 平台不嵌入（系统 PATH 足够）。新增 `app/gitbinary` 包统一 Runner 抽象（`RunGit` / `RunGitWithEnv` / `ResolveGitBinaryPath` / `TestGitBinary` / `Init`），所有 11 处 `exec.Command("git", ...)` 生产调用点改走 Runner。**用户可在 SettingsView「Git 二进制」卡片自定义路径**（macOS / Windows / Linux 都支持，平台特定文件选择对话框 + `git --version` 验证 + macOS Gatekeeper `xattr -d com.apple.quarantine` 自动剥离）。LocalState 新增 `prefs["app.gitBinaryPath"]` 字段，进程内 `gitbinary.SetUserOverride` 立即生效无需重启。详细 commit：`dc004ad` + `85e63a8` + `18beec3` + `271fc3b` + `e7a5344`。
>
> - **v0.5.0-m9** (2026-07-01)：M9 里程碑。TimelineView 防抖 composable 抽离 + schema regression 守 M5 fix-1 + W3 e2e helper 计数语义修正。4 件套全 EXIT=0，W3 known-issue 3→0，vitest 68 tests PASS
> - **v0.3.0** (2026-07-01)：UNCOMMITTED lane 1:1 对齐 vscode-git-graph，`git status --porcelain` 直采。详见 `git tag v0.3.0` 注释 + commit `24066b5 fix(gitgraph): UNCOMMITTED 检测改用 git status --porcelain, 1:1 复刻 vscode-git-graph`
> - **v3.0–v3.14** (2026-06-26 ~ 2026-06-30)：Git Graph 严格 1:1 复刻 vscode-git-graph，丢弃 v2.x 历史包袱。关键 commit `71a43f3 refactor(gitgraph): v3.0 严格 1:1 复刻 vscode-git-graph，丢弃 v2.x 历史包袱`。包含：v3.1-v3.3 列宽拖动 / [60,715] clamp、v3.10-v3.14 dot hover + ref badge + lane 色软底、SVG S 曲线、SourceTree 风格栅格栏、表头中文、author date 替代 committer date、blobless clone 下 (+N | -N) 0 修复等
> - **v2.6** (2026-06-25)：StatusBar 仓库行同步进度条。`go-git sideband.Progress` → Go 端 `SidebandWriter` → `wailsruntime.EventsEmit("git:sync:progress")` → 前端 `wails-api-shim.on()` → repo store `progressByRepo` → StatusBar 行内 2px 进度条。详见 [memory: gitea-kanban-v26-sync-progress-bar](../../.reasonix/projects/-Users-zhongxingxing-2026-code-gitea-kanban/memory/gitea-kanban-v26-sync-progress-bar.md)
> - **v2.5** (2026-06-22)：workspace 按账号分层。`${dataDir}/workspace/repos/${owner}__${repo}/` → `${dataDir}/workspace/repos/${username}/${owner}__${repo}/`。多账号场景避免同名 username 在不同平台撞目录；启动期**自动迁移**旧数据，备份保留到 `${dataDir}/workspace/_pre_v25_workspace`。详见 [ADR-0007](./docs/adr/0007-workspace-account-scoped.md) + §6.4 + §6.5
> - **v2.4** (2026-06-22)：迁移完成后真实用户桌面跑暴露 6 类问题（鉴权铁律 / 业务 binding stub / 数据目录嵌套 / StatusBar localPath 拼错 / prefs 死链 / go-git 拉全 worktree），全部修复并记录在 [ADR-0006](./docs/adr/0006-v24-iteration-fixes.md) + [07-v24-iteration.md](./docs/design/07-v24-iteration.md)。关键：所有 binding 接受 `projectId` / `owner+repo` 业务态概念，Go 端反查 `localPath + token`；go-git 走 `NoCheckout=true` 轻量模式（磁盘 -99%）；prefs 走 IPC + localStorage 双源持久化
> - **v2.0** (2026-06-22)：Electron+TypeScript+Vue → Go+Wails+Vue 3；单平台 Gitea → 多平台 Gitea+GitHub；前端保留 Vue 3，git 客户端改用 go-git。详见 [ADR-0005](./docs/adr/0005-electron-to-go-wails-migration.md)
>
> **历史快照**：v1 时代的 Electron 文档已标注 deprecated（详见 `docs/design/02-architecture.md` 顶部 + `docs/design/03-frontend.md` 顶部）。
>
> **过期文档警示**（避免后续 agent 误信）：
> - `docs/adr/0001-keychain.md` — SUPERSEDED by ADR-0005（已加横幅）
> - `docs/adr/0003-local-store-electron-store.md` — SUPERSEDED by ADR-0005（已加横幅）
> - `docs/design/02-architecture.md` — DEPRECATED（已标注）
> - `docs/design/03-frontend.md` — DEPRECATED（2026-07-01 加横幅）
> - `docs/design/00-overview.md` / `01-research.md` / `04-review-report.md` / `05-repair-decisions.md` / `checklist.md` — v1 设计阶段历史档案，**不**作为实施依据
> - `docs/onboarding/pm-first-run.md` / `docs/review/*.md` — v1 时代 review 文档
> - `CHANGELOG.md` — 严重过期，停留在 v1.3.1（重写待办）

---

## 1. 项目概述

**gitea-kanban** 是一个**基于 Gitea/GitHub 的桌面端看板 + Git Graph 工具**，技术形态为 **Go + Wails v2 + Vue 3**。

- **核心定位**：把 Gitea/GitHub 仓库里的 issue、分支、提交、合并请求以可视化方式呈现给团队，让非技术人员也能看懂当前工作流。**Git Graph 是核心入口**，其它功能（看板、合并管理、成员）从 commit DAG 衍生展开。
- **Source of truth**：Gitea / GitHub API。本地只存用户偏好、缓存和必要的派生数据（Go 端 `app/store` 包 + 文件 KV，零 SQLite 依赖）。
- **目标用户**：自托管 Gitea / GitHub 团队，**包含非技术人员**（PM、设计师、市场、运营）。因此 UI 必须零术语、危险操作二次确认、错误提示要说"人话"。
- **当前状态**：v2.0 已完成核心迁移（Go+Wails 骨架 + go-git + 多平台 PlatformAdapter）。前端 Vue 3 完整保留（9 视图 + 10 store + 组件库），通过 `wails-api-shim` 兼容旧 IPC 调用方式，逐步替换为 Go 后端 Wails bindings。

### 1.1 多平台支持

| 平台 | 鉴权方式 | 首期支持范围 |
|---|---|---|
| **Gitea** | `Authorization: token <pat>` | 全部功能：仓库 / 分支 / Git Graph / 议题 / 合并 / 标签 / 成员 |
| **GitHub** | `Authorization: Bearer <token>` | **仅 Git Graph**（VerifyToken + CloneRepo + LogGraph）；其余返回 `ErrNotSupported` |

---

## 2. 技术栈（实际生效）

> 以下均来自 `go.mod`、`wails.json`、`frontend/package.json` 等真实配置，不是计划文档中的历史草稿。

| 维度 | 选型 | 说明 |
|---|---|---|
| 运行时 | **Go 1.22+** + Wails v2.12.0 | Go 编译为单一原生二进制；Wails 用系统 WebView |
| 客户端框架 | **Wails v2.12.0** | 跨平台桌面应用（macOS / Windows / Linux），system WebView |
| git 客户端 | **go-git v5.16**（纯 Go，无 CGO） | 替代旧版 `spawn('git', ...)` 子进程调用 |
| 凭证存储 | **zalando/go-keyring v0.2.6**（纯 Go） | 跨平台 keychain（macOS Keychain / Windows Credential Vault / Linux Secret Service） |
| 业务态存储 | **JSON 文件 + 文件 KV**（自研 `app/store` + `app/cache`） | 延续 ADR-0003 零 SQLite 决策；Go 端 `encoding/json` 序列化 |
| 同步队列 | **queue.jsonl**（append-only，JSONL） | 离线写 op 持久化（Go 端 `app/sync`） |
| 平台 API | **Go net/http**（手写，替代旧版 gitea-js） | Gitea REST API + GitHub REST API，统一走 `app/platform` 抽象层 |
| UUID | **google/uuid** | id 生成 |
| 日志 | **log/slog** + 文件 transport | 写 `${dataRoot}/logs/main/main-YYYY-MM-DD.log` |
| 测试 | **Go testing** + httptest | 12 个 Go 包测试（config/git/git-graph/gitbinary/ipc/logexport/logx/platform-gitea/platform-github/secret/store/sync），共 60+ 测试用例（v0.7.2 +1 `TestGiteaAdapter_ListPullTimeline_DetailFields`）|
| 前端语言 | **TypeScript 5.7.2** | ESM (`"type": "module"`) |
| 前端构建 | **Vite 6.0** | 产物输出到 `frontend/dist/`，由 `main.go` 的 `//go:embed` 嵌入二进制 |
| 前端框架 | **Vue 3.5.35** + Composition API + `<script setup>` | 保留 v1 Vue 3 全部 9 视图 + 10 store |
| 前端状态 | **Pinia 3.0.4** | 保留 v1 Pinia stores |
| 前端路由 | **Vue Router 4.6.4** | `createWebHashHistory`（与 v1 相同） |
| 前端图标 | **lucide-vue-next** |  |
| 前端拖拽 | **vue-draggable-plus 0.6.1** | 看板列拖拽（v1 沿用） |
| 前端 Markdown | **markdown-it + dompurify** | 议题/PR 评论渲染（v1 沿用） |
| 包管理（前端） | **pnpm 11.x** |  |
| 包管理（Go） | **Go modules** |  |

### 2.1 关键依赖（go.mod）

```
github.com/go-git/go-git/v5 v5.16.2
github.com/google/uuid v1.6.0
github.com/wailsapp/wails/v2 v2.12.0
github.com/zalando/go-keyring v0.2.6
golang.org/x/sys（flock 跨进程锁用）
```

---

## 3. 目录结构

```
gitea-kanban/
├── AGENTS.md                    # 本文件
├── CLAUDE.md                    # 给 Claude 的快捷摘要（与本文件冲突时以本文件为准）
├── go.mod / go.sum              # Go 依赖
├── wails.json                   # Wails v2 配置
├── main.go                      # Wails 应用入口（OnStartup/OnShutdown + Bind）
├── app.go                       # 主后端 App（Wails binding 入口）
├── app/                         # Go 后端业务逻辑
│   ├── config/                  # 数据根目录解析 + slog 日志
│   ├── store/                   # 业务态（state.json，原子写 + 并发安全）
│   ├── git/                     # go-git 封装：clone / log / workspace / sync / repo / lock
│   │   └── graph/               # 自研 lane 布局算法（替代 git log --graph 字形）
│   ├── platform/                # 平台抽象层
│   │   ├── adapter.go           # PlatformAdapter interface + DTO
│   │   ├── platform.go          # Platform 常量（gitea / github）
│   │   ├── gitea/               # GiteaAdapter（net/http + token <pat>）
│   │   └── github/              # GitHubAdapter（仅 Git Graph，Bearer 鉴权）
│   ├── secret/                  # 凭证存储（go-keyring + dev 文件 fallback）
│   └── sync/                    # 同步队列（queue.jsonl append-only + GC）
├── frontend/                    # Vue 3 前端（从旧 src/renderer 迁移）
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/                     # 与 v1 src/renderer 结构对齐
│       ├── App.vue              # 根 SFC
│       ├── main.ts              # Vue 3 入口（注入 wails-api-shim）
│       ├── routes/              # Vue Router
│       ├── components/          # 通用组件（AppShell / NavRail / StatusBar / Toast ...）
│       ├── views/               # 路由级页面（9 个 view）
│       ├── stores/              # Pinia store（10 个）
│       ├── lib/                 # 工具（含 wails-api-shim 兼容层）
│       ├── types/               # DTO 类型
│       ├── shared/              # 前后端共享（errors + ipc-channels）
│       └── styles/              # 全局样式（theme.css / reset.css）
├── build/                       # Wails 构建产物（macOS / Windows / Linux）
│   ├── appicon.png              # 应用图标（gitea 绿 #609926）
│   ├── darwin/  windows/  linux/
├── docs/                        # 设计文档 + ADR
│   ├── design/                  # 设计文档（v2 部分文档已 deprecated）
│   │   ├── 00-overview.md       # 设计综述（**需更新**技术栈章节）
│   │   ├── 02-architecture.md   # **DEPRECATED**（基于 Electron IPC 架构，v2 改为 Wails bindings）
│   │   ├── 03-frontend.md       # 前端设计（v2 仍有效）
│   │   ├── 06-gitgraph.md       # Git Graph 设计（v2 仍有效）
│   │   └── ...                  # 其余 wireframe / review
│   ├── adr/                     # 架构决策记录
│   │   ├── 0001-keychain.md     # @napi-rs/keyring（v1 决策，v2 改 go-keyring 但设计理念一致）
│   │   ├── 0002-board-data-source-reset.md
│   │   ├── 0003-local-store-electron-store.md  # 零 SQLite 决策（v2 沿用）
│   │   ├── 0004-single-repo-focus.md
│   │   └── 0005-electron-to-go-wails-migration.md  # **v2.0 重大决策（新增）**
│   └── dev/
│       └── cdp-performance-testing.md  # CDP 调试（**Electron 专用，v2 不适用**）
└── scripts/                     # Reasonix agent hooks（post-edit.sh：format / build / test / commit）
```

---

## 4. 构建与开发命令

```bash
# 开发（启动 Wails dev server + 桌面窗口 + Vite HMR）
wails dev

# 三端构建（Go 后端 + 前端 + Wails bundle）
wails build                    # 默认当前平台（macOS → .app / Windows → .exe / Linux → .AppImage）
wails build -platform darwin/universal  # 跨架构：x86_64 + arm64

# 平台特定构建（在对应平台机器上执行）
wails build -platform windows/amd64
wails build -platform linux/amd64

# 清理 + 重新构建
wails build -clean

# Go 单元测试
go test ./app/...              # 全部 9 个包测试
go test -v ./app/git/...       # 单包详细输出
go test -race ./app/...        # 竞态检测

# Go vet + 编译验证
go vet ./...
go build -o /dev/null .

# 前端独立构建（不进 Wails，直接出 dist/）
cd frontend
pnpm install
pnpm build                     # vite build（typecheck 暂时跳过，迁移期旧代码有 strict 报错）
pnpm typecheck                 # vue-tsc --noEmit（迁移期可能失败，旧代码 strict 模式报错）
```

**前端类型检查铁律**：仓库已有 `frontend/package.json` 的 `typecheck` 脚本。需要跑 `vue-tsc` 时必须执行 `cd frontend && pnpm typecheck`，禁止临时手写后台 `npx vue-tsc --noEmit &` + `sleep/kill/ps` 超时脚本；这类脚本容易拿错 `$!`、误判卡住并遗留进程。

### 4.1 跨平台编译说明

- **macOS**：默认产出 `.app`（17MB，含 x86_64+arm64 universal binary）
- **Windows**：在 Windows 机器上跑 `wails build -platform windows/amd64`
- **Linux**：在 Linux 机器上跑 `wails build -platform linux/amd64`（需要 webkit2gtk-4.0）
- **macOS 交叉编译 Linux**：需要 `CGO_ENABLED=0`（但 Linux 实际打包仍需 Linux 平台环境）

### 4.2 本地开发首次 setup

1. **Go ≥ 1.22**（项目用 `go 1.22` 工具链）
2. **Node ≥ 20** + pnpm 11（前端构建用）
3. **Wails CLI**：`go install github.com/wailsapp/wails/v2/cmd/wails@latest`
4. `git clone` 后进入项目
5. `cd frontend && pnpm install`（前端依赖）
6. `go mod download`（Go 依赖）
7. `wails dev` 启动开发模式

---

## 5. 代码风格与规范

### 5.1 Go 代码

- `gofmt` 格式化（所有 `.go` 必须 `gofmt -d` 干净）
- 注释关键业务逻辑、安全边界、历史踩坑**必须中文**
- 命名风格：package 小写、export 大写驼峰
- 错误处理：**不吞 error**；`fmt.Errorf("ctx: %w", err)` 包装
- 导出函数必须有 godoc 注释（`// FuncName ...`）

### 5.2 TypeScript / Vue 代码

- **Prettier** 配置在 `frontend/.prettierrc`：
  - `semi: true`
  - `singleQuote: true`
  - `trailingComma: all`
  - `printWidth: 100`
  - `tabWidth: 2`
  - `endOfLine: lf`
- 路径别名：
  - `@renderer/*` → `frontend/src/*`
  - `@shared/*` → `frontend/src/shared/*`
- 注释关键业务逻辑必须中文
- IPC 端点命名：**`<namespace>.<method>`**，例如 `repos.list`、`board.columns.list`、`issues.moveColumn`

### 5.3 Commit Message

- **必须中文**。
- Type 限定：`feat / fix / refactor / perf / chore / test / docs / style`。
- 格式：`<type>: <中文一句话描述>`。
- 每个阶段性交付打一次 commit，不攒大 commit。
- 末尾不加 `Co-Authored-By`。
- 当前单分支 `main`（v1 时代是 `master`，v2 已迁回 `main`）。

---

## 6. 架构要点

### 6.1 Wails 三层架构

```
+--------------------------------------------+
|  Vue 3 Renderer (frontend/dist)            |  ← wails build 嵌入到二进制
|  - Pinia stores                            |
|  - window.go.main.App.* (Wails bindings)   |
+--------------------------------------------+
            ↕ IPC (Wails 自动生成的 Go bindings)
+--------------------------------------------+
|  Go Backend (main package + app/...)       |
|  - App struct: 所有 Wails-exposed 方法    |
|  - app/platform: PlatformAdapter interface |
|  - app/git: go-git 封装                    |
|  - app/store: state.json 原子写            |
|  - app/secret: go-keyring                  |
+--------------------------------------------+
            ↕ HTTPS REST API
+--------------------------------------------+
|  Gitea / GitHub API                         |
|  - GiteaAdapter: token <pat>               |
|  - GitHubAdapter: Bearer <token>            |
+--------------------------------------------+
```

### 6.2 Wails Binding 模式

**`main.go`** 定义窗口 + bind App struct：
```go
wails.Run(&options.App{
    Bind: []interface{}{app},
    OnStartup: app.OnStartup,
    OnShutdown: app.OnShutdown,
})
```

**`app.go`** 集中所有暴露给前端的方法：
```go
type App struct { /* ... */ }
func (a *App) GetAppInfo() AppInfo { ... }
func (a *App) AuthConnect(args ConnectArgs) (ConnectResult, error) { ... }
func (a *App) ListRepos(args ListReposArgs) (ListReposResp, error) { ... }
func (a *App) CloneRepo(args CloneRepoArgs) (CloneRepoResult, error) { ... }
func (a *App) GetGitGraph(args GetGitGraphArgs) (GraphResultDTO, error) { ... } // v2.4
// ... 全部 Wails binding 方法都集中在这里
```

**Wails 自动生成** TypeScript bindings 到 `frontend/wailsjs/wailsjs/go/main/App.d.ts`，前端直接 `import { GetAppInfo } from '../wailsjs/go/main/App'` 调用。

> **v2.4 重要更新**：所有 binding 接受业务态概念（`projectId` / `owner+repo`），Go 端反查 `localPath + token`。**禁止**前端传 `localPath` / `token`（违反 AGENTS §8.2 鉴权铁律）。详见 [ADR-0006 §2.1 + §2.4](./docs/adr/0006-v24-iteration-fixes.md)。

### 6.3 平台抽象层（PlatformAdapter）

所有平台差异通过 `app/platform/adapter.go` 中的 `PlatformAdapter` interface 隔离：

```go
type PlatformAdapter interface {
    Platform() Platform
    VerifyToken(ctx, hostURL, token) (*UserDTO, error)
    ListRepos(ctx, hostURL, username, token, opts) ([]RepoDTO, error)
    ListBranches(ctx, hostURL, username, token, owner, repo) ([]BranchDTO, error)
    CloneRepo(ctx, hostURL, username, token, owner, repo, workspacePath, accountUsername string) (string, error) // v2.5 加 accountUsername
    LogGraph(ctx, localPath, opts) (*GraphResult, error)
    ListIssues(ctx, hostURL, username, token, owner, repo, opts) ([]IssueDTO, error)
    ListPulls(ctx, hostURL, username, token, owner, repo, opts) ([]PullDTO, error)
    ListLabels(ctx, hostURL, username, token, owner, repo) ([]LabelDTO, error)
    ListMembers(ctx, hostURL, username, token, owner, repo) ([]MemberDTO, error)
}
```

**实现**：
- `GiteaAdapter`（`app/platform/gitea/`）：完整实现 9 类方法，鉴权 `token <pat>`
- `GitHubAdapter`（`app/platform/github/`）：首期**仅**实现 `VerifyToken` + `CloneRepo` + `LogGraph`，其余 6 个方法返回 `platform.ErrNotSupported`

### 6.4 数据模型

业务态 8 张表（**全部**在 `state.json`，由 `app/store/store.go` 的 `LocalState` 定义）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | int | 当前 1（迁移时手动 bump） |
| `accounts` | []GiteaAccount | v2 新增 `Platform` 字段（`gitea` / `github`），旧数据迁移默认 `gitea` |
| `users` | []LocalUser | 1 行 seed `local-user` |
| `prefs` | map[string]any | 业务偏好（含 `app.workspacePath`） |
| `projects` | []RepoProject | v2 新增 `Platform` 字段 |
| `columns` | []BoardColumn | 看板列 |
| `labelMaps` | []ColumnLabelMap | 列 ↔ Gitea label 映射 |
| `starredBranches` | []StarredBranch | 收藏的分支 |

**加载与原子写**（`app/store/store.go`）：
- 启动期 `NewLocalStore(path)`：`os.ReadFile` + `json.Unmarshal`；文件不存在初始化默认值；JSON 损坏返 error
- 写操作 `Mutate(fn)`：`sync.RWMutex` 保护 + 临时文件 `tmp+rename` 原子写
- 旧数据迁移：`accounts[i].Platform == ""` → 默认 `"gitea"`

**Gitea 缓存层**（v2 暂未实现，仍走 Gitea API 实时拉取；v2.1 计划加 `app/cache` 文件 KV 缓存层，对齐 v1 设计）。

**Workspace 路径**（Git Graph 专用，**v2.2 锁定不可改**）：`~/.gitea-kanban/workspace`（单层，无嵌套），repos 存 `${workspace}/repos/${username}/${owner}__${repo}/`（v2.5 起按账号分层）。**禁止**在连接 / 设置界面暴露修改入口（v2.2 user 拍板）；设置界面只读 + "打开应用数据目录"按钮（`App.OpenDataDir`）。详见 [ADR-0006 §2.3](./docs/adr/0006-v24-iteration-fixes.md#23-数据目录收尾-v22--v24)。

**v2.5 按账号分层**（user 拍板 2026-06-22）：
- 旧布局 `${workspace}/repos/${owner}__${repo}/` 启动期**自动迁移**到新布局（见 §6.5）
- 迁移逻辑：`app/git/workspace.go` 的 `MigrateLegacyWorkspaceLayout` + `App.runLegacyWorkspaceMigration`
- 迁移成功后旧 `${workspace}/repos/` 整目录 mv 到 `${workspace}/_pre_v25_workspace` 保留备份
- 失败时整个旧目录也 mv 到 `_pre_v25_workspace`（带 .1/.2... 后缀避免冲突）；新空 `${workspace}/repos/` 重建
- 任何时候 resolveTokenByLocalPath 都兼容 v2.4 旧路径（`repos/<owner>__<repo>` 两层）+ v2.5 新路径（`repos/<username>/<owner>__<repo>` 三层），主要用于迁移期残留数据

### 6.5 git 客户端（go-git）

> **v2.4 轻量模式（user 拍板）**：本应用**只**用 commit / tree / branch 元信息画 Git Graph，**不** clone 工作区文件。`PlainClone` 必须传 `NoCheckout: true`，磁盘占用 -99%。

**`app/git/clone.go`**：`go-git.PlainClone(localPath, false, &git.CloneOptions{NoCheckout: true, Auth: ...})`，token 仅内存态不落盘。
  - v2.5 起路径：`RepoLocalPathForAccount(workspacePath, accountUsername, owner, repo)` = `${ws}/repos/${username}/${owner}__${repo}/`
  - 旧版 `RepoLocalPath(workspacePath, owner, repo)` 保留（仅供测试 / 迁移期 fallback）
**`app/git/log.go`**：`repo.Log(&git.LogOptions{Order: git.LogOrderCommitterTime})` 遍历 commit DAG。
**`app/git/graph/layout.go`**：自研 lane 布局算法（go-git 不提供 `git log --graph` 字形），输出结构化 `GraphNode + GraphEdge`。
**`app/git/workspace.go`**：workspace 路径管理（mkdir / list / migrate）。
  - `ListRepos`：扫 `${ws}/repos/<username>/<owner>__<repo>/`，返回带 AccountUsername 字段的 WorkspaceRepo
  - `MigrateLegacyWorkspaceLayout`：启动期一次性旧 → 新布局迁移，使用 `_v25_migration_staging` 临时目录 + `os.Rename` 原子切换
  - 备份目录命名 `_pre_v25_workspace`（冲突时自动加 `.1` / `.2` 后缀）
**`app/git/sync.go`**：`FetchRepo` + `PullRepo`（**NoCheckout 适配**：fetch 后**主动**更新本地 HEAD ref 指向新 remote HEAD；`AddedCommits` 真正反映远端变化）。
**`app/git/repo.go`**：commit 详情 + diff 封装。
**`app/git/lock.go`**：per-repo `sync.Mutex`（内存）+ `flock`（跨进程）双重锁，防 `CloneRepo` 并发竞态。

### 6.6 凭证存储

**`app/secret/store.go`**：
- 生产：`go-keyring`（zalando/go-keyring，跨平台纯 Go）写系统 keychain
- dev fallback：`userData/dev-tokens/<service>__<username>.json`（0600 权限）
- Key 规则：service = `gitea-kanban@${hostURL}`（与 v1 相同）
- 铁律：token 永远不离开主进程内存 + 系统 keychain，**不**写到日志 / state.json / 前端

### 6.7 Wails 窗口安全

- 渲染端默认 `contextIsolation: true`、`nodeIntegration: false`
- v2 **不**用 Electron sandbox（WebView 自带安全模型）
- 前端通过 `window.go.main.App.*` 调用后端；没有 preload script（Wails 直接注入 bindings）
- 禁止 `v-html`，除非是明确审核过的 sanitize 场景

### 6.8 主题系统

- v2 沿用 v1 主题策略：**2 主题切换**（dark / light），默认 dark
  - dark 基底 `#0F1115`，主色 token `#74B830`
  - light 基底 `#E8F1F5`，主色 token `#466B16`
- 持久化走 `localStore.prefs['theme']`（前端用 localStorage 启动期 0 闪烁）
- 切换入口 3 处：StatusBar cycle 按钮 / 设置页"外观" / 命令面板 ⌘K

---

## 7. 测试策略

### 7.1 Go 单元测试

- **配置**：标准库 `testing` + `httptest`
- **覆盖目标**（当前 50+ 测试用例，9 个包）：
  - `app/config`：3 测试（数据目录解析 + 日志写入）
  - `app/git`：10 测试（clone 路径 / URL 构造 / sanitize / file:// clone / commit 遍历 / DAG log / layout 算法 / workspace / fetch / pull / 锁）
  - `app/git/graph`：5 测试（线性 / 分支+合并 DAG / 空图 / 排序）
  - `app/platform`：2 测试（Platform 常量 / IsValid）
  - `app/platform/gitea`：6 测试（httptest mock server 验证 HTTP 请求）
  - `app/platform/github`：5 测试（Bearer 鉴权 / NotSupported 场景）
  - `app/secret`：5 测试（dev 文件 fallback Set/Get/Delete + 0600 权限）
  - `app/store`：4 测试（默认状态 / Mutate+持久化 / 旧数据迁移 / workspace 路径）
  - `app/sync`：4 测试（Enqueue / LoadPending / MarkDone 去重 / GC）
- **运行**：`go test ./app/...`
- **覆盖率目标**：未设置硬阈值（迁移期不强制）

### 7.2 前端组件测试

- v2 沿用 v1 测试模式：Vitest + @vue/test-utils + @testing-library/vue
- 当前 0 个前端测试运行（v1 时代的前端测试已随 Electron 迁出本仓）
- 计划恢复 v1 的关键测试：AuthView / BoardView / 拖拽链路（用 CDP 在真实 Electron renderer 验证）

### 7.3 E2E

- v1 计划用 Playwright + Electron（**已不适用**，v2 是 Wails）
- v2 E2E 计划：Playwright + Wails（**待规划**），关键路径必须覆盖：首次接入、Git Graph 渲染、平台选择、克隆、错误提示

### 7.4 其他验证

- `go vet ./...` 必须无 error
- `go test ./app/...` 必须全通过
- 前端 `pnpm build` 必须成功
- `wails build` 三端至少 macOS 通过

---

## 8. 安全与运维

### 8.1 鉴权铁律

- **token 永远不离开 Go 进程内存**。
- `App.VerifyToken` 是**唯一**接收 token 的入口。
- token 通过 `go-keyring` 存系统 keychain；**绝不**存到文件（生产）/ 日志 / state.json。
- 渲染进程通过 Wails bindings 调用，**拿不到**明文 token（只能看 `Account.UserInfo`）。
- `slog` 禁止把 `token` / `password` / `key` 等写入日志（不要在调用处显式 print 这些字段）。

### 8.2 数据与日志路径

- 数据根目录优先级：
  1. 环境变量 `GITEA_KANBAN_DATA_DIR`（必须是绝对路径）
  2. 兜底 `~/.gitea-kanban`
- 业务态：`${dataRoot}/state.json`（`app/store` 原子写）
- Workspace：`${dataRoot}/workspace/repos/${username}/${owner}__${repo}/`（v2.5 起按账号分层，go-git clone 目标）
  - 旧布局 `${dataRoot}/workspace/repos/${owner}__${repo}/` 启动期**自动迁移**（见 §6.5）
- 同步队列：`${dataRoot}/queue.jsonl`（append-only JSONL）
- 日志目录：`${dataRoot}/logs/main/main.log`（`slog` 写文件）
- 开发模式如遇 macOS SIP 写权限问题，会 fallback 到 `/tmp/gitea-kanban`。

### 8.3 输入与路径安全

- **MigrateRepo** 沙箱校验：`newWorkspacePath` 必须在 `allowedRoot` 之下（防系统目录逃逸）
- **CloneRepo** token 走 go-git `http.BasicAuth.Password`（内存态，不落盘到 `.git/config`）
- 禁止 `v-html`，除非是明确审核过的 sanitize 场景

### 8.4 启动调试

Wails v2 没有 Electron 那套 CDP 远程调试端口（v1 的 9492 端口已不适用）。

**v2 启动排查**：

```bash
# 1. 设独立 data dir 避免污染真实数据
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-debug
rm -rf "$GITEA_KANBAN_DATA_DIR"

# 2. 后台跑 dev
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev > /tmp/wails-dev.log 2>&1 &
echo "pid=$!"

# 3. 等 10 秒（Vite 编译 + Go 编译 + Wails 启动）
sleep 10

# 4. 三路看
echo "--- 1. slog 日志（Go 写文件，不是 stdout）---"
tail -50 "$GITEA_KANBAN_DATA_DIR/logs/main/main.log" 2>&1
echo "--- 2. wails dev 自身输出 ---"
tail -30 /tmp/wails-dev.log
echo "--- 3. Go 二进制是否启动 ---"
ps aux | grep -E "gitea-kanban|main" | grep -v grep
```

**常见启动问题**：
1. **CSP / 渲染端加载失败** — 罕见（Wails 自动处理 CSP）
2. **`app.setPath` 写入受限**（macOS SIP）— 走 `GITEA_KANBAN_DATA_DIR` 到 `/tmp`
3. **state.json 损坏** — 删 `state.json` 重启（localStore 初始化默认值）
4. **go-git clone 失败** — 网络问题或 token 无效；看 slog 日志中的 HTTP 错误
5. **wails 找不到 go / node** — `wails doctor` 诊断

### 8.5 沙箱/容器内启动

当 dev 环境是 AI agent 沙箱（reasonix / docker / k8s），默认 `~/.gitea-kanban` 写不进去时：

```bash
# 1. 选个沙箱可写的数据目录
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-test
rm -rf "$GITEA_KANBAN_DATA_DIR"

# 2. 后台跑 dev（用环境变量彻底绕开 ~ 目录）
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev > /tmp/wails-dev.log 2>&1 &
echo "pid=$!"

# 3. 等 10 秒
sleep 10

# 4. 看日志
tail -30 /tmp/wails-dev.log
tail -30 "$GITEA_KANBAN_DATA_DIR/logs/main/main.log" 2>&1
```

---

## 9. 关键产品约束

### 9.1 零术语

UI 文本禁止直接出现以下原词，必须走翻译表（与 v1 相同）：

| 原词 | 中文 |
|---|---|
| PR | 合并请求 |
| merge | 合并 |
| rebase | 变基 |
| fork | 派生 |
| repo | 仓库 |
| branch | 分支 |
| maintainer | 维护者 |
| issue | 议题（或保留 Issue，gitea 自身保留） |

### 9.2 危险操作二次确认

- 删分支 / 强推 / 合并冲突解决 / 关闭合并请求 / 合并到主线分支 → 弹窗二次确认

### 9.3 错误提示"人话"

- 统一 `IpcError` / `GoError` 格式：`code + message + hint`
- 前端 `lib/ipc-client.ts` 把错误码转成本地化中文类别前缀 + 建议
- 不暴露内部 stack trace 给最终用户
- GiteaAdapter / GitHubAdapter `mapHTTPError` 翻译 401/403/404/409/422/429/5xx

### 9.4 离线降级

- 平台 API 失败时降级到本地缓存（v2.1 计划加文件 KV 缓存层）
- 写操作离线时入队到 `queue.jsonl`，后台 runner 重试
- 状态栏显著提示"离线模式"（前端已实现）

---

## 10. 常见陷阱与专属注意

1. **Wails binding 签名**：所有 `(args struct) (result, error)` 形式，struct 字段名会原样生成 TS 类型。
2. **go-git clone URL**：go-git 的 auth 走 `http.BasicAuth`，URL **不**含 token（与 git 二进制不同——后者需要 set-url 清 token）。
3. **go-git 不提供 `--graph` 字形**：必须用 `app/git/graph/layout.go` 自研 lane 布局算法，输出结构化 `GraphNode + GraphEdge`。
4. **go-keyring 平台差异**：
   - macOS：可能弹出 keychain 授权弹窗
   - Linux：需要 `gnome-keyring` 或 `kwallet` 运行
   - dev fallback：文件（0600 权限）
5. **平台选择 UI**：GitHub 首期仅 Git Graph，其余入口（issue/PR/labels/members）必须 UI 隐藏 + 后端返 `ErrNotSupported`。
6. **Wails frontend:dist 必须存在**：`wails.json` 配置 `frontend:build = pnpm build`；CI 必须先 build 前端再 `wails build`。
7. **不要跨边界**：渲染端不写 `app/**/*.go`、主进程不写 Vue 组件 / CSS。
8. **Wails 跨平台构建限制**：
   - macOS 产 `.app`（dmg 在 macOS 上 `wails build` 自动生成）
   - Windows 产 `.exe`（必须在 Windows 机器上跑）
   - Linux 产 `AppImage`（必须在 Linux 机器上跑，需要 webkit2gtk-4.0）
9. **Edit 工具残段**：用 `edit_file` 替换时 `old_string` 尽量包整个函数或大段；替换后 `git diff` 确认无重复行。
10. **go-git AuthMethod 接口**：`transport.AuthMethod`（来自 `plumbing/transport`），不是 `http.BasicAuth` 直接传——后者只是 `AuthMethod` 的一种实现。

---

## 11. 关键文档索引

| 文档 | 路径 | 用途 |
|---|---|---|
| 设计综述 + 路线图 | `docs/design/00-overview.md` | 用户 review 入口（v2.4 增量已加横幅） |
| 架构 + 后端设计 | `docs/design/02-architecture.md` | **DEPRECATED**（基于 Electron IPC，v2 改为 Wails bindings） |
| 前端设计 | `docs/design/03-frontend.md` | UI/UX、路由、状态管理（v2 仍有效） |
| Git Graph 设计 | `docs/design/06-gitgraph.md` | Git Graph 设计（v2 仍有效） |
| **v2.4 迭代记录** | `docs/design/07-v24-iteration.md` | **v2.4 新增**：迁移后 6 类问题修复 + 决策总表 + 验证基线 |
| keychain 选型 | `docs/adr/0001-keychain.md` | v1 用 @napi-rs/keyring；v2 改 zalando/go-keyring 但设计理念一致 |
| board 数据模型 reset | `docs/adr/0002-board-data-source-reset.md` | 为什么卡片 = Gitea issue |
| **本地存储迁移 + 同步队列** | `docs/adr/0003-local-store-electron-store.md` | **ADR-0003（v1 完结）**：SQLite → electron-store + 文件 KV + queue.jsonl |
| **单一仓库专注模式** | `docs/adr/0004-single-repo-focus.md` | ADR-0004（v1.4 拍板）：每个 view 只看一个 project |
| **v2.0 迁移决策** | `docs/adr/0005-electron-to-go-wails-migration.md` | **v2.0 重大决策**：Electron→Go+Wails + 多平台 + go-git |
| **v2.4 迭代修复** | `docs/adr/0006-v24-iteration-fixes.md` | **v2.4 新增**：6 个决策（鉴权铁律 / binding 补全 / 数据目录 / 反查链路 / prefs / go-git 轻量） |
| **v2.5 workspace 按账号分层** | `docs/adr/0007-workspace-account-scoped.md` | **v2.5 新增**：repos 按账号 username 子目录分层 + 启动期自动迁移 + `_pre_v25_workspace` 备份 |
| 设计系统 | `design-system/gitea-kanban/OVERRIDE.md` | 颜色、字体、零术语、二次确认（v2 仍有效） |
| 本文件 | `AGENTS.md` | agent 入口规范 |

---

## 12. Agent 角色边界（参考）

> 项目使用 mavis team plan 时的角色分工。单人开发时也可作为代码组织参考。

- **后端 agent**：负责 `app/**`、`main.go`、`wails.json`、`go.mod`、打包配置。
- **前端 agent**：负责 `frontend/src/**`、wireframe、组件库；不碰 Go 后端 / binding schema。
- **verifier**：独立验证 Wails bindings 暴露数、零术语、错误码统一性、数据路径、go test 全过、wails build 成功。
- **orchestrator**：拆 plan、跑 cycle、统一 git commit。

---

## 13. 不决事项（必须推给用户拍板）

以下变更不准 agent 自决：
1. 改技术栈（Go / Wails / go-git / zalando-go-keyring / Vue 3 / Pinia 任一变更）
2. 改 Wails bindings 契约（`app.go` 的方法签名 / 字段类型）
3. 改数据模型（`LocalState` 结构 / 新增字段）
4. 改 PlatformAdapter interface（增减方法 / 改签名）
5. 改设计原则（零术语表、危险操作清单、错误码表）
6. 改设计系统 token（主色 / 强调色 / 字体 / 默认主题）
7. 改鉴权方式（PAT → OAuth2 / SSH key 等）
8. 改打包目标平台（新增 Android / iOS / Web）
9. 引入重大新依赖（如更换 go-git 为 git CLI wrapper / 改用 SQLite 等）

---

> **记住**：本文件是活的规范。当你修改了技术栈、构建流程、安全边界、目录结构或关键约定时，必须同步更新本文件。

---

## 14. 前端性能预防规范（v0.7.4 立，时刻留意）

以下规范从 v0.7.4 性能优化中提炼，所有前端开发（含 agent）必须遵守，避免卡顿问题反复出现。

### 14.1 禁止路由守卫 await IPC
- **正确**：守卫只做同步判断，读 store 状态（`auth.isConnected`、`repo.currentProject`）。
- **禁止**：在 `router.beforeEach` 中 `await auth.refreshStatus()` 或任何其他 IPC 调用。
- **Why**：v0.7.4 前每条路由切换都等 IPC，导航同步卡住。替代：App.vue mount 时一次性拉好状态，守卫直接读已缓存的状态。
- **代码位置**：`frontend/src/routes/index.ts`

### 14.2 懒加载路由必须包 Suspense + 骨架屏
- **正确**：`<router-view>` 包裹 `<Suspense>` + `<template #fallback>骨架屏</template>`。
- **禁止**：裸 `<KeepAlive>` 或无 fallback 的 Suspense。
- **Why**：chunk 下载期用户看到白屏/无反馈，体验为"卡死"。
- **代码位置**：`frontend/src/components/AppShell.vue`

### 14.3 所有 UI 事件必须非阻塞
- **正确**：按钮 click 后立即返回，后台 `void asyncFn()` 执行；失败时 toast 通知用户。
- **禁止**：click handler 内同步 `await repo.loadRepos(...)` 等阻塞操作。
- **Why**：用户点按钮后 UI 必须立即响应，远端调用不应该冻结主线程。
- **防抖**：连续可触发操作（如刷新、重试）加 400~800ms 防抖。
- **代码位置**：`frontend/src/components/StatusBar.vue` § onRefreshClick

### 14.4 console 拦截器必须轻量
- **正确**：只提取字符串/Error.message，不 `JSON.stringify` 复杂对象。
- **禁止**：同步 `JSON.stringify(args)` 处理日志参数。
- **Why**：v2.5 死循环惨案：IPC 401 → console.error → logError → send → console.error → ... 164MB 日志冻屏。v0.7.4 用 `fastSerialize` 只走安全路径。
- **代码位置**：`frontend/src/main.ts`

### 14.5 滚动加载必须有冷却 + 不跳走
- **正确**：IntersectionObserver 加 400ms 冷却；加载后保持 scrollTop 相对位置。
- **禁止**：加载后 `scrollIntoView` 到底部（链式触发：滚到底 → 哨兵进视口 → 又加载 → 滚到底 → …）。
- **Why**：v0.7.4 前造成加载风暴，主线程繁忙。
- **代码位置**：`frontend/src/views/TimelineNewView.vue` loadMoreGraph

### 14.6 大数据量全量替换必须有上限
- **正确**：累计加载到达上限（如 5000 条）后改为虚拟列表，或明确提示"已达上限"。
- **禁止**：无限 `maxCommits += 300` 全量替换 graphDto，O(N²) 重算 downstream computed（currentBranchBySha、inHeadShaSet、svgRender、pathGroups、allRows、svgCircleNodes）。
- **Why**：v0.7.3 vscode-git-graph 对齐引入的全量替换，在深历史仓库会卡死。
- **代码位置**：`frontend/src/views/TimelineNewView.vue` loadMoreGraph / allRows

### 14.7 新增前端 binding 时必须同步检查点
- 改 `app.go` binding → 检查前端 `wails-api-shim.ts` + `ipc-client.ts` + 调用方是否同步更新
- 改 DTO → 检查 `dto.ts` + 模板中数据来源 + 所有 computed/watch 依赖此字段的路径
- **新增 IPC 调用** → 必须是非阻塞模式，调用方不能同步 await 后阻塞 UI

## Notes

- MCP调试完成后，应该主动关闭由MCP拉起的浏览器进程，注意：不要错误关闭掉了用户启动的浏览器进程。
- 优先使用 /mmc-cli来读取图片信息，如果失败再回退到模型的处理能力上
- 优先使用 /mmc-cli来读取图片信息，如果失败再回退到模型的处理能力上
- 优先使用 mmc-cli 这个skill来读取图片信息，如果失败再回退到模型的处理能力上
- 以后不是自己改的文件，一定不能进入自己的Commit的，有多人都修改的文件需要Commit，就请示如何处理
