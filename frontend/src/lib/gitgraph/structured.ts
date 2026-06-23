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
 * v2.7：24 → 16。Gitea 原版用 5 unit × 2 缩放 = 10px/lane；旧值 24px 导致 lane
 * 间距过宽、整体图形稀疏。16px 在可读性与紧凑性之间取平衡（dot 8px + 8px 间隙）。
 */
export const LANE_WIDTH = 16;
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
 * v2.7 重写（修复 bug1 宽度过大 + bug2 分叉/合并连线方向错误）：
 * - 颜色来自后端 GraphEdge.color（0..15，对齐 Gitea Color16()），前端不再 % N 自算
 * - 按 color 分组 paths，便于 SVG <g class="flow-color-16-N"> 染色
 * - 路径公式对齐 Gitea svgcontainer.tmpl 字形语义：
 *   · 同 lane (EdgeNormal) → 垂直线 `M x y1 L x y2`（对齐 Gitea `|` / `v 12`）
 *   · 跨 lane (EdgeMerge) → 当前 flow 先从 commit 点后方补一段短竖线，再只画一行
 *     `/` 或 `\` glyph。lane 会复用，不能沿目标 lane 继续找节点，否则会把前后不同
 *     flow 粘在一起；也不能直接画到远端 parent dot。
 *     fromLane > toLane（向左汇入主干）→ `/` 字形（斜线从右上到左下）
 *     fromLane < toLane（向右分叉）→ `\` 字形（斜线从左上到右下）
 *   · 旧版用贝塞尔曲线，不符合 Gitea 真实 `git log --graph` 的折线表现
 * - node 颜色：建立 lane → color 映射（从 inbound edges 推断），
 *   避免合并边颜色污染（旧版取第一个 inbound edge，merge commit 节点色错乱）
 *
 * @param graph Go 后端 BuildGraph 输出
 * @returns SVG paths（按 color 分组）+ nodes + 尺寸
 */
export function renderGraph(graph: GraphResultDto): SvgRenderResult {
  // 按 color 分组的 paths：每个 color 一组（对应一个 SVG <g class="flow-color-16-N">）
  const pathsByColor = new Map<number, string[]>();
  // 节点数组（v2.7：颜色从 laneColorMap 推断，避免合并边颜色污染）
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
  const maxLaneRaw = graph.nodes.reduce((m, n) => Math.max(m, n.lane), 0);

  const addPath = (color: number, d: string): void => {
    const arr = pathsByColor.get(color) ?? [];
    arr.push(d);
    pathsByColor.set(color, arr);
  };

  const rowCenter = (row: number): number => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const rowBottom = (row: number): number => (row + 1) * ROW_HEIGHT;
  const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

  // ===== 1. 生成 edges → SVG paths =====
  for (const edge of graph.edges) {
    const x1 = laneX(edge.fromLane);
    const y1 = rowCenter(edge.fromRow);
    const x2 = laneX(edge.toLane);
    const y2 = rowCenter(edge.toRow);

    let d: string;
    if (edge.fromLane === edge.toLane) {
      // 同 lane → 垂直直线（对齐 Gitea `|` / `v 12`）
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      // 跨 lane 是当前 flow 的结束 glyph：从 commit 点后方补短竖线，
      // 再画一行斜线。不要沿目标 lane 继续延伸，否则 column 复用时会把不同 flow 粘连。
      const joinStartY = rowBottom(edge.fromRow);
      const joinY = Math.min(rowBottom(edge.fromRow + 1), rowBottom(edge.toRow));
      d = `M ${x1} ${y1} L ${x1} ${joinStartY} L ${x2} ${joinY}`;
    }

    addPath(edge.color, d);
  }

  // ===== 2. 展平成 SvgPath 数组 =====
  const paths: SvgPath[] = [];
  for (const [colorIndex, ds] of pathsByColor.entries()) {
    paths.push({
      d: ds.join(' '),
      colorIndex,
      colorHex: LANE_COLORS[colorIndex] ?? LANE_COLORS[0],
    });
  }

  // ===== 3. 生成 nodes → SVG circles =====
  for (const node of graph.nodes) {
    const colorHex = LANE_COLORS[node.color] ?? LANE_COLORS[0];
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

  // ===== 4. 计算尺寸（基于实际用到的最大 lane）=====
  const width = (maxLaneRaw + 1) * LANE_WIDTH + LANE_WIDTH;
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
