# CLAUDE.md — gitea-kanban

> 这是给 Claude 的工作指引版摘要。若与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准。
>
> **最后更新**：2026-07-12（v2.0 + v2.4 + v2.5 + v2.6 + v3.x + v0.3.0 + v0.5.3 + v0.6.0 + v0.7.0 + v0.7.1 + v0.7.2 + v0.7.3 + v0.7.4 + v0.7.5 + v0.7.6 + v0.7.7）。详细版本演进看 [AGENTS.md](./AGENTS.md) 顶部。

## 项目一句话

`gitea-kanban` 是一个基于 Gitea/GitHub 的桌面端看板 + Git Graph 工具，技术栈固定为 **Go + Wails v2 + Vue 3**（v1 时代的 Electron+TypeScript+SQLite 已迁移完成）。

目标用户包含非技术人员，所以 UI 必须零术语、危险操作二次确认、错误提示要人话。

## 固定技术栈（v2.0 + v2.4 + v2.5 + v2.6 + v3.x + v0.3.0 + v0.5.3 + v0.6.0 + v0.7.0 + v0.7.1 + v0.7.2 + v0.7.3 + v0.7.4 + v0.7.5）

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
>
> **v3.0–v3.14 历史**：Git Graph 严格 1:1 复刻 vscode-git-graph（已上述 v0.5.3 为准）

- 运行时：Go 1.22+ + Wails v2.12（用系统 WebView，非 Chromium）
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
