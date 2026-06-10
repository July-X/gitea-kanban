import { describe, it, expect } from 'vitest';
import {
  ConnectArgsSchema,
  DisconnectArgsSchema,
  StatusResultSchema,
  GiteaUrlSchema,
  TokenSchema,
  UserDtoSchema,
  IpcChannel,
} from './schema.js';

describe('GiteaUrlSchema', () => {
  it('接受 http:// + host', () => {
    expect(GiteaUrlSchema.parse('http://localhost:3000')).toBe('http://localhost:3000');
  });
  it('接受 https:// + host', () => {
    expect(GiteaUrlSchema.parse('https://gitea.example.com')).toBe('https://gitea.example.com');
  });
  it('接受子路径', () => {
    expect(GiteaUrlSchema.parse('https://example.com/gitea/')).toBe('https://example.com/gitea/');
  });
  it('拒绝非 URL', () => {
    expect(() => GiteaUrlSchema.parse('not-a-url')).toThrow();
  });
  it('拒绝 file://', () => {
    expect(() => GiteaUrlSchema.parse('file:///tmp/x')).toThrow();
  });
  it('拒绝空字符串', () => {
    expect(() => GiteaUrlSchema.parse('')).toThrow();
  });
});

describe('TokenSchema', () => {
  it('接受 ≥ 8 字符', () => {
    expect(TokenSchema.parse('ghp_abcdef123')).toBe('ghp_abcdef123');
  });
  it('去前后空格', () => {
    expect(TokenSchema.parse('  ghp_abcdef123  ')).toBe('ghp_abcdef123');
  });
  it('拒绝 < 8 字符', () => {
    expect(() => TokenSchema.parse('short')).toThrow();
  });
  it('拒绝 > 512 字符', () => {
    expect(() => TokenSchema.parse('a'.repeat(513))).toThrow();
  });
});

describe('ConnectArgsSchema', () => {
  it('合法 giteaUrl + token 通过', () => {
    const r = ConnectArgsSchema.parse({
      giteaUrl: 'http://localhost:3000',
      token: 'ghp_abcdef123',
    });
    expect(r.giteaUrl).toBe('http://localhost:3000');
    expect(r.token).toBe('ghp_abcdef123');
  });

  it('缺 giteaUrl 失败', () => {
    expect(() =>
      ConnectArgsSchema.parse({ token: 'ghp_abcdef123' }),
    ).toThrow();
  });

  it('缺 token 失败', () => {
    expect(() =>
      ConnectArgsSchema.parse({ giteaUrl: 'http://localhost:3000' }),
    ).toThrow();
  });

  it('非法 giteaUrl 失败', () => {
    expect(() =>
      ConnectArgsSchema.parse({ giteaUrl: 'not-a-url', token: 'ghp_abcdef123' }),
    ).toThrow();
  });
});

describe('DisconnectArgsSchema', () => {
  it('只需 giteaUrl', () => {
    const r = DisconnectArgsSchema.parse({ giteaUrl: 'http://localhost:3000' });
    expect(r.giteaUrl).toBe('http://localhost:3000');
  });
  it('空对象失败', () => {
    expect(() => DisconnectArgsSchema.parse({})).toThrow();
  });
});

describe('UserDtoSchema', () => {
  it('最少字段（id + login）', () => {
    const r = UserDtoSchema.parse({ id: 1, login: 'alice' });
    expect(r.id).toBe(1);
    expect(r.login).toBe('alice');
  });
  it('可选字段', () => {
    const r = UserDtoSchema.parse({
      id: 1,
      login: 'alice',
      fullName: 'Alice',
      email: 'alice@example.com',
      avatarUrl: 'https://example.com/a.png',
    });
    expect(r.fullName).toBe('Alice');
    expect(r.email).toBe('alice@example.com');
  });
  it('login 不能空', () => {
    expect(() => UserDtoSchema.parse({ id: 1, login: '' })).toThrow();
  });
  it('id 必须正整数', () => {
    expect(() => UserDtoSchema.parse({ id: 0, login: 'alice' })).toThrow();
    expect(() => UserDtoSchema.parse({ id: -1, login: 'alice' })).toThrow();
  });
});

describe('StatusResultSchema', () => {
  it('空 accounts + null currentUser', () => {
    const r = StatusResultSchema.parse({ accounts: [], currentUser: null });
    expect(r.accounts).toEqual([]);
    expect(r.currentUser).toBeNull();
  });
  it('完整状态', () => {
    const r = StatusResultSchema.parse({
      accounts: [
        { id: '00000000-0000-4000-8000-000000000001', giteaUrl: 'http://localhost:3000', username: 'alice', createdAt: '2026-06-10T00:00:00.000Z' },
      ],
      currentUser: { id: 1, login: 'alice' },
    });
    expect(r.accounts).toHaveLength(1);
    expect(r.currentUser?.login).toBe('alice');
  });
  it('**不**含 token 字段（schema 强制）', () => {
    // 即使有人尝试塞 token，schema 也不接受
    expect(() =>
      StatusResultSchema.parse({
        accounts: [],
        currentUser: { id: 1, login: 'alice', token: 'ghp_secret' },
      }),
    ).toThrow();
  });
});

describe('IpcChannel 常量', () => {
  it('所有 channel 是点分命名（namespace.method 或 namespace.namespace.method，camelCase 允许）', () => {
    // 02-architecture.md §5.1：'<namespace>.<method>'，camelCase
    // v1 board 走 `board.columns.*` / `board.cards.*`（双段 namespace，02 §5.3 拍板）
    for (const v of Object.values(IpcChannel)) {
      expect(v).toMatch(/^[a-z]+(\.[a-z]+)*\.[a-z][a-zA-Z0-9]*$/);
    }
  });
  it('auth.* 三个 channel 存在', () => {
    expect(IpcChannel.AUTH_CONNECT).toBe('auth.connect');
    expect(IpcChannel.AUTH_DISCONNECT).toBe('auth.disconnect');
    expect(IpcChannel.AUTH_STATUS).toBe('auth.status');
  });
});
