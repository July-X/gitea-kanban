/**
 * 启动期全表 bootstrap（ADR-0003 Phase 2 基础设施）
 * (touch v2)
 *
 * 启动期从 SQLite 灌 6 张业务表到 localStore：
 * - prefs                       → state.prefs
 * - gitea_accounts + gitea_user → state.accounts（denormalize）
 * - users (仅 1 条 seed)        → state.users
 * - repo_projects               → state.projects
 * - board_columns               → state.columns
 * - column_label_mapping        → state.labelMaps
 * - starred_branches            → state.starredBranches
 *
 * 设计原则（ADR-0003）：
 * - **不**保留 SQLite 写路径（Phase 2 切读路径时 SQLite 还在；Phase 3 删 SQLite）
 * - 启动期一次全量灌入；后续 IPC 写双写 SQLite + localStore
 * - 失败：log error 但**不**抛（启动期 SQLite 还没起来时 localStore 已经 OK）
 *
 * 边界：
 * - **不**删 SQLite 数据
 * - **不**做 schema 校验（Zod 在 IPC 边界）
 * - **不**碰 token / keychain
 */

import { eq, and } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import {
  prefs,
  giteaAccounts,
  giteaUser,
  users,
  repoProjects,
  boardColumns,
  columnLabelMapping,
  starredBranches,
} from '../cache/schema/index.js';
import { getLocalStore } from './state.js';
import type { GiteaAccount, LocalUser } from './state.js';
import { logger } from '../logger.js';

const LOCAL_USER_ID = 'local-user';

/**
 * 启动期全表 bootstrap —— 从 SQLite 一次性灌 6 张业务表到 localStore
 *
 * 时机：app.ready 阶段，initSqlite() 之后；早于 IPC handler 注册
 *
 * 幂等：mutate 是覆盖写，重复调安全
 *
 * 失败策略：log error 不抛（启动期最坏情况 = localStore 是空 / 部分，IPC 走兜底）
 */
export async function bootstrapAllFromSqlite(): Promise<void> {
  const store = getLocalStore();
  const db = getDb();

  // 1. prefs
  bootstrapPrefsFromSqliteCore(store, db);

  // 2. accounts (gitea_accounts + gitea_user denormalize)
  bootstrapAccountsFromSqliteCore(store, db);

  // 3. users
  bootstrapUsersFromSqliteCore(store, db);

  // 4. projects (repo_projects)
  bootstrapProjectsFromSqliteCore(store, db);

  // 5. columns (board_columns)
  bootstrapColumnsFromSqliteCore(store, db);

  // 6. labelMaps (column_label_mapping)
  bootstrapLabelMapsFromSqliteCore(store, db);

  // 7. starredBranches
  bootstrapStarredBranchesFromSqliteCore(store, db);

  await store.flushNow();
  const s = store.get();
  logger.info(
    {
      prefs: Object.keys(s.prefs).length,
      accounts: s.accounts.length,
      users: s.users.length,
      projects: s.projects.length,
      columns: s.columns.length,
      labelMaps: s.labelMaps.length,
      starredBranches: s.starredBranches.length,
    },
    'bootstrapAllFromSqlite done',
  );
}

// ===== 7 个子函数（每个独立 try/catch，单表失败不阻塞整体）=====

function bootstrapPrefsFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const rows = db
      .select({ key: prefs.key, value: prefs.value })
      .from(prefs)
      .where(eq(prefs.userId, LOCAL_USER_ID))
      .all();
    if (rows.length === 0) return;
    const seed: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        seed[r.key] = JSON.parse(r.value);
      } catch (err) {
        logger.warn(
          { key: r.key, err: err instanceof Error ? err.message : String(err) },
          'bootstrap prefs: skip invalid JSON row',
        );
      }
    }
    store.mutate((s) => {
      s.prefs = { ...s.prefs, ...seed };
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap prefs failed (non-fatal)',
    );
  }
}

function bootstrapAccountsFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const accRows = db.select().from(giteaAccounts).all();
    if (accRows.length === 0) return;
    const userRows = db.select().from(giteaUser).all();
    const userByAcct = new Map(userRows.map((u) => [u.giteaAccountId, u]));
    const seed: GiteaAccount[] = accRows.map((a) => {
      const u = userByAcct.get(a.id);
      return {
        id: a.id,
        giteaUrl: a.giteaUrl,
        username: a.username,
        keychainService: a.keychainService,
        createdAt: toEpochMsOrThrow(a.createdAt), // schema notNull
        userInfo: u
          ? {
              giteaUserId: u.giteaUserId,
              login: u.login,
              ...(u.fullName ? { fullName: u.fullName } : {}),
              ...(u.email ? { email: u.email } : {}),
              ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
              updatedAt: toEpochMsOrThrow(u.updatedAt), // schema notNull
            }
          : null,
      };
    });
    store.mutate((s) => {
      s.accounts = seed;
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap accounts failed (non-fatal)',
    );
  }
}

function bootstrapUsersFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const rows = db.select().from(users).all();
    if (rows.length === 0) return;
    const seed: LocalUser[] = rows.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      createdAt: toEpochMsOrThrow(u.createdAt), // schema notNull
    }));
    store.mutate((s) => {
      s.users = seed;
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap users failed (non-fatal)',
    );
  }
}

function bootstrapProjectsFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const rows = db.select().from(repoProjects).all();
    if (rows.length === 0) return;
    const seed = rows.map((p) => ({
      id: p.id,
      giteaAccountId: p.giteaAccountId,
      owner: p.owner,
      name: p.name,
      defaultBranch: p.defaultBranch ?? null,
      lastSyncAt: p.lastSyncAt ? toEpochMsOrThrow(p.lastSyncAt) : null,
      createdAt: toEpochMsOrThrow(p.createdAt), // schema notNull
    }));
    store.mutate((s) => {
      s.projects = seed;
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap projects failed (non-fatal)',
    );
  }
}

function bootstrapColumnsFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const rows = db.select().from(boardColumns).all();
    if (rows.length === 0) return;
    const seed = rows.map((c) => ({
      id: c.id,
      projectId: c.repoProjectId, // SQLite 是 repoProjectId，localStore 是 projectId
      title: c.title,
      position: c.position,
      createdAt: toEpochMsOrThrow(c.createdAt), // schema notNull
    }));
    store.mutate((s) => {
      s.columns = seed;
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap columns failed (non-fatal)',
    );
  }
}

function bootstrapLabelMapsFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const rows = db.select().from(columnLabelMapping).all();
    if (rows.length === 0) return;
    const seed = rows.map((m) => ({
      id: m.id,
      columnId: m.columnId,
      projectId: m.repoProjectId, // 同上：SQLite repoProjectId → localStore projectId
      giteaLabelId: m.giteaLabelId,
      giteaLabelName: m.giteaLabelName,
      createdAt: toEpochMsOrThrow(m.createdAt), // schema notNull
    }));
    store.mutate((s) => {
      s.labelMaps = seed;
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap labelMaps failed (non-fatal)',
    );
  }
}

function bootstrapStarredBranchesFromSqliteCore(
  store: ReturnType<typeof getLocalStore>,
  db: ReturnType<typeof getDb>,
): void {
  try {
    const rows = db.select().from(starredBranches).all();
    if (rows.length === 0) return;
    const seed = rows.map((s) => ({
      id: s.id,
      projectId: s.repoProjectId, // 同上
      branch: s.branch,
      createdAt: toEpochMsOrThrow(s.createdAt), // schema notNull
    }));
    store.mutate((s) => {
      s.starredBranches = seed;
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bootstrap starredBranches failed (non-fatal)',
    );
  }
}

// ===== helper =====

/** Date | null | undefined → epoch ms；null/undefined 保持 null */
function toEpochMs(v: Date | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  // drizzle 偶尔返 string / number
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Date | string | number → epoch ms（**不**接受 null）
 *
 * 用在 schema 标记 .notNull() 的字段；drizzle 类型层是 Date，但 runtime 可能是 string / number
 * （取决于 sqlite 模式 + serialize 路径）
 *
 * 抛错策略：null/undefined → throw（schema 不允许，bootstrap 数据已坏）
 */
function toEpochMsOrThrow(v: Date | string | number | null | undefined): number {
  const r = toEpochMs(v as Date | null | undefined);
  if (r === null) {
    throw new Error(`toEpochMsOrThrow: value is null/undefined, got: ${String(v)}`);
  }
  return r;
}

// 抑制 unused 警告（giteaAccounts 引入仅做类型保证，and 同 and 助手）
void giteaAccounts;
void and;
