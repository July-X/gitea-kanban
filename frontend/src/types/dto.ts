/**
 * dto.ts —— 从旧 Electron schema.ts 提取的纯 TypeScript 类型定义
 *
 * 来源：legacy/electron/src/main/ipc/schema.ts（Zod schema + z.infer 派生类型）
 * 用途：Wails 前端（Go 后端）的 IPC DTO 类型契约。
 *       本文件只包含 type/interface，不含 Zod 运行时校验。
 *
 * 转换规则：
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
  description: string;
  defaultBranch: string;
  archived: boolean;
  private: boolean;
  updatedAt: string;
  permissions: Permissions;
  isProject: boolean;
  lastSyncAt?: string;
}

export interface RepoProjectDto {
  id: string;
  giteaAccountId: string;
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
// ===== board.columns 命名空间 =====
// ============================================================

/** 看板列绑的 gitea label 摘要（DTO 形态） */
export interface ColumnLabelDto {
  id: number;
  name: string;
  color: string;
}

/** WIP 上限：正整数 = 上限，null = 无限 */
export type WipLimit = number | null;

/** 看板列 DTO（DB row + 绑定的 gitea labels） */
export interface ColumnDto {
  id: string;
  projectId: string;
  title: string;
  position: number;
  labels: ColumnLabelDto[];
  wipLimit?: WipLimit;
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

/** 结构化 Graph 完整结果（Go BuildGraph 输出） */
export interface GraphResultDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  maxLane: number;
  truncated: boolean;
}

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
