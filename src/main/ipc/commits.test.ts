/**
 * src/main/ipc/commits.ts 单测
 *
 * 覆盖（任务 prompt §关键约束 + §commits.*）：
 * - registerCommitsIpc 注册 2 个 channel
 * - commits.list happy path：转 CommitDto[] + linkedCards JOIN
 * - commits.list 缓存：第二次命中（不调 gitea）
 * - commits.get happy path：转 CommitDto + linkedCards JOIN
 * - commits.get 缓存：第二次命中
 * - 错误码透传：gitea 401/404 → IpcError TOKEN_INVALID/NOT_FOUND
 * - Zod 校验：缺 projectId / sha → VALIDATION_FAILED
 * - resolveProject 缺失：NOT_FOUND
 * - giteaAccount 缺失（孤儿）：NOT_FOUND
 * - linkedCards JOIN：关联到 cards 时填充
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// ===== mock electron =====
const ipcHandlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
  },
  app: {
    isPackaged: false,
    getPath: (k: string) => {
      throw new Error(`electron.getPath(${k}) not mocked in test`);
    },
  },
}));

const mockGiteaFetch = vi.fn();
vi.mock('../gitea/client.js', () => ({
  giteaFetch: (...args: unknown[]) => mockGiteaFetch(...args),
}));

// ===== 动态 import 顺序必须在 mock 之后 =====
const { IpcErrorCode, IpcError } = await import('@shared/errors');
const { IpcChannel } = await import('./schema.js');
const { registerCommitsIpc, unregisterCommitsIpc } = await import('./commits.js');
const sqliteMod = await import('../cache/sqlite.js');
const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
const { repoProjects } = await import('../cache/schema/repoProjects.js');

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-ipc-commits-test-'));
let currentDbPath = '';

function makeRawCommit(overrides: Partial<{
  sha: string;
  message: string;
  parents: Array<{ sha: string }>;
}> = {}) {
  return {
    sha: overrides.sha ?? 'aaa-sha-full-40-chars-here-00000000000',
    commit: {
      message: overrides.message ?? 'feat: hello',
      author: { name: 'alice', email: 'alice@example.com', date: '2026-06-10T00:00:00.000Z' },
      committer: { name: 'alice', email: 'alice@example.com' },
    },
    parents: overrides.parents ?? [{ sha: 'parent-sha-0000000000000000000000000000000' }],
    author: { login: 'alice', avatar_url: 'https://gitea.example.com/avatars/alice.png' },
  };
}

async function seedAccount(id = 'acc-1', giteaUrl = 'http://x', username = 'alice') {
  const existing = sqliteMod.getDb().select().from(giteaAccounts).all().find((a) => a.id === id);
  if (!existing) {
    sqliteMod.getDb().insert(giteaAccounts).values({
      id, giteaUrl, username,
      keychainService: `gitea-kanban@${giteaUrl}`,
      createdAt: new Date(),
    }).run();
  }
}

async function seedProject(
  projectId = 'proj-1',
  giteaAccountId = 'acc-1',
  owner = 'alice',
  name = 'foo',
): Promise<string> {
  const existing = sqliteMod.getDb().select().from(repoProjects).all().find((p) => p.id === projectId);
  if (!existing) {
    sqliteMod.getDb().insert(repoProjects).values({
      id: projectId, giteaAccountId, owner, name,
      defaultBranch: 'main',
      createdAt: new Date(),
    }).run();
  }
  return projectId;
}

async function seedCardLinkForCommit(sha: string) {
  const { giteaRefs } = await import('../cache/schema/giteaRefs.js');
  const { cardLinks } = await import('../cache/schema/cardLinks.js');
  const { cards } = await import('../cache/schema/cards.js');
  const { boardColumns } = await import('../cache/schema/boardColumns.js');
  const { boards } = await import('../cache/schema/boards.js');

  const db = sqliteMod.getDb();
  const board = db.select().from(boards).all().find((b) => b.id === 'board-1');
  if (!board) {
    db.insert(boards).values({
      id: 'board-1', repoProjectId: 'proj-1', name: 'main', layout: 'kanban',
      createdAt: new Date(),
    }).run();
  }
  const col = db.select().from(boardColumns).all().find((c) => c.id === 'col-1');
  if (!col) {
    db.insert(boardColumns).values({
      id: 'col-1', boardId: 'board-1', name: 'todo', position: 0, createdAt: new Date(),
    }).run();
  }
  const card = db.select().from(cards).all().find((c) => c.id === 'card-1');
  if (!card) {
    db.insert(cards).values({
      id: 'card-1', columnId: 'col-1', title: 'card', position: 0,
      createdAt: new Date(), updatedAt: new Date(),
    }).run();
  }
  const ref = db.select().from(giteaRefs).all().find((r) => r.id === `ref-${sha}`);
  if (!ref) {
    db.insert(giteaRefs).values({
      id: `ref-${sha}`, kind: 'commit', owner: 'alice', repo: 'foo',
      refId: sha, cachedAt: new Date(),
    }).run();
  }
  const link = db.select().from(cardLinks).all().find((l) => l.id === `link-${sha}`);
  if (!link) {
    db.insert(cardLinks).values({
      id: `link-${sha}`, cardId: 'card-1', giteaRefId: `ref-${sha}`,
      role: 'reference', createdAt: new Date(),
    }).run();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  ipcHandlers.clear();
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  sqliteMod._setSqlitePathForTest(currentDbPath);
  await sqliteMod.initSqlite();
  await seedAccount();
  await seedProject();
  registerCommitsIpc();
});

afterEach(async () => {
  unregisterCommitsIpc();
  await sqliteMod._resetSqliteForTest();
});

// ===== 注册断言 =====

describe('registerCommitsIpc', () => {
  it('注册 2 个 channel', () => {
    expect(ipcHandlers.has(IpcChannel.COMMITS_LIST)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.COMMITS_GET)).toBe(true);
  });

  it('unregisterCommitsIpc 清空所有 channel', () => {
    unregisterCommitsIpc();
    expect(ipcHandlers.has(IpcChannel.COMMITS_LIST)).toBe(false);
    expect(ipcHandlers.has(IpcChannel.COMMITS_GET)).toBe(false);
  });
});

// ===== commits.list happy path =====

describe('commits.list happy path', () => {
  it('返回 CommitDto[] + nextPage=null', async () => {
    mockGiteaFetch.mockResolvedValueOnce([
      makeRawCommit({ sha: 'aaa-sha-1' }),
      makeRawCommit({ sha: 'bbb-sha-2' }),
    ]);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    const r = (await handler({}, { projectId: 'proj-1' })) as {
      items: Array<{ sha: string; shortSha: string; message: string; author: { name: string; avatarUrl?: string } }>;
      total: number;
      hasMore: boolean;
      nextPage: number | null;
    };
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.sha).toBe('aaa-sha-1');
    expect(r.items[0]!.shortSha).toBe('aaa-sha');
    expect(r.items[0]!.author.name).toBe('alice');
    expect(r.items[0]!.author.avatarUrl).toBe('https://gitea.example.com/avatars/alice.png');
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(false);
    expect(r.nextPage).toBeNull();
  });

  it('hasMore=true → nextPage = page+1', async () => {
    const raws = Array.from({ length: 50 }, (_, i) => makeRawCommit({ sha: `sha-${i}` }));
    mockGiteaFetch.mockResolvedValueOnce(raws);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    const r = (await handler({}, { projectId: 'proj-1', page: 2, limit: 50 })) as {
      hasMore: boolean; nextPage: number | null;
    };
    expect(r.hasMore).toBe(true);
    expect(r.nextPage).toBe(3);
  });

  it('linkedCards JOIN：commit 有关联 card → linkedCards 含 cardId/columnName', async () => {
    await seedCardLinkForCommit('aaa-sha-1');
    mockGiteaFetch.mockResolvedValueOnce([
      makeRawCommit({ sha: 'aaa-sha-1' }),
      makeRawCommit({ sha: 'bbb-sha-2' }),
    ]);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    const r = (await handler({}, { projectId: 'proj-1' })) as {
      items: Array<{ sha: string; linkedCards?: Array<{ cardId: string; columnName: string }> }>;
    };
    expect(r.items[0]!.linkedCards).toEqual([{ cardId: 'card-1', columnName: 'todo' }]);
    expect(r.items[1]!.linkedCards).toEqual([]);
  });
});

// ===== 缓存行为 =====

describe('commits.list 缓存', () => {
  it('第二次调用相同 args 命中缓存（不调 gitea）', async () => {
    mockGiteaFetch.mockResolvedValueOnce([makeRawCommit()]);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    const args = { projectId: 'proj-1', page: 1, limit: 50 };
    await handler({}, args);
    await handler({}, args);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);
  });

  it('不同 args 不命中缓存（独立切片）', async () => {
    mockGiteaFetch.mockResolvedValue([makeRawCommit()]);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    await handler({}, { projectId: 'proj-1', page: 1, limit: 50 });
    await handler({}, { projectId: 'proj-1', page: 2, limit: 50 });
    expect(mockGiteaFetch).toHaveBeenCalledTimes(2);
  });

  it('缓存命中时返回的 JSON.parse 失败 → 当作 miss 重试 gitea', async () => {
    // 第一次调：返正常数据
    mockGiteaFetch.mockResolvedValueOnce([makeRawCommit()]);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    await handler({}, { projectId: 'proj-1' });

    // 手动把 cache 弄坏
    const db = sqliteMod.getDb();
    const { cacheEntries } = await import('../cache/schema/cacheEntries.js');
    const rows = db.select().from(cacheEntries).all();
    for (const r of rows) {
      if (r.resource === 'commits') {
        db.update(cacheEntries).set({ payload: 'INVALID_JSON' }).where(eq(cacheEntries.id, r.id)).run();
      }
    }

    // 第二次调：会因 JSON.parse 失败 fallback 到 gitea
    mockGiteaFetch.mockResolvedValueOnce([makeRawCommit()]);
    const r = (await handler({}, { projectId: 'proj-1' })) as { items: unknown[] };
    expect(r.items).toHaveLength(1);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(2);
  });
});

// ===== commits.get =====

describe('commits.get', () => {
  it('happy path: 调 /git/commits/{sha} + 返回完整 DTO', async () => {
    mockGiteaFetch.mockResolvedValueOnce({
      ...makeRawCommit({ sha: 'aaa-sha-1' }),
      stats: { additions: 10, deletions: 5, total: 15 },
      files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
    });
    const handler = ipcHandlers.get(IpcChannel.COMMITS_GET)!;
    const c = (await handler({}, { projectId: 'proj-1', sha: 'aaa-sha-1' })) as {
      sha: string; additions: number; deletions: number; filesChanged: number; linkedCards: unknown[];
    };
    expect(c.sha).toBe('aaa-sha-1');
    expect(c.additions).toBe(10);
    expect(c.deletions).toBe(5);
    expect(c.filesChanged).toBe(2);
    expect(c.linkedCards).toEqual([]);
  });

  it('linkedCards JOIN', async () => {
    await seedCardLinkForCommit('aaa-sha-1');
    mockGiteaFetch.mockResolvedValueOnce(makeRawCommit());
    const handler = ipcHandlers.get(IpcChannel.COMMITS_GET)!;
    const c = (await handler({}, { projectId: 'proj-1', sha: 'aaa-sha-1' })) as {
      linkedCards: Array<{ cardId: string; columnName: string }>;
    };
    expect(c.linkedCards).toEqual([{ cardId: 'card-1', columnName: 'todo' }]);
  });

  it('第二次调相同 sha 命中缓存（5 min TTL）', async () => {
    mockGiteaFetch.mockResolvedValueOnce(makeRawCommit());
    const handler = ipcHandlers.get(IpcChannel.COMMITS_GET)!;
    const args = { projectId: 'proj-1', sha: 'aaa-sha-1' };
    await handler({}, args);
    await handler({}, args);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);
  });

  it('不同 sha 独立缓存', async () => {
    mockGiteaFetch
      .mockResolvedValueOnce(makeRawCommit({ sha: 'sha-a' }))
      .mockResolvedValueOnce(makeRawCommit({ sha: 'sha-b' }));
    const handler = ipcHandlers.get(IpcChannel.COMMITS_GET)!;
    await handler({}, { projectId: 'proj-1', sha: 'sha-a' });
    await handler({}, { projectId: 'proj-1', sha: 'sha-b' });
    expect(mockGiteaFetch).toHaveBeenCalledTimes(2);
  });
});

// ===== 错误码透传 =====

describe('commits.* 错误码', () => {
  it('gitea 401 → IpcError TOKEN_INVALID', async () => {
    const err = new IpcError({
      code: IpcErrorCode.TOKEN_INVALID,
      message: '登录已过期或 token 无效',
      hint: '请到 gitea 重新生成 token 后重新连接',
      httpStatus: 401,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    await expect(handler({}, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
  });

  it('gitea 404 → IpcError NOT_FOUND', async () => {
    const err = new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '找不到该资源（可能已被删除）',
      hint: '请刷新列表',
      httpStatus: 404,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.COMMITS_GET)!;
    await expect(handler({}, { projectId: 'proj-1', sha: 'missing' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('缺 projectId → VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    await expect(handler({}, {})).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('缺 sha（commits.get）→ VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.COMMITS_GET)!;
    await expect(handler({}, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('repoProject 不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    await expect(handler({}, { projectId: 'nonexistent' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('giteaAccount 缺失（孤儿）→ NOT_FOUND', async () => {
    sqliteMod.getDb().insert(giteaAccounts).values({
      id: 'orphan-acc', giteaUrl: 'http://orphan', username: 'orphan',
      keychainService: 'gitea-kanban@http://orphan', createdAt: new Date(),
    }).run();
    sqliteMod.getDb().insert(repoProjects).values({
      id: 'orphan-proj', giteaAccountId: 'orphan-acc',
      owner: 'a', name: 'b', defaultBranch: 'main', createdAt: new Date(),
    }).run();
    sqliteMod.getDb().delete(giteaAccounts).where(eq(giteaAccounts.id, 'orphan-acc')).run();
    const handler = ipcHandlers.get(IpcChannel.COMMITS_LIST)!;
    await expect(handler({}, { projectId: 'orphan-proj' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
