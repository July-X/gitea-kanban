<script setup lang="ts">
/**
 * ColumnHeader —— 列头 + WIP 计数显示（plan_25cc4562 Task D · BoardView 重构）
 *
 * 设计（v1.3 · Task B · kanban-wip-limit）：
 * - 列名（h3）+ 计数 chip
 * - 有 wipLimit 时显示 "3 / 5"；超限整列变红
 * - 已绑 label 列表（chip 形式 + 颜色圆点）
 *
 * 通信：props + emit（不直接调 store）
 *   - props.column       : 当前列
 *   - props.issueCount   : 当前列 issue 数（避免子组件再调 store getter）
 *   - props.isOverLimit  : 是否超限
 *   - props.overLimitTooltip : 超限提示文案
 *   - emit('open-settings') : 父组件点开"列设置"按钮的回调
 */
import { Settings, Tag } from 'lucide-vue-next';
import type { ColumnDto } from '../../../main/ipc/schema.js';

interface Props {
  column: ColumnDto;
  issueCount: number;
  isOverLimit: boolean;
  overLimitTooltip: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-settings'): void;
}>();

function handleSettings(): void {
  emit('open-settings');
}
</script>

<template>
  <header class="column__header">
    <div class="column__title-wrap">
      <h3 class="column__title">{{ props.column.title }}</h3>
      <!-- 列头计数：有上限时显示 "3 / 5"（超限自动变红），无上限时只显示数字 -->
      <span
        class="column__count"
        :class="{ 'column__count--over': props.isOverLimit }"
        :title="props.isOverLimit ? props.overLimitTooltip : ''"
      >
        <template v-if="props.column.wipLimit && props.column.wipLimit > 0">
          {{ props.issueCount }} / {{ props.column.wipLimit }}
        </template>
        <template v-else>
          {{ props.issueCount }}<template v-if="props.column.labels.length"> 个标签</template>
        </template>
      </span>
      <!-- 列设置按钮：v1.1 列管理入口（绑 label / 改名 / 删列 / WIP） -->
      <button
        type="button"
        class="column__settings-btn"
        :title="`设置列 ${props.column.title}`"
        :aria-label="`设置列 ${props.column.title}`"
        @click="handleSettings"
      >
        <Settings :size="14" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
    <div v-if="props.column.labels.length" class="column__labels">
      <Tag
        v-for="lab in props.column.labels"
        :key="lab.id"
        :size="11"
        :stroke-width="2"
        aria-hidden="true"
        class="column__label-icon"
      />
      <span class="column__label-text">{{ props.column.labels.map((l) => l.name).join(' · ') }}</span>
    </div>
  </header>
</template>

<style scoped>
.column__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-3) var(--space-3) var(--space-2);
  flex-shrink: 0;
  border-bottom: 1px solid var(--color-divider);
}
.column__title-wrap {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
  font-feature-settings: 'tnum';
  white-space: nowrap;
}
/* v1.3（plan_25cc4562 · Task B）：WIP 上限视觉
 *  - .column__count--over  : 列头计数器超限变红（最直接提示）
 *  - 父选择器让标题色跟着走，a11y 友好（不靠颜色单一编码）
 */
.column__count--over {
  background: var(--color-danger-soft, #fde8e8);
  color: var(--color-danger, #d33);
  font-weight: 600;
}
.column__labels {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.column__label-icon { color: var(--color-accent); flex-shrink: 0; }
.column__label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
