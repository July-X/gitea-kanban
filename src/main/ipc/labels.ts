/**
 * IPC路由：labels.*2 个 endpoint（ADR-0002）
 *
 *契约：ADR-0002
 *端点（2 个）：
 * - labels.list → 列仓库所有 gitea label（看板列绑 label 前的前置准备）
 * - labels.create → 在 gitea 创建新 label
 */

import { ipcMain } from 'electron';
import { resolveProject } from "../board/resolveProject.js";
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
 IpcChannel,
 ListLabelsArgsSchema,
 CreateLabelArgsSchema,
 type ListLabelsArgs,
 type ListLabelsResp,
 type CreateLabelArgs,
 type LabelDto,
} from './schema.js';
import { logger } from '../logger.js';
import {
 listGiteaLabels,
 createGiteaLabel,
} from '../gitea/labels.js';

/**统一包装：与其它 IPC handler一致 */
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

async function listLabelsHandler(args: ListLabelsArgs): Promise<ListLabelsResp> {
 const start = Date.now();
 logger.info({ op: 'labels.list', args: { projectId: args.projectId } }, 'ipc start');
 const proj = resolveProject(args.projectId);
 const result = await listGiteaLabels({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 page: args.page,
 limit: args.limit,
 });
 logger.info({ op: 'labels.list', latencyMs: Date.now() - start, count: result.items.length }, 'ipc done');
 return { items: result.items, hasMore: result.hasMore };
}

async function createLabelHandler(args: CreateLabelArgs): Promise<LabelDto> {
 const start = Date.now();
 logger.info({ op: 'labels.create', args: { projectId: args.projectId, name: args.name } }, 'ipc start');
 const proj = resolveProject(args.projectId);
 const result = await createGiteaLabel({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 name: args.name,
 color: args.color,
 ...(args.description !== undefined ? { description: args.description } : {}),
 });
 logger.info({ op: 'labels.create', latencyMs: Date.now() - start, labelId: result.id }, 'ipc done');
 return result;
}

export function registerLabelsIpc(): void {
 wrapIpc(IpcChannel.LABELS_LIST, ListLabelsArgsSchema, listLabelsHandler);
 wrapIpc(IpcChannel.LABELS_CREATE, CreateLabelArgsSchema, createLabelHandler);
}

export function unregisterLabelsIpc(): void {
 ipcMain.removeHandler(IpcChannel.LABELS_LIST);
 ipcMain.removeHandler(IpcChannel.LABELS_CREATE);
}
