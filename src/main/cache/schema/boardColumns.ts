import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { boards } from './boards';

export const boardColumns = sqliteTable(
  'board_columns',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    wipLimit: integer('wip_limit'),                              // null = 无限
    hideMergedPr: integer('hide_merged_pr', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    idxBoardPos: index('idx_board_pos').on(t.boardId, t.position),
  }),
);
