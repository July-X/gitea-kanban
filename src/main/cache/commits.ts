/**
 * commit / PR 缓存 + linkedCards 查询
 *
 * 职责（02-architecture.md §4.2 + §5.3.3 + §5.3.5 + §5.3.8）：
 * - 缓存 TTL 助手（commits 2 min / 5 min；pulls 30s）
 * - linkedCards 查询：v1 不存 cards 表（ADR-0002 reset）→ linkedCards 永远空 Map
 *   → IPC handler attach 到 DTO 上是空数组，UI 看到正常但**没有** card-link 数据
 *
 * 历史（2026-06-11 reset）：
 * - 旧实现用 `cards` / `card_links` / `boards` 表（gitea 1.26 没 projects API 之前的设计）
 * - ADR-0002 reset 后这三张表删了，cache/commits.ts 跟着 stub
 * - 真正卡-列关系通过 `column_label_mapping`（列绑 gitea label）实现，看板从 gitea issues 派生卡片
 *   → 不会再有"commit 关联卡片"的概念（commit 不绑 label）
 *
 * v2 决策：linkedCards 功能要么彻底砍（commit 跟卡片无强关联），要么改成"commit 跟 PR 关联"——待 v2 评估
 */

import { getCache, setCache, invalidateCache } from './file-store.js';
const CACHE_RESOURCE = 'commits';

/** v1：commit list 缓存 TTL 2 min */
export const COMMITS_LIST_TTL_SECONDS = 2 * 60;
/** v1：commit get 缓存 TTL 5 min */
export const COMMITS_GET_TTL_SECONDS = 5 * 60;

// ============================================================
// ===== linkedCards（v1 stub）=====
// ============================================================

/** v1 stub：linkedCards 查询永远返空 Map（commit 跟卡片没有直接关联） */
export function getLinkedCardsForCommits(_args: {
  owner: string;
  repo: string;
  shas: string[];
}): Map<string, never[]> {
  return new Map();
}

export function getLinkedCardsForCommit(_args: {
  owner: string;
  repo: string;
  sha: string;
}): never[] {
  return [];
}

export function getLinkedCardsForPulls(_args: {
  owner: string;
  repo: string;
  indexes: number[];
}): Map<number, never[]> {
  return new Map();
}

export function getLinkedCardsForPull(_args: {
  owner: string;
  repo: string;
  index: number;
}): never[] {
  return [];
}

// ============================================================
// ===== commits 资源级缓存（文件 KV）=====
// ============================================================

/** 读 commits 缓存 */
export function getCommitsCache(args: { projectId: string; cacheKey: string }): string | null {
  return getCache<string>({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: args.cacheKey,
  });
}

/** 写 commits 缓存 */
export function setCommitsCache(args: {
  projectId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  setCache({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? COMMITS_LIST_TTL_SECONDS,
  });
}

// ============================================================
// ===== gitgraph 视图缓存（v1.4 重构后保留 const；v1.5 接入 git 子进程时启用函数）=====
// ============================================================

/** gitgraph 缓存 TTL：30 秒（分支切换频繁但需保证实时性） */
export const GITGRAPH_CACHE_TTL_SECONDS = 30;

/** gitgraph 缓存 key 前缀（与 commits.list 的 'commits' 区分） */
const GITGRAPH_CACHE_KEY_PREFIX = 'gitgraph';

/**
 * 读 gitgraph 缓存（v1.5 启用）
 * cacheKey 格式：`${branches.join(',')}__${limit}`（branches 用 sha 排序保证 key 稳定）
 *
 * v1.4 重构后 `commits.gitgraph.lines` 暂时 throw IpcError('not_implemented')，
 * 所以该函数暂未调用；保留 const + 函数体，等 v1.5 接 git 子进程后恢复 handler。
 */
// @ts-expect-error - v1.5 启用
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _getGitgraphCacheImpl(args: { projectId: string; cacheKey: string }): string | null {
  return getCache<string>({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: `${GITGRAPH_CACHE_KEY_PREFIX}__${args.cacheKey}`,
  });
}

/** 失效 commits 资源的所有缓存条目。传 projectId 仅清该项目；缺省清整个 resource。 */
export function invalidateCommitsCache(projectId?: string): void {
  invalidateCache({ resource: CACHE_RESOURCE, projectId });
}
