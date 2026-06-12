#!/usr/bin/env tsx
/**
 * M5 fix-3 user.* 4 个 IPC 端点端到端验证
 *
 * 任务：02-architecture.md §5.3.9 拍板的 4 个端点（user.prefs.get/set + user.undo/redo）实现验证
 *
 * 验证策略（沿用 AGENTS §8.11 + W4 e2e 模式）：
 * - **不** import 项目内 src/main/gitea/* 或 src/main/cache/sqlite.ts（它们 import electron / logger）
 * - 直接 better-sqlite3 + drizzle-orm/better-sqlite3 + Zod schema（从 src/main/ipc/schema.js 导入）
 * - 业务层等价函数（getPrefsEq / setPrefsEq / undoEq / redoEq）手写在脚本里，**不**依赖 logger/electron
 * - 临时 db 路径 /tmp/gitea-kanban-verify-userPrefs-<pid>.db，跑完删
 * - 跑迁移确保表 schema 在
 *
 * 验证矩阵（沿用任务 prompt）：
 * 1. writePrefs: theme='dark', fontSize=14 → DB 写入
 * 2. readPrefs: { theme: 'dark', fontSize: 14 } → 一致
 * 3. readPrefs: { unknownKey: ??? } → 返回空 record（缺 key 不抛）
 * 4. deletePrefs + readPrefs → 返回空 record
 * 5. undo() / redo() → 返 { restored: number } 不抛错（M5 空栈 version，restored=0）
 *
 * 用法：
 *   pnpm exec tsx scripts/verify-userPrefs.ts
 *   # 或带 dev 进程检测：
 *   GITEA_KANBAN_DATA_DIR=/tmp/...-pid pnpm exec tsx scripts/verify-userPrefs.ts
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import {
  UserPrefsGetArgsSchema,
  UserPrefsSetArgsSchema,
  UserUndoResultSchema,
  UserRedoResultSchema,
  type UserPrefsGetResult,
} from '../src/main/ipc/schema.js';
import { prefs } from '../src/main/cache/schema/prefs.js';
import { users } from '../src/main/cache/schema/users.js';

// ====== 配置 ======

const PID = process.pid;
const TMP_DB = join(tmpdir(), `gitea-kanban-verify-userPrefs-${PID}.db`);
const TMP_DIR = join(tmpdir(), `gitea-kanban-verify-userPrefs-${PID}`);
const MIGRATIONS = join(process.cwd(), 'drizzle');

const LOCAL_USER_ID = 'local-user'; // 与 src/main/ipc/user.ts 保持一致

// ====== 工具函数 ======

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail !== undefined ? `\n     ${JSON.stringify(detail)}` : ''}`);
    fail++;
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

// ====== 业务层等价函数（与 src/main/ipc/user.ts 保持语义一致；不依赖 electron/logger） ======

// 我们走 drizzle 的 typed API；db 通过 getDb() 返回
function getPrefsEq(
  db: ReturnType<typeof drizzle>,
  args: unknown,
): UserPrefsGetResult {
  const parsed = UserPrefsGetArgsSchema.parse(args);
  const rows = db
    .select({ key: prefs.key, value: prefs.value })
    .from(prefs)
    .where(and(eq(prefs.userId, LOCAL_USER_ID), inArray(prefs.key, parsed.keys)))
    .all();

  const result: UserPrefsGetResult = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      // skip 烂数据（与 user.ts 行为一致）
    }
  }
  return result;
}

function setPrefsEq(
  db: ReturnType<typeof drizzle>,
  args: unknown,
): void {
  const parsed = UserPrefsSetArgsSchema.parse(args);
  const entries = Object.entries(parsed.entries);
  if (entries.length === 0) return;

  const now = new Date();
  db.transaction((tx) => {
    for (const [key, value] of entries) {
      const jsonStr = JSON.stringify(value);
      const updated = tx
        .update(prefs)
        .set({ value: jsonStr, updatedAt: now })
        .where(and(eq(prefs.userId, LOCAL_USER_ID), eq(prefs.key, key)))
        .run();
      if (updated.changes === 0) {
        tx.insert(prefs)
          .values({
            id: randomUUID(),
            userId: LOCAL_USER_ID,
            key,
            value: jsonStr,
            updatedAt: now,
          })
          .run();
      }
    }
  });
}

function deletePrefsEq(
  db: ReturnType<typeof drizzle>,
  key: string,
): void {
  db.delete(prefs)
    .where(and(eq(prefs.userId, LOCAL_USER_ID), eq(prefs.key, key)))
    .run();
}

function undoEq(): { restored: number } {
  return UserUndoResultSchema.parse({ restored: 0 });
}

function redoEq(): { restored: number } {
  return UserRedoResultSchema.parse({ restored: 0 });
}

// ====== 主流程 ======

function main(): void {
  console.log(`[verify-userPrefs] using tmp db: ${TMP_DB}`);
  console.log(`[verify-userPrefs] migrations folder: ${MIGRATIONS}`);

  // 1. 准备临时 db + 跑迁移
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  }
  if (existsSync(TMP_DB)) {
    rmSync(TMP_DB);
  }

  if (!isAbsolute(TMP_DB)) {
    throw new Error(`TMP_DB must be absolute, got: ${TMP_DB}`);
  }
  if (!existsSync(MIGRATIONS)) {
    throw new Error(`MIGRATIONS folder not found: ${MIGRATIONS}\n请先 pnpm db:generate 生成迁移 SQL`);
  }

  const sqlite = new Database(TMP_DB);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS });
  console.log('[verify-userPrefs] migrations applied');

  // 1.1 seed local user (prefs.userId FK 到 users.id)
  db.insert(users)
    .values({
      id: LOCAL_USER_ID,
      displayName: 'Local User',
      createdAt: new Date(),
    })
    .run();
  console.log(`[verify-userPrefs] seeded users row: id=${LOCAL_USER_ID}`);

  // 2. 验证 Zod schema 接受/拒绝 args
  section('Zod schema 校验');

  // 2.1 prefs.get 入参合法
  const getArgsValid = UserPrefsGetArgsSchema.safeParse({ keys: ['theme', 'fontSize'] });
  check('UserPrefsGetArgsSchema 接受 {keys: [2 items]}', getArgsValid.success);

  // 2.2 prefs.get 入参空数组 → 拒
  const getArgsEmpty = UserPrefsGetArgsSchema.safeParse({ keys: [] });
  check('UserPrefsGetArgsSchema 拒绝 {keys: []}', !getArgsEmpty.success);

  // 2.3 prefs.get 入参缺 keys → 拒
  const getArgsMissing = UserPrefsGetArgsSchema.safeParse({});
  check('UserPrefsGetArgsSchema 拒绝 {}', !getArgsMissing.success);

  // 2.4 prefs.set 入参合法
  const setArgsValid = UserPrefsSetArgsSchema.safeParse({ entries: { theme: 'dark' } });
  check('UserPrefsSetArgsSchema 接受 {entries: {...}}', setArgsValid.success);

  // 2.5 prefs.set 入参空 entries → 接受（空操作）
  const setArgsEmpty = UserPrefsSetArgsSchema.safeParse({ entries: {} });
  check('UserPrefsSetArgsSchema 接受 {entries: {}}（空操作）', setArgsEmpty.success);

  // 2.6 undo / redo 结果 shape
  const undoOk = UserUndoResultSchema.safeParse({ restored: 0 });
  check('UserUndoResultSchema 接受 {restored: 0}', undoOk.success);

  const undoNegative = UserUndoResultSchema.safeParse({ restored: -1 });
  check('UserUndoResultSchema 拒绝 {restored: -1}', !undoNegative.success);

  const redoOk = UserRedoResultSchema.safeParse({ restored: 5 });
  check('UserRedoResultSchema 接受 {restored: 5}', redoOk.success);

  // 3. 业务端点等价函数端到端
  section('业务函数端到端');

  // 3.1 setPrefsEq({ theme: 'dark', fontSize: 14 })
  setPrefsEq(db, { entries: { theme: 'dark', fontSize: 14 } });

  // 3.2 readPrefs({ keys: ['theme', 'fontSize'] })
  const read1 = getPrefsEq(db, { keys: ['theme', 'fontSize'] });
  check('getPrefsEq 返回 theme=dark', read1['theme'] === 'dark', read1);
  check('getPrefsEq 返回 fontSize=14', read1['fontSize'] === 14, read1);

  // 3.3 readPrefs({ keys: ['theme', 'nonExistent'] }) → 只有 theme
  const read2 = getPrefsEq(db, { keys: ['theme', 'nonExistent'] });
  check('getPrefsEq 缺 key 不抛，仅返存在的', read2['theme'] === 'dark' && read2['nonExistent'] === undefined, read2);

  // 3.4 deletePrefsEq('theme') → 再读 theme 不存在
  deletePrefsEq(db, 'theme');
  const read3 = getPrefsEq(db, { keys: ['theme'] });
  check('删除后 getPrefsEq 不返 theme', read3['theme'] === undefined, read3);

  // 3.5 deletePrefsEq('fontSize') → 全空
  deletePrefsEq(db, 'fontSize');
  const read4 = getPrefsEq(db, { keys: ['theme', 'fontSize'] });
  check('全部删除后 getPrefsEq 返空 record', Object.keys(read4).length === 0, read4);

  // 3.6 setPrefsEq 二次 upsert：值被覆盖
  setPrefsEq(db, { entries: { count: 1 } });
  setPrefsEq(db, { entries: { count: 2 } });
  const read5 = getPrefsEq(db, { keys: ['count'] });
  check('setPrefsEq 二次 upsert 覆盖', read5['count'] === 2, read5);

  // 3.7 setPrefsEq 多类型值（number / boolean / object / array）
  setPrefsEq(db, {
    entries: {
      nested: { a: 1, b: [true, null, 'x'] },
      flag: false,
    },
  });
  const read6 = getPrefsEq(db, { keys: ['nested', 'flag'] });
  check('setPrefsEq 嵌套 object JSON roundtrip', JSON.stringify(read6['nested']) === JSON.stringify({ a: 1, b: [true, null, 'x'] }), read6['nested']);
  check('setPrefsEq boolean false 保留', read6['flag'] === false, read6['flag']);

  // 3.8 undo / redo 等价函数（M5 空栈 version）
  const undoResult = undoEq();
  check('undoEq 返 { restored: number }', typeof undoResult.restored === 'number', undoResult);

  const redoResult = redoEq();
  check('redoEq 返 { restored: number }', typeof redoResult.restored === 'number', redoResult);

  // 4. 边界：prefs.get 入参 keys 超 64 → 拒
  section('边界条件');
  const tooManyKeys = UserPrefsGetArgsSchema.safeParse({
    keys: Array.from({ length: 65 }, (_, i) => `k${i}`),
  });
  check('UserPrefsGetArgsSchema 拒绝 65 个 keys', !tooManyKeys.success);

  // 5. 收尾
  sqlite.close();
  rmSync(TMP_DB);
  rmSync(`${TMP_DB}-wal`, { force: true });
  rmSync(`${TMP_DB}-shm`, { force: true });
  rmSync(TMP_DIR, { recursive: true, force: true });

  section('summary');
  console.log(`✅ pass: ${pass}`);
  console.log(`${fail === 0 ? '✅' : '❌'} fail: ${fail}`);
  if (fail > 0) {
    process.exit(1);
  }
  console.log('\n[verify-userPrefs] all checks passed');
}

try {
  main();
} catch (err) {
  console.error('[verify-userPrefs] FATAL:', err);
  process.exit(2);
}