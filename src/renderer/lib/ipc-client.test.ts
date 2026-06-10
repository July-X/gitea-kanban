/**
 * ipc-client.test.ts —— IpcError duck-type + hint 提取 + 错误规整
 *
 * 覆盖（ipc-client.ts §职责清单）：
 * - isIpcErrorPayload: 正例/反例/字段不全
 * - normalizeError: IpcErrorPayload / Error / unknown(null/str/obj) 三类输入
 * - toUserFacingError: code 分类前缀 + hint fallback + httpStatus 透传
 * - 12 个 IpcErrorCode 都正确归类（recoverable + category）
 *
 * 不测：getIpcClient 单例（需要 window 注入）、IpcClient.invoke（mock window.api 走完整链路）
 *       —— 那些走 stores/auth.test.ts 测
 */
import { describe, expect, it } from 'vitest';
import {
  isIpcErrorPayload,
  normalizeError,
  toUserFacingError,
} from '@renderer/lib/ipc-client';
import type { IpcErrorPayload } from '@shared/errors';

describe('isIpcErrorPayload', () => {
  it('接受合法 IpcErrorPayload', () => {
    const p: IpcErrorPayload = {
      code: 'token_invalid',
      message: 'token 已失效',
      hint: '请重新连接',
    };
    expect(isIpcErrorPayload(p)).toBe(true);
  });

  it('接受含 cause / httpStatus 的 IpcErrorPayload', () => {
    const p: IpcErrorPayload = {
      code: 'gitea_error',
      message: 'gitea 5xx',
      hint: '稍候重试',
      cause: 'ECONNRESET',
      httpStatus: 502,
    };
    expect(isIpcErrorPayload(p)).toBe(true);
  });

  it('拒绝 null', () => {
    expect(isIpcErrorPayload(null)).toBe(false);
  });

  it('拒绝非对象', () => {
    expect(isIpcErrorPayload('token_invalid')).toBe(false);
    expect(isIpcErrorPayload(42)).toBe(false);
    expect(isIpcErrorPayload(undefined)).toBe(false);
  });

  it('拒绝缺 code 字段', () => {
    expect(isIpcErrorPayload({ message: 'x' })).toBe(false);
  });

  it('拒绝 code 不是字符串', () => {
    expect(isIpcErrorPayload({ code: 123, message: 'x' })).toBe(false);
  });

  it('拒绝未知 code（防止误抓 zod / gitea 原始错误）', () => {
    // 任何不在 12 个 IpcErrorCode 白名单里的 code 都不应被识别
    expect(isIpcErrorPayload({ code: 'random_error', message: 'x' })).toBe(false);
    expect(isIpcErrorPayload({ code: 'ZodError', message: 'x' })).toBe(false);
  });
});

describe('toUserFacingError', () => {
  it('正确加类别前缀（unauthenticated → "需要登录"）', () => {
    const r = toUserFacingError({
      code: 'unauthenticated',
      message: '尚未连接',
      hint: '请先连接',
    });
    expect(r.code).toBe('unauthenticated');
    expect(r.messageText).toBe('需要登录：尚未连接');
    expect(r.hint).toBe('请先连接');
    expect(r.recoverable).toBe(true);
  });

  it('正确分类 token_invalid 为可恢复（要重连）', () => {
    const r = toUserFacingError({
      code: 'token_invalid',
      message: 'token 已失效',
      hint: '请重新连接',
    });
    expect(r.messageText.startsWith('登录已过期')).toBe(true);
    expect(r.recoverable).toBe(true);
  });

  it('正确分类 permission_denied 为不可恢复', () => {
    const r = toUserFacingError({
      code: 'permission_denied',
      message: '无权访问该仓库',
      hint: '联系仓库管理员',
    });
    expect(r.messageText.startsWith('权限不足')).toBe(true);
    expect(r.recoverable).toBe(false);
  });

  it('正确分类 network_offline 为可恢复', () => {
    const r = toUserFacingError({
      code: 'network_offline',
      message: '网络不可达',
      hint: '请检查网络连接',
    });
    expect(r.messageText.startsWith('网络问题')).toBe(true);
    expect(r.recoverable).toBe(true);
  });

  it('hint 缺失时 fallback "请稍候重试"', () => {
    const r = toUserFacingError({
      code: 'internal',
      message: '本地 bug',
    });
    expect(r.hint).toBe('请稍候重试');
  });

  it('透传 cause / httpStatus（可选字段）', () => {
    const r = toUserFacingError({
      code: 'gitea_error',
      message: 'gitea 5xx',
      hint: '稍候',
      cause: 'ECONNRESET',
      httpStatus: 502,
    });
    expect(r.cause).toBe('ECONNRESET');
    expect(r.httpStatus).toBe(502);
  });

  it('可选字段不传时不出现', () => {
    const r = toUserFacingError({
      code: 'not_found',
      message: '资源不存在',
    });
    expect(r.cause).toBeUndefined();
    expect(r.httpStatus).toBeUndefined();
  });
});

describe('normalizeError', () => {
  it('IpcErrorPayload → toUserFacingError', () => {
    const r = normalizeError({
      code: 'rate_limited',
      message: '429',
      hint: '稍候',
    });
    expect(r.code).toBe('rate_limited');
    expect(r.messageText.startsWith('请求太频繁')).toBe(true);
  });

  it('普通 Error → 包成 internal', () => {
    const r = normalizeError(new Error('boom'));
    expect(r.code).toBe('internal');
    expect(r.messageText).toContain('应用出错了');
    expect(r.messageText).toContain('boom');
    expect(r.cause).toContain('Error: boom');
    expect(r.recoverable).toBe(true);
  });

  it('null / 字符串 / 对象 → 包成 internal（不崩）', () => {
    expect(normalizeError(null).code).toBe('internal');
    expect(normalizeError('boom').code).toBe('internal');
    expect(normalizeError({ random: 'obj' }).code).toBe('internal');
    expect(normalizeError(undefined).code).toBe('internal');
  });
});
