import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { boardColumns } from './boardColumns.js';
import { repoProjects } from './repoProjects.js';

/**
 *派生缓存：gitea issue 被哪条 gitea-kanban 列"看到"（ADR-0002 §"数据模型"）
 *
 *背景：
 * - gitea issues 带 N 个 label，gitea-kanban 列绑 N 个 label（columnLabelMapping）
 * - 一个 issue命中列 = 它至少有一个 label 被某列绑
 * -派生 = (issue_id, repo_project_id) →第一个命中列（v1简化）
 *
 *写入时机（v1简化）：
 * - 列绑定 label 后，第一次拉 issues.list 时 backfill
 * - issue增删改 label 后增量更新（本任务 v1 不做，靠 ttl失效）
 *
 * v1 可选（ADR-0002："v1 不强求"）；但保留表让 v2启用
 *
 *唯一索引：(repo_project_id, gitea_issue_id) —— 同 repo 下同 issue 只一行
 */
export const cardIssueLink = sqliteTable(
 'card_issue_link',
 {
 id: text('id').primaryKey(),
 repoProjectId: text('repo_project_id')
 .notNull()
 .references(() => repoProjects.id, { onDelete: 'cascade' }),
 boardColumnId: text('board_column_id')
 .notNull()
 .references(() => boardColumns.id, { onDelete: 'cascade' }),
 giteaIssueId: text('gitea_issue_id').notNull(), // gitea issue index（数字字符串）
 cachedAt: integer('cached_at', { mode: 'timestamp' }).notNull(),
 },
 (t) => ({
 uniqProjectIssue: uniqueIndex('uniq_project_issue').on(t.repoProjectId, t.giteaIssueId),
 idxColumnIssue: index('idx_column_issue').on(t.boardColumnId, t.giteaIssueId),
 }),
);
