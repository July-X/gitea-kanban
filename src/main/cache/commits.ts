/**
 * commit / PR 卡片关联查询（linkedCards）
 *
 * 职责（02-architecture.md §4.2 + §5.3.3 + §5.3.5 + §5.3.8）：
 * - 给定一组 (kind, owner, repo, refId) → LinkedCardDto[]（按 refId 分组）
 * - 关联链：gitea_refs ←(gitea_ref_id)─ card_links ─(card_id)→ cards ─(column_id)→ board_columns
 * - 用 LEFT JOIN 即使 cards / board_columns 缺失也返空数组（v1 没种子数据时）
 *
 * 边界（关键约束，AGENTS.md §5.1 / 任务 prompt §关键约束 8）：
 * - **不**改表结构（13 业务表 + 1 denorm 缓存表已拍板）
 * - **不**做 gitea_refs 的 UPSERT（那是 task 3 card links 范围）
 * - 写操作（pulls.create / pulls.merge）失效 commits + pulls + branches 资源缓存——本文件不写
 *
 * 缓存层职责（02 §5.3.3 / §5.3.5）：
 * - commits.list / commits.get 缓存（2 min / 5 min TTL）—— 任务 prompt 拍板
 * - pulls.list / pulls.get 缓存（30s / 30s）—— 在 cache/pulls.ts
 * - 写操作（pulls.create / pulls.merge）失效 commits + pulls + branches 资源缓存——本文件不写
 *
 * 注：02-architecture §6.2 表格里 commits TTL 写的是 10 min；
 * 任务 prompt §commits.* 拍板是 2 min（list）+ 5 min（get）——
 * 任务 prompt 优先级更高（worker 不自决），按 prompt 落地。
 */

import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from './sqlite.js';
import { cacheEntries } from './schema/cacheEntries.js';
import { giteaRefs } from './schema/giteaRefs.js';
import { cardLinks } from './schema/cardLinks.js';
import { cards } from './schema/cards.js';
import { boardColumns } from './schema/boardColumns.js';
import type { LinkedCardDto } from '../ipc/schema.js';

// ============================================================
// ===== linkedCards 查询（card_links JOIN gitea_refs JOIN cards JOIN board_columns）=====
// ============================================================

/**
 * 内部：按 (kind, owner, repo, refId[]) 一次 SQL 拿 LinkedCardDto 列表（refId → 列表的 Map）
 *
 * 实现：
 *   gitea_refs ──(gitea_ref_id=id)─ card_links ──(card_id=id)─ cards ──(column_id=id)─ board_columns
 *   WHERE gitea_refs.kind = ? AND gitea_refs.owner = ? AND gitea_refs.repo = ?
 *     AND gitea_refs.ref_id IN (...)
 *
 * 注：使用 sql 模板做 (kind, owner, repo, refId) IN 的多值匹配
 */
function queryLinkedCardsByRefs(args: {
  kind: 'commit' | 'pr';
  owner: string;
  repo: string;
  refIds: ReadonlyArray<string>;
}): Map<string, LinkedCardDto[]> {
  const result = new Map<string, LinkedCardDto[]>();
  if (args.refIds.length === 0) return result;
  for (const id of args.refIds) result.set(id, []);

  const db = getDb();
  // drizzle LEFT JOIN：即使 cards / board_columns 缺失也返空
  const rows = db
    .select({
      refId: giteaRefs.refId,
      cardId: cards.id,
      columnName: boardColumns.name,
    })
    .from(giteaRefs)
    .leftJoin(cardLinks, eq(cardLinks.giteaRefId, giteaRefs.id))
    .leftJoin(cards, eq(cards.id, cardLinks.cardId))
    .leftJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .where(
      and(
        eq(giteaRefs.kind, args.kind),
        eq(giteaRefs.owner, args.owner),
        eq(giteaRefs.repo, args.repo),
        // refIds 多值 IN —— 不用 inArray 因为 refId 是 text 列，inArray 行为同
        inArray(giteaRefs.refId, args.refIds as string[]),
      ),
    )
    .all();

  for (const r of rows) {
    if (!r.cardId || !r.columnName) continue; // LEFT JOIN 缺失 = 跳过
    const list = result.get(r.refId);
    if (list) list.push({ cardId: r.cardId, columnName: r.columnName });
  }
  return result;
}

/**
 * 给 commit SHA 数组批量取 linkedCards
 *
 * 用于 commits.list 渲染时把 gitea 返回的 commit 跟本地卡片关联
 * —— 一次 SQL，避免 N+1
 */
export function getLinkedCardsForCommits(args: {
  owner: string;
  repo: string;
  shas: ReadonlyArray<string>;
}): Map<string, LinkedCardDto[]> {
  return queryLinkedCardsByRefs({
    kind: 'commit',
    owner: args.owner,
    repo: args.repo,
    refIds: args.shas,
  });
}

/**
 * 给 PR index 数组批量取 linkedCards
 *
 * 用于 pulls.list 渲染
 */
export function getLinkedCardsForPulls(args: {
  owner: string;
  repo: string;
  indices: ReadonlyArray<number>;
}): Map<number, LinkedCardDto[]> {
  // 把 indices 转 string，PR refId 在 gitea_refs 表里是 text（按 string 存的）
  const stringIndices = args.indices.map(String);
  const raw = queryLinkedCardsByRefs({
    kind: 'pr',
    owner: args.owner,
    repo: args.repo,
    refIds: stringIndices,
  });
  // 还原成 number key
  const result = new Map<number, LinkedCardDto[]>();
  for (const idx of args.indices) {
    result.set(idx, raw.get(String(idx)) ?? []);
  }
  return result;
}

/**
 * 单 commit 取 linkedCards
 *
 * 用于 commits.get 端点
 */
export function getLinkedCardsForCommit(args: {
  owner: string;
  repo: string;
  sha: string;
}): LinkedCardDto[] {
  return getLinkedCardsForCommits({ owner: args.owner, repo: args.repo, shas: [args.sha] }).get(args.sha) ?? [];
}

/**
 * 单 PR 取 linkedCards
 */
export function getLinkedCardsForPull(args: {
  owner: string;
  repo: string;
  index: number;
}): LinkedCardDto[] {
  return getLinkedCardsForPulls({ owner: args.owner, repo: args.repo, indices: [args.index] }).get(args.index) ?? [];
}

// ============================================================
// ===== cache_entries（commits 资源级缓存）=====
// ============================================================

const CACHE_RESOURCE = 'commits';
/** commits.list 缓存 TTL：2 min（任务 prompt §commits.* 拍板） */
export const COMMITS_LIST_TTL_SECONDS = 2 * 60;
/** commits.get 缓存 TTL：5 min（任务 prompt §commits.* 拍板） */
export const COMMITS_GET_TTL_SECONDS = 5 * 60;

/** 读 commits 缓存 */
export function getCommitsCache(args: {
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

/** 写 commits 缓存 */
export function setCommitsCache(args: {
  projectId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  const db = getDb();
  const ttl = args.ttlSeconds ?? COMMITS_LIST_TTL_SECONDS;
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
 * 失效 commits 资源的所有缓存条目
 *
 * 触发：commits.* 写操作（目前 v1 没有，未来 commits.create 等会有）
 * 也被 pulls.merge 调用以清掉合并后受影响的 commits 缓存
 */
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
