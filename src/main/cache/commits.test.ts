/**
 * cache/commits.ts 单测
 *
 * 覆盖：
 * - getLinkedCardsForCommits / getLinkedCardsForPulls 关联查询
 *   - LEFT JOIN 即使 cards/boardColumns 缺失也返空数组
 *   - 一个 refId 关联多个 card
 *   - 多个 refId 一次查
 *   - 空 refIds → 空 Map
 *   - owner/repo 维度不串
 * - getCommitsCache / setCommitsCache / invalidateCommitsCache
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

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-commits-test-'));
let currentDbPath = '';

let initSqlite: typeof import('./sqlite.js').initSqlite;
let _setSqlitePathForTest: typeof import('./sqlite.js')._setSqlitePathForTest;
let _resetSqliteForTest: typeof import('./sqlite.js')._resetSqliteForTest;
let getDb: typeof import('./sqlite.js').getDb;

let getLinkedCardsForCommits: typeof import('./commits.js').getLinkedCardsForCommits;
let getLinkedCardsForPulls: typeof import('./commits.js').getLinkedCardsForPulls;
let getLinkedCardsForCommit: typeof import('./commits.js').getLinkedCardsForCommit;
let getLinkedCardsForPull: typeof import('./commits.js').getLinkedCardsForPull;
let getCommitsCache: typeof import('./commits.js').getCommitsCache;
let setCommitsCache: typeof import('./commits.js').setCommitsCache;
let invalidateCommitsCache: typeof import('./commits.js').invalidateCommitsCache;

beforeEach(async () => {
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  const sqliteMod = await import('./sqlite.js');
  initSqlite = sqliteMod.initSqlite;
  _setSqlitePathForTest = sqliteMod._setSqlitePathForTest;
  _resetSqliteForTest = sqliteMod._resetSqliteForTest;
  getDb = sqliteMod.getDb;
  _setSqlitePathForTest(currentDbPath);
  await initSqlite();

  const commitsMod = await import('./commits.js');
  getLinkedCardsForCommits = commitsMod.getLinkedCardsForCommits;
  getLinkedCardsForPulls = commitsMod.getLinkedCardsForPulls;
  getLinkedCardsForCommit = commitsMod.getLinkedCardsForCommit;
  getLinkedCardsForPull = commitsMod.getLinkedCardsForPull;
  getCommitsCache = commitsMod.getCommitsCache;
  setCommitsCache = commitsMod.setCommitsCache;
  invalidateCommitsCache = commitsMod.invalidateCommitsCache;
});

afterEach(async () => {
  await _resetSqliteForTest();
});

// ===== seed helper =====

async function seedCardLink(args: {
  refKind: 'commit' | 'pr';
  owner: string;
  repo: string;
  refId: string;
  cardId: string;
  columnName: string;
}) {
  const { giteaRefs } = await import('./schema/giteaRefs.js');
  const { cardLinks } = await import('./schema/cardLinks.js');
  const { cards } = await import('./schema/cards.js');
  const { boardColumns } = await import('./schema/boardColumns.js');
  const { boards } = await import('./schema/boards.js');
  const { repoProjects } = await import('./schema/repoProjects.js');
  const { giteaAccounts } = await import('./schema/giteaAccounts.js');

  const db = getDb();
  // seed account + repoProject（避免 FK 失败；实际关联查询不依赖）
  const acc = db.select().from(giteaAccounts).all().find((a) => a.id === 'acc-1');
  if (!acc) {
    db.insert(giteaAccounts).values({
      id: 'acc-1', giteaUrl: 'http://x', username: 'alice',
      keychainService: 'gitea-kanban@http://x', createdAt: new Date(),
    }).run();
  }
  const proj = db.select().from(repoProjects).all().find(
    (p) => p.giteaAccountId === 'acc-1' && p.owner === args.owner && p.name === args.repo,
  );
  if (!proj) {
    db.insert(repoProjects).values({
      id: `proj-${args.owner}-${args.repo}`,
      giteaAccountId: 'acc-1',
      owner: args.owner, name: args.repo, defaultBranch: 'main',
      createdAt: new Date(),
    }).run();
  }
  const board = db.select().from(boards).all().find((b) => b.repoProjectId === `proj-${args.owner}-${args.repo}`);
  if (!board) {
    db.insert(boards).values({
      id: `board-${args.owner}-${args.repo}`,
      repoProjectId: `proj-${args.owner}-${args.repo}`,
      name: 'main', layout: 'kanban', createdAt: new Date(),
    }).run();
  }
  const colId = `col-${args.columnName}-${args.cardId}`;
  const col = db.select().from(boardColumns).all().find((c) => c.id === colId);
  if (!col) {
    db.insert(boardColumns).values({
      id: colId, boardId: `board-${args.owner}-${args.repo}`,
      name: args.columnName, position: 0, createdAt: new Date(),
    }).run();
  }
  const card = db.select().from(cards).all().find((c) => c.id === args.cardId);
  if (!card) {
    db.insert(cards).values({
      id: args.cardId, columnId: colId,
      title: 'card', position: 0, createdAt: new Date(), updatedAt: new Date(),
    }).run();
  }
  const refId = `ref-${args.refKind}-${args.owner}-${args.repo}-${args.refId}`;
  const ref = db.select().from(giteaRefs).all().find((r) => r.id === refId);
  if (!ref) {
    db.insert(giteaRefs).values({
      id: refId, kind: args.refKind, owner: args.owner, repo: args.repo,
      refId: args.refId, cachedAt: new Date(),
    }).run();
  }
  const linkId = `link-${args.cardId}-${refId}`;
  const link = db.select().from(cardLinks).all().find((l) => l.id === linkId);
  if (!link) {
    db.insert(cardLinks).values({
      id: linkId, cardId: args.cardId, giteaRefId: refId, role: 'reference',
      createdAt: new Date(),
    }).run();
  }
}

// ===== getLinkedCardsForCommits =====

describe('getLinkedCardsForCommits', () => {
  it('空 shas → 空 Map', () => {
    const m = getLinkedCardsForCommits({ owner: 'o', repo: 'r', shas: [] });
    expect(m.size).toBe(0);
  });

  it('无任何 card_links → 全空列表（gitea_refs 也没建）', () => {
    const m = getLinkedCardsForCommits({ owner: 'o', repo: 'r', shas: ['sha1', 'sha2'] });
    expect(m.get('sha1')).toEqual([]);
    expect(m.get('sha2')).toEqual([]);
  });

  it('一个 commit 关联一个 card → LinkedCardDto[]', async () => {
    await seedCardLink({
      refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1',
      cardId: 'card-1', columnName: 'todo',
    });
    const m = getLinkedCardsForCommits({ owner: 'alice', repo: 'foo', shas: ['sha1'] });
    expect(m.get('sha1')).toEqual([{ cardId: 'card-1', columnName: 'todo' }]);
  });

  it('一个 commit 关联多个 card', async () => {
    await seedCardLink({
      refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1',
      cardId: 'card-1', columnName: 'todo',
    });
    await seedCardLink({
      refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1',
      cardId: 'card-2', columnName: 'doing',
    });
    const m = getLinkedCardsForCommits({ owner: 'alice', repo: 'foo', shas: ['sha1'] });
    expect(m.get('sha1')).toHaveLength(2);
    expect(m.get('sha1')?.map((c) => c.cardId).sort()).toEqual(['card-1', 'card-2']);
  });

  it('多个 commit 一次查（命中 / 不命中混合）', async () => {
    await seedCardLink({
      refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1',
      cardId: 'card-1', columnName: 'todo',
    });
    const m = getLinkedCardsForCommits({ owner: 'alice', repo: 'foo', shas: ['sha1', 'sha2', 'sha3'] });
    expect(m.get('sha1')).toHaveLength(1);
    expect(m.get('sha2')).toEqual([]);
    expect(m.get('sha3')).toEqual([]);
  });

  it('owner/repo 维度不串', async () => {
    await seedCardLink({
      refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1',
      cardId: 'card-1', columnName: 'todo',
    });
    const m = getLinkedCardsForCommits({ owner: 'bob', repo: 'bar', shas: ['sha1'] });
    expect(m.get('sha1')).toEqual([]);
  });

  it('kind 维度不串（commit 关联不污染 pr 关联）', async () => {
    await seedCardLink({
      refKind: 'commit', owner: 'alice', repo: 'foo', refId: 'sha1',
      cardId: 'card-1', columnName: 'todo',
    });
    const m = getLinkedCardsForPulls({ owner: 'alice', repo: 'foo', indices: [1] });
    expect(m.get(1)).toEqual([]);
  });
});

// ===== getLinkedCardsForPulls =====

describe('getLinkedCardsForPulls', () => {
  it('空 indices → 空 Map', () => {
    const m = getLinkedCardsForPulls({ owner: 'o', repo: 'r', indices: [] });
    expect(m.size).toBe(0);
  });

  it('PR 关联 card', async () => {
    await seedCardLink({
      refKind: 'pr', owner: 'alice', repo: 'foo', refId: '42',
      cardId: 'card-1', columnName: 'review',
    });
    const m = getLinkedCardsForPulls({ owner: 'alice', repo: 'foo', indices: [42] });
    expect(m.get(42)).toEqual([{ cardId: 'card-1', columnName: 'review' }]);
  });

  it('多个 PR index 一次查', async () => {
    await seedCardLink({
      refKind: 'pr', owner: 'alice', repo: 'foo', refId: '42',
      cardId: 'card-1', columnName: 'review',
    });
    const m = getLinkedCardsForPulls({ owner: 'alice', repo: 'foo', indices: [42, 43] });
    expect(m.get(42)).toHaveLength(1);
    expect(m.get(43)).toEqual([]);
  });

  it('refId 数字存成字符串（pr kind + refId = "42"）', async () => {
    // 验证 PR index 在 gitea_refs.ref_id 列里就是 text "42"，
    // 我们这边按 number → string 转换查询后能正确命中
    await seedCardLink({
      refKind: 'pr', owner: 'alice', repo: 'foo', refId: '42',
      cardId: 'card-1', columnName: 'review',
    });
    const single = getLinkedCardsForPull({ owner: 'alice', repo: 'foo', index: 42 });
    expect(single).toEqual([{ cardId: 'card-1', columnName: 'review' }]);
  });
});

// ===== getLinkedCardsForCommit / getLinkedCardsForPull（单条）=====

describe('getLinkedCardsForCommit（单条）', () => {
  it('命中', async () => {
    await seedCardLink({
      refKind: 'commit', owner: 'a', repo: 'b', refId: 's1',
      cardId: 'c1', columnName: 'todo',
    });
    expect(getLinkedCardsForCommit({ owner: 'a', repo: 'b', sha: 's1' }))
      .toEqual([{ cardId: 'c1', columnName: 'todo' }]);
  });

  it('不命中 → 空数组（不是 null）', () => {
    expect(getLinkedCardsForCommit({ owner: 'a', repo: 'b', sha: 'missing' }))
      .toEqual([]);
  });
});

// ===== commits 缓存 =====

async function seedProjectForCache(projectId: string, owner: string, name: string) {
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

describe('getCommitsCache / setCommitsCache', () => {
  it('未写 → null', async () => {
    await seedProjectForCache('p-1', 'alice', 'foo');
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });

  it('写后读出', async () => {
    await seedProjectForCache('p-1', 'alice', 'foo');
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: '{"x":1}' });
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('{"x":1}');
  });

  it('upsert 同 key', async () => {
    await seedProjectForCache('p-1', 'alice', 'foo');
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v1' });
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v2' });
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('v2');
  });

  it('TTL 过期 → null', async () => {
    await seedProjectForCache('p-1', 'alice', 'foo');
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'x', ttlSeconds: 1 });
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('x');
    await new Promise((r) => setTimeout(r, 1100));
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
  });

  it('commits 缓存与 branches 缓存互不串', async () => {
    await seedProjectForCache('p-1', 'alice', 'foo');
    const { setBranchesCache, getBranchesCache } = await import('./branches.js');
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'commits-v' });
    setBranchesCache({ projectId: 'p-1', cacheKey: 'k', payload: 'branches-v' });
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('commits-v');
    expect(getBranchesCache({ projectId: 'p-1', cacheKey: 'k' })).toBe('branches-v');
  });
});

describe('invalidateCommitsCache', () => {
  it('按 projectId 失效：只清该项目', async () => {
    // 注：测试用 projectId 是 'p-1' / 'p-2'，但 commitsCache 没强制 FK 到 repo_projects
    // 所以这里直接 set 然后失效
    await seedProjectForCache('p-1', 'alice', 'foo');
    await seedProjectForCache('p-2', 'bob', 'bar');
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k', payload: 'v1' });
    setCommitsCache({ projectId: 'p-2', cacheKey: 'k', payload: 'v2' });
    invalidateCommitsCache('p-1');
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k' })).toBeNull();
    expect(getCommitsCache({ projectId: 'p-2', cacheKey: 'k' })).toBe('v2');
  });

  it('不带 projectId → 清所有 commits 资源缓存', async () => {
    await seedProjectForCache('p-1', 'alice', 'foo');
    await seedProjectForCache('p-2', 'bob', 'bar');
    setCommitsCache({ projectId: 'p-1', cacheKey: 'k1', payload: 'v1' });
    setCommitsCache({ projectId: 'p-2', cacheKey: 'k2', payload: 'v2' });
    invalidateCommitsCache();
    expect(getCommitsCache({ projectId: 'p-1', cacheKey: 'k1' })).toBeNull();
    expect(getCommitsCache({ projectId: 'p-2', cacheKey: 'k2' })).toBeNull();
  });
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
