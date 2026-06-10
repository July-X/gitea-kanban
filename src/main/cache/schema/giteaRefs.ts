import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const giteaRefs = sqliteTable(
  'gitea_refs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),                            // 'commit' | 'pr' | 'branch' | 'issue'
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    refId: text('ref_id').notNull(),                         // sha / pr index / branch name / issue index
    cachedTitle: text('cached_title'),
    cachedAt: integer('cached_at', { mode: 'timestamp' }),
  },
  (t) => ({
    uniqKind: uniqueIndex('uniq_kind').on(t.kind, t.owner, t.repo, t.refId),
  }),
);
