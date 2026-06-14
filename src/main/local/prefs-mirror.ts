/**
 * localPrefs —— prefs 的 localStore 入口
 * (touch v4)
 *
 * ADR-0003 Phase 3 状态：
 * - **写**：setPrefsWithMirror 单写 localStore（删 Phase 1 双写）
 * - **读**：getPrefs 走 localStore（Phase 2 切，Phase 3 保留）
 * - **初始化**：bootstrapPrefsFromSqlite 启动期从 SQLite SELECT 灌进 localStore
 *   （Phase 5 删 SQLite 后这个函数整体删）
 *
 * 边界：
 * - **不**改 IPC 端点签名（`user.prefs.get/set`）
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
 * - Phase 3 后：每次启动做一次 reconcile（localStore 跟 SQLite 对齐，给 verify-state-consistency 兜底）
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
 * 写 prefs（**单写 localStore**，ADR-0003 Phase 3）
 *
 * 调用方（src/main/ipc/user.ts setPrefs）传 entries
 * 行为：**只**写 localStore。Phase 3 后 localStore 是唯一 source of truth。
 *
 * 历史：
 * - Phase 1：双写（SQLite source of truth + localStore best-effort 镜像）
 * - Phase 2：读切 localStore，写仍双写（SQLite 兜底）
 * - Phase 3：去双写（删 SQLite 写分支；Phase 5 删 SQLite 整体后，函数保留）
 *
 * 离线语义：
 * - prefs 是**纯本地** op——不调 gitea，dispatch 自动识别（offlineApply 缺省 = execute）
 * - 见 src/main/sync/queue.ts dispatch()
 */
export async function setPrefsWithMirror(entries: Record<string, unknown>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const store = getLocalStore();
  store.mutate((s) => {
    s.prefs = { ...s.prefs, ...entries };
  });
  logger.debug({ keys: Object.keys(entries) }, 'setPrefs: written to localStore');
}

/**
 * 读 prefs（**Phase 2 切 localStore**，Phase 3 保留）
 *
 * 这里暴露一个查询函数，供 verify-state-consistency 脚本对比
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
