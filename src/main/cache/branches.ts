/**
 * 分支（starred_branches 业务态 + branches Gitea 缓存）本地层
 *
 * 职责（02-architecture.md §5.3.2 + ADR-0003 完结态）：
 * - branches.list 列表缓存 1 min（写在文件 KV，见 ./file-store.ts）
 * - branches.star / unstar：纯本地 starred_branches（走 localStore）
 * - 写操作（create / rename / delete）失效 'branches' 缓存
 *
 * 关键约束：
 * - **不**调 gitea API（gitea 调用在 src/main/gitea/branches.ts）
 *
 * 存储（ADR-0003 完结态）：
 * - 业务态 starred_branches → localStore
 * - Gitea 缓存（branches 列表）→ 文件 KV（cache/branches/<projectId>__<key>.json）
 */

import { randomUUID } from 'node:crypto';
import { getCache, setCache, invalidateCache } from './file-store.js';
import { getLocalStore } from '../local/state.js';
import { listStarredBranchesWithStore } from '../local/starred-branches.js';

const CACHE_RESOURCE = 'branches';
/** branches.list 缓存 TTL：1 min（任务 prompt §关键约束 4） */
export const BRANCHES_LIST_TTL_SECONDS = 1 * 60;

/**
 * 列一个 project 下所有 starred 分支名
 *
 * 用于 branches.list 渲染时把 gitea 返回的分支跟本地 starred 状态 JOIN
 * ADR-0003：走 localStore
 */
export function listStarredBranches(projectId: string): Set<string> {
  return listStarredBranchesWithStore(getLocalStore().get(), projectId);
}

/**
 * star / unstar 切换 —— UPSERT 或 DELETE
 * ADR-0003：写 localStore（star 是纯本地操作）
 */
export function setStarred(args: {
  projectId: string;
  branch: string;
  starred: boolean;
}): void {
  const store = getLocalStore();
  if (args.starred) {
    // upsert：localStore 已存在就 nothing，不存在就 push
    const existing = store
      .get()
      .starredBranches.some(
        (s) => s.projectId === args.projectId && s.branch === args.branch,
      );
    if (!existing) {
      const newRow = {
        id: randomUUID(),
        projectId: args.projectId,
        branch: args.branch,
        createdAt: Date.now(),
      };
      store.mutate((s) => {
        s.starredBranches.push(newRow);
      });
    }
  } else {
    // 删除：localStore
    const existingLocal = store
      .get()
      .starredBranches.find(
        (s) => s.projectId === args.projectId && s.branch === args.branch,
      );
    if (existingLocal) {
      store.mutate((s) => {
        s.starredBranches = s.starredBranches.filter(
          (s) => !(s.projectId === args.projectId && s.branch === args.branch),
        );
      });
    }
  }
  // star 是本地操作；不失效 gitea 资源缓存（gitea 不知道这回事）
  // 但 branches.list 缓存需要失效（star 状态变了）
  invalidateBranchesCache(args.projectId);
}

// ===== branches 资源级缓存（文件 KV）=====

/**
 * 读 branches 缓存
 *
 * 按 (projectId, resource, key) 三个字段查——避免跨 projectId 误命中
 */
export function getBranchesCache(args: { projectId: string; cacheKey: string }): string | null {
  return getCache<string>({ resource: CACHE_RESOURCE, projectId: args.projectId, key: args.cacheKey });
}

/**
 * 写 branches 缓存
 */
export function setBranchesCache(args: { projectId: string; cacheKey: string; payload: string; ttlSeconds?: number }): void {
  setCache({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? BRANCHES_LIST_TTL_SECONDS,
  });
}

/**
 * 失效 branches 资源的所有缓存条目
 *
 * 触发：branches.create / rename / delete / star 之后
 * 传 projectId 仅清该项目；缺省清整个 resource。
 */
export function invalidateBranchesCache(projectId?: string): void {
  invalidateCache({ resource: CACHE_RESOURCE, projectId });
}
