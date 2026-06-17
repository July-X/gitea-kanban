/**
 * useKanbanMouseDrag 单元测试（v1.4 修复守护）
 *
 * 守护的不变量：
 * 1. 跨列移动 → onMove 被调用，参数正确
 * 2. 同列排序 → onMove **不**被调用（v1 不接后端）
 * 3. toColumnId 不是有效目标列（caller 传 isValidTargetColumn=false）→ onMove **不**被调用
 *    —— 这就是 v1.4 修的 bug：拖列到 UnassignedSection 的 '__unassigned__' 哨兵时，
 *    旧代码会调到 board.moveIssue('__unassigned__') 走 IPC 失败 → 静默回滚
 * 4. 不传 isValidTargetColumn → 不过滤（向后兼容老 caller）
 * 5. dataset 字段缺失 → onMove **不**被调用
 *
 * 不挂 Vue（AGENTS §7.2"frontend 任务 0 装新依赖"原则）：
 * composable 是纯函数 + 闭包，直接调用 onColumnDragEnd 即可。
 */
import { describe, it, expect, vi } from 'vitest';
import type { IssueCardDto } from '../../../main/ipc/schema.js';
import { useKanbanMouseDrag } from '../useKanbanMouseDrag';

/** 模拟 SortableJS @end 事件（只需要 from / to / item 的 dataset） */
function fakeEndEvt(fromColumnId: string, toColumnId: string, issueIndex: number | string): unknown {
  return {
    from: { dataset: { columnId: fromColumnId } } as unknown as HTMLElement,
    to: { dataset: { columnId: toColumnId } } as unknown as HTMLElement,
    item: { dataset: { issueIndex: String(issueIndex) } } as unknown as HTMLElement,
  };
}

const fakeIssue: IssueCardDto = {
  id: 1,
  index: 5,
  title: 'fake',
  state: 'open',
  labels: [],
  author: { username: 'u', fullName: '' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as IssueCardDto;

describe('useKanbanMouseDrag · onColumnDragEnd', () => {
  it('跨列移动 → 调 onMove，参数正确', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      isValidTargetColumn: () => true,
    });
    onColumnDragEnd({} as never, fakeEndEvt('colA', 'colB', 5));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(fakeIssue, 'colA', 'colB');
  });

  it('同列排序 → 不调 onMove（v1 不接后端）', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      isValidTargetColumn: () => true,
    });
    onColumnDragEnd({} as never, fakeEndEvt('colA', 'colA', 5));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('v1.4 修复：toColumnId 是非真实列（UnassignedSection 哨兵）→ 不调 onMove', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      // 模拟 BoardView 注入的真实列判断：'__unassigned__' 不在 board.columns 里
      isValidTargetColumn: (id) => id === 'colA' || id === 'colB',
    });
    onColumnDragEnd({} as never, fakeEndEvt('colA', '__unassigned__', 5));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('向后兼容：不传 isValidTargetColumn → 不拦截（行为同 v1.3）', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      // 不传 isValidTargetColumn
    });
    onColumnDragEnd({} as never, fakeEndEvt('colA', '__unassigned__', 5));
    // 不过滤，照常调 onMove（老 caller 自己负责）
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('from dataset.columnId 缺失 → 不调 onMove', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      isValidTargetColumn: () => true,
    });
    onColumnDragEnd(
      {} as never,
      fakeEndEvt('', 'colB', 5), // from 缺
    );
    expect(onMove).not.toHaveBeenCalled();
  });

  it('item dataset.issueIndex 非数字 → 不调 onMove', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      isValidTargetColumn: () => true,
    });
    onColumnDragEnd({} as never, fakeEndEvt('colA', 'colB', 'abc'));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('getColumnIssues 找不到 issue → 不调 onMove', () => {
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [], // 找不到
      onMove,
      isValidTargetColumn: () => true,
    });
    onColumnDragEnd({} as never, fakeEndEvt('colA', 'colB', 5));
    expect(onMove).not.toHaveBeenCalled();
  });
});
