/**
 * main 端 gitea/keychain.ts 单测
 *
 * 覆盖：
 * - makeService / makeEntry 工厂
 * - mapKeyringError 错误映射（NoEntry / UNAVAILABLE / ACCESS_DENIED / INTERNAL / 其它）
 * - keychainSet/Get/Delete/Find 业务层 API（含 NoEntry 退化为 null/false/[]）
 *
 * Mock 策略：
 * - @napi-rs/keyring 整个 mock 掉（不真访问系统 keychain）
 * - 每个测试用 vi.fn() 控制 setPassword/getPassword/deletePassword/findCredentials 的返回值或抛错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { KEYCHAIN_SERVICE_PREFIX } from '@shared/constants';

const mocks = vi.hoisted(() => {
  // factory 必须能在 vi.mock factory 里用，所以放进 hoisted 块
  function makeFakeEntry() {
    return {
      setPassword: vi.fn().mockResolvedValue(undefined),
      getPassword: vi.fn().mockResolvedValue('my-pat'),
      deletePassword: vi.fn().mockResolvedValue(true),
    };
  }
  return {
    AsyncEntry: vi.fn(),
    findCredentials: vi.fn(),
    /** 当前测试期望构造时返的 entry impl（test 用 vi.fn() 控返回值/抛错） */
    currentImpl: null as null | ReturnType<typeof makeFakeEntry>,
    makeFakeEntry,
  };
});

vi.mock('@napi-rs/keyring', () => {
  // 必须用真 class 才能被 `new AsyncEntry(...)` 调用 —— 普通 vi.fn() 不是构造器
  class FakeAsyncEntry {
    public service: string;
    public username: string;
    public impl: ReturnType<typeof mocks.makeFakeEntry>;
    constructor(service: string, username: string) {
      this.service = service;
      this.username = username;
      // 每次 new 都从 currentImpl 取一份 fresh vi.fn() —— 让 beforeEach 的 mockResolvedValueOnce 隔离
      this.impl = mocks.currentImpl ?? mocks.makeFakeEntry();
      mocks.AsyncEntry(service, username); // 记录构造调用
    }
    setPassword(p: string) { return this.impl.setPassword(p); }
    getPassword() { return this.impl.getPassword(); }
    deletePassword() { return this.impl.deletePassword(); }
  }
  return {
    AsyncEntry: FakeAsyncEntry,
    findCredentials: mocks.findCredentials,
  };
});

const {
  makeService,
  makeEntry,
  keychainSet,
  keychainGet,
  keychainDelete,
  keychainFindAccounts,
  keychainDeleteAllForUrl,
} = await import('../keychain.js');

/** 构造一个 fake AsyncEntry —— 暴露 setPassword/getPassword/deletePassword 三个 vi.fn() */
function makeFakeEntry() {
  return mocks.makeFakeEntry();
}

beforeEach(() => {
  mocks.AsyncEntry.mockReset();
  mocks.findCredentials.mockReset();
});

// ============================================================
// ===== 工厂 ===================================================
// ============================================================

describe('gitea/keychain · makeService / makeEntry', () => {
  it('makeService = "<prefix><giteaUrl>"', () => {
    expect(makeService('https://gitea.example.com')).toBe(
      `${KEYCHAIN_SERVICE_PREFIX}https://gitea.example.com`,
    );
  });

  it('makeEntry 调 AsyncEntry(service, account) 构造', () => {
    mocks.currentImpl = null; // 用默认 fresh impl
    const e = makeEntry('https://x', 'alice');
    expect(mocks.AsyncEntry).toHaveBeenCalledWith(`${KEYCHAIN_SERVICE_PREFIX}https://x`, 'alice');
    // 返回值是 FakeAsyncEntry 实例 —— 验证 service/username 字段
    expect((e as unknown as { service: string }).service).toBe(`${KEYCHAIN_SERVICE_PREFIX}https://x`);
    expect((e as unknown as { username: string }).username).toBe('alice');
  });
});

// ============================================================
// ===== keychainSet ===========================================
// ============================================================

describe('gitea/keychain · keychainSet', () => {
  beforeEach(() => {
    mocks.AsyncEntry.mockImplementation(() => makeFakeEntry());
  });

  it('success → 调 entry.setPassword(token)', async () => {
    const entry = makeFakeEntry();
    mocks.currentImpl = entry;
    await keychainSet('https://x', 'alice', 'tok-123');
    expect(entry.setPassword).toHaveBeenCalledWith('tok-123');
  });

  it('platform failure → throw KEYCHAIN_UNAVAILABLE', async () => {
    const entry = makeFakeEntry();
    entry.setPassword.mockRejectedValueOnce(new Error('platform failure: libsecret not available'));
    mocks.currentImpl = entry;
    await expect(keychainSet('https://x', 'a', 't')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('access denied → throw KEYCHAIN_ACCESS_DENIED', async () => {
    const entry = makeFakeEntry();
    entry.setPassword.mockRejectedValueOnce(new Error('access denied by ACL'));
    mocks.currentImpl = entry;
    await expect(keychainSet('https://x', 'a', 't')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
    });
  });

  it('permission denied（无连字符）→ throw KEYCHAIN_ACCESS_DENIED', async () => {
    const entry = makeFakeEntry();
    entry.setPassword.mockRejectedValueOnce(new Error('Permission Denied'));
    mocks.currentImpl = entry;
    await expect(keychainSet('https://x', 'a', 't')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
    });
  });

  it('未知错误 → throw INTERNAL', async () => {
    const entry = makeFakeEntry();
    entry.setPassword.mockRejectedValueOnce(new Error('something weird'));
    mocks.currentImpl = entry;
    await expect(keychainSet('https://x', 'a', 't')).rejects.toMatchObject({
      code: IpcErrorCode.INTERNAL,
    });
  });

  it('cause 透传原始 message', async () => {
    const entry = makeFakeEntry();
    entry.setPassword.mockRejectedValueOnce(new Error('platform failure: x'));
    mocks.currentImpl = entry;
    try {
      await keychainSet('https://x', 'a', 't');
    } catch (err) {
      expect((err as IpcError).cause).toBe('platform failure: x');
    }
  });
});

// ============================================================
// ===== keychainGet ===========================================
// ============================================================

describe('gitea/keychain · keychainGet', () => {
  it('success → 返 token 字符串', async () => {
    const entry = makeFakeEntry();
    entry.getPassword.mockResolvedValueOnce('my-pat');
    mocks.currentImpl = entry;
    await expect(keychainGet('https://x', 'alice')).resolves.toBe('my-pat');
  });

  it('getPassword 返 undefined → 业务返 null（不进 catch）', async () => {
    const entry = makeFakeEntry();
    entry.getPassword.mockResolvedValueOnce(undefined);
    mocks.currentImpl = entry;
    await expect(keychainGet('https://x', 'alice')).resolves.toBeNull();
  });

  it('NoEntry error → 业务返 null（mapKeyringError 返回 null）', async () => {
    const entry = makeFakeEntry();
    entry.getPassword.mockRejectedValueOnce(new Error('No entry found'));
    mocks.currentImpl = entry;
    await expect(keychainGet('https://x', 'alice')).resolves.toBeNull();
  });

  it('platform failure → throw KEYCHAIN_UNAVAILABLE', async () => {
    const entry = makeFakeEntry();
    entry.getPassword.mockRejectedValueOnce(new Error('no storage access'));
    mocks.currentImpl = entry;
    await expect(keychainGet('https://x', 'a')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('access denied → throw KEYCHAIN_ACCESS_DENIED', async () => {
    const entry = makeFakeEntry();
    entry.getPassword.mockRejectedValueOnce(new Error('access denied'));
    mocks.currentImpl = entry;
    await expect(keychainGet('https://x', 'a')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
    });
  });

  it('未知错误 → throw INTERNAL', async () => {
    const entry = makeFakeEntry();
    entry.getPassword.mockRejectedValueOnce(new Error('weird'));
    mocks.currentImpl = entry;
    await expect(keychainGet('https://x', 'a')).rejects.toMatchObject({
      code: IpcErrorCode.INTERNAL,
    });
  });
});

// ============================================================
// ===== keychainDelete ========================================
// ============================================================

describe('gitea/keychain · keychainDelete', () => {
  it('deletePassword 返 truthy → 业务返 true', async () => {
    const entry = makeFakeEntry();
    entry.deletePassword.mockResolvedValueOnce(true);
    mocks.currentImpl = entry;
    await expect(keychainDelete('https://x', 'a')).resolves.toBe(true);
  });

  it('deletePassword 返 falsy → 业务返 false', async () => {
    const entry = makeFakeEntry();
    entry.deletePassword.mockResolvedValueOnce(0);
    mocks.currentImpl = entry;
    await expect(keychainDelete('https://x', 'a')).resolves.toBe(false);
  });

  it('NoEntry error → 业务返 false（mapKeyringError 返回 null）', async () => {
    const entry = makeFakeEntry();
    entry.deletePassword.mockRejectedValueOnce(new Error('no entry'));
    mocks.currentImpl = entry;
    await expect(keychainDelete('https://x', 'a')).resolves.toBe(false);
  });

  it('platform failure → throw KEYCHAIN_UNAVAILABLE', async () => {
    const entry = makeFakeEntry();
    entry.deletePassword.mockRejectedValueOnce(new Error('platform failure: nosecret'));
    mocks.currentImpl = entry;
    await expect(keychainDelete('https://x', 'a')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });
});

// ============================================================
// ===== keychainFindAccounts ==================================
// ============================================================

describe('gitea/keychain · keychainFindAccounts', () => {
  it('success → 返 account 列表（**不**含 password）', async () => {
    mocks.findCredentials.mockResolvedValueOnce([
      { account: 'alice', password: 'pat-alice' },
      { account: 'bob', password: 'pat-bob' },
    ]);
    const r = await keychainFindAccounts('https://x');
    expect(r).toEqual(['alice', 'bob']);
    // 验证 password 字段**没有**泄露出去
    expect((r as unknown as Array<{ password?: string }>)[0]?.password).toBeUndefined();
  });

  it('NoEntry / 空 creds → 返 []（不抛）', async () => {
    mocks.findCredentials.mockRejectedValueOnce(new Error('no entry'));
    await expect(keychainFindAccounts('https://x')).resolves.toEqual([]);
  });

  it('空数组 → 返 []', async () => {
    mocks.findCredentials.mockResolvedValueOnce([]);
    await expect(keychainFindAccounts('https://x')).resolves.toEqual([]);
  });

  it('platform failure → throw KEYCHAIN_UNAVAILABLE', async () => {
    mocks.findCredentials.mockRejectedValueOnce(new Error('platform failure: dbus missing'));
    await expect(keychainFindAccounts('https://x')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
    });
  });

  it('access denied → throw KEYCHAIN_ACCESS_DENIED', async () => {
    mocks.findCredentials.mockRejectedValueOnce(new Error('access denied'));
    await expect(keychainFindAccounts('https://x')).rejects.toMatchObject({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
    });
  });
});

// ============================================================
// ===== keychainDeleteAllForUrl ===============================
// ============================================================

describe('gitea/keychain · keychainDeleteAllForUrl', () => {
  it('3 个账号全删成功 → 返 3', async () => {
    // 第一次 findCredentials 返 3 个账号
    mocks.findCredentials.mockResolvedValueOnce([
      { account: 'alice', password: 'x' },
      { account: 'bob', password: 'y' },
      { account: 'carol', password: 'z' },
    ]);
    // 每个 deletePassword 都成功
    const entry = makeFakeEntry();
    entry.deletePassword.mockResolvedValue(true);
    mocks.currentImpl = entry;

    const n = await keychainDeleteAllForUrl('https://x');
    expect(n).toBe(3);
    expect(entry.deletePassword).toHaveBeenCalledTimes(3);
  });

  it('有账号 NoEntry 不存在（deletePassword 返 false）→ 不计入成功数', async () => {
    mocks.findCredentials.mockResolvedValueOnce([
      { account: 'alice', password: 'x' },
      { account: 'bob', password: 'y' },
    ]);
    const entry = makeFakeEntry();
    // alice 成功，bob NoEntry 返 false
    entry.deletePassword
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mocks.currentImpl = entry;

    const n = await keychainDeleteAllForUrl('https://x');
    expect(n).toBe(1);
  });
});