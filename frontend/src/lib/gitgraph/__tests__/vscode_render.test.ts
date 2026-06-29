import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
	VSCODE_COLORS,
	VSCODE_GRID_X,
	VSCODE_GRID_Y,
	VSCODE_OFFSET_X,
	VSCODE_OFFSET_Y,
	VSCODE_VERTEX_RADIUS,
	renderGraphVscode,
} from '../vscode-render.ts';
import type { GraphResultDto } from '../structured.ts';

function node(row: number, lane: number, color: number, sha: string, parents: string[] = []) {
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
		isMerge: parents.length >= 2,
		parents,
	};
}

describe('gitgraph vscode-render (1:1 复刻 web/graph.ts::Branch.draw)', () => {
	test('LANE=0 的顶点 cx = offsetX (4), cy = row*GRID_Y + offsetY (4)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a')],
			edges: [],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		assert.equal(r.nodes[0]?.cx, VSCODE_OFFSET_X);
		assert.equal(r.nodes[0]?.cy, VSCODE_OFFSET_Y);
		assert.equal(r.nodes[0]?.r, VSCODE_VERTEX_RADIUS);
	});

	test('LANE 间距对齐 GRID_X=16 (vscode 默认)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [],
			maxLane: 1,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		const a = r.nodes[0]!;
		const b = r.nodes[1]!;
		assert.equal(b.cx - a.cx, VSCODE_GRID_X, 'lane 间距必须 = GRID_X');
	});

	test('同 lane EdgeNormal 渲染为 L 直线 (垂直)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		// 从 (0,0) 到 (1,0), 像素 = (4, 4) → (4, 28)
		// path d: M 4 4 L 4 28
		assert.equal(r.paths.length, 1);
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes('M 4 4'), `path 应以 M 4 4 开头, 实际: ${d}`);
		assert.ok(d.includes('L 4 28'), `path 应包含 L 4 28, 实际: ${d}`);
	});

	test('跨 lane 转场用 C 贝塞尔 (rounded 风格)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 1, type: 1 }],
			maxLane: 1,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		const d = r.paths[0]?.d ?? '';
		// rounded: C x1 (y1+d) x2 (y2-d) x2 y2
		// d = 24*0.8 = 19.2
		// p1 = (4, 4), p2 = (20, 28)
		// path: M 4 4 C 4 23.2 20 8.8 20 28
		assert.ok(d.startsWith('M 4 4'), `path 应以 M 4 4 开头, 实际: ${d}`);
		assert.ok(d.includes('C 4'), `path 必须包含贝塞尔 C 4 ..., 实际: ${d}`);
		// 端点 y2 - d = 28 - 19.2 = 8.8
		assert.ok(d.includes('8.8'), `path 应包含 8.8 (y2-d), 实际: ${d}`);
	});

	test('angular 风格:跨 lane 用 L 折线,38% 拐点', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 1, type: 1 }],
			maxLane: 1,
			truncated: false,
		};
		const r = renderGraphVscode(graph, { style: 'angular' });
		const d = r.paths[0]?.d ?? '';
		// d = 24*0.38 = 9.12
		// lockedFirst = true (p1.x < p2.x)
		// midX = x2 = 20, midY = y2 - d = 28 - 9.12 = 18.88
		// path: M 4 4 L 20 18.9 L 20 28
		assert.ok(d.includes('L 20 18.9'), `angular 拐点应在中点 18.9, 实际: ${d}`);
		assert.ok(d.includes('L 20 28'), `angular 终点 28, 实际: ${d}`);
		// 必须不包含 C
		assert.ok(!d.includes('C '), `angular 不应有 C 命令, 实际: ${d}`);
	});

	test('颜色用 VSCODE_COLORS 调色板 (16 色循环)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 5, 'a')],
			edges: [],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		assert.equal(r.nodes[0]?.colorHex, VSCODE_COLORS[5]);
	});

	test('merge commit 的 vertex 圆点跟 vscode Vertex.draw 一样画 (默认 fill, 非 stroke-only)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a', ['p1', 'p2'])],
			edges: [],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		// 圆点 = cx=4, cy=4, r=4
		assert.equal(r.nodes[0]?.isMerge, true);
		assert.equal(r.nodes[0]?.r, 4);
	});

	test('SVG 总宽度 = 2*offsetX + (maxLane+1)*GRID_X', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b'), node(2, 2, 2, 'c')],
			edges: [],
			maxLane: 2,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		const expectedWidth = 2 * VSCODE_OFFSET_X + (2 + 1) * VSCODE_GRID_X;
		assert.equal(r.width, expectedWidth);
	});

	test('SVG 总高度 = commitCount*GRID_Y + offsetY', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b'), node(2, 0, 0, 'c')],
			edges: [],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		const expectedHeight = 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y;
		assert.equal(r.height, expectedHeight);
	});

	test('expandAt 处理: 展开后下方所有 line 自动 +EXPAND_Y (vscode Branch.draw 行为)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph, { expandedAt: 0 });
		// 展开 row 0 后, row 1 的 y 加 EXPAND_Y (120)
		// 节点 b 的 cy = 1*24 + 4 + 120 = 148
		assert.equal(r.nodes[1]?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 120);
		// path 终点 = 28 + 120 = 148
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes('L 4 148'), `展开后 path 终点应为 148, 实际: ${d}`);
	});
});
