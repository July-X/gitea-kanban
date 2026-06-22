/**
 * useBoardCardActions —— BoardView 卡片级操作（换列 / 归类 / 删除 / 标记完成）state + handlers
 *
 * 抽出动机：把 BoardView 内的"换列 / 归类 / 删除 / 标记完成"四组弹窗 + handler
 * 集中到一个 composable，避免 BoardView 自身过长。
 *
 * 业务不变：handler 调 board.* actions + showToast；与原 BoardView 实现 1:1。
 * 涵盖：
 * - moveMenu（点卡片"换列"按钮）        → pickTargetColumn → performMove / 触发 confirmFinish
 * - assignMenu（未分类卡"归到…"）       → pickAssignTarget → confirmAssign → performAssign
 * - confirmDelete（卡片关闭）            → performDelete
 * - confirmFinish（拖到已完成列二次确认） → performFinishMove
 */
import { computed, ref, type ComputedRef } from 'vue';
import { useBoardStore } from '@renderer/stores/board';
import { showToast } from '@renderer/lib/toast';
import { isFinishColumnByTitle } from '@renderer/lib/drag-helper';
import { issuesUpdate } from '@renderer/lib/ipc-client';
import type { IssueCardDto } from '@renderer/types/dto';

export interface UseBoardCardActionsReturn {
  // state
  moveMenu: ReturnType<
    typeof ref<{ open: boolean; issue: IssueCardDto | null; fromColumnId: string | null }>
  >;
  assignMenu: ReturnType<typeof ref<{ open: boolean; issue: IssueCardDto | null }>>;
  confirmAssign: ReturnType<
    typeof ref<{ open: boolean; issue: IssueCardDto | null; toColumnId: string | null }>
  >;
  confirmDelete: ReturnType<
    typeof ref<{ open: boolean; issue: IssueCardDto | null; columnId: string | null }>
  >;
  confirmFinish: ReturnType<
    typeof ref<{
      open: boolean;
      issue: IssueCardDto | null;
      fromColumnId: string | null;
      toColumnId: string | null;
    }>
  >;
  confirmAssignDescription: ComputedRef<string>;
  // handlers
  openMoveMenu: (issue: IssueCardDto, fromColumnId: string) => void;
  closeMoveMenu: () => void;
  pickTargetColumn: (toColumnId: string, activeProjectId: string | null) => Promise<void>;
  performMove: (
    issue: IssueCardDto,
    fromColumnId: string,
    toColumnId: string,
    activeProjectId: string | null,
  ) => Promise<void>;
  performDragMove: (
    issue: IssueCardDto,
    fromColumnId: string,
    toColumnId: string,
    activeProjectId: string | null,
  ) => Promise<void>;
  openAssignMenu: (issue: IssueCardDto) => void;
  closeAssignMenu: () => void;
  pickAssignTarget: (toColumnId: string) => void;
  performAssign: (activeProjectId: string | null) => Promise<void>;
  requestDeleteIssue: (issue: IssueCardDto, columnId: string) => void;
  performDelete: (activeProjectId: string | null) => Promise<void>;
  performFinishMove: (activeProjectId: string | null) => Promise<void>;
}

export function useBoardCardActions(): UseBoardCardActionsReturn {
  const board = useBoardStore();

  // ===== 换列 =====
  const moveMenu = ref<{
    open: boolean;
    issue: IssueCardDto | null;
    fromColumnId: string | null;
  }>({ open: false, issue: null, fromColumnId: null });
  function openMoveMenu(issue: IssueCardDto, fromColumnId: string): void {
    moveMenu.value = { open: true, issue, fromColumnId };
  }
  function closeMoveMenu(): void {
    moveMenu.value = { open: false, issue: null, fromColumnId: null };
  }
  async function performMove(
    issue: IssueCardDto,
    fromColumnId: string,
    toColumnId: string,
    activeProjectId: string | null,
  ): Promise<void> {
    if (!activeProjectId) return;
    try {
      await board.moveIssue({
        projectId: activeProjectId,
        issueIndex: issue.index,
        fromColumnId,
        toColumnId,
      });
    } catch {
      /* error in board.error */
    }
  }
  async function pickTargetColumn(
    toColumnId: string,
    activeProjectId: string | null,
  ): Promise<void> {
    const issue = moveMenu.value.issue;
    const fromColumnId = moveMenu.value.fromColumnId;
    if (!issue || !fromColumnId) return;
    closeMoveMenu();
    if (fromColumnId === toColumnId) return;
    const toCol = board.columns.find((c) => c.id === toColumnId);
    if (toCol && isFinishColumnByTitle(toCol.title)) {
      confirmFinish.value = { open: true, issue, fromColumnId, toColumnId };
      return;
    }
    await performMove(issue, fromColumnId, toColumnId, activeProjectId);
  }
  async function performDragMove(
    issue: IssueCardDto,
    fromColumnId: string,
    toColumnId: string,
    activeProjectId: string | null,
  ): Promise<void> {
    if (fromColumnId === toColumnId) return;
    const toCol = board.columns.find((c) => c.id === toColumnId);
    if (toCol && isFinishColumnByTitle(toCol.title)) {
      confirmFinish.value = { open: true, issue, fromColumnId, toColumnId };
      return;
    }
    await performMove(issue, fromColumnId, toColumnId, activeProjectId);
  }

  // ===== 归类（未分类） =====
  const assignMenu = ref<{ open: boolean; issue: IssueCardDto | null }>({
    open: false,
    issue: null,
  });
  const confirmAssign = ref<{
    open: boolean;
    issue: IssueCardDto | null;
    toColumnId: string | null;
  }>({ open: false, issue: null, toColumnId: null });
  function openAssignMenu(issue: IssueCardDto): void {
    assignMenu.value = { open: true, issue };
  }
  function closeAssignMenu(): void {
    assignMenu.value = { open: false, issue: null };
  }
  function pickAssignTarget(toColumnId: string): void {
    const issue = assignMenu.value.issue;
    closeAssignMenu();
    if (!issue) return;
    confirmAssign.value = { open: true, issue, toColumnId };
  }
  const confirmAssignDescription = computed<string>(() => {
    const { issue, toColumnId } = confirmAssign.value;
    if (!issue || !toColumnId) return '';
    const col = board.columns.find((c) => c.id === toColumnId);
    if (!col) return '';
    const firstLabel = col.labels[0]?.name ?? '?';
    return `将给议题 #${issue.index}「${issue.title}」加上列「${col.title}」绑的第一个标签（${firstLabel}）。确认后议题会自动从未分类移到该列。`;
  });
  async function performAssign(activeProjectId: string | null): Promise<void> {
    const { issue, toColumnId } = confirmAssign.value;
    if (!issue || !toColumnId) return;
    confirmAssign.value = { open: false, issue: null, toColumnId: null };
    try {
      await board.assignUnassignedIssue({
        projectId: activeProjectId!,
        issueIndex: issue.index,
        toColumnId,
      });
      showToast({ type: 'success', message: `议题 #${issue.index} 已归到列` });
    } catch {
      /* error in board.error */
    }
  }

  // ===== 删除议题 =====
  const confirmDelete = ref<{ open: boolean; issue: IssueCardDto | null; columnId: string | null }>(
    {
      open: false,
      issue: null,
      columnId: null,
    },
  );
  function requestDeleteIssue(issue: IssueCardDto, columnId: string): void {
    confirmDelete.value = { open: true, issue, columnId };
  }
  async function performDelete(activeProjectId: string | null): Promise<void> {
    const { issue, columnId } = confirmDelete.value;
    if (!issue || !columnId) return;
    try {
      await board.closeIssue({
        projectId: activeProjectId!,
        issueIndex: issue.index,
      });
      showToast({ type: 'success', message: `议题 #${issue.index} 已关闭` });
    } catch {
      /* error in board.error */
    }
    confirmDelete.value = { open: false, issue: null, columnId: null };
  }

  // ===== 完成态二次确认 =====
  const confirmFinish = ref<{
    open: boolean;
    issue: IssueCardDto | null;
    fromColumnId: string | null;
    toColumnId: string | null;
  }>({ open: false, issue: null, fromColumnId: null, toColumnId: null });
  async function performFinishMove(activeProjectId: string | null): Promise<void> {
    const { issue, fromColumnId, toColumnId } = confirmFinish.value;
    if (!issue || !fromColumnId || !toColumnId) return;
    confirmFinish.value = { open: false, issue: null, fromColumnId: null, toColumnId: null };
    try {
      await board.moveIssue({
        projectId: activeProjectId!,
        issueIndex: issue.index,
        fromColumnId,
        toColumnId,
      });
      await issuesUpdate({
        projectId: activeProjectId!,
        issueIndex: issue.index,
        patch: { state: 'closed' },
      });
      showToast({ type: 'success', message: `议题 #${issue.index} 已标记完成` });
    } catch {
      /* error in board.error */
    }
  }

  return {
    // state
    moveMenu,
    assignMenu,
    confirmAssign,
    confirmDelete,
    confirmFinish,
    confirmAssignDescription,
    // handlers
    openMoveMenu,
    closeMoveMenu,
    pickTargetColumn,
    performMove,
    performDragMove,
    openAssignMenu,
    closeAssignMenu,
    pickAssignTarget,
    performAssign,
    requestDeleteIssue,
    performDelete,
    performFinishMove,
  };
}
