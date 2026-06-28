/**
 * 结构化 Git Graph 渲染 —— 消费 Go 后端 BuildGraph 输出的 GraphNode + GraphEdge
 *
 * 背景（迁移步骤 4.6）：
 * 旧版前端用 parser.ts 解析 `git log --graph` 的 ASCII 字形（移植 Gitea parser.go）。
 * 新版 Go 后端用 go-git + 自研 lane 布局算法直接输出结构化 GraphNode + GraphEdge，
 * 前端无需字形解析，直接消费结构化数据生成 SVG。
 *
 * 本模块是新的渲染入口，替代旧的 parser.ts + 部分 svg.ts 逻辑。
 * 旧 parser.ts 保留在 lib/gitgraph/ 供参考，但不再被调用。
 */

// ===== Go 后端 BuildGraph 输出的类型（与 app/git/graph/layout.go 对齐）=====

/** 图节点（一个 commit） */
export interface GraphNodeDto {
  row: number;
  lane: number;
  /** 节点所属 flow 的颜色号 0..15，由后端 lane 分配直接给出 */
  color: number;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 时间
  isMerge: boolean;
  parents: string[];
  /**
   * 关联的 ref 名称列表（branch / tag 短名）
   * 后端 LogCommits 在收集时附带，前端右侧 commit 行直接渲染 badge
   */
  refs?: string[];
  /**
   * 与 refs 一一对应的 ref 类型（v2.8）：
   * "branch" / "remoteBranch" / "tag"
   */
  refTypes?: string[];
}

/** 边类型 */
export type EdgeTypeDto = 0 | 1 | 2; // 0=normal, 1=branch, 2=merge

/** 图边（连线） */
export interface GraphEdgeDto {
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
  /** 颜色号 0..15，对齐 Gitea Color16()（v2.6 后端生成，前端不再 % N 自算） */
  color: number;
  type: EdgeTypeDto;
}

/** 完整图结果 */
export interface GraphResultDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  maxLane: number;
  truncated: boolean;
}

// ===== SVG 渲染常量 =====

/** 列宽（每个 lane 的水平间距）
 *
 * v2.8：16 → 10。分叉 flow 需要按相邻列固定 10px 递增：
 * flow2 相对 flow1 = 10px，flow3 相对 flow2 = 10px，依次类推。
 * 这样更接近 Gitea/SourceTree 的紧凑 column 视觉，避免分叉横向被拉得过宽。
 */
export const LANE_WIDTH = 10;
/** 行高（每个 commit 的垂直间距）
 *  v2.40：26 → 30px，配合 commit-row 上下 5px vertical padding，
 *  让密集 commit-row 文字上下有清晰呼吸空间（连续文字间距 7.83 → 11.11px, +42%）。
 *  dot 圆心 cy = row*30+15 仍完美对齐 30px commit-row 中心（SVG 与 row 同步）。*/
export const ROW_HEIGHT = 30;

/** v2.42：flow 1 (lane 0) 距离 commit list 左边缘 padding
 *  之前 lane 0 圆心 cx = LANE_WIDTH/2 = 5px (DOT_SIZE=8 → 圆缘贴边 1px)，看起来"flow 1 贴着边"。
 *  现在 +4px padding，lane 0 圆心 cx = LANE_WIDTH/2 + FLOW_LEFT_PAD = 9px（圆缘距边框 5px）。
 *  ⚠️ 只影响 structured 路径（renderGraph() 输出）。
 *  ASCII 路径在 models.ts 自己处理（FLOW_LEFT_PAD 也独立 export 在那里）。*/
export const FLOW_LEFT_PAD = 4;
/** 节点半径 */
export const NODE_RADIUS = 4;
/** 多条 merge 同时汇入同一 parent 时的错层步进，避免外侧斜线压住内侧竖线 */
export const MERGE_STAGGER = 10;

// ===== SVG path 生成 =====

/** 一条 SVG path（d 字符串 + 颜色号 + hex） */
export interface SvgPath {
  d: string;
  colorIndex: number; // 0..15，对齐 Gitea Color16()
  /** 内联 hex 颜色（v2.6 fix：用 SVG attribute 而非 CSS 变量，兼容 WebKit + scoped CSS） */
  colorHex: string;
  order: number; // 保留原始 edge 顺序，避免 regroup 后覆盖主干竖线
}

/** 一条 SVG 节点（圆点 + commit 关联） */
export interface SvgNode {
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
  /** 内联 hex 颜色（v2.6 fix：与 path 同策略，不依赖 CSS 变量） */
  colorHex: string;
}

/** SVG 渲染结果 */
export interface SvgRenderResult {
  paths: SvgPath[];
  nodes: SvgNode[];
  width: number;
  height: number;
}

/**
 * 从结构化 GraphResult 生成 SVG 渲染数据
 *
 * v2.7 重写（修复 bug1 宽度过大 + bug2 分叉/合并连线方向错误）：
 * - 颜色来自后端 GraphEdge.color（0..15，对齐 Gitea Color16()），前端不再 % N 自算
 * - 保留 edges 原始顺序输出 path，避免按颜色 regroup 后改变覆盖层级
 * - 路径公式使用 SourceTree 风格 flow segment：
 *   · 同 lane (EdgeNormal) → 当前 flow 自己的垂直 segment
 *   · 向右分叉（类似 '\'）→ 先局部斜出，再在目标 lane 继续下行
 *   · 向左回收（类似 '/'）→ 先沿当前 lane 下行，最后一段再斜回主干
 *     这样能保留 SourceTree/Gitea 的“右开左收”视觉语义，而不是把所有跨 lane
 *     边都画成同一种直角折线。
 *   · lane 复用时只截断冲突段，不把前后不同 flow 强行连成一条。
 *   · 旧版用贝塞尔曲线，不符合 Gitea 真实 `git log --graph` 的折线表现
 * - node 颜色：直接使用后端 GraphNode.color，避免 merge edge 污染节点颜色
 *
 * @param graph Go 后端 BuildGraph 输出
 * @returns SVG paths（按 color 分组）+ nodes + 尺寸
 */
export function renderGraph(graph: GraphResultDto): SvgRenderResult {
  const paths: SvgPath[] = [];
  const nodes: SvgNode[] = [];

  // ===== 计算最大 lane（用于 viewBox 宽度）=====
  // v2.8 验证：Gitea 实际行为是 main（lane 0 / column 0）在 SVG 最左
  // （Playwright 验证 http://127.0.0.1:3000/kanban_demo/m4java-test/graph：
  //   flow-1  72 个 commit cx=5（column 0） color=1 → main 在最左
  //   flow-2/3/4/5  分支 cx=15（column 1）       → 分支在右
  //   Gitea svgcontainer.tmpl 公式：M col*5+5 → column 0 → x=5（最左）
  //   Gitea parser.go ParseGlyphs 从右到左扫描，新 flow +1，但根 commit
  //   总是占 column 0（= 最左位置）
  //   结论：lane 0 = main 在最左，lane N = 最新分叉在右（v2.6+ 标准）
  const maxRenderLane = graph.maxLane;

  const nodesByLane = new Map<number, GraphNodeDto[]>();
  for (const node of graph.nodes) {
    const laneNodes = nodesByLane.get(node.lane) ?? [];
    laneNodes.push(node);
    nodesByLane.set(node.lane, laneNodes);
  }
  for (const laneNodes of nodesByLane.values()) {
    laneNodes.sort((a, b) => a.row - b.row);
  }

  const addPath = (color: number, d: string, order: number): void => {
    paths.push({
      d,
      colorIndex: color,
      colorHex: LANE_COLORS[color] ?? LANE_COLORS[0],
      order,
    });
  };

  const rowCenter = (row: number): number => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const rowTop = (row: number): number => row * ROW_HEIGHT;
  const rowBottom = (row: number): number => (row + 1) * ROW_HEIGHT;
  // v2.42：+FLOW_LEFT_PAD 让 lane 0 圆心距边框 9px（圆缘 5px），跟 ASCII 路径对齐。
  const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2 + FLOW_LEFT_PAD;

  const firstForeignNodeBetween = (
    lane: number,
    fromRow: number,
    toRow: number,
    color: number,
  ): GraphNodeDto | undefined => {
    const minRow = Math.min(fromRow, toRow);
    const maxRow = Math.max(fromRow, toRow);
    return (nodesByLane.get(lane) ?? []).find(
      (node) => node.row > minRow && node.row < maxRow && node.color !== color,
    );
  };

  const mergeSiblings = new Map<string, GraphEdgeDto[]>();
  for (const edge of graph.edges) {
    if (edge.fromLane <= edge.toLane) {
      continue;
    }
    const key = `${edge.toRow}:${edge.toLane}`;
    const arr = mergeSiblings.get(key) ?? [];
    arr.push(edge);
    mergeSiblings.set(key, arr);
  }
  const mergeRankByEdge = new Map<GraphEdgeDto, { rank: number; total: number }>();
  for (const edges of mergeSiblings.values()) {
    edges.sort((a, b) => a.fromLane - b.fromLane || a.fromRow - b.fromRow);
    for (let i = 0; i < edges.length; i++) {
      mergeRankByEdge.set(edges[i], { rank: i, total: edges.length });
    }
  }

  // ===== 1. 生成 edges → SVG paths =====
  for (const [index, edge] of graph.edges.entries()) {
    const x1 = laneX(edge.fromLane);
    const y1 = rowCenter(edge.fromRow);
    const x2 = laneX(edge.toLane);
    const y2 = rowCenter(edge.toRow);

    let d: string;
    if (edge.fromLane === edge.toLane) {
      const foreignNode = firstForeignNodeBetween(edge.fromLane, edge.fromRow, edge.toRow, edge.color);
      if (foreignNode) {
        // 如果同 lane edge 会穿过其它颜色的 commit，说明这个 column 已被后续 flow 复用。
        // 这里截断到外来 flow 前一行，避免大矩形绕行和不同 flow 粘连。
        const stopY = edge.toRow > edge.fromRow ? rowTop(foreignNode.row) : rowBottom(foreignNode.row);
        d = `M ${x1} ${y1} L ${x1} ${stopY}`;
      } else {
        d = `M ${x1} ${y1} L ${x2} ${y2}`;
      }
    } else if (edge.toLane > edge.fromLane) {
      // 向右分叉：模仿 '\' 语义，尽快斜出到新 lane，再沿目标 lane 继续向下。
      // 这样 feature 分支不会被画成“先在主干上垂直坠落，再最后一刻拐过去”的直角折线。
      const branchY = rowTop(Math.min(edge.fromRow + 1, edge.toRow));
      d = `M ${x1} ${y1} L ${x2} ${branchY} L ${x2} ${y2}`;
    } else {
      // 向左回收：同一 parent 的多条 merge 线不能在同一高度一起左拐，
      // 否则外侧分支的斜线会压住内侧分支的竖线。这里按 lane 从内到外错层回收：
      // 越靠近主干的分支越早左拐，越外侧的分支越晚左拐。
      const mergeRank = mergeRankByEdge.get(edge);
      const defaultBranchY = edge.toRow > edge.fromRow ? rowTop(edge.toRow) : rowBottom(edge.toRow);
      const minBranchY = rowTop(Math.min(edge.fromRow + 1, edge.toRow));
      const desiredOffset =
        mergeRank && mergeRank.total > 1
          ? (mergeRank.total - mergeRank.rank - 1) * MERGE_STAGGER
          : 0;
      const maxOffset = Math.max(0, defaultBranchY - minBranchY);
      const branchY = defaultBranchY - Math.min(desiredOffset, maxOffset);
      d = `M ${x1} ${y1} L ${x1} ${branchY} L ${x2} ${y2}`;
    }

    addPath(edge.color, d, index);
  }

  // ===== 2. 生成 nodes → SVG circles =====
  // v2.46：dot cx 加 +FLOW_LEFT_PAD 与 path d x (laneX) 对齐——
  //   之前 cx = lane*CW + CW/2 (lane 0 = 5px)，path d x = lane*CW + CW/2 + FLOW_LEFT_PAD (lane 0 = 9px)，
  //   dot 与 line 错位 4px（用户可能没注意到，因为 dot 直径 8px 覆盖 line 半边）。
  //   现在 cx 加 +FLOW_LEFT_PAD = 4，dot 中心与 line 完美重合（lane 0 = 9px），
  //   与 ASCII 路径 dot cx 公式完全一致，跨平台视觉统一。
  for (const node of graph.nodes) {
    const colorHex = LANE_COLORS[node.color] ?? LANE_COLORS[0];
    nodes.push({
      cx: node.lane * LANE_WIDTH + LANE_WIDTH / 2 + FLOW_LEFT_PAD,
      cy: node.row * ROW_HEIGHT + ROW_HEIGHT / 2,
      r: NODE_RADIUS,
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
    });
  }

  // ===== 3. 计算尺寸（基于实际用到的最大 lane）=====
  // v2.42：+FLOW_LEFT_PAD 让 SVG 容器宽度增 4px，与 laneX 偏移同步。
  const width = (maxRenderLane + 1) * LANE_WIDTH + LANE_WIDTH + FLOW_LEFT_PAD;
  const height = graph.nodes.length * ROW_HEIGHT + ROW_HEIGHT;

  return { paths, nodes, width, height };
}

// ===== 颜色表（16 色循环，对齐 Gitea flow-color-16-N 系列）=====
// 颜色定义对齐 Gitea web_src/css/themes/theme-gitlight.css 与 themedark.css 的 --color-series-16-N
export const LANE_COLORS = [
  '#4fc4d6', // 0  青
  '#74b830', // 1  绿
  '#f76707', // 2  橙
  '#db2828', // 3  红
  '#6366f1', // 4  靛
  '#a855f7', // 5  紫
  '#eab308', // 6  黄
  '#14b8a6', // 7  蓝绿
  '#0ea5e9', // 8  天蓝
  '#ec4899', // 9  粉
  '#84cc16', // 10 柠檬绿
  '#f43f5e', // 11 玫红
  '#8b5cf6', // 12 紫罗兰
  '#06b6d4', // 13 青蓝
  '#facc15', // 14 金
  '#10b981', // 15 翠绿
];
