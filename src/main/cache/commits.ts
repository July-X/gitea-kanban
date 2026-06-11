/**
 * commit / PR 缓存 + linkedCards 查询（v1 stub）
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

/** v1 stub：commits 资源缓存键。v1 不做缓存（按 ADR-0002 v1 简化），但 IPC 端约定 key 形状不变 */
export const COMMITS_LIST_TTL_SECONDS = 2 * 60;
export const COMMITS_GET_TTL_SECONDS = 5 * 60;

/** v1 stub：commits 缓存读 / 写 / 失效都 no-op */
export function getCommitsCache(_args: { projectId: string; cacheKey: string }): string | null {
  return null;
}

export function setCommitsCache(_args: {
  projectId: string;
  cacheKey: string;
  payload: string;
  ttlSeconds?: number;
}): void {
  // no-op v1
}

export function invalidateCommitsCache(_projectId?: string): void {
  // no-op v1
}
