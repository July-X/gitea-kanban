/**
 * 仓库（repo_projects）本地缓存层
 *
 * 职责（02-architecture.md §5.3.1 / §6.3）：
 * - repos.list 列表缓存 5 min（写在 cache_entries 表）
 * - repos.addProject / removeProject：写 repo_projects 本地表，**不**调 gitea
 * - isProject / lastSyncAt 通过 repo_projects JOIN 计算
 * - 写操作（addProject / removeProject）失效 'repos' 缓存
 *
 * 关键约束：
 * - **不**碰 token / keychain
 * - **不**调 gitea API
 * - **不**修改表结构（13 业务表 + 1 denorm 缓存表已拍板）
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql, isNull } from 'drizzle-orm';
// 注：isNull 在 cache_entries (nullable) 列上查询时使用——
// drizzle `eq(col, null)` 编译成 SQL `col = NULL`（永远 false）；
// SQLite 的 NULL 比较必须用 `IS NULL`，所以 isNull 是必需的。
import { getDb } from './sqlite.js';
import { repoProjects } from './schema/repoProjects.js';
import { cacheEntries } from './schema/cacheEntries.js';
import { giteaAccounts } from './schema/giteaAccounts.js';
import type { RepoProjectDto } from '../ipc/schema.js';

const CACHE_RESOURCE = 'repos';
/** repos.list 缓存 TTL：5 min（任务 prompt §关键约束 4） */
export const REPOS_LIST_TTL_SECONDS = 5 * 60;

/**
 * 内部：根据 (giteaAccountId, owner, name) 找 repo_projects 行
 */
export function findProject(
  giteaAccountId: string,
  owner: string,
  name: string,
): RepoProjectDto | null {
  const db = getDb();
  const row = db
    .select()
    .from(repoProjects)
    .where(
      and(
        eq(repoProjects.giteaAccountId, giteaAccountId),
        eq(repoProjects.owner, owner),
        eq(repoProjects.name, name),
      ),
    )
    .all()[0];
  if (!row) return null;
  return projectRowToDto(row);
}

/**
 * 内部：列一个 giteaAccountId 下所有 repo_projects 行
 */
export function listProjectsForAccount(giteaAccountId: string): RepoProjectDto[] {
  const db = getDb();
  const rows = db
    .select()
    .from(repoProjects)
    .where(eq(repoProjects.giteaAccountId, giteaAccountId))
    .all();
  return rows.map(projectRowToDto);
}

/**
 * 批量查 (owner, name) → 命中列表
 *
 * 用于 repos.list 渲染时把 gitea 返回的仓库跟本地项目状态 JOIN
 * —— 一次 SQL，避免 N+1
 */
export function findProjectsByOwnerName(
  giteaAccountId: string,
  pairs: ReadonlyArray<{ owner: string; name: string }>,
): Map<string, RepoProjectDto> {
  if (pairs.length === 0) return new Map();
  const db = getDb();
  // 拼成 OR 条件：drizzle 的 inArray 只能单一字段
  // 这里 owner+name 联合查，用 sql 模板
  const ownerNamePairs = pairs.map((p) => ({ owner: p.owner, name: p.name }));
  const rows = db
    .select()
    .from(repoProjects)
    .where(
      and(
        eq(repoProjects.giteaAccountId, giteaAccountId),
        // (owner, name) in (val1, val2, ...)
        sql`(${repoProjects.owner}, ${repoProjects.name}) in (${sql.join(
          ownerNamePairs.map(
            (p) => sql`(${p.owner}, ${p.name})`,
          ),
          sql`, `,
        )})`,
      ),
    )
    .all();
  const map = new Map<string, RepoProjectDto>();
  for (const r of rows) {
    map.set(`${r.owner}/${r.name}`, projectRowToDto(r));
  }
  return map;
}

/**
 * 加为"项目" —— 在 repo_projects 表写一行
 *
 * 行为：
 * - 已存在：返回现有（不报错；幂等）
 * - 不存在：insert
 *
 * 必须提供 giteaUrl（gitea 仓库元数据）以便在 defaultBranch 为 null 时
 * 后续从 gitea 拉一次填上；v1 简化为 null（可由后续 sync 任务补全）
 */
export function addProject(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch?: string | null;
}): RepoProjectDto {
  const db = getDb();
  const existing = findProject(args.giteaAccountId, args.owner, args.name);
  if (existing) return existing;

  // 校验 gitea_accounts 存在（避免 FK 失败）
  const acc = db
    .select()
    .from(giteaAccounts)
    .where(eq(giteaAccounts.id, args.giteaAccountId))
    .all()[0];
  if (!acc) {
    throw new Error(
      `gitea_accounts row not found: ${args.giteaAccountId}（先调 auth.connect）`,
    );
  }

  const now = new Date();
  const id = randomUUID();
  db.insert(repoProjects)
    .values({
      id,
      giteaAccountId: args.giteaAccountId,
      owner: args.owner,
      name: args.name,
      defaultBranch: args.defaultBranch ?? null,
      lastSyncAt: now,
      createdAt: now,
    })
    .run();

  // 失效 repos 缓存（addProject 是写操作）
  invalidateReposCache(args.giteaAccountId);

  const row = db
    .select()
    .from(repoProjects)
    .where(eq(repoProjects.id, id))
    .all()[0]!;
  return projectRowToDto(row);
}

/**
 * 取消"项目" —— 删 repo_projects 行
 *
 * gitea 那边不动（用户到 gitea 页面处理，或保留为不活跃仓库）
 */
export function removeProject(projectId: string): void {
  const db = getDb();
  const existing = db
    .select()
    .from(repoProjects)
    .where(eq(repoProjects.id, projectId))
    .all()[0];
  if (!existing) {
    // 幂等：不存在 = 静默成功
    return;
  }
  db.delete(repoProjects).where(eq(repoProjects.id, projectId)).run();

  // 失效 repos 缓存
  invalidateReposCache(existing.giteaAccountId);
}

/**
 * 更新 lastSyncAt —— repos.list 拉取后调用，标记"刚同步过"
 */
export function touchLastSync(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
  when?: Date;
}): void {
  const db = getDb();
  db.update(repoProjects)
    .set({ lastSyncAt: args.when ?? new Date() })
    .where(
      and(
        eq(repoProjects.giteaAccountId, args.giteaAccountId),
        eq(repoProjects.owner, args.owner),
        eq(repoProjects.name, args.name),
      ),
    )
    .run();
}

/**
 * 回填 repo_projects.default_branch —— v1.1.3 timeline polish 引入
 *
 * 背景（2026-06-13 user 报"时间轴完全不可用"+ diagnose CDP 复现）：
 * - 旧 addProject 写入 sqlite 时 default_branch 为 null
 * - branchesListHandler 用 proj.defaultBranch 判定 BranchDto.isDefault
 * - 全 null → 所有 branch 都是 isDefault=false
 * - TimelineView 默认选 default branch 找不到 → 只勾选 1 个非 default 分支
 * - commits.timeline IPC 只返 7 commits → X6 画 7 节点（应该是 4 分支 15 commit）
 *
 * 修法：reposListHandler 拉完 gitea repo 后对每个 project row 检查
 * - if row 已有 default_branch → noop
 * - elif gitea repo.default_branch 有值 → UPDATE 写回
 *
 * 幂等 + 无副作用：不破坏 IPC schema（仍保持 defaultBranch optional）。
 */
export function backfillDefaultBranch(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}): void {
  const db = getDb();
  db.update(repoProjects)
    .set({ defaultBranch: args.defaultBranch })
    .where(
      and(
        eq(repoProjects.giteaAccountId, args.giteaAccountId),
        eq(repoProjects.owner, args.owner),
        eq(repoProjects.name, args.name),
        isNull(repoProjects.defaultBranch),
      ),
    )
    .run();
}

// ===== cache_entries（repos 资源级缓存）=====

/**
 * 读 repos 缓存（cache-aside 的 cache hit 分支）
 *
 * 唯一索引 (repoProjectId, resource, key)；repos 资源级缓存 repoProjectId 始终为 null
 *
 * @returns payload 字符串（JSON）；null = 缓存未命中或已过期
 */
export function getReposCache(args: {
  giteaAccountId: string;
  cacheKey: string;
}): string | null {
  const db = getDb();
  const row = db
    .select()
    .from(cacheEntries)
    .where(
      and(
        isNull(cacheEntries.repoProjectId),
        eq(cacheEntries.resource, CACHE_RESOURCE),
        eq(cacheEntries.key, args.cacheKey),
      ),
    )
    .all()[0];
  if (!row) return null;

  const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt.getTime() : new Date(row.fetchedAt).getTime();
  const ageSeconds = (Date.now() - fetchedAt) / 1000;
  if (ageSeconds > row.ttlSeconds) {
    return null;
  }
  return row.payload;
}

/**
 * 写 repos 缓存
 */
export function setReposCache(args: {
  giteaAccountId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  const db = getDb();
  const ttl = args.ttlSeconds ?? REPOS_LIST_TTL_SECONDS;
  const now = new Date();
  // upsert: 按 (repoProjectId, resource, key) 查
  // repos 资源级缓存 repoProjectId 始终为 null（账号级）—— 用 isNull 才能命中
  const existing = db
    .select()
    .from(cacheEntries)
    .where(
      and(
        isNull(cacheEntries.repoProjectId),
        eq(cacheEntries.resource, CACHE_RESOURCE),
        eq(cacheEntries.key, args.cacheKey),
      ),
    )
    .all()[0];
  if (existing) {
    db.update(cacheEntries)
      .set({
        payload: args.payload,
        fetchedAt: now,
        ttlSeconds: ttl,
      })
      .where(eq(cacheEntries.id, existing.id))
      .run();
  } else {
    db.insert(cacheEntries)
      .values({
        id: randomUUID(),
        repoProjectId: null,
        resource: CACHE_RESOURCE,
        key: args.cacheKey,
        payload: args.payload,
        fetchedAt: now,
        ttlSeconds: ttl,
      })
      .run();
  }
}

/**
 * 失效 repos 资源的所有缓存条目
 *
 * 触发：addProject / removeProject 之后
 *
 * 备注：cacheEntries.repoProjectId 是 nullable + 没强制 FK；
 * repos 资源用 cacheKey 而不是 projectId 索引（账号级缓存）
 */
export function invalidateReposCache(_giteaAccountId?: string): void {
  const db = getDb();
  db.delete(cacheEntries).where(eq(cacheEntries.resource, CACHE_RESOURCE)).run();
}

// ===== helper =====

type ProjectRow = {
  id: string;
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  lastSyncAt: Date | null;
  createdAt: Date;
};

function projectRowToDto(row: ProjectRow): RepoProjectDto {
  return {
    id: row.id,
    giteaAccountId: row.giteaAccountId,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
