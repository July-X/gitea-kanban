/**
 * gitea client 单测
 *
 * 重点：HTTP 错误 → IpcError 映射
 *
 * - 401 → TOKEN_INVALID
 * - 403 → PERMISSION_DENIED
 * - 404 → NOT_FOUND
 * - 409 → CONFLICT
 * - 429 → RATE_LIMITED
 * - 502/503/504/0 → NETWORK_OFFLINE
 * - 其它 → GITEA_ERROR
 */

import { describe, it, expect } from 'vitest';
import { IpcErrorCode } from '@shared/errors';
import { _testInternals } from './client.js';

const { httpErrorToIpcError, normalizeBaseUrl } = _testInternals;

describe('normalizeBaseUrl', () => {
  it('去尾斜杠', () => {
    expect(normalizeBaseUrl('http://x/')).toBe('http://x');
    expect(normalizeBaseUrl('http://x///')).toBe('http://x');
  });
  it('不变无尾斜杠', () => {
    expect(normalizeBaseUrl('http://x')).toBe('http://x');
  });
});

describe('httpErrorToIpcError', () => {
  it('401 → TOKEN_INVALID', () => {
    const e = httpErrorToIpcError(401, { message: 'auth required' }, 'fallback');
    expect(e.code).toBe(IpcErrorCode.TOKEN_INVALID);
    expect(e.httpStatus).toBe(401);
  });

  it('403 → PERMISSION_DENIED', () => {
    const e = httpErrorToIpcError(403, { message: 'no push' }, 'fallback');
    expect(e.code).toBe(IpcErrorCode.PERMISSION_DENIED);
  });

  it('404 → NOT_FOUND', () => {
    const e = httpErrorToIpcError(404, {}, 'fallback');
    expect(e.code).toBe(IpcErrorCode.NOT_FOUND);
  });

  it('409 → CONFLICT', () => {
    const e = httpErrorToIpcError(409, { message: 'already exists' }, 'fallback');
    expect(e.code).toBe(IpcErrorCode.CONFLICT);
  });

  it('429 → RATE_LIMITED', () => {
    const e = httpErrorToIpcError(429, {}, 'fallback');
    expect(e.code).toBe(IpcErrorCode.RATE_LIMITED);
  });

  it('502 → NETWORK_OFFLINE', () => {
    const e = httpErrorToIpcError(502, {}, 'fallback');
    expect(e.code).toBe(IpcErrorCode.NETWORK_OFFLINE);
  });

  it('503 → NETWORK_OFFLINE', () => {
    const e = httpErrorToIpcError(503, {}, 'fallback');
    expect(e.code).toBe(IpcErrorCode.NETWORK_OFFLINE);
  });

  it('504 → NETWORK_OFFLINE', () => {
    const e = httpErrorToIpcError(504, {}, 'fallback');
    expect(e.code).toBe(IpcErrorCode.NETWORK_OFFLINE);
  });

  it('500 → GITEA_ERROR', () => {
    const e = httpErrorToIpcError(500, { message: 'oops' }, 'fallback');
    expect(e.code).toBe(IpcErrorCode.GITEA_ERROR);
  });

  it('400 → GITEA_ERROR', () => {
    const e = httpErrorToIpcError(400, { message: 'bad' }, 'fallback');
    expect(e.code).toBe(IpcErrorCode.GITEA_ERROR);
  });

  it('cause 字段含 gitea 响应 body', () => {
    const body = { message: 'auth required' };
    const e = httpErrorToIpcError(401, body, 'fallback');
    expect(e.cause).toContain('auth required');
  });

  it('cause 字符串 body 也接受', () => {
    const e = httpErrorToIpcError(401, 'plain text', 'fallback');
    expect(e.cause).toBe('plain text');
  });
});
