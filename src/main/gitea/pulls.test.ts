/**
 * gitea/pulls.ts 单测
 *
 * 覆盖：
 * - listGiteaPulls happy path：转 PullDto[] + hasMore
 * - getGiteaPull / createGiteaPull / mergeGiteaPull
 * - 关键映射：mergeable=false → hasConflicts=true
 * - mergeable 缺失（undefined）→ mergeable=true, hasConflicts=false（gitea 未加载完）
 * - merged 字段透传
 * - author.avatar_url 缺失 → 不带 avatarUrl
 * - merge 失败错误码透传（CONFLICT / PERMISSION_DENIED）
 * - merge body 序列化（Do / delete_branch_after_merge / Merge_Message）
 * - URL 拼接 + encode
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('../gitea/client.js', () => ({
  giteaFetch: (...args: unknown[]) => mockFetch(...args),
}));

const {
  listGiteaPulls,
  getGiteaPull,
  createGiteaPull,
  mergeGiteaPull,
} = await import('./pulls.js');
const { IpcErrorCode } = await import('@shared/errors');

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRawPull(overrides: Partial<{
  index: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
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
      sha: overrides.head_sha ?? 'head-sha-0000000000000000000000000000000',
    },
    base: {
      ref: overrides.base_ref ?? 'main',
      sha: overrides.base_sha ?? 'base-sha-0000000000000000000000000000000',
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

describe('listGiteaPulls', () => {
  it('happy path: 返回 PullDto[] + hasMore=false', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawPull({ index: 1, title: 'PR 1' }),
      makeRawPull({ index: 2, title: 'PR 2' }),
    ]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.index).toBe(1);
    expect(r.items[0]!.title).toBe('PR 1');
    expect(r.items[0]!.state).toBe('open');
    expect(r.items[0]!.head.ref).toBe('feature/x');
    expect(r.items[0]!.base.ref).toBe('main');
    expect(r.hasMore).toBe(false);
  });

  it('返回数 == limit 时 hasMore=true', async () => {
    const raws = Array.from({ length: 50 }, (_, i) => makeRawPull({ index: i + 1 }));
    mockFetch.mockResolvedValueOnce(raws);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', limit: 50,
    });
    expect(r.hasMore).toBe(true);
  });

  it('query: state/head/base/author + page/limit 透传', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      state: 'open', head: 'feat', base: 'main', author: 'alice',
      page: 2, limit: 25,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls',
      expect.objectContaining({
        method: 'GET',
        query: {
          state: 'open', head: 'feat', base: 'main', author: 'alice',
          page: 2, limit: 25,
        },
      }),
    );
  });

  it('mergeable=false → hasConflicts=true（**关键映射**）', async () => {
    mockFetch.mockResolvedValueOnce([makeRawPull({ mergeable: false })]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.mergeable).toBe(false);
    expect(r.items[0]!.hasConflicts).toBe(true);
  });

  it('mergeable=true → hasConflicts=false', async () => {
    mockFetch.mockResolvedValueOnce([makeRawPull({ mergeable: true })]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.mergeable).toBe(true);
    expect(r.items[0]!.hasConflicts).toBe(false);
  });

  it('mergeable 缺失（gitea 未加载完）→ 默认 mergeable=true, hasConflicts=false', async () => {
    // gitea 在某些情况下不返回 mergeable 字段（PR 创建后还在异步检查）
    const raw = makeRawPull();
    delete (raw as { mergeable?: boolean }).mergeable;
    mockFetch.mockResolvedValueOnce([raw]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.mergeable).toBe(true);
    expect(r.items[0]!.hasConflicts).toBe(false);
  });

  it('merged=true → DTO.merged=true', async () => {
    mockFetch.mockResolvedValueOnce([makeRawPull({ state: 'closed', merged: true })]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.merged).toBe(true);
    expect(r.items[0]!.state).toBe('closed');
  });

  it('author.avatar_url 缺失 → 不带 avatarUrl', async () => {
    mockFetch.mockResolvedValueOnce([makeRawPull({ author_login: 'bob' })]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.author.username).toBe('bob');
    expect(r.items[0]!.author.avatarUrl).toBeUndefined();
  });

  it('user 字段缺失 → author.username = <unknown>', async () => {
    const raw = makeRawPull();
    delete (raw as { user?: unknown }).user;
    mockFetch.mockResolvedValueOnce([raw]);
    const r = await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.author.username).toBe('<unknown>');
  });

  it('URL encode owner/repo', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaPulls({
      giteaUrl: 'http://x', username: 'alice', owner: 'org/sub', repo: 'my repo',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/org%2Fsub/my%20repo/pulls',
      expect.anything(),
    );
  });

  it('404 NOT_FOUND 透传（仓库不存在）', async () => {
    const err = new Error('404');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaPulls({ giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

describe('getGiteaPull', () => {
  it('URL: /pulls/{index} 编码 index', async () => {
    mockFetch.mockResolvedValueOnce(makeRawPull());
    await getGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', index: 42,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls/42',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('返回完整 PullDto', async () => {
    mockFetch.mockResolvedValueOnce(makeRawPull({ index: 7, mergeable: true, draft: true }));
    const p = await getGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', index: 7,
    });
    expect(p.index).toBe(7);
    expect(p.draft).toBe(true);
    expect(p.mergeable).toBe(true);
    expect(p.hasConflicts).toBe(false);
  });
});

describe('createGiteaPull', () => {
  it('happy path: POST + body', async () => {
    mockFetch.mockResolvedValueOnce(makeRawPull());
    await createGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      head: 'feature/x', base: 'main', title: 'feat: new', body: 'desc', draft: true,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls',
      expect.objectContaining({
        method: 'POST',
        body: { head: 'feature/x', base: 'main', title: 'feat: new', body: 'desc', draft: true },
      }),
    );
  });

  it('optional body / draft 缺省时不传', async () => {
    mockFetch.mockResolvedValueOnce(makeRawPull());
    await createGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      head: 'feature/x', base: 'main', title: 'feat: new',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls',
      expect.objectContaining({
        body: { head: 'feature/x', base: 'main', title: 'feat: new' },
      }),
    );
  });

  it('409 CONFLICT 透传（head = base）', async () => {
    const err = new Error('409');
    (err as unknown as { code: string }).code = IpcErrorCode.CONFLICT;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      createGiteaPull({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        head: 'main', base: 'main', title: 't',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  });

  it('422 NOT_FOUND 透传（head 不存在）', async () => {
    // gitea 在 head 不存在时返 422 → 走 NOT_FOUND
    const err = new Error('422');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      createGiteaPull({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        head: 'nonexistent', base: 'main', title: 't',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });
});

describe('mergeGiteaPull', () => {
  it('URL: /pulls/{index}/merge', async () => {
    mockFetch.mockResolvedValueOnce({ sha: 'merge-sha', merged: true, message: 'ok' });
    await mergeGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      index: 42, method: 'merge',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls/42/merge',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('body: Do=method + delete_branch_after_merge + Merge_Message 全透传', async () => {
    mockFetch.mockResolvedValueOnce({ sha: 'm-sha', merged: true, message: 'ok' });
    await mergeGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      index: 1, method: 'squash',
      deleteBranchAfter: true,
      commitMessage: 'feat: combined',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls/1/merge',
      expect.objectContaining({
        body: {
          Do: 'squash',
          delete_branch_after_merge: true,
          Merge_Message: 'feat: combined',
        },
      }),
    );
  });

  it('body: 只传 Do = method（不传 delete/Merge_Message）', async () => {
    mockFetch.mockResolvedValueOnce({ sha: 'm-sha', merged: true, message: 'ok' });
    await mergeGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      index: 1, method: 'rebase',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/pulls/1/merge',
      expect.objectContaining({ body: { Do: 'rebase' } }),
    );
  });

  it('happy path: 返 MergePrResult', async () => {
    mockFetch.mockResolvedValueOnce({
      sha: 'result-sha', merged: true, message: 'Merge done',
    });
    const r = await mergeGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      index: 5, method: 'merge',
    });
    expect(r.sha).toBe('result-sha');
    expect(r.merged).toBe(true);
    expect(r.message).toBe('Merge done');
  });

  it('gitea 返 merged undefined → 默认 merged=true（成功 = 已合并）', async () => {
    mockFetch.mockResolvedValueOnce({}); // 没 merged 字段
    const r = await mergeGiteaPull({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      index: 5, method: 'merge',
    });
    expect(r.merged).toBe(true);
  });

  it('409 CONFLICT 透传（PR 已合并 / 有冲突）', async () => {
    const err = new Error('409');
    (err as unknown as { code: string }).code = IpcErrorCode.CONFLICT;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      mergeGiteaPull({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        index: 1, method: 'merge',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  });

  it('403 PERMISSION_DENIED 透传（无合并权限）', async () => {
    const err = new Error('403');
    (err as unknown as { code: string }).code = IpcErrorCode.PERMISSION_DENIED;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      mergeGiteaPull({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        index: 1, method: 'merge',
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.PERMISSION_DENIED });
  });

  it('method 5 种值都能传', async () => {
    for (const m of ['merge', 'rebase', 'rebase-merge', 'squash', 'squash-merge'] as const) {
      mockFetch.mockResolvedValueOnce({ sha: 'm', merged: true, message: 'ok' });
      await mergeGiteaPull({
        giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
        index: 1, method: m,
      });
      const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!;
      const body = (call[3] as { body: { Do: string } }).body;
      expect(body.Do).toBe(m);
    }
  });
});
