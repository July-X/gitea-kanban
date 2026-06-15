<script setup lang="ts">
/**
 * KanbanColumnSection —— 看板单列内容（plan_25cc4562 Task D · BoardView 重构 · 第 7 拆分）
 *
 * 设计：
 * - 单列的"列头 + 卡片列表 + 新建议题输入"打包成一个组件
 * - 与 ColumnHeader / ColumnMenu / MoveColumnPicker 解耦：
 *   · 列头渲染委托给 ColumnHeader
 *   · 列设置弹窗由父组件管理（BoardView 持有 showColumnMenu），本组件**只**emit 'open-settings'
 *   · 拖拽事件（onEnd / onCardKeydown）由父组件传入回调
 *   · 新建议题输入框 + 换列 / 删除按钮 emit 到父
 *
 * 通信：props + emit（不直接调 store）
 *   - props.column           : 当前列
 *   - props.issues           : 当前列的 issue 列表
 *   - props.newIssueDraft    : 当前列的新建议题输入（受控）
 *   - props.loading          : store.loading
 *   - props.isOverLimit      : 超限标志（视觉）
 *   - props.overLimitTooltip : 超限提示文案
 *   - props.keyboardPickedIssueId : 键盘拖拽中拾起的 issue.id（null = 无）
 *   - props.keyboardHoveredColumnId : 键盘拖拽时当前 hover 的列 id
 *   - props.dragOptions      : vue-draggable-plus options
 *
 *   - emit('open-settings')           : 父组件打开列设置弹窗
 *   - emit('drag-end', evt)           : 父组件接住 vue-draggable-plus onEnd
 *   - emit('card-keydown', payload)   : 父组件接住卡片键盘事件
 *   - emit('update:newIssueDraft', v) : 列内输入双向
 *   - emit('create-issue')            : 列内创建
 *   - emit('open-move-menu', payload) : 卡片点"换列"按钮
 *   - emit('request-delete-issue', payload) : 卡片点"关闭"按钮
 */
import { ChevronDown, Plus, Tag } from 'lucide-vue-next';
import { VueDraggable } from 'vue-draggable-plus';
import type { ColumnDto, IssueCardDto } from '../../../main/ipc/schema.js';
import ColumnHeader from '@renderer/components/board/ColumnHeader.vue';

interface CardKeydownPayload {
  issue: IssueCardDto;
  fromColumnId: string;
  evt: KeyboardEvent;
}

interface Props {
  column: ColumnDto;
  issues: IssueCardDto[];
  newIssueDraft: string;
  loading: boolean;
  isOverLimit: boolean;
  overLimitTooltip: string;
  keyboardPickedIssueId: number | null;
  keyboardHoveredColumnId: string | null;
  dragOptions: Record<string, unknown>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-settings'): void;
  (e: 'drag-end', evt: unknown): void;
  (e: 'card-keydown', payload: CardKeydownPayload): void;
  (e: 'update:newIssueDraft', value: string): void;
  (e: 'create-issue'): void;
  (e: 'open-move-menu', payload: { issue: IssueCardDto; fromColumnId: string }): void;
  (e: 'request-delete-issue', payload: { issue: IssueCardDto; columnId: string }): void;
}>();
</script>

<template>
  <section
    class="column"
    :class="{ 'column--over-limit': props.isOverLimit }"
    :title="props.isOverLimit ? props.overLimitTooltip : ''"
    :aria-label="props.isOverLimit ? props.overLimitTooltip : undefined"
  >
    <ColumnHeader
      :column="props.column"
      :issue-count="props.issues.length"
      :is-over-limit="props.isOverLimit"
      :over-limit-tooltip="props.overLimitTooltip"
      @open-settings="emit('open-settings')"
    />
    <!-- 空状态：列未绑 label → 引导绑定 -->
    <div v-if="!props.column.labels.length" class="column__empty column__empty--hint">
      <p class="column__empty-text">这列还没绑标签</p>
      <p class="column__empty-hint muted">绑定 Gitea 标签后，带该标签的议题会自动出现在这里</p>
      <button type="button" class="column__empty-btn" @click="emit('open-settings')">
        <Tag :size="13" :stroke-width="2" aria-hidden="true" />
        绑定标签
      </button>
    </div>
    <!-- 空状态：绑了 label 但没匹配到 issue -->
    <div v-else-if="!props.issues.length" class="column__empty">
      <p class="column__empty-text muted">这列还没有议题</p>
      <p class="column__empty-hint muted">在下面输入框创建，或给现有议题加上对应的标签</p>
    </div>
    <!-- v1.3 拖拽：v-else 不能跟 VueDraggable 异 tag；走独立 v-if 绕开 v-else 折叠 -->
    <VueDraggable
      v-if="props.column.labels.length > 0 && props.issues.length > 0"
      v-bind="props.dragOptions"
      :class="[
        'column__cards',
        { 'column__cards--drag-target': props.keyboardHoveredColumnId === props.column.id },
      ]"
      :data-column-id="props.column.id"
      @end="(evt) => emit('drag-end', evt)"
      tag="ul"
    >
      <li
        v-for="issue in props.issues"
        :key="issue.id"
        class="card"
        :class="{
          'card--closed': issue.state === 'closed',
          'card--picked':
            props.keyboardPickedIssueId !== null && props.keyboardPickedIssueId === issue.id,
        }"
        :data-issue-index="issue.index"
        :data-column-id="props.column.id"
        tabindex="0"
        role="article"
        :aria-label="`议题 #${issue.index}：${issue.title}`"
        @keydown="(e) => emit('card-keydown', { issue, fromColumnId: props.column.id, evt: e })"
      >
        <div class="card__head">
          <span class="card__index mono">#{{ issue.index }}</span>
          <span v-if="issue.state === 'closed'" class="card__state">已关闭</span>
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
        <div class="card__actions">
          <button
            type="button"
            class="card__action"
            :title="`换列：${issue.title}`"
            :aria-label="`换列 ${issue.title}`"
            :disabled="props.loading"
            @click="emit('open-move-menu', { issue, fromColumnId: props.column.id })"
          >
            <ChevronDown :size="14" :stroke-width="2" />
          </button>
          <button
            type="button"
            class="card__action card__action--danger"
            :title="`关闭议题 #${issue.index}`"
            :aria-label="`关闭议题 #${issue.index}`"
            :disabled="props.loading"
            @click="emit('request-delete-issue', { issue, columnId: props.column.id })"
          >
            <span :style="{ display: 'inline-flex' }" aria-hidden="true">×</span>
          </button>
        </div>
      </li>
    </VueDraggable>
    <div class="column__new">
      <input
        :value="props.newIssueDraft"
        type="text"
        class="column__new-input"
        :placeholder="`在「${props.column.title}」新建议题`"
        :disabled="props.loading"
        @input="(e) => emit('update:newIssueDraft', (e.target as HTMLInputElement).value)"
        @keydown.enter="emit('create-issue')"
      />
      <button
        type="button"
        class="column__new-btn"
        :disabled="!props.newIssueDraft.trim() || props.loading"
        :title="'新建议题'"
        :aria-label="'新建议题'"
        @click="emit('create-issue')"
      >
        <Plus :size="16" :stroke-width="2" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.column {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}
.column--over-limit {
  border: 1px solid var(--color-danger, #d33);
  box-shadow: 0 0 0 1px var(--color-danger-soft, rgba(221, 51, 51, 0.15));
}
.column--over-limit .column__title { color: var(--color-danger, #d33); }

.column__cards {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  overflow-y: auto;
  min-height: 60px;
}

.column__new {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) var(--space-3);
  flex-shrink: 0;
  border-top: 1px solid var(--color-divider);
}
.column__new-input { flex: 1; background: var(--color-bg); font-size: var(--font-sm); }
.column__new-btn {
  padding: 6px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 0 0 1px var(--color-primary-active),
    0 0 8px var(--color-primary-glow);
  transition: background var(--t-fast) var(--ease);
}
.column__new-btn:hover:not(:disabled) { background: var(--color-primary-hover); }
.column__new-btn:disabled {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.column__empty {
  padding: var(--space-md, 12px) var(--space-sm, 8px);
  text-align: center;
}
.column__empty--hint {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  border: 1px dashed var(--color-border, #ccc);
  border-radius: var(--radius-md, 6px);
  margin: var(--space-sm, 8px) 0;
}
.column__empty-text {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text, inherit);
}
.column__empty-hint { margin: 0 0 8px; font-size: 12px; line-height: 1.5; }
.column__empty-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--color-primary, #609926);
  background: var(--color-primary-glow, rgba(96, 153, 38, 0.1));
  border: 1px solid var(--color-primary, #609926);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: background var(--t-fast, 120ms) var(--ease, ease);
}
.column__empty-btn:hover {
  background: var(--color-primary-hover, #4f7d1f);
  color: var(--color-text-inverse, #fff);
}

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
.card--closed { opacity: 0.6; border-left-color: var(--color-text-muted); }
.card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 4px;
}
.card__index { font-size: var(--font-xs); color: var(--color-text-muted); font-weight: 600; }
.card__state {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: var(--color-bg-active);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
}
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
.card__action--danger:hover:not(:disabled) { color: var(--color-danger); }
.card__action:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
