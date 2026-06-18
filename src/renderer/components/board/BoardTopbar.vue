<script setup lang="ts">
/**
 * BoardTopbar —— 看板顶栏（plan_25cc4562 Task D · BoardView 重构 · 第 7 拆分）
 *
 * 设计（v1.4 · 任务 #statusbar-picker 重构）：
 * - v1.4 之前：仓库下拉触发器 + 撤销 / 重做 / 仓库计数 / loading
 * - v1.4 之后：**仓库选择已下沉到 StatusBar 全局 picker**（状态栏唯一入口），
 *   BoardTopbar **不再**渲染 picker 触发器 / 也不接收 picker 相关 props/emits
 * - 保留：撤销 / 重做 / loading
 *
 * v1.4 调整（2026-06-18）：
 * - 移除左侧"看板"标题（StatusBar 已有当前 view 语义，顶栏不再重复）
 * - 移除右侧"共 X 个仓库"计数（仓库上下文由 StatusBar picker 承担）
 * - 撤销后方加"Gitea 数据源"按钮：window.open 走系统浏览器（main 端 setWindowOpenHandler
 *   拦截 → shell.openExternal）
 *
 * 通信：props + emit
 *   - props.canUndo / canRedo : 撤销 / 重做按钮可点态
 *   - props.undoSize / redoSize : 撤销 / 重做栈深度（tooltip 文本）
 *   - props.giteaSourceUrl     : 当前仓库的 Gitea 页面 URL（无值时按钮隐藏）
 *   - props.loading            : loading 标志
 *   - emit('undo') / emit('redo')
 */
import { ExternalLink, RefreshCw, RotateCcw, RotateCw } from 'lucide-vue-next';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  undoSize: number;
  redoSize: number;
  /** 当前仓库的 Gitea 页面 URL（无值时隐藏"Gitea 数据源"按钮） */
  giteaSourceUrl: string;
  loading: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'undo'): void;
  (e: 'redo'): void;
  // v1.4 增量 · 拍板 2026-06-16 user 拍板「重建视图」按钮
  (e: 'reset-view'): void;
}>();

/** 打开 Gitea 仓库页面（window.open 被 main 端 setWindowOpenHandler 拦截 → shell.openExternal 走系统浏览器） */
function openGiteaSource(): void {
  if (!props.giteaSourceUrl) return;
  window.open(props.giteaSourceUrl, '_blank', 'noopener,noreferrer');
}
</script>

<template>
  <header class="board__topbar">
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
      <!-- v1.4 调整（2026-06-18）：撤销后方加 Gitea 数据源按钮，跳转当前仓库的 Gitea 页面 -->
      <button
        v-if="props.giteaSourceUrl"
        type="button"
        class="board__gitea-btn"
        :disabled="props.loading"
        title="在 Gitea 上查看当前仓库"
        @click="openGiteaSource"
      >
        <ExternalLink :size="14" :stroke-width="2" />
        <span>Gitea 数据源</span>
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
      <span v-if="props.loading" class="board__loading">加载中…</span>
    </div>
  </header>
</template>

<style scoped>
.board__topbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
  position: relative;
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
/* v1.4 调整：Gitea 数据源按钮 —— 主色风格（区别于撤销/重做的 warning） */
.board__gitea-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-primary-glow);
  color: var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.board__gitea-btn:hover:not(:disabled) {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}
.board__gitea-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.board__loading { color: var(--color-info); font-size: var(--font-xs); }
</style>
