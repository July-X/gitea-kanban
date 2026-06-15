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

import type { HttpResponse, PullRequest } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { PullDto, MergePrResult, PullState } from '../ipc/schema.js';

/** gitea-js PullRequest → 业务 DTO。所有字段全 optional，fallback 处理。 */
function toPullDto(r: PullRequest): PullDto {
  // gitea-js 用 number 字段（仓库内递增编号），不用 id
  const number = r.number ?? r.id ?? 0;
  // mergeable 三值逻辑：true=可合并 / false=有冲突 / undefined=计算中
  // 计算 中 视为不可合并（避免用户误以为无冲突后点合并却失败）
  const mergeable = r.mergeable === true;
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
    // ===== v1.1 补充字段 =====
    labels: (r.labels ?? []).map(l => ({
      id: l.id ?? 0,
      name: l.name ?? '',
      color: l.color ?? '#ccc',
    })),
    milestone: r.milestone ? { id: r.milestone.id ?? 0, title: r.milestone.title ?? '' } : null,
    assignee: r.assignee ? { username: r.assignee.login ?? '' } : null,
    assignees: (r.assignees ?? []).map(a => ({ username: a.login ?? '' })),
    reviewers: (r.requested_reviewers ?? []).map(u => ({ username: u.login ?? '' })),
    mergedBy: r.merged_by ? { username: r.merged_by.login ?? '' } : null,
    commentsCount: r.comments ?? 0,
    body: r.body ?? '',
  };
}

/** gitea-js 透传的 sort 枚举（与 swagger.ListPullRequests.sort 对齐） */
type PullSort =
  | 'oldest'
  | 'recentupdate'
  | 'leastupdate'
  | 'mostcomment'
  | 'leastcomment'
  | 'priority';

/**
 * 拉仓库 PR列表（分页 + 过滤 + 排序）
 *
 * 透传字段（与 gitea-js 1.23.0 `repoListPullRequests` + gitea 1.26 swagger 对齐）：
 * - state     ✓ 透传（PullState | 'all' → 'open' | 'closed' | 'all'）
 * - sort      ✓ 透传（PullSort 6 种枚举）
 * - milestone ✓ 透传（gitea 端是 number，**不**是字符串）
 * - labels    ✓ 透传（gitea 端是 number[] label id 数组，**不**是字符串/label name）
 * - poster    ✓ 透传（gitea 端字段名是 poster；IPC schema 叫 author——是 gitea 端的命名，
 *                      业务层与 IPC schema 解耦，不在 gitea 包装层做命名映射）
 * - page/limit ✓ 透传
 *
 * 不透传的字段（gitea-js 没暴露 + 上游 swagger 有但 gitea-js 漏生成）：
 * - base_branch（gitea 1.26 swagger 有,gitea-js 1.23.0 漏——要支持得 raw fetch,
 *   v1 简化:不支持,UI 走本地 filter）
 *
 * v1 调用方（src/main/ipc/pulls.ts pullsListHandler）实际只传 state/page/limit;
 * sort/milestone/labels/poster 留作 v2 高级过滤扩展
 */
export async function listGiteaPulls(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  state?: PullState | 'all';
  sort?: PullSort;
  milestone?: number;
  labels?: number[];
  poster?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: PullDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoListPullRequests(args.owner, args.repo, {
    ...(args.state !== undefined ? { state: args.state } : {}),
    ...(args.sort !== undefined ? { sort: args.sort } : {}),
    ...(args.milestone !== undefined ? { milestone: args.milestone } : {}),
    ...(args.labels !== undefined ? { labels: args.labels } : {}),
    ...(args.poster !== undefined ? { poster: args.poster } : {}),
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

  try {
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
  } catch (err) {
    // gitea-js 1.23.0 在 fetch 层遇到 !ok 时**直接 throw** 修改过的 Response（HttpResponse 子类）
    //   见 node_modules/gitea-js/dist/index.js:161-162 `if (!response.ok) throw data;`
    // 如果不 catch，这个对象会一路冒到 IPC wrapIpc，被 catch-all 误判成 INTERNAL，
    //   前端只能看到 "应用内部错误" + cause="[object Response]" —— 丢码又丢人话
    // 这里把它当 HttpResponse 处理：走 unwrapGitea 复用 httpErrorToIpcError 映射
    //   - 409 → IpcError(CONFLICT)
    //   - 403 → IpcError(PERMISSION_DENIED)
    //   - 404 → IpcError(NOT_FOUND)
    //   - 422 → IpcError(VALIDATION_FAILED)
    //   - 405 / 其他 → IpcError(GITEA_ERROR)
    if (err && typeof err === 'object' && 'ok' in err && 'status' in err) {
      // 类型守卫：把 unknown 当 HttpResponse 用（gitea-js throw 的就是 HttpResponse）
      const httpErr = err as HttpResponse<unknown, unknown>;
      // unwrapGitea 在 !ok 时一定 throw IpcError（不会 return）
      unwrapGitea(httpErr, `合并 PR #${args.index}失败`);
    }
    // 非 HttpResponse 错误（程序 bug / IO 异常 / 其它）直接抛
    //   wrapIpc 会把它 catch 成 IpcError(INTERNAL) 走通用错误路径
    throw err;
  }
}

/**
 * 关闭合并请求（不合并，直接关闭）—— 对应 gitea PATCH /pulls/{index} {state: 'closed'}
 *
 * gitea 1.26 支持 PATCH /repos/{owner}/{repo}/pulls/{index} 修改 PR 状态。
 * gitea-js 的 repoEditPull 可以改 state。
 */
export async function closeGiteaPull(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  reason?: string;
}): Promise<{ closed: boolean }> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  try {
    // PATCH /repos/{owner}/{repo}/pulls/{index} {state: 'closed'}
    const res = await api.repos.repoEditPullRequest(args.owner, args.repo, args.index, {
      state: 'closed',
    });
    if (res.ok) {
      return { closed: true };
    }
    unwrapGitea(res, `关闭 PR #${args.index}失败`);
    return { closed: true };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'ok' in err && 'status' in err) {
      const httpErr = err as HttpResponse<unknown, unknown>;
      unwrapGitea(httpErr, `关闭 PR #${args.index}失败`);
    }
    throw err;
  }
}

/**
 * 更新合并请求标签 —— 对应 gitea PUT /issues/{index}/labels
 *
 * gitea 把 PR 视为 issue 的子类型，标签操作走 issue API。
 */
export async function updatePullLabels(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  labels: string[];
}): Promise<void> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueReplaceLabels(args.owner, args.repo, args.index, {
    labels: args.labels,
  });
  if (!res.ok) {
    unwrapGitea(res, `更新 PR #${args.index}标签失败`);
  }
}

/**
 * 更新合并请求指派人 —— 对应 gitea PATCH /issues/{index} {assignee}
 */
export async function updatePullAssignee(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  assignee: string;
}): Promise<void> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueEditIssue(args.owner, args.repo, args.index, {
    assignee: args.assignee,
  });
  if (!res.ok) {
    unwrapGitea(res, `更新 PR #${args.index}指派人失败`);
  }
}

/**
 * 更新合并请求评审人 —— 对应 gitea POST /pulls/{index}/requested_reviewers
 *
 * gitea 1.x 限制：评审人不能是组织账号（Organization can't be doer to add reviewer）
 * 调用方传入的 reviewers 应是个人用户名，不能是组织。
 */
export async function updatePullReviewers(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  reviewers: string[];
}): Promise<void> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  try {
    const res = await api.repos.repoCreatePullReviewRequests(args.owner, args.repo, args.index, {
      reviewers: args.reviewers,
    });
    if (res.ok) return;
    unwrapGitea(res, `更新 PR #${args.index}评审人失败`);
  } catch (err: unknown) {
    // gitea-js 失败时直接 throw HttpResponse，必须走 unwrapGitea 映射错误码
    if (err && typeof err === 'object' && 'ok' in err && 'status' in err) {
      const httpErr = err as HttpResponse<unknown, unknown>;
      unwrapGitea(httpErr, `更新 PR #${args.index}评审人失败`);
    }
    throw err;
  }
}
