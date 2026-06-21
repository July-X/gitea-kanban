import { describe, it, expect } from 'vitest';
import { getColumnLabelRemovalImpact, matchIssueToColumn } from '../issue-column-match';
import type { ColumnDto, IssueCardDto } from '../../../main/ipc/schema.js';

function makeColumn(id: string, labelIds: number[]): ColumnDto {
  return {
    id,
    projectId: 'proj-1',
    title: `col-${id}`,
    position: 0,
    wipLimit: null,
    labels: labelIds.map((lId) => ({ id: lId, name: `l-${lId}`, color: '#000' })),
  };
}

function makeIssue(
  idx: number,
  labelIds: number[],
  state: 'open' | 'closed' = 'open',
): IssueCardDto {
  return {
    id: idx,
    index: idx,
    title: `issue ${idx}`,
    body: '',
    state,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    author: { username: 'u' },
    labels: labelIds.map((lId) => ({ id: lId, name: `l-${lId}`, color: '#000' })),
    isPullRequest: false,
    refBranch: '',
  };
}

describe('matchIssueToColumn', () => {
  it('issue 没有任何 label → null', () => {
    const cols = [makeColumn('c1', [1, 2])];
    const iss = makeIssue(1, []);
    expect(matchIssueToColumn(iss, cols)).toBeNull();
  });

  it('列绑的 label 与 issue 持有的 label 交集为空 → null', () => {
    const cols = [makeColumn('c1', [1, 2])];
    const iss = makeIssue(1, [3, 4]);
    expect(matchIssueToColumn(iss, cols)).toBeNull();
  });

  it('OR 语义：issue 持有列绑的任意一个 label → 匹配该列', () => {
    const cols = [makeColumn('c1', [1, 2])];
    const iss = makeIssue(1, [2, 99]);
    expect(matchIssueToColumn(iss, cols)).toBe('c1');
  });

  it('OR 语义：issue 持有多个列绑 label，按列 position 顺序匹配第一个', () => {
    const cols = [makeColumn('c1', [1]), makeColumn('c2', [2])];
    const iss = makeIssue(1, [1, 2]);
    expect(matchIssueToColumn(iss, cols)).toBe('c1');
  });

  it('列没绑 label → 跳过（不算匹配）', () => {
    const cols = [makeColumn('c1', []), makeColumn('c2', [5])];
    const iss = makeIssue(1, [5]);
    expect(matchIssueToColumn(iss, cols)).toBe('c2');
  });

  it('v1.4 拍板：closed issue 也能匹配（与 open 同语义）', () => {
    const cols = [makeColumn('c1', [10])];
    const iss = makeIssue(1, [10], 'closed');
    expect(matchIssueToColumn(iss, cols)).toBe('c1');
  });

  it('cols 为空数组 → null', () => {
    const iss = makeIssue(1, [1]);
    expect(matchIssueToColumn(iss, [])).toBeNull();
  });
});

describe('getColumnLabelRemovalImpact', () => {
  it('删除当前归属列绑定的标签 → 返回影响信息', () => {
    const cols = [makeColumn('c1', [1, 2]), makeColumn('c2', [3])];
    const iss = makeIssue(1, [2, 99]);

    expect(getColumnLabelRemovalImpact(iss, cols, [2])).toEqual({
      columnId: 'c1',
      columnTitle: 'col-c1',
      labelNames: ['l-2'],
    });
  });

  it('删除非当前列绑定标签 → 不需要提醒', () => {
    const cols = [makeColumn('c1', [1]), makeColumn('c2', [2])];
    const iss = makeIssue(1, [1, 99]);

    expect(getColumnLabelRemovalImpact(iss, cols, [99])).toBeNull();
  });

  it('未归属任何列的议题删除标签 → 不需要提醒', () => {
    const cols = [makeColumn('c1', [1])];
    const iss = makeIssue(1, [99]);

    expect(getColumnLabelRemovalImpact(iss, cols, [99])).toBeNull();
  });
});
