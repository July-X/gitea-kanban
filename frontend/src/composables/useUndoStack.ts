/**
 * @deprecated v0.6+ 软废弃：仍保留以便回滚。导航栏已移除"看板"入口。
 *
 * useUndoStack —— 看板换列撤销/重做的栈深度状态 + IPC 薄包装
 *
 * M6 undo-by-project 设计：栈数据走 main 端 `user.undo` / `user.redo` / `user.undoStatus`
 * （app/store/store.go 是 single source of truth，**不**存 SQL —— 内存栈 + 重启丢失）。
 * 渲染端只持有"栈深度"两个数字供 UI 灰化按钮用。
 *
 * 职责（保持薄）：
 * - 暴露 `undoSize` / `redoSize` 响应式 ref（store 透传出去给 UI）
 * - 暴露 `canUndo` / `canRedo` computed
 * - 调 IPC：`loadUndoStatus` / `undoLastMove` / `redoLastMove`
 *
 * **不**做的：
 * - **不**自动 reload board —— composable 调完 IPC 后只更新栈深度 + 返 `{ restored }`。
 *   是否要 reload board 由 caller 决定（store 端 thin wrap，根据 `restored > 0` 调 loadBoard）。
 * - **不**持久化栈 —— 重启后栈丢（这跟 main 端实现一致；业务上用户接受）。
 *
 * 测试策略（vitest 单测）：
 * - 不依赖 Vue / Pinia，纯 IPC mock + ref 断言
 * - 6 用例：初始 0/0、loadUndoStatus 更新、undo 后栈更新、redo 后栈更新、
 *   restored=0 不触发 reload 回调、restored>0 触发回调
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { getIpcClient } from '@renderer/lib/ipc-client';

/** IPC user.undo / user.redo 的出参形态 */
export interface UndoOpResult {
  restored: number;
  undoSize: number;
  redoSize: number;
}

/** IPC user.undoStatus 的出参形态 */
export interface UndoStatus {
  undoSize: number;
  redoSize: number;
}

export interface UndoStack {
  /** 当前 projectId undo 栈深度（>0 时 UI 启用"撤销"按钮） */
  undoSize: Ref<number>;
  /** 当前 projectId redo 栈深度（>0 时 UI 启用"重做"按钮） */
  redoSize: Ref<number>;
  canUndo: ComputedRef<boolean>;
  canRedo: ComputedRef<boolean>;
  /** 拉栈深度（切 project 时调一次） */
  loadUndoStatus: (projectId: string) => Promise<void>;
  /** 调 IPC undo，更新栈深度，返 `{ restored }` 让 caller 决定要不要 reload */
  undoLastMove: (projectId: string) => Promise<UndoOpResult>;
  /** 调 IPC redo，更新栈深度，返 `{ restored }` 让 caller 决定要不要 reload */
  redoLastMove: (projectId: string) => Promise<UndoOpResult>;
}

export function useUndoStack(): UndoStack {
  const undoSize = ref(0);
  const redoSize = ref(0);
  const canUndo = computed(() => undoSize.value > 0);
  const canRedo = computed(() => redoSize.value > 0);

  async function loadUndoStatus(projectId: string): Promise<void> {
    const result = await getIpcClient().invoke<UndoStatus>('user', 'undoStatus', {
      projectId,
    });
    undoSize.value = result.undoSize;
    redoSize.value = result.redoSize;
  }

  async function undoLastMove(projectId: string): Promise<UndoOpResult> {
    const result = await getIpcClient().invoke<UndoOpResult>('user', 'undo', {
      projectId,
    });
    undoSize.value = result.undoSize;
    redoSize.value = result.redoSize;
    return result;
  }

  async function redoLastMove(projectId: string): Promise<UndoOpResult> {
    const result = await getIpcClient().invoke<UndoOpResult>('user', 'redo', {
      projectId,
    });
    undoSize.value = result.undoSize;
    redoSize.value = result.redoSize;
    return result;
  }

  return {
    undoSize,
    redoSize,
    canUndo,
    canRedo,
    loadUndoStatus,
    undoLastMove,
    redoLastMove,
  };
}
