/**
 * IPC 路由：milestones.* 1 个 endpoint（v1.4 新增）
 *
 * 端点（1 个）：
 * - milestones.list → 列仓库里程碑（gitea GET /repos/{owner}/{repo}/milestones?state=all）
 *
 * 用途：新建议题弹窗选里程碑（CreateIssueDialog）。
 * gitea issueCreateIssue 的 milestone 字段 = milestone id，弹窗选中后传到 issues.create。
 *
 * 流程：wrapIpc(Zod parse) → resolveProject(projectId) → listGiteaMilestones → 返 {items, hasMore}
 */

import { ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListMilestonesArgsSchema,
  type ListMilestonesArgs,
  type ListMilestonesResp,
} from './schema.js';
import { logger } from '../logger.js';
import { listGiteaMilestones } from '../gitea/milestones.js';
import { resolveProject } from '../board/resolveProject.js';

/** 统一包装：与其它 IPC handler 一致 */
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

async function listMilestonesHandler(args: ListMilestonesArgs): Promise<ListMilestonesResp> {
  const start = Date.now();
  logger.info(
    { op: 'milestones.list', args: { projectId: args.projectId, state: args.state } },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  const result = await listGiteaMilestones({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    state: args.state,
    page: args.page,
    limit: args.limit,
  });
  logger.info(
    { op: 'milestones.list', latencyMs: Date.now() - start, count: result.items.length },
    'ipc done',
  );
  return { items: result.items, hasMore: result.hasMore };
}

export function registerMilestonesIpc(): void {
  wrapIpc(IpcChannel.MILESTONES_LIST, ListMilestonesArgsSchema, listMilestonesHandler);
}

export function unregisterMilestonesIpc(): void {
  ipcMain.removeHandler(IpcChannel.MILESTONES_LIST);
}
