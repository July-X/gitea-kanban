/**
 * IPC 路由：board.columns.* 7 个 endpoint
 *
 * 契约：ADR-0002 + 02-architecture.md §5.3.7
 *
 * 端点（7 个）：
 * - board.columns.list / create / update / reorder / delete
 * - board.columns.mapLabel / unmapLabel
 *
 * 注：M2 board.cards.* 7 个端点 **已删除**（ADR-0002 reset），被 issues.* / moveColumn 取代
 *
 * 流程：wrapIpc(Zod parse) → dispatch(op, args) → 调 board/columns.ts 业务函数 → 错误转 IpcError
 *
 * ADR-0003 Phase 3：写 op 走 dispatch 统一入口
 *   - board.columns.* 都是纯本地 op（仅改 localStore，不调 gitea）
 *   - execute 永远跑，IPC 返 mode: 'online' 永远
 *   - 未来加 gitea 副作用（如远程同步）时实现 offlineApply 即可
 *
 * 边界（任务 prompt §严格边界）：
 * - **不**改 schema / IpcErrorCode / IPC 端点清单
 * - **不**碰 src/renderer/**
 * - wrapIpc 模式与 commits.ts / pulls.ts / branches.ts / repos.ts 保持一致
 */

import { ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListBoardColumnsArgsSchema,
  CreateBoardColumnArgsSchema,
  UpdateBoardColumnArgsSchema,
  ReorderBoardColumnsArgsSchema,
  DeleteBoardColumnArgsSchema,
  MapColumnLabelArgsSchema,
  UnmapColumnLabelArgsSchema,
  type ListBoardColumnsArgs,
  type CreateBoardColumnArgs,
  type UpdateBoardColumnArgs,
  type ReorderBoardColumnsArgs,
  type DeleteBoardColumnArgs,
  type MapColumnLabelArgs,
  type UnmapColumnLabelArgs,
  type ColumnDto,
} from './schema.js';
import { logger } from '../logger.js';
import {
  listColumns,
  createColumn as _createColumn,
  updateColumn as _updateColumn,
  reorderColumns as _reorderColumns,
  deleteColumn as _deleteColumn,
  mapLabel as _mapLabel,
  unmapLabel as _unmapLabel,
  projectExists,
} from '../board/columns.js';
import { dispatch, registerOp } from '../sync/dispatch.js';

/** 统一包装：parse 入参 → 调 handler → 错误转 IpcError */
function wrapIpc<TArgs, TResult>(
  channel: string,
  schema: { parse: (raw: unknown) => TArgs },
  handler: (args: TArgs) => Promise<TResult>,
): void {
  ipcMain.handle(channel, async (_event, rawArgs: unknown) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled('debug')) {
        logger.debug({ channel, latencyMs: Date.now() - start }, 'ipc ok');
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, 'ipc business error');
        throw err.toJSON();
      }
      if (err && typeof err === 'object' && 'issues' in err) {
        const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
        const issue = zodErr.issues[0];
        const path = issue?.path.join('.') ?? '<root>';
        const message = issue?.message ?? '参数校验失败';
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, 'ipc validation failed');
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, 'ipc internal error');
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: '应用内部错误，已记录日志',
        hint: '请稍后重试，或联系开发者',
        cause: err instanceof Error ? err.message : String(err),
      });
      throw i.toJSON();
    }
  });
}

// ===== handler =====

async function listBoardColumnsHandler(args: ListBoardColumnsArgs): Promise<ColumnDto[]> {
  const start = Date.now();
  logger.info({ op: 'board.columns.list', args }, 'ipc start');
  if (!projectExists(args.projectId)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目不存在',
      hint: '请先在仓库列表中重新添加该仓库为项目',
    });
  }
  // listColumns 现在是 async（调 gitea 拉 label name/color；Gitea 优先原则 2026-06-15）
  const result = await listColumns(args.projectId);
  logger.info({ op: 'board.columns.list', latencyMs: Date.now() - start, count: result.length }, 'ipc done');
  return result;
}

async function createBoardColumnHandler(args: CreateBoardColumnArgs): Promise<ColumnDto> {
  const start = Date.now();
  logger.info({ op: 'board.columns.create', args: { projectId: args.projectId, title: args.title } }, 'ipc start');
  if (!projectExists(args.projectId)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目不存在',
    });
  }
  // ADR-0003 Phase 3：走 dispatch（纯本地 op，缺省 offlineApply = execute）
  const { result } = await dispatch<CreateBoardColumnArgs, ColumnDto>('board.columns.create', args);
  logger.info({ op: 'board.columns.create', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
  return result;
}

async function updateBoardColumnHandler(args: UpdateBoardColumnArgs): Promise<ColumnDto> {
  const start = Date.now();
  logger.info({ op: 'board.columns.update', args: { columnId: args.columnId } }, 'ipc start');
  const { result } = await dispatch<UpdateBoardColumnArgs, ColumnDto>('board.columns.update', args);
  logger.info({ op: 'board.columns.update', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
  return result;
}

async function reorderBoardColumnsHandler(args: ReorderBoardColumnsArgs): Promise<void> {
  const start = Date.now();
  logger.info({ op: 'board.columns.reorder', args: { projectId: args.projectId, count: args.orderedIds.length } }, 'ipc start');
  if (!projectExists(args.projectId)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目不存在',
    });
  }
  await dispatch('board.columns.reorder', args);
  logger.info({ op: 'board.columns.reorder', latencyMs: Date.now() - start }, 'ipc done');
}

async function deleteBoardColumnHandler(args: DeleteBoardColumnArgs): Promise<void> {
  const start = Date.now();
  logger.info({ op: 'board.columns.delete', args: { columnId: args.columnId } }, 'ipc start');
  await dispatch('board.columns.delete', args);
  logger.info({ op: 'board.columns.delete', latencyMs: Date.now() - start }, 'ipc done');
}

async function mapColumnLabelHandler(args: MapColumnLabelArgs): Promise<ColumnDto> {
  const start = Date.now();
  logger.info({ op: 'board.columns.mapLabel', args: { columnId: args.columnId, giteaLabelId: args.giteaLabelId } }, 'ipc start');
  const { result } = await dispatch<MapColumnLabelArgs, ColumnDto>('board.columns.mapLabel', args);
  logger.info({ op: 'board.columns.mapLabel', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
  return result;
}

async function unmapColumnLabelHandler(args: UnmapColumnLabelArgs): Promise<ColumnDto> {
  const start = Date.now();
  logger.info({ op: 'board.columns.unmapLabel', args: { columnId: args.columnId, giteaLabelId: args.giteaLabelId } }, 'ipc start');
  const { result } = await dispatch<UnmapColumnLabelArgs, ColumnDto>('board.columns.unmapLabel', args);
  logger.info({ op: 'board.columns.unmapLabel', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
  return result;
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerBoardIpc(): void {
  // ADR-0003 Phase 3：注册 op 到 dispatch 中心
  //   board.columns.* 都是纯本地 op（仅改 localStore），不调 gitea
  //   **不**实现 offlineApply → dispatch 缺省 = execute → IPC 永远 mode: 'online'
  registerOp<CreateBoardColumnArgs, ColumnDto>('board.columns.create', {
    execute: _createColumn,
  });
  registerOp<UpdateBoardColumnArgs, ColumnDto>('board.columns.update', {
    execute: _updateColumn,
  });
  registerOp<ReorderBoardColumnsArgs, void>('board.columns.reorder', {
    execute: _reorderColumns,
  });
  registerOp<DeleteBoardColumnArgs, void>('board.columns.delete', {
    execute: _deleteColumn,
  });
  registerOp<MapColumnLabelArgs, ColumnDto>('board.columns.mapLabel', {
    execute: _mapLabel,
  });
  registerOp<UnmapColumnLabelArgs, ColumnDto>('board.columns.unmapLabel', {
    execute: _unmapLabel,
  });

  // list 是纯读，不走 dispatch
  wrapIpc(IpcChannel.BOARD_COLUMNS_LIST, ListBoardColumnsArgsSchema, listBoardColumnsHandler);
  // 7 个写 op 走 dispatch
  wrapIpc(IpcChannel.BOARD_COLUMNS_CREATE, CreateBoardColumnArgsSchema, createBoardColumnHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_UPDATE, UpdateBoardColumnArgsSchema, updateBoardColumnHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_REORDER, ReorderBoardColumnsArgsSchema, reorderBoardColumnsHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_DELETE, DeleteBoardColumnArgsSchema, deleteBoardColumnHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_MAP_LABEL, MapColumnLabelArgsSchema, mapColumnLabelHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_UNMAP_LABEL, UnmapColumnLabelArgsSchema, unmapColumnLabelHandler);
}

export function unregisterBoardIpc(): void {
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_LIST);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_CREATE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_UPDATE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_REORDER);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_DELETE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_MAP_LABEL);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_UNMAP_LABEL);
}
