/**
 * gitea 分支 API 包装层
 *
 * 契约：02-architecture.md §5.3.2 + §6.2
 *
 * endpoint 清单（02 §6.2 表格）：
 * - GET    /repos/{owner}/{repo}/branches              → list
 * - GET    /repos/{owner}/{repo}/branches/{branch}    → 单分支（lastCommit 用）
 * - POST   /repos/{owner}/{repo}/branches              → create
 * - PATCH  /repos/{owner}/{repo}/branches/{oldName}    → rename（2026-06-10 user 拍板维持 PATCH）
 * - DELETE /repos/{owner}/{repo}/branches/{branch}     → delete
 *
 * 重要偏离（决策项）：
 * - gitea 实际上**没有**原生 rename API（见 02-architecture §7.1 第 4 条
 *   "gitea 实际不支持直接 rename API，走'新建 + 推送 + 删旧'三步"）。
 * - **2026-06-10 user 拍板维持 PATCH**（plans/plan_bff2a100/notes/owner-decisions-cycle2.md §1）：
 *   仍用 PATCH /branches/{oldName} 改 newName，不切三步"新建 + 推送 + 删旧"。
 *   真实 gitea 返 404/405 时，UI 引导到 gitea 页面手动操作（符合 AGENTS §2.6
 *   "v1 跳 gitea 网页"原则）。与 02 §7.1 第 4 条冲突保留，user 拍板承担。
 */

import { giteaFetch } from './client.js';
import type { BranchDto, BranchLastCommitDto } from '../ipc/schema.js';

/** gitea /repos/.../branches 响应子集 */
interface GiteaBranchRaw {
  name: string;
  commit: {
    id: string;
    message?: string;
    author?: { name?: string; email?: string; date?: string };
  };
  protected: boolean;
}

/** gitea 单分支 + commit 合并响应（用于 lastCommit） */
interface GiteaBranchWithCommitRaw {
  name: string;
  commit: {
    id: string;
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
  protected: boolean;
}

/**
 * 拉仓库分支列表
 */
export async function listGiteaBranches(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  page?: number;
  limit?: number;
}): Promise<{ items: BranchDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const raws = await giteaFetch<GiteaBranchRaw[]>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/branches`,
    {
      method: 'GET',
      query: { page, limit },
    },
  );

  const items: BranchDto[] = raws.map((r) => ({
    name: r.name,
    sha: r.commit.id,
    protected: Boolean(r.protected),
    isDefault: false, // 由 IPC handler 跟 repo_projects.defaultBranch 比对后填充
    starred: false, // 由 cache/branches.ts 的 starred_branches JOIN 覆盖
  }));

  return {
    items,
    hasMore: raws.length === limit,
  };
}

/**
 * 拉单个分支（拿 lastCommit 详情用 —— list 返回的 commit message 可能是 truncated）
 */
export async function getGiteaBranchWithCommit(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<BranchLastCommitDto> {
  const raw = await giteaFetch<GiteaBranchWithCommitRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/branches/${encodeURIComponent(args.branch)}`,
    { method: 'GET' },
  );
  return {
    sha: raw.commit.id,
    message: raw.commit.message ?? '',
    author: raw.commit.author?.name ?? '<unknown>',
    date: raw.commit.author?.date ?? new Date(0).toISOString(),
  };
}

/**
 * 创建分支
 *
 * gitea POST body: { new_branch_name, old_branch_name } —— v1.20+ 老字段名是 { name, old_branch_name } 兼容
 */
export async function createGiteaBranch(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  newBranch: string;
  fromBranch: string;
}): Promise<BranchDto> {
  // gitea 实际响应：返回 201 + Branch 对象
  const raw = await giteaFetch<GiteaBranchWithCommitRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/branches`,
    {
      method: 'POST',
      body: {
        new_branch_name: args.newBranch,
        old_branch_name: args.fromBranch,
      },
    },
  );
  return {
    name: raw.name,
    sha: raw.commit.id,
    protected: Boolean(raw.protected),
    isDefault: false,
    starred: false,
    lastCommit: {
      sha: raw.commit.id,
      message: raw.commit.message ?? '',
      author: raw.commit.author?.name ?? '<unknown>',
      date: raw.commit.author?.date ?? new Date().toISOString(),
    },
  };
}

/**
 * 重命名分支 —— PATCH（任务 prompt 拍板）
 *
 * 注意：gitea 本身不直接支持 rename；本实现按任务 prompt 调 PATCH
 */
export async function renameGiteaBranch(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  oldName: string;
  newName: string;
}): Promise<BranchDto> {
  const raw = await giteaFetch<GiteaBranchWithCommitRaw>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/branches/${encodeURIComponent(args.oldName)}`,
    {
      method: 'PATCH',
      body: { name: args.newName },
    },
  );
  return {
    name: raw.name,
    sha: raw.commit.id,
    protected: Boolean(raw.protected),
    isDefault: false,
    starred: false,
  };
}

/**
 * 删除分支
 */
export async function deleteGiteaBranch(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<void> {
  await giteaFetch<void>(
    args.giteaUrl,
    args.username,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/branches/${encodeURIComponent(args.branch)}`,
    { method: 'DELETE' },
  );
}
