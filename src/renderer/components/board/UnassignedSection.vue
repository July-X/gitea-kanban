<script setup lang="ts">
/**
 * UnassignedSection —— 未分类列 + 快捷归类（plan_25cc4562 Task C + Task D 重构）
 *
 * 设计：
 * - 列形态 = 与普通列一致（section.column.column--unassigned）
 * - 卡片右上角"归到…"按钮（区别于普通列的"换列"按钮，入口语义不同）
 * - 整段**不**走 vue-draggable-plus 拖拽（未分类列 v1 不支持拖入/拖出；归类走"归到…"弹窗）
 *
 * 通信：props + emit
 *   - props.issues : 未分类 issue 列表（boardStore.unassignedIssues）
 *   - props.loading : store.loading（卡片操作按钮 disabled 态）
 *   - emit('request-assign', issue) : 点"归到…"按钮
 *
 * 卡片内部 UI（标题 / 标签 / 作者）跟普通列卡片一致 —— 不复用 Card 组件（v1 普通卡片
 * 跟未分类卡片 actions 按钮不同，强行抽出 Card 会带很多 prop 分支；保持独立）
 */
import { ArrowRight } from 'lucide-vue-next';
import type { IssueCardDto } from '../../../main/ipc/schema.js';

interface Props {
  issues: IssueCardDto[];
  loading: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'request-assign', issue: IssueCardDto): void;
}>();
</script>

<template>
  <section
    v-if="props.issues.length"
    class="column column--unassigned"
    aria-label="未分类议题"
  >
    <header class="column__header">
      <div class="column__title-wrap">
        <h3 class="column__title">未分类</h3>
        <span class="column__count">{{ props.issues.length }} 个议题</span>
      </div>
    </header>
    <p class="column__unassigned-hint muted">
      这些议题还没归到任何列。点下方"归到…"按钮选一个列，会自动给议题加上该列绑的第一个标签。
    </p>
    <ul class="column__cards">
      <li
        v-for="issue in props.issues"
        :key="issue.id"
        class="card card--unassigned"
        tabindex="0"
        role="article"
        :aria-label="`议题 #${issue.index}：${issue.title}`"
      >
        <div class="card__head">
          <span class="card__index mono">#{{ issue.index }}</span>
        </div>
        <div class="card__title">{{ issue.title }}</div>
        <div v-if="issue.labels.length" class="card__labels">
          <span
            v-for="lab in issue.labels"
            :key="lab.id"
            class="card__label"
            :style="{ '--label-color': lab.color }"
          >
            {{ lab.name }}
          </span>
        </div>
        <div v-if="issue.author?.fullName || issue.author?.username" class="card__author muted">
          {{ issue.author.fullName || issue.author.username }}
        </div>
        <!-- 归到…按钮：plan_25cc4562 Task C · 未分类快捷归类入口 -->
        <div class="card__actions">
          <button
            type="button"
            class="card__action"
            :title="`归到…：${issue.title}`"
            :aria-label="`归到… ${issue.title}`"
            :disabled="props.loading"
            @click="emit('request-assign', issue)"
          >
            归到…<ArrowRight :size="12" :stroke-width="2" />
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.column--unassigned {
  opacity: 0.85;
}
.column__unassigned-hint {
  margin: 0 0 var(--space-sm, 8px);
  padding: 0 var(--space-xs, 6px);
  font-size: 12px;
  line-height: 1.5;
}
.column__cards {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  overflow-y: auto;
  min-height: 60px;
}
.card {
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  border-left: 3px solid var(--color-primary);
  position: relative;
  transition: background var(--t-fast) var(--ease);
}
.card:hover { background: var(--color-bg-hover); }
.card--unassigned {
  border-style: dashed;
  opacity: 0.8;
}
.card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 4px;
}
.card__index { font-size: var(--font-xs); color: var(--color-text-muted); font-weight: 600; }
.card__title {
  font-size: var(--font-sm);
  color: var(--color-text);
  line-height: var(--line-base);
  word-break: break-word;
}
.card__labels {
  margin-top: var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.card__label {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  white-space: nowrap;
  background-color: var(--label-color, var(--color-bg-active));
  color: var(--label-fg, var(--color-text-inverse, #ffffff));
}
.card__author { margin-top: var(--space-2); font-size: var(--font-xs); }
.card__actions {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease);
}
/* a11y：hover + :focus-within 双触发（与原 BoardView 一致） */
.card:hover .card__actions,
.card:focus-within .card__actions { opacity: 1; }
.card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
.card__action {
  padding: 4px;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.card__action:hover:not(:disabled) { background: var(--color-bg-active); color: var(--color-text); }
.card__action:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
