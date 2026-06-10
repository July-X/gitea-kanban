import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { boardColumns } from './boardColumns';

export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    columnId: text('column_id')
      .notNull()
      .references(() => boardColumns.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    position: integer('position').notNull(),
    color: text('color'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    idxColPos: index('idx_col_pos').on(t.columnId, t.position),
  }),
);
