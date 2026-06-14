/**
 * commit / PR 缓存 + linkedCards 查询
 *
 * 职责（02-architecture.md §4.2 + §5.3.3 + §5.3.5 + §5.3.8）：
 * - 缓存 TTL 助手（commits 2 min / 5 min；pulls 30s）
 * - linkedCards 查询：v1 不存 cards 表（ADR-0002 reset）→ linkedCards 永远空 Map
 *   → IPC handler attach 到 DTO 上是空数组，UI 看到正常但**没有** card-link 数据
 *
 * 历史（2026-06-11 reset）：
 * - 旧实现用 `cards` / `card_links` / `boards` 表（gitea 1.26 没 projects API 之前的设计）
 * - ADR-0002 reset 后这三张表删了，cache/commits.ts 跟着 stub
 * - 真正卡-列关系通过 `column_label_mapping`（列绑 gitea label）实现，看板从 gitea issues 派生卡片
 *   → 不会再有"commit 关联卡片"的概念（commit 不绑 label）
 *
 * v2 决策：linkedCards 功能要么彻底砍（commit 跟卡片无强关联），要么改成"commit 跟 PR 关联"——待 v2 评估
 */

import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from './sqlite.js';
import { cacheEntries } from './schema/cacheEntries.js';

const CACHE_RESOURCE = 'commits';

/** v1：commit list 缓存 TTL 2 min */
export const COMMITS_LIST_TTL_SECONDS = 2 * 60;
/** v1：commit get 缓存 TTL 5 min */
export const COMMITS_GET_TTL_SECONDS = 5 * 60;

// ============================================================
// ===== linkedCards（v1 stub）=====
// ============================================================

/** v1 stub：linkedCards 查询永远返空 Map（commit 跟卡片没有直接关联） */
export function getLinkedCardsForCommits(_args: {
  owner: string;
  repo: string;
  shas: string[];
}): Map<string, never[]> {
  return new Map();
}

export function getLinkedCardsForCommit(_args: {
  owner: string;
  repo: string;
  sha: string;
}): never[] {
  return [];
}

export function getLinkedCardsForPulls(_args: {
  owner: string;
  repo: string;
  indexes: number[];
}): Map<number, never[]> {
  return new Map();
}

export function getLinkedCardsForPull(_args: {
  owner: string;
  repo: string;
  index: number;
}): never[] {
  return [];
}

// ============================================================
// ===== cache_entries（commits 资源级缓存）=====
// ============================================================

/** 读 commits 缓存 */
export function getCommitsCache(args: { projectId: string; cacheKey: string }): string | null {
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

/** 写 commits 缓存 */
export function setCommitsCache(args: {
  projectId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  const db = getDb();
  const ttl = args.ttlSeconds ?? COMMITS_LIST_TTL_SECONDS;
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

/** 失效 commits 资源的所有缓存条目 */
export function invalidateCommitsCache(projectId?: string): void {
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
