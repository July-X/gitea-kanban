/**
 * src/main/cache/timeline.ts 单测
 *
 * 覆盖（任务 prompt §关键约束 13 + 02-architecture §5.3.4）：
 * - makeTimelineCacheKey：branches 顺序不影响（sorted）；since/until 变化；laneMode 变化；maxNodes 变化
 * - getTimelineCache / setTimelineCache：round-trip + TTL 过期
 * - invalidateTimelineCache：按 projectId 删 / 全删
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (k: string) => {
      throw new Error(`electron.getPath(${k}) not mocked in test`);
    },
  },
}));

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-cache-timeline-test-'));
let currentDbPath = '';

let initSqlite: typeof import('../cache/sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('../cache/sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('../cache/sqlite.js')._resetSqliteForTest;
let getDb: typeof import('../cache/sqlite.js').getDb;
let makeTimelineCacheKey: typeof import('./timeline.js').makeTimelineCacheKey;
let getTimelineCache: typeof import('./timeline.js').getTimelineCache;
let setTimelineCache: typeof import('./timeline.js').setTimelineCache;
let invalidateTimelineCache: typeof import('./timeline.js').invalidateTimelineCache;
let TIMELINE_TTL_SECONDS: number;

async function seedProject(projectId: string, name: string) {
  const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
  const { repoProjects } = await import('../cache/schema/repoProjects.js');
  if (!getDb().select().from(giteaAccounts).all().find((a) => a.id === 'acc-1')) {
    getDb().insert(giteaAccounts).values({
      id: 'acc-1',
      giteaUrl: 'http://x',
      username: 'alice',
      keychainService: 'gitea-kanban@http://x',
      createdAt: new Date(),
    }).run();
  }
  if (!getDb().select().from(repoProjects).all().find((p) => p.id === projectId)) {
    getDb().insert(repoProjects).values({
      id: projectId,
      giteaAccountId: 'acc-1',
      owner: 'alice',
      name,
      defaultBranch: 'main',
      createdAt: new Date(),
    }).run();
  }
}

beforeEach(async () => {
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const sqliteMod = await import('../cache/sqlite.js');
  initSqlite = sqliteMod.initSqlite;
  _setSqlitePathForTest = sqliteMod._setSqlitePathForTest;
  _resetSqliteForTest = sqliteMod._resetSqliteForTest;
  getDb = sqliteMod.getDb;
  _setSqlitePathForTest(currentDbPath);
  await initSqlite();

  const tlMod = await import('./timeline.js');
  makeTimelineCacheKey = tlMod.makeTimelineCacheKey;
  getTimelineCache = tlMod.getTimelineCache;
  setTimelineCache = tlMod.setTimelineCache;
  invalidateTimelineCache = tlMod.invalidateTimelineCache;
  TIMELINE_TTL_SECONDS = tlMod.TIMELINE_TTL_SECONDS;

  // 不同 name 避免 (account, owner, name) UNIQUE 冲突
  await seedProject('p-1', 'foo');
  await seedProject('p-2', 'bar');
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

const baseArgs = {
  projectId: 'p-1',
  branches: ['main'],
  since: undefined as string | undefined,
  until: undefined as string | undefined,
  maxNodes: 500,
  laneMode: 'branch' as const,
};

describe('makeTimelineCacheKey', () => {
  it('branches 顺序不影响（同 sorted 结果）', () => {
    const a = makeTimelineCacheKey({ ...baseArgs, branches: ['main', 'feature/a', 'feature/b'] });
    const b = makeTimelineCacheKey({ ...baseArgs, branches: ['feature/b', 'main', 'feature/a'] });
    expect(a).toBe(b);
  });

  it('branches 不同 → key 不同', () => {
    const a = makeTimelineCacheKey({ ...baseArgs, branches: ['main'] });
    const b = makeTimelineCacheKey({ ...baseArgs, branches: ['dev'] });
    expect(a).not.toBe(b);
  });

  it('since/until 变化 → key 不同', () => {
    const a = makeTimelineCacheKey({ ...baseArgs, since: '2026-01-01T00:00:00.000Z' });
    const b = makeTimelineCacheKey({ ...baseArgs, since: '2026-02-01T00:00:00.000Z' });
    expect(a).not.toBe(b);
  });

  it('laneMode 变化 → key 不同', () => {
    const a = makeTimelineCacheKey({ ...baseArgs, laneMode: 'branch' });
    const b = makeTimelineCacheKey({ ...baseArgs, laneMode: 'author' });
    const c = makeTimelineCacheKey({ ...baseArgs, laneMode: 'pr' });
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('maxNodes 变化 → key 不同', () => {
    const a = makeTimelineCacheKey({ ...baseArgs, maxNodes: 100 });
    const b = makeTimelineCacheKey({ ...baseArgs, maxNodes: 500 });
    expect(a).not.toBe(b);
  });

  it('projectId 变化 → key 不同', () => {
    const a = makeTimelineCacheKey({ ...baseArgs, projectId: 'p-1' });
    const b = makeTimelineCacheKey({ ...baseArgs, projectId: 'p-2' });
    expect(a).not.toBe(b);
  });
});

describe('getTimelineCache / setTimelineCache', () => {
  it('set 后 get 返 JSON 字符串', () => {
    const payload = { range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' }, lanes: [], nodes: [], edges: [], prs: [], truncated: false, totalCommits: 0 };
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: payload as any });
    const got = getTimelineCache({ projectId: 'p-1', cacheKey: 'k1' });
    expect(got).not.toBeNull();
    const parsed = JSON.parse(got!);
    expect(parsed.totalCommits).toBe(0);
  });

  it('未命中 → null', () => {
    expect(getTimelineCache({ projectId: 'p-1', cacheKey: 'nope' })).toBeNull();
  });

  it('不同 projectId 不互相命中', () => {
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 1 } as any });
    expect(getTimelineCache({ projectId: 'p-2', cacheKey: 'k1' })).toBeNull();
  });

  it('set 同 key 第二次 → update（不 insert 新行）', async () => {
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 1 } as any });
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 2 } as any });
    const { cacheEntries } = await import('../cache/schema/cacheEntries.js');
    const rows = getDb()
      .select()
      .from(cacheEntries)
      .where(and(eq(cacheEntries.repoProjectId, 'p-1'), eq(cacheEntries.key, 'k1'), eq(cacheEntries.resource, 'timeline')))
      .all();
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!.payload);
    expect(parsed.totalCommits).toBe(2);
  });

  it('TTL 默认 30s', () => {
    expect(TIMELINE_TTL_SECONDS).toBe(30);
  });

  it('TTL 过期 → 返 null（手动把 fetchedAt 改到 60s 前）', async () => {
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 1 } as any });
    const { cacheEntries } = await import('../cache/schema/cacheEntries.js');
    getDb()
      .update(cacheEntries)
      .set({ fetchedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(cacheEntries.repoProjectId, 'p-1'), eq(cacheEntries.key, 'k1')))
      .run();
    expect(getTimelineCache({ projectId: 'p-1', cacheKey: 'k1' })).toBeNull();
  });

  it('TTL 范围内 → 仍命中', () => {
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 1 } as any });
    expect(getTimelineCache({ projectId: 'p-1', cacheKey: 'k1' })).not.toBeNull();
  });
});

describe('invalidateTimelineCache', () => {
  it('按 projectId 删 → 该 project 缓存清空，其它 project 不动', () => {
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 1 } as any });
    setTimelineCache({ projectId: 'p-2', cacheKey: 'k1', payload: { totalCommits: 2 } as any });
    invalidateTimelineCache('p-1');
    expect(getTimelineCache({ projectId: 'p-1', cacheKey: 'k1' })).toBeNull();
    expect(getTimelineCache({ projectId: 'p-2', cacheKey: 'k1' })).not.toBeNull();
  });

  it('不传 projectId → 清所有 timeline 缓存', () => {
    setTimelineCache({ projectId: 'p-1', cacheKey: 'k1', payload: { totalCommits: 1 } as any });
    setTimelineCache({ projectId: 'p-2', cacheKey: 'k1', payload: { totalCommits: 2 } as any });
    invalidateTimelineCache();
    expect(getTimelineCache({ projectId: 'p-1', cacheKey: 'k1' })).toBeNull();
    expect(getTimelineCache({ projectId: 'p-2', cacheKey: 'k1' })).toBeNull();
  });
});
