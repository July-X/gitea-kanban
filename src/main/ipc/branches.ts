/**
 * IPC 路由：branches.* 五个 endpoint
 *
 * 契约：02-architecture.md §5.3.2
 *
 * 端点：
 * - branches.list    →  GET /branches  +  本地 cache_entries（1 min TTL）+ starred JOIN
 * - branches.create  →  POST /branches  +  失效 cache
 * - branches.rename  →  PATCH /branches/{oldName}  +  失效 cache
 * - branches.delete  →  DELETE /branches/{branch}  +  失效 cache（**pre-check 默认分支**）
 * - branches.star    →  本地 starred_branches UPSERT/DELETE
 *
 * 危险操作保护（任务 prompt §关键约束 6 / 02 §7.1 第 5 条）：
 * - branches.delete 必须在 IPC handler 入口校验"不能删 default branch"
 *   pre-check + 抛 IpcError(code=CONFLICT, hint=不能删除默认分支)
 *
 * 流程：wrapIpc(Zod parse) → 调 gitea/branches.ts 或 cache/branches.ts → 错误转 IpcError
 */

import { ipcMain } from 'electron';
import { resolveProject } from "../board/resolveProject.js";
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListBranchesArgsSchema,
  CreateBranchArgsSchema,
  RenameBranchArgsSchema,
  DeleteBranchArgsSchema,
  StarBranchArgsSchema,
  type ListBranchesArgs,
  type CreateBranchArgs,
  type RenameBranchArgs,
  type DeleteBranchArgs,
  type StarBranchArgs,
  type ListBranchesResp,
  type BranchDto,
} from './schema.js';
import {
  listGiteaBranches,
  createGiteaBranch,
  renameGiteaBranch,
  deleteGiteaBranch,
} from '../gitea/branches.js';
import {
  listStarredBranches,
  setStarred as _setStarred,
  getBranchesCache,
  setBranchesCache,
  invalidateBranchesCache,
} from '../cache/branches.js';
import { dispatch, registerOp } from '../sync/dispatch.js';
import { logger } from '../logger.js';

/** 统一包装：parse → handler → error → IpcError（与 auth.ts / repos.ts 保持一致） */
function wrapIpc<TArgs, TResult>(
  channel: string,
  schema: { parse: (raw: unknown) => TArgs },
  handler: (args: TArgs) => Promise<TResult>,
): void {
  ipcMain.handle(channel, async (_event, rawArgs: unknown) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled('debug')) {
        logger.debug({ channel, latencyMs: Date.now() - start }, 'ipc ok');
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, 'ipc business error');
        throw err.toJSON();
      }
      if (err && typeof err === 'object' && 'issues' in err) {
        const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
        const issue = zodErr.issues[0];
        const path = issue?.path.join('.') ?? '<root>';
        const message = issue?.message ?? '参数校验失败';
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, 'ipc validation failed');
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, 'ipc internal error');
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: '应用内部错误，已记录日志',
        hint: '请稍后重试，或联系开发者',
        cause: err instanceof Error ? err.message : String(err),
      });
      throw i.toJSON();
    }
  });
}

/** 通过 projectId 找到 (giteaUrl, username, owner, repo, defaultBranch) */
function makeCacheKey(args: ListBranchesArgs): string {
  return `project=${args.projectId}|query=${args.query ?? ''}|page=${args.page}|limit=${args.limit}`;
}

// ===== branches.list =====

async function branchesListHandler(args: ListBranchesArgs): Promise<ListBranchesResp> {
  const start = Date.now();
  const op = 'branches.list';
  logger.info({ op, args: { projectId: args.projectId, query: args.query, page: args.page, limit: args.limit } }, 'ipc start');

  // 1. cache hit
  const cacheKey = makeCacheKey(args);
  const cached = getBranchesCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ListBranchesResp;
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, 'ipc done');
      return parsed;
    } catch {
      // 损坏 = miss
    }
  }

  // 2. resolve
  const proj = resolveProject(args.projectId);

  // 3. 调 gitea
  const giteaResult = await listGiteaBranches({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    page: args.page,
    limit: args.limit,
  });

  // 4. JOIN 本地 starred
  const starredSet = listStarredBranches(args.projectId);

  // 5. lastCommit 取第一个分支的 commit（按 task prompt §branches.list "lastCommit 走 commits.list 第一次 GET"）
  //    v1 简化：list 端点暂不带 lastCommit（commit 列表是后续 task）
  //    —— schema 允许 optional，不带就不返回
  const items: BranchDto[] = giteaResult.items.map((b) => ({
    ...b,
    isDefault: proj.defaultBranch != null && b.name === proj.defaultBranch,
    starred: starredSet.has(b.name),
  }));

  const resp: ListBranchesResp = {
    items,
    total: items.length,
    hasMore: giteaResult.hasMore,
  };

  // 6. 写缓存
  setBranchesCache({ projectId: args.projectId, cacheKey, payload: JSON.stringify(resp) });

  logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, 'ipc done');
  return resp;
}

// ===== branches.create =====

async function branchesCreateHandler(args: CreateBranchArgs): Promise<BranchDto> {
  const start = Date.now();
  const op = 'branches.create';
  logger.info({ op, args }, 'ipc start');

  const proj = resolveProject(args.projectId);

  const created = await createGiteaBranch({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    newBranch: args.newBranch,
    fromBranch: args.fromBranch,
  });

  // 失效 branches 缓存
  invalidateBranchesCache(args.projectId);

  logger.info({ op, latencyMs: Date.now() - start, branch: created.name }, 'ipc done');
  return { ...created, isDefault: false };
}

// ===== branches.rename =====

async function branchesRenameHandler(args: RenameBranchArgs): Promise<BranchDto> {
  const start = Date.now();
  const op = 'branches.rename';
  logger.info({ op, args }, 'ipc start');

  const proj = resolveProject(args.projectId);

  // pre-check：不能改默认分支名
  if (proj.defaultBranch === args.oldName) {
    throw new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: '不能重命名默认分支',
      hint: '默认分支在 gitea 端有特殊处理，不允许重命名',
    });
  }

  const renamed = await renameGiteaBranch({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    oldName: args.oldName,
    newName: args.newName,
  });

  // 失效 branches 缓存
  invalidateBranchesCache(args.projectId);

  // 同步 starred_branches 里的 branch 名字（重命名后 starred 应该跟过去）
  // —— gitea 上重命名是新建+删旧，但我们的 starred 记录要改名
  // 简化：直接 upsert 新名 + 删旧名
  _setStarred({ projectId: args.projectId, branch: args.newName, starred: true });
  _setStarred({ projectId: args.projectId, branch: args.oldName, starred: false });

  logger.info({ op, latencyMs: Date.now() - start, oldName: args.oldName, newName: args.newName }, 'ipc done');
  return { ...renamed, isDefault: false };
}

// ===== branches.delete（危险操作）=====

async function branchesDeleteHandler(args: DeleteBranchArgs): Promise<void> {
  const start = Date.now();
  const op = 'branches.delete';
  logger.info({ op, args }, 'ipc start');

  const proj = resolveProject(args.projectId);

  // pre-check：不能删默认分支（任务 prompt §关键约束 6）
  if (proj.defaultBranch === args.branch) {
    throw new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: '不能删除默认分支',
      hint: '默认分支在 gitea 端是项目基线，不允许删除',
    });
  }

  // pre-check：受保护分支（gitea protected branch）— 调一次单分支接口拿 protected 状态
  // v1 简化：直接调 DELETE，让 gitea 自己 403/409 报错
  // —— 上层 giteaFetch 已经把 403 → PERMISSION_DENIED、409 → CONFLICT
  await deleteGiteaBranch({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    branch: args.branch,
  });

  // 失效 branches 缓存
  invalidateBranchesCache(args.projectId);

  // 同步删除 starred 记录
  _setStarred({ projectId: args.projectId, branch: args.branch, starred: false });

  logger.info({ op, latencyMs: Date.now() - start, branch: args.branch }, 'ipc done');
}

// ===== branches.star =====

async function branchesStarHandler(args: StarBranchArgs): Promise<void> {
  const start = Date.now();
  const op = 'branches.star';
  logger.info({ op, args: { projectId: args.projectId, branch: args.branch, starred: args.starred } }, 'ipc start');
  // ADR-0003 Phase 3：走 dispatch（纯本地 op，仅改 localStore.starredBranches）
  await dispatch('branches.star', args);
  logger.info({ op, latencyMs: Date.now() - start }, 'ipc done');
}

// ===== 注册 =====

export function registerBranchesIpc(): void {
  // ADR-0003 Phase 3：注册 op（纯本地，缺省 offlineApply = execute）
  registerOp<StarBranchArgs, void>('branches.star', {
    execute: _setStarred,
  });

  wrapIpc(IpcChannel.BRANCHES_LIST, ListBranchesArgsSchema, branchesListHandler);
  wrapIpc(IpcChannel.BRANCHES_CREATE, CreateBranchArgsSchema, branchesCreateHandler);
  wrapIpc(IpcChannel.BRANCHES_RENAME, RenameBranchArgsSchema, branchesRenameHandler);
  wrapIpc(IpcChannel.BRANCHES_DELETE, DeleteBranchArgsSchema, branchesDeleteHandler);
  wrapIpc(IpcChannel.BRANCHES_STAR, StarBranchArgsSchema, branchesStarHandler);
}

export function unregisterBranchesIpc(): void {
  ipcMain.removeHandler(IpcChannel.BRANCHES_LIST);
  ipcMain.removeHandler(IpcChannel.BRANCHES_CREATE);
  ipcMain.removeHandler(IpcChannel.BRANCHES_RENAME);
  ipcMain.removeHandler(IpcChannel.BRANCHES_DELETE);
  ipcMain.removeHandler(IpcChannel.BRANCHES_STAR);
}
