/**
 * gitea commit API 包装层
 *
 * 契约：02-architecture.md §5.3.3 + §6.2
 *
 * endpoint 清单（02 §6.2 表格）：
 * - GET /repos/{owner}/{repo}/commits?sha=&path=&author=&since=&until=&page=&limit=  → list
 * - GET /repos/{owner}/{repo}/git/commits/{sha}                                    → get（单 commit 含 additions/deletions/filesChanged）
 *
 * 行为：
 * - list 的 response 不含 additions/deletions/filesChanged（gitea 不在 list 返回 stats）
 *   → 在 CommitDTO 上是 optional，list 不填；get 调 git/commits/{sha} 拿 stats 后填
 * - 父子 commit 用 parents[].sha
 * - shortSha = sha.slice(0, 7)（gitea 习惯，但不强求 7 字符——gitea 自己也允许更短）
 *
 * 业务约束：
 * - **不**做 cache（缓存层在 src/main/cache/commits.ts）
 * - **不**做权限校验（gitea 自己管）
 * - **不**做 linkedCards JOIN（缓存层做；DTO 留 optional 字段）
 */

import { giteaFetch } from './client.js';
import type { CommitDto, CommitAuthorDto, CommitCommitterDto } from '../ipc/schema.js';

/** gitea /repos/.../commits list 响应单条 */
interface GiteaCommitSummaryRaw {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string };
  };
  parents: Array<{ sha: string }>;
  author?: { login?: string; avatar_url?: string } | null;
}

/** gitea /repos/.../git/commits/{sha} 单 commit 详情（list 不会带 stats） */
interface GiteaCommitDetailRaw {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string };
  };
  parents: Array<{ sha: string }>;
  stats?: {
    additions?: number;
    deletions?: number;
    total?: number;
  };
  files?: Array<{ filename: string }>;
  author?: { login?: string; avatar_url?: string } | null;
}

/** 拉仓库 commit 列表（分页） */
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
  const raws = await giteaFetch<GiteaCommitSummaryRaw[]>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits`,
    {
      method: 'GET',
      query: {
        ...(args.sha !== undefined ? { sha: args.sha } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.author !== undefined ? { author: args.author } : {}),
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.until !== undefined ? { until: args.until } : {}),
        page,
        limit,
      },
    },
  );

  const items: CommitDto[] = raws.map((r) => toCommitDto(r));
  return {
    items,
    hasMore: raws.length === limit,
  };
}

/**
 * 拉单个 commit 完整信息（含 stats）
 *
 * gitea 端点：GET /repos/{owner}/{repo}/git/commits/{sha}
 * （注意是 /git/commits/ 不是 /commits/ —— 后者不返回 stats）
 */
export async function getGiteaCommit(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<CommitDto> {
  const raw = await giteaFetch<GiteaCommitDetailRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/git/commits/${encodeURIComponent(args.sha)}`,
    { method: 'GET' },
  );
  return toCommitDto(raw);
}

// ===== helper =====

function toCommitDto(r: GiteaCommitSummaryRaw | GiteaCommitDetailRaw): CommitDto {
  const author: CommitAuthorDto = {
    name: r.commit.author.name,
    email: r.commit.author.email,
    // list 端点会带 author.login + avatar_url；detail 端点也可能带
    ...(r.author?.avatar_url ? { avatarUrl: r.author.avatar_url } : {}),
  };
  const committer: CommitCommitterDto = {
    name: r.commit.committer.name,
    email: r.commit.committer.email,
  };

  // list/dedtail 通用字段
  const base: CommitDto = {
    sha: r.sha,
    shortSha: r.sha.slice(0, 7),
    message: r.commit.message,
    author,
    committer,
    date: r.commit.author.date,
    parents: r.parents.map((p) => p.sha),
  };

  // detail 才有 stats / files
  const detail = r as GiteaCommitDetailRaw;
  if (detail.stats || detail.files) {
    return {
      ...base,
      ...(detail.stats?.additions !== undefined ? { additions: detail.stats.additions } : {}),
      ...(detail.stats?.deletions !== undefined ? { deletions: detail.stats.deletions } : {}),
      ...(detail.files ? { filesChanged: detail.files.length } : {}),
    };
  }
  return base;
}
