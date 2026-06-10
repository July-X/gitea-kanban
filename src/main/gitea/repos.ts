/**
 * gitea 仓库 API 包装层
 *
 * 契约：02-architecture.md §5.3.1 + §6.2
 *
 * 职责：
 * - 调 gitea HTTP（GET /user/repos 列表）
 * - 把 gitea 响应 → RepoDTO
 * - 错误统一抛 IpcError（client.ts 的 giteaFetch 已映射 HTTP code）
 *
 * 铁律：
 * - 不碰 token（giteaFetch / giteaClient 自己处理 keychain）
 * - 不写 SQLite（持久化在 cache/repos.ts / IPC handler）
 * - 不存 gitea 数据（只做透传 + 转换）
 */

import { giteaFetch } from './client.js';
import type { RepoDto } from '../ipc/schema.js';

/** gitea /user/repos 响应字段子集（我们关心的） */
interface GiteaRepoRaw {
  id: number;
  owner: { login: string; avatar_url?: string };
  name: string;
  full_name: string;
  description: string;
  default_branch: string;
  archived: boolean;
  private: boolean;
  updated_at: string;
  permissions?: {
    pull: boolean;
    push: boolean;
    admin: boolean;
  };
}

/**
 * 拉当前用户可见的仓库列表
 *
 * endpoint: GET /user/repos
 *
 * @param giteaUrl
 * @param username
 * @param query  搜索关键字（gitea 端**不**直接支持 query 过滤——v1 在客户端做大小写不敏感匹配）
 * @param page   1-based
 * @param limit  default 50, max 100
 *
 * 返回值：items + total（gitea 不直接给 total 计数；用 items.length 上界 + 翻页信号）
 * —— gitea /user/repos 响应有 X-Total-Count header 但 openapi-fetch 未必透传；
 *    v1 简化：total = items.length；hasMore = items.length === limit
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
  const raws = await giteaFetch<GiteaRepoRaw[]>(
    args.giteaUrl,
    args.username,
    '/user/repos',
    {
      method: 'GET',
      query: { page, limit },
    },
  );

  // query 过滤在客户端做
  const filtered = args.query
    ? raws.filter((r) => {
        const q = args.query!.toLowerCase();
        return (
          r.full_name.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q)
        );
      })
    : raws;

  const items = filtered.map(rawToRepoDto);
  return {
    items,
    total: items.length,
    hasMore: raws.length === limit, // gitea 还有下一页的信号
  };
}

/** 客户端本地查询过滤（v1 简化版）
 *
 *  任务 prompt 提到 "搜索 + 分页 + 50/页默认"；gitea 本身不直接支持 query 过滤，
 *  我们拉一页后客户端过滤。如果数据量大，后续可以改用 gitea /repos/search。
 */
function rawToRepoDto(r: GiteaRepoRaw): RepoDto {
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? '',
    defaultBranch: r.default_branch || 'main',
    archived: Boolean(r.archived),
    private: Boolean(r.private),
    updatedAt: r.updated_at,
    permissions: {
      pull: Boolean(r.permissions?.pull ?? true),
      push: Boolean(r.permissions?.push ?? false),
      admin: Boolean(r.permissions?.admin ?? false),
    },
    isProject: false, // 由 cache/repos.ts 的 JOIN 覆盖
  };
}
