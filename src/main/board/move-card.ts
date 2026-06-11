/**
 *看板拖拽换列业务层（ADR-0002 §"业务"）
 *
 *职责：
 * - 实现 issues.moveColumn IPC handler
 * -原子地把 issue 的 labels 从 fromColumn绑的 →toColumn绑的
 * -校验（前置）：fromColumn绑的 labels是 issue 真有的（防漂移）
 *
 * 设计（ADR-0002 §"业务约束"）：
 * - 列绑 label改绑 = gitea issues.addLabel / removeLabel（不存"卡片"本地实体）
 * -一次拖拽 = 多组 label 操作（fromColumn绑的 N 个 +toColumn绑的 M 个）
 * -部分失败回滚：先 addLabel(toColumn)，全部成功后 removeLabel(fromColumn)——反向防漂移
 *
 *边界：
 * - **不**直接调 gitea API（走 src/main/gitea/issues.ts包装）
 * - **不**存"卡片位置"本地（位置在 gitea端 label上）
 * - **不**改 schema / IpcErrorCode / IPC端点清单
 */

import { eq, and, asc } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { boardColumns } from '../cache/schema/boardColumns.js';
import { columnLabelMapping } from '../cache/schema/columnLabelMapping.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import type { MoveIssueColumnArgs, IssueCardDto } from '../ipc/schema.js';
import { resolveProject } from './resolveProject.js';
import {
 removeGiteaIssueLabel,
 addGiteaIssueLabel,
 getGiteaIssue,
} from '../gitea/issues.js';

/**
 *拖拽换列（原子）
 *
 *步骤：
 *1. resolve project → giteaUrl + username + owner + repo
 *2.拿 fromColumn绑的 labels + toColumn绑的 labels（一次 SQL）
 *3.拉 issue 当前真实 labels（gitea）——防漂移校验
 *4. addLabel(toColumn绑的 labels) 全成功 → removeLabel(fromColumn绑的 labels) 全成功
 *5. （可选）update card_issue_link派生缓存
 */
export async function moveIssueColumn(args: MoveIssueColumnArgs): Promise<IssueCardDto> {
 const db = getDb();

 //1. resolve project
 const proj = resolveProject(args.projectId);

 //2.拿 from/to 列绑的 labels
 const fromLabels = db
 .select()
 .from(columnLabelMapping)
 .where(eq(columnLabelMapping.columnId, args.fromColumnId))
 .orderBy(asc(columnLabelMapping.createdAt))
 .all();
 const toLabels = db
 .select()
 .from(columnLabelMapping)
 .where(eq(columnLabelMapping.columnId, args.toColumnId))
 .orderBy(asc(columnLabelMapping.createdAt))
 .all();

 // from / to 列存在性校验（projectId维度）
 const fromCol = db
 .select()
 .from(boardColumns)
 .where(and(eq(boardColumns.id, args.fromColumnId), eq(boardColumns.repoProjectId, args.projectId)))
 .all()[0];
 if (!fromCol) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: 'fromColumnId 不存在或不在该项目下',
 });
 }
 const toCol = db
 .select()
 .from(boardColumns)
 .where(and(eq(boardColumns.id, args.toColumnId), eq(boardColumns.repoProjectId, args.projectId)))
 .all()[0];
 if (!toCol) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: 'toColumnId 不存在或不在该项目下',
 });
 }

 //3.拿 issue当前真实 labels（gitea）—— 防漂移
 const currentIssue = await getGiteaIssue({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 index: args.issueIndex,
 });
 const currentLabelIds = new Set(currentIssue.labels.map((l) => l.id));

 // fromLabels必须都真在 issue上（否则说明 gitea端已变，没同步）
 for (const fl of fromLabels) {
 const id = Number(fl.giteaLabelId);
 if (!currentLabelIds.has(id)) {
 throw new IpcError({
 code: IpcErrorCode.CONFLICT,
 message: '该列绑的 label已在 gitea端变更（issue 不再带该 label）',
 hint: '请刷新看板',
 cause: `columnId=${args.fromColumnId}, giteaLabelId=${fl.giteaLabelId}, issue=${args.issueIndex}`,
 });
 }
 }

 //4. addLabel(toLabels) →失败回滚（先 removeLabel已 add 的）
 const addedLabelIds: number[] = [];
 try {
 for (const tl of toLabels) {
 const id = Number(tl.giteaLabelId);
 if (currentLabelIds.has(id)) continue; // 已带跳过
 await addGiteaIssueLabel({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 index: args.issueIndex,
 labelId: id,
 });
 addedLabelIds.push(id);
 }
 } catch (e) {
 //回滚：移除已 add 的
 for (const id of addedLabelIds) {
 try {
 await removeGiteaIssueLabel({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 index: args.issueIndex,
 labelId: id,
 });
 } catch {
 //忽略回滚失败（业务上 issue状态已经前进）
 }
 }
 throw e;
 }

 //5. removeLabel(fromLabels)
 try {
 for (const fl of fromLabels) {
 const id = Number(fl.giteaLabelId);
 await removeGiteaIssueLabel({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 index: args.issueIndex,
 labelId: id,
 });
 }
 } catch (e) {
 // 不回滚 addLabel（已落地）；告诉用户部分成功
 throw new IpcError({
 code: IpcErrorCode.INTERNAL,
 message: '已加 toColumn labels，但移除 fromColumn labels 时部分失败',
 hint: '请手动检查 issue标签',
 cause: e instanceof Error ? e.message : String(e),
 });
 }

 //6. 返回最新 issue（gitea端）
 return await getGiteaIssue({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 index: args.issueIndex,
 });
}
