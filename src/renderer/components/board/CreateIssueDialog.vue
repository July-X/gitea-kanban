<script setup lang="ts">
/**
 * CreateIssueDialog —— 新建议题弹窗（v1.4 · 2026-06-18）
 *
 * 还原 Gitea 新建 issue 方式：标题 + 正文 + 标签 + 里程碑 + 指派人 + 看板列（锁定新建列）。
 *
 * 设计：
 * - 复用 LabelPicker 的 modal 外壳模式（Teleport to body + v-if + open prop）
 * - 数据源：标签 board.labelsByProject / 指派人 window.api.members.list /
 *   里程碑 window.api.milestones.list（空列表时显示提示）
 * - 看板列锁定为"新建"列（disabled，只读展示）
 * - 确认 → emit('create', { title, body, labelIds, assignees, milestoneId })
 *   → BoardView 调 board.createIssue（列 label 自动合并）
 *
 * 通信：props.open + emit('update:open') + emit('create')
 */
import { computed, ref, watch } from 'vue';
import { X, Plus } from 'lucide-vue-next';
import type { IssueLabelDto, CollaboratorDto, MilestoneDto } from '../../../../main/ipc/schema.js';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 仓库全部标签（来自 board.labelsByProject） */
    labels?: IssueLabelDto[];
    /** 仓库协作者（来自 window.api.members.list） */
    members?: CollaboratorDto[];
    /** 仓库里程碑（来自 window.api.milestones.list） */
    milestones?: MilestoneDto[];
    /** 锁定的看板列标题（展示用，如"新建"） */
    lockedColumnTitle: string;
    /** 里程碑/指派人加载中 */
    loading?: boolean;
  }>(),
  { labels: () => [], members: () => [], milestones: () => [], loading: false },
);

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (
    e: 'create',
    payload: {
      title: string;
      body?: string;
      labelIds?: number[];
      assignees?: string[];
      milestoneId?: number;
    },
  ): void;
}>();

// 表单状态
const title = ref('');
const body = ref('');
const selectedLabelIds = ref<Set<number>>(new Set());
const selectedAssignees = ref<Set<string>>(new Set());
const selectedMilestoneId = ref<number | null>(null);

// 每次打开弹窗时重置表单
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      title.value = '';
      body.value = '';
      selectedLabelIds.value = new Set();
      selectedAssignees.value = new Set();
      selectedMilestoneId.value = null;
    }
  },
);

const canSubmit = computed(() => title.value.trim().length > 0);

/** 是否有未保存改动（标题/正文/标签/指派人/里程碑 任一非空） */
const hasUnsavedChanges = computed(
  () =>
    title.value.trim().length > 0 ||
    body.value.trim().length > 0 ||
    selectedLabelIds.value.size > 0 ||
    selectedAssignees.value.size > 0 ||
    selectedMilestoneId.value !== null,
);

function toggleLabel(id: number): void {
  const next = new Set(selectedLabelIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedLabelIds.value = next;
}

function toggleAssignee(username: string): void {
  const next = new Set(selectedAssignees.value);
  if (next.has(username)) next.delete(username);
  else next.add(username);
  selectedAssignees.value = next;
}

/**
 * 请求关闭：必须点关闭按钮主动触发（不响应遮罩点击）。
 * 有未保存改动时二次确认，避免误关丢失信息。
 */
function requestClose(): void {
  if (hasUnsavedChanges.value) {
    const ok = window.confirm('当前有未保存的改动，关闭将丢失信息。确定不保存并关闭吗？');
    if (!ok) return;
  }
  emit('update:open', false);
}

function submit(): void {
  if (!canSubmit.value) return;
  emit('create', {
    title: title.value.trim(),
    ...(body.value.trim() ? { body: body.value.trim() } : {}),
    ...(selectedLabelIds.value.size > 0
      ? { labelIds: Array.from(selectedLabelIds.value) }
      : {}),
    ...(selectedAssignees.value.size > 0
      ? { assignees: Array.from(selectedAssignees.value) }
      : {}),
    ...(selectedMilestoneId.value !== null ? { milestoneId: selectedMilestoneId.value } : {}),
  });
}
</script>

<template>
  <Teleport to="body">
    <!-- v1.4：非模态 —— 点遮罩不关闭，必须点关闭按钮主动管理；有改动时二次确认 -->
    <div v-if="props.open" class="modal-overlay">
      <div class="modal create-issue-modal" role="dialog" aria-modal="true" aria-label="新建议题">
        <header class="modal__header">
          <h2 class="modal__title">新建议题</h2>
          <button type="button" class="modal__close" aria-label="关闭" @click="requestClose">
            <X :size="16" :stroke-width="2" />
          </button>
        </header>
        <div class="modal__body create-issue__body">
          <!-- 标题（必填） -->
          <div class="create-issue__field">
            <label class="create-issue__label" for="create-issue-title">标题</label>
            <input
              id="create-issue-title"
              v-model="title"
              type="text"
              class="create-issue__input"
              placeholder="一句话描述这个议题"
              autofocus
            />
          </div>

          <!-- 内容（正文） -->
          <div class="create-issue__field">
            <label class="create-issue__label" for="create-issue-body">内容</label>
            <textarea
              id="create-issue-body"
              v-model="body"
              class="create-issue__textarea"
              placeholder="详细描述（支持 Markdown）"
              rows="5"
            />
          </div>

          <!-- 标签（多选） -->
          <div class="create-issue__field">
            <span class="create-issue__label">标签</span>
            <div class="create-issue__chips">
              <button
                v-for="lab in props.labels"
                :key="lab.id"
                type="button"
                class="create-issue__chip"
                :class="{ 'create-issue__chip--active': selectedLabelIds.has(lab.id) }"
                :title="lab.description || lab.name"
                @click="toggleLabel(lab.id)"
              >
                <span class="create-issue__chip-dot" :style="{ background: lab.color || '#888' }" />
                <span>{{ lab.name }}</span>
              </button>
              <span v-if="props.labels.length === 0" class="create-issue__empty-hint">
                仓库暂无标签
              </span>
            </div>
          </div>

          <!-- 里程碑（下拉单选） -->
          <div class="create-issue__field">
            <label class="create-issue__label" for="create-issue-milestone">里程碑</label>
            <select
              id="create-issue-milestone"
              v-model="selectedMilestoneId"
              class="create-issue__select"
              :disabled="props.loading || props.milestones.length === 0"
            >
              <option :value="null">不选择里程碑</option>
              <option v-for="m in props.milestones" :key="m.id" :value="m.id">
                {{ m.title }}{{ m.state === 'closed' ? '（已关闭）' : '' }}
              </option>
            </select>
            <span v-if="props.milestones.length === 0" class="create-issue__empty-hint">
              暂无里程碑，请联系管理员在 Gitea 新建
            </span>
          </div>

          <!-- 指派人（多选） -->
          <div class="create-issue__field">
            <span class="create-issue__label">指派人</span>
            <div class="create-issue__chips">
              <button
                v-for="mem in props.members"
                :key="mem.username"
                type="button"
                class="create-issue__chip"
                :class="{ 'create-issue__chip--active': selectedAssignees.has(mem.username) }"
                :title="mem.fullName || mem.username"
                @click="toggleAssignee(mem.username)"
              >
                <span>{{ mem.fullName || mem.username }}</span>
              </button>
              <span v-if="props.members.length === 0" class="create-issue__empty-hint">
                仓库暂无协作者
              </span>
            </div>
          </div>

          <!-- 看板列（锁定，只读） -->
          <div class="create-issue__field">
            <span class="create-issue__label">看板列</span>
            <div class="create-issue__locked-column">
              <span class="create-issue__locked-tag">{{ props.lockedColumnTitle }}</span>
              <span class="create-issue__locked-hint">新建议题默认进入此列</span>
            </div>
          </div>
        </div>
        <footer class="modal__footer">
          <button type="button" class="modal__btn modal__btn--ghost" @click="requestClose">取消</button>
          <button
            type="button"
            class="modal__btn modal__btn--primary"
            :disabled="!canSubmit"
            @click="submit"
          >
            <Plus :size="14" :stroke-width="2" />
            <span>创建</span>
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.create-issue-modal {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
}
.create-issue__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
}
.create-issue__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.create-issue__label {
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--color-text-muted);
}
.create-issue__input,
.create-issue__textarea,
.create-issue__select {
  width: 100%;
  padding: 8px 10px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-sm);
  font-family: inherit;
}
.create-issue__input:focus,
.create-issue__textarea:focus,
.create-issue__select:focus {
  outline: none;
  border-color: var(--color-primary);
}
.create-issue__textarea {
  resize: vertical;
  min-height: 80px;
}
/* 标签 / 指派人 chip 多选区 */
.create-issue__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.create-issue__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
}
.create-issue__chip:hover {
  border-color: var(--color-primary);
}
.create-issue__chip--active {
  background: var(--color-primary-glow);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.create-issue__chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.create-issue__empty-hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-style: italic;
}
/* 看板列锁定区 */
.create-issue__locked-column {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
}
.create-issue__locked-tag {
  padding: 2px 8px;
  background: var(--color-primary-glow);
  color: var(--color-primary);
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  font-weight: 500;
}
.create-issue__locked-hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
</style>
