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
import type { CommitDto, CommitAuthorDto, CommitCommitterDto } from '../ipc/schema.js';

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

  // detail 才有 stats / files
  const stats: CommitStats | undefined = c.stats;
  if (stats || c.files) {
    return {
      ...base,
      ...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
      ...(c.files ? { filesChanged: c.files.length } : {}),
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
 * 拉单个 commit完整信息（含 stats）
 *
 * gitea端点：GET /repos/{owner}/{repo}/git/commits/{sha}
 * （注意是 /git/commits/ 不是 /commits/ ——后者不返回 stats）
 */
export async function getGiteaCommit(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<CommitDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoGetSingleCommit(args.owner, args.repo, args.sha);
  const raw = unwrapGitea(res, `获取 commit ${args.sha}失败`);
  return toCommitDto(raw);
}
