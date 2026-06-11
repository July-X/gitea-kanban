/**
 * gitea分支 API包装层（基于 gitea-js）
 *
 * 契约：02-architecture.md §5.3.2 + §6.2
 *
 * endpoint清单（02 §6.2表格）：
 * - GET /repos/{owner}/{repo}/branches → list
 * - GET /repos/{owner}/{repo}/branches/{branch} → 单分支（lastCommit用）
 * - POST /repos/{owner}/{repo}/branches → create
 * - PATCH /repos/{owner}/{repo}/branches/{oldName} → rename（2026-06-10 user拍板维持 PATCH）
 * - DELETE /repos/{owner}/{repo}/branches/{branch} → delete
 *
 * 重要偏离（决策项）：
 * - gitea实际上**没有**原生 rename API（见02-architecture §7.1第4条
 *   "gitea实际不支持直接 rename API，走'新建 +推送 +删旧'三步"）。
 * - **2026-06-10 user拍板维持 PATCH**（plans/plan_bff2a100/notes/owner-decisions-cycle2.md §1）：
 *   仍用 PATCH /branches/{oldName}改 newName，不切三步"新建 +推送 +删旧"。
 *   真实 gitea返404/405时，UI引导到 gitea页面手动操作（符合 AGENTS §2.6
 *   "v1跳 gitea网页"原则）。与02 §7.1第4条冲突保留，user拍板承担。
 *
 * 历史（ADR-0002）：从 openapi-fetch +手写 raw类型改成 gitea-js Branch类型
 */

import type { Branch } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { BranchDto, BranchLastCommitDto } from '../ipc/schema.js';

/** gitea-js Branch 字段全是 optional（gitea swagger 习惯），给业务 DTO 做 nullish fallback。 */
function branchToDto(b: Branch): BranchDto {
  return {
    name: b.name ?? '<unknown>',
    sha: b.commit?.id ?? '',
    protected: Boolean(b.protected),
    isDefault: false, // 由 IPC handler 跟 repo_projects.defaultBranch 比对后填充
    starred: false, // 由 cache/branches.ts 的 starred_branches JOIN 覆盖
  };
}

/** gitea-js PayloadCommit → DTO lastCommit 形状 */
function lastCommitToDto(b: Branch): BranchLastCommitDto {
  const c = b.commit;
  return {
    sha: c?.id ?? '',
    message: c?.message ?? '',
    author: c?.author?.name ?? '<unknown>',
    // gitea-js PayloadCommit 字段名是 timestamp（不是 PayloadUser.date）
    date: c?.timestamp ?? new Date(0).toISOString(),
  };
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
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoListBranches(args.owner, args.repo, { page, limit });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/branches列表失败`);

  const items = raws.map(branchToDto);

  return {
    items,
    hasMore: raws.length === limit,
  };
}

/**
 * 拉单个分支（拿 lastCommit详情用 —— list返回的 commit message可能是 truncated）
 */
export async function getGiteaBranchWithCommit(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<BranchLastCommitDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoGetBranch(args.owner, args.repo, args.branch);
  const raw = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/branches/${args.branch}失败`);

  return lastCommitToDto(raw);
}

/**
 * 创建分支
 *
 * gitea POST body: { new_branch_name, old_branch_name }
 */
export async function createGiteaBranch(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  newBranch: string;
  fromBranch: string;
}): Promise<BranchDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoCreateBranch(args.owner, args.repo, {
    new_branch_name: args.newBranch,
    old_branch_name: args.fromBranch,
  });
  const raw = unwrapGitea(res, '创建分支失败');

  return {
    ...branchToDto(raw),
    lastCommit: lastCommitToDto(raw),
  };
}

/**
 * 重命名分支 —— PATCH（任务 prompt拍板）
 *
 * 注意：gitea本身不直接支持 rename；本实现按任务 prompt调 PATCH
 */
export async function renameGiteaBranch(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  oldName: string;
  newName: string;
}): Promise<BranchDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoUpdateBranch(args.owner, args.repo, args.oldName, { name: args.newName });
  const raw = unwrapGitea(res, `重命名分支 ${args.oldName}失败`);

  return branchToDto(raw);
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
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.repoDeleteBranch(args.owner, args.repo, args.branch);
  unwrapGitea(res, `删除分支 ${args.branch}失败`);
}
