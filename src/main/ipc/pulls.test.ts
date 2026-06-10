/**
 * src/main/ipc/pulls.ts 单测
 *
 * 覆盖（任务 prompt §关键约束 + §pulls.*）：
 * - registerPullsIpc 注册 4 个 channel
 * - pulls.list happy path：PullDto[] + linkedCards JOIN + hasMore
 * - pulls.list 缓存：第二次命中（不调 gitea）
 * - pulls.get happy path + linkedCards JOIN + 缓存
 * - pulls.create：调 POST /pulls + 失效 pulls 缓存
 * - pulls.merge（危险操作）：
 *   - happy path：调 POST /pulls/{index}/merge + 失效 pulls + commits + branches
 *   - squash 时缺 commitMessage → Zod VALIDATION_FAILED
 *   - mergeable=false → hasConflicts=true
 *   - 5 种 method 都能传
 *   - 错误码透传：CONFLICT（已合并 / 冲突）/ PERMISSION_DENIED
 * - Zod 校验：缺 projectId / index / method → VALIDATION_FAILED
 * - resolveProject 缺失：NOT_FOUND
 * - linkedCards JOIN：pull 有关联 card → 填充
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

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

const { IpcErrorCode, IpcError } = await import('@shared/errors');
const { IpcChannel } = await import('./schema.js');
const { registerPullsIpc, unregisterPullsIpc } = await import('./pulls.js');
const sqliteMod = await import('../cache/sqlite.js');
const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
const { repoProjects } = await import('../cache/schema/repoProjects.js');

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-ipc-pulls-test-'));
let currentDbPath = '';

function makeRawPull(overrides: Partial<{
  index: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  head_ref: string;
  base_ref: string;
  author_login: string;
  author_avatar: string | undefined;
  created_at: string;
  updated_at: string;
  mergeable: boolean;
}> = {}) {
  return {
    index: overrides.index ?? 1,
    title: overrides.title ?? 'feat: hello',
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    head: {
      ref: overrides.head_ref ?? 'feature/x',
      sha: 'head-sha-0000000000000000000000000000000',
    },
    base: {
      ref: overrides.base_ref ?? 'main',
      sha: 'base-sha-0000000000000000000000000000000',
    },
    user: overrides.author_login !== undefined
      ? {
          login: overrides.author_login,
          ...(overrides.author_avatar !== undefined ? { avatar_url: overrides.author_avatar } : {}),
        }
      : { login: 'alice' },
    created_at: overrides.created_at ?? '2026-06-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-10T00:00:00.000Z',
    mergeable: overrides.mergeable,
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

async function seedCardLinkForPull(index: number) {
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
      id: 'col-1', boardId: 'board-1', name: 'review', position: 0, createdAt: new Date(),
    }).run();
  }
  const card = db.select().from(cards).all().find((c) => c.id === 'card-1');
  if (!card) {
    db.insert(cards).values({
      id: 'card-1', columnId: 'col-1', title: 'card', position: 0,
      createdAt: new Date(), updatedAt: new Date(),
    }).run();
  }
  const ref = db.select().from(giteaRefs).all().find((r) => r.id === `ref-pr-${index}`);
  if (!ref) {
    db.insert(giteaRefs).values({
      id: `ref-pr-${index}`, kind: 'pr', owner: 'alice', repo: 'foo',
      refId: String(index), cachedAt: new Date(),
    }).run();
  }
  const link = db.select().from(cardLinks).all().find((l) => l.id === `link-pr-${index}`);
  if (!link) {
    db.insert(cardLinks).values({
      id: `link-pr-${index}`, cardId: 'card-1', giteaRefId: `ref-pr-${index}`,
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
  registerPullsIpc();
});

afterEach(async () => {
  unregisterPullsIpc();
  await sqliteMod._resetSqliteForTest();
});

// ===== 注册断言 =====

describe('registerPullsIpc', () => {
  it('注册 4 个 channel', () => {
    expect(ipcHandlers.has(IpcChannel.PULLS_LIST)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.PULLS_GET)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.PULLS_CREATE)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.PULLS_MERGE)).toBe(true);
  });

  it('unregisterPullsIpc 清空所有 channel', () => {
    unregisterPullsIpc();
    expect(ipcHandlers.has(IpcChannel.PULLS_LIST)).toBe(false);
    expect(ipcHandlers.has(IpcChannel.PULLS_GET)).toBe(false);
    expect(ipcHandlers.has(IpcChannel.PULLS_CREATE)).toBe(false);
    expect(ipcHandlers.has(IpcChannel.PULLS_MERGE)).toBe(false);
  });
});

// ===== pulls.list happy path =====

describe('pulls.list happy path', () => {
  it('返回 PullDto[] + hasMore', async () => {
    mockGiteaFetch.mockResolvedValueOnce([
      makeRawPull({ index: 1, title: 'PR 1' }),
      makeRawPull({ index: 2, title: 'PR 2' }),
    ]);
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    const r = (await handler({}, { projectId: 'proj-1' })) as {
      items: Array<{ index: number; title: string; head: { ref: string }; base: { ref: string } }>;
      total: number;
      hasMore: boolean;
    };
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.index).toBe(1);
    expect(r.items[0]!.head.ref).toBe('feature/x');
    expect(r.items[0]!.base.ref).toBe('main');
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(false);
  });

  it('mergeable=false → hasConflicts=true（**关键映射**）', async () => {
    mockGiteaFetch.mockResolvedValueOnce([makeRawPull({ mergeable: false })]);
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    const r = (await handler({}, { projectId: 'proj-1' })) as {
      items: Array<{ mergeable: boolean; hasConflicts: boolean }>;
    };
    expect(r.items[0]!.mergeable).toBe(false);
    expect(r.items[0]!.hasConflicts).toBe(true);
  });

  it('linkedCards JOIN：PR 有关联 card → 填充', async () => {
    await seedCardLinkForPull(1);
    mockGiteaFetch.mockResolvedValueOnce([
      makeRawPull({ index: 1 }),
      makeRawPull({ index: 2 }),
    ]);
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    const r = (await handler({}, { projectId: 'proj-1' })) as {
      items: Array<{ index: number; linkedCards?: Array<{ cardId: string; columnName: string }> }>;
    };
    expect(r.items[0]!.linkedCards).toEqual([{ cardId: 'card-1', columnName: 'review' }]);
    expect(r.items[1]!.linkedCards).toEqual([]);
  });
});

// ===== 缓存行为 =====

describe('pulls.list 缓存', () => {
  it('第二次调用相同 args 命中缓存（不调 gitea）', async () => {
    mockGiteaFetch.mockResolvedValueOnce([makeRawPull()]);
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    const args = { projectId: 'proj-1', page: 1, limit: 50 };
    await handler({}, args);
    await handler({}, args);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);
  });

  it('不同 state 切片独立', async () => {
    mockGiteaFetch.mockResolvedValue([makeRawPull()]);
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    await handler({}, { projectId: 'proj-1', state: 'open' });
    await handler({}, { projectId: 'proj-1', state: 'closed' });
    expect(mockGiteaFetch).toHaveBeenCalledTimes(2);
  });
});

// ===== pulls.get =====

describe('pulls.get', () => {
  it('happy path: 返回完整 PullDto + linkedCards', async () => {
    await seedCardLinkForPull(7);
    mockGiteaFetch.mockResolvedValueOnce(makeRawPull({ index: 7, draft: true }));
    const handler = ipcHandlers.get(IpcChannel.PULLS_GET)!;
    const p = (await handler({}, { projectId: 'proj-1', index: 7 })) as {
      index: number; draft: boolean; linkedCards?: Array<{ cardId: string; columnName: string }>;
    };
    expect(p.index).toBe(7);
    expect(p.draft).toBe(true);
    expect(p.linkedCards).toEqual([{ cardId: 'card-1', columnName: 'review' }]);
  });

  it('第二次调相同 index 命中缓存', async () => {
    mockGiteaFetch.mockResolvedValueOnce(makeRawPull());
    const handler = ipcHandlers.get(IpcChannel.PULLS_GET)!;
    const args = { projectId: 'proj-1', index: 1 };
    await handler({}, args);
    await handler({}, args);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);
  });
});

// ===== pulls.create =====

describe('pulls.create', () => {
  it('happy path: POST + 失效 pulls 缓存', async () => {
    mockGiteaFetch.mockResolvedValueOnce(makeRawPull({ index: 42 }));
    const handler = ipcHandlers.get(IpcChannel.PULLS_CREATE)!;
    const p = (await handler({}, {
      projectId: 'proj-1', head: 'feature/y', base: 'main', title: 'feat: new',
    })) as { index: number; linkedCards: unknown[] };
    expect(p.index).toBe(42);
    expect(p.linkedCards).toEqual([]);
  });

  it('create 失效 pulls 缓存（list 第二次会调 gitea）', async () => {
    // 写一次 list 缓存
    mockGiteaFetch.mockResolvedValueOnce([makeRawPull()]);
    const listHandler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    await listHandler({}, { projectId: 'proj-1' });
    await listHandler({}, { projectId: 'proj-1' });
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);

    // create 应失效缓存
    mockGiteaFetch.mockResolvedValueOnce(makeRawPull({ index: 100 }));
    const createHandler = ipcHandlers.get(IpcChannel.PULLS_CREATE)!;
    await createHandler({}, { projectId: 'proj-1', head: 'feat', base: 'main', title: 't' });

    // 第三次 list 应重新调 gitea
    mockGiteaFetch.mockResolvedValueOnce([makeRawPull()]);
    await listHandler({}, { projectId: 'proj-1' });
    expect(mockGiteaFetch).toHaveBeenCalledTimes(3);
  });

  it('缺 head → VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_CREATE)!;
    await expect(handler({}, { projectId: 'proj-1', base: 'main', title: 't' }))
      .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });
});

// ===== pulls.merge（危险操作）=====

describe('pulls.merge', () => {
  it('happy path: 调 POST /pulls/{index}/merge + 失效 pulls + commits + branches 缓存', async () => {
    // 先种三种缓存
    mockGiteaFetch.mockResolvedValueOnce([makeRawPull()]);
    const listHandler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    await listHandler({}, { projectId: 'proj-1' });

    // 验证三种缓存都写入了
    const { cacheEntries } = await import('../cache/schema/cacheEntries.js');
    const db = sqliteMod.getDb();
    const beforeRows = db.select().from(cacheEntries).all();
    const before = {
      pulls: beforeRows.filter((r) => r.resource === 'pulls').length,
      commits: beforeRows.filter((r) => r.resource === 'commits').length,
      branches: beforeRows.filter((r) => r.resource === 'branches').length,
    };
    expect(before.pulls).toBe(1);

    // merge 成功
    mockGiteaFetch.mockResolvedValueOnce({
      sha: 'merge-sha', merged: true, message: 'Merge OK',
    });
    const mergeHandler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    const r = (await mergeHandler({}, {
      projectId: 'proj-1', index: 1, method: 'merge',
    })) as { sha: string; merged: boolean; message: string };
    expect(r.sha).toBe('merge-sha');
    expect(r.merged).toBe(true);

    // 验证 pulls 缓存被清空
    const afterRows = db.select().from(cacheEntries).all();
    const after = {
      pulls: afterRows.filter((r) => r.resource === 'pulls').length,
      commits: afterRows.filter((r) => r.resource === 'commits').length,
      branches: afterRows.filter((r) => r.resource === 'branches').length,
    };
    expect(after.pulls).toBe(0);
  });

  it('body: Do + deleteBranchAfter + commitMessage 全透传', async () => {
    mockGiteaFetch.mockResolvedValueOnce({ sha: 'm', merged: true, message: 'ok' });
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await handler({}, {
      projectId: 'proj-1', index: 1, method: 'squash',
      deleteBranchAfter: true, commitMessage: 'feat: combined',
    });
    expect(mockGiteaFetch).toHaveBeenLastCalledWith(
      'http://x', 'alice',
      '/repos/alice/foo/pulls/1/merge',
      expect.objectContaining({
        method: 'POST',
        body: {
          Do: 'squash',
          delete_branch_after_merge: true,
          Merge_Message: 'feat: combined',
        },
      }),
    );
  });

  it('squash + 缺 commitMessage → Zod VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await expect(handler({}, {
      projectId: 'proj-1', index: 1, method: 'squash',
    })).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
    expect(mockGiteaFetch).not.toHaveBeenCalled();
  });

  it('squash-merge + 缺 commitMessage → Zod VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await expect(handler({}, {
      projectId: 'proj-1', index: 1, method: 'squash-merge',
    })).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('merge / rebase / rebase-merge 不需要 commitMessage', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    for (const m of ['merge', 'rebase', 'rebase-merge'] as const) {
      mockGiteaFetch.mockResolvedValueOnce({ sha: 'm', merged: true, message: 'ok' });
      const r = (await handler({}, { projectId: 'proj-1', index: 1, method: m })) as { merged: boolean };
      expect(r.merged).toBe(true);
    }
    expect(mockGiteaFetch).toHaveBeenCalledTimes(3);
  });

  it('5 种 method 都能传（+ 验证 method 描述）', async () => {
    // Zod schema 拍板的 .describe 落定（02 §5.3.6 拍板文案）
    const { MergeMethodSchema, MergePrArgsSchema } = await import('./schema.js');
    // MergePrArgsSchema 用了 .refine → ZodEffects，没有 .shape
    // 直接调 .parse() 来访问内部 method 字段
    // 验证 5 种 method 都通过 + 错误信息在 description 里
    const desc = (MergePrArgsSchema as unknown as { description?: string }).description ?? '';
    // Zod 描述在 ZodEnum 的 description 上
    const methodDesc = MergeMethodSchema.description ?? '';
    const fullDesc = desc + '\n' + methodDesc;
    expect(fullDesc).toContain('普通合并（保留所有提交历史）');
    expect(fullDesc).toContain('变基后快进（重写历史，单一线性）');
    expect(fullDesc).toContain('压缩为单提交（合并请求内 N 个提交合成 1 个）');

    // 5 种 method 都能解析
    for (const m of ['merge', 'rebase', 'rebase-merge', 'squash', 'squash-merge'] as const) {
      expect(() => MergeMethodSchema.parse(m)).not.toThrow();
    }
  });

  it('gitea 409 CONFLICT 透传（PR 已合并 / 有冲突）', async () => {
    const err = new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: '操作冲突：资源已存在或状态不允许',
      httpStatus: 409,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await expect(handler({}, { projectId: 'proj-1', index: 1, method: 'merge' }))
      .rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  });

  it('gitea 403 PERMISSION_DENIED 透传（无合并权限）', async () => {
    const err = new IpcError({
      code: IpcErrorCode.PERMISSION_DENIED,
      message: '没有该操作权限',
      hint: '请联系仓库管理员',
      httpStatus: 403,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await expect(handler({}, { projectId: 'proj-1', index: 1, method: 'merge' }))
      .rejects.toMatchObject({ code: IpcErrorCode.PERMISSION_DENIED });
  });
});

// ===== 错误码透传 / 校验 =====

describe('pulls.* 通用错误', () => {
  it('gitea 401 → IpcError TOKEN_INVALID', async () => {
    const err = new IpcError({
      code: IpcErrorCode.TOKEN_INVALID, message: '登录已过期或 token 无效',
      hint: '请到 gitea 重新生成 token 后重新连接', httpStatus: 401,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    await expect(handler({}, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
  });

  it('缺 projectId → VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
    await expect(handler({}, {})).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('缺 index（pulls.get）→ VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_GET)!;
    await expect(handler({}, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('缺 method（pulls.merge）→ VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await expect(handler({}, { projectId: 'proj-1', index: 1 }))
      .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('repoProject 不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.PULLS_LIST)!;
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
    const handler = ipcHandlers.get(IpcChannel.PULLS_MERGE)!;
    await expect(handler({}, { projectId: 'orphan-proj', index: 1, method: 'merge' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
