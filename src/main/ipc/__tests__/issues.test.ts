/**
 * main 端 issues IPC handler 单测
 *
 * 覆盖：list / get / create / update / addLabel / removeLabel / moveColumn / comment.list / comment.create
 *
 * Mock 策略（参考 business-core.test.ts）：
 * - 真实 localStore（temp dir）
 * - 整个 gitea/issues.js + board/move-card.js mock 掉
 * - 真实 resolveProject（mock 不掉，靠 account/project seed）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  listIssuesFromGitea: vi.fn(),
  moveIssueColumn: vi.fn(),
  getGiteaIssue: vi.fn(),
  createGiteaIssue: vi.fn(),
  editGiteaIssue: vi.fn(),
  addGiteaIssueLabel: vi.fn(),
  removeGiteaIssueLabel: vi.fn(),
  listGiteaIssueComments: vi.fn(),
  createGiteaIssueComment: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../board/card-from-issues.js', () => ({
  listIssuesFromGitea: mocks.listIssuesFromGitea,
}));

vi.mock('../../board/move-card.js', () => ({
  moveIssueColumn: mocks.moveIssueColumn,
}));

vi.mock('../../gitea/issues.js', () => ({
  getGiteaIssue: mocks.getGiteaIssue,
  createGiteaIssue: mocks.createGiteaIssue,
  editGiteaIssue: mocks.editGiteaIssue,
  addGiteaIssueLabel: mocks.addGiteaIssueLabel,
  removeGiteaIssueLabel: mocks.removeGiteaIssueLabel,
  listGiteaIssueComments: mocks.listGiteaIssueComments,
  createGiteaIssueComment: mocks.createGiteaIssueComment,
}));

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-issues-ipc-test-'));
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

function makeIssueDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    index: 1,
    title: 'A',
    body: '',
    state: 'open' as const,
    author: { username: 'tester' },
    labels: [],
    isPullRequest: false,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

/** 工具：找 ipcMain.handle 注册的 callback
 *
 * 真实 handler 签名：`(event, rawArgs) => result`
 * 我们 helper 让测试代码写 `(rawArgs) => result`。
 *
 * 实现：ipcMain.handle mock 把 (channel, cb) 推到 globalThis.__ipcHandlers Map；
 * 这样多个 describe 共享同一份 handler registry（不会因 beforeEach 重设 mockImplementation 而丢）。*/
function getHandler(channel: string): (rawArgs: unknown) => Promise<unknown> {
  const registry = (globalThis as { __ipcHandlers?: Map<string, (e: unknown, a: unknown) => Promise<unknown>> }).__ipcHandlers;
  if (!registry) throw new Error('__ipcHandlers registry not initialized');
  return (rawArgs) => {
    const fn = registry.get(channel);
    if (!fn) throw new Error(`Handler not registered for channel: ${channel}`);
    return fn(undefined, rawArgs);
  };
}

describe('ipc/issues · list / get / create / update + label actions', () => {
  beforeEach(async () => {
    // 注册 capture：把 ipcMain.handle 的 callback 存到 globalThis.__ipcHandlers
    const electron = await import('electron');
    const ipcMainMock = vi.mocked(electron.ipcMain);
    ipcMainMock.handle.mockImplementation((channel: unknown, cb: unknown) => {
      const g = globalThis as { __ipcHandlers?: Map<string, (e: unknown, a: unknown) => Promise<unknown>> };
      if (!g.__ipcHandlers) g.__ipcHandlers = new Map();
      g.__ipcHandlers.set(channel as string, cb as (e: unknown, a: unknown) => Promise<unknown>);
    });

    // seed localStore
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

    const { registerIssuesIpc } = await import('../issues.js');
    registerIssuesIpc();
  });

  it('issues.list → 调 listIssuesFromGitea 返 ListIssuesResp', async () => {
    const dto = makeIssueDto();
    mocks.listIssuesFromGitea.mockResolvedValueOnce({ items: [dto], hasMore: false });
    const result = (await getHandler('issues.list')({ projectId: PROJECT_ID })) as {
      items: typeof dto[];
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('A');
  });

  it('issues.get → 调 getGiteaIssue 返 IssueDto', async () => {
    const dto = makeIssueDto({ index: 42 });
    mocks.getGiteaIssue.mockResolvedValueOnce(dto);
    const result = (await getHandler('issues.get')({ projectId: PROJECT_ID, issueIndex: 42 })) as typeof dto;
    expect(result.index).toBe(42);
  });

  it('issues.create → 调 createGiteaIssue 返 IssueDto', async () => {
    const dto = makeIssueDto({ title: 'new' });
    mocks.createGiteaIssue.mockResolvedValueOnce(dto);
    const result = (await getHandler('issues.create')({
      projectId: PROJECT_ID,
      title: 'new',
      refBranch: 'main',
    })) as typeof dto;
    expect(result.title).toBe('new');
  });

  it('issues.update → 调 editGiteaIssue 返 IssueDto', async () => {
    const dto = makeIssueDto({ title: 'updated' });
    mocks.editGiteaIssue.mockResolvedValueOnce(dto);
    const result = (await getHandler('issues.update')({
      projectId: PROJECT_ID,
      issueIndex: 1,
      patch: { title: 'updated' },
    })) as typeof dto;
    expect(result.title).toBe('updated');
  });

  it('issues.addLabel → 调 addGiteaIssueLabel', async () => {
    mocks.addGiteaIssueLabel.mockResolvedValueOnce(undefined);
    await expect(
      getHandler('issues.addLabel')({ projectId: PROJECT_ID, issueIndex: 1, labelId: 100 }),
    ).resolves.toBeUndefined();
    expect(mocks.addGiteaIssueLabel).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, labelId: 100 }),
    );
  });

  it('issues.removeLabel → 调 removeGiteaIssueLabel', async () => {
    mocks.removeGiteaIssueLabel.mockResolvedValueOnce(undefined);
    await expect(
      getHandler('issues.removeLabel')({ projectId: PROJECT_ID, issueIndex: 1, labelId: 100 }),
    ).resolves.toBeUndefined();
    expect(mocks.removeGiteaIssueLabel).toHaveBeenCalled();
  });

  it('issues.moveColumn → 调 moveIssueColumn 返 IssueDto', async () => {
    const dto = makeIssueDto();
    mocks.moveIssueColumn.mockResolvedValueOnce(dto);
    const result = (await getHandler('issues.moveColumn')({
      projectId: PROJECT_ID,
      issueIndex: 1,
      fromColumnId: 'c-from',
      toColumnId: 'c-to',
    })) as typeof dto;
    expect(result.index).toBe(1);
  });
});

describe('ipc/issues · comment.list / comment.create', () => {
  beforeEach(async () => {
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

    const { registerIssuesIpc } = await import('../issues.js');
    registerIssuesIpc();
  });

  it('issues.comment.list → 返 IssueCommentDto[]', async () => {
    mocks.listGiteaIssueComments.mockResolvedValueOnce([
      { id: 100, body: 'first', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', author: { username: 'tester' } },
    ]);
    const result = (await getHandler('issues.comment.list')({
      projectId: PROJECT_ID,
      issueIndex: 1,
    })) as Array<{ id: number; body: string }>;
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe('first');
  });

  it('issues.comment.create → 调 createGiteaIssueComment 返 IssueCommentDto', async () => {
    const dto = { id: 101, body: 'reply', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', author: { username: 'tester' } };
    mocks.createGiteaIssueComment.mockResolvedValueOnce(dto);
    const result = (await getHandler('issues.comment.create')({
      projectId: PROJECT_ID,
      issueIndex: 1,
      body: 'reply',
    })) as typeof dto;
    expect(result.body).toBe('reply');
  });

  it('issues.comment.create 入参 body 空字符串 → Zod 校验失败', async () => {
    await expect(
      getHandler('issues.comment.create')({
        projectId: PROJECT_ID,
        issueIndex: 1,
        body: '',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
