/**
 * IPC 路由：members.* 1 个 endpoint（a3 新增）
 *
 * 契约：plan_32018da5 a3-ipc-handlers-4-endpoints
 * 端点（1 个）：
 * - members.list → 列仓库成员（gitea /repos/{owner}/{repo}/collaborators + per-user permission）
 *
 * 关键设计（a3 拍板）：
 * - 出参 = `CollaboratorDto[]` 数组，**不**包 `{items, hasMore}`（frontend `useMemberStore.list`
 *   已写 `as MemberDto[]` 直读数组；保持对齐；见 schema.ts ListMembersRespSchema 注释）
 * - v1 不缓存（gitea 端 /collaborators 不分页，单次拉 N+1 permission；命中 < 100 / repo，
 *   缓存策略 v2 评估）
 * - gitea layer 已在 listRepoCollaborators 里做 per-user 失败降级（permission='unknown'），
 *   IPC 层不重复处理
 *
 * 流程：wrapIpc(Zod parse) → resolveProject(projectId) → listRepoCollaborators → 返数组
 */

import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListMembersArgsSchema,
  type ListMembersArgs,
  type ListMembersResp,
} from './schema.js';
import { logger } from '../logger.js';
import { getDb } from '../cache/sqlite.js';
import { repoProjects } from '../cache/schema/repoProjects.js';
import { giteaAccounts } from '../cache/schema/giteaAccounts.js';
import { listRepoCollaborators } from '../gitea/repos.js';

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

/** 通过 projectId 找到 (giteaUrl, username, owner, repo) */
function resolveProject(projectId: string): {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
} {
  const db = getDb();
  const row = db
    .select()
    .from(repoProjects)
    .where(eq(repoProjects.id, projectId))
    .all()[0];
  if (!row) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目不存在',
      hint: '请先在仓库列表中重新添加该仓库为项目',
    });
  }
  const acc = db
    .select()
    .from(giteaAccounts)
    .where(eq(giteaAccounts.id, row.giteaAccountId))
    .all()[0];
  if (!acc) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'gitea 账户不存在（项目孤儿）',
      hint: '请重新连接 gitea 账户',
    });
  }
  return {
    giteaUrl: acc.giteaUrl,
    username: acc.username,
    owner: row.owner,
    repo: row.name,
  };
}

// ============================================================
// ===== members.list handler =====
// ============================================================

async function listMembersHandler(args: ListMembersArgs): Promise<ListMembersResp> {
  const start = Date.now();
  const op = 'members.list';
  logger.info({ op, args: { projectId: args.projectId } }, 'ipc start');

  const proj = resolveProject(args.projectId);

  // 调 gitea 包装层：单次拉 collaborators 列表 + parallel per-user permission
  // gitea 层内部已处理 per-user 失败降级（permission='unknown'），
  // IPC 层**不**重复处理（详见 src/main/gitea/repos.ts:152-227 listRepoCollaborators）
  const result = await listRepoCollaborators({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
  });

  // 出参 = 数组（**不**包 {items, hasMore}，见 schema 注释 + 拍板理由）
  const resp: ListMembersResp = result.items;

  logger.info(
    { op, latencyMs: Date.now() - start, count: resp.length, hasMore: result.hasMore },
    'ipc done',
  );
  return resp;
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerMembersIpc(): void {
  wrapIpc(IpcChannel.MEMBERS_LIST, ListMembersArgsSchema, listMembersHandler);
}

export function unregisterMembersIpc(): void {
  ipcMain.removeHandler(IpcChannel.MEMBERS_LIST);
}
