/**
 * useKanbanMouseDrag —— BoardView 鼠标拖拽（vue-draggable-plus）配置 + drag-end 转 move
 *
 * 抽出动机：原 BoardView.vue 内 columnDragOptions + onColumnDragEnd 共 23 行；
 * 抽成 composable 后 BoardView 模板直接 :drag-options / @drag-end 接住。
 *
 * 设计：
 * - dragOptions 走标准 vue-draggable-plus 配置（与原 BoardView 1:1）
 * - onColumnDragEnd 从 vue-draggable-plus onEnd 回调（{ from, to, item }）读
 *   dataset.columnId / dataset.issueIndex，转成 move intent，调 caller 注入的 onMove
 *
 * 不接 store：caller 注入 `getColumnIssues(columnId)` 和 `onMove(issue, from, to)`
 *
 * v1.4 修复（2026-06-17 · 拖拽光晕失效 bug）：
 * 旧版光晕靠 CSS `.column:has(.card--dragging)`，但配置 `forceFallback: false`（原生 HTML5 拖拽）
 * 下 SortableJS 的 `_dragStarted` 会**立即移除**被拖 card 上的 `.card--dragging`（改加 `.card--ghost`），
 * 导致拖拽全程没有任何元素带 `.card--dragging` → `:has()` 永不命中 → 光晕不亮。
 * 修法：不依赖 SortableJS 的 dragClass，改在 onStart / onMove / onEnd 里显式给列加/移
 * `.column--drag-source`（源列）/ `.column--drop-target`（当前目标列）class，CSS 改匹配这俩。
 * 模式无关（native + fallback 都 work），且可单测。
 */
import type { ColumnDto, IssueCardDto } from '../../main/ipc/schema.js';
import { mapDragEndToMoveIntent } from '@renderer/lib/drag-helper';

/** 拖拽光晕 class —— 加在 `<section class="column">` 上，CSS 联动发光 */
const DRAG_SOURCE_CLASS = 'column--drag-source';
const DROP_TARGET_CLASS = 'column--drop-target';

/**
 * 从任意 DOM 元素向上找最近的 `<section.column>`（看板列容器）。
 * SortableJS 的 evt.from / evt.to 是 `<ul class="column__cards">`，列容器是它的父 `<section>`。
 */
/**
 * 从任意 DOM 元素向上找最近的 `<section.column>`（看板列容器）。
 * SortableJS 的 evt.from / evt.to 是 `<ul class="column__cards">`，列容器是它的父 `<section>`。
 * DOM 安全：node 环境单测（无 document / 无 parentElement）下返 null。
 */
function findColumnSection(el: HTMLElement | null | undefined): HTMLElement | null {
  if (!el || typeof document === 'undefined') return null;
  // evt.from / evt.to 是 ul.column__cards；列容器是它.parentElement
  const parent = el.parentElement;
  if (parent && parent.classList.contains('column')) return parent;
  // 兜底：自身或祖先匹配 section.column
  const sec = el.closest('section.column');
  return sec instanceof HTMLElement ? sec : null;
}

/** 清掉所有列上的光晕 class（onEnd / 异常兜底用） */
function clearAllGlowClasses(): void {
  // DOM 安全：node 环境单测（无 document）下 no-op，避免 ReferenceError。
  // onColumnDragEnd 的 data 路径在 node 单测里仍可验证（不依赖 DOM）。
  if (typeof document === 'undefined') return;
  document
    .querySelectorAll<HTMLElement>(`.${DRAG_SOURCE_CLASS}, .${DROP_TARGET_CLASS}`)
    .forEach((el) => {
      el.classList.remove(DRAG_SOURCE_CLASS, DROP_TARGET_CLASS);
    });
}

export interface UseKanbanMouseDragOptions {
  /** 列内所有 issue getter（按 columnId 返回） */
  getColumnIssues: (columnId: string) => IssueCardDto[];
  /** 拖动完成回调（caller 调 board.moveIssue / 等价） */
  onMove: (
    issue: IssueCardDto,
    fromColumnId: string,
    toColumnId: string,
  ) => void | Promise<void>;
  /**
   * 可选：判断 columnId 是不是有效目标列。
   * 不传 = 不过滤（保留旧行为）。
   *
   * 用途：过滤非真实列 id（如 UnassignedSection 的 `'__unassigned__'` 哨兵），
   * 避免这些"非列 DOM"被当成目标列触发 `board.moveIssue(toColumnId: '__unassigned__')`，
   * 走到 main 端 `findColumnByIdWithStore` 找不到列 → 抛 NOT_FOUND → 乐观更新回滚
   * → 用户感知"我松手了但 data 没更新"（v1.4 修复）。
   *
   * 设计：composable 不依赖 store（caller 注入），所以判断逻辑也走 caller 注入。
   *   BoardView 用法：`isValidTargetColumn: (id) => board.columns.some(c => c.id === id)`
   */
  isValidTargetColumn?: (columnId: string) => boolean;
}

export interface UseKanbanMouseDragReturn {
  /** 给 <KanbanColumnSection :drag-options> 用的 vue-draggable-plus 配置 */
  dragOptions: Record<string, unknown>;
  /** 给 <KanbanColumnSection @drag-end="(evt) => onColumnDragEnd(col, evt)"> 用的 handler */
  onColumnDragEnd: (col: ColumnDto, evt: unknown) => void;
  /** 给 <KanbanColumnSection @drag-start> 用的 handler —— 给源列加光晕 class */
  onColumnDragStart: (col: ColumnDto, evt: unknown) => void;
  /** 给 <KanbanColumnSection @drag-move> 用的 handler —— 给当前目标列加光晕 class */
  onColumnDragMove: (col: ColumnDto, evt: unknown) => void;
  /** 给 <KanbanColumnSection @drag-end> 用的 handler —— 清所有光晕 class（与 onColumnDragEnd 同链路，data 走 onColumnDragEnd） */
  clearGlow: () => void;
}

export function useKanbanMouseDrag(
  options: UseKanbanMouseDragOptions,
): UseKanbanMouseDragReturn {
  const dragOptions: Record<string, unknown> = {
    group: 'kanban-cards',
    animation: 150,
    ghostClass: 'card--ghost',
    chosenClass: 'card--chosen',
    dragClass: 'card--dragging',
    forceFallback: false,
    fallbackOnBody: true,
  };

  /** v1.4 修复：拖拽光晕显式管 class（绕开原生模式 dragClass 被立即移除的陷阱） */
  function onColumnDragStart(_col: ColumnDto, evt: unknown): void {
    const e = evt as { from?: HTMLElement };
    const sec = findColumnSection(e.from);
    sec?.classList.add(DRAG_SOURCE_CLASS);
  }

  function onColumnDragMove(_col: ColumnDto, evt: unknown): void {
    if (typeof document === 'undefined') return;
    const e = evt as { to?: HTMLElement };
    const targetSec = findColumnSection(e.to);
    if (!targetSec) return;
    // 清掉其他列的 drop-target，只保留当前目标
    document
      .querySelectorAll<HTMLElement>(`.${DROP_TARGET_CLASS}`)
      .forEach((el) => {
        if (el !== targetSec) el.classList.remove(DROP_TARGET_CLASS);
      });
    targetSec.classList.add(DROP_TARGET_CLASS);
  }

  function clearGlow(): void {
    clearAllGlowClasses();
  }

  function onColumnDragEnd(_col: ColumnDto, evt: unknown): void {
    // 先清光晕（无论 data 走哪条分支，光晕都得清）
    clearGlow();
    const e = evt as { from?: HTMLElement; to?: HTMLElement; item?: HTMLElement };
    const fromColumnId = e.from?.dataset.columnId ?? '';
    const toColumnId = e.to?.dataset.columnId ?? '';
    const issueIndex = Number(e.item?.dataset.issueIndex ?? NaN);
    if (!fromColumnId || !toColumnId || !Number.isFinite(issueIndex)) return;
    // v1.4 修复：过滤非真实列目标（如 UnassignedSection 的 '__unassigned__'）。
    // 不传 isValidTargetColumn = 不过滤，保留旧行为（向后兼容）。
    if (options.isValidTargetColumn && !options.isValidTargetColumn(toColumnId)) return;
    const intent = mapDragEndToMoveIntent({ fromColumnId, toColumnId, issueIndex });
    if (!intent) return;
    const issue = options
      .getColumnIssues(intent.fromColumnId)
      .find((i) => i.index === intent.issueIndex);
    if (!issue) return;
    void options.onMove(issue, intent.fromColumnId, intent.toColumnId);
  }

  return {
    dragOptions,
    onColumnDragEnd,
    onColumnDragStart,
    onColumnDragMove,
    clearGlow,
  };
}