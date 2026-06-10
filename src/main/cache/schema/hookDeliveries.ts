import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { repoProjects } from './repoProjects';

export const hookDeliveries = sqliteTable(
  'hook_deliveries',
  {
    id: text('id').primaryKey(),
    repoProjectId: text('repo_project_id').references(() => repoProjects.id, {
      onDelete: 'cascade',
    }),
    deliveryId: text('delivery_id').notNull(),                 // gitea X-Gitea-Delivery
    receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    uniqRepoDelivery: uniqueIndex('uniq_repo_delivery').on(
      t.repoProjectId,
      t.deliveryId,
    ),
    idxReceived: index('idx_received').on(t.receivedAt),
  }),
);
