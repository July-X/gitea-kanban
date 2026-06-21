/**
 * board store · loadBoard / moveIssue 核心业务单测
 *
 * 覆盖（v1.4 polish 测试债清理 · P3-2）：
 * - loadBoard 成功：columns + issues 归类（OR 语义 + 未归类进 unassignedIssues）
 * - loadBoard 失败：IPC 抛错 → 错误传出去 + store.error 落地
 * - moveIssue 成功：乐观更新 + 调 IPC + loadUndoStatus
 * - moveIssue 失败：IPC 抛错 → 状态回滚 + 错误抛
 * - moveIssue no-op（fromColumn === toColumn）：不调 IPC
 * - moveIssue 找不到 issue：抛 not_found 错误（**不**调 IPC）
 *
 * Mock 策略（参考 board-autoinit.test.ts 模板）：
 * - vi.mock('@renderer/lib/ipc-client') mock 整个 IPC wrapper
 * - vi.hoisted 共享 mock 句柄
 * - localStorage stub 提前 hoist 避开 pinia 顶层调 localStorage.getItem
 *
 * 不依赖真实 gitea / electron / better-sqlite3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===== localStorage stub（必须在 pinia 导入前生效）=====
vi.hoisted(() => {
  const stub = {
    getItem: (_k: string): string | null => null,
    setItem: (_k: string, _v: string): void => {},
    removeItem: (_k: string): void => {},
    clear: (): void => {},
    key: (_i: number): string | null => null,
    get length(): number {
      return 0;
    },
  };
  (globalThis as unknown as { localStorage: typeof stub }).localStorage = stub;
});

// ===== vi.mock 必须放在 import 业务模块之前 =====
const mocks = vi.hoisted(() => ({
  boardColumnsList: vi.fn(),
  labelsList: vi.fn(),
  issuesList: vi.fn(),
  issuesMoveColumn: vi.fn(),
  issuesAddLabel: vi.fn(),
  issuesRemoveLabel: vi.fn(),
  loadUndoStatus: vi.fn(),
  getIpcClient: vi.fn(),
}));

vi.mock('@renderer/lib/ipc-client', () => ({
  boardColumnsList: mocks.boardColumnsList,
  labelsList: mocks.labelsList,
  issuesList: mocks.issuesList,
  issuesMoveColumn: mocks.issuesMoveColumn,
  issuesAddLabel: mocks.issuesAddLabel,
  issuesRemoveLabel: mocks.issuesRemoveLabel,
  // 业务里也用到的其它具名 export（mock 返回合理 stub）
  boardColumnsCreate: vi.fn(),
  boardColumnsDelete: vi.fn(),
  boardColumnsMapLabel: vi.fn(),
  boardColumnsUnmapLabel: vi.fn(),
  boardColumnsUpdate: vi.fn(),
  issuesCreate: vi.fn(),
  issuesUpdate: vi.fn(),
  getIpcClient: mocks.getIpcClient,
  // normalizeError 在 store catch 时调用
  normalizeError: vi.fn((e: unknown) => e),
}));

// IPC user.undoStatus 走 getIpcClient().invoke —— 单独 mock 让 moveIssue 后 loadUndoStatus 不抛
mocks.getIpcClient.mockReturnValue({
  invoke: vi.fn().mockResolvedValue({ undoSize: 0, redoSize: 0 }),
});

import { setActivePinia, createPinia } from 'pinia';
import { useBoardStore } from '@renderer/stores/board';
import type { ColumnDto, IssueCardDto, IssueLabelDto } from '../../../main/ipc/schema.js';

// ===== 测试用 fixtures =====

const PROJECT_ID = 'p-test-uuid';

const LABEL_TODO: IssueLabelDto = { id: 100, name: 'To Do', color: '#cccccc' };
const LABEL_DOING: IssueLabelDto = { id: 101, name: 'In Progress', color: '#dddddd' };
// v1.4 修复守护：moveIssue 乐观更新 labels 字段测试需要更多 label fixture
const LABEL_BUG: IssueLabelDto = { id: 102, name: 'bug', color: '#ee0701' };
const LABEL_FEATURE: IssueLabelDto = { id: 103, name: 'feature', color: '#00aaff' };

function makeCol(id: string, title: string, labels: IssueLabelDto[]): ColumnDto {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    position: 0,
    labels,
  };
}

function makeIssue(index: number, title: string, labels: IssueLabelDto[]): IssueCardDto {
  return {
    id: index,
    index,
    title,
    body: '',
    state: 'open',
    author: { username: 'tester' },
    labels,
    isPullRequest: false,
    refBranch: '',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

describe('board store · loadBoard 基础', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.boardColumnsList.mockReset();
    mocks.labelsList.mockReset();
    mocks.issuesList.mockReset();
    mocks.issuesMoveColumn.mockReset();
    mocks.issuesAddLabel.mockReset();
    mocks.issuesRemoveLabel.mockReset();
  });

  it('loadBoard 成功：columns + issues 归类（OR 语义）', async () => {
    const todoCol = makeCol('c-todo', 'To Do', [LABEL_TODO]);
    const doingCol = makeCol('c-doing', 'Doing', [LABEL_DOING]);
    mocks.boardColumnsList.mockResolvedValueOnce([todoCol, doingCol]);
    mocks.labelsList.mockResolvedValueOnce({ items: [LABEL_TODO, LABEL_DOING], hasMore: false });
    // issue A 带 "To Do" → todoCol；issue B 带 "In Progress" → doingCol；issue C 无列绑 label → unassigned
    const issues = [
      makeIssue(1, 'A', [LABEL_TODO]),
      makeIssue(2, 'B', [LABEL_DOING]),
      makeIssue(3, 'C', []),
    ];
    mocks.issuesList.mockResolvedValueOnce({ items: issues, hasMore: false });

    const board = useBoardStore();
    const result = await board.loadBoard(PROJECT_ID);

    expect(result.columns).toHaveLength(2);
    expect(result.autoInitCreatedCount).toBe(0); // N 列 → 不 autoInit
    expect(board.columns).toHaveLength(2);
    expect(board.issuesOf('c-todo')).toHaveLength(1);
    expect(board.issuesOf('c-todo')[0]?.index).toBe(1);
    expect(board.issuesOf('c-doing')).toHaveLength(1);
    expect(board.issuesOf('c-doing')[0]?.index).toBe(2);
    expect(board.unassignedIssues).toHaveLength(1);
    expect(board.unassignedIssues[0]?.index).toBe(3);
    expect(board.currentProjectId).toBe(PROJECT_ID);
  });

  it('loadBoard 失败：IPC 抛错 → store.error 落地 + 抛出', async () => {
    mocks.boardColumnsList.mockRejectedValueOnce({
      code: 'network_offline',
      message: '网络问题',
      hint: '请检查网络',
      recoverable: true,
    });

    const board = useBoardStore();
    await expect(board.loadBoard(PROJECT_ID)).rejects.toBeDefined();
    expect(board.error).toBeDefined();
  });

  it('loadBoard 成功但 issues 归类后 issuesByColumn 含全部列的 key', async () => {
    const todoCol = makeCol('c-todo', 'To Do', [LABEL_TODO]);
    const emptyCol = makeCol('c-empty', 'Empty', []);
    mocks.boardColumnsList.mockResolvedValueOnce([todoCol, emptyCol]);
    mocks.labelsList.mockResolvedValueOnce({ items: [LABEL_TODO], hasMore: false });
    mocks.issuesList.mockResolvedValueOnce({
      items: [makeIssue(1, 'A', [LABEL_TODO])],
      hasMore: false,
    });

    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);

    // 即使 emptyCol 没绑 label，issuesByColumn 也要有它的 key（防止 UI 渲染 undefined）
    expect(board.issuesOf('c-empty')).toEqual([]);
  });
});

describe('board store · moveIssue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.boardColumnsList.mockReset();
    mocks.labelsList.mockReset();
    mocks.issuesList.mockReset();
    mocks.issuesMoveColumn.mockReset();
    mocks.issuesAddLabel.mockReset();
    mocks.issuesRemoveLabel.mockReset();
  });

  // 共享 setup：建好 board + 2 列 + 1 个 issue 在 todoCol
  async function setupBoard(): Promise<ReturnType<typeof useBoardStore>> {
    const todoCol = makeCol('c-todo', 'To Do', [LABEL_TODO]);
    const doingCol = makeCol('c-doing', 'Doing', [LABEL_DOING]);
    mocks.boardColumnsList.mockResolvedValueOnce([todoCol, doingCol]);
    mocks.labelsList.mockResolvedValueOnce({ items: [LABEL_TODO, LABEL_DOING], hasMore: false });
    mocks.issuesList.mockResolvedValueOnce({
      items: [makeIssue(1, 'A', [LABEL_TODO])],
      hasMore: false,
    });
    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);
    return board;
  }

  it('moveIssue 成功：issue 从 todoCol 移到 doingCol + 调 IPC + loadUndoStatus', async () => {
    const board = await setupBoard();
    mocks.issuesMoveColumn.mockResolvedValueOnce(undefined);

    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-todo',
      toColumnId: 'c-doing',
    });

    expect(mocks.issuesMoveColumn).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-todo',
      toColumnId: 'c-doing',
    });
    expect(board.issuesOf('c-todo')).toHaveLength(0);
    expect(board.issuesOf('c-doing')).toHaveLength(1);
    expect(board.issuesOf('c-doing')[0]?.index).toBe(1);
  });

  it('moveIssue no-op（from === to）：不调 IPC', async () => {
    const board = await setupBoard();
    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-todo',
      toColumnId: 'c-todo', // 同一列
    });
    expect(mocks.issuesMoveColumn).not.toHaveBeenCalled();
  });

  it('moveIssue 失败：状态回滚（issue 仍在 fromColumn） + 错误抛', async () => {
    const board = await setupBoard();
    mocks.issuesMoveColumn.mockRejectedValueOnce({
      code: 'gitea_error',
      message: '服务器开小差',
      hint: '请稍候重试',
      recoverable: true,
    });

    await expect(
      board.moveIssue({
        projectId: PROJECT_ID,
        issueIndex: 1,
        fromColumnId: 'c-todo',
        toColumnId: 'c-doing',
      }),
    ).rejects.toBeDefined();

    // 回滚：issue 应回到 todoCol，doingCol 仍空
    expect(board.issuesOf('c-todo')).toHaveLength(1);
    expect(board.issuesOf('c-todo')[0]?.index).toBe(1);
    expect(board.issuesOf('c-doing')).toHaveLength(0);
    expect(board.error).toBeDefined();
  });

  it('moveIssue 找不到 issue：抛 not_found + 不调 IPC', async () => {
    const board = await setupBoard();
    await expect(
      board.moveIssue({
        projectId: PROJECT_ID,
        issueIndex: 999, // 不存在
        fromColumnId: 'c-todo',
        toColumnId: 'c-doing',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(mocks.issuesMoveColumn).not.toHaveBeenCalled();
  });

  // v1.4 修复守护：乐观更新 issue.labels 字段同步刷
  //  原 bug：位置层更新但 issue.labels 保留 fromColumn 绑的 label
  //  → 卡片 label chip 仍显示旧 label，用户感受"释放不更新"
  it('moveIssue 乐观更新同步刷 issue.labels（移除 fromCol 绑的 + 加上 toCol 绑的）', async () => {
    const board = await setupBoard();
    mocks.issuesMoveColumn.mockResolvedValueOnce(undefined);

    // setupBoard 把 issue 1 放在 todoCol 且 labels=[LABEL_TODO]（见 makeIssue 默认）
    // 期待：移去 doingCol 后，issue.labels 应只含 LABEL_DOING（移除 LABEL_TODO + 加 LABEL_DOING）
    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-todo',
      toColumnId: 'c-doing',
    });

    const moved = board.issuesOf('c-doing')[0];
    expect(moved).toBeDefined();
    const labelIds = moved!.labels.map((l) => l.id);
    // 不应再含 LABEL_TODO
    expect(labelIds).not.toContain(LABEL_TODO.id);
    // 应含 LABEL_DOING
    expect(labelIds).toContain(LABEL_DOING.id);
    // issue 其他字段保留
    expect(moved!.index).toBe(1);
    expect(moved!.title).toBe('A');
  });

  it('moveIssue 失败回滚用原 issue（labels 不变）+ 状态完整恢复', async () => {
    const board = await setupBoard();
    const originalIssue = board.issuesOf('c-todo')[0]!;
    mocks.issuesMoveColumn.mockRejectedValueOnce({
      code: 'gitea_error',
      message: '服务器开小差',
      hint: '请稍候重试',
      recoverable: true,
    });

    await expect(
      board.moveIssue({
        projectId: PROJECT_ID,
        issueIndex: 1,
        fromColumnId: 'c-todo',
        toColumnId: 'c-doing',
      }),
    ).rejects.toBeDefined();

    // 回滚后 issue 应回 todoCol 且 labels 是原值
    const rolled = board.issuesOf('c-todo')[0]!;
    expect(rolled).toBeDefined();
    expect(rolled.labels.map((l) => l.id)).toEqual(originalIssue.labels.map((l) => l.id));
    expect(rolled.labels.map((l) => l.id)).toContain(LABEL_TODO.id);
  });

  it('moveIssue 多列绑 label 的 issue：labels 集合正确（OR 语义）', async () => {
    // 列绑 2 个 label：todoCol 绑 [TODO, BUG]，doingCol 绑 [DOING]
    // issue 在 todoCol 实际 labels = [TODO, BUG, FEATURE]（FEATURE 是其它无关 label）
    // 移去 doingCol 后：issue.labels = 原 labels - {TODO, BUG} ∪ {DOING} = [FEATURE, DOING]
    const todoCol = makeCol('c-todo', 'To Do', [LABEL_TODO, LABEL_BUG]);
    const doingCol = makeCol('c-doing', 'Doing', [LABEL_DOING]);
    mocks.boardColumnsList.mockResolvedValueOnce([todoCol, doingCol]);
    mocks.labelsList.mockResolvedValueOnce({
      items: [LABEL_TODO, LABEL_BUG, LABEL_DOING, LABEL_FEATURE],
      hasMore: false,
    });
    const issueWithMultiLabels = makeIssue(1, 'A', [LABEL_TODO, LABEL_BUG, LABEL_FEATURE]);
    mocks.issuesList.mockResolvedValueOnce({ items: [issueWithMultiLabels], hasMore: false });
    setActivePinia(createPinia());
    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);
    mocks.issuesMoveColumn.mockResolvedValueOnce(undefined);

    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-todo',
      toColumnId: 'c-doing',
    });

    const moved = board.issuesOf('c-doing')[0]!;
    const labelIds = moved.labels.map((l) => l.id).sort();
    // 应去掉 TODO + BUG（fromCol 绑的）
    expect(labelIds).not.toContain(LABEL_TODO.id);
    expect(labelIds).not.toContain(LABEL_BUG.id);
    // 应加 DOING（toCol 绑的）
    expect(labelIds).toContain(LABEL_DOING.id);
    // 应保留 FEATURE（与列绑定无关）
    expect(labelIds).toContain(LABEL_FEATURE.id);
  });
});

describe('board store · updateIssueLabels', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.boardColumnsList.mockReset();
    mocks.labelsList.mockReset();
    mocks.issuesList.mockReset();
    mocks.issuesMoveColumn.mockReset();
    mocks.issuesAddLabel.mockReset();
    mocks.issuesRemoveLabel.mockReset();
  });

  async function setupBoardWithIssue(
    labels: IssueLabelDto[],
  ): Promise<ReturnType<typeof useBoardStore>> {
    const todoCol = makeCol('c-todo', 'To Do', [LABEL_TODO]);
    const doingCol = makeCol('c-doing', 'Doing', [LABEL_DOING]);
    mocks.boardColumnsList.mockResolvedValueOnce([todoCol, doingCol]);
    mocks.labelsList.mockResolvedValueOnce({
      items: [LABEL_TODO, LABEL_DOING, LABEL_FEATURE],
      hasMore: false,
    });
    mocks.issuesList.mockResolvedValueOnce({ items: [makeIssue(1, 'A', labels)], hasMore: false });
    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);
    return board;
  }

  it('删除唯一列绑定标签后，内容区从原列移到未分类', async () => {
    const board = await setupBoardWithIssue([LABEL_TODO, LABEL_FEATURE]);
    mocks.issuesRemoveLabel.mockResolvedValueOnce(undefined);

    await board.updateIssueLabels({
      projectId: PROJECT_ID,
      issueIndex: 1,
      removeLabelIds: [LABEL_TODO.id],
    });

    expect(mocks.issuesRemoveLabel).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueIndex: 1,
      labelId: LABEL_TODO.id,
    });
    expect(board.issuesOf('c-todo')).toHaveLength(0);
    expect(board.unassignedIssues).toHaveLength(1);
    expect(board.unassignedIssues[0]?.index).toBe(1);
    expect(board.unassignedIssues[0]?.labels.map((l) => l.id)).toEqual([LABEL_FEATURE.id]);
  });

  it('删除当前列标签后若仍命中其他列，内容区移到新列', async () => {
    const board = await setupBoardWithIssue([LABEL_TODO, LABEL_DOING]);
    mocks.issuesRemoveLabel.mockResolvedValueOnce(undefined);

    await board.updateIssueLabels({
      projectId: PROJECT_ID,
      issueIndex: 1,
      removeLabelIds: [LABEL_TODO.id],
    });

    expect(board.issuesOf('c-todo')).toHaveLength(0);
    expect(board.issuesOf('c-doing')).toHaveLength(1);
    expect(board.issuesOf('c-doing')[0]?.index).toBe(1);
    expect(board.unassignedIssues).toHaveLength(0);
  });
});
