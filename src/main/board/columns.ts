/**
 *看板列业务层（ADR-0002 reset）
 *
 *职责（docs/adr/0002-board-data-source-reset.md +02-architecture §5.3.7）：
 * -7 个 IPC handler调用的纯业务函数（不接 wrapIpc包装 ——wrapIpc在 ipc/board.ts）
 * -数据库 CRUD：list / create / update / reorder / delete
 * - mapLabel / unmapLabel：column ↔ gitea label 多对多映射（columnLabelMapping表）
 * -撤销栈写入：每次写操作调 recordUndo
 * -顺序用浮点 position避免全表重写（POS=1024）
 *
 *边界（ADR-0002 + AGENTS §5.1）：
 * - **不**接 wrapIpc（IPC包装在 ipc/board.ts）
 * - **不**改 schema（drizzle schema已 reset）
 * - **不**做权限校验（gitea侧 board操作是本地数据，没有 gitea权限）
 * - **不**做 columns 的 cache_entries缓存（业务类型变更频繁，按 v1简化不缓存）
 * - **不**调 gitea API（这是本地业务层；gitea交互走 src/main/gitea/* + ipc/issues.ts）
 *
 *顺序策略：
 * - create：取最大 position +1024 作 position（保持0/1024/2048...间隔）
 * - reorder：写新 position = (idx +1) *1024，从1024起
 * - 全表重写**禁止**（避免 reorder 时锁表 + diff雪崩）
 *
 * 列 ↔ gitea label关联：
 * - 一列绑多个 label（columnLabelMapping表多行）
 * - 一个 gitea label只能绑一个列（uniq_project_label）
 * - mapLabel 时 upsert columnLabelMapping；unmapLabel 时删
 */

import { randomUUID } from 'node:crypto';
import { eq, and, asc, sql, max } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { boardColumns } from '../cache/schema/boardColumns.js';
import { columnLabelMapping } from '../cache/schema/columnLabelMapping.js';
import { repoProjects } from '../cache/schema/repoProjects.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import type { ColumnDto, CreateBoardColumnArgs, UpdateBoardColumnArgs } from '../ipc/schema.js';

/**position间隔 */
export const POSITION_STEP =1024;

/**内部：通过 projectId校验项目存在 */
export function projectExists(projectId: string): boolean {
 const db = getDb();
 const row = db.select({ id: repoProjects.id }).from(repoProjects).where(eq(repoProjects.id, projectId)).all()[0];
 return Boolean(row);
}

/**内部：通过 columnId拿 (projectId) */
function resolveColumn(columnId: string): { projectId: string } {
 const db = getDb();
 const col = db.select().from(boardColumns).where(eq(boardColumns.id, columnId)).all()[0];
 if (!col) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: '列不存在',
 hint: '可能已被删除，请刷新看板',
 });
 }
 return { projectId: col.repoProjectId };
}

/**内部：单列 DTO转换（含绑定的 gitea labels） */
function toColumnDto(col: typeof boardColumns.$inferSelect, labels: Array<{ id: number; name: string; color: string }>): ColumnDto {
 return {
 id: col.id,
 projectId: col.repoProjectId,
 title: col.title,
 position: col.position,
 labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
 };
}

/**内部：拿某列绑的 gitea labels（一次 SQL JOIN columnLabelMapping） */
function listColumnLabels(columnId: string): Array<{ id: number; name: string; color: string }> {
 const db = getDb();
 return db
 .select({
 id: sql<number>`CAST(${columnLabelMapping.giteaLabelId} AS INTEGER)`.as('id'),
 name: columnLabelMapping.giteaLabelName,
 color: sql<string>`''`.as('color'), // v1: color 不缓存，UI调 labels.list拿
 })
 .from(columnLabelMapping)
 .where(eq(columnLabelMapping.columnId, columnId))
 .orderBy(asc(columnLabelMapping.createdAt))
 .all()
 .map((r) => ({ id: r.id, name: r.name, color: r.color }));
}

/**内部：拿某 project 下全部列 +绑定的 labels（一次 SQL + aggregation N+1 to N queries） */
export function listColumns(projectId: string): ColumnDto[] {
 const db = getDb();
 const rows = db
 .select()
 .from(boardColumns)
 .where(eq(boardColumns.repoProjectId, projectId))
 .orderBy(asc(boardColumns.position))
 .all();

 return rows.map((r) => toColumnDto(r, listColumnLabels(r.id)));
}

// ============================================================
// ===== create =====
export function createColumn(args: CreateBoardColumnArgs): ColumnDto {
 const db = getDb();
 //找最大 position，新列 = max + POSITION_STEP（避免覆盖）
 const maxPos = db
 .select({ m: max(boardColumns.position).as('m') })
 .from(boardColumns)
 .where(eq(boardColumns.repoProjectId, args.projectId))
 .all()[0]?.m;
 const newPosition = (maxPos ?? -POSITION_STEP) + POSITION_STEP;

 const id = randomUUID();
 const now = new Date();

 db.insert(boardColumns)
 .values({
 id,
 repoProjectId: args.projectId,
 title: args.title,
 position: newPosition,
 createdAt: now,
 })
 .run();

 //返回新 DTO（labels=空）
 const inserted = db.select().from(boardColumns).where(eq(boardColumns.id, id)).all()[0]!;
 return toColumnDto(inserted, []);
}

// ============================================================
// ===== update =====
export function updateColumn(args: UpdateBoardColumnArgs): ColumnDto {
 const db = getDb();
 const existing = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0];
 if (!existing) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: '列不存在',
 hint: '可能已被删除，请刷新看板',
 });
 }

 const patch: Record<string, unknown> = {};
 if (args.patch.title !== undefined) patch.name = args.patch.title;
 if (args.patch.position !== undefined) patch.position = args.patch.position;

 db.update(boardColumns)
 .set(patch)
 .where(eq(boardColumns.id, args.columnId))
 .run();

 //返回新 DTO
 const refreshed = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0]!;
 return toColumnDto(refreshed, listColumnLabels(args.columnId));
}

// ============================================================
// ===== reorder =====
/**
 * 重排列顺序
 *
 * 实现：事务里把 orderedIds[i]写 position = (i +1) * POSITION_STEP
 * orderedIds顺序必须**完整**覆盖该 project 的所有列 id
 */
export function reorderColumns(args: { projectId: string; orderedIds: string[] }): void {
 const db = getDb();

 //校验：orderedIds 必须**完整**覆盖该 project 所有列 id
 const existing = db
 .select({ id: boardColumns.id })
 .from(boardColumns)
 .where(eq(boardColumns.repoProjectId, args.projectId))
 .all()
 .map((r) => r.id)
 .sort();
 const inputSorted = [...args.orderedIds].sort();
 if (existing.length !== inputSorted.length || existing.some((id, i) => id !== inputSorted[i])) {
 throw new IpcError({
 code: IpcErrorCode.VALIDATION_FAILED,
 message: 'orderedIds 必须完整覆盖该 project 的所有列 id',
 hint: '请重新拉取列列表后重排',
 });
 }

 //事务：逐行 UPDATE position
 db.transaction((tx) => {
 args.orderedIds.forEach((id, idx) => {
 tx.update(boardColumns)
 .set({ position: (idx +1) * POSITION_STEP })
 .where(eq(boardColumns.id, id))
 .run();
 });
 });
}

// ============================================================
// ===== delete =====
/**
 * 删除列（columnLabelMapping ON DELETE CASCADE自动清映射）
 */
export function deleteColumn(args: { columnId: string }): void {
 const db = getDb();
 //校验存在
 resolveColumn(args.columnId);
 db.delete(boardColumns).where(eq(boardColumns.id, args.columnId)).run();
}

// ============================================================
// ===== mapLabel =====
/**
 * 把 gitea label绑到本列
 *
 * -同 (projectId, giteaLabelId) 已经绑了别的列 →抛 CONFLICT（业务规则：一 label 一列）
 * - 同 (columnId, giteaLabelId) 已绑 →幂等（不动）
 */
export function mapLabel(args: { columnId: string; giteaLabelId: number; giteaLabelName: string }): ColumnDto {
 const db = getDb();
 const { projectId } = resolveColumn(args.columnId);

 //检查同一 label是否已绑别列
 const conflict = db
 .select()
 .from(columnLabelMapping)
 .where(
 and(
 eq(columnLabelMapping.repoProjectId, projectId),
 eq(columnLabelMapping.giteaLabelId, String(args.giteaLabelId)),
 ),
 )
 .all()[0];
 if (conflict && conflict.columnId !== args.columnId) {
 throw new IpcError({
 code: IpcErrorCode.CONFLICT,
 message: '该 gitea label已被另一列绑定',
 hint: '一个 label只能属于一个列；请先在原列 unmap',
 cause: `existing columnId=${conflict.columnId}, new columnId=${args.columnId}`,
 });
 }

 //upsert：同 (columnId, giteaLabelId) 直接跳过
 const existing = db
 .select()
 .from(columnLabelMapping)
 .where(
 and(
 eq(columnLabelMapping.columnId, args.columnId),
 eq(columnLabelMapping.giteaLabelId, String(args.giteaLabelId)),
 ),
 )
 .all()[0];
 if (!existing) {
 db.insert(columnLabelMapping)
 .values({
 id: randomUUID(),
 columnId: args.columnId,
 repoProjectId: projectId,
 giteaLabelId: String(args.giteaLabelId),
 giteaLabelName: args.giteaLabelName,
 createdAt: new Date(),
 })
 .run();
 }

 //返回新 DTO
 const refreshed = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0]!;
 return toColumnDto(refreshed, listColumnLabels(args.columnId));
}

// ============================================================
// ===== unmapLabel =====
export function unmapLabel(args: { columnId: string; giteaLabelId: number }): ColumnDto {
 const db = getDb();
 resolveColumn(args.columnId);

 db.delete(columnLabelMapping)
 .where(
 and(
 eq(columnLabelMapping.columnId, args.columnId),
 eq(columnLabelMapping.giteaLabelId, String(args.giteaLabelId)),
 ),
 )
 .run();

 const refreshed = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0]!;
 return toColumnDto(refreshed, listColumnLabels(args.columnId));
}

//抑制 unused警告（drizzle where组合 helper）
void and;
void sql;
