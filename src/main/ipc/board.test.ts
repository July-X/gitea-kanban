/**
 * src/main/ipc/board.ts 单测
 *
 * 覆盖（任务 prompt §"端点实现清单 board.cards/columns" + 02-architecture §5.3.7 + §5.3.8）：
 * - registerBoardIpc 注册 12 个 channel（5 columns + 7 cards）
 * - 业务层 happy path（columns.list / cards.list / cards.create / cards.move 等）
 * - Zod 校验：缺必填 → VALIDATION_FAILED
 * - 错误码透传：业务层抛 NOT_FOUND / CONFLICT → 渲染层拿到 code
 * - unregister 清理全部
 *
 * 跟 branches.test.ts 同样的 mock 风格：捕获 ipcMain.handle 注册的回调
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ipcHandlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
  },
  app: {
    isPackaged: false,
    getPath: (k: string) => {
      throw new Error(`electron.getPath(${k}) not mocked in test`);
    },
  },
}));

const { IpcErrorCode } = await import('@shared/errors');
const { IpcChannel } = await import('./schema.js');
const { registerBoardIpc, unregisterBoardIpc } = await import('./board.js');
const sqliteMod = await import('../cache/sqlite.js');
const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
const { repoProjects } = await import('../cache/schema/repoProjects.js');
const { boards } = await import('../cache/schema/boards.js');

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-ipc-board-test-'));
let currentDbPath = '';

async function seedProjectAndBoard() {
  if (!sqliteMod.getDb().select().from(giteaAccounts).all().find((a) => a.id === 'acc-1')) {
    sqliteMod.getDb().insert(giteaAccounts).values({
      id: 'acc-1',
      giteaUrl: 'http://x',
      username: 'alice',
      keychainService: 'gitea-kanban@http://x',
      createdAt: new Date(),
    }).run();
  }
  if (!sqliteMod.getDb().select().from(repoProjects).all().find((p) => p.id === 'p-1')) {
    sqliteMod.getDb().insert(repoProjects).values({
      id: 'p-1',
      giteaAccountId: 'acc-1',
      owner: 'alice',
      name: 'foo',
      defaultBranch: 'main',
      createdAt: new Date(),
    }).run();
  }
  if (!sqliteMod.getDb().select().from(boards).all().find((b) => b.id === 'b-1')) {
    sqliteMod.getDb().insert(boards).values({
      id: 'b-1',
      repoProjectId: 'p-1',
      name: 'default',
      layout: 'kanban',
      createdAt: new Date(),
    }).run();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  ipcHandlers.clear();
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  sqliteMod._setSqlitePathForTest(currentDbPath);
  await sqliteMod.initSqlite();
  await seedProjectAndBoard();
  // 撤销栈的 default user 标志
  const { _resetDefaultUserSeededForTest } = await import('../board/undo.js');
  _resetDefaultUserSeededForTest();
  registerBoardIpc();
});

afterEach(async () => {
  unregisterBoardIpc();
  await sqliteMod._resetSqliteForTest();
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ===== 注册断言 =====

describe('registerBoardIpc', () => {
  it('注册 12 个 channel（5 columns + 7 cards）', () => {
    expect(ipcHandlers.has(IpcChannel.BOARD_COLUMNS_LIST)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_COLUMNS_CREATE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_COLUMNS_UPDATE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_COLUMNS_REORDER)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_COLUMNS_DELETE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_LIST)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_CREATE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_UPDATE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_MOVE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_DELETE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_LINK)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.BOARD_CARDS_UNLINK)).toBe(true);
  });

  it('unregisterBoardIpc 清空所有 12 个 channel', () => {
    unregisterBoardIpc();
    for (const ch of [
      IpcChannel.BOARD_COLUMNS_LIST, IpcChannel.BOARD_COLUMNS_CREATE, IpcChannel.BOARD_COLUMNS_UPDATE,
      IpcChannel.BOARD_COLUMNS_REORDER, IpcChannel.BOARD_COLUMNS_DELETE,
      IpcChannel.BOARD_CARDS_LIST, IpcChannel.BOARD_CARDS_CREATE, IpcChannel.BOARD_CARDS_UPDATE,
      IpcChannel.BOARD_CARDS_MOVE, IpcChannel.BOARD_CARDS_DELETE,
      IpcChannel.BOARD_CARDS_LINK, IpcChannel.BOARD_CARDS_UNLINK,
    ]) {
      expect(ipcHandlers.has(ch)).toBe(false);
    }
  });
});

// ===== board.columns.* 业务路径 =====

describe('board.columns.list', () => {
  it('空 board → []', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_LIST)!;
    const r = (await handler({}, { projectId: 'p-1' })) as unknown[];
    expect(r).toEqual([]);
  });

  it('projectId 缺失 → VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_LIST)!;
    await expect(handler({}, {})).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('项目不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_LIST)!;
    await expect(handler({}, { projectId: 'no-such' })).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

describe('board.columns.create', () => {
  it('happy path：返 ColumnDto', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const r = (await handler({}, { projectId: 'p-1', name: 'todo', position: 0 })) as { id: string; name: string };
    expect(r.name).toBe('todo');
    expect(r.id).toBeTruthy();
  });

  it('name 缺失 → VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    await expect(handler({}, { projectId: 'p-1', position: 0 })).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });
});

describe('board.columns.update', () => {
  it('columnId 不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_UPDATE)!;
    await expect(handler({}, { columnId: 'no-such', patch: { name: 'x' } })).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('patch 全空 → VALIDATION_FAILED（refine 失败）', async () => {
    const createHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const c = (await createHandler({}, { projectId: 'p-1', name: 'todo', position: 0 })) as { id: string };
    const updateHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_UPDATE)!;
    await expect(updateHandler({}, { columnId: c.id, patch: {} })).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });
});

describe('board.columns.reorder', () => {
  it('orderedIds 漏列 → VALIDATION_FAILED', async () => {
    const createHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const c1 = (await createHandler({}, { projectId: 'p-1', name: 'a', position: 0 })) as { id: string };
    const _c2 = (await createHandler({}, { projectId: 'p-1', name: 'b', position: 0 })) as { id: string };
    void _c2;
    const reorderHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_REORDER)!;
    await expect(reorderHandler({}, { projectId: 'p-1', orderedIds: [c1.id] })).rejects.toMatchObject({
      code: IpcErrorCode.VALIDATION_FAILED,
    });
  });
});

describe('board.columns.delete', () => {
  it('moveCardsTo=自身 → CONFLICT', async () => {
    const createHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const c = (await createHandler({}, { projectId: 'p-1', name: 'a', position: 0 })) as { id: string };
    const deleteHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_DELETE)!;
    await expect(deleteHandler({}, { columnId: c.id, moveCardsTo: c.id })).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  });
});

// ===== board.cards.* 业务路径 =====

describe('board.cards.list', () => {
  it('columnId 不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.BOARD_CARDS_LIST)!;
    await expect(handler({}, { columnId: 'no-such' })).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('happy path：空列 → []', async () => {
    const createColHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const c = (await createColHandler({}, { projectId: 'p-1', name: 'todo', position: 0 })) as { id: string };
    const listHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_LIST)!;
    const cards = (await listHandler({}, { columnId: c.id })) as unknown[];
    expect(cards).toEqual([]);
  });
});

describe('board.cards.create', () => {
  it('happy path：返 CardDto + 同步插 undo_entries', async () => {
    const createColHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const c = (await createColHandler({}, { projectId: 'p-1', name: 'todo', position: 0 })) as { id: string; title: string };
    const { undoEntries } = await import('../cache/schema/undoEntries.js');
    const before = sqliteMod.getDb().select().from(undoEntries).all();
    const createCardHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_CREATE)!;
    const card = (await createCardHandler({}, { columnId: c.id, title: 'do thing', position: 1024 })) as { id: string; title: string };
    expect(card.title).toBe('do thing');
    const after = sqliteMod.getDb().select().from(undoEntries).all();
    expect(after.length - before.length).toBe(1);
    expect(after[after.length - 1]!.op).toBe('card.create');
  });

  it('title 缺失 → VALIDATION_FAILED', async () => {
    const createColHandler = ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!;
    const c = (await createColHandler({}, { projectId: 'p-1', name: 'todo', position: 0 })) as { id: string };
    const createCardHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_CREATE)!;
    await expect(createCardHandler({}, { columnId: c.id, position: 0 })).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });
});

describe('board.cards.move', () => {
  it('跨列 wipLimit=3 已 3 张 → 再 move → CONFLICT', async () => {
    // 建 wipLimit=3 的列
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    const c1 = (await (ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!)(
      {},
      { projectId: 'p-1', name: 'todo', position: 0 },
    )) as { id: string };
    const c2id = 'c-wip-3';
    sqliteMod.getDb().insert(boardColumns).values({
      id: c2id, boardId: 'b-1', name: 'wip', position: 1024, wipLimit: 3, hideMergedPr: false, createdAt: new Date(),
    }).run();
    // c2 塞 3 张
    const createCardHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_CREATE)!;
    for (let i = 0; i < 3; i++) {
      await createCardHandler({}, { columnId: c2id, title: `c${i}`, position: 1024 * (i + 1) });
    }
    // c1 准备一张要 move
    const movable = (await createCardHandler({}, { columnId: c1.id, title: 'movable', position: 0 })) as { id: string };
    const moveHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_MOVE)!;
    await expect(moveHandler({}, { cardId: movable.id, toColumnId: c2id, toPosition: 9999 })).rejects.toMatchObject({
      code: IpcErrorCode.CONFLICT,
    });
  });
});

describe('board.cards.link / unlink', () => {
  it('link 重复 → CONFLICT', async () => {
    const c = (await (ipcHandlers.get(IpcChannel.BOARD_COLUMNS_CREATE)!)(
      {},
      { projectId: 'p-1', name: 'todo', position: 0 },
    )) as { id: string };
    const card = (await (ipcHandlers.get(IpcChannel.BOARD_CARDS_CREATE)!)(
      {},
      { columnId: c.id, title: 'a', position: 0 },
    )) as { id: string };
    const linkHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_LINK)!;
    await linkHandler({}, { cardId: card.id, link: { refKind: 'commit', owner: 'a', repo: 'r', refId: 'sha', role: 'reference' } });
    await expect(
      linkHandler({}, { cardId: card.id, link: { refKind: 'commit', owner: 'a', repo: 'r', refId: 'sha', role: 'reference' } }),
    ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  });

  it('unlink 不存在 → NOT_FOUND', async () => {
    const unlinkHandler = ipcHandlers.get(IpcChannel.BOARD_CARDS_UNLINK)!;
    await expect(unlinkHandler({}, { linkId: 'no-such' })).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});
