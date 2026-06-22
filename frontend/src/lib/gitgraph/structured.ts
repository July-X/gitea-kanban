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
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 时间
  isMerge: boolean;
  parents: string[];
}

/** 边类型 */
export type EdgeTypeDto = 0 | 1 | 2; // 0=normal, 1=branch, 2=merge

/** 图边（连线） */
export interface GraphEdgeDto {
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
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

/** 列宽（每个 lane 的水平间距） */
export const LANE_WIDTH = 24;
/** 行高（每个 commit 的垂直间距） */
export const ROW_HEIGHT = 28;
/** 节点半径 */
export const NODE_RADIUS = 4;

// ===== SVG path 生成 =====

/** 一条 SVG path（d 字符串 + 颜色号） */
export interface SvgPath {
  d: string;
  colorIndex: number;
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
 * @param graph Go 后端 BuildGraph 输出
 * @returns SVG paths + nodes + 尺寸
 */
export function renderGraph(graph: GraphResultDto): SvgRenderResult {
  const paths: SvgPath[] = [];
  const nodes: SvgNode[] = [];

  // 1. 生成 edges → SVG paths
  for (const edge of graph.edges) {
    const x1 = edge.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
    const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = edge.toLane * LANE_WIDTH + LANE_WIDTH / 2;
    const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

    let d: string;
    if (edge.fromLane === edge.toLane) {
      // 同 lane → 直线
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      // 跨 lane → 贝塞尔曲线（更美观）
      const midY = (y1 + y2) / 2;
      d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    }

    paths.push({
      d,
      colorIndex: edge.fromLane % 8, // 8 色循环
    });
  }

  // 2. 生成 nodes → SVG circles
  for (const node of graph.nodes) {
    nodes.push({
      cx: node.lane * LANE_WIDTH + LANE_WIDTH / 2,
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
    });
  }

  // 3. 计算尺寸
  const width = (graph.maxLane + 1) * LANE_WIDTH + LANE_WIDTH;
  const height = graph.nodes.length * ROW_HEIGHT + ROW_HEIGHT;

  return { paths, nodes, width, height };
}

// ===== 颜色表（8 色循环，对齐 Gitea flow-color-16 系列）=====

export const LANE_COLORS = [
  '#4fc4d6', // 青
  '#74b830', // 绿
  '#f76707', // 橙
  '#db2828', // 红
  '#6366f1', // 靛
  '#a855f7', // 紫
  '#eab308', // 黄
  '#14b8a6', // 蓝绿
];
