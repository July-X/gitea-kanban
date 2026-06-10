import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { repoProjects } from './repoProjects';

export const starredBranches = sqliteTable(
  'starred_branches',
  {
    id: text('id').primaryKey(),
    repoProjectId: text('repo_project_id')
      .notNull()
      .references(() => repoProjects.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    uniqRepoBranch: uniqueIndex('uniq_repo_branch').on(t.repoProjectId, t.branch),
  }),
);
