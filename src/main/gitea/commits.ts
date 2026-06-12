/**
 * gitea commit API包装层（基于 gitea-js）
 *
 * 契约：02-architecture.md §5.3.3 + §6.2
 *
 * endpoint清单（02 §6.2表格）：
 * - GET /repos/{owner}/{repo}/commits?sha=&path=&author=&since=&until=&page=&limit= → list
 * - GET /repos/{owner}/{repo}/git/commits/{sha} → get（单 commit含 additions/deletions/filesChanged）
 *
 * 行为：
 * - list 的 response 不含 additions/deletions/filesChanged（gitea不在 list返回 stats）
 *   →在 CommitDTO上 optional，list不填；get调 git/commits/{sha}拿 stats后填
 * - 父子 commit用 parents[].sha
 * - shortSha = sha.slice(0,7)（gitea习惯，但不强求7字符——gitea自己也允许更短）
 *
 * 业务约束：
 * - **不**做 cache（缓存层在 src/main/cache/commits.ts）
 * - **不**做权限校验（gitea自己管）
 * - **不**做 linkedCards JOIN（缓存层做；DTO留 optional字段）
 *
 * 历史（ADR-0002）：从 openapi-fetch +手写 raw类型改成 gitea-js Commit类型
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
  const stats: CommitStats | undefined = c.stats;
  if (stats) {
    return {
      ...base,
      ...(stats.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats.deletions !== undefined ? { deletions: stats.deletions } : {}),
      ...(stats.total !== undefined ? { filesChanged: stats.total } : {}),
    };
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
 * 端点：
 * - GET /repos/{owner}/{repo}/git/commits/{sha} —— 拿 metadata + stats + 2 字段 files
 * - GET /repos/{owner}/{repo}/git/commits/{sha}.diff —— 拿 raw unified diff 本地解析
 *
 * v1.1.3 · task #23 修正：gitea v1.x `/git/commits/{sha}` 只返 files[].{filename, status}，
 * 不返 additions/deletions/patch。所以并发拉 `.diff` 端点 + parseUnifiedDiff 补全。
 *
 * .diff 端点是 text/plain，不是 JSON —— 走原生 fetch（不调 gitea-js），失败兜底：
 * - diff 端点失败（404/网络）→ files 留空，metadata 仍返（不影响其他功能）
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

  const res = await api.repos.repoGetSingleCommit(args.owner, args.repo, args.sha);
  const raw = unwrapGitea(res, `获取 commit ${args.sha}失败`) as Commit & {
    files?: GiteaFileEntry[];
  };
  const dto = toCommitDto(raw);

  // 并发拉 .diff（失败兜底：不影响主流程）
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
      logger.info({ op: 'commits.get.diff', sha: args.sha, diffLen: diffText.length }, 'diff fetched');
    } else {
      diffFetchError = `HTTP ${dr.status}`;
      logger.warn({ op: 'commits.get.diff', sha: args.sha, status: dr.status }, 'diff fetch non-ok');
    }
  } catch (e) {
    diffFetchError = (e as Error).message;
    logger.warn({ op: 'commits.get.diff', sha: args.sha, err: diffFetchError }, 'diff fetch threw');
  }

  if (diffText) {
    const parsed = parseUnifiedDiff(diffText);
    logger.info({ op: 'commits.get.parse', sha: args.sha, parsedCount: parsed.length }, 'diff parsed');
    const giteaFiles = (raw.files ?? []) as GiteaFileEntry[];
    const files: CommitFileChangeDto[] = mergeToFileChangeDtos(parsed, giteaFiles);
    if (files.length > 0) {
      dto.files = files;
      dto.filesChanged = files.length;
      const adds = files.reduce((s, f) => s + (f.binary ? 0 : (f.additions ?? 0)), 0);
      const dels = files.reduce((s, f) => s + (f.binary ? 0 : (f.deletions ?? 0)), 0);
      dto.additions = adds;
      dto.deletions = dels;
      logger.info({ op: 'commits.get', sha: args.sha, fileCount: files.length, adds, dels }, 'files attached');
    }
  } else if (diffFetchError) {
    logger.warn({ op: 'commits.get', sha: args.sha, diffFetchError }, 'no files attached (diff fetch failed)');
  }

  return dto;
}
