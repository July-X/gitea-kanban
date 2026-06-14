/**
 * 看板拖拽换列业务层（ADR-0002 §"业务"）
 *
 * 职责：
 * - 实现 issues.moveColumn IPC handler
 * - 原子地把 issue 的 labels 从 fromColumn 绑的 → toColumn 绑的
 * - 校验（前置）：fromColumn 绑的 labels 是 issue 真有的（防漂移）
 *
 * 设计（ADR-0002 §"业务约束"）：
 * - 列绑 label 改绑 = gitea issues.addLabel / removeLabel（不存"卡片"本地实体）
 * - 一次拖拽 = 多组 label 操作（fromColumn 绑的 N 个 + toColumn 绑的 M 个）
 * - 部分失败回滚：先 addLabel(toColumn)，全部成功后 removeLabel(fromColumn)——反向防漂移
 *
 * 边界：
 * - **不**直接调 gitea API（走 src/main/gitea/issues.ts 包装）
 * - **不**存"卡片位置"本地（位置在 gitea 端 label 上）
 * - **不**改 schema / IpcErrorCode / IPC 端点清单
 *
 * M6 undo/redo 接入：
 * - 成功时 pushUndo（src/main/board/undo.ts）记一条 op='issues.moveColumn'
 * - reverseArgs = swap from/to（moveIssueColumn 对称，反向即同函数换参）
 * - 失败 / 部分回滚 不入栈
 *
 * ADR-0003 Phase 2：boardColumns / columnLabelMapping 改读 localStore
 */

import { IpcError, IpcErrorCode } from '@shared/errors';
import type { MoveIssueColumnArgs, IssueCardDto } from '../ipc/schema.js';
import { resolveProject } from './resolveProject.js';
import { pushUndo, registerUndoHandler } from './undo.js';
import {
  removeGiteaIssueLabel,
  addGiteaIssueLabel,
  getGiteaIssue,
} from '../gitea/issues.js';
import { getLocalStore } from '../local/state.js';
import { findColumnByIdWithStore } from '../local/columns.js';
import { listLabelMapsByColumnWithStore } from '../local/label-maps.js';

/**
 * 拖拽换列（原子）
 *
 * 步骤：
 * 1. resolve project → giteaUrl + username + owner + repo
 * 2. 拿 fromColumn 绑的 labels + toColumn 绑的 labels（localStore）
 * 3. 拉 issue 当前真实 labels（gitea）—— 防漂移校验
 * 4. addLabel(toColumn 绑的 labels) 全成功 → removeLabel(fromColumn 绑的 labels) 全成功
 */
export async function moveIssueColumn(args: MoveIssueColumnArgs): Promise<IssueCardDto> {
  // 1. resolve project
  const proj = resolveProject(args.projectId);

  // 2. 拿 from/to 列绑的 labels（localStore）
  const state = getLocalStore().get();
  const fromLabels = listLabelMapsByColumnWithStore(state, args.fromColumnId);
  const toLabels = listLabelMapsByColumnWithStore(state, args.toColumnId);

  // from / to 列存在性校验（projectId 维度）
  const fromCol = findColumnByIdWithStore(state, args.fromColumnId);
  if (!fromCol || fromCol.projectId !== args.projectId) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'fromColumnId 不存在或不在该项目下',
    });
  }
  const toCol = findColumnByIdWithStore(state, args.toColumnId);
  if (!toCol || toCol.projectId !== args.projectId) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'toColumnId 不存在或不在该项目下',
    });
  }

  // 3. 拿 issue 当前真实 labels（gitea）—— 防漂移
  const currentIssue = await getGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
  });
  const currentLabelIds = new Set(currentIssue.labels.map((l) => l.id));

  // fromLabels 必须都真在 issue 上（否则说明 gitea 端已变，没同步）
  for (const fl of fromLabels) {
    const id = Number(fl.giteaLabelId);
    if (!currentLabelIds.has(id)) {
      throw new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: '该列绑的 label 已在 gitea 端变更（issue 不再带该 label）',
        hint: '请刷新看板',
        cause: `columnId=${args.fromColumnId}, giteaLabelId=${fl.giteaLabelId}, issue=${args.issueIndex}`,
      });
    }
  }

  // 4. addLabel(toLabels) → 失败回滚（先 removeLabel 已 add 的）
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
    // 回滚：移除已 add 的
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
        // 忽略回滚失败（业务上 issue 状态已经前进）
      }
    }
    throw e;
  }

  // 5. removeLabel(fromLabels)
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
      hint: '请手动检查 issue 标签',
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  // 6. 返回最新 issue（gitea 端）
  const result = await getGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
  });

  // 7. push undo（M6）：reverse = 互换 from/to（moveIssueColumn 对称）
  pushUndo(
    'issues.moveColumn',
    args.projectId,
    args,
    { ...args, fromColumnId: args.toColumnId, toColumnId: args.fromColumnId },
  );

  return result;
}

/** M6 undo/redo：注册 moveIssueColumn 的 forward/reverse handler
 *
 *  设计：undo.ts 不 import 业务侧（避免 electron/sqlite 链路）；
 *  业务侧自己调 registerUndoHandler 把 handler 注入。
 *  moveIssueColumn 对称（reverse = swap from/to），所以 forward = reverse = moveIssueColumn 自身。
 *
 *  模块加载即注册（move-card.ts 在 IPC 启动期已被 import 进来）—— 不需要在 bootstrap 再调一次。
 */
registerUndoHandler('issues.moveColumn', {
  // 包装为 (args: unknown) => ...，类型断言回 MoveIssueColumnArgs
  // （OpHandler 故意用 unknown 走弱耦合；moveIssueColumn 自己会做 zod / DB 校验）
  forward: (args) => moveIssueColumn(args as MoveIssueColumnArgs),
  reverse: (args) => moveIssueColumn(args as MoveIssueColumnArgs),
});
