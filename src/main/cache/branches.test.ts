/**
 * cache/branches.ts 单测
 *
 * 覆盖：
 * - listStarredBranches
 * - setStarred UPSERT/DELETE
 * - getBranchesCache / setBranchesCache / invalidateBranchesCache
 * - 写后缓存失效
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

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-branches-test-'));
let currentDbPath = '';

let initSqlite: typeof import('./sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('./sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('./sqlite.js')._resetSqliteForTest;
let getDb: typeof import('./sqlite.js').getDb;

let listStarredBranches: typeof import('./branches.js').listStarredBranches;
let setStarred: typeof import('./branches.js').setStarred;
let getBranchesCache: typeof import('./branches.js').getBranchesCache;
let setBranchesCache: typeof import('./branches.js').setBranchesCache;
let invalidateBranchesCache: typeof import('./branches.js').invalidateBranchesCache;

beforeEach(async () => {
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const sqliteMod = await import('./sqlite.js');
  initSqlite = sqliteMod.initSqlite;
  _setSqlitePathForTest = sqliteMod._setSqlitePathForTest;
  _resetSqliteForTest = sqliteMod._resetSqliteForTest;
  getDb = sqliteMod.getDb;
  _setSqlitePathForTest(currentDbPath);
  await initSqlite();

  const branchesMod = await import('./branches.js');
  listStarredBranches = branchesMod.listStarredBranches;
  setStarred = branchesMod.setStarred;
  getBranchesCache = branchesMod.getBranchesCache;
  setBranchesCache = branchesMod.setBranchesCache;
  invalidateBranchesCache = branchesMod.invalidateBranchesCache;
});

afterEach(async () => {
  await _resetSqliteForTest();
});

async function seedProject(projectId: string, giteaAccountId = 'acc-1', repoName = 'foo') {
  const { giteaAccounts } = await import('./schema/giteaAccounts.js');
  const { repoProjects } = await import('./schema/repoProjects.js');
  // seed account if not exists
  const existing = getDb().select().from(giteaAccounts).all().find((a) => a.id === giteaAccountId);
  if (!existing) {
    getDb().insert(giteaAccounts).values({
      id: giteaAccountId,
      giteaUrl: 'http://x',
      username: 'alice',
      keychainService: 'gitea-kanban@http://x',
      createdAt: new Date(),
    }).run();
  }
  // seed repoProject if not exists（按 (giteaAccountId, owner, name) UNIQUE 索引查）
  const existingProj = getDb().select().from(repoProjects).all().find(
    (p) => p.giteaAccountId === giteaAccountId && p.owner === 'alice' && p.name === repoName,
  );
  if (!existingProj) {
    getDb().insert(repoProjects).values({
      id: projectId,
      giteaAccountId,
      owner: 'alice',
      name: repoName,
      defaultBranch: 'main',
      lastSyncAt: new Date(),
      createdAt: new Date(),
    }).run();
  }
}

describe('setStarred + listStarredBranches', () => {
  it('star=true → INSERT → 列表里有', async () => {
    await seedProject('p-1');
    setStarred({ projectId: 'p-1', branch: 'main', starred: true });
    expect(listStarredBranches('p-1').has('main')).toBe(true);
  });

  it('star=false → 不存在时 DELETE 静默', async () => {
    await seedProject('p-1');
    expect(() =>
      setStarred({ projectId: 'p-1', branch: 'main', starred: false }),
    ).not.toThrow();
    expect(listStarredBranches('p-1').size).toBe(0);
  });

  it('star=true 再 star=true → 幂等', async () => {
    await seedProject('p-1');
    setStarred({ projectId: 'p-1', branch: 'main', starred: true });
    setStarred({ projectId: 'p-1', branch: 'main', starred: true });
    expect(listStarredBranches('p-1').size).toBe(1);
  });

  it('star=true → star=false → DELETE', async () => {
    await seedProject('p-1');
    setStarred({ projectId: 'p-1', branch: 'main', starred: true });
    setStarred({ projectId: 'p-1', branch: 'main', starred: false });
    expect(listStarredBranches('p-1').has('main')).toBe(false);
  });

  it('多个 project 互不干扰', async () => {
    // 注意：repo_projects 唯一索引 (giteaAccountId, owner, name)，
    // 多 project 必须用不同 (owner, name)，不能两个都用默认 'alice/foo'
    await seedProject('p-1', 'acc-1', 'repo1');
    await seedProject('p-2', 'acc-1', 'repo2');
    setStarred({ projectId: 'p-1', branch: 'main', starred: true });
    setStarred({ projectId: 'p-1', branch: 'feat', starred: true });
    setStarred({ projectId: 'p-2', branch: 'main', starred: true });
    expect(listStarredBranches('p-1').size).toBe(2);
    expect(listStarredBranches('p-2').size).toBe(1);
  });
});

describe('getBranchesCache / setBranchesCache', () => {
  it('未写 → null', async () => {
    await seedProject('p-1');
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });

  it('写后读出', async () => {
    await seedProject('p-1');
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: '{"x":1}' });
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('{"x":1}');
  });

  it('upsert 同 key', async () => {
    await seedProject('p-1');
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v1' });
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v2' });
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('v2');
  });

  it('TTL 过期 → null', async () => {
    await seedProject('p-1');
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'x', ttlSeconds: 1 });
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('x');
    await new Promise((r) => setTimeout(r, 1100));
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });
});

describe('invalidateBranchesCache', () => {
  it('按 projectId 失效：只清该项目', async () => {
    await seedProject('p-1', 'acc-1', 'foo');
    await seedProject('p-2', 'acc-1', 'bar');
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v1' });
    setBranchesCache({ projectId: 'p-2', cacheKey: 'k', payload: 'v2' });
    invalidateBranchesCache('p-1');
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
    expect(getBranchesCache({ projectId: 'p-2', cacheKey: 'k' })).toBe('v2');
  });

  it('不带 projectId → 清所有 branches 资源缓存', async () => {
    await seedProject('p-1', 'acc-1', 'foo');
    await seedProject('p-2', 'acc-1', 'bar');
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k1', payload: 'v1' });
    setBranchesCache({ projectId: 'p-2', cacheKey: 'k2', payload: 'v2' });
    invalidateBranchesCache();
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k1' })).toBeNull();
    expect(getBranchesCache({ projectId: 'p-2', cacheKey: 'k2' })).toBeNull();
  });

  it('setStarred 触发 invalidateBranchesCache（写后立即 miss）', async () => {
    await seedProject('p-1');
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'old' });
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('old');
    setStarred({ projectId: 'p-1', branch: 'main', starred: true });
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
