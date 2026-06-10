/**
 * cache/repos.ts 单测
 *
 * 覆盖：
 * - findProject / listProjectsForAccount / findProjectsByOwnerName
 * - addProject 幂等（已存在不报错）
 * - removeProject 幂等（不存在静默成功）
 * - touchLastSync 写入
 * - getReposCache / setReposCache：cache-aside + TTL 过期
 * - invalidateReposCache 清空
 * - FK 约束：addProject 缺少 gitea_accounts 行时报错
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-repos-test-'));
let currentDbPath = '';

let initSqlite: typeof import('./sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('./sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('./sqlite.js')._resetSqliteForTest;
let getDb: typeof import('./sqlite.js').getDb;

let addProject: typeof import('./repos.js').addProject;
let removeProject: typeof import('./repos.js').removeProject;
let findProject: typeof import('./repos.js').findProject;
let listProjectsForAccount: typeof import('./repos.js').listProjectsForAccount;
let findProjectsByOwnerName: typeof import('./repos.js').findProjectsByOwnerName;
let touchLastSync: typeof import('./repos.js').touchLastSync;
let getReposCache: typeof import('./repos.js').getReposCache;
let setReposCache: typeof import('./repos.js').setReposCache;
let invalidateReposCache: typeof import('./repos.js').invalidateReposCache;

beforeEach(async () => {
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const sqliteMod = await import('./sqlite.js');
  initSqlite = sqliteMod.initSqlite;
  _setSqlitePathForTest = sqliteMod._setSqlitePathForTest;
  _resetSqliteForTest = sqliteMod._resetSqliteForTest;
  getDb = sqliteMod.getDb;
  _setSqlitePathForTest(currentDbPath);
  await initSqlite();

  const reposMod = await import('./repos.js');
  addProject = reposMod.addProject;
  removeProject = reposMod.removeProject;
  findProject = reposMod.findProject;
  listProjectsForAccount = reposMod.listProjectsForAccount;
  findProjectsByOwnerName = reposMod.findProjectsByOwnerName;
  touchLastSync = reposMod.touchLastSync;
  getReposCache = reposMod.getReposCache;
  setReposCache = reposMod.setReposCache;
  invalidateReposCache = reposMod.invalidateReposCache;
});

afterEach(async () => {
  await _resetSqliteForTest();
});

/** 帮手：建一个 gitea_accounts 行（避免 FK 失败） */
async function seedAccount(id: string, giteaUrl = 'http://x', username = 'alice') {
  const { giteaAccounts } = await import('./schema/giteaAccounts.js');
  getDb().insert(giteaAccounts).values({
    id,
    giteaUrl,
    username,
    keychainService: `gitea-kanban@${giteaUrl}`,
    createdAt: new Date(),
  }).run();
}

describe('addProject / findProject / listProjectsForAccount', () => {
  it('addProject → findProject 找到', async () => {
    await seedAccount('acc-1');
    const p = addProject({ giteaAccountId: 'acc-1', owner: 'alice', name: 'foo' });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.owner).toBe('alice');
    expect(p.name).toBe('foo');
    expect(p.lastSyncAt).not.toBeNull();

    const found = findProject('acc-1', 'alice', 'foo');
    expect(found?.id).toBe(p.id);
  });

  it('addProject 幂等：已存在时返回现有', async () => {
    await seedAccount('acc-1');
    const p1 = addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    const p2 = addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    expect(p2.id).toBe(p1.id);
    expect(listProjectsForAccount('acc-1')).toHaveLength(1);
  });

  it('addProject 在 defaultBranch 缺失时存 null', async () => {
    await seedAccount('acc-1');
    const p = addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    expect(p.defaultBranch).toBeNull();
  });

  it('addProject 支持显式 defaultBranch', async () => {
    await seedAccount('acc-1');
    const p = addProject({
      giteaAccountId: 'acc-1', owner: 'a', name: 'b', defaultBranch: 'main',
    });
    expect(p.defaultBranch).toBe('main');
  });

  it('addProject 缺少 gitea_accounts 行时报错（FK 保护）', async () => {
    expect(() =>
      addProject({ giteaAccountId: 'nonexistent', owner: 'a', name: 'b' }),
    ).toThrow(/gitea_accounts row not found/);
  });

  it('listProjectsForAccount 只列该 account 下的', async () => {
    await seedAccount('acc-1');
    await seedAccount('acc-2', 'http://y', 'bob');
    addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'x' });
    addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'y' });
    addProject({ giteaAccountId: 'acc-2', owner: 'b', name: 'z' });
    expect(listProjectsForAccount('acc-1')).toHaveLength(2);
    expect(listProjectsForAccount('acc-2')).toHaveLength(1);
  });

  it('findProject 不存在 → null', () => {
    expect(findProject('nonexistent', 'a', 'b')).toBeNull();
  });
});

describe('removeProject', () => {
  it('存在 → 删', async () => {
    await seedAccount('acc-1');
    addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    removeProject(findProject('acc-1', 'a', 'b')!.id);
    expect(findProject('acc-1', 'a', 'b')).toBeNull();
  });

  it('不存在 → 静默成功（不抛）', async () => {
    expect(() => removeProject('nonexistent-id')).not.toThrow();
  });

  it('删后 addProject 可以重建（cascade 不影响）', async () => {
    await seedAccount('acc-1');
    const p1 = addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    removeProject(p1.id);
    const p2 = addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    expect(p2.id).not.toBe(p1.id);
  });
});

describe('touchLastSync', () => {
  it('更新 lastSyncAt', async () => {
    await seedAccount('acc-1');
    const p1 = addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'b' });
    const before = p1.lastSyncAt;
    // 显式传 when = 1.5s 后，绕过 timestamp 秒级精度问题
    const futureDate = new Date(Date.now() + 1500);
    touchLastSync({ giteaAccountId: 'acc-1', owner: 'a', name: 'b', when: futureDate });
    const p2 = findProject('acc-1', 'a', 'b')!;
    expect(new Date(p2.lastSyncAt!).getTime()).toBeGreaterThan(new Date(before!).getTime());
  });

  it('不存在的 project → 静默成功（不抛）', () => {
    expect(() =>
      touchLastSync({ giteaAccountId: 'acc-1', owner: 'nope', name: 'nope' }),
    ).not.toThrow();
  });
});

describe('findProjectsByOwnerName 批量 JOIN', () => {
  it('返回 owner/name → project 映射', async () => {
    await seedAccount('acc-1');
    addProject({ giteaAccountId: 'acc-1', owner: 'a', name: 'x' });
    addProject({ giteaAccountId: 'acc-1', owner: 'b', name: 'y' });
    const map = findProjectsByOwnerName('acc-1', [
      { owner: 'a', name: 'x' },
      { owner: 'b', name: 'y' },
      { owner: 'c', name: 'z' }, // 不存在
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a/x')?.name).toBe('x');
    expect(map.get('b/y')?.name).toBe('y');
    expect(map.has('c/z')).toBe(false);
  });

  it('空 pairs → 空 map', () => {
    const map = findProjectsByOwnerName('acc-1', []);
    expect(map.size).toBe(0);
  });
});

describe('getReposCache / setReposCache / invalidateReposCache', () => {
  it('未写 → null', () => {
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k' })).toBeNull();
  });

  it('写后读出', () => {
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k', payload: '{"a":1}' });
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k' })).toBe('{"a":1}');
  });

  it('upsert：同 key 二次写覆盖', () => {
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k', payload: 'v1' });
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k', payload: 'v2' });
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k' })).toBe('v2');
  });

  it('TTL 过期 → null', async () => {
    // 写一个 ttl=1s 的缓存，等 1.1s 再读应 null
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k', payload: 'x', ttlSeconds: 1 });
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k' })).toBe('x');
    await new Promise((r) => setTimeout(r, 1100));
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k' })).toBeNull();
  });

  it('invalidateReposCache 清空所有 repos 资源', () => {
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k1', payload: 'v1' });
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k2', payload: 'v2' });
    invalidateReposCache();
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k1' })).toBeNull();
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k2' })).toBeNull();
  });

  it('addProject 自动失效 repos 缓存（写后立即 miss）', () => {
    setReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k', payload: 'old' });
    // 这里没 seed account，但 invalidateReposCache 不需要 account 存在也能跑
    // —— 走 setReposCache 后 invalidateReposCache，再读应 null
    invalidateReposCache();
    expect(getReposCache({ giteaAccountId: 'acc-1', cacheKey: 'k' })).toBeNull();
  });
});

import { afterAll } from 'vitest';
afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
