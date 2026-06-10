import { describe, it, expect } from 'vitest';
import {
  IpcError,
  IpcErrorCode,
  isIpcError,
  validationFailed,
  type IpcErrorCodeValue,
} from './errors.js';

describe('IpcErrorCode', () => {
  it('含 12 个常量（10 业务 + 2 keychain）', () => {
    const keys = Object.keys(IpcErrorCode);
    expect(keys.length).toBe(12);
  });

  it('所有值为 snake_case 字符串', () => {
    const re = /^[a-z][a-z0-9_]*$/;
    for (const [, v] of Object.entries(IpcErrorCode)) {
      expect(v).toMatch(re);
    }
  });

  it('含 ADR-0001 新增的 2 个 keychain 常量', () => {
    expect(IpcErrorCode.KEYCHAIN_UNAVAILABLE).toBe('keychain_unavailable');
    expect(IpcErrorCode.KEYCHAIN_ACCESS_DENIED).toBe('keychain_access_denied');
  });

  it('含 02-architecture.md §5.4 原始 10 个常量', () => {
    expect(IpcErrorCode.UNAUTHENTICATED).toBe('unauthenticated');
    expect(IpcErrorCode.TOKEN_INVALID).toBe('token_invalid');
    expect(IpcErrorCode.PERMISSION_DENIED).toBe('permission_denied');
    expect(IpcErrorCode.NOT_FOUND).toBe('not_found');
    expect(IpcErrorCode.CONFLICT).toBe('conflict');
    expect(IpcErrorCode.RATE_LIMITED).toBe('rate_limited');
    expect(IpcErrorCode.NETWORK_OFFLINE).toBe('network_offline');
    expect(IpcErrorCode.GITEA_ERROR).toBe('gitea_error');
    expect(IpcErrorCode.VALIDATION_FAILED).toBe('validation_failed');
    expect(IpcErrorCode.INTERNAL).toBe('internal');
  });

  it('所有值唯一（无重复）', () => {
    const values = Object.values(IpcErrorCode) as IpcErrorCodeValue[];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('IpcError class', () => {
  it('throw 后 instanceof Error && IpcError', () => {
    const err = new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'no',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IpcError);
    expect(err.name).toBe('IpcError');
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('no');
  });

  it('toJSON 输出 IPC 边界用纯对象', () => {
    const err = new IpcError({
      code: IpcErrorCode.TOKEN_INVALID,
      message: 'token expired',
      hint: '重新连接',
      cause: '401',
      httpStatus: 401,
    });
    expect(err.toJSON()).toEqual({
      code: 'token_invalid',
      message: 'token expired',
      hint: '重新连接',
      cause: '401',
      httpStatus: 401,
    });
  });

  it('toJSON 省略 undefined 字段（避免 JSON 里出现 undefined）', () => {
    const err = new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: 'oops',
    });
    const json = err.toJSON();
    expect(Object.keys(json).sort()).toEqual(['code', 'message']);
  });

  it('可被 catch 后再用 toJSON() throw（IPC reject 模式）', () => {
    const err = new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: 'dup',
    });
    try {
      throw err;
    } catch (e) {
      expect(isIpcError(e)).toBe(true);
      if (isIpcError(e)) {
        expect(e.toJSON().code).toBe('conflict');
      }
    }
  });
});

describe('isIpcError type guard', () => {
  it('识别 IpcError', () => {
    const e: unknown = new IpcError({ code: IpcErrorCode.NOT_FOUND, message: 'x' });
    expect(isIpcError(e)).toBe(true);
  });
  it('拒绝普通 Error', () => {
    expect(isIpcError(new Error('x'))).toBe(false);
  });
  it('拒绝非 Error 对象', () => {
    expect(isIpcError('x')).toBe(false);
    expect(isIpcError({ code: 'foo' })).toBe(false);
    expect(isIpcError(null)).toBe(false);
    expect(isIpcError(undefined)).toBe(false);
  });
});

describe('validationFailed factory', () => {
  it('生成的 IpcError code=VALIDATION_FAILED + hint', () => {
    const v = validationFailed('foo is bad', 'ZodError');
    expect(v.code).toBe('validation_failed');
    expect(v.message).toBe('foo is bad');
    expect(v.cause).toBe('ZodError');
    expect(v.hint).toBe('请检查输入参数');
  });

  it('没有 cause 时不写 cause 字段', () => {
    const v = validationFailed('bad');
    expect(v.toJSON()).toEqual({
      code: 'validation_failed',
      message: 'bad',
      hint: '请检查输入参数',
    });
  });
});
