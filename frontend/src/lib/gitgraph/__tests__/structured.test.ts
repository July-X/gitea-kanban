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
