/**
 * useColumnManager —— BoardView 列管理 state + IPC handlers（plan_25cc4562 Task D 重构）
 *
 * 抽出动机：原 BoardView.vue 单文件 700+ 行 script，列管理相关 state + handler 占约 200 行；
 * 拆成 composable 后 BoardView 只剩"调用 + 串接"。
 *
 * 业务不变（不引新功能 / 不改 IPC）：只是把 state ref + handler 集中到一个组合式函数。
 * 边界：与 store 交互全部走 board.* actions（不直接调 IPC）。
 *
 * 涵盖：
 * - showCreateColumn / newColumnTitle / creatingColumn + openCreateColumn/closeCreateColumn/confirmCreateColumn
 * - showColumnMenu / editingColumnTitle / editingColumnWipLimit + openColumnMenu/closeColumnMenu/confirmUpdateColumn
 * - confirmDeleteColumn + requestDeleteColumn/performDeleteColumn
 * - showBindLabel / bindingLabel + openBindLabelPicker/bindLabel/unbindLabel
 * - parseWipLimitInput / isWipLimitInputInvalid / isColumnOverLimit / wipOverLimitTooltip / isColumnMenuDirty
 *
 * 返回的 state 全是 ref，可由 BoardView 在模板里 v-bind；handler 是普通函数。
 */
import { ref } from 'vue';
import { useBoardStore } from '@renderer/stores/board';
import { showToast } from '@renderer/lib/toast';
import type { ColumnDto } from '../../main/ipc/schema.js';

export interface UseColumnManagerReturn {
  // state
  showCreateColumn: ReturnType<typeof ref<boolean>>;
  newColumnTitle: ReturnType<typeof ref<string>>;
  creatingColumn: ReturnType<typeof ref<boolean>>;
  showColumnMenu: ReturnType<typeof ref<{ open: boolean; column: ColumnDto | null }>>;
  editingColumnTitle: ReturnType<typeof ref<string>>;
  editingColumnWipLimit: ReturnType<typeof ref<string>>;
  confirmDeleteColumn: ReturnType<typeof ref<{ open: boolean; column: ColumnDto | null }>>;
  showBindLabel: ReturnType<typeof ref<boolean>>;
  bindingLabel: ReturnType<typeof ref<boolean>>;
  // handlers
  openCreateColumn: () => void;
  closeCreateColumn: () => void;
  confirmCreateColumn: (activeProjectId: string | null) => Promise<void>;
  openColumnMenu: (col: ColumnDto) => void;
  closeColumnMenu: () => void;
  confirmUpdateColumn: () => Promise<void>;
  requestDeleteColumn: () => void;
  performDeleteColumn: () => Promise<void>;
  openBindLabelPicker: () => void;
  bindLabel: (labelId: number, labelName: string) => Promise<void>;
  unbindLabel: (labelId: number) => Promise<void>;
  // helpers
  parseWipLimitInput: (raw: string) => { value: number | null } | { invalid: true };
  isWipLimitInputInvalid: () => boolean;
  isColumnOverLimit: (col: ColumnDto) => boolean;
  wipOverLimitTooltip: (col: ColumnDto) => string;
  isColumnMenuDirty: () => boolean;
}

export function useColumnManager(): UseColumnManagerReturn {
  const board = useBoardStore();

  // ===== 新增列 =====
  const showCreateColumn = ref(false);
  const newColumnTitle = ref('');
  const creatingColumn = ref(false);

  function openCreateColumn(): void {
    showCreateColumn.value = true;
    newColumnTitle.value = '';
  }
  function closeCreateColumn(): void {
    showCreateColumn.value = false;
    newColumnTitle.value = '';
  }
  async function confirmCreateColumn(activeProjectId: string | null): Promise<void> {
    const title = newColumnTitle.value.trim();
    if (!title || !activeProjectId) return;
    creatingColumn.value = true;
    try {
      await board.createColumn({ projectId: activeProjectId, title });
      showToast({ type: 'success', message: '已新增列 ' + title });
      closeCreateColumn();
    } catch {
      /* board.error */
    } finally {
      creatingColumn.value = false;
    }
  }

  // ===== 列设置 =====
  const showColumnMenu = ref<{ open: boolean; column: ColumnDto | null }>({
    open: false,
    column: null,
  });
  const editingColumnTitle = ref('');
  const editingColumnWipLimit = ref('');

  function openColumnMenu(col: ColumnDto): void {
    showColumnMenu.value = { open: true, column: col };
    editingColumnTitle.value = col.title;
    editingColumnWipLimit.value =
      col.wipLimit !== undefined && col.wipLimit !== null ? String(col.wipLimit) : '';
  }
  function closeColumnMenu(): void {
    showColumnMenu.value = { open: false, column: null };
    editingColumnTitle.value = '';
    editingColumnWipLimit.value = '';
  }

  function parseWipLimitInput(raw: string): { value: number | null } | { invalid: true } {
    const trimmed = raw.trim();
    if (trimmed === '') return { value: null };
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) return { invalid: true };
    return { value: n };
  }
  const isWipLimitInputInvalid = (): boolean =>
    'invalid' in parseWipLimitInput(editingColumnWipLimit.value);
  function isColumnOverLimit(col: ColumnDto): boolean {
    const limit = col.wipLimit;
    if (limit === undefined || limit === null || limit <= 0) return false;
    return board.issuesOf(col.id).length > limit;
  }
  function wipOverLimitTooltip(col: ColumnDto): string {
    const limit = col.wipLimit;
    if (limit === undefined || limit === null || limit <= 0) return '';
    const current = board.issuesOf(col.id).length;
    const overBy = current - limit;
    return `超出建议 ${overBy} 张（当前 ${current} / 上限 ${limit}）`;
  }
  const isColumnMenuDirty = (): boolean => {
    const col = showColumnMenu.value.column;
    if (!col) return false;
    const title = editingColumnTitle.value.trim();
    const titleChanged = title !== '' && title !== col.title;
    const wipChanged = (() => {
      const parsed = parseWipLimitInput(editingColumnWipLimit.value);
      if ('invalid' in parsed) return false;
      const current = col.wipLimit ?? null;
      return parsed.value !== current;
    })();
    return titleChanged || wipChanged;
  };
  async function confirmUpdateColumn(): Promise<void> {
    const col = showColumnMenu.value.column;
    if (!col) return;
    const title = editingColumnTitle.value.trim();
    const wipParsed = parseWipLimitInput(editingColumnWipLimit.value);
    if ('invalid' in wipParsed) {
      showToast({ type: 'error', message: 'WIP 上限必须是正整数或留空' });
      return;
    }
    const newWipLimit = wipParsed.value;
    const oldWipLimit = col.wipLimit ?? null;
    const titleChanged = title !== '' && title !== col.title;
    const wipChanged = newWipLimit !== oldWipLimit;
    if (!titleChanged && !wipChanged) {
      closeColumnMenu();
      return;
    }
    try {
      await board.updateColumn({
        columnId: col.id,
        ...(titleChanged ? { title } : {}),
        ...(wipChanged ? { wipLimit: newWipLimit } : {}),
      });
      if (titleChanged && wipChanged) {
        showToast({ type: 'success', message: '列名和 WIP 上限已更新' });
      } else if (titleChanged) {
        showToast({ type: 'success', message: '列已改名为 ' + title });
      } else {
        showToast({
          type: 'success',
          message: newWipLimit === null ? 'WIP 上限已设为无限' : 'WIP 上限已设为 ' + newWipLimit,
        });
      }
      closeColumnMenu();
    } catch {
      /* board.error */
    }
  }

  // ===== 删列 =====
  const confirmDeleteColumn = ref<{ open: boolean; column: ColumnDto | null }>({
    open: false,
    column: null,
  });
  function requestDeleteColumn(): void {
    const col = showColumnMenu.value.column;
    if (!col) return;
    closeColumnMenu();
    confirmDeleteColumn.value = { open: true, column: col };
  }
  async function performDeleteColumn(): Promise<void> {
    const col = confirmDeleteColumn.value.column;
    if (!col) return;
    confirmDeleteColumn.value = { open: false, column: null };
    try {
      await board.deleteColumn({ columnId: col.id });
      showToast({ type: 'success', message: '列已删除' });
    } catch {
      /* board.error */
    }
  }

  // ===== 绑 label =====
  const showBindLabel = ref(false);
  const bindingLabel = ref(false);
  function openBindLabelPicker(): void {
    showBindLabel.value = true;
  }
  async function bindLabel(labelId: number, labelName: string): Promise<void> {
    const col = showColumnMenu.value.column;
    if (!col) return;
    bindingLabel.value = true;
    try {
      await board.mapLabelToColumn({
        columnId: col.id,
        giteaLabelId: labelId,
        giteaLabelName: labelName,
      });
      showToast({ type: 'success', message: '已绑标签 ' + labelName + ' 到列' });
    } catch {
      /* board.error */
    } finally {
      bindingLabel.value = false;
    }
  }
  async function unbindLabel(labelId: number): Promise<void> {
    const col = showColumnMenu.value.column;
    if (!col) return;
    try {
      await board.unmapLabelFromColumn({ columnId: col.id, giteaLabelId: labelId });
      showToast({ type: 'success', message: '已解绑标签' });
    } catch {
      /* board.error */
    }
  }

  return {
    // state
    showCreateColumn,
    newColumnTitle,
    creatingColumn,
    showColumnMenu,
    editingColumnTitle,
    editingColumnWipLimit,
    confirmDeleteColumn,
    showBindLabel,
    bindingLabel,
    // handlers
    openCreateColumn,
    closeCreateColumn,
    confirmCreateColumn,
    openColumnMenu,
    closeColumnMenu,
    confirmUpdateColumn,
    requestDeleteColumn,
    performDeleteColumn,
    openBindLabelPicker,
    bindLabel,
    unbindLabel,
    // helpers
    parseWipLimitInput,
    isWipLimitInputInvalid,
    isColumnOverLimit,
    wipOverLimitTooltip,
    isColumnMenuDirty,
  };
}
