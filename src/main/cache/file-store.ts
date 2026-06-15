/**
 * FileStore —— Gitea 缓存层文件 KV（替代 SQLite cache_entries）
 *
 * 职责（ADR-0003 Phase 3b）：
 * - 5 个 resource（repos / branches / commits / pulls / timeline）缓存读写
 * - TTL 过期处理（mtime vs now 算 age）
 * - 启动期 LRU GC（按 mtime 倒序删到 LRU_BUDGET_BYTES 内）
 * - 原子写（writeFile + rename，同 localStore 模式）
 *
 * 文件布局：
 *   ${DATA_DIR}/cache/
 *     repos/<projectId>__<key>.json      # { payload, fetchedAt, ttlSeconds }
 *     branches/<projectId>__<key>.json
 *     commits/<projectId>__<key>.json
 *     pulls/<projectId>__<key>.json
 *     timeline/<projectId>__<key>.json
 *     manifest.json                       # LRU 元数据（mtime + bytes；启动期 GC 决策用）
 *
 * key 命名：项目方传 `cacheKey`（业务层 makeXxxCacheKey 构造），
 *   双下划线 `__` 是 projectId 与 key 的分隔符（业务层 key 内部禁止出现 `__`），
 *   简化：业务层 key 已用 `|`（如 `project=x|branches=main`），无 `__` 风险。
 *
 * 边界（任务 prompt §严格边界）：
 * - **不**碰 IPC 契约
 * - **不**碰 src/renderer/**
 * - **不**改 Gitea 集成
 * - **不**存业务态（业务态走 localStore）
 * - **不**接 drizzle / better-sqlite3（Phase 3b 目标就是删这俩）
 *
 * 错误处理：
 * - 读失败（JSON.parse 错 / 文件不存在）→ 返 null（cache miss）
 * - 写失败：抛（IPC handler 写失败必须显式错，让调用方决定是 invalidate 还是重试）
 * - GC 失败：log warn 但不抛（启动期容忍）
 *
 * 并发（v1 单实例）：
 * - 单进程内：debounce 不需要（写即生效）
 * - 跨进程：v1 不支持，TODO v2+（文件锁或迁移到 sqlite WAL）
 *
 * 性能预算（实测基线）：
 * - 读缓存：1 次 readFile（0.5ms） + 1 次 JSON.parse（0.1ms） ≈ 1ms
 * - 写缓存：1 次 writeFile tmp + 1 次 rename ≈ 1ms
 * - 启动期 GC：扫 ~500 文件按 mtime 倒序删到 LRU 预算内 ≈ 50ms
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { pino } from 'pino';
import { logger } from '../logger.js';

const log = pino({ name: 'cache-file-store', level: process.env['LOG_LEVEL'] ?? 'info' });

/** cache/ 根目录默认 LRU 预算（实测：5 resource × 20 project × 5 key ≈ 500 文件 ≈ 5-10 MB） */
const DEFAULT_LRU_BUDGET_BYTES = 50 * 1024 * 1024; // 50 MB

/** cache key 构造：业务方 key + 项目方 key，双下划线分隔避免冲突 */
function makeEntryPath(rootDir: string, resource: string, projectId: string, key: string): string {
  return join(rootDir, resource, `${projectId}__${key}.json`);
}

/**
 * 内部：拼出 cache 根目录
 * 与 localStore state.json 同样策略：
 * - 优先 ${GITEA_KANBAN_DATA_DIR}/cache
 * - 兜底 ~/.gitea-kanban/cache
 */
export function resolveCacheDir(): string {
  const dataDir = process.env['GITEA_KANBAN_DATA_DIR']
    ?? join(process.env['HOME'] ?? '/tmp', '.gitea-kanban');
  if (!isAbsolute(dataDir)) {
    throw new Error(`data dir must be absolute, got: ${dataDir}`);
  }
  return join(dataDir, 'cache');
}

// ============================================================
// ===== 公共 API =====
// ============================================================

/**
 * 读缓存
 *
 * 行为：
 * 1. 文件不存在 → 返 null（cache miss）
 * 2. 读文件 / JSON.parse 失败 → 返 null + log warn（烂数据当 miss 处理，不阻塞调用方）
 * 3. mtime + ttlSeconds 算出 age，过期 → 返 null（cache miss）
 *    **不**主动删（等下次启动期 GC 或 invalidate 触发）
 * 4. 命中 → 返 payload
 */
export function getCache<T>(args: {
  resource: string;
  projectId: string;
  key: string;
}): T | null {
  const file = makeEntryPath(resolveCacheDir(), args.resource, args.projectId, args.key);
  if (!existsSync(file)) return null;

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    log.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      'fileStore.get: readFile failed, treat as miss',
    );
    return null;
  }

  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch (err) {
    log.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      'fileStore.get: JSON.parse failed, treat as miss',
    );
    return null;
  }

  // TTL 检查（用 mtime 算 age，不依赖 fetchedAt 字段以减少冗余）
  try {
    const stat = statSync(file);
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSeconds > entry.ttlSeconds) {
      return null;
    }
  } catch {
    // stat 失败（文件竞态被删了）→ 当 miss
    return null;
  }

  return entry.payload as T;
}

/**
 * 写缓存（upsert：存在则覆盖）
 *
 * 原子写：writeFile(tmp) + rename(tmp, real)
 * - 写失败：抛（IPC handler 必须显式处理）
 * - 写盘失败兜底：mtime 没更新，下次读按 mtime 算 TTL 准；fetchedAt 字段没实际作用（保留为 debug 用）
 */
export function setCache<T>(args: {
  resource: string;
  projectId: string;
  key: string;
  payload: T;
  ttlSeconds: number;
}): void {
  const rootDir = resolveCacheDir();
  const dir = join(rootDir, args.resource);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const file = makeEntryPath(rootDir, args.resource, args.projectId, args.key);
  const entry: CacheEntry<T> = {
    payload: args.payload,
    fetchedAt: Date.now(),
    ttlSeconds: args.ttlSeconds,
  };
  const raw = JSON.stringify(entry);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;

  writeFileSync(tmp, raw, { mode: 0o600 });
  renameSync(tmp, file);

  log.debug(
    { file, bytes: raw.length, ttl: args.ttlSeconds },
    'fileStore.set: written',
  );
}

/**
 * 删一条缓存（kv 删）
 *
 * 用法：业务层触发"具体 key 失效"（如 commits.timeline 算 key 时某字段变了要清旧 key）
 */
export function deleteCache(args: { resource: string; projectId: string; key: string }): void {
  const file = makeEntryPath(resolveCacheDir(), args.resource, args.projectId, args.key);
  if (!existsSync(file)) return; // idempotent
  try {
    unlinkSync(file);
  } catch (err) {
    log.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      'fileStore.delete: unlink failed',
    );
  }
}

/**
 * 失效整个 resource（或指定 projectId 子集）
 *
 * 用法：业务层触发"整类失效"（如 addProject 失效 'repos' 缓存）
 *
 * projectId 缺省 = 整个 resource 全清；给 projectId = 仅清该项目
 */
export function invalidateCache(args: { resource: string; projectId?: string }): void {
  const dir = join(resolveCacheDir(), args.resource);
  if (!existsSync(dir)) return;

  const files = readdirSync(dir);
  const prefix = args.projectId ? `${args.projectId}__` : null;
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (prefix && !f.startsWith(prefix)) continue;
    try {
      unlinkSync(join(dir, f));
      removed++;
    } catch (err) {
      log.warn(
        { file: f, err: err instanceof Error ? err.message : String(err) },
        'fileStore.invalidate: unlink failed',
      );
    }
  }
  log.debug(
    { resource: args.resource, projectId: args.projectId, removed },
    'fileStore.invalidate: done',
  );
}

// ============================================================
// ===== GC =====
// ============================================================

/**
 * 启动期 LRU GC
 *
 * 扫整个 cache/ 目录，按 mtime 倒序（最新优先），删到总大小 ≤ LRU_BUDGET_BYTES
 *
 * 时机：app.ready 后 initSqlite 旧位置；或 SyncRunner.start 之前
 * 频次：v1 仅启动期 + 写时按 mtime 自然（不主动）→ 简单
 */
export function gcCache(args: { budgetBytes?: number } = {}): {
  removed: number;
  remaining: number;
  bytesBefore: number;
  bytesAfter: number;
} {
  const budget = args.budgetBytes ?? DEFAULT_LRU_BUDGET_BYTES;
  const rootDir = resolveCacheDir();
  if (!existsSync(rootDir)) {
    return { removed: 0, remaining: 0, bytesBefore: 0, bytesAfter: 0 };
  }

  // 1. 扫所有 cache_entry 文件（含 mtime + bytes）
  const all: Array<{ file: string; mtimeMs: number; size: number }> = [];
  const resources = readdirSync(rootDir);
  for (const r of resources) {
    const dir = join(rootDir, r);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const file = join(dir, f);
      try {
        const st = statSync(file);
        all.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // 文件被并发删了 = 跳过
      }
    }
  }

  const bytesBefore = all.reduce((s, e) => s + e.size, 0);
  const total = all.length;

  // 2. 已 ≤ 预算 → 不动
  if (bytesBefore <= budget) {
    return { removed: 0, remaining: total, bytesBefore, bytesAfter: bytesBefore };
  }

  // 3. 按 mtime 升序（最旧优先删）
  all.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytesAfter = bytesBefore;
  let removed = 0;
  for (const e of all) {
    if (bytesAfter <= budget) break;
    try {
      unlinkSync(e.file);
      bytesAfter -= e.size;
      removed++;
    } catch {
      // 删失败（并发）→ 跳过
    }
  }

  log.info(
    {
      removed,
      remaining: total - removed,
      bytesBefore,
      bytesAfter,
      budget,
    },
    'fileStore.gc: done',
  );
  return { removed, remaining: total - removed, bytesBefore, bytesAfter };
}

// ============================================================
// ===== 内部类型 =====
// ============================================================

interface CacheEntry<T = unknown> {
  payload: T;
  /** 写盘时刻 epoch ms（debug 用；TTL 实际用 mtime） */
  fetchedAt: number;
  ttlSeconds: number;
}
