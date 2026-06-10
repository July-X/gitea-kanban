/**
 * commits.timeline 聚合算法（02-architecture.md §5.3.4）
 *
 * 职责：把 gitea commits / pulls / 本地 card_links 聚合成渲染所需的 TimelineDTO
 *
 * 设计原则（02 §5.3.4 注释 + 任务 prompt §commits.timeline）：
 * 1. **不**调 gitea / **不**读 cache —— 由调用方（ipc/commits.ts）传入 CommitsByBranch + Pulls
 * 2. **纯函数**：入参 → 出参，易于单测
 * 3. x/y 坐标只计算**归一化 0-1 浮点**，渲染层换算 canvasWidth（任务 prompt §commits.timeline 步骤 5-6）
 * 4. lane 颜色按 02 §5.3.4 Lane.color 拍板的三色 (#609926 / #f76707 / #6c757d)
 * 5. truncated = 节点数 > maxNodes 时为 true（任务 prompt §关键约束 12）
 *
 * 关联链路：
 *   1. 对每个 branch 调 listGiteaCommits → CommitsByBranch[branch] = CommitDto[]
 *   2. listGiteaPulls → pulls（拿高亮用 + merge 边）
 *   3. linkedCardIds 来自 cache/commits.getLinkedCardsForCommits（card_links JOIN gitea_refs）
 *   4. lane 分配按 laneMode：
 *      - branch: lanes[i] = 每个 branch 一条
 *      - author: lanes[i] = 每个 author 一条
 *      - pr:     lanes[i] = 每个 PR（merged PR）一条
 *   5. commit → laneId 映射：branch 模式按 commit 在哪个 branch 上 → author 模式按 author.name → pr 模式按 merge commit
 *   6. 边：parents 关系（kind=parent）+ merge 边（pulls[i].mergedAt 命中 commit 时 kind=merge）
 *
 * 关键 trade-off（v1）：
 * - "commit 在哪些 branch 上"是 gitea 拉到的 commit history 交集推断（不是 gitea 显式给）
 *   v1 简化：每个 branch 独立拉 → commitsByBranch[branch] 都是该 branch 上的 commit
 *   → 任何 commit 在哪个 branch 上 = 它出现在哪个 branches[] 数组里
 * - merge commit（parents.length > 1）→ lane = pr 或 head branch lane
 */

import type { CommitDto, Lane, CommitNode, ParentEdge, TimelinePR, TimelineDto, LaneMode, TimelineArgs } from '../ipc/schema.js';

// ===== 02 §5.3.4 拍板的三色 =====
export const LANE_COLOR_PRIMARY = '#609926'; // 主分支（main）
export const LANE_COLOR_ACTIVE = '#f76707'; // 活跃开发
export const LANE_COLOR_ARCHIVED = '#6c757d'; // 归档 / 其它

/** 02-architecture §5.3.4 commits.timeline 单一来源算法 */
export interface BuildTimelineInput {
  args: TimelineArgs;
  commitsByBranch: Record<string, CommitDto[]>;
  pulls: TimelinePR[];
  /** sha → linkedCardIds（来自 cache/commits.getLinkedCardsForCommits 转换） */
  linkedCardIdsBySha: Map<string, string[]>;
}

export function buildTimeline(input: BuildTimelineInput): TimelineDto {
  const { args, commitsByBranch, pulls, linkedCardIdsBySha } = input;
  const maxNodes = args.maxNodes;

  // ===== step 1: 合并 + dedupe commits =====
  const commitMap = new Map<string, CommitNode>();
  const branchHintsBySha = new Map<string, string[]>();

  for (const branch of args.branches) {
    const list = commitsByBranch[branch] ?? [];
    for (const c of list) {
      const existing = commitMap.get(c.sha);
      if (existing) {
        existing.branchHints.push(branch);
      } else {
        commitMap.set(c.sha, {
          id: c.sha,
          laneId: '', // 后面 lane 分配阶段填
          x: 0, // 后面归一化阶段填
          y: 0, // 后面 lane.order 填
          sha: c.sha,
          shortSha: c.shortSha,
          message: c.message.split('\n', 1)[0] ?? c.message,
          author: { name: c.author.name, ...(c.author.avatarUrl ? { avatarUrl: c.author.avatarUrl } : {}) },
          timestamp: c.date,
          parents: [...c.parents],
          isMerge: c.parents.length > 1,
          branchHints: [branch],
          linkedCardIds: linkedCardIdsBySha.get(c.sha) ?? [],
          ...(c.additions !== undefined ? { additions: c.additions } : {}),
          ...(c.deletions !== undefined ? { deletions: c.deletions } : {}),
          ...(c.filesChanged !== undefined ? { filesChanged: c.filesChanged } : {}),
        });
      }
      const hints = branchHintsBySha.get(c.sha) ?? [];
      if (!hints.includes(branch)) hints.push(branch);
      branchHintsBySha.set(c.sha, hints);
    }
  }

  // ===== step 2: 构造 lanes（按 laneMode）=====
  const lanes: Lane[] = buildLanes(args.laneMode, args.branches, commitMap, pulls);

  // ===== step 3: 分配 commit.laneId + y =====
  assignLanes(args.laneMode, lanes, commitMap, pulls);

  // ===== step 4: 归一化 x (0-1 浮点) =====
  const timestamps = [...commitMap.values()].map((n) => Date.parse(n.timestamp));
  const minT = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxT = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const tRange = maxT - minT || 1;
  for (const n of commitMap.values()) {
    n.x = (Date.parse(n.timestamp) - minT) / tRange;
    n.y = lanes.find((l) => l.id === n.laneId)?.order ?? 0;
  }

  // ===== step 5: 构造 edges（parents + merge）=====
  const edges: ParentEdge[] = [];
  for (const n of commitMap.values()) {
    for (const parentSha of n.parents) {
      if (commitMap.has(parentSha)) {
        edges.push({
          id: `${n.sha}->${parentSha}:parent`,
          source: n.sha,
          target: parentSha,
          kind: 'parent',
        });
      }
    }
  }
  // merge 边：每个 merged PR → PR head sha 的 parents 关系
  for (const pr of pulls) {
    if (pr.state !== 'merged') continue;
    if (!pr.mergedAt) continue;
    // 找 PR head sha：在 commits 里找 timestamp ≈ mergedAt 且 ref=head 的 commit
    // 简化：v1 暂不实现精确的"PR head sha"——pulls.head ref 是 branch 名不是 sha
    //   → 留 placeholder：业务上 merge 边靠"isMerge=true 的 commit 跟 PR base 关联"实现
    //   → 后续 task 补（v1 不强求 PR merge 边）
  }

  // ===== step 6: 排序 + 截断 =====
  const allNodes = [...commitMap.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const totalCommits = allNodes.length;
  const truncated = totalCommits > maxNodes;
  // 截断策略（任务 prompt §关键约束 12）：取最近的 maxNodes
  const nodes = truncated ? allNodes.slice(-maxNodes) : allNodes;

  // 截断时 edges 也要清掉"指向被截断节点"的边
  const nodeShaSet = new Set(nodes.map((n) => n.sha));
  const edgesFiltered = edges.filter((e) => nodeShaSet.has(e.source) && nodeShaSet.has(e.target));

  // ===== step 7: range =====
  const from = args.since ?? (totalCommits > 0 ? new Date(minT).toISOString() : new Date().toISOString());
  const to = args.until ?? (totalCommits > 0 ? new Date(maxT).toISOString() : new Date().toISOString());

  return {
    ...(args.since ? { windowStart: args.since } : {}),
    ...(args.until ? { windowEnd: args.until } : {}),
    range: { from, to },
    lanes,
    nodes,
    edges: edgesFiltered,
    prs: pulls,
    truncated,
    totalCommits,
  };
}

// ============================================================
// ===== 内部：lane 构造 =====
function buildLanes(
  mode: LaneMode,
  branches: string[],
  commitMap: Map<string, CommitNode>,
  pulls: TimelinePR[],
): Lane[] {
  if (mode === 'branch') {
    return branches.map((b, idx) => ({
      id: `branch:${b}`,
      label: b,
      kind: 'branch' as const,
      // 拍板 02 §5.3.4：main 在最上用主色；其它按出现顺序交替 active/archived
      color: idx === 0 && b === 'main' ? LANE_COLOR_PRIMARY : idx % 2 === 0 ? LANE_COLOR_ACTIVE : LANE_COLOR_ARCHIVED,
      order: idx,
    }));
  }

  if (mode === 'author') {
    const authors = new Set<string>();
    for (const n of commitMap.values()) authors.add(n.author.name);
    const sortedAuthors = [...authors].sort();
    return sortedAuthors.map((a, idx) => ({
      id: `author:${a}`,
      label: a,
      kind: 'author' as const,
      color: idx === 0 ? LANE_COLOR_PRIMARY : idx % 2 === 0 ? LANE_COLOR_ACTIVE : LANE_COLOR_ARCHIVED,
      order: idx,
    }));
  }

  // mode === 'pr'
  return pulls
    .filter((p) => p.state === 'merged')
    .map((p, idx) => ({
      id: `pr:${p.index}`,
      label: `#${p.index} ${p.title}`,
      kind: 'pr' as const,
      color: idx === 0 ? LANE_COLOR_PRIMARY : idx % 2 === 0 ? LANE_COLOR_ACTIVE : LANE_COLOR_ARCHIVED,
      order: idx,
    }));
}

// ============================================================
// ===== 内部：commit.laneId 分配 =====
function assignLanes(
  mode: LaneMode,
  lanes: Lane[],
  commitMap: Map<string, CommitNode>,
  pulls: TimelinePR[],
): void {
  if (lanes.length === 0) return;
  const fallbackLane = lanes[0]!.id; // 空兜底

  if (mode === 'branch') {
    // 第一个出现在 commit.branchHints 里的 branch
    for (const n of commitMap.values()) {
      const first = n.branchHints[0];
      const lane = first ? lanes.find((l) => l.id === `branch:${first}`) : undefined;
      n.laneId = lane?.id ?? fallbackLane;
    }
    return;
  }

  if (mode === 'author') {
    for (const n of commitMap.values()) {
      const lane = lanes.find((l) => l.id === `author:${n.author.name}`);
      n.laneId = lane?.id ?? fallbackLane;
    }
    return;
  }

  // mode === 'pr'：merge commit（isMerge=true）→ 找其 head branch 对应的 PR
  // v1 简化：merge commit 落到第一个 merged PR lane；非 merge 落到 fallback
  const firstMergedPr = pulls.find((p) => p.state === 'merged');
  const prFallbackLane = firstMergedPr ? `pr:${firstMergedPr.index}` : fallbackLane;
  for (const n of commitMap.values()) {
    if (n.isMerge) {
      n.laneId = prFallbackLane;
    } else {
      n.laneId = fallbackLane;
    }
  }
}

// ===== 默认 export：纯函数聚合 =====
export default buildTimeline;
