/**
 * labelMaps 业务接口 —— localStore 中 ColumnLabelMap[] 的查询
 * (touch v2)
 *
 * 替代 SQLite column_label_mapping 表
 *
 * 设计原则（ADR-0003 Phase 2）：
 * - 全部走 LocalState.labelMaps
 * - 错误：找不到返 []
 * - **不**做缓存
 *
 * 关联表：
 * - board/columns.ts mapLabel / unmapLabel：Phase 2 切写
 * - board/card-from-issues.ts：用 listLabelMapsByColumn（按 columnId 拿绑的 labels）
 * - board/move-card.ts：用 listLabelMapsByColumn（双列：from / to）+ 找冲突
 */

import type { ColumnLabelMap } from './state.js';

/** 按 columnId 拿绑的所有 labelMap，按 createdAt 升序 */
export function listLabelMapsByColumnWithStore(
  state: { labelMaps: ColumnLabelMap[] },
  columnId: string,
): ColumnLabelMap[] {
  return state.labelMaps
    .filter((m) => m.columnId === columnId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 按 (projectId, giteaLabelId) 找唯一 labelMap
 *
 * 用于 mapLabel 冲突校验（业务规则：一个 gitea label 在一个 project 下只能绑一个列）
 */
export function findLabelMapByProjectAndLabelWithStore(
  state: { labelMaps: ColumnLabelMap[] },
  args: { projectId: string; giteaLabelId: string },
): ColumnLabelMap | null {
  return (
    state.labelMaps.find(
      (m) => m.projectId === args.projectId && m.giteaLabelId === args.giteaLabelId,
    ) ?? null
  );
}

/** 按 (columnId, giteaLabelId) 找 —— mapLabel 幂等检查 */
export function findLabelMapByColumnAndLabelWithStore(
  state: { labelMaps: ColumnLabelMap[] },
  args: { columnId: string; giteaLabelId: string },
): ColumnLabelMap | null {
  return (
    state.labelMaps.find(
      (m) => m.columnId === args.columnId && m.giteaLabelId === args.giteaLabelId,
    ) ?? null
  );
}
