/**
 * main 端 labels IPC handler 单测
 *
 * 覆盖：list / create
 *
 * Mock 策略（参考 issues.test.ts）：
 * - electron.ipcMain.handle mock 推 callback 到 globalThis.__ipcHandlers
 * - 整个 gitea/labels.js mock 掉（listGiteaLabels / createGiteaLabel）
 * - 真实 localStore + 真实 resolveProject（account/project seed）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  listGiteaLabels: vi.fn(),
  createGiteaLabel: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../gitea/labels.js', () => ({
  listGiteaLabels: mocks.listGiteaLabels,
  createGiteaLabel: mocks.createGiteaLabel,
}));

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-labels-ipc-test-'));
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

function makeLabelDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    name: 'bug',
    color: '#ff0000',
    description: '',
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

  const { registerLabelsIpc } = await import('../labels.js');
  registerLabelsIpc();
}

describe('ipc/labels · list / create', () => {
  beforeEach(seedProjectAndRegister);

  it('labels.list → 调 listGiteaLabels 返 ListLabelsResp', async () => {
    mocks.listGiteaLabels.mockResolvedValueOnce({ items: [makeLabelDto()], hasMore: false });
    const result = (await getHandler('labels.list')({ projectId: PROJECT_ID })) as {
      items: Array<{ id: number }>;
      hasMore: boolean;
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(100);
    expect(result.hasMore).toBe(false);
    expect(mocks.listGiteaLabels).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'org', repo: 'repo', giteaUrl: 'https://gitea.example.com' }),
    );
  });

  it('labels.list → Zod 校验失败（缺 projectId）', async () => {
    await expect(getHandler('labels.list')({})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('labels.list → Zod 校验失败（page < 1）', async () => {
    await expect(
      getHandler('labels.list')({ projectId: PROJECT_ID, page: 0 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('labels.create → 调 createGiteaLabel 返 LabelDto', async () => {
    mocks.createGiteaLabel.mockResolvedValueOnce(makeLabelDto({ name: 'enhancement', color: '#00ff00' }));
    const result = (await getHandler('labels.create')({
      projectId: PROJECT_ID,
      name: 'enhancement',
      color: '#00ff00',
    })) as { name: string; color: string };
    expect(result.name).toBe('enhancement');
    expect(result.color).toBe('#00ff00');
    expect(mocks.createGiteaLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'enhancement', color: '#00ff00' }),
    );
  });

  it('labels.create → description 可选（不传 = 不下发到 gitea）', async () => {
    mocks.createGiteaLabel.mockResolvedValueOnce(makeLabelDto());
    await getHandler('labels.create')({ projectId: PROJECT_ID, name: 'bug', color: '#ff0000' });
    expect(mocks.createGiteaLabel).toHaveBeenCalledWith(
      expect.not.objectContaining({ description: expect.anything() }),
    );
  });

  it('labels.create → description 透传', async () => {
    mocks.createGiteaLabel.mockResolvedValueOnce(makeLabelDto());
    await getHandler('labels.create')({
      projectId: PROJECT_ID,
      name: 'bug',
      color: '#ff0000',
      description: 'something is broken',
    });
    expect(mocks.createGiteaLabel).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'something is broken' }),
    );
  });

  it('labels.create → Zod 校验失败（name 空字符串）', async () => {
    await expect(
      getHandler('labels.create')({ projectId: PROJECT_ID, name: '', color: '#ff0000' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('labels.create → gitea 抛 IpcError → handler 透传 .toJSON()', async () => {
    const { IpcError, IpcErrorCode } = await import('@shared/errors');
    mocks.createGiteaLabel.mockRejectedValueOnce(
      new IpcError({ code: IpcErrorCode.NOT_FOUND, message: 'repo not found' }),
    );
    await expect(
      getHandler('labels.create')({ projectId: PROJECT_ID, name: 'bug', color: '#ff0000' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});