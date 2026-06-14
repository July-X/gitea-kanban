/**
 * localPrefs —— prefs 表的 localStore 镜像
 * (touch v4)
 *
 * Phase 1 双写策略（ADR-0003）：
 * - **写**：调 setPrefs() → Promise.allSettled([写 SQLite, 写 localStore])
 *   任一失败 log，但**不**抛错（Phase 1 验证期允许 localStore 失败）
 * - **读**：仍走 SQLite（Phase 1 不切读路径）
 * - **初始化**：initPrefsMirror() 启动期从 SQLite SELECT 一次全量 → 灌进 localStore
 *
 * Phase 2 切读路径：getPrefs() 优先读 localStore（**不** fallback SQLite）
 * Phase 3 删 SQLite：删 setPrefs 中的 SQLite 分支
 *
 * 边界：
 * - **不**改 IPC 端点签名（`user.prefs.get/set`）
 * - **不**改 prefs 表 schema
 * - **不**碰 token / keychain
 */

import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { prefs } from '../cache/schema/index.js';
import { getLocalStore } from './state.js';
import { logger } from '../logger.js';

const LOCAL_USER_ID = 'local-user';

/**
 * 启动期：把 SQLite 的 prefs 同步到 localStore
 *
 * 策略：全量 SELECT → 一次性 mutate 写进 localStore
 *
 * 用途：
 * - 首次部署：localStore 是空的，从 SQLite 灌入
 * - Phase 2 切读路径后：每次启动做一次 reconcile（localStore 跟 SQLite 对齐）
 *
 * **幂等**：重复调安全（mutate 是覆盖写）
 */
export async function bootstrapPrefsFromSqlite(): Promise<void> {
  const store = getLocalStore();
  const db = getDb();
  const rows = db
    .select({ key: prefs.key, value: prefs.value })
    .from(prefs)
    .where(eq(prefs.userId, LOCAL_USER_ID))
    .all();

  if (rows.length === 0) {
    logger.info('prefs mirror: sqlite has no prefs rows, nothing to bootstrap');
    return;
  }

  const seed: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      seed[r.key] = JSON.parse(r.value);
    } catch (err) {
      logger.warn(
        { key: r.key, err: err instanceof Error ? err.message : String(err) },
        'prefs mirror: skip row with invalid JSON',
      );
    }
  }

  store.mutate((s) => {
    s.prefs = { ...s.prefs, ...seed };
  });
  await store.flushNow();
  logger.info({ count: rows.length }, 'prefs mirror: bootstrapped from sqlite');
}

/**
 * 双写 prefs
 *
 * 调用方（src/main/ipc/user.ts setPrefs）传 entries
 * 行为：同步写 SQLite（source of truth） + 异步写 localStore（best-effort 镜像）
 */
export async function setPrefsWithMirror(entries: Record<string, unknown>): Promise<void> {
  // 1. 写 SQLite（source of truth）—— 走原逻辑
  writeSqlitePrefs(entries);

  // 2. 写 localStore（best-effort）—— 失败 log 不抛
  try {
    const store = getLocalStore();
    store.mutate((s) => {
      s.prefs = { ...s.prefs, ...entries };
    });
    logger.debug({ keys: Object.keys(entries) }, 'prefs mirror: written to localStore');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), keys: Object.keys(entries) },
      'prefs mirror: localStore write failed; sqlite is still authoritative',
    );
  }
}

/**
 * 内部：原 SQLite 写 prefs 逻辑（从 src/main/ipc/user.ts setPrefs 拆出来）
 *
 * 抽到这个文件是为了让双写策略集中维护；调用方改 import
 */
function writeSqlitePrefs(entries: Record<string, unknown>): void {
  if (Object.keys(entries).length === 0) return;
  const db = getDb();
  const now = new Date();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(entries)) {
      const jsonStr = JSON.stringify(value);
      const updated = tx
        .update(prefs)
        .set({ value: jsonStr, updatedAt: now })
        .where(and(eq(prefs.userId, LOCAL_USER_ID), eq(prefs.key, key)))
        .run();
      if (updated.changes === 0) {
        // 没行 → 插入；这里需要 id + key（schema 要求 text PRIMARY KEY）
        // 但原 user.ts setPrefs 用 randomUUID；这里复用同模式
        const id = `prefs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        tx.insert(prefs)
          .values({ id, userId: LOCAL_USER_ID, key, value: jsonStr, updatedAt: now })
          .run();
      }
    }
  });
}

/**
 * 读 prefs（**Phase 1 仍走 SQLite**，Phase 2 切 localStore）
 *
 * 这里暴露一个查询函数，供 verify-state-consistency 脚本使用
 */
export function readSqlitePrefs(keys: string[]): Record<string, unknown> {
  if (keys.length === 0) return {};
  const db = getDb();
  const rows = db
    .select({ key: prefs.key, value: prefs.value })
    .from(prefs)
    .where(and(eq(prefs.userId, LOCAL_USER_ID), inArray(prefs.key, keys)))
    .all();
  const result: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      result[r.key] = JSON.parse(r.value);
    } catch {
      // 烂数据：跳过
    }
  }
  return result;
}

/**
 * 读 localStore 的 prefs
 *
 * 供 verify-state-consistency 脚本对比
 */
export function readLocalStorePrefs(keys: string[]): Record<string, unknown> {
  const store = getLocalStore().get();
  if (keys.length === 0) return {};
  const result: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in store.prefs) {
      result[k] = store.prefs[k];
    }
  }
  return result;
}
