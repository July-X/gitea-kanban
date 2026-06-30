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

// 测试用: 把 (fromRow, fromLane) → (toRow, toLane) 的 edge 转成单个 branch line
// (跟 Go 端 BuildGraphVscode 的 Branch.lines 格式一致)
function edgesToBranches(
	edges: { fromRow: number; toRow: number; fromLane: number; toLane: number; color: number }[]
) {
	// 按 color 分组, 每个 color 一个 branch
	const byColor = new Map<number, { x1: number; y1: number; x2: number; y2: number; lockedFirst: boolean }[]>();
	for (const e of edges) {
		const arr = byColor.get(e.color) ?? [];
		arr.push({
			x1: e.fromLane, y1: e.fromRow,
			x2: e.toLane, y2: e.toRow,
			lockedFirst: e.fromLane < e.toLane,
		});
		byColor.set(e.color, arr);
	}
	return Array.from(byColor.entries()).map(([color, lines]) => ({ color, end: 0, lines }));
}

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
			edges: [],maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		assert.equal(r.nodes[0]?.cx, VSCODE_OFFSET_X);
		assert.equal(r.nodes[0]?.cy, VSCODE_OFFSET_Y);
		assert.equal(r.nodes[0]?.r, VSCODE_VERTEX_RADIUS);
	});

	test('LANE 间距对齐 GRID_X=16 (vscode 默认)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [],maxLane: 1,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		const a = r.nodes[0]!;
		const b = r.nodes[1]!;
		assert.equal(b.cx - a.cx, VSCODE_GRID_X, 'lane 间距必须 = GRID_X');
	});

	test('同 lane EdgeNormal 渲染为 L 直线 (垂直)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		// 从 (0,0) 到 (1,0), 像素 = (4, 4) → (4, 28)
		// path d: M 16 12 L 16 36
		// shadow + line = 2 entries (vscode Branch.drawPath 画 2 遍)
		assert.equal(r.paths.length, 2);
		// shadow first, line second
		assert.equal(r.paths[0]?.kind, 'shadow');
		assert.equal(r.paths[1]?.kind, 'line');
		assert.equal(r.paths[0]?.d, r.paths[1]?.d, 'shadow / line d 必须相同');
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes('M 16 12'), `path 应以 M 16 12 开头, 实际: ${d}`);
		assert.ok(d.includes('L 16 36'), `path 应包含 L 16 36, 实际: ${d}`);
	});

	test('branches 缺失时从 edges fallback 渲染 flow path', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		assert.equal(r.paths.length, 2);
		assert.ok(r.paths[0]?.d.includes('L 16 36'), `fallback path 应连接两行，实际: ${r.paths[0]?.d}`);
	});

	test('跨 lane 转场用 C 贝塞尔 (rounded 风格)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 1, type: 1 }],maxLane: 1,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		const d = r.paths[0]?.d ?? '';
		// rounded 风格: C 贝塞尔, dy = GRID_Y * 0.8 = 19.2 (vscode graph.ts:76)
		//   p1 = (4, 4), p2 = (20, 28)
		//   控制点 1: (4, 4+19.2) = (4, 23.2)
		//   控制点 2: (20, 28-19.2) = (20, 8.8)
		//   path: M 16 12.0 C 16 31.2 32 16.8 32 36.0
		assert.ok(d.startsWith('M 16 12'), `path 应以 M 16 12 开头, 实际: ${d}`);
		assert.ok(d.includes('C 16 31.2'), `path 应包含 C 16 31.2 (控制点 1), 实际: ${d}`);
		assert.ok(d.includes('32 16.8'), `path 应包含 32 16.8 (控制点 2), 实际: ${d}`);
	});

	test('跨 lane 后接垂直线时保留 VSCode 的曲线转场', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 0, 'b'), node(2, 1, 0, 'c')],
			edges: [],
			branches: [
				{
					color: 0,
					end: 3,
					lines: [
						{ x1: 0, y1: 0, x2: 1, y2: 1, lockedFirst: true },
						{ x1: 1, y1: 1, x2: 1, y2: 2, lockedFirst: false },
					],
				},
			],
			maxLane: 1,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes('C 16 31.2 32 16.8 32 36.0'), `应保留跨 lane 曲线，实际: ${d}`);
		assert.ok(d.includes('L 32 60.0'), `曲线后应继续连接目标 lane 垂直线，实际: ${d}`);
	});

	test('angular 风格:跨 lane 用 L 折线,38% 拐点', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 1, type: 1 }],maxLane: 1,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph, { style: 'angular' });
		const d = r.paths[0]?.d ?? '';
		// angular 风格:跨 lane 用 L 折线,38% 拐点 (vscode graph.ts:76)
		//   p1 = (4, 4), p2 = (20, 28)
		//   dy = GRID_Y * 0.38 = 9.12
		//   lockedFirst = true (p1.x < p2.x)
		//   midX = x2 = 20, midY = y2 - 9.12 = 18.88
		//   path: M 16 12.0 L 32 26.9 L 32 36.0
		assert.ok(d.includes('L 32 26.9'), `angular 拐点应在中点 18.9, 实际: ${d}`);
		assert.ok(d.includes('L 32 36'), `angular 终点 28, 实际: ${d}`);
		// 必须不包含 C
		assert.ok(!d.includes('C '), `angular 不应有 C 命令, 实际: ${d}`);
	});

	test('颜色用 VSCODE_COLORS 调色板 (16 色循环)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 5, 'a')],
			edges: [],maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		assert.equal(r.nodes[0]?.colorHex, VSCODE_COLORS[5]);
	});

	test('merge commit 的 vertex 圆点跟 vscode Vertex.draw 一样画 (默认 fill, 非 stroke-only)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a', ['p1', 'p2'])],
			edges: [],maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		// 圆点 = cx=4, cy=4, r=4
		assert.equal(r.nodes[0]?.isMerge, true);
		assert.equal(r.nodes[0]?.r, 4);
	});

	test('SVG 总宽度 = 2*offsetX + (maxLane+1)*GRID_X', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b'), node(2, 2, 2, 'c')],
			edges: [],maxLane: 2,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		const expectedWidth = 2 * VSCODE_OFFSET_X + (2 + 1) * VSCODE_GRID_X;
		assert.equal(r.width, expectedWidth);
	});

	test('SVG 总高度 = commitCount*GRID_Y + offsetY', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b'), node(2, 0, 0, 'c')],
			edges: [],maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		const expectedHeight = 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y / 2;
		assert.equal(r.height, expectedHeight);
	});

	test('expandAt 处理: 展开后下方所有 line 自动 +EXPAND_Y (vscode Branch.draw 行为)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph, { expandedAt: 0 });
		// 展开 row 0 后, row 1 的 y 加 EXPAND_Y (250, vscode config.ts:278)
		// 节点 b 的 cy = 1*24 + 12 + 250 = 286
		assert.equal(r.nodes[1]?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250);
		// path 终点 = 36 + 250 = 286
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes('L 16 286'), `展开后 path 终点应为 286, 实际: ${d}`);
	});

	test('自定义 expandY 同时作用于 dot、path 和 SVG 高度', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);

		const r = renderGraphVscode(graph, { expandedAt: 0, expandY: 120 });

		assert.equal(r.nodes[1]?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 120);
		assert.ok(r.paths[0]?.d.includes('L 16 156'), `path 应使用自定义 expandY，实际: ${r.paths[0]?.d}`);
		assert.equal(r.height, 2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y / 2 + 120);
	});

	// ============================================================
	// v2.64: maxWidth / contentWidth 测试
	// 对齐 vscode-git-graph Graph.setSvgWidth (graph.ts:697-700) +
	// Graph.applyMaxWidth (graph.ts:689-695) 渐变 fade 行为
	// ============================================================
	test('maxWidth=-1 (默认): width = contentWidth, 无渐变 fade', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b'), node(2, 2, 2, 'c')],
			edges: [],
			maxLane: 2,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph);
		const expectedContent = 2 * VSCODE_OFFSET_X + (2 + 1) * VSCODE_GRID_X;
		assert.equal(r.contentWidth, expectedContent, 'contentWidth 必须 = 完整内容宽');
		assert.equal(r.width, expectedContent, 'maxWidth=-1 时 width == contentWidth');
	});

	test('maxWidth > contentWidth: width = contentWidth (不被放大)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 1, 1, 'b')],
			edges: [],
			maxLane: 1,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph, { maxWidth: 9999 });
		const expectedContent = 2 * VSCODE_OFFSET_X + (1 + 1) * VSCODE_GRID_X;
		assert.equal(r.contentWidth, expectedContent);
		assert.equal(r.width, expectedContent, 'maxWidth 远大于 contentWidth → width == contentWidth');
	});

	test('maxWidth < contentWidth: width = maxWidth (截短渲染宽度, 触发 mask 渐变)', () => {
		const graph: GraphResultDto = {
			nodes: [
				node(0, 0, 0, 'a'),
				node(1, 1, 1, 'b'),
				node(2, 2, 2, 'c'),
				node(3, 3, 3, 'd'),
			],
			edges: [],
			maxLane: 3,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph, { maxWidth: 96 });
		const expectedContent = 2 * VSCODE_OFFSET_X + (3 + 1) * VSCODE_GRID_X;
		assert.equal(r.contentWidth, expectedContent);
		assert.equal(r.width, 96, 'maxWidth 截短渲染宽度 → SVG width = maxWidth');
		// height 不受影响
		assert.equal(
			r.height,
			4 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y / 2,
			'maxWidth 不影响 SVG 高度',
		);
	});

	test('maxWidth=0: width = 0 (极端边界)', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a')],
			edges: [],
			maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		const r = renderGraphVscode(graph, { maxWidth: 0 });
		assert.equal(r.width, 0);
		assert.equal(r.contentWidth, 2 * VSCODE_OFFSET_X + VSCODE_GRID_X);
	});

	test('maxWidth 与 expandAt 同时工作: 截短 width 但展开区域不缩放', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);
		// contentWidth = 2*16 + 1*16 = 48, maxWidth=30 < contentWidth → 截短到 30
		const r = renderGraphVscode(graph, { expandedAt: 0, expandY: 100, maxWidth: 30 });
		assert.equal(r.width, 30, 'maxWidth < contentWidth → width = maxWidth');
		assert.equal(
			r.height,
			2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y / 2 + 100,
			'expandY 影响 height 但 maxWidth 不影响',
		);
		assert.equal(
			r.nodes[1]?.cy,
			1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 100,
			'展开后下方 dot 仍 +expandY',
		);
	});
});
