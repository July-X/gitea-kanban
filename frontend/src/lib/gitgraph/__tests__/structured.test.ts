import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANE_WIDTH,
  MERGE_STAGGER,
  ROW_HEIGHT,
  renderGraph,
  type GraphResultDto,
} from '../structured.ts';

function node(row: number, lane: number, color: number, sha: string) {
  return {
    row,
    lane,
    color,
    sha,
    shortSha: sha,
    subject: sha,
    authorName: 'tester',
    authorEmail: 'tester@example.com',
    date: '2026-01-01T00:00:00Z',
    isMerge: false,
    parents: [],
  };
}

test('向右分叉时先斜出再沿目标 lane 下行', () => {
  const graph: GraphResultDto = {
    nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
    edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 1, type: 1 }],
    maxLane: 1,
    truncated: false,
  };

  const result = renderGraph(graph);
  assert.equal(result.paths[0]?.d, 'M 5 14 L 15 28 L 15 42');
});

test('向左回收时先沿当前 lane 下行再斜回主干', () => {
  const graph: GraphResultDto = {
    nodes: [node(1, 1, 1, 'feature'), node(3, 0, 0, 'main')],
    edges: [{ fromRow: 1, toRow: 3, fromLane: 1, toLane: 0, color: 1, type: 2 }],
    maxLane: 1,
    truncated: false,
  };

  const result = renderGraph(graph);
  assert.equal(result.paths[0]?.d, 'M 15 42 L 15 84 L 5 98');
});

test('同 lane 被外来 flow 复用时在外来节点前截断', () => {
  const graph: GraphResultDto = {
    nodes: [node(0, 0, 1, 'top'), node(1, 0, 2, 'foreign'), node(2, 0, 1, 'bottom')],
    edges: [{ fromRow: 0, toRow: 2, fromLane: 0, toLane: 0, color: 1, type: 0 }],
    maxLane: 0,
    truncated: false,
  };

  const result = renderGraph(graph);
  assert.equal(result.paths[0]?.d, 'M 5 14 L 5 28');
});

test('尺寸基于 lane/row 常量稳定输出', () => {
  const graph: GraphResultDto = {
    nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
    edges: [],
    maxLane: 1,
    truncated: false,
  };

  const result = renderGraph(graph);
  assert.equal(result.width, 3 * LANE_WIDTH);
  assert.equal(result.height, 3 * ROW_HEIGHT);
});

test('多条分支回收到同一 parent 时按层级错开拐点，避免线条覆盖', () => {
  const graph: GraphResultDto = {
    nodes: [
      node(1, 1, 1, 'inner'),
      node(1, 2, 2, 'outer'),
      node(3, 0, 0, 'main'),
    ],
    edges: [
      { fromRow: 1, toRow: 3, fromLane: 1, toLane: 0, color: 1, type: 2 },
      { fromRow: 1, toRow: 3, fromLane: 2, toLane: 0, color: 2, type: 2 },
    ],
    maxLane: 2,
    truncated: false,
  };

  const result = renderGraph(graph);
  const inner = result.paths.find((path) => path.colorIndex === 1);
  const outer = result.paths.find((path) => path.colorIndex === 2);

  assert.equal(inner?.d, 'M 15 42 L 15 74 L 5 98');
  assert.equal(outer?.d, `M 25 42 L 25 ${84} L 5 98`);
  assert.notEqual(inner?.d, outer?.d);
  assert.equal(84 - 74, MERGE_STAGGER);
});

test('path 输出顺序保持 edge 原始顺序，避免按颜色 regroup 后覆盖主干', () => {
  const graph: GraphResultDto = {
    nodes: [
      node(0, 0, 0, 'head'),
      node(1, 0, 0, 'main-1'),
      node(1, 1, 1, 'feature'),
      node(2, 0, 0, 'base'),
    ],
    edges: [
      { fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 },
      { fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 1, type: 1 },
      { fromRow: 1, toRow: 2, fromLane: 0, toLane: 0, color: 0, type: 0 },
      { fromRow: 1, toRow: 2, fromLane: 1, toLane: 0, color: 1, type: 2 },
    ],
    maxLane: 1,
    truncated: false,
  };

  const result = renderGraph(graph);
  assert.deepEqual(
    result.paths.map((path) => [path.order, path.colorIndex, path.d]),
    [
      [0, 0, 'M 5 14 L 5 42'],
      [1, 1, 'M 5 14 L 15 28 L 15 42'],
      [2, 0, 'M 5 42 L 5 70'],
      [3, 1, 'M 15 42 L 15 56 L 5 70'],
    ],
  );
});

test('merge 回其他分支后，目标分支 flow 前后半段保持同色 path', () => {
  const graph: GraphResultDto = {
    nodes: [
      node(0, 0, 0, 'm4'),
      node(1, 1, 1, 'b4'),
      node(2, 1, 1, 'bm'),
      node(3, 2, 2, 'a2'),
      node(4, 1, 1, 'b2'),
      node(5, 2, 2, 'a1'),
      node(6, 1, 1, 'b1'),
      node(7, 0, 0, 'm3'),
      node(8, 0, 0, 'm2'),
      node(9, 0, 0, 'm1'),
    ],
    edges: [
      { fromRow: 0, toRow: 7, fromLane: 0, toLane: 0, color: 0, type: 0 },
      { fromRow: 1, toRow: 2, fromLane: 1, toLane: 1, color: 1, type: 0 },
      { fromRow: 2, toRow: 4, fromLane: 1, toLane: 1, color: 1, type: 0 },
      { fromRow: 2, toRow: 3, fromLane: 1, toLane: 2, color: 1, type: 2 },
      { fromRow: 3, toRow: 5, fromLane: 2, toLane: 2, color: 2, type: 0 },
      { fromRow: 4, toRow: 6, fromLane: 1, toLane: 1, color: 1, type: 0 },
      { fromRow: 5, toRow: 6, fromLane: 2, toLane: 1, color: 2, type: 2 },
      { fromRow: 6, toRow: 8, fromLane: 1, toLane: 0, color: 1, type: 2 },
      { fromRow: 7, toRow: 8, fromLane: 0, toLane: 0, color: 0, type: 0 },
      { fromRow: 8, toRow: 9, fromLane: 0, toLane: 0, color: 0, type: 0 },
    ],
    maxLane: 2,
    truncated: false,
  };

  const result = renderGraph(graph);
  const branchFlowPaths = result.paths.filter((path) => path.colorIndex === 1);
  assert.deepEqual(
    branchFlowPaths.map((path) => path.d),
    [
      'M 15 42 L 15 70',
      'M 15 70 L 15 126',
      'M 15 70 L 25 84 L 25 98',
      'M 15 126 L 15 182',
      'M 15 182 L 15 224 L 5 238',
    ],
  );
});

test('merge commit 指向被合入分支的长斜线使用 parent flow 颜色', () => {
  const graph: GraphResultDto = {
    nodes: [
      node(0, 0, 0, 'merge'),
      node(1, 0, 0, 'main-1'),
      node(9, 1, 1, 'feature'),
      node(10, 0, 0, 'main-2'),
      node(11, 0, 0, 'base'),
    ],
    edges: [
      { fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 },
      { fromRow: 0, toRow: 9, fromLane: 0, toLane: 1, color: 1, type: 2 },
      { fromRow: 1, toRow: 10, fromLane: 0, toLane: 0, color: 0, type: 0 },
      { fromRow: 9, toRow: 11, fromLane: 1, toLane: 0, color: 1, type: 2 },
      { fromRow: 10, toRow: 11, fromLane: 0, toLane: 0, color: 0, type: 0 },
    ],
    maxLane: 1,
    truncated: false,
  };

  const result = renderGraph(graph);
  const longBranch = result.paths.find((path) => path.order === 1);
  assert.equal(longBranch?.colorIndex, 1);
  assert.equal(longBranch?.d, 'M 5 14 L 15 28 L 15 266');
});
