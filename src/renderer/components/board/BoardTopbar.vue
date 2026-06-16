<script setup lang="ts">
/**
 * BoardTopbar —— 看板顶栏（plan_25cc4562 Task D · BoardView 重构 · 第 7 拆分）
 *
 * 设计（v1.4 · 任务 #statusbar-picker 重构）：
 * - v1.4 之前：仓库下拉触发器 + 撤销 / 重做 / 仓库计数 / loading
 * - v1.4 之后：**仓库选择已下沉到 StatusBar 全局 picker**（状态栏唯一入口），
 *   BoardTopbar **不再**渲染 picker 触发器 / 也不接收 picker 相关 props/emits
 * - 保留：撤销 / 重做 / 仓库计数（只读展示）/ loading
 *
 * 通信：props + emit
 *   - props.canUndo / canRedo : 撤销 / 重做按钮可点态
 *   - props.undoSize / redoSize : 撤销 / 重做栈深度（tooltip 文本）
 *   - props.loading           : loading 标志
 *   - emit('undo') / emit('redo')
 */
import { Package, RefreshCw, RotateCcw, RotateCw } from 'lucide-vue-next';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  undoSize: number;
  redoSize: number;
  /** 仓库全量计数（v1.4：只读展示，不渲染 picker） */
  repoCount: number;
  loading: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'undo'): void;
  (e: 'redo'): void;
  // v1.4 增量 · 拍板 2026-06-16 user 拍板「重建视图」按钮
  (e: 'reset-view'): void;
}>();
</script>

<template>
  <header class="board__topbar">
    <div class="board__topbar-title muted text-xs">看板</div>
    <div class="board__topbar-right">
      <!--
        v1.4 增量 · 拍板 2026-06-16 user 拍板「重建视图」按钮
        - 危险操作（删本地列 + 重建）— danger 风格
        - 二次确认：BoardView 用 ConfirmDialog（emit 'reset-view' 触发）
        - 位置：撤销/重做之前（最危险放最左，不让误点）
      -->
      <button
        type="button"
        class="board__reset-btn"
        :disabled="props.loading"
        title="清空本地列并按 gitea label 重建"
        @click="emit('reset-view')"
      >
        <RefreshCw :size="14" :stroke-width="2" />
        <span>重建视图</span>
      </button>
      <button
        v-if="props.canUndo"
        type="button"
        class="board__undo-btn"
        :disabled="props.loading"
        :title="`撤销最近一次换列（共 ${props.undoSize}步可撤销）`"
        @click="emit('undo')"
      >
        <RotateCcw :size="14" :stroke-width="2" />
        <span>撤销</span>
      </button>
      <button
        v-if="props.canRedo"
        type="button"
        class="board__redo-btn"
        :disabled="props.loading"
        :title="`重做最近一次换列（共 ${props.redoSize}步可重做）`"
        @click="emit('redo')"
      >
        <RotateCw :size="14" :stroke-width="2" />
        <span>重做</span>
      </button>
      <span class="board__counter">
        <Package :size="14" :stroke-width="2" aria-hidden="true" />
        <span>共 {{ props.repoCount }} 个仓库</span>
      </span>
      <span v-if="props.loading" class="board__loading">加载中…</span>
    </div>
  </header>
</template>

<style scoped>
.board__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
  position: relative;
}
.board__topbar-title {
  /* v1.4: 顶栏不再渲染仓库 picker,留个 "看板" 小标做语义锚;
   * 真正的仓库上下文由 StatusBar picker 承担（全局唯一） */
  font-weight: 500;
}
.board__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
}
.board__reset-btn,
.board__undo-btn,
.board__redo-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.board__reset-btn:hover:not(:disabled),
.board__undo-btn:hover:not(:disabled),
.board__redo-btn:hover:not(:disabled) {
  background: var(--color-warning);
  color: var(--color-text-inverse);
}
.board__reset-btn:disabled,
.board__undo-btn:disabled,
.board__redo-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.board__counter { display: inline-flex; align-items: center; gap: 4px; }
.board__loading { color: var(--color-info); font-size: var(--font-xs); }
</style>
