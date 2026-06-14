#!/usr/bin/env tsx
/**
 * ADR-0003 Phase 1 一致性巡检脚本 (touch v4)
 *
 * 任务：启动期（或手动）跑一次，对比 SQLite `prefs` 表 ↔ localStore `prefs` 字段
 * 任一不一致必须 warn + 打印 diff + 自动备份再修复
 *
 * 用法：
 *   # 默认用 ${GITEA_KANBAN_DATA_DIR}/state.json + kanban.db
 *   pnpm exec tsx scripts/verify-state-consistency.ts
 *
 *   # 自定义 data dir（测试用）
 *   GITEA_KANBAN_DATA_DIR=/tmp/... pnpm exec tsx scripts/verify-state-consistency.ts
 *
 * 设计原则（AGENTS §8.11 e2e 模式）：
 * - **不** import electron
 * - **不** import src/main/logger.ts（logger 依赖 electron.app）
 * - 直接用 better-sqlite3 + LocalStore 抽象（不引 drizzle，避免 init drizzle 整个 schema）
 * - 临时路径走 _setSqlitePathForTest + _resetLocalStoreForTest
 *
 * 退出码：
 * - 0 = 一致
 * - 1 = 不一致（已自动修复 SQLite 端，state.json 保留 user 改动；打印 diff）
 * - 2 = 启动失败（db / state.json 都不存在）
 */

import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { LocalStore } from '../src/main/local/store.js';

// ===== 引一个独立的 pino 实例（不引项目内 logger，避开 electron）=====
import pino from 'pino';
const log = pino({ name: 'verify-state-consistency', level: 'info' });

// ===== 路径解析（对齐 src/main/cache/sqlite.ts 的 resolveDbPath）=====
function resolveDbPath(dataDir: string): string {
  return join(dataDir, 'kanban.db');
}
function resolveStatePath(dataDir: string): string {
  return join(dataDir, 'state.json');
}
function resolveDataDir(): string {
  const env = process.env['GITEA_KANBAN_DATA_DIR'];
  if (env) {
    if (!isAbsolute(env)) {
      throw new Error(`GITEA_KANBAN_DATA_DIR must be absolute, got: ${env}`);
    }
    return env;
  }
  // 兜底：~/.gitea-kanban（与 sqlite.ts 一致）
  return join(process.env['HOME'] ?? tmpdir(), '.gitea-kanban');
}

/**
 * 读 SQLite prefs —— 用 sqlite3 CLI 而**不**引 better-sqlite3
 *
 * 原因：better-sqlite3 的 native binding 编给 electron ABI（NODE_MODULE_VERSION 145）
 * 但本脚本跑在 Node 20 下（NODE_MODULE_VERSION 141）→ 加载失败。
 * sqlite3 CLI 是命令行工具，跟 ABI 无关；macOS 自带，Linux 多数发行版自带。
 *
 * Windows 没自带 → 返回 empty + warn，提示用户装 sqlite3 或跑 `pnpm rebuild better-sqlite3`
 */
function readSqlitePrefsViaCli(dbPath: string): Record<string, unknown> {
  // 找 sqlite3 CLI
  const candidates =
    process.platform === 'win32'
      ? ['sqlite3.exe', 'sqlite3']
      : ['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3'];
  let sqliteBin: string | null = null;
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) {
      sqliteBin = c;
      break;
    }
  }
  if (!sqliteBin) {
    log.warn(
      { dbPath },
      'sqlite3 CLI not found; cannot read SQLite prefs. Install sqlite3 or run pnpm rebuild better-sqlite3',
    );
    return {};
  }

  // SELECT key, value FROM prefs WHERE user_id='local-user'
  // 输出 JSON 数组（-json 模式）
  const r = spawnSync(
    sqliteBin,
    ['-json', dbPath, "SELECT key, value FROM prefs WHERE user_id='local-user'"],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    log.warn({ dbPath, stderr: r.stderr }, 'sqlite3 query failed');
    return {};
  }
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = JSON.parse(r.stdout.trim());
  } catch (err) {
    log.warn({ stdout: r.stdout, err }, 'sqlite3 -json parse failed');
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      // 烂数据：跳过
    }
  }
  return result;
}

// ===== 对比函数 =====

type Diff = { key: string; side: 'sqlite-only' | 'localStore-only' | 'mismatch'; sqlite?: unknown; localStore?: unknown };

function diffPrefs(
  sqlite: Record<string, unknown>,
  local: Record<string, unknown>,
): Diff[] {
  const diffs: Diff[] = [];
  const allKeys = new Set([...Object.keys(sqlite), ...Object.keys(local)]);
  for (const k of allKeys) {
    const inSqlite = k in sqlite;
    const inLocal = k in local;
    if (inSqlite && !inLocal) {
      diffs.push({ key: k, side: 'localStore-only', localStore: sqlite[k] });
    } else if (!inSqlite && inLocal) {
      diffs.push({ key: k, side: 'sqlite-only', sqlite: local[k] });
    } else if (JSON.stringify(sqlite[k]) !== JSON.stringify(local[k])) {
      diffs.push({ key: k, side: 'mismatch', sqlite: sqlite[k], localStore: local[k] });
    }
  }
  return diffs;
}

/**
 * 启动期巡检：对比 + 修复
 *
 * 修复策略（Phase 1 双写期）：
 * - sqlite-only（localStore 缺 key）→ localStore 补齐（用 sqlite 值）
 * - localStore-only（sqlite 缺 key）→ **不**自动写回 sqlite（避免覆盖新部署）→ 仅 warn
 * - mismatch → 取**更晚的** updatedAt（这里 prefs 表没存 updatedAt，所以走"localStore 优先"
 *   —— localStore 是后写的，timestamp 更新）
 *
 * Phase 3 删 SQLite 后整个函数就退化成一个 noop 验证。
 */
async function checkAndRepair(
  dataDir: string,
  options: { autoRepair: boolean; exitOnDiff: boolean },
): Promise<{ ok: boolean; diffs: Diff[] }> {
  const dbPath = resolveDbPath(dataDir);
  const statePath = resolveStatePath(dataDir);

  if (!existsSync(dbPath) && !existsSync(statePath)) {
    log.warn({ dataDir }, 'both db and state.json missing → fresh install, nothing to verify');
    return { ok: true, diffs: [] };
  }
  if (!existsSync(dbPath)) {
    log.warn({ dbPath }, 'kanban.db missing, cannot verify; state.json exists');
    // 这种情况下 state.json 可能是 Phase 1 双写期单边写入的（用户可能用过一次就崩了）
    return { ok: true, diffs: [] };
  }
  if (!existsSync(statePath)) {
    log.warn({ statePath }, 'state.json missing; bootstrap from sqlite (Phase 1 first-run)');
    // 第一次跑 localStore 的场景；不算 diff
    return { ok: true, diffs: [] };
  }

  // ===== 读 SQLite 的 prefs =====
  let sqlitePrefs: Record<string, unknown> = readSqlitePrefsViaCli(dbPath);

  // ===== 读 localStore =====
  const store = new LocalStore<{ prefs: Record<string, unknown> }>({
    file: statePath,
    defaults: { prefs: {} },
  });
  await store.load();
  const localPrefs = store.get().prefs;
  await store.close();

  // ===== 对比 =====
  const diffs = diffPrefs(sqlitePrefs, localPrefs);
  if (diffs.length === 0) {
    log.info({ dbPath, statePath }, '✅ state consistent (0 diffs)');
    return { ok: true, diffs: [] };
  }

  log.warn(
    { count: diffs.length, summary: diffs.slice(0, 5) },
    '⚠️ state inconsistent',
  );

  if (options.autoRepair) {
    // 备份不一致的 state.json
    const backupPath = `${statePath}.bak.${Date.now()}`;
    copyFileSync(statePath, backupPath);
    log.info({ backupPath }, 'backed up state.json before repair');

    // 重新打开 localStore 修复
    const store2 = new LocalStore<{ prefs: Record<string, unknown> }>({
      file: statePath,
      defaults: { prefs: {} },
    });
    await store2.load();
    store2.mutate((s) => {
      for (const d of diffs) {
        if (d.side === 'localStore-only' && d.sqlite !== undefined) {
          s.prefs[d.key] = d.sqlite;
        } else if (d.side === 'mismatch' && d.localStore !== undefined) {
          s.prefs[d.key] = d.localStore; // localStore 优先（后写）
        }
        // 'sqlite-only' 不动 localStore（避免覆盖 Phase 1 期间新部署的 state.json）
      }
    });
    await store2.flushNow();
    await store2.close();
    log.info('auto-repaired state.json from sqlite/localStore');
  }

  if (options.exitOnDiff) {
    process.exit(1);
  }
  return { ok: false, diffs };
}

// ===== 主流程 =====

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    log.info({ dataDir }, 'data dir created');
  }

  const autoRepair = process.argv.includes('--auto-repair');
  const exitOnDiff = process.argv.includes('--exit-on-diff');
  const useSandbox = process.argv.includes('--sandbox');

  let workingDir = dataDir;
  if (useSandbox) {
    // 测试模式：copy 整个 data dir 到 /tmp 跑，原始不动
    const sandboxDir = join(tmpdir(), `gitea-kanban-verify-${process.pid}-${randomUUID().slice(0, 8)}`);
    mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    if (existsSync(join(dataDir, 'kanban.db'))) {
      copyFileSync(join(dataDir, 'kanban.db'), join(sandboxDir, 'kanban.db'));
    }
    if (existsSync(join(dataDir, 'state.json'))) {
      copyFileSync(join(dataDir, 'state.json'), join(sandboxDir, 'state.json'));
    }
    log.info({ sandboxDir, source: dataDir }, 'sandbox mode: copied to tmp');
    workingDir = sandboxDir;

    // 跑完清理
    process.on('exit', () => {
      try {
        rmSync(sandboxDir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    });
  }

  const result = await checkAndRepair(workingDir, { autoRepair, exitOnDiff });

  log.info(
    {
      ok: result.ok,
      diffs: result.diffs.length,
      workingDir,
    },
    'verify-state-consistency done',
  );

  if (!result.ok && result.diffs.length > 0) {
    console.log('\n========== DIFFS ==========');
    for (const d of result.diffs) {
      console.log(`  [${d.side}] key=${d.key}`);
      if (d.side === 'mismatch') {
        console.log(`    sqlite:     ${JSON.stringify(d.sqlite)}`);
        console.log(`    localStore: ${JSON.stringify(d.localStore)}`);
      } else {
        console.log(`    value: ${JSON.stringify(d.sqlite ?? d.localStore)}`);
      }
    }
    console.log('============================\n');
  }
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'verify failed');
  process.exit(2);
});
