/**
 * gitea/branches.ts 单测
 *
 * 重点：
 * - list / get / create / rename / delete 5 个端点的 happy path
 * - 错误码映射：401/403/404/409/429/5xx + 网络断
 * - URL 路径拼接（encodeURIComponent 处理 owner/repo 含特殊字符）
 * - body 序列化
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('../gitea/client.js', () => ({
  giteaFetch: (...args: unknown[]) => mockFetch(...args),
}));

const {
  listGiteaBranches,
  getGiteaBranchWithCommit,
  createGiteaBranch,
  renameGiteaBranch,
  deleteGiteaBranch,
} = await import('./branches.js');
const { IpcErrorCode } = await import('@shared/errors');

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRawBranch(overrides: Partial<{ name: string; sha: string; protected: boolean }> = {}) {
  return {
    name: 'main',
    commit: { id: 'abc123sha', message: 'msg', author: { name: 'alice', email: 'a@b', date: '2026-06-10T00:00:00.000Z' } },
    protected: false,
    ...overrides,
  };
}

describe('listGiteaBranches', () => {
  it('happy path: 返回 BranchDTO[] + hasMore=false', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawBranch({ name: 'main' }),
      makeRawBranch({ name: 'feature-x', sha: 'def456' }),
    ]);
    const r = await listGiteaBranches({
      giteaUrl: 'http://x', username: 'alice', owner: 'org', repo: 'proj',
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.name).toBe('main');
    expect(r.items[0]!.sha).toBe('abc123sha');
    expect(r.items[0]!.protected).toBe(false);
    expect(r.items[0]!.isDefault).toBe(false);
    expect(r.items[0]!.starred).toBe(false);
    expect(r.hasMore).toBe(false);
  });

  it('返回数 == limit 时 hasMore=true', async () => {
    const raws = Array.from({ length: 50 }, (_, i) =>
      makeRawBranch({ name: `b${i}`, sha: `sha${i}` }),
    );
    mockFetch.mockResolvedValueOnce(raws);
    const r = await listGiteaBranches({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', limit: 50,
    });
    expect(r.hasMore).toBe(true);
  });

  it('URL 拼接 + query', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaBranches({
      giteaUrl: 'http://x', username: 'alice', owner: 'org/sub', repo: 'my repo',
      page: 2, limit: 25,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/org%2Fsub/my%20repo/branches',
      expect.objectContaining({ method: 'GET', query: { page: 2, limit: 25 } }),
    );
  });

  it('缺省 page=1 + limit=50', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaBranches({ giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/branches',
      expect.objectContaining({ query: { page: 1, limit: 50 } }),
    );
  });

  it('错误码透传（401 TOKEN_INVALID）', async () => {
    const err = new Error('401');
    (err as unknown as { code: string }).code = IpcErrorCode.TOKEN_INVALID;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaBranches({ giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
  });
});

describe('getGiteaBranchWithCommit', () => {
  it('返回 lastCommit 字段', async () => {
    mockFetch.mockResolvedValueOnce({
      name: 'main',
      commit: {
        id: 'sha-xyz',
        message: 'Initial commit',
        author: { name: 'bob', email: 'b@c', date: '2026-06-10T00:00:00.000Z' },
      },
      protected: true,
    });
    const lc = await getGiteaBranchWithCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'main',
    });
    expect(lc.sha).toBe('sha-xyz');
    expect(lc.message).toBe('Initial commit');
    expect(lc.author).toBe('bob');
    expect(lc.date).toBe('2026-06-10T00:00:00.000Z');
  });

  it('commit.author.name 缺失时 fallback <unknown>', async () => {
    mockFetch.mockResolvedValueOnce({
      name: 'main',
      commit: { id: 'sha', message: 'm', author: { name: undefined, email: 'x', date: '2026-01-01T00:00:00.000Z' } },
      protected: false,
    });
    const lc = await getGiteaBranchWithCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'main',
    });
    expect(lc.author).toBe('<unknown>');
  });

  it('author 整段缺失时 fallback <unknown>', async () => {
    mockFetch.mockResolvedValueOnce({
      name: 'main',
      commit: { id: 'sha', message: 'm', author: undefined as unknown as { name: string; email: string; date: string } },
      protected: false,
    });
    const lc = await getGiteaBranchWithCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'main',
    });
    expect(lc.author).toBe('<unknown>');
  });

  it('URL 用 encodeURIComponent 编码 branch 名', async () => {
    mockFetch.mockResolvedValueOnce({
      name: 'feature/with-slash',
      commit: { id: 'sha', message: 'm', author: { name: 'a', email: 'a', date: '2026-01-01T00:00:00.000Z' } },
      protected: false,
    });
    await getGiteaBranchWithCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'feature/with-slash',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/branches/feature%2Fwith-slash',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('createGiteaBranch', () => {
  it('happy path: POST + 返回 BranchDTO 含 lastCommit', async () => {
    mockFetch.mockResolvedValueOnce({
      name: 'feat',
      commit: { id: 'new-sha', message: 'first', author: { name: 'alice', email: 'a@b', date: '2026-06-10T00:00:00.000Z' } },
      protected: false,
    });
    const b = await createGiteaBranch({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      newBranch: 'feat', fromBranch: 'main',
    });
    expect(b.name).toBe('feat');
    expect(b.sha).toBe('new-sha');
    expect(b.lastCommit?.sha).toBe('new-sha');
    expect(b.lastCommit?.author).toBe('alice');
    // body 验证
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/branches',
      expect.objectContaining({
        method: 'POST',
        body: { new_branch_name: 'feat', old_branch_name: 'main' },
      }),
    );
  });

  it('404 NOT_FOUND 透传（fromBranch 不存在）', async () => {
    const err = new Error('404');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      createGiteaBranch({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        newBranch: 'x', fromBranch: 'nonexistent',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

describe('renameGiteaBranch', () => {
  it('happy path: PATCH + body 含 name', async () => {
    mockFetch.mockResolvedValueOnce({
      name: 'feat-v2',
      commit: { id: 'sha-2', message: 'm', author: { name: 'a', email: 'a', date: '2026-01-01T00:00:00.000Z' } },
      protected: false,
    });
    const b = await renameGiteaBranch({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      oldName: 'feat', newName: 'feat-v2',
    });
    expect(b.name).toBe('feat-v2');
    expect(b.sha).toBe('sha-2');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/branches/feat',
      expect.objectContaining({ method: 'PATCH', body: { name: 'feat-v2' } }),
    );
  });

  it('404 NOT_FOUND 透传（gitea 不支持 rename 时会 404）', async () => {
    const err = new Error('404');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      renameGiteaBranch({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        oldName: 'feat', newName: 'feat-v2',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('409 CONFLICT 透传（新名已被占用）', async () => {
    const err = new Error('409');
    (err as unknown as { code: string }).code = IpcErrorCode.CONFLICT;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      renameGiteaBranch({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        oldName: 'feat', newName: 'main',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  });
});

describe('deleteGiteaBranch', () => {
  it('happy path: DELETE 调通', async () => {
    mockFetch.mockResolvedValueOnce(null);
    await deleteGiteaBranch({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'feat',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/branches/feat',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('404 NOT_FOUND 透传', async () => {
    const err = new Error('404');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      deleteGiteaBranch({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'nonexistent',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('403 PERMISSION_DENIED 透传（protected branch）', async () => {
    const err = new Error('403');
    (err as unknown as { code: string }).code = IpcErrorCode.PERMISSION_DENIED;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      deleteGiteaBranch({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'main',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.PERMISSION_DENIED });
  });

  it('网络断 NETWORK_OFFLINE 透传', async () => {
    const err = new Error('net fail');
    (err as unknown as { code: string }).code = IpcErrorCode.NETWORK_OFFLINE;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      deleteGiteaBranch({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', branch: 'feat',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NETWORK_OFFLINE });
  });
});
