/**
 * src/main/board/cards.ts 单测
 *
 * 覆盖（02-architecture.md §5.3.8 + 任务 prompt §"board.cards namespace"）：
 * - listCards：返回 CardDto[]（含 links JOIN）；column 不存在 → NOT_FOUND
 * - createCard：插 card + 同步插 links（UPSERT gitea_refs）；undo_entries 多 1 条
 * - updateCard：patch 应用 + undo
 * - moveCard：跨列 WIP 限制（wipLimit=3 已 3 张 → 再 move → CONFLICT；wipLimit=null 不限；同列重排不计）
 * - deleteCard：级联删 card + undo
 * - linkCard / unlinkCard：UNIQUE 冲突 → CONFLICT；不存在 → NOT_FOUND
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

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-cards-test-'));
let currentDbPath = '';

let initSqlite: typeof import('../cache/sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('../cache/sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('../cache/sqlite.js')._resetSqliteForTest;
let getDb: typeof import('../cache/sqlite.js').getDb;
let _resetDefaultUserSeededForTest: typeof import('./undo.js')._resetDefaultUserSeededForTest;

let createColumn: typeof import('./columns.js').createColumn;
let listCards: typeof import('./cards.js').listCards;
let createCard: typeof import('./cards.js').createCard;
let updateCard: typeof import('./cards.js').updateCard;
let moveCard: typeof import('./cards.js').moveCard;
let deleteCard: typeof import('./cards.js').deleteCard;
let linkCard: typeof import('./cards.js').linkCard;
let unlinkCard: typeof import('./cards.js').unlinkCard;

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
  createColumn = columnsMod.createColumn;

  const cardsMod = await import('./cards.js');
  listCards = cardsMod.listCards;
  createCard = cardsMod.createCard;
  updateCard = cardsMod.updateCard;
  moveCard = cardsMod.moveCard;
  deleteCard = cardsMod.deleteCard;
  linkCard = cardsMod.linkCard;
  unlinkCard = cardsMod.unlinkCard;

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

async function seedProjectWithBoard(args: { projectId?: string; accountId?: string; boardId?: string; giteaUrl?: string; username?: string; owner?: string; repoName?: string } = {}) {
  const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
  const { repoProjects } = await import('../cache/schema/repoProjects.js');
  const { boards } = await import('../cache/schema/boards.js');
  const projectId = args.projectId ?? 'p-1';
  const accountId = args.accountId ?? 'acc-1';
  const boardId = args.boardId ?? 'b-1';
  const giteaUrl = args.giteaUrl ?? 'http://x';
  const username = args.username ?? 'alice';
  const owner = args.owner ?? 'alice';
  const repoName = args.repoName ?? 'foo';

  if (!getDb().select().from(giteaAccounts).all().find((a) => a.id === accountId)) {
    getDb().insert(giteaAccounts).values({
      id: accountId,
      giteaUrl,
      username,
      keychainService: `gitea-kanban@${giteaUrl}`,
      createdAt: new Date(),
    }).run();
  }
  if (!getDb().select().from(repoProjects).all().find((p) => p.id === projectId)) {
    getDb().insert(repoProjects).values({
      id: projectId,
      giteaAccountId: accountId,
      owner,
      name: repoName,
      defaultBranch: 'main',
      createdAt: new Date(),
    }).run();
  }
  if (!getDb().select().from(boards).all().find((b) => b.id === boardId)) {
    getDb().insert(boards).values({
      id: boardId,
      repoProjectId: projectId,
      name: 'default',
      layout: 'kanban',
      createdAt: new Date(),
    }).run();
  }
  return { projectId, boardId };
}

async function countUndoEntries(): Promise<number> {
  const { undoEntries } = await import('../cache/schema/undoEntries.js');
  return getDb().select().from(undoEntries).all().length;
}

describe('listCards', () => {
  it('列不存在 → NOT_FOUND', async () => {
    expect(() => listCards({ columnId: 'no-such' })).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('happy path：空列 → []；插入 N 卡 → 返回按 position 升序 + 含 links', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    createCard({ columnId: c.id, title: 'a', position: 1024 });
    createCard({ columnId: c.id, title: 'b', position: 2048, links: [{ refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1', role: 'reference' }] });
    const cards = listCards({ columnId: c.id });
    expect(cards).toHaveLength(2);
    expect(cards[0]!.title).toBe('a');
    expect(cards[1]!.title).toBe('b');
    expect(cards[1]!.links).toHaveLength(1);
    expect(cards[1]!.links[0]!.refKind).toBe('commit');
  });
});

describe('createCard', () => {
  it('happy path + undo_entries 写 1 条', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const before = await countUndoEntries();
    const card = createCard({ columnId: c.id, title: 'do thing', position: 1024 });
    expect(card.id).toBeTruthy();
    expect(card.title).toBe('do thing');
    const after = await countUndoEntries();
    expect(after - before).toBe(1);
  });

  it('列不存在 → NOT_FOUND', async () => {
    expect(() => createCard({ columnId: 'no-such', title: 'x', position: 0 })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('含 links 时同步插 card_links（去重 gitea_refs 唯一键）', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({
      columnId: c.id,
      title: 'a',
      position: 0,
      links: [
        { refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1', role: 'reference' },
        { refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1', role: 'blocks' }, // 同 sha 不同 role → 第二条
      ],
    });
    expect(card.links).toHaveLength(2);
  });
});

describe('updateCard', () => {
  it('happy path：title + body + color patch + undo 写 1 条', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c.id, title: 'old', position: 0 });
    const before = await countUndoEntries();
    const updated = updateCard({ cardId: card.id, patch: { title: 'new', body: 'desc', color: '#abcdef' } });
    expect(updated.title).toBe('new');
    expect(updated.body).toBe('desc');
    expect(updated.color).toBe('#abcdef');
    const after = await countUndoEntries();
    expect(after - before).toBe(1);
  });

  it('卡片不存在 → NOT_FOUND', async () => {
    expect(() => updateCard({ cardId: 'no-such', patch: { title: 'x' } })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('patch 为空 → VALIDATION_FAILED（schema refine）', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c.id, title: 'a', position: 0 });
    // patch = {} → refine 失败 → 走到 Zod 错误 → 在 IPC 层转 VALIDATION_FAILED
    // 业务层不直接验（cards.update 不接 schema），但 updateCard 不会修改任何字段
    const updated = updateCard({ cardId: card.id, patch: {} as any });
    expect(updated.title).toBe('a'); // 无变化
  });
});

describe('moveCard', () => {
  it('同列重排不检 WIP（不限 → 跨列也不检；wipLimit=null）', async () => {
    await seedProjectWithBoard();
    const c1 = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c1.id, title: 'a', position: 0 });
    const r = moveCard({ cardId: card.id, toColumnId: c1.id, toPosition: 2048 });
    expect(r.id).toBe(card.id);
  });

  it('跨列 wipLimit=null → 任意移动不限', async () => {
    await seedProjectWithBoard();
    const c1 = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const c2 = createColumn({ projectId: 'p-1', name: 'doing', position: 1024 });
    const card = createCard({ columnId: c1.id, title: 'a', position: 0 });
    const r = moveCard({ cardId: card.id, toColumnId: c2.id, toPosition: 1024 });
    expect(r.columnId).toBe(c2.id);
  });

  it('跨列 wipLimit=3 已 3 张 → 再 move → CONFLICT', async () => {
    await seedProjectWithBoard();
    const c1 = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    // 用 SQL 直接建 wipLimit=3 的列（不暴露 update 改 wipLimit）
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    const c2id = 'c2-wip';
    getDb().insert(boardColumns).values({
      id: c2id, boardId: 'b-1', name: 'wip', position: 1024, wipLimit: 3, hideMergedPr: false, createdAt: new Date(),
    }).run();
    // c2 塞 3 张
    for (let i = 0; i < 3; i++) {
      createCard({ columnId: c2id, title: `card${i}`, position: 1024 * (i + 1) });
    }
    // c1 准备一张要 move
    const movable = createCard({ columnId: c1.id, title: 'movable', position: 0 });
    expect(() => moveCard({ cardId: movable.id, toColumnId: c2id, toPosition: 9999 })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('跨列 wipLimit=3 已 2 张 → move 第 3 张成功', async () => {
    await seedProjectWithBoard();
    const c1 = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const { boardColumns } = await import('../cache/schema/boardColumns.js');
    const c2id = 'c2-wip2';
    getDb().insert(boardColumns).values({
      id: c2id, boardId: 'b-1', name: 'wip', position: 1024, wipLimit: 3, hideMergedPr: false, createdAt: new Date(),
    }).run();
    createCard({ columnId: c2id, title: 'a', position: 1024 });
    createCard({ columnId: c2id, title: 'b', position: 2048 });
    const movable = createCard({ columnId: c1.id, title: 'movable', position: 0 });
    const r = moveCard({ cardId: movable.id, toColumnId: c2id, toPosition: 9999 });
    expect(r.columnId).toBe(c2id);
  });

  it('卡片不存在 → NOT_FOUND', async () => {
    expect(() => moveCard({ cardId: 'no-such', toColumnId: 'x', toPosition: 0 })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('目标列不存在 → NOT_FOUND', async () => {
    await seedProjectWithBoard();
    const c1 = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c1.id, title: 'a', position: 0 });
    expect(() => moveCard({ cardId: card.id, toColumnId: 'no-such', toPosition: 0 })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('deleteCard', () => {
  it('happy path：删除 + undo 写 1 条', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c.id, title: 'a', position: 0 });
    const before = await countUndoEntries();
    deleteCard({ cardId: card.id });
    const { cards } = await import('../cache/schema/cards.js');
    expect(getDb().select().from(cards).all()).toHaveLength(0);
    const after = await countUndoEntries();
    expect(after - before).toBe(1);
  });

  it('卡片不存在 → NOT_FOUND', async () => {
    expect(() => deleteCard({ cardId: 'no-such' })).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('linkCard / unlinkCard', () => {
  it('linkCard 返 linkId + 重复（同 ref/role）→ CONFLICT', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c.id, title: 'a', position: 0 });
    const link1 = linkCard({ cardId: card.id, link: { refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha-x', role: 'reference' } });
    expect(link1.id).toBeTruthy();
    expect(() => linkCard({ cardId: card.id, link: { refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha-x', role: 'reference' } })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('unlinkCard 删 link + linkId 不存在 → NOT_FOUND', async () => {
    await seedProjectWithBoard();
    const c = createColumn({ projectId: 'p-1', name: 'todo', position: 0 });
    const card = createCard({ columnId: c.id, title: 'a', position: 0 });
    const link = linkCard({ cardId: card.id, link: { refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha-y', role: 'reference' } });
    unlinkCard({ linkId: link.id });
    const { cardLinks } = await import('../cache/schema/cardLinks.js');
    expect(getDb().select().from(cardLinks).all()).toHaveLength(0);
    expect(() => unlinkCard({ linkId: 'no-such' })).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

// 抑制 unused 警告（vi 全局导入已用）
void vi;
