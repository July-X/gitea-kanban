/**
 * better-sqlite3 单例 + Drizzle ORM
 *
 * ADR-0003 Phase 3 后职责：
 * - **仅**承担 Gitea 缓存层（cache-aside 模式）
 * - 业务表（prefs / gitea_accounts / ...）已**全部**迁到 localStore.state.json
 *
 * 路径策略（AGENTS §8.2）：
 * - 环境变量 GITEA_KANBAN_DATA_DIR（绝对路径）→ 优先
 * - 兜底 ~/.gitea-kanban/kanban.db
 * - macOS SIP 限制时 fallback /tmp/gitea-kanban/main/kanban.db
 *
 * 边界：
 * - **不**做业务表 CRUD（业务表已迁 localStore）
 * - **不**接受用户输入的绝对路径（白名单：env 或 ~/.gitea-kanban）
 * - 测试用 _setSqlitePathForTest() 显式指定（**只**给 vitest 用）
 *
 * 后续 Phase 3b 切到文件 JSON 缓存时本文件整体可删（届时 better-sqlite3 也走）。
 */

import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import os from 'node:os';
import Database, { type Database as BetterSqliteDb } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '../logger.js';
import { SQLITE_DB_FILENAME } from '@shared/constants';
import * as schema from './schema/index.js';

let rawDb: BetterSqliteDb | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let testDbPath: string | null = null;

/**
 * 计算 db 路径：
 * 1. 环境变量 GITEA_KANBAN_DATA_DIR（绝对路径）
 * 2. 兜底 ~/.gitea-kanban（跨平台统一，开发/打包都一致）
 *
 * 显式白名单 + isAbsolute 校验：避免任何 caller 注入路径
 */
export function resolveDbPath(): string {
  if (testDbPath !== null) {
    // 测试路径走专门口子（**只**给 _setSqlitePathForTest 写）
    if (!isAbsolute(testDbPath)) {
      throw new Error(`test db path must be absolute, got: ${testDbPath}`);
    }
    return testDbPath;
  }
  // 生产路径：环境变量或 ~/.gitea-kanban
  const dataDir = process.env.GITEA_KANBAN_DATA_DIR
    ?? join(os.homedir(), '.gitea-kanban');
  if (!isAbsolute(dataDir)) {
    throw new Error(`data dir must be absolute, got: ${dataDir}`);
  }
  return join(dataDir, SQLITE_DB_FILENAME);
}

/**
 * 应用启动时调用：开库 + 跑 Gitea 缓存层建表（cacheEntries 唯一）
 *
 * 注意：业务表（9 张）已**全部**迁到 localStore —— 这里只建 cacheEntries
 * 业务表迁移的 drizzle/ 目录已删
 */
export async function initSqlite(): Promise<void> {
  if (rawDb) return; // idempotent

  // 2026-06-12 修复：macOS 用户目录 SIP 限制时先 probe 再 open
  const dbPath = resolveDbPath();
  const dbDir = join(dbPath, '..');

  let probeOk = false;
  try {
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }
    const probePath = join(dbDir, `.probe-${process.pid}`);
    const fd = openSync(probePath, 'a');
    closeSync(fd);
    unlinkSync(probePath);
    probeOk = true;
  } catch (err) {
    logger.warn({ err, dbDir }, 'sqlite dir probe failed, falling back to /tmp/gitea-kanban');
  }

  if (!probeOk) {
    return initSqliteWithFallback();
  }

  try {
    rawDb = new Database(dbPath);
  } catch (err) {
    logger.warn({ err, dbPath }, 'sqlite open failed, trying /tmp fallback');
    rawDb = null;
    return initSqliteWithFallback();
  }
  applyPragmasAndInitSchema();
}

/** EPERM fallback：把 db 放到 /tmp/gitea-kanban */
async function initSqliteWithFallback(): Promise<void> {
  const fallbackRoot = '/tmp/gitea-kanban';
  const fallbackDir = join(fallbackRoot, 'main');
  mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  const fallbackPath = join(fallbackDir, SQLITE_DB_FILENAME);
  logger.info({ fallbackPath }, 'sqlite fallback path in use');
  rawDb = new Database(fallbackPath);
  applyPragmasAndInitSchema();
}

/**
 * 设置 pragmas + 建 Gitea 缓存层 schema
 *
 * 业务表已迁 localStore；这里只建 cacheEntries（Gitea 缓存层）
 * 用 better-sqlite3 raw exec 而非 drizzle migrate（业务 drizzle 迁移已删）
 */
function applyPragmasAndInitSchema(): void {
  if (!rawDb) return;
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  rawDb.pragma('synchronous = NORMAL');

  // cacheEntries 表 DDL（Gitea 缓存层唯一保留的表）
  // 注：用 raw SQL 而非 drizzle 迁移（drizzle-kit 已删，业务表 drizzle schema 已删）
  // schema：payload TEXT + ttl_seconds INTEGER（与 cacheEntries.ts 保持一致）
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      id TEXT PRIMARY KEY,
      repo_project_id TEXT,
      resource TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      ttl_seconds INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_res_key
      ON cache_entries (repo_project_id, resource, key);
    CREATE INDEX IF NOT EXISTS idx_fetched
      ON cache_entries (fetched_at);
  `);

  dbInstance = drizzle(rawDb, { schema });
  logger.info({ dbPath: rawDb.name }, 'sqlite (cache layer) ready');
}

/** 取 drizzle instance（Gitea 缓存层业务代码用） */
export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!dbInstance) {
    throw new Error('sqlite not initialized; call initSqlite() first');
  }
  return dbInstance;
}

/** 关闭（before-quit 用） */
export function closeSqlite(): void {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
    dbInstance = null;
    logger.info('sqlite closed');
  }
}

/** 取 raw better-sqlite3 instance（integrity check 等维护操作） */
export function getRawDb(): BetterSqliteDb {
  if (!rawDb) {
    throw new Error('sqlite not initialized');
  }
  return rawDb;
}

/** 测试用：显式注入 db 路径 */
export function _setSqlitePathForTest(path: string): void {
  if (rawDb) {
    throw new Error('cannot change db path after initSqlite()');
  }
  if (!isAbsolute(path)) {
    throw new Error(`test db path must be absolute, got: ${path}`);
  }
  testDbPath = path;
}

/** 测试用：清单例 + 闭库 */
export async function _resetSqliteForTest(): Promise<void> {
  closeSqlite();
  testDbPath = null;
}

/** 重新导出 schema */
export { schema };
