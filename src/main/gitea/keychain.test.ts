/**
 * keychain 包装单测
 *
 * 关键约束：
 * - **不**打真实 keychain（即使在 macOS 也不污染当前用户 keychain）
 * - 用 vi.mock 完全替换 @napi-rs/keyring
 * - 覆盖：错误映射（NoEntry / PlatformFailure / AccessDenied / 其它）
 * - 覆盖：多账号隔离（同 giteaUrl 不同 username）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===== Mock @napi-rs/keyring =====
// 必须在 import keychain.ts 之前 mock，否则模块顶层就 import 真包
const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockFindCredentials = vi.fn();

class MockAsyncEntry {
  constructor(public service: string, public account: string) {}
  setPassword = mockSet;
  getPassword = mockGet;
  deletePassword = mockDelete;
}

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: MockAsyncEntry,
  findCredentials: mockFindCredentials,
}));

// 现在 import
const {
  keychainSet,
  keychainGet,
  keychainDelete,
  keychainFindAccounts,
  keychainDeleteAllForUrl,
  makeService,
  makeEntry,
} = await import('./keychain.js');

const { IpcErrorCode } = await import('@shared/errors');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('makeService / makeEntry', () => {
  it('service 格式 gitea-kanban@<url>', () => {
    expect(makeService('http://localhost:3000')).toBe('gitea-kanban@http://localhost:3000');
  });
  it('entry 持有 service + account', () => {
    // @napi-rs/keyring 的 AsyncEntry 类型未导出 service/account 字段（运行时实际有），
    // 这里改用 cast 验证：构造时 service / account 已传给底层。
    const service = makeService('http://x');
    expect(service).toBe('gitea-kanban@http://x');
    const e = makeEntry('http://x', 'alice');
    // 用 Reflect 拿真实运行时属性
    const eAny = e as unknown as { service: string; account: string };
    expect(eAny.service).toBe('gitea-kanban@http://x');
    expect(eAny.account).toBe('alice');
  });
});

describe('keychainSet', () => {
  it('成功：不抛错，调用 setPassword', async () => {
    mockSet.mockResolvedValueOnce(undefined);
    await keychainSet('http://x', 'alice', 'tok-1');
    expect(mockSet).toHaveBeenCalledWith('tok-1');
  });

  it('PlatformFailure → KEYCHAIN_UNAVAILABLE', async () => {
    mockSet.mockRejectedValueOnce(new Error('platform failure: dbus not available'));
    await expect(keychainSet('http://x', 'alice', 'tok')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('NoStorageAccess → KEYCHAIN_UNAVAILABLE', async () => {
    mockSet.mockRejectedValueOnce(new Error('no storage access: gnome-keyring missing'));
    await expect(keychainSet('http://x', 'alice', 'tok')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('AccessDenied → KEYCHAIN_ACCESS_DENIED', async () => {
    mockSet.mockRejectedValueOnce(new Error('access denied by ACL'));
    await expect(keychainSet('http://x', 'alice', 'tok')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
    });
  });

  it('其它错误 → INTERNAL', async () => {
    mockSet.mockRejectedValueOnce(new Error('something weird'));
    await expect(keychainSet('http://x', 'alice', 'tok')).rejects.toMatchObject({
      code: IpcErrorCode.INTERNAL,
    });
  });
});

describe('keychainGet', () => {
  it('存在 → 返回字符串', async () => {
    mockGet.mockResolvedValueOnce('ghp_secret');
    const t = await keychainGet('http://x', 'alice');
    expect(t).toBe('ghp_secret');
  });

  it('不存在（null）→ 返回 null', async () => {
    mockGet.mockResolvedValueOnce(null);
    const t = await keychainGet('http://x', 'alice');
    expect(t).toBeNull();
  });

  it('NoEntry 错误 → 返回 null（不抛）', async () => {
    mockGet.mockRejectedValueOnce(new Error('no entry found'));
    const t = await keychainGet('http://x', 'alice');
    expect(t).toBeNull();
  });

  it('PlatformFailure → 抛 KEYCHAIN_UNAVAILABLE', async () => {
    mockGet.mockRejectedValueOnce(new Error('platform failure: no dbus'));
    await expect(keychainGet('http://x', 'alice')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('AccessDenied → 抛 KEYCHAIN_ACCESS_DENIED', async () => {
    mockGet.mockRejectedValueOnce(new Error('access denied'));
    await expect(keychainGet('http://x', 'alice')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
    });
  });
});

describe('keychainDelete', () => {
  it('存在 → 返回 true', async () => {
    mockDelete.mockResolvedValueOnce(true);
    const ok = await keychainDelete('http://x', 'alice');
    expect(ok).toBe(true);
  });

  it('不存在 → 返回 false', async () => {
    mockDelete.mockResolvedValueOnce(false);
    const ok = await keychainDelete('http://x', 'alice');
    expect(ok).toBe(false);
  });

  it('NoEntry → 返回 false', async () => {
    mockDelete.mockRejectedValueOnce(new Error('no entry'));
    const ok = await keychainDelete('http://x', 'alice');
    expect(ok).toBe(false);
  });

  it('PlatformFailure → 抛 KEYCHAIN_UNAVAILABLE', async () => {
    mockDelete.mockRejectedValueOnce(new Error('platform failure'));
    await expect(keychainDelete('http://x', 'alice')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });
});

describe('keychainFindAccounts', () => {
  it('返回 username 列表', async () => {
    mockFindCredentials.mockResolvedValueOnce([
      { service: 'gitea-kanban@http://x', account: 'alice' },
      { service: 'gitea-kanban@http://x', account: 'bob' },
    ]);
    const accounts = await keychainFindAccounts('http://x');
    expect(accounts).toEqual(['alice', 'bob']);
  });

  it('无条目 → 返回 []', async () => {
    mockFindCredentials.mockResolvedValueOnce([]);
    const accounts = await keychainFindAccounts('http://x');
    expect(accounts).toEqual([]);
  });

  it('PlatformFailure → 抛 KEYCHAIN_UNAVAILABLE', async () => {
    mockFindCredentials.mockRejectedValueOnce(new Error('platform failure'));
    await expect(keychainFindAccounts('http://x')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('NoEntry 错误 → 返回 []（不抛）', async () => {
    mockFindCredentials.mockRejectedValueOnce(new Error('no entry'));
    const accounts = await keychainFindAccounts('http://x');
    expect(accounts).toEqual([]);
  });
});

describe('keychainDeleteAllForUrl', () => {
  it('列所有 → 逐个删 → 返回成功数', async () => {
    mockFindCredentials.mockResolvedValueOnce([
      { service: 'gitea-kanban@http://x', account: 'alice' },
      { service: 'gitea-kanban@http://x', account: 'bob' },
    ]);
    mockDelete.mockResolvedValueOnce(true);
    mockDelete.mockResolvedValueOnce(true);
    const n = await keychainDeleteAllForUrl('http://x');
    expect(n).toBe(2);
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('空 → 返回 0', async () => {
    mockFindCredentials.mockResolvedValueOnce([]);
    const n = await keychainDeleteAllForUrl('http://x');
    expect(n).toBe(0);
  });
});

describe('多账号隔离', () => {
  it('同 giteaUrl 不同 username 互不干扰', async () => {
    // alice set / bob set / alice get 仍 alice / bob get 仍 bob
    mockSet.mockResolvedValue(undefined);
    mockGet.mockImplementation(async function (this: MockAsyncEntry) {
      if (this.account === 'alice') return 'alice-tok';
      if (this.account === 'bob') return 'bob-tok';
      return null;
    });
    await keychainSet('http://x', 'alice', 'alice-tok');
    await keychainSet('http://x', 'bob', 'bob-tok');
    expect(await keychainGet('http://x', 'alice')).toBe('alice-tok');
    expect(await keychainGet('http://x', 'bob')).toBe('bob-tok');
  });
});
