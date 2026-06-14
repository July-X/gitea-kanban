/**
 * 看板列业务层（ADR-0002 reset + ADR-0003 Phase 2 切 localStore）
 *
 * 职责（docs/adr/0002-board-data-source-reset.md + 02-architecture §5.3.7）：
 * - 7 个 IPC handler 调用的纯业务函数（不接 wrapIpc 包装 —— wrapIpc 在 ipc/board.ts）
 * - 数据库 CRUD：list / create / update / reorder / delete
 * - mapLabel / unmapLabel：column ↔ gitea label 多对多映射（columnLabelMapping 表）
 * - 撤销栈写入：每次写操作调 recordUndo（M6 已切 in-memory）
 * - 顺序用浮点 position 避免全表重写（POS=1024）
 *
 * 边界（ADR-0002 + AGENTS §5.1）：
 * - **不**接 wrapIpc（IPC 包装在 ipc/board.ts）
 * - **不**改 schema
 * - **不**做权限校验
 * - **不**做 columns 的 cache_entries 缓存（业务类型变更频繁）
 * - **不**调 gitea API
 *
 * ADR-0003 Phase 2 改造：
 * - 业务态（board_columns + column_label_mapping）走 localStore 优先
 * - SQLite 镜像（best-effort，Phase 2 兜底）
 * - repo_projects 校验改用 state.projects（cross-table 关联）
 *
 * 顺序策略：
 * - create：取最大 position + 1024 作 position（保持 0/1024/2048... 间隔）
 * - reorder：写新 position = (idx + 1) * 1024，从 1024 起
 * - 全表重写 **禁止**
 *
 * 列 ↔ gitea label 关联：
 * - 一列绑多个 label（labelMaps 多行）
 * - 一个 gitea label 只能绑一个列（uniq_project_label 业务规则）
 */

import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { boardColumns } from '../cache/schema/boardColumns.js';
import { columnLabelMapping } from '../cache/schema/columnLabelMapping.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import type { ColumnDto, CreateBoardColumnArgs, UpdateBoardColumnArgs } from '../ipc/schema.js';
import { getLocalStore } from '../local/state.js';
import {
  findColumnByIdWithStore,
  listColumnsByProjectWithStore,
  maxColumnPositionByProjectWithStore,
  columnIdsByProjectWithStore,
} from '../local/columns.js';
import {
  findLabelMapByProjectAndLabelWithStore,
  findLabelMapByColumnAndLabelWithStore,
  listLabelMapsByColumnWithStore,
} from '../local/label-maps.js';
import { logger } from '../logger.js';

/** position 间隔 */
export const POSITION_STEP = 1024;

/**
 * 通过 projectId 校验项目存在
 * ADR-0003 Phase 2：走 localStore（state.projects）
 */
export function projectExists(projectId: string): boolean {
  return getLocalStore()
    .get()
    .projects.some((p) => p.id === projectId);
}

/**
 * 通过 columnId 拿 (projectId)
 * ADR-0003 Phase 2：走 localStore
 */
function resolveColumn(columnId: string): { projectId: string } {
  const col = findColumnByIdWithStore(getLocalStore().get(), columnId);
  if (!col) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '列不存在',
      hint: '可能已被删除，请刷新看板',
    });
  }
  return { projectId: col.projectId };
}

/**
 * 单列 DTO 转换（含绑定的 gitea labels）
 * ADR-0003 Phase 2：col 是 localStore BoardColumn（number epoch ms）
 */
function toColumnDto(
  col: { id: string; projectId: string; title: string; position: number; createdAt: number },
  labels: Array<{ id: number; name: string; color: string }>,
): ColumnDto {
  return {
    id: col.id,
    projectId: col.projectId,
    title: col.title,
    position: col.position,
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
  };
}

/**
 * 拿某列绑的 gitea labels（localStore.labelMaps 过滤）
 */
function listColumnLabels(columnId: string): Array<{ id: number; name: string; color: string }> {
  return listLabelMapsByColumnWithStore(getLocalStore().get(), columnId).map((m) => ({
    id: Number(m.giteaLabelId),
    name: m.giteaLabelName,
    color: '', // v1: color 不缓存，UI 调 labels.list 拿
  }));
}

/**
 * 拿某 project 下全部列 + 绑定的 labels
 * ADR-0003 Phase 2：localStore 优先
 */
export function listColumns(projectId: string): ColumnDto[] {
  const cols = listColumnsByProjectWithStore(getLocalStore().get(), projectId);
  return cols.map((c) => toColumnDto(c, listColumnLabels(c.id)));
}

// ============================================================
// ===== create =====
export function createColumn(args: CreateBoardColumnArgs): ColumnDto {
  // 找最大 position，新列 = max + POSITION_STEP（避免覆盖）
  const maxPos = maxColumnPositionByProjectWithStore(getLocalStore().get(), args.projectId);
  const newPosition = maxPos + POSITION_STEP;

  const id = randomUUID();
  const nowEpochMs = Date.now();
  const createdRow = {
    id,
    projectId: args.projectId,
    title: args.title,
    position: newPosition,
    createdAt: nowEpochMs,
  };

  getLocalStore().mutate((s) => {
    s.columns.push(createdRow);
  });

  // SQLite 镜像（best-effort）
  try {
    getDb()
      .insert(boardColumns)
      .values({
        id,
        repoProjectId: args.projectId,
        title: args.title,
        position: newPosition,
        createdAt: new Date(nowEpochMs),
      })
      .run();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), id, projectId: args.projectId },
      'createColumn: SQLite insert failed (non-fatal in Phase 2)',
    );
  }

  // 返回新 DTO（labels=空）
  return toColumnDto(createdRow, []);
}

// ============================================================
// ===== update =====
export function updateColumn(args: UpdateBoardColumnArgs): ColumnDto {
  const store = getLocalStore();
  const existing = findColumnByIdWithStore(store.get(), args.columnId);
  if (!existing) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '列不存在',
      hint: '可能已被删除，请刷新看板',
    });
  }

  store.mutate((s) => {
    const idx = s.columns.findIndex((c) => c.id === args.columnId);
    if (idx < 0) return;
    s.columns[idx] = {
      ...s.columns[idx]!,
      ...(args.patch.title !== undefined ? { title: args.patch.title } : {}),
      ...(args.patch.position !== undefined ? { position: args.patch.position } : {}),
    };
  });

  // SQLite 镜像（best-effort）
  try {
    const db = getDb();
    const patch: Record<string, unknown> = {};
    if (args.patch.title !== undefined) patch.title = args.patch.title;
    if (args.patch.position !== undefined) patch.position = args.patch.position;
    if (Object.keys(patch).length > 0) {
      db.update(boardColumns)
        .set(patch)
        .where(eq(boardColumns.id, args.columnId))
        .run();
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), columnId: args.columnId },
      'updateColumn: SQLite update failed (non-fatal)',
    );
  }

  // 返回新 DTO
  const refreshed = findColumnByIdWithStore(store.get(), args.columnId)!;
  return toColumnDto(refreshed, listColumnLabels(args.columnId));
}

// ============================================================
// ===== reorder =====
/**
 * 重排列顺序
 *
 * 实现：把 orderedIds[i] 写 position = (i + 1) * POSITION_STEP
 * orderedIds 顺序必须**完整**覆盖该 project 的所有列 id
 */
export function reorderColumns(args: { projectId: string; orderedIds: string[] }): void {
  const store = getLocalStore();
  // 校验：orderedIds 必须**完整**覆盖该 project 所有列 id
  const existing = columnIdsByProjectWithStore(store.get(), args.projectId).sort();
  const inputSorted = [...args.orderedIds].sort();
  if (existing.length !== inputSorted.length || existing.some((id, i) => id !== inputSorted[i])) {
    throw new IpcError({
      code: IpcErrorCode.VALIDATION_FAILED,
      message: 'orderedIds 必须完整覆盖该 project 的所有列 id',
      hint: '请重新拉取列列表后重排',
    });
  }

  // 逐行 mutate（localStore 是 in-memory，单线程 mutate 即原子）
  store.mutate((s) => {
    for (let idx = 0; idx < args.orderedIds.length; idx++) {
      const id = args.orderedIds[idx]!;
      const pos = (idx + 1) * POSITION_STEP;
      const cIdx = s.columns.findIndex((c) => c.id === id);
      if (cIdx >= 0) {
        s.columns[cIdx] = { ...s.columns[cIdx]!, position: pos };
      }
    }
  });

  // SQLite 镜像（best-effort；事务批量 UPDATE）
  try {
    const db = getDb();
    db.transaction((tx) => {
      for (let idx = 0; idx < args.orderedIds.length; idx++) {
        tx.update(boardColumns)
          .set({ position: (idx + 1) * POSITION_STEP })
          .where(eq(boardColumns.id, args.orderedIds[idx]!))
          .run();
      }
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), projectId: args.projectId },
      'reorderColumns: SQLite update failed (non-fatal)',
    );
  }
}

// ============================================================
// ===== delete =====
/**
 * 删除列（labelMaps **不**级联删——labelMaps 跨列共享保留语义，
 * Phase 3 改 schema 时一起处理）
 */
export function deleteColumn(args: { columnId: string }): void {
  resolveColumn(args.columnId);
  getLocalStore().mutate((s) => {
    s.columns = s.columns.filter((c) => c.id !== args.columnId);
    s.labelMaps = s.labelMaps.filter((m) => m.columnId !== args.columnId);
  });
  // SQLite 镜像（best-effort；columnLabelMapping FK CASCADE 旧行为由 SQLite 处理）
  try {
    getDb().delete(boardColumns).where(eq(boardColumns.id, args.columnId)).run();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), columnId: args.columnId },
      'deleteColumn: SQLite delete failed (non-fatal)',
    );
  }
}

// ============================================================
// ===== mapLabel =====
/**
 * 把 gitea label 绑到本列
 *
 * - 同 (projectId, giteaLabelId) 已经绑了别的列 → 抛 CONFLICT（业务规则：一 label 一列）
 * - 同 (columnId, giteaLabelId) 已绑 → 幂等（不动）
 */
export function mapLabel(args: {
  columnId: string;
  giteaLabelId: number;
  giteaLabelName: string;
}): ColumnDto {
  const store = getLocalStore();
  const { projectId } = resolveColumn(args.columnId);

  // 检查同一 label 是否已绑别列
  const conflict = findLabelMapByProjectAndLabelWithStore(store.get(), {
    projectId,
    giteaLabelId: String(args.giteaLabelId),
  });
  if (conflict && conflict.columnId !== args.columnId) {
    throw new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: '该 gitea label 已被另一列绑定',
      hint: '一个 label 只能属于一个列；请先在原列 unmap',
      cause: `existing columnId=${conflict.columnId}, new columnId=${args.columnId}`,
    });
  }

  // upsert：同 (columnId, giteaLabelId) 直接跳过
  const existing = findLabelMapByColumnAndLabelWithStore(store.get(), {
    columnId: args.columnId,
    giteaLabelId: String(args.giteaLabelId),
  });
  if (!existing) {
    const newMap = {
      id: randomUUID(),
      columnId: args.columnId,
      projectId,
      giteaLabelId: String(args.giteaLabelId),
      giteaLabelName: args.giteaLabelName,
      createdAt: Date.now(),
    };
    store.mutate((s) => {
      s.labelMaps.push(newMap);
    });
    // SQLite 镜像（best-effort）
    try {
      getDb()
        .insert(columnLabelMapping)
        .values({
          id: newMap.id,
          columnId: newMap.columnId,
          repoProjectId: projectId,
          giteaLabelId: newMap.giteaLabelId,
          giteaLabelName: newMap.giteaLabelName,
          createdAt: new Date(newMap.createdAt),
        })
        .run();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), id: newMap.id },
        'mapLabel: SQLite insert failed (non-fatal)',
      );
    }
  }

  // 返回新 DTO
  const refreshed = findColumnByIdWithStore(store.get(), args.columnId)!;
  return toColumnDto(refreshed, listColumnLabels(args.columnId));
}

// ============================================================
// ===== unmapLabel =====
export function unmapLabel(args: { columnId: string; giteaLabelId: number }): ColumnDto {
  const store = getLocalStore();
  resolveColumn(args.columnId);

  store.mutate((s) => {
    s.labelMaps = s.labelMaps.filter(
      (m) =>
        !(m.columnId === args.columnId && m.giteaLabelId === String(args.giteaLabelId)),
    );
  });

  // SQLite 镜像（best-effort）
  try {
    getDb()
      .delete(columnLabelMapping)
      .where(
        and(
          eq(columnLabelMapping.columnId, args.columnId),
          eq(columnLabelMapping.giteaLabelId, String(args.giteaLabelId)),
        ),
      )
      .run();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), columnId: args.columnId, giteaLabelId: args.giteaLabelId },
      'unmapLabel: SQLite delete failed (non-fatal)',
    );
  }

  const refreshed = findColumnByIdWithStore(store.get(), args.columnId)!;
  return toColumnDto(refreshed, listColumnLabels(args.columnId));
}
