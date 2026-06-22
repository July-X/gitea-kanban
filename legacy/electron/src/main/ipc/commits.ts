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
  GitGraphSetWorkspaceArgsSchema,
  type GraphLinesDto,
  type GitGraphPullArgs,
  type GitGraphPullResp,
  type GitGraphSetWorkspaceArgs,
  type GitGraphSetWorkspaceResp,
  type GitGraphGetWorkspaceResp,
  type CloneRepoArgs,
  ListWorkspaceReposArgsSchema,
  type ListWorkspaceReposArgs,
  type ListWorkspaceReposResp,
  MigrateWorkspaceArgsSchema,
  type MigrateWorkspaceArgs,
  type MigrateWorkspaceResp,
  OpenDirectoryArgsSchema,
  type OpenDirectoryArgs,
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
import { getGiteaClient, unwrapGitea } from '../gitea/client.js';
import {
  runGraphLog,
  cloneRepo,
  suggestLocalRepoPath,
  repoPathExists,
  pullRepo,
} from '../gitgraph/gitProcess.js';
import { listLocalRepoPath, saveLocalRepoPath } from '../local/gitgraphPaths.js';
import {
  getWorkspacePath,
  setWorkspacePath,
  resolveDefaultWorkspacePath,
  validateWorkspacePath,
} from '../local/workspace.js';
import { keychainGet } from '../gitea/keychain.js';
import { existsSync } from 'node:fs';
import { readdir, stat, cp, mkdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { shell } from 'electron';
import { getMainWindow } from '../window.js';
import { IpcEvent } from '../../shared/ipc-channels.js';

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

    // v1.6 enrich：从 Gitea API 拿协作者头像，补充到 graph line 的 authorAvatar
    // 静默失败（不影响 graph 主流程）
    try {
      const proj = resolveProject(args.projectId);
      const { api } = await getGiteaClient(proj.giteaUrl, proj.username);
      const res = await api.repos.repoListCollaborators(proj.owner, proj.repo, { limit: 50 });
      const users = unwrapGitea(res, '');
      // 构建 fullName → avatarUrl 和 username → avatarUrl 映射
      const avatarByName = new Map<string, string>();
      const avatarByUsername = new Map<string, string>();
      for (const u of users) {
        const url = u.avatar_url ?? '';
        if (!url) continue;
        if (u.full_name) avatarByName.set(u.full_name, url);
        if (u.login) avatarByUsername.set(u.login, url);
      }
      // 给每个 graph line 补头像
      for (const line of result.lines) {
        if (!line.commit || line.commit.authorAvatar) continue;
        const byName = avatarByName.get(line.commit.authorName);
        if (byName) {
          line.commit.authorAvatar = byName;
        }
      }
    } catch {
      // enrich 失败静默（头像不是必需的）
    }

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

  // 2. 决定 cwd（await 因为 suggestLocalRepoPath 现在异步 import workspace）
  const cwd = args.cwd?.trim() || (await suggestLocalRepoPath(proj.owner, proj.repo));
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
  // getWorkspace 无入参，用空对象 schema 避免校验出参字段
  wrapIpc(
    IpcChannel.COMMITS_GITGRAPH_GET_WORKSPACE,
    { parse: () => ({}) },
    commitsGitGraphGetWorkspaceHandler,
  );
  wrapIpc(
    IpcChannel.COMMITS_GITGRAPH_SET_WORKSPACE,
    GitGraphSetWorkspaceArgsSchema,
    commitsGitGraphSetWorkspaceHandler,
  );
  // v1.6 workspace 迁移
  wrapIpc(
    IpcChannel.COMMITS_GITGRAPH_LIST_WORKSPACE_REPOS,
    ListWorkspaceReposArgsSchema,
    listWorkspaceReposHandler,
  );
  wrapIpc(
    IpcChannel.COMMITS_GITGRAPH_MIGRATE_WORKSPACE,
    MigrateWorkspaceArgsSchema,
    migrateWorkspaceHandler,
  );
  wrapIpc(
    IpcChannel.COMMITS_GITGRAPH_OPEN_DIRECTORY,
    OpenDirectoryArgsSchema,
    openDirectoryHandler,
  );
}

export function unregisterCommitsIpc(): void {
  ipcMain.removeHandler(IpcChannel.COMMITS_LIST);
  ipcMain.removeHandler(IpcChannel.COMMITS_GET);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_LINES);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_CLONE_REPO);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_PULL);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_GET_WORKSPACE);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_SET_WORKSPACE);
  // v1.6 workspace 迁移
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_LIST_WORKSPACE_REPOS);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_MIGRATE_WORKSPACE);
  ipcMain.removeHandler(IpcChannel.COMMITS_GITGRAPH_OPEN_DIRECTORY);
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

// ===== commits.gitgraph.getWorkspace / setWorkspace（v1.5.3 应用工作区）=====

/**
 * 读当前 workspace 路径
 * - localStore 没存 → 用默认 ~/.gitea-kanban/workspace 并自动 setWorkspace（lazy init）
 * - 有 → 校验存在性 + 可写
 */
async function commitsGitGraphGetWorkspaceHandler(): Promise<GitGraphGetWorkspaceResp> {
  let cwd = getWorkspacePath();
  if (!cwd) {
    cwd = resolveDefaultWorkspacePath();
    setWorkspacePath(cwd);
  }
  const v = await validateWorkspacePath(cwd);
  return {
    cwd,
    isDefault: cwd === resolveDefaultWorkspacePath(),
    validated: v.ok,
  };
}

/**
 * 用户设置新 workspace 路径（SettingsView / AuthView 用）
 * - 校验：存在 + 是目录 + 可写
 * - mkdir -p（不存在时）
 * - 持久化到 prefs
 * - 返回新 cwd + 仓库路径模板（提示用户后续 gitgraph 仓库会放哪）
 */
async function commitsGitGraphSetWorkspaceHandler(
  args: GitGraphSetWorkspaceArgs,
): Promise<GitGraphSetWorkspaceResp> {
  const cwd = args.cwd.trim();

  // 校验
  const v = await validateWorkspacePath(cwd);
  if (!v.ok) {
    throw new IpcError({
      code: IpcErrorCode.VALIDATION_FAILED,
      message: `workspace 路径不可用：${v.reason ?? '未知'}`,
      hint: `检查路径是否正确且当前用户可写：${cwd}`,
    });
  }

  setWorkspacePath(cwd);
  logger.info({ cwd }, 'workspace: updated');

  return {
    cwd,
    suggestedRepoCwdTemplate: `${cwd}${sep}repos${sep}\${owner}__\${repo}.git`,
  };
}

// ===== v1.6 workspace 迁移（listRepos / migrate / openDirectory）=====

/** 递归计算目录大小（字节） */
async function dirSizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {
          /* 跳过不可读文件 */
        }
      }
    }
  } catch {
    /* 目录不可读 → 返回已累计值 */
  }
  return total;
}

/**
 * 列出旧工作区 repos/ 子目录下的所有仓库
 *
 * 扫描 `{cwd}/repos/` 下的子目录（bare repo 命名为 `{owner}__{repo}.git`），
 * 返回每个仓库的名称、完整路径和大小。
 */
async function listWorkspaceReposHandler(
  args: ListWorkspaceReposArgs,
): Promise<ListWorkspaceReposResp> {
  const reposDir = join(args.cwd, 'repos');
  if (!existsSync(reposDir)) {
    return { repos: [], totalSizeBytes: 0 };
  }

  const entries = await readdir(reposDir, { withFileTypes: true });
  const repos: ListWorkspaceReposResp['repos'] = [];
  let totalSizeBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(reposDir, entry.name);
    const sizeBytes = await dirSizeBytes(fullPath);
    repos.push({ name: entry.name, fullPath, sizeBytes });
    totalSizeBytes += sizeBytes;
  }

  // 按名称排序，保证顺序稳定
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { repos, totalSizeBytes };
}

/**
 * 迁移仓库：从旧工作区复制到新工作区
 *
 * 逐个仓库复制（cp -r），每复制完一个就通过 webContents.send 推进度事件给渲染端。
 * 复制完成后更新 localStore 里的 per-project 路径。
 */
async function migrateWorkspaceHandler(
  args: MigrateWorkspaceArgs,
): Promise<MigrateWorkspaceResp> {
  const oldReposDir = join(args.oldCwd, 'repos');
  const newReposDir = join(args.newCwd, 'repos');
  const win = getMainWindow();

  // 确保新工作区 repos 目录存在
  await mkdir(newReposDir, { recursive: true });

  const failed: Record<string, string> = {};
  let migratedCount = 0;
  const total = args.repoNames.length;

  for (let i = 0; i < total; i++) {
    const name = args.repoNames[i];
    const src = join(oldReposDir, name);
    const dest = join(newReposDir, name);

    // 推进度（当前正在处理第 i+1 个，总数 total）
    if (win && !win.isDestroyed()) {
      win.webContents.send(`event:${IpcEvent.WORKSPACE_MIGRATE_PROGRESS}`, {
        current: i + 1,
        total,
        repoName: name,
        phase: 'copying' as const,
      });
    }

    try {
      if (!existsSync(src)) {
        failed[name] = '源目录不存在';
        continue;
      }
      if (existsSync(dest)) {
        // 目标已存在 → 跳过（不覆盖）
        failed[name] = '目标目录已存在，跳过';
        continue;
      }
      // 递归复制（Node 16.7+ cp with recursive）
      await cp(src, dest, { recursive: true });
      migratedCount++;

      // 推进度：该仓库复制完成
      if (win && !win.isDestroyed()) {
        win.webContents.send(`event:${IpcEvent.WORKSPACE_MIGRATE_PROGRESS}`, {
          current: i + 1,
          total,
          repoName: name,
          phase: 'done' as const,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed[name] = msg;
      logger.warn({ err: e, src, dest }, 'workspace migrate: repo copy failed');

      // 推进度：失败
      if (win && !win.isDestroyed()) {
        win.webContents.send(`event:${IpcEvent.WORKSPACE_MIGRATE_PROGRESS}`, {
          current: i + 1,
          total,
          repoName: name,
          phase: 'error' as const,
          error: msg,
        });
      }
    }
  }

  // 更新 localStore 里的 per-project 路径（把旧路径前缀替换为新路径前缀）
  // gitgraph.localPath.{projectId} 存的是完整路径，需要批量更新
  const { listAllLocalRepoPaths, updateLocalRepoPaths } = await import(
    '../local/gitgraphPaths.js'
  );
  const allPaths = listAllLocalRepoPaths();
  const updates: Record<string, string> = {};
  for (const [projectId, oldPath] of Object.entries(allPaths)) {
    if (oldPath.startsWith(oldReposDir)) {
      const relative = oldPath.slice(oldReposDir.length);
      updates[projectId] = join(newReposDir, relative);
    }
  }
  if (Object.keys(updates).length > 0) {
    updateLocalRepoPaths(updates);
    logger.info(
      { count: Object.keys(updates).length },
      'workspace migrate: updated per-project paths',
    );
  }

  logger.info({ migratedCount, failedCount: Object.keys(failed).length }, 'workspace migrate: done');
  return { migratedCount, failed };
}

/**
 * 在系统文件管理器中打开指定目录（Finder / Explorer / xdg-open）
 */
async function openDirectoryHandler(args: OpenDirectoryArgs): Promise<void> {
  const targetPath = args.path;
  if (!existsSync(targetPath)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '目录不存在',
      hint: `路径：${targetPath}`,
    });
  }
  shell.showItemInFolder(targetPath);
}
