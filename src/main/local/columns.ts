/**
 * columns 业务接口 —— localStore 中 BoardColumn[] 的查询
 * (touch v2)
 *
 * 替代 SQLite board_columns 表
 *
 * 设计原则（ADR-0003 Phase 2）：
 * - 全部走 LocalState.columns
 * - 错误：找不到返 null / []
 * - **不**做缓存（业务表，读多写少，内存比 SQLite 更快）
 *
 * 关联表：
 * - board/columns.ts 8 个函数（listColumns/createColumn/updateColumn/reorderColumns/deleteColumn/mapLabel/unmapLabel/projectExists/resolveColumn）
 *   Commit A 只暴露读，Phase 2 切写路径时再加写函数
 * - board/card-from-issues.ts：用 findColumnById
 * - board/move-card.ts：用 findColumnById（双列：from / to）
 */

import type { BoardColumn } from './state.js';

/** 按 projectId 拿全部列，按 position 升序 —— 替代 listColumns */
export function listColumnsByProjectWithStore(
  state: { columns: BoardColumn[] },
  projectId: string,
): BoardColumn[] {
  return state.columns
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.position - b.position);
}

/** 按 projectId 取最大 position —— 替代 createColumn 的 "find max + POSITION_STEP" */
export function maxColumnPositionByProjectWithStore(
  state: { columns: BoardColumn[] },
  projectId: string,
): number {
  let max = -1024; // 与 columns.ts POSITION_STEP=1024 对齐
  for (const c of state.columns) {
    if (c.projectId === projectId && c.position > max) {
      max = c.position;
    }
  }
  return max;
}

/** 按 columnId 找 —— 替代 resolveColumn / card-from-issues / move-card */
export function findColumnByIdWithStore(
  state: { columns: BoardColumn[] },
  columnId: string,
): BoardColumn | null {
  return state.columns.find((c) => c.id === columnId) ?? null;
}

/** 检查 project 下是否至少有 1 列（projectExists 之外的轻量校验） */
export function projectExistsInColumnsWithStore(
  state: { columns: BoardColumn[] },
  projectId: string,
): boolean {
  return state.columns.some((c) => c.projectId === projectId);
}

/** 按 projectId 取所有 column id 集合 —— 替代 reorderColumns 的 "完整覆盖校验" */
export function columnIdsByProjectWithStore(
  state: { columns: BoardColumn[] },
  projectId: string,
): string[] {
  return state.columns.filter((c) => c.projectId === projectId).map((c) => c.id);
}
