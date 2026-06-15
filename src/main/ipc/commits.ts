/**
 * IPC 路由：commits.* 3 个 endpoint
 *
 * 契约：02-architecture.md §5.3.3 + §5.3.4
 *
 * 端点：
 * - commits.list      →  GET /commits  +  本地 cache_entries（2 min TTL）+ linkedCards JOIN
 * - commits.get       →  GET /git/commits/{sha}  +  本地 cache_entries（5 min TTL）+ linkedCards JOIN
 * - commits.timeline  →  聚合 gitea commits + pulls + 本地 card_links → TimelineDTO
 *                       缓存 30s（与 pulls 一致）；maxNodes 默认 500；truncated 时仅返最近 500
 *
 * 流程：wrapIpc(Zod parse) → 调 gitea/commits.ts + cache/commits.ts + gitea/timeline.ts → 错误转 IpcError
 *
 * 边界：
 * - **不**做 gitea_refs / card_links 写操作（board.cards.link 范围）
 * - linkedCards 来自 card_links JOIN gitea_refs JOIN cards JOIN board_columns（cache/commits.ts）
 */

import { ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListCommitsArgsSchema,
  GetCommitArgsSchema,
  TimelineArgsSchema,
  type ListCommitsArgs,
  type ListCommitsResp,
  type GetCommitArgs,
  type CommitDto,
  type TimelineArgs,
  type TimelineDto,
  type TimelinePR,
  type PullDto,
} from './schema.js';
import { listGiteaCommits, getGiteaCommit } from '../gitea/commits.js';
import { listGiteaPulls } from '../gitea/pulls.js';
import {
  getCommitsCache,
  setCommitsCache,
  COMMITS_LIST_TTL_SECONDS,
  getLinkedCardsForCommits,
  getLinkedCardsForCommit,
} from '../cache/commits.js';
import { getPullsCache, setPullsCache, PULLS_LIST_TTL_SECONDS } from '../cache/pulls.js';
import { getTimelineCache, setTimelineCache, makeTimelineCacheKey } from '../cache/timeline.js';
import { buildTimeline } from '../gitea/timeline.js';
import { resolveProject } from '../board/resolveProject.js';
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

/** 通过 projectId 找到 (giteaUrl, username, owner, repo) —— ADR-0003 Phase 3 统一调 board/resolveProject.ts */

/** 带缓存的拉取 PR 列表（供 commits.timeline 复用 pulls.list 缓存逻辑） */
async function listGiteaPullsCached(
  projectId: string,
  proj: { giteaUrl: string; username: string; owner: string; repo: string },
  state: 'open' | 'closed',
  limit: number,
): Promise<{ items: PullDto[]; hasMore: boolean }> {
  const cacheKey = `state=${state}|page=1|limit=${limit}`;
  const cached = getPullsCache({ projectId, cacheKey });
  if (cached) {
    try {
      return JSON.parse(cached) as { items: PullDto[]; hasMore: boolean };
    } catch {
      // 缓存损坏 = miss
    }
  }
  const r = await listGiteaPulls({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    state,
    limit,
  });
  setPullsCache({
    projectId,
    cacheKey,
    payload: JSON.stringify(r),
    ttlSeconds: PULLS_LIST_TTL_SECONDS,
  });
  return r;
}

function makeListCacheKey(args: ListCommitsArgs): string {
  return [
    `project=${args.projectId}`,
    `sha=${args.sha ?? ''}`,
    `path=${args.path ?? ''}`,
    `author=${args.author ?? ''}`,
    `since=${args.since ?? ''}`,
    `until=${args.until ?? ''}`,
    `page=${args.page}`,
    `limit=${args.limit}`,
  ].join('|');
}

/** commits.timeline 内部按分支缓存的 key */
function makeBranchCommitsCacheKey(
  projectId: string,
  branch: string,
  since: string | undefined,
  until: string | undefined,
  limit: number,
): string {
  return [
    `project=${projectId}`,
    `sha=${branch}`,
    `since=${since ?? ''}`,
    `until=${until ?? ''}`,
    `limit=${limit}`,
  ].join('|');
}

// ===== commits.list =====

async function commitsListHandler(args: ListCommitsArgs): Promise<ListCommitsResp> {
  const start = Date.now();
  const op = 'commits.list';
  logger.info({ op, args: { projectId: args.projectId, page: args.page, limit: args.limit } }, 'ipc start');

  // 1. cache hit
  const cacheKey = makeListCacheKey(args);
  const cached = getCommitsCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ListCommitsResp;
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, 'ipc done');
      return parsed;
    } catch {
      // 损坏 = miss
    }
  }

  // 2. resolve
  const proj = resolveProject(args.projectId);

  // 3. 调 gitea（网络错误时 fallback 到缓存）
  try {
    const giteaResult = await listGiteaCommits({
      giteaUrl: proj.giteaUrl,
      username: proj.username,
      owner: proj.owner,
      repo: proj.repo,
      sha: args.sha,
      path: args.path,
      author: args.author,
      since: args.since,
      until: args.until,
      page: args.page,
      limit: args.limit,
    });

    // 4. JOIN 本地 linkedCards
    const linkedCardsMap = getLinkedCardsForCommits({
      owner: proj.owner,
      repo: proj.repo,
      shas: giteaResult.items.map((c) => c.sha),
    });

    const items: CommitDto[] = giteaResult.items.map((c) => ({
      ...c,
      linkedCards: linkedCardsMap.get(c.sha) ?? [],
    }));

    const resp: ListCommitsResp = {
      items,
      total: items.length,
      hasMore: giteaResult.hasMore,
      nextPage: giteaResult.hasMore ? args.page + 1 : null,
    };

    // 5. 写缓存
    setCommitsCache({ projectId: args.projectId, cacheKey, payload: JSON.stringify(resp) });

    logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, 'ipc done');
    return resp;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn({ op, latencyMs: Date.now() - start }, 'gitea unreachable, falling back to cache');
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as ListCommitsResp;
          (parsed as unknown as Record<string, unknown>)['__offline'] = true;
          logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, offline: true }, 'ipc done (offline)');
          return parsed;
        } catch {
          // 缓存损坏
        }
      }
      // 无缓存，返回空 offline 响应
      const offlineResp: ListCommitsResp = { items: [], total: 0, hasMore: false, nextPage: null };
      (offlineResp as unknown as Record<string, unknown>)['__offline'] = true;
      logger.info({ op, latencyMs: Date.now() - start, offline: true }, 'ipc done (offline, no cache)');
      return offlineResp;
    }
    throw err;
  }
}

// ===== commits.get =====

async function commitsGetHandler(args: GetCommitArgs): Promise<CommitDto> {
  const start = Date.now();
  const op = 'commits.get';
  logger.info({ op, args }, 'ipc start');

  // 1. cache hit（按 sha + projectId 作 key）
  const cacheKey = `project=${args.projectId}|sha=${args.sha}`;
  const cached = getCommitsCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CommitDto;
      logger.info({ op, latencyMs: Date.now() - start, sha: args.sha, hit: true }, 'ipc done');
      return parsed;
    } catch {
      // 损坏 = miss
    }
  }

  // 2. resolve
  const proj = resolveProject(args.projectId);

  // 3. 调 gitea
  const commit = await getGiteaCommit({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    sha: args.sha,
  });

  // 4. JOIN 本地 linkedCards
  const linkedCards = getLinkedCardsForCommit({
    owner: proj.owner,
    repo: proj.repo,
    sha: args.sha,
  });

  const dto: CommitDto = { ...commit, linkedCards };

  // 5. 写缓存（5 min TTL）
  setCommitsCache({
    projectId: args.projectId,
    cacheKey,
    payload: JSON.stringify(dto),
    ttlSeconds: 5 * 60,
  });

  logger.info({ op, latencyMs: Date.now() - start, sha: args.sha, hit: false }, 'ipc done');
  return dto;
}

// ===== commits.timeline =====

/**
 * commits.timeline 聚合
 *
 * 流程：
 * 1. cache hit（30s TTL）→ 解析返回
 * 2. 对每个 branch 调 listGiteaCommits（since/until 透传）→ commitsByBranch
 * 3. 调 listGiteaPulls（拿高亮用 PR + merge 边；state='all' 同时拿 open + closed + merged）
 * 4. linkedCardIdsBySha = 一次 SQL JOIN（cache/commits.getLinkedCardsForCommits）
 * 5. buildTimeline() 归一化 / lane 分配 / edges / 截断
 * 6. 写 cache
 */
async function commitsTimelineHandler(args: TimelineArgs): Promise<TimelineDto> {
  const start = Date.now();
  const op = 'commits.timeline';
  logger.info(
    { op, args: { projectId: args.projectId, branches: args.branches.length, laneMode: args.laneMode, maxNodes: args.maxNodes } },
    'ipc start',
  );

  // 1. cache hit
  const cacheKey = makeTimelineCacheKey(args);
  const cached = getTimelineCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as TimelineDto;
      logger.info({ op, latencyMs: Date.now() - start, hit: true, totalCommits: parsed.totalCommits }, 'ipc done');
      return parsed;
    } catch {
      // 损坏 = miss
    }
  }

  // 2. resolve project
  const proj = resolveProject(args.projectId);

  try {
    // 3. 对每个 branch 拉 commits，优先命中分支级缓存（避免重复选择同一分支时反复请求 gitea）
    const commitsByBranch: Record<string, CommitDto[]> = {};
    for (const branch of args.branches) {
      const branchCacheKey = makeBranchCommitsCacheKey(
        args.projectId,
        branch,
        args.since,
        args.until,
        args.maxNodes,
      );
      const cachedBranch = getCommitsCache({ projectId: args.projectId, cacheKey: branchCacheKey });
      if (cachedBranch) {
        try {
          const parsed = JSON.parse(cachedBranch) as { items: CommitDto[] };
          commitsByBranch[branch] = parsed.items;
          continue;
        } catch {
          // 缓存损坏 = miss，继续走 gitea
        }
      }
      const r = await listGiteaCommits({
        giteaUrl: proj.giteaUrl,
        username: proj.username,
        owner: proj.owner,
        repo: proj.repo,
        sha: branch,
        since: args.since,
        until: args.until,
        page: 1,
        limit: args.maxNodes, // 拉够 maxNodes 即可（任务 prompt §关键约束 12）
      });
      commitsByBranch[branch] = r.items;
      setCommitsCache({
        projectId: args.projectId,
        cacheKey: branchCacheKey,
        payload: JSON.stringify({ items: r.items }),
        ttlSeconds: COMMITS_LIST_TTL_SECONDS,
      });
    }

    // 4. 拉 PR 列表（state='all' 拿全 + 改 state 适配 schema 限制）
    // 02 §5.3.5 PullStateSchema 只接受 'open' | 'closed' → 拆两次合并
    const prsOpen = await listGiteaPullsCached(args.projectId, proj, 'open', 100);
    const prsClosed = await listGiteaPullsCached(args.projectId, proj, 'closed', 100);

    // 转 TimelinePR 形态
    // a3 注：PullDto.state 现在含 'all'（PullStateSchema 加了 a3 'all' 字段），
    //   但 gitea /pulls 实际只返 'open' / 'closed'；这里 narrowing 收窄到不含 'all' 的子集。
    const timelinePrs: TimelinePR[] = [...prsOpen.items, ...prsClosed.items].map((p) => {
      const state: 'open' | 'closed' | 'merged' = p.merged ? 'merged' : (p.state === 'all' ? 'open' : p.state);
      return {
        id: `pr:${proj.owner}/${proj.repo}/${p.index}`,
        index: p.index,
        title: p.title,
        state,
        head: p.head.ref,
        base: p.base.ref,
        author: { name: p.author.username, ...(p.author.avatarUrl ? { avatarUrl: p.author.avatarUrl } : {}) },
        url: `${proj.giteaUrl.replace(/\/+$/, '')}/${proj.owner}/${proj.repo}/pulls/${p.index}`,
        ...(p.merged && p.updatedAt ? { mergedAt: p.updatedAt } : {}),
      };
    });

    // 5. 拿全部 commit 的 linkedCardIds
    const allShas = new Set<string>();
    for (const list of Object.values(commitsByBranch)) {
      for (const c of list) allShas.add(c.sha);
    }
    const linkedCardsMap = getLinkedCardsForCommits({
      owner: proj.owner,
      repo: proj.repo,
      shas: [...allShas],
    });
   const linkedCardIdsBySha = new Map<string, string[]>();
   for (const [sha, links] of linkedCardsMap.entries()) {
   // v1 stub：linkedCardsMap.value 类型是 never[]（永不返回任何 linkedCard）
   // 真有 link 时会是 { cardId: string }，v1 不会发生
   linkedCardIdsBySha.set(sha, (links as Array<{ cardId: string }>).map((l) => l.cardId));
   }

    // 6. buildTimeline 归一化
    const dto = buildTimeline({ args, commitsByBranch, pulls: timelinePrs, linkedCardIdsBySha });

    // 7. 写缓存（payload 统一为 JSON 字符串，cache 层不关心业务类型）
    setTimelineCache({ projectId: args.projectId, cacheKey, payload: JSON.stringify(dto) });

    logger.info(
      { op, latencyMs: Date.now() - start, totalCommits: dto.totalCommits, nodes: dto.nodes.length, truncated: dto.truncated },
      'ipc done',
    );
    return dto;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn({ op, latencyMs: Date.now() - start }, 'gitea unreachable, falling back to timeline cache');
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as TimelineDto;
          (parsed as unknown as Record<string, unknown>)['__offline'] = true;
          logger.info({ op, latencyMs: Date.now() - start, offline: true, totalCommits: parsed.totalCommits }, 'ipc done (offline)');
          return parsed;
        } catch {
          // 缓存损坏
        }
      }
      // 无缓存，返回空 offline 响应
      const offlineDto: TimelineDto = {
        windowStart: undefined,
        windowEnd: undefined,
        range: {
          from: args.since ?? new Date(0).toISOString(),
          to: args.until ?? new Date().toISOString(),
        },
        lanes: [],
        nodes: [],
        edges: [],
        prs: [],
        truncated: false,
        totalCommits: 0,
      };
      (offlineDto as unknown as Record<string, unknown>)['__offline'] = true;
      logger.info({ op, latencyMs: Date.now() - start, offline: true }, 'ipc done (offline, no cache)');
      return offlineDto;
    }
    throw err;
  }
}

// ===== 注册 =====

export function registerCommitsIpc(): void {
  wrapIpc(IpcChannel.COMMITS_LIST, ListCommitsArgsSchema, commitsListHandler);
  wrapIpc(IpcChannel.COMMITS_GET, GetCommitArgsSchema, commitsGetHandler);
  wrapIpc(IpcChannel.COMMITS_TIMELINE, TimelineArgsSchema, commitsTimelineHandler);
}

export function unregisterCommitsIpc(): void {
  ipcMain.removeHandler(IpcChannel.COMMITS_LIST);
  ipcMain.removeHandler(IpcChannel.COMMITS_GET);
  ipcMain.removeHandler(IpcChannel.COMMITS_TIMELINE);
}
