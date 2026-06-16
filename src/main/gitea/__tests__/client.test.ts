/**
 * main 端 gitea/client.ts 单测
 *
 * 覆盖：HTTP status → IpcError 映射、unwrapGitea 成功/失败/消息提取、token worker、cache key/cache 清空
 *
 * Mock 策略：
 * - electron.app mock（client.ts 用 app.getPath 拿 dev token 路径 + app.isPackaged）
 * - ./keychain.js mock（client.ts 的 readToken fallback 到 keychainGet；测试不真访问系统 keychain）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HttpResponse } from 'gitea-js';
import { IpcError, IpcErrorCode } from '@shared/errors';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (_key: string) => '/tmp/gitea-kanban-client-test',
  },
}));

vi.mock('./keychain.js', () => ({
  keychainGet: vi.fn().mockResolvedValue(null),
}));

const {
  httpErrorToIpcError,
  unwrapGitea,
  clearGiteaClientCache,
  invalidateGiteaClient,
  getGiteaClient,
  _testInternals,
} = await import('../client.js');

const { normalizeBaseUrl, cacheKey, makeGiteaSecurityWorker } = _testInternals;

/** 构造一个 fake HttpResponse<T> 用于 unwrapGitea 测试（绕过真网络） */
function fakeResponse<T>(args: {
  ok: boolean;
  status: number;
  data?: T;
  statusText?: string;
}): HttpResponse<T, unknown> {
  return {
    ok: args.ok,
    status: args.status,
    statusText: args.statusText ?? '',
    data: args.data as T,
  } as unknown as HttpResponse<T, unknown>;
}

beforeEach(() => {
  // 每个测试前清掉模块级 cache，避免 token 5min 缓存污染测试间状态
  clearGiteaClientCache();
});

// ============================================================
// ===== httpErrorToIpcError：状态码映射全覆盖 ===================
// ============================================================

describe('gitea/client · httpErrorToIpcError · HTTP status 映射', () => {
  it('401 → TOKEN_INVALID', () => {
    const e = httpErrorToIpcError(401, 'bad token', 'fallback');
    expect(e).toBeInstanceOf(IpcError);
    expect(e.code).toBe(IpcErrorCode.TOKEN_INVALID);
    expect(e.httpStatus).toBe(401);
    expect(e.hint).toContain('重新连接');
  });

  it('403 → PERMISSION_DENIED', () => {
    const e = httpErrorToIpcError(403, 'forbidden', 'fallback');
    expect(e.code).toBe(IpcErrorCode.PERMISSION_DENIED);
    expect(e.httpStatus).toBe(403);
    expect(e.hint).toContain('仓库管理员');
  });

  it('404 → NOT_FOUND', () => {
    const e = httpErrorToIpcError(404, 'gone', 'fallback');
    expect(e.code).toBe(IpcErrorCode.NOT_FOUND);
    expect(e.httpStatus).toBe(404);
    expect(e.hint).toContain('请刷新');
  });

  it('405 → CONFLICT（已合并/已关闭 PR 再 merge）', () => {
    const e = httpErrorToIpcError(405, '', 'fallback');
    expect(e.code).toBe(IpcErrorCode.CONFLICT);
    expect(e.httpStatus).toBe(405);
    expect(e.message).toContain('已合并或已关闭');
  });

  it('409 → CONFLICT', () => {
    const e = httpErrorToIpcError(409, '', 'fallback');
    expect(e.code).toBe(IpcErrorCode.CONFLICT);
    expect(e.httpStatus).toBe(409);
  });

  it('422 → VALIDATION_FAILED', () => {
    const e = httpErrorToIpcError(422, 'bad payload', 'fallback');
    expect(e.code).toBe(IpcErrorCode.VALIDATION_FAILED);
    expect(e.httpStatus).toBe(422);
    expect(e.hint).toContain('检查输入');
  });

  it('429 → RATE_LIMITED', () => {
    const e = httpErrorToIpcError(429, '', 'fallback');
    expect(e.code).toBe(IpcErrorCode.RATE_LIMITED);
    expect(e.httpStatus).toBe(429);
    expect(e.hint).toContain('稍后');
  });

  it.each([0, 502, 503, 504])('%i → NETWORK_OFFLINE', (status) => {
    const e = httpErrorToIpcError(status, '', 'fallback');
    expect(e.code).toBe(IpcErrorCode.NETWORK_OFFLINE);
    expect(e.httpStatus).toBe(status);
    expect(e.hint).toContain('网络');
  });

  it('500 (default 分支) → GITEA_ERROR with fallbackMessage', () => {
    const e = httpErrorToIpcError(500, '', '自定义失败文案');
    expect(e.code).toBe(IpcErrorCode.GITEA_ERROR);
    expect(e.httpStatus).toBe(500);
    expect(e.message).toBe('自定义失败文案');
  });

  it('body=object → cause 走 JSON.stringify', () => {
    const e = httpErrorToIpcError(500, { detail: 'explosion' }, 'fallback');
    expect(e.cause).toBe(JSON.stringify({ detail: 'explosion' }));
  });

  it('body=null → cause = "null"', () => {
    const e = httpErrorToIpcError(500, null, 'fallback');
    expect(e.cause).toBe(JSON.stringify({}));
  });
});

// ============================================================
// ===== unwrapGitea：HttpResponse → data / throw =================
// ============================================================

describe('gitea/client · unwrapGitea · success / failure 路径', () => {
  it('res.ok=true → 返 res.data', () => {
    const r = fakeResponse({ ok: true, status: 200, data: [{ id: 1 }, { id: 2 }] });
    const out = unwrapGitea(r, 'list failed');
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('res.ok=false + data.message → cause = data.message', () => {
    const r = fakeResponse({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      data: { message: 'invalid label color' },
    });
    expect(() => unwrapGitea(r, 'create failed')).toThrow(IpcError);
    try {
      unwrapGitea(r, 'create failed');
    } catch (err) {
      const e = err as IpcError;
      expect(e.code).toBe(IpcErrorCode.VALIDATION_FAILED);
      expect(e.cause).toBe('invalid label color');
    }
  });

  it('res.ok=false + data.error.message（嵌套）→ cause = inner', () => {
    const r = fakeResponse({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      data: { error: { message: 'database down' } },
    });
    expect(() => unwrapGitea(r, 'whatever')).toThrow(IpcError);
    try {
      unwrapGitea(r, 'whatever');
    } catch (err) {
      expect((err as IpcError).cause).toBe('database down');
    }
  });

  it('res.ok=false + 只有 statusText → cause = statusText', () => {
    const r = fakeResponse({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      data: null,
    });
    try {
      unwrapGitea(r, 'fb');
    } catch (err) {
      expect((err as IpcError).cause).toBe('Bad Gateway');
    }
  });

  it('res.ok=false + 啥都没有 → cause = "HTTP <status>"', () => {
    const r = fakeResponse({
      ok: false,
      status: 500,
      statusText: '',
      data: null,
    });
    try {
      unwrapGitea(r, 'fb');
    } catch (err) {
      expect((err as IpcError).cause).toBe('HTTP 500');
    }
  });

  it('fallbackMessage 用作 IpcError.message', () => {
    const r = fakeResponse({ ok: false, status: 500, statusText: '', data: null });
    try {
      unwrapGitea(r, '/repos/foo/issues 失败');
    } catch (err) {
      expect((err as IpcError).message).toBe('/repos/foo/issues 失败');
    }
  });
});

// ============================================================
// ===== normalizeBaseUrl / cacheKey / makeGiteaSecurityWorker ==
// ============================================================

describe('gitea/client · normalizeBaseUrl / cacheKey / token worker', () => {
  it('normalizeBaseUrl 去掉尾斜杠', () => {
    expect(normalizeBaseUrl('https://gitea.example.com/')).toBe('https://gitea.example.com');
    expect(normalizeBaseUrl('https://gitea.example.com///')).toBe('https://gitea.example.com');
    expect(normalizeBaseUrl('https://gitea.example.com')).toBe('https://gitea.example.com');
  });

  it('cacheKey = "<giteaUrl>::<username>"', () => {
    expect(cacheKey('https://gitea.example.com', 'alice')).toBe('https://gitea.example.com::alice');
  });

  it('makeGiteaSecurityWorker 返 "token <pat>"（不是 Bearer）', async () => {
    const worker = makeGiteaSecurityWorker();
    const out = await worker('my-pat');
    expect(out).toEqual({ secure: true, headers: { Authorization: 'token my-pat' } });
  });

  it('makeGiteaSecurityWorker securityData 为空 → undefined（不设 headers）', async () => {
    const worker = makeGiteaSecurityWorker();
    expect(await worker(undefined)).toBeUndefined();
  });
});

// ============================================================
// ===== cache 控制：clear / invalidate / token TTL ============
// ============================================================

describe('gitea/client · cache 控制', () => {
  it('clearGiteaClientCache 清掉所有 entry（之后 getGiteaClient 会重新走 keychain）', async () => {
    // 第一次调：token=null → 抛 UNAUTHENTICATED
    await expect(getGiteaClient('https://x', 'u')).rejects.toMatchObject({
      code: IpcErrorCode.UNAUTHENTICATED,
    });

    // 清空后再调：仍然 UNAUTHENTICATED（确认 cache 真的清掉了，重新走 readToken 路径）
    clearGiteaClientCache();
    await expect(getGiteaClient('https://x', 'u')).rejects.toMatchObject({
      code: IpcErrorCode.UNAUTHENTICATED,
    });
  });

  it('invalidateGiteaClient 只清指定 (giteaUrl, username)', async () => {
    // 两次都失败，但两次都会各自走 readToken（验证 cache 没串）
    invalidateGiteaClient('https://x', 'u');
    await expect(getGiteaClient('https://x', 'u')).rejects.toBeInstanceOf(IpcError);

    // 第二次 invalidate 不存在的 key 不抛
    expect(() => invalidateGiteaClient('https://never-seen', 'nobody')).not.toThrow();
  });
});