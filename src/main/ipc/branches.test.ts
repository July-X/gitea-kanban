/**
 * src/main/ipc/branches.ts 单测
 *
 *覆盖（任务 prompt §7 + §关键约束）：
 * - registerBranchesIpc 注册5 个 channel
 * - happy path：branches.list200 → BranchDto[] + isDefault JOIN + starred JOIN
 * - cache hit：第二次调用相同 args 不发 gitea fetch
 * - cache invalidate：create 后 list 不命中旧缓存
 * -危险操作保护：rename / delete 默认分支 → CONFLICT
 * -错误码透传：gitea401/404 → IpcError TOKEN_INVALID/NOT_FOUND
 * - Zod校验：缺 projectId → VALIDATION_FAILED
 * - resolveProject缺失：NOT_FOUND
 *
 * mock思路：与 repos.test.ts 一致 —— ipcMain.handle 把回调存到 Map，测试从 Map调 channel
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

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

// =====动态 import顺序必须在 mock之后 =====
const { IpcErrorCode, IpcError } = await import('@shared/errors');
const { IpcChannel } = await import('./schema.js');
const { registerBranchesIpc, unregisterBranchesIpc } = await import('./branches.js');
const sqliteMod = await import('../cache/sqlite.js');
const { giteaAccounts } = await import('../cache/schema/giteaAccounts.js');
const { repoProjects } = await import('../cache/schema/repoProjects.js');

const tmp = mkdtempSync(join(tmpdir(), 'gitea-kanban-ipc-branches-test-'));
let currentDbPath = '';

function makeRawBranch(overrides: Partial<{
 name: string;
 commit_id: string;
 commit_message: string;
 commit_author_name: string;
 commit_author_date: string;
 protected: boolean;
}> = {}) {
 return {
 name: 'feature/x',
 commit: {
 id: overrides.commit_id ?? 'abc123',
 message: overrides.commit_message ?? 'feat: hello',
 author: {
 name: overrides.commit_author_name ?? 'alice',
 email: 'alice@example.com',
 date: overrides.commit_author_date ?? '2026-06-10T00:00:00.000Z',
 },
 },
 protected: overrides.protected ?? false,
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

async function seedProject(
 projectId = 'proj-1',
 giteaAccountId = 'acc-1',
 owner = 'alice',
 name = 'foo',
 defaultBranch: string | null = 'main',
): Promise<string> {
 const existing = sqliteMod.getDb().select().from(repoProjects).all().find((p) => p.id === projectId);
 if (!existing) {
 sqliteMod.getDb().insert(repoProjects).values({
 id: projectId,
 giteaAccountId,
 owner,
 name,
 defaultBranch,
 createdAt: new Date(),
 }).run();
 }
 return projectId;
}

beforeEach(async () => {
 vi.clearAllMocks();
 ipcHandlers.clear();
 currentDbPath = join(tmp, `test-${Math.random().toString(36).slice(2)}.db`);
 sqliteMod._setSqlitePathForTest(currentDbPath);
 await sqliteMod.initSqlite();
 await seedAccount();
 await seedProject();
 registerBranchesIpc();
});

afterEach(async () => {
 unregisterBranchesIpc();
 await sqliteMod._resetSqliteForTest();
});

afterAll(() => {
 try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ===== 注册断言 =====

describe('registerBranchesIpc', () => {
 it('注册5 个 channel', () => {
 expect(ipcHandlers.has(IpcChannel.BRANCHES_LIST)).toBe(true);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_CREATE)).toBe(true);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_RENAME)).toBe(true);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_DELETE)).toBe(true);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_STAR)).toBe(true);
 });

 it('unregisterBranchesIpc 清空所有 channel', () => {
 unregisterBranchesIpc();
 expect(ipcHandlers.has(IpcChannel.BRANCHES_LIST)).toBe(false);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_CREATE)).toBe(false);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_RENAME)).toBe(false);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_DELETE)).toBe(false);
 expect(ipcHandlers.has(IpcChannel.BRANCHES_STAR)).toBe(false);
 });
});

// ===== branches.list happy path =====

describe('branches.list happy path', () => {
 it('返回 BranchDto[] + isDefault JOIN + starred JOIN', async () => {
 mockGiteaFetch.mockResolvedValueOnce([
 makeRawBranch({ name: 'main' }),
 makeRawBranch({ name: 'feature/x' }),
 ]);
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 const r = (await handler({}, { projectId: 'proj-1' })) as {
 items: Array<{ name: string; isDefault: boolean; starred: boolean }>;
 total: number;
 hasMore: boolean;
 };
 expect(r.items).toHaveLength(2);
 // main 是 defaultBranch → isDefault=true
 expect(r.items.find((b) => b.name === 'main')?.isDefault).toBe(true);
 expect(r.items.find((b) => b.name === 'feature/x')?.isDefault).toBe(false);
 // starred JOIN：没 star任何分支 → 全 false
 expect(r.items[0]!.starred).toBe(false);
 expect(r.items[1]!.starred).toBe(false);
 expect(r.total).toBe(2);
 expect(r.hasMore).toBe(false);
 });

 it('starred JOIN：star过的分支 starred=true', async () => {
 // 先 star 一个分支
 const starHandler = ipcHandlers.get(IpcChannel.BRANCHES_STAR)!;
 await starHandler({}, { projectId: 'proj-1', branch: 'feature/x', starred: true });

 // 再 list
 mockGiteaFetch.mockResolvedValueOnce([
 makeRawBranch({ name: 'main' }),
 makeRawBranch({ name: 'feature/x' }),
 ]);
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 const r = (await handler({}, { projectId: 'proj-1' })) as {
 items: Array<{ name: string; starred: boolean }>;
 };
 expect(r.items.find((b) => b.name === 'feature/x')?.starred).toBe(true);
 expect(r.items.find((b) => b.name === 'main')?.starred).toBe(false);
 });
});

// ===== cache行为 =====

describe('branches.list缓存', () => {
 it('第二次调用相同 args命中缓存（不调 gitea）', async () => {
 mockGiteaFetch.mockResolvedValueOnce([makeRawBranch()]);
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 const args = { projectId: 'proj-1', page:1, limit:50 };
 await handler({}, args);
 await handler({}, args); //第二次
 expect(mockGiteaFetch).toHaveBeenCalledTimes(1);
 });

 it('create失效 branches缓存', async () => {
 //写一次缓存（用 list触发 setBranchesCache）
 mockGiteaFetch.mockResolvedValueOnce([makeRawBranch()]);
 const listHandler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 const args = { projectId: 'proj-1' };
 await listHandler({}, args);
 await listHandler({}, args); //第二次应命中缓存
 expect(mockGiteaFetch).toHaveBeenCalledTimes(1);

 // create 应失效缓存
 mockGiteaFetch.mockResolvedValueOnce(makeRawBranch({ name: 'new-branch' }));
 const createHandler = ipcHandlers.get(IpcChannel.BRANCHES_CREATE)!;
 await createHandler({}, {
 projectId: 'proj-1', newBranch: 'new-branch', fromBranch: 'main',
 });

 //第三次 list 应重新调 gitea
 mockGiteaFetch.mockResolvedValueOnce([makeRawBranch()]);
 await listHandler({}, args);
 expect(mockGiteaFetch).toHaveBeenCalledTimes(3);
 });
});

// ===== branches.create =====

describe('branches.create', () => {
 it('happy path：返回 BranchDto +失效 cache', async () => {
 mockGiteaFetch.mockResolvedValueOnce(makeRawBranch({ name: 'feature/y' }));
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_CREATE)!;
 const r = (await handler({}, {
 projectId: 'proj-1', newBranch: 'feature/y', fromBranch: 'main',
 })) as { name: string; sha: string; isDefault: boolean };
 expect(r.name).toBe('feature/y');
 expect(r.isDefault).toBe(false);
 });

 it('缺 newBranch → VALIDATION_FAILED', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_CREATE)!;
 await expect(handler({}, { projectId: 'proj-1', fromBranch: 'main' }))
 .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
 });
});

// ===== branches.rename（默认分支保护）=====

describe('branches.rename', () => {
 it('happy path：改名 +同步 starred（老名 starred=true → 新名 starred=true）', async () => {
 // 先 star 老名
 const starHandler = ipcHandlers.get(IpcChannel.BRANCHES_STAR)!;
 await starHandler({}, { projectId: 'proj-1', branch: 'feature/x', starred: true });

 mockGiteaFetch.mockResolvedValueOnce(makeRawBranch({ name: 'feature/y' }));
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_RENAME)!;
 await handler({}, {
 projectId: 'proj-1', oldName: 'feature/x', newName: 'feature/y',
 });

 //验证 starred同步到新名（setStarred 会清旧名、加新名）
 const { listStarredBranches } = await import('../cache/branches.js');
 const starred = listStarredBranches('proj-1');
 expect(starred.has('feature/y')).toBe(true);
 expect(starred.has('feature/x')).toBe(false);
 });

 it('改名默认分支 → CONFLICT', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_RENAME)!;
 await expect(handler({}, {
 projectId: 'proj-1', oldName: 'main', newName: 'master',
 })).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
 expect(mockGiteaFetch).not.toHaveBeenCalled();
 });
});

// ===== branches.delete（默认分支保护）=====

describe('branches.delete', () => {
 it('happy path：删除 +清理 starred', async () => {
 // 先 star
 const starHandler = ipcHandlers.get(IpcChannel.BRANCHES_STAR)!;
 await starHandler({}, { projectId: 'proj-1', branch: 'feature/x', starred: true });

 mockGiteaFetch.mockResolvedValueOnce(undefined);
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_DELETE)!;
 await expect(handler({}, { projectId: 'proj-1', branch: 'feature/x' }))
 .resolves.toBeUndefined();

 // starred 应被清掉
 const { listStarredBranches } = await import('../cache/branches.js');
 const starred = listStarredBranches('proj-1');
 expect(starred.has('feature/x')).toBe(false);
 });

 it('删默认分支 → CONFLICT', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_DELETE)!;
 await expect(handler({}, { projectId: 'proj-1', branch: 'main' }))
 .rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
 expect(mockGiteaFetch).not.toHaveBeenCalled();
 });
});

// ===== branches.star =====

describe('branches.star', () => {
 it('happy path：star=true UPSERT', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_STAR)!;
 await expect(handler({}, {
 projectId: 'proj-1', branch: 'feature/x', starred: true,
 })).resolves.toBeUndefined();

 const { listStarredBranches } = await import('../cache/branches.js');
 expect(listStarredBranches('proj-1').has('feature/x')).toBe(true);
 });

 it('happy path：star=false DELETE', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_STAR)!;
 // 先 star
 await handler({}, { projectId: 'proj-1', branch: 'feature/x', starred: true });
 // 再 unstar
 await handler({}, { projectId: 'proj-1', branch: 'feature/x', starred: false });

 const { listStarredBranches } = await import('../cache/branches.js');
 expect(listStarredBranches('proj-1').has('feature/x')).toBe(false);
 });
});

// =====错误码透传 =====

describe('branches.*错误码', () => {
 it('gitea401 → IpcError TOKEN_INVALID', async () => {
 const err = new IpcError({
 code: IpcErrorCode.TOKEN_INVALID,
 message: '登录已过期或 token 无效',
 hint: '请到 gitea重新生成 token 后重新连接',
 httpStatus:401,
 });
 mockGiteaFetch.mockRejectedValueOnce(err);
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 await expect(handler({}, { projectId: 'proj-1' }))
 .rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
 });

 it('gitea404 → IpcError NOT_FOUND', async () => {
 const err = new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: '找不到该资源（可能已被删除）',
 hint: '请刷新列表',
 httpStatus:404,
 });
 mockGiteaFetch.mockRejectedValueOnce(err);
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 await expect(handler({}, { projectId: 'proj-1' }))
 .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
 });

 it('projectId缺失 → VALIDATION_FAILED', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 await expect(handler({}, {}))
 .rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED });
 });

 it('repoProject 不存在 → NOT_FOUND', async () => {
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 await expect(handler({}, { projectId: 'nonexistent' }))
 .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
 });

 it('giteaAccount缺失（项目孤儿）→ NOT_FOUND', async () => {
 //制造孤儿：先建 account+project，再删 account（绕过 FK约束检查）
 sqliteMod.getDb().insert(giteaAccounts).values({
 id: 'orphan-acc',
 giteaUrl: 'http://orphan',
 username: 'orphan',
 keychainService: 'gitea-kanban@http://orphan',
 createdAt: new Date(),
 }).run();
 sqliteMod.getDb().insert(repoProjects).values({
 id: 'orphan-proj',
 giteaAccountId: 'orphan-acc',
 owner: 'a',
 name: 'b',
 defaultBranch: 'main',
 createdAt: new Date(),
 }).run();
 //删 account，制造悬挂 project
 sqliteMod.getDb().delete(giteaAccounts).where(eq(giteaAccounts.id, 'orphan-acc')).run();
 const handler = ipcHandlers.get(IpcChannel.BRANCHES_LIST)!;
 await expect(handler({}, { projectId: 'orphan-proj' }))
 .rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
 });
});
