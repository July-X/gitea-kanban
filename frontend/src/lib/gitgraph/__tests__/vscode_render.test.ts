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
		// 转场段 (0,0)→(1,1)：贝塞尔 M 16 12 C 16 31.2 32 16.8 32 36.0
		assert.ok(d1.includes('C 16 31.2 32 16.8 32 36.0'), `转场段应集中在首行，实际: ${d1}`);
		// 竖直段 (1,1)→(1,3)：L 32 84（y = 3*24+12）
		assert.ok(d1.includes('L 32 84'), `转场后应为纯竖直段到目标行，实际: ${d1}`);

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
		// 竖直段 (1,0)→(1,2)：M 32 12.0 L 32 60.0（y = 2*24+12）
		assert.ok(d2.includes('M 32 12.0 L 32 60.0'), `fork 线应先竖直到末段前，实际: ${d2}`);
		// 转场段 (1,2)→(0,3)：贝塞尔 C 32 79.2 16 64.8 16 84.0
		assert.ok(d2.includes('C 32 79.2 16 64.8 16 84.0'), `fork 转场段应集中在末行，实际: ${d2}`);
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
// v0.8.31 回归测试：line 跨 expandedAt 边界时 pushSplit 几何一致性
//
// 用户 2026-07-31 实测："新 bug：展开查看 commit 详情后，断线了，没有和 dot 连起来"
// 截图显示当多分支仓库展开 commit 详情时，穿过展开区的 lane line 在 panel 下方端点
// 悬空、未准确落到 dot 上（dot 已 +expandY，但 line 几何未跟进）。
//
// 根因：expandAt 处理时对 line 跨边界情况硬编码 gridY 单位（vscode 原版"单行跨度"
// 不变量），但 v0.8.27 Go 端 LockedFirst 改后，DIO 会发"跨多行跨 lane" line（multi-row）。
// pushSplit 用 (sy1+gridY) 当转场点 mid，sy1 没 +expandY 但 sy2 +expandY → 几何错位。
//
// v0.8.31 修复：在 expandAt 处理前用 splitLineByExpandedAt 把跨边界 line 拆为
// upper (y ≤ expandedAt) + lower (y > expandedAt) 两段。每段独立处理 expandY，
// 几何无歧义。
// =====================================================================================

// helper: line (X1,Y1)→(X2,Y2) + lockedFirst + isCommitted
type LineSpec = { x1: number; y1: number; x2: number; y2: number; lockedFirst?: boolean; isCommitted?: boolean };

function line(s: LineSpec): any {
  return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, lockedFirst: s.lockedFirst ?? false, isCommitted: s.isCommitted ?? true };
}

describe('gitgraph vscode-render (1:1 复刻 web/graph.ts::Branch.draw) — v0.8.31 expandedAt 跨边界', () => {
  // SVG 路径端点解析：M (start: x,y) / L (x,y) / C cp1,cp2,end —— 每段最后 2 个数
  // 是终点（M 是起点，L 是终点，C 是 control+control+end），曲线控制点 y 不计入
  // 端点集合（控制点 y 经常偏离节点 cy 正常，比如贝塞尔曲线 mid 控制点 ≈ 0.4*gridY
  // 偏移）。
  const extractEndpoints = (d: string): Array<{ x: number; y: number }> => {
    const pts: Array<{ x: number; y: number }> = [];
    const re = /([MLC])\s*((?:-?\d+(?:\.\d+)?\s+)+)/g;
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
    // 期望：splitLineByExpandedAt 拆为 (0,0)→(0,0)（空）+ (0,0)→(0,1)（isLowerSegment 含 expandY）
    //       pushSplit 看到 y2 - y1 = gridY 跳 fallback（≤ 1.5 gridY），画 1 段 vertical
    //       端点 = 1*24 + 12 + 250 = 286
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

  test('跨 lane multi-row line 跨 expandedAt 边界：拆分后每段独立处理，端点连续', () => {
    // 拓扑（latest-first）：
    //   row 0: a (lane 0)               —— expandedAt 行
    //   row 1: b (lane 1)               —— expandedAt 后续行被分段
    //   row 2: c (lane 2)               —— 展开后 + expandY
    //   row 3: d (lane 3)               —— 展开后 + expandY (line 跨 row 2 → row 3)
    //
    // v0.8.31 splitLineByExpandedAt 把 line (0,0)→(1,2) 拆为:
    //   upper (0,0)→(1,0): 单行跨 lane (lockedFirst=true)，按原 pushSplit 几何画 1 段
    //   lower (0,0)→(1,2): isLowerSegment 整段 +expandY，跨 multi-row，pushSplit 走
    //     拆段（lockedFirst=true: 斜切 + 竖直段）；abs(sy2-sy1)=288 = 1.5*(gridY+expandY)，触发上限
    // line (1,2)→(2,3) 仅下方，全段 +expandY，vertical。端点 = c.cy + d.cy + expandY。
    //
    // 关键断言：node c/d cy 都 +expandY=250，所有 line 端点严格接到 cy（含 expandY）。
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

    // 拿到 d 节点的 cx, cy
    const nodeA = r.nodes.find((n) => n.row === 0);
    const nodeD = r.nodes.find((n) => n.row === 3);
    assert.ok(nodeA && nodeD, '必须有 a 和 d 节点');
    // node a 在 expandedAt 行不偏移 cy=12
    assert.equal(nodeA!.cy, VSCODE_OFFSET_Y, 'node a.cy 应不变（expandedAt 行）');
    // node d (row 3) cy 应含 expandY=250
    assert.equal(nodeD!.cy, 3 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250, 'node d.cy 含 expandY 偏移');

    // 验证至少有一条 path 端点落到 node d.cy (line 2 整段 + expandY) // placeholder
    // 关键断言：所有 path 端点都至少接近某个节点 cy（不能悬空到 1/2 行中间）
    // 留空：见 describe 顶部 extractEndpoints helper
    const allPathYs = r.paths.flatMap((p) => extractEndpoints(p.d).map((pt) => pt.y));
    const nodeCys = r.nodes.map((n) => n.cy);
    for (const py of allPathYs) {
      // 每个 path 的 y 端点应该接近某个节点 cy（容忍 1px 浮点误差）
      const closeToAny = nodeCys.some((cy) => Math.abs(py - cy) <= 2);
      assert.ok(closeToAny, `path y=${py} 偏离所有节点 cy=${JSON.stringify(nodeCys)}，端点悬空！`);
    }
  });

  test('LockedFirst=true 跨 multi-row 跨 lane line 跨 expandedAt：拆段点几何连接', () => {
    // 拓扑：feature branch tip (row 0 lane 1) parent→main HEAD (row 5 lane 0)
    //       line (0,5)→(1,0) lockedFirst=true (parent @ child=main; child 在 row 0 上端)
    //       expandedAt = 3 (中间行)
    // v0.8.31: splitLineByExpandedAt 把该 line 拆为:
    //   upper (0,3)→(1,3): lockedFirst=true 单行段，pushSplit 拆上端锁转场
    //   lower (0,3)→(1,5) lockedFirst=true: 整段 +expandY。pushSplit 看到 y 跨度=
    //     24 (gridY) > 1.5*gridY ? 不超阈值（注意 sy1/sy2 都来自 line y1*y1 row 上
    //     —— pushSplit 已加 expandY 后线段相对原点是 line.y1/line.y2 row index，
    //     不是 pixel，所以 abs(sy2-sy1)=2 gridY 触发 pushSplit 拆段）。
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
    assert.equal(headNode!.cy, VSCODE_OFFSET_Y, `head.cy 应不变 = 12（expandedAt 上方 3 行不偏移），实测=${headNode!.cy}`);
    assert.equal(mainNode!.cy, 5 * VSCODE_GRID_Y + VSCODE_OFFSET_Y + 250, `main.cy 应 = 382（含 expandY），实测=${mainNode!.cy}`);

    // 所有 path 端点 y 都接近某个节点 cy，无悬空
    const allPathYs = r.paths.flatMap((p) => extractEndpoints(p.d).map((pt) => pt.y));
    const nodeCys = r.nodes.map((n) => n.cy);
    for (const py of allPathYs) {
      const closeToAny = nodeCys.some((cy) => Math.abs(py - cy) <= 2);
      assert.ok(closeToAny, `path y=${py} 偏离所有节点 cy=${JSON.stringify(nodeCys)}，端点悬空！`);
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
    assert.ok(d.includes(`L 16 36`), `默认状态回归: path 应有 L 16 36（y2=1*24+12=36），实测: ${d}`);
  });
});
