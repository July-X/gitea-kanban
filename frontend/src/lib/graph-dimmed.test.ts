/**
 * graph-dimmed.test.ts —— v0.8.28 已合并 PR 灰化算法单测
 *
 * 关键场景：
 *   1) 普通 merge commit 合并 —— PR head 链整段都被 dim，merge-base（main trunk 上）
 *      及之后不再扩散
 *   2) PR head 在 main trunk 上（极端边界）—— skip，不产生 dimmed
 *   3) PR head 在 graph 窗口外（深历史 / force-push）—— skip
 *   4) 多个 PR 共享一段 commit —— Set 去重
 *   5) closed-unmerged PR —— skip（只 merged=true 才 dim）
 *   6) resolveMainHeadSha 找 main/master refs 的最小 row node
 *
 * 不引入新依赖，纯函数 + node assert。
 */

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  dimMergedPullCommits,
  resolveMainHeadSha,
} from '@renderer/lib/graph-dimmed';
import type { GraphNodeDto, PullDto } from '@renderer/types/dto';

// helper：构造 GraphNodeDto
function node(
  row: number,
  sha: string,
  parents: string[] = [],
  opts: { refs?: string[]; refTypes?: string[] } = {},
): GraphNodeDto {
  return {
    row,
    lane: 0,
    color: 0,
    sha,
    shortSha: sha.slice(0, 7),
    subject: sha,
    authorName: 'a',
    authorEmail: 'a@b',
    date: '2026-01-01',
    isMerge: parents.length >= 2,
    parents,
    refs: opts.refs ?? [],
    refTypes: opts.refTypes ?? [],
  };
}
// helper alias for clarity at call sites that use it inline —
// (inlined into node() below; alias removed since typed Generic inference
// failed against ConstructorParameters<typeof node>)

// helper：构造 PullDto
function pr(
  headSha: string,
  merged = true,
  mergeCommitSha?: string,
): PullDto {
  return {
    index: 1,
    title: '',
    state: 'closed',
    draft: false,
    merged,
    head: { ref: 'refs/heads/' + headSha, sha: headSha, label: 'feat' },
    base: { ref: 'refs/heads/main', sha: 'm', label: 'main' },
    author: { username: 'u' },
    createdAt: '',
    updatedAt: '',
    mergeable: true,
    hasConflicts: false,
    mergeCommitSha,
  };
}

describe('graph-dimmed: dimMergedPullCommits (普通 merge 合并)', () => {
  test('普通 merge commit：PR head 链整段 dim，main trunk 不 dim', () => {
    // 拓扑 (latest-first):
    //   row 0: HEAD (lane 0) parents=[mergeCommit]   refs=[main] -> main HEAD
    //   row 1: MERGE (merge commit, parents=[m_base, PR_TIP])  2 parents = merge
    //   row 2: PR_TIP  parents=[PR1]
    //   row 3: PR1     parents=[PR2]
    //   row 4: PR2     parents=[m_base]          <- merge-base
    //   row 5: m_base  parents=[m_root]          refs=[main]
    //   row 6: m_root  parents=[]
    const m_root_s = 'm_root';
    const m_base_s = 'm_base';
    const pr2_s = 'pr2';
    const pr1_s = 'pr1';
    const pr_tip_s = 'pr_tip';
    const merge_s = 'merge';
    const head_s = 'head';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [merge_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, merge_s, [m_base_s, pr_tip_s]),
      node(2, pr_tip_s, [pr1_s]),
      node(3, pr1_s, [pr2_s]),
      node(4, pr2_s, [m_base_s]),
      node(5, m_base_s, [m_root_s], { refs: ['main'], refTypes: ['branch'] }),
      node(6, m_root_s, []),
    ];

    const pulls: PullDto[] = [pr(pr_tip_s, true, merge_s)];

    const dimmed = dimMergedPullCommits(nodes, pulls);
    // 期望 dimmed = [pr_tip, pr1, pr2]
    assert.deepStrictEqual([...dimmed].sort(), [pr2_s, pr1_s, pr_tip_s].sort());
    // m_base / m_root / merge / head 都不应在 dimmed
    assert.ok(!dimmed.has(m_base_s), 'merge-base 不应在 dimmed');
    assert.ok(!dimmed.has(m_root_s), 'main root 不应在 dimmed');
    assert.ok(!dimmed.has(merge_s), 'merge commit 本身不在 dimmed');
    assert.ok(!dimmed.has(head_s), 'main HEAD 不应在 dimmed');
  });

  test('closed-unmerged PR（state=closed 但 merged=false）不 dim', () => {
    const head_s = 'h';
    const m_s = 'm';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [m_s]),
      node(1, m_s, []),
    ];
    const pulls: PullDto[] = [pr(head_s, false)]; // merged=false
    const dimmed = dimMergedPullCommits(nodes, pulls);
    assert.strictEqual(dimmed.size, 0);
  });

  test('多 PR：共用一段 commit + 单独一段', () => {
    // PR A head 在 PR 链顶端 a_tip，BFS 回到 m_base (在 main 上)
    // PR B head 在另一条 b_tip，BFS 回到 m_c (在 main 上)
    // 两条 PR 链不重叠，应分别 dim
    const a_tip_s = 'a_tip';
    const a_mid_s = 'a_mid';
    const b_tip_s = 'b_tip';
    const b_mid_s = 'b_mid';
    const m_head_s = 'm_head';
    const m_b_s = 'm_b';
    const m_c_s = 'm_c';
    const m_d_s = 'm_d';
    const nodes: GraphNodeDto[] = [
      node(0, m_head_s, [m_b_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, m_b_s, [m_c_s]),
      // PR A: a_mid → a_tip merge into m_b via merge_a
      node(2, 'merge_a', [m_b_s, a_tip_s]),
      node(3, a_tip_s, [a_mid_s]),
      node(4, a_mid_s, [m_c_s]),
      // PR B: b_mid → b_tip merge into m_c via merge_b
      node(5, m_c_s, [m_d_s]),
      node(6, 'merge_b', [m_c_s, b_tip_s]),
      node(7, b_tip_s, [b_mid_s]),
      node(8, b_mid_s, [m_d_s]),
      node(9, m_d_s, []),
    ];
    const pulls: PullDto[] = [
      pr(a_tip_s, true, 'merge_a'),
      pr(b_tip_s, true, 'merge_b'),
    ];
    const dimmed = dimMergedPullCommits(nodes, pulls);
    // PR A 链：a_tip, a_mid；PR B 链：b_tip, b_mid
    const expected = [a_tip_s, a_mid_s, b_tip_s, b_mid_s].sort();
    assert.deepStrictEqual([...dimmed].sort(), expected);
  });

  test('同 PR 链上一节点被多次访问（去重）', () => {
    // 极端：PR head 的 first-parent 是 head 自身（循环引用罕见）—— 简化用
    // PR 链 + merge commit 的 parents[1] 指向 PR chain 中间节点（罕见构造），
    // 保证 BFS 不会双计入（Set 去重）。
    const head_s = 'h';
    const tip_s = 't';
    const mid_s = 'm';
    const base_s = 'b';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [base_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, 'merge', [base_s, tip_s]),
      node(2, tip_s, [mid_s]),
      node(3, mid_s, [base_s]),
      node(4, base_s, []),
    ];
    const pulls: PullDto[] = [pr(tip_s, true, 'merge')];
    const dimmed = dimMergedPullCommits(nodes, pulls);
    // Set.size 应该 = 2 (tip, mid)，不重复
    assert.strictEqual(dimmed.size, 2);
    assert.ok(dimmed.has(tip_s));
    assert.ok(dimmed.has(mid_s));
  });

  test('PR head sha 不在 graph 窗口：skip，不报错', () => {
    const head_s = 'h';
    const m_s = 'm';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [m_s]),
      node(1, m_s, []),
    ];
    const pulls: PullDto[] = [pr('sha-not-in-graph', true)];
    const dimmed = dimMergedPullCommits(nodes, pulls);
    assert.strictEqual(dimmed.size, 0);
  });

  test('PR head 在 mainAnc 内（head 把 main 推到前）：skip，不 dim', () => {
    // 极端边界：head.sha 也在 main 上
    const head_s = 'h';
    const m_s = 'm';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [m_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, m_s, []),
    ];
    const pulls: PullDto[] = [pr(head_s, true)];
    const dimmed = dimMergedPullCommits(nodes, pulls);
    assert.strictEqual(dimmed.size, 0);
  });

  test('空输入：graphDto 为空 / mergedPulls 为空 → 返回空 Set', () => {
    assert.strictEqual(dimMergedPullCommits([], [pr('x', true)]).size, 0);
    assert.strictEqual(
      dimMergedPullCommits([node(0, 'a', [])], []).size,
      0,
    );
  });

  test('多个 merged PR：每个 PR 自链分别 dim', () => {
    // 两条独立 PR 链 + main trunk
    // row 0: m_head (refs=[main])
    // row 1: m_a (parents=[m_b])
    // row 2: pr1_merge (parents=[m_b, pr1_tip])
    // row 3: pr1_tip parents=[pr1_mid]
    // row 4: pr1_mid parents=[m_c]
    // row 5: m_b (refs=[main])
    // row 6: m_c (refs=[main])
    // row 7: pr2_merge (parents=[m_c, pr2_tip])
    // row 8: pr2_tip parents=[pr2_mid]
    // row 9: pr2_mid parents=[m_d]
    // row 10: m_d parents=[]
    const m_head_s = 'm_head';
    const m_a_s = 'm_a';
    const pr1_merge_s = 'pr1_merge';
    const pr1_tip_s = 'pr1_tip';
    const pr1_mid_s = 'pr1_mid';
    const m_b_s = 'm_b';
    const m_c_s = 'm_c';
    const pr2_merge_s = 'pr2_merge';
    const pr2_tip_s = 'pr2_tip';
    const pr2_mid_s = 'pr2_mid';
    const m_d_s = 'm_d';
    const nodes: GraphNodeDto[] = [
      node(0, m_head_s, [m_a_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, m_a_s, [m_b_s]),
      node(2, pr1_merge_s, [m_b_s, pr1_tip_s]),
      node(3, pr1_tip_s, [pr1_mid_s]),
      node(4, pr1_mid_s, [m_c_s]),
      node(5, m_b_s, [m_c_s], { refs: ['main'], refTypes: ['branch'] }),
      node(6, m_c_s, [m_d_s], { refs: ['main'], refTypes: ['branch'] }),
      node(7, pr2_merge_s, [m_c_s, pr2_tip_s]),
      node(8, pr2_tip_s, [pr2_mid_s]),
      node(9, pr2_mid_s, [m_d_s]),
      node(10, m_d_s, []),
    ];
    const pulls: PullDto[] = [
      pr(pr1_tip_s, true, pr1_merge_s),
      pr(pr2_tip_s, true, pr2_merge_s),
    ];
    const dimmed = dimMergedPullCommits(nodes, pulls);
    const expected = [pr1_tip_s, pr1_mid_s, pr2_tip_s, pr2_mid_s].sort();
    assert.deepStrictEqual([...dimmed].sort(), expected);
    // main 上所有 commit 都不 dim
    for (const s of [m_head_s, m_a_s, m_b_s, m_c_s, m_d_s]) {
      assert.ok(!dimmed.has(s), `${s} 不应在 dimmed`);
    }
    // merge commit 不算入 dimmed
    for (const s of [pr1_merge_s, pr2_merge_s]) {
      assert.ok(!dimmed.has(s), `merge commit ${s} 不应在 dimmed`);
    }
  });
});

describe('graph-dimmed: resolveMainHeadSha', () => {
  test('找 refs 含 main 的最早 row', () => {
    const nodes: GraphNodeDto[] = [
      node(0, 'h', [], { refs: ['HEAD'], refTypes: ['branch'] }),
      node(1, 'main_head', [], { refs: ['main'], refTypes: ['branch'] }),
      node(2, 'older', [], { refs: ['main'], refTypes: ['branch'] }),
    ];
    assert.strictEqual(resolveMainHeadSha(nodes), 'main_head');
  });

  test('refs 含 master 也算', () => {
    const nodes: GraphNodeDto[] = [
      node(0, 'mst', [], { refs: ['master'], refTypes: ['branch'] }),
    ];
    assert.strictEqual(resolveMainHeadSha(nodes), 'mst');
  });

  test('refs 含 origin/main 也算（剥前缀后取末段）', () => {
    const nodes: GraphNodeDto[] = [
      node(0, 'ot', [], { refs: ['origin/main'], refTypes: ['remoteBranch'] }),
    ];
    assert.strictEqual(resolveMainHeadSha(nodes), 'ot');
  });

  test('无 main/master refs 兜底：row 0 node', () => {
    const nodes: GraphNodeDto[] = [
      node(0, 'top', []),
      node(1, 'next', []),
    ];
    assert.strictEqual(resolveMainHeadSha(nodes), 'top');
  });

  test('空数组返回 undefined', () => {
    assert.strictEqual(resolveMainHeadSha([]), undefined);
  });
});

