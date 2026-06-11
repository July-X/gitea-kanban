import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { repoProjects } from './repoProjects.js';

/**
 *看板列（gitea-kanban 本地概念，ADR-0002）
 *
 * 设计：
 * -1:N 一个 repo_project 可有多个 board_column（顺序按 position）
 * - title 自定（"待办/进行中/已完成"），与 gitea label name 解耦
 * - 列 ↔ gitea label 的映射在 columnLabelMapping 表（多对多）
 * - 不存 wipLimit / hideMergedPr（v1简化；列约束仅靠 label隐式）
 * - 不挂 "boards" 表（ADR-0002 reset：删 boards 中间层，列直接挂 repo_project）
 */
export const boardColumns = sqliteTable(
 'board_columns',
 {
 id: text('id').primaryKey(),
 repoProjectId: text('repo_project_id')
 .notNull()
 .references(() => repoProjects.id, { onDelete: 'cascade' }),
 title: text('title').notNull(),
 position: integer('position').notNull(),
 createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
 },
 (t) => ({
 idxProjectPos: index('idx_project_pos').on(t.repoProjectId, t.position),
 }),
);
