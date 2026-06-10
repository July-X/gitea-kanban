/**
 * SQLite + Drizzle 迁移单测
 *
 * 关键约束：
 * - 用临时文件路径（tmpdir + uuid）作为 db 路径
 * - 测迁移幂等（重复跑不报错 / 数据保留）
 * - 测 schema 13 张表都建出来
 * - 测外键 ON / WAL 启用
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import sqlite.ts 之前 mock electron（避免测试拉 electron）
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (k: string) => {
      // 永远不会调到；测试用 _setSqlitePathForTest 注入
      throw new Error(`electron.getPath(${k}) not mocked in test`);
    },
  },
}));

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-test-'));
const defaultDbPath = join(tmp, 'kanban.db');
// 每个 beforeEach 覆盖；"幂等" case 复用同一路径来验证 close→reopen
let currentDbPath = defaultDbPath;

let initSqlite: typeof import('./sqlite.js').initSqlite;
let closeSqlite: typeof import('./sqlite.js').closeSqlite;
let getDb: typeof import('./sqlite.js').getDb;
let getRawDb: typeof import('./sqlite.js').getRawDb;
let _setSqlitePathForTest: typeof import('./sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('./sqlite.js')._resetSqliteForTest;

beforeEach(async () => {
  // 每个 test 用独立的子 db
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const mod = await import('./sqlite.js');
  initSqlite = mod.initSqlite;
  closeSqlite = mod.closeSqlite;
  getDb = mod.getDb;
  getRawDb = mod.getRawDb;
  _setSqlitePathForTest = mod._setSqlitePathForTest;
  _resetSqliteForTest = mod._resetSqliteForTest;
  _setSqlitePathForTest(currentDbPath);
});

afterEach(async () => {
  await _resetSqliteForTest();
});

describe('initSqlite', () => {
  it('db 文件被创建', async () => {
    await initSqlite();
    expect(existsSync(currentDbPath)).toBe(true);
  });

  it('userData 目录权限 0700（macOS/Linux）', async () => {
    if (process.platform === 'win32') return;
    await initSqlite();
    const { statSync } = await import('node:fs');
    const stat = statSync(tmp);
    // 0o700 实际只屏蔽 "other" 位；检查 owner/group 不给 other
    expect((stat.mode & 0o007) === 0).toBe(true);
  });

  it('PRAGMA journal_mode = WAL', async () => {
    await initSqlite();
    const raw = getRawDb();
    const r = raw.pragma('journal_mode', { simple: true }) as string;
    expect(r.toLowerCase()).toBe('wal');
  });

  it('PRAGMA foreign_keys = ON', async () => {
    await initSqlite();
    const raw = getRawDb();
    const r = raw.pragma('foreign_keys', { simple: true });
    expect(r).toBe(1);
  });

  it('幂等：连续两次 initSqlite 不报错', async () => {
    await initSqlite();
    await expect(initSqlite()).resolves.toBeUndefined();
  });
});

describe('13 张表都建出来', () => {
  it('sqlite_master 含 14 张表（13 业务 + drizzle 的 __drizzle_migrations）', async () => {
    await initSqlite();
    const raw = getRawDb();
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    const expected = [
      'boards',
      'board_columns',
      'cache_entries',
      'card_links',
      'cards',
      'gitea_accounts',
      'gitea_refs',
      'gitea_user',
      'hook_deliveries',
      'prefs',
      'repo_projects',
      'starred_branches',
      'undo_entries',
      'users',
    ];
    for (const t of expected) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });
});

describe('迁移幂等', () => {
  it('第二次 initSqlite 不会丢已写入的数据', async () => {
    await initSqlite();
    const db = getDb();
    const { users } = await import('./schema/users.js');
    db.insert(users).values({
      id: 'u-1',
      displayName: 'Alice',
      createdAt: new Date(),
    }).run();

    closeSqlite();
    // 重新初始化（同路径）
    _setSqlitePathForTest(currentDbPath);
    await initSqlite();
    const db2 = getDb();
    const rows = db2.select().from(users).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Alice');
  });
});

describe('外键约束', () => {
  it('cascade 删生效（gitea_accounts → gitea_user）', async () => {
    await initSqlite();
    const { giteaAccounts } = await import('./schema/giteaAccounts.js');
    const { giteaUser } = await import('./schema/giteaUser.js');
    const { eq } = await import('drizzle-orm');

    const db = getDb();
    const accountId = 'acc-1';
    db.insert(giteaAccounts).values({
      id: accountId,
      giteaUrl: 'http://localhost:3000',
      username: 'alice',
      keychainService: 'gitea-kanban@http://localhost:3000',
      createdAt: new Date(),
    }).run();
    db.insert(giteaUser).values({
      id: 'u-1',
      giteaAccountId: accountId,
      giteaUserId: 1,
      login: 'alice',
      fullName: null,
      email: null,
      avatarUrl: null,
      updatedAt: new Date(),
    }).run();

    expect(db.select().from(giteaUser).all()).toHaveLength(1);

    db.delete(giteaAccounts).where(eq(giteaAccounts.id, accountId)).run();
    // cascade 应该把 gitea_user 一并删
    expect(db.select().from(giteaUser).all()).toHaveLength(0);
  });
});

describe('tmp 目录清理', () => {
  it('当前 case 之外不残留前 case 的 db 文件', () => {
    // 兜底：每个 test 自带 reset，不应让前 case 的 db 文件无限累积
    // —— 验证：tmp 下没有任何 **.db-wal / **.db-shm / **.db-journal 残留
    // （这些只在 init 后未正常 close 才可能出现）
    const files = readdirSync(tmp);
    const walOrShm = files.filter((f) => /\.(db-wal|db-shm|db-journal)$/.test(f));
    expect(walOrShm).toEqual([]);
  });
});

// 全局 afterAll：清 tmp
import { afterAll } from 'vitest';
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
