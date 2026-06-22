<script setup lang="ts">
/**
 * UnassignedSection —— 未分类列 + 拖拽归类（plan_25cc4562 Task C + Task D 重构 + v1.4 拍板"拖拽归类"）
 *
 * 设计（v1.4）：
 * - 列形态 = 与普通列一致（section.column.column--unassigned）
 * - **拖拽归类（v1.4 拍板）**：整段走 VueDraggable + group:'kanban' 跨列共享
 *   - 把未归类卡片拖到普通列 → 自动归类（绑该列第一个 label）
 *   - 列间互拖：列也支持（之前已有，group:'kanban' 同 group 自动联动）
 * - 保留"归到…"按钮作为 a11y 备选（键盘 / 不熟悉拖拽的 user）
 * - 已关闭的 issue 也走拖拽归类
 *
 * 通信：props + emit
 *   - props.issues : 未分类 issue 列表（含 open + closed）
 *   - props.loading : store.loading（卡片操作按钮 disabled 态）
 *   - emit('request-assign', issue) : 点"归到…"按钮（a11y 备选）
 *   - emit('drag-end', evt) : vue-draggable-plus onEnd —— 父组件 useKanbanMouseDrag 处理换列
 *
 * v1.4 拍板"拖拽归类"细节：
 * - 拖出到普通列 → 列 id 从 evt.to.dataset.columnId 拿 → 调 performDragMove
 * - 拖回 UnassignedSection 自身：不处理（user 已 unassign，没法再 unassign）
 *   - 这里**不**写列绑定逻辑（gitea 端 addLabel 走的是 store.moveIssue）
 */
import { computed, ref } from 'vue';
import { ArrowRight } from 'lucide-vue-next';
import { VueDraggable } from 'vue-draggable-plus';
import type { IssueCardDto } from '@renderer/types/dto';

interface Props {
  issues: IssueCardDto[];
  loading: boolean;
  dragOptions: Record<string, unknown>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'request-assign', issue: IssueCardDto): void;
  // v1.4 增量：拖拽到列时 emit drag-end，父组件统一处理归类
  (e: 'drag-end', evt: unknown): void;
}>();

/**
 * v1.4：拆分 open / closed 卡片
 * - open 默认显示
 * - closed 折叠收起（仅当 closed 存在时显示 toggle）
 */
const openIssues = computed<IssueCardDto[]>(() => props.issues.filter((i) => i.state !== 'closed'));
const closedIssues = computed<IssueCardDto[]>(() => props.issues.filter((i) => i.state === 'closed'));
/**
 * v1.4：UnassignedSection 列内"显示已关闭" toggle —— 列内独立控制
 */
const showClosedLocal = ref(false);
</script>

<template>
  <section
    v-if="openIssues.length || closedIssues.length"
    class="column column--unassigned"
    aria-label="未分类议题"
  >
    <header class="column__header">
      <div class="column__title-wrap">
        <h3 class="column__title">未分类</h3>
        <span class="column__count">{{ openIssues.length }} 个议题</span>
      </div>
    </header>
    <p class="column__unassigned-hint muted">
      这些议题还没归到任何列。<b>直接拖到右边任意列</b>可快速归类；点下方"归到…"也可手动选。
    </p>
    <!-- v1.4 拍板：VueDraggable + group:'kanban' 跨列共享拖拽
         v1.4 修复（2026-06-17）：传 :model-value 让 vue-draggable-plus 0.6.1 参数解析走对分支
         （详见 KanbanColumnSection 同名注释），否则 group/onEnd 等 options 被丢弃 → 跨列拖失效 -->
    <VueDraggable
      :model-value="openIssues"
      v-bind="props.dragOptions"
      class="column__cards"
      data-column-id="__unassigned__"
      @end="(evt) => emit('drag-end', evt)"
      tag="ul"
    >
      <li
        v-for="issue in openIssues"
        :key="issue.id"
        class="card card--unassigned"
        :data-issue-index="issue.index"
        :data-column-id="'__unassigned__'"
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
        <!-- 归到…按钮：v1.4 保留为 a11y / 键盘备选 -->
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
    </VueDraggable>
    <!--
      v1.4 拍板：未分类的"已关闭"折叠显示
      - 默认折叠（不打扰 user 主线）
      - 列内 toggle 独立控制（不跟全局 showClosed 联动 —— 未分类列是入口列，
        user 不一定想看"未归类的已关闭"）
    -->
    <button
      v-if="closedIssues.length"
      type="button"
      class="column__closed-toggle"
      :title="`展开 ${closedIssues.length} 张已关闭议题`"
      @click="showClosedLocal = !showClosedLocal"
    >
      <span>{{ closedIssues.length }} 张已关闭</span>
    </button>
    <ul v-if="closedIssues.length && showClosedLocal" class="column__cards column__cards--closed">
      <li
        v-for="issue in closedIssues"
        :key="issue.id"
        class="card card--unassigned card--closed"
        :aria-label="`已关闭议题 #${issue.index}：${issue.title}`"
      >
        <div class="card__head">
          <span class="card__index mono">#{{ issue.index }}</span>
          <span class="card__state">已关闭</span>
        </div>
        <div class="card__title">{{ issue.title }}</div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* v1.4 bug4 修复（2026-06-18）：补齐列容器 + header 样式，跟 KanbanColumnSection / ColumnHeader 对齐。
   旧版只有 opacity:0.85，缺 background/border-radius/box-shadow + header padding/border-bottom，
   视觉跟普通列不匹配。 */
.column--unassigned {
  min-width: 0;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  opacity: 0.85;
}
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
  white-space: nowrap;
}
.column__unassigned-hint {
  margin: 0 0 var(--space-sm, 8px);
  padding: var(--space-2) var(--space-3) 0;
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
/* v1.4 增量：未分类列的"已关闭"列表用 muted 背景区分 */
.column__cards--closed { opacity: 0.7; padding-top: 0; }
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
