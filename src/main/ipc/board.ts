/**
 * IPC 路由：board.* 12 个 endpoint
 *
 * 契约：02-architecture.md §5.3.7 (board.columns.*) + §5.3.8 (board.cards.*)
 *
 * 端点（5 + 7 = 12 个）：
 * - board.columns.list / create / update / reorder / delete
 * - board.cards.list / create / update / move / delete / link / unlink
 *
 * 流程：wrapIpc(Zod parse) → 调 board/{columns,cards}.ts 业务函数 → 错误转 IpcError
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
  ListBoardCardsArgsSchema,
  CreateBoardCardArgsSchema,
  UpdateBoardCardArgsSchema,
  MoveBoardCardArgsSchema,
  DeleteBoardCardArgsSchema,
  LinkBoardCardArgsSchema,
  UnlinkBoardCardArgsSchema,
  type ListBoardColumnsArgs,
  type CreateBoardColumnArgs,
  type UpdateBoardColumnArgs,
  type ReorderBoardColumnsArgs,
  type DeleteBoardColumnArgs,
  type ListBoardCardsArgs,
  type CreateBoardCardArgs,
  type UpdateBoardCardArgs,
  type MoveBoardCardArgs,
  type DeleteBoardCardArgs,
  type LinkBoardCardArgs,
  type UnlinkBoardCardArgs,
  type ColumnDto,
  type CardDto,
  type CardLinkDto,
} from './schema.js';
import { logger } from '../logger.js';
import {
  listColumns,
  createColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
  projectExists,
} from '../board/columns.js';
import {
  listCards,
  createCard,
  updateCard,
  moveCard,
  deleteCard,
  linkCard,
  unlinkCard,
} from '../board/cards.js';

/** 统一包装：与 commits.ts / pulls.ts / branches.ts / repos.ts 模式一致 */
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
  logger.info({ op: 'board.columns.create', args: { projectId: args.projectId, name: args.name } }, 'ipc start');
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
  logger.info(
    { op: 'board.columns.delete', args: { columnId: args.columnId, moveCardsTo: args.moveCardsTo } },
    'ipc start',
  );
  deleteColumn(args);
  logger.info({ op: 'board.columns.delete', latencyMs: Date.now() - start }, 'ipc done');
}

// ============================================================
// ===== board.cards.* handler =====
// ============================================================

async function listBoardCardsHandler(args: ListBoardCardsArgs): Promise<CardDto[]> {
  const start = Date.now();
  logger.info({ op: 'board.cards.list', args: { columnId: args.columnId } }, 'ipc start');
  const result = listCards(args);
  logger.info({ op: 'board.cards.list', latencyMs: Date.now() - start, count: result.length }, 'ipc done');
  return result;
}

async function createBoardCardHandler(args: CreateBoardCardArgs): Promise<CardDto> {
  const start = Date.now();
  logger.info(
    { op: 'board.cards.create', args: { columnId: args.columnId, title: args.title, links: args.links?.length ?? 0 } },
    'ipc start',
  );
  const result = createCard(args);
  logger.info({ op: 'board.cards.create', latencyMs: Date.now() - start, cardId: result.id }, 'ipc done');
  return result;
}

async function updateBoardCardHandler(args: UpdateBoardCardArgs): Promise<CardDto> {
  const start = Date.now();
  logger.info({ op: 'board.cards.update', args: { cardId: args.cardId } }, 'ipc start');
  const result = updateCard(args);
  logger.info({ op: 'board.cards.update', latencyMs: Date.now() - start, cardId: result.id }, 'ipc done');
  return result;
}

async function moveBoardCardHandler(args: MoveBoardCardArgs): Promise<CardDto> {
  const start = Date.now();
  logger.info(
    { op: 'board.cards.move', args: { cardId: args.cardId, toColumnId: args.toColumnId, toPosition: args.toPosition } },
    'ipc start',
  );
  const result = moveCard(args);
  logger.info({ op: 'board.cards.move', latencyMs: Date.now() - start, cardId: result.id }, 'ipc done');
  return result;
}

async function deleteBoardCardHandler(args: DeleteBoardCardArgs): Promise<void> {
  const start = Date.now();
  logger.info({ op: 'board.cards.delete', args: { cardId: args.cardId } }, 'ipc start');
  deleteCard(args);
  logger.info({ op: 'board.cards.delete', latencyMs: Date.now() - start }, 'ipc done');
}

async function linkBoardCardHandler(args: LinkBoardCardArgs): Promise<CardLinkDto> {
  const start = Date.now();
  logger.info(
    { op: 'board.cards.link', args: { cardId: args.cardId, refKind: args.link.refKind, refId: args.link.refId } },
    'ipc start',
  );
  const result = linkCard(args);
  logger.info({ op: 'board.cards.link', latencyMs: Date.now() - start, linkId: result.id }, 'ipc done');
  return result;
}

async function unlinkBoardCardHandler(args: UnlinkBoardCardArgs): Promise<void> {
  const start = Date.now();
  logger.info({ op: 'board.cards.unlink', args: { linkId: args.linkId } }, 'ipc start');
  unlinkCard(args);
  logger.info({ op: 'board.cards.unlink', latencyMs: Date.now() - start }, 'ipc done');
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerBoardIpc(): void {
  // board.columns.*
  wrapIpc(IpcChannel.BOARD_COLUMNS_LIST, ListBoardColumnsArgsSchema, listBoardColumnsHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_CREATE, CreateBoardColumnArgsSchema, createBoardColumnHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_UPDATE, UpdateBoardColumnArgsSchema, updateBoardColumnHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_REORDER, ReorderBoardColumnsArgsSchema, reorderBoardColumnsHandler);
  wrapIpc(IpcChannel.BOARD_COLUMNS_DELETE, DeleteBoardColumnArgsSchema, deleteBoardColumnHandler);

  // board.cards.*
  wrapIpc(IpcChannel.BOARD_CARDS_LIST, ListBoardCardsArgsSchema, listBoardCardsHandler);
  wrapIpc(IpcChannel.BOARD_CARDS_CREATE, CreateBoardCardArgsSchema, createBoardCardHandler);
  wrapIpc(IpcChannel.BOARD_CARDS_UPDATE, UpdateBoardCardArgsSchema, updateBoardCardHandler);
  wrapIpc(IpcChannel.BOARD_CARDS_MOVE, MoveBoardCardArgsSchema, moveBoardCardHandler);
  wrapIpc(IpcChannel.BOARD_CARDS_DELETE, DeleteBoardCardArgsSchema, deleteBoardCardHandler);
  wrapIpc(IpcChannel.BOARD_CARDS_LINK, LinkBoardCardArgsSchema, linkBoardCardHandler);
  wrapIpc(IpcChannel.BOARD_CARDS_UNLINK, UnlinkBoardCardArgsSchema, unlinkBoardCardHandler);
}

export function unregisterBoardIpc(): void {
  // board.columns.*
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_LIST);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_CREATE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_UPDATE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_REORDER);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_DELETE);
  // board.cards.*
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_LIST);
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_CREATE);
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_UPDATE);
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_MOVE);
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_DELETE);
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_LINK);
  ipcMain.removeHandler(IpcChannel.BOARD_CARDS_UNLINK);
}
