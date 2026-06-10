/**
 * 看板列业务层（02-architecture.md §5.3.7）
 *
 * 职责：
 * - 5 个 IPC handler 调用的纯业务函数（不接 wrapIpc 包装 —— wrapIpc 在 ipc/board.ts）
 * - 数据库 CRUD：list / create / update / reorder / delete
 * - 撤销栈写入：每次写操作调 recordUndo
 * - 顺序用浮点 position 避免全表重写（任务 prompt §关键约束 11）
 *
 * 边界（任务 prompt §严格边界）：
 * - **不**接 wrapIpc（IPC 包装在 ipc/board.ts）
 * - **不**改 schema、不改 IpcErrorCode
 * - **不**做权限校验（gitea 侧 board 操作是本地数据，没有 gitea 权限）
 * - **不**做 columns 的 cache_entries 缓存（业务类型变更频繁，按 v1 简化不缓存）
 *
 * 顺序策略（任务 prompt §关键约束 11）：
 * - create：取最大 position + 1024 作 position（保持 0/1024/2048... 间隔）
 * - reorder：写新 position = (idx + 1) * 1024，从 1024 起
 * - move（card 移动）：用前后平均定位（不调 reorder）
 * - 全表重写**禁止**（避免 reorder 时锁表 + diff 雪崩）
 */

import { randomUUID } from 'node:crypto';
import { eq, and, asc, sql, max } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { boardColumns } from '../cache/schema/boardColumns.js';
import { cards } from '../cache/schema/cards.js';
import { boards } from '../cache/schema/boards.js';
import { repoProjects } from '../cache/schema/repoProjects.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import type { ColumnDto, CreateBoardColumnArgs, UpdateBoardColumnArgs } from '../ipc/schema.js';
import { recordUndo } from './undo.js';

/** position 间隔（与同列卡片 position 共用） */
export const POSITION_STEP = 1024;

// ============================================================
// ===== 内部：resolve boardId =====
/**
 * 通过 projectId 拿到 boardId（board 是 1:1 with repo_project，02 §4.2 uniqRepoBoard）
 *
 * 拍板 02 §4.2：boards 有 uniqRepoBoard 唯一索引 → 一个 repo_project 只对应一个 board
 * 第一次访问时**不**自动 seed（IPC handler 层负责"建项目时同时建 board"）
 */
export function getBoardIdByProjectId(projectId: string): string {
  const db = getDb();
  const row = db.select().from(boards).where(eq(boards.repoProjectId, projectId)).all()[0];
  if (!row) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目没有看板',
      hint: '请先在仓库列表中把该项目作为"项目"加入',
    });
  }
  return row.id;
}

/** 通过 columnId 拿 (boardId, projectId) */
function resolveColumn(columnId: string): { boardId: string; projectId: string } {
  const db = getDb();
  const col = db.select().from(boardColumns).where(eq(boardColumns.id, columnId)).all()[0];
  if (!col) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '列不存在',
      hint: '可能已被删除，请刷新看板',
    });
  }
  const board = db.select().from(boards).where(eq(boards.id, col.boardId)).all()[0];
  if (!board) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '看板不存在',
      hint: '项目元数据损坏',
    });
  }
  return { boardId: col.boardId, projectId: board.repoProjectId };
}

/** 内部：单列 DTO 转换（含 cardCount） */
function toColumnDto(col: typeof boardColumns.$inferSelect, cardCount: number): ColumnDto {
  return {
    id: col.id,
    boardId: col.boardId,
    name: col.name,
    position: col.position,
    wipLimit: col.wipLimit,
    hideMergedPr: col.hideMergedPr,
    cardCount,
  };
}

/** 内部：拿某 board 全部列 + cardCount（一次 SQL + 聚合） */
export function listColumns(projectId: string): ColumnDto[] {
  const boardId = getBoardIdByProjectId(projectId);
  const db = getDb();
  // 用 LEFT JOIN cards + COUNT 一次 SQL 拿
  const rows = db
    .select({
      col: boardColumns,
      cardCount: sql<number>`COUNT(${cards.id})`.as('card_count'),
    })
    .from(boardColumns)
    .leftJoin(cards, eq(cards.columnId, boardColumns.id))
    .where(eq(boardColumns.boardId, boardId))
    .groupBy(boardColumns.id)
    .orderBy(asc(boardColumns.position))
    .all();
  return rows.map((r) => toColumnDto(r.col, Number(r.cardCount)));
}

// ============================================================
// ===== create =====
export function createColumn(args: CreateBoardColumnArgs): ColumnDto {
  const boardId = getBoardIdByProjectId(args.projectId);
  const db = getDb();
  // 找最大 position，新列 = max + POSITION_STEP（避免覆盖）
  const maxPos = db
    .select({ m: max(boardColumns.position).as('m') })
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .all()[0]?.m;
  const newPosition = (maxPos ?? -POSITION_STEP) + POSITION_STEP;

  const id = randomUUID();
  const now = new Date();

  db.insert(boardColumns)
    .values({
      id,
      boardId,
      name: args.name,
      position: newPosition,
      wipLimit: args.wipLimit ?? null,
      hideMergedPr: args.hideMergedPr ?? false,
      createdAt: now,
    })
    .run();

  // 写撤销栈
  recordUndo({
    op: 'col.create',
    payload: { columnId: id, before: {}, after: { name: args.name, position: newPosition, wipLimit: args.wipLimit ?? null, hideMergedPr: args.hideMergedPr ?? false } },
  });

  // 返回新 DTO（cardCount=0）
  const inserted = db.select().from(boardColumns).where(eq(boardColumns.id, id)).all()[0]!;
  return toColumnDto(inserted, 0);
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

  // 拍 before 快照（用于 undo）
  const before = {
    name: existing.name,
    wipLimit: existing.wipLimit,
    hideMergedPr: existing.hideMergedPr,
  };

  // 计算 after（用 patch 覆盖）
  const patch: Record<string, unknown> = {};
  if (args.patch.name !== undefined) patch.name = args.patch.name;
  if (args.patch.wipLimit !== undefined) patch.wipLimit = args.patch.wipLimit;
  if (args.patch.hideMergedPr !== undefined) patch.hideMergedPr = args.patch.hideMergedPr;

  db.update(boardColumns)
    .set(patch)
    .where(eq(boardColumns.id, args.columnId))
    .run();

  // 写撤销栈
  recordUndo({
    op: 'col.update',
    payload: { columnId: args.columnId, before, after: patch },
  });

  // 返回新 DTO（含 cardCount）
  const refreshed = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0]!;
  const cardCount = db
    .select({ c: sql<number>`COUNT(${cards.id})`.as('c') })
    .from(cards)
    .where(eq(cards.columnId, args.columnId))
    .all()[0]?.c;
  return toColumnDto(refreshed, Number(cardCount ?? 0));
}

// ============================================================
// ===== reorder =====
/**
 * 重排列顺序
 *
 * 实现：事务里把 orderedIds[i] 写 position = (i + 1) * POSITION_STEP
 * orderedIds 顺序必须**完整**覆盖该 board 的所有列 id（否则剩余列 position 不变 = 乱）
 */
export function reorderColumns(args: { projectId: string; orderedIds: string[] }): void {
  const boardId = getBoardIdByProjectId(args.projectId);
  const db = getDb();

  // 校验：orderedIds 必须**完整**覆盖该 board 所有列 id
  const existing = db
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .all()
    .map((r) => r.id)
    .sort();
  const inputSorted = [...args.orderedIds].sort();
  if (existing.length !== inputSorted.length || existing.some((id, i) => id !== inputSorted[i])) {
    throw new IpcError({
      code: IpcErrorCode.VALIDATION_FAILED,
      message: 'orderedIds 必须完整覆盖该 board 的所有列 id',
      hint: '请重新拉取列列表后重排',
    });
  }

  // 拍 before 顺序
  const beforeOrder = db
    .select({ id: boardColumns.id, position: boardColumns.position })
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .orderBy(asc(boardColumns.position))
    .all()
    .map((r) => r.id);

  // 事务：逐行 UPDATE position
  db.transaction((tx) => {
    args.orderedIds.forEach((id, idx) => {
      tx.update(boardColumns)
        .set({ position: (idx + 1) * POSITION_STEP })
        .where(eq(boardColumns.id, id))
        .run();
    });
  });

  // 写撤销栈
  recordUndo({
    op: 'col.reorder',
    payload: { projectId: args.projectId, beforeOrder, afterOrder: args.orderedIds },
  });
}

// ============================================================
// ===== delete =====
/**
 * 删除列
 *
 * - moveCardsTo 缺省 / null → cards 级联 DELETE（cards.columnId ON DELETE CASCADE）
 * - moveCardsTo = columnId → 把该列卡片 move 到目标列（不删卡片）
 *
 * 危险操作（任务 prompt §"危险操作"段）—— UI 层**必须**双确认
 */
export function deleteColumn(args: { columnId: string; moveCardsTo?: string | null }): void {
  const db = getDb();
  const { projectId, boardId } = resolveColumn(args.columnId);

  // moveCardsTo 校验
  if (args.moveCardsTo !== undefined && args.moveCardsTo !== null) {
    if (args.moveCardsTo === args.columnId) {
      throw new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: 'moveCardsTo 不能等于 columnId 自身',
      });
    }
    const target = db.select().from(boardColumns).where(eq(boardColumns.id, args.moveCardsTo)).all()[0];
    if (!target || target.boardId !== boardId) {
      throw new IpcError({
        code: IpcErrorCode.NOT_FOUND,
        message: 'moveCardsTo 目标列不存在或不在同一看板',
        hint: '请选择同一看板的其它列',
      });
    }
  }

  // 拍 before 快照（用于 undo 重建）
  const before = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0];
  if (!before) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '列不存在',
    });
  }
  // 拍该列卡片（用于 undo 重建时回插）
  const beforeCards = db
    .select()
    .from(cards)
    .where(eq(cards.columnId, args.columnId))
    .orderBy(asc(cards.position))
    .all();

  // 事务：move cards（如指定）→ DELETE column（cards 级联删或已 move 走）
  db.transaction((tx) => {
    if (args.moveCardsTo !== undefined && args.moveCardsTo !== null) {
      // 目标列最大 position
      const targetMax = tx
        .select({ m: max(cards.position).as('m') })
        .from(cards)
        .where(eq(cards.columnId, args.moveCardsTo))
        .all()[0]?.m;
      let nextPos = (targetMax ?? -POSITION_STEP) + POSITION_STEP;
      for (const c of beforeCards) {
        tx.update(cards)
          .set({ columnId: args.moveCardsTo, position: nextPos, updatedAt: new Date() })
          .where(eq(cards.id, c.id))
          .run();
        nextPos += POSITION_STEP;
      }
    }
    // DELETE column（cards 已 move 走 → 0 行级联；否则级联删）
    tx.delete(boardColumns).where(eq(boardColumns.id, args.columnId)).run();
  });

  // 写撤销栈
  recordUndo({
    op: 'col.delete',
    payload: {
      columnId: args.columnId,
      boardId,
      projectId,
      before: { ...before, cards: beforeCards },
      after: { moveCardsTo: args.moveCardsTo ?? null },
    },
  });
}

// ============================================================
// ===== 内部 helper：projects 完整性（给 IPC 层做 existence check）=====
/** 通过 projectId 检查 project 存在（不创建） */
export function projectExists(projectId: string): boolean {
  const db = getDb();
  const row = db.select({ id: repoProjects.id }).from(repoProjects).where(eq(repoProjects.id, projectId)).all()[0];
  return Boolean(row);
}

// 抑制 unused 警告：and 是 drizzle where 组合，将来 SQL 复杂条件可能用到
void and;
