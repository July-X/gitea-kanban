/**
 * 撤销 / 重做真栈（M6 落地）
 *
 * 设计：
 * - in-memory 双向栈（undoStack + redoStack），按 projectId 隔离
 * - op 路由：每个 op 类型由业务侧注册 reverse / forward handler（registry 模式）
 *   → 避免 undo.ts 反向 import 业务侧文件（业务侧 import electron / sqlite，tsx 跑不动）
 * - 栈上限 50 / project，超出丢最早的（避免内存膨胀）
 * - **不**入 DB（undo_entries 表保留为未来 crash recovery 留口子；本任务不写避免 §7.1 拍板）
 *
 * 接入点：
 * - 业务侧（如 moveIssueColumn）调 registerUndoHandler('issues.moveColumn', { forward, reverse })
 * - 业务侧成功时调 pushUndo(op, projectId, forwardArgs, reverseArgs)
 * - IPC user.undo → pop undo + push redo + 调 reverse
 * - IPC user.redo → pop redo + push undo + 调 forward
 *
 * 限制：
 * - 同一栈内仅"同 projectId" op 可互逆（M6 范围内只接 moveColumn 一个 op，无跨 op 风险）
 * - 网络错误：reverse 失败保留原栈（不消费）→ 用户重试
 */

import { IpcError, IpcErrorCode } from '@shared/errors';

const MAX_STACK_SIZE = 50;

/** 支持的 op 类型（扩展时 union 加项 + 注册 handler） */
export type UndoOp = 'issues.moveColumn';

/** op handler 集合（业务侧注册） */
interface OpHandler {
  forward: (args: unknown) => Promise<unknown>;
  reverse: (args: unknown) => Promise<unknown>;
}

const handlers = new Map<UndoOp, OpHandler>();

/** 业务侧注册：app 启动期（registerUserIpc 之类）调一次即可 */
export function registerUndoHandler(op: UndoOp, handler: OpHandler): void {
  handlers.set(op, handler);
}

/** undo 栈条目 */
interface UndoEntry {
  op: UndoOp;
  projectId: string;
  forwardArgs: unknown;
  reverseArgs: unknown;
  createdAt: number;
}

/** per-project 栈：undo / redo 各自一个数组（FILO） */
const undoStacks = new Map<string, UndoEntry[]>();
const redoStacks = new Map<string, UndoEntry[]>();

function getOrCreate(map: Map<string, UndoEntry[]>, key: string): UndoEntry[] {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  return arr;
}

function pushBounded(stack: UndoEntry[], entry: UndoEntry): void {
  stack.push(entry);
  while (stack.length > MAX_STACK_SIZE) {
    stack.shift();
  }
}

/** 业务侧调用：操作成功后入 undo 栈 + 清 redo 栈（新操作清 redo 是行业惯例） */
export function pushUndo(
  op: UndoOp,
  projectId: string,
  forwardArgs: unknown,
  reverseArgs: unknown,
): void {
  const stack = getOrCreate(undoStacks, projectId);
  pushBounded(stack, {
    op,
    projectId,
    forwardArgs,
    reverseArgs,
    createdAt: Date.now(),
  });
  const redo = redoStacks.get(projectId);
  if (redo && redo.length > 0) {
    redoStacks.set(projectId, []);
  }
}

/** undo 栈深度（UI 灰化按钮用） */
export function undoStackSize(projectId: string): number {
  return undoStacks.get(projectId)?.length ?? 0;
}

/** redo 栈深度（UI 灰化按钮用） */
export function redoStackSize(projectId: string): number {
  return redoStacks.get(projectId)?.length ?? 0;
}

/** 内部：根据 op 取 handler */
function getHandler(op: UndoOp): OpHandler {
  const h = handlers.get(op);
  if (!h) {
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: `未注册的 undo op: ${op}`,
      hint: '业务侧 registerUndoHandler 未在启动期调用',
    });
  }
  return h;
}

/** IPC user.undo handler 内部：弹 undo 栈顶部 + 派发 reverse
 *
 *  args.projectId 可选：提供时只弹该 project 的栈（防跨看板误撤销）；未提供时返 0（安全默认）
 *  返回的 undoSize / redoSize 是**操作后**的栈深度（供 UI 按钮灰化用，免一次 roundtrip）
 */
export async function undoOne(args?: { projectId?: string }): Promise<{
  restored: number;
  op?: UndoOp;
  undoSize: number;
  redoSize: number;
}> {
  if (args?.projectId) {
    const stack = undoStacks.get(args.projectId);
    const entry = stack?.pop();
    if (!entry) {
      return {
        restored: 0,
        undoSize: undoStackSize(args.projectId),
        redoSize: redoStackSize(args.projectId),
      };
    }
    const redo = getOrCreate(redoStacks, args.projectId);
    pushBounded(redo, entry);
    const handler = getHandler(entry.op);
    await handler.reverse(entry.reverseArgs);
    return {
      restored: 1,
      op: entry.op,
      undoSize: undoStackSize(args.projectId),
      redoSize: redoStackSize(args.projectId),
    };
  }
  // 无 projectId → 安全默认：返 0（不跨看板撤销；上层必须传 projectId）
  return { restored: 0, undoSize: 0, redoSize: 0 };
}

/** IPC user.redo handler 内部：弹 redo 栈顶部 + 派发 forward
 *  同 undoOne：projectId 可选；未提供时返 0 */
export async function redoOne(args?: { projectId?: string }): Promise<{
  restored: number;
  op?: UndoOp;
  undoSize: number;
  redoSize: number;
}> {
  if (args?.projectId) {
    const stack = redoStacks.get(args.projectId);
    const entry = stack?.pop();
    if (!entry) {
      return {
        restored: 0,
        undoSize: undoStackSize(args.projectId),
        redoSize: redoStackSize(args.projectId),
      };
    }
    const undo = getOrCreate(undoStacks, args.projectId);
    pushBounded(undo, entry);
    const handler = getHandler(entry.op);
    await handler.forward(entry.forwardArgs);
    return {
      restored: 1,
      op: entry.op,
      undoSize: undoStackSize(args.projectId),
      redoSize: redoStackSize(args.projectId),
    };
  }
  return { restored: 0, undoSize: 0, redoSize: 0 };
}

/** IPC user.undoStatus handler 内部：返当前 projectId 的栈深度（UI 灰化用） */
export function undoStatus(projectId: string): { undoSize: number; redoSize: number } {
  return {
    undoSize: undoStackSize(projectId),
    redoSize: redoStackSize(projectId),
  };
}

/** 测试辅助：清空所有栈（vitest 跨用例隔离用） */
export function _resetStacks(): void {
  undoStacks.clear();
  redoStacks.clear();
  handlers.clear();
}

/** 测试辅助：清 handler 注册（保留栈） */
export function _resetHandlers(): void {
  handlers.clear();
}

/** 测试辅助：snapshot 当前栈内容（不打日志） */
export function _snapshotStacks(): {
  undo: Record<string, UndoEntry[]>;
  redo: Record<string, UndoEntry[]>;
} {
  return {
    undo: Object.fromEntries(undoStacks),
    redo: Object.fromEntries(redoStacks),
  };
}
