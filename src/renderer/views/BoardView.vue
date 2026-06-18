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
import { computed, reactive, ref, watch } from 'vue';
import { Plus } from 'lucide-vue-next';
import { showToast } from '@renderer/lib/toast';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import type { ColumnDto, IssueCardDto, RepoDto, CollaboratorDto, MilestoneDto } from '../../main/ipc/schema.js';
import { matchIssueToColumn } from '@renderer/lib/issue-column-match';
import { membersList, milestonesList } from '@renderer/lib/ipc-client';
import EmptyState from '@renderer/components/EmptyState.vue';
// 全局样式（Teleport 后 .modal-overlay / .move-menu-overlay / .column__settings-btn 等）
import '@renderer/components/board/board-modals.css';
// 子组件
import BoardTopbar from '@renderer/components/board/BoardTopbar.vue';
import KanbanColumnSection from '@renderer/components/board/KanbanColumnSection.vue';
import ClosedSection from '@renderer/components/board/ClosedSection.vue';
import ColumnMenu from '@renderer/components/board/ColumnMenu.vue';
import LabelPicker from '@renderer/components/board/LabelPicker.vue';
import MoveColumnPicker from '@renderer/components/board/MoveColumnPicker.vue';
import ConfirmFinishDialog from '@renderer/components/board/ConfirmFinishDialog.vue';
import UnassignedSection from '@renderer/components/board/UnassignedSection.vue';
import CreateIssueDialog from '@renderer/components/board/CreateIssueDialog.vue';
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
const auth = useAuthStore();

// v1.4 调整（2026-06-18）：列内 inline 新建框已移除，新建议题改走 Header 弹窗
const createIssueDialogOpen = ref(false);
const createIssueMembers = ref<CollaboratorDto[]>([]);
const createIssueMilestones = ref<MilestoneDto[]>([]);
const createIssueLoading = ref(false);
/** 锁定的"新建"列（新建议题默认进此列）。找不到时退回第一列。 */
const lockedColumn = computed<ColumnDto | null>(() => {
  const cols = board.columns;
  if (cols.length === 0) return null;
  return cols.find((c) => c.title.includes('新建')) ?? cols[0];
});

/**
 * v1.4 优化（2026-06-18）：members/milestones 会话级缓存。
 * 旧版每次点"新建议题"都 Promise.all 拉 Gitea API（~1.5s），弹窗下拉禁用等待。
 * 改为：activeProjectId 变化时后台预加载（用户看板加载时并行，无感知），
 * 弹窗打开时缓存已就绪则直接用（瞬时）；缓存未命中才请求（fallback）。
 * 缓存 key = projectId，切仓库时重置。
 */
const createIssueCache = ref<Record<string, { members: CollaboratorDto[]; milestones: MilestoneDto[] }>>({});
let createIssuePreloading = false;

/** 后台预加载 members/milestones（不阻塞 UI，失败静默——弹窗打开时 fallback 重试） */
async function preloadCreateIssueData(pid: string): Promise<void> {
  if (createIssuePreloading || createIssueCache.value[pid]) return;
  createIssuePreloading = true;
  try {
    const [memResp, mileResp] = await Promise.all([
      membersList({ projectId: pid }).catch(() => ({ items: [], hasMore: false })),
      milestonesList({ projectId: pid }).catch(() => ({ items: [], hasMore: false })),
    ]);
    createIssueCache.value = {
      ...createIssueCache.value,
      [pid]: { members: memResp.items, milestones: mileResp.items },
    };
  } finally {
    createIssuePreloading = false;
  }
}

// activeProjectId 变化（loadBoard 完成）时后台预加载
watch(
  activeProjectId,
  (pid) => {
    if (pid) void preloadCreateIssueData(pid);
  },
  { immediate: true },
);
// v1.4（P0-1 autoInit 透明化）：把 useColumnManager() 提到顶部，让 openColumnMenu
// 既能注入 bootstrap 回调、又能给下面解构用（避免重复声明）
const columnManager = useColumnManager();

// v1.4 增量 · 拍板 2026-06-16 user 拍板「重建视图」按钮
// ConfirmDialog 状态
const resetDialogOpen = ref(false);

/** 打开 ConfirmDialog（BoardTopbar @reset-view 触发） */
function onResetViewRequest(): void {
  // 至少要有 activeProject 才允许 reset（否则就 Reset 0 列，没必要）
  if (!activeProjectId.value) {
    showToast({
      type: 'info',
      message: '当前未选仓库',
      description: '请先在状态栏选个仓库再重建视图',
      duration: 3000,
    });
    return;
  }
  resetDialogOpen.value = true;
}

/** 用户点 ConfirmDialog 确认 → 调 store resetColumnsAndReinit */
async function onConfirmResetView(): Promise<void> {
  resetDialogOpen.value = false;
  const projectId = activeProjectId.value;
  if (!projectId) return;
  const beforeCount = board.columns.length;
  try {
    const result = await board.resetColumnsAndReinit(projectId);
    if (result.autoInitCreatedCount > 0) {
      showToast({
        type: 'success',
        message: '视图已重建',
        description: `已清空 ${beforeCount} 列并按 gitea label 重新建了 ${result.autoInitCreatedCount} 列`,
        duration: 4500,
      });
    } else {
      showToast({
        type: 'info',
        message: '视图已重建',
        description: `已清空 ${beforeCount} 列（gitea 暂无 label，无新列可建）`,
        duration: 3500,
      });
    }
  } catch (e) {
    // store 内部已 set error.value；这里只提示
    showToast({
      type: 'error',
      message: '重建失败',
      description: '请看状态栏错误提示，重试一次',
      duration: 4000,
    });
  }
}

/**
 * v1.4 调整（2026-06-18）：新建议题弹窗。
 * 优先用预加载缓存（瞬时）；缓存未命中才请求（fallback ~1.5s）。
 */
async function openCreateIssueDialog(): Promise<void> {
  const pid = activeProjectId.value;
  if (!pid) return;
  createIssueDialogOpen.value = true;
  // 优先用缓存（预加载大概率已就绪 → 瞬时显示）
  const cached = createIssueCache.value[pid];
  if (cached) {
    createIssueMembers.value = cached.members;
    createIssueMilestones.value = cached.milestones;
    createIssueLoading.value = false;
    return;
  }
  // 缓存未命中：请求 + 缓存
  createIssueLoading.value = true;
  createIssueMembers.value = [];
  createIssueMilestones.value = [];
  try {
    const [memResp, mileResp] = await Promise.all([
      membersList({ projectId: pid }).catch(() => ({ items: [], hasMore: false })),
      milestonesList({ projectId: pid }).catch(() => ({ items: [], hasMore: false })),
    ]);
    createIssueMembers.value = memResp.items;
    createIssueMilestones.value = mileResp.items;
    createIssueCache.value = {
      ...createIssueCache.value,
      [pid]: { members: memResp.items, milestones: mileResp.items },
    };
  } finally {
    createIssueLoading.value = false;
  }
}

/** 弹窗确认创建 → 调 board.createIssue（列 label 自动合并） */
async function onCreateIssue(payload: {
  title: string;
  body?: string;
  labelIds?: number[];
  assignees?: string[];
  milestoneId?: number;
}): Promise<void> {
  const pid = activeProjectId.value;
  const col = lockedColumn.value;
  if (!pid || !col) return;
  try {
    await board.createIssue({
      projectId: pid,
      columnId: col.id,
      title: payload.title,
      ...(payload.body ? { body: payload.body } : {}),
      ...(payload.labelIds && payload.labelIds.length > 0 ? { labelIds: payload.labelIds } : {}),
      ...(payload.assignees && payload.assignees.length > 0 ? { assignees: payload.assignees } : {}),
      ...(payload.milestoneId !== undefined ? { milestoneId: payload.milestoneId } : {}),
    });
    createIssueDialogOpen.value = false;
    showToast({ type: 'success', message: '已创建议题', duration: 2500 });
  } catch {
    /* board.error 已设置，状态栏会显示 */
  }
}

const { openColumnMenu } = columnManager;
const { activeProjectId } = useBoardBootstrap({
  onAutoInitOpenColumnMenu: (col) => {
    openColumnMenu(col);
  },
});
// v1.4 调整（2026-06-18）：列内新建框已移除，createIssueInColumn 不再使用；
// 保留 useBoardActions 取 undo/redo，newIssueDrafts 传空对象（createIssueInColumn 不再被调）
const { undoLastMove, redoLastMove } = useBoardActions({
  newIssueDrafts: {},
  activeProjectId,
});
const activeRepo = computed<RepoDto | null>(() => {
  if (!activeProjectId.value) return null;
  const fn = repo.currentProject
    ? `${repo.currentProject.owner}/${repo.currentProject.name}`
    : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/**
 * v1.4 调整（2026-06-18）：当前仓库的 Gitea 页面 URL，传给 BoardTopbar 的"Gitea 数据源"按钮。
 * 拼 ${giteaUrl}/${owner}/${name}（Gitea 仓库路径 = owner/name）。
 * 无 currentProject 或 giteaUrl 时返空串（按钮隐藏）。
 */
const giteaSourceUrl = computed<string>(() => {
  const proj = repo.currentProject;
  const url = auth.currentGiteaUrl;
  if (!proj || !url) return '';
  return `${url.replace(/\/+$/, '')}/${proj.owner}/${proj.name}`;
});

/**
 * v1.4 P0-2：未归类 gitea label 数量
 *  - v1.4 兜底：board store 没有 breakdown 字段 → 0（不显示 banner）
 *  - v1.5 接 autoInitBreakdown：返回 store 的 unmatched.length
 *  - 走 computed 形式：响应 board store 变化，未来 v1.5 改 store 即可
 */
const unmatchedLabelCount = computed<number>(() => {
  // v1.4：永远 0（v1.5 占位）
  // v1.5 替换：return board.lastAutoInitBreakdown?.unmatched.length ?? 0;
  return 0;
});
// v1.4 任务 #statusbar-picker：仓库选择已下沉到 StatusBar 全局 picker
// BoardTopbar 不再接收 activeRepo / search / pickerOpen / selectProject 这些 props/emits
// 这里保留 activeRepo 仅用于 EmptyState 判断"是否选过仓库"

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
// v1.4 增量：列内"显示已关闭" toggle（每列独立，key = columnId）
const showClosedByColumn = reactive<Record<string, boolean>>({});
function toggleColumnShowClosed(columnId: string): void {
  showClosedByColumn[columnId] = !(showClosedByColumn[columnId] ?? false);
}
/**
 * v1.4 布局（2026-06-18 修订 · 消除横向滚动条）：
 * 普通列列表 —— 不再把"已关闭"section 插入列流。
 * 旧版把 ClosedSection 当独立列插入横向 flex 流，列多时总宽超视口 → 横向滚动条。
 * 修订后 ClosedSection 独立渲染在列区下方（换行排到"第一列下面"语义），
 * `.board__columns` 改 flex-wrap + overflow-y:auto，列换行适配视口，仅纵向滚动。
 */
type ColumnListItem = { kind: 'column'; key: string; column: ColumnDto };

const columnsWithClosed = computed<ColumnListItem[]>(() => {
  // 纯列列表（ClosedSection 不再 inline，模板独立渲染）
  return board.columns.map((c) => ({ kind: 'column', key: c.id, column: c }));
});

/** v1.4：按列 id 拿该列的 closed issue 列表（已关的） */
function closedIssuesOf(columnId: string): IssueCardDto[] {
  // closedIssues 是全局仓库的，需要按 column 归类（同 open 的逻辑）
  // 复用 matchIssueToColumn：按 issue.labels ∩ column.labels 匹配
  return board.closedIssues.filter((iss) => matchIssueToColumn(iss, board.columns) === columnId);
}

const {
  dragOptions: columnDragOptions,
  onColumnDragEnd,
  onColumnDragStart,
  onColumnDragMove,
} = useKanbanMouseDrag({
  getColumnIssues: (columnId) => board.issuesOf(columnId),
  onMove: (issue, fromColumnId, toColumnId) => {
    void performDragMove(issue, fromColumnId, toColumnId, activeProjectId.value);
  },
  // v1.4 修复：过滤非真实列目标（UnassignedSection 的 '__unassigned__' 哨兵），
  // 避免拖列到未分类 section 时误触 board.moveIssue('__unassigned__') 走 IPC 失败 → 静默回滚
  isValidTargetColumn: (id) => board.columns.some((c) => c.id === id),
});

/**
 * v1.4 拍板"未分类拖拽归类"：未分类列 → 普通列 的拖拽 end 回调
 * - 走 assignUnassignedIssue（不是 moveIssue）—— 未分类到普通列是"首次归类"，不是"换列"
 * - moveIssue 走 issues.moveColumn（要求 fromColumn 绑的 label = issue 当前真有的 label）
 *   未分类 issue 没有列绑 label，会校验失败
 * - 复用了"归到…"按钮的 assignUnassignedIssue 路径 + 弹 toast
 */
async function onUnassignedDragEnd(evt: unknown): Promise<void> {
  const e = evt as { to?: HTMLElement; item?: HTMLElement };
  const toColumnId = e.to?.dataset.columnId ?? '';
  const issueIndex = Number(e.item?.dataset.issueIndex ?? NaN);
  if (!toColumnId || toColumnId === '__unassigned__' || !Number.isFinite(issueIndex)) return;
  if (!activeProjectId.value) return;
  const issue = board.unassignedIssues.find((i) => i.index === issueIndex);
  if (!issue) return;
  try {
    await board.assignUnassignedIssue({
      projectId: activeProjectId.value,
      issueIndex,
      toColumnId,
    });
    showToast({ type: 'success', message: `议题 #${issueIndex} 已归到列` });
  } catch {
    /* error in board.error */
  }
}
</script>

<template>
  <div class="board">
    <BoardTopbar
      :can-undo="board.canUndo"
      :can-redo="board.canRedo"
      :undo-size="board.undoSize"
      :redo-size="board.redoSize"
      :gitea-source-url="giteaSourceUrl"
      :loading="board.loading"
      @undo="undoLastMove"
      @redo="redoLastMove"
      @reset-view="onResetViewRequest"
      @create-issue="openCreateIssueDialog"
    />

    <div v-if="!activeRepo" class="board__placeholder">
      <EmptyState
        title="还没有选中仓库"
        description="点状态栏（窗口底部）的仓库名，从下拉里选一个"
      />
    </div>
    <!--
      v1.4 拍板"替换模式"：删 v-else-if="board.loading && ..." 的"正在加载看板…"占位
      全局海豚 overlay 接管请求级 loading
    -->
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
      <!--
        v1.4 布局（2026-06-18 修订 · 消除横向滚动条）：
        普通列 flex-wrap 换行适配视口，列宽固定 280px（4 列/1280px 视口），
        第 5 列起自动换到下一行；`.board__columns` overflow-y:auto 仅纵向滚动。
        ClosedSection / UnassignedSection 作为独立块跟在列后，换行后排到下方
        （语义 = "已关闭"折到第一列下面），不再占横向列宽 → 不出横向滚动条。
      -->
      <KanbanColumnSection
        v-for="col in columnsWithClosed"
        :key="col.key"
        :column="col.column"
        :issues="board.issuesOf(col.column.id)"
        :closed-issues="closedIssuesOf(col.column.id)"
        :show-closed-in-column="board.showClosed && (showClosedByColumn[col.column.id] ?? false)"
        :show-closed-column="showClosedByColumn[col.column.id] ?? false"
        :loading="board.loading"
        :is-over-limit="isColumnOverLimit(col.column)"
        :over-limit-tooltip="wipOverLimitTooltip(col.column)"
        :drag-options="columnDragOptions"
        @open-settings="openColumnMenu(col.column)"
        @drag-start="(evt) => onColumnDragStart(col.column, evt)"
        @drag-move="(evt) => onColumnDragMove(col.column, evt)"
        @drag-end="(evt) => onColumnDragEnd(col.column, evt)"
        @open-move-menu="({ issue, fromColumnId }) => openMoveMenu(issue, fromColumnId)"
        @request-delete-issue="({ issue, columnId }) => requestDeleteIssue(issue, columnId)"
        @toggle-show-closed="(columnId) => toggleColumnShowClosed(columnId)"
      />
      <!--
        v1.4 布局修订（2026-06-18）：ClosedSection 排在普通列之后、UnassignedSection 之前。
        flex-wrap 换行后，已关闭区会优先填到第二行剩余位置（贴近已完成列），
        排不下了才折到下一行 —— 语义上"折到看板下方"，不再占横向列宽。
      -->
      <ClosedSection
        v-if="board.closedIssues.length"
        :issues="board.closedIssues"
        :loading="board.loading"
      />
      <UnassignedSection
        v-if="board.unassignedIssues.length"
        :issues="board.unassignedIssues"
        :loading="board.loading"
        :drag-options="columnDragOptions"
        @request-assign="openAssignMenu"
        @drag-end="onUnassignedDragEnd"
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
      :unmatched-count="unmatchedLabelCount"
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

    <!--
      v1.4 增量 · 拍板 2026-06-16 user 拍板「重建视图」按钮
      - ConfirmDialog 二次确认（AGENTS §9.2 危险操作）
      - 描述带列数（动态）："已清空 N 列后按 gitea label 重建"
      - confirm-keyword 强制输入「重建」（让用户主动敲字才能确认）
    -->
    <ConfirmDialog
      :open="resetDialogOpen"
      title="重建视图"
      :description="`会移除本地 ${board.columns.length} 个列,重建后按 gitea label 重新生成。继续?`"
      confirm-label="重建"
      cancel-label="取消"
      :danger="true"
      confirm-keyword="重建"
      @update:open="(v) => (resetDialogOpen = v)"
      @confirm="onConfirmResetView"
    />
    <!-- v1.4 调整（2026-06-18）：新建议题弹窗（Header 左侧按钮触发） -->
    <CreateIssueDialog
      :open="createIssueDialogOpen"
      :labels="board.labelsByProject"
      :members="createIssueMembers"
      :milestones="createIssueMilestones"
      :locked-column-title="lockedColumn?.title ?? '新建'"
      :loading="createIssueLoading"
      @update:open="(v) => (createIssueDialogOpen = v)"
      @create="onCreateIssue"
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
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-4);
  /* v1.4 布局修订（2026-06-18）：列换行适配视口，仅纵向滚动，不出横向滚动条。
     旧版 overflow-x:auto 横向滚动 → 列多时看板显示不全 + 横向滚动条。 */
  overflow-x: hidden;
  overflow-y: auto;
  align-items: flex-start;
  align-content: flex-start;
}
</style>
