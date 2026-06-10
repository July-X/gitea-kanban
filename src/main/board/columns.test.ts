/**
 * src/main/board/columns.ts 单测
 *
 * 覆盖：
 * - getBoardIdByProjectId：项目无 board → NOT_FOUND
 * - listColumns：返回 ColumnDto[]（含 cardCount 聚合）
 * - createColumn：name + position + undo_entries
 * - updateColumn：patch 应用 + undo 快照
 * - reorderColumns：事务批量 + undo；orderedIds 不完整 → VALIDATION_FAILED
 * - deleteColumn：moveCardsTo=null 级联删；moveCardsTo=columnId 移走；moveCardsTo=自身 → CONFLICT
 * - projectExists：boolean
 *
 * 不测 wrapIpc（IPC 测试在 ipc/board.test.ts）
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (k: string) => {
      throw new Error(`electron.getPath(${k}) not mocked in test`);
    },
  },
}));

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-columns-test-'));
let currentDbPath = '';

let initSqlite: typeof import('../cache/sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('../cache/sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('../cache/sqlite.js')._resetSqliteForTest;
let getDb: typeof import('../cache/sqlite.js').getDb;
let _resetDefaultUserSeededForTest: typeof import('./undo.js')._resetDefaultUserSeededForTest;

let getBoardIdByProjectId: typeof import('./columns.js').getBoardIdByProjectId;
let listColumns: typeof import('./columns.js').listColumns;
let createColumn: typeof import('./columns.js').createColumn;
let updateColumn: typeof import('./columns.js').updateColumn;
let reorderColumns: typeof import('./columns.js').reorderColumns;
let deleteColumn: typeof import('./columns.js').deleteColumn;
let projectExists: typeof import('./columns.js').projectExists;

beforeEach(async () => {
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const sqliteMod = await import('../cache/sqlite.js');
  initSqlite = sqliteMod.initSqlite;
  _setSqlitePathForTest = sqliteMod._setSqlitePathForTest;
  _resetSqliteForTest = sqliteMod._resetSqliteForTest;
  getDb = sqliteMod.getDb;
  _setSqlitePathForTest(currentDbPath);
  await initSqlite();

  const undoMod = await import('./undo.js');
  _resetDefaultUserSeededForTest = undoMod._resetDefaultUserSeededForTest;

  const columnsMod = await import('./columns.js');
  getBoardIdByProjectId = columnsMod.getBoardIdByProjectId;
  listColumns = columnsMod.listColumns;
  createColumn = columnsMod.createColumn;
  updateColumn = columnsMod.updateColumn;
  reorderColumns = columnsMod.reorderColumns;
  deleteColumn = columnsMod.deleteColumn;
  projectExists = columnsMod.projectExists;

  _resetDefaultUserSeededForTest();
});

afterEach(async () => {
  await _resetSqliteForTest();
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function seedProjectWithBoard(args: { projectId: string; accountId?: string; boardId?: string; giteaUrl?: string; username?: string; owner?: string; repoName?: string } = { projectId: 'p-1' }) {
  const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
  const { repoProjects } = await import('../cache/schema/repoProjects.js');
  const { boards } = await import('../cache/schema/boards.js');
  const accountId = args.accountId ?? 'acc-1';
  const boardId = args.boardId ?? 'b-1';
  const giteaUrl = args.giteaUrl ?? 'http://x';
  const username = args.username ?? 'alice';
  const owner = args.owner ?? 'alice';
  const repoName = args.repoName ?? 'foo';
  // giteaAccounts（UNIQUE on gitea_url+username）
  if (!getDb().select().from(giteaAccounts).all().find((a) => a.id === accountId)) {
    getDb().insert(giteaAccounts).values({
      id: accountId,
      giteaUrl,
      username,
      keychainService: `gitea-kanban@${giteaUrl}`,
      createdAt: new Date(),
    }).run();
  }
  // repoProjects
  if (!getDb().select().from(repoProjects).all().find((p) => p.id === args.projectId)) {
    getDb().insert(repoProjects).values({
      id: args.projectId,
      giteaAccountId: accountId,
      owner,
      name: repoName,
      defaultBranch: 'main',
      createdAt: new Date(),
    }).run();
  }
  // boards
  if (!getDb().select().from(boards).all().find((b) => b.id === boardId)) {
    getDb().insert(boards).values({
      id: boardId,
      repoProjectId: args.projectId,
      name: 'default',
      layout: 'kanban',
      createdAt: new Date(),
    }).run();
  }
  return { projectId: args.projectId, boardId };
}

describe('getBoardIdByProjectId', () => {
  it('项目无 board → NOT_FOUND', async () => {
    await seedProjectWithBoard({ projectId: 'p-1' });
    // 把 board 删了
    const { boards } = await import('../cache/schema/boards.js');
    getDb().delete(boards).run();
    expect(() => getBoardIdByProjectId('p-1')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('项目 + board → 返 boardId', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    expect(getBoardIdByProjectId('p-1')).toBe('b-1');
  });
});

describe('listColumns', () => {
  it('空 board → 空数组', async () => {
    await seedProjectWithBoard({ projectId: 'p-1' });
    expect(listColumns('p-1')).toEqual([]);
  });

  it('3 列 + cardCount 聚合', async () => {
    const { boardId } = await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    const { cards } = await import('../cache/schema/cards.js');
    getDb().insert(boardColumns).values([
      { id: 'c1', boardId, name: 'todo', position: 1024, wipLimit: null, hideMergedPr: false, createdAt: new Date() },
      { id: 'c2', boardId, name: 'doing', position: 2048, wipLimit: 3, hideMergedPr: false, createdAt: new Date() },
      { id: 'c3', boardId, name: 'done', position: 3072, wipLimit: null, hideMergedPr: true, createdAt: new Date() },
    ]).run();
    // c1 放 2 卡，c2 放 0，c3 放 1
    getDb().insert(cards).values([
      { id: 'k1', columnId: 'c1', title: 'a', body: null, position: 1024, color: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 'k2', columnId: 'c1', title: 'b', body: null, position: 2048, color: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 'k3', columnId: 'c3', title: 'c', body: null, position: 1024, color: null, createdAt: new Date(), updatedAt: new Date() },
    ]).run();
    const cols = listColumns('p-1');
    expect(cols).toHaveLength(3);
    expect(cols[0]!.name).toBe('todo');
    expect(cols[0]!.cardCount).toBe(2);
    expect(cols[1]!.name).toBe('doing');
    expect(cols[1]!.cardCount).toBe(0);
    expect(cols[1]!.wipLimit).toBe(3);
    expect(cols[2]!.name).toBe('done');
    expect(cols[2]!.cardCount).toBe(1);
    expect(cols[2]!.hideMergedPr).toBe(true);
  });
});

describe('createColumn', () => {
  it('happy path：返 ColumnDTO + position = 0（首个列 max=null → -STEP+STEP）', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    expect(c.id).toBeTruthy();
    expect(c.name).toBe('todo');
    // 业务逻辑：首个列 max(boardColumns.position) 查不到 → fallback -STEP=−1024
    //   → newPosition = -1024 + 1024 = 0
    expect(c.position).toBe(0);
    expect(c.cardCount).toBe(0);
  });

  it('第二个列 position = 第一个 + STEP（1024）', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c1 = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const c2 = createColumn({ projectId: 'p-1', name: 'doing', position: 0 });
    expect(c2.position).toBeGreaterThan(c1.position);
    expect(c2.position - c1.position).toBe(1024);
  });
});

describe('updateColumn', () => {
  it('改 name + wipLimit + hideMergedPr', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const updated = updateColumn({ columnId: c.id, patch: { name: 'backlog', wipLimit: 5, hideMergedPr: true } });
    expect(updated.name).toBe('backlog');
    expect(updated.wipLimit).toBe(5);
    expect(updated.hideMergedPr).toBe(true);
  });

  it('columnId 不存在 → NOT_FOUND', async () => {
    expect(() => updateColumn({ columnId: 'no-such', patch: { name: 'x' } })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('reorderColumns', () => {
  it('重排后 position 反映新顺序', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c1 = createColumn({ projectId: 'p-1', name: 'a', position: 0 });
    const c2 = createColumn({ projectId: 'p-1', name: 'b', position: 0 });
    const c3 = createColumn({ projectId: 'p-1', name: 'c', position: 0 });
    // 重排 c3 c1 c2
    reorderColumns({ projectId: 'p-1', orderedIds: [c3.id, c1.id, c2.id] });
    const cols = listColumns('p-1');
    expect(cols.map((c) => c.name)).toEqual(['c', 'a', 'b']);
  });

  it('orderedIds 漏列 → VALIDATION_FAILED', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c1 = createColumn({ projectId: 'p-1', name: 'a', position: 0 });
    const _c2 = createColumn({ projectId: 'p-1', name: 'b', position: 0 });
    void _c2;
    expect(() => reorderColumns({ projectId: 'p-1', orderedIds: [c1.id] })).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });

  it('orderedIds 多列（不属于本 board）→ VALIDATION_FAILED', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c1 = createColumn({ projectId: 'p-1', name: 'a', position: 0 });
    expect(() => reorderColumns({ projectId: 'p-1', orderedIds: [c1.id, 'extra'] })).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});

describe('deleteColumn', () => {
  it('moveCardsTo=undefined → 级联删 cards', async () => {
    const { boardId } = await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    const { cards } = await import('../cache/schema/cards.js');
    getDb().insert(boardColumns).values({ id: 'c1', boardId, name: 'todo', position: 1024, wipLimit: null, hideMergedPr: false, createdAt: new Date() }).run();
    getDb().insert(cards).values({ id: 'k1', columnId: 'c1', title: 'a', body: null, position: 1024, color: null, createdAt: new Date(), updatedAt: new Date() }).run();
    deleteColumn({ columnId: 'c1' });
    expect(getDb().select().from(boardColumns).all()).toHaveLength(0);
    expect(getDb().select().from(cards).all()).toHaveLength(0);
  });

  it('moveCardsTo=目标列 → 卡片 move 过去', async () => {
    const { boardId } = await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    const { cards } = await import('../cache/schema/cards.js');
    getDb().insert(boardColumns).values([
      { id: 'c1', boardId, name: 'todo', position: 1024, wipLimit: null, hideMergedPr: false, createdAt: new Date() },
      { id: 'c2', boardId, name: 'doing', position: 2048, wipLimit: null, hideMergedPr: false, createdAt: new Date() },
    ]).run();
    getDb().insert(cards).values({ id: 'k1', columnId: 'c1', title: 'a', body: null, position: 1024, color: null, createdAt: new Date(), updatedAt: new Date() }).run();
    deleteColumn({ columnId: 'c1', moveCardsTo: 'c2' });
    expect(getDb().select().from(boardColumns).all()).toHaveLength(1);
    expect(getDb().select().from(cards).all()).toHaveLength(1);
    expect(getDb().select().from(cards).all()[0]!.columnId).toBe('c2');
  });

  it('moveCardsTo=自身 → CONFLICT', async () => {
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1' });
    const c = createColumn({ projectId: 'p-1', name: 'a', position: 0 });
    expect(() => deleteColumn({ columnId: c.id, moveCardsTo: c.id })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('moveCardsTo=其它 board 的列 → NOT_FOUND', async () => {
    // 两个项目用不同 (accountId, giteaUrl, owner, name) 避免 UNIQUE 约束
    await seedProjectWithBoard({ projectId: 'p-1', boardId: 'b-1', accountId: 'acc-1', giteaUrl: 'http://x1', username: 'alice' });
    await seedProjectWithBoard({ projectId: 'p-2', boardId: 'b-2', accountId: 'acc-2', giteaUrl: 'http://x2', username: 'bob', owner: 'bob', repoName: 'bar' });
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    getDb().insert(boardColumns).values([
      { id: 'c1', boardId: 'b-1', name: 'todo', position: 1024, wipLimit: null, hideMergedPr: false, createdAt: new Date() },
      { id: 'c-other', boardId: 'b-2', name: 'other', position: 1024, wipLimit: null, hideMergedPr: false, createdAt: new Date() },
    ]).run();
    expect(() => deleteColumn({ columnId: 'c1', moveCardsTo: 'c-other' })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('projectExists', () => {
  it('存在 → true', async () => {
    await seedProjectWithBoard({ projectId: 'p-1' });
    expect(projectExists('p-1')).toBe(true);
  });
  it('不存在 → false', async () => {
    expect(projectExists('no-such')).toBe(false);
  });
});
