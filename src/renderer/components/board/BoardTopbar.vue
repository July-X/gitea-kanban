<script setup lang="ts">
/**
 * BoardTopbar —— 看板顶栏（plan_25cc4562 Task D · BoardView 重构 · 第 7 拆分）
 *
 * 设计：
 * - 仓库下拉触发器（picker）+ 撤销 / 重做 / 仓库计数 / loading
 * - 仓库下拉面板本身（下拉搜索 + 列表）也包进来（虽然视觉是 absolute 浮层，
 *   但语义上属于"顶栏的一部分"——点 picker 切换显隐）
 *
 * 通信：props + emit
 *   - props.activeRepo      : 当前仓库（null = 未选）
 *   - props.repos           : 全量仓库列表
 *   - props.search          : 搜索框文本（受控）
 *   - props.canUndo / canRedo : 撤销 / 重做按钮可点态
 *   - props.undoSize / redoSize : 撤销 / 重做栈深度（tooltip 文本）
 *   - props.loading         : loading 标志
 *   - emit('toggle-picker') : 点 picker 切换下拉
 *   - emit('update:search', v) : 搜索输入
 *   - emit('select', repo) : 选中某仓库
 *   - emit('undo') / emit('redo')
 */
import { computed } from 'vue';
import {
  ChevronDown,
  KeyRound,
  Package,
  RotateCcw,
  RotateCw,
  Search,
} from 'lucide-vue-next';
import EmptyState from '@renderer/components/EmptyState.vue';
import type { RepoDto } from '../../../main/ipc/schema.js';

interface Props {
  activeRepo: RepoDto | null;
  repos: RepoDto[];
  search: string;
  canUndo: boolean;
  canRedo: boolean;
  undoSize: number;
  redoSize: number;
  loading: boolean;
  /** v1 顶栏默认收起；首次 mount 后看 store 是否有 currentProject 决定是否默认展开 */
  pickerOpen: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'toggle-picker'): void;
  (e: 'update:search', value: string): void;
  (e: 'select', repo: RepoDto): void;
  (e: 'undo'): void;
  (e: 'redo'): void;
}>();

const filteredRepos = computed<RepoDto[]>(() => {
  const q = props.search.trim().toLowerCase();
  if (!q) return props.repos;
  return props.repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
  );
});
</script>

<template>
  <header class="board__topbar">
    <div class="board__picker" @click="emit('toggle-picker')">
      <KeyRound :size="18" :stroke-width="1.75" aria-hidden="true" />
      <span class="board__picker-label">
        <span class="muted text-xs">当前仓库</span>
        <span class="board__picker-name">{{ props.activeRepo?.fullName ?? '请选择仓库' }}</span>
      </span>
      <ChevronDown :size="16" :stroke-width="2" aria-hidden="true" />
    </div>
    <div class="board__topbar-right">
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
        <span>共 {{ props.repos.length }} 个仓库</span>
      </span>
      <span v-if="props.loading" class="board__loading">加载中…</span>
    </div>
    <div v-if="props.pickerOpen" class="board__dropdown" role="dialog" aria-label="选择仓库">
      <div class="board__dropdown-search">
        <Search :size="14" :stroke-width="2" aria-hidden="true" />
        <input
          :value="props.search"
          type="text"
          class="board__dropdown-input"
          placeholder="搜索仓库（按名称 /描述）"
          autocomplete="off"
          spellcheck="false"
          @input="(e) => emit('update:search', (e.target as HTMLInputElement).value)"
        />
      </div>
      <ul v-if="filteredRepos.length" class="board__dropdown-list">
        <li v-for="r in filteredRepos" :key="r.id">
          <button
            type="button"
            class="board__dropdown-item"
            :class="{ 'board__dropdown-item--active': r.fullName === props.activeRepo?.fullName }"
            @click="emit('select', r)"
          >
            <span class="board__dropdown-item-name">{{ r.fullName }}</span>
            <span v-if="r.isProject" class="board__dropdown-item-tag">已加入</span>
          </button>
        </li>
      </ul>
      <EmptyState
        v-else
        title="没有匹配的仓库"
        description="试试别的搜索词，或去 gitea 添加新仓库"
      />
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
.board__picker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--color-text-secondary);
  transition: background var(--t-fast) var(--ease);
  min-width: 240px;
}
.board__picker:hover { background: var(--color-bg-hover); color: var(--color-text); }
.board__picker-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.board__picker-name {
  font-size: var(--font-md);
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
}
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
.board__undo-btn:hover:not(:disabled),
.board__redo-btn:hover:not(:disabled) {
  background: var(--color-warning);
  color: var(--color-text-inverse);
}
.board__undo-btn:disabled,
.board__redo-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.board__counter { display: inline-flex; align-items: center; gap: 4px; }
.board__loading { color: var(--color-info); font-size: var(--font-xs); }

.board__dropdown {
  position: absolute;
  top: 64px;
  left: var(--space-4);
  width: 360px;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-nav);
  overflow: hidden;
}
.board__dropdown-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-muted);
}
.board__dropdown-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}
.board__dropdown-input:focus { background: transparent; box-shadow: none; }
.board__dropdown-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1);
}
.board__dropdown-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.board__dropdown-item:hover { background: var(--color-bg-hover); color: var(--color-text); }
.board__dropdown-item--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.board__dropdown-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board__dropdown-item-tag {
  font-size: var(--font-xs);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}
</style>
