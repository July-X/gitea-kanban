/**
 * board store · updateColumn WIP 上限单测（plan_25cc4562 · Task B）
 *
 * 覆盖（spec 至少 1 个 store 测试）：
 * - board.updateColumn({ columnId, wipLimit: 5 }) → 调 IPC + 本地列的 wipLimit 同步
 * - board.updateColumn({ columnId, wipLimit: null }) → 本地列的 wipLimit 同步成 null
 * - board.updateColumn({ columnId, title: '新名', wipLimit: 3 }) → title + wipLimit 一起同步
 * - board.updateColumn 不传 wipLimit（仅传 title）→ 原 wipLimit 不变
 * - board.updateColumn IPC 失败 → 抛 UserFacingError + 本地**不**变
 *
 * Mock 策略（renderer store 不直接连 gitea，全走 IPC wrapper）：
 * - vi.mock('@renderer/lib/ipc-client') mock 整个 IPC wrapper
 * - 用 vi.hoisted 共享 mock 句柄给测试用例改返回值
 * - 不引 pinia createPinia + setActivePinia
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
  boardColumnsUpdate: vi.fn(),
}));

// mock 整个 ipc-client 模块（board store 全 import 这里）
// 只 mock 我们用到的 boardColumnsUpdate，其他具名 export 给空 stub 即可
vi.mock('@renderer/lib/ipc-client', () => ({
  boardColumnsUpdate: mocks.boardColumnsUpdate,
  // 业务里也用到的其它具名 export（mock 返回合理 stub，避免 undefined.func 报错）
  boardColumnsList: vi.fn(),
  boardColumnsCreate: vi.fn(),
  boardColumnsDelete: vi.fn(),
  boardColumnsMapLabel: vi.fn(),
  boardColumnsUnmapLabel: vi.fn(),
  issuesAddLabel: vi.fn(),
  issuesCreate: vi.fn(),
  issuesList: vi.fn(),
  issuesMoveColumn: vi.fn(),
  issuesUpdate: vi.fn(),
  labelsList: vi.fn(),
  getIpcClient: vi.fn(),
}));

import { setActivePinia, createPinia } from 'pinia';
import { useBoardStore } from '@renderer/stores/board';
import type { ColumnDto, IssueLabelDto } from '../../../main/ipc/schema.js';

// ===== fixtures =====

const PROJECT_ID = 'p-test-uuid';

const SAMPLE_LABEL: IssueLabelDto = { id: 100, name: 'To Do', color: '#cccccc' };

function makeCol(
  id: string,
  title: string,
  labels: IssueLabelDto[] = [],
  wipLimit: number | null = null,
): ColumnDto {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    position: 0,
    labels,
    wipLimit,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.boardColumnsUpdate.mockReset();
});

/** 直接把列塞进 store（不走 IPC，测 updateColumn 时已有本地列） */
function seedColumns(board: ReturnType<typeof useBoardStore>, cols: ColumnDto[]): void {
  board.columns = [...cols];
}

// ============================================================
// ===== updateColumn · wipLimit 同步 =====
// ============================================================

describe('board store · updateColumn WIP 上限（plan_25cc4562 · Task B）', () => {
  it('1. updateColumn({ columnId, wipLimit: 5 }) 调 IPC + 本地 wipLimit 同步', async () => {
    mocks.boardColumnsUpdate.mockResolvedValue(makeCol('c1', 'ToDo', [], 5));
    const board = useBoardStore();
    seedColumns(board, [makeCol('c1', 'ToDo', [SAMPLE_LABEL], null)]);

    await board.updateColumn({ columnId: 'c1', wipLimit: 5 });

    // IPC 被调，patch 只含 wipLimit（没 title 字段）
    expect(mocks.boardColumnsUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.boardColumnsUpdate).toHaveBeenCalledWith({
      columnId: 'c1',
      patch: { wipLimit: 5 },
    });
    // 本地列 wipLimit 同步
    expect(board.columns[0]!.wipLimit).toBe(5);
  });

  it('2. updateColumn({ columnId, wipLimit: null }) 把上限清成无限', async () => {
    mocks.boardColumnsUpdate.mockResolvedValue(makeCol('c1', 'ToDo', [], null));
    const board = useBoardStore();
    seedColumns(board, [makeCol('c1', 'ToDo', [SAMPLE_LABEL], 5)]);

    await board.updateColumn({ columnId: 'c1', wipLimit: null });

    expect(mocks.boardColumnsUpdate).toHaveBeenCalledWith({
      columnId: 'c1',
      patch: { wipLimit: null },
    });
    expect(board.columns[0]!.wipLimit).toBeNull();
  });

  it('3. updateColumn({ columnId, title: "新名", wipLimit: 3 }) 同时改 title + wipLimit', async () => {
    mocks.boardColumnsUpdate.mockResolvedValue(
      makeCol('c1', '新名', [SAMPLE_LABEL], 3),
    );
    const board = useBoardStore();
    seedColumns(board, [makeCol('c1', '旧名', [SAMPLE_LABEL], null)]);

    await board.updateColumn({ columnId: 'c1', title: '新名', wipLimit: 3 });

    expect(mocks.boardColumnsUpdate).toHaveBeenCalledWith({
      columnId: 'c1',
      patch: { title: '新名', wipLimit: 3 },
    });
    expect(board.columns[0]!.title).toBe('新名');
    expect(board.columns[0]!.wipLimit).toBe(3);
  });

  it('4. updateColumn 不传 wipLimit（只改 title）→ 原 wipLimit 不变', async () => {
    mocks.boardColumnsUpdate.mockResolvedValue(
      makeCol('c1', '新名', [SAMPLE_LABEL], 5),
    );
    const board = useBoardStore();
    seedColumns(board, [makeCol('c1', '旧名', [SAMPLE_LABEL], 5)]);

    await board.updateColumn({ columnId: 'c1', title: '新名' });

    // patch 不含 wipLimit 字段
    expect(mocks.boardColumnsUpdate).toHaveBeenCalledWith({
      columnId: 'c1',
      patch: { title: '新名' },
    });
    // 本地 wipLimit 保持 5（没动）
    expect(board.columns[0]!.wipLimit).toBe(5);
    expect(board.columns[0]!.title).toBe('新名');
  });

  it('5. updateColumn IPC 失败 → 抛 UserFacingError + 本地 wipLimit 不变', async () => {
    // IPC 抛 IpcError 形态（store 透传成 UserFacingError）
    mocks.boardColumnsUpdate.mockRejectedValue({
      code: 'validation_failed',
      message: 'wipLimit 必须是正整数或 null（无限）',
      hint: '请输入 ≥ 1 的整数，留空表示无限',
    });
    const board = useBoardStore();
    seedColumns(board, [makeCol('c1', 'ToDo', [SAMPLE_LABEL], null)]);

    await expect(
      board.updateColumn({ columnId: 'c1', wipLimit: -1 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // 本地未变（仍然是 null）
    expect(board.columns[0]!.wipLimit).toBeNull();
  });

  it('6. updateColumn 不传 title（只改 wipLimit）→ 不被当成 "title 是空字符串" 误清空', async () => {
    mocks.boardColumnsUpdate.mockResolvedValue(makeCol('c1', 'ToDo', [], 7));
    const board = useBoardStore();
    seedColumns(board, [makeCol('c1', 'ToDo', [SAMPLE_LABEL], null)]);

    await board.updateColumn({ columnId: 'c1', wipLimit: 7 });

    // patch 只有 wipLimit
    expect(mocks.boardColumnsUpdate).toHaveBeenCalledWith({
      columnId: 'c1',
      patch: { wipLimit: 7 },
    });
    // title 保持 ToDo（**不**被空字符串覆盖）
    expect(board.columns[0]!.title).toBe('ToDo');
    expect(board.columns[0]!.wipLimit).toBe(7);
  });
});
