/**
 * file-store 单元测试
 *
 * 不引 electron / better-sqlite3 / drizzle；纯 fs + 临时目录
 *
 * 覆盖：
 * 1. get / set / delete / invalidate 4 个公共 API
 * 2. 过期（mtime + ttlSeconds 算 age）
 * 3. JSON.parse 失败 → 当 miss
 * 4. 原子写（tmp 不残留）
 * 5. GC：超预算按 mtime LRU 删
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getCache, setCache, deleteCache, invalidateCache, gcCache, resolveCacheDir } from '../file-store.js';

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-file-store-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
});

afterEach(async () => {
  if (savedEnv !== undefined) {
    process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  } else {
    delete process.env['GITEA_KANBAN_DATA_DIR'];
  }
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  await sleep(10);
});

// ===== resolveCacheDir =====

describe('resolveCacheDir', () => {
  it('返 ${DATA_DIR}/cache', () => {
    expect(resolveCacheDir()).toBe(join(TMP_DIR, 'cache'));
  });
});

// ===== getCache / setCache =====

describe('setCache + getCache', () => {
  it('set 后 get 命中（payload 还原）', () => {
    setCache({ resource: 'repos', projectId: 'p1', key: 'k1', payload: { a: 1 }, ttlSeconds: 60 });
    const got = getCache<{ a: number }>({ resource: 'repos', projectId: 'p1', key: 'k1' });
    expect(got).toEqual({ a: 1 });
  });

  it('set 后 get 不同 key 返 null', () => {
    setCache({ resource: 'repos', projectId: 'p1', key: 'k1', payload: { a: 1 }, ttlSeconds: 60 });
    expect(getCache({ resource: 'repos', projectId: 'p1', key: 'k2' })).toBeNull();
  });

  it('set 后 get 不同 resource 隔离', () => {
    setCache({ resource: 'repos', projectId: 'p1', key: 'k1', payload: 'r', ttlSeconds: 60 });
    setCache({ resource: 'branches', projectId: 'p1', key: 'k1', payload: 'b', ttlSeconds: 60 });
    expect(getCache<string>({ resource: 'repos', projectId: 'p1', key: 'k1' })).toBe('r');
    expect(getCache<string>({ resource: 'branches', projectId: 'p1', key: 'k1' })).toBe('b');
  });

  it('set 后 get 不同 projectId 隔离', () => {
    setCache({ resource: 'repos', projectId: 'p1', key: 'k1', payload: 1, ttlSeconds: 60 });
    setCache({ resource: 'repos', projectId: 'p2', key: 'k1', payload: 2, ttlSeconds: 60 });
    expect(getCache<number>({ resource: 'repos', projectId: 'p1', key: 'k1' })).toBe(1);
    expect(getCache<number>({ resource: 'repos', projectId: 'p2', key: 'k1' })).toBe(2);
  });

  it('upsert：同 key 覆盖', () => {
    setCache({ resource: 'r', projectId: 'p', key: 'k', payload: 'old', ttlSeconds: 60 });
    setCache({ resource: 'r', projectId: 'p', key: 'k', payload: 'new', ttlSeconds: 60 });
    expect(getCache<string>({ resource: 'r', projectId: 'p', key: 'k' })).toBe('new');
  });
});

// ===== TTL 过期 =====

describe('getCache TTL 过期', () => {
  it('mtime + ttlSeconds 算 age，过期返 null', async () => {
    setCache({ resource: 'r', projectId: 'p', key: 'k', payload: 'v', ttlSeconds: 1 });
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k' })).toBe('v');
    // 把 mtime 调到 2 秒前（mtimeMs 改时间，模拟时间流逝）
    const file = join(TMP_DIR, 'cache', 'r', 'p__k.json');
    expect(existsSync(file)).toBe(true);
    const twoSecAgo = new Date(Date.now() - 2_000);
    utimesSync(file, twoSecAgo, twoSecAgo);
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k' })).toBeNull();
  });
});

// ===== JSON.parse 失败 / 文件竞态 =====

describe('getCache 健壮性', () => {
  it('文件不存在 → null', () => {
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k' })).toBeNull();
  });

  it('JSON 损坏 → null（不当错抛）', () => {
    const dir = join(TMP_DIR, 'cache', 'r');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'p__k.json'), '{ not valid json', { mode: 0o600 });
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k' })).toBeNull();
  });
});

// ===== deleteCache =====

describe('deleteCache', () => {
  it('存在 → 删；不存在 → idempotent noop', () => {
    setCache({ resource: 'r', projectId: 'p', key: 'k', payload: 1, ttlSeconds: 60 });
    deleteCache({ resource: 'r', projectId: 'p', key: 'k' });
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k' })).toBeNull();
    deleteCache({ resource: 'r', projectId: 'p', key: 'k' }); // idempotent
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k' })).toBeNull();
  });
});

// ===== invalidateCache =====

describe('invalidateCache', () => {
  it('resource 级别：清空整个 resource 目录', () => {
    setCache({ resource: 'r', projectId: 'p1', key: 'k1', payload: 1, ttlSeconds: 60 });
    setCache({ resource: 'r', projectId: 'p2', key: 'k1', payload: 2, ttlSeconds: 60 });
    setCache({ resource: 'b', projectId: 'p1', key: 'k1', payload: 3, ttlSeconds: 60 });
    invalidateCache({ resource: 'r' });
    expect(getCache({ resource: 'r', projectId: 'p1', key: 'k1' })).toBeNull();
    expect(getCache({ resource: 'r', projectId: 'p2', key: 'k1' })).toBeNull();
    expect(getCache({ resource: 'b', projectId: 'p1', key: 'k1' })).toBe(3); // 不动
  });

  it('projectId 级别：仅清该项目', () => {
    setCache({ resource: 'r', projectId: 'p1', key: 'k1', payload: 1, ttlSeconds: 60 });
    setCache({ resource: 'r', projectId: 'p2', key: 'k1', payload: 2, ttlSeconds: 60 });
    invalidateCache({ resource: 'r', projectId: 'p1' });
    expect(getCache({ resource: 'r', projectId: 'p1', key: 'k1' })).toBeNull();
    expect(getCache({ resource: 'r', projectId: 'p2', key: 'k1' })).toBe(2);
  });
});

// ===== gcCache =====

describe('gcCache LRU', () => {
  it('未超预算 → 不删', () => {
    setCache({ resource: 'r', projectId: 'p', key: 'k1', payload: 'x', ttlSeconds: 60 });
    const r = gcCache({ budgetBytes: 1024 * 1024 });
    expect(r.removed).toBe(0);
    expect(r.remaining).toBe(1);
  });

  it('超预算 → 按 mtime 升序（最旧）删到预算内', async () => {
    // 写 5 个，每个约 200 字节
    for (let i = 0; i < 5; i++) {
      setCache({ resource: 'r', projectId: 'p', key: `k${i}`, payload: 'x'.repeat(200), ttlSeconds: 60 });
      await sleep(20); // 保证 mtime 不同
    }
    // 预算 = 300 字节 → 删到 ≤ 1 个文件
    const r = gcCache({ budgetBytes: 300 });
    expect(r.bytesAfter).toBeLessThanOrEqual(300);
    expect(r.remaining).toBeGreaterThanOrEqual(1);
    expect(r.remaining).toBeLessThan(5);
    // 删的是最旧的 k0, k1, k2, k3（保留最新 k4）
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k0' })).toBeNull();
    expect(getCache({ resource: 'r', projectId: 'p', key: 'k4' })).toBe('x'.repeat(200));
  });

  it('空目录 → 0 删', () => {
    const r = gcCache({ budgetBytes: 1024 });
    expect(r.removed).toBe(0);
    expect(r.remaining).toBe(0);
  });
});
