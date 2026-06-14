/**
 * IPC 路由：repos.* 三个 endpoint
 *
 * 契约：02-architecture.md §5.3.1
 *
 * 端点：
 * - repos.list          →  GET /user/repos  +  本地 cache_entries（5 min TTL）
 * - repos.addProject    →  本地 repo_projects INSERT
 * - repos.removeProject →  本地 repo_projects DELETE
 *
 * 流程：wrapIpc(Zod parse) → 调 gitea/repos.ts 或 cache/repos.ts → 错误转 IpcError
 *
 * 铁律：
 * - repos.* 不需要本地权限校验（gitea 自己管）
 * - isProject 字段：列表渲染时通过 cache/repos.findProjectsByOwnerName JOIN 覆盖
 */

import { ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListReposArgsSchema,
  AddProjectArgsSchema,
  RemoveProjectArgsSchema,
  type ListReposResp,
  type RepoProjectDto,
  type ListReposArgs,
  type AddProjectArgs,
  type RemoveProjectArgs,
  type RepoDto,
} from './schema.js';
import { listGiteaRepos } from '../gitea/repos.js';
import {
  findProjectsByOwnerName,
  addProject as _cacheAddProject,
  removeProject as _cacheRemoveProject,
  getReposCache,
  setReposCache,
  touchLastSync,
  backfillDefaultBranch,
} from '../cache/repos.js';
import { getLocalStore } from '../local/state.js';
import { dispatch, registerOp } from '../sync/dispatch.js';
import { logger } from '../logger.js';

/** 统一包装：parse → handler → error → IpcError */
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

/**
 * 解析 giteaAccountId → (giteaUrl, username)
 *
 * 内部辅助：gitea API 调用需要 (giteaUrl, username) 而不是 account.id
 * ADR-0003 Phase 2：走 localStore
 */
function resolveGiteaAccount(giteaAccountId: string): { giteaUrl: string; username: string } {
  const state = getLocalStore().get();
  const acc = state.accounts.find((a) => a.id === giteaAccountId);
  if (!acc) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'gitea 账户不存在',
      hint: '请先在 设置 → 账户 连接 gitea',
    });
  }
  return { giteaUrl: acc.giteaUrl, username: acc.username };
}

/** 构造 cache key —— 同一 giteaAccountId + 过滤 + 分页 = 同一份缓存 */
function makeCacheKey(args: ListReposArgs): string {
  return `account=${args.giteaAccountId}|query=${args.query ?? ''}|page=${args.page}|limit=${args.limit}`;
}

// ===== repos.list =====

async function reposListHandler(args: ListReposArgs): Promise<ListReposResp> {
  const start = Date.now();
  const op = 'repos.list';
  logger.info({ op, args: { accountId: args.giteaAccountId, query: args.query, page: args.page, limit: args.limit } }, 'ipc start');

  // 1. cache hit
  const cacheKey = makeCacheKey(args);
  const cached = getReposCache({ giteaAccountId: args.giteaAccountId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ListReposResp;
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, 'ipc done');
      return parsed;
    } catch {
      // 缓存 JSON 损坏 = 当作 miss，继续走 gitea
    }
  }

  // 2. resolve account
  const { giteaUrl, username } = resolveGiteaAccount(args.giteaAccountId);

  // 3. 调 gitea
  const giteaResult = await listGiteaRepos({
    giteaUrl,
    username,
    query: args.query,
    page: args.page,
    limit: args.limit,
  });

  // 4. JOIN 本地项目状态
  const projectMap = findProjectsByOwnerName(
    args.giteaAccountId,
    giteaResult.items.map((r) => ({ owner: r.owner, name: r.name })),
  );

  // 5. 写回本地 lastSyncAt（成功的 list 算一次同步）
  //    + 顺手 backfill defaultBranch（v1.1.3 timeline polish 发现 sqlite 里 default_branch 为空，
  //    导致所有 BranchDto.isDefault = false，branches.list 选不出 default 分支；
  //    TimelineView 默认勾选只命中 1 个非 default 分支 → commits.timeline IPC 只返 7 commits，
  //    用户感觉"时间轴画得零零散散，完全不可用"）。
  for (const item of giteaResult.items) {
    const proj = projectMap.get(`${item.owner}/${item.name}`);
    if (proj) {
      touchLastSync({ giteaAccountId: args.giteaAccountId, owner: item.owner, name: item.name });
      if (!proj.defaultBranch && item.defaultBranch) {
        backfillDefaultBranch({
          giteaAccountId: args.giteaAccountId,
          owner: item.owner,
          name: item.name,
          defaultBranch: item.defaultBranch,
        });
      }
    }
  }

  // 6. 合并 RepoDTO
  const items: RepoDto[] = giteaResult.items.map((r) => {
    const proj = projectMap.get(`${r.owner}/${r.name}`);
    return {
      ...r,
      isProject: Boolean(proj),
      lastSyncAt: proj?.lastSyncAt ?? undefined,
    };
  });

  const resp: ListReposResp = {
    items,
    total: items.length,
    page: args.page,
    hasMore: giteaResult.hasMore,
  };

  // 7. 写缓存
  setReposCache({
    giteaAccountId: args.giteaAccountId,
    cacheKey,
    payload: JSON.stringify(resp),
  });

  logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, 'ipc done');
  return resp;
}

// ===== repos.addProject =====

async function reposAddProjectHandler(args: AddProjectArgs): Promise<RepoProjectDto> {
  const start = Date.now();
  const op = 'repos.addProject';
  logger.info({ op, args }, 'ipc start');

  // 1. 校验 gitea_account 存在
  resolveGiteaAccount(args.giteaAccountId);

  // 2. 写 localStore（ADR-0003 Phase 3：走 dispatch，纯本地 op）
  //   业务函数是同步的，wrap 成 async execute 以匹配 OpHandler.execute 签名
  const { result: project } = await dispatch<AddProjectArgs, RepoProjectDto>('repos.addProject', args);

  logger.info({ op, latencyMs: Date.now() - start, projectId: project.id }, 'ipc done');
  return project;
}

// ===== repos.removeProject =====

async function reposRemoveProjectHandler(args: RemoveProjectArgs): Promise<void> {
  const start = Date.now();
  const op = 'repos.removeProject';
  logger.info({ op, args }, 'ipc start');
  await dispatch('repos.removeProject', args);
  logger.info({ op, latencyMs: Date.now() - start }, 'ipc done');
}

// ===== 注册 =====

export function registerReposIpc(): void {
  // ADR-0003 Phase 3：注册 op 到 dispatch（纯本地 op，缺省 offlineApply = execute）
  //   业务函数是 sync，wrap 成 async execute 满足 OpHandler.execute 签名（返 Promise）
  registerOp<AddProjectArgs, RepoProjectDto>('repos.addProject', {
    execute: async (a) => _cacheAddProject(a),
  });
  registerOp<RemoveProjectArgs, void>('repos.removeProject', {
    execute: async (a) => _cacheRemoveProject(a.projectId),
  });

  wrapIpc(IpcChannel.REPOS_LIST, ListReposArgsSchema, reposListHandler);
  wrapIpc(IpcChannel.REPOS_ADD_PROJECT, AddProjectArgsSchema, reposAddProjectHandler);
  wrapIpc(IpcChannel.REPOS_REMOVE_PROJECT, RemoveProjectArgsSchema, reposRemoveProjectHandler);
}

export function unregisterReposIpc(): void {
  ipcMain.removeHandler(IpcChannel.REPOS_LIST);
  ipcMain.removeHandler(IpcChannel.REPOS_ADD_PROJECT);
  ipcMain.removeHandler(IpcChannel.REPOS_REMOVE_PROJECT);
}
