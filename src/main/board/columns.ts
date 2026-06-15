/**
 * 看板列业务层（ADR-0002 reset + ADR-0003 Phase 2 切 localStore + Phase 3 删 SQLite）
 *
 * 职责（docs/adr/0002-board-data-source-reset.md + 02-architecture §5.3.7）：
 * - 7 个 IPC handler 调用的纯业务函数（不接 wrapIpc 包装 —— wrapIpc 在 ipc/board.ts）
 * - 列/列-标签映射改 localStore（业务配置）
 * - 撤销栈写入：每次写操作调 recordUndo（M6 已切 in-memory）
 * - 顺序用浮点 position 避免全表重写（POS=1024）
 *
 * 数据源原则（2026-06-15 user 拍板）：
 * - App 是"Gitea 显示/聚合/简化"平台，**gitea 是 label 数据的 source of truth**
 * - `listColumns` 调 gitea 拉最新 label name/color（**不**依赖 localStore 缓存的 giteaLabelName 字段）
 * - `mapLabel` 调 gitea 校验 label 真实存在（写 localStore 前先验证 gitea 端）
 * - 已删 label 在 `listColumns` 返回时**过滤掉**（不展示给用户）
 * - gitea 拉失败 → 抛 NETWORK_OFFLINE（不静默降级用 stale 数据）
 *
 * 边界（ADR-0002 + AGENTS §5.1）：
 * - **不**接 wrapIpc（IPC 包装在 ipc/board.ts）
 * - **不**改 schema / IpcErrorCode
 * - **不**做权限校验
 * - **不**做 columns 的 cache_entries 缓存（业务类型变更频繁）
 * - **不**改 resolveProject.ts（59 个调用点跨 9 个 IPC 文件 —— 单独拍板）
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
import { listGiteaLabels } from '../gitea/labels.js';
import { resolveProject } from './resolveProject.js';

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
 *
 * 关键：name/color 来自 caller 传入的 gitea 实时数据（`liveLabelsById` 映射），
 * **不**读 localStore.labelMaps 的 giteaLabelName 缓存字段（避免漂移）
 */
function toColumnDto(
  col: {
    id: string;
    projectId: string;
    title: string;
    position: number;
    createdAt: number;
    wipLimit?: number | null;
  },
  boundLabelIds: number[],
  liveLabelsById: Map<number, { name: string; color: string }>,
): ColumnDto {
  const labels = boundLabelIds
    .map((id) => {
      const live = liveLabelsById.get(id);
      // gitea 端已删的 label → 跳过（不展示给用户，避免误导）
      if (!live) return null;
      return { id, name: live.name, color: live.color };
    })
    .filter((l): l is { id: number; name: string; color: string } => l !== null);
  return {
    id: col.id,
    projectId: col.projectId,
    title: col.title,
    position: col.position,
    labels,
    wipLimit: normalizeWipLimit(col.wipLimit),
  };
}

/**
 * 单列 DTO 转换（labels 来自 caller 给的扁平数组，**不**调 gitea）
 *
 * 用途：单列写操作（create/update/unmapLabel）返 DTO 时避免再调一次 gitea 拉全表
 * - `name` 取自 caller 传（mapLabel 用 gitea 实时名；create/unmapLabel 留空 color）
 * - `color` 字段：mapLabel 从 gitea 拉、create/unmapLabel 留空字符串（renderer 不读后端 DTO）
 */
function toColumnDtoFromLabels(
  col: {
    id: string;
    projectId: string;
    title: string;
    position: number;
    createdAt: number;
    wipLimit?: number | null;
  },
  labels: Array<{ id: number; name: string; color: string }>,
): ColumnDto {
  return {
    id: col.id,
    projectId: col.projectId,
    title: col.title,
    position: col.position,
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    wipLimit: normalizeWipLimit(col.wipLimit),
  };
}

/**
 * WIP 上限归一化（plan_25cc4562 · Task B）：
 * - 正整数 → 保留
 * - 0 / 负数 / 非整数 → null（视作"无限"，容错旧数据 / 输入错误）
 * - null / undefined → null（无限）
 *
 * 为何不在写入时拒绝 0？
 * - 业务语义 0 = "一卡都不能放"无意义
 * - 但容错路径上（旧 state 没 wipLimit 字段）选 null 比 422 更友好
 *   —— 真正的非法值已在 updateColumn 入口用 VALIDATION_FAILED 拦截
 */
function normalizeWipLimit(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/**
 * 拿某 project 下全部列 + 绑定的 labels
 *
 * 数据源：localStore 拿列定义 + labelMap 关系（**配置**）
 *        gitea 实时拉 label name/color（**展示数据** —— gitea 是真理源）
 *
 * 失败策略：gitea 拉失败 → 抛 NETWORK_OFFLINE（不静默降级用 stale 数据）
 * 过滤策略：gitea 端已删的 label 在 DTO 中**过滤掉**（用户看到的就是 gitea 真实存在）
 */
export async function listColumns(projectId: string): Promise<ColumnDto[]> {
  const state = getLocalStore().get();
  const cols = listColumnsByProjectWithStore(state, projectId);

  // 1. 收集所有绑定到本 project 的 label id（跨列去重）
  const allLabelMaps = state.labelMaps.filter((m) => m.projectId === projectId);
  const boundLabelIds = Array.from(new Set(allLabelMaps.map((m) => Number(m.giteaLabelId))));

  // 2. 拉 gitea 实时 label（一次 list 拿全）
  //    无绑定 label → 跳过网络调用（让空列场景不浪费请求）
  let liveLabelsById: Map<number, { name: string; color: string }> = new Map();
  if (boundLabelIds.length > 0) {
    const proj = resolveProject(projectId);
    const resp = await listGiteaLabels({
      giteaUrl: proj.giteaUrl,
      username: proj.username,
      owner: proj.owner,
      repo: proj.repo,
      page: 1,
      limit: 50, // 单仓库 label 通常 < 50，gitea 端无 project 概念后全 repo label 拉一次
    });
    liveLabelsById = new Map(resp.items.map((l) => [l.id, { name: l.name, color: l.color }]));
  }

  // 3. 每列拼 DTO：按 column 过滤已绑 label id（保证只展示该列绑的）
  return cols.map((c) => {
    const colBoundIds = listLabelMapsByColumnWithStore(state, c.id).map((m) => Number(m.giteaLabelId));
    return toColumnDto(c, colBoundIds, liveLabelsById);
  });
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
    wipLimit: null, // v1.3 默认无限（UI 列设置弹窗可改）
  };

  getLocalStore().mutate((s) => {
    s.columns.push(createdRow);
  });

  return toColumnDtoFromLabels(createdRow, []);
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

  // 业务层二次校验 wipLimit（Zod 已在 IPC 入口校验过；这里兜底防止业务层被 direct 调时漏过）
  // Zod 接受的正整数已经过滤了负数 / 0 / 浮点；这里只需要再挡一次 NaN 之类
  if (args.patch.wipLimit !== undefined) {
    if (
      args.patch.wipLimit !== null &&
      (!Number.isInteger(args.patch.wipLimit) || args.patch.wipLimit <= 0)
    ) {
      throw new IpcError({
        code: IpcErrorCode.VALIDATION_FAILED,
        message: 'wipLimit 必须是正整数或 null（无限）',
        hint: '请输入 ≥ 1 的整数，留空表示无限',
      });
    }
  }

  store.mutate((s) => {
    const idx = s.columns.findIndex((c) => c.id === args.columnId);
    if (idx < 0) return;
    s.columns[idx] = {
      ...s.columns[idx]!,
      ...(args.patch.title !== undefined ? { title: args.patch.title } : {}),
      ...(args.patch.position !== undefined ? { position: args.patch.position } : {}),
      ...(args.patch.wipLimit !== undefined ? { wipLimit: args.patch.wipLimit } : {}),
    };
  });

  const refreshed = findColumnByIdWithStore(store.get(), args.columnId)!;
  // updateColumn 只动 title/position/wipLimit，labels 不变；name 来自 localStore 缓存，color 留空（renderer 不读后端 DTO 的 color）
  const labels = listLabelMapsByColumnWithStore(store.get(), args.columnId).map((m) => ({
    id: Number(m.giteaLabelId),
    name: m.giteaLabelName,
    color: '',
  }));
  return toColumnDtoFromLabels(refreshed, labels);
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
 * - **写 localStore 前先调 gitea 校验 label 真实存在**（Gitea 优先原则）：
 *   - 已删 → 抛 NOT_FOUND（提示用户刷新 label 列表）
 *   - 网络失败 → 抛 NETWORK_OFFLINE（不静默写入 stale 数据）
 *   - name/color **以 gitea 实时数据为准**写 localStore（避免 caller 传 stale name）
 */
export async function mapLabel(args: {
  columnId: string;
  giteaLabelId: number;
  giteaLabelName: string;
}): Promise<ColumnDto> {
  const store = getLocalStore();
  const { projectId } = resolveColumn(args.columnId);

  // 1. 调 gitea 校验 label 存在（一次 list 拿全，过滤）
  const proj = resolveProject(projectId);
  const resp = await listGiteaLabels({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    page: 1,
    limit: 50,
  });
  const liveLabel = resp.items.find((l) => l.id === args.giteaLabelId);
  if (!liveLabel) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '该 gitea label 已不存在',
      hint: '请在 label 选择器中刷新后重选',
      cause: `giteaLabelId=${args.giteaLabelId} not found in repo ${proj.owner}/${proj.repo}`,
    });
  }

  // 2. 一 label 一列校验
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

  // 3. 幂等检查 + 写入（name 取 gitea 实时值，不是 caller 传的）
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
      giteaLabelName: liveLabel.name, // Gitea 优先：以 gitea 实时 name 写
      createdAt: Date.now(),
    };
    store.mutate((s) => {
      s.labelMaps.push(newMap);
    });
  } else if (existing.giteaLabelName !== liveLabel.name) {
    // 漂移修复：caller 之前传的 name 跟 gitea 不一致 → 同步修正
    store.mutate((s) => {
      const idx = s.labelMaps.findIndex(
        (m) => m.columnId === args.columnId && m.giteaLabelId === String(args.giteaLabelId),
      );
      if (idx >= 0) {
        s.labelMaps[idx] = { ...s.labelMaps[idx]!, giteaLabelName: liveLabel.name };
      }
    });
  }

  // 4. 返 DTO（color 用 gitea 实时值）
  const refreshed = findColumnByIdWithStore(store.get(), args.columnId)!;
  return toColumnDtoFromLabels(refreshed, [
    { id: liveLabel.id, name: liveLabel.name, color: liveLabel.color },
  ]);
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
  const labels = listLabelMapsByColumnWithStore(store.get(), args.columnId).map((m) => ({
    id: Number(m.giteaLabelId),
    name: m.giteaLabelName,
    color: '',
  }));
  return toColumnDtoFromLabels(refreshed, labels);
}
