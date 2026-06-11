/**
 * gitea PR API包装层（基于 gitea-js）
 *
 * 契约：02-architecture.md §5.3.5 + §5.3.6 + §6.2
 *
 * endpoint清单（02 §6.2表格）：
 * - GET /repos/{owner}/{repo}/pulls?state=&page=&limit= → list
 * - GET /repos/{owner}/{repo}/pulls/{index} → get
 * - POST /repos/{owner}/{repo}/pulls → create
 * - POST /repos/{owner}/{repo}/pulls/{index}/merge → merge（**危险操作**）
 *
 * 字段映射（关键决策，02-architecture §5.3.5 +任务 prompt §9）：
 * - gitea `mergeable: false` → DTO `hasConflicts: true`（人类可读语义）
 * - gitea `merged: true` → DTO `state: 'closed'`（gitea把 merged PR视为 closed；我们 DTO上把
 *   merged单独存为 boolean，state仅表达 open/closed；UI按 merged决定是否进"已合并"列）
 *
 * 业务约束（02 §5.3.6）：
 * - merge失败错误码（gitea → DTO）：
 *   -405/409 "pull request is closed" → CONFLICT
 *   -409 "merge conflict" → CONFLICT
 *   -403 "user is not allowed" → PERMISSION_DENIED
 *   -422 "head branch is protected" → CONFLICT
 *   -业务侧不调 branches.delete（**双确认**在 UI层统一做）
 *
 * - **不**做 cache（缓存层在 src/main/cache/pulls.ts）
 * - **不**做 linkedCards JOIN（缓存层做；DTO留 optional字段）
 *
 * 历史（ADR-0002）：从 openapi-fetch +手写 raw类型改成 gitea-js PullRequest类型
 */

import type { PullRequest } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { PullDto, MergePrResult, PullState } from '../ipc/schema.js';

/** gitea-js PullRequest → 业务 DTO。所有字段全 optional，fallback 处理。 */
function toPullDto(r: PullRequest): PullDto {
  // gitea-js 用 number 字段（仓库内递增编号），不用 id
  const number = r.number ?? r.id ?? 0;
  // undefined mergeable 视为 true（gitea 还在加载）
  const mergeable = r.mergeable !== false;
  return {
    index: number,
    title: r.title ?? '',
    state: (r.state === 'closed' ? 'closed' : 'open'),
    draft: Boolean(r.draft),
    merged: Boolean(r.merged),
    head: { ref: r.head?.ref ?? '', sha: r.head?.sha ?? '' },
    base: { ref: r.base?.ref ?? '', sha: r.base?.sha ?? '' },
    author: {
      username: r.user?.login ?? '<unknown>',
      ...(r.user?.avatar_url ? { avatarUrl: r.user.avatar_url } : {}),
    },
    createdAt: r.created_at ?? new Date(0).toISOString(),
    updatedAt: r.updated_at ?? new Date(0).toISOString(),
    mergeable,
    // 关键映射：gitea mergeable=false → 我们 hasConflicts=true
    hasConflicts: !mergeable,
  };
}

/** 拉仓库 PR列表（分页） */
export async function listGiteaPulls(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  state?: PullState | 'all';
  sort?: string;
  labels?: string;
  milestone?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: PullDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoListPullRequests(args.owner, args.repo, {
    ...(args.state !== undefined ? { state: args.state } : {}),
    page,
    limit,
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/pulls列表失败`);

  const items = raws.map(toPullDto);
  return { items, hasMore: raws.length === limit };
}

/** 拉单个 PR */
export async function getGiteaPull(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
}): Promise<PullDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoGetPullRequest(args.owner, args.repo, args.index);
  const raw = unwrapGitea(res, `获取 PR #${args.index}失败`);
  return toPullDto(raw);
}

/** 创建 PR */
export async function createGiteaPull(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}): Promise<PullDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoCreatePullRequest(args.owner, args.repo, {
    head: args.head,
    base: args.base,
    title: args.title,
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.draft !== undefined ? { draft: args.draft } : {}),
  });
  const raw = unwrapGitea(res, `创建 PR失败`);
  return toPullDto(raw);
}

/**
 * 合并 PR（**危险操作**）
 *
 * gitea端点：POST /repos/{owner}/{repo}/pulls/{index}/merge
 * body：{ Do: 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'fast-forward-only' | 'manually-merged', delete_branch_after_merge?, MergeMessageField? }
 *
 * 失败错误码（gitea → IpcError）：
 * -405/409 "pull request is closed" → CONFLICT（PR已合并或关闭）
 * -409 "merge conflict" → CONFLICT（有冲突）
 * -403 "user is not allowed" → PERMISSION_DENIED
 * -422 "head branch is protected" → CONFLICT
 *
 * 注：业务侧**不**主动调 branches.delete（deleteBranchAfter透传给 gitea）——
 * UI层在双确认后再传 true；这是用户决策，任务 prompt §危险信号第2条
 */
export async function mergeGiteaPull(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  method: 'merge' | 'rebase' | 'rebase-merge' | 'squash';
  deleteBranchAfter?: boolean;
  commitMessage?: string;
}): Promise<MergePrResult> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoMergePullRequest(args.owner, args.repo, args.index, {
    Do: args.method,
    ...(args.deleteBranchAfter !== undefined ? { delete_branch_after_merge: args.deleteBranchAfter } : {}),
    ...(args.commitMessage !== undefined ? { MergeMessageField: args.commitMessage } : {}),
  });
  // 合并成功时 gitea 通常 200 + 空 body；gitea-js res.data 是 void
  // 走 ok 分支：返回基本成功标识
  if (res.ok) {
    return {
      sha: '',
      merged: true,
      message: 'merge success',
    };
  }
  // 失败时 gitea-js res.data 也有内容，统一丢给 unwrapGitea 抛 IpcError
  const raw = unwrapGitea(res, `合并 PR #${args.index}失败`) as { sha?: string; merged?: boolean; message?: string } | undefined;
  return {
    sha: raw?.sha ?? '',
    merged: raw?.merged ?? true,
    message: raw?.message ?? '',
  };
}
