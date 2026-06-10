/**
 * gitea/commits.ts 单测
 *
 * 覆盖：
 * - listGiteaCommits happy path：转 CommitDto[] + hasMore
 * - list query 参数传递（sha/path/author/since/until）
 * - list 缺省 page=1 + limit=50
 * - getGiteaCommit：调 /git/commits/{sha}（不是 /commits/{sha}）
 * - getGiteaCommit：带 stats 字段（additions/deletions/filesChanged）
 * - list 不带 stats（list response 没 stats 字段）
 * - 错误码透传（401/404）
 * - URL 拼接 encodeURIComponent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('../gitea/client.js', () => ({
  giteaFetch: (...args: unknown[]) => mockFetch(...args),
}));

const {
  listGiteaCommits,
  getGiteaCommit,
} = await import('./commits.js');
const { IpcErrorCode } = await import('@shared/errors');

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRawCommitSummary(overrides: Partial<{
  sha: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name: string;
  committer_email: string;
  parents: Array<{ sha: string }>;
  avatar_url: string | undefined;
}> = {}) {
  return {
    sha: overrides.sha ?? 'abc123sha-full-40-chars-here-0000000000',
    commit: {
      message: overrides.message ?? 'feat: hello',
      author: {
        name: overrides.author_name ?? 'alice',
        email: overrides.author_email ?? 'alice@example.com',
        date: overrides.author_date ?? '2026-06-10T00:00:00.000Z',
      },
      committer: {
        name: overrides.committer_name ?? 'alice',
        email: overrides.committer_email ?? 'alice@example.com',
      },
    },
    parents: overrides.parents ?? [{ sha: 'parent-sha-00000000000000000000' }],
    author: overrides.avatar_url !== undefined
      ? { login: 'alice', avatar_url: overrides.avatar_url }
      : { login: 'alice' },
  };
}

describe('listGiteaCommits', () => {
  it('happy path: 返回 CommitDto[] + hasMore=false', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawCommitSummary({ sha: 'aaa123sha-full-40-chars-here-0000000000' }),
      makeRawCommitSummary({ sha: 'bbb456sha-full-40-chars-here-0000000000' }),
    ]);
    const r = await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.sha).toBe('aaa123sha-full-40-chars-here-0000000000');
    expect(r.items[0]!.shortSha).toBe('aaa123s');
    expect(r.items[0]!.author.name).toBe('alice');
    expect(r.items[0]!.parents).toEqual(['parent-sha-00000000000000000000']);
    expect(r.hasMore).toBe(false);
  });

  it('返回数 == limit 时 hasMore=true', async () => {
    const raws = Array.from({ length: 50 }, (_, i) =>
      makeRawCommitSummary({ sha: `sha-${i.toString().padStart(40, '0')}` }),
    );
    mockFetch.mockResolvedValueOnce(raws);
    const r = await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', limit: 50,
    });
    expect(r.hasMore).toBe(true);
  });

  it('author.avatar_url → CommitDto.author.avatarUrl', async () => {
    mockFetch.mockResolvedValueOnce([
      makeRawCommitSummary({ avatar_url: 'https://gitea.example.com/avatars/alice.png' }),
    ]);
    const r = await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.author.avatarUrl).toBe('https://gitea.example.com/avatars/alice.png');
  });

  it('author.avatar_url 缺失 → 不带 avatarUrl 字段', async () => {
    mockFetch.mockResolvedValueOnce([makeRawCommitSummary({ avatar_url: undefined })]);
    const r = await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.author.avatarUrl).toBeUndefined();
  });

  it('list 不带 stats 字段（gitea list response 不返回 stats）', async () => {
    mockFetch.mockResolvedValueOnce([makeRawCommitSummary()]);
    const r = await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
    });
    expect(r.items[0]!.additions).toBeUndefined();
    expect(r.items[0]!.deletions).toBeUndefined();
    expect(r.items[0]!.filesChanged).toBeUndefined();
  });

  it('query: sha/path/author/since/until 全透传', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      sha: 'main', path: 'src/x.ts', author: 'alice', since: '2026-01-01T00:00:00Z', until: '2026-12-31T23:59:59Z',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/commits',
      expect.objectContaining({
        method: 'GET',
        query: expect.objectContaining({
          sha: 'main', path: 'src/x.ts', author: 'alice',
          since: '2026-01-01T00:00:00Z', until: '2026-12-31T23:59:59Z',
          page: 1, limit: 50,
        }),
      }),
    );
  });

  it('query: 显式传 page/limit', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      page: 3, limit: 25,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/commits',
      expect.objectContaining({ query: expect.objectContaining({ page: 3, limit: 25 }) }),
    );
  });

  it('URL encode owner/repo 含特殊字符', async () => {
    mockFetch.mockResolvedValueOnce([]);
    await listGiteaCommits({
      giteaUrl: 'http://x', username: 'alice', owner: 'org/sub', repo: 'my repo',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/org%2Fsub/my%20repo/commits',
      expect.anything(),
    );
  });

  it('401 TOKEN_INVALID 透传', async () => {
    const err = new Error('401');
    (err as unknown as { code: string }).code = IpcErrorCode.TOKEN_INVALID;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      listGiteaCommits({ giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.TOKEN_INVALID });
  });
});

describe('getGiteaCommit', () => {
  it('调 /git/commits/{sha}（不是 /commits/{sha}）', async () => {
    mockFetch.mockResolvedValueOnce(makeRawCommitSummary());
    await getGiteaCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', sha: 'abc',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/git/commits/abc',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('URL encode sha', async () => {
    mockFetch.mockResolvedValueOnce(makeRawCommitSummary());
    await getGiteaCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r',
      sha: 'abc/with/slash',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://x', 'alice',
      '/repos/o/r/git/commits/abc%2Fwith%2Fslash',
      expect.anything(),
    );
  });

  it('带 stats → 填 additions/deletions/filesChanged', async () => {
    mockFetch.mockResolvedValueOnce({
      ...makeRawCommitSummary(),
      stats: { additions: 10, deletions: 5, total: 15 },
      files: [
        { filename: 'src/a.ts' },
        { filename: 'src/b.ts' },
        { filename: 'src/c.ts' },
      ],
    });
    const c = await getGiteaCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', sha: 'abc',
    });
    expect(c.additions).toBe(10);
    expect(c.deletions).toBe(5);
    expect(c.filesChanged).toBe(3);
  });

  it('stats 缺字段 → 不写 undefined 字段', async () => {
    mockFetch.mockResolvedValueOnce({
      ...makeRawCommitSummary(),
      stats: { total: 15 }, // 没 additions / deletions
    });
    const c = await getGiteaCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', sha: 'abc',
    });
    expect(c.additions).toBeUndefined();
    expect(c.deletions).toBeUndefined();
    expect(c.filesChanged).toBeUndefined();
  });

  it('files 缺失 → filesChanged 不填', async () => {
    mockFetch.mockResolvedValueOnce({
      ...makeRawCommitSummary(),
      stats: { additions: 1, deletions: 2 },
      // files 缺失
    });
    const c = await getGiteaCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', sha: 'abc',
    });
    expect(c.additions).toBe(1);
    expect(c.deletions).toBe(2);
    expect(c.filesChanged).toBeUndefined();
  });

  it('404 NOT_FOUND 透传（sha 不存在）', async () => {
    const err = new Error('404');
    (err as unknown as { code: string }).code = IpcErrorCode.NOT_FOUND;
    mockFetch.mockRejectedValueOnce(err);
    await expect(
      getGiteaCommit({ giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', sha: 'missing' }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  });

  it('parent 列表透传', async () => {
    mockFetch.mockResolvedValueOnce(makeRawCommitSummary({
      parents: [{ sha: 'parent-a' }, { sha: 'parent-b' }],
    }));
    const c = await getGiteaCommit({
      giteaUrl: 'http://x', username: 'alice', owner: 'o', repo: 'r', sha: 'merge-sha',
    });
    expect(c.parents).toEqual(['parent-a', 'parent-b']);
  });
});
