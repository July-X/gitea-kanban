/**
 * src/main/ipc/repos.ts 单测
 *
 * 覆盖：
 * - registerReposIpc 注册 3 个 channel
 * - happy path：repos.list 200 → DTO + isProject JOIN
 * - cache hit：第二次调用不发 gitea fetch
 * - cache invalidate：addProject 后 list 不命中旧缓存
 * - 错误码透传：gitea 401/404 → IpcError TOKEN_INVALID/NOT_FOUND
 * - Zod 校验：list 必填 giteaAccountId 缺失 → VALIDATION_FAILED
 * - resolveGiteaAccount 缺失：NOT_FOUND
 *
 * mock 思路：ipcMain.handle 把回调存到 Map，测试 import 后从 Map 调 channel 拿回调
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== mock electron：捕获 ipcMain.handle 注册的回调 =====
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

// ===== mock giteaFetch =====
const mockGiteaFetch = vi.fn();
vi.mock('../gitea/client.js', () => ({
  giteaFetch: (...args: unknown[]) => mockGiteaFetch(...args),
}));

// ===== 动态 import 顺序必须在 mock 之后 =====
const { IpcErrorCode, IpcError } = await import('@shared/errors');
const { IpcChannel } = await import('./schema.js');
const { registerReposIpc, unregisterReposIpc } = await import('./repos.js');
const sqliteMod = await import('../cache/sqlite.js');
const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-ipc-repos-test-'));
let currentDbPath = '';

function makeRawRepo(overrides: Partial<{
  id: number;
  name: string;
  full_name: string;
  description: string;
  default_branch: string;
  archived: boolean;
  private: boolean;
  updated_at: string;
  permissions: { pull: boolean; push: boolean; admin: boolean };
}> = {}) {
  return {
    id: 1,
    name: 'foo',
    full_name: 'alice/foo',
    description: 'desc',
    default_branch: 'main',
    archived: false,
    private: false,
    updated_at: '2026-06-10T00:00:00.000Z',
    permissions: { pull: true, push: true, admin: false },
    owner: { login: 'alice' },
    ...overrides,
  };
}

async function seedAccount(id = 'acc-1', giteaUrl = 'http://x', username = 'alice') {
  const existing = sqliteMod.getDb().select().from(giteaAccounts).all().find((a) => a.id === id);
  if (!existing) {
    sqliteMod.getDb().insert(giteaAccounts).values({
      id,
      giteaUrl,
      username,
      keychainService: `gitea-kanban@${giteaUrl}`,
      createdAt: new Date(),
    }).run();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  ipcHandlers.clear();
  currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
  sqliteMod._setSqlitePathForTest(currentDbPath);
  await sqliteMod.initSqlite();
  registerReposIpc();
});

afterEach(async () => {
  unregisterReposIpc();
  await sqliteMod._resetSqliteForTest();
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ===== 注册断言 =====

describe('registerReposIpc', () => {
  it('注册 3 个 channel', () => {
    expect(ipcHandlers.has(IpcChannel.REPOS_LIST)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.REPOS_ADD_PROJECT)).toBe(true);
    expect(ipcHandlers.has(IpcChannel.REPOS_REMOVE_PROJECT)).toBe(true);
  });

  it('unregisterReposIpc 清空所有 channel', () => {
    unregisterReposIpc();
    expect(ipcHandlers.has(IpcChannel.REPOS_LIST)).toBe(false);
    expect(ipcHandlers.has(IpcChannel.REPOS_ADD_PROJECT)).toBe(false);
    expect(ipcHandlers.has(IpcChannel.REPOS_REMOVE_PROJECT)).toBe(false);
  });
});

// ===== repos.list happy path =====

describe('repos.list happy path', () => {
  it('返回 RepoDTO[] + hasMore + total', async () => {
    await seedAccount();
    mockGiteaFetch.mockResolvedValueOnce([
      makeRawRepo(),
      makeRawRepo({ id: 2, name: 'bar', full_name: 'alice/bar' }),
    ]);
    const handler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    const r = (await handler({}, { giteaAccountId: 'acc-1' })) as {
      items: Array<{ owner: string; name: string; fullName: string; isProject: boolean }>;
      total: number;
      hasMore: boolean;
    };
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.owner).toBe('alice');
    expect(r.items[0]!.name).toBe('foo');
    expect(r.items[0]!.fullName).toBe('alice/foo');
    expect(r.items[0]!.isProject).toBe(false);
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(false);
  });
});

// ===== cache 行为 =====

describe('repos.list 缓存', () => {
  it('第二次调用相同 args 命中缓存（不调 gitea）', async () => {
    await seedAccount();
    mockGiteaFetch.mockResolvedValueOnce([makeRawRepo()]);
    const handler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    const args = { giteaAccountId: 'acc-1', page: 1, limit: 50 };
    await handler({}, args);
    await handler({}, args); // 第二次
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);
  });

  it('addProject 失效 repos 缓存', async () => {
    await seedAccount();
    // 写一次缓存（用 list 触发 setReposCache）
    mockGiteaFetch.mockResolvedValueOnce([makeRawRepo()]);
    const listHandler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    const args = { giteaAccountId: 'acc-1' };
    await listHandler({}, args);
    // 第二次 list 应命中缓存
    await listHandler({}, args);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(1);

    // addProject 应失效缓存
    const addHandler = ipcHandlers.get(IpcChannel.REPOS_ADD_PROJECT)!;
    await addHandler({}, {
      giteaAccountId: 'acc-1', owner: 'bob', name: 'baz',
    });
    // 第三次 list 应重新调 gitea
    mockGiteaFetch.mockResolvedValueOnce([makeRawRepo()]);
    await listHandler({}, args);
    expect(mockGiteaFetch).toHaveBeenCalledTimes(2);
  });
});

// ===== 错误码透传 =====

describe('repos.list 错误码', () => {
  it('gitea 401 → IpcError TOKEN_INVALID', async () => {
    await seedAccount();
    const err = new IpcError({
      code: IpcErrorCode.TOKEN_INVALID,
      message: '登录已过期或 token 无效',
      hint: '请到 gitea 重新生成 token 后重新连接',
      httpStatus: 401,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    await expect(handler({}, { giteaAccountId: 'acc-1' }))
      .rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
  });

  it('gitea 404 → IpcError NOT_FOUND', async () => {
    await seedAccount();
    const err = new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '找不到该资源（可能已被删除）',
      hint: '请刷新列表',
      httpStatus: 404,
    });
    mockGiteaFetch.mockRejectedValueOnce(err);
    const handler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    await expect(handler({}, { giteaAccountId: 'acc-1' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('giteaAccountId 缺失 → VALIDATION_FAILED', async () => {
    const handler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    await expect(handler({}, {}))
      .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
  });

  it('gitea_account 不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.REPOS_LIST)!;
    await expect(handler({}, { giteaAccountId: 'nonexistent' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

// ===== addProject / removeProject =====

describe('repos.addProject', () => {
  it('返回 RepoProjectDto + 写库', async () => {
    await seedAccount();
    const handler = ipcHandlers.get(IpcChannel.REPOS_ADD_PROJECT)!;
    const r = (await handler({}, {
      giteaAccountId: 'acc-1', owner: 'alice', name: 'newrepo',
    })) as { id: string; owner: string; name: string };
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.owner).toBe('alice');
    expect(r.name).toBe('newrepo');
  });

  it('幂等：已存在 → 返回现有', async () => {
    await seedAccount();
    const handler = ipcHandlers.get(IpcChannel.REPOS_ADD_PROJECT)!;
    const r1 = (await handler({}, { giteaAccountId: 'acc-1', owner: 'a', name: 'b' })) as { id: string };
    const r2 = (await handler({}, { giteaAccountId: 'acc-1', owner: 'a', name: 'b' })) as { id: string };
    expect(r1.id).toBe(r2.id);
  });

  it('gitea_account 不存在 → NOT_FOUND', async () => {
    const handler = ipcHandlers.get(IpcChannel.REPOS_ADD_PROJECT)!;
    await expect(handler({}, { giteaAccountId: 'no', owner: 'a', name: 'b' }))
      .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

describe('repos.removeProject', () => {
  it('存在 → 删', async () => {
    await seedAccount();
    const addHandler = ipcHandlers.get(IpcChannel.REPOS_ADD_PROJECT)!;
    const r = (await addHandler({}, { giteaAccountId: 'acc-1', owner: 'a', name: 'b' })) as { id: string };

    const removeHandler = ipcHandlers.get(IpcChannel.REPOS_REMOVE_PROJECT)!;
    await expect(removeHandler({}, { projectId: r.id })).resolves.toBeUndefined();
  });

  it('不存在 → 静默成功', async () => {
    const removeHandler = ipcHandlers.get(IpcChannel.REPOS_REMOVE_PROJECT)!;
    await expect(removeHandler({}, { projectId: 'nope' })).resolves.toBeUndefined();
  });
});
