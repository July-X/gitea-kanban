import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const undoEntries = sqliteTable(
  'undo_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    op: text('op').notNull(),                                   // 'card.move' | 'card.delete' | ...
    payload: text('payload').notNull(),                         // JSON 字符串
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    idxUserTime: index('idx_user_time').on(t.userId, t.createdAt),
  }),
);
