/**
 * pull request 缓存层
 *
 * 职责（02-architecture.md §5.3.5 + §5.3.6 + §6.2）：
 * - pulls.list 列表缓存 30s（写在文件 KV，见 ./file-store.ts）
 * - pulls.get 单 PR 缓存 30s
 * - pulls.create 写操作：失效 pulls 资源缓存
 * - pulls.merge 写操作：失效 pulls + commits + branches 三个资源缓存
 *
 * 边界：
 * - **不**调 gitea API（gitea 调用在 src/main/gitea/pulls.ts）
 * - **不**改表结构
 * - 失败重试：暂不实现（v1 由 IPC handler 层透传错误给 UI）
 */

import { getCache, setCache, invalidateCache } from './file-store.js';
const CACHE_RESOURCE = 'pulls';
/** pulls.list 缓存 TTL：30s（任务 prompt §pulls.* 拍板，PR 状态变化频繁） */
export const PULLS_LIST_TTL_SECONDS = 30;
/** pulls.get 缓存 TTL：30s（同 list） */
export const PULLS_GET_TTL_SECONDS = 30;

// ============================================================
// ===== pulls 资源级缓存（文件 KV）=====
// ============================================================

/** 读 pulls 缓存 */
export function getPullsCache(args: { projectId: string; cacheKey: string }): string | null {
  return getCache<string>({ resource: CACHE_RESOURCE, projectId: args.projectId, key: args.cacheKey });
}

/** 写 pulls 缓存 */
export function setPullsCache(args: { projectId: string; cacheKey: string; payload: string; ttlSeconds?: number }): void {
  setCache({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? PULLS_LIST_TTL_SECONDS,
  });
}

/**
 * 失效 pulls 资源的所有缓存条目
 *
 * 触发：pulls.create / pulls.merge 之后
 * 传 projectId 仅清该项目；缺省清整个 resource。
 */
export function invalidatePullsCache(projectId?: string): void {
  invalidateCache({ resource: CACHE_RESOURCE, projectId });
}
