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
import { IpcChannel } from '../../shared/ipc-channels.js';
import {
  ListCommitsArgsSchema,
  GetCommitArgsSchema,
  type ListCommitsArgs,
  type ListCommitsResp,
  type GetCommitArgs,
  type CommitDto,
  type GitGraphLinesArgs,
  GitGraphLinesArgsSchema,
  CloneRepoArgsSchema,
  GitGraphPullArgsSchema,
  type GraphLinesDto,
  type GitGraphPullArgs,
  type GitGraphPullResp,
  type CloneRepoArgs,
} from './schema.js';
import { listGiteaCommits, getGiteaCommit } from '../gitea/commits.js';
import {
  getCommitsCache,
  setCommitsCache,
  getLinkedCardsForCommits,
  getLinkedCardsForCommit,
} from '../cache/commits.js';
import { resolveProject } from '../board/resolveProject.js';
import { logger } from '../logger.js';
import {
  runGraphLog,
  cloneRepo,
  suggestLocalRepoPath,
  repoPathExists,
  pullRepo,
} from '../gitgraph/gitProcess.js';
import { listLocalRepoPath, saveLocalRepoPath } from '../local/gitgraphPaths.js';
import { keychainGet } from '../gitea/keychain.js';
import { existsSync } from 'node:fs';

/** 简洁 fs.existsSync 包装（避免上面 main 块用 fs.mkdir 时干扰） */
function existsPath(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

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

// ===== commits.list =====

async function commitsListHandler(args: ListCommitsArgs): Promise<ListCommitsResp> {
  const start = Date.now();
  const op = 'commits.list';
  logger.info(
    { op, args: { projectId: args.projectId, page: args.page, limit: args.limit } },
    'ipc start',
  );

  // 1. cache hit
  const cacheKey = makeListCacheKey(args);
  const cached = getCommitsCache({ projectId: args.projectId, cacheKey });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ListCommitsResp;
      logger.info(
        { op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true },
        'ipc done',
      );
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

    logger.info(
      { op, latencyMs: Date.now() - start, resultSize: items.length, hit: false },
      'ipc done',
    );
    return resp;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn(
        { op, latencyMs: Date.now() - start },
        'gitea unreachable, falling back to cache',
      );
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as ListCommitsResp;
          (parsed as unknown as Record<string, unknown>)['__offline'] = true;
          logger.info(
            { op, latencyMs: Date.now() - start, resultSize: parsed.items.length, offline: true },
            'ipc done (offline)',
          );
          return parsed;
        } catch {
          // 缓存损坏
        }
      }
      // 无缓存，返回空 offline 响应
      const offlineResp: ListCommitsResp = { items: [], total: 0, hasMore: false, nextPage: null };
      (offlineResp as unknown as Record<string, unknown>)['__offline'] = true;
      logger.info(
        { op, latencyMs: Date.now() - start, offline: true },
        'ipc done (offline, no cache)',
      );
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

// ===== commits.gitgraph.lines =====
/**
 * v1.4 重构：返回 Gitea parser.go 字符流协议
 *
 * 数据流：
 *   main: gitea REST → commit[]  →  (v1.5) git log --graph 子进程  → GraphLinesDto
 *   renderer: GraphLinesDto → parseLines() → Graph → SVG
 *
 * 当前实现（v1.4）：gitea-kanban 还没接仓库本地路径，
 *   没法跑 `git log --graph` 子进程 → handler **不抛错**，而是返
 *   `{ disabled: true, disabledReason, lines: [] }`，让前端 view 走
 *   "功能暂未启用"占位（避免被用户感知为"操作失败"）
 *
 * v1.5 计划：
 *   1. 引入仓库本地路径（clone 或指定 path）
 *   2. 用 src/main/gitgraph/gitProcess.ts runGraphLog(cwd, opts) 调 git 二进制
 *   3. 加上 listGiteaRefsBySha 关联 ref 装饰（与 graph.go %D 等价）
 *   4. 写 cache（30s TTL）
 *   5. 把下面的 `disabled: true` 分支去掉，改为跑 gitProcess
 */
async function commitsGitGraphLinesHandler(args: GitGraphLinesArgs): Promise<GraphLinesDto> {
  // v1.5：查 localStore 看 projectId 是否有 localPath
  // - 有 → 跑 git log --graph 子进程拿字符流
  // - 没有 → 返 disabled 让前端显示「启用 Git Graph」按钮
  const localCwd = listLocalRepoPath(args.projectId);
  if (!localCwd || !existsPath(localCwd)) {
    return {
      disabled: true,
      disabledReason:
        'Git Graph 功能需要先启用本地仓库（点击「启用 Git Graph」按钮自动 git clone 到本地）。',
      lines: [],
      totalCommits: 0,
      truncated: false,
      range: { from: new Date(0).toISOString(), to: new Date(0).toISOString() },
    };
  }

  try {
    const result = await runGraphLog(localCwd, {
      branches: args.branches,
      maxCount: args.limit,
      hidePRRefs: args.hidePRRefs,
    });
    return {
      disabled: false,
      /** 本地仓库路径（用于 Header 小字标注） */
      localPath: localCwd,
      lines: result.lines,
      totalCommits: result.lines.filter((l) => l.commit).length,
      truncated: result.truncated,
      range: result.range,
    };
  } catch (e) {
    // git 子进程失败（仓库 broken / 网络断 / git 未装）→ 让前端看到错误
    logger.warn({ op: 'commits.gitgraph.lines', err: String(e) }, 'git log --graph failed');
    if (e instanceof IpcError) throw e;
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: 'git log --graph 失败',
      hint: (e as Error).message ?? String(e),
    });
  }
}

// ===== commits.gitgraph.cloneRepo（v1.5 启用 Git Graph）=====

interface CloneRepoResp {
  cwd: string;
  stdout: string;
  /** 是否复用已有仓库（true = 没 clone，用了用户已有路径） */
  reused: boolean;
}

/**
 * v1.5：自动 git clone 仓库到本地（带 token），路径持久化到 localStore
 *
 * 流程：
 *   1. 读 localStore 看 projectId 已有 localPath → 有就复用（只 fetch）
 *   2. 没有 → 用 suggestLocalRepoPath(owner, repo) 算默认路径 → clone
 *   3. clone 成功后 saveLocalRepoPath(projectId, cwd)
 *   4. 立即 `git remote set-url` 去掉 token（防止 .git/config 留存）
 *
 * 鉴权：token 从 keychain 内存读，**不持久化**
 */
async function commitsGitGraphCloneRepoHandler(args: CloneRepoArgs): Promise<CloneRepoResp> {
  const proj = resolveProject(args.projectId);
  // token 从 keychain 读（async，OK 在 handler 内 await）
  const token = (await keychainGet(proj.giteaUrl, proj.username)) ?? '';

  // 1. 已有 localPath → 复用
  const existing = listLocalRepoPath(args.projectId);
  if (existing && repoPathExists(existing)) {
    return { cwd: existing, stdout: '(reused)', reused: true };
  }

  // 2. 决定 cwd
  const cwd = args.cwd?.trim() || suggestLocalRepoPath(proj.owner, proj.repo);
  if (repoPathExists(cwd)) {
    // 路径已存在且是 git 仓库 → 保存并复用
    saveLocalRepoPath(args.projectId, cwd);
    return { cwd, stdout: '(reused existing)', reused: true };
  }

  // 3. clone（带 token；clone 后立即清掉）
  const result = await cloneRepo({
    giteaUrl: proj.giteaUrl,
    owner: proj.owner,
    repo: proj.repo,
    token,
    cwd,
    bare: true, // 桌面端不编辑代码，裸仓库足够，省一半磁盘
  });

  // 4. 持久化
  saveLocalRepoPath(args.projectId, result.cwd);

  logger.info(
    { op: 'commits.gitgraph.cloneRepo', cwd: result.cwd, projectId: args.projectId },
    'clone done',
  );
  return { cwd: result.cwd, stdout: result.stdout, reused: false };
}

// ===== 注册 =====

export function registerCommitsIpc(): void {
  wrapIpc(IpcChannel.COMMITS_LIST, ListCommitsArgsSchema, commitsListHandler);
  wrapIpc(IpcChannel.COMMITS_GET, GetCommitArgsSchema, commitsGetHandler);
  wrapIpc(IpcChannel.COMMITS_GITGRAPH_LINES, GitGraphLinesArgsSchema, commitsGitGraphLinesHandler);
  wrapIpc(
    IpcChannel.COMMITS_GITGRAPH_CLONE_REPO,
    CloneRepoArgsSchema,
    commitsGitGraphCloneRepoHandler,
  );
  wrapIpc(IpcChannel.COMMITS_GITGRAPH_PULL, GitGraphPullArgsSchema, commitsGitGraphPullHandler);
}

export function unregisterCommitsIpc(): void {
  ipcMain.removeHandler(IpcChannel.COMMITS_LIST);
  ipcMain.removeHandler(IpcChannel.COMMITS_GET);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_LINES);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_CLONE_REPO);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_PULL);
}

// ===== commits.gitgraph.pull（v1.5.2 pull/merge 按钮）=====

async function commitsGitGraphPullHandler(args: GitGraphPullArgs): Promise<GitGraphPullResp> {
  const localCwd = listLocalRepoPath(args.projectId);
  if (!localCwd) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Git Graph 尚未启用：没有本地仓库',
      hint: '点击「启用 Git Graph」按钮先 git clone 仓库到本地',
    });
  }

  try {
    const result = await pullRepo({ cwd: localCwd });
    logger.info(
      {
        op: 'commits.gitgraph.pull',
        projectId: args.projectId,
        cwd: localCwd,
        addedCommits: result.addedCommits,
      },
      'pull done',
    );
    return {
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      addedCommits: result.addedCommits,
      stdout: result.stdout,
    };
  } catch (e) {
    logger.warn({ op: 'commits.gitgraph.pull', err: String(e) }, 'pull failed');
    if (e instanceof IpcError) throw e;
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: 'git pull --rebase 失败',
      hint: (e as Error).message ?? String(e),
    });
  }
}
