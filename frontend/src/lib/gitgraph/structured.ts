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

/** 列宽（每个 lane 的水平间距） */
export const LANE_WIDTH = 24;
/** 行高（每个 commit 的垂直间距） */
export const ROW_HEIGHT = 28;
/** 节点半径 */
export const NODE_RADIUS = 4;

// ===== SVG path 生成 =====

/** 一条 SVG path（d 字符串 + 颜色号 + hex） */
export interface SvgPath {
  d: string;
  colorIndex: number; // 0..15，对齐 Gitea Color16()
  /** 内联 hex 颜色（v2.6 fix：用 SVG attribute 而非 CSS 变量，兼容 WebKit + scoped CSS） */
  colorHex: string;
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
 * v2.6 重写：
 * - 颜色来自后端 GraphEdge.color（0..15，对齐 Gitea Color16()），前端不再 % N 自算
 * - 按 color 分组 paths，便于 SVG <g class="flow-color-16-N"> 染色
 * - 路径公式 1:1 对齐 Gitea svgcontainer.tmpl（同 lane 直线 v 12，跨 lane 贝塞尔）
 *
 * @param graph Go 后端 BuildGraph 输出
 * @returns SVG paths（按 color 分组）+ nodes + 尺寸
 */
export function renderGraph(graph: GraphResultDto): SvgRenderResult {
  // 按 color 分组的 paths：每个 color 一组（对应一个 SVG <g class="flow-color-16-N">）
  const pathsByColor = new Map<number, string[]>();
  const nodes: SvgNode[] = [];

  // 1. 生成 edges → SVG paths
  for (const edge of graph.edges) {
    const x1 = edge.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
    const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = edge.toLane * LANE_WIDTH + LANE_WIDTH / 2;
    const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

    let d: string;
    if (edge.fromLane === edge.toLane) {
      // 同 lane → 直线（对齐 Gitea `v 12` 风格，但用整段 L 更清晰）
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      // 跨 lane → 贝塞尔曲线
      const midY = (y1 + y2) / 2;
      d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    }

    const color = edge.color;
    const arr = pathsByColor.get(color) ?? [];
    arr.push(d);
    pathsByColor.set(color, arr);
  }

  // 2. 展平成 SvgPath 数组（每 color 一条 path d，便于复用 <g class="flow-color-16-N">）
  const paths: SvgPath[] = [];
  for (const [colorIndex, ds] of pathsByColor.entries()) {
    paths.push({
      d: ds.join(' '),
      colorIndex,
      colorHex: LANE_COLORS[colorIndex] ?? LANE_COLORS[0],
    });
  }

  // 3. 生成 nodes → SVG circles
  for (const node of graph.nodes) {
    // node 颜色取**该 commit 所在 lane 的主流颜色**：
    // 简化：取第一个 inbound edge color；无 inbound edge（root commit）取 lane 0 的色
    let colorHex = LANE_COLORS[0];
    for (const e of graph.edges) {
      if (e.toRow === node.row && e.toLane === node.lane) {
        colorHex = LANE_COLORS[e.color] ?? LANE_COLORS[0];
        break;
      }
    }
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
      colorHex,
    });
  }

  // 4. 计算尺寸（基于实际用到的最大 lane）
  const maxLane = graph.nodes.reduce((m, n) => Math.max(m, n.lane), 0);
  const width = (maxLane + 1) * LANE_WIDTH + LANE_WIDTH;
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
