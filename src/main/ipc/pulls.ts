/**
 * IPC 路由：pulls.* 4 个 endpoint
 *
 * 契约：02-architecture.md §5.3.5 + §5.3.6
 *
 * 端点：
 * - pulls.list   →  GET /pulls  +  本地 cache_entries（30s TTL）+ linkedCards JOIN
 * - pulls.get    →  GET /pulls/{index}  +  本地 cache_entries（30s TTL）+ linkedCards JOIN
 * - pulls.create →  POST /pulls  +  失效 pulls 缓存
 * - pulls.merge  →  POST /pulls/{index}/merge（**危险操作**）  +  失效 pulls + commits + branches 缓存
 *
 * 关键约束（任务 prompt §关键约束 + §pulls.merge 业务规则）：
 * - pulls.create / pulls.merge 是写操作，触发缓存失效
 * - pulls.merge 写后**不**主动调 branches.delete（双确认在 UI 层做；deleteBranchAfter 透传 gitea）
 * - pulls.merge 失败错误码由 giteaFetch 映射（CONFLICT / PERMISSION_DENIED）
 * - linkedCards 来自 card_links JOIN gitea_refs JOIN cards JOIN board_columns
 *
 * 危险操作（任务 prompt §pulls.merge + AGENTS.md §8.3）：
 * - 方法选择 5 种 + 用户友好文案（Zod schema .describe 落定）
 * - squash / squash-merge 时 commitMessage 必填（Zod refine）
 * - UI 层会有二次确认（"普通合并/变基/压缩..."的提示），IPC 层只做：
 *   ① Zod 校验
 *  ② 调 gitea
 *  ③ 写后失效
 */

import { ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListPullsArgsSchema,
  GetPullArgsSchema,
  CreatePullArgsSchema,
  MergePrArgsSchema,
  ClosePrArgsSchema,
  UpdatePullLabelsArgsSchema,
  UpdatePullAssigneeArgsSchema,
  UpdatePullReviewersArgsSchema,
  type ListPullsArgs,
  type ListPullsResp,
  type GetPullArgs,
  type CreatePullArgs,
  type MergePrArgs,
  type MergePrResult,
  type ClosePrArgs,
  type UpdatePullLabelsArgs,
  type UpdatePullAssigneeArgs,
  type UpdatePullReviewersArgs,
  type PullDto,
} from './schema.js';
import {
  listGiteaPulls,
  getGiteaPull,
  createGiteaPull,
  mergeGiteaPull,
  closeGiteaPull,
  updatePullLabels,
  updatePullAssignee,
  updatePullReviewers,
} from '../gitea/pulls.js';
import {
  getPullsCache,
  setPullsCache,
  invalidatePullsCache,
} from '../cache/pulls.js';
import { invalidateCommitsCache } from '../cache/commits.js';
import { invalidateBranchesCache } from '../cache/branches.js';
import {
  getLinkedCardsForPulls,
  getLinkedCardsForPull,
} from '../cache/commits.js';
import { repoProjects } from '../cache/schema/repoProjects.js';
import { giteaAccounts } from '../cache/schema/giteaAccounts.js';
import { eq } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { logger } from '../logger.js';

/** 统一包装：parse → handler → error → IpcError（与 branches.ts / repos.ts 保持一致） */
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

/** 通过 projectId 找到 (giteaUrl, username, owner, repo) */
function resolveProject(projectId: string): {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
} {
  const db = getDb();
  const row = db
    .select()
    .from(repoProjects)
    .where(eq(repoProjects.id, projectId))
    .all()[0];
  if (!row) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目不存在',
      hint: '请先在仓库列表中重新添加该仓库为项目',
    });
  }
  const acc = db
    .select()
    .from(giteaAccounts)
    .where(eq(giteaAccounts.id, row.giteaAccountId))
    .all()[0];
  if (!acc) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'gitea 账户不存在（项目孤儿）',
      hint: '请重新连接 gitea 账户',
    });
  }
  return {
    giteaUrl: acc.giteaUrl,
    username: acc.username,
    owner: row.owner,
    repo: row.name,
  };
}

function makeListCacheKey(args: ListPullsArgs): string {
  return [
    `project=${args.projectId}`,
    `state=${args.state ?? ''}`,
    `head=${args.head ?? ''}`,
    `base=${args.base ?? ''}`,
    `author=${args.author ?? ''}`,
    `page=${args.page}`,
    `limit=${args.limit}`,
  ].join('|');
}

// ===== pulls.list =====

async function pullsListHandler(args: ListPullsArgs): Promise<ListPullsResp> {
  const start = Date.now();
  const op = 'pulls.list';
  logger.info({ op, args: { projectId: args.projectId, state: args.state, page: args.page } }, 'ipc start');

  // 1. cache hit
  const cacheKey = makeListCacheKey(args);
  const cached = getPullsCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ListPullsResp;
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, 'ipc done');
      return parsed;
    } catch {
      // 损坏 = miss
    }
  }

  // 2. resolve
  const proj = resolveProject(args.projectId);

 // 3. 调 gitea
 const giteaResult = await listGiteaPulls({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 state: args.state,
 page: args.page,
 limit: args.limit,
 });

  // 4. JOIN 本地 linkedCards
 const linkedCardsMap = getLinkedCardsForPulls({
 owner: proj.owner,
 repo: proj.repo,
 indexes: giteaResult.items.map((p) => p.index),
 });

  const items: PullDto[] = giteaResult.items.map((p) => ({
    ...p,
    linkedCards: linkedCardsMap.get(p.index) ?? [],
  }));

  const resp: ListPullsResp = {
    items,
    total: giteaResult.hasMore ? items.length + 1 : items.length, // hasMore 时 total 至少比当前页多 1
    hasMore: giteaResult.hasMore,
  };

  // 5. 写缓存
  setPullsCache({ projectId: args.projectId, cacheKey, payload: JSON.stringify(resp) });

  logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, 'ipc done');
  return resp;
}

// ===== pulls.get =====

async function pullsGetHandler(args: GetPullArgs): Promise<PullDto> {
  const start = Date.now();
  const op = 'pulls.get';
  logger.info({ op, args }, 'ipc start');

  // 1. cache hit
  const cacheKey = `project=${args.projectId}|index=${args.index}`;
  const cached = getPullsCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as PullDto;
      logger.info({ op, latencyMs: Date.now() - start, index: args.index, hit: true }, 'ipc done');
      return parsed;
    } catch {
      // 损坏 = miss
    }
  }

  // 2. resolve
  const proj = resolveProject(args.projectId);

  // 3. 调 gitea
  const pull = await getGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
  });

  // 4. JOIN 本地 linkedCards
  const linkedCards = getLinkedCardsForPull({
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
  });

  const dto: PullDto = { ...pull, linkedCards };

  // 5. 写缓存
  setPullsCache({ projectId: args.projectId, cacheKey, payload: JSON.stringify(dto) });

  logger.info({ op, latencyMs: Date.now() - start, index: args.index, hit: false }, 'ipc done');
  return dto;
}

// ===== pulls.create =====

async function pullsCreateHandler(args: CreatePullArgs): Promise<PullDto> {
  const start = Date.now();
  const op = 'pulls.create';
  logger.info({ op, args }, 'ipc start');

  const proj = resolveProject(args.projectId);

  const created = await createGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    head: args.head,
    base: args.base,
    title: args.title,
    body: args.body,
    draft: args.draft,
  });

  // 失效 pulls 缓存（list 里有新 PR）
  invalidatePullsCache(args.projectId);

  // linkedCards 关联（新 PR 还没卡，所以走空）
  logger.info({ op, latencyMs: Date.now() - start, index: created.index }, 'ipc done');
  return { ...created, linkedCards: [] };
}

// ===== pulls.merge（危险操作）=====

async function pullsMergeHandler(args: MergePrArgs): Promise<MergePrResult> {
  const start = Date.now();
  const op = 'pulls.merge';
  logger.info({ op, args: { projectId: args.projectId, index: args.index, method: args.method } }, 'ipc start');

  const proj = resolveProject(args.projectId);

  // 调 gitea（错误码 giteaFetch 已映射：CONFLICT / PERMISSION_DENIED / NOT_FOUND）
  const result = await mergeGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    method: args.method,
    deleteBranchAfter: args.deleteBranchAfter,
    commitMessage: args.commitMessage,
  });

  // 合并成功后失效 pulls + commits + branches 三个资源缓存
  // —— 合并后 PR 状态变、head 分支前进、可能多出新 commit
  invalidatePullsCache(args.projectId);
  invalidateCommitsCache(args.projectId);
  invalidateBranchesCache(args.projectId);

  logger.info({ op, latencyMs: Date.now() - start, sha: result.sha, merged: result.merged }, 'ipc done');
  return result;
}

// ===== pulls.close（关闭合并请求，不合并）=====

async function pullsCloseHandler(args: ClosePrArgs): Promise<{ closed: boolean }> {
  const start = Date.now();
  const op = 'pulls.close';
  logger.info({ op, args: { projectId: args.projectId, index: args.index } }, 'ipc start');

  const proj = resolveProject(args.projectId);

  const result = await closeGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    reason: args.reason,
  });

  // 关闭后失效 pulls 缓存（PR 状态从 open → closed）
  invalidatePullsCache(args.projectId);

  logger.info({ op, latencyMs: Date.now() - start, closed: result.closed }, 'ipc done');
  return result;
}

// ===== pulls.updateLabels =====

async function pullsUpdateLabelsHandler(args: UpdatePullLabelsArgs): Promise<void> {
  const start = Date.now();
  const op = 'pulls.updateLabels';
  logger.info({ op, args: { projectId: args.projectId, index: args.index, labels: args.labels } }, 'ipc start');

  const proj = resolveProject(args.projectId);
  await updatePullLabels({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    labels: args.labels,
  });

  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start }, 'ipc done');
}

// ===== pulls.updateAssignee =====

async function pullsUpdateAssigneeHandler(args: UpdatePullAssigneeArgs): Promise<void> {
  const start = Date.now();
  const op = 'pulls.updateAssignee';
  logger.info({ op, args: { projectId: args.projectId, index: args.index, assignee: args.assignee } }, 'ipc start');

  const proj = resolveProject(args.projectId);
  await updatePullAssignee({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    assignee: args.assignee,
  });

  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start }, 'ipc done');
}

// ===== pulls.updateReviewers =====

async function pullsUpdateReviewersHandler(args: UpdatePullReviewersArgs): Promise<void> {
  const start = Date.now();
  const op = 'pulls.updateReviewers';
  logger.info({ op, args: { projectId: args.projectId, index: args.index, reviewers: args.reviewers } }, 'ipc start');

  const proj = resolveProject(args.projectId);
  await updatePullReviewers({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    reviewers: args.reviewers,
  });

  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start }, 'ipc done');
}

// ===== 注册 =====

export function registerPullsIpc(): void {
  wrapIpc(IpcChannel.PULLS_LIST, ListPullsArgsSchema, pullsListHandler);
  wrapIpc(IpcChannel.PULLS_GET, GetPullArgsSchema, pullsGetHandler);
  wrapIpc(IpcChannel.PULLS_CREATE, CreatePullArgsSchema, pullsCreateHandler);
  wrapIpc(IpcChannel.PULLS_MERGE, MergePrArgsSchema, pullsMergeHandler);
  wrapIpc(IpcChannel.PULLS_CLOSE, ClosePrArgsSchema, pullsCloseHandler);
  wrapIpc(IpcChannel.PULLS_UPDATE_LABELS, UpdatePullLabelsArgsSchema, pullsUpdateLabelsHandler);
  wrapIpc(IpcChannel.PULLS_UPDATE_ASSIGNEE, UpdatePullAssigneeArgsSchema, pullsUpdateAssigneeHandler);
  wrapIpc(IpcChannel.PULLS_UPDATE_REVIEWERS, UpdatePullReviewersArgsSchema, pullsUpdateReviewersHandler);
}

export function unregisterPullsIpc(): void {
  ipcMain.removeHandler(IpcChannel.PULLS_LIST);
  ipcMain.removeHandler(IpcChannel.PULLS_GET);
  ipcMain.removeHandler(IpcChannel.PULLS_CREATE);
  ipcMain.removeHandler(IpcChannel.PULLS_MERGE);
  ipcMain.removeHandler(IpcChannel.PULLS_CLOSE);
  ipcMain.removeHandler(IpcChannel.PULLS_UPDATE_LABELS);
  ipcMain.removeHandler(IpcChannel.PULLS_UPDATE_ASSIGNEE);
  ipcMain.removeHandler(IpcChannel.PULLS_UPDATE_REVIEWERS);
}
