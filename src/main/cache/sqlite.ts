/**
 * better-sqlite3 单例 + Drizzle ORM
 *
 * 铁律（02-architecture.md §9.3 路径遍历防护）：
 * - DB 路径**永远**来自 app.getPath('userData') —— 不接受任何用户输入的绝对路径
 * - 不存在则建（mkdir 0700）
 * - 测试用 _setSqlitePathForTest() 显式指定（**只**给 vitest 用）
 */

import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import Database, { type Database as BetterSqliteDb } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { logger } from '../logger.js';
import { SQLITE_DB_FILENAME } from '@shared/constants';
import * as schema from './schema/index.js';

let rawDb: BetterSqliteDb | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let testDbPath: string | null = null;

/**
 * 计算 db 路径：app.getPath('userData')/kanban.db
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
  // 生产路径：app.getPath('userData')
  const userDataDir = app.getPath('userData');
  if (!isAbsolute(userDataDir)) {
    throw new Error(`app.getPath('userData') must be absolute, got: ${userDataDir}`);
  }
  return join(userDataDir, SQLITE_DB_FILENAME);
}

/** 应用启动时调用：开库 + 跑迁移 */
export async function initSqlite(): Promise<void> {
  if (rawDb) return; // idempotent

  const dbPath = resolveDbPath();
  const dbDir = join(dbPath, '..');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  }

  rawDb = new Database(dbPath);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  rawDb.pragma('synchronous = NORMAL');

  dbInstance = drizzle(rawDb, { schema });

  // 跑迁移（drizzle-kit 产物在 drizzle/）
  // 路径相对 process.cwd()；drizzle-kit generate 输出到 drizzle/
  try {
    migrate(dbInstance, { migrationsFolder: getMigrationsFolder() });
    logger.info({ dbPath }, 'sqlite migrations applied');
  } catch (err) {
    logger.fatal({ err, dbPath }, 'sqlite migration failed');
    throw err;
  }
}

function getMigrationsFolder(): string {
  // 开发：cwd = 项目根
  // 生产：asar 内；electron-vite 把 drizzle/ 复制到 out/...，需要 locate
  // 简化：cwd/drizzle（M0 测试覆盖；生产 asar 路径后续 Plan 14 调）
  return join(process.cwd(), 'drizzle');
}

/** 取 drizzle instance（业务代码用） */
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

/** 取 raw better-sqlite3 instance（迁移 / integrity check 用） */
export function getRawDb(): BetterSqliteDb {
  if (!rawDb) {
    throw new Error('sqlite not initialized');
  }
  return rawDb;
}

/** 测试用：显式注入 db 路径（必须是绝对路径，且仅在 initSqlite 前调） */
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

/** 重新导出 schema，方便业务层 import */
export { schema };
