/**
 * 仓库（repo_projects）本地缓存层
 *
 * 职责（02-architecture.md §5.3.1 / §6.3）：
 * - repos.list 列表缓存 5 min（写在文件 KV，见 ./file-store.ts）
 * - repos.addProject / removeProject：写 repo_projects 本地表（localStore），**不**调 gitea
 * - isProject / lastSyncAt 通过 localStore.projects 计算
 * - 写操作（addProject / removeProject）失效 'repos' 缓存
 *
 * 关键约束：
 * - **不**碰 token / keychain
 * - **不**调 gitea API
 *
 * 存储（ADR-0003 完结态）：
 * - 业务态 repo_projects → localStore（source of truth）
 * - Gitea 缓存（repos 列表）→ 文件 KV（cache/repos/<accountId>__<key>.json）
 */

import { randomUUID } from 'node:crypto';
import { getCache, setCache, invalidateCache } from './file-store.js';
import type { RepoProjectDto } from '../ipc/schema.js';
import { getLocalStore } from '../local/state.js';
import { findProjectWithStore, findProjectsByOwnerNameWithStore } from '../local/projects.js';
import { findAccountByIdWithStore } from '../local/accounts.js';

const CACHE_RESOURCE = 'repos';
/** repos.list 缓存 TTL：5 min（任务 prompt §关键约束 4） */
export const REPOS_LIST_TTL_SECONDS = 5 * 60;

/**
 * 内部：根据 (giteaAccountId, owner, name) 找 repo_projects 行
 * ADR-0003：走 localStore
 */
export function findProject(
  giteaAccountId: string,
  owner: string,
  name: string,
): RepoProjectDto | null {
  return projectRowToDto(
    findProjectWithStore(getLocalStore().get(), { giteaAccountId, owner, name }),
  );
}

/**
 * 内部：列一个 giteaAccountId 下所有 repo_projects 行
 * ADR-0003：走 localStore
 */
export function listProjectsForAccount(giteaAccountId: string): RepoProjectDto[] {
  const projects = getLocalStore()
    .get()
    .projects.filter((p) => p.giteaAccountId === giteaAccountId);
  return projects.map((p) => projectRowToDto(p)!);
}

/**
 * 批量查 (owner, name) → 命中列表
 *
 * 用于 repos.list 渲染时把 gitea 返回的仓库跟本地项目状态 JOIN
 * —— 一次 map filter，避免 N+1
 * ADR-0003：走 localStore
 */
export function findProjectsByOwnerName(
  giteaAccountId: string,
  pairs: ReadonlyArray<{ owner: string; name: string }>,
): Map<string, RepoProjectDto> {
  const m = findProjectsByOwnerNameWithStore(getLocalStore().get(), giteaAccountId, pairs);
  const out = new Map<string, RepoProjectDto>();
  for (const [k, v] of m) {
    const dto = projectRowToDto(v);
    if (dto) out.set(k, dto);
  }
  return out;
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
 *
 * ADR-0003：写 localStore（source of truth）
 */
export function addProject(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch?: string | null;
}): RepoProjectDto {
  // 1. 检查 gitea_account 存在（用 localStore）
  const store = getLocalStore();
  const stateNow = store.get();
  if (!findAccountByIdWithStore(stateNow, args.giteaAccountId)) {
    throw new Error(
      `gitea_accounts row not found: ${args.giteaAccountId}（先调 auth.connect）`,
    );
  }

  // 2. 幂等：localStore 已存在
  const existingLocal = findProjectWithStore(stateNow, {
    giteaAccountId: args.giteaAccountId,
    owner: args.owner,
    name: args.name,
  });
  if (existingLocal) return projectRowToDto(existingLocal)!;

  // 3. 写 localStore
  const nowEpochMs = Date.now();
  const id = randomUUID();
  const createdRow = {
    id,
    giteaAccountId: args.giteaAccountId,
    owner: args.owner,
    name: args.name,
    defaultBranch: args.defaultBranch ?? null,
    lastSyncAt: nowEpochMs,
    createdAt: nowEpochMs,
  };
  store.mutate((s) => {
    s.projects.push(createdRow);
  });

  // 4. 失效 repos 缓存（addProject 是写操作）
  invalidateReposCache(args.giteaAccountId);

  return projectRowToDto(createdRow)!;
}

/**
 * 取消"项目" —— 删 repo_projects 行
 *
 * gitea 那边不动（用户到 gitea 页面处理，或保留为不活跃仓库）
 *
 * ADR-0003：删 localStore
 */
export function removeProject(projectId: string): void {
  const store = getLocalStore();
  const stateNow = store.get();
  const existingLocal = stateNow.projects.find((p) => p.id === projectId);
  if (!existingLocal) {
    // 幂等：不存在 = 静默成功
    return;
  }

  // 1. 删 localStore（**不**级联 columns / labelMaps / starredBranches —— 项目实体，跨 project
  //    共享不常见但保留语义；Phase 3 改 schema 时一起处理）
  store.mutate((s) => {
    s.projects = s.projects.filter((p) => p.id !== projectId);
  });

  // 2. 失效 repos 缓存
  invalidateReposCache(existingLocal.giteaAccountId);

}

/**
 * 更新 lastSyncAt —— repos.list 拉取后调用，标记"刚同步过"
 * ADR-0003：走 localStore
 */
export function touchLastSync(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
  when?: Date;
}): void {
  const store = getLocalStore();
  const whenMs = (args.when ?? new Date()).getTime();
  store.mutate((s) => {
    const idx = s.projects.findIndex(
      (p) =>
        p.giteaAccountId === args.giteaAccountId &&
        p.owner === args.owner &&
        p.name === args.name,
    );
    if (idx >= 0) {
      s.projects[idx] = { ...s.projects[idx]!, lastSyncAt: whenMs };
    }
  });
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
 *
 * ADR-0003：走 localStore
 */
export function backfillDefaultBranch(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}): void {
  const store = getLocalStore();
  store.mutate((s) => {
    const idx = s.projects.findIndex(
      (p) =>
        p.giteaAccountId === args.giteaAccountId &&
        p.owner === args.owner &&
        p.name === args.name,
    );
    if (idx < 0) return;
    if (s.projects[idx]!.defaultBranch !== null) return; // 已有 → noop
    s.projects[idx] = { ...s.projects[idx]!, defaultBranch: args.defaultBranch };
  });
}

// ===== cache_entries（repos 资源级缓存）=====

/**
 * 读 repos 缓存（cache-aside 的 cache hit 分支）
 *
 * 唯一索引 (repoProjectId, resource, key)；repos 资源级缓存 repoProjectId 始终为 null
 *
 * @returns payload 字符串（JSON）；null = 缓存未命中或已过期
 */
export function getReposCache(args: { giteaAccountId: string; cacheKey: string }): string | null {
  return getCache<string>({ resource: CACHE_RESOURCE, projectId: args.giteaAccountId, key: args.cacheKey });
}

/**
 * 写 repos 缓存
 */
export function setReposCache(args: { giteaAccountId: string; cacheKey: string; payload: string; ttlSeconds?: number }): void {
  setCache({
    resource: CACHE_RESOURCE,
    projectId: args.giteaAccountId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? REPOS_LIST_TTL_SECONDS,
  });
}

/**
 * 失效 repos 资源的所有缓存条目
 *
 * 触发：addProject / removeProject 之后
 *
 * 备注：repos 是账号级缓存（projectId 维度实际是 giteaAccountId）；
 * 传 giteaAccountId 仅清该账号；缺省清整个 resource。
 */
export function invalidateReposCache(giteaAccountId?: string): void {
  invalidateCache({ resource: CACHE_RESOURCE, projectId: giteaAccountId });
}

// ===== helper =====

/**
 * localStore row（number epoch ms）→ RepoProjectDto
 *
 * ADR-0003：cache/repos.ts 走 localStore，createdAt/lastSyncAt 是 number epoch ms
 * （参考 src/main/local/state.ts RepoProject）。
 *
 * 类型签名保留 `Date | number` 兼容，归一化逻辑 `new Date(x).toISOString()` 对两种
 * 入参都正确；RepoProjectDto 输出要求 ISO date string。
 *
 * null 入参 → null（用于 findProject 之类的"找不到"路径）
 */
function projectRowToDto(row: {
  id: string;
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  lastSyncAt: Date | number | null;
  createdAt: Date | number;
} | null): RepoProjectDto | null {
  if (!row) return null;
  return {
    id: row.id,
    giteaAccountId: row.giteaAccountId,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
    lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
