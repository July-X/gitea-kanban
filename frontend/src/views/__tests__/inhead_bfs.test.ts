// 单测 inHeadShaSet 的 BFS 祖先算法
// (直接 import 用 vscode-render 不便, 复刻同样算法验证)
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

interface NodeDto {
  sha: string;
  parents: string[];
  isCurrent?: boolean;
}

function computeInHeadSet(nodes: NodeDto[]): Set<string> {
  let headSha: string | undefined;
  for (const n of nodes) {
    if (n.isCurrent) {
      headSha = n.sha;
      break;
    }
  }
  if (!headSha) return new Set();
  const parentsBySha = new Map<string, string[]>();
  for (const n of nodes) parentsBySha.set(n.sha, n.parents ?? []);
  const visited = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    for (const p of parentsBySha.get(sha) ?? []) {
      if (p && !visited.has(p)) queue.push(p);
    }
  }
  return visited;
}

describe('inHead 祖先 BFS (strict vscode-git-graph semantic)', () => {
  test('空 graph 返回空集合', () => {
    assert.equal(computeInHeadSet([]).size, 0);
  });

  test('无 isCurrent 节点返回空集合 (vscode 不显示 "in HEAD" section)', () => {
    const set = computeInHeadSet([
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'] },
    ]);
    assert.equal(set.size, 0);
  });

  test('线性链: HEAD=77399179, 它的 init commit 也在 inHead 集合里', () => {
    const set = computeInHeadSet([
      { sha: 'init', parents: [] },
      { sha: 'mid', parents: ['init'] },
      { sha: '77399179', parents: ['mid'], isCurrent: true },
    ]);
    assert.equal(set.size, 3);
    assert.ok(set.has('77399179'));
    assert.ok(set.has('mid'));
    assert.ok(set.has('init'));
  });

  test('分叉链: HEAD 在 main, 不在 feature 分叉上的祖先', () => {
    // main:    a → b → c (HEAD)
    // feature: a → b → d
    // inHead = {a, b, c}  (d 不在, d 是 b 的 descendant 而不是 ancestor)
    const set = computeInHeadSet([
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'] },
      { sha: 'c', parents: ['b'], isCurrent: true },
      { sha: 'd', parents: ['b'] },
    ]);
    assert.equal(set.size, 3);
    assert.ok(set.has('a'));
    assert.ok(set.has('b'));
    assert.ok(set.has('c'));
    assert.ok(!set.has('d'), 'd 是 b 的 descendant 不是 ancestor, 不在 inHead');
  });

  test('merge commit: HEAD=merge, 两个 parent 链的祖先都进集合', () => {
    // a → b → c (merge) ← d → e
    const set = computeInHeadSet([
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'] },
      { sha: 'c', parents: ['b', 'e'], isCurrent: true },
      { sha: 'd', parents: [] },
      { sha: 'e', parents: ['d'] },
    ]);
    assert.equal(set.size, 5);
    assert.ok(set.has('a'));
    assert.ok(set.has('b'));
    assert.ok(set.has('c'));
    assert.ok(set.has('d'));
    assert.ok(set.has('e'));
  });

  test('UNCOMMITTED (row 0, sha=*) 不在集合里 —— 它不是 HEAD 的 ancestor', () => {
    // 真实 wails dev 场景: UNCOMMITTED + main-v2 tip + local HEAD + 祖先
    const set = computeInHeadSet([
      { sha: '*', parents: ['77399179'] },  // UNCOMMITTED 虚拟 commit
      { sha: '5e40ed68', parents: ['77399179'] },  // origin/main-v2 tip (unpulled)
      { sha: '77399179', parents: ['parent'], isCurrent: true },
      { sha: 'parent', parents: [] },
    ]);
    assert.equal(set.size, 2);
    assert.ok(set.has('77399179'));
    assert.ok(set.has('parent'));
    assert.ok(!set.has('*'), 'UNCOMMITTED 不应 in HEAD');
    assert.ok(!set.has('5e40ed68'), 'unpulled commit 不应 in HEAD');
  });

  test('diamond: a → b → d, a → c → d, HEAD=d, 整图都 in HEAD', () => {
    const set = computeInHeadSet([
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'] },
      { sha: 'c', parents: ['a'] },
      { sha: 'd', parents: ['b', 'c'], isCurrent: true },
    ]);
    assert.equal(set.size, 4);
  });
});
