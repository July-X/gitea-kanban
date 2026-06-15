/**
 * board store · loadBoard autoInit 透明化单测（plan_25cc4562 Task C）
 *
 * 覆盖（spec 3 个用例 + 1 个补充）：
 * - 0 列 + gitea 有 label → autoInitCreatedCount > 0（自动建列 + 绑 label）
 * - 0 列 + gitea 无 label → autoInitCreatedCount = 0（**不**弹 toast，避免"啥都没干"误报）
 * - N 列（已建过）→ autoInitCreatedCount = 0（不干预）
 * - 补充：返回的 columns 数组长度 = autoInitCreatedCount（caller 用作"已建 N 个列"提示）
 *
 * Mock 策略（renderer store 不直接连 gitea，全走 IPC wrapper）：
 * - vi.mock('@renderer/lib/ipc-client') mock 整个 IPC wrapper
 * - 用 vi.hoisted 共享 mock 句柄给测试用例改返回值
 * - 不引 pinia createPinia + setActivePinia → 走 createStore helper（看下面）
 *
 * 不依赖真实 gitea / electron / better-sqlite3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===== localStorage stub（必须在 pinia 导入前生效）=====
// pinia 4.x + @vue/devtools-kit 在 node env 启动时调 localStorage.getItem('vue-devtools-suspended')
// （位于 vue/devtools-kit/dist/index.js:2272）—— node env 无 localStorage，**会**抛 TypeError
// 测试环境用最小内存 stub 规避（**不**装新依赖）。
// **关键**：必须用 `vi.hoisted` —— vi.mock 已被 hoisted 到 import 之前，stub 也得 hoist 到
// vi.mock 之前才能拦截 vue/devtools-kit 模块顶层的 localStorage.getItem 调用。
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

// ===== vi.mock 必须放在 import 业务模块之前 =====

// vi.hoisted 让 mock 工厂能引用 top-level mock 对象（vi.mock 会被 hoist）
const mocks = vi.hoisted(() => ({
  boardColumnsList: vi.fn(),
  labelsList: vi.fn(),
  issuesList: vi.fn(),
  boardColumnsCreate: vi.fn(),
  boardColumnsMapLabel: vi.fn(),
  getIpcClient: vi.fn(),
}));

// mock 整个 ipc-client 模块（board store 全 import 这里）
vi.mock('@renderer/lib/ipc-client', () => ({
  boardColumnsList: mocks.boardColumnsList,
  labelsList: mocks.labelsList,
  issuesList: mocks.issuesList,
  boardColumnsCreate: mocks.boardColumnsCreate,
  boardColumnsMapLabel: mocks.boardColumnsMapLabel,
  getIpcClient: mocks.getIpcClient,
  // 业务里也用到的其它具名 export（mock 返回合理 stub，避免 undefined.func 报错）
  boardColumnsDelete: vi.fn(),
  boardColumnsUnmapLabel: vi.fn(),
  boardColumnsUpdate: vi.fn(),
  issuesAddLabel: vi.fn(),
  issuesCreate: vi.fn(),
  issuesMoveColumn: vi.fn(),
  issuesUpdate: vi.fn(),
}));

import { setActivePinia, createPinia } from 'pinia';
import { useBoardStore } from '@renderer/stores/board';
import type { ColumnDto, IssueLabelDto } from '../../../main/ipc/schema.js';

// ===== 测试用 fixtures =====

const PROJECT_ID = 'p-test-uuid';

const LABEL_TODO: IssueLabelDto = { id: 100, name: 'To Do', color: '#cccccc' };
const LABEL_DOING: IssueLabelDto = { id: 101, name: 'In Progress', color: '#dddddd' };
const LABEL_DONE: IssueLabelDto = { id: 102, name: 'Done', color: '#eeeeee' };

function makeCol(id: string, title: string, labels: IssueLabelDto[]): ColumnDto {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    position: 0,
    labels,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  // 重置所有 mock 调用记录 + 默认实现
  mocks.boardColumnsList.mockReset();
  mocks.labelsList.mockReset();
  mocks.issuesList.mockReset();
  mocks.boardColumnsCreate.mockReset();
  mocks.boardColumnsMapLabel.mockReset();
  // 默认 issuesList 返空（多数 case 不关心 issue 列表）
  mocks.issuesList.mockResolvedValue({ items: [], hasMore: false });
});

describe('board store · loadBoard autoInit 透明化（plan_25cc4562 Task C）', () => {
  it('0 列 + gitea 有 label → autoInitCreatedCount > 0（自动建列 + 绑 label）', async () => {
  // gitea label 列表有 3 个：'To Do' / 'In Progress' / 'Done'（3 个都命中 autoInit 的预设列名）
  mocks.labelsList.mockResolvedValue({
  items: [LABEL_TODO, LABEL_DOING, LABEL_DONE],
  hasMore: false,
  });
  // 第 1 次 boardColumnsList 返 0 列（autoInit 触发前）；第 2 次返建好的 3 列
  let listCallCount = 0;
  mocks.boardColumnsList.mockImplementation(async () => {
  listCallCount += 1;
  if (listCallCount === 1) return []; // autoInit 触发前：0 列
  // autoInit 触发后：3 个建好且绑了 label 的列
  return [
  makeCol('c-1', 'To Do', [LABEL_TODO]),
  makeCol('c-2', 'In Progress', [LABEL_DOING]),
  makeCol('c-3', 'Done', [LABEL_DONE]),
  ];
  });
  // createColumn 返带 id 的 col（autoInit 内部用）
  let createCallCount = 0;
  mocks.boardColumnsCreate.mockImplementation(async (args: { title: string }) => {
  createCallCount += 1;
  return makeCol(`c-new-${createCallCount}`, args.title, []);
  });
  // mapLabel 返绑好 label 的 col
  mocks.boardColumnsMapLabel.mockImplementation(async (args: { giteaLabelId: number }) => {
  const label = [LABEL_TODO, LABEL_DOING, LABEL_DONE].find((l) => l.id === args.giteaLabelId)!;
  return makeCol(`c-bound-${args.giteaLabelId}`, label.name, [label]);
  });

  const board = useBoardStore();
  const result = await board.loadBoard(PROJECT_ID);

  // autoInit 帮建了 2 列（"To Do" 和 "In Progress" 命中预设名；"Done" 也命中但本测试 mock 只给 2 个）
  // 实际 presetColumns 含 Done → 3 个全中。修正 mock：上面我们让 listCallCount === 2 返 2 个，
  // 业务上 autoInit 实际会建 3 个 + 重拉 3 个。检查数量大于 0 即满足 spec。
  expect(result.autoInitCreatedCount).toBeGreaterThan(0);
  expect(result.columns.length).toBeGreaterThan(0);
  expect(result.columns.length).toBe(result.autoInitCreatedCount);
  // createColumn 至少调了 1 次
  expect(mocks.boardColumnsCreate).toHaveBeenCalled();
  // mapLabel 至少调了 1 次
  expect(mocks.boardColumnsMapLabel).toHaveBeenCalled();
  // store.columns 也同步了
  expect(board.columns.length).toBe(result.columns.length);
  });

  it('0 列 + gitea 无 label → autoInitCreatedCount = 0（**不**触发 autoInit）', async () => {
  // 第 1 次：0 列；第 2 次：仍 0 列（autoInit 不建列）
  let listCallCount = 0;
  mocks.boardColumnsList.mockImplementation(async () => {
  listCallCount += 1;
  return [];
  });
  // gitea 没 label
  mocks.labelsList.mockResolvedValue({ items: [], hasMore: false });

  const board = useBoardStore();
  const result = await board.loadBoard(PROJECT_ID);

  // autoInit 跳过 → 计数 = 0
  expect(result.autoInitCreatedCount).toBe(0);
  expect(result.columns).toEqual([]);
  // createColumn / mapLabel 一次都没调
  expect(mocks.boardColumnsCreate).not.toHaveBeenCalled();
  expect(mocks.boardColumnsMapLabel).not.toHaveBeenCalled();
  // store.columns 也是空
  expect(board.columns).toEqual([]);
  // 即使调了 boardColumnsList 一次或两次（autoInit 条件 `0 列 + gitea 无 label` 跳过 re-list），
  // 都正常；不强制断言 listCallCount 具体值
  });

  it('N 列（已建过）→ autoInitCreatedCount = 0（不干预）', async () => {
  // 直接返 3 个已有列（带 label）
  const existing = [
  makeCol('c-1', '待办', [LABEL_TODO]),
  makeCol('c-2', '进行中', [LABEL_DOING]),
  makeCol('c-3', '已完成', [LABEL_DONE]),
  ];
  mocks.boardColumnsList.mockResolvedValue(existing);
  mocks.labelsList.mockResolvedValue({
  items: [LABEL_TODO, LABEL_DOING, LABEL_DONE],
  hasMore: false,
  });

  const board = useBoardStore();
  const result = await board.loadBoard(PROJECT_ID);

  // 已有列 → autoInit 不触发
  expect(result.autoInitCreatedCount).toBe(0);
  expect(result.columns).toEqual(existing);
  expect(board.columns).toEqual(existing);
  // createColumn / mapLabel 都没调
  expect(mocks.boardColumnsCreate).not.toHaveBeenCalled();
  expect(mocks.boardColumnsMapLabel).not.toHaveBeenCalled();
  // boardColumnsList 只调 1 次（autoInit 不触发 → 不重拉）
  expect(mocks.boardColumnsList).toHaveBeenCalledTimes(1);
  });
});
