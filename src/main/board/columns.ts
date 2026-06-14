/**
 * 看板列业务层（ADR-0002 reset + ADR-0003 Phase 2 切 localStore + Phase 3 删 SQLite）
 *
 * 职责（docs/adr/0002-board-data-source-reset.md + 02-architecture §5.3.7）：
 * - 7 个 IPC handler 调用的纯业务函数（不接 wrapIpc 包装 —— wrapIpc 在 ipc/board.ts）
 * - **纯 localStore**：列/列-标签映射都改 localStore
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
 * ADR-0003 Phase 3：业务态走 localStore，**没有** SQLite 镜像分支
 * （删了 SQLite 双写后，写操作只改 localStore；崩恢复靠 localStore.atomic write）
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

/** position 间隔 */
export const POSITION_STEP = 1024;

/**
 * 通过 projectId 校验项目存在
 * ADR-0003 Phase 3：走 localStore
 */
export function projectExists(projectId: string): boolean {
  return getLocalStore()
    .get()
    .projects.some((p) => p.id === projectId);
}

/**
 * 通过 columnId 拿 (projectId)
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
 * ADR-0003 Phase 3：localStore only
 */
export function listColumns(projectId: string): ColumnDto[] {
  const cols = listColumnsByProjectWithStore(getLocalStore().get(), projectId);
  return cols.map((c) => toColumnDto(c, listColumnLabels(c.id)));
}

// ============================================================
// ===== create =====
export function createColumn(args: CreateBoardColumnArgs): ColumnDto {
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
  const existing = columnIdsByProjectWithStore(store.get(), args.projectId).sort();
  const inputSorted = [...args.orderedIds].sort();
  if (existing.length !== inputSorted.length || existing.some((id, i) => id !== inputSorted[i])) {
    throw new IpcError({
      code: IpcErrorCode.VALIDATION_FAILED,
      message: 'orderedIds 必须完整覆盖该 project 的所有列 id',
      hint: '请重新拉取列列表后重排',
    });
  }

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
}

// ============================================================
// ===== delete =====
/**
 * 删除列（labelMaps **不**级联删——labelMaps 跨列共享保留语义）
 */
export function deleteColumn(args: { columnId: string }): void {
  resolveColumn(args.columnId);
  getLocalStore().mutate((s) => {
    s.columns = s.columns.filter((c) => c.id !== args.columnId);
    s.labelMaps = s.labelMaps.filter((m) => m.columnId !== args.columnId);
  });
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
  }

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

  const refreshed = findColumnByIdWithStore(store.get(), args.columnId)!;
  return toColumnDto(refreshed, listColumnLabels(args.columnId));
}
