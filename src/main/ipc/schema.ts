/**
 * IPC schema —— 所有 IPC endpoint 的 Zod schema 集中地
 *
 * 契约：02-architecture.md §5.3（10 个 namespace × 多 method）
 *       docs/adr/0001-keychain.md §"需更新的下游文件"（KEYCHAIN_* 错误码）
 *
 * 用法：
 *   import { ConnectArgsSchema, type ConnectArgs } from './schema.js';
 *   const args = ConnectArgsSchema.parse(raw);  // throws ZodError → wrap as VALIDATION_FAILED
 *
 * 提交历史：
 *   - M0 交付：auth 三个 endpoint
 *   - Plan 2 cycle 6：repos + branches 五个 endpoint
 *   - Plan 2 cycle 7：commits + pulls 八个 endpoint
 *   - Plan 2 cycle 8：board.columns.* 5 个 + board.cards.* 7 个 + commits.timeline 1 个
 *   - M3 reset（ADR-0002）：board.cards.* 删 7 个，加 issues.*9 + labels.*2
 *   - M5 补齐：user.* 4 个
 *   - a3（2026-06-12）：
 *     · ListIssuesArgsSchema 加 `assignee?: string`（a1 gitea 包装层已透传 assigned_by；IPC 层补齐契约）
 *     · PullStateSchema 加 'all'（前端 store 需要拉全量）
 *     · 新增 members namespace：CollaboratorDtoSchema + ListMembersArgsSchema + ListMembersRespSchema
 *       （出参为 `CollaboratorDto[]` 数组形态，不包 `{items, hasMore}` —— 见 schema 内注释）
 *   - theme-ipc（2026-06-12，v1.1.2 主题切换）：
 *     · 新增 preferences namespace：ThemeEnumSchema + ThemeGetArgsSchema + ThemeGetResultSchema
 *       + ThemeSetArgsSchema + ThemeSetResultSchema
 *     · 契约来源：design-system/pages/tech-refine.md §16.1-§16.3（user 拍板）
 *     · 复用 IpcErrorCode 新增 4 个常量（THEME_NOT_FOUND / INVALID_THEME / DATABASE_UNAVAILABLE / DATABASE_WRITE_FAILED）
 *     · 端点命名：channel 字面量 = 'preferences.theme.get' / 'preferences.theme.set'，走 preferences.* 而非 theme.* namespace
 */

import { z } from 'zod';
import { IpcChannel } from '../../shared/ipc-channels.js';

// IpcChannel 常量已抽到 src/shared/ipc-channels.ts（zod-free）——
// 主进程 / preload 共享同一份 channel 名常量，但 preload 端不能 import 自带
// zod 的本文件（sandboxed preload 不允许 runtime require external，AGENTS §8.10）。
// 此处 re-export 以保持所有 main 端现有 `import { IpcChannel } from '.../schema.js'` 调用点不变。
export { IpcChannel };
export type { IpcChannelName } from '../../shared/ipc-channels.js';

// ===== 通用基础类型 =====
export const UuidSchema = z.string().uuid();
export const NonEmptyStringSchema = z.string().min(1).max(1024);

/** ISO 时间戳（接受带时区偏移：gitea 实际返 +08:00 / -05:00 等，**不**仅 UTC 'Z'） */
export const IsoDateSchema = z.string().datetime({ offset: true });

/** gitea URL 校验：https?://host，**不**允许任意路径前缀
 *  （允许 path，因为自托管 gitea 多在子路径：https://example.com/gitea/）
 */
export const GiteaUrlSchema = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        const url = new URL(u);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'giteaUrl 必须是 http(s) URL' },
  );

/** PAT：长度 8+，去前后空格 */
export const TokenSchema = z
  .string()
  .min(8, 'token 长度至少 8')
  .max(512, 'token 长度不超过 512')
  .transform((s) => s.trim());

// ===== auth 命名空间 =====

/** auth.connect 入参 */
export const ConnectArgsSchema = z.object({
  giteaUrl: GiteaUrlSchema,
  token: TokenSchema,
});
export type ConnectArgs = z.infer<typeof ConnectArgsSchema>;

/** gitea /user 响应子集（02-architecture.md §5.3.9）
 *  —— .strict() 保证 token 等敏感字段不会意外穿透 */
export const UserDtoSchema = z
  .object({
    id: z.number().int().positive(),
    login: NonEmptyStringSchema,
    fullName: z.string().optional(),
    email: z.string().email().optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict();
export type UserDto = z.infer<typeof UserDtoSchema>;

/** gitea_accounts 行映射 —— .strict() 拒绝 token 等敏感字段 */
export const GiteaAccountDtoSchema = z
  .object({
    id: UuidSchema,
    giteaUrl: z.string(),
    username: NonEmptyStringSchema,
    createdAt: IsoDateSchema,
  })
  .strict();
export type GiteaAccountDto = z.infer<typeof GiteaAccountDtoSchema>;

/** auth.connect 出参 */
export const ConnectResultSchema = z
  .object({
    account: GiteaAccountDtoSchema,
    user: UserDtoSchema,
  })
  .strict();
export type ConnectResult = z.infer<typeof ConnectResultSchema>;

/** auth.disconnect 入参（按 giteaUrl 定位——一个 giteaUrl 只对应一个 account） */
export const DisconnectArgsSchema = z.object({
  giteaUrl: GiteaUrlSchema,
});
export type DisconnectArgs = z.infer<typeof DisconnectArgsSchema>;

/** auth.status 出参（**不**含 token） */
export const StatusResultSchema = z
  .object({
    accounts: z.array(GiteaAccountDtoSchema),
    currentUser: UserDtoSchema.nullable(),
  })
  .strict();
export type StatusResult = z.infer<typeof StatusResultSchema>;

// ============================================================
// ===== repos namespace（02-architecture.md §5.3.1）=====
// ============================================================

export const PermissionsSchema = z
  .object({
    pull: z.boolean(),
    push: z.boolean(),
    admin: z.boolean(),
  })
  .strict();
export type Permissions = z.infer<typeof PermissionsSchema>;

export const RepoDtoSchema = z
  .object({
    id: z.number().int().positive(),
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    fullName: NonEmptyStringSchema,
    description: z.string().default(''),
    defaultBranch: NonEmptyStringSchema,
    archived: z.boolean(),
    private: z.boolean(),
    updatedAt: IsoDateSchema,
    permissions: PermissionsSchema,
    isProject: z.boolean().default(false),
    lastSyncAt: IsoDateSchema.optional(),
  })
  .strict();
export type RepoDto = z.infer<typeof RepoDtoSchema>;

export const RepoProjectDtoSchema = z
  .object({
    id: NonEmptyStringSchema,
    giteaAccountId: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    defaultBranch: z.string().nullable(),
    lastSyncAt: IsoDateSchema.nullable(),
    createdAt: IsoDateSchema,
  })
  .strict();
export type RepoProjectDto = z.infer<typeof RepoProjectDtoSchema>;

export const ListReposArgsSchema = z
  .object({
    giteaAccountId: NonEmptyStringSchema,
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    page: z.number().int().min(1).default(1),
  })
  .strict();
export type ListReposArgs = z.infer<typeof ListReposArgsSchema>;

export const ListReposRespSchema = z
  .object({
    items: z.array(RepoDtoSchema),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    hasMore: z.boolean(),
  })
  .strict();
export type ListReposResp = z.infer<typeof ListReposRespSchema>;

export const AddProjectArgsSchema = z
  .object({
    giteaAccountId: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
  })
  .strict();
export type AddProjectArgs = z.infer<typeof AddProjectArgsSchema>;

export const RemoveProjectArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
  })
  .strict();
export type RemoveProjectArgs = z.infer<typeof RemoveProjectArgsSchema>;

// ============================================================
// ===== branches namespace（02-architecture.md §5.3.2）=====
// ============================================================

export const BranchLastCommitDtoSchema = z
  .object({
    sha: NonEmptyStringSchema,
    message: z.string(),
    author: z.string(),
    date: IsoDateSchema,
  })
  .strict();
export type BranchLastCommitDto = z.infer<typeof BranchLastCommitDtoSchema>;

export const BranchDtoSchema = z
  .object({
    name: NonEmptyStringSchema,
    sha: NonEmptyStringSchema,
    protected: z.boolean(),
    isDefault: z.boolean(),
    starred: z.boolean().default(false),
    lastCommit: BranchLastCommitDtoSchema.optional(),
  })
  .strict();
export type BranchDto = z.infer<typeof BranchDtoSchema>;

export const ListBranchesArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    page: z.number().int().min(1).default(1),
  })
  .strict();
export type ListBranchesArgs = z.infer<typeof ListBranchesArgsSchema>;

export const ListBranchesRespSchema = z
  .object({
    items: z.array(BranchDtoSchema),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  })
  .strict();
export type ListBranchesResp = z.infer<typeof ListBranchesRespSchema>;

export const RenameBranchArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    oldName: NonEmptyStringSchema,
    newName: NonEmptyStringSchema,
  })
  .strict();
export type RenameBranchArgs = z.infer<typeof RenameBranchArgsSchema>;

export const StarBranchArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    branch: NonEmptyStringSchema,
    starred: z.boolean(),
  })
  .strict();
export type StarBranchArgs = z.infer<typeof StarBranchArgsSchema>;

// ============================================================
// ===== commits namespace（02-architecture.md §5.3.3）=====
// ============================================================

/**
 * 卡片 ↔ git 引用关联条目（DTO 形态）
 *
 * 实际数据来源：card_links JOIN gitea_refs JOIN cards JOIN board_columns
 * 详见 docs/design/02-architecture.md §4.2 + §5.3.8
 *
 * v1 简化：当前 schema 还没建 cards / board_columns 的种子数据，
 * 所以本任务只写查询函数，运行时拿到空数组是预期行为。
 */
export const LinkedCardDtoSchema = z
  .object({
    cardId: NonEmptyStringSchema,
    columnName: NonEmptyStringSchema,
  })
  .strict();
export type LinkedCardDto = z.infer<typeof LinkedCardDtoSchema>;

/** 单 commit 的父 commit SHA 列表 + 单条 author/committer 形态 */
export const CommitAuthorDtoSchema = z
  .object({
    name: NonEmptyStringSchema,
    email: z.string().email().optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict();
export type CommitAuthorDto = z.infer<typeof CommitAuthorDtoSchema>;

export const CommitCommitterDtoSchema = z
  .object({
    name: NonEmptyStringSchema,
    email: z.string().email().optional(),
  })
  .strict();
export type CommitCommitterDto = z.infer<typeof CommitCommitterDtoSchema>;

/**
 * 单个文件变更（v1.1.3 · task #23）
 *
 * 数据来源：gitea `GET /repos/{owner}/{repo}/git/commits/{sha}` 默认返 `files[]`
 * —— 含 `filename / status / additions / deletions / changes / previous_filename / binary_file / patch`
 * （gitea-js 类型只暴露了 2 字段，本地 wrapper 用 RawCommitFile 强转拿到全字段，
 *  在 toCommitDto 阶段就地解析 patch → `functions`，patch 字符串**不**进 IPC 边界）
 *
 * `functions` 已在 main 端按文件去重（用户拍板 C：同文件多 hunk 合并为一个 chip 集合）
 */
export const CommitFileChangeDtoSchema = z
  .object({
    filename: z.string(),
    /** 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' —— gitea 原值 */
    status: z.string().optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    /** gitea 端 total changes（≠ additions+deletions，因 whitespace 等），按 gitea 原值存 */
    changes: z.number().int().min(0).optional(),
    /** 旧名（status=renamed 时才有） */
    previousFilename: z.string().optional(),
    /** 是否二进制 —— gitea 端 binary_file 字段 OR status='binary'（任一为真） */
    binary: z.boolean().optional(),
    /** hunk 头解析出的"改动函数/方法"列表（已按文件合并去重）；二进制文件不解析 */
    functions: z.array(z.string()).optional(),
  })
  .strict();
export type CommitFileChangeDto = z.infer<typeof CommitFileChangeDtoSchema>;

export const CommitDtoSchema = z
  .object({
    sha: NonEmptyStringSchema,
    shortSha: NonEmptyStringSchema,
    message: z.string(),
    author: CommitAuthorDtoSchema,
    committer: CommitCommitterDtoSchema,
    date: IsoDateSchema,
    parents: z.array(NonEmptyStringSchema),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    filesChanged: z.number().int().min(0).optional(),
    /** 单条 commit 详情才返（list 端点不返）—— v1.1.3 task #23 */
    files: z.array(CommitFileChangeDtoSchema).optional(),
    linkedCards: z.array(LinkedCardDtoSchema).optional(),
  })
  .strict();
export type CommitDto = z.infer<typeof CommitDtoSchema>;

export const ListCommitsArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    sha: z.string().optional(),
    path: z.string().optional(),
    author: z.string().optional(),
    since: IsoDateSchema.optional(),
    until: IsoDateSchema.optional(),
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListCommitsArgs = z.infer<typeof ListCommitsArgsSchema>;

export const ListCommitsRespSchema = z
  .object({
    items: z.array(CommitDtoSchema),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
    nextPage: z.number().int().min(1).nullable(),
  })
  .strict();
export type ListCommitsResp = z.infer<typeof ListCommitsRespSchema>;

export const GetCommitArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    sha: NonEmptyStringSchema,
  })
  .strict();
export type GetCommitArgs = z.infer<typeof GetCommitArgsSchema>;

// ============================================================
// ===== pulls namespace（02-architecture.md §5.3.5 + §5.3.6）=====
// ============================================================

export const PullRefDtoSchema = z
  .object({
    ref: NonEmptyStringSchema,
    sha: NonEmptyStringSchema,
  })
  .strict();
export type PullRefDto = z.infer<typeof PullRefDtoSchema>;

export const PullAuthorDtoSchema = z
  .object({
    username: NonEmptyStringSchema,
    avatarUrl: z.string().url().optional(),
  })
  .strict();
export type PullAuthorDto = z.infer<typeof PullAuthorDtoSchema>;

/**
 * PR 状态：
 * - open / closed：来自 gitea 字段
 * - merged：单独字段，gitea 也提供
 * - all：a3 拍板加，给前端"拉全量然后按 merged 二次过滤"的合并请求视图用
 *   （gitea 端 /pulls?state=closed 同时含 merged；想看"全部"必须显式 'all'，
 *    不传 = gitea 默认 'open' 行为）
 */
export const PullStateSchema = z.enum(['open', 'closed', 'all']);
export type PullState = z.infer<typeof PullStateSchema>;

export const PullDtoSchema = z
  .object({
    index: z.number().int().positive(),
    title: NonEmptyStringSchema,
    state: PullStateSchema,
    draft: z.boolean(),
    merged: z.boolean(),
    head: PullRefDtoSchema,
    base: PullRefDtoSchema,
    author: PullAuthorDtoSchema,
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    mergeable: z.boolean(),
    hasConflicts: z.boolean(),
    linkedCards: z.array(LinkedCardDtoSchema).optional(),
    // ===== v1.1 补充字段（对齐 gitea PR 详情页属性块） =====
    labels: z.array(z.object({ id: z.number(), name: z.string(), color: z.string() })).optional(),
    milestone: z.object({ id: z.number(), title: z.string() }).nullable().optional(),
    assignee: z.object({ username: z.string() }).nullable().optional(),
    assignees: z.array(z.object({ username: z.string() })).optional(),
    reviewers: z.array(z.object({ username: z.string() })).optional(),
    mergedBy: z.object({ username: z.string() }).nullable().optional(),
    commentsCount: z.number().int().optional(),
    body: z.string().optional(),
  })
  .strict();
export type PullDto = z.infer<typeof PullDtoSchema>;

export const ListPullsArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    state: PullStateSchema.optional(),
    head: z.string().optional(),
    base: z.string().optional(),
    author: z.string().optional(),
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListPullsArgs = z.infer<typeof ListPullsArgsSchema>;

export const ListPullsRespSchema = z
  .object({
    items: z.array(PullDtoSchema),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  })
  .strict();
export type ListPullsResp = z.infer<typeof ListPullsRespSchema>;

export const GetPullArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    index: z.number().int().positive(),
  })
  .strict();
export type GetPullArgs = z.infer<typeof GetPullArgsSchema>;

/**
 * PR 合并方式（02-architecture.md §5.3.6 + gitea 1.26 swagger）
 *
 * gitea `Do` 字段实际枚举（gitea-js 1.23.0 派生自 swagger）：
 *   'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'fast-forward-only' | 'manually-merged'
 *   —— gitea swagger 本身**没有** 'squash-merge' 这个字面量；UI 上"压缩 + 保留合并提交" 走 'rebase-merge' 的不同变体或 'squash' + 后处理
 *
 * 业务侧支持 4 种（前端暴露 4 个选项，'fast-forward-only' / 'manually-merged' 暂不开放给用户）：
 *   - 'merge'        → "普通合并（保留所有提交历史）"
 *   - 'rebase'       → "变基后快进（重写历史，单一线性）"
 *   - 'rebase-merge' → "变基后 merge commit（重写历史 + 保留 merge commit）"
 *   - 'squash'       → "压缩为单提交（合并请求内 N 个提交合成 1 个）"
 */
export const MergeMethodSchema = z.enum([
  'merge',
  'rebase',
  'rebase-merge',
  'squash',
]).describe(
  [
    'merge        → "普通合并（保留所有提交历史）"',
    'rebase       → "变基后快进（重写历史，单一线性）"',
    'rebase-merge → "变基后 merge commit（重写历史 + 保留 merge commit）"',
    'squash       → "压缩为单提交（合并请求内 N 个提交合成 1 个）"',
  ].join('\n'),
);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

export const MergePrArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    index: z.number().int().positive(),
    method: MergeMethodSchema,
    deleteBranchAfter: z.boolean().optional(),
    commitMessage: z.string().optional(),
  })
  .strict()
  .refine(
    (a) => {
      if (a.method === 'squash') {
        return typeof a.commitMessage === 'string' && a.commitMessage.length > 0;
      }
      return true;
    },
    {
      message: 'method=squash 时 commitMessage 必填',
      path: ['commitMessage'],
    },
  );
export type MergePrArgs = z.infer<typeof MergePrArgsSchema>;

export const MergePrResultSchema = z
  .object({
    /** 合并后的 commit SHA（gitea 合并成功时可能返回空 body，此时为空字符串） */
    sha: z.string(),
    merged: z.boolean(),
    message: z.string(),
  })
  .strict();
export type MergePrResult = z.infer<typeof MergePrResultSchema>;

/** 关闭合并请求（不合并，直接关闭）—— 对应 gitea PATCH /pulls/{index} {state: 'closed'} */
export const ClosePrArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    index: z.number().int().positive(),
    /** 关闭原因（可选，传给 gitea 的 comment body） */
    reason: z.string().optional(),
  })
  .strict();
export type ClosePrArgs = z.infer<typeof ClosePrArgsSchema>;

/** 更新合并请求标签 —— 对应 gitea PUT /issues/{index}/labels */
export const UpdatePullLabelsArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    index: z.number().int().positive(),
    labels: z.array(z.string()),
  })
  .strict();
export type UpdatePullLabelsArgs = z.infer<typeof UpdatePullLabelsArgsSchema>;

/** 更新合并请求指派人 —— 对应 gitea PATCH /issues/{index} {assignee} */
export const UpdatePullAssigneeArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    index: z.number().int().positive(),
    assignee: z.string(),
  })
  .strict();
export type UpdatePullAssigneeArgs = z.infer<typeof UpdatePullAssigneeArgsSchema>;

/** 更新合并请求评审人 —— 对应 gitea POST /pulls/{index}/requested_reviewers */
export const UpdatePullReviewersArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    index: z.number().int().positive(),
    reviewers: z.array(z.string()),
  })
  .strict();
export type UpdatePullReviewersArgs = z.infer<typeof UpdatePullReviewersArgsSchema>;

// ============================================================
// ===== board.columns namespace（ADR-0002 +02-architecture §5.3.7）=====
// ============================================================

/**看板列绑的 gitea label摘要（DTO形态） */
export const ColumnLabelDtoSchema = z
 .object({
 id: z.number().int().positive(), // gitea label id
 name: NonEmptyStringSchema,
 color: z.string(),
 })
 .strict();
export type ColumnLabelDto = z.infer<typeof ColumnLabelDtoSchema>;

/** 看板列 WIP（Work-In-Progress）上限
 *
 * 语义（plan_25cc4562 · Task B · 看板 WIP 上限）：
 * - 正整数 = 列里允许的最大 issue 数
 * - null    = 无限（**不**是 0；0 是非法值 —— 一张都不能放无业务意义）
 *
 * 业务规则：仅提示不拦截（v1.3）
 * - 超限**允许**继续加卡片 / 拖入
 * - 列头变红 + 提示气泡 "超出建议 N 张" 提醒用户
 * - 二次确认拦截**不**触发（避免和 A 的 drag + confirmFinish 路径纠缠）
 */
export const WipLimitSchema = z
  .union([z.number().int().positive(), z.null()])
  .describe('WIP 上限：正整数 = 上限，null = 无限');
export type WipLimit = z.infer<typeof WipLimitSchema>;

/**看板列 DTO（DB row +绑定的 gitea labels） */
export const ColumnDtoSchema = z
  .object({
  id: NonEmptyStringSchema,
  projectId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  position: z.number().int().min(0),
  labels: z.array(ColumnLabelDtoSchema),
  wipLimit: WipLimitSchema.optional(),
  })
  .strict();
export type ColumnDto = z.infer<typeof ColumnDtoSchema>;

export const ListBoardColumnsArgsSchema = z
  .object({
  projectId: NonEmptyStringSchema,
  })
  .strict();
export type ListBoardColumnsArgs = z.infer<typeof ListBoardColumnsArgsSchema>;

export const CreateBoardColumnArgsSchema = z
  .object({
  projectId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  position: z.number().int().min(0),
  })
  .strict();
export type CreateBoardColumnArgs = z.infer<typeof CreateBoardColumnArgsSchema>;

export const UpdateBoardColumnArgsSchema = z
  .object({
  columnId: NonEmptyStringSchema,
  patch: z
  .object({
  title: NonEmptyStringSchema.optional(),
  position: z.number().int().min(0).optional(),
  wipLimit: WipLimitSchema.optional(),
  })
  .strict()
  .refine(
  (p) => p.title !== undefined || p.position !== undefined || p.wipLimit !== undefined,
  {
  message: 'patch 必须至少含一个字段',
  },
  ),
  })
  .strict();
export type UpdateBoardColumnArgs = z.infer<typeof UpdateBoardColumnArgsSchema>;

export const ReorderBoardColumnsArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 orderedIds: z.array(NonEmptyStringSchema).min(1),
 })
 .strict();
export type ReorderBoardColumnsArgs = z.infer<typeof ReorderBoardColumnsArgsSchema>;

export const DeleteBoardColumnArgsSchema = z
 .object({
 columnId: NonEmptyStringSchema,
 })
 .strict();
export type DeleteBoardColumnArgs = z.infer<typeof DeleteBoardColumnArgsSchema>;

/**
 * board.columns.reset 入参（v1.4 增量 · 拍板 2026-06-16 user 拍板"重建视图"按钮）
 *   - 重置 project 的所有列 + 列绑 label 映射
 *   - 触发后 store.columns = []，调用方应立刻再 loadBoard 走 autoInit 重建
 *   - 设计原因：user 在前端"重建视图"按钮触发（详见 P0-1 wireframe 场景 4）
 */
export const ResetBoardColumnsArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
  })
  .strict();
export type ResetBoardColumnsArgs = z.infer<typeof ResetBoardColumnsArgsSchema>;

/**
 * board.columns.reset 出参
 *   - resetCount: 删了多少列（labelMaps 随列一起删，不单独计）
 *   - 实现：handler 走 localStore 删列 + labelMaps；renderer 端 loadBoard 自动触发 autoInit
 */
export const ResetBoardColumnsResultSchema = z.object({
  resetCount: z.number().int().min(0),
});
export type ResetBoardColumnsResult = z.infer<typeof ResetBoardColumnsResultSchema>;

export const MapColumnLabelArgsSchema = z
 .object({
 columnId: NonEmptyStringSchema,
 giteaLabelId: z.number().int().positive(),
 giteaLabelName: NonEmptyStringSchema,
 })
 .strict();
export type MapColumnLabelArgs = z.infer<typeof MapColumnLabelArgsSchema>;

export const UnmapColumnLabelArgsSchema = z
 .object({
 columnId: NonEmptyStringSchema,
 giteaLabelId: z.number().int().positive(),
 })
 .strict();
export type UnmapColumnLabelArgs = z.infer<typeof UnmapColumnLabelArgsSchema>;

// ============================================================
// ===== issues namespace（ADR-0002 reset：卡片 = gitea issue）=====
// ============================================================

export const IssueStateSchema = z.enum(['open', 'closed', 'all']);
export type IssueState = z.infer<typeof IssueStateSchema>;

export const IssueLabelDtoSchema = z
 .object({
 id: z.number().int().positive(),
 name: NonEmptyStringSchema,
 color: z.string(),
 description: z.string().optional(),
 })
 .strict();
export type IssueLabelDto = z.infer<typeof IssueLabelDtoSchema>;

export const IssueAuthorDtoSchema = z
 .object({
 username: NonEmptyStringSchema,
 fullName: z.string().optional(),
 avatarUrl: z.string().url().optional(),
 })
 .strict();
export type IssueAuthorDto = z.infer<typeof IssueAuthorDtoSchema>;

export const IssueCardDtoSchema = z
 .object({
 id: z.number().int().positive(),
 index: z.number().int().positive(),
 title: NonEmptyStringSchema,
 body: z.string(),
 state: z.enum(['open', 'closed']),
 createdAt: IsoDateSchema,
 updatedAt: IsoDateSchema,
 author: IssueAuthorDtoSchema,
 labels: z.array(IssueLabelDtoSchema),
 /**
 * true 当 gitea response包含非空 pull_request（gitea 把 PR 也列在 /issues）；
 *看板拖拽换列时只对纯 issue生效。
 */
 isPullRequest: z.boolean(),
 })
 .strict();
export type IssueCardDto = z.infer<typeof IssueCardDtoSchema>;

export const ListIssuesArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 columnId: NonEmptyStringSchema.optional(),
 state: IssueStateSchema.optional(),
 labelIds: z.array(z.number().int().positive()).optional(),
 q: z.string().optional(),
 /**
  * gitea username 字符串（**不**是 userId）—— "我的卡片"视图用。
  * 透传到 gitea `/issues?assigned_by=<username>`。
  * 不传 = 走原行为（不过滤 assignee，向后兼容）。
  *
  * a3 拍板：gitea 端不识别 'me' magic string，业务层（IPC handler / store）
  * 拿到 'me' 后必须先 resolve 成当前连接 username 再传进来。
  */
 assignee: z.string().min(1).optional(),
 page: z.number().int().min(1).default(1),
 limit: z.number().int().min(1).max(100).default(50),
 })
 .strict();
export type ListIssuesArgs = z.infer<typeof ListIssuesArgsSchema>;

export const ListIssuesRespSchema = z
 .object({
 items: z.array(IssueCardDtoSchema),
 hasMore: z.boolean(),
 })
 .strict();
export type ListIssuesResp = z.infer<typeof ListIssuesRespSchema>;

export const GetIssueArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 issueIndex: z.number().int().positive(),
 })
 .strict();
export type GetIssueArgs = z.infer<typeof GetIssueArgsSchema>;

export const CreateIssueArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 title: NonEmptyStringSchema,
 body: z.string().optional(),
 labelIds: z.array(z.number().int().positive()).optional(),
 })
 .strict();
export type CreateIssueArgs = z.infer<typeof CreateIssueArgsSchema>;

export const UpdateIssueArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 issueIndex: z.number().int().positive(),
 patch: z
 .object({
 title: NonEmptyStringSchema.optional(),
 body: z.string().optional(),
 state: z.enum(['open', 'closed']).optional(),
 })
 .strict()
 .refine(
 (p) => p.title !== undefined || p.body !== undefined || p.state !== undefined,
 { message: 'patch 必须至少含一个字段' },
 ),
 })
 .strict();
export type UpdateIssueArgs = z.infer<typeof UpdateIssueArgsSchema>;

export const IssueLabelActionArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 issueIndex: z.number().int().positive(),
 labelId: z.number().int().positive(),
 })
 .strict();
export type IssueLabelActionArgs = z.infer<typeof IssueLabelActionArgsSchema>;

/**
 *看板拖拽换列专用端点（move-card）：原子地换绑 label
 *
 * fromColumnId + toColumnId 都必填；后端把 issue 的 fromColumn labels 全 remove、toColumn labels 全 add
 * 后端会在事务里校验 fromColumn绑的 labels是不是 issue 当前真有的（防漂移）
 */
export const MoveIssueColumnArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 issueIndex: z.number().int().positive(),
 fromColumnId: NonEmptyStringSchema,
 toColumnId: NonEmptyStringSchema,
 })
 .strict()
 .refine((a) => a.fromColumnId !== a.toColumnId, {
 message: 'fromColumnId 与 toColumnId 不能相同',
 });
export type MoveIssueColumnArgs = z.infer<typeof MoveIssueColumnArgsSchema>;

export const IssueCommentDtoSchema = z
 .object({
 id: z.number().int().positive(),
 body: z.string(),
 author: IssueAuthorDtoSchema,
 createdAt: IsoDateSchema,
 updatedAt: IsoDateSchema,
 })
 .strict();
export type IssueCommentDto = z.infer<typeof IssueCommentDtoSchema>;

export const ListIssueCommentsArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 issueIndex: z.number().int().positive(),
 })
 .strict();
export type ListIssueCommentsArgs = z.infer<typeof ListIssueCommentsArgsSchema>;

export const CreateIssueCommentArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 issueIndex: z.number().int().positive(),
 body: NonEmptyStringSchema,
 })
 .strict();
export type CreateIssueCommentArgs = z.infer<typeof CreateIssueCommentArgsSchema>;

// ============================================================
// ===== labels namespace（ADR-0002：看板列绑 gitea label 用）=====
// ============================================================

export const LabelDtoSchema = z
 .object({
 id: z.number().int().positive(),
 name: NonEmptyStringSchema,
 color: z.string(),
 description: z.string().optional(),
 })
 .strict();
export type LabelDto = z.infer<typeof LabelDtoSchema>;

export const ListLabelsArgsSchema = z
 .object({
 projectId: NonEmptyStringSchema,
 page: z.number().int().min(1).default(1),
 limit: z.number().int().min(1).max(100).default(50),
 })
 .strict();
export type ListLabelsArgs = z.infer<typeof ListLabelsArgsSchema>;

export const ListLabelsRespSchema = z
 .object({
 items: z.array(LabelDtoSchema),
 hasMore: z.boolean(),
 })
 .strict();
export type ListLabelsResp = z.infer<typeof ListLabelsRespSchema>;

export const CreateLabelArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    color: z.string(),
    description: z.string().optional(),
  })
  .strict();
export type CreateLabelArgs = z.infer<typeof CreateLabelArgsSchema>;

// ============================================================
// ===== members namespace（a3 新增：仓库成员 = gitea repo collaborators）=====
// ============================================================

/**
 * 仓库成员 DTO —— 字段来源：
 * - username / avatarUrl ← gitea-js User（来自 /repos/{owner}/{repo}/collaborators）
 * - permission           ← gitea RepoCollaboratorPermission（来自 per-user /permission 端点）
 *                          实际值：'read' | 'write' | 'admin'（gitea 1.26 swagger）；
 *                          旧版本可能 'pull' | 'push' | 'owner'（v1 简化不区分，前端按 string 渲染）
 *                          'unknown' = 取权限失败（per-user 端点 403 / 404 / 5xx 降级）
 *
 * 出参设计：直接返 `CollaboratorDto[]`（**不**包 `{items, hasMore}` 包装）
 * 理由（a3 拍板）：
 *   1. 成员量 v1 < 100，包成 items+hasMore 反而给前端"分页错觉"；
 *   2. frontend `useMemberStore.list` 已写 `as MemberDto[]`，保持对齐；
 *   3. gitea /collaborators 端点本身**不**分页（N+1 简化见 src/main/gitea/repos.ts:152）。
 */
export const CollaboratorDtoSchema = z
  .object({
    username: NonEmptyStringSchema,
    avatarUrl: z.string().url().optional(),
    /**
     * gitea 用户真名（来自 /repos/{owner}/{repo}/collaborators 返回的 User.full_name）。
     *
     * A-3 P3 · W7 修法（2026-06-14）：非破坏性新增 optional 字段——
     * 旧客户端忽略 fullName 不受影响；新客户端用 fullName 做"按姓名搜索"。
     * 旧版 gitea 实例 full_name 可能为空字符串 → main 端过滤掉，不下发。
     */
    fullName: z.string().min(1).optional(),
    /**
     * gitea 权限字符串：'read' | 'write' | 'admin' | 'unknown'。
     * 字符串而不是 enum：gitea 历史版本字段值漂移，v1 简化不锁死。
     */
    permission: z.string(),
  })
  .strict();
export type CollaboratorDto = z.infer<typeof CollaboratorDtoSchema>;

/**
 * members.list 入参
 *
 * v1 简化：只接 projectId。gitea 端 collaborators list 本身**不**支持 query / sort
 * （gitea 1.26 swagger 验证），二次过滤（按权限 / 名称）放 store 层前端做。
 */
export const ListMembersArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
  })
  .strict();
export type ListMembersArgs = z.infer<typeof ListMembersArgsSchema>;

/**
 * members.list 出参
 *
 * 直接返 `CollaboratorDto[]` 数组（不包 `{items, hasMore}`，见上）。
 * 跟 labels/issues/pulls 等"包装对象"出参不一致 —— 这是 a3 拍板的有意偏离
 * （理由同上）；**不**走 §7.1 拍板（属于"端点形态细节"非契约变更）。
 */
export const ListMembersRespSchema = z.array(CollaboratorDtoSchema);
export type ListMembersResp = z.infer<typeof ListMembersRespSchema>;

// ============================================================
// ===== user namespace（02-architecture.md §5.3.9；M5补齐）=====
// ============================================================

/**
 * user.prefs.get 入参
 *
 * keys 限制 1-64 个；空数组 / 超限都拒（防止 caller 误用 "全表"）。
 *
 * 注：M5 阶段 v1 简化——userId 在 main 端硬编码 'local-user'（LOCAL_USER_ID）
 * （M0 单 userId 简化：未连 gitea 时 prefs 仍可读写到 local-user 命名空间）。
 *
 * **M6 拍板保留**：prefs 跟 app user 走（设备级），**不**按 gitea account 切分
 * 拍板记录：notes/m6-prefs-schema-decision.md（方案 A）
 */
export const UserPrefsGetArgsSchema = z
  .object({
    keys: z.array(z.string().min(1)).min(1).max(64),
  })
  .strict();
export type UserPrefsGetArgs = z.infer<typeof UserPrefsGetArgsSchema>;

/**
 * user.prefs.get 出参
 *
 * 只返 caller 问的 keys（缺一个就给 caller 一个 key 不在；不像 memcached 静默返空）。
 */
export const UserPrefsGetResultSchema = z.record(z.string(), z.unknown());
export type UserPrefsGetResult = z.infer<typeof UserPrefsGetResultSchema>;

/**
 * user.prefs.set 入参
 *
 * entries 是 Record<string, unknown>——UI 层把任何 JSON-序列化对象存这里（主题色 / 字号 / 看板布局 等）。
 * value 在 db 里 JSON.stringify；读时 JSON.parse。
 */
export const UserPrefsSetArgsSchema = z
  .object({
    entries: z.record(z.string(), z.unknown()),
  })
  .strict();
export type UserPrefsSetArgs = z.infer<typeof UserPrefsSetArgsSchema>;

/**
 * user.undo / user.redo 入参（M6 落地：按 projectId 弹栈）
 *
 * - projectId 可选；提供时**只**弹该 project 的栈（防跨看板误撤销）
 * - 未提供时：返 restored=0（**不**弹任意栈——安全默认；上层必须传）
 * - 拍板：notes/m6-undo-redo-deliverable.md §4
 */
export const UserUndoArgsSchema = z
  .object({
    projectId: z.string().min(1).optional(),
  })
  .strict();
export type UserUndoArgs = z.infer<typeof UserUndoArgsSchema>;

/** user.redo 入参与 undo 同形 */
export const UserRedoArgsSchema = UserUndoArgsSchema;
export type UserRedoArgs = z.infer<typeof UserRedoArgsSchema>;

/**
 * user.undo / user.redo 出参（M6 落地：操作后栈深度回传）
 *
 * 字段：
 * - restored  : 实际恢复了多少个 state（0 或 1）
 * - op        : 操作的 op 类型（restored=1 时有；restored=0 时缺省）
 * - undoSize  : **操作后** undo 栈深度（UI 灰化按钮用，免一次 roundtrip）
 * - redoSize  : **操作后** redo 栈深度（同上）
 */
export const UserUndoResultSchema = z
  .object({
    restored: z.number().int().min(0).max(1),
    op: z.string().min(1).optional(),
    undoSize: z.number().int().min(0),
    redoSize: z.number().int().min(0),
  })
  .strict();
export type UserUndoResult = z.infer<typeof UserUndoResultSchema>;

/** user.undo / user.redo 共用出参 */
export const UserRedoResultSchema = UserUndoResultSchema;
export type UserRedoResult = z.infer<typeof UserRedoResultSchema>;

/**
 * user.undoStatus 入参 / 出参 —— 栈深度查询（UI 灰化按钮用）
 *
 * 设计：独立端点而非塞进 undo/redo 返参里——mount / 切 project / 拖拽后都要拉一次
 */
export const UserUndoStatusArgsSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();
export type UserUndoStatusArgs = z.infer<typeof UserUndoStatusArgsSchema>;

export const UserUndoStatusResultSchema = z
  .object({
    undoSize: z.number().int().min(0),
    redoSize: z.number().int().min(0),
  })
  .strict();
export type UserUndoStatusResult = z.infer<typeof UserUndoStatusResultSchema>;

// ============================================================
// ===== preferences namespace（v1.1.2 主题切换 —— tech-refine.md §16）=====
// ============================================================

/**
 * 主题枚举（2 选 1）
 *
 * 设计来源：design-system/pages/tech-refine.md §14.1（v1.2 拍板）
 * - 'dark'： 暗色 · 中性近黑（#0F1115 canvas）—— **默认**（v1.1.2 C 暗基底）
 * - 'light'： 浅色 · 浅苍蓝（#E8F1F5 canvas）—— 主色用 #466B16 加深版过 WCAG AA 4.5:1
 *
 * v1.2 收敛（2026-06-13）：
 *   - v1.1.2 的 'A-dark'（苍蓝提饱和）'C-dark'（中性近黑）视觉差异仅在冷暖，
 *     非技术用户分不清、且 3 主题对非技术用户产生认知负担。
 *   - A 暗 / C 暗合并为统一的 'dark'（沿用 C 暗中性近黑基底）。
 *   - 主色 token 提亮到 #74B830（dark）/ 压暗到 #466B16（light），过 AA 4.5:1。
 *
 * 复用：ThemeGetArgsSchema / ThemeSetArgsSchema 共享此 enum；
 * ThemeGetResultSchema.theme / ThemeSetResultSchema.theme 也用此 enum。
 */
export const ThemeEnumSchema = z.enum(['dark', 'light']);
export type ThemeName = z.infer<typeof ThemeEnumSchema>;

/** 默认主题：'dark' —— v1.2 拍板（tech-refine.md §14.1 + §15.3） */
export const DEFAULT_THEME: ThemeName = 'dark';

/**
 * preferences.theme.get 入参 —— 无参
 *
 * 严格用 `Record<string, never>` 而非 `z.object({})`：
 * - `z.object({})` 实际接受任意 object（含任意 key）—— 兼容性过头
 * - `Record<string, never>` 强制 caller 传 `{}`（TS 类型层面 + 运行时都校验）
 *   —— Zod 文档推荐做法（https://zod.dev/?id=records）
 */
export const ThemeGetArgsSchema = z.object({}).strict();
export type ThemeGetArgs = z.infer<typeof ThemeGetArgsSchema>;

/**
 * preferences.theme.get 出参
 *
 * changedAt：
 * - 已设过（row 存在）→ 返 row.updatedAt 的 ISO 字符串
 * - 未设过（首次启动）→ 返 new Date().toISOString()（synthetic；用于 analytics / 调试一致）
 *
 * 注：ZodIsoDateSchema 要求 `z.string().datetime({ offset: true })`；
 * sqlite prefs.updatedAt 是 Date 对象，Drizzle `{ mode: 'timestamp' }` 转回 Date；
 * 我们用 `.toISOString()`（'Z' UTC 后缀）—— schema 接受 ✓
 */
export const ThemeGetResultSchema = z
  .object({
    theme: ThemeEnumSchema,
    changedAt: IsoDateSchema,
  })
  .strict();
export type ThemeGetResult = z.infer<typeof ThemeGetResultSchema>;

/**
 * preferences.theme.set 入参
 *
 * 必填 theme 字段（3 选 1，Zod enum 严格校验）
 *
 * 错误处理：
 * - VALIDATION_FAILED：theme 不在 enum 3 选 1（Zod 在 wrapIpc 入口先 reject）
 * - INTERNAL：localStore.mutate 写盘失败（rare；原子写 + 重试退避）
 */
export const ThemeSetArgsSchema = z
  .object({
    theme: ThemeEnumSchema,
  })
  .strict();
export type ThemeSetArgs = z.infer<typeof ThemeSetArgsSchema>;

/**
 * preferences.theme.set 出参
 *
 * 跟 get 一样：返 { theme, changedAt }；changedAt 是本次 set 的时间（不是之前的 updatedAt）
 */
export const ThemeSetResultSchema = z
  .object({
    theme: ThemeEnumSchema,
    changedAt: IsoDateSchema,
  })
  .strict();
export type ThemeSetResult = z.infer<typeof ThemeSetResultSchema>;

// ============================================================
// ===== preferences.clipboard.write（v1.1.3 提交号 / 分支名复制）=====
// ============================================================
//
// 走主进程 electron.clipboard.writeText 而非 renderer 端 navigator.clipboard.writeText：
// 1) renderer 端 navigator.clipboard 在 Electron webContents 窗口未 focus / 非用户激活时
//    promise reject（v1.1.2 主题切换已踩过 → 改成主进程最稳）
// 2) 主进程 clipboard 模块是系统级 API，与 webview focus 解耦，永远可靠
// 3) 不暴露 clipboard.read / .clear —— v1 单向写即可
//
// 入参 text：必填、长度 [1, 8192]、UTF-8 任意字符（分支名 / sha / commit message 都包得住）
// 出参 { ok: true }：无业务错误；写失败由 main 端 wrapIpc 兜底成 INTERNAL

export const ClipboardWriteArgsSchema = z
  .object({
    text: z.string().min(1).max(8192),
  })
  .strict();
export type ClipboardWriteArgs = z.infer<typeof ClipboardWriteArgsSchema>;

export const ClipboardWriteResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type ClipboardWriteResult = z.infer<typeof ClipboardWriteResultSchema>;

// ============================================================
// ===== board.cards namespace（ADR-0002 reset：删除）=====
// ============================================================
// 注：M2拍板的 board.cards.*7 个端点（list/create/update/move/delete/link/unlink）
// 在 M3 ADR-0002 reset 中**全部删除**。卡片 = gitea issue：
// - list → issues.list({ columnId })
// - create → issues.create({ labelIds: [columnBoundLabelId] })
// - update → issues.update
// - move → move-card端点（issues + 列绑 label 操作）
// - delete → issues.update({ state: 'closed' }) 或 issues 删除（gitea 无 DELETE issue API；v1改 state）
// - link / unlink → gitea labels关联（addLabel / removeLabel）
//
// 历史：M2 schema 的 CardDto/CardLinkDto保留**未导出**，但 board.cards.*端点本身已删。

// ============================================================
// ===== commits.timeline（02-architecture.md §5.3.4）=====
// ============================================================

/**
 * lane 排序方式（02-architecture.md §5.3.4 Lane.kind）
 * - branch: 每条 branch 一条泳道（默认主分支 main 在最上）
 * - author: 每个 author 一条泳道
 * - pr:     每个 PR 一条泳道
 */
export const LaneModeSchema = z.enum(['branch', 'author', 'pr']);
export type LaneMode = z.infer<typeof LaneModeSchema>;

/** 02 §5.3.4 拍板的三色（来自 02 §3 设计系统 + 02 §5.3.4 Lane.color 注释） */
export const LaneColorHexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const LaneSchema = z
  .object({
    id: NonEmptyStringSchema, // "branch:main" / "author:alice" / "pr:42"
    label: NonEmptyStringSchema,
    kind: LaneModeSchema,
    color: LaneColorHexSchema,
    order: z.number().int().min(0),
    hidden: z.boolean().optional(),
  })
  .strict();
export type Lane = z.infer<typeof LaneSchema>;

export const CommitNodeSchema = z
  .object({
    id: NonEmptyStringSchema, // sha
    laneId: NonEmptyStringSchema,
    x: z.number(),
    y: z.number().int().min(0),
    sha: NonEmptyStringSchema,
    shortSha: NonEmptyStringSchema,
    message: z.string(),
    author: z
      .object({
        name: NonEmptyStringSchema,
        avatarUrl: z.string().url().optional(),
      })
      .strict(),
    timestamp: IsoDateSchema,
    parents: z.array(NonEmptyStringSchema),
    isMerge: z.boolean(),
    branchHints: z.array(NonEmptyStringSchema),
    linkedCardIds: z.array(NonEmptyStringSchema),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    filesChanged: z.number().int().min(0).optional(),
  })
  .strict();
export type CommitNode = z.infer<typeof CommitNodeSchema>;

export const ParentEdgeSchema = z
  .object({
    id: NonEmptyStringSchema,
    source: NonEmptyStringSchema, // source node id (sha)
    target: NonEmptyStringSchema, // target node id (sha)
    kind: z.enum(['parent', 'merge']),
    prIndex: z.number().int().positive().optional(),
  })
  .strict();
export type ParentEdge = z.infer<typeof ParentEdgeSchema>;

export const TimelinePRSchema = z
  .object({
    id: NonEmptyStringSchema,
    index: z.number().int().positive(),
    title: NonEmptyStringSchema,
    state: z.enum(['open', 'closed', 'merged']),
    head: NonEmptyStringSchema,
    base: NonEmptyStringSchema,
    author: z
      .object({
        name: NonEmptyStringSchema,
        avatarUrl: z.string().url().optional(),
      })
      .strict(),
    url: z.string().url(),
    mergedAt: IsoDateSchema.optional(),
  })
  .strict();
export type TimelinePR = z.infer<typeof TimelinePRSchema>;

export const TimelineDtoSchema = z
  .object({
    windowStart: IsoDateSchema.optional(),
    windowEnd: IsoDateSchema.optional(),
    range: z
      .object({
        from: IsoDateSchema,
        to: IsoDateSchema,
      })
      .strict(),
    lanes: z.array(LaneSchema),
    nodes: z.array(CommitNodeSchema),
    edges: z.array(ParentEdgeSchema),
    prs: z.array(TimelinePRSchema),
    truncated: z.boolean(),
    totalCommits: z.number().int().min(0),
  })
  .strict();
export type TimelineDto = z.infer<typeof TimelineDtoSchema>;

/** commits.timeline 入参（02 §5.3.4 TimelineArgs） */
export const TimelineArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    branches: z.array(NonEmptyStringSchema).min(1).max(10),
    since: IsoDateSchema.optional(),
    until: IsoDateSchema.optional(),
    maxNodes: z.number().int().min(1).max(500).default(500),
    laneMode: LaneModeSchema.default('branch'),
  })
  .strict();
export type TimelineArgs = z.infer<typeof TimelineArgsSchema>;

// ===== @deprecated 兼容导出（ADR-0002 reset 删了 board.cards.* 端点） =====
// 这些类型 owner 在 T3 阶段会替换为 IssueCardDto + issues.* / labels.* 新端点；
// 这里只提供 type-only stub 保证 type-check 通过（行为层面：boardCardsList 端点已删，前端调用会抛 NOT_FOUND）。
// 2026-06-11 临时补 stub，后续 owner-takeover 后删
/** @deprecated use IssueCardDto instead (T3 owner-takeover will migrate renderer) */
export type CardDto = Omit<IssueCardDto, 'id'> & {
  id: string; // T3 会改回 number (IssueCardDto.id 是 number)
  columnId: string;
  position: number;
  color?: string;
  links?: Array<{
    refKind: 'commit' | 'pr' | 'branch' | 'issue';
    owner: string;
    repo: string;
    refId: string;
    cachedTitle?: string;
    role?: 'reference' | 'blocks' | 'relates-to';
  }>;
};
/** @deprecated use IssueCardDto with columnId label for create (T3 owner-takeover) */
export type CreateBoardCardArgs = {
  projectId: string;
  columnId: string;
  title: string;
  body?: string;
  position?: number;
  color?: string;
  links?: Array<{
    refKind: 'commit' | 'pr' | 'branch' | 'issue';
    owner: string;
    repo: string;
    refId: string;
    cachedTitle?: string;
    role?: 'reference' | 'blocks' | 'relates-to';
  }>;
};
/** @deprecated use move-card.ts addLabel/removeLabel flow (T3 owner-takeover) */
export type MoveBoardCardArgs = {
  cardId: string; // T3 会改成 number (IssueCardDto.id)
  toColumnId: string;
  toPosition: number;
};

// ===== channel 名称（ipcMain.handle 字符串 + 渲染端 invoke 字符串共用） =====
// IpcChannel 常量定义已抽到 src/shared/ipc-channels.ts（zod-free），本文件顶部 re-export。
// 新增 / 修改 / 删除 channel 时，**只**改 src/shared/ipc-channels.ts。

