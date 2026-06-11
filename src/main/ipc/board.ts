/**
 * IPC路由：board.columns.*7 个 endpoint
 *
 *契约：ADR-0002 +02-architecture.md §5.3.7
 *
 *端点（7 个）：
 * - board.columns.list / create / update / reorder / delete
 * - board.columns.mapLabel / unmapLabel
 *
 * 注：M2 board.cards.*7 个端点**已删除**（ADR-0002 reset），被 issues.* / moveColumn取代
 *
 *流程：wrapIpc(Zod parse) →调 board/columns.ts业务函数 →错误转 IpcError
 *
 *边界（任务 prompt §严格边界）：
 * - **不**改 schema / IpcErrorCode / IPC端点清单
 * - **不**碰 src/renderer/**
 * - wrapIpc模式与 commits.ts / pulls.ts / branches.ts / repos.ts保持一致
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
 createColumn,
 updateColumn,
 reorderColumns,
 deleteColumn,
 mapLabel,
 unmapLabel,
 projectExists,
} from '../board/columns.js';

/**统一包装：与 commits.ts / pulls.ts / branches.ts / repos.ts模式一致 */
function wrapIpc<TArgs, TResult>(
 channel: string,
 schema: { parse: (raw: unknown) => TArgs },
 handler: (args: TArgs) => Promise<TResult> | TResult,
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

// ============================================================
// ===== board.columns.* handler =====
// ============================================================

async function listBoardColumnsHandler(args: ListBoardColumnsArgs): Promise<ColumnDto[]> {
 const start = Date.now();
 logger.info({ op: 'board.columns.list', args: { projectId: args.projectId } }, 'ipc start');
 if (!projectExists(args.projectId)) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: '项目不存在',
 hint: '请先在仓库列表中重新添加该仓库为项目',
 });
 }
 const result = listColumns(args.projectId);
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
 const result = createColumn(args);
 logger.info({ op: 'board.columns.create', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
 return result;
}

async function updateBoardColumnHandler(args: UpdateBoardColumnArgs): Promise<ColumnDto> {
 const start = Date.now();
 logger.info({ op: 'board.columns.update', args: { columnId: args.columnId } }, 'ipc start');
 const result = updateColumn(args);
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
 reorderColumns(args);
 logger.info({ op: 'board.columns.reorder', latencyMs: Date.now() - start }, 'ipc done');
}

async function deleteBoardColumnHandler(args: DeleteBoardColumnArgs): Promise<void> {
 const start = Date.now();
 logger.info({ op: 'board.columns.delete', args: { columnId: args.columnId } }, 'ipc start');
 deleteColumn(args);
 logger.info({ op: 'board.columns.delete', latencyMs: Date.now() - start }, 'ipc done');
}

async function mapColumnLabelHandler(args: MapColumnLabelArgs): Promise<ColumnDto> {
 const start = Date.now();
 logger.info({ op: 'board.columns.mapLabel', args: { columnId: args.columnId, giteaLabelId: args.giteaLabelId } }, 'ipc start');
 const result = mapLabel(args);
 logger.info({ op: 'board.columns.mapLabel', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
 return result;
}

async function unmapColumnLabelHandler(args: UnmapColumnLabelArgs): Promise<ColumnDto> {
 const start = Date.now();
 logger.info({ op: 'board.columns.unmapLabel', args: { columnId: args.columnId, giteaLabelId: args.giteaLabelId } }, 'ipc start');
 const result = unmapLabel(args);
 logger.info({ op: 'board.columns.unmapLabel', latencyMs: Date.now() - start, columnId: result.id }, 'ipc done');
 return result;
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerBoardIpc(): void {
 wrapIpc(IpcChannel.BOARD_COLUMNS_LIST, ListBoardColumnsArgsSchema, listBoardColumnsHandler);
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
