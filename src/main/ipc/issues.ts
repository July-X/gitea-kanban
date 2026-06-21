/**
 * IPC路由：issues.*9 个 endpoint（ADR-0002 reset）
 *
 *契约：ADR-0002 +02-architecture.md §5.3.8（新定义）
 *
 *端点（9 个 = list/get/create/update/addLabel/removeLabel/moveColumn/comment.list/comment.create）：
 * - issues.list →按 columnId过滤时走 board/card-from-issues.listIssuesFromGitea
 * - issues.get → gitea issue
 * - issues.create → gitea create issue
 * - issues.update → gitea edit issue
 * - issues.addLabel / removeLabel → gitea issue labels操作
 * - issues.moveColumn → board/move-card.moveIssueColumn（原子换绑 label）
 * - issues.comment.list / create → gitea issue comments
 *
 *历史：M2 board.cards.*7 个端点被 issues.*取代（ADR-0002）。
 */

import { ipcMain } from 'electron';
import { resolveProject } from '../board/resolveProject.js';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ListIssuesArgsSchema,
  GetIssueArgsSchema,
  CreateIssueArgsSchema,
  UpdateIssueArgsSchema,
  IssueLabelActionArgsSchema,
  MoveIssueColumnArgsSchema,
  ListIssueCommentsArgsSchema,
  CreateIssueCommentArgsSchema,
  type ListIssuesArgs,
  type ListIssuesResp,
  type GetIssueArgs,
  type CreateIssueArgs,
  type UpdateIssueArgs,
  type IssueLabelActionArgs,
  type MoveIssueColumnArgs,
  type ListIssueCommentsArgs,
  type CreateIssueCommentArgs,
  type IssueCardDto,
  type IssueCommentDto,
} from './schema.js';
import { logger } from '../logger.js';
import { listIssuesFromGitea } from '../board/card-from-issues.js';
import { moveIssueColumn } from '../board/move-card.js';
import {
  getGiteaIssue,
  createGiteaIssue,
  editGiteaIssue,
  addGiteaIssueLabel,
  removeGiteaIssueLabel,
  listGiteaIssueComments,
  createGiteaIssueComment,
} from '../gitea/issues.js';

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

/**通过 projectId找到 (giteaUrl, username, owner, repo) */
// ============================================================
// ===== issues.* handler =====
// ============================================================

async function listIssuesHandler(args: ListIssuesArgs): Promise<ListIssuesResp> {
  const start = Date.now();
  logger.info(
    {
      op: 'issues.list',
      args: {
        projectId: args.projectId,
        columnId: args.columnId,
        page: args.page,
        limit: args.limit,
      },
    },
    'ipc start',
  );
  const result = await listIssuesFromGitea(args);
  logger.info(
    { op: 'issues.list', latencyMs: Date.now() - start, count: result.items.length },
    'ipc done',
  );
  return result;
}

async function getIssueHandler(args: GetIssueArgs): Promise<IssueCardDto> {
  const start = Date.now();
  logger.info(
    { op: 'issues.get', args: { projectId: args.projectId, issueIndex: args.issueIndex } },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  const result = await getGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
  });
  logger.info(
    { op: 'issues.get', latencyMs: Date.now() - start, issueIndex: args.issueIndex },
    'ipc done',
  );
  return result;
}

async function createIssueHandler(args: CreateIssueArgs): Promise<IssueCardDto> {
  const start = Date.now();
  logger.info(
    { op: 'issues.create', args: { projectId: args.projectId, title: args.title } },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  const result = await createGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    title: args.title,
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.labelIds && args.labelIds.length > 0 ? { labelIds: args.labelIds } : {}),
    // v1.4 扩展：里程碑 + 指派人透传到 gitea issueCreateIssue
    ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
    ...(args.assignees && args.assignees.length > 0 ? { assignees: args.assignees } : {}),
    // v1.4：关联分支（gitea ref 字段，必填）
    refBranch: args.refBranch,
  });
  logger.info(
    { op: 'issues.create', latencyMs: Date.now() - start, issueIndex: result.index },
    'ipc done',
  );
  return result;
}

async function updateIssueHandler(args: UpdateIssueArgs): Promise<IssueCardDto> {
  const start = Date.now();
  logger.info(
    { op: 'issues.update', args: { projectId: args.projectId, issueIndex: args.issueIndex } },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  const result = await editGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    ...(args.patch.title !== undefined ? { title: args.patch.title } : {}),
    ...(args.patch.body !== undefined ? { body: args.patch.body } : {}),
    ...(args.patch.state !== undefined ? { state: args.patch.state } : {}),
    // v1.4：关联分支（gitea ref 字段）
    ...(args.patch.refBranch !== undefined ? { refBranch: args.patch.refBranch } : {}),
  });
  logger.info(
    { op: 'issues.update', latencyMs: Date.now() - start, issueIndex: args.issueIndex },
    'ipc done',
  );
  return result;
}

async function addIssueLabelHandler(args: IssueLabelActionArgs): Promise<void> {
  const start = Date.now();
  logger.info(
    {
      op: 'issues.addLabel',
      args: { projectId: args.projectId, issueIndex: args.issueIndex, labelId: args.labelId },
    },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  await addGiteaIssueLabel({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    labelId: args.labelId,
  });
  logger.info({ op: 'issues.addLabel', latencyMs: Date.now() - start }, 'ipc done');
}

async function removeIssueLabelHandler(args: IssueLabelActionArgs): Promise<void> {
  const start = Date.now();
  logger.info(
    {
      op: 'issues.removeLabel',
      args: { projectId: args.projectId, issueIndex: args.issueIndex, labelId: args.labelId },
    },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  await removeGiteaIssueLabel({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    labelId: args.labelId,
  });
  logger.info({ op: 'issues.removeLabel', latencyMs: Date.now() - start }, 'ipc done');
}

async function moveIssueColumnHandler(args: MoveIssueColumnArgs): Promise<IssueCardDto> {
  const start = Date.now();
  logger.info(
    {
      op: 'issues.moveColumn',
      args: {
        projectId: args.projectId,
        issueIndex: args.issueIndex,
        from: args.fromColumnId,
        to: args.toColumnId,
      },
    },
    'ipc start',
  );
  const result = await moveIssueColumn(args);
  logger.info(
    { op: 'issues.moveColumn', latencyMs: Date.now() - start, issueIndex: args.issueIndex },
    'ipc done',
  );
  return result;
}

async function listIssueCommentsHandler(args: ListIssueCommentsArgs): Promise<IssueCommentDto[]> {
  const start = Date.now();
  logger.info(
    { op: 'issues.comment.list', args: { projectId: args.projectId, issueIndex: args.issueIndex } },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  const result = await listGiteaIssueComments({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
  });
  logger.info(
    { op: 'issues.comment.list', latencyMs: Date.now() - start, count: result.length },
    'ipc done',
  );
  return result;
}

async function createIssueCommentHandler(args: CreateIssueCommentArgs): Promise<IssueCommentDto> {
  const start = Date.now();
  logger.info(
    {
      op: 'issues.comment.create',
      args: { projectId: args.projectId, issueIndex: args.issueIndex },
    },
    'ipc start',
  );
  const proj = resolveProject(args.projectId);
  const result = await createGiteaIssueComment({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    body: args.body,
  });
  logger.info(
    { op: 'issues.comment.create', latencyMs: Date.now() - start, commentId: result.id },
    'ipc done',
  );
  return result;
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerIssuesIpc(): void {
  wrapIpc(IpcChannel.ISSUES_LIST, ListIssuesArgsSchema, listIssuesHandler);
  wrapIpc(IpcChannel.ISSUES_GET, GetIssueArgsSchema, getIssueHandler);
  wrapIpc(IpcChannel.ISSUES_CREATE, CreateIssueArgsSchema, createIssueHandler);
  wrapIpc(IpcChannel.ISSUES_UPDATE, UpdateIssueArgsSchema, updateIssueHandler);
  wrapIpc(IpcChannel.ISSUES_ADD_LABEL, IssueLabelActionArgsSchema, addIssueLabelHandler);
  wrapIpc(IpcChannel.ISSUES_REMOVE_LABEL, IssueLabelActionArgsSchema, removeIssueLabelHandler);
  wrapIpc(IpcChannel.ISSUES_MOVE_COLUMN, MoveIssueColumnArgsSchema, moveIssueColumnHandler);
  wrapIpc(IpcChannel.ISSUES_COMMENT_LIST, ListIssueCommentsArgsSchema, listIssueCommentsHandler);
  wrapIpc(
    IpcChannel.ISSUES_COMMENT_CREATE,
    CreateIssueCommentArgsSchema,
    createIssueCommentHandler,
  );
}

export function unregisterIssuesIpc(): void {
  ipcMain.removeHandler(IpcChannel.ISSUES_LIST);
  ipcMain.removeHandler(IpcChannel.ISSUES_GET);
  ipcMain.removeHandler(IpcChannel.ISSUES_CREATE);
  ipcMain.removeHandler(IpcChannel.ISSUES_UPDATE);
  ipcMain.removeHandler(IpcChannel.ISSUES_ADD_LABEL);
  ipcMain.removeHandler(IpcChannel.ISSUES_REMOVE_LABEL);
  ipcMain.removeHandler(IpcChannel.ISSUES_MOVE_COLUMN);
  ipcMain.removeHandler(IpcChannel.ISSUES_COMMENT_LIST);
  ipcMain.removeHandler(IpcChannel.ISSUES_COMMENT_CREATE);
}
