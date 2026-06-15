/**
 * Timeline 缓存层（02-architecture.md §5.3.4 + §6.2）
 *
 * 职责：把 commits.timeline 的归一化 TimelineDto 写进文件 KV（见 ./file-store.ts）
 * - key 构造（任务 prompt §关键约束 13）：projectId + branches (sorted) + since/until + laneMode + maxNodes
 * - TTL：30s（与 pulls 一致，任务 prompt §commits.timeline 步骤 9 缓存段）
 * - 写操作（pulls.merge）触发的"timeline 失效"由调用方处理（这里不主动失效）
 *
 * 边界：
 * - **不**调 gitea
 * - **不**做归一化（归一化在 gitea/timeline.ts 的 buildTimeline）
 * - **不**做截断（截断在 buildTimeline）
 */

import { getCache, setCache, invalidateCache } from './file-store.js';
import type { TimelineArgs } from '../ipc/schema.js';

const CACHE_RESOURCE = 'timeline';
/** commits.timeline 缓存 TTL：30s（与 pulls 同步） */
export const TIMELINE_TTL_SECONDS = 30;

/**
 * 构造 cache key
 *
 * 任务 prompt §关键约束 13：
 * - projectId + branches (sorted) + since/until + laneMode + maxNodes
 * - 任何字段变都重新算
 *
 * 顺序固定（branches 排序后 join）—— 同一组参数不同顺序应命中同一缓存
 */
export function makeTimelineCacheKey(args: TimelineArgs): string {
  const branches = [...args.branches].sort();
  return [
    `project=${args.projectId}`,
    `branches=${branches.join(',')}`,
    `since=${args.since ?? ''}`,
    `until=${args.until ?? ''}`,
    `laneMode=${args.laneMode}`,
    `maxNodes=${args.maxNodes}`,
  ].join('|');
}

/** 读 timeline 缓存 */
export function getTimelineCache(args: { projectId: string; cacheKey: string }): string | null {
  return getCache<string>({ resource: CACHE_RESOURCE, projectId: args.projectId, key: args.cacheKey });
}

/** 写 timeline 缓存 */
export function setTimelineCache(args: { projectId: string; cacheKey: string; payload: string; ttlSeconds?: number }): void {
  setCache({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? TIMELINE_TTL_SECONDS,
  });
}

/**
 * 失效 timeline 资源的所有缓存条目
 *
 * 触发：commits.timeline 主动刷新（UI 按钮）；pulls.merge 完成后（写操作失效，02 §6.3.4）
 * 由调用方（ipc/commits.ts / ipc/pulls.ts）显式调用。
 * 传 projectId 仅清该项目；缺省清整个 resource。
 */
export function invalidateTimelineCache(projectId?: string): void {
  invalidateCache({ resource: CACHE_RESOURCE, projectId });
}
