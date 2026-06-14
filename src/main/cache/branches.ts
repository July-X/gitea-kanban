/**
 * 分支（starred_branches 业务态 + branches Gitea 缓存）本地层
 *
 * 职责（02-architecture.md §5.3.2 + ADR-0003 Phase 3）：
 * - branches.list 列表缓存 1 min（写在 cache_entries 表，Gitea 缓存层）
 * - branches.star / unstar：纯本地 starred_branches（**走 localStore**，Phase 3 删 SQLite 镜像）
 * - 写操作（create / rename / delete）失效 'branches' 缓存
 *
 * 关键约束：
 * - **不**调 gitea API（gitea 调用在 src/main/gitea/branches.ts）
 * - **不**修改表结构
 *
 * ADR-0003 Phase 3：业务态 starred_branches 走 localStore（**无** SQLite 镜像）；
 *   gitea 缓存层（cache_entries）继续走 SQLite（Phase 3b 单独切）
 */

import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from './sqlite.js';
import { cacheEntries } from './schema/cacheEntries.js';
import { getLocalStore } from '../local/state.js';
import { listStarredBranchesWithStore } from '../local/starred-branches.js';

const CACHE_RESOURCE = 'branches';
/** branches.list 缓存 TTL：1 min（任务 prompt §关键约束 4） */
export const BRANCHES_LIST_TTL_SECONDS = 1 * 60;

/**
 * 列一个 project 下所有 starred 分支名
 *
 * 用于 branches.list 渲染时把 gitea 返回的分支跟本地 starred 状态 JOIN
 * ADR-0003 Phase 2：走 localStore
 */
export function listStarredBranches(projectId: string): Set<string> {
  return listStarredBranchesWithStore(getLocalStore().get(), projectId);
}

/**
 * star / unstar 切换 —— UPSERT 或 DELETE
 * ADR-0003 Phase 2：localStore 写优先，SQLite 镜像（best-effort）
 */
export function setStarred(args: {
  projectId: string;
  branch: string;
  starred: boolean;
}): void {
  const store = getLocalStore();
  if (args.starred) {
    // upsert：localStore 已存在就 nothing，不存在就 push
    const existing = store
      .get()
      .starredBranches.some(
        (s) => s.projectId === args.projectId && s.branch === args.branch,
      );
    if (!existing) {
      const newRow = {
        id: randomUUID(),
        projectId: args.projectId,
        branch: args.branch,
        createdAt: Date.now(),
      };
      store.mutate((s) => {
        s.starredBranches.push(newRow);
      });
    }
  } else {
    // 删除：localStore
    const existingLocal = store
      .get()
      .starredBranches.find(
        (s) => s.projectId === args.projectId && s.branch === args.branch,
      );
    if (existingLocal) {
      store.mutate((s) => {
        s.starredBranches = s.starredBranches.filter(
          (s) => !(s.projectId === args.projectId && s.branch === args.branch),
        );
      });
    }
  }
  // star 是本地操作；不失效 gitea 资源缓存（gitea 不知道这回事）
  // 但 branches.list 缓存需要失效（star 状态变了）
  invalidateBranchesCache(args.projectId);
}

// ===== cache_entries（branches 资源级缓存）=====

/**
 * 读 branches 缓存
 *
 * 按 (projectId, resource, key) 三个字段查——避免跨 projectId 误命中
 */
export function getBranchesCache(args: {
  projectId: string;
  cacheKey: string;
}): string | null {
  const db = getDb();
  const row = db
    .select()
    .from(cacheEntries)
    .where(
      and(
        eq(cacheEntries.repoProjectId, args.projectId),
        eq(cacheEntries.resource, CACHE_RESOURCE),
        eq(cacheEntries.key, args.cacheKey),
      ),
    )
    .all()[0];
  if (!row) return null;
  const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt.getTime() : new Date(row.fetchedAt).getTime();
  const ageSeconds = (Date.now() - fetchedAt) / 1000;
  if (ageSeconds > row.ttlSeconds) {
    return null;
  }
  return row.payload;
}

/**
 * 写 branches 缓存
 */
export function setBranchesCache(args: {
  projectId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  const db = getDb();
  const ttl = args.ttlSeconds ?? BRANCHES_LIST_TTL_SECONDS;
  // upsert 必须按唯一索引 (repoProjectId, resource, key) 三个字段查
  // —— 否则跨 projectId 同 key 会互相覆盖
  const existing = db
    .select()
    .from(cacheEntries)
    .where(
      and(
        eq(cacheEntries.repoProjectId, args.projectId),
        eq(cacheEntries.resource, CACHE_RESOURCE),
        eq(cacheEntries.key, args.cacheKey),
      ),
    )
    .all()[0];
  if (existing) {
    db.update(cacheEntries)
      .set({
        payload: args.payload,
        fetchedAt: new Date(),
        ttlSeconds: ttl,
      })
      .where(eq(cacheEntries.id, existing.id))
      .run();
  } else {
    db.insert(cacheEntries)
      .values({
        id: randomUUID(),
        repoProjectId: args.projectId,
        resource: CACHE_RESOURCE,
        key: args.cacheKey,
        payload: args.payload,
        fetchedAt: new Date(),
        ttlSeconds: ttl,
      })
      .run();
  }
}

/**
 * 失效 branches 资源的所有缓存条目
 *
 * 触发：branches.create / rename / delete 之后
 */
export function invalidateBranchesCache(projectId?: string): void {
  const db = getDb();
  if (projectId) {
    // 同时清（resource, key）匹配和 (resource, repoProjectId) 匹配
    // 简化：先按 projectId 删（关联的 cache_entries 行有 repoProjectId）
    // 再按 resource 删（兜底，因为 cacheKey 也包含 projectId）
    db.delete(cacheEntries)
      .where(
        and(
          eq(cacheEntries.resource, CACHE_RESOURCE),
          eq(cacheEntries.repoProjectId, projectId),
        ),
      )
      .run();
  } else {
    db.delete(cacheEntries).where(eq(cacheEntries.resource, CACHE_RESOURCE)).run();
  }
}
