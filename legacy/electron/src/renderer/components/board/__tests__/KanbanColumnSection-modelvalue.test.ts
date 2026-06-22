// @vitest-environment happy-dom
/**
 * KanbanColumnSection · VueDraggable modelValue 透传回归测试
 *
 * 守护的不变量（2026-06-17 修复的 bug）：
 * KanbanColumnSection 的 <VueDraggable> 必须传 :model-value（真实数组），
 * 否则 vue-draggable-plus 0.6.1 的 useDraggable 参数解析 bug 会让
 * group/animation/onStart/onMove/onEnd 等 options 全部丢失 → SortableJS 用默认
 * options 创建 → 拖拽光晕失效 + 释放不记录（moveIssue 不调）。
 *
 * 根因见 useKanbanMouseDrag.ts 文件头注释 + KanbanColumnSection.vue 模板注释。
 *
 * 本测试 mount KanbanColumnSection，直接检查 ul 上的 SortableJS 实例 options：
 *   - group.name === 'kanban-cards'（不是默认的 null）
 *   - animation === 150
 *   - ghostClass === 'card--ghost'
 *   - onStart / onMove / onEnd 都是 function
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import KanbanColumnSection from '../KanbanColumnSection.vue';
import type { ColumnDto, IssueCardDto } from '../../../../main/ipc/schema.js';

const col: ColumnDto = {
  id: 'colA',
  projectId: 'p1',
  title: '待办',
  position: 0,
  wipLimit: null,
  labels: [{ id: 100, name: 'todo', color: '#74B830' }],
} as unknown as ColumnDto;

const issue: IssueCardDto = {
  id: 1,
  index: 5,
  title: '测试卡片',
  state: 'open',
  labels: [{ id: 100, name: 'todo', color: '#74B830' }],
  author: { username: 'u', fullName: 'U' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as IssueCardDto;

const dragOptions = {
  group: 'kanban-cards',
  animation: 150,
  ghostClass: 'card--ghost',
  chosenClass: 'card--chosen',
  dragClass: 'card--dragging',
  forceFallback: false,
  fallbackOnBody: true,
};

/** 从 ul 元素上拿 SortableJS 实例（vue-draggable-plus 0.6.x 挂在 "Sortable" + timestamp 字符串 key 上） */
function getSortableInstance(ul: HTMLElement): { options: Record<string, unknown> } | null {
  for (const k of Object.getOwnPropertyNames(ul)) {
    if (k.startsWith('Sortable')) {
      const v = (ul as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'options' in (v as object)) {
        return v as { options: Record<string, unknown> };
      }
    }
  }
  return null;
}

describe('KanbanColumnSection · VueDraggable modelValue 透传回归（v1.4 修复守护）', () => {
  it('VueDraggable 收到 :model-value，SortableJS options 含 group/animation/onStart/onMove/onEnd', async () => {
    const wrapper = mount(KanbanColumnSection, {
      props: {
        column: col,
        issues: [issue],
        closedIssues: [],
        showClosedInColumn: false,
        showClosedColumn: false,
        newIssueDraft: '',
        loading: false,
        isOverLimit: false,
        overLimitTooltip: '',
        dragOptions,
      },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();
    // 等 vue-draggable-plus 的 watchEffect 创建 SortableJS 实例
    await new Promise((r) => setTimeout(r, 100));

    const ul = document.querySelector('ul.column__cards');
    expect(ul, 'ul.column__cards 应渲染').toBeTruthy();

    const inst = getSortableInstance(ul as HTMLElement);
    expect(inst, 'SortableJS 实例应挂在 ul 上').toBeTruthy();

    const opts = inst!.options;
    // group 应该是 'kanban-cards' 或 {name: 'kanban-cards'}，不应该是默认的 {name: null}
    const groupName =
      typeof opts.group === 'string' ? opts.group : (opts.group as { name?: string } | null)?.name;
    expect(groupName, 'group.name 应为 kanban-cards（不是默认 null）').toBe('kanban-cards');

    expect(opts.animation, 'animation 应为 150（不是默认 0）').toBe(150);
    expect(opts.ghostClass, 'ghostClass 应为 card--ghost（不是默认 sortable-ghost）').toBe(
      'card--ghost',
    );
    expect(opts.chosenClass, 'chosenClass 应为 card--chosen').toBe('card--chosen');
    expect(opts.dragClass, 'dragClass 应为 card--dragging').toBe('card--dragging');

    // 关键：onStart/onMove/onEnd 必须是 function（vue-draggable-plus 的 emit wrapper）
    // bug 现象：不传 modelValue 时这三个是 undefined → emit 不触发 → 光晕不亮 + moveIssue 不调
    expect(typeof opts.onStart, 'onStart 必须是 function').toBe('function');
    expect(typeof opts.onMove, 'onMove 必须是 function').toBe('function');
    expect(typeof opts.onEnd, 'onEnd 必须是 function').toBe('function');

    wrapper.unmount();
  });

  it('空列（0 卡片）也渲染 VueDraggable 且 options 正确（v1.4 空列可拖放守护）', async () => {
    const wrapper = mount(KanbanColumnSection, {
      props: {
        column: col,
        issues: [], // 空列
        closedIssues: [],
        showClosedInColumn: false,
        showClosedColumn: false,
        newIssueDraft: '',
        loading: false,
        isOverLimit: false,
        overLimitTooltip: '',
        dragOptions,
      },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 100));

    const ul = document.querySelector('ul.column__cards');
    expect(ul, '空列也应渲染 ul.column__cards（drop zone）').toBeTruthy();

    const inst = getSortableInstance(ul as HTMLElement);
    expect(inst, '空列也应有 SortableJS 实例').toBeTruthy();
    const opts = inst!.options;
    const groupName =
      typeof opts.group === 'string' ? opts.group : (opts.group as { name?: string } | null)?.name;
    expect(groupName).toBe('kanban-cards');
    expect(typeof opts.onStart).toBe('function');
    expect(typeof opts.onEnd).toBe('function');

    // 空列占位 li 应存在
    const placeholder = ul?.querySelector('.column__empty-placeholder');
    expect(placeholder, '空列应渲染占位 li').toBeTruthy();

    wrapper.unmount();
  });
});
