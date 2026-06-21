/**
 * main 端 cache 层单测（v1.4 polish 测试债清理）
 *
 * 覆盖：
 * - branches / commits / pulls / timeline 四个资源的 get/set/invalidate 同模式 API
 * - timeline.makeTimelineCacheKey：branches 排序 + 字段全量拼装 + 同 key 同命中
 * - commits.getLinkedCardsFor* 4 个 stub：v1 永远返空 Map/[]
 * - branches.listStarredBranches / setStarred：跟 localStore.starredBranches 交互
 *
 * Mock 策略：
 * - 真实 initLocalStore + temp dir（GITEA_KANBAN_DATA_DIR 走 file-store 真实路径）
 * - 不引 electron / sqlite / better-sqlite3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
}));

// ===== localStore 临时初始化（每个 test 独立 tmp dir） =====
let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-cache-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
});

afterEach(async () => {
  if (savedEnv !== undefined) process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  else delete process.env['GITEA_KANBAN_DATA_DIR'];
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

const PROJECT_ID = 'p-test-uuid';
const CACHE_KEY = 'test-key-1';

describe('cache/pulls · getPullsCache / setPullsCache / invalidatePullsCache', () => {
  beforeEach(async () => {
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();
  });

  it('set 后 get 能拿到（payload 字符串）', async () => {
    const { setPullsCache, getPullsCache } = await import('../pulls.js');
    setPullsCache({ projectId: PROJECT_ID, cacheKey: CACHE_KEY, payload: '{"items":[1,2]}' });
    expect(getPullsCache({ projectId: PROJECT_ID, cacheKey: CACHE_KEY })).toBe('{"items":[1,2]}');
  });

  it('未 set 的 key → get 返 null', async () => {
    const { getPullsCache } = await import('../pulls.js');
    expect(getPullsCache({ projectId: PROJECT_ID, cacheKey: 'nonexistent' })).toBeNull();
  });

  it('invalidate（带 projectId）只清该项目', async () => {
    const { setPullsCache, getPullsCache, invalidatePullsCache } = await import('../pulls.js');
    setPullsCache({ projectId: PROJECT_ID, cacheKey: 'k1', payload: 'a' });
    setPullsCache({ projectId: 'p-other', cacheKey: 'k1', payload: 'b' });
    invalidatePullsCache(PROJECT_ID);
    expect(getPullsCache({ projectId: PROJECT_ID, cacheKey: 'k1' })).toBeNull();
    expect(getPullsCache({ projectId: 'p-other', cacheKey: 'k1' })).toBe('b');
  });

  it('invalidate（无参）清整个 resource', async () => {
    const { setPullsCache, getPullsCache, invalidatePullsCache } = await import('../pulls.js');
    setPullsCache({ projectId: PROJECT_ID, cacheKey: 'k1', payload: 'a' });
    setPullsCache({ projectId: 'p-other', cacheKey: 'k1', payload: 'b' });
    invalidatePullsCache();
    expect(getPullsCache({ projectId: PROJECT_ID, cacheKey: 'k1' })).toBeNull();
    expect(getPullsCache({ projectId: 'p-other', cacheKey: 'k1' })).toBeNull();
  });

  it('自定义 ttlSeconds 生效', async () => {
    const { setPullsCache } = await import('../pulls.js');
    // ttlSeconds=1 → 应该写到 file-store（不直接验证过期，验证不抛）
    expect(() =>
      setPullsCache({ projectId: PROJECT_ID, cacheKey: 'k', payload: 'v', ttlSeconds: 1 }),
    ).not.toThrow();
  });
});

describe('cache/commits · getCommitsCache / setCommitsCache / invalidateCommitsCache', () => {
  beforeEach(async () => {
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();
  });

  it('set 后 get 拿到（独立 resource 不污染 pulls）', async () => {
    const { setCommitsCache, getCommitsCache } = await import('../commits.js');
    setCommitsCache({ projectId: PROJECT_ID, cacheKey: CACHE_KEY, payload: '{"sha":"abc"}' });
    expect(getCommitsCache({ projectId: PROJECT_ID, cacheKey: CACHE_KEY })).toBe('{"sha":"abc"}');
  });

  it('invalidate（带 projectId）只清该项目', async () => {
    const { setCommitsCache, getCommitsCache, invalidateCommitsCache } =
      await import('../commits.js');
    setCommitsCache({ projectId: PROJECT_ID, cacheKey: 'k', payload: 'a' });
    setCommitsCache({ projectId: 'p-other', cacheKey: 'k', payload: 'b' });
    invalidateCommitsCache(PROJECT_ID);
    expect(getCommitsCache({ projectId: PROJECT_ID, cacheKey: 'k' })).toBeNull();
    expect(getCommitsCache({ projectId: 'p-other', cacheKey: 'k' })).toBe('b');
  });
});

describe('cache/timeline · getTimelineCache / setTimelineCache / makeTimelineCacheKey', () => {
  beforeEach(async () => {
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();
  });

  it('makeTimelineCacheKey：branches 排序后 join（不同顺序同命中）', async () => {
    const { makeTimelineCacheKey } = await import('../timeline.js');
    const k1 = makeTimelineCacheKey({
      projectId: 'p1',
      branches: ['main', 'dev', 'feat'],
      maxNodes: 200,
      laneMode: 'branch',
    });
    const k2 = makeTimelineCacheKey({
      projectId: 'p1',
      branches: ['feat', 'main', 'dev'], // 不同顺序
      maxNodes: 200,
      laneMode: 'branch',
    });
    expect(k1).toBe(k2);
  });

  it('makeTimelineCacheKey：字段全量拼装（任何一个变都重算）', async () => {
    const { makeTimelineCacheKey } = await import('../timeline.js');
    const base = {
      projectId: 'p1',
      branches: ['main'],
      maxNodes: 200,
      laneMode: 'branch' as const,
    };
    const k1 = makeTimelineCacheKey(base);
    const k2 = makeTimelineCacheKey({ ...base, laneMode: 'author' });
    const k3 = makeTimelineCacheKey({ ...base, since: '2026-06-01' });
    const k4 = makeTimelineCacheKey({ ...base, until: '2026-06-30' });
    const k5 = makeTimelineCacheKey({ ...base, maxNodes: 100 });
    expect(new Set([k1, k2, k3, k4, k5]).size).toBe(5);
  });

  it('set 后 get 拿到 timeline payload', async () => {
    const { setTimelineCache, getTimelineCache, makeTimelineCacheKey } =
      await import('../timeline.js');
    const key = makeTimelineCacheKey({
      projectId: PROJECT_ID,
      branches: ['main'],
      maxNodes: 200,
      laneMode: 'branch',
    });
    setTimelineCache({ projectId: PROJECT_ID, cacheKey: key, payload: '{"lanes":[]}' });
    expect(getTimelineCache({ projectId: PROJECT_ID, cacheKey: key })).toBe('{"lanes":[]}');
  });

  it('invalidateTimelineCache 清所有 timeline 缓存', async () => {
    const { setTimelineCache, getTimelineCache, invalidateTimelineCache, makeTimelineCacheKey } =
      await import('../timeline.js');
    const k1 = makeTimelineCacheKey({
      projectId: PROJECT_ID,
      branches: ['main'],
      maxNodes: 200,
      laneMode: 'branch',
    });
    const k2 = makeTimelineCacheKey({
      projectId: PROJECT_ID,
      branches: ['dev'],
      maxNodes: 200,
      laneMode: 'branch',
    });
    setTimelineCache({ projectId: PROJECT_ID, cacheKey: k1, payload: 'a' });
    setTimelineCache({ projectId: PROJECT_ID, cacheKey: k2, payload: 'b' });
    invalidateTimelineCache();
    expect(getTimelineCache({ projectId: PROJECT_ID, cacheKey: k1 })).toBeNull();
    expect(getTimelineCache({ projectId: PROJECT_ID, cacheKey: k2 })).toBeNull();
  });
});

describe('cache/commits · linkedCards stub（v1 永远返空）', () => {
  it('getLinkedCardsForCommits 返空 Map', async () => {
    const { getLinkedCardsForCommits } = await import('../commits.js');
    const m = getLinkedCardsForCommits({ owner: 'o', repo: 'r', shas: ['a', 'b'] });
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });

  it('getLinkedCardsForCommit 返空数组', async () => {
    const { getLinkedCardsForCommit } = await import('../commits.js');
    expect(getLinkedCardsForCommit({ owner: 'o', repo: 'r', sha: 'a' })).toEqual([]);
  });

  it('getLinkedCardsForPulls 返空 Map', async () => {
    const { getLinkedCardsForPulls } = await import('../commits.js');
    const m = getLinkedCardsForPulls({ owner: 'o', repo: 'r', indexes: [1, 2] });
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });

  it('getLinkedCardsForPull 返空数组', async () => {
    const { getLinkedCardsForPull } = await import('../commits.js');
    expect(getLinkedCardsForPull({ owner: 'o', repo: 'r', index: 1 })).toEqual([]);
  });
});

describe('cache/branches · listStarredBranches / setStarred + 缓存层', () => {
  beforeEach(async () => {
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();
  });

  it('空 starred 列表 → listStarredBranches 返空 Set', async () => {
    const { listStarredBranches } = await import('../branches.js');
    const s = listStarredBranches(PROJECT_ID);
    expect(s).toBeInstanceOf(Set);
    expect(s.size).toBe(0);
  });

  it('setStarred starred=true 后 list 返含该分支', async () => {
    const { setStarred, listStarredBranches } = await import('../branches.js');
    setStarred({ projectId: PROJECT_ID, branch: 'feat-x', starred: true });
    const s = listStarredBranches(PROJECT_ID);
    expect(s.has('feat-x')).toBe(true);
  });

  it('setStarred starred=false → 移除（无副作用 if 不存在）', async () => {
    const { setStarred, listStarredBranches } = await import('../branches.js');
    setStarred({ projectId: PROJECT_ID, branch: 'feat-y', starred: true });
    setStarred({ projectId: PROJECT_ID, branch: 'feat-y', starred: false });
    const s = listStarredBranches(PROJECT_ID);
    expect(s.has('feat-y')).toBe(false);
  });

  it('setBranchesCache + getBranchesCache 独立 resource', async () => {
    const { setBranchesCache, getBranchesCache, invalidateBranchesCache } =
      await import('../branches.js');
    setBranchesCache({ projectId: PROJECT_ID, cacheKey: 'b1', payload: 'data' });
    expect(getBranchesCache({ projectId: PROJECT_ID, cacheKey: 'b1' })).toBe('data');
    invalidateBranchesCache(PROJECT_ID);
    expect(getBranchesCache({ projectId: PROJECT_ID, cacheKey: 'b1' })).toBeNull();
  });
});
