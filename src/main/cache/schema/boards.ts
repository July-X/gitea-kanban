import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { repoProjects } from './repoProjects';

export const boards = sqliteTable(
  'boards',
  {
    id: text('id').primaryKey(),
    repoProjectId: text('repo_project_id')
      .notNull()
      .references(() => repoProjects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    layout: text('layout').notNull().default('kanban'),     // kanban | timeline | split
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    uniqRepoBoard: uniqueIndex('uniq_repo_board').on(t.repoProjectId),
  }),
);
