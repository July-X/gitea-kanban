/**
 * auth.test.ts —— auth store 状态机
 *
 * 覆盖（stores/auth.ts 行为 + AGENTS §8.2 token 铁律）：
 * - refreshStatus 成功 → 填 accounts + currentUser
 * - refreshStatus 失败 → accounts 保留 / error 填充 / loading 复位
 * - connect 成功 → 调一次 connect IPC + 自动 refreshStatus
 * - connect 失败 → 抛 UserFacingError + 填 error
 * - disconnect 成功 → 调一次 disconnect + 自动 refreshStatus
 * - 跨 store 调 connect 时**不**留 token 引用（铁律：store 不持 token）
 *
 * 用 vi.mock('@renderer/lib/ipc-client') mock 三个具名函数
 */

// ⚠️ 必须在 import pinia / vue / store 之前 stub localStorage
// node 22 默认的 localStorage 是个空对象，vue devtools-kit 在 module load 阶段就调 localStorage.getItem
// 会抛 TypeError；用 vi.hoisted 让 stub 代码 hoist 到所有 import 之前
vi.hoisted(() => {
  if (typeof globalThis.localStorage === 'undefined' || typeof (globalThis.localStorage as { getItem?: unknown }).getItem !== 'function') {
    const store: Record<string, string> = {};
    const polyfill = {
      getItem: (k: string): string | null => (k in store ? store[k]! : null),
      setItem: (k: string, v: string): void => {
        store[k] = String(v);
      },
      removeItem: (k: string): void => {
        delete store[k];
      },
      clear: (): void => {
        for (const k of Object.keys(store)) delete store[k];
      },
      key: (i: number): string | null => Object.keys(store)[i] ?? null,
      get length(): number {
        return Object.keys(store).length;
      },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: polyfill,
      writable: true,
      configurable: true,
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@renderer/stores/auth';
import type { GiteaAccountDto, UserDto } from '../../main/ipc/schema.js';

// 关键：把 authConnect / authDisconnect / authStatus 三个具名函数 mock 掉
// 用 vi.hoisted 让 mock factory 在 hoisting 阶段就生效
const { mockAuthConnect, mockAuthDisconnect, mockAuthStatus } = vi.hoisted(() => ({
  mockAuthConnect: vi.fn(),
  mockAuthDisconnect: vi.fn(),
  mockAuthStatus: vi.fn(),
}));

vi.mock('@renderer/lib/ipc-client', () => ({
  authConnect: mockAuthConnect,
  authDisconnect: mockAuthDisconnect,
  authStatus: mockAuthStatus,
}));

const fakeUser: UserDto = {
  id: 1,
  login: 'alice',
  fullName: 'Alice',
  email: 'alice@example.com',
  avatarUrl: 'https://example.com/avatar.png',
};

const fakeAccount: GiteaAccountDto = {
  id: 'acc-1',
  giteaUrl: 'https://gitea.example.com',
  username: 'alice',
  createdAt: '2026-06-10T00:00:00.000Z',
};

const fakeStatusResp = {
  accounts: [fakeAccount],
  currentUser: fakeUser,
};

beforeEach(() => {
  setActivePinia(createPinia());
  mockAuthConnect.mockReset();
  mockAuthDisconnect.mockReset();
  mockAuthStatus.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAuthStore', () => {
  describe('refreshStatus', () => {
    it('成功 → accounts/currentUser 填进 store + loading 复位', async () => {
      mockAuthStatus.mockResolvedValueOnce(fakeStatusResp);
      const store = useAuthStore();
      expect(store.accounts).toEqual([]);
      expect(store.currentUser).toBeNull();

      await store.refreshStatus();

      expect(store.accounts).toEqual([fakeAccount]);
      expect(store.currentUser).toEqual(fakeUser);
      expect(store.isConnected).toBe(true);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('失败 → accounts 保留 / error 填充 / loading 复位', async () => {
      mockAuthStatus.mockRejectedValueOnce({
        code: 'network_offline',
        message: '网络不可达',
        hint: '检查网络',
      });
      const store = useAuthStore();

      await store.refreshStatus();

      // accounts 保持空（首次失败）,error 填充,loading 复位
      expect(store.accounts).toEqual([]);
      expect(store.error).toMatchObject({ code: 'network_offline' });
      expect(store.loading).toBe(false);
    });
  });

  describe('connect', () => {
    it('成功 → 调一次 connect + 拉一次 status', async () => {
      mockAuthConnect.mockResolvedValueOnce({
        account: fakeAccount,
        user: fakeUser,
      });
      mockAuthStatus.mockResolvedValueOnce(fakeStatusResp);

      const store = useAuthStore();
      await store.connect('https://gitea.example.com', 'fake-token-1234');

      expect(mockAuthConnect).toHaveBeenCalledWith('https://gitea.example.com', 'fake-token-1234');
      expect(mockAuthConnect).toHaveBeenCalledTimes(1);
      expect(mockAuthStatus).toHaveBeenCalledTimes(1);
      expect(store.isConnected).toBe(true);
      expect(store.error).toBeNull();
    });

    it('**不**把 token 存到 store（AGENTS §8.2 铁律）', async () => {
      mockAuthConnect.mockResolvedValueOnce({
        account: fakeAccount,
        user: fakeUser,
      });
      mockAuthStatus.mockResolvedValueOnce(fakeStatusResp);

      const store = useAuthStore();
      await store.connect('https://gitea.example.com', 'secret-token-1234');

      // store 字段不能含 token / tokenLike 字符串
      const dump = JSON.stringify(store.$state);
      expect(dump).not.toContain('secret-token-1234');
      expect(dump).not.toMatch(/token/i);
    });

    it('失败 → 抛错 + error 填充 + 不调 status', async () => {
      mockAuthConnect.mockRejectedValueOnce({
        code: 'token_invalid',
        message: '令牌无效',
        hint: '重新生成',
      });

      const store = useAuthStore();
      await expect(store.connect('https://x', 'bad')).rejects.toMatchObject({
        code: 'token_invalid',
      });
      expect(store.error).toMatchObject({ code: 'token_invalid' });
      expect(mockAuthStatus).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('成功 → 调一次 disconnect + 拉一次 status', async () => {
      mockAuthDisconnect.mockResolvedValueOnce({});
      mockAuthStatus.mockResolvedValueOnce({ accounts: [], currentUser: null });

      const store = useAuthStore();
      await store.disconnect('https://gitea.example.com');

      expect(mockAuthDisconnect).toHaveBeenCalledWith('https://gitea.example.com');
      expect(mockAuthStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearError', () => {
    it('清空 error 字段', async () => {
      mockAuthStatus.mockRejectedValueOnce({ code: 'internal', message: 'x' });
      const store = useAuthStore();
      await store.refreshStatus();
      expect(store.error).not.toBeNull();

      store.clearError();
      expect(store.error).toBeNull();
    });
  });

  describe('getters', () => {
    it('isConnected 反映 accounts.length > 0', async () => {
      mockAuthStatus.mockResolvedValueOnce({ accounts: [], currentUser: null });
      const store = useAuthStore();
      await store.refreshStatus();
      expect(store.isConnected).toBe(false);
    });

    it('currentGiteaUrl 取 accounts[0].giteaUrl', async () => {
      mockAuthStatus.mockResolvedValueOnce(fakeStatusResp);
      const store = useAuthStore();
      await store.refreshStatus();
      expect(store.currentGiteaUrl).toBe('https://gitea.example.com');
    });

    it('accounts 为空时 currentGiteaUrl 为空串', async () => {
      const store = useAuthStore();
      expect(store.currentGiteaUrl).toBe('');
    });
  });
});
