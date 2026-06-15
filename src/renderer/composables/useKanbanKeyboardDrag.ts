/**
 * useKanbanKeyboardDrag —— 看板键盘拖拽状态机 composable（v1.3 · plan_25cc4562 Task A）
 *
 * 封装：
 * - 状态机 ref（idle / picked）
 * - hoveredColumnId computed（template 列高亮 + banner 文字用）
 * - onCardKeydown handler（在卡片 <li @keydown> 上挂）
 * - onWindowKeydown handler（Esc 兜底，window 级监听，焦点离开卡片也能取消）
 * - 生命周期：onMounted 注册 / onBeforeUnmount 注销 window keydown
 *
 * 设计要点：
 * - **不**接 store / IPC —— caller 注入 `columns` getter + `onDrop(issue, fromCol, toCol)` 副作用
 * - **不**强制 picked 态 banner 渲染 —— caller 模板自行 `v-if="keyboardDrag.kind === 'picked'"`
 * - 防御：target 是 INPUT / TEXTAREA 时**不**响应 Space（避免破坏列内"新建议题"输入框）
 * - Esc 兜底：window 级监听 → 焦点离开卡片也能取消
 * - Space 拾起调 `showToast` 提示用户"用方向键选列，Space 放下"（optional，caller 注入）
 */
import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue';
import {
  keyDownToColumn,
  makeIdleKeyboardDrag,
  type KeyboardDragState,
} from '@renderer/lib/drag-helper';
import type { ColumnDto, IssueCardDto } from '../../main/ipc/schema.js';

export interface UseKanbanKeyboardDragOptions {
  /** 当前所有可拖目标列 getter（v1.3 不含"未分类"section） */
  getColumns: () => Pick<ColumnDto, 'id'>[];
  /** Space 放下回调 —— caller 调 performDragMove / 等价逻辑 */
  onDrop: (issue: IssueCardDto, fromColumnId: string, toColumnId: string) => void | Promise<void>;
  /** Space 拾起 toast（caller 决定文案 + duration） */
  onPicked?: (issue: IssueCardDto) => void;
}

export interface UseKanbanKeyboardDragReturn {
  /** 状态机 ref：idle 或 picked */
  keyboardDrag: Ref<KeyboardDragState>;
  /** 当前 hover 的列 id（picked 态才有值；idle 态 null） */
  keyboardHoveredColumnId: ComputedRef<string | null>;
  /** 卡片 keydown handler：绑到 <li @keydown> 上 */
  onCardKeydown: (issue: IssueCardDto, fromColumnId: string, evt: KeyboardEvent) => void;
  /** 强制取消（caller 在路由切换 / 项目切换时调） */
  reset: () => void;
}

export function useKanbanKeyboardDrag(
  options: UseKanbanKeyboardDragOptions,
): UseKanbanKeyboardDragReturn {
  const { getColumns, onDrop, onPicked } = options;

  const keyboardDrag = ref<KeyboardDragState>(makeIdleKeyboardDrag());

  const keyboardHoveredColumnId = computed<string | null>(() => {
    const k = keyboardDrag.value;
    return k.kind === 'picked' ? k.hoveredColumnId : null;
  });

  function onCardKeydown(
    issue: IssueCardDto,
    fromColumnId: string,
    evt: KeyboardEvent,
  ): void {
    // 防御：input / textarea 内的按键不响应（避免破坏列内"新建议题"输入框）
    const target = evt.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    if (keyboardDrag.value.kind === 'idle') {
      // Space → 拾起
      if (evt.key === ' ' || evt.code === 'Space') {
        evt.preventDefault();
        keyboardDrag.value = {
          kind: 'picked',
          issue,
          fromColumnId,
          hoveredColumnId: fromColumnId,
        };
        onPicked?.(issue);
      }
      return;
    }
    // picked 态：方向键选列 / Space 放下 / Esc 取消
    const picked = keyboardDrag.value;
    if (picked.kind !== 'picked') return;
    if (evt.key === 'Escape') {
      evt.preventDefault();
      keyboardDrag.value = makeIdleKeyboardDrag();
      return;
    }
    if (evt.key === ' ' || evt.code === 'Space') {
      evt.preventDefault();
      const toColumnId = picked.hoveredColumnId;
      const movedIssue = picked.issue;
      const from = picked.fromColumnId;
      keyboardDrag.value = makeIdleKeyboardDrag();
      void onDrop(movedIssue, from, toColumnId);
      return;
    }
    // 方向键：循环切列
    const nextCol = keyDownToColumn(getColumns(), picked.hoveredColumnId, evt.key);
    if (nextCol) {
      evt.preventDefault();
      keyboardDrag.value = { ...picked, hoveredColumnId: nextCol };
    }
  }

  /** window 级 Esc 兜底：焦点离开卡片也能取消 */
  function onWindowKeydown(evt: KeyboardEvent): void {
    if (keyboardDrag.value.kind !== 'picked') return;
    if (evt.key === 'Escape') {
      evt.preventDefault();
      keyboardDrag.value = makeIdleKeyboardDrag();
    }
  }

  function reset(): void {
    keyboardDrag.value = makeIdleKeyboardDrag();
  }

  onMounted(() => {
    window.addEventListener('keydown', onWindowKeydown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onWindowKeydown);
  });

  return {
    keyboardDrag,
    keyboardHoveredColumnId,
    onCardKeydown,
    reset,
  };
}
