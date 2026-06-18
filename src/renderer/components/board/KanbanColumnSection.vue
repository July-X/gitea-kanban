<script setup lang="ts">
/**
 * KanbanColumnSection —— 看板单列内容（plan_25cc4562 Task D · BoardView 重构 · 第 7 拆分）
 *
 * 设计：
 * - 单列的"列头 + 卡片列表 + 新建议题输入"打包成一个组件
 * - 与 ColumnHeader / ColumnMenu / MoveColumnPicker 解耦：
 *   · 列头渲染委托给 ColumnHeader
 *   · 列设置弹窗由父组件管理（BoardView 持有 showColumnMenu），本组件**只**emit 'open-settings'
 *   · 拖拽事件（onEnd）由父组件传入回调
 *   · 新建议题输入框 + 换列 / 删除按钮 emit 到父
 *
 * 通信：props + emit（不直接调 store）
 *   - props.column           : 当前列
 *   - props.issues           : 当前列的 issue 列表
 *   - props.newIssueDraft    : 当前列的新建议题输入（受控）
 *   - props.loading          : store.loading
 *   - props.isOverLimit      : 超限标志（视觉）
 *   - props.overLimitTooltip : 超限提示文案
 *   - props.dragOptions      : vue-draggable-plus options
 *
 *   - emit('open-settings')           : 父组件打开列设置弹窗
 *   - emit('drag-end', evt)           : 父组件接住 vue-draggable-plus onEnd
 *   - emit('update:newIssueDraft', v) : 列内输入双向
 *   - emit('create-issue')            : 列内创建
 *   - emit('open-move-menu', payload) : 卡片点"换列"按钮
 *   - emit('request-delete-issue', payload) : 卡片点"关闭"按钮
 *
 * 历史：v1.3 引入过键盘拖拽 props（keyboardPickedIssueId / keyboardHoveredColumnId）
 * + card-keydown emit + card--picked / column__cards--drag-target class；v1.3.1 撤回。
 * 卡片 tabindex="0" + role="article" 保留（驱动 .card:focus-within 视觉反馈）。
 */
import { computed } from 'vue';
import { ChevronDown, ChevronUp, Tag } from 'lucide-vue-next';
import { VueDraggable } from 'vue-draggable-plus';
import type { ColumnDto, IssueCardDto } from '../../../main/ipc/schema.js';
import ColumnHeader from '@renderer/components/board/ColumnHeader.vue';

interface Props {
  column: ColumnDto;
  /**
   * 当前列的 open issue（默认列表，**不**含已关闭）
   * v1.4：拆 `closedIssues` 单独 prop —— 已关闭走折叠区
   */
  issues: IssueCardDto[];
  /**
   * v1.4：当前列已关闭的 issue（折叠区显示）
   * - 空数组 → 不渲染折叠区
   */
  closedIssues: IssueCardDto[];
  /**
   * v1.4：是否展示已关闭的 issue（列内 AND 全局）
   * - 全局开关 + 列内开关同时为真才显示
   * - 列内 toggle 单独控制（用户可能想看某列的已关，不想看其他列）
   */
  showClosedInColumn: boolean;
  /** v1.4：列内"显示已关闭" toggle（用户单独控制列级展开） */
  showClosedColumn: boolean;
  loading: boolean;
  isOverLimit: boolean;
  overLimitTooltip: string;
  dragOptions: Record<string, unknown>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-settings'): void;
  (e: 'drag-end', evt: unknown): void;
  // v1.4 修复：拖拽光晕显式管 class —— onStart/onMove 透传给父
  (e: 'drag-start', evt: unknown): void;
  (e: 'drag-move', evt: unknown): void;
  (e: 'open-move-menu', payload: { issue: IssueCardDto; fromColumnId: string }): void;
  (e: 'request-delete-issue', payload: { issue: IssueCardDto; columnId: string }): void;
  // v1.4 增量：列内 toggle "显示已关闭"
  (e: 'toggle-show-closed', columnId: string): void;
  // v1.4 新增：点击 card 打开详情弹窗
  (e: 'open-issue-detail', issue: IssueCardDto): void;
}>();

/**
 * v1.4 拍板：列内"显示已关闭"折叠 toggle
 * - showClosedColumn = true → 展开 closedIssues 列表
 * - 列内 toggle 跟全局 toggle AND（showClosedInColumn = showClosed && showClosedColumn）
 * - 文案：N 已关闭 ▼ / N 已关闭 ▶
 */
const closedToggleText = computed(() => {
  const n = props.closedIssues.length;
  if (n === 0) return null;
  return `${n} 张已关闭`;
});
/** 列内 toggle 按钮：点击后 emit，由父组件维护 showClosedColumn state */
function onToggleClosed(): void {
  emit('toggle-show-closed', props.column.id);
}
/** 显示哪些 issues（merge open + closed 当 showClosed 时） */
const displayIssues = computed<IssueCardDto[]>(() => {
  if (props.showClosedInColumn) {
    return [...props.issues, ...props.closedIssues];
  }
  return props.issues;
});
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
    <!--
      v1.4 修复（2026-06-17 · 空列无法成为拖放目标 bug）：
      旧 v-if="props.column.labels.length > 0 && displayIssues.length > 0" 导致列一旦空了
      （卡片全拖走 / 新建空列），VueDraggable 就不渲染 → 空列没有 drop zone → 拖不回来。
      现改为只看 labels.length > 0：绑了 label 的列即使 0 卡片也渲染 VueDraggable
      （min-height: 60px 撑出 drop zone），空状态文案移到 VueDraggable 内部当占位 li。
      v-if 而非 v-else：跟下面的 VueDraggable 异 tag，走独立 v-if 绕开 v-else 折叠坑（AGENTS §10.11）。

      v1.4 修复（2026-06-17 · 拖拽光晕失效 + 释放不记录 bug · 真因）：
      vue-draggable-plus 0.6.1 的 useDraggable 参数解析有坑：当**不传 modelValue** 时，
      它的 `Array.isArray(unref(modelValueRef)) || (options = modelValueRef, modelValueRef = null)`
      会把"本应是 options 的第二个参数"误当成 modelValue，真正的 options（group/animation/
      onStart/onMove/onEnd 等）被丢弃 → SortableJS 用默认 options 创建 → 没有 onStart/onMove/onEnd
      回调 → emit 不触发 → 上一个 commit 加的 onColumnDragStart/Move/End 永远不被调 → 光晕不亮 +
      moveIssue 不调（释放不记录）。
      修法：传 `:model-value="displayIssues"`（真实数组）让参数解析走对分支。**不**监听
      `@update:model-value` —— store 仍是 source of truth（Sortable 改 DOM 的视觉效果会被 Vue
      下一帧重渲染拉回，只有 store.moveIssue 的乐观更新说了算，与 drag-helper.ts 注释一致）。
    -->
    <VueDraggable
      v-if="props.column.labels.length > 0"
      :model-value="displayIssues"
      v-bind="props.dragOptions"
      class="column__cards"
      :data-column-id="props.column.id"
      @start="(evt) => emit('drag-start', evt)"
      @move="(evt) => emit('drag-move', evt)"
      @end="(evt) => emit('drag-end', evt)"
      tag="ul"
    >
      <!--
        空列占位：displayIssues 为空时渲染一个不可拖的占位 li（提示文案），
        min-height 由 .column__cards 撑住 drop zone。占位 li 不带 data-issue-index，
        SortableJS 不会当 card 处理；v-if 独立避免 v-else 折叠坑。
      -->
      <li v-if="!displayIssues.length" class="column__empty-placeholder" aria-hidden="true">
        <span class="muted">这列还没有议题，拖卡片进来或下面输入框创建</span>
      </li>
      <li
        v-for="issue in displayIssues"
        :key="issue.id"
        class="card"
        :class="{
          'card--closed': issue.state === 'closed',
        }"
        :data-issue-index="issue.index"
        :data-column-id="props.column.id"
        tabindex="0"
        role="article"
        :aria-label="`议题 #${issue.index}：${issue.title}`"
        @click="emit('open-issue-detail', issue)"
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
            @click.stop="emit('open-move-menu', { issue, fromColumnId: props.column.id })"
          >
            <ChevronDown :size="14" :stroke-width="2" />
          </button>
          <button
            type="button"
            class="card__action card__action--danger"
            :title="`关闭议题 #${issue.index}`"
            :aria-label="`关闭议题 #${issue.index}`"
            :disabled="props.loading"
            @click.stop="emit('request-delete-issue', { issue, columnId: props.column.id })"
          >
            <span :style="{ display: 'inline-flex' }" aria-hidden="true">×</span>
          </button>
        </div>
      </li>
    </VueDraggable>
    <!--
      v1.4 增量：列内"已关闭"折叠 toggle
      - 默认收起（showClosedColumn = false）—— 不占列内空间
      - 展开后：列底追加"已关闭"卡片列表（视觉用 card--closed 灰显样式）
      - 全局 showClosed 关时强制 hide（即便 showClosedColumn true）
    -->
    <button
      v-if="props.closedIssues.length > 0"
      type="button"
      class="column__closed-toggle"
      :class="{ 'column__closed-toggle--active': props.showClosedInColumn }"
      :title="props.showClosedInColumn ? '收起已关闭议题' : `展开 ${props.closedIssues.length} 张已关闭议题`"
      :aria-expanded="props.showClosedInColumn"
      @click="onToggleClosed"
    >
      <span>{{ closedToggleText }}</span>
      <ChevronDown v-if="!props.showClosedInColumn" :size="14" :stroke-width="2" aria-hidden="true" />
      <ChevronUp v-else :size="14" :stroke-width="2" aria-hidden="true" />
    </button>
    <!-- v1.4 调整（2026-06-18）：列内 inline 新建框已移除，新建议题改走 Header 弹窗 -->
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

/* v1.4 增量：列内"已关闭"折叠 toggle —— 灰显 + 边框 + 展开/收起 */
.column__closed-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 6px 8px;
  margin: 4px 0;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: transparent;
  border: 1px dashed var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.column__closed-toggle:hover { background: var(--color-bg-hover); color: var(--color-text); }
.column__closed-toggle--active {
  border-style: solid;
  border-color: var(--color-text-muted);
  color: var(--color-text);
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

/* ===== v1.4 列级光晕（拖卡时整列外发光 · 2026-06-17 重写）=====
 * 旧版用 `.column:has(.card--dragging)`，但配置 forceFallback: false（原生 HTML5 拖拽）
 * 下 SortableJS 的 _dragStarted 会立即把 .card--dragging 从被拖 card 上移除（改加
 * .card--ghost），导致拖拽全程没有任何元素带 .card--dragging → :has() 永不命中 → 光晕不亮。
 *
 * 修法：不依赖 SortableJS 的 dragClass，改由 useKanbanMouseDrag 的 onColumnDragStart /
 * onColumnDragMove / clearGlow 显式给列加/移 class：
 *   - .column--drag-source：源列（ onStart 加，淡光提示"我从这拖出"）
 *   - .column--drop-target：当前目标列（ onMove 加，强光提示"会落入这列"）
 * onEnd（onColumnDragEnd 内部）清所有光晕 class。
 * 模式无关（native + fallback 都 work），可单测。
 *
 * box-shadow：drop-target 用主色 2px 实线 + 24px glow 扩散；
 * drag-source 用更弱的 soft 描边（区别于目标列强光）。 */
.column--drag-source {
  box-shadow:
    0 0 0 1px var(--color-primary-soft),
    0 0 12px 2px var(--color-primary-soft);
  transition: box-shadow 120ms ease-out;
}
.column--drop-target {
  box-shadow:
    0 0 0 2px var(--color-primary),
    0 0 24px 4px var(--color-primary-glow);
  transition: box-shadow 120ms ease-out;
}

/* v1.4 修复：空列占位 li（VueDraggable 内部，撑 drop zone + 提示文案） */
.column__empty-placeholder {
  list-style: none;
  padding: var(--space-3);
  text-align: center;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  border: 1px dashed var(--color-divider);
  border-radius: var(--radius-sm);
  pointer-events: none;
}
</style>
