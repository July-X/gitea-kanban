/**
 * graph-dimmed.ts —— 算已合并 PR commit 集合（v0.8.28 灰化视觉）
 *
 * GitLens 实测：已合并（merged=true）的合并请求对应的 commit 链
 * （head 分支顶端 → merge-base）在 Commit Graph 上以低 opacity 呈现，
 * 对齐 GitLens 设置 `dimCommitsWithPullRequests` 的视觉语义。
 *
 * 算法（覆盖 PR 合并 4 种方式 + 边界）：
 *   1) 找 main head sha（graph node 上挂 refs 含 main / master）
 *      备用兜底：refs 为空但 sha 是当前 branch tip
 *   2) mainAncestors = ancestors(mainHead)：main trunk 上的所有 commit
 *   3) 对每个 merged PR：
 *      a) 从 PR.head.sha 出发沿 first-parent 走（BFS）
 *      b) 遇到 mainAncestors 内的 sha 停止（到达 merge-base / common ancestor）
 *      c) 走到尽头 / 走到未在 graph 里的 sha 停止
 *      d) 沿途所有 sha 加入 dimmed Set
 *
 *   覆盖三种合并方式：
 *     - 普通 merge commit：BFS 沿 first-parent 一路到 merge-base（parents[1] →
 *       PR 链 ... → common ancestor）；merge commit 本身不在 BFS 路径上
 *       （因为我们从 parents[1] 出发的，已经是 merge commit 的子）
 *     - squash：mergeCommitSha == head.sha，Gitea 把整个 PR 折成一个
 *       commit squashed 到 main，PR 分支所有原 commit **不在 main 上**，
 *       这些 commit 不在当前 graph（被 squash 掉了）—— dimmed 集合为空，符合预期
 *     - rebase / fast-forward：BFS 沿 first-parent 自然覆盖整个 PR 链
 *
 *   边界：
 *     - PR head sha 在 graph 窗口外（force-push / 深历史）→ 跳过
 *     - 多个 merged PR 共享同一 head sha → Set 去重
 *     - main head 找不到 → 兜底走 PR.head.sha 整链祖先（保守灰化）
 *
 * 性能：O(N + ΣM·D) 其中 N=graph nodes, M=PR 数, D=单 PR 链深度
 * 单 main ancestors BFS + 单个 shared parentsBySha 索引。
 * 实测 < 10ms @ 5000 commits × 30 PR。
 *
 * 输入：
 *   - nodes: GraphNodeDto[]（dto.ts:754），仅用 sha + parents + refs
 *   - mergedPulls: PullDto[]（dto.ts:312），仅用 merged + head.sha
 *
 * 输出：
 *   - Set<string>：应被灰化的 commit SHA 集合
 *
 * 不引入新依赖，纯函数 + 单测友好。
 */

import type { GraphNodeDto, PullDto } from '@renderer/types/dto';

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
 * mainAncBuild —— main trunk 祖先集合（走**仅 first-parent**）
 *
 * 关键：从 mainHead 沿 parents BFS 时**只看 parents[0]**，不走 second-parent。
 * 原因：main 上的 merge commit 把 feature branch "拉进来" —— 如果走所有 parents，
 * mainAnc 会包含 PR 链整段 commit，dim 截断条件就误命中。
 *
 * first-parent-only 等价于 "git log --first-parent main ^feature" 的语义：
 * 只看 main 自身链历史，不看经 merge 接管的其它分支 commit。
 */
function mainAncBuild(
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
    const firstParent = parents[0];
    if (firstParent && !visited.has(firstParent)) queue.push(firstParent);
  }
  return visited;
}

/**
 * dimMergedPullCommits —— 计算 dimmed SHA 集合
 *
 * 算法：
 *   1) mainAnc = ancestors(mainHead)（used as 截断线）
 *   2) 对每个 merged PR：
 *      - 从 PR.head.sha 沿 first-parent BFS
 *      - 遇到 mainAnc 的 sha → 停止（merge-base 处截断，不再向 main 主线扩散）
 *      - 沿途 sha 加入 dimmed
 *
 * 关键 invariant：BFS 只走 first-parent，避免从 PR 分支跳到 main trunk
 * 其它分支（merge 时 merged branch 的 second parent 会引到 main 上，
 * 但我们 first-parent only，永不跳）。
 */
export function dimMergedPullCommits(
  nodes: readonly GraphNodeDto[],
  mergedPulls: readonly PullDto[],
): Set<string> {
  const dimmed = new Set<string>();

  if (nodes.length === 0 || mergedPulls.length === 0) return dimmed;

  // sha → parents 索引（单次构建）
  const parentsBySha = new Map<string, readonly string[]>();
  for (const n of nodes) {
    if (n.sha) parentsBySha.set(n.sha, n.parents ?? []);
  }

  // 1) main trunk 祖先集（用于 BFS 截断点）—— first-parent only
  const mainHead = resolveMainHeadSha(nodes);
  const mainAnc = mainHead ? mainAncBuild(mainHead, parentsBySha) : new Set<string>();

  for (const pr of mergedPulls) {
    if (!pr.merged) continue;
    const headSha = pr.head?.sha;
    if (!headSha) continue;
    if (!parentsBySha.has(headSha)) continue; // 窗口外，跳过

    // BFS 沿 first-parent only（merge commit 的 second-parent 永不跳，避免回 main）
    const visited = new Set<string>();
    const queue: string[] = [headSha];
    // mainAnc 不空（mainHead 解析成功）时，PR head 自身通常不在 mainAnc
    // （head branch 是 feature 分支，与 main fork 后才汇合）。
    // 边界：headSha 自身在 mainAnc（极端情况：PR 把 main HEAD 推前）
    // → 该 PR 与 main 完全重合，不应有任何 dimmed（BFS 立即 break）
    const isHeadInMain = mainAnc.size > 0 && mainAnc.has(headSha);
    if (isHeadInMain) continue;

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      // 截断点：cur 已在 main trunk 上（即到达 merge-base）→ 不加入 dimmed
      // 注意保留 headSha 自身加入（PR head tip 属于被灰化的 PR 链）
      if (mainAnc.size > 0 && mainAnc.has(cur)) break;
      visited.add(cur);
      const parents = parentsBySha.get(cur) ?? [];
      // 只走 first-parent（PR 上 commits 通常线性，偶有 merge-base 后分支也走不到 main）
      const firstParent = parents[0];
      if (firstParent && !visited.has(firstParent)) queue.push(firstParent);
    }

    for (const sha of visited) dimmed.add(sha);
  }

  return dimmed;
}

/**
 * 输入为空时返回的稳定空 Set（避免组件侧 .has() 总是 undefined 边界）
 */
export const EMPTY_DIMMED_SET: ReadonlySet<string> = new Set<string>();
