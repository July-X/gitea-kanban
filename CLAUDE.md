# CLAUDE.md — gitea-kanban

> 这是给 Claude 的工作指引版摘要。若与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准。
>
> **⚠️ 版本演进信息不在本文件维护**：所有版本的演进历史 / release note 索引统一在 [docs/releases/INDEX.md](./docs/releases/INDEX.md)。本文件**仅承载项目规范 + 工作指引**，不承载版本信息。

## 项目一句话

`gitea-kanban` 是一个基于 Gitea/GitHub 的桌面端看板 + Git Graph 工具，技术栈固定为 **Go + Wails v2 + Vue 3**（v1 时代的 Electron+TypeScript+SQLite 已迁移完成）。

目标用户包含非技术人员，所以 UI 必须零术语、危险操作二次确认、错误提示要人话。

## 固定技术栈

> **v2.4 增量**：go-git 走 `NoCheckout=true` 轻量模式（只拉元信息，磁盘 -99%）；所有 Wails binding 接受 `projectId` / `owner+repo` 业务态概念（Go 端反查 `localPath + token`，AGENTS §8.1 鉴权铁律）
>
> **v2.5 增量**：workspace 按账号分层（旧布局自动迁移到 `_pre_v25_workspace` 备份）
>
> **v2.6 增量**：StatusBar 同步进度条（go-git sideband → EventsEmit → 前端 UI）
>
> **v0.5.0 增量**：PR 评论模块 M1-M4 完整交付。文件评论（PullFileComments.vue + 4 个 platform adapter 方法 + 4 个 bindings）、对话流融合 Review 事件系统消息、三 Tab PR 详情布局（概览/文件评论/对话），TS DTO + store + ipc-client 扩展。docs/adr/0008 + docs/releases/v0.5.0.md。
>
> **v0.6.0 增量**：app.go 9 文件拆分（主文件 226 行）+ MergesView 三 Tab 重构 + PR 属性编辑器（Milestone / Review 行内评论 / Assignee 多选）+ store-first 封装（`updateLabels / updateAssignees / updateReviewers / updateMilestone` actions）+ 提交签名验证 9 种状态 + commit 计数 badge + GitHub PR 闭环。docs/releases/v0.6.0.md。
>
> **v0.7.0 增量**：GitHub adapter 5 方法补全（`ListLabels` / `ListMembers` / `ListMilestones` / `UpdatePullMilestone` / `ListPullCommits`）+ 属性编辑器对 GitHub 数据源可用（放开 v-if）+ GitHub milestone 进入 PR 详情 + `CreatePullReview` 行内评论 + 跨平台 build CI。docs/releases/v0.7.0.md。
>
> **v0.7.1 增量**：PR 对话区对齐 Gitea web（评审拆 2 卡 / 合并检查警告区 toggle / 系统事件卡独立渲染）+ Timeline 数据源切换（`/issues/{index}/timeline` 端点 + TimelinePanel store）+ pnpm typecheck 60 → 0 错。docs/releases/v0.7.1.md。
>
> **v0.7.2 增量**：视觉 1:1 对齐 Gitea web —— 5 档颜色（success/danger/merge/warn/neutral）+ 21 个 lucide icon 替代 Unicode + 7 类系统事件二级详情块（label/milestone/assignees/title/branch/ref/dependency）+ 气泡左箭头 CSS 三角形 + Dismiss review 拆 2 卡。后端 `platform.TimelineItem` 加 12 个二级详情字段 + `IssueDTO` 加 3 个跨仓 ref 字段 + `TestGiteaAdapter_ListPullTimeline_DetailFields` 7 类系统事件解析测试。docs/releases/v0.7.2.md。
>
> **v0.7.3 增量**：Timeline 视觉对齐 Gitea web —— 系统事件紧凑单行布局（去掉 bubble 框，纯 icon + 单行文字）+ 左侧贯穿 timeline 竖线（2px 灰色垂直线，圆点节点切断）+ 5 档颜色应用到 dot 边框 + 评审 state 独立 dot 颜色 + 二级详情拆 inline/block 两层。docs/releases/v0.7.3.md。
>
> **v0.7.4 增量**：Timeline 细节补全 —— DisplayName 全链路（`PullUserDTO.FullName` + gitea/github 双 adapter 解析 + `displayName()` helper）+ "评论于" 动词 + 时间链接样式 + 系统事件 verb item 级别化（`systemEventVerb(item)` 区分添加/移除）+ 3 类系统事件 inline 详情（review_request 评审人 / assignees 指派人 / merge commit SHA）+ 评论 header 右侧 [所有者] 角色标签 + Smile 表情按钮 + 8 emoji popover + MoreHorizontal ... 菜单（按权限动态显示：引用/复制链接/编辑/删除）+ 新增 `--color-timeline` token（暗色 18% alpha，比 `--color-divider` 亮 80%）。docs/releases/v0.7.4.md。
>
> **v0.7.5 增量**：系统事件 UX 文案 + 时间格式对齐 Gitea web —— `systemEventVerb(item)` 字典重写覆盖 22+ 种 Gitea CommentType 全部 case（之前 18 种 + "事件" fallback → 现在全部具体 verb）+ PR 动作加 "此合并请求" 限定词（"关闭了此合并请求"/"重新开启了此合并请求"/"置顶了此合并请求" 等）+ 时间格式从 `X verb · Y 天前`（独立在右）改成 `X 于 Y verb`（融进行内 + "于" 介词）+ push event 数量解析（regex 抠 body 里的 commit 数量，输出 "推送了 N 个提交"）+ 移除 v0.7.x "事件" 通用 fallback（未识别 type 返回空字符串）+ CSS：新增 `.pr-detail__event-prep`（"于" 介词样式）。docs/releases/v0.7.5.md。

> **v0.7.6 增量**：4 个 user 反馈问题修复 + label 全背景色 —— ① 评论 body 缺失时 `v-if="item.body"` 防御 + "（无内容）" 占位（避免 v-html='' 渲染空 div 让用户误以为评论内容缺失）② WIP toggle 改标题事件识别：`TimelineItem.IsWipToggle/IsWip` 字段（后端仿 Gitea `commentTimelineEventIsWipToggle` 检测"加/去 WIP: 前缀"特殊事件），前端 `systemEventVerb` 走 2 个分支（"已将合并请求标记为进行中"/"可评审"，对齐 Gitea web 中文 locale）③ PR header 改格式 `<author> 请求将 <N> 次代码提交从 <head> 合并至 <base>`（对齐 Gitea web `templates/repo/issue/view_title.tmpl`）+ 分支名加链接（Gitea `/src/branch/{ref}` / GitHub `/tree/{ref}`）+ 新增 `branchWebUrl(ref)` helper + `PullDetailDTO.Commits` 字段（N 从 Gitea `/pulls/{index}` `commits` 字段）④ label 事件按 Gitea web 行为合并：`pull.ts` 新增 `mergeLabelEvents()` helper（仿 Gitea `routers/web/repo/issue_view.go: mergeLabels`，同作者 + 时间间隔 < 60s 连续 label 事件合并到第一条，标点 add/remove 互转，后一条设 merged=true）+ 后端 `giteaTimelineToItem` 拆分 Content=`"1"` → AddedLabels / 其他 → RemovedLabels + `TimelineItem` 加 AddedLabels/RemovedLabels/LabelAction 字段 + `systemEventVerb` 加 label 三态文案 + CSS `.pr-detail__event-labels` flex 容器 + `--add/--remove` + / − 圆点 ⑤ label chip 全背景色：`labelStyle()` 之前 `color + '22'` (13% alpha) + 边框 → 暗色主题看不清，改 `color` 实心 + WCAG 相对亮度 `(0.2126R + 0.7152G + 0.0722B) / 255` 阈值 0.453 决定白字/黑字（对齐 Gitea `modules/util/color.go: ContrastColor`）+ 边框 transparent + `.merge-item__label` 同步去掉边框 + CSS 新增 `.pr-detail__branch--link` / `.pr-detail__comment-body--empty`。docs/releases/v0.7.6.md。

> **v0.7.7 增量**：push 事件 commit 列表 + merge 事件 commit 链接（user 反馈 ⑥ "带分支信息的评论没正确还原"）—— ① 后端 `platform.TimelineItem` 加 `OldCommit / NewCommit / CommitsNum / IsForcePush`（push 事件）+ `MergeCommitSHA`（merge 事件）字段 + `giteaTimelineRaw` 加 `old_commit_id / new_commit_id / commits_num / is_force_push` 4 字段 + `giteaTimelineToItem` 映射 ② 前端 `TimelineItemDto` 同步 5 字段 + `commitsByPR: Map<index, PullCommitDto[]>` 缓存 + `loadCommits(projectId, index)` helper + `loadComments` 调完 `fetchTimeline` 后并行 `loadCommits` ③ push 事件 inline 块：7 位短 SHA 链接到 Gitea web `/commit/{full_sha}`（`commitWebUrl(sha)` helper，Gitea / GitHub 通用）+ force push 时加 "(强制推送)" 提示 ④ push 事件 block 块：缩进 22px + 左侧 2px 分隔线（对齐 Gitea web `commits_list_small.tmpl`）+ 每行 `GitCommit` icon + 短 SHA 链接 + commit 消息 + 提交者 ⑤ merge 事件 inline 块：SHA 改成 `<a>` 链接到 Gitea web `/commit/{sha}`（优先用 `item.mergeCommitSha`，fallback 用 body regex 抠的 7 位短码）⑥ 新增 3 个 helper：`fullMergeSha(item)` / `pushEventCommits(item)`（v0.7.7 简化版按 NewCommit 位置 + CommitsNum 从 commitsByPR 过滤）/ `commitWebUrl(sha)` ⑦ lucide `GitCommit` icon 引入 ⑧ CSS 8 处新增（`.pr-detail__event-block--commits` / `.pr-detail__event-commit-row` / 4 个子元素样式）。docs/releases/v0.7.7.md。

> **v0.7.8 增量**：push/merge 事件详情 根因修复（user 反馈 ⑦ "对话事件中的 commit 信息还是看不到"）—— v0.7.5/v0.7.7 写 push/merge 事件时**没实测过 Gitea 1.26+ API**，凭印象假设 4 个独立顶层字段（OldCommit/NewCommit/CommitsNum/IsForcePush）+ type 字符串 "push"/"merge"，实际 Gitea 1.26+ 是 snake_case `pull_push`/`merge_pull` + 真实 commit_ids 在 body JSON 字符串 `{"is_force_push":false,"commit_ids":["sha1"]}` 里 + merge_pull event body 是空字符串。v0.7.8 全部重写：① 后端 `giteaTimelineToItem` 加类型归一化（`pull_push`→`push` / `merge_pull`→`merge`）+ push event 解析 body JSON → `CommitIDs []string` + `IsForcePush` ② 删 3 个无用字段（OldCommit/NewCommit/CommitsNum）③ `giteaPullRaw` + `giteaPullToDetail` 补 `MergeCommitSHA` 字段映射（v0.7.7 加了 DTO 字段但 adapter 漏 raw 字段）+ GitHub adapter 同步 ④ 3 个新测试覆盖 type 归一化 / commitIds 提取 / body 解析失败 / PR 详情 merge_commit_sha 映射 ⑤ 前端删 v0.7.7 引入的组件本地 `commitsByPR / commitsLoading / loadCommits`（双 Map bug）+ `pushEventCommits / fullMergeSha / mergeCommitSha` helper（key 错 + body regex 抠永远 null）⑥ push event 渲染直接用 `item.commitIds` 数组 v-for（仿 Gitea web `commits_list_small` 模板）+ commitDetails(sha) helper 从 store 缓存按 SHA 短码补 subject/author ⑦ merge event inline 块从 `selectedPR.value?.mergeCommitSha` 拿 SHA 链接（PR 详情端点字段，store `fetchPullDetail(p)` 新增 + `loadComments` 并行 3 个请求）⑧ `PullDto` 加 `mergeCommitSha?: string` 字段 + `TimelineItemDto` 加 `commitIds?: string[]` 删 4 字段 ⑨ Wails binding 自动重生成。docs/releases/v0.7.8.md。

> **v0.7.9 增量**：PR header / 列表项 / merge warning 显示真实分支名（user 反馈 ⑧ "缺少明确的分支记录"）—— Gitea API `/pulls/{index}` 端点 head/base 嵌套对象里返 `label` 字段（真实分支名 `pr-with-labels-366575`）+ `ref` 字段（git ref 全路径 `refs/pull/72/head`），v0.7.6 改 PR header 格式时只用了 ref 字段（user 截图显示 "refs/pull/72/head" 不像分支名）。v0.7.9 修：① 后端 `giteaPullRefRaw` + `githubPullRefRaw` 加 `Label` 字段 + `giteaPullToDetail` / `githubPullToDetail` 映射到 `PullRefDTO.Label` ② `PullRefDTO` 加 Label string 字段 ③ 前端 `PullRefDto` 加 `label?: string` 字段 ④ 新增 `headLabel(p) / baseLabel(p)` helper（label 优先 ref 兜底）⑤ PR header / 列表项 / merge warning / merge event inline 块 / 合并确认框 / 删除源分支提示 8 处模板替换。docs/releases/v0.7.9.md。

> **v0.7.10 增量**：PR 对话区 UI 微调（user 反馈 ⑨）—— ① 移除 `pr-detail__conv-header` 对话标题 div（"不需要展示出来"，含 MessageSquare icon + "对话" + 计数 badge + 刷新按钮整块） + 删对应 CSS（.pr-detail__conv-header / .pr-detail__conv-header-left / .pr-detail__conv-count）② timeline dot 22px → 26px（"大一点点"）+ 内部 icon size 13 → 15（review state + system event 2 处同步放大）③ timeline 文字字号升一档：event-line 显式 14px（继承默认 13px）+ event-prep 14px（13px）+ event-time 12px（11px，inline 不引 --font-mono 避免中文 + 数字用等宽字体）+ event-inline 14px（13px）。docs/releases/v0.7.10.md。

> **v0.7.11 增量**：指派自指派判断 + delete_branch verb 对齐 Gitea web（user 反馈 ⑩ "指派给自己的事件，没有对齐" + "分支信息还是有缺失"）—— ① `systemEventVerb` assignees 分支补 `isSelfAssign` 判断（`assignee.username === author.username`）：自指派 → "自指派"/"取消自指派"、指派给他人 → "指派给"/"取消了指派"，对齐 Gitea web 中文 locale（v0.7.5 注释里就有规划但代码漏判）② `systemEventVerb` delete_branch 分支：'删除了分支' → '删除分支'（去掉"了"字对齐 Gitea web "删除分支 ex-same-057405" 渲染，分支名走 inline 块的 GitBranch icon + `<code>{{ item.oldRef }}</code>`，v0.7.4 已有）③ 注意：close 事件 verb "关闭了此合并请求" 跟 Gitea web "关闭此合并请求"（无"了"）也对不齐，user 没明确反馈本次没动。docs/releases/v0.7.11.md。

> **v0.7.12 增量**：Gitea web 1:1 对齐 assignees / delete_branch 渲染（user 反馈 ⑪ "指派给自己的事件，没有对齐" + "分支信息还是有缺失" + "推送事件没显示 commit 消息"）—— ① assignees 事件删除 v0.7.4 加的 inline 块（"+/− icon + assignee 用户名 + 添加了指派" 缩进），对齐 Gitea web 把信息合并到主行 verb（"kanban_bot 于 上个月 指派给自己"）② delete_branch 事件 verb 直接拼分支名（`删除分支 ${oldRef.replace(/^refs\/heads\//, '')}`），去掉 inline 块（v0.7.10 改 CSS 后 user 反馈仍看不到 inline 块，verb 拼接方案兜底），对齐 Gitea web "kanban_bot 于 3 周前 删除分支 cx-same-057405" 渲染 ③ push 事件 commit 消息 v0.7.8 已加 block 块 + commitDetails(sha) helper，留给 user 升级 binary 验证（如不生效 v0.7.13 排查）。docs/releases/v0.7.12.md。

> **v0.7.13 增量**：assignees verb 文案对齐 Gitea web（user 反馈 ⑫"自指派应该改成指派给自己，指派给其他人应该是指派给X"）—— 4 字符串全部按 Gitea web `repo.issues.self_assigned` / `assigned_to` / `unassigned` / `unassigned_from` 中文 locale 改：自指派 add → "指派给自己" / 自指派 remove → "取消指派给自己" / 他人 add → "指派给 {X}"（拼接 `displayName(item.assignee)`） / 他人 remove → "取消指派给 {X}"。user 反馈"还是看不到具体的分支信息"（push event commit 消息 + delete_branch 分支名）v0.7.8 + v0.7.12 master 已修，但 user 实际跑 v0.7.5 之前 binary 看不到效果，需要升级 binary 才能看到新效果。docs/releases/v0.7.13.md。

> **v0.7.14 增量**：label 事件 chip 移到主行（user 反馈 ⑬"修改了标签"后面 chip 不要单独换一行显示）—— v0.7.6 把 label chip 渲染在独立 `<div pr-detail__event-inline>` 块（缩进显示），跟 push/merge 在主行 v-else-if 链里渲染的风格不一致；v0.7.14 改：把 label chip 搬到主行 `<div pr-detail__event-line>` 内紧跟 verb span 后，跟 push/merge 一致同 div 渲染；保留单 chip 兜底；删除 inline 块内 label chip 重复渲染。对齐 Gitea web "X 于 Y 修改了标签 [bug] [feature] [needs-review]" 一行渲染。user 反馈"还是看不到具体的分支信息"v0.7.8 + v0.7.12 master 已修，user 实际跑 v0.7.5 之前 binary 看不到效果。docs/releases/v0.7.14.md。

> **v0.7.15 增量**：merge 事件对齐 Gitea web "合并提交 X 到 Y"（user 反馈"文本说明中'合并提交 X 到 Y'"）—— ① `systemEventVerb` merge 分支去"了"字："合并了提交" → "合并提交"（对齐 Gitea web "merged commit" 无"了"字） ② merge 事件 v-else-if 链调整渲染顺序为 `ShortSha 链接 + 到 + branch`，删 v0.7.8 加的 GitMerge icon（icon 已通过主行 timeline-dot 渲染，去重），对齐 Gitea web "X 于 Y 合并提交 f30ece070c 到 main" 一行渲染。docs/releases/v0.7.15.md。

> **v0.7.16 增量**：merge 事件整段 white-space: nowrap 强制 1 行渲染（user 反馈"合并提交 X 到 Y" 应该 1 行显示）—— v0.7.10 加的 `flex-wrap: wrap` 让长内容在主行宽度不够时换行成 2 行（"X 于 Y 合并提交" 主行 + "ShortSha 到 branch" 下一行）。修法：新增 `.pr-detail__event-merge` CSS class（`white-space: nowrap` + `display: inline-flex`）+ merge 事件 v-else-if 链 span 加 class，强制整段 1 行。主行 `flex-wrap: wrap` 保留让 author / time 太长可换行。对齐 Gitea web "X 合并 commit {sha_short} 到 {branch}" 1 行渲染。docs/releases/v0.7.16.md。

> **v0.7.17 增量**：pr-detail__event-content 内部尽量 1 行显示完（user 反馈"'pr-detail__event-content' 当中内容，应该尽量 1 行显示完，不要多行显示，和 Gitea web 保持一致"）—— v0.7.16 只给 merge 事件整段加 nowrap 兜底，其他事件（push / label / assignees / change_title / review_request / change_target_branch / delete_branch / milestone）还是被 v0.7.10 加的 `flex-wrap: wrap` 换行成 2 行。修法：v0.7.17 收口主行 + inline 块强制 1 行——`.pr-detail__event-content` 加 `overflow: hidden`（内容超出容器宽度直接截断，不撑爆 timeline 列宽），`.pr-detail__event-line` 改 `flex-wrap: nowrap` + 加 `white-space: nowrap` + `overflow: hidden`（主行强制 1 行）。block 块（push event commit 列表）保留 column 布局（每 commit 1 行对齐 Gitea web `commits_list_small` 模板），inline 块（label 兜底单 chip 块）继续 wrap 走窄屏换行。对齐 Gitea web 实际渲染——"X 合并 commit {sha_short} 到 {branch}" / "X 修改了标签 [bug]" / "X 删除分支 cx-same-057405" / "X 指派给自己" 等全部 1 行。docs/releases/v0.7.17.md。

> **v0.7.18 增量**：TimelineItem DTO 字段名 camelCase + merge 事件真正搬主行（user 反馈 "分支信息还是换行了" + "push、delete 事件的分支信息还是未显示"）—— 2 个根因：① TimelineItem DTO 字段 snake_case（Go json tag）→ Wails 生成 snake_case TS class → 前端 dto.ts camelCase 强转后所有 camelCase 访问都拿 undefined（v0.7.6 / v0.7.8 / v0.7.9 加的 13 个字段基本都失效：commitIds / isForcePush / mergeCommitSha / isWipToggle / isWip / addedLabels / removedLabels / labelAction / oldRef / newRef / oldTitle / newTitle / refIssue / refAction / refCommitSha / dependentIssue / removedAssignee / oldMilestone / assignee）。后果——push 事件 block 块不渲染（commit 列表空白）/ WIP toggle 检测走不到（全部走"修改了标题"兜底）/ label 合并 mergeLabelEvents 失效 / assignees isSelfAssign 永远 false（verb 走"指派给"不走"指派给自己"）/ delete_branch 分支名拿不到 / change_title oldTitle → newTitle 不显示 / 跨引用 issue / dependency block 块不显示 ② v0.7.15 注释说要把 merge 事件 SHA + branch 拼到主行 verb 后但**实际没动代码**——span 还在 inline 块（`<div class="pr-detail__event-inline">` 子 div 必然另起一行），v0.7.16 加 `class="pr-detail__event-merge"`（white-space: nowrap）+ v0.7.17 加 `.pr-detail__event-line` 主行 nowrap 都救不了 inline 子 div 必然换行。修法：① `app/platform/adapter.go` TimelineItem 20 字段 json tag 全部 snake_case → camelCase（`commitId` / `oldTitle` / `isWipToggle` / `addedLabels` / `commitIds` / `isForcePush` / `mergeCommitSha` 等），跟 `PullDetailDTO` 保持一致风格，`wails generate module` 重新生成 models.ts（80 处字段名自动改）② `MergesView.vue` merge 事件 v-else-if 链 span 真正搬到主行 `pr-detail__event-line`（紧跟 verb 后，跟 v0.7.14 label chip 同样模式），inline 块里那个 span 整段删掉。修复后预期 Gitea web 1:1 一行渲染——"X 推送了 N 个提交" + 下方 commits_list_small 块 / "X 合并提交 7db04cd 到 main" 1 行 / "X 已将合并请求标记为进行中" 1 行 / "X 指派给自己" 1 行 / "X 删除分支 cx-same-057405" 1 行。docs/releases/v0.7.18.md。

> **v0.7.19 增量**：label 方向判断改用 body 字段 + push event 渲染对齐 Gitea web（user 反馈"事件标记错误"+"UI 没有对齐"）—— 2 个根因：① v0.7.6 调研 Gitea 源码 `models/issues/comment.go: Content` 字段在 type=7 label change 时写 `"1"`=add，但 Gitea 1.26+ timeline 端点 label 事件**没有 `content` 字段**——label add/remove 信息在 `body` 字段（实测 pr72/pr81 timeline 数据 label event body 全是 `"1"`）。v0.7.6 写代码时把字段名搞错（`r.Content` 永远空串），label 判断永远走 remove 路径，前端 verb 显示"移除了标签"，跟 Gitea web "添加了标签" 相反 ② v0.7.8 push event 渲染多加了 inline 块 head commit 短码链接 + block 块短 SHA 前缀，跟 Gitea web 1:1 对齐冗余——Gitea web `commits_list_small` 模板只显示 commit 消息（带链接到 commit 页）+ author avatar，没有短 SHA 前缀。修法：① 移除 v0.7.6 加的 r.Content struct 字段（json tag 改 `"body"` 会跟 Body 字段冲突，Go json.Unmarshal 同一 tag 多个字段会全部不填值），label 判断改用 `r.Body` 字段。改 `TestGiteaAdapter_ListPullTimeline_LabelAction` 测试 input 也用 body 字段 ② 删 push event inline 块 head commit 短码链接 + block 块 short SHA 链接改成 commit 消息链接（commit 消息本身就是链接，user 点击跳转 Gitea web 不需要单独短 SHA 链接）+ force push 提示搬主行。修复后预期 Gitea web 1:1 对齐——"X 添加了标签 [bug]" 1 行 / "X 推送了 1 个提交" 1 行 + 下方 commits_list_small 块（只 commit 消息 + author，无短 SHA 前缀）。docs/releases/v0.7.19.md。
>
> **v0.8.x 自动更新全链路 + 累积 fix（v0.8.0 ~ v0.8.22）**：见 [docs/releases/INDEX.md](./docs/releases/INDEX.md) 完整索引。v0.8.0 拍板 macOS+Windows 应用内自动更新（manifest + ed25519 + 断点续传 + Wails 2.12 + NSIS），后续 22 个版本主要是 release.yml 修复、CI 累积 fix、macOS dmg 签名链路补全、PR 属性编辑器乐观更新等。
>
> **v0.8.23.4 增量**：Windows 自动更新 apply 阶段 Win32 740 ERROR_ELEVATION_REQUIRED 修复（user 实测截图：NSIS installer 启动失败 + "可手动重试"）—— 根因：`app/updater/updater_windows.go` 走 `exec.Command(installerPath).Start()` 调 `CreateProcess`，**不触发 UAC**；NSIS installer manifest 声明 `requireAdministrator`（要写 `C:\Program Files\`），直接返 740。修法：改走 `ShellExecuteExW` + `lpVerb="runas"` 触发 UAC 弹窗（用户点确认后 NSIS 以管理员权限安装），新增 `shellExecuteInfoW` 结构体镜像（字段顺序严格对齐 Win32 `SHELLEXECUTEINFOW`，cbSize 用 `unsafe.Sizeof` 算）+ `launchElevated(installerPath, shortInstallDir)` 函数 + `launchElevatedWith` 可注入测试版本（fake launcher 捕获入参）+ 6 个单测覆盖 `lpVerb="runas"` / `lpFile` / `lpParameters="/S /D=<短路径>"` / `nShow=SW_HIDE` / `fMask` 标志 / UAC 取消（errno=1223 静默）/ 错误透传 / `win32ErrorHint` 5 种 errno → 人话翻译 + fallback 到 `explorer.exe /select,<installerPath>` 打开下载目录让用户手动双击 + 保留 `getShortPathNameW`（v0.8.16）+ 保留 `installerCommandLine` 仅作日志输出。docs/releases/v0.8.23.4.md。
>
> **v0.8.24 增量**：Git Graph vscode 原版幽灵 line bug 修复 —— `app/git/graph/layout_vscode.go` 复用 `layout.go` 的 main chain 锚定策略，给 `BuildGraphVscode` 加 `mainChain map[string]bool` 字段 + `computeMainChain` 函数（找 primary branch ref head → 沿 first-parent 标记 main chain），`determinePath` normal 分支 + merge stitch 分支强制 main chain vertex `cp.x=0`、非 main 在 `cp.x=0` 时强制 `cp.x=1`，解决 vscode-git-graph v1.30.0 原版 `vertex.nextX` 单调递增导致 first-parent 链 commit 被推到 lane 2+ + lane 0 出现贯穿 49 行"幽灵 line"（merge stitch 在 lane 0 沿线 0..50 的 line 段穿过 row 但该 row 没有 dot）。新增 `v0824_main_chain_test.go:TestBuildGraphVscode_MainChainLaneZero` 构造 M0(merge)/M1..M50/F1/F0 DAG 用 hex SHA（`%010x%030x`）避免 padding 撞 sha，断言 M0..M50 全部 Lane=0 + F1/F0 Lane!=0 + Branch[0] 所有 line 端点 x=0（无幽灵 line）。`layout.go` 的 v2.7 first-parent 不被 merge 抢占修复（`TestBuildGraph_FirstParentNotOverwriteMergeParent` 覆盖）与本版 `layout_vscode.go` 的幽灵 line 修复是**两套独立布局算法各自的主链锚定保护**。docs/releases/v0.8.24.md。
>
> **v0.8.26 增量**：Graph 算法入口统一收敛到 GitLens —— v0.8.25 默认切换后保留的 vscode-git-graph 1:1 复刻 fallback 经 2 周稳定性验证后 user 拍板全删。删 `app/git/graph/layout_vscode.go` (650 行) + `layout.go` (749 行孤儿代码) + 4 个 vscode 配套测试（`v0824_main_chain_test.go` 幽灵 line 修复回归 + `layout_uncommitted_test.go` Uncommitted 行渲染 + `layout_test.go` + `v27_regression_test.go` first-parent 回归）+ `layout_gitlens_e2e_test.go:220` vscode baseline 对照块 + 2 个 adapter 的 `pickGraphBuilder` env 开关 + `GITEA_KANBAN_GRAPH_ALGO` 环境变量（删除后两 adapter `os` import 一并删除）。DTO 共享类型（`GraphNode` / `GraphEdge` / `GraphBranchLine` / `GraphBranch` / `EdgeType` 常量 / `GraphResult`）迁到新建的 `app/git/graph/types.go`（237 行）并承接 `HasPrimaryBranchRef` 函数。净代码量 -1700 行 / +237 行。**v0.8.24 幽灵 line 修复的延续性**：`aa3b599` 中 `layout_vscode.go` 的 main chain 锚定 + `computeMainChain` 在 GitLens 算法中被 `assignColumnForRow` main chain reservation 等价重新实现，`TestBuildGraphVscode_MainChainLaneZero` 删除不降低覆盖（GitLens `TestBuildGraphGitlens_*` 系列覆盖等价拓扑）。**v0.8.24 release note 不删** —— 它仍是 vscode-git-graph 原版幽灵 line bug 的事实记录 + 调研过程。graph 包终极结构：`types.go` (237 行) + `layout_gitlens.go` (896 行) + 5 个测试 / dump 工具；`BuildGraphGitlens` 是**唯一公开入口**。docs/releases/v0.8.26.md。

> **v0.8.32 增量**：Windows GitHub 仓库刷新 `git: 'remote-https' is not a git command` 修复 —— 3 处改动：① `app/gitbinary/binaries/git/windows-helper/` 新增 21 个 helper + DLL（4 remote http exes + 16 libcurl/libssl/libcrypto/brotli/nghttp2/idn2/psl/ssh2/zstd 等）从 MinGit-2.55.0-64-bit.zip `mingw64/bin/` 提取，子目录 `.gitignore` 白名单 `!*.exe` / `!*.dll` ② `app/gitbinary/embed_windows.go` 加 `//go:embed binaries/git/windows-helper`（embed.FS）+ `app/gitbinary/runner.go` Init 释放 helper + DLL 到 `${dataDir}/tools/git/` 同目录 + 新增 `GitEnvFor(binPath, extraEnv)` 函数（仅内嵌路径触发，注入 `GIT_EXEC_PATH=<tools/git>` 让 git 找到 helper；系统 git / 用户自定义路径不注入避免破坏相对 exec-path 解析）+ Windows 平台 Init 末尾 `ls-remote https://github.com/git/git.git HEAD` smoke test 验证 helper 链通（失败仅 WARN，离线环境不阻断）③ `app/git/native.go:fetchRemoteWithFilter` 鉴权改造：删 `-c credential.helper=!gh auth git-credential`（需要 sh.exe 解析 `!` 前缀但 MinGit 不带 sh），改 env-based `GIT_CONFIG_COUNT/KEY_0/VALUE_0` 注入 `http.https://github.com.extraHeader=Authorization: Bearer <token>`（限定到 github.com 域避免 token 泄露给其它 remote；env 注入符合 §8.1 鉴权铁律）+ `FetchWithFilter` 同步删 `gitbinary.ResolveGhPath` 检查 + 错误信息去重（删「输出: %s」重复拼接）。跨平台 stub：`app/gitbinary/helper_darwin.go`（//go:build darwin）+ `helper_other.go`（!darwin && !windows）提供 `embeddedHelperFS()` / `embeddedHelperAvailable()` 接口——当前仅 Windows 嵌入 helper，macOS / Linux 走 stub 返 nil，未来若用户撞同类 bug 可直接扩展（不需改 runner.go）。测试 10 个新增：`app/git/native_test.go` 7 个（fetch args 不含 credential.helper / token 注入 extraHeader / no-token 跳过 / shallow unshallow / 内嵌 GIT_EXEC_PATH 注入 / 系统 git 不注入 / extraEnv 覆盖去重）+ `app/gitbinary/runner_e2e_test.go` 2 个（Init 释放 11 个 helper + DLL / helper 链通端到端断言）。bundle 端到端实测：`cp windows-helper/* gk-git-2.55.0-windows-amd64.exe /tmp/x/tools/git/ && GIT_EXEC_PATH=/tmp/x/tools/git ./gk-git ls-remote https://github.com/octocat/Hello-World.git HEAD` → 返回 `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d HEAD` exit=0。docs/adr/0010 + docs/releases/v0.8.32.md + docs/releases/INDEX.md 已同步。AGENTS.md §10 加第 12 条陷阱。
>
> **v0.8.32.1 增量**：v0.8.32 把 GitHub REST API 的 `Authorization: Bearer <pat>` 误用到 Git Smart HTTP 协议——私有仓库 fetch 永远 `remote: invalid credentials` / `Authentication failed for`。v0.8.32.1 修正鉴权格式为 `Authorization: Basic base64(x-access-token:<pat>)`（Smart HTTP 要求 Basic credential，username 固定为 `x-access-token`，base64 是传输编码不是脱敏）。3 处改动：① `app/git/native.go` 抽 `buildGitHubFetchAuthEnv(token) map[string]string` 纯函数（`strings.TrimSpace` token + base64 编码）+ `isGitHubAuthFailure` 关键字识别（`remote: invalid credentials` / `Authentication failed for` / `fatal: authentication failed`）+ `truncateForHint` 200 字符截断，`fetchRemoteWithFilter` 调新函数 + 401 时返 `ipc.NewGitHubAuthFailed` ② `app/ipc/errors.go` 加 `CodeGitHubAuthFailed` + `NewGitHubAuthFailed`（message=「GitHub 凭证无效，或当前账号没有读取该仓库的权限」+ hint=「请重新连接 GitHub 账号；私有仓库 token 需要读取权限，组织仓库可能还需要完成 SSO 授权」+ cause 截断 200 字符不暴露 token/base64/env）③ 前端 `frontend/src/shared/errors.ts` `IpcErrorCode.GITHUB_AUTH_FAILED` + `frontend/src/lib/ipc-client.ts` `KNOWN_ERROR_CODES` / `CODE_CATEGORY` / `RECOVERABLE` 三处扩展。`app/git/native_test.go` 改用 `buildGitHubFetchAuthEnv` 直接测（删 `buildFetchEnvForTest` 镜像 helper 避免测试/实现漂移）+ 5 新测试：trim / only-whitespace / `TestIsGitHubAuthFailure`(6 子用例) / `TestNewGitHubAuthFailed`(防 token/base64 泄露到 message/hint)。70 → 75 测试 / 11 包。`AGENTS.md` §10 第 12 条改 Bearer → Basic 描述。docs/releases/v0.8.32.1.md + docs/releases/INDEX.md 已同步。
>
> **v0.8.25 增量**：GitLens GKC 算法 Go 1:1 移植 —— v0.8.24 修了幽灵 line 但没解决 lane 膨胀（gitea-kanban master 实测 ~35 lane vs GitLens 桌面 ~15 lane），新加 `app/git/graph/layout_gitlens.go`（896 行）1:1 移植 `vscode-gitlens/packages/plus/commit-graph/src/engine/layout.ts + edges.ts`，关键差异：vscode 原版 `vertex.nextX` 单调递增永不回收（→ lane 35+）vs GitLens `columnsUsed Set + columnsToFreeWhenFound Map` 真正回收 column（→ lane 10-15）。**双轨布局**：visual pass `compact=true` 出紧凑 lane 编号（X 坐标用），color pass `compact=false` 出按 segment claim 顺序的 lane（颜色 % 16 用），单跑方案无法兼顾"紧凑+取色按 claim 顺序"，双跑性能可接受（150ms @ 3000 commits）。**5 个具体 bug 修**：`b989f9f` 排序 authorDate → committerDate（cherry-pick 行序错位）+ `b86a0fd` Uncommitted 行固定 lane 不参与接力 + `e9ed576 + 1acdfcb` fresh claim branchSha / DTO 转换层 4 bug + `1bc9fbc` 单 commit lane 不画线 + merge stitch 转场缺失 + **`64499be` 连线 4 形态 bug 修**（fork stitch `segmentToLines` 不处理 `seg.forkSha` 整段缺失 / pinned parent 汇入时不 mark columnsToFreeWhenFound 致 segment 不 finalize / merge incoming second parent 已在别 lane 时 branches 缺这条边 / merge edge child→parent 方向颜色应为 parent 链色 / 跨 lane 长线整条对角线应 pushSplit 转场段 ≤1 行高 + `LockedFirst` 决定斜切位置）。**配色优化**：`1075a95` lane 玫红 `#d9008f` → 草绿 `#7cb342`（lane 排除红色系原则，先两处 v0.7.x 已换纯红 / 橙红，本轮再换玫红）+ `07f3fb6` 草绿再换亮橙 `#e8890c`（实测 `b989f9f` lane 0 蓝 / lane 2 绿 间插草绿 hue 只差 22° 分不开，用户反馈再换；橙 + 蓝互补 + 绿强对比，对齐 GitLens 高区分效果）。**测试**：4 个新增 Go 测试文件 + 调试 dump 工具，共 1318 行覆盖单元 / DTO 转换 / 真实 TRex 仓库端到端行级对比。配套技术文档 [docs/design/gitgraph-engine.md](./docs/design/gitgraph-engine.md)（当前算法原理 + AI 借鉴指南 + 6 项"别照抄"坑清单）+ [docs/design/gitgraph-engine-history.md](./docs/design/gitgraph-engine-history.md)（四阶段演进：从字符流 → `layout.go` → vscode 1:1 → GitLens GKC 移植）。docs/releases/v0.8.25.md。
>
> **v3.0–v3.14 历史**：Git Graph 严格 1:1 复刻 vscode-git-graph（已上述 v0.5.3 为准）

- 运行时：Go 1.26+ + Wails v2.12（用系统 WebView，非 Chromium）
- git 客户端：go-git v5（纯 Go，无 CGO，替代旧的 spawn('git')；v2.4 走 NoCheckout 轻量模式）
- 凭证：zalando/go-keyring（纯 Go，替代旧的 @napi-rs/keyring napi 二进制）
- 本地库：**JSON 文件 + 文件 KV**（延续 ADR-0003 零 SQLite 决策）
- 同步队列：queue.jsonl（append-only JSONL）
- Gitea 集成：Go `net/http` 手写（替代旧的 gitea-js）+ `PlatformAdapter` 抽象层
- 日志：`log/slog` + 文件 transport
- 测试：Go 标准 `testing` + `httptest`（**60+ 测试用例覆盖 11 个 Go 包**，含 v2.4 新增 18+ 测试）
- 前端：Vue 3 + Vite + Pinia + Vue Router（**前端 v1 完全保留**）
- 打包：Wails build（macOS .app / Windows .exe / Linux AppImage）

## 多平台支持（v2.0 核心特性）

| 平台 | 鉴权 | 首期支持 |
|---|---|---|
| **Gitea** | `Authorization: token <pat>` | 完整：仓库/分支/Git Graph/议题/合并/标签/成员 |
| **GitHub** | `Authorization: Bearer [redacted]` | **PR 闭环 + 属性编辑器已完成**（v0.7.0 补 5 方法：ListLabels / ListMembers / ListMilestones / UpdatePullMilestone / ListPullCommits） |

GitHub Issue 暂不做（等 v0.7.x）；GitHub 看板暂不做。

## 关键产品约束

- Gitea/GitHub API 是 source of truth，本地只存偏好、缓存和必要的派生数据
- 不做 OAuth2，不做 nginx 反代，不做实时协作，不做 in-app 冲突解决
- token 只允许在 Go 进程内存和系统 keychain 中存在，不能写文件、state.json、日志、前端
- UI 文本禁止直接出现 `PR`、`merge`、`rebase`、`fork`、`repo`、`branch`、`maintainer` 等原词，必须走项目翻译表
- 危险操作必须二次确认，并说明影响
- 离线时降级到本地缓存（v2.1 计划加文件 KV 缓存层），写操作入队 queue.jsonl
- 主题策略按 v1.2 拍板的 2 主题方案（dark/light），不要自行改回多主题

## 目录边界

- `main.go` / `app.go` / `app/**`：Go 后端（Wails binding 入口 + 业务逻辑）
- `frontend/src/**`：Vue 3 渲染端
- `docs/design/**`：设计文档（部分已 deprecated，详见各文件顶部）
- `docs/adr/**`：架构决策记录
- `design-system/gitea-kanban/OVERRIDE.md`：当前生效设计系统

**不要跨边界写代码**：

- 不要在 Go 后端写 Vue 组件 / CSS
- 不要在渲染端调 Gitea API（必须走 Wails binding → Go 后端）
- 不要在渲染端改 `frontend/src/types/dto.ts` 的字段定义（DTO 是 binding 契约，前后端共享）

## 数据模型

- 业务态 8 张表（**全部**在 `${dataDir}/state.json`，由 `app/store/store.go` 的 `LocalState` 定义）
- v2 新增 `Platform` 字段（`gitea` / `github`），旧数据迁移默认 `gitea`
- 原子写（tmp + rename）+ 并发安全（`sync.RWMutex`）
- Workspace 路径：默认 `~/.gitea-kanban/workspace`，repos 存 `${workspace}/repos/${username}/${owner}__${repo}/`（v2.5 按账号分层；旧布局自动迁移到 `_pre_v25_workspace` 备份）
- 同步队列：`${dataDir}/queue.jsonl`（append-only + 崩恢复 + 30 天 GC）

## Wails Binding 模式

- 所有 Go → 渲染端的 binding 方法都集中在 `app.go` 的 `App` struct 上
- 签名：`(args struct) (result, error)`
- Wails 自动生成 TS bindings 到 `frontend/wailsjs/wailsjs/go/main/App.d.ts`
- 前端通过 `import { GetAppInfo } from '../wailsjs/go/main/App'` 调用
- 迁移期兼容：`frontend/src/lib/wails-api-shim.ts` 提供 `window.api.<namespace>.<method>()` 兼容层（旧 IPC 风格），逐步替换

## 安全与日志

- Go 端无 Electron sandbox；Wails 用系统 WebView 自带安全模型
- 渲染端默认 `contextIsolation: true`、`nodeIntegration: false`
- token 走 `go-keyring` 写系统 keychain（macOS Keychain / Windows Credential Vault / Linux Secret Service）
- dev fallback：文件 `userData/dev-tokens/<service>__<username>.json`（0600 权限）
- 主进程文件 I/O 走白名单，不接受用户绝对路径作为任意输入
- `MigrateRepo` 沙箱校验：`newWorkspacePath` 必须在 `allowedRoot` 之下
- `slog` 禁止把 `token` / `password` / `key` 等写入日志

## 路径规则

- 数据根目录：`GITEA_KANBAN_DATA_DIR` 环境变量 → 兜底 `~/.gitea-kanban`
- 日志目录：`${dataRoot}/logs/main/main.log`
- 不要再回到 `app.getPath('userData')`（Electron 概念，已不适用）

## 测试与验证

- Go 后端：`go test ./app/...`（9 个包 50+ 测试）
- 渲染端：Vitest（**当前 0 个运行**，v1 测试已归档）
- 关键 Go 测试：
  - `go test ./app/git/...`（clone/log/workspace/sync/lock）
  - `go test ./app/platform/...`（gitea+github adapter）
  - `go test ./app/secret/...`（凭证 fallback）
  - `go test ./app/store/...`（业务态）
  - `go test ./app/sync/...`（队列）
- `go vet ./...` 必须无 error
- `go build -o /dev/null .` 必须通过
- 前端类型检查走 `cd frontend && pnpm typecheck`；不要临时手写后台 `npx vue-tsc --noEmit &` + `sleep/kill/ps` 脚本，容易拿错 `$!` 并误判卡住
- `wails build` 至少 macOS 通过

## 启动调试（Wails v2，没有 Electron CDP）

Wails v2 没有 Electron 那套 CDP 远程调试端口（v1 的 9492 已不适用）。

```bash
# 设独立 data dir 避免污染
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-debug
rm -rf "$GITEA_KANBAN_DATA_DIR"

# 后台跑 dev
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev > /tmp/wails-dev.log 2>&1 &
sleep 10

# 看日志（slog 写文件，stdout 看不到）
tail -50 "$GITEA_KANBAN_DATA_DIR/logs/main/main.log"
```

常见启动问题：
1. macOS SIP 写权限 → 用 `GITEA_KANBAN_DATA_DIR=/tmp/...`
2. state.json 损坏 → 删 `state.json` 重启
3. go-git clone 失败 → 网络/token 问题，看 slog
4. wails 找不到 go/node → `wails doctor`

## 提交规范

- commit message 必须中文
- 格式：`<type>: <中文一句话描述>`
- type 只用 `feat / fix / refactor / perf / chore / test / docs / style`
- 阶段性交付要有 commit 和 hash
- 不要加 `Co-Authored-By`
- 当前单分支 `main`（v1 是 `master`，v2 已迁回 `main`）

## 常用文档入口

- `AGENTS.md`（**最权威**）
- `docs/adr/0005-electron-to-go-wails-migration.md`（v2.0 迁移决策）
- `docs/adr/0006-v24-iteration-fixes.md`（**v2.4 迭代修复**：鉴权铁律 / binding 补全 / 数据目录 / 反查链路 / prefs / go-git 轻量模式 6 个决策）
- `docs/design/07-v24-iteration.md`（v2.4 迭代记录：6 类问题的症状/根因/修复/回归测试）
- `docs/design/00-overview.md`（v1 综述，**部分已 deprecated**，v2.0/v2.4 横幅已加）
- `docs/design/02-architecture.md`（**DEPRECATED**，基于 Electron）
- `docs/design/03-frontend.md`（前端设计，v2 仍有效）
- `docs/design/06-gitgraph.md`（Git Graph 设计，v2 仍有效）
- `design-system/gitea-kanban/OVERRIDE.md`（当前生效设计系统）

## 实际工作提醒

- 任何开始前，先确认当前上下文是否已经有相关实现或历史决策
- 遇到不确定的库、框架、CLI、SDK，用官方文档确认，不要凭记忆
- 如果要改 UI，优先保持本项目已有的设计系统和零术语规则
- Go 代码优先用标准库 + go-git + zalando/go-keyring，不要引入新依赖除非必要
- 后端方法签名（含参数/返回 struct 字段）变化会同时影响 Wails 生成的 TS 类型和前端调用，要同时改两端并测试
