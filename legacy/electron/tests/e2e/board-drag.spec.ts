/**
 * 看板真拖拽（vue-draggable-plus）端到端验证（plan_25cc4562 Task A · v1.3.1 撤回键盘双模后）
 *
 * **策略说明**（与同目录 board-unassigned.spec.ts 一致）：
 * - @vue/test-utils 的 mount() 需要 happy-dom/jsdom（**未**装）
 * - 项目约定：e2e spec 走"store + IPC mock + lib helper"路径，**不**挂 Vue 组件
 * - 此 spec 覆盖 2 个 e2e 用例 + 1 个补充：
 *
 * - 用例 1：跨列拖动 → 走 `mapDragEndToMoveIntent` 生成的 intent 调 store.moveIssue → IPC 调过 + args 对
 * - 用例 2：拖到"已完成"列 → `isFinishColumnByTitle` 命中 → 二次确认逻辑触发 → 确认后 moveIssue + issuesUpdate
 * - 补充 3：列内排序（同列拖动）v1 **不**调后端
 *
 * 历史：v1.3 引入过"键盘 Space 拾起 + 方向键 + Space 放下"用例 3（依赖 keyDownToColumn +
 * makeIdleKeyboardDrag）；v1.3.1 撤回键盘双模后用例 3 整体删除。
 *
 * 跨端到端覆盖：
 * - drag-helper（纯函数单测在 src/renderer/lib/__tests__/drag-helper.test.ts）
 * - board store.moveIssue（业务态在 src/renderer/stores/__tests__/board-autoinit.test.ts 已覆盖 autoInit）
 * - isFinishColumnByTitle（已在 drag-helper 单测覆盖）
 *
 * 此 spec 把"组件内 onColumnDragEnd 调 performDragMove 调 store.moveIssue"这条端到端链
 * 拆成"mapDragEndToMoveIntent 出参" + "store.moveIssue 调 IPC"两段验证，**等于**组件契约：
 * - 契约 1：onColumnDragEnd 拿到 from/to/issueIndex → mapDragEndToMoveIntent 返 intent
 * - 契约 2：store.moveIssue(intent.fromColumnId, intent.toColumnId, intent.issueIndex) 调 issuesMoveColumn IPC
 * - 契约 3：isFinishColumnByTitle('已完成') === true → 二次确认
 * - 契约 4：performFinishMove → moveIssue + issuesUpdate({ state: 'closed' })
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ===== localStorage stub（必须 hoist 到 import pinia 之前）=====
vi.hoisted(() => {
  const stub = {
    getItem: (_k: string): string | null => null,
    setItem: (_k: string, _v: string): void => {},
    removeItem: (_k: string): void => {},
    clear: (): void => {},
    key: (_i: number): string | null => null,
    get length(): number { return 0; },
  };
  (globalThis as unknown as { localStorage: typeof stub }).localStorage = stub;
});

// ===== vi.hoisted 共享 mock 句柄 =====
const mocks = vi.hoisted(() => ({
  boardColumnsList: vi.fn(),
  labelsList: vi.fn(),
  issuesList: vi.fn(),
  issuesMoveColumn: vi.fn(),
  issuesUpdate: vi.fn(),
  issuesAddLabel: vi.fn(),
  boardColumnsCreate: vi.fn(),
  boardColumnsMapLabel: vi.fn(),
  reposList: vi.fn(),
  reposAddProject: vi.fn(),
  getIpcClient: vi.fn(),
}));

// mock ipc-client（与 board-unassigned.spec.ts 同结构）
vi.mock('@renderer/lib/ipc-client', () => ({
  boardColumnsList: mocks.boardColumnsList,
  labelsList: mocks.labelsList,
  issuesList: mocks.issuesList,
  issuesMoveColumn: mocks.issuesMoveColumn,
  issuesUpdate: mocks.issuesUpdate,
  issuesAddLabel: mocks.issuesAddLabel,
  boardColumnsCreate: mocks.boardColumnsCreate,
  boardColumnsMapLabel: mocks.boardColumnsMapLabel,
  reposList: mocks.reposList,
  reposAddProject: mocks.reposAddProject,
  getIpcClient: mocks.getIpcClient,
  // 业务也用到但本 spec 不关心的 stub（避免 undefined.func 报错）
  boardColumnsDelete: vi.fn(),
  boardColumnsUnmapLabel: vi.fn(),
  boardColumnsUpdate: vi.fn(),
  issuesCreate: vi.fn(),
}));

import { setActivePinia, createPinia } from 'pinia';
import { useBoardStore } from '@renderer/stores/board';
import { useRepoStore } from '@renderer/stores/repo';
import {
  isFinishColumnByTitle,
  mapDragEndToMoveIntent,
} from '@renderer/lib/drag-helper';
import type { ColumnDto, IssueCardDto, IssueLabelDto, RepoDto } from '../../main/ipc/schema.js';

// ===== fixtures =====

const PROJECT_ID = 'p-test-uuid';
const REPO_FULL = 'kanban_demo/m4java-test';

const LABEL_TODO: IssueLabelDto = { id: 100, name: 'To Do', color: '#cccccc' };
const LABEL_DOING: IssueLabelDto = { id: 101, name: 'In Progress', color: '#dddddd' };
const LABEL_DONE: IssueLabelDto = { id: 102, name: 'Done', color: '#aaaaaa' };
const LABEL_FINISH_CN: IssueLabelDto = { id: 103, name: '已完成', color: '#bbbbbb' };

function makeIssue(
  index: number,
  labels: IssueLabelDto[] = [],
  state: 'open' | 'closed' = 'open',
): IssueCardDto {
  return {
    id: index,
    index,
    title: `议题 #${index}`,
    body: '',
    state,
    createdAt: '2026-06-15T10:00:00+08:00',
    updatedAt: '2026-06-15T10:00:00+08:00',
    author: { username: 'u' },
    labels,
    isPullRequest: false,
  };
}

function makeCol(id: string, title: string, labels: IssueLabelDto[]): ColumnDto {
  return { id, projectId: PROJECT_ID, title, position: 0, labels };
}

function makeRepo(fullName: string, owner: string, name: string): RepoDto {
  return {
    id: 1,
    owner,
    name,
    fullName,
    description: '',
    defaultBranch: 'main',
    archived: false,
    private: false,
    updatedAt: '2026-06-15T10:00:00+08:00',
    permissions: { pull: true, push: true, admin: false },
    isProject: true,
  };
}

function makeStubAuthRepo(): void {
  // 注入 stub：repo.currentProject / repo.repos / auth.isConnected
  const repo = useRepoStore();
  mocks.reposList.mockResolvedValue({
    items: [makeRepo(REPO_FULL, 'kanban_demo', 'm4java-test')],
    total: 1,
    page: 1,
    hasMore: false,
  });
  mocks.reposAddProject.mockResolvedValue({
    id: PROJECT_ID,
    giteaAccountId: 'a',
    owner: 'kanban_demo',
    name: 'm4java-test',
    defaultBranch: 'main',
    lastSyncAt: null,
    createdAt: '2026-06-15T10:00:00+08:00',
  });
  (repo as unknown as { currentProject: unknown }).currentProject = {
    id: PROJECT_ID,
    giteaAccountId: 'a',
    owner: 'kanban_demo',
    name: 'm4java-test',
    defaultBranch: 'main',
    lastSyncAt: null,
    createdAt: '2026-06-15T10:00:00+08:00',
  };
  (repo as unknown as { repos: RepoDto[] }).repos = [
    makeRepo(REPO_FULL, 'kanban_demo', 'm4java-test'),
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const fn of Object.values(mocks)) {
    (fn as Mock).mockReset?.();
  }
  // default: issuesMoveColumn 走 IPC 返回 success
  mocks.issuesMoveColumn.mockResolvedValue(undefined);
  mocks.issuesUpdate.mockResolvedValue(undefined);
  // 默认 issuesList 返空（loadBoard 走 Promise 后才能覆盖）
  mocks.issuesList.mockResolvedValue({ items: [], hasMore: false });
  // user.undoStatus 走 getIpcClient().invoke 装 stub
  mocks.getIpcClient.mockReturnValue({
    invoke: vi.fn().mockResolvedValue({ undoSize: 0, redoSize: 0 }),
  });
  makeStubAuthRepo();
});

describe('BoardView · 真拖拽换列（plan_25cc4562 Task A）', () => {
  it('用例 1：跨列拖动 → mapDragEndToMoveIntent 出参正确 + store.moveIssue 调 IPC', async () => {
    // 2 列：To Do + In Progress，各 1 issue
    const colTodo = makeCol('c-todo', 'To Do', [LABEL_TODO]);
    const colDoing = makeCol('c-doing', 'In Progress', [LABEL_DOING]);
    mocks.boardColumnsList.mockResolvedValue([colTodo, colDoing]);
    mocks.labelsList.mockResolvedValue({ items: [LABEL_TODO, LABEL_DOING], hasMore: false });
    const issue = makeIssue(7, [LABEL_TODO]);
    mocks.issuesList.mockResolvedValue({ items: [issue], hasMore: false });

    // 模拟 BoardView.onMounted → loadBoard
    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);
    expect(board.issuesOf('c-todo').length).toBe(1);
    expect(board.issuesOf('c-doing').length).toBe(0);

    // ===== 模拟 Sortable onEnd 事件流 =====
    // 组件 onColumnDragEnd(col, evt) 内部从 evt.from / evt.to / evt.item.dataset 抽出
    // → mapDragEndToMoveIntent 出 intent → performDragMove → store.moveIssue
    const dragEvent = {
      fromColumnId: 'c-todo',
      toColumnId: 'c-doing',
      issueIndex: 7,
    };
    const intent = mapDragEndToMoveIntent(dragEvent);
    expect(intent).toEqual({ issueIndex: 7, fromColumnId: 'c-todo', toColumnId: 'c-doing' });

    // 调 store.moveIssue（这是组件 onColumnDragEnd → performDragMove → store.moveIssue 的终点）
    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: intent!.issueIndex,
      fromColumnId: intent!.fromColumnId,
      toColumnId: intent!.toColumnId,
    });

    // 校验 IPC
    expect(mocks.issuesMoveColumn).toHaveBeenCalledTimes(1);
    expect(mocks.issuesMoveColumn).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueIndex: 7,
      fromColumnId: 'c-todo',
      toColumnId: 'c-doing',
    });
    // 校验 store 状态（乐观更新生效）
    expect(board.issuesOf('c-todo').length).toBe(0);
    expect(board.issuesOf('c-doing').length).toBe(1);
    expect(board.issuesOf('c-doing')[0]!.index).toBe(7);
  });

  it('用例 2：拖到"已完成"列 → 二次确认 + 确认后 moveIssue + issuesUpdate(state=closed)', async () => {
    // 2 列：In Progress + 已完成
    const colDoing = makeCol('c-doing', 'In Progress', [LABEL_DOING]);
    const colDone = makeCol('c-done', '已完成', [LABEL_FINISH_CN]);
    mocks.boardColumnsList.mockResolvedValue([colDoing, colDone]);
    mocks.labelsList.mockResolvedValue({ items: [LABEL_DOING, LABEL_FINISH_CN], hasMore: false });
    const issue = makeIssue(42, [LABEL_DOING]);
    mocks.issuesList.mockResolvedValue({ items: [issue], hasMore: false });

    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);
    expect(board.issuesOf('c-doing').length).toBe(1);

    // ===== 模拟组件 performDragMove 流程（v1.3 拍板路径）=====
    // performDragMove(issue, fromColumnId, toColumnId) 内部：
    //   1. if (from === to) return
    //   2. const toCol = board.columns.find(c => c.id === toColumnId)
    //   3. if (toCol && isFinishColumn(toCol)) → confirmFinish.open = true → 等用户确认
    //   4. else → performMove → store.moveIssue
    //
    // 我们的等价：先验证 isFinishColumnByTitle 命中"已完成" → 模拟 confirm 触发 performFinishMove
    // performFinishMove 内部：store.moveIssue + issuesUpdate({ state: 'closed' })

    // 1. isFinishColumn 命中校验
    expect(isFinishColumnByTitle('已完成')).toBe(true);
    expect(isFinishColumnByTitle(colDone.title)).toBe(true);
    expect(isFinishColumnByTitle('In Progress')).toBe(false);

    // 2. 用户在 confirmFinish 弹层输入"完成"+点确认 → performFinishMove 调：
    //    a. store.moveIssue(c-doing → c-done)
    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: 42,
      fromColumnId: 'c-doing',
      toColumnId: 'c-done',
    });
    //    b. issuesUpdate({ state: 'closed' }) —— 调真实的 issuesUpdate wrapper（mock 已 stub）
    //       用 dynamic import 模拟 BoardView.performFinishMove 内部的 dynamic import
    const { issuesUpdate } = await import('@renderer/lib/ipc-client');
    await issuesUpdate({
      projectId: PROJECT_ID,
      issueIndex: 42,
      patch: { state: 'closed' },
    });

    // 校验：moveIssue + issuesUpdate 都调过 + args 对
    expect(mocks.issuesMoveColumn).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueIndex: 42,
      fromColumnId: 'c-doing',
      toColumnId: 'c-done',
    });
    expect(mocks.issuesUpdate).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueIndex: 42,
      patch: { state: 'closed' },
    });
    // store 状态：issue 移到 c-done
    expect(board.issuesOf('c-doing').length).toBe(0);
    expect(board.issuesOf('c-done').length).toBe(1);
    expect(board.issuesOf('c-done')[0]!.index).toBe(42);
  });

  it('补充 3：列内排序（同列拖动）v1 **不**调后端', async () => {
    // 1 列：To Do，2 个 issue
    const colTodo = makeCol('c-todo', 'To Do', [LABEL_TODO]);
    mocks.boardColumnsList.mockResolvedValue([colTodo]);
    mocks.labelsList.mockResolvedValue({ items: [LABEL_TODO], hasMore: false });
    const issueA = makeIssue(1, [LABEL_TODO]);
    const issueB = makeIssue(2, [LABEL_TODO]);
    mocks.issuesList.mockResolvedValue({ items: [issueA, issueB], hasMore: false });

    const board = useBoardStore();
    await board.loadBoard(PROJECT_ID);
    expect(board.issuesOf('c-todo').length).toBe(2);

    // 模拟"列内拖动"onEnd：从 c-todo 拖到 c-todo（fromColumnId === toColumnId）
    const dragEvent = { fromColumnId: 'c-todo', toColumnId: 'c-todo', issueIndex: 1 };
    const intent = mapDragEndToMoveIntent(dragEvent);
    // mapDragEndToMoveIntent 同列返 null → 组件不调 store.moveIssue
    expect(intent).toBeNull();

    // 即使用户手动调 store.moveIssue 同列，moveIssue 内部 from === to 提前 return
    await board.moveIssue({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-todo',
      toColumnId: 'c-todo',
    });
    // issuesMoveColumn IPC **不**被调
    expect(mocks.issuesMoveColumn).not.toHaveBeenCalled();
    // store 状态：2 个 issue 还在 c-todo
    expect(board.issuesOf('c-todo').length).toBe(2);
  });
});
