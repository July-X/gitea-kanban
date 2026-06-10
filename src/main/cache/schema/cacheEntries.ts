import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { repoProjects } from './repoProjects';

export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    id: text('id').primaryKey(),
    repoProjectId: text('repo_project_id').references(() => repoProjects.id, {
      onDelete: 'cascade',
    }),
    resource: text('resource').notNull(),                       // 'branches' | 'commits' | 'pulls' | ...
    key: text('key').notNull(),                                 // e.g. 'page=1&limit=50&sha=main'
    payload: text('payload').notNull(),                         // JSON 字符串
    fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
  },
  (t) => ({
    uniqResKey: uniqueIndex('uniq_res_key').on(
      t.repoProjectId,
      t.resource,
      t.key,
    ),
    idxFetched: index('idx_fetched').on(t.fetchedAt),
  }),
);
