/**
 * gitea commit API包装层（基于 gitea-js）
 *
 * 契约：02-architecture.md §5.3.3 + §6.2
 *
 * endpoint清单（02 §6.2 + v1.1.3 #23 修正）：
 * - GET /repos/{owner}/{repo}/commits?sha=&path=&author=&since=&until=&page=&limit=
 *   → list（v1.1.3 修：可加 `stat=true&files=true` 返顶层 stats + files[].{filename, status}）
 * - GET /repos/{owner}/{repo}/git/commits/{sha}.diff → text/plain 拿 raw unified diff
 *
 * 行为（v1.1.3 #23 修正后）：
 * - list 端点**不**带 `stat=true&files=true` 时不返 stats/files → dto.additions/deletions
 *   /filesChanged/files 全部 undefined，UI 显示「—」
 * - get 端点用 `repoGetAllCommits` 配 `stat: true, files: true, sha, limit: 1`：
 *   拿到顶层 stats.{additions,deletions,total}（权威合计）+ files[].{filename, status}
 *   然后并发拉 `.diff` 端点拿 per-file additions/deletions/patch/previousFilename
 * - 父子 commit用 parents[].sha
 * - shortSha = sha.slice(0,7)（gitea习惯，但不强求7字符——gitea自己也允许更短）
 *
 * 业务约束：
 * - **不**做 cache（缓存层在 src/main/cache/commits.ts）
 * - **不**做权限校验（gitea自己管）
 * - **不**做 linkedCards JOIN（缓存层做；DTO留 optional字段）
 *
 * 历史：
 * - ADR-0002：从 openapi-fetch +手写 raw类型改成 gitea-js Commit类型
 * - v1.1.3 #23：从 repoGetSingleCommit 改成 repoGetAllCommits 配 stat/files query
 *   （前者只返 2 字段 files，后者能返完整 stats + files）
 */

import type { Commit, CommitStats } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import { parseUnifiedDiff, mergeToFileChangeDtos } from './diff-parse.js';
import { logger } from '../logger.js';
import type {
  CommitDto,
  CommitAuthorDto,
  CommitCommitterDto,
  CommitFileChangeDto,
} from '../ipc/schema.js';

/**
 * gitea v1.x 服务端 `/git/commits/{sha}` 端点**只**返 files[].{filename, status}
 * 2 字段（v1.1.3 · task #23 修正后实测确认）。
 * additions/deletions/patch/previous_filename/binary_file 都不在响应里 —— 要从
 * `/git/commits/{sha}.diff` 端点拿 raw unified diff 本地解析（diff-parse.ts）。
 *
 * 这里保留 filename/status 用于兜底匹配。
 */
interface GiteaFileEntry {
  filename?: string;
  status?: string;
}

/** gitea-js Commit → 业务 CommitDto，所有 gitea-js 字段都是 optional（swagger 习惯） */
function toCommitDto(c: Commit): CommitDto {
  // gitea-js 字段路径：c.commit.author.name / c.commit.committer.name（RepoCommit.author 是 CommitUser）
  const authorName = c.commit?.author?.name ?? '<unknown>';
  const authorEmail = c.commit?.author?.email ?? '';
  const authorDate = c.commit?.author?.date ?? new Date(0).toISOString();
  const committerName = c.commit?.committer?.name ?? authorName;
  const committerEmail = c.commit?.committer?.email ?? authorEmail;

  // User.avatar_url（顶层 author / committer 是 gitea User，不是 CommitUser）
  const authorAvatar = c.author?.avatar_url;

  const author: CommitAuthorDto = {
    name: authorName,
    email: authorEmail,
    ...(authorAvatar ? { avatarUrl: authorAvatar } : {}),
  };
  const committer: CommitCommitterDto = {
    name: committerName,
    email: committerEmail,
  };

  // list/detail通用字段
  const base: CommitDto = {
    sha: c.sha ?? '',
    shortSha: (c.sha ?? '').slice(0, 7),
    message: c.commit?.message ?? '',
    author,
    committer,
    date: authorDate,
    parents: (c.parents ?? []).map((p) => p.sha ?? '').filter((s) => s !== ''),
  };

  // detail 才有 stats
  // 注意：gitea `stats.total` 是 **additions + deletions 的行数合计**（实测确认），
  // 不是 `files.length`。「改了多少文件」必须用 `c.files.length`。
  // v1.1.3 · task #23 修正：原实现 `filesChanged: stats.total` 在 20 行改动场景下
  // 会显示 20 个文件，但实际只有 4 个 —— 强误导。
  const stats: CommitStats | undefined = c.stats;
  const filesArr = c.files ?? [];
  const hasFiles = filesArr.length > 0;
  if (stats) {
    return {
      ...base,
      ...(stats.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats.deletions !== undefined ? { deletions: stats.deletions } : {}),
      ...(hasFiles ? { filesChanged: filesArr.length } : {}),
    };
  }
  if (hasFiles) {
    return { ...base, filesChanged: filesArr.length };
  }
  return base;
}

/** 拉仓库 commit列表（分页） */
export async function listGiteaCommits(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  sha?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: CommitDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoGetAllCommits(args.owner, args.repo, {
    ...(args.sha !== undefined ? { sha: args.sha } : {}),
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.author !== undefined ? { author: args.author } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
    page,
    limit,
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/commits列表失败`);

  const items = raws.map(toCommitDto);
  return {
    items,
    hasMore: raws.length === limit,
  };
}

/**
 * 拉单个 commit 完整信息（含 stats + files + functions）
 *
 * 端点（v1.1.3 · task #23 修正）：
 * - GET /repos/{owner}/{repo}/commits?sha={sha}&limit=1&stat=true&files=true
 *   ——拿 metadata + 顶层 stats + files[].{filename, status}
 * - GET /repos/{owner}/{repo}/git/commits/{sha}.diff
 *   ——拿 raw unified diff 本地解析（per-file additions/deletions/patch/previousFilename）
 *
 * 为什么不用 `/git/commits/{sha}`（gitea-js `repoGetSingleCommit`）：
 *   实测确认 gitea v1.x 该端点**只**返 files[].{filename, status}，不返 stats/files。
 *   而 `/repos/.../commits?stat=true&files=true` 是列表端点，但通过 `sha + limit: 1`
 *   可以精确定位单个 commit，且 gitea-js 暴露了 `stat / files` 两个 query 参数。
 *
 *   **本实现以 `repoGetAllCommits` 取代 `repoGetSingleCommit`**，原因：
 *   - 拿到顶层 `stats.{additions, deletions, total}`（gitea 权威总计）
 *   - 拿到 `files[].{filename, status}`（用于和 diff 解析结果做 filename 兜底匹配）
 *   - gitea-js 类型层声明有 `files / stats` 字段但 `repoGetSingleCommit` 实际不填；
 *     改走 list 端点后才真正填上
 *
 * .diff 端点是 text/plain，不是 JSON —— 走原生 fetch（不调 gitea-js），失败兜底：
 * - diff 端点失败（404/网络）→ files 留空，metadata + 顶层 stats 仍返（不影响其他功能）
 * - parseUnifiedDiff 解析失败（罕见）→ files 留空
 */
export async function getGiteaCommit(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<CommitDto> {
  const { api, baseUrl, token } = await getGiteaClient(args.giteaUrl, args.username);

  // 1) 走 list 端点 + stat/files query + limit:1 ——拿 metadata + 顶层 stats + files
  const res = await api.repos.repoGetAllCommits(args.owner, args.repo, {
    sha: args.sha,
    limit: 1,
    stat: true,
    files: true,
  });
  const raws = unwrapGitea(res, `获取 commit ${args.sha} 失败`) as Commit[];
  const raw = raws[0];
  if (!raw) {
    // 仓库可能没这个 sha；保留和原 repoGetSingleCommit 行为一致的"返回空 dto"是
    // 不恰当的（前端会拿到 sha='' 误显示），这里抛错让上层 catch + show toast
    throw new Error(`commit ${args.sha} 不存在或仓库不可达`);
  }
  // gitea-js 顶层类型已声明 files/stats 是 optional，但 list 端点带 stat/files 时
  // 实际会填；这里强转补类型让后续代码可读
  const dto = toCommitDto(raw);

  logger.info(
    {
      op: 'commits.get',
      sha: args.sha,
      hasStats: !!raw.stats,
      fileCount: raw.files?.length ?? 0,
      adds: raw.stats?.additions,
      dels: raw.stats?.deletions,
    },
    'list endpoint returned',
  );

  // 2) 并发拉 .diff ——拿 per-file 字段（additions/deletions/patch/previousFilename）
  let diffText: string | null = null;
  let diffFetchError: string | null = null;
  try {
    const diffUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1/repos/${args.owner}/${args.repo}/git/commits/${args.sha}.diff`;
    logger.info({ op: 'commits.get.diff', sha: args.sha, diffUrl }, 'fetching diff');
    const dr = await globalThis.fetch(diffUrl, {
      headers: {
        Accept: 'text/plain',
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
    });
    if (dr.ok) {
      diffText = await dr.text();
      logger.info(
        { op: 'commits.get.diff', sha: args.sha, diffLen: diffText.length },
        'diff fetched',
      );
    } else {
      diffFetchError = `HTTP ${dr.status}`;
      logger.warn(
        { op: 'commits.get.diff', sha: args.sha, status: dr.status },
        'diff fetch non-ok',
      );
    }
  } catch (e) {
    diffFetchError = (e as Error).message;
    logger.warn({ op: 'commits.get.diff', sha: args.sha, err: diffFetchError }, 'diff fetch threw');
  }

  if (diffText) {
    const parsed = parseUnifiedDiff(diffText);
    logger.info(
      { op: 'commits.get.parse', sha: args.sha, parsedCount: parsed.length },
      'diff parsed',
    );
    const giteaFiles = (raw.files ?? []) as GiteaFileEntry[];
    const files: CommitFileChangeDto[] = mergeToFileChangeDtos(parsed, giteaFiles);
    if (files.length > 0) {
      dto.files = files;
      // 顶层 dto.filesChanged 已被 toCommitDto 用 raw.files.length 填过；这里强制
      // 以解析后的 files 长度为准（diff 端点可能含 gitea files 没列出的二进制
      // 文件 —— 用解析结果更准）
      dto.filesChanged = files.length;
      // 注意：dto.additions / dto.deletions 优先信任 gitea 顶层 stats（避免
      // parseUnifiedDiff 的 + / - 行计数和 gitea 权威统计有出入 —— 例如 gitea
      // 会把纯空白行变化排除）。如果 stats 缺失再退回到 diff 合计。
      if (dto.additions === undefined || dto.deletions === undefined) {
        const adds = files.reduce((s, f) => s + (f.binary ? 0 : (f.additions ?? 0)), 0);
        const dels = files.reduce((s, f) => s + (f.binary ? 0 : (f.deletions ?? 0)), 0);
        dto.additions = adds;
        dto.deletions = dels;
      }
      logger.info(
        {
          op: 'commits.get',
          sha: args.sha,
          fileCount: files.length,
          adds: dto.additions,
          dels: dto.deletions,
        },
        'files attached',
      );
    }
  } else if (diffFetchError) {
    logger.warn(
      { op: 'commits.get', sha: args.sha, diffFetchError },
      'no per-file details (diff fetch failed); 顶层 stats 保留',
    );
  }

  return dto;
}
