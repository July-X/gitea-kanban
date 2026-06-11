/**
 * gitea仓库 API包装层（基于 gitea-js）
 *
 * 契约：02-architecture.md §5.3.1 + §6.2
 * 职责：
 * - 调 gitea /user/repos
 * - 把 gitea-js Repository → RepoDTO
 * - 错误统一抛 IpcError（client.ts 的 unwrapGitea 已映射 HTTP code）
 *
 * 铁律：
 * - 不碰 token（getGiteaClient 自己处理 keychain）
 * - 不写 SQLite（持久化在 cache/repos.ts / IPC handler）
 * - 不存 gitea 数据（只做透传 +转换）
 *
 * 历史（ADR-0002）：
 * - 从 openapi-fetch + 手写 GiteaRepoRaw改成 gitea-js 的 Repository 类型
 */

import type { Repository } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { RepoDto } from '../ipc/schema.js';

/**
 * 拉当前用户可见的仓库列表
 *
 * endpoint: GET /user/repos
 *
 * @param giteaUrl
 * @param username
 * @param query 搜索关键字（gitea端**不**直接支持 query过滤——v1在客户端做大小写不敏感匹配）
 * @param page 1-based
 * @param limit default 50, max 100
 *
 * 返回值：items + total（gitea不直接给 total计数；用 items.length上界 +翻页信号）
 * - gitea /user/repos响应有 X-Total-Count header 但 gitea-js 未暴露；
 *   v1简化：total = items.length；hasMore = items.length === limit
 */
export interface ListGiteaReposResult {
  items: RepoDto[];
  total: number;
  hasMore: boolean;
}

export async function listGiteaRepos(args: {
  giteaUrl: string;
  username: string;
  query?: string;
  page?: number;
  limit?: number;
}): Promise<ListGiteaReposResult> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.user.userCurrentListRepos({ page, limit });
  const raws = unwrapGitea(res, '/user/repos列表失败');

  // query 过滤在客户端做
  const filtered = args.query
    ? raws.filter((r) => {
        const q = args.query!.toLowerCase();
        return (
          (r.full_name ?? '').toLowerCase().includes(q) ||
          (r.name ?? '').toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q)
        );
      })
    : raws;

  const items = filtered.map(rawToRepoDto);
  return {
    items,
    total: items.length,
    hasMore: raws.length === limit, // gitea还有下一页的信号
  };
}

/** 客户端本地查询过滤（v1简化版）
 *
 * 任务 prompt提到 "搜索 + 分页 +50/页默认"；gitea本身不直接支持 query过滤，
 * 我们拉一页后客户端过滤。如果数据量大，后续可以改用 gitea /repos/search。
 */
function rawToRepoDto(r: Repository): RepoDto {
  return {
    id: r.id ?? 0,
    owner: r.owner?.login ?? '<unknown>',
    name: r.name ?? '',
    fullName: r.full_name ?? r.name ?? '',
    description: r.description ?? '',
    defaultBranch: r.default_branch || 'main',
    archived: Boolean(r.archived),
    private: Boolean(r.private),
    updatedAt: r.updated_at ?? new Date(0).toISOString(),
    permissions: {
      pull: Boolean(r.permissions?.pull ?? true),
      push: Boolean(r.permissions?.push ?? false),
      admin: Boolean(r.permissions?.admin ?? false),
    },
    isProject: false, // 由 cache/repos.ts 的 JOIN 覆盖
  };
}
