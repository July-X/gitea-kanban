<script setup lang="ts">
/**
 * BoardView —— 仓库选择 + 看板（plan_25cc4562 Task D 重构版 · slim）
 *
 * 重构目标：把 v1.1 + v1.3 累加的 2072 行巨型 SFC 拆到子组件 + composable：
 *   - 子组件（src/renderer/components/board/）：
 *     BoardTopbar / KanbanColumnSection / ColumnHeader / ColumnMenu /
 *     LabelPicker / MoveColumnPicker / ConfirmFinishDialog / UnassignedSection
 *   - 全局样式：board-modals.css（Teleport 到 body 后 .modal-overlay / .move-menu 等）
 *   - 业务 composable（src/renderer/composables/）：
 *     useColumnManager（列设置 / WIP / 绑 label / 删列）
 *     useBoardCardActions（换列 / 归类 / 删除 / 标记完成）
 *
 * 重构原则（task spec）：
 * 1. 子组件 props + emit 通信，**不**直接调 store
 * 2. 全部子组件保留 scoped 样式；Teleport 全局样式集中到 board-modals.css
 * 3. BoardView 只剩"顶层布局 + drag 包装 + onMounted 串接"
 * 4. 保留 a11y / hover / focus / disabled 视觉反馈
 * 5. **不**改业务逻辑（store actions / IPC / main 端）；只搬代码不改语义
 */
import { computed, ref } from 'vue';
import { Plus } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import type { RepoDto } from '../../main/ipc/schema.js';
import EmptyState from '@renderer/components/EmptyState.vue';
// 全局样式（Teleport 后 .modal-overlay / .move-menu-overlay / .column__settings-btn 等）
import '@renderer/components/board/board-modals.css';
// 子组件
import BoardTopbar from '@renderer/components/board/BoardTopbar.vue';
import KanbanColumnSection from '@renderer/components/board/KanbanColumnSection.vue';
import ColumnMenu from '@renderer/components/board/ColumnMenu.vue';
import LabelPicker from '@renderer/components/board/LabelPicker.vue';
import MoveColumnPicker from '@renderer/components/board/MoveColumnPicker.vue';
import ConfirmFinishDialog from '@renderer/components/board/ConfirmFinishDialog.vue';
import UnassignedSection from '@renderer/components/board/UnassignedSection.vue';
// composables
import { useColumnManager } from '@renderer/composables/useColumnManager';
import { useBoardCardActions } from '@renderer/composables/useBoardCardActions';
import { useKanbanMouseDrag } from '@renderer/composables/useKanbanMouseDrag';
import { useBoardBootstrap } from '@renderer/composables/useBoardBootstrap';
import { useBoardActions } from '@renderer/composables/useBoardActions';
// 复用 ConfirmDialog（直接用，不二次包）
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';

const repo = useRepoStore();
const board = useBoardStore();

const search = ref('');
const showProjectPicker = ref(false);
const newIssueDrafts = ref<Record<string, string>>({});
const { activeProjectId } = useBoardBootstrap();
const { selectProject, createIssueInColumn, undoLastMove, redoLastMove } = useBoardActions({
  newIssueDrafts: newIssueDrafts.value,
  activeProjectId,
});
const activeRepo = computed<RepoDto | null>(() => {
  if (!activeProjectId.value) return null;
  const fn = repo.currentProject
    ? `${repo.currentProject.owner}/${repo.currentProject.name}`
    : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});
const toggleProjectPicker = () => (showProjectPicker.value = !showProjectPicker.value);

const {
  showCreateColumn,
  newColumnTitle,
  creatingColumn,
  showColumnMenu,
  editingColumnTitle,
  editingColumnWipLimit,
  confirmDeleteColumn,
  showBindLabel,
  bindingLabel,
  openCreateColumn,
  closeCreateColumn,
  confirmCreateColumn,
  openColumnMenu,
  isColumnOverLimit,
  wipOverLimitTooltip,
  isWipLimitInputInvalid,
  isColumnMenuDirty,
  confirmUpdateColumn,
  requestDeleteColumn,
  performDeleteColumn,
  openBindLabelPicker,
  bindLabel,
  unbindLabel,
} = useColumnManager();
const {
  moveMenu,
  assignMenu,
  confirmAssign,
  confirmDelete,
  confirmFinish,
  confirmAssignDescription,
  openMoveMenu,
  pickTargetColumn,
  performDragMove,
  openAssignMenu,
  pickAssignTarget,
  performAssign,
  requestDeleteIssue,
  performDelete,
  performFinishMove,
} = useBoardCardActions();

// ===== 拖拽（v1.3 · plan_25cc4562 Task A · v1.3.1 撤回键盘双模） =====
// 鼠标拖拽（vue-draggable-plus）：保留为唯一拖拽路径
const { dragOptions: columnDragOptions, onColumnDragEnd } = useKanbanMouseDrag({
  getColumnIssues: (columnId) => board.issuesOf(columnId),
  onMove: (issue, fromColumnId, toColumnId) => {
    void performDragMove(issue, fromColumnId, toColumnId, activeProjectId.value);
  },
});
</script>

<template>
  <div class="board">
    <BoardTopbar
      :active-repo="activeRepo"
      :repos="repo.repos"
      :search="search"
      :can-undo="board.canUndo"
      :can-redo="board.canRedo"
      :undo-size="board.undoSize"
      :redo-size="board.redoSize"
      :loading="board.loading"
      :picker-open="showProjectPicker"
      @toggle-picker="toggleProjectPicker"
      @update:search="(v) => (search = v)"
      @select="(r) => { showProjectPicker = false; void selectProject(r); }"
      @undo="undoLastMove"
      @redo="redoLastMove"
    />

    <div v-if="!activeRepo" class="board__placeholder">
      <EmptyState
        title="还没有选中仓库"
        description="点击左上角选择仓库，或去 gitea 添加新仓库"
      />
    </div>
    <div v-else-if="board.loading && board.columns.length === 0" class="board__placeholder">
      <p class="muted">正在加载看板…</p>
    </div>
    <div v-else-if="board.columns.length === 0" class="board__placeholder">
      <EmptyState
        title="这个仓库还没有看板列"
        description="点下方“新增列”创建第一个列，再把 gitea 上的 label绑到列上"
      />
      <button type="button" class="board__add-col-btn" @click="openCreateColumn">
        <Plus :size="16" :stroke-width="2" />
        <span>新增列</span>
      </button>
    </div>
    <div v-else class="board__columns">
      <KanbanColumnSection
        v-for="col in board.columns"
        :key="col.id"
        :column="col"
        :issues="board.issuesOf(col.id)"
        :new-issue-draft="newIssueDrafts[col.id] ?? ''"
        :loading="board.loading"
        :is-over-limit="isColumnOverLimit(col)"
        :over-limit-tooltip="wipOverLimitTooltip(col)"
        :drag-options="columnDragOptions"
        @open-settings="openColumnMenu(col)"
        @drag-end="(evt) => onColumnDragEnd(col, evt)"
        @update:new-issue-draft="(v) => (newIssueDrafts[col.id] = v)"
        @create-issue="createIssueInColumn(col)"
        @open-move-menu="({ issue, fromColumnId }) => openMoveMenu(issue, fromColumnId)"
        @request-delete-issue="({ issue, columnId }) => requestDeleteIssue(issue, columnId)"
      />
      <UnassignedSection
        v-if="board.unassignedIssues.length"
        :issues="board.unassignedIssues"
        :loading="board.loading"
        @request-assign="openAssignMenu"
      />
    </div>

    <!-- 弹窗 / 菜单 收口 -->
    <MoveColumnPicker
      :open="moveMenu.open"
      :issue-index="moveMenu.issue?.index"
      :columns="board.columns"
      :from-column-id="moveMenu.fromColumnId"
      mode="move"
      @update:open="(v) => (moveMenu.open = v)"
      @pick="(id) => pickTargetColumn(id, activeProjectId)"
    />
    <MoveColumnPicker
      :open="assignMenu.open"
      :issue-index="assignMenu.issue?.index"
      :columns="board.columns.filter((c) => c.labels.length > 0)"
      :from-column-id="null"
      mode="assign"
      @update:open="(v) => (assignMenu.open = v)"
      @pick="(id) => pickAssignTarget(id)"
    />

    <ConfirmDialog
      :open="confirmDelete.open"
      title="关闭这张议题？"
      :description="
        confirmDelete.issue
          ? `议题 #${confirmDelete.issue.index}「${confirmDelete.issue.title}」将在 gitea 上标记为已关闭（v1 不真删除）。关闭后你仍能在 gitea 的「已关闭」列表里找到它。`
          : ''
      "
      confirm-label="我了解风险，仍要关闭"
      cancel-label="取消"
      :danger="true"
      confirm-keyword="关闭"
      @update:open="(v) => (confirmDelete.open = v)"
      @confirm="performDelete(activeProjectId)"
    />

    <ConfirmDialog
      :open="confirmAssign.open"
      title="归类这张议题？"
      :description="confirmAssignDescription"
      confirm-label="确认归类"
      cancel-label="取消"
      :danger="false"
      confirm-keyword="归类"
      @update:open="(v) => (confirmAssign.open = v)"
      @confirm="performAssign(activeProjectId)"
    />

    <ConfirmFinishDialog
      :open="confirmFinish.open"
      :issue="confirmFinish.issue"
      @update:open="(v) => (confirmFinish.open = v)"
      @confirm="performFinishMove(activeProjectId)"
    />

    <Teleport to="body">
      <div v-if="showCreateColumn" class="modal-overlay" @click.self="closeCreateColumn">
        <div class="modal" role="dialog" aria-modal="true" aria-label="新增列">
          <header class="modal__header">
            <h2 class="modal__title">新增列</h2>
            <button type="button" class="modal__close" :aria-label="'关闭'" @click="closeCreateColumn">
              <span :style="{ display: 'inline-flex' }" aria-hidden="true">×</span>
            </button>
          </header>
          <div class="modal__body">
            <label class="modal__label" for="new-col-title">列名</label>
            <input
              id="new-col-title"
              v-model="newColumnTitle"
              type="text"
              class="modal__input"
              placeholder="例如: 待办 / 进行中 / 已完成"
              :disabled="creatingColumn"
              maxlength="32"
              autofocus
              @keydown.enter="confirmCreateColumn(activeProjectId)"
            />
            <p class="modal__hint muted">列会按从左到右展示;之后可改列名、删除、或绑 gitea 仓库里的标签</p>
          </div>
          <footer class="modal__footer">
            <button type="button" class="modal__btn modal__btn--ghost" :disabled="creatingColumn" @click="closeCreateColumn">取消</button>
            <button
              type="button"
              class="modal__btn modal__btn--primary"
              :disabled="!newColumnTitle.trim() || creatingColumn"
              @click="confirmCreateColumn(activeProjectId)"
            >
              {{ creatingColumn ? '创建中...' : '新增列' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <ColumnMenu
      :open="showColumnMenu.open"
      :column="showColumnMenu.column"
      :editing-title="editingColumnTitle"
      :editing-wip-limit="editingColumnWipLimit"
      :is-wip-invalid="isWipLimitInputInvalid()"
      :is-dirty="isColumnMenuDirty()"
      :binding-label="bindingLabel"
      @update:open="(v) => (showColumnMenu.open = v)"
      @update:editing-title="(v) => (editingColumnTitle = v)"
      @update:editing-wip-limit="(v) => (editingColumnWipLimit = v)"
      @save="confirmUpdateColumn"
      @request-delete="requestDeleteColumn"
      @unbind-label="(id) => unbindLabel(id)"
      @open-bind-label="openBindLabelPicker"
    />

    <LabelPicker
      :open="showBindLabel"
      :column="showColumnMenu.column"
      :labels="board.labelsByProject"
      :binding="bindingLabel"
      @update:open="(v) => (showBindLabel = v)"
      @bind-label="({ id, name }) => bindLabel(id, name)"
    />

    <ConfirmDialog
      :open="confirmDeleteColumn.open"
      :title="'删除列 ' + (confirmDeleteColumn.column ? confirmDeleteColumn.column.title : '')"
      description="删除后无法恢复。如果列里有议题,它们不会消失,只是不再被这个看板列归类。"
      confirm-label="我了解风险,仍要删除"
      cancel-label="取消"
      :danger="true"
      confirm-keyword="删除"
      @update:open="(v) => (confirmDeleteColumn.open = v)"
      @confirm="performDeleteColumn"
    />
  </div>
</template>

<style scoped>
.board {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}
.board__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}
.board__add-col-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  cursor: pointer;
  box-shadow:
    0 0 0 1px var(--color-primary-active),
    0 0 12px var(--color-primary-glow);
}
.board__columns {
  flex: 1;
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4);
  overflow-x: auto;
  overflow-y: hidden;
  align-items: flex-start;
}
</style>
