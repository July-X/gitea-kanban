#!/usr/bin/env tsx
/**
 * 跑 drizzle 迁移到指定 db 文件
 *
 * 用法：
 *   pnpm db:migrate              # 跑迁移到 ~/.gitea-kanban/kanban.db（默认）
 *   GITEA_KANBAN_DATA_DIR=path pnpm db:migrate  # 显式数据目录
 *   DB_PATH=/abs/path/to/test.db pnpm db:migrate  # 显式 db 文件（CI/测试用）
 *   pnpm db:migrate --target=path/to/test.db     # 同上，CLI 参数形式
 *
 * 设计：
 * - 默认路径 = GITEA_KANBAN_DATA_DIR 环境变量 或 ~/.gitea-kanban/kanban.db
 * - 幂等：drizzle migrate 跟踪 _journal 表，重复跑无副作用
 */

import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLITE_DB_FILENAME } from '../src/shared/constants.js';

function parseArgs(): { target: string | null } {
  const arg = process.argv.find((a) => a.startsWith('--target='));
  return { target: arg ? arg.slice('--target='.length) : null };
}

function resolveTargetPath(): string {
  // 优先级：--target > DB_PATH > GITEA_KANBAN_DATA_DIR + kanban.db
  const arg = parseArgs().target;
  const dbPathEnv = process.env['DB_PATH'];
  const dataDirEnv = process.env.GITEA_KANBAN_DATA_DIR;

  if (arg) {
    if (!isAbsolute(arg)) throw new Error(`--target must be absolute, got: ${arg}`);
    return arg;
  }
  if (dbPathEnv) {
    if (!isAbsolute(dbPathEnv)) throw new Error(`DB_PATH must be absolute, got: ${dbPathEnv}`);
    return dbPathEnv;
  }
  // 默认：~/.gitea-kanban/kanban.db（跨平台统一）
  const dataDir = dataDirEnv ?? join(os.homedir(), '.gitea-kanban');
  if (!isAbsolute(dataDir)) throw new Error(`GITEA_KANBAN_DATA_DIR must be absolute, got: ${dataDir}`);
  return join(dataDir, SQLITE_DB_FILENAME);
}

async function main(): Promise<void> {
  const target = resolveTargetPath();
  const targetDir = join(target, '..');
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  console.log(`[migrate] target: ${target}`);
  const sqlite = new Database(target);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite);
  const migrationsFolder = join(process.cwd(), 'drizzle');
  if (!existsSync(migrationsFolder)) {
    console.error(`[migrate] drizzle/ 目录不存在: ${migrationsFolder}`);
    console.error('请先 pnpm db:generate 生成迁移 SQL');
    process.exit(1);
  }

  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  migrate(db, { migrationsFolder });
  console.log('[migrate] done');
  sqlite.close();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
