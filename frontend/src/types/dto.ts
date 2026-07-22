/**
 * dto.ts —— 前后端共享的 DTO 类型契约
 *
 * 历史来源（v1 时代，2026-06-10）：
 *   - v1 Electron 时代：Zod schema + z.infer 派生类型，原文件已随 v1 Electron 迁出本仓
 *   - v2.0 Wails 迁移：删 Zod 运行时校验，本文件保留纯 TS interface 作为 IPC DTO 契约
 *   - 同步 Wails 自动生成的 frontend/wailsjs/wailsjs/go/main/models.ts
 *
 * 用途：v0.3.0 渲染端 + Go 后端共享 IPC DTO 类型契约。
 *       本文件只包含 type/interface，不含 Zod 运行时校验。
 *
 * 转换规则（v1 → v2.0）：
 *   - `z.infer<typeof XxxDtoSchema>`  → `export interface XxxDto { ... }`
 *   - `z.enum([...])`                 → union 字面量类型（如 `type PullState = 'open' | 'closed' | 'all'`）
 *   - `.optional()`                   → `?:` 语法
 *   - `.default(x)`                   → 必填字段（z.infer 取 output 类型，default 后必有值）
 *   - `.nullable()`                   → `T | null`
 *   - `.strict()`                     → 运行时约束，类型层面忽略（interface 默认即开放，但 DTO 形态已固定）
 *   - ISO 日期字符串（z.string().datetime）→ `string`
 *
 * 注：成员类型在这里统一收口；store/view 直接复用，不再各自镜像一份。
 */

// ============================================================
// ===== auth 命名空间 =====
// ============================================================

/** auth.connect 入参 */
export interface ConnectArgs {
  giteaUrl: string;
  token: string;
}

/** gitea /user 响应子集 */
export interface UserDto {
  id: number;
  login: string;
  fullName?: string;
  email?: string;
  avatarUrl?: string;
}

/** gitea_accounts 行映射（不含 token） */
export interface GiteaAccountDto {
  id: string;
  /** v2 多平台：gitea | github */
  platform?: 'gitea' | 'github';
  giteaUrl: string;
  username: string;
  createdAt: string;
  /** v2 新增：denormalized 用户信息（AccountManagerDialog 用） */
  userInfo?: {
    giteaUserId: number;
    login: string;
    fullName?: string;
    email?: string;
    avatarUrl?: string;
    updatedAt: string;
  } | null;
}

/** auth.connect 出参 */
export interface ConnectResult {
  account: GiteaAccountDto;
  user: UserDto;
}

/** auth.disconnect 入参（按 giteaUrl 定位） */
export interface DisconnectArgs {
  giteaUrl: string;
}

/** v1.6 auth.disconnectOne 入参（按 giteaUrl + username 精确删除单个账号） */
export interface DisconnectOneArgs {
  giteaUrl: string;
  username: string;
}

/** v1.6 auth.switchAccount 入参（按 accountId 重排 accounts 顺序） */
export interface SwitchAccountArgs {
  accountId: string;
}

/** auth.status 出参（不含 token） */
export interface StatusResult {
  accounts: GiteaAccountDto[];
  currentUser: UserDto | null;
}

// ============================================================
// ===== repos 命名空间 =====
// ============================================================

export interface Permissions {
  pull: boolean;
  push: boolean;
  admin: boolean;
}

export interface RepoDto {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  /** 后端 JSON 对空字符串使用 omitempty，可能缺失 */
  description?: string;
  defaultBranch: string;
  archived: boolean;
  private: boolean;
  updatedAt: string;
  permissions: Permissions;
  projectId?: string;
  isProject: boolean;
  lastSyncAt?: string;
}

export interface RepoProjectDto {
  id: string;
  giteaAccountId: string;
  /** v2 多平台：gitea | github */
  platform?: 'gitea' | 'github';
  owner: string;
  name: string;
  defaultBranch: string | null;
  lastSyncAt: string | null;
  createdAt: string;
}

export interface ListReposArgs {
  giteaAccountId: string;
  query?: string;
  limit: number;
  page: number;
}

export interface ListReposResp {
  items: RepoDto[];
  total: number;
  page: number;
  hasMore: boolean;
}

export interface AddProjectArgs {
  giteaAccountId: string;
  owner: string;
  name: string;
}

export interface RemoveProjectArgs {
  projectId: string;
}

// ============================================================
// ===== branches 命名空间 =====
// ============================================================

export interface BranchLastCommitDto {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchDto {
  name: string;
  sha: string;
  protected: boolean;
  isDefault: boolean;
  starred: boolean;
  lastCommit?: BranchLastCommitDto;
}

export interface ListBranchesArgs {
  projectId: string;
  query?: string;
  limit: number;
  page: number;
}

export interface ListBranchesResp {
  items: BranchDto[];
  total: number;
  hasMore: boolean;
}

export interface RenameBranchArgs {
  projectId: string;
  oldName: string;
  newName: string;
}

export interface StarBranchArgs {
  projectId: string;
  branch: string;
  starred: boolean;
}

// ============================================================
// ===== commits 命名空间 =====
// ============================================================

/** 卡片 ↔ git 引用关联条目（DTO 形态） */
export interface LinkedCardDto {
  cardId: string;
  columnName: string;
}

export interface CommitAuthorDto {
  name: string;
  email?: string;
  avatarUrl?: string;
}

export interface CommitCommitterDto {
  name: string;
  email?: string;
}

/** 单个文件变更（v1.1.3 · task #23） */
export interface CommitFileChangeDto {
  filename: string;
  /** 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' —— gitea 原值 */
  status?: string;
  additions?: number;
  deletions?: number;
  /** gitea 端 total changes（≠ additions+deletions，因 whitespace 等） */
  changes?: number;
  /** 旧名（status=renamed 时才有） */
  previousFilename?: string;
  /** 是否二进制 */
  binary?: boolean;
  /** hunk 头解析出的"改动函数/方法"列表（已按文件合并去重） */
  functions?: string[];
}

export interface CommitDto {
  sha: string;
  shortSha: string;
  message: string;
  author: CommitAuthorDto;
  committer: CommitCommitterDto;
  date: string;
  parents: string[];
  additions?: number;
  deletions?: number;
  filesChanged?: number;
  /** 单条 commit 详情才返（list 端点不返） */
  files?: CommitFileChangeDto[];
  linkedCards?: LinkedCardDto[];
  /** GPG 签名状态（commitsGet 单条详情才有） */
  gpg?: CommitGpgDto;
}

/** 单个 commit 的 GPG 签名状态（go 后端 app/git/repo.go CommitGpgStatus 的 TS 镜像） */
export interface CommitGpgDto {
  status: string;
  key: string;
  name: string;
}

export type CommitDetailDTO = CommitDto;

export interface ListCommitsArgs {
  projectId: string;
  sha?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  page: number;
  limit: number;
}

export interface ListCommitsResp {
  items: CommitDto[];
  total: number;
  hasMore: boolean;
  nextPage: number | null;
}

export interface GetCommitArgs {
  projectId: string;
  sha: string;
}

// ============================================================
// ===== pulls 命名空间 =====
// ============================================================

export interface PullRefDto {
  ref: string;
  // v0.7.9：真实分支名（去掉 refs/heads/ 前缀）。Gitea 1.20+ 在 head/base 嵌套
  // 对象里返 label 字段（与 ref 不同），Gitea web 用 label 渲染 PR header 分支名
  // （"X 请求将 N 次提交从 {head.label} 合并至 {base.label}"）。我们 v0.7.6
  // 改 PR header 格式时只用了 ref，导致显示成 ref id（"refs/pull/72/head"）
  // 而不是真实分支名（user 反馈 "缺少明确的分支记录"）。
  // GitHub API 端 label == ref；老 Gitea 端（< 1.20）没 label 字段 → 模板
  // 兜底用 ref 渲染。
  label?: string;
  sha: string;
}

export interface PullAuthorDto {
  username: string;
  fullName?: string;
  avatarUrl?: string;
}

/** PR 状态：open / closed / all（all 给前端"拉全量"用） */
export type PullState = 'open' | 'closed' | 'all';

export interface PullDto {
  index: number;
  title: string;
  state: PullState;
  draft: boolean;
  merged: boolean;
  head: PullRefDto;
  base: PullRefDto;
  author: PullAuthorDto;
  createdAt: string;
  updatedAt: string;
  mergeable: boolean;
  hasConflicts: boolean;
  linkedCards?: LinkedCardDto[];
  // ===== v1.1 补充字段（对齐 gitea PR 详情页属性块） =====
  labels?: Array<{ id: number; name: string; color: string }>;
  milestone?: { id: number; title: string } | null;
  assignee?: { username: string; avatarUrl?: string } | null;
  assignees?: Array<{ username: string; avatarUrl?: string }>;
  reviewers?: Array<{ username: string; avatarUrl?: string }>;
  mergedBy?: { username: string } | null;
  commentsCount?: number;
  body?: string;
  // v0.7.6：PR 头部分支显示 "请求将 N 次代码提交从 {head} 合并至 {base}" 用
  // Gitea / GitHub /pulls/{index} 返回的 commits 字段（0 兜底"1 次"）。
  commits?: number;
  // v0.7.6：用于 PR 头部分支链接（/src/branch/{ref}），ListPulls resp 不返回
  // repoFullName，前端用 projectId 反查 LocalState.repoPath 后拼。
  // 不存到 DTO 里（避免污染），用项目级 helper `branchWebUrl()` 处理。
  // v0.7.8：merge commit SHA —— Gitea 1.26+ timeline 端点 merge_pull event body
  // 是空字符串（不像 v0.7.4-v0.7.7 假设的 "merged commit {sha}" 文本），timeline
  // 渲染 merge 事件 inline 块需要的 SHA 从 PR 详情端点 `merge_commit_sha` 字段拿。
  // ListPulls 轻量接口不返这个字段，store.fetchPullDetail() 拉详情后浅 patch 进来。
  mergeCommitSha?: string;
  // v0.7.26：commits_behind —— 基础分支领先 head 分支的提交数。
  // Gitea 1.26+ /pulls/{index} 端点不返这个字段，必须调
  // GET /repos/{owner}/{repo}/compare/{head}...{base} 单独拿。
  // store.fetchPullDetail() 之后调 platform.GetPullCommitsBehind 拿值 + patchItem。
  // 用途：
  //   - merge warning 区过期警告 "此分支相比基础分支已过期"
  //   - "通过合并更新分支"按钮的 v-if 条件
  commitsBehind?: number;
}

export interface ListPullsArgs {
  projectId: string;
  state?: PullState;
  head?: string;
  base?: string;
  author?: string;
  page: number;
  limit: number;
}

export interface ListPullsResp {
  items: PullDto[];
  total: number;
  hasMore: boolean;
}

export interface GetPullArgs {
  projectId: string;
  index: number;
}

/** PR 合并方式（业务侧支持 4 种） */
export type MergeMethod = 'merge' | 'rebase' | 'rebase-merge' | 'squash';

export interface MergePrResult {
  /** 合并后的 commit SHA（gitea 合并成功时可能返回空 body，此时为空字符串） */
  sha: string;
  merged: boolean;
  message: string;
}

// ============================================================
// ===== issues 命名空间（ADR-0002 reset：卡片 = gitea issue）=====
// ============================================================

export interface IssueLabelDto {
  id: number;
  name: string;
  color: string;
  description?: string;
}

export interface IssueAuthorDto {
  username: string;
  fullName?: string;
  avatarUrl?: string;
}

export interface IssueCardDto {
  id: number;
  index: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  author: IssueAuthorDto;
  labels: IssueLabelDto[];
  /** true 当 gitea response 包含非空 pull_request（gitea 把 PR 也列在 /issues） */
  isPullRequest: boolean;
  /** gitea issue ref 字段（关联分支/Git 标签），无关联时为空串 */
  refBranch: string;
}

export interface ListIssuesResp {
  items: IssueCardDto[];
  hasMore: boolean;
}

export interface IssueCommentDto {
  id: number;
  body: string;
  author: IssueAuthorDto;
  createdAt: string;
  updatedAt: string;
  // v0.7.x: 评论类型 (Gitea CommentType 枚举值)
  //   0=COMMENT 普通评论 | 21=REVIEW 评审总结文 | 22=REVIEW 评审事件
  //   1=REOPEN | 2=CLOSE | 4=COMMIT_REF | 7=LABEL | 8=MILESTONE | 9=ASSIGNEE
  //   10=TITLE_CHANGE | 27=REVIEW_REQUEST | 28=MERGE | 29=PUSH 等
  // GitHub 后端所有评论 type=0 (普通评论, GitHub 不返回 system events)
  type: number;
}

// v0.7.x: TimelineItemDto — Gitea /timeline 端点返回的统一时间轴 DTO
export interface TimelineItemDto {
  id: number;
  type: string; // "comment" | "review" | "code" | "reopen" | "close" | "label" | ...
  body: string;
  author?: IssueAuthorDto;
  created: string;
  updated?: string;
  // type="review" 评审事件专属
  state?: string; // "approved" | "changes_requested" | "commented"
  commitId?: string;
  official?: boolean;
  // type="pull_request_push" 推送事件专属
  commitSha?: string;

  // ===== v0.7.2：系统事件 detail 字段 =====
  // 对齐 Gitea web templates/repo/issue/view_content/comments.tmpl 渲染的二级详情块。
  // 前端按 type 决定哪些字段参与渲染，不用的 type 字段保持 undefined。
  //
  //   type=7 (label):        label
  //   type=8 (milestone):    oldMilestone / milestone
  //   type=9 (assignees):    assignee + removedAssignee
  //   type=10 (change_title): oldTitle / newTitle
  //   type=11/25/33:         oldRef / newRef
  //   type=3/5/6/33:         refIssue + refAction
  //   type=4 (commit_ref):   refCommitSha
  //   type=19/20:            dependentIssue

  // type=10 标题变化
  oldTitle?: string;
  newTitle?: string;

  // type=11 (delete_branch) / 25 (change_target_branch) / 33 (change_issue_ref)
  oldRef?: string;
  newRef?: string;

  // type=7 (label) —— 单个 label
  label?: { id: number; name: string; color: string };

  // type=8 (milestone) —— 里程碑变化
  oldMilestone?: MilestoneDto;
  milestone?: MilestoneDto;

  // type=9 (assignees) —— 指派人变化
  assignee?: PullAuthorDto;
  removedAssignee?: boolean; // true=移除，false=添加

  // type=3/5/6/33 跨引用
  refIssue?: TimelineRefIssueDto;
  refAction?: string;     // "close" | "reopen" | "cross"
  refCommitSha?: string;  // type=4 commit ref

  // type=19/20 依赖
  dependentIssue?: TimelineRefIssueDto;

  // ===== v0.7.6：WIP toggle 标记 =====
  // 仅 type="change_title" 改标题事件可能命中。
  //
  // 对齐 Gitea web `modules/templates/util_render_comment.go: commentTimelineEventIsWipToggle`。
  // 当用户在 PR 详情页拖"标记为 WIP / 标记为可评审"按钮时，Gitea 端会改标题
  // 加/去掉 "WIP:" / "Draft:" 前缀，并触发一条 change_title 事件。
  // 后端检测到这种特殊改标题会设 isWipToggle=true，前端 systemEventVerb
  // 走 "已将合并请求标记为进行中" / "已将合并请求标记为可评审" 文案，
  // 而不是普通 "修改了标题" + 标题对比。
  isWipToggle?: boolean;
  isWip?: boolean; // isWipToggle=true 时才有意义：true=进入 WIP / false=退出 WIP

  // ===== v0.7.6：label 事件聚合字段 =====
  // Gitea /timeline 端点每个 label 变化返回 1 条独立 type="label" 事件。
  // 前端 timeline store 按"同作者 + 60s 内连续 label 事件"合并为 1 条
  // 带 addedLabels/removedLabels 数组的事件（对齐 Gitea web 行为）。
  //
  // labelAction 标记单条 label 事件的 add/remove 方向（仅前端合并前用）：
  //   "add" = content=="1" / "remove" = content!="1"
  addedLabels?: Array<{ id: number; name: string; color: string }>;
  removedLabels?: Array<{ id: number; name: string; color: string }>;
  labelAction?: 'add' | 'remove';

  // v0.7.6：label 事件合并标记 —— mergeLabelEvents() 把连续 label 事件合并后，
  // 被合并掉的事件设 merged=true，模板用 v-if="!item.merged" 跳过渲染
  // （避免重复显示 "添加了标签 bug" / "添加了标签 enhancement"）。
  merged?: boolean;

  // ===== v0.7.8：type=push (前 v0.7.7 叫 type=29) 事件专属字段 =====
  //
  // 根因（v0.7.7 → v0.7.8 重写）：v0.7.7 假设 Gitea /timeline 端点顶层会返
  // `old_commit_id / new_commit_id / commits_num / is_force_push` 4 个独立字段，
  // 实际 Gitea 1.26+ API 这 4 个字段**全部不返回**。真实数据在 body JSON 字符串里：
  //   `{"is_force_push":false,"commit_ids":["sha1","sha2"]}`
  // v0.7.7 凭印象写代码（没实测过 API），导致所有 push / merge 事件模板永远
  // 不渲染（type 字符串 "push" 跟实际 "pull_push" 也不匹配）。
  //
  // v0.7.8 重写：删 4 个无用字段（oldCommit / newCommit / commitsNum），加
  // `commitIds` 数组（直接拿 Gitea 端 commit_ids 渲染 commit 列表），保留
  // isForcePush 标志（从 body JSON 拿，**不是**顶层字段）。
  commitIds?: string[];
  isForcePush?: boolean;
  // type=merge (前 v0.7.7 叫 type=28) 事件：merge commit SHA。
  // Gitea 1.26+ timeline 端点 merge_pull event body 是空字符串，merge commit SHA
  // 只能从 PR 详情 `/pulls/{index}` 端点的 `merge_commit_sha` 字段拿（v0.7.8 修
  // giteaPullRaw 映射，PullDetailDTO.MergeCommitSha 字段 v0.7.7 已有但 raw 漏映射）。
  // timeline 渲染 merge 事件 inline 块时拿这个字段。PR 未合并时为空。
  mergeCommitSha?: string;
}

// v0.7.2：timeline 内 issue 引用（ref_issue / dependent_issue）
// 是 IssueCardDto 的子集，避免 timeline 渲染时去读不存在的字段。
export interface TimelineRefIssueDto {
  index: number;
  title: string;
  state: string;          // "open" | "closed"（gitea 还可能返回 "all" 但 timeline 不会）
  isPull: boolean;
  repoId?: number;
  repoFullName?: string;  // "owner/repo"，跨仓库引用时显示
}


// ============================================================
// ===== inline review comments 命名空间（v0.5.0 文件评论） =====
// ============================================================

/** PR 行内评论（挂在文件 diff 某一行上的评审评论） */
export interface PullReviewCommentDto {
  id: number;
  body: string;
  author: PullAuthorDto;
  path: string;       // 文件路径，如 src/auth/oauth.ts
  line: number;       // 行号
  createdAt: string;
  updatedAt?: string;
}

/** 行内评论的创建参数 */
export interface CreatePullReviewCommentArgs {
  projectId: string;
  index: number;
  body: string;
  path: string;
  line: number;
}

// ============================================================
// ===== review 命名空间（v0.5.0 M3） =====
// ============================================================

/** 评审状态：approved / changes_requested / commented */
export type ReviewState = 'approved' | 'changes_requested' | 'commented';

/** 评审操作事件：approve / request_changes / comment */
export type ReviewEvent = 'approve' | 'request_changes' | 'comment';

/** 合并请求评审 */
export interface PullReviewDto {
  id: number;
  state: ReviewState;
  body: string;
  author: PullAuthorDto;
  commitId?: string;
  submittedAt: string;
}

/** 创建评审参数 */
export interface CreateReviewArgs {
  projectId: string;
  index: number;
  commitId?: string;
  body?: string;
  event: ReviewEvent;
  comments?: ReviewCommentArg[]; // v0.6.0 行内评论
}

/** 创建评审时的单条行内评论（v0.6.0） */
export interface ReviewCommentArg {
  body: string;
  path: string;
  position: number;
}

// ============================================================
// ===== reactions 命名空间（v0.5.0 M2） =====
// ============================================================

/** 受支持的 8 种表情类型 */
export type ReactionContent = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'eyes' | 'rocket';

/** 单条表情反应 */
export interface ReactionDto {
  id: number;
  content: ReactionContent;
  user: IssueAuthorDto;
}

/** 按表情类型聚合的展示数据 */
export interface ReactionGroupDto {
  content: ReactionContent;
  emoji: string;
  label: string;
  count: number;
  usernames: string[];
  viewerReacted: boolean;
}

// ============================================================
// ===== labels 命名空间 =====
// ============================================================

export interface LabelDto {
  id: number;
  name: string;
  color: string;
  description?: string;
}

export interface ListLabelsResp {
  items: LabelDto[];
  hasMore: boolean;
}

// ============================================================
// ===== milestones 命名空间 =====
// ============================================================

export interface MilestoneDto {
  id: number;
  title: string;
  state: 'open' | 'closed' | 'all';
  description?: string;
}

export interface ListMilestonesResp {
  items: MilestoneDto[];
  hasMore: boolean;
}

// ============================================================
// ===== members 命名空间（仓库成员 = gitea repo collaborators）=====
// ============================================================

/** 仓库成员 DTO（schema.ts CollaboratorDto） */
export interface CollaboratorDto {
  username: string;
  avatarUrl?: string;
  /** gitea 用户真名（来自 /collaborators 返回的 User.full_name） */
  fullName?: string;
  /** gitea 权限字符串：'read' | 'write' | 'admin' | 'unknown'（字符串而非 enum） */
  permission: string;
}

/** members.list 出参：直接返 CollaboratorDto[] 数组（不包 {items, hasMore}） */
/** 列出仓库成员的响应
 *
 * 注：旧 schema.ts 定义为 CollaboratorDto[]，但前端 BoardView 等处当 {items} 用。
 * 迁移期统一为 {items, hasMore} 形态以兼容前端代码。 */
export interface ListMembersResp {
  items: CollaboratorDto[];
  hasMore: boolean;
}

/** 视图层成员类型：当前直接复用 CollaboratorDto，避免多一份镜像类型。 */
export type MemberDto = CollaboratorDto;

// ============================================================
// ===== gitgraph 命名空间（git graph 视图）=====
// ============================================================

/** refs 装饰（与 Gitea modules/git/ref.go RefName 对齐） */
export type GitRefRefGroup = 'heads' | 'tags' | 'remotes' | 'pull';

export interface GitRefDto {
  name: string;
  refGroup: GitRefRefGroup;
  shortName: string;
}

/** 单个 commit 的轻量 DTO（main 端按 gitgraph 协议返的形态） */
export interface GraphLineCommitDto {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  authorName: string;
  authorEmail: string;
  authorAvatar?: string;
  isMerge: boolean;
  parents: string[];
  refs: GitRefDto[];
}

/** 单行字符流（Gitea parser.go 输入格式） */
export interface GraphLineDto {
  row: number;
  glyph: string;
  commit: GraphLineCommitDto | null;
}

/** commits.gitgraph.lines 端点的完整返回 */
export interface GraphLinesDto {
  /** 是否处于"功能未启用"状态（true 时 lines 为空，前端显示占位） */
  disabled: boolean;
  /** 禁用原因文案（仅 disabled=true 时使用） */
  disabledReason?: string;
  /** 本地仓库绝对路径（disabled=true 时不返回） */
  localPath?: string;
  lines: GraphLineDto[];
  totalCommits: number;
  truncated: boolean;
  range: {
    from: string;
    to: string;
  };
}

// ===== v2 结构化 Graph（Go 后端 BuildGraph 输出，替代字形格式）=====

/** 图节点（一个 commit，含 lane 信息） */
export interface GraphNodeDto {
  row: number;
  lane: number;
  /** 节点所属 flow 的颜色号 0..15，由后端 lane 分配直接给出 */
  color: number;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
  isMerge: boolean;
  parents: string[];
  /**
   * 关联的 ref 名称列表（branch / tag 短名，已剥 refs/heads/、refs/remotes/<remote>/、refs/tags/ 前缀）
   * 远程跟踪分支保留 `<remote>/<branch>` 形式（如 `origin/main`）
   * 顺序固定：本地分支 → 远程跟踪分支 → tag（后端已排序）
   */
  refs?: string[];
  /**
   * 与 refs 一一对应的 ref 类型（v2.8 新增）
   * 'branch' | 'remoteBranch' | 'tag'，让前端严格区分 badge 颜色，不再用启发式猜
   */
  refTypes?: string[];
  /** HEAD 节点，vscode 风格渲染为空心圆 */
  isCurrent?: boolean;
  /** stash 节点，vscode 风格渲染为双圈 */
  isStash?: boolean;
  /**
   * 该节点是否「已提交」。
   * - true：常规 commit 节点（默认值，前端不传时按已提交渲染）
   * - false：UNCOMMITTED 虚拟节点（Go 端 LogCommits / LogCommitsVscode 在
   *          worktree dirty 时（v0.3.0 起；v0.3.0 之前是 local HEAD 落后
   *          origin/<defaultBranch>）unshift 的 SHA="*" 节点），
   *          dot stroke 走 #808080 灰色
   *
   * 对齐 vscode graph.ts Vertex.draw:269-273。
   */
  isCommitted?: boolean;
}

/** 边类型：0=normal(直线下行), 1=branch(分支), 2=merge(合并) */
export type GraphEdgeTypeDto = 0 | 1 | 2;

/** 图边（连线） */
export interface GraphEdgeDto {
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
  /** 颜色号 0..15，对齐 Gitea Color16() = ColorNumber % 16（v2.6 后端生成，前端不再 % N 自算） */
  color: number;
  type: GraphEdgeTypeDto;
}

export interface GraphBranchLineDto {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lockedFirst: boolean;
  /**
   * 该 line 是否属于「已提交」段。
   * - true：常规 lane 颜色（默认值）
   * - false：UNCOMMITTED 段，stroke 走 #808080 + stroke-dasharray: 2px 灰色虚线
   *
   * 对齐 vscode graph.ts:102 `line.isCommitted` 与 Branch.drawPath:152 stroke 切换。
   */
  isCommitted?: boolean;
}

export interface GraphBranchDto {
  color: number;
  end: number;
  lines: GraphBranchLineDto[];
}

/** 结构化 Graph 完整结果（Go BuildGraph 输出） */
export interface GraphResultDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  branches?: GraphBranchDto[];
  maxLane: number;
  truncated: boolean;
  /** 本地 commit 已全部取出，远端可能有更多（需 deepen） */
  localExhausted?: boolean;
  /** 后端已启动后台增量 deepen */
  deepenTriggered?: boolean;
}

export type GraphRefGroupDto = 'heads' | 'tags' | 'remotes' | 'pull';

export interface GraphLineRefDto {
  name: string;
  refGroup: GraphRefGroupDto;
  shortName: string;
}

export interface GraphLineCommitDto {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  authorName: string;
  authorEmail: string;
  isMerge: boolean;
  parents: string[];
  refs: GraphLineRefDto[];
}

export interface GraphLineDto {
  row: number;
  glyph: string;
  commit: GraphLineCommitDto | null;
}

/** ASCII Git Graph 完整结果（GitHub/gh 超大仓库 fallback 使用） */
export interface GraphLinesDto {
  lines: GraphLineDto[];
  totalCommits: number;
  truncated: boolean;
  range: { from: string; to: string };
}

// ============================================================
// ===== 文件评论命名空间（v0.5.0 M4） =====
// ============================================================

/** PR 修改文件的变更状态 */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** PR 提交列表项（对齐 Gitea /pulls/{index}/commits） */
export interface PullCommitDto {
  sha: string;
  shortSha: string;
  subject: string;
  body?: string;
  authorName: string;
  authorMail?: string;
  authoredAt: string;
  committed?: string;
  verified?: boolean;
}

/** PR 修改的文件项 */
export interface PullFileDto {
  filename: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string; // status=renamed 时
}

/** Diff Hunk（unified diff 中的一个 @@ 块） */
export interface PullDiffHunkDto {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string; // "@@ ... @@"
  lines: string[]; // 包含前缀: ' ' = 上下文, '+' = 新增, '-' = 删除
}

/** 单个文件的 diff 详情 */
export interface PullFileDiffDto {
  filename: string;
  rawDiff: string; // 完整 unified diff 文本
  hunks: PullDiffHunkDto[];
}

// ============================================================
// ===== Git Graph 命名空间 =====
// ============================================================

/** commits.gitgraph.pull 返回 */
export interface GitGraphPullResp {
  /** 拉取前本地 commit 数（origin/HEAD 的 commits 不算） */
  beforeCount: number;
  /** 拉取后本地 commit 数 */
  afterCount: number;
  /** 新增 commit 数 = afterCount - beforeCount（可能为 0 表示已最新） */
  addedCommits: number;
  /** git fetch / pull 的 stdout（用户可见，便于诊断冲突） */
  stdout: string;
}

// ============================================================
// ===== 自动更新命名空间（v0.8.0 引入）=====
// ============================================================

/**
 * 自动更新信息（CheckUpdate 返回）
 *
 * 对齐 Go 端 updater.UpdateInfo json tag（camelCase）。
 *
 * - available: 是否有可用更新
 * - current: 当前运行版本（如 "v0.8.0" 或 "dev"）
 * - latest: 最新版本
 * - notes: release notes markdown
 * - channel: 发布通道（v0.8.0 仅 "stable"）
 * - canSelfUpdate: 是否支持自动 in-place apply（macOS 未签名 build 返 false）
 * - manualOnly: 只能手动去 release 页下载
 * - manualReason: 手动下载的可读原因
 * - downloaded: 缓存里是否已有这个版本的安装包
 * - downloadUrl: 安装包 URL
 * - assetSize: 安装包大小（字节）
 * - err: 内部错误（前端拿来显示人话）
 */
export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  notes?: string;
  channel: string;
  canSelfUpdate: boolean;
  manualOnly?: boolean;
  manualReason?: string;
  downloaded: boolean;
  downloadUrl?: string;
  assetSize?: number;
  err?: string;
  devBuild?: boolean;
}

/**
 * 下载完成结果（DownloadUpdate 返回）
 */
export interface UpdateDownloadResult {
  version: string;
  channel: string;
  platform: string;
  path: string;
  size: number;
  sha256: string;
}

/**
 * 更新进度（updater:progress 事件 payload）
 *
 * phase: 'downloading' | 'verifying' | 'downloaded' | 'installing' | 'done' | 'error'
 */
export interface UpdateProgress {
  phase: string;
  received: number;
  total: number;
  err?: string;
}
