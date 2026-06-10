import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { cards } from './cards';
import { giteaRefs } from './giteaRefs';

export const cardLinks = sqliteTable(
  'card_links',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    giteaRefId: text('gitea_ref_id')
      .notNull()
      .references(() => giteaRefs.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('reference'),          // reference | blocks | relates-to
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    uniqCardRef: uniqueIndex('uniq_card_ref').on(t.cardId, t.giteaRefId, t.role),
    idxRefCard: index('idx_ref_card').on(t.giteaRefId, t.cardId),
  }),
);
