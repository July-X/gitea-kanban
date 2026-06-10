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
 * 本 M0 交付：auth 三个 endpoint（auth.connect / disconnect / status）。
 * Plan 2 起按 02 §5.3 顺序补全（repos.list / branches.list / ...）。
 */

import { z } from 'zod';

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

// ===== channel 名称（ipcMain.handle 字符串 + 渲染端 invoke 字符串共用） =====

/**
 * IPC channel 集中常量
 *
 * 命名约定：`<namespace>.<method>`，camelCase
 * 02-architecture.md §5.1
 */
export const IpcChannel = {
  AUTH_CONNECT: 'auth.connect',
  AUTH_DISCONNECT: 'auth.disconnect',
  AUTH_STATUS: 'auth.status',

  // === repos namespace（02-architecture.md §5.3.1）===
  REPOS_LIST: 'repos.list',
  REPOS_ADD_PROJECT: 'repos.addProject',
  REPOS_REMOVE_PROJECT: 'repos.removeProject',

  // === branches namespace（02-architecture.md §5.3.2）===
  BRANCHES_LIST: 'branches.list',
  BRANCHES_CREATE: 'branches.create',
  BRANCHES_RENAME: 'branches.rename',
  BRANCHES_DELETE: 'branches.delete',
  BRANCHES_STAR: 'branches.star',

  // === 后续 namespace 占位（Plan 2 续）===
  // COMMITS_LIST: 'commits.list',
  // ...
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
