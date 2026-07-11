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
  assignee?: { username: string } | null;
  assignees?: Array<{ username: string }>;
  reviewers?: Array<{ username: string }>;
  mergedBy?: { username: string } | null;
  commentsCount?: number;
  body?: string;
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
