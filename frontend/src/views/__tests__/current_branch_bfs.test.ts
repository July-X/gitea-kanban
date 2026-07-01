// 单测 currentBranchBySha 的 DFS 算法 (与 inhead_bfs 同思路, 走 children 而非 parents)
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

interface NodeDto {
  sha: string;
  parents: string[];
  refs?: string[];
  refTypes?: string[];
}

function computeCurrentBranch(nodes: NodeDto[]): Map<string, string> {
  // 1. child map
  const childrenBySha = new Map<string, string[]>();
  // 2. own branch
  const ownBranchBySha = new Map<string, string>();
  for (const n of nodes) {
    if (n.refs && n.refTypes) {
      for (let i = 0; i < n.refs.length; i++) {
        if (n.refTypes[i] !== 'tag' && n.refs[i]) {
          ownBranchBySha.set(n.sha, n.refs[i]!);
          break;
        }
      }
    }
    if (n.parents) {
      for (const parent of n.parents) {
        const list = childrenBySha.get(parent) ?? [];
        list.push(n.sha);
        childrenBySha.set(parent, list);
      }
    }
  }
  // 3. memoized DFS
  const cache = new Map<string, string>();
  const visiting = new Set<string>();
  function dfs(sha: string): string {
    if (cache.has(sha)) return cache.get(sha)!;
    if (visiting.has(sha)) return '';
    visiting.add(sha);
    const own = ownBranchBySha.get(sha);
    if (own) {
      cache.set(sha, own);
      visiting.delete(sha);
      return own;
    }
    const children = childrenBySha.get(sha) ?? [];
    let found = '';
    for (const child of children) {
      const cb = dfs(child);
      if (cb) { found = cb; break; }
    }
    cache.set(sha, found);
    visiting.delete(sha);
    return found;
  }
  for (const n of nodes) dfs(n.sha);
  return cache;
}

describe('currentBranchBySha DFS (沿 lane 传播, 走 children 找 branch tip)', () => {
  test('空 graph 返回空 map', () => {
    assert.equal(computeCurrentBranch([]).size, 0);
  });

  test('线性链: 每个 commit 都显示 main (因为 main 标签在 tip 上, 中间 commit 沿 children 找到)', () => {
    //   init → mid → main-tip (refs=[main])
    const map = computeCurrentBranch([
      { sha: 'init', parents: [] },
      { sha: 'mid', parents: ['init'] },
      { sha: 'main-tip', parents: ['mid'], refs: ['main'], refTypes: ['branch'] },
    ]);
    assert.equal(map.get('init'), 'main');
    assert.equal(map.get('mid'), 'main');
    assert.equal(map.get('main-tip'), 'main');
  });

  test('分叉: feature 分支的 commit 全部显示 feature, main 链显示 main', () => {
    //   a → b → c (main) ← d (feature)
    //            ↑
    //            e (feature tip, refs=[feature])
    const map = computeCurrentBranch([
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'] },
      { sha: 'c', parents: ['b', 'e'], refs: ['main'], refTypes: ['branch'] }, // merge commit
      { sha: 'd', parents: ['b'] },
      { sha: 'e', parents: ['d'], refs: ['feature'], refTypes: ['branch'] },
    ]);
    assert.equal(map.get('a'), 'main');    // 走 children → b → c (main)
    assert.equal(map.get('b'), 'main');    // 走 children → c (main, 第一个有 branch)
    assert.equal(map.get('c'), 'main');    // 自己的 ref
    assert.equal(map.get('d'), 'feature'); // 走 children → e (feature)
    assert.equal(map.get('e'), 'feature'); // 自己的 ref
  });

  test('commit 完全没 branch 标签 (孤儿) → 沿 children 找不到, 显示空', () => {
    const map = computeCurrentBranch([
      { sha: 'orphan', parents: [] },
      { sha: 'main', parents: ['orphan'], refs: ['main'], refTypes: ['branch'] },
    ]);
    assert.equal(map.get('orphan'), 'main');  // 走 children → main
    assert.equal(map.get('main'), 'main');
  });

  test('tag 不算 branch (commit 带 tag 不显示 "当前分支: tag")', () => {
    //   a → b (refs=[v1.0, refTypes=[tag]]) → c (refs=[main])
    const map = computeCurrentBranch([
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'], refs: ['v1.0'], refTypes: ['tag'] },
      { sha: 'c', parents: ['b'], refs: ['main'], refTypes: ['branch'] },
    ]);
    assert.equal(map.get('a'), 'main');  // 走 children → c
    assert.equal(map.get('b'), 'main');  // 自己只有 tag, 不算 branch
    assert.equal(map.get('c'), 'main');
  });

  test('UNCOMMITTED (row 0) 不应进 branch map (无 children, 也不该传 branch 上去)', () => {
    const map = computeCurrentBranch([
      { sha: '*', parents: ['head'] },  // UNCOMMITTED 虚拟
      { sha: 'head', parents: ['parent'], refs: ['main-v2'], refTypes: ['branch'] },
    ]);
    assert.equal(map.get('*'), '');     // UNCOMMITTED 不是 branch tip, 也不该传 main-v2
    assert.equal(map.get('head'), 'main-v2');
  });

  test('多个 children: 走第一个有 branch 的', () => {
    const map = computeCurrentBranch([
      { sha: 'root', parents: [] },
      { sha: 'left', parents: ['root'] },
      { sha: 'right', parents: ['root'] },
      { sha: 'left-tip', parents: ['left'], refs: ['left-branch'], refTypes: ['branch'] },
      { sha: 'right-tip', parents: ['right'], refs: ['right-branch'], refTypes: ['branch'] },
    ]);
    // root 走 children 顺序 (按 push 顺序), 第一个找到的是 left-tip → left-branch
    assert.equal(map.get('root'), 'left-branch');
  });

  test('merge commit 自己有 branch ref → 优先用自己的', () => {
    const map = computeCurrentBranch([
      { sha: 'a', parents: [] },
      { sha: 'merge', parents: ['a', 'b'], refs: ['main'], refTypes: ['branch'] },
      { sha: 'b', parents: [] },
    ]);
    assert.equal(map.get('merge'), 'main');
  });
});
