<script setup lang="ts">
/**
 * IssueDetailDialog —— 议题详情弹窗（v1.4 · 2026-06-18）
 *
 * 点击看板 card → 弹窗显示 issue 完整信息：
 * 标题 / 状态 / #index / 作者 / 创建/更新时间 / 标签 / 正文（body）
 * + 评论列表（issuesCommentList）+ 发评论（issuesCommentCreate）
 *
 * 设计：
 * - 非模态：点遮罩不关，必须点关闭按钮（与 CreateIssueDialog 一致）
 * - 数据：props.issue（IssueCardDto）传当前议题；评论 props 传入或组件内自加载
 * - 通信：props.open + emit('update:open') + emit('comment-created')
 */
import { computed, ref, watch } from 'vue';
import { X, Send, GitBranch } from 'lucide-vue-next';
import type { IssueCardDto, IssueCommentDto, IssueLabelDto } from '@renderer/types/dto';
import LabelSelectDropdown from '@renderer/components/board/LabelSelectDropdown.vue';

interface Props {
  open: boolean;
  /** 当前议题（点哪个 card 就传哪个） */
  issue: IssueCardDto | null;
  /** 评论列表（父组件加载后传入） */
  comments: IssueCommentDto[];
  /** 评论加载中 */
  commentsLoading?: boolean;
  /** 发评论中 */
  submitting?: boolean;
  /** v1.4：仓库全部标签（标签编辑用） */
  allLabels?: IssueLabelDto[];
}

const props = withDefaults(defineProps<Props>(), {
  commentsLoading: false,
  submitting: false,
  allLabels: () => [],
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'request-comments', issueIndex: number): void;
  (e: 'submit-comment', payload: { issueIndex: number; body: string }): void;
  /** v1.4：标签增删（父组件调 store.updateIssueLabels） */
  (e: 'update-labels', payload: { issueIndex: number; addLabelIds: number[]; removeLabelIds: number[] }): void;
  /** v1.4：点击关联分支跳时间轴（父组件走 branch.setPendingTimelineFocus + router.push） */
  (e: 'jump-to-branch', refBranch: string): void;
}>();

const commentDraft = ref('');

// 每次打开弹窗时清空草稿
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      commentDraft.value = '';
    }
  },
);

const canSubmitComment = () => commentDraft.value.trim().length > 0;

/** v1.4：标签编辑 —— 当前 issue 已有的 label id 集合 */
const issueLabelIds = computed<Set<number>>(() => new Set(props.issue?.labels.map((l) => l.id) ?? []));

/** v1.4：标签切换（LabelSelectDropdown toggle）—— 已有则删，没有则加 */
function toggleLabel(id: number): void {
  if (!props.issue) return;
  if (issueLabelIds.value.has(id)) {
    emit('update-labels', { issueIndex: props.issue.index, addLabelIds: [], removeLabelIds: [id] });
  } else {
    emit('update-labels', { issueIndex: props.issue.index, addLabelIds: [id], removeLabelIds: [] });
  }
}

/** v1.4：点击关联分支 → emit 给父组件跳时间轴（子组件不直接调 store/router） */
function onJumpToBranch(): void {
  if (!props.issue || !props.issue.refBranch) return;
  emit('jump-to-branch', props.issue.refBranch);
}

function close(): void {
  emit('update:open', false);
}

function submitComment(): void {
  if (!props.issue || !canSubmitComment()) return;
  emit('submit-comment', { issueIndex: props.issue.index, body: commentDraft.value.trim() });
  commentDraft.value = '';
}

/** 格式化日期 */
function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- 非模态：点遮罩不关 -->
    <div v-if="props.open && props.issue" class="modal-overlay">
      <div
        class="modal issue-detail-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="`议题 #${props.issue.index} 详情`"
      >
        <header class="modal__header">
          <div class="issue-detail__title-wrap">
            <span class="issue-detail__index mono">#{{ props.issue.index }}</span>
            <span
              class="issue-detail__state"
              :class="props.issue.state === 'closed' ? 'issue-detail__state--closed' : ''"
            >
              {{ props.issue.state === 'closed' ? '已关闭' : '进行中' }}
            </span>
          </div>
          <button type="button" class="modal__close" aria-label="关闭" @click="close">
            <X :size="16" :stroke-width="2" />
          </button>
        </header>

        <div class="modal__body issue-detail__body">
          <!-- 标题 -->
          <h2 class="issue-detail__title">{{ props.issue.title }}</h2>

          <!-- 元信息：作者 + 时间 -->
          <div class="issue-detail__meta">
            <span v-if="props.issue.author?.fullName || props.issue.author?.username" class="muted">
              作者：{{ props.issue.author.fullName || props.issue.author.username }}
            </span>
            <span class="muted">创建：{{ fmtDate(props.issue.createdAt) }}</span>
            <span class="muted">更新：{{ fmtDate(props.issue.updatedAt) }}</span>
          </div>

          <!-- 标签（v1.4：带搜索过滤下拉框，可二次增删） -->
          <div class="issue-detail__labels-section">
            <span class="issue-detail__section-label">标签</span>
            <LabelSelectDropdown
              :labels="props.allLabels"
              :selected-ids="issueLabelIds"
              placeholder="搜索或选择标签"
              @toggle="toggleLabel"
            />
          </div>

          <!-- 关联分支（v1.4：可点击跳时间轴，高亮该分支最新提交） -->
          <div
            v-if="props.issue.refBranch"
            class="issue-detail__ref-branch"
            role="button"
            tabindex="0"
            title="在时间轴查看此分支"
            @click="onJumpToBranch"
            @keydown.enter.prevent="onJumpToBranch"
            @keydown.space.prevent="onJumpToBranch"
          >
            <GitBranch :size="13" :stroke-width="2" aria-hidden="true" />
            <span class="mono">{{ props.issue.refBranch }}</span>
          </div>

          <!-- 正文 -->
          <section class="issue-detail__section">
            <h3 class="issue-detail__section-title">内容</h3>
            <div v-if="props.issue.body" class="issue-detail__body-text">
              {{ props.issue.body }}
            </div>
            <div v-else class="issue-detail__empty muted">暂无内容</div>
          </section>

          <!-- 评论列表 -->
          <section class="issue-detail__section">
            <h3 class="issue-detail__section-title">
              评论
              <span v-if="props.comments.length" class="issue-detail__count">
                {{ props.comments.length }}
              </span>
            </h3>
            <div v-if="props.commentsLoading" class="issue-detail__empty muted">加载中…</div>
            <div v-else-if="props.comments.length === 0" class="issue-detail__empty muted">
              暂无评论
            </div>
            <ul v-else class="issue-detail__comments">
              <li v-for="c in props.comments" :key="c.id" class="issue-detail__comment">
                <div class="issue-detail__comment-head">
                  <span class="issue-detail__comment-author">
                    {{ c.author.fullName || c.author.username }}
                  </span>
                  <span class="muted issue-detail__comment-time">{{ fmtDate(c.createdAt) }}</span>
                </div>
                <div class="issue-detail__comment-body">{{ c.body }}</div>
              </li>
            </ul>
          </section>
        </div>

        <!-- 发评论 -->
        <footer class="modal__footer issue-detail__footer">
          <textarea
            v-model="commentDraft"
            class="issue-detail__comment-input"
            placeholder="写下你的评论…"
            rows="2"
            :disabled="props.submitting"
            @keydown.enter.meta="submitComment"
            @keydown.enter.ctrl="submitComment"
          />
          <button
            type="button"
            class="modal__btn modal__btn--primary issue-detail__send-btn"
            :disabled="!canSubmitComment() || props.submitting"
            @click="submitComment"
          >
            <Send :size="14" :stroke-width="2" />
            <span>发送</span>
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.issue-detail-modal {
  width: 640px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
}
.issue-detail__title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.issue-detail__index {
  font-size: var(--font-md);
  color: var(--color-text-muted);
  font-weight: 600;
}
.issue-detail__state {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  /* v1.6：去 v1.1 强底色，降到 --color-primary-soft */
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.issue-detail__state--closed {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
}
.issue-detail__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
}
.issue-detail__title {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.4;
}
.issue-detail__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--font-xs);
}
.issue-detail__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
/* v1.4：标签二次修改区 */
.issue-detail__labels-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.issue-detail__section-label {
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--color-text-muted);
}
.issue-detail__labels-current {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.issue-detail__labels-available {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.issue-detail__labels-hint {
  font-size: var(--font-xs);
  margin-right: 2px;
}
.issue-detail__labels-empty {
  font-size: var(--font-xs);
  font-style: italic;
}
.issue-detail__label {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  background: var(--label-color, var(--color-bg-hover));
  color: var(--color-text-inverse, #fff);
}
.issue-detail__label--removable {
  cursor: pointer;
  transition: opacity var(--t-fast) var(--ease);
}
.issue-detail__label--removable:hover {
  opacity: 0.6;
}
.issue-detail__label--addable {
  cursor: pointer;
  background: transparent;
  border: 1px dashed var(--color-divider);
  color: var(--color-text-muted);
  transition: all var(--t-fast) var(--ease);
}
.issue-detail__label--addable:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  border-style: solid;
}
/* v1.4：关联分支展示（可点击跳时间轴） */
.issue-detail__ref-branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  padding: 2px 8px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  align-self: flex-start;
  cursor: pointer;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.issue-detail__ref-branch:hover,
.issue-detail__ref-branch:focus-visible {
  color: var(--color-primary);
  background: var(--color-primary-soft);
  outline: none;
}
.issue-detail__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.issue-detail__section-title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.issue-detail__count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
}
.issue-detail__body-text {
  padding: var(--space-3);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.issue-detail__empty {
  font-size: var(--font-sm);
  font-style: italic;
}
.issue-detail__comments {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.issue-detail__comment {
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
}
.issue-detail__comment-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.issue-detail__comment-author {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-text);
}
.issue-detail__comment-time {
  font-size: var(--font-xs);
}
.issue-detail__comment-body {
  font-size: var(--font-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
/* footer 发评论区 */
.issue-detail__footer {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
}
.issue-detail__comment-input {
  flex: 1;
  padding: 8px 10px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-sm);
  font-family: inherit;
  resize: none;
}
.issue-detail__comment-input:focus {
  outline: none;
  border-color: var(--color-primary);
}
.issue-detail__send-btn {
  flex-shrink: 0;
}
</style>
