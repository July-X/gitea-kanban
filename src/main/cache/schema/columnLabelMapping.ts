import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { boardColumns } from './boardColumns.js';
import { repoProjects } from './repoProjects.js';

/**
 * 列 ↔ gitea label 多对多映射（ADR-0002 §"数据模型"）
 *
 * 设计：
 * - 一个 board_column 可绑多个 gitea label（多对多的一侧）
 * - 一个 gitea_label_id只能绑一个 board_column（业务规则：一个 issue 同时只能属一列）
 * - gitea_label_id 在本表以 text存（gitea label id 是 number 但本表 nullable text兼容）
 *实际从 issues.list 的 label.id拿；存 text 是为兼容 v2 多 label id 类型
 *
 *唯一索引：(repo_project_id, gitea_label_id) —— 同 repo 下同一 label 不能绑两列
 *业务层加 UNIQUE(gitea_label_id) 在跨项目层保证全局唯一（v1简化为 repo 内唯一）
 */
export const columnLabelMapping = sqliteTable(
 'column_label_mapping',
 {
 id: text('id').primaryKey(),
 columnId: text('column_id')
 .notNull()
 .references(() => boardColumns.id, { onDelete: 'cascade' }),
 repoProjectId: text('repo_project_id')
 .notNull()
 .references(() => repoProjects.id, { onDelete: 'cascade' }),
 giteaLabelId: text('gitea_label_id').notNull(), // gitea issue label.id（数字字符串）
 giteaLabelName: text('gitea_label_name').notNull(), //冗余存（gitea端 label改名时仍可识别）
 createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
 },
 (t) => ({
 uniqProjectLabel: uniqueIndex('uniq_project_label').on(t.repoProjectId, t.giteaLabelId),
 idxColumn: index('idx_column').on(t.columnId),
 }),
);
