/**
 * useUndoStack 单元测试
 *
 * 测试目标（v1.4 polish refactor · commit c3d32d2）：
 * - 初始状态：undoSize=0, redoSize=0, canUndo=false, canRedo=false
 * - loadUndoStatus(projectId) 调 IPC + 更新栈深度 ref
 * - undoLastMove(projectId) 调 IPC + 更新栈深度 ref + 返回 { restored, undoSize, redoSize }
 * - redoLastMove(projectId) 调 IPC + 更新栈深度 ref + 返回 { restored, undoSize, redoSize }
 * - canUndo / canRedo computed 跟随 ref 自动反应
 * - composable **不**处理 IPC 错误（错误透传给 caller，由 store 端 normalizeError 处理）
 *   · caller 负责 decide reload by `restored > 0`
 *
 * 测试策略：
 * - 纯 JS + vi.mock 整个 '@renderer/lib/ipc-client' 模块
 * - mock getIpcClient 返 { invoke: vi.fn() }，每个 case 用 mockResolvedValueOnce 注入返回值
 * - 不挂载 Vue 组件（composable 内部 ref/computed 在 setup-like 环境能直接 .value 读）
 * - happy-dom/jsdom 都未装 → 避免引入新依赖
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===== vi.mock 必须放在 import 业务模块之前 =====
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@renderer/lib/ipc-client', () => ({
  getIpcClient: () => ({ invoke: mocks.invoke }),
}));

import { useUndoStack } from '@renderer/composables/useUndoStack';

describe('useUndoStack（M6 undo-by-project 状态层）', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it('初始状态：undoSize/redoSize 都为 0，canUndo/canRedo 都是 false', () => {
    const stack = useUndoStack();
    expect(stack.undoSize.value).toBe(0);
    expect(stack.redoSize.value).toBe(0);
    expect(stack.canUndo.value).toBe(false);
    expect(stack.canRedo.value).toBe(false);
  });

  it('loadUndoStatus：调 IPC + 更新 undoSize/redoSize ref', async () => {
    mocks.invoke.mockResolvedValueOnce({ undoSize: 3, redoSize: 1 });
    const stack = useUndoStack();
    await stack.loadUndoStatus('p-1');
    expect(mocks.invoke).toHaveBeenCalledWith('user', 'undoStatus', { projectId: 'p-1' });
    expect(stack.undoSize.value).toBe(3);
    expect(stack.redoSize.value).toBe(1);
    expect(stack.canUndo.value).toBe(true);
    expect(stack.canRedo.value).toBe(true);
  });

  it('loadUndoStatus：传不同 projectId 应能更新（切 project 时重新拉）', async () => {
    mocks.invoke.mockResolvedValueOnce({ undoSize: 2, redoSize: 0 });
    const stack = useUndoStack();
    await stack.loadUndoStatus('p-1');
    expect(stack.undoSize.value).toBe(2);
    expect(stack.redoSize.value).toBe(0);
    expect(stack.canRedo.value).toBe(false);

    // 切到 p-2 重新拉
    mocks.invoke.mockResolvedValueOnce({ undoSize: 0, redoSize: 5 });
    await stack.loadUndoStatus('p-2');
    expect(stack.undoSize.value).toBe(0);
    expect(stack.redoSize.value).toBe(5);
    expect(stack.canUndo.value).toBe(false);
    expect(stack.canRedo.value).toBe(true);
  });

  it('undoLastMove：调 IPC + 更新 ref + 返回 { restored, undoSize, redoSize }', async () => {
    mocks.invoke.mockResolvedValueOnce({ restored: 1, undoSize: 2, redoSize: 1 });
    const stack = useUndoStack();
    const result = await stack.undoLastMove('p-1');
    expect(mocks.invoke).toHaveBeenCalledWith('user', 'undo', { projectId: 'p-1' });
    expect(result).toEqual({ restored: 1, undoSize: 2, redoSize: 1 });
    expect(stack.undoSize.value).toBe(2);
    expect(stack.redoSize.value).toBe(1);
  });

  it('undoLastMove：restored=0 时 IPC 仍然调（栈也可能更新），caller 决定 reload', async () => {
    // 边界：restored=0 但栈仍可能因为某种原因被调整（异常路径）
    mocks.invoke.mockResolvedValueOnce({ restored: 0, undoSize: 0, redoSize: 0 });
    const stack = useUndoStack();
    const result = await stack.undoLastMove('p-1');
    expect(result.restored).toBe(0);
    // caller (board store) 根据 `result.restored > 0` 决定是否 reload board
    // composable 不做这个判断
    expect(stack.undoSize.value).toBe(0);
  });

  it('redoLastMove：调 IPC + 更新 ref + 返回 { restored, undoSize, redoSize }', async () => {
    mocks.invoke.mockResolvedValueOnce({ restored: 1, undoSize: 1, redoSize: 0 });
    const stack = useUndoStack();
    const result = await stack.redoLastMove('p-1');
    expect(mocks.invoke).toHaveBeenCalledWith('user', 'redo', { projectId: 'p-1' });
    expect(result).toEqual({ restored: 1, undoSize: 1, redoSize: 0 });
    expect(stack.undoSize.value).toBe(1);
    expect(stack.redoSize.value).toBe(0);
  });

  it('IPC 抛错时：composable 不 catch，错误透传给 caller', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('boom'));
    const stack = useUndoStack();
    await expect(stack.loadUndoStatus('p-1')).rejects.toThrow('boom');
  });

  it('每个 useUndoStack() 调用都是独立实例（典型 pinia setup 行为）', async () => {
    // 边界：composable 不能 module-level 单例（pinia store setup 会多次调，state 需独立）
    mocks.invoke.mockResolvedValueOnce({ undoSize: 5, redoSize: 0 });
    const stack1 = useUndoStack();
    await stack1.loadUndoStatus('p-1');
    expect(stack1.undoSize.value).toBe(5);

    const stack2 = useUndoStack();
    expect(stack2.undoSize.value).toBe(0); // 全新实例
    expect(stack2.canUndo.value).toBe(false);
  });

  it('canUndo / canRedo 是 computed：ref 变化时自动反应', async () => {
    const stack = useUndoStack();
    expect(stack.canUndo.value).toBe(false);

    mocks.invoke.mockResolvedValueOnce({ undoSize: 1, redoSize: 0 });
    await stack.loadUndoStatus('p-1');
    expect(stack.canUndo.value).toBe(true);

    mocks.invoke.mockResolvedValueOnce({ undoSize: 0, redoSize: 2 });
    await stack.loadUndoStatus('p-1');
    expect(stack.canUndo.value).toBe(false);
    expect(stack.canRedo.value).toBe(true);
  });
});
