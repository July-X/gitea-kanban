/**
 * gitea milestone API 包装层（基于 gitea-js）
 *
 * v1.4 新增（2026-06-18）：新建议题弹窗选里程碑用。
 *
 * endpoint 清单：
 * - GET /repos/{owner}/{repo}/milestones?state=&page=&limit= → list
 *
 * 设计：
 * - milestones.list 拉仓库全部里程碑（state='all'），供新建议题弹窗下拉选择
 * - v1 不做 milestones.create（在 gitea 管理后台建，UI 跳 gitea）
 * - gitea issueCreateIssue 的 milestone 字段 = milestone id（int64）
 */

import type { Milestone } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { MilestoneDto } from '../ipc/schema.js';

/** gitea-js Milestone → DTO。gitea-js 字段全 optional，fallback 处理。 */
function toMilestoneDto(r: Milestone): MilestoneDto {
  return {
    id: r.id ?? 0,
    title: r.title ?? '',
    state: (r.state as 'open' | 'closed' | 'all') ?? 'open',
    ...(r.description ? { description: r.description } : {}),
  };
}

/** 列仓库 milestones（默认 state='all' 拉全部，供弹窗选择） */
export async function listGiteaMilestones(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  state?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: MilestoneDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const state = args.state ?? 'all';
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueGetMilestonesList(args.owner, args.repo, {
    state,
    page,
    limit,
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/milestones 列表失败`);

  const items = raws.map(toMilestoneDto);
  return { items, hasMore: raws.length === limit };
}
