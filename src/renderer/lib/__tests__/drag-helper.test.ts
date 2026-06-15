/**
 * drag-helper 单元测试（Task A · kanban-drag-replace · v1.3.1 撤回键盘双模后）
 *
 * 测试目标：
 * - mapDragEndToMoveIntent：
 *   * 同列 → null
 *   * 跨列 → DragMoveIntent
 * - isFinishColumnByTitle：中文 / 英文 / 子串
 * - columnDragOptions：返回 Sortable config（group / ghost class / scroll sensitivity）
 * - extractDragEndFromEvent：从 SortableEvent 抽出三元组；dataset 缺失返 null
 *
 * 历史：v1.3 引入过 keyDownToColumn + makeIdleKeyboardDrag + KeyboardDragState 测试；
 * v1.3.1 撤回键盘双模后这两个 describe 整体删除。
 *
 * 环境：node（composable 是纯函数，**不**挂 Vue 组件）
 */
import { describe, it, expect } from 'vitest';
import {
  mapDragEndToMoveIntent,
  isFinishColumnByTitle,
  columnDragOptions,
  extractDragEndFromEvent,
} from '@renderer/lib/drag-helper';

describe('drag-helper · mapDragEndToMoveIntent', () => {
  it('同列排序 → null（v1 不接后端）', () => {
    expect(
      mapDragEndToMoveIntent({ fromColumnId: 'c1', toColumnId: 'c1', issueIndex: 5 }),
    ).toBeNull();
  });

  it('跨列 → 返回 DragMoveIntent', () => {
    expect(
      mapDragEndToMoveIntent({ fromColumnId: 'c1', toColumnId: 'c2', issueIndex: 5 }),
    ).toEqual({ issueIndex: 5, fromColumnId: 'c1', toColumnId: 'c2' });
  });

  it('issueIndex 透传（不被改动）', () => {
    expect(
      mapDragEndToMoveIntent({ fromColumnId: 'a', toColumnId: 'b', issueIndex: 42 }),
    ).toMatchObject({ issueIndex: 42 });
  });
});

describe('drag-helper · isFinishColumnByTitle', () => {
  it('"已完成" → true', () => {
    expect(isFinishColumnByTitle('已完成')).toBe(true);
  });

  it('"已完成 "（带空格）→ true（trim 生效）', () => {
    expect(isFinishColumnByTitle('  已完成  ')).toBe(true);
  });

  it('"done" / "Done" / "DONE" → true（toLowerCase）', () => {
    expect(isFinishColumnByTitle('done')).toBe(true);
    expect(isFinishColumnByTitle('Done')).toBe(true);
    expect(isFinishColumnByTitle('DONE')).toBe(true);
  });

  it('"closed" → true', () => {
    expect(isFinishColumnByTitle('closed')).toBe(true);
  });

  it('"未完成"（含"完成"）→ true（includes 命中）', () => {
    expect(isFinishColumnByTitle('未完成')).toBe(true);
  });

  it('"进行中" → false', () => {
    expect(isFinishColumnByTitle('进行中')).toBe(false);
  });

  it('"待办" → false', () => {
    expect(isFinishColumnByTitle('待办')).toBe(false);
  });

  it('"To Do" → false', () => {
    expect(isFinishColumnByTitle('To Do')).toBe(false);
  });
});

describe('drag-helper · columnDragOptions', () => {
  const col = { id: 'c1', projectId: 'p1', title: 'To Do', position: 0, labels: [] };
  it('group = kanban-cards（跨列拖动必须同 group）', () => {
    expect(columnDragOptions(col).group).toBe('kanban-cards');
  });
  it('3 个 class hook 跟 board-drag.css 联动', () => {
    const opts = columnDragOptions(col);
    expect(opts.ghostClass).toBe('card--ghost');
    expect(opts.chosenClass).toBe('card--chosen');
    expect(opts.dragClass).toBe('card--dragging');
  });
  it('animation = 150ms（平滑过渡）', () => {
    expect(columnDragOptions(col).animation).toBe(150);
  });
  it('scrollSensitivity = 20（列边缘自动滚动灵敏度）', () => {
    expect(columnDragOptions(col).scrollSensitivity).toBe(20);
  });
  it('forceFallback = false + fallbackOnBody = true（桌面 v1.3 不强 pointer 模拟）', () => {
    const opts = columnDragOptions(col);
    expect(opts.forceFallback).toBe(false);
    expect(opts.fallbackOnBody).toBe(true);
  });
});

describe('drag-helper · extractDragEndFromEvent', () => {
  it('完整 dataset → 返三元组', () => {
    // jsdom/happy-dom 没装：用对象模拟（HTMLElement dataset 防御访问）
    const fakeEvt = {
      from: { dataset: { columnId: 'c1' } } as unknown as HTMLElement,
      to: { dataset: { columnId: 'c2' } } as unknown as HTMLElement,
      item: { dataset: { issueIndex: 5 } } as unknown as HTMLElement,
    };
    expect(extractDragEndFromEvent(fakeEvt)).toEqual({
      fromColumnId: 'c1',
      toColumnId: 'c2',
      issueIndex: 5,
    });
  });
  it('from 缺 columnId → null', () => {
    expect(
      extractDragEndFromEvent({
        from: { dataset: {} } as unknown as HTMLElement,
        to: { dataset: { columnId: 'c2' } } as unknown as HTMLElement,
        item: { dataset: { issueIndex: 5 } } as unknown as HTMLElement,
      }),
    ).toBeNull();
  });
  it('to 缺 columnId → null', () => {
    expect(
      extractDragEndFromEvent({
        from: { dataset: { columnId: 'c1' } } as unknown as HTMLElement,
        to: { dataset: {} } as unknown as HTMLElement,
        item: { dataset: { issueIndex: 5 } } as unknown as HTMLElement,
      }),
    ).toBeNull();
  });
  it('item 缺 issueIndex → null', () => {
    expect(
      extractDragEndFromEvent({
        from: { dataset: { columnId: 'c1' } } as unknown as HTMLElement,
        to: { dataset: { columnId: 'c2' } } as unknown as HTMLElement,
        item: { dataset: {} } as unknown as HTMLElement,
      }),
    ).toBeNull();
  });
  it('issueIndex 非数字 → null（防御）', () => {
    expect(
      extractDragEndFromEvent({
        from: { dataset: { columnId: 'c1' } } as unknown as HTMLElement,
        to: { dataset: { columnId: 'c2' } } as unknown as HTMLElement,
        item: { dataset: { issueIndex: 'abc' } } as unknown as HTMLElement,
      }),
    ).toBeNull();
  });
  it('evt 整体缺 from/to/item → null（防御 Sortable 事件结构变更）', () => {
    expect(extractDragEndFromEvent({})).toBeNull();
    expect(extractDragEndFromEvent(null)).toBeNull();
    expect(extractDragEndFromEvent(undefined)).toBeNull();
    expect(extractDragEndFromEvent('not an object')).toBeNull();
  });
});
