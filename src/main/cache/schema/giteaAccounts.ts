import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const giteaAccounts = sqliteTable(
  'gitea_accounts',
  {
    id: text('id').primaryKey(),
    giteaUrl: text('gitea_url').notNull(),                    // e.g. https://gitea.example.com
    username: text('username').notNull(),                     // gitea 登录用户名
    keychainService: text('keychain_service').notNull(),      // e.g. gitea-kanban@<url>
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    uniqUrlUser: uniqueIndex('uniq_url_user').on(t.giteaUrl, t.username),
  }),
);
