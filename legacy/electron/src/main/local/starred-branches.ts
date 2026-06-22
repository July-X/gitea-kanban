/**
 * starredBranches 业务接口 —— localStore 中 StarredBranch[] 的查询
 * (touch v2)
 *
 * 替代 SQLite starred_branches 表
 *
 * 设计原则（ADR-0003 Phase 2）：
 * - 全部走 LocalState.starredBranches
 * - 错误：找不到返空 Set
 * - **不**做缓存
 *
 * 关联代码：
 * - cache/branches.ts listStarredBranches：返 Set<branch> 供 branches.list 渲染时 JOIN
 * - cache/branches.ts setStarred：Phase 2 切写
 */

import type { StarredBranch } from './state.js';

/** 按 projectId 拿所有 starred branch 名 —— 替代 listStarredBranches */
export function listStarredBranchesWithStore(
  state: { starredBranches: StarredBranch[] },
  projectId: string,
): Set<string> {
  return new Set(
    state.starredBranches.filter((s) => s.projectId === projectId).map((s) => s.branch),
  );
}
