/**
 * main 端 repos IPC handler 单测
 *
 * 覆盖：list (cache hit/miss + isProject JOIN + lastSync touch + backfillDefaultBranch) /
 *       addProject / removeProject
 *
 * Mock 策略（参考 labels.test.ts / branches.test.ts）：
 * - electron.ipcMain.handle mock 推 callback 到 globalThis.__ipcHandlers
 * - 整个 gitea/repos.js mock 掉（listGiteaRepos）
 * - 真实 localStore + 真实 cache/repos（addProject / removeProject 真路径）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  listGiteaRepos: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../gitea/repos.js', () => ({
  listGiteaRepos: mocks.listGiteaRepos,
}));

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-repos-ipc-test-'));
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

const ACCOUNT_ID = 'a-1';

function getHandler(channel: string): (rawArgs: unknown) => Promise<unknown> {
  const registry = (
    globalThis as { __ipcHandlers?: Map<string, (e: unknown, a: unknown) => Promise<unknown>> }
  ).__ipcHandlers;
  if (!registry) throw new Error('__ipcHandlers registry not initialized');
  return (rawArgs) => {
    const fn = registry.get(channel);
    if (!fn) throw new Error(`Handler not registered for channel: ${channel}`);
    return fn(undefined, rawArgs);
  };
}

function makeRepoDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    owner: 'org',
    name: 'repo-1',
    fullName: 'org/repo-1',
    description: '',
    defaultBranch: 'main',
    archived: false,
    private: false,
    updatedAt: '2026-06-01T00:00:00Z',
    permissions: { pull: true, push: false, admin: false },
    isProject: false,
    ...overrides,
  };
}

async function seedAccountAndRegister() {
  const electron = await import('electron');
  const ipcMainMock = vi.mocked(electron.ipcMain);
  ipcMainMock.handle.mockImplementation((channel: unknown, cb: unknown) => {
    const g = globalThis as {
      __ipcHandlers?: Map<string, (e: unknown, a: unknown) => Promise<unknown>>;
    };
    if (!g.__ipcHandlers) g.__ipcHandlers = new Map();
    g.__ipcHandlers.set(channel as string, cb as (e: unknown, a: unknown) => Promise<unknown>);
  });

  const stateMod = await import('../../local/state.js');
  await stateMod._resetLocalStoreForTest();
  await stateMod.initLocalStore();
  stateMod.getLocalStore().mutate((s) => {
    s.accounts.push({
      id: ACCOUNT_ID,
      giteaUrl: 'https://gitea.example.com',
      username: 'tester',
      keychainService: 'gitea-kanban',
      createdAt: Date.now(),
      userInfo: { giteaUserId: 1, login: 'tester', fullName: 'tester', updatedAt: Date.now() },
    });
    return s;
  });

  const { registerReposIpc } = await import('../repos.js');
  registerReposIpc();
}

describe('ipc/repos · list (cache hit/miss + isProject JOIN + lastSync + backfill)', () => {
  beforeEach(seedAccountAndRegister);

  it('cache miss → 调 gitea → isProject=false（没建项目）', async () => {
    mocks.listGiteaRepos.mockResolvedValueOnce({
      items: [
        makeRepoDto(),
        makeRepoDto({ id: 2, owner: 'org', name: 'repo-2', fullName: 'org/repo-2' }),
      ],
      total: 2,
      hasMore: false,
    });

    const result = (await getHandler('repos.list')({ giteaAccountId: ACCOUNT_ID })) as {
      items: Array<{ isProject: boolean; owner: string; name: string }>;
    };
    expect(result.items).toHaveLength(2);
    expect(result.items.every((r) => r.isProject === false)).toBe(true);
    expect(mocks.listGiteaRepos).toHaveBeenCalledWith(
      expect.objectContaining({ giteaUrl: 'https://gitea.example.com', username: 'tester' }),
    );
  });

  it('cache miss + 项目已建 → isProject=true + lastSyncAt 填上', async () => {
    // 先 addProject 建一个本地项目
    await getHandler('repos.addProject')({
      giteaAccountId: ACCOUNT_ID,
      owner: 'org',
      name: 'repo-1',
    });

    mocks.listGiteaRepos.mockResolvedValueOnce({
      items: [makeRepoDto()],
      total: 1,
      hasMore: false,
    });

    const result = (await getHandler('repos.list')({ giteaAccountId: ACCOUNT_ID })) as {
      items: Array<{ isProject: boolean; lastSyncAt?: string }>;
    };
    expect(result.items[0]?.isProject).toBe(true);
    expect(result.items[0]?.lastSyncAt).toBeDefined();
  });

  it('cache miss + 项目 defaultBranch=null + gitea 有 → 触发 backfill', async () => {
    // addProject + 手动把项目的 defaultBranch 设为 null（模拟 v1.1.3 那个 timeline polish bug 场景）
    await getHandler('repos.addProject')({
      giteaAccountId: ACCOUNT_ID,
      owner: 'org',
      name: 'repo-1',
    });
    const stateMod = await import('../../local/state.js');
    stateMod.getLocalStore().mutate((s) => {
      const proj = s.projects.find((p) => p.owner === 'org' && p.name === 'repo-1');
      if (proj) proj.defaultBranch = null;
      return s;
    });

    mocks.listGiteaRepos.mockResolvedValueOnce({
      items: [makeRepoDto({ defaultBranch: 'trunk' })],
      total: 1,
      hasMore: false,
    });

    await getHandler('repos.list')({ giteaAccountId: ACCOUNT_ID });

    // 验证：localStore 里 defaultBranch 已 backfill
    stateMod.getLocalStore().mutate((s) => {
      const proj = s.projects.find((p) => p.owner === 'org' && p.name === 'repo-1');
      expect(proj?.defaultBranch).toBe('trunk');
      return s;
    });
  });

  it('cache hit → 第二次不调 gitea', async () => {
    mocks.listGiteaRepos.mockResolvedValueOnce({
      items: [makeRepoDto()],
      total: 1,
      hasMore: false,
    });

    await getHandler('repos.list')({ giteaAccountId: ACCOUNT_ID });
    expect(mocks.listGiteaRepos).toHaveBeenCalledTimes(1);

    await getHandler('repos.list')({ giteaAccountId: ACCOUNT_ID });
    expect(mocks.listGiteaRepos).toHaveBeenCalledTimes(1); // 没增加
  });

  it('account 不存在 → NOT_FOUND', async () => {
    await expect(getHandler('repos.list')({ giteaAccountId: 'not-exist' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('Zod 校验失败（缺 giteaAccountId）', async () => {
    await expect(getHandler('repos.list')({})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('ipc/repos · addProject (走 dispatch)', () => {
  beforeEach(seedAccountAndRegister);

  it('成功 → 返 RepoProjectDto + 写 localStore', async () => {
    const result = (await getHandler('repos.addProject')({
      giteaAccountId: ACCOUNT_ID,
      owner: 'org',
      name: 'repo-1',
    })) as { id: string; owner: string; name: string };

    expect(result.id).toBeDefined();
    expect(result.owner).toBe('org');
    expect(result.name).toBe('repo-1');

    // 验证 localStore 真的写进去了
    const stateMod = await import('../../local/state.js');
    const state = stateMod.getLocalStore().get();
    expect(state.projects.find((p) => p.id === result.id)).toBeDefined();
  });

  it('account 不存在 → NOT_FOUND（addProject 入口校验）', async () => {
    await expect(
      getHandler('repos.addProject')({ giteaAccountId: 'ghost', owner: 'org', name: 'r' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('Zod 校验失败（name 空字符串）', async () => {
    await expect(
      getHandler('repos.addProject')({ giteaAccountId: ACCOUNT_ID, owner: 'org', name: '' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('ipc/repos · removeProject (走 dispatch)', () => {
  beforeEach(seedAccountAndRegister);

  it('成功 → 从 localStore 删除', async () => {
    const added = (await getHandler('repos.addProject')({
      giteaAccountId: ACCOUNT_ID,
      owner: 'org',
      name: 'repo-1',
    })) as { id: string };

    await getHandler('repos.removeProject')({ projectId: added.id });

    const stateMod = await import('../../local/state.js');
    const state = stateMod.getLocalStore().get();
    expect(state.projects.find((p) => p.id === added.id)).toBeUndefined();
  });

  it('Zod 校验失败（projectId 空字符串）', async () => {
    await expect(getHandler('repos.removeProject')({ projectId: '' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
