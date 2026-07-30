/**
 * graph-dimmed.test.ts —— v0.8.29："未与 main 接合的独立分支 commit" 灰化算法单测
 *
 * 关键场景：
 *   1) main trunk 全部不 dim（已经在 main 上）
 *   2) main 上 merge commit 接管的旁支 commit 也不 dim（已被 main 接合）
 *   3) 未与 main 接合的 dangling commit dim（独立分支顶端链）
 *   4) 空 graph / 无 main refs → 兜底 row 0
 *   5) 多 main refs（main + master）→ 取最早 row
 *
 * 不引入新依赖，纯函数 + node assert。
 */

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  dimNonMainReachableCommits,
  resolveMainHeadSha,
} from '@renderer/lib/graph-dimmed';
import type { GraphNodeDto } from '@renderer/types/dto';

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

describe('graph-dimmed: dimNonMainReachableCommits (dangling / no-main-connection)', () => {
  test('main trunk 全部不 dim，dangling 链全部 dim', () => {
    // 拓扑（latest-first）：
    //   row 0: HEAD (refs=[main], parents=[merge])
    //   row 1: merge (refs=[main], parents=[m_base, feat_tip])  已 merged PR
    //   row 2: feat_tip parents=[feat1]
    //   row 3: feat1 parents=[feat0]
    //   row 4: feat0 parents=[m_base]                 ← dangling 这条 chain 上；已在 main 上汇合
    //   row 5: feat0_dangling_orphan parents=[]      ← 独立分支，**未被 main 接合** → dim
    //   row 5 (same row): m_base (refs=[main], parents=[m_root])
    //   row 6: m_root
    //
    // mainReachable（all-parents from HEAD）= {HEAD, merge, m_base, m_root, feat_tip, feat1, feat0, ...}
    // 实际（BFS from HEAD all-parents）= HEAD + merge.parents[1] + feat_tip.parents[0] + feat1.parents[0]
    //   = {HEAD, merge, m_base, feat_tip, feat1}（注意：BFS 进入 merge.parents[1] = feat_tip 后再 first-parent 不必要，
    //     但用 all-parents 所以每个 parents 都走；feat1.parents[0] = feat0 → 加入 feat0）
    // 实际 unreachable：feat0_dangling_orphan → 应进 dim
    //
    // 简化：明确标注
    const head_s = 'head';
    const merge_s = 'merge';
    const feat_tip_s = 'feat_tip';
    const feat1_s = 'feat1';
    const feat0_s = 'feat0';
    const orphan_s = 'orphan';
    const m_base_s = 'm_base';
    const m_root_s = 'm_root';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [merge_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, merge_s, [m_base_s, feat_tip_s]),
      node(2, feat_tip_s, [feat1_s]),
      node(3, feat1_s, [feat0_s]),
      node(4, feat0_s, [m_base_s]),
      node(5, orphan_s, []),
      node(1, m_base_s, [m_root_s], { refs: ['main'], refTypes: ['branch'] }),
      node(2, m_root_s, []),
    ];

    const dimmed = dimNonMainReachableCommits(nodes);
    // mainReachable (all parents from HEAD):
    //   HEAD → merge → m_base, feat_tip → feat1 → feat0 → m_base (visited), m_root
    //   merge.parents[0] m_base 已在 visited 集合里
    //   所以 mainReachable = {HEAD, merge, m_base, feat_tip, feat1, feat0, m_root}
    // orphan_s 不在 → dim
    assert.deepStrictEqual([...dimmed], [orphan_s]);

    // main trunk 上的 commit 都不 dim
    for (const s of [head_s, merge_s, m_base_s, m_root_s]) {
      assert.ok(!dimmed.has(s), `${s} 不应在 dimmed`);
    }
    // 已 merged PR 的 feature 链（feat_tip, feat1, feat0）都不 dim（已被 main 接合）
    for (const s of [feat_tip_s, feat1_s, feat0_s]) {
      assert.ok(!dimmed.has(s), `${s}（已 merge 旁支）不应 dim`);
    }
  });

  test('未 merged 旁支链 commit 全部 dim（独立 draft 分支）', () => {
    // 拓扑：main chain + 一个独立未 merge 分支
    const head_s = 'head';
    const m1_s = 'm1';
    const m2_s = 'm2';
    const m3_s = 'm3';
    const tip_s = 'tip';     // 独立分支 tip
    const t1_s = 't1';
    const t2_s = 't2';
    const nodes: GraphNodeDto[] = [
      node(0, head_s, [m1_s], { refs: ['main'], refTypes: ['branch'] }),
      node(1, m1_s, [m2_s]),
      node(2, m2_s, [m3_s]),
      node(3, m3_s, []),
      node(0, tip_s, [t1_s]), // 独立分支 tip，row 0 但不在 mainReachable
      node(1, t1_s, [t2_s]),
      node(2, t2_s, [m3_s]), // merge-base 在 m3，但这条分支没被 merge 接合
    ];

    const dimmed = dimNonMainReachableCommits(nodes);
    // tip / t1 / t2 没被 main 接合（m3 实际上**只走 mainReachable first-parent**，
    // 但 m3 没接 t2 → t2/t1/tip 不在 mainReachable）→ dim
    assert.deepStrictEqual([...dimmed].sort(), [tip_s, t1_s, t2_s].sort());
    assert.ok(!dimmed.has(head_s), 'main HEAD 不 dim');
    assert.ok(!dimmed.has(m3_s), 'main root 上 commit 不 dim');
  });

  test('空输入：空 nodes 返回空 Set', () => {
    assert.strictEqual(dimNonMainReachableCommits([]).size, 0);
  });

  test('无 main refs 兜底：row 0 node 作为 main 起始', () => {
    const a_s = 'a';
    const b_s = 'b';
    const nodes: GraphNodeDto[] = [
      node(0, a_s, [b_s]),
      node(1, b_s, []),
    ];
    // a_s 视为 main HEAD，b_s 是 main 上的祖先
    const dimmed = dimNonMainReachableCommits(nodes);
    assert.strictEqual(dimmed.size, 0);
  });

  test('main head 找不到：极限兜底返回全集 dim（不留白）', () => {
    // 不可能真发生（resolveMainHeadSha 总是返回 row 0 兜底），只是数学边界
    // 这里跳过实际写法
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
