/**
 * localStore 顶层 state —— 替代 9 张活 SQLite 表
 * (touch v5)
 *
 * 设计原则（ADR-0003）：
 * - 1 个 JSON 文件 = 1 个 LocalState 对象
 * - schemaVersion 顶层，迁移时手动 bump
 * - Zod 校验在 IPC 边界（不引 ajv —— ADR-0003 §"为什么不直接用 electron-store"）
 * - 子模块按职责切分；后续可拆 LocalState 成多 store，但 v1 单一文件最简
 *
 * 与 SQLite 业务表映射（Phase 1 双写期，Phase 3 删 SQLite）：
 * - gitea_accounts        → accounts[]
 * - gitea_user            → accounts[].userInfo（denormalized 进 account）
 * - users (仅 1 行 seed)  → users[]（保留以便未来多 user）
 * - repo_projects         → projects[]
 * - board_columns         → columns[]
 * - column_label_mapping  → labelMaps[]
 * - starred_branches      → starredBranches[]
 * - prefs                 → prefs (Record<string, unknown>)
 *
 * 砍掉的（不写入 state）：cardIssueLink / giteaRefs / undoEntries / hookDeliveries
 */

import { LocalStore, resolveStatePath } from './store.js';
import { logger } from '../logger.js';

// ===== 顶层 schema =====

/** 业务态 schema 版本（手动 bump；变更时在 scripts/migrate.ts 加迁移） */
export const STATE_SCHEMA_VERSION = 1 as const;

export interface GiteaAccount {
  id: string;
  giteaUrl: string;
  username: string;
  keychainService: string;
  createdAt: number; // epoch ms
  /** denormalized: gitea /user 响应（auth.status 不读 keychain 也要用） */
  userInfo: {
    giteaUserId: number;
    login: string;
    fullName?: string;
    email?: string;
    avatarUrl?: string;
    updatedAt: number;
  } | null;
}

export interface LocalUser {
  id: string; // 永远是 'local-user'
  displayName: string;
  createdAt: number;
}

export interface RepoProject {
  id: string;
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  lastSyncAt: number | null;
  createdAt: number;
}

export interface BoardColumn {
  id: string;
  projectId: string;
  title: string;
  position: number;
  createdAt: number;
}

export interface ColumnLabelMap {
  id: string;
  columnId: string;
  projectId: string;
  giteaLabelId: string;
  giteaLabelName: string;
  createdAt: number;
}

export interface StarredBranch {
  id: string;
  projectId: string;
  branch: string;
  createdAt: number;
}

/**
 * 顶层 LocalState —— 1 个 JSON 文件
 *
 * 任何字段必须可 JSON 序列化（不要存 Date 对象 / Function / undefined）
 * 时间字段统一 epoch ms number
 */
export interface LocalState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  accounts: GiteaAccount[];
  users: LocalUser[];
  prefs: Record<string, unknown>; // IPC `user.prefs.*` 的 value
  projects: RepoProject[];
  columns: BoardColumn[];
  labelMaps: ColumnLabelMap[];
  starredBranches: StarredBranch[];
}

// ===== 默认值 =====

const defaultState = (): LocalState => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  accounts: [],
  users: [
    {
      id: 'local-user',
      displayName: 'Local User',
      createdAt: Date.now(),
    },
  ],
  prefs: {},
  projects: [],
  columns: [],
  labelMaps: [],
  starredBranches: [],
});

// ===== 单例 =====

let storeInstance: LocalStore<LocalState> | null = null;
let loaded = false;

/**
 * 启动期调用一次：创建 store + load 磁盘
 *
 * 双写期（Phase 1）：此函数与 initSqlite 并行调用
 * Phase 2：此函数先于 IPC 注册
 * Phase 3：删 initSqlite
 */
export async function initLocalStore(): Promise<LocalStore<LocalState>> {
  if (loaded && storeInstance) return storeInstance;
  const file = resolveStatePath();
  storeInstance = new LocalStore<LocalState>({ file, defaults: defaultState() });
  await storeInstance.load();
  loaded = true;
  logger.info({ file }, 'localStore initialized');
  return storeInstance;
}

/**
 * 取 store 单例（必须在 initLocalStore 之后调）
 */
export function getLocalStore(): LocalStore<LocalState> {
  if (!storeInstance || !loaded) {
    throw new Error('localStore not initialized; call initLocalStore() first');
  }
  return storeInstance;
}

/**
 * 关停（before-quit）
 */
export async function closeLocalStore(): Promise<void> {
  if (storeInstance) {
    await storeInstance.close();
    storeInstance = null;
    loaded = false;
  }
}

// ===== 测试用 =====

/** 重置单例 + 清路径（**只**给 vitest 用） */
export async function _resetLocalStoreForTest(): Promise<void> {
  if (storeInstance) {
    await storeInstance.close();
  }
  storeInstance = null;
  loaded = false;
}
