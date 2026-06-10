import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { giteaAccounts } from './giteaAccounts';

export const repoProjects = sqliteTable(
  'repo_projects',
  {
    id: text('id').primaryKey(),
    giteaAccountId: text('gitea_account_id')
      .notNull()
      .references(() => giteaAccounts.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch'),
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    uniqAccountRepo: uniqueIndex('uniq_account_repo').on(
      t.giteaAccountId,
      t.owner,
      t.name,
    ),
  }),
);
