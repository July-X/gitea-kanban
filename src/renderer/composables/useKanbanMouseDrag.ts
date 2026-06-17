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
 */
import type { ColumnDto, IssueCardDto } from '../../main/ipc/schema.js';
import { mapDragEndToMoveIntent } from '@renderer/lib/drag-helper';

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

  function onColumnDragEnd(_col: ColumnDto, evt: unknown): void {
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

  return { dragOptions, onColumnDragEnd };
}