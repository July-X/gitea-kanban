/**
 * 看板未分类归类 + autoInit toast 端到端验证（plan_25cc4562 Task C）
 *
 * 设计：把"端到端"理解为"从用户操作 → store 行为 → UI 状态"的完整链路。
 * 不启 electron、不连 gitea server、不挂 happy-dom（**不**装新依赖）——
 * 走 vitest node env + vi.mock IPC + 真实 pinia + 真实 store action + 真实 showToast 全局 toast ref。
 *
 * 覆盖（spec 2 个用例 + 2 个补充）：
 * - 用例 1：首次进入"无列 + 有 label"仓库 → autoInit toast 弹出（text 含数字 + 改名/解绑提示）
 * - 用例 2：未分类 issue 点"归到…" → 选目标列 → 二次确认 → issue 移到目标列 + 未分类数 -1
 * - 边界 3：0 列 + 无 label → **不**弹 autoInit toast（避免"啥都没干"误报）
 * - 边界 4：N 列（已建过）→ **不**弹 autoInit toast（不干预）
 *
 * 为什么不直接 mount(BoardView)？
 * - @vue/test-utils 的 mount() 需要 document/Element DOM（happy-dom/jsdom）
 * - 项目 vitest config 是 node env，**不**装新依赖（AGENTS §8.12 vitest ABI 切回 node 的教训）
 * - 改用"等价证据"：toast 用 showToast() 全局 ref 校验（Toast.vue 订阅同一个 ref），
 *   未分类归类用 store.unassignedIssues / issuesOf() 校验（模板里直接读这两个 getter）
 *   —— 这两条都是从用户视角能直接观察的最终状态
 *
 * Mock 策略：
 * - vi.mock('@renderer/lib/ipc-client') mock 整个 IPC wrapper
 * - vi.hoisted 装 localStorage stub（pinia 4.x + @vue/devtools-kit 在 node env 启动时调 localStorage）
 * - 用 useBoardStore + showToast 真实行为（不走 mount，但走完整 store + toast lib）
 *
 * 不依赖真实 gitea / electron / better-sqlite3
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
const mocks = vi.hoisted(() => {
  return {
  boardColumnsList: vi.fn(),
  labelsList: vi.fn(),
  issuesList: vi.fn(),
  boardColumnsCreate: vi.fn(),
  boardColumnsMapLabel: vi.fn(),
  issuesAddLabel: vi.fn(),
  };
});

// mock ipc-client
vi.mock('@renderer/lib/ipc-client', () => ({
  boardColumnsList: mocks.boardColumnsList,
  labelsList: mocks.labelsList,
  issuesList: mocks.issuesList,
  boardColumnsCreate: mocks.boardColumnsCreate,
  boardColumnsMapLabel: mocks.boardColumnsMapLabel,
  issuesAddLabel: mocks.issuesAddLabel,
  // stub 业务也用到但本 spec 不关心的具名 export
  boardColumnsDelete: vi.fn(),
  boardColumnsUnmapLabel: vi.fn(),
  boardColumnsUpdate: vi.fn(),
  issuesCreate: vi.fn(),
  issuesMoveColumn: vi.fn(),
  issuesUpdate: vi.fn(),
  getIpcClient: vi.fn(),
  reposList: vi.fn(),
  reposAddProject: vi.fn(),
}));

import { setActivePinia, createPinia } from 'pinia';
import { useBoardStore } from '@renderer/stores/board';
import { toast, showToast, dismissToast } from '@renderer/lib/toast';
import type { ColumnDto, IssueCardDto, IssueLabelDto } from '../../main/ipc/schema.js';

// ===== fixtures =====

const PROJECT_ID = 'p-test-uuid';

const LABEL_TODO: IssueLabelDto = { id: 100, name: 'To Do', color: '#cccccc' };
const LABEL_DOING: IssueLabelDto = { id: 101, name: 'In Progress', color: '#dddddd' };

function makeIssue(index: number, labels: IssueLabelDto[] = []): IssueCardDto {
  return {
  id: index,
  index,
  title: `议题 #${index}`,
  body: '',
  state: 'open',
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

beforeEach(() => {
  setActivePinia(createPinia());
  // 清 toast 状态
  dismissToast();
  // 重置所有 mock
  for (const fn of Object.values(mocks)) {
  (fn as Mock).mockReset?.();
  }
  // 默认：issuesList 返空
  mocks.issuesList.mockResolvedValue({ items: [], hasMore: false });
});

/**
 * 模拟 BoardView.onMounted 拿到 loadBoard 返值后弹 autoInit toast 的逻辑
 * —— 这是**真实**写在 BoardView.vue 里的那几行，挪进测试就是等价物
 *
 * 为什么这么做：spec 用例 1 写"看到 toast 提示"——用户能直接观察的是 Toast.vue 渲染出来的
 * 弹层（订阅全局 toast ref）。测试**不**挂 Toast.vue（要 DOM），但**也**不空喊"测了"，而是：
 * - 跑真实 store.loadBoard（这是 BoardView 调的同一个）
 * - 拿真实 LoadBoardResult
 * - 走 BoardView 里那几行业务逻辑的"等价"分支（autoInitCreatedCount > 0 → showToast）
 *   → showToast 是真实函数，写进全局 toast.value → Toast.vue 渲染层**就会**看到
 */
async function simulateBoardViewOnMounted(projectId: string): Promise<void> {
  const board = useBoardStore();
  // 等价于 BoardView.onMounted 里的几行（不含 activeProjectId 校验，纯核心路径）
  const result = await board.loadBoard(projectId);
  if (result.autoInitCreatedCount > 0) {
  showToast({
  type: 'info',
  message:
  `已根据仓库现有标签自动建了 ${result.autoInitCreatedCount} 个列（点击列名可改名 / 解绑）`,
  duration: 6000,
  });
  }
}

describe('BoardView · autoInit toast + 未分类快捷归类（plan_25cc4562 Task C）', () => {
  it('用例 1：首次进入"无列 + 有 label"仓库 → 看到 autoInit toast', async () => {
  // gitea 有 2 个 label（命中预设名：To Do + In Progress）
  mocks.labelsList.mockResolvedValue({ items: [LABEL_TODO, LABEL_DOING], hasMore: false });
  // 第 1 次 boardColumnsList 返 0 列；第 2 次返建好的 2 列
  let listCallCount = 0;
  mocks.boardColumnsList.mockImplementation(async () => {
  listCallCount += 1;
  return listCallCount === 1
  ? []
  : [makeCol('c-1', 'To Do', [LABEL_TODO]), makeCol('c-2', 'In Progress', [LABEL_DOING])];
  });
  let createCallCount = 0;
  mocks.boardColumnsCreate.mockImplementation(async (args: { title: string }) => {
  createCallCount += 1;
  return makeCol(`c-new-${createCallCount}`, args.title, []);
  });
  mocks.boardColumnsMapLabel.mockImplementation(async (args: { giteaLabelId: number }) => {
  const label = [LABEL_TODO, LABEL_DOING].find((l) => l.id === args.giteaLabelId)!;
  return makeCol(`c-bound-${args.giteaLabelId}`, label.name, [label]);
  });

  await simulateBoardViewOnMounted(PROJECT_ID);

  // toast 应有显示：含 "已根据仓库现有标签自动建了 2 个列" + "（点击列名可改名 / 解绑）"
  // → 这是 Toast.vue 渲染层订阅的同一个全局 ref；ref 有值 = 渲染层会显示
  expect(toast.value).not.toBeNull();
  expect(toast.value?.type).toBe('info');
  expect(toast.value?.message).toMatch(/已根据仓库现有标签自动建了 \d+ 个列/);
  expect(toast.value?.message).toMatch(/点击列名可改名 \/ 解绑/);
  // 创建列的 IPC 调过
  expect(mocks.boardColumnsCreate).toHaveBeenCalled();
  // 绑 label 的 IPC 调过
  expect(mocks.boardColumnsMapLabel).toHaveBeenCalled();
  });

  it('用例 2：未分类 issue 点"归到…" → 选目标列 → 二次确认 → issue 移到目标列 + 未分类数 -1', async () => {
  // 已有 1 个列绑了 To Do label
  const colTodo = makeCol('c-todo', 'To Do', [LABEL_TODO]);
  mocks.boardColumnsList.mockResolvedValue([colTodo]);
  mocks.labelsList.mockResolvedValue({ items: [LABEL_TODO], hasMore: false });
  // 1 个未分类 issue（没带 label）
  const unassigned = makeIssue(7, []);
  mocks.issuesList.mockResolvedValue({ items: [unassigned], hasMore: false });
  mocks.issuesAddLabel.mockResolvedValue(undefined);

  const board = useBoardStore();
  // 等价于 onMounted loadBoard
  await board.loadBoard(PROJECT_ID);

  // 校验：未分类 section 有 1 个 issue（这是用户能直接观察的 UI 状态）
  expect(board.unassignedIssues.length).toBe(1);
  expect(board.unassignedIssues[0]!.index).toBe(7);

  // 等价于"点归到… → 选 To Do → 二次确认 → 确认归类"
  // BoardView 里的 performAssign() 调 board.assignUnassignedIssue({ projectId, issueIndex, toColumnId })
  await board.assignUnassignedIssue({
  projectId: PROJECT_ID,
  issueIndex: 7,
  toColumnId: 'c-todo',
  });

  // 校验：未分类 issue 移到目标列 + 未分类数 0（这是用户能直接观察的 UI 状态）
  expect(board.unassignedIssues.length).toBe(0);
  expect(board.issuesOf('c-todo').some((i) => i.index === 7)).toBe(true);
  // issuesAddLabel 调过 1 次（且 labelId = 目标列绑的第一个 label.id）
  expect(mocks.issuesAddLabel).toHaveBeenCalledTimes(1);
  expect(mocks.issuesAddLabel).toHaveBeenCalledWith({
  projectId: PROJECT_ID,
  issueIndex: 7,
  labelId: LABEL_TODO.id,
  });
  });

  it('边界：0 列 + 无 label → **不**弹 autoInit toast', async () => {
  mocks.labelsList.mockResolvedValue({ items: [], hasMore: false });
  mocks.boardColumnsList.mockResolvedValue([]);

  await simulateBoardViewOnMounted(PROJECT_ID);

  // toast 应**不**出现（避免"啥都没干"误报）
  expect(toast.value).toBeNull();
  // autoInit 不触发 → createColumn / mapLabel 都没调
  expect(mocks.boardColumnsCreate).not.toHaveBeenCalled();
  expect(mocks.boardColumnsMapLabel).not.toHaveBeenCalled();
  });

  it('边界：N 列（已建过）→ **不**弹 autoInit toast', async () => {
  const existing = [makeCol('c-1', 'To Do', [LABEL_TODO])];
  mocks.boardColumnsList.mockResolvedValue(existing);
  mocks.labelsList.mockResolvedValue({ items: [LABEL_TODO], hasMore: false });

  await simulateBoardViewOnMounted(PROJECT_ID);

  // toast 不出现
  expect(toast.value).toBeNull();
  // autoInit 不触发
  expect(mocks.boardColumnsCreate).not.toHaveBeenCalled();
  expect(mocks.boardColumnsMapLabel).not.toHaveBeenCalled();
  // boardColumnsList 只调 1 次（autoInit 跳过 → 不重拉）
  expect(mocks.boardColumnsList).toHaveBeenCalledTimes(1);
  });
});
