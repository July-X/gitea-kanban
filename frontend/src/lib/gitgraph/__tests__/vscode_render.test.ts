import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
	VSCODE_COLORS,
	VSCODE_EXPAND_Y,
	VSCODE_GRID_X,
	VSCODE_GRID_Y,
	VSCODE_OFFSET_X,
	VSCODE_OFFSET_Y,
	VSCODE_VERTEX_RADIUS,
	renderGraphVscode,
} from '../vscode-render.ts';
import type { GraphResultDto } from '@renderer/types/dto';

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
		// v0.8.37.5: VSCODE_GRID_Y 24 → 28（对齐 vscode-office ROW_HEIGHT=28）
		// path d: M ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y).toFixed(1)} L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}
		// 例如 offsetX=8, GRID_Y=24, offsetY=12: M 8 12 L 8 36
		// 从 (0,0) 到 (1,0), 像素 = (offsetX, offsetY) → (offsetX, offsetY+VSCODE_GRID_Y)
		// v0.8.37：去掉 shadow 双层（vscode-office 单层），path 数量从 2 变 1
		assert.equal(r.paths.length, 1);
		assert.equal(r.paths[0]?.kind, 'line');
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes(`M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y}`), `path 应以 M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y} 开头, 实际: ${d}`);
		assert.ok(d.includes(`L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}`), `path 应包含 L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}, 实际: ${d}`);
	});

	test('branches 缺失时从 edges fallback 渲染 flow path', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		const r = renderGraphVscode(graph);
		// v0.8.37：去掉 shadow 双层
		assert.equal(r.paths.length, 1);
		assert.ok(r.paths[0]?.d.includes(`L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}`), `fallback path 应连接两行，实际: ${r.paths[0]?.d}`);
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
		// rounded 风格: C 贝塞尔, dy = GRID_Y * 0.8 (vscode graph.ts:76)
		//   p1 = (offsetX, offsetY), p2 = (GRID_X+offsetX, GRID_Y+offsetY)
		//   控制点 1: (offsetX, offsetY + GRID_Y * 0.8)
		//   控制点 2: (GRID_X+offsetX, GRID_Y+offsetY - GRID_Y * 0.8)
		//   path: M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y} C ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y - VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}
		assert.ok(d.startsWith(`M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y}`), `path 应以 M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y} 开头, 实际: ${d}`);
		assert.ok(d.includes(`C ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.8).toFixed(1)}`), `path 应包含 C ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.8).toFixed(1)} (控制点 1), 实际: ${d}`);
		assert.ok(d.includes(`${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y - VSCODE_GRID_Y * 0.8).toFixed(1)}`), `path 应包含 ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y - VSCODE_GRID_Y * 0.8).toFixed(1)} (控制点 2), 实际: ${d}`);
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
		assert.ok(d.includes(`C ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y - VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}`), `应保留跨 lane 曲线，实际: ${d}`);
		assert.ok(d.includes(`L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + 2 * VSCODE_GRID_Y).toFixed(1)}`), `曲线后应继续连接目标 lane 垂直线 (y=${(VSCODE_OFFSET_Y + 2 * VSCODE_GRID_Y).toFixed(1)})，实际: ${d}`);
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
		//   p1 = (offsetX, offsetY), p2 = (GRID_X+offsetX, GRID_Y+offsetY)
		//   dy = GRID_Y * 0.38
		//   lockedFirst = true (p1.x < p2.x)
		//   midX = x2 = GRID_X+offsetX, midY = y2 - GRID_Y*0.38
		//   path: M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y.toFixed(1)} L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.62).toFixed(1)} L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}
		// v0.8.35: 跟 vscode-render.ts 同步，angDy.toFixed(1) (GRID_Y*0.38)
		const expectedMidY = ((VSCODE_OFFSET_Y + VSCODE_GRID_Y) - VSCODE_GRID_Y * 0.38).toFixed(1);
		assert.ok(d.includes(`L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${expectedMidY}`), `angular 拐点应在中点 ${expectedMidY}, 实际: ${d}`);
		assert.ok(d.includes(`L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}`), `angular 终点 ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}, 实际: ${d}`);
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
		// 节点 b 的 cy = 1*VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250 = 286
		assert.equal(r.nodes[1]?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250);
		// path 终点 = VSCODE_OFFSET_Y + VSCODE_GRID_Y + 250 = 36 + 250 = 286
		const d = r.paths[0]?.d ?? '';
		assert.ok(d.includes(`L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y + 250).toFixed(1)}`), `展开后 path 终点应为 ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y + 250).toFixed(1)}, 实际: ${d}`);
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
		assert.ok(r.paths[0]?.d.includes(`L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y + 120).toFixed(1)}`), `path 应使用自定义 expandY（y=${(VSCODE_OFFSET_Y + VSCODE_GRID_Y + 120).toFixed(1)}），实际: ${r.paths[0]?.d}`);
		assert.equal(r.height, 2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y / 2 + 120);
	});

	/* v0.9.x 回归：commit-row 展开后 accordion 实际 scrollHeight 用 expandedHeight 传入，
	 * 必须替换默认 VSCODE_EXPAND_Y=250，让 SVG 容器 + dot cy + path 端点偏移全都用 actual 值。
	 * 修复 commit-row 展开后左侧 Graph 与 DOM row 错位的 bug。 */
	test('expandedHeight 实际 accordion 高度替换默认 expandY=250', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b'), node(2, 0, 0, 'c')],
			edges: [
				{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 },
				{ fromRow: 1, toRow: 2, fromLane: 0, toLane: 0, color: 0, type: 0 },
			],
			maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);

		const actualAccordionH = 350;
		const r = renderGraphVscode(graph, {
			expandedAt: 0,
			expandY: VSCODE_EXPAND_Y,
			expandedHeight: actualAccordionH,
		});

		assert.equal(r.nodes[1]?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + actualAccordionH);
		assert.equal(r.nodes[2]?.cy, 2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + actualAccordionH);
		assert.equal(r.height, 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y / 2 + actualAccordionH);
	});

	/* v0.9.x 回归：expandedHeight < expandY 时仍用 expandY（fallback）。 */
	test('expandedHeight < expandY 时 fallback 到 expandY', () => {
		const graph: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = edgesToBranches(graph.edges);

		const r = renderGraphVscode(graph, {
			expandedAt: 0,
			expandY: 250,
			expandedHeight: 100,
		});

		assert.equal(r.nodes[1]?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250);
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
		const r = renderGraphVscode(graph, { maxWidth: 50 }); // < contentWidth (2*offsetX + 4*GRID_X)
		const expectedContent = 2 * VSCODE_OFFSET_X + (3 + 1) * VSCODE_GRID_X;
		assert.equal(r.contentWidth, expectedContent);
		assert.equal(r.width, 50, 'maxWidth 截短渲染宽度 → SVG width = maxWidth');
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

	test('v0.8.26.x: 跨 lane 跨多行的线拆成「转场段(≤1 行高) + 竖直段」（GitLens 形态）', () => {
		// lockedFirst=true（merge 边）：斜切段在上端，竖直段随后
		const mergeLike: GraphResultDto = {
			nodes: [node(0, 0, 0, 'a'), node(3, 1, 0, 'b')],
			edges: [],
			branches: [
				{
					color: 1,
					end: 4,
					lines: [{ x1: 0, y1: 0, x2: 1, y2: 3, lockedFirst: true }],
				},
			],
			maxLane: 1,
			truncated: false,
		};
		const r1 = renderGraphVscode(mergeLike);
		const d1 = r1.paths[0]?.d ?? '';
		// 转场段 (0,0)→(1,1)：贝塞尔 M ${VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y} C ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y - VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}
		assert.ok(d1.includes(`C ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y - VSCODE_GRID_Y * 0.8).toFixed(1)} ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}`), `转场段应集中在首行，实际: ${d1}`);
		// 竖直段 (1,1)→(1,3)：L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)}（y = 3*${VSCODE_GRID_Y}+${VSCODE_OFFSET_Y}）
		assert.ok(d1.includes(`L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)}`), `转场后应为纯竖直段到目标行 (y=${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)})，实际: ${d1}`);

		// lockedFirst=false（fork 汇入边）：竖直段先行，斜切段在下端
		const forkLike: GraphResultDto = {
			nodes: [node(0, 1, 0, 'a'), node(3, 0, 0, 'b')],
			edges: [],
			branches: [
				{
					color: 1,
					end: 4,
					lines: [{ x1: 1, y1: 0, x2: 0, y2: 3, lockedFirst: false }],
				},
			],
			maxLane: 1,
			truncated: false,
		};
		const r2 = renderGraphVscode(forkLike);
		const d2 = r2.paths[0]?.d ?? '';
		// 竖直段 (1,0)→(1,2)：M ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y.toFixed(1)} L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)}（y = 2*${VSCODE_GRID_Y}+${VSCODE_OFFSET_Y}）
		assert.ok(d2.includes(`M ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${VSCODE_OFFSET_Y.toFixed(1)} L ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)}`), `fork 线应先竖直到末段前 (y=${(2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)})，实际: ${d2}`);
		// 转场段 (1,2)→(0,3)：贝塞尔 C ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y * 0.2).toFixed(1)} ${VSCODE_OFFSET_X} ${(2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.2).toFixed(1)} ${VSCODE_OFFSET_X} ${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)}
		assert.ok(d2.includes(`C ${VSCODE_GRID_X + VSCODE_OFFSET_X} ${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y - VSCODE_GRID_Y * 0.2).toFixed(1)} ${VSCODE_OFFSET_X} ${(2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + VSCODE_GRID_Y * 0.2).toFixed(1)} ${VSCODE_OFFSET_X} ${(3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y).toFixed(1)}`), `fork 转场段应集中在末行，实际: ${d2}`);
	});
});

describe('gitgraph vscode-render UNCOMMITTED 灰色虚线 (v3.x)', () => {
	test('UNCOMMITTED 节点 + isCommitted=false branch line → 渲染出 #808080 + 2px dasharray 灰色虚线段', () => {
		// 1. 构造 [UNCOMMITTED(row 0), HEAD(row 1), parent(row 2)] 三个 commit
		// 2. branches 用 3 条 line 把 row 0↔1↔2 串起来
		// 3. row 0↔1 line 标 isCommitted=false (模拟 Go 端 layout_vscode.go 透传)
		// 4. 断言 renderGraphVscode 输出的 paths 里至少有一条 isCommitted=false + #808080 + '2px'
		const graph: GraphResultDto = {
			nodes: [
				node(0, 0, 0, '*', ['head']),
				node(1, 0, 0, 'head', ['parent']),
				node(2, 0, 0, 'parent', []),
			],
			edges: [
				{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 },
				{ fromRow: 1, toRow: 2, fromLane: 0, toLane: 0, color: 0, type: 0 },
			],
			maxLane: 0,
			truncated: false,
		};
		// 关键:branch lines 携带 isCommitted
		(graph as any).branches = [{
			color: 0,
			end: 3,
			lines: [
				{ x1: 0, y1: 0, x2: 0, y2: 1, lockedFirst: false, isCommitted: false }, // UNCOMMITTED → HEAD
				{ x1: 0, y1: 1, x2: 0, y2: 2, lockedFirst: false, isCommitted: true },  // HEAD → parent
			],
		}];

		const r = renderGraphVscode(graph);
		assert.ok(r.paths.length > 0, '应该渲染出 path');

		// 关键断言:至少有一条 path 的 isCommitted=false + colorHex=#808080 + dasharray='2px'
		const uncommittedPaths = r.paths.filter((p) => p.isCommitted === false);
		assert.ok(
			uncommittedPaths.length > 0,
			'UNCOMMITTED 行应该产生 isCommitted=false 的 path, 实际: ' +
				JSON.stringify(r.paths.map((p) => ({ isCommitted: p.isCommitted, colorHex: p.colorHex, dasharray: p.dasharray })))
		);
		assert.equal(uncommittedPaths[0]!.colorHex, '#808080', 'UNCOMMITTED path 颜色应该是 #808080');
		assert.equal(uncommittedPaths[0]!.dasharray, '2px', 'UNCOMMITTED path 应该是 2px dasharray');
	});

	test('UNCOMMITTED 节点在 nodes 数组里携带 isCommitted=false → 透传到 result.nodes', () => {
		const graph: GraphResultDto = {
			nodes: [
				{ ...node(0, 0, 0, '*', ['head']), isCommitted: false },
				node(1, 0, 0, 'head', []),
			],
			edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
			maxLane: 0,
			truncated: false,
		};
		(graph as any).branches = [{
			color: 0, end: 2,
			lines: [{ x1: 0, y1: 0, x2: 0, y2: 1, lockedFirst: false, isCommitted: false }],
		}];

		const r = renderGraphVscode(graph);
		assert.equal(r.nodes.length, 2);
		assert.equal(r.nodes[0]!.isCommitted, false, 'row 0 (UNCOMMITTED) 透传 isCommitted=false');
		assert.equal(r.nodes[1]!.isCommitted, undefined, 'row 1 缺省 (undefined)');
	});
});

// =====================================================================================
// v0.8.31 回归测试：line 跨 expandedAt 边界时端点严格落到 dot cy
//
// 用户 2026-07-31 实测："新 bug：展开查看 commit 详情后，断线了，没有和 dot 连起来"
// 截图显示当多分支仓库展开 commit 详情时，穿过展开区的 lane line 在 panel 下方端点
// 悬空、未准确落到 dot 上（dot 已 +expandY，但 line 几何未跟进）。
//
// 根因：v0.8.31 最初尝试用 splitLineByExpandedAt 把跨边界 line 拆为 upper+lower 两段，
// 但拆段后两段各自走 pushSplit 导致双重转场 + 端点偏离 dot（断线）。
//
// 正确修复：expandY 偏移只看端点行号，与 lane 无关：
//   if (line.y1 > expandedAt) y1 += expandY;
//   if (line.y2 > expandedAt) y2 += expandY;
// pushSplit 不动：lockedFirst 转场点 sy1+gridY（上端行底）、sy2-gridY（下端行顶），
// 竖直段天然连续穿过 expandY 空隙，无断线、无重复转场。
// =====================================================================================

// helper: line (X1,Y1)→(X2,Y2) + lockedFirst + isCommitted
type LineSpec = { x1: number; y1: number; x2: number; y2: number; lockedFirst?: boolean; isCommitted?: boolean };

function line(s: LineSpec): any {
  return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, lockedFirst: s.lockedFirst ?? false, isCommitted: s.isCommitted ?? true };
}

describe('gitgraph vscode-render — v0.8.31 expandedAt 端点独立偏移（无拆段）', () => {
  // SVG 路径端点解析：M (start: x,y) / L (x,y) / C cp1,cp2,end —— 每段最后 2 个数
  // 是终点（M 是起点，L 是终点，C 是 control+control+end），曲线控制点 y 不计入
  // 端点集合（控制点 y 经常偏离节点 cy 正常，比如贝塞尔曲线 mid 控制点 ≈ 0.4*gridY
  // 偏移）。
  const extractEndpoints = (d: string): Array<{ x: number; y: number }> => {
    const pts: Array<{ x: number; y: number }> = [];
    // 注意：\s*（而非 \s+）确保末尾无空格的最后一个数也被捕获
    const re = /([MLC])\s*((?:-?\d+(?:\.\d+)?\s*)*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(d)) !== null) {
      const nums = m[2]!.trim().split(/\s+/).map((s) => parseFloat(s));
      if (nums.length < 2) continue;
      pts.push({ x: nums[nums.length - 2]!, y: nums[nums.length - 1]! });
    }
    return pts;
  };

  test('vertical line 跨 expandedAt 边界：line 端点严格落到下一行 dot（含 expandY）', () => {
    // 拓扑：row 0 (main lane) → row 1 (main lane)，expandedAt=0
    // 期望：y1=0 (不偏移), y2=1*VSCODE_GRID_Y+VSCODE_OFFSET_Y+250=286 (偏移)
    //       pushSplit 看到 y2-y1=288 > 1.5*VSCODE_GRID_Y=36，但 x1===x2 走 fallback 画 1 段 vertical
    const graph: GraphResultDto = {
      nodes: [node(0, 0, 0, 'a'), node(1, 0, 0, 'b')],
      edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
      maxLane: 0,
      truncated: false,
    };
    (graph as any).branches = [{ color: 0, lines: [line({ x1: 0, y1: 0, x2: 0, y2: 1 })], end: 2, colorIndex: 0 }];
    const r = renderGraphVscode(graph, { expandedAt: 0 });

    const nodeB = r.nodes.find((n) => n.row === 1);
    assert.equal(nodeB?.cy, 1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250);

    // 至少一条 path 端点 y 接近 b.cy
    const allPathYs = r.paths.flatMap((p) => extractEndpoints(p.d).map((pt) => pt.y));
    const closeToB = allPathYs.some((py) => Math.abs(py - nodeB!.cy) <= 2);
    assert.ok(closeToB, `vertical line 端点 y 应接近 b.cy=${nodeB!.cy}，所有端点 y: ${JSON.stringify(allPathYs)}`);
  });

  test('跨 lane multi-row line 跨 expandedAt 边界：端点严格落到 dot cy（含 expandY）', () => {
    // 拓扑（latest-first）：
    //   row 0: a (lane 0)               —— expandedAt 行
    //   row 1: b (lane 1)               —— expandedAt 后续行
    //   row 2: c (lane 2)               —— 展开后 + expandY
    //   row 3: d (lane 3)               —— 展开后 + expandY
    //
    // line (0,0)→(1,2) 跨 expandedAt=0：
    //   y1=0 (不偏移), y2=2*VSCODE_GRID_Y+VSCODE_OFFSET_Y+250=310 (偏移)
    //   pushSplit 看到 y2-y1=310 > 1.5*VSCODE_GRID_Y=36，x1!==x2 走拆段（lockedFirst=true 上端锁）
    //   转场点 mid = sy1+VSCODE_GRID_Y = 0+24 = 24（上端行底）
    //   竖直段从 y=VSCODE_GRID_Y 到 y=310，穿过 expandY 空隙，无断线
    //
    // 关键断言：所有 line 端点严格接到 cy（含 expandY），无悬空。
    const graph: GraphResultDto = {
      nodes: [
        node(0, 0, 0, 'a'),
        node(1, 1, 1, 'b'),
        node(2, 2, 2, 'c'),
        node(3, 3, 2, 'd'),
      ],
      edges: [
        { fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, color: 0, type: 0 },
        { fromRow: 1, toRow: 2, fromLane: 1, toLane: 2, color: 0, type: 0 },
        { fromRow: 2, toRow: 3, fromLane: 2, toLane: 3, color: 0, type: 0 },
      ],
      maxLane: 3,
      truncated: false,
    };
    (graph as any).branches = [{
      color: 0,
      lines: [
        line({ x1: 0, y1: 0, x2: 1, y2: 2 }),
        line({ x1: 1, y1: 2, x2: 2, y2: 3 }),
      ],
      end: 4,
      colorIndex: 0,
    }];
    const r = renderGraphVscode(graph, { expandedAt: 0 });

    const nodeA = r.nodes.find((n) => n.row === 0);
    const nodeD = r.nodes.find((n) => n.row === 3);
    assert.ok(nodeA && nodeD, '必须有 a 和 d 节点');
    assert.equal(nodeA!.cy, VSCODE_OFFSET_Y, 'node a.cy 应不变（expandedAt 行）');
    assert.equal(nodeD!.cy, 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250, 'node d.cy 含 expandY 偏移');

    // 所有 path 端点都至少接近某个节点 cy 或转场点（node.cy ± gridY），不能悬空到 1/2 行中间
    //
    // v0.8.35.x 更新：转场点 = sy1+gridY（lockedFirst=true 上端锁）或 sy2-gridY
    //   （lockedFirst=false 下端锁）—— 转场点是合法的 path 点，**不需要接近 dot cy**。
    //   v0.8.26 隐含假设"所有 path 端点都接近 dot cy"是错的，转场点天然在 dot 行底。
    //   放宽断言：path y 必须 >= 所有 dot cy - gridY 且 <= 所有 dot cy + gridY
    //   （即不能悬空到 node 行 1/2 中间）
    const allPathYs = r.paths.flatMap((p) => extractEndpoints(p.d).map((pt) => pt.y));
    const nodeCys = r.nodes.map((n) => n.cy);
    const minDotCy = Math.min(...nodeCys);
    const maxDotCy = Math.max(...nodeCys);
    const tol = VSCODE_GRID_Y;
    for (const py of allPathYs) {
      // 转场点 = sy+gridY (在 dot 下方 1 行内)，或 sy-gridY (在 dot 上方 1 行内)
      const isTransferPoint = nodeCys.some((cy) => Math.abs(py - (cy + VSCODE_GRID_Y)) <= 1)
        || nodeCys.some((cy) => Math.abs(py - (cy - VSCODE_GRID_Y)) <= 1);
      const isEndpointClose = nodeCys.some((cy) => Math.abs(py - cy) <= tol);
      assert.ok(
        isTransferPoint || isEndpointClose || (py >= minDotCy - VSCODE_GRID_Y && py <= maxDotCy + VSCODE_GRID_Y),
        `path y=${py} 偏离所有节点 cy=${JSON.stringify(nodeCys)}，端点悬空！`,
      );
    }
  });

  test('LockedFirst=true 跨 multi-row 跨 lane line 跨 expandedAt：端点严格落到 dot cy', () => {
    // 拓扑：feature branch tip (row 0 lane 1) parent→main HEAD (row 5 lane 0)
    //       line (0,5)→(1,0) lockedFirst=true (parent @ child=main; child 在 row 0 上端)
    //       expandedAt = 3 (中间行)
    //
    // y1=5*VSCODE_GRID_Y+VSCODE_OFFSET_Y+250=402 (row 5 > expandedAt=3，偏移)
    // y2=0*VSCODE_GRID_Y+VSCODE_OFFSET_Y=12 (row 0 <= expandedAt=3，不偏移)
    // pushSplit 看到 y2-y1=-390, abs=390 > 1.5*VSCODE_GRID_Y=36，x1!==x2 走拆段
    // lockedFirst=true: 转场点 mid = sy1+VSCODE_GRID_Y = 402+24=426（上端行底）
    // 竖直段从 y=426 到 y=12，穿过 expandY 空隙，无断线
    //
    // 关键断言：line 端点严格落到 head.cy (row 0) 和 main.cy (row 5+expandY)。
    const graph: GraphResultDto = {
      nodes: [
        node(0, 1, 1, 'head'),
        node(5, 0, 0, 'main'),
      ],
      edges: [
        { fromRow: 0, toRow: 5, fromLane: 1, toLane: 0, color: 0, type: 0 },
      ],
      maxLane: 1,
      truncated: false,
    };
    (graph as any).branches = [{
      color: 0,
      lines: [
        line({ x1: 0, y1: 5, x2: 1, y2: 0, lockedFirst: true }),
      ],
      end: 6,
      colorIndex: 0,
    }];
    const r = renderGraphVscode(graph, { expandedAt: 3 });

    const headNode = r.nodes.find((n) => n.row === 0);
    const mainNode = r.nodes.find((n) => n.row === 5);
    assert.ok(headNode && mainNode, '必有 head 和 main 节点');
    assert.equal(headNode!.cy, VSCODE_OFFSET_Y, `head.cy 应不变 = 12（expandedAt 上方 3 行不偏移），实测=${(headNode!.cy).toFixed(1)}`);
    assert.equal(mainNode!.cy, 5 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250, `main.cy 应 = 5*${VSCODE_GRID_Y}+${VSCODE_OFFSET_Y}+250（含 expandY），实测=${(mainNode!.cy).toFixed(1)}`);

    // 所有 path 端点 y 都接近某个节点 cy 或转场点（node.cy ± gridY），无悬空
    // v0.8.35.x 更新：转场点 = sy1+gridY（lockedFirst=true）或 sy2-gridY
    //   （lockedFirst=false），是合法的 path 点，**不需要接近 dot cy**。
    const allPathYs = r.paths.flatMap((p) => extractEndpoints(p.d).map((pt) => pt.y));
    const nodeCys = r.nodes.map((n) => n.cy);
    const tol = VSCODE_GRID_Y; // 转场点距 node.cy 最大为 gridY
    const minDotCy = Math.min(...nodeCys);
    const maxDotCy = Math.max(...nodeCys);
    for (const py of allPathYs) {
      const isTransferPoint = nodeCys.some((cy) => Math.abs(py - (cy + VSCODE_GRID_Y)) <= 1)
        || nodeCys.some((cy) => Math.abs(py - (cy - VSCODE_GRID_Y)) <= 1);
      const isEndpointClose = nodeCys.some((cy) => Math.abs(py - cy) <= tol);
      assert.ok(
        isTransferPoint || isEndpointClose || (py >= minDotCy - VSCODE_GRID_Y && py <= maxDotCy + VSCODE_GRID_Y),
        `path y=${py} 偏离所有节点 cy=${JSON.stringify(nodeCys)}，端点悬空！`,
      );
    }
  });

  test('无 expandedAt 时 multi-row line 不拆分 (回归不动既有默认状态)', () => {
    const graph: GraphResultDto = {
      nodes: [
        node(0, 0, 0, 'a'),
        node(1, 0, 0, 'b'),
      ],
      edges: [{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0, type: 0 }],
      maxLane: 0,
      truncated: false,
    };
    (graph as any).branches = [{ color: 0, lines: [line({ x1: 0, y1: 0, x2: 0, y2: 1 })], end: 2, colorIndex: 0 }];
    const r = renderGraphVscode(graph);
    const d = r.paths[0]?.d ?? '';
    assert.ok(d.includes(`L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}`), `默认状态回归: path 应有 L ${VSCODE_OFFSET_X} ${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}（y2=1*${(VSCODE_GRID_Y).toFixed(1)}+${(VSCODE_OFFSET_Y).toFixed(1)}=${(VSCODE_OFFSET_Y + VSCODE_GRID_Y).toFixed(1)}），实测: ${d}`);
  });
});

// =====================================================================================
// v0.8.35.x：跨 lane 单行 stitch line（merge stitch 入线 / fork stitch 出线）渲染修复
//
// 用户 2026-07-31 实测反馈：
//   "这种孤立的 lane 展开后，连线就会出现错误"
//
// 截图（展开 `feat: add clean feature` commit 详情）：
//   - 橙色 lane（feature lane）从某个 main commit fork 到右 lane，单 commit feature tip
//   - 折叠态：橙色 line 形态正常（merge stitch 转场紧贴 merge dot）
//   - 展开后：橙色 line "钩子" 形态错位、转场曲线超出 dot 下方
//
// 根因（v0.8.26.x 未覆盖的边角）：
//   pushSplit 触发条件 `Math.abs(sy2 - sy1) > gridY * 1.5` —— 当 merge stitch 入线
//   dy=1 行时（merge commit 在 row N lane 0，feature tip 在 row N-1 lane X，X>0），
//   |sy2-sy1| = gridY（28） < 1.5*28 = 42 → 不触发 pushSplit
//   → 走整段贝塞尔 C，控制点 y = y1 + gridY * 0.8 = y1 + 22.4
//   → 控制点超出 merge dot 下沿 22.4 px，曲线"溢出"到下一行 DOM 区域
//   → 折叠态视觉上"勉强能看"，展开后因为 expandY=250 让 dot 整体下移，
//     控制点溢出相对位置被放大到看不见/脱离主 lane（视觉错误）。
//
// GitLens 实测形态（正确行为）：
//   不管 dy=1 还是 dy=N 行，跨 lane stitch line 都应该走「转场段（≤ 1 行高）+ 竖直段」形态
//   转场段终点严格落到语义端点 dot（不允许控制点溢出）
//   转场段起点是 lane 切换开始处（lockedFirst=true → sy1 + gridY / lockedFirst=false → sy2 - gridY）
//
// 修法：pushSplit 触发阈值改 `>= gridY`（而不是 > gridY * 1.5）—— 任何跨 lane 都走拆段形态。
// 这跟 GitLens 行为一致：转场段高度 = 1 行（gridY），跨 lane line 不画整段贝塞尔。
//
// 测试断言：
//   ① merge stitch 入线 `(0, 4) → (2, 3)` LockedFirst=true 跨 lane：转场段终点精确落到
//      merge dot (lane 0, cy=4*28+12)，不允许控制点溢出到 (cy + gridY) 之外
//   ② 展开 row 3 后 merge stitch 入线仍然精确连到 merge dot（cy + expandY），
//      转场段紧贴 merge dot，不出现"曲线脱离主 lane"的视觉异常
//   ③ fork stitch 出线 `(2, 3) → (0, 4)` LockedFirst=false：转场段终点精确落到
//      merge dot (lane 0, cy=4*28+12+expandY)，转场段紧贴 merge dot 下沿
// =====================================================================================

describe('gitgraph vscode-render — v0.8.35.x 跨 lane 单行 stitch line（merge/fork stitch 强制转场段形态）', () => {
  // helper: 提取 path d 字符串里所有 (x, y) 端点坐标（M / L / C 都取最后坐标）
  // 用于断言"线端点精确接到 dot cy"
  const extractAllPathPoints = (d: string): { x: number; y: number }[] => {
    const points: { x: number; y: number }[] = [];
    // 匹配 M/L 后的 (x, y)，C 后取最后 (x, y)
    const regex = /[ML]\s+([-\d.]+)\s+([-\d.]+)|C\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(d)) !== null) {
      const x = parseFloat(m[1] ?? m[3] ?? '0');
      const y = parseFloat(m[2] ?? m[4] ?? '0');
      points.push({ x, y });
    }
    return points;
  };

  // helper: 找 path d 里 y 值最近某个 target y 的点 (允许 gridY/2 容差)
  const findPointNear = (
    points: { x: number; y: number }[],
    targetY: number,
    tolerance = VSCODE_GRID_Y / 2,
  ): { x: number; y: number } | null => {
    let best: { x: number; y: number } | null = null;
    let bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.y - targetY);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    }
    if (best && bestDiff <= tolerance) return best;
    return null;
  };

  test('merge stitch 入线 dy=1 行（折叠态）：转场段精确落到 merge dot 和 segment firstRow，GitLens 形态', () => {
    // 拓扑（latest-first）：
    //   row 0: main (lane 0)
    //   row 1: main (lane 0)
    //   row 2: main (lane 0)
    //   row 3: main commit (lane 0)
    //   row 4: merge commit (lane 0) ← mergeRow=4 (newer merge commit)
    //   row 5: feature root (lane 2) ← firstRow=5 (feature segment 第一行)
    //
    // merge stitch 入线：(mergeCol=0, mergeRow=4) → (firstCol=2, firstRow=5)
    //   mergeRow < firstRow（merge 是 newer, firstRow 是 older 历史上更早）
    //   LockedFirst = 0 < 2 = true (转场在上端/merge dot 端)
    //
    // 预期（GitLens 形态）：
    //   转场段 (0, 4) → (2, 5) — 从 merge dot 斜切到 feature root 行底
    //   走 pushSplit 后: 转场段 (16, 124) → (48, 152) + 竖直段 (48, 152) → (48, 152) 退化
    //   path 实际只有 1 段 C 贝塞尔 (16, 124) → (48, 152)，控制点 cp1=(16, 146.4) cp2=(48, 129.6)
    //
    // 关键修复：v0.8.26 pushSplit 阈值 `1.5 * gridY`，dy=gridY=28 < 42 → 不触发
    //   → 整段贝塞尔 → 转场段 (16, 124) → (48, 152) 控制点溢出 merge dot 下方 22.4 px
    //   但**端点精确**接到 merge dot 和 feature root dot
    // v0.8.35.x fix：跨 lane dy ≥ gridY 都走 pushSplit 形态
    //   → 转场段 (16, 124) → (48, 152) + 竖直段 (48, 152) → (48, 152)
    //   → 行为对 1 行 dy 跟 1 行 dy 跟多行 dy 一致（GitLens 实测）
    const graph: GraphResultDto = {
      nodes: [
        node(0, 0, 0, 'main0'),
        node(1, 0, 0, 'main1'),
        node(2, 0, 0, 'main2'),
        node(3, 0, 0, 'main3'),
        node(4, 0, 0, 'merge'),
        node(5, 2, 1, 'featRoot'),
      ],
      edges: [],
      branches: [{
        color: 1,
        end: 6,
        lines: [line({ x1: 0, y1: 4, x2: 2, y2: 5, lockedFirst: true })],
      }],
      maxLane: 2,
      truncated: false,
    };
    const r = renderGraphVscode(graph);
    const d = r.paths[0]?.d ?? '';

    // 端点必须严格接到 merge dot (16, 124) 和 feature root dot (48, 152)
    const mergeDotY = 4 * VSCODE_GRID_Y + VSCODE_OFFSET_Y;  // 124
    const featRootDotY = 5 * VSCODE_GRID_Y + VSCODE_OFFSET_Y; // 152
    const allPts = extractAllPathPoints(d);
    assert.ok(findPointNear(allPts, mergeDotY), `merge stitch 端点必须接近 merge dot y=${mergeDotY}，所有点: ${JSON.stringify(allPts)}`);
    assert.ok(findPointNear(allPts, featRootDotY), `merge stitch 端点必须接近 feature root dot y=${featRootDotY}，所有点: ${JSON.stringify(allPts)}`);

    // GitLens 形态：贝塞尔控制点 cp1.y = y1 + gridY*0.8 = 124 + 22.4 = 146.4
    // cp1.y 在 merge dot 下方 22.4 px —— 这是**正常的贝塞尔曲线控制点偏移**，
    // vscode-git-graph Branch.draw:139 同样会算出 cp1.y = y1 + d = 124 + 22.4 = 146.4。
    // 不要断言 cp1.y <= mergeDot.cy + gridY/2（之前断言错了）
    //
    // 关键断言：path 端点不悬空，必须接近 merge dot 或 feature root dot
    for (const p of allPts) {
      const closeToMerge = Math.abs(p.y - mergeDotY) <= VSCODE_GRID_Y;
      const closeToFeatRoot = Math.abs(p.y - featRootDotY) <= VSCODE_GRID_Y;
      assert.ok(
        closeToMerge || closeToFeatRoot,
        `merge stitch path 点 y=${p.y} 偏离 merge dot (${mergeDotY}) 或 feature root dot (${featRootDotY})，
         v0.8.26 旧行为可能输出悬空控制点。\n完整 path: ${d}`
      );
    }
  });


  test('跨 lane 多行 stitch line 走 pushSplit（回归 v0.8.26.x 不动）', () => {
    // 拓扑：merge stitch 入线 (0, 4) → (2, 0)，dy=4 行
    //   转场段 (0, 4) → (2, 4+1) = (0, 124) → (2, 152) (lockedFirst=true 上端转场)
    //   竖直段 (2, 152) → (2, 12)
    //
    // 这个测试 v0.8.26 已经覆盖（lines 351-393），确保我们的修复不影响旧行为
    const graph: GraphResultDto = {
      nodes: [node(0, 2, 1, 'feat'), node(4, 0, 0, 'merge')],
      edges: [],
      branches: [{
        color: 1,
        end: 5,
        lines: [line({ x1: 0, y1: 4, x2: 2, y2: 0, lockedFirst: true })],
      }],
      maxLane: 2,
      truncated: false,
    };
    const r = renderGraphVscode(graph);
    const d = r.paths[0]?.d ?? '';

    // 转场段必须在 row 4（merge dot 下方 1 行高内完成 lane 切换）
    // 旧 pushSplit 阈值：|sy2-sy1| = 4 * gridY = 112 > 1.5 * gridY = 42 → 触发
    // 新阈值（>= gridY）：|sy2-sy1| = 112 > 28 → 也触发
    //   行为不变：转场段 + 竖直段
    const mergeDotY = 4 * VSCODE_GRID_Y + VSCODE_OFFSET_Y; // 124
    const allPts = extractAllPathPoints(d);

    // 端点必须接近 merge dot 和 feat dot
    assert.ok(findPointNear(allPts, mergeDotY), `端点必须接近 merge dot y=${mergeDotY}`);
    assert.ok(findPointNear(allPts, VSCODE_OFFSET_Y), `端点必须接近 feat dot y=${VSCODE_OFFSET_Y}`);

    // 不应该有控制点 y > mergeDotY + gridY = 152
    for (const p of allPts) {
      assert.ok(p.y <= mergeDotY + VSCODE_GRID_Y, `控制点 y=${p.y} 超出 merge dot 下 1 行高`);
    }
  });

  test('fork stitch 出线 dy=1 行（折叠态）：GitLens 形态 + 端点接到 feat tip dot 和 merge dot', () => {
    // 用户 2026-07-31 实测 bug 核心场景：fork stitch 出线 (lastCol=2, lastRow=3) → (forkCol=0, forkRow=4)
    // LockedFirst=false（feature lane 在右，merge 在左 → 转场在下端）
    //
    // v0.8.26 pushSplit 阈值 `1.5 * gridY = 42`，dy=gridY=28 < 42 → 不触发
    //   → 整段贝塞尔，控制点 y1+gridY*0.8 = 96+22.4 = 118.4 在 feat tip dot 上方 22.4 px
    //   → 视觉："钩子上飘" —— 用户实测反馈
    // v0.8.35.x fix pushSplit 阈值 `>= gridY`，跨 lane dy=1 行也走转场段 + 竖直段形态
    //   → 竖直段 (32, 96) → (32, 124) ← feat lane 行底竖直到转场点
    //   → 转场段 (32, 124) → (16, 124) ← lane 2 → lane 0，转场在下端
    //
    // 关键断言：所有 path 点 y 必须接近 feat tip dot (96) 或 merge dot (124) 或转场点
    const graph: GraphResultDto = {
      nodes: [
        node(0, 0, 0, 'main0'),
        node(3, 2, 1, 'feat'),
        node(4, 0, 0, 'merge'),
      ],
      edges: [],
      branches: [{
        color: 1,
        end: 5,
        lines: [line({ x1: 2, y1: 3, x2: 0, y2: 4, lockedFirst: false })],
      }],
      maxLane: 2,
      truncated: false,
    };
    const r = renderGraphVscode(graph);
    const d = r.paths[0]?.d ?? '';

    const featDotY = 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y;   // 96
    const mergeDotY = 4 * VSCODE_GRID_Y + VSCODE_OFFSET_Y; // 124
    const allPts = extractAllPathPoints(d);
    assert.ok(findPointNear(allPts, featDotY), `fork stitch 端点必须接近 feat tip dot y=${featDotY}，所有点: ${JSON.stringify(allPts)}`);
    assert.ok(findPointNear(allPts, mergeDotY), `fork stitch 端点必须接近 merge dot y=${mergeDotY}，所有点: ${JSON.stringify(allPts)}`);

    // 所有 path 点 y 必须接近 feat tip dot (96) 或 merge dot (124) 或转场点 (124-gridY=96 已在 featDotY 范围内)
    for (const p of allPts) {
      const closeToFeat = Math.abs(p.y - featDotY) <= VSCODE_GRID_Y;
      const closeToMerge = Math.abs(p.y - mergeDotY) <= VSCODE_GRID_Y;
      assert.ok(
        closeToFeat || closeToMerge,
        `fork stitch path 点 y=${p.y} 偏离 feat tip dot (${featDotY}) 或 merge dot (${mergeDotY})，
         v0.8.26 旧行为可能输出悬空控制点。\n完整 path: ${d}`
      );
    }
  });

  test('fork stitch 出线 dy=1 行跨 expandedAt=3：端点接到 feat tip dot 和 merge dot（含 expandY），不悬空', () => {
    // 同上拓扑，展开 row 3（feat tip 所在行）
    // row 3 dot (feat tip, lane 2) cy = 96 (不偏移, expandedAt 行不偏移)
    // row 4 dot (merge commit, lane 0) cy = 124 + 250 = 374 (row 4 > expandedAt, +expandY)
    //
    // 关键断言：所有 path 点必须接近 feat tip dot (3*VSCODE_GRID_Y+VSCODE_OFFSET_Y) 或 merge dot (4*VSCODE_GRID_Y+VSCODE_OFFSET_Y+250)，不能悬空
    const graph: GraphResultDto = {
      nodes: [
        node(0, 0, 0, 'main0'),
        node(3, 2, 1, 'feat'),
        node(4, 0, 0, 'merge'),
      ],
      edges: [],
      branches: [{
        color: 1,
        end: 5,
        lines: [line({ x1: 2, y1: 3, x2: 0, y2: 4, lockedFirst: false })],
      }],
      maxLane: 2,
      truncated: false,
    };
    const r = renderGraphVscode(graph, { expandedAt: 3, expandY: 250 });

    const mergeNode = r.nodes.find((n) => n.row === 4)!;
    const featNode = r.nodes.find((n) => n.row === 3)!;
    assert.equal(mergeNode.cy, 4 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250, 'merge dot cy 含 expandY');
    assert.equal(featNode.cy, 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y, 'feat dot cy 不偏移');

    const d = r.paths[0]?.d ?? '';
    const allPts = extractAllPathPoints(d);

    assert.ok(findPointNear(allPts, mergeNode.cy), `fork stitch 端点必须接近 merge dot cy=${mergeNode.cy}，所有点: ${JSON.stringify(allPts)}`);
    assert.ok(findPointNear(allPts, featNode.cy), `fork stitch 端点必须接近 feat dot cy=${featNode.cy}`);

    for (const p of allPts) {
      const closeToMerge = Math.abs(p.y - mergeNode.cy) <= VSCODE_GRID_Y;
      const closeToFeat = Math.abs(p.y - featNode.cy) <= VSCODE_GRID_Y;
      assert.ok(
        closeToMerge || closeToFeat,
        `fork stitch path 点 y=${p.y} 偏离 feat dot (${featNode.cy}) 或 merge dot (${mergeNode.cy})，
         v0.8.35.x 修复后端点应精确。\n完整 path: ${d}`
      );
    }
  });
});
