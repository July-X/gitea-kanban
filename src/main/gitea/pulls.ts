/**
 * gitea PR API 包装层
 *
 * 契约：02-architecture.md §5.3.5 + §5.3.6 + §6.2
 *
 * endpoint 清单（02 §6.2 表格）：
 * - GET    /repos/{owner}/{repo}/pulls?state=&page=&limit=           → list
 * - GET    /repos/{owner}/{repo}/pulls/{index}                      → get
 * - POST   /repos/{owner}/{repo}/pulls                              → create
 * - POST   /repos/{owner}/{repo}/pulls/{index}/merge                → merge（**危险操作**）
 *
 * 字段映射（关键决策，02-architecture §5.3.5 + 任务 prompt §9）：
 * - gitea `mergeable: false` → DTO `hasConflicts: true`（人类可读语义）
 * - gitea `merged: true` → DTO `state: 'closed'`（gitea 把 merged PR 视为 closed；我们 DTO 上把
 *   merged 单独存为 boolean，state 仅表达 open/closed；UI 按 merged 决定是否进"已合并"列）
 *
 * 业务约束（02 §5.3.6）：
 * - merge 失败错误码（gitea → DTO）：
 *   - 405/409 "pull request is closed" → CONFLICT
 *   - 409 "merge conflict"              → CONFLICT
 *   - 403 "user is not allowed"         → PERMISSION_DENIED
 *   - 422 "head branch is protected"    → CONFLICT
 * - 业务侧不调 branches.delete（**双确认** 在 UI 层统一做）
 *
 * - **不**做 cache（缓存层在 src/main/cache/pulls.ts）
 * - **不**做 linkedCards JOIN（缓存层做；DTO 留 optional 字段）
 */

import { giteaFetch } from './client.js';
import type { PullDto, MergePrResult, PullState } from '../ipc/schema.js';

/** gitea /repos/.../pulls list/get 响应单条 */
interface GiteaPullRaw {
  index: number;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user?: { login?: string; avatar_url?: string } | null;
  created_at: string;
  updated_at: string;
  mergeable?: boolean;
  has_merge_pull_requests_unsynced?: boolean;
}

/** gitea POST /repos/.../pulls/{index}/merge 响应 */
interface GiteaMergeResultRaw {
  sha?: string;
  merged?: boolean;
  message?: string;
}

/** 拉仓库 PR 列表（分页） */
export async function listGiteaPulls(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  state?: PullState | 'all';
  head?: string;
  base?: string;
  author?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: PullDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const raws = await giteaFetch<GiteaPullRaw[]>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    {
      method: 'GET',
      query: {
        ...(args.state !== undefined ? { state: args.state } : {}),
        ...(args.head !== undefined ? { head: args.head } : {}),
        ...(args.base !== undefined ? { base: args.base } : {}),
        ...(args.author !== undefined ? { author: args.author } : {}),
        page,
        limit,
      },
    },
  );
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
  const raw = await giteaFetch<GiteaPullRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${encodeURIComponent(String(args.index))}`,
    { method: 'GET' },
  );
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
  const raw = await giteaFetch<GiteaPullRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    {
      method: 'POST',
      body: {
        head: args.head,
        base: args.base,
        title: args.title,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.draft !== undefined ? { draft: args.draft } : {}),
      },
    },
  );
  return toPullDto(raw);
}

/**
 * 合并 PR（**危险操作**）
 *
 * gitea 端点：POST /repos/{owner}/{repo}/pulls/{index}/merge
 * body：{ Do: 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'squash-merge', delete_branch_after_merge?, Merge_Message? }
 *
 * 失败错误码（gitea → IpcError）：
 * - 405/409 "pull request is closed" → CONFLICT（PR 已合并或关闭）
 * - 409 "merge conflict"             → CONFLICT（有冲突）
 * - 403 "user is not allowed"        → PERMISSION_DENIED
 * - 422 "head branch is protected"   → CONFLICT
 *
 * 注：业务侧**不**主动调 branches.delete（deleteBranchAfter 透传给 gitea）——
 * UI 层在双确认后再传 true；这是用户决策，任务 prompt §危险信号第 2 条
 */
export async function mergeGiteaPull(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  method: 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'squash-merge';
  deleteBranchAfter?: boolean;
  commitMessage?: string;
}): Promise<MergePrResult> {
  const raw = await giteaFetch<GiteaMergeResultRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${encodeURIComponent(String(args.index))}/merge`,
    {
      method: 'POST',
      body: {
        Do: args.method,
        ...(args.deleteBranchAfter !== undefined ? { delete_branch_after_merge: args.deleteBranchAfter } : {}),
        ...(args.commitMessage !== undefined ? { Merge_Message: args.commitMessage } : {}),
      },
    },
  );
  return {
    sha: raw.sha ?? '',
    merged: raw.merged ?? true, // gitea 200/201 默认 merged=true（成功 = 已合并）
    message: raw.message ?? '',
  };
}

// ===== helper =====

function toPullDto(r: GiteaPullRaw): PullDto {
  const mergeable = r.mergeable !== false; // undefined 视为 true（gitea 未加载完的状态）
  return {
    index: r.index,
    title: r.title,
    state: r.state,
    draft: Boolean(r.draft),
    merged: Boolean(r.merged),
    head: { ref: r.head.ref, sha: r.head.sha },
    base: { ref: r.base.ref, sha: r.base.sha },
    author: {
      username: r.user?.login ?? '<unknown>',
      ...(r.user?.avatar_url ? { avatarUrl: r.user.avatar_url } : {}),
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mergeable,
    // 关键映射：gitea mergeable=false → 我们 hasConflicts=true
    hasConflicts: !mergeable,
  };
}
