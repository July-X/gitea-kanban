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
 *   - Plan 2 cycle 8（本版本）：board.columns.* 5 个 + board.cards.* 7 个 + commits.timeline 1 个
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

/** ISO 时间戳 */
export const IsoDateSchema = z.string().datetime();

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

export const CreateBranchArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    newBranch: NonEmptyStringSchema,
    fromBranch: NonEmptyStringSchema,
  })
  .strict();
export type CreateBranchArgs = z.infer<typeof CreateBranchArgsSchema>;

export const RenameBranchArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    oldName: NonEmptyStringSchema,
    newName: NonEmptyStringSchema,
  })
  .strict();
export type RenameBranchArgs = z.infer<typeof RenameBranchArgsSchema>;

export const DeleteBranchArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    branch: NonEmptyStringSchema,
  })
  .strict();
export type DeleteBranchArgs = z.infer<typeof DeleteBranchArgsSchema>;

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
 */
export const PullStateSchema = z.enum(['open', 'closed']);
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

export const CreatePullArgsSchema = z
  .object({
    projectId: NonEmptyStringSchema,
    head: NonEmptyStringSchema,
    base: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    body: z.string().optional(),
    draft: z.boolean().optional(),
  })
  .strict();
export type CreatePullArgs = z.infer<typeof CreatePullArgsSchema>;

/**
 * PR 合并方式（02-architecture.md §5.3.6）
 *
 * 用户友好映射（Zod .describe 加在 source schema 上，使 `MergeMethodSchema.description` 可读）：
 *   - 'merge'         → "普通合并（保留所有提交历史）"
 *   - 'rebase'        → "变基后快进（重写历史，单一线性）"
 *   - 'rebase-merge'  → "变基后 merge commit（重写历史 + 保留 merge commit）"
 *   - 'squash'        → "压缩为单提交（合并请求内 N 个提交合成 1 个）"
 *   - 'squash-merge'  → gitea 字段：等同 squash + 显式 merge commit
 *
 * 业务规则（02-architecture §5.3.6）：
 *   - method='squash' / 'squash-merge' → commitMessage 必填（Zod refine 强制）
 *   - deleteBranchAfter：仅作参数透传（不主动调 branches.delete —— UI 走双确认在 UI 层统一实现）
 */
export const MergeMethodSchema = z.enum([
  'merge',
  'rebase',
  'rebase-merge',
  'squash',
  'squash-merge',
]).describe(
  [
    'merge        → "普通合并（保留所有提交历史）"',
    'rebase       → "变基后快进（重写历史，单一线性）"',
    'rebase-merge → "变基后 merge commit（重写历史 + 保留 merge commit）"',
    'squash       → "压缩为单提交（合并请求内 N 个提交合成 1 个）"',
    'squash-merge → gitea 字段：等同 squash + 显式 merge commit',
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
      if (a.method === 'squash' || a.method === 'squash-merge') {
        return typeof a.commitMessage === 'string' && a.commitMessage.length > 0;
      }
      return true;
    },
    {
      message: 'method=squash / squash-merge 时 commitMessage 必填',
      path: ['commitMessage'],
    },
  );
export type MergePrArgs = z.infer<typeof MergePrArgsSchema>;

export const MergePrResultSchema = z
  .object({
    sha: NonEmptyStringSchema,
    merged: z.boolean(),
    message: z.string(),
  })
  .strict();
export type MergePrResult = z.infer<typeof MergePrResultSchema>;

// ============================================================
// ===== board.columns namespace（02-architecture.md §5.3.7）=====
// ============================================================

/** 看板列 DTO（DB row + 聚合 cardCount） */
export const ColumnDtoSchema = z
  .object({
    id: NonEmptyStringSchema,
    boardId: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    position: z.number().int().min(0),
    wipLimit: z.number().int().min(0).nullable(),
    hideMergedPr: z.boolean(),
    cardCount: z.number().int().min(0),
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
    name: NonEmptyStringSchema,
    position: z.number().int().min(0),
    wipLimit: z.number().int().min(0).optional(),
    hideMergedPr: z.boolean().optional(),
  })
  .strict();
export type CreateBoardColumnArgs = z.infer<typeof CreateBoardColumnArgsSchema>;

export const UpdateBoardColumnArgsSchema = z
  .object({
    columnId: NonEmptyStringSchema,
    patch: z
      .object({
        name: NonEmptyStringSchema.optional(),
        wipLimit: z.number().int().min(0).nullable().optional(),
        hideMergedPr: z.boolean().optional(),
      })
      .strict()
      .refine(
        (p) => p.name !== undefined || p.wipLimit !== undefined || p.hideMergedPr !== undefined,
        { message: 'patch 必须至少含一个字段' },
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
    /**
     * 该列上的卡片移到哪一列。null = 一起删（卡片会级联 DELETE，因为 cards.columnId
     * ON DELETE CASCADE）；不传 = 同 null。
     */
    moveCardsTo: NonEmptyStringSchema.nullable().optional(),
  })
  .strict();
export type DeleteBoardColumnArgs = z.infer<typeof DeleteBoardColumnArgsSchema>;

// ============================================================
// ===== board.cards namespace（02-architecture.md §5.3.8）=====
// ============================================================

/** 卡片关联条目（DTO 形态） */
export const CardLinkDtoSchema = z
  .object({
    id: NonEmptyStringSchema,
    refKind: z.enum(['commit', 'pr', 'branch', 'issue']),
    owner: NonEmptyStringSchema,
    repo: NonEmptyStringSchema,
    refId: NonEmptyStringSchema,
    cachedTitle: z.string().optional(),
    role: z.enum(['reference', 'blocks', 'relates-to']),
  })
  .strict();
export type CardLinkDto = z.infer<typeof CardLinkDtoSchema>;

/** 卡片 DTO（DB row + 关联 links） */
export const CardDtoSchema = z
  .object({
    id: NonEmptyStringSchema,
    columnId: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    body: z.string().optional(),
    position: z.number().int().min(0),
    color: z.string().optional(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    links: z.array(CardLinkDtoSchema),
  })
  .strict();
export type CardDto = z.infer<typeof CardDtoSchema>;

export const ListBoardCardsArgsSchema = z
  .object({
    columnId: NonEmptyStringSchema,
  })
  .strict();
export type ListBoardCardsArgs = z.infer<typeof ListBoardCardsArgsSchema>;

export const CreateBoardCardArgsSchema = z
  .object({
    columnId: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    body: z.string().optional(),
    position: z.number().int().min(0),
    color: z.string().optional(),
    /**
     * 关联条目（不指定 id —— 由后端生成 + UPSERT gitea_refs 后分配 linkId）。
     * 用 02 §4.2 拍板的 4 种 kind + 3 种 role。
     */
    links: z
      .array(
        z
          .object({
            refKind: z.enum(['commit', 'pr', 'branch', 'issue']),
            owner: NonEmptyStringSchema,
            repo: NonEmptyStringSchema,
            refId: NonEmptyStringSchema,
            cachedTitle: z.string().optional(),
            role: z.enum(['reference', 'blocks', 'relates-to']).default('reference'),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type CreateBoardCardArgs = z.infer<typeof CreateBoardCardArgsSchema>;

export const UpdateBoardCardArgsSchema = z
  .object({
    cardId: NonEmptyStringSchema,
    patch: z
      .object({
        title: NonEmptyStringSchema.optional(),
        body: z.string().optional(),
        color: z.string().optional(),
      })
      .strict()
      .refine((p) => p.title !== undefined || p.body !== undefined || p.color !== undefined, {
        message: 'patch 必须至少含一个字段',
      }),
  })
  .strict();
export type UpdateBoardCardArgs = z.infer<typeof UpdateBoardCardArgsSchema>;

export const MoveBoardCardArgsSchema = z
  .object({
    cardId: NonEmptyStringSchema,
    toColumnId: NonEmptyStringSchema,
    toPosition: z.number().int().min(0),
  })
  .strict();
export type MoveBoardCardArgs = z.infer<typeof MoveBoardCardArgsSchema>;

export const DeleteBoardCardArgsSchema = z
  .object({
    cardId: NonEmptyStringSchema,
  })
  .strict();
export type DeleteBoardCardArgs = z.infer<typeof DeleteBoardCardArgsSchema>;

export const LinkBoardCardArgsSchema = z
  .object({
    cardId: NonEmptyStringSchema,
    link: z
      .object({
        refKind: z.enum(['commit', 'pr', 'branch', 'issue']),
        owner: NonEmptyStringSchema,
        repo: NonEmptyStringSchema,
        refId: NonEmptyStringSchema,
        cachedTitle: z.string().optional(),
        role: z.enum(['reference', 'blocks', 'relates-to']).default('reference'),
      })
      .strict(),
  })
  .strict();
export type LinkBoardCardArgs = z.infer<typeof LinkBoardCardArgsSchema>;

export const UnlinkBoardCardArgsSchema = z
  .object({
    linkId: NonEmptyStringSchema,
  })
  .strict();
export type UnlinkBoardCardArgs = z.infer<typeof UnlinkBoardCardArgsSchema>;

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

// ===== channel 名称（ipcMain.handle 字符串 + 渲染端 invoke 字符串共用） =====
// IpcChannel 常量定义已抽到 src/shared/ipc-channels.ts（zod-free），本文件顶部 re-export。
// 新增 / 修改 / 删除 channel 时，**只**改 src/shared/ipc-channels.ts。

