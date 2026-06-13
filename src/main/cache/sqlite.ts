/**
 * better-sqlite3 单例 + Drizzle ORM
 *
 * 铁律（02-architecture.md §9.3 路径遍历防护）：
 * - DB 路径**永远**来自 app.getPath('userData') 或 GITEA_KANBAN_DATA_DIR 环境变量
 *   —— 不接受任何用户输入的绝对路径
 * - 不存在则建（mkdir 0700）
 * - 测试用 _setSqlitePathForTest() 显式指定（**只**给 vitest 用）
 */

import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import os from 'node:os';
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

/** 应用启动时调用：开库 + 跑迁移 */
export async function initSqlite(): Promise<void> {
  if (rawDb) return; // idempotent

  // 2026-06-12 修复：macOS 用户目录 SIP 限制（~/.gitea-kanban/）时
  // new Database() 不会立即报错，但 journal_mode=WAL 需要建 .wal/.shm 文件
  // → 写 EPERM → 整个 pragma 失败。所以不走"open 才 fallback"逻辑
  // 而是先 probe 写权限再 open

  const dbPath = resolveDbPath();
  const dbDir = join(dbPath, '..');

  // 1. probe 写权限（openSync + closeSync）
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
    // EPERM/EACCES：macOS SIP 限制某些用户目录 → fallback
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
  await applyPragmasAndMigrate();
}

/** EPERM fallback：把 db 放到 /tmp/gitea-kanban（用户显式数据迁过来时改 GITEA_KANBAN_DATA_DIR） */
async function initSqliteWithFallback(): Promise<void> {
  const fallbackRoot = '/tmp/gitea-kanban';
  const fallbackDir = join(fallbackRoot, 'main');
  mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  const fallbackPath = join(fallbackDir, SQLITE_DB_FILENAME);
  logger.info({ fallbackPath }, 'sqlite fallback path in use');
  rawDb = new Database(fallbackPath);
  await applyPragmasAndMigrate();
}

async function applyPragmasAndMigrate(): Promise<void> {
  if (!rawDb) return;
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  rawDb.pragma('synchronous = NORMAL');

  dbInstance = drizzle(rawDb, { schema });

  try {
    migrate(dbInstance, { migrationsFolder: getMigrationsFolder() });
    logger.info({ dbPath: rawDb.name }, 'sqlite migrations applied');
  } catch (err) {
    logger.fatal({ err, dbPath: rawDb.name }, 'sqlite migration failed');
    throw err;
  }

  // Seed local-user row if missing（FK 约束：prefs.user_id → users.id）
  // user.ts / preferences.ts 都用 LOCAL_USER_ID = 'local-user'
  // **M6 拍板保留**：prefs 跟 app user（设备级），不按 gitea account 切分
  // 见 notes/m6-prefs-schema-decision.md（方案 A）
  seedLocalUser();
}

/**
 * 确保 users 表有 local-user 行（FK 约束兜底）
 *
 * 多处 IPC handler（user.prefs.* / preferences.theme.*）用 LOCAL_USER_ID = 'local-user' 写 prefs 表，
 * 但 users 表 FK 引用 users.id —— 如果 users 表空（迁移只建表不 seed），
 * prefs INSERT 会抛 SQLITE_CONSTRAINT_FOREIGNKEY → DATABASE_WRITE_FAILED。
 *
 * **M6 拍板保留**：prefs 跟 app user 走（设备级），**不**按 gitea account 切分
 * 拍板记录：notes/m6-prefs-schema-decision.md（方案 A）
 *
 * 调用时机：applyPragmasAndMigrate 之后（migration 跑完、schema 建好）
 */
function seedLocalUser(): void {
  if (!rawDb) return;
  const existing = rawDb
    .prepare('SELECT id FROM users WHERE id = ?')
    .get('local-user');
  if (existing) return;

  rawDb
    .prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
    .run('local-user', 'Local User', Math.floor(Date.now() / 1000));
  logger.info('seeded local-user row in users table');
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
