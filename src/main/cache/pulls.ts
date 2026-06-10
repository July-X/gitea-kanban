/**
 * pull request 缓存层
 *
 * 职责（02-architecture.md §5.3.5 + §5.3.6 + §6.2）：
 * - pulls.list 列表缓存 30s（写在 cache_entries 表）
 * - pulls.get 单 PR 缓存 30s
 * - pulls.create 写操作：失效 pulls 资源缓存
 * - pulls.merge 写操作：失效 pulls + commits + branches 三个资源缓存
 *
 * 边界：
 * - **不**调 gitea API（gitea 调用在 src/main/gitea/pulls.ts）
 * - **不**改表结构
 * - 失败重试：暂不实现（v1 由 IPC handler 层透传错误给 UI）
 */

import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from './sqlite.js';
import { cacheEntries } from './schema/cacheEntries.js';

const CACHE_RESOURCE = 'pulls';
/** pulls.list 缓存 TTL：30s（任务 prompt §pulls.* 拍板，PR 状态变化频繁） */
export const PULLS_LIST_TTL_SECONDS = 30;
/** pulls.get 缓存 TTL：30s（同 list） */
export const PULLS_GET_TTL_SECONDS = 30;

// ============================================================
// ===== cache_entries（pulls 资源级缓存）=====
// ============================================================

/** 读 pulls 缓存 */
export function getPullsCache(args: {
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

/** 写 pulls 缓存 */
export function setPullsCache(args: {
  projectId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  const db = getDb();
  const ttl = args.ttlSeconds ?? PULLS_LIST_TTL_SECONDS;
  // upsert 按 (repoProjectId, resource, key) 查
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
 * 失效 pulls 资源的所有缓存条目
 *
 * 触发：pulls.create / pulls.merge 之后
 */
export function invalidatePullsCache(projectId?: string): void {
  const db = getDb();
  if (projectId) {
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
