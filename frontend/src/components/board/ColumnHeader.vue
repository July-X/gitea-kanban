<script setup lang="ts">
/**
 * @deprecated v0.6+ 软废弃：仍保留以便回滚。导航栏已移除"看板"入口。
 */
/**
 * ColumnHeader —— 列头 + WIP 计数显示（v1.3 BoardView 重构（拆 7 子组件））
 *
 * 设计（v1.3 · Task B · kanban-wip-limit）：
 * - 列名（h3）+ 计数 chip
 * - 有 wipLimit 时显示 "3 / 5"；超限整列变红
 * - 已绑 label 列表（chip 形式 + 颜色圆点）
 *
 * v1.4 增强（P0-2 列 = label UI 标注落地）：
 * - 修"X 个标签"文案 bug → 改成"X 张卡片"（issueCount 是 issue 数不是 label 数）
 * - label 列表 chip 化：用 gitea label 真实颜色作圆点 + label 名
 *   · 之前 v1.3 是 <Tag icon> + "·" join 文字，user 看不见 label 颜色差异
 * - chip 颜色：gitea API 返回 label.color 是 hex（#RRGGBB），用作 dot 背景
 *
 * 通信：props + emit（不直接调 store）
 *   - props.column       : 当前列
 *   - props.issueCount   : 当前列 issue 数（避免子组件再调 store getter）
 *   - props.isOverLimit  : 是否超限
 *   - props.overLimitTooltip : 超限提示文案
 *   - emit('open-settings') : 父组件点开"列设置"按钮的回调
 *
 * 边界：列头**不**渲染"未绑 label 红边警告"——那是 KanbanColumnSection 的职责
 * （P0-2 wireframe 场景 3 决定的，红边包整列要 parent 容器控制）
 */
import { Settings } from 'lucide-vue-next';
import type { ColumnDto } from '@renderer/types/dto';

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
      <!--
        列头计数：v1.4 修文案 bug
        - 有 WIP 上限 → "3 / 5"（超限自动变红）
        - 无 WIP 上限 → "X 张"（v1.4 修：之前是 "X 个标签"，文案错误）
      -->
      <span
        class="column__count"
        :class="{ 'column__count--over': props.isOverLimit }"
        :title="props.isOverLimit ? props.overLimitTooltip : ''"
      >
        <template v-if="props.column.wipLimit && props.column.wipLimit > 0">
          {{ props.issueCount }} / {{ props.column.wipLimit }}
        </template>
        <template v-else>
          {{ props.issueCount }} 张
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
    <!--
      v1.4 P0-2：label chip 化
      - 每个 label 一个独立 chip（gitea label 真实颜色 dot + label 名）
      - 之前 v1.3 是 1 个 v-for Tag icon + "·" join 文字，看不出 label 视觉区分
      - gitea API 返回 label.color 是 hex 字符串（例 "#fbca04"），用 inline style
        作为 dot 背景；label 名放 chip 文字里
    -->
    <div v-if="props.column.labels.length" class="column__labels">
      <span
        v-for="lab in props.column.labels"
        :key="lab.id"
        class="column__label-chip"
        :title="`gitea label：${lab.name}`"
      >
        <span
          class="column__label-dot"
          :style="{ background: lab.color || '#888888' }"
          aria-hidden="true"
        />
        <span class="column__label-name">{{ lab.name }}</span>
      </span>
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
/* v1.3（v1.3 WIP 上限）：WIP 上限视觉
 *  - .column__count--over  : 列头计数器超限变红（最直接提示）
 *  - 父选择器让标题色跟着走，a11y 友好（不靠颜色单一编码）
 */
.column__count--over {
  background: var(--color-danger-soft, #fde8e8);
  color: var(--color-danger, #d33);
  font-weight: 600;
}

/* v1.4 P0-2：列绑 gitea label 的 chip 化渲染
 *  - 之前：1 个 v-for Tag icon + "·" join 文字，看不出 label 视觉差异
 *  - 现在：每个 label 一个独立 chip（dot 用 gitea label 真实颜色）
 *  - 限制：chip 多了会自动换行（flex-wrap），列头高度自适应
 */
.column__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: var(--font-xs);
}

.column__label-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 4px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  color: var(--color-text);
  line-height: 1.4;
  max-width: 100%;
}

.column__label-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  /* gitea label 颜色作背景（fallback 灰） */
}

.column__label-name {
  /* label 名允许截断 + ellipsis，避免列头被长 label 名撑爆 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}
</style>
