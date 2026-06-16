/**
 * main 端 branches IPC handler 单测
 *
 * 覆盖：list (cache hit/miss + isDefault/starred JOIN) / rename (默认分支保护 + starred 同步) / star
 *
 * Mock 策略（参考 issues.test.ts / labels.test.ts）：
 * - electron.ipcMain.handle mock 推 callback 到 globalThis.__ipcHandlers
 * - 整个 gitea/branches.js mock 掉（listGiteaBranches / renameGiteaBranch）
 * - 真实 localStore + 真实 resolveProject（account/project seed）
 * - cache/branches.js 用真实（sqlite tempdir，listStarredBranches / setStarred 走真路径）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  listGiteaBranches: vi.fn(),
  renameGiteaBranch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../gitea/branches.js', () => ({
  listGiteaBranches: mocks.listGiteaBranches,
  renameGiteaBranch: mocks.renameGiteaBranch,
}));

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-branches-ipc-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
  vi.resetModules();
  Object.values(mocks).forEach((m) => m.mockReset?.());
});

afterEach(async () => {
  if (savedEnv !== undefined) process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  else delete process.env['GITEA_KANBAN_DATA_DIR'];
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

const PROJECT_ID = 'p-test-uuid';

function getHandler(channel: string): (rawArgs: unknown) => Promise<unknown> {
  const registry = (globalThis as { __ipcHandlers?: Map<string, (e: unknown, a: unknown) => Promise<unknown>> }).__ipcHandlers;
  if (!registry) throw new Error('__ipcHandlers registry not initialized');
  return (rawArgs) => {
    const fn = registry.get(channel);
    if (!fn) throw new Error(`Handler not registered for channel: ${channel}`);
    return fn(undefined, rawArgs);
  };
}

function makeBranchDto(overrides: Record<string, unknown> = {}) {
  return {
    name: 'main',
    sha: 'abc123',
    protected: true,
    ...overrides,
  };
}

async function seedProjectAndRegister() {
  const electron = await import('electron');
  const ipcMainMock = vi.mocked(electron.ipcMain);
  ipcMainMock.handle.mockImplementation((channel: unknown, cb: unknown) => {
    const g = globalThis as { __ipcHandlers?: Map<string, (e: unknown, a: unknown) => Promise<unknown>> };
    if (!g.__ipcHandlers) g.__ipcHandlers = new Map();
    g.__ipcHandlers.set(channel as string, cb as (e: unknown, a: unknown) => Promise<unknown>);
  });

  const stateMod = await import('../../local/state.js');
  await stateMod._resetLocalStoreForTest();
  await stateMod.initLocalStore();
  stateMod.getLocalStore().mutate((s) => {
    s.accounts.push({
      id: 'a-1',
      giteaUrl: 'https://gitea.example.com',
      username: 'tester',
      keychainService: 'gitea-kanban',
      createdAt: Date.now(),
      userInfo: { giteaUserId: 1, login: 'tester', fullName: 'tester', updatedAt: Date.now() },
    });
    s.projects.push({
      id: PROJECT_ID,
      giteaAccountId: 'a-1',
      owner: 'org',
      name: 'repo',
      defaultBranch: 'main',
      lastSyncAt: null,
      createdAt: Date.now(),
    });
    return s;
  });

  const { registerBranchesIpc } = await import('../branches.js');
  registerBranchesIpc();
}

describe('ipc/branches · list (cache hit/miss + isDefault/starred JOIN)', () => {
  beforeEach(seedProjectAndRegister);

  it('cache miss → 调 gitea → 返带 isDefault/starred 的 BranchDto[]', async () => {
    mocks.listGiteaBranches.mockResolvedValueOnce({
      items: [
        makeBranchDto({ name: 'main', protected: true }),
        makeBranchDto({ name: 'feature-1', protected: false, sha: 'def456' }),
      ],
      hasMore: false,
    });

    // 先 star 一个非默认分支
    const cacheMod = await import('../../cache/branches.js');
    cacheMod.setStarred({ projectId: PROJECT_ID, branch: 'feature-1', starred: true });

    const result = (await getHandler('branches.list')({ projectId: PROJECT_ID })) as {
      items: Array<{ name: string; isDefault: boolean; starred: boolean }>;
    };
    expect(result.items).toHaveLength(2);
    expect(result.items.find((b) => b.name === 'main')?.isDefault).toBe(true);
    expect(result.items.find((b) => b.name === 'main')?.starred).toBe(false);
    expect(result.items.find((b) => b.name === 'feature-1')?.isDefault).toBe(false);
    expect(result.items.find((b) => b.name === 'feature-1')?.starred).toBe(true);
  });

  it('cache hit → 第二次不进 gitea（写缓存 → 走缓存）', async () => {
    mocks.listGiteaBranches.mockResolvedValueOnce({
      items: [makeBranchDto({ name: 'main' })],
      hasMore: false,
    });

    // 第一次写缓存
    await getHandler('branches.list')({ projectId: PROJECT_ID });
    expect(mocks.listGiteaBranches).toHaveBeenCalledTimes(1);

    // 第二次 → 应该走缓存，不调 gitea
    const result = (await getHandler('branches.list')({ projectId: PROJECT_ID })) as {
      items: Array<{ name: string }>;
    };
    expect(mocks.listGiteaBranches).toHaveBeenCalledTimes(1); // 没增加
    expect(result.items[0]?.name).toBe('main');
  });

  it('cache JSON 损坏 → 当作 miss，重新走 gitea', async () => {
    const cacheMod = await import('../../cache/branches.js');
    // 故意写一个损坏 payload 到 cache（任意 key 命中分支列表 cacheKey）
    cacheMod.setBranchesCache({
      projectId: PROJECT_ID,
      cacheKey: 'project=p-test-uuid|query=|page=1|limit=50',
      payload: '{not valid json',
    });

    mocks.listGiteaBranches.mockResolvedValueOnce({
      items: [makeBranchDto({ name: 'main' })],
      hasMore: false,
    });

    const result = (await getHandler('branches.list')({ projectId: PROJECT_ID })) as {
      items: Array<{ name: string }>;
    };
    expect(mocks.listGiteaBranches).toHaveBeenCalledTimes(1); // 重新走 gitea
    expect(result.items[0]?.name).toBe('main');
  });

  it('Zod 校验失败（缺 projectId）', async () => {
    await expect(getHandler('branches.list')({})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('Zod 校验失败（limit > 100）', async () => {
    await expect(
      getHandler('branches.list')({ projectId: PROJECT_ID, limit: 200 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('ipc/branches · rename (默认分支保护 + starred 同步)', () => {
  beforeEach(seedProjectAndRegister);

  it('rename 默认分支 → 抛 CONFLICT', async () => {
    await expect(
      getHandler('branches.rename')({
        projectId: PROJECT_ID,
        oldName: 'main',
        newName: 'main2',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(mocks.renameGiteaBranch).not.toHaveBeenCalled();
  });

  it('rename 非默认分支 → 调 gitea + 失效 cache + 同步 starred', async () => {
    // 预置 starred 'feature-1'
    const cacheMod = await import('../../cache/branches.js');
    cacheMod.setStarred({ projectId: PROJECT_ID, branch: 'feature-1', starred: true });

    mocks.renameGiteaBranch.mockResolvedValueOnce(makeBranchDto({ name: 'feature-2', sha: 'new-sha' }));

    const result = (await getHandler('branches.rename')({
      projectId: PROJECT_ID,
      oldName: 'feature-1',
      newName: 'feature-2',
    })) as { name: string; isDefault: boolean };

    expect(mocks.renameGiteaBranch).toHaveBeenCalledWith(
      expect.objectContaining({ oldName: 'feature-1', newName: 'feature-2' }),
    );
    expect(result.name).toBe('feature-2');
    expect(result.isDefault).toBe(false);

    // starred 同步：新名 starred=true，旧名 starred=false
    const starredSet = cacheMod.listStarredBranches(PROJECT_ID);
    expect(starredSet.has('feature-2')).toBe(true);
    expect(starredSet.has('feature-1')).toBe(false);
  });

  it('rename → gitea 抛 IpcError → 透传 .toJSON()', async () => {
    const { IpcError, IpcErrorCode } = await import('@shared/errors');
    mocks.renameGiteaBranch.mockRejectedValueOnce(
      new IpcError({ code: IpcErrorCode.NOT_FOUND, message: 'branch not found' }),
    );

    await expect(
      getHandler('branches.rename')({
        projectId: PROJECT_ID,
        oldName: 'missing',
        newName: 'whatever',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('Zod 校验失败（oldName 空字符串）', async () => {
    await expect(
      getHandler('branches.rename')({ projectId: PROJECT_ID, oldName: '', newName: 'x' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('ipc/branches · star (纯本地 op)', () => {
  beforeEach(seedProjectAndRegister);

  it('branches.star true → 写入 starred_branches', async () => {
    await getHandler('branches.star')({ projectId: PROJECT_ID, branch: 'feature-1', starred: true });
    const cacheMod = await import('../../cache/branches.js');
    expect(cacheMod.listStarredBranches(PROJECT_ID).has('feature-1')).toBe(true);
  });

  it('branches.star false → 删除 starred_branches', async () => {
    const cacheMod = await import('../../cache/branches.js');
    cacheMod.setStarred({ projectId: PROJECT_ID, branch: 'feature-1', starred: true });

    await getHandler('branches.star')({ projectId: PROJECT_ID, branch: 'feature-1', starred: false });
    expect(cacheMod.listStarredBranches(PROJECT_ID).has('feature-1')).toBe(false);
  });

  it('Zod 校验失败（starred 非 boolean）', async () => {
    await expect(
      getHandler('branches.star')({ projectId: PROJECT_ID, branch: 'x', starred: 'yes' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});