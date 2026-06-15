/**
 * drag-helper 单元测试（Task A · kanban-drag-replace）
 *
 * 测试目标：
 * - mapDragEndToMoveIntent：
 *   * 同列 → null
 *   * 跨列 → DragMoveIntent
 * - keyDownToColumn：
 *   * ArrowRight / ArrowLeft 循环
 *   * ArrowUp / ArrowDown 等同 Left / Right
 *   * Home / End 跳首尾
 *   * 不在 columns 里的 currentColumnId 走 fallback（第 0 列）
 *   * 空 columns → null
 *   * 未知键 → null
 * - isFinishColumnByTitle：中文 / 英文 / 子串
 * - makeIdleKeyboardDrag：返回 idle
 * - columnDragOptions：返回 Sortable config（group / ghost class / scroll sensitivity）
 * - extractDragEndFromEvent：从 SortableEvent 抽出三元组；dataset 缺失返 null
 *
 * 环境：node（composable 是纯函数，**不**挂 Vue 组件）
 */
import { describe, it, expect } from 'vitest';
import {
  mapDragEndToMoveIntent,
  keyDownToColumn,
  isFinishColumnByTitle,
  makeIdleKeyboardDrag,
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

describe('drag-helper · keyDownToColumn', () => {
  const cols = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];

  it('ArrowRight：从 c1 到 c2', () => {
    expect(keyDownToColumn(cols, 'c1', 'ArrowRight')).toBe('c2');
  });

  it('ArrowRight：末尾循环到第 0 列', () => {
    expect(keyDownToColumn(cols, 'c3', 'ArrowRight')).toBe('c1');
  });

  it('ArrowLeft：从 c2 到 c1', () => {
    expect(keyDownToColumn(cols, 'c2', 'ArrowLeft')).toBe('c1');
  });

  it('ArrowLeft：第 0 列循环到末尾', () => {
    expect(keyDownToColumn(cols, 'c1', 'ArrowLeft')).toBe('c3');
  });

  it('ArrowUp 等同 ArrowLeft', () => {
    expect(keyDownToColumn(cols, 'c2', 'ArrowUp')).toBe('c1');
  });

  it('ArrowDown 等同 ArrowRight', () => {
    expect(keyDownToColumn(cols, 'c2', 'ArrowDown')).toBe('c3');
  });

  it('Home → 第 0 列', () => {
    expect(keyDownToColumn(cols, 'c2', 'Home')).toBe('c1');
  });

  it('End → 末尾列', () => {
    expect(keyDownToColumn(cols, 'c2', 'End')).toBe('c3');
  });

  it('空 columns → null（任意键）', () => {
    expect(keyDownToColumn([], 'c1', 'ArrowRight')).toBeNull();
  });

  it('未知键 → null', () => {
    expect(keyDownToColumn(cols, 'c1', 'Enter')).toBeNull();
    expect(keyDownToColumn(cols, 'c1', 'Tab')).toBeNull();
    expect(keyDownToColumn(cols, 'c1', 'a')).toBeNull();
  });

  it('currentColumnId 不在列里 → fallback 到第 0 列（防御列刚被删除）', () => {
    // currentColumnId 是 "deleted"，从"第 0 列位置"按 ArrowRight 应到 c2
    expect(keyDownToColumn(cols, 'deleted', 'ArrowRight')).toBe('c2');
    expect(keyDownToColumn(cols, 'deleted', 'Home')).toBe('c1');
  });

  it('currentColumnId 不在列里 + ArrowLeft → 末尾（循环从 0 出发）', () => {
    expect(keyDownToColumn(cols, 'deleted', 'ArrowLeft')).toBe('c3');
  });

  it('单列时 ArrowLeft / ArrowRight 都回到自己', () => {
    const single = [{ id: 'only' }];
    expect(keyDownToColumn(single, 'only', 'ArrowRight')).toBe('only');
    expect(keyDownToColumn(single, 'only', 'ArrowLeft')).toBe('only');
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

describe('drag-helper · makeIdleKeyboardDrag', () => {
  it('返回 idle state', () => {
    expect(makeIdleKeyboardDrag()).toEqual({ kind: 'idle' });
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
