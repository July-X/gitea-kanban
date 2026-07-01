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
// vscode-git-graph config.ts:278 默认值
export const VSCODE_GRID_X = 16;
export const VSCODE_GRID_Y = 24;
export const VSCODE_OFFSET_X = 16;
export const VSCODE_OFFSET_Y = 12;
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

// v3.x：UNCOMMITTED 虚拟 commit 触发的灰色 line 颜色。
// 对齐 vscode graph.ts:152 `line.setAttribute('stroke', isCommitted ? colour : '#808080')`
export const VSCODE_UNCOMMITTED_COLOR = '#808080';
// 对齐 vscode graph.ts:155 (OpenCircleAtTheCheckedOutCommit 模式)：
// `line.setAttribute('stroke-dasharray', '2px')`
// 我们 v3.x 固定走这条模式（默认灰色 + 虚线），不引入二级 config。
export const VSCODE_UNCOMMITTED_DASHARRAY = '2px';

export type VscodeGraphStyle = 'rounded' | 'angular';

export interface VscodeSvgPath {
	d: string;
	colorIndex: number;
	colorHex: string;
	order: number;
	/**
	 * 'line' (默认实色, stroke-width=2) 或 'shadow' (半透明描边, stroke-width=4)
	 * vscode Branch.drawPath (graph.ts:149-159) 每个 path 画 2 遍:
	 * shadow (暗背景下光晕) + line (实色)。
	 */
	kind?: 'line' | 'shadow';
	/**
	 * v3.x：isCommitted=false 时该 path 走 #808080 灰色 + stroke-dasharray: 2px（虚线）。
	 * 对齐 vscode Branch.drawPath (graph.ts:152-155)。
	 * 默认 undefined (true)，表示走 lane 颜色。
	 */
	isCommitted?: boolean;
	/** stroke-dasharray 属性值；isCommitted=false 时固定为 '2px'。 */
	dasharray?: string;
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
	/** HEAD 标记 (vscode Vertex.draw: 空心 circle, fill=bg, stroke=color, stroke-width=2) */
	isCurrent?: boolean;
	/** stash 标记 (vscode Vertex.draw: r=4.5 outer + r=2 inner 双圈) */
	isStash?: boolean;
	/** 是否已提交 (true) 还是未提交的 worktree 变更 (false)
	 * 对齐 vscode graph.ts Vertex.draw：uncommitted 时 dot stroke = #808080 */
	isCommitted?: boolean;
}

export interface VscodeSvgRenderResult {
	paths: VscodeSvgPath[];
	nodes: VscodeSvgNode[];
	/**
	 * SVG 实际渲染宽度（= min(contentWidth, maxWidth)）。
	 * 对齐 vscode-git-graph Graph.setSvgWidth (graph.ts:697-700):
	 *   width = maxWidth > -1 ? min(contentWidth, maxWidth) : contentWidth
	 * 当 maxWidth=-1 时无限制，整个 content 完整渲染
	 */
	width: number;
	/**
	 * SVG 坐标系总宽度（不被 maxWidth 截短）。
	 * 用于 mask/linearGradient 渐变计算 offset。
	 * 对齐 vscode-git-graph Graph.getContentWidth (graph.ts:467-473)
	 */
	contentWidth: number;
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
	options?: {
		style?: VscodeGraphStyle;
		expandedAt?: number | null;
		expandY?: number;
		/**
		 * graph 列最大可见宽度（对齐 vscode-git-graph Graph.limitMaxWidth）。
		 * - 默认 -1：不限制，SVG 完整渲染 contentWidth
		 * - 传入 px：SVG 渲染宽度被截短到 min(contentWidth, maxWidth)，
		 *   超出 maxWidth 的 lane 在 mask 渐变 fade 区间内
		 *   （(maxWidth-12)px ~ maxWidth px 渐变 12px）
		 */
		maxWidth?: number;
		/**
		 * 动态行高（对齐 vscode-git-graph main.ts:801 动态 grid.y）。
		 * - 默认 VSCODE_GRID_Y(24)：固定行高
		 * - 传入实际行高：dot cy 与 commit-row 中心精确对齐
		 * vscode main.ts:801: grid.y = (tableHeight - headerHeight) / commits.length
		 */
		gridY?: number;
		/**
		 * 垂直偏移（对齐 vscode-git-graph main.ts:804 动态 offsetY）。
		 * - 默认 VSCODE_OFFSET_Y(12)
		 * - 传入 headerHeight + gridY/2：补偿表头高度，让第一行 dot 落在行中心
		 * vscode main.ts:804: offsetY = headerHeight + grid.y / 2
		 */
		offsetY?: number;
	},
): VscodeSvgRenderResult {
	const style = options?.style ?? 'rounded';
	const expandedAt = options?.expandedAt ?? null;
	const expandY = options?.expandY ?? VSCODE_EXPAND_Y;
	const maxWidth = options?.maxWidth ?? -1;
	// v3.4：动态行高对齐（vscode main.ts:801,804）
	const gridY = options?.gridY ?? VSCODE_GRID_Y;
	const offsetY = options?.offsetY ?? VSCODE_OFFSET_Y;
	// GRID_X / OFFSET_X 保持固定（横向 lane 间距不变，vscode 也是固定 16）
	const gridX = VSCODE_GRID_X;
	const offsetX = VSCODE_OFFSET_X;

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

	// vscode Branch.drawPath (graph.ts:149-159) 每条 path 画 2 遍:
	//   - shadow: stroke-width=4 stroke-opacity=0.75 stroke=bg (暗背景下"光晕")
	//   - line:   stroke-width=2 stroke=color 实色
	// 我们在 DTO 区分两者,前端 CSS 给 shadow 加粗 + 半透明背景色描边
	//
	// v3.x：isCommitted=false 时改走 #808080 + stroke-dasharray='2px'，对齐
	// vscode Branch.drawPath (graph.ts:152-155)。
	const addPath = (color: number, dStr: string, order: number, isCommitted: boolean): void => {
		const baseHex = VSCODE_COLORS[color % VSCODE_COLORS.length] ?? VSCODE_COLORS[0]!;
		const finalHex = isCommitted ? baseHex : VSCODE_UNCOMMITTED_COLOR;
		const finalDasharray = isCommitted ? undefined : VSCODE_UNCOMMITTED_DASHARRAY;
		paths.push({
			d: dStr,
			colorIndex: color,
			colorHex: finalHex,
			order,
			kind: 'shadow',
			isCommitted,
		});
		paths.push({
			d: dStr,
			colorIndex: color,
			colorHex: finalHex,
			order,
			kind: 'line',
			isCommitted,
			dasharray: finalDasharray,
		});
	};

	const branches = (graph.branches?.length ? graph.branches : edgesToFallbackBranches(graph));
	for (let branchIdx = 0; branchIdx < branches.length; branchIdx++) {
		const branch = branches[branchIdx]!;
		const color = branch.color;
		const lines = branch.lines;
		// 1) 把 line 转成像素坐标,处理 expandAt (vscode Branch.draw:78-103)
		// v3.x: 携带 isCommitted —— UNCOMMITTED 段走灰色虚线,其余走 lane 颜色
		const placed: Array<{
			p1: { x: number; y: number };
			p2: { x: number; y: number };
			lockedFirst: boolean;
			isCommitted: boolean;
		}> = [];
		for (const line of lines) {
			let x1 = line.x1 * gridX + offsetX;
			let y1 = line.y1 * gridY + offsetY;
			let x2 = line.x2 * gridX + offsetX;
			let y2 = line.y2 * gridY + offsetY;
			// v3.x: 缺省视作已提交（Go 端老 DTO 没有 isCommitted 字段，fallback 分支
			// edgesToFallbackBranches 也会写 true），与 vscode 默认行为一致。
			const isCommitted = line.isCommitted !== false;

			// expandAt 处理: 展开 commit 详情时,下方所有 line 自动"延伸"
			// (vscode Branch.draw:85-101)
			if (expandedAt !== null && expandedAt >= 0) {
				if (line.y1 > expandedAt) {
					y1 += expandY;
					y2 += expandY;
				} else if (line.y2 > expandedAt) {
					if (x1 === x2) {
						// 垂直线 - 终点延伸
						y2 += expandY;
					} else {
						// 跨 lane - 锁定方向延伸
						if (line.lockedFirst) {
							// 转场在 p1 端:保持原转场,再延伸到 p2 端
							placed.push({
								p1: { x: x1, y: y1 },
								p2: { x: x2, y: y2 },
								lockedFirst: line.lockedFirst,
								isCommitted,
							});
							placed.push({
								p1: { x: x2, y: y1 + gridY },
								p2: { x: x2, y: y2 + expandY },
								lockedFirst: line.lockedFirst,
								isCommitted,
							});
							continue;
						} else {
							// 转场在 p2 端:先延伸到 p2 上方,再做转场
							placed.push({
								p1: { x: x1, y: y1 },
								p2: { x: x1, y: y2 - gridY + expandY },
								lockedFirst: line.lockedFirst,
								isCommitted,
							});
							y1 += expandY;
							y2 += expandY;
						}
					}
				}
			}
			placed.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, lockedFirst: line.lockedFirst, isCommitted });
		}

		// 2) 简化共线中间点 (vscode Branch.draw:106-116)
		// 只合并同列且首尾相接的垂直线。跨 lane 线段即使首尾相接也必须保留，
		// 否则会吞掉 VSCode 依赖行间距生成的 C 贝塞尔转场。
		// v3.x: 同 isCommitted 段的 line 才能合并，跨段必须保留断点（切路径用）
		let i = 0;
		while (i < placed.length - 1) {
			const line = placed[i]!;
			const nextLine = placed[i + 1]!;
			if (
				line.p1.x === line.p2.x &&
				line.p2.x === nextLine.p1.x &&
				nextLine.p1.x === nextLine.p2.x &&
				line.p2.y === nextLine.p1.y &&
				line.isCommitted === nextLine.isCommitted
			) {
				line.p2.y = nextLine.p2.y;
				placed.splice(i + 1, 1);
			} else {
				i++;
			}
		}

		// 3) 拼成 path d 字符串 (vscode Branch.draw:118-146)
		//
		// 关键: vscode 的 line list 是 "按 column 顺时针串行" 的连续序列,
		//       所以同 branch 的连续 line 经常 last.p2 == next.p1, 可以用
		//       单一 path + 多个 L/C 续接。
		//
		// 跨 lane 转场继续沿当前 path 输出，使用 VSCode 默认 0.8 * GRID_Y
		// 控制点偏移，靠行间距完成曲线形变后连接到目标 lane。
		//
		// v3.x: 当 seg.isCommitted 变化时切路径 (与 vscode Branch.draw:125
		//       `line.isCommitted !== lines[i - 1].isCommitted` 等价)，分别
		//       flush 上一段 + 开新段。确保 UNCOMMITTED 灰虚线与已提交彩色段独立 path。
		let curPath = '';
		let curIsCommitted: boolean | null = null;
		for (let i = 0; i < placed.length; i++) {
			const seg = placed[i]!;
			const x1 = seg.p1.x;
			const y1 = seg.p1.y;
			const x2 = seg.p2.x;
			const y2 = seg.p2.y;
			const segIsCommitted = seg.isCommitted;

			// 段间 committed-ness 切变: 提交当前 path 并开新段
			if (curPath !== '' && curIsCommitted !== null && curIsCommitted !== segIsCommitted) {
				addPath(color, curPath, branchIdx, curIsCommitted);
				curPath = '';
			}
			curIsCommitted = segIsCommitted;

			// 新段起点跟前段终点连续 (last.p2 == cur.p1) 时, 不开 M, 直接续接
			// 这是 "column 0 主线" 贯通的关键: 多个同 column 的 line 简化后
			// 拼成一条 M..L..L.. path
			const continuous =
				i > 0 &&
				curPath !== '' &&
				placed[i - 1]!.p2.x === x1 &&
				placed[i - 1]!.p2.y === y1;

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
				const angDy = gridY * 0.38;
				const midX = seg.lockedFirst ? x2 : x1;
				const midY = seg.lockedFirst ? y2 - angDy : y1 + angDy;
				curPath += ` L ${midX.toFixed(0)} ${midY.toFixed(1)} L ${x2.toFixed(0)} ${y2.toFixed(1)}`;
			} else {
				// C 贝塞尔: rounded 风格, dy = GRID_Y * 0.8 = 19.2 (vscode graph.ts:76)
				// p1 = (4, 4), p2 = (20, 28)
				// 控制点 1: (4, 4+19.2) = (4, 23.2)
				// 控制点 2: (20, 28-19.2) = (20, 8.8)
				// path: M 4 4.0 C 4 23.2 20 8.8 20 28.0
				const curveDy = gridY * 0.8;
				curPath += ` C ${x1.toFixed(0)} ${(y1 + curveDy).toFixed(1)} ${x2.toFixed(0)} ${(y2 - curveDy).toFixed(1)} ${x2.toFixed(0)} ${y2.toFixed(1)}`;
			}
		}

		if (curPath !== '') {
			addPath(color, curPath, branchIdx, curIsCommitted ?? true);
		}
	}

	// ===== 4. Vertex.draw 复刻: 圆点 =====
	// (vscode Vertex.draw:298-331)
	for (const node of graph.nodes) {
		const cx = node.lane * gridX + offsetX;
		const cy = node.row * gridY + offsetY + (expandedAt !== null && node.row > expandedAt ? expandY : 0);
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
			isCommitted: node.isCommitted,
		});
	}

	// ===== 5. 尺寸 =====
	// vscode Graph.getContentWidth: 2*offsetX + (maxX-1)*gridX
	// vscode Graph.getHeight (graph.ts:476): vertices.length * gridY + offsetY - gridY/2 + (expandAt ? expandY : 0)
	const maxLane = graph.maxLane;
	const contentWidth = 2 * offsetX + maxLane * gridX + gridX;
	// vscode Graph.setSvgWidth (graph.ts:697-700): SVG 实际渲染宽度 = min(contentWidth, maxWidth)
	const width = maxWidth > -1 ? Math.min(contentWidth, maxWidth) : contentWidth;
	const height =
		graph.nodes.length * gridY +
		offsetY -
		gridY / 2 +
		(expandedAt !== null ? expandY : 0);

	return { paths, nodes, width, contentWidth, height, style };
}

function edgesToFallbackBranches(graph: GraphResultDto): NonNullable<GraphResultDto['branches']> {
	return graph.edges.map((edge) => ({
		color: edge.color,
		end: Math.max(edge.fromRow, edge.toRow) + 1,
		lines: [
			{
				x1: edge.fromLane,
				y1: edge.fromRow,
				x2: edge.toLane,
				y2: edge.toRow,
				lockedFirst: edge.fromLane < edge.toLane,
				// Gitea 风格 fallback：没有 UNCOMMITTED 概念，全部视作已提交
				isCommitted: true,
			},
		],
	}));
}
