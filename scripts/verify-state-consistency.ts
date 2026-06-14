#!/usr/bin/env tsx
/**
 * ADR-0003 Phase 2 一致性巡检脚本（touch v4）
 *
 * 任务：启动期（或手动）跑一次，对比 SQLite 6 张业务表 ↔ localStore 顶层字段
 * 任一不一致必须 warn + 打印 diff + 自动备份再修复
 *
 * 覆盖表（Phase 2 范围）：
 * - prefs (key-value)
 * - gitea_accounts + gitea_user → accounts[]（denormalize）
 * - users (仅 1 条 seed)
 * - repo_projects → projects[]
 * - board_columns → columns[]（SQLite repoProjectId → localStore projectId）
 * - column_label_mapping → labelMaps[]
 * - starred_branches → starredBranches[]
 *
 * 砍掉不查的（Phase 2 drop 的 4 张死表）：
 * - cardIssueLink / giteaRefs / undoEntries / hookDeliveries
 *
 * 砍掉不查的（gitea 缓存层仍用 cache_entries，本期不切）：
 * - cache_entries（gitea 列表缓存）
 *
 * 用法：
 *   # 默认用 ${GITEA_KANBAN_DATA_DIR}/state.json + kanban.db
 *   pnpm exec tsx scripts/verify-state-consistency.ts
 *
 *   # 自定义 data dir（测试用）
 *   GITEA_KANBAN_DATA_DIR=/tmp/... pnpm exec tsx scripts/verify-state-consistency.ts
 *
 *   # 自动修复（备份 → 用 sqlite/localStore 优势方向覆盖 → 写回 state.json）
 *   pnpm exec tsx scripts/verify-state-consistency.ts --auto-repair
 *
 *   # sandbox：copy 整个 data dir 到 /tmp 跑，原始不动（测试用）
 *   pnpm exec tsx scripts/verify-state-consistency.ts --sandbox
 *
 *   # 不一致时 exit 1（CI 用）
 *   pnpm exec tsx scripts/verify-state-consistency.ts --exit-on-diff
 *
 * 设计原则（AGENTS §8.11 e2e 模式）：
 * - **不** import electron
 * - **不** import src/main/logger.ts（logger 依赖 electron.app）
 * - 读 SQLite 走 sqlite3 CLI（避免 better-sqlite3 ABI 问题）
 * - 读 localStore 走 LocalStore 抽象（pino 直连 stderr，**不**引项目内 logger）
 *
 * 退出码：
 * - 0 = 一致
 * - 1 = 不一致（--exit-on-diff 时）
 * - 2 = 启动失败
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
  return join(process.env['HOME'] ?? tmpdir(), '.gitea-kanban');
}

// ===== sqlite3 CLI helper =====

function findSqliteBin(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['sqlite3.exe', 'sqlite3']
      : ['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return null;
}

function sqliteQuery(dbPath: string, sql: string): unknown[] {
  const bin = findSqliteBin();
  if (!bin) {
    log.warn(
      { dbPath },
      'sqlite3 CLI not found; cannot read SQLite. Install sqlite3 or run pnpm rebuild better-sqlite3',
    );
    return [];
  }
  const r = spawnSync(bin, ['-json', dbPath, sql], { encoding: 'utf8' });
  if (r.status !== 0) {
    log.warn({ dbPath, sql, stderr: r.stderr }, 'sqlite3 query failed');
    return [];
  }
  try {
    return JSON.parse(r.stdout.trim());
  } catch (err) {
    log.warn({ stdout: r.stdout, err }, 'sqlite3 -json parse failed');
    return [];
  }
}

// ===== 6 张表的"读 SQLite 一侧" =====

interface SqliteAccount {
  id: string;
  gitea_url: string;
  username: string;
  keychain_service: string;
  created_at: number;
  // 来自 gitea_user
  user_gitea_user_id?: number;
  user_login?: string;
  user_full_name?: string | null;
  user_email?: string | null;
  user_avatar_url?: string | null;
  user_updated_at?: number;
}

interface SqliteUser {
  id: string;
  display_name: string;
  created_at: number;
}

interface SqliteProject {
  id: string;
  gitea_account_id: string;
  owner: string;
  name: string;
  default_branch: string | null;
  last_sync_at: number | null;
  created_at: number;
}

interface SqliteColumn {
  id: string;
  repo_project_id: string;
  title: string;
  position: number;
  created_at: number;
}

interface SqliteLabelMap {
  id: string;
  column_id: string;
  repo_project_id: string;
  gitea_label_id: string;
  gitea_label_name: string;
  created_at: number;
}

interface SqliteStarredBranch {
  id: string;
  repo_project_id: string;
  branch: string;
  created_at: number;
}

interface SqlitePrefRow {
  key: string;
  value: string;
}

function readSqliteAll(dbPath: string): {
  prefs: Record<string, unknown>;
  accounts: SqliteAccount[];
  users: SqliteUser[];
  projects: SqliteProject[];
  columns: SqliteColumn[];
  labelMaps: SqliteLabelMap[];
  starredBranches: SqliteStarredBranch[];
} {
  // prefs
  const prefRows = sqliteQuery(
    dbPath,
    "SELECT key, value FROM prefs WHERE user_id='local-user'",
  ) as SqlitePrefRow[];
  const prefs: Record<string, unknown> = {};
  for (const r of prefRows) {
    try {
      prefs[r.key] = JSON.parse(r.value);
    } catch {
      // 烂数据：跳过
    }
  }

  // accounts (gitea_accounts LEFT JOIN gitea_user)
  const accounts = sqliteQuery(
    dbPath,
    `SELECT a.id, a.gitea_url, a.username, a.keychain_service, a.created_at,
            u.gitea_user_id as user_gitea_user_id, u.login as user_login,
            u.full_name as user_full_name, u.email as user_email,
            u.avatar_url as user_avatar_url, u.updated_at as user_updated_at
     FROM gitea_accounts a
     LEFT JOIN gitea_user u ON u.gitea_account_id = a.id`,
  ) as SqliteAccount[];

  const users = sqliteQuery(dbPath, 'SELECT id, display_name, created_at FROM users') as SqliteUser[];
  const projects = sqliteQuery(
    dbPath,
    'SELECT id, gitea_account_id, owner, name, default_branch, last_sync_at, created_at FROM repo_projects',
  ) as SqliteProject[];
  const columns = sqliteQuery(
    dbPath,
    'SELECT id, repo_project_id, title, position, created_at FROM board_columns',
  ) as SqliteColumn[];
  const labelMaps = sqliteQuery(
    dbPath,
    'SELECT id, column_id, repo_project_id, gitea_label_id, gitea_label_name, created_at FROM column_label_mapping',
  ) as SqliteLabelMap[];
  const starredBranches = sqliteQuery(
    dbPath,
    'SELECT id, repo_project_id, branch, created_at FROM starred_branches',
  ) as SqliteStarredBranch[];

  return { prefs, accounts, users, projects, columns, labelMaps, starredBranches };
}

// ===== localStore 一侧的 shape（跟 src/main/local/state.ts 的 LocalState 对齐）=====

interface LocalStoreAccount {
  id: string;
  giteaUrl: string;
  username: string;
  keychainService: string;
  createdAt: number;
  userInfo: {
    giteaUserId: number;
    login: string;
    fullName?: string;
    email?: string;
    avatarUrl?: string;
    updatedAt: number;
  } | null;
}

interface LocalStoreUser {
  id: string;
  displayName: string;
  createdAt: number;
}

interface LocalStoreProject {
  id: string;
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  lastSyncAt: number | null;
  createdAt: number;
}

interface LocalStoreColumn {
  id: string;
  projectId: string;
  title: string;
  position: number;
  createdAt: number;
}

interface LocalStoreLabelMap {
  id: string;
  columnId: string;
  projectId: string;
  giteaLabelId: string;
  giteaLabelName: string;
  createdAt: number;
}

interface LocalStoreStarredBranch {
  id: string;
  projectId: string;
  branch: string;
  createdAt: number;
}

interface LocalStateShape {
  schemaVersion: number;
  accounts: LocalStoreAccount[];
  users: LocalStoreUser[];
  prefs: Record<string, unknown>;
  projects: LocalStoreProject[];
  columns: LocalStoreColumn[];
  labelMaps: LocalStoreLabelMap[];
  starredBranches: LocalStoreStarredBranch[];
}

// ===== diff =====

type Diff = {
  table: string;
  key: string;
  side: 'sqlite-only' | 'localStore-only' | 'mismatch';
  sqlite?: unknown;
  localStore?: unknown;
};

function diffPrefs(sqlite: Record<string, unknown>, local: Record<string, unknown>): Diff[] {
  const diffs: Diff[] = [];
  const allKeys = new Set([...Object.keys(sqlite), ...Object.keys(local)]);
  for (const k of allKeys) {
    const inS = k in sqlite;
    const inL = k in local;
    if (inS && !inL) diffs.push({ table: 'prefs', key: k, side: 'localStore-only', localStore: sqlite[k] });
    else if (!inS && inL) diffs.push({ table: 'prefs', key: k, side: 'sqlite-only', sqlite: local[k] });
    else if (JSON.stringify(sqlite[k]) !== JSON.stringify(local[k])) {
      diffs.push({ table: 'prefs', key: k, side: 'mismatch', sqlite: sqlite[k], localStore: local[k] });
    }
  }
  return diffs;
}

/** 通用：把 sqlite 行数组 + localStore 行数组按"主键"对齐，输出 diff */
function diffByPrimaryKey(
  tableName: string,
  sqliteRows: Array<{ id: string }>,
  localRows: Array<{ id: string }>,
  equal: (a: { id: string }, b: { id: string }) => boolean,
  pickKey: (r: { id: string }) => string = (r) => r.id,
): Diff[] {
  const diffs: Diff[] = [];
  const sMap = new Map(sqliteRows.map((r) => [pickKey(r), r] as const));
  const lMap = new Map(localRows.map((r) => [pickKey(r), r] as const));
  const allKeys = new Set([...sMap.keys(), ...lMap.keys()]);
  for (const k of allKeys) {
    const s = sMap.get(k);
    const l = lMap.get(k);
    if (s && !l) diffs.push({ table: tableName, key: k, side: 'localStore-only', localStore: s });
    else if (!s && l) diffs.push({ table: tableName, key: k, side: 'sqlite-only', sqlite: l });
    else if (s && l && !equal(s, l)) diffs.push({ table: tableName, key: k, side: 'mismatch', sqlite: s, localStore: l });
  }
  return diffs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ===== 巡检主流程 =====

interface CheckResult {
  ok: boolean;
  diffs: Diff[];
}

async function checkAndRepair(
  dataDir: string,
  options: { autoRepair: boolean; exitOnDiff: boolean },
): Promise<CheckResult> {
  const dbPath = resolveDbPath(dataDir);
  const statePath = resolveStatePath(dataDir);

  if (!existsSync(dbPath) && !existsSync(statePath)) {
    log.warn({ dataDir }, 'both db and state.json missing → fresh install, nothing to verify');
    return { ok: true, diffs: [] };
  }
  if (!existsSync(dbPath)) {
    log.warn({ dbPath }, 'kanban.db missing, cannot verify; state.json exists');
    return { ok: true, diffs: [] };
  }
  if (!existsSync(statePath)) {
    log.warn({ statePath }, 'state.json missing; bootstrap from sqlite (Phase 2 first-run)');
    return { ok: true, diffs: [] };
  }

  // ===== 读 SQLite 全表 =====
  const sqlite = readSqliteAll(dbPath);

  // ===== 读 localStore =====
  const store = new LocalStore<LocalStateShape>({
    file: statePath,
    defaults: {
      schemaVersion: 1,
      accounts: [],
      users: [{ id: 'local-user', displayName: 'Local User', createdAt: Date.now() }],
      prefs: {},
      projects: [],
      columns: [],
      labelMaps: [],
      starredBranches: [],
    },
  });
  await store.load();
  const local = store.get();

  // ===== 6 张表逐表对比 =====
  const allDiffs: Diff[] = [];
  allDiffs.push(...diffPrefs(sqlite.prefs, local.prefs));
  allDiffs.push(
    ...diffByPrimaryKey('accounts', sqlite.accounts, local.accounts, deepEqual),
  );
  allDiffs.push(
    ...diffByPrimaryKey('users', sqlite.users, local.users, deepEqual),
  );
  allDiffs.push(
    ...diffByPrimaryKey('projects', sqlite.projects, local.projects, deepEqual),
  );
  allDiffs.push(
    ...diffByPrimaryKey('columns', sqlite.columns, local.columns, deepEqual),
  );
  allDiffs.push(
    ...diffByPrimaryKey('labelMaps', sqlite.labelMaps, local.labelMaps, deepEqual),
  );
  allDiffs.push(
    ...diffByPrimaryKey('starredBranches', sqlite.starredBranches, local.starredBranches, deepEqual),
  );

  // 表级空提示
  const summary: Record<string, number> = {};
  for (const t of ['prefs', 'accounts', 'users', 'projects', 'columns', 'labelMaps', 'starredBranches']) {
    const n = allDiffs.filter((d) => d.table === t).length;
    if (n > 0) summary[t] = n;
  }

  if (allDiffs.length === 0) {
    log.info(
      {
        dbPath,
        statePath,
        sqlite: {
          accounts: sqlite.accounts.length,
          projects: sqlite.projects.length,
          columns: sqlite.columns.length,
          labelMaps: sqlite.labelMaps.length,
          starredBranches: sqlite.starredBranches.length,
        },
        localStore: {
          accounts: local.accounts.length,
          projects: local.projects.length,
          columns: local.columns.length,
          labelMaps: local.labelMaps.length,
          starredBranches: local.starredBranches.length,
        },
      },
      '✅ state consistent (0 diffs)',
    );
    await store.close();
    return { ok: true, diffs: [] };
  }

  log.warn(
    { count: allDiffs.length, byTable: summary, sample: allDiffs.slice(0, 5) },
    '⚠️ state inconsistent',
  );

  if (options.autoRepair) {
    const backupPath = `${statePath}.bak.${Date.now()}`;
    copyFileSync(statePath, backupPath);
    log.info({ backupPath }, 'backed up state.json before repair');

    // 修复策略（Phase 2 双写期 + 用户拍板"不 fallback 读 SQLite"）：
    // - localStore-only（sqlite 缺 row）→ **不**自动写 sqlite（避免覆盖新部署）→ 仅 warn
    // - sqlite-only（localStore 缺 row）→ 用 sqlite 值补齐 localStore
    // - mismatch → localStore 优先（后写）
    store.mutate((s) => {
      for (const d of allDiffs) {
        if (d.table === 'prefs') {
          if (d.side === 'localStore-only' && d.localStore !== undefined) {
            (s.prefs as Record<string, unknown>)[d.key] = d.localStore;
          } else if (d.side === 'mismatch' && d.localStore !== undefined) {
            (s.prefs as Record<string, unknown>)[d.key] = d.localStore;
          }
          continue;
        }
        // 表类
        const list = (s as unknown as Record<string, Array<{ id: string }>>)[d.table];
        if (d.side === 'localStore-only' && d.localStore !== undefined) {
          // sqlite 有，localStore 缺 → 补
          list.push(d.localStore as { id: string });
        } else if (d.side === 'mismatch' && d.localStore !== undefined) {
          // 冲突 → localStore 优先
          const idx = list.findIndex((r) => r.id === d.key);
          if (idx >= 0) list[idx] = d.localStore as { id: string };
        }
        // 'sqlite-only'：localStore 有，sqlite 没（=localStore 是新部署 / 全新 state.json），不动
      }
    });
    await store.flushNow();
    log.info('auto-repaired state.json');
  }
  await store.close();

  if (options.exitOnDiff) {
    process.exit(1);
  }
  return { ok: false, diffs: allDiffs };
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
    { ok: result.ok, diffs: result.diffs.length, workingDir },
    'verify-state-consistency done',
  );

  if (!result.ok && result.diffs.length > 0) {
    console.log('\n========== DIFFS ==========');
    const byTable = new Map<string, Diff[]>();
    for (const d of result.diffs) {
      const arr = byTable.get(d.table) ?? [];
      arr.push(d);
      byTable.set(d.table, arr);
    }
    for (const [table, diffs] of byTable) {
      console.log(`\n  [${table}] ${diffs.length} diff(s)`);
      for (const d of diffs.slice(0, 10)) {
        console.log(`    [${d.side}] key=${d.key}`);
        if (d.side === 'mismatch') {
          console.log(`      sqlite:     ${JSON.stringify(d.sqlite).slice(0, 200)}`);
          console.log(`      localStore: ${JSON.stringify(d.localStore).slice(0, 200)}`);
        }
      }
      if (diffs.length > 10) console.log(`    ... +${diffs.length - 10} more`);
    }
    console.log('============================\n');
  }
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'verify failed');
  process.exit(2);
});
