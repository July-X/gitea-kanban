/**
 * gitea仓库 API包装层（基于 gitea-js）
 *
 * 契约：02-architecture.md §5.3.1 + §6.2
 * 职责：
 * - 调 gitea /user/repos
 * - 调 gitea /repos/{owner}/{repo}/collaborators + /collaborators/{user}/permission
 *   （a1 扩展：Members view 拉仓库成员用；DTO 走 CollaboratorDto）
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
 * - a1（2026-06-12）：新增 listRepoCollaborators + CollaboratorDto
 */

import type { Repository, User } from 'gitea-js';
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

// ============================================================
// ===== 仓库成员（collaborators）—— a1 新增 =====================
// ============================================================

/**
 * 仓库成员 DTO（Members view 用）
 *
 * 字段来源：
 * - username / avatarUrl ← gitea-js User（来自 /repos/{owner}/{repo}/collaborators）
 * - permission           ← gitea RepoCollaboratorPermission（来自 per-user /permission 端点）
 *                          'unknown' = 取权限失败（per-user 403 / 404 / 5xx 等降级）
 *
 * 历史（2026-06-12 a1）：
 * - gitea /collaborators 列表端点**不**带 per-user permission（只列用户名）
 * - per-user 权限走独立端点 /repos/{owner}/{repo}/collaborators/{user}/permission
 * - v1 简化：parallel fetch，one user fail 不影响其它（try/catch per user）
 * - 大仓库 N+1 风险 v2 评估（可考虑 gitea team API 或前端懒加载）
 */
export interface CollaboratorDto {
  username: string;
  avatarUrl?: string;
  /**
   * gitea 权限字符串：'read' | 'write' | 'admin' | 'owner'（gitea 自定义语义）。
   * 'unknown' = 取权限失败（per-user 端点 403 / 404 / 5xx）；前端展示成"—"。
   */
  permission: string;
}

export interface ListGiteaCollaboratorsResult {
  items: CollaboratorDto[];
  hasMore: boolean;
}

/**
 * 拉仓库成员列表（带 per-user 权限）
 *
 * endpoint 组合：
 * - GET /repos/{owner}/{repo}/collaborators?page=&limit=  → User[]（只取 username / avatar）
 * - GET /repos/{owner}/{repo}/collaborators/{user}/permission  → RepoCollaboratorPermission
 *   （per-user，parallel；任一失败 → 该用户 permission = 'unknown'）
 *
 * 设计权衡（a1 §7.2 自决）：
 * - 不用 N+1 走全部 pages：v1 假定单页（limit=50）足够覆盖大多数仓库
 * - per-user 权限取失败不 throw：避免一个 user 403 把整个列表带崩
 * - 整体抛错（401/403/404 等）走 unwrapGitea → IpcError
 */
export async function listRepoCollaborators(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  page?: number;
  limit?: number;
}): Promise<ListGiteaCollaboratorsResult> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  // 1. 拉成员 user 列表
  const res = await api.repos.repoListCollaborators(args.owner, args.repo, { page, limit });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/collaborators列表失败`);

  if (raws.length === 0) {
    return { items: [], hasMore: false };
  }

  // 2. per-user permission 并发拉（任一失败 → permission='unknown'）
  const perms = await Promise.all(
    raws.map((u) =>
      api.repos.repoGetRepoPermissions(args.owner, args.repo, u.login ?? '').then(
        (r) => ({ login: u.login ?? '', permResp: r }),
        (err: unknown) => ({ login: u.login ?? '', permResp: null, err }),
      ),
    ),
  );

  const permByLogin = new Map<string, string>();
  for (const p of perms) {
    if (p.permResp && p.permResp.ok) {
      // gitea RepoCollaboratorPermission: { permission?, role_name?, user? }
      const perm = p.permResp.data?.permission;
      permByLogin.set(p.login, perm ?? 'unknown');
    } else if (p.permResp && !p.permResp.ok) {
      // per-user 端点 4xx/5xx → 'unknown'（避免破坏整个列表）
      // 注：v1 不打 pino 日志（避免在 gitea 层 import logger.ts → 拉链 electron，tsx 跑不通）
      // 大仓库降级常见，前端展示 "—" 即可，调试用 console 即可
      if (process.env['DEBUG_COLLAB_PERM']) {
        // eslint-disable-next-line no-console
        console.debug(
          `[repos] collaborator permission 降级: ${args.owner}/${args.repo} user=${p.login} status=${p.permResp.status}`,
        );
      }
      permByLogin.set(p.login, 'unknown');
    } else if (p.permResp === null) {
      // 网络错 / 抛错（Promise.all 第二个参数 rejected 分支）
      // Cycle 2 retry fix：原 WIP 写法 `const errInfo = 'err' in p ? p.err : undefined;`
      // 触发 `error TS2339: Property 'err' does not exist on type ...`
      // （TS 对带 `err?: unknown` 字段的 union 不做 `in` narrowing；详见
      //  plan_32018da5/notes/cycle-1-decision.md §P0-3 + AGENTS §8 待补）
      //
      // 改 type assertion（cycle-1-decision.md 推荐方案 a）：改动小、向后兼容
      const errInfo = (p as { err?: unknown }).err;
      if (process.env['DEBUG_COLLAB_PERM']) {
        // eslint-disable-next-line no-console
        console.debug(
          `[repos] collaborator permission fetch threw: ${args.owner}/${args.repo} user=${p.login} err=${String(errInfo)}`,
        );
      }
      permByLogin.set(p.login, 'unknown');
    }
  }

  const items: CollaboratorDto[] = raws.map((u: User) => {
    const username = u.login ?? '<unknown>';
    return {
      username,
      ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
      // A-3 P3 · W7 修法：full_name 非空才下发（旧 gitea 可能为空，schema 验证过滤）
      ...(u.full_name ? { fullName: u.full_name } : {}),
      permission: permByLogin.get(username) ?? 'unknown',
    };
  });

  return { items, hasMore: raws.length === limit };
}
