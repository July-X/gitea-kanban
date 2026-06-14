/**
 * cacheEntries —— Gitea 缓存层唯一保留的表（ADR-0003 Phase 3）
 *
 * 与 src/main/cache/sqlite.ts applyPragmasAndInitSchema 的 raw DDL 保持一致：
 * - payload TEXT NOT NULL （JSON 字符串）
 * - ttl_seconds INTEGER NOT NULL
 * - **无** repoProjectId 外键（业务表已迁 localStore，cache 层不做 FK 约束）
 *
 * 边界（任务 prompt §严格边界）：
 * - **不**碰 IPC 契约
 * - **不**碰 src/renderer/**
 * - **不**改 Gitea 集成
 */
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    id: text('id').primaryKey(),
    /** 业务表已迁 localStore；这里存 gitea_account_id 或 repo "owner/name" 字符串，无 FK */
    repoProjectId: text('repo_project_id'),
    resource: text('resource').notNull(), // 'repos' | 'branches' | 'commits' | 'pulls' | 'timeline'
    key: text('key').notNull(),
    payload: text('payload').notNull(), // JSON 字符串
    fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
  },
  (t) => ({
    uniqResKey: uniqueIndex('uniq_res_key').on(t.repoProjectId, t.resource, t.key),
    idxFetched: index('idx_fetched').on(t.fetchedAt),
  }),
);
