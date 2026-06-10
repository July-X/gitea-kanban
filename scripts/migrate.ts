#!/usr/bin/env tsx
/**
 * 跑 drizzle 迁移到 userData/kanban.db
 *
 * 用法：
 *   pnpm db:migrate              # 跑迁移（用默认 userData 路径）
 *   pnpm db:migrate --target=path/to/test.db  # 显式目标（**只**给单测/CI 用）
 *
 * 设计：
 * - 路径来自 app.getPath('userData')（电子运行时）
 * - 测试用脚本不依赖 electron；用 DB_PATH 环境变量或 --target 参数
 * - 幂等：drizzle migrate 跟踪 _journal 表，重复跑无副作用
 */

import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLITE_DB_FILENAME } from '../src/shared/constants.js';

function parseArgs(): { target: string | null } {
  const arg = process.argv.find((a) => a.startsWith('--target='));
  return { target: arg ? arg.slice('--target='.length) : null };
}

function resolveTargetPath(): string {
  const env = process.env['DB_PATH'];
  const arg = parseArgs().target;
  const target = env || arg;
  if (target) {
    if (!isAbsolute(target)) {
      throw new Error(`DB_PATH / --target must be absolute, got: ${target}`);
    }
    return target;
  }
  // 默认：../kanban.db（相对 cwd 落仓库根；开发期方便）
  return join(process.cwd(), SQLITE_DB_FILENAME);
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
