/**
 * src/main/board/undo.ts 单测
 *
 * 覆盖（任务 prompt §"撤销栈（user.undo）" + 02-architecture §5.3.9 关联）：
 * - recordUndo 写一条到 undo_entries
 * - 默认用户懒 seed（_resetDefaultUserSeededForTest 重置后首次写入自动 seed users 行）
 * - 容量裁剪：超过 20 条删最早
 * - payload JSON 序列化
 * - LIFO 顺序：createdAt DESC 取最新
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
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

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-undo-test-'));
let currentDbPath = '';

let initSqlite: typeof import('../cache/sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('../cache/sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('../cache/sqlite.js')._resetSqliteForTest;
let getDb: typeof import('../cache/sqlite.js').getDb;
let recordUndo: typeof import('./undo.js').recordUndo;
let _resetDefaultUserSeededForTest: typeof import('./undo.js')._resetDefaultUserSeededForTest;

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
  recordUndo = undoMod.recordUndo;
  _resetDefaultUserSeededForTest = undoMod._resetDefaultUserSeededForTest;
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

async function countUsers(): Promise<number> {
  const { users } = await import('../cache/schema/users.js');
  return getDb().select().from(users).all().length;
}

async function countUndoEntries(): Promise<number> {
  const { undoEntries } = await import('../cache/schema/undoEntries.js');
  return getDb().select().from(undoEntries).all().length;
}

async function getUndoEntriesByCreated(): Promise<Array<{ op: string; payload: string }>> {
  const { undoEntries } = await import('../cache/schema/undoEntries.js');
  const { desc, sql } = await import('drizzle-orm');
  // createdAt 精度为秒，25 次插入同秒时 tie-break 用 rowid DESC
  return getDb()
    .select({ op: undoEntries.op, payload: undoEntries.payload })
    .from(undoEntries)
    .orderBy(desc(undoEntries.createdAt), sql`rowid DESC`)
    .all();
}

describe('recordUndo', () => {
  it('首次写时懒 seed 默认用户（idempotent）', async () => {
    expect(await countUsers()).toBe(0);
    recordUndo({ op: 'card.create', payload: { cardId: 'k-1', before: {}, after: {} } });
    expect(await countUsers()).toBe(1);
    // 再次 recordUndo 不再 seed
    recordUndo({ op: 'card.update', payload: { cardId: 'k-1', before: {}, after: {} } });
    expect(await countUsers()).toBe(1);
  });

  it('写一条到 undo_entries（op + payload JSON 字符串）', async () => {
    recordUndo({ op: 'col.create', payload: { columnId: 'c-1', before: {}, after: { name: 'todo' } } });
    const rows = await getUndoEntriesByCreated();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe('col.create');
    const parsed = JSON.parse(rows[0]!.payload);
    expect(parsed.columnId).toBe('c-1');
    expect(parsed.after.name).toBe('todo');
  });

  it('多次写入 LIFO：最后写的 op 排第一', async () => {
    recordUndo({ op: 'col.create', payload: { columnId: 'c-1', before: {}, after: {} } });
    // 间隔 2ms 保证 createdAt 排序稳定
    await new Promise((r) => setTimeout(r, 5));
    recordUndo({ op: 'col.update', payload: { columnId: 'c-1', before: {}, after: {} } });
    await new Promise((r) => setTimeout(r, 5));
    recordUndo({ op: 'col.delete', payload: { columnId: 'c-1', before: {}, after: {} } });
    const rows = await getUndoEntriesByCreated();
    expect(rows.map((r) => r.op)).toEqual(['col.delete', 'col.update', 'col.create']);
  });

  it('容量裁剪：超 20 条只留最近 20', async () => {
    for (let i = 0; i < 25; i++) {
      recordUndo({ op: 'card.update', payload: { cardId: `k-${i}`, before: {}, after: {} } });
      // 间隔 2ms 保证 createdAt 单调
      await new Promise((r) => setTimeout(r, 2));
    }
    const total = await countUndoEntries();
    expect(total).toBe(20);
    // 保留的是最近 20 条（i=5..24）
    const rows = await getUndoEntriesByCreated();
    // rows 已经按 createdAt DESC 排序
    const cardIds = rows.map((r) => (JSON.parse(r.payload) as { cardId: string }).cardId);
    expect(cardIds).toEqual(['k-24', 'k-23', 'k-22', 'k-21', 'k-20', 'k-19', 'k-18', 'k-17', 'k-16', 'k-15', 'k-14', 'k-13', 'k-12', 'k-11', 'k-10', 'k-9', 'k-8', 'k-7', 'k-6', 'k-5']);
  });

  it('支持所有 op 类型（card / col / link 族）', async () => {
    const ops = [
      'col.create',
      'col.update',
      'col.reorder',
      'col.delete',
      'card.create',
      'card.update',
      'card.move',
      'card.delete',
      'card.link',
      'card.unlink',
    ] as const;
    for (const op of ops) {
      recordUndo({ op, payload: { test: op } });
    }
    expect(await countUndoEntries()).toBe(ops.length);
  });

  it('_resetDefaultUserSeededForTest 让下一条重走 seed（idempotent）', async () => {
    recordUndo({ op: 'card.create', payload: { cardId: 'k-1', before: {}, after: {} } });
    expect(await countUsers()).toBe(1);
    _resetDefaultUserSeededForTest();
    recordUndo({ op: 'card.update', payload: { cardId: 'k-1', before: {}, after: {} } });
    // seed 是 idempotent → user 数量仍为 1
    expect(await countUsers()).toBe(1);
  });
});
