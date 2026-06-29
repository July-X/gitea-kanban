/**
 * vscode-git-graph 风格 SVG 渲染 (1:1 复刻 web/graph.ts::Branch.draw)
 *
 * 对应源码 vscode-git-graph/web/graph.ts(参考版本 1.30.0):
 *   - GraphConfig            : graph.ts:50-60 (config.grid / config.colours / config.style)
 *   - GraphStyle.Rounded     : graph.ts:138-140 (C 贝塞尔)
 *   - GraphStyle.Angular     : graph.ts:136-137 (L 折线 + 38% 拐点)
 *   - Branch.draw            : graph.ts:75-147 (核心:line 简化 + path 拼接)
 *   - Branch.drawPath        : graph.ts:149-159 (line + shadow + uncommitted stroke)
 *   - Vertex.draw            : graph.ts:298-331 (圆点 + stash 双圈)
 *
 * 与旧 renderGraph(structured.ts) 的差别:
 *   - 路径起点 = commit 顶部 (row * grid.y + offsetY),而非中心
 *   - 跨列转场用 C 贝塞尔 (rounded) / L 折线 (angular),非斜线
 *   - lane 间距 = GRID_X (= 16, vscode 默认),而非 LANE_WIDTH (= 10)
 *   - 行高 = GRID_Y (= 24, vscode 默认),而非 ROW_HEIGHT (= 30)
 *   - 颜色调色板对齐 vscode-git-graph 默认 16 色
 *   - 顶点是 SVG <circle> (而非 div overlay),与 path 同坐标系
 *
 * 用法:
 *   const r = renderGraphVscode(graph);
 *   // r.paths: SvgPath[], r.nodes: SvgNode[], r.width, r.height
 *   // r.style: 'rounded' | 'angular'
 */

import type { GraphNodeDto, GraphResultDto } from './structured.js';

// vscode 默认 grid 配置 (对齐 graph.ts GraphConfig 默认值)
export const VSCODE_GRID_X = 16;
export const VSCODE_GRID_Y = 24;
export const VSCODE_OFFSET_X = 4;
export const VSCODE_OFFSET_Y = 4;
export const VSCODE_VERTEX_RADIUS = 4;
export const VSCODE_EXPAND_Y = 250; // vscode config.ts:278 expandY 默认值

// 对齐 vscode-git-graph web/graph.ts config.colours 默认 16 色
// (与 layout.go 注释里提到的 graphColours 数组一致)
export const VSCODE_COLORS = [
	'#0085d9', // 0
	'#d9008f', // 1
	'#00d90a', // 2
	'#d98500', // 3
	'#a300d9', // 4
	'#ff0000', // 5
	'#00d9cc', // 6
	'#e138e8', // 7
	'#85d900', // 8
	'#dc5b23', // 9
	'#6f24d6', // 10
	'#ffcc00', // 11
];

export type VscodeGraphStyle = 'rounded' | 'angular';

export interface VscodeSvgPath {
	d: string;
	colorIndex: number;
	colorHex: string;
	order: number;
}

export interface VscodeSvgNode {
	cx: number;
	cy: number;
	r: number;
	sha: string;
	shortSha: string;
	subject: string;
	authorName: string;
	authorEmail: string;
	date: string;
	isMerge: boolean;
	row: number;
	lane: number;
	refs?: string[];
	refTypes?: string[];
	colorHex: string;
	isCurrent?: boolean; // HEAD 标记 (vscode Vertex.draw 画成空心 stroke-only)
	isStash?: boolean;
}

export interface VscodeSvgRenderResult {
	paths: VscodeSvgPath[];
	nodes: VscodeSvgNode[];
	width: number;
	height: number;
	style: VscodeGraphStyle;
}

/**
 * renderGraphVscode —— 1:1 复刻 vscode-git-graph 的 SVG 渲染。
 *
 * 输入: Go 端 BuildGraphVscodeWithHead 输出的 GraphResultDto
 * 输出: 路径 + 圆点 + 尺寸,直接喂给 <svg> 渲染
 *
 * 算法:
 *   1. 重建 vscode 内部数据: Vertex + Branch
 *   2. Branch.draw: 把每条 line 转成像素坐标,同列合并,跨列用 C (rounded) / L (angular)
 *   3. Vertex.draw: 圆心 (x*GRID_X+OFFSET_X, id*GRID_Y+OFFSET_Y)
 *
 * 关键简化:
 *   - vscode 在 Branch 内部维护 Line 列表(跨多 commit 的"轨道")
 *   - 我们从 edges 重建:把每条 EdgeNormal/EdgeBranch/EdgeMerge 转成 line 段
 *   - 同 color 的连续 line 段合并为一条 path,模拟 vscode 的 Branch.draw 行为
 */
export function renderGraphVscode(
	graph: GraphResultDto,
	options?: { style?: VscodeGraphStyle; expandedAt?: number | null },
): VscodeSvgRenderResult {
	const style = options?.style ?? 'rounded';
	const expandedAt = options?.expandedAt ?? null;

	const nodes: VscodeSvgNode[] = [];
	const paths: VscodeSvgPath[] = [];

	// ===== 1. 收集 node 信息 (vertex 数据) =====
	const nodesByRow = new Map<number, GraphNodeDto>();
	const nodesBySha = new Map<string, GraphNodeDto>();
	for (const node of graph.nodes) {
		nodesByRow.set(node.row, node);
		nodesBySha.set(node.sha, node);
	}

	// SHA 集合: 保留接口(后续用于 in-view 过滤 edge), 暂时不直接用
	// const visibleShas = new Set(nodesBySha.keys());

	// ===== 2. 重建 Branch + Line =====
	//
	// vscode 算法中:
	//   - 每个 commit 会被挂到某个 Branch 上(merge stitch 例外)
	//   - Branch 沿 commit row 链绘制 line
	//   - 我们从 edges 倒推: 把每条 edge (from, to) 看作一个 line 段
	//   - 按 (fromLane) 分组,组内按 (fromRow 升序) 串接
	//
	// 简化策略: 把每个 flow 看成一条 lane 上的连续线。
	//   - EdgeNormal: (fromRow, fromLane) → (toRow, toLane) 直线/曲线
	//   - EdgeBranch: 跨 lane 分叉,从 fromLane 到 toLane
	//   - EdgeMerge: 跨 lane 汇入, 从 fromLane 到 toLane
	//   - 把 (from, to) 看成 vscode 的 Line(p1, p2)
	//
	// vscode Branch.draw 的核心: line 之间的"中间点"会被合并(同列共线),
	// 然后所有 line 拼成一条 SVG path。这要求 line 列表是"沿同一 flow"
	// 的连续段,而不是随意拼接。
	//
	// 为简单起见, 我们按 color (等价于 Branch.colour) 分组, 同 color 的
	// edge 串起来形成一条 path。这跟 vscode 的视觉效果几乎一致(同 flow
	// 必然同 color)。
	
	// 直接用 Go 端 BuildGraphVscode 暴露的 branch 列表 (1:1 复刻 vscode Branch)

	// ===== 3. Branch.draw 复刻: 把每条 line 转 SVG path d =====
	// d 系数移到循环内部 (3 步), 按紧凑策略选小 dy ≈ dot 半径

	const addPath = (color: number, dStr: string, order: number): void => {
		paths.push({
			d: dStr,
			colorIndex: color,
			colorHex: VSCODE_COLORS[color % VSCODE_COLORS.length] ?? VSCODE_COLORS[0],
			order,
		});
	};

	for (let branchIdx = 0; branchIdx < (graph.branches ?? []).length; branchIdx++) {
		const branch = (graph.branches ?? [])[branchIdx]!;
		const color = branch.color;
		const lines = branch.lines;
		// 1) 把 line 转成像素坐标,处理 expandAt (vscode Branch.draw:78-103)
		const placed: Array<{
			p1: { x: number; y: number };
			p2: { x: number; y: number };
			lockedFirst: boolean;
		}> = [];
		for (const line of lines) {
			let x1 = line.x1 * VSCODE_GRID_X + VSCODE_OFFSET_X;
			let y1 = line.y1 * VSCODE_GRID_Y + VSCODE_OFFSET_Y;
			let x2 = line.x2 * VSCODE_GRID_X + VSCODE_OFFSET_X;
			let y2 = line.y2 * VSCODE_GRID_Y + VSCODE_OFFSET_Y;

			// expandAt 处理: 展开 commit 详情时,下方所有 line 自动"延伸"
			// (vscode Branch.draw:85-101)
			if (expandedAt !== null && expandedAt >= 0) {
				if (line.y1 > expandedAt) {
					y1 += VSCODE_EXPAND_Y;
					y2 += VSCODE_EXPAND_Y;
				} else if (line.y2 > expandedAt) {
					if (x1 === x2) {
						// 垂直线 - 终点延伸
						y2 += VSCODE_EXPAND_Y;
					} else {
						// 跨 lane - 锁定方向延伸
						if (line.lockedFirst) {
							// 转场在 p1 端:保持原转场,再延伸到 p2 端
							placed.push({
								p1: { x: x1, y: y1 },
								p2: { x: x2, y: y2 },
								lockedFirst: line.lockedFirst,
							});
							placed.push({
								p1: { x: x2, y: y1 + VSCODE_GRID_Y },
								p2: { x: x2, y: y2 + VSCODE_EXPAND_Y },
								lockedFirst: line.lockedFirst,
							});
							continue;
						} else {
							// 转场在 p2 端:先延伸到 p2 上方,再做转场
							placed.push({
								p1: { x: x1, y: y1 },
								p2: { x: x1, y: y2 - VSCODE_GRID_Y + VSCODE_EXPAND_Y },
								lockedFirst: line.lockedFirst,
							});
							y1 += VSCODE_EXPAND_Y;
							y2 += VSCODE_EXPAND_Y;
						}
					}
				}
			}
			placed.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, lockedFirst: line.lockedFirst });
		}

		// 2) 简化共线中间点 (vscode Branch.draw:106-116)
		// vscode 的逻辑: 只看 last.p2 == seg.p1 (首尾相接), 不看 column。
		// 跨 lane 后如果 p2 落在 dot 上, 下一条从该 dot 出发的 line 就续接。
		// 我们的 edges 是按 LogCommits 顺序, 不保证这个性质, 所以把
		// "首尾相接" 放宽为简化条件, 保留 vscode Branch.draw 同样的拼 path 逻辑。
		const simplified: typeof placed = [];
		for (const seg of placed) {
			const last = simplified[simplified.length - 1];
			if (
				last &&
				last.p2.x === seg.p1.x &&
				last.p2.y === seg.p1.y
			) {
				// 首尾相接: 合并,延长 last 的 p2
				last.p2.x = seg.p2.x;
				last.p2.y = seg.p2.y;
			} else {
				simplified.push(seg);
			}
		}

		// 3) 拼成 path d 字符串 (vscode Branch.draw:118-146)
		//
		// 关键: vscode 的 line list 是 "按 column 顺时针串行" 的连续序列,
		//       所以同 branch 的连续 line 经常 last.p2 == next.p1, 可以用
		//       单一 path + 多个 L/C 续接; 但跨 lane 后 line 跟 dot 在
		//       不同 column, 只能新开 M。
		//
		// 我们的数据是 "按 color 分组的 edge list", 顺序是 LogCommits 顺序,
		// 跟 vscode 的 Branch.line list 不完全一致。所以采取更稳健的策略:
		//   - 同列共线 (simplify 已合并)
		//   - 跨 lane 永远不续接, 新开 M (避免 column 0 主线被错误延长)
		//   - 跨 lane 转场用 C 贝塞尔 (你要的"曲线", d 取小值 ≈ dot 半径,
		//     让曲线紧凑在 dot-to-dot 的小空隙内, 而不是 0.8*GRID_Y=19.2 拉满)
		//
		// 跟 3 段 L S 形相比, C 贝塞尔视觉上是 "真正平滑的曲线", 更接近
		// vscode 真实渲染。
		const dy = VSCODE_VERTEX_RADIUS - 1; // 3px, ≈ dot 半径
		let curPath = '';
		for (let i = 0; i < simplified.length; i++) {
			const seg = simplified[i];
			const x1 = seg.p1.x;
			const y1 = seg.p1.y;
			const x2 = seg.p2.x;
			const y2 = seg.p2.y;

			// 新段起点跟前段终点连续 (last.p2 == cur.p1) 时, 不开 M, 直接续接
			// 这是 "column 0 主线" 贯通的关键: 多个同 column 的 line 简化后
			// 拼成一条 M..L..L.. path
			const continuous =
				i > 0 &&
				curPath !== '' &&
				simplified[i - 1].p2.x === x1 &&
				simplified[i - 1].p2.y === y1;

			if (!continuous) {
				curPath += `M ${x1.toFixed(0)} ${y1.toFixed(1)}`;
			}

			if (x1 === x2) {
				// 垂直线 (L)
				curPath += ` L ${x2.toFixed(0)} ${y2.toFixed(1)}`;
			} else if (style === 'angular') {
				// 折线: angular 风格, dy = GRID_Y * 0.38 (vscode graph.ts:76)
				// p1 = (4, 4), p2 = (20, 28)
				// midX = x2 = 20, midY = y2 - 9.12 = 18.88 (lockedFirst=true)
				// path: M 4 4.0 L 20 18.9 L 20 28.0
				const angDy = VSCODE_GRID_Y * 0.38;
				const midX = seg.lockedFirst ? x2 : x1;
				const midY = seg.lockedFirst ? y2 - angDy : y1 + angDy;
				curPath += ` L ${midX.toFixed(0)} ${midY.toFixed(1)} L ${x2.toFixed(0)} ${y2.toFixed(1)}`;
			} else {
				// C 贝塞尔: rounded 风格, dy = GRID_Y * 0.8 = 19.2 (vscode graph.ts:76)
				// p1 = (4, 4), p2 = (20, 28)
				// 控制点 1: (4, 4+19.2) = (4, 23.2)
				// 控制点 2: (20, 28-19.2) = (20, 8.8)
				// path: M 4 4.0 C 4 23.2 20 8.8 20 28.0
				const curveDy = VSCODE_GRID_Y * 0.8;
				curPath += ` C ${x1.toFixed(0)} ${(y1 + curveDy).toFixed(1)} ${x2.toFixed(0)} ${(y2 - curveDy).toFixed(1)} ${x2.toFixed(0)} ${y2.toFixed(1)}`;
			}
		}

		if (curPath !== '') {
			addPath(color, curPath, branchIdx);
		}
	}

	// ===== 4. Vertex.draw 复刻: 圆点 =====
	// (vscode Vertex.draw:298-331)
	for (const node of graph.nodes) {
		const cx = node.lane * VSCODE_GRID_X + VSCODE_OFFSET_X;
		const cy = node.row * VSCODE_GRID_Y + VSCODE_OFFSET_Y + (expandedAt !== null && node.row > expandedAt ? VSCODE_EXPAND_Y : 0);
		const colorHex = VSCODE_COLORS[node.color % VSCODE_COLORS.length] ?? VSCODE_COLORS[0];

		nodes.push({
			cx,
			cy,
			r: node.isStash ? VSCODE_VERTEX_RADIUS + 0.5 : VSCODE_VERTEX_RADIUS,
			sha: node.sha,
			shortSha: node.shortSha,
			subject: node.subject,
			authorName: node.authorName,
			authorEmail: node.authorEmail,
			date: node.date,
			isMerge: node.isMerge,
			row: node.row,
			lane: node.lane,
			refs: node.refs,
			refTypes: node.refTypes,
			colorHex,
			isCurrent: node.isCurrent,
			isStash: node.isStash,
		});
	}

	// ===== 5. 尺寸 =====
	// vscode Graph.getContentWidth: 2*offsetX + (maxX-1)*gridX
	// vscode Graph.getHeight: vertices.length * gridY + offsetY - gridY/2
	const maxLane = graph.maxLane;
	const width = 2 * VSCODE_OFFSET_X + maxLane * VSCODE_GRID_X + VSCODE_GRID_X;
	const height = graph.nodes.length * VSCODE_GRID_Y + VSCODE_OFFSET_Y + (expandedAt !== null ? VSCODE_EXPAND_Y : 0);

	return { paths, nodes, width, height, style };
}
