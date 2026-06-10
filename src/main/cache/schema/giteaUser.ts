import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { giteaAccounts } from './giteaAccounts';

/**
 * denormalized gitea /user 信息
 *
 * 用途：auth.status 不读 keychain、不调 gitea 就能拿到当前 user 头像/邮箱展示
 * 一对一：每个 gitea_account 最多一行（auth.connect 时 upsert）
 */
export const giteaUser = sqliteTable('gitea_user', {
  id: text('id').primaryKey(),
  giteaAccountId: text('gitea_account_id')
    .notNull()
    .references(() => giteaAccounts.id, { onDelete: 'cascade' }),
  giteaUserId: integer('gitea_user_id').notNull(),    // gitea 内部 id（数字）
  login: text('login').notNull(),
  fullName: text('full_name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
