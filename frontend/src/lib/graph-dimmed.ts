/**
 * graph-dimmed.ts —— v0.8.29：算"未与主分支产出联系"的 commit 集合
 *
 * 语义（对齐 GitLens "dangling / non-reachable" 视角）：
 *   "gitlens 表达没有和主分支产出联系的分支" —— 即一个 commit 不属于 main
 *   可达祖先集合（main trunk + 经 merge 接入的所有 commit 都不算）。
 *
 *   应用视觉：这些 commit 视觉降 opacity（用户能 sense "这条分支独立存在，
 *   主线没见过它"）。与 PR 是否合并无关 —— merged PR 链上的 commit 也属于
 *   "和 main 有联系"（merge 把它们拉进了 main 祖先），所以它们**不**dim。
 *
 * 算法：
 *   1) mainReachable = ancestors(mainHead)（走**所有 parents**，不是 first-parent）：
 *      - main trunk 自身 first-parent 链
 *      - main 上 merge commit 接管的旁支 commit（即 PR 链上的 commit）
 *      - main 上 merge commit 的 second-parent 反向的所有 ancestors
 *   2) 起点选择：refs 含 main/master；兜底 row 0 node
 *   3) dimmed = { sha ∈ nodes.sha - mainReachable }
 *
 *   注：v0.8.28 之前的"已 merged PR 灰化"逻辑基于"被合并的 PR 链 dim"，
 *   与本语义**相反**（merged 反而是联系到 main，应**不**dim）。本版本按 user
 *   2026-07-31 最新指引改为"未与 main 接合的 commit"语义。
 *
 * 边界：
 *   - main head 找不到 → 兜底 row 0，仍能算出 mainReachable
 *   - graph 完全无 main refs（罕见，初始化期）→ mainReachable 仅含 row 0
 *   - 极小 graph（< 2 commit）→ dim 集合可能为空
 *
 * 性能：O(N) 其中 N=graph nodes，单 BFS 单次 mainReachable 推断。
 * 比 v0.8.28 的 mainAncBuild 实现更**便宜**（不需要迭代 PR 列表）。
 *
 * 输入：
 *   - nodes: GraphNodeDto[]（dto.ts:754），仅用 sha + parents + refs
 *
 * 输出：
 *   - Set<string>：应被灰化的 commit SHA 集合
 *
 * 不引入新依赖，纯函数 + 单测友好。
 */

import type { GraphNodeDto } from '@renderer/types/dto';

/**
 * resolveMainHeadSha —— 找 main/trunk head SHA
 *
 * 优先级：
 *   1) refs 含 main/master 的 node（trunk head）
 *   2) 第一条 lane 0 上 row 0 的 node（最顶端 commit 即 current HEAD）兜底
 *   3) undefined（graph 异常）
 *
 * v0.8.28 实现从 refs 直接判断，rows 在 latest-first 拓扑下 main HEAD
 * 就是 refs 里带 main/master 的最早 commit（row 最小的那个）。
 */
export function resolveMainHeadSha(
  nodes: readonly GraphNodeDto[],
): string | undefined {
  let bestRow = Number.POSITIVE_INFINITY;
  let bestSha: string | undefined;
  for (const n of nodes) {
    const refs = n.refs ?? [];
    for (const r of refs) {
      const shortName = r.includes('/') ? (r.split('/').pop() ?? r) : r;
      if (shortName === 'main' || shortName === 'master') {
        if (n.row < bestRow) {
          bestRow = n.row;
          bestSha = n.sha;
        }
        break;
      }
    }
  }
  if (bestSha) return bestSha;
  // 兜底：row 0 即最顶端 commit
  if (nodes.length > 0) {
    let row0best = Number.POSITIVE_INFINITY;
    let row0sha: string | undefined;
    for (const n of nodes) {
      if (n.row < row0best) {
        row0best = n.row;
        row0sha = n.sha;
      }
    }
    return row0sha;
  }
  return undefined;
}

/**
 * ancestorsAllParents —— 从 anchor 沿所有 parents BFS 走，collect 所有 visited
 *
 * 含 anchor 自身。等价于 git command: "git rev-list --all ^HEAD" 反面
 * 或 "ancestorsOf mainHead"：包括 first-parent 主链 + 经 merge 接入的所有支链。
 *
 * v0.8.28 的 `mainAncBuild` 走 first-parent only（语义完全不同：只主链）。
 * 本 v0.8.29 用 all-parents，因为"和主分支产出联系"应包含 merge 接纳的旁支。
 */
function ancestorsAllParents(
  sha: string,
  parentsBySha: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visited = new Set<string>();
  if (!parentsBySha.has(sha)) return visited;
  const queue: string[] = [sha];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const parents = parentsBySha.get(cur) ?? [];
    for (const p of parents) {
      if (p && !visited.has(p)) queue.push(p);
    }
  }
  return visited;
}

/**
 * dimNonMainReachableCommits —— 计算"未与 main 接合"的 commit 集合
 *
 * 算法：
 *   1) mainHead = resolveMainHeadSha(nodes)
 *   2) mainReachable = mainHead ? ancestorsAllParents(mainHead, parentsBySha) : new Set()
 *      注：mainHead 自身 + 整条主链祖先 + 经 merge 接纳的所有 commit
 *   3) dimmed = { sha ∈ nodes | sha ∉ mainReachable }
 *
 * 等价于 "git log --graph main ^feature --not main"：main 没见过的 commit。
 * 与"已合并 PR"语义相反（合并进 main 的 PR 链 commit 已经属于 mainReachable，
 * 不进入 dim 集合，与 GitLens "已 merge 的 PR 标记状态而非 dim" 一致）。
 */
export function dimNonMainReachableCommits(
  nodes: readonly GraphNodeDto[],
): Set<string> {
  const dimmed = new Set<string>();

  if (nodes.length === 0) return dimmed;

  // sha → parents 索引（单次构建）
  const parentsBySha = new Map<string, readonly string[]>();
  for (const n of nodes) {
    if (n.sha) parentsBySha.set(n.sha, n.parents ?? []);
  }

  // 1) main 可达祖先集合
  const mainHead = resolveMainHeadSha(nodes);
  const mainReachable = mainHead
    ? ancestorsAllParents(mainHead, parentsBySha)
    : new Set<string>();

  // 2) 不在 mainReachable 内的所有 graph commit 即为 "dim"
  for (const n of nodes) {
    if (n.sha && !mainReachable.has(n.sha)) {
      dimmed.add(n.sha);
    }
  }

  return dimmed;
}

/**
 * 输入为空时返回的稳定空 Set（避免组件侧 .has() 总是 undefined 边界）
 */
export const EMPTY_DIMMED_SET: ReadonlySet<string> = new Set<string>();
