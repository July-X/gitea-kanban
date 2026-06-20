<script setup lang="ts">
/**
 * ClosedSection —— 已关闭议题折叠区（v1.4 拍板"已完成列旁新折叠列"）
 *
 * 设计（2026-06-16 21:13 user 反馈）：
 * - 独立列形态，**插在"已完成"列右侧**（没已完成列时插在最末）
 * - **默认折叠**：仅显示"X 张已关闭 ▸"标题 + 简短文字，**不挤占内容区**
 * - 点击展开 → 列出所有 closed issue（按 gitea issue.index 倒序，编号大的在前面）
 * - 视觉与 UnassignedSection 类似（虚线 border + muted 文字）
 * - **不**走 vue-draggable-plus（v1.4：closed 是"已结束"的事，不支持拖回 open 列）
 *   - 如需"重开"操作：v1.5 走 gitea 端 reopen（本期不做）
 *
 * 通信：props only（只读）
 *   - props.issues : 所有 closed issue（store.closedIssues）
 *   - props.loading : store.loading（卡片 disabled 态）
 *
 * v1.4 拍板历史：
 *  - v1.4 第一版放在 BoardTopbar 全局 toggle 按钮：user 反馈"位置不对 + 挤占顶栏"
 *  - v1.4 第二版：插在已完成列**旁边**作为独立折叠列（本文档）
 */
import { computed, ref } from 'vue';
import { Archive, ChevronDown, ChevronUp } from 'lucide-vue-next';
import type { IssueCardDto } from '../../../main/ipc/schema.js';

interface Props {
  issues: IssueCardDto[];
  loading: boolean;
}

const props = defineProps<Props>();

/** v1.4：默认折叠（user 反馈"不挤占内容区"） */
const expanded = ref(false);

/** 按 issue.index 倒序展示（编号大的在前面） */
const sortedIssues = computed<IssueCardDto[]>(() =>
  [...props.issues].sort((a, b) => b.index - a.index),
);

function onToggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <section
    v-if="props.issues.length"
    class="column column--closed"
    :class="{ 'column--closed-expanded': expanded }"
    aria-label="已关闭议题"
  >
    <header class="column__header column__header--closed" @click="onToggle">
      <div class="column__title-wrap">
        <Archive :size="14" :stroke-width="2" aria-hidden="true" class="column__closed-icon" />
        <h3 class="column__title">已关闭</h3>
        <span class="column__count">{{ props.issues.length }} 张</span>
      </div>
      <button
        type="button"
        class="column__closed-toggle-icon"
        :title="expanded ? '收起已关闭议题' : '展开已关闭议题'"
        :aria-expanded="expanded"
        @click.stop="onToggle"
      >
        <ChevronDown v-if="!expanded" :size="14" :stroke-width="2" aria-hidden="true" />
        <ChevronUp v-else :size="14" :stroke-width="2" aria-hidden="true" />
      </button>
    </header>
    <p v-if="!expanded" class="column__closed-hint muted">
      点击展开看已关闭议题（默认折叠）
    </p>
    <ul v-else class="column__cards column__cards--closed-list">
      <li
        v-for="issue in sortedIssues"
        :key="issue.id"
        class="card card--closed"
        tabindex="0"
        role="article"
        :aria-label="`已关闭议题 #${issue.index}：${issue.title}`"
      >
        <div class="card__head">
          <span class="card__index mono">#{{ issue.index }}</span>
          <span class="card__state">已关闭</span>
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
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* v1.4 拍板：独立列形态（不挤占内容区）—— 默认只显示头部 + hint
   v1.4 布局修订（2026-06-18）：从横向列流移出，作为独立块渲染在列区下方
   （flex-wrap 换行后排到下方）。补齐列容器视觉（background/border-radius/shadow），
   与 KanbanColumnSection 的 .column 基础样式对齐。 */
.column--closed {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  /* v1.4 布局（2026-06-19）：宽度交给外层 wrapper（280px）控制，
     折叠/展开都撑满 wrapper，与上方「已完成」列等宽对齐。 */
  min-width: 0;
  width: 100%;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}
.column--closed-expanded {
  /* 展开时仍撑满 cell，不再单独设宽 */
  min-width: 0;
  width: 100%;
}
.column__header--closed {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: var(--space-3) var(--space-3) var(--space-2);
  flex-shrink: 0;
  border-bottom: 1px solid var(--color-divider);
}
.column__header--closed:hover {
  background: var(--color-bg-hover);
}
/* title-wrap / title / count 跟 ColumnHeader 对齐（scoped 隔离需各自声明） */
.column__title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.column__title {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}
.column__count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: var(--color-bg);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
}
.column__closed-icon {
  color: var(--color-text-muted);
  margin-right: 4px;
}
.column__closed-toggle-icon {
  background: transparent;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
}
.column__closed-toggle-icon:hover {
  background: var(--color-bg-active);
  color: var(--color-text);
}
.column__closed-hint {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--color-text-muted);
}
/* v1.4（2026-06-19）：card 基础样式 —— 与 KanbanColumnSection 的 .card 完全对齐，
   保证「已关闭」区卡片视觉与其他列一致（背景/圆角/padding/border-left/hover/cursor）。
   scoped 隔离下拿不到 KanbanColumnSection 的 .card，必须各自声明。 */
.card {
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  border-left: 3px solid var(--color-primary);
  position: relative;
  transition: background var(--t-fast) var(--ease);
  cursor: grab;
}
.card:active { cursor: grabbing; }
.card:hover { background: var(--color-bg-hover); }
.card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
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
/* 已关闭卡片：灰显 + 左边框 muted（与 KanbanColumnSection .card--closed 一致） */
.card--closed {
  opacity: 0.6;
  border-left-color: var(--color-text-muted);
}
.card--closed:hover { opacity: 0.8; }
.card--closed .card__state {
  font-size: var(--font-xs);
  padding: 1px 6px;
  background: var(--color-bg-active);
  color: var(--color-text-muted);
  border-radius: var(--radius-pill);
  margin-left: 6px;
}
.column__cards--closed-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  overflow-y: auto;
  min-height: 100px;
  /* v1.4（2026-06-19）：高度由 .board__done-wrap 的 max-height:40% 限制，
     展开时内容区在此限额内滚动，不撑破 wrapper。 */
}
</style>
