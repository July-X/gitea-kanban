// @vitest-environment happy-dom
/**
 * useKanbanMouseDrag · 拖拽光晕显式 class 管理回归测试（v1.4 修复守护）
 *
 * 守护的不变量（2026-06-17 修复的 bug）：
 * 1. onColumnDragStart → 给源列 section 加 .column--drag-source
 * 2. onColumnDragMove → 给目标列 section 加 .column--drop-target，且清掉其他列的 drop-target
 * 3. onColumnDragEnd → 清所有光晕 class（无论 data 走哪条分支）
 * 4. 跨列移动：光晕清完 + onMove 被调（data 路径不破）
 *
 * 背景：旧版光晕靠 CSS `.column:has(.card--dragging)`，但原生 HTML5 拖拽模式下
 * SortableJS 会立即把 .card--dragging 从被拖 card 上移除，导致 :has() 永不命中。
 * 修法改 onStart/onMove/onEnd 显式管 class，这里守护它。
 *
 * 用 happy-dom：composable 的光晕逻辑直接操作 document，需要 DOM 环境。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueCardDto } from '../../../main/ipc/schema.js';
import { useKanbanMouseDrag } from '../useKanbanMouseDrag';

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

/**
 * 造一个看板列 DOM：`<section class="column"><ul class="column__cards" data-column-id>`
 * SortableJS 的 evt.from / evt.to 是 ul.column__cards；列容器是 section.column。
 */
function setupBoardDOM(): { colA: HTMLElement; colB: HTMLElement; ulA: HTMLElement; ulB: HTMLElement } {
  document.body.innerHTML = '';
  const colA = document.createElement('section');
  colA.className = 'column';
  const ulA = document.createElement('ul');
  ulA.className = 'column__cards';
  ulA.dataset.columnId = 'colA';
  colA.appendChild(ulA);

  const colB = document.createElement('section');
  colB.className = 'column';
  const ulB = document.createElement('ul');
  ulB.className = 'column__cards';
  ulB.dataset.columnId = 'colB';
  colB.appendChild(ulB);

  document.body.append(colA, colB);
  return { colA, colB, ulA, ulB };
}

/** 造 SortableJS onStart 事件（evt.from = ul.column__cards） */
function fakeStartEvt(ul: HTMLElement): unknown {
  return { from: ul } as unknown;
}
/** 造 SortableJS onMove 事件（evt.to = 目标列 ul.column__cards） */
function fakeMoveEvt(ul: HTMLElement): unknown {
  return { to: ul } as unknown;
}
/** 造 SortableJS @end 事件 */
function fakeEndEvt(fromUl: HTMLElement, toUl: HTMLElement, issueIndex: number): unknown {
  return {
    from: fromUl,
    to: toUl,
    item: { dataset: { issueIndex: String(issueIndex) } } as unknown as HTMLElement,
  } as unknown;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('useKanbanMouseDrag · 拖拽光晕显式 class 管理（v1.4 修复）', () => {
  it('onColumnDragStart → 给源列 section 加 .column--drag-source', () => {
    const { ulA, colA } = setupBoardDOM();
    const { onColumnDragStart } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove: vi.fn(),
    });
    expect(colA.classList.contains('column--drag-source')).toBe(false);
    onColumnDragStart({ id: 'colA' } as never, fakeStartEvt(ulA));
    expect(colA.classList.contains('column--drag-source')).toBe(true);
  });

  it('onColumnDragMove → 给目标列加 .column--drop-target，且清掉其他列的 drop-target', () => {
    const { ulA, ulB, colA, colB } = setupBoardDOM();
    const { onColumnDragMove } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove: vi.fn(),
    });
    // 先模拟拖到 colA（drop-target 在 colA）
    onColumnDragMove({ id: 'colA' } as never, fakeMoveEvt(ulA));
    expect(colA.classList.contains('column--drop-target')).toBe(true);
    expect(colB.classList.contains('column--drop-target')).toBe(false);

    // 再拖到 colB（drop-target 切到 colB，colA 的清掉）
    onColumnDragMove({ id: 'colB' } as never, fakeMoveEvt(ulB));
    expect(colB.classList.contains('column--drop-target')).toBe(true);
    expect(colA.classList.contains('column--drop-target')).toBe(false);
  });

  it('onColumnDragEnd → 清所有光晕 class（含 drag-source + drop-target）', () => {
    const { ulA, ulB, colA, colB } = setupBoardDOM();
    const { onColumnDragStart, onColumnDragMove, onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove: vi.fn(),
      isValidTargetColumn: () => true,
    });
    // 模拟完整拖拽：start on colA → move to colB → end
    onColumnDragStart({ id: 'colA' } as never, fakeStartEvt(ulA));
    onColumnDragMove({ id: 'colB' } as never, fakeMoveEvt(ulB));
    expect(colA.classList.contains('column--drag-source')).toBe(true);
    expect(colB.classList.contains('column--drop-target')).toBe(true);

    onColumnDragEnd({ id: 'colA' } as never, fakeEndEvt(ulA, ulB, 5));
    expect(colA.classList.contains('column--drag-source')).toBe(false);
    expect(colB.classList.contains('column--drop-target')).toBe(false);
  });

  it('跨列移动：光晕清完 + onMove 被调（data 路径不破）', () => {
    const { ulA, ulB, colA, colB } = setupBoardDOM();
    const onMove = vi.fn();
    const { onColumnDragEnd } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove,
      isValidTargetColumn: () => true,
    });
    // 先手动加光晕 class（模拟 onStart/onMove 已跑过）
    colA.classList.add('column--drag-source');
    colB.classList.add('column--drop-target');

    onColumnDragEnd({ id: 'colA' } as never, fakeEndEvt(ulA, ulB, 5));
    // 光晕清完
    expect(colA.classList.contains('column--drag-source')).toBe(false);
    expect(colB.classList.contains('column--drop-target')).toBe(false);
    // data 路径：onMove 被调，参数正确
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(fakeIssue, 'colA', 'colB');
  });

  it('onColumnDragMove 在无 DOM（evt.to 缺失）时不抛', () => {
    const { onColumnDragMove } = useKanbanMouseDrag({
      getColumnIssues: () => [fakeIssue],
      onMove: vi.fn(),
    });
    // evt.to 为 undefined → findColumnSection 返 null → 静默 no-op
    expect(() => onColumnDragMove({ id: 'colA' } as never, { to: undefined })).not.toThrow();
  });
});
