/**
 * gitea/repos.ts 单测
 *
 * 重点：
 * - happy path: list 200 + DTO 字段映射
 * - 错误码映射：401/403/404/409/429/5xx + 网络断 7 种
 * - query 过滤在客户端做（包含 full_name / name / description，大小写不敏感）
 * - permissions 默认值
 * - description 缺失时默认空字符串
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===== mock giteaFetch =====
const mockFetch = vi.fn();
vi.mock('../gitea/client.js', () => ({
  giteaFetch: (...args: unknown[]) => mockFetch(...args),
}));

const { listGiteaRepos } = await import('./repos.js');
const { IpcErrorCode } = await import('@shared/errors');

beforeEach(() => {
  vi.clearAllMocks();
});

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
    description: 'A test repo',
    default_branch: 'main',
    archived: false,
    private: false,
    updated_at: '2026-06-10T00:00:00.000Z',
    permissions: { pull: true, push: true, admin: false },
    owner: { login: 'alice' },
    ...overrides,
  };
}

describe('listGiteaRepos happy path', () => {
  it('返回 RepoDTO[] + hasMore + total', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo(),
      makeRawRepo({ id: 2, name: 'bar', full_name: 'alice/bar' }),
    ]);
    const r = await listGiteaRepos({
      giteaUrl: 'http://x',
      username: 'alice',
      page: 1,
      limit: 50,
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.owner).toBe('alice');
    expect(r.items[0]!.name).toBe('foo');
    expect(r.items[0]!.fullName).toBe('alice/foo');
    expect(r.items[0]!.defaultBranch).toBe('main');
    expect(r.items[0]!.permissions.pull).toBe(true);
    expect(r.items[0]!.isProject).toBe(false); // 由 IPC handler 覆盖
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(false);
  });

  it('返回项数 == limit 时 hasMore=true', async () => {
    const raws = Array.from({ length: 50 }, (_, i) =>
      makeRawRepo({ id: i, name: `r${i}`, full_name: `alice/r${i}` }),
    );
    mockFetch.mockResolvedValueOnce(raws);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice', limit: 50 });
    expect(r.hasMore).toBe(true);
  });

  it('description 为空字符串时填默认 ""', async () => {
    mockFetch.mockResolvedValueOnce([makeRawRepo({ description: '' as unknown as string })]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(r.items[0]!.description).toBe('');
  });

  it('description 字段为 null 时填默认 ""', async () => {
    mockFetch.mockResolvedValueOnce([makeRawRepo({ description: null as unknown as string })]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(r.items[0]!.description).toBe('');
  });

  it('default_branch 为空时 fallback main', async () => {
    mockFetch.mockResolvedValueOnce([makeRawRepo({ default_branch: '' })]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(r.items[0]!.defaultBranch).toBe('main');
  });

  it('permissions 缺失时 pull=true / push=false / admin=false', async () => {
    mockFetch.mockResolvedValueOnce([makeRawRepo({ permissions: undefined as unknown as { pull: boolean; push: boolean; admin: boolean } })]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(r.items[0]!.permissions).toEqual({ pull: true, push: false, admin: false });
  });

  it('archived / private 强制 boolean', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo({ archived: 1 as unknown as boolean, private: 0 as unknown as boolean }),
    ]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(r.items[0]!.archived).toBe(true);
    expect(r.items[0]!.private).toBe(false);
  });
});

describe('listGiteaRepos query 过滤（客户端）', () => {
  it('query 命中 full_name', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo({ full_name: 'alice/foo' }),
      makeRawRepo({ id: 2, name: 'bar', full_name: 'alice/bar' }),
    ]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice', query: 'foo' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.fullName).toBe('alice/foo');
  });

  it('query 大小写不敏感', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo({ name: 'Foo', full_name: 'alice/Foo' }),
    ]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice', query: 'FOO' });
    expect(r.items).toHaveLength(1);
  });

  it('query 命中 description', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo({ name: 'x', full_name: 'alice/x', description: 'Hello world' }),
      makeRawRepo({ id: 2, name: 'y', full_name: 'alice/y', description: 'unrelated' }),
    ]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice', query: 'hello' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.name).toBe('x');
  });

  it('query 命中 name', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo({ name: 'special-name', full_name: 'alice/special-name' }),
    ]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice', query: 'special' });
    expect(r.items).toHaveLength(1);
  });

  it('query 不传 = 不过滤', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawRepo(),
      makeRawRepo({ id: 2, name: 'bar', full_name: 'alice/bar' }),
    ]);
    const r = await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(r.items).toHaveLength(2);
  });
});

describe('listGiteaRepos 错误码映射（giteaFetch 抛 IpcError，list 直接透传）', () => {
  it('401 → IpcError TOKEN_INVALID 透传', async () => {
    const err = new Error('401');
    (err as unknown as { code: string }).code = IpcErrorCode.TOKEN_INVALID;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
  });

  it('403 → PERMISSION_DENIED', async () => {
    const err = new Error('403');
    (err as unknown as { code: string }).code = IpcErrorCode.PERMISSION_DENIED;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.PERMISSION_DENIED });
  });

  it('404 → NOT_FOUND', async () => {
    const err = new Error('404');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('429 → RATE_LIMITED', async () => {
    const err = new Error('429');
    (err as unknown as { code: string }).code = IpcErrorCode.RATE_LIMITED;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.RATE_LIMITED });
  });

  it('5xx → GITEA_ERROR', async () => {
    const err = new Error('500');
    (err as unknown as { code: string }).code = IpcErrorCode.GITEA_ERROR;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.GITEA_ERROR });
  });

  it('网络断（fetch reject）→ NETWORK_OFFLINE', async () => {
    const err = new Error('fetch failed');
    (err as unknown as { code: string }).code = IpcErrorCode.NETWORK_OFFLINE;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NETWORK_OFFLINE });
  });
});

describe('listGiteaRepos 入参映射', () => {
  it('page + limit 透传到 giteaFetch', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice', page: 3, limit: 25 });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x',
      'alice',
      '/user/repos',
      expect.objectContaining({ method: 'GET', query: { page: 3, limit: 25 } }),
    );
  });

  it('缺省 page=1 + limit=50', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaRepos({ giteaUrl: 'http://x', username: 'alice' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x',
      'alice',
      '/user/repos',
      expect.objectContaining({ query: { page: 1, limit: 50 } }),
    );
  });
});
