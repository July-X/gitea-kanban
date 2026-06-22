/**
 * matchIssueToColumn —— 按 issue 持有的 label 找归属列（v1.4 抽到 lib）
 *
 * 语义：OR —— issue 拥有列绑的任意一个 label 即匹配该列
 * 优先：按列的 position 升序（store.columns 已是 position 序）
 *
 * 来源：plan_25cc4562 拍板（v1.2 P0-1 透明化）
 * v1.4 重构：原在 board.ts 私有，BoardView.closedIssuesOf 也要用 → 抽到 lib
 */
import type { ColumnDto, IssueCardDto } from '@renderer/types/dto';

export interface ColumnLabelRemovalImpact {
  columnId: string;
  columnTitle: string;
  labelNames: string[];
}

export function matchIssueToColumn(issue: IssueCardDto, cols: ColumnDto[]): string | null {
  const issueLabelIds = new Set(issue.labels.map((l) => l.id));
  for (const col of cols) {
    const colLabelIds = col.labels.map((l) => l.id);
    if (colLabelIds.length === 0) continue;
    // OR 语义：issue 拥有列绑的任意一个 label 即匹配
    if (colLabelIds.some((id) => issueLabelIds.has(id))) return col.id;
  }
  return null;
}

/**
 * 判断“删除标签”是否会动到当前归属列绑定的标签。
 * 用在详情弹窗二次确认：删掉列绑定标签后，卡片可能离开当前列或变成未分类。
 */
export function getColumnLabelRemovalImpact(
  issue: IssueCardDto,
  cols: ColumnDto[],
  removeLabelIds: number[],
): ColumnLabelRemovalImpact | null {
  if (removeLabelIds.length === 0) return null;
  const currentColumnId = matchIssueToColumn(issue, cols);
  if (!currentColumnId) return null;
  const currentColumn = cols.find((c) => c.id === currentColumnId);
  if (!currentColumn) return null;

  const removeSet = new Set(removeLabelIds);
  const removedColumnLabels = currentColumn.labels.filter((l) => removeSet.has(l.id));
  if (removedColumnLabels.length === 0) return null;

  return {
    columnId: currentColumn.id,
    columnTitle: currentColumn.title,
    labelNames: removedColumnLabels.map((l) => l.name),
  };
}
