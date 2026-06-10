/**
 * cache/pulls.ts 单测
 *
 * 覆盖：
 * - getPullsCache / setPullsCache / invalidatePullsCache
 * - 写后缓存 + 失效
 * - TTL 过期
 * - 与 commits/branches 缓存互不串
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

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-pulls-test-'));
let currentDbPath = '';

let initSqlite: typeof import('./sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('./sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('./sqlite.js')._resetSqliteForTest;

let getPullsCache: typeof import('./pulls.js').getPullsCache;
let setPullsCache: typeof import('./pulls.js').setPullsCache;
let invalidatePullsCache: typeof import('./pulls.js').invalidatePullsCache;
let getDb: typeof import('./sqlite.js').getDb;

beforeEach(async () => {
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const sqliteMod = await import('./sqlite.js');
  initSqlite = sqliteMod.initSqlite;
  _setSqlitePathForTest = sqliteMod._setSqlitePathForTest;
  _resetSqliteForTest = sqliteMod._resetSqliteForTest;
  getDb = sqliteMod.getDb;
  _setSqlitePathForTest(currentDbPath);
  await initSqlite();

  const pullsMod = await import('./pulls.js');
  getPullsCache = pullsMod.getPullsCache;
  setPullsCache = pullsMod.setPullsCache;
  invalidatePullsCache = pullsMod.invalidatePullsCache;
});

afterEach(async () => {
  await _resetSqliteForTest();
});

// seed gitea_accounts + repo_projects 以满足 cache_entries 的 FK
async function seedProject(projectId: string, owner: string, name: string) {
  const { giteaAccounts } = await import('./schema/giteaAccounts.js');
  const { repoProjects } = await import('./schema/repoProjects.js');
  const db = getDb();
  const acc = db.select().from(giteaAccounts).all().find((a) => a.id === 'cache-acc');
  if (!acc) {
    db.insert(giteaAccounts).values({
      id: 'cache-acc', giteaUrl: 'http://x', username: 'alice',
      keychainService: 'gitea-kanban@http://x', createdAt: new Date(),
    }).run();
  }
  const proj = db.select().from(repoProjects).all().find((p) => p.id === projectId);
  if (!proj) {
    db.insert(repoProjects).values({
      id: projectId, giteaAccountId: 'cache-acc',
      owner, name, defaultBranch: 'main', createdAt: new Date(),
    }).run();
  }
}

describe('getPullsCache / setPullsCache', () => {
  it('未写 → null', async () => {
    await seedProject('p-1', 'alice', 'foo');
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });

  it('写后读出', async () => {
    await seedProject('p-1', 'alice', 'foo');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: '{"x":1}' });
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('{"x":1}');
  });

  it('upsert 同 key', async () => {
    await seedProject('p-1', 'alice', 'foo');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v1' });
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v2' });
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('v2');
  });

  it('TTL 过期 → null', async () => {
    await seedProject('p-1', 'alice', 'foo');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'x', ttlSeconds: 1 });
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('x');
    await new Promise((r) => setTimeout(r, 1100));
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });

  it('pulls 缓存与 commits / branches 缓存互不串', async () => {
    await seedProject('p-1', 'alice', 'foo');
    const { setCommitsCache, getCommitsCache } = await import('./commits.js');
    const { setBranchesCache, getBranchesCache } = await import('./branches.js');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'pulls-v' });
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'commits-v' });
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'branches-v' });
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('pulls-v');
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('commits-v');
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('branches-v');
  });
});

describe('invalidatePullsCache', () => {
  it('按 projectId 失效：只清该项目', async () => {
    await seedProject('p-1', 'alice', 'foo');
    await seedProject('p-2', 'bob', 'bar');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v1' });
    setPullsCache({ projectId: 'p-2', cacheKey: 'k', payload: 'v2' });
    invalidatePullsCache('p-1');
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
    expect(getPullsCache({ projectId: 'p-2', cacheKey: 'k' })).toBe('v2');
  });

  it('不带 projectId → 清所有 pulls 资源缓存', async () => {
    await seedProject('p-1', 'alice', 'foo');
    await seedProject('p-2', 'bob', 'bar');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k1', payload: 'v1' });
    setPullsCache({ projectId: 'p-2', cacheKey: 'k2', payload: 'v2' });
    invalidatePullsCache();
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k1' })).toBeNull();
    expect(getPullsCache({ projectId: 'p-2', cacheKey: 'k2' })).toBeNull();
  });

  it('invalidate 不影响 commits / branches 缓存', async () => {
    await seedProject('p-1', 'alice', 'foo');
    const { setCommitsCache, getCommitsCache } = await import('./commits.js');
    const { setBranchesCache, getBranchesCache } = await import('./branches.js');
    setPullsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'pulls-v' });
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'commits-v' });
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'branches-v' });
    invalidatePullsCache('p-1');
    expect(getPullsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('commits-v');
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('branches-v');
  });
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
