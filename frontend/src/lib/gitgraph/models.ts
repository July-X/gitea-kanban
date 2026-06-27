/**
 * Git Graph 数据模型 —— 1:1 对齐 Gitea graph_models.go
 *
 * 核心概念（与 Gitea 一致）：
 * - Graph   : 整个图 = 多个 Flow + 一组 Commit + 全局包围盒
 * - Flow    : 一条"线"（一条 lane / 一个连续时间序列），包含 Glyph 序列和 Commit 序列
 * - Glyph   : 单个 (row, column, glyph) 字形，渲染成 SVG path 的一段
 * - Commit  : 一个 commit 节点，带 (row, column, flowId) 坐标
 * - GitRef  : 关联的分支 / tag / PR ref（commit 装饰）
 *
 * 行号 / 列号 含义（与 Gitea git --graph 输出一致）：
 * - row    : 从 0 开始，向下递增（0 = 最新 commit）
 * - column : 从 0 开始，向右递增
 *
 * 注：这里 row/column 与原 parser.go 一致 —— Parser 内部 row 是从 0 开始的全局行号
 * （与 graph.go MinRow=0 / row++ 同步）。Graph 的 min/max 是**全局**包围盒，
 * 渲染端画 SVG 时按全局坐标算 viewBox。
 */

import type { GitRef } from './types.js';

export { type GitRef };

// ============================================================
// 尺寸常量（可调整）
// ============================================================

/** SVG 单位列宽（unit），控制 flow lane 之间的间距 */
export const COL_WIDTH = 5;

/** SVG 单位行高（unit）
 *  v2.41：12 → 16px，让 ASCII 路径（GitHub 平台）的 commit-row 上下各有 ~2px 气口。
 *  之前 12px 太紧，11px 字体 + line-height 1 文字几乎贴满 row 上下边界，
 *  密集 row 时连续文字行间间距几乎为 0（看 v3-005 用户截图"sig-go coms"项目）。
 *
 *  ⚠️ 只影响 ASCII 路径（git --graph 字符流渲染）。
 *  structured 路径用 structured.ts 自己的 ROW_HEIGHT=30，与本常量无关。
 *  - COL_WIDTH = 5 → lane 视觉间距 5px（用户要求"flow 线条间隔调整到 5px"）
 *  - ROW_HEIGHT = 16 → row 视觉高度 16px（v2.41 从 12 提升）
 *  - svgWidth = graphWidth * 5 + 5（跟 Gitea `Width * 5 + 5` 一致）
 *  之前是 2（lane 10px），改 1 后 git-graph 整体更紧凑，更接近 SourceTree 风格
 */
export const ROW_HEIGHT = 16;

/** 显示缩放系数（1 SVG unit = SCALE px） */
export const DISPLAY_SCALE = 1;

/** v2.42：flow 1 (column 0) 距离 commit list 左边缘的 padding
 * 之前 viewBox/dot 起点 = 0，导致第一个 lane 圆心距离边框仅 4.5px（DOT_SIZE=8 → 圆心 4.5，
 * 圆缘贴边 0.5px），看起来"flow 1 贴着边太近"。
 * 现在统一 +4px padding，让 flow 1 圆心距离边框 9px，圆缘距离边框 5px（用户要求）。
 * ⚠️ 只影响 ASCII 路径（git --graph 字符流渲染）。
 * structured 路径有自己的 SVG 几何（renderGraph() in structured.ts），那里单独处理。*/
export const FLOW_LEFT_PAD = 4;

/** 字形：git --graph 输出中的一个字符位置 */
export interface Glyph {
  /** 行号（Y 坐标） */
  row: number;
  /** 列号（X 坐标） */
  column: number;
  /** 字形字符：* | / \ _ - . 或 ' ' */
  glyph: string;
  /**
   * 对角线的另一端列号（仅 \ 和 / 使用）。
   * \ 表示从 parentColumn 分叉到 column；/ 表示从 column 合并到 parentColumn。
   * 设为 undefined 表示与相邻列连接（column-1 或 column+1 的情况）。
   */
  parentColumn?: number;
}

/** 一条分支线（git flow / lane） */
export interface Flow {
  /** 全局唯一 ID（自增，从 1 开始） */
  id: number;
  /** 颜色编号（Color16 = colorNumber % 16） */
  colorNumber: number;
  /** 该 flow 上的所有字形（已按 (row, column) 排序） */
  glyphs: Glyph[];
  /** 该 flow 上的所有 commit（已按 row 排序） */
  commits: GitGraphCommit[];
  /** 包围盒 */
  minRow: number;
  maxRow: number;
  minColumn: number;
  maxColumn: number;
}

/** git graph 中的一个 commit 节点 */
export interface GitGraphCommit {
  /** commit 唯一标识 = SHA */
  id: string;
  /** 该 commit 所属的 flow ID */
  flowId: number;
  /** 行号（Y 坐标，0 = 最新） */
  row: number;
  /** 列号（X 坐标） */
  column: number;
  /** 完整 SHA */
  sha: string;
  /** 短 SHA */
  shortSha: string;
  /** commit 消息第一行（subject） */
  subject: string;
  /** 作者日期（ISO） */
  date: string;
  /** 关联的 ref（分支 / tag / PR） */
  refs: GitRef[];
  /** 作者名 */
  authorName: string;
  /** 作者邮箱 */
  authorEmail: string;
  /** 作者头像 URL（可选） */
  authorAvatar?: string;
  /** 是否 merge commit（parents > 1） */
  isMerge: boolean;
  /** parent SHA 列表 */
  parents: string[];
}

/** Relation commit —— 一行无 * 时占位（与 Gitea graph_models.go RelationCommit 一致） */
export interface RelationCommit {
  id: '__relation__';
  row: number;
}

export const RELATION_COMMIT_ID = '__relation__' as const;

/** 整个图 = 所有 flow + commit + 包围盒 */
export interface Graph {
  /** flow ID → Flow */
  flows: Map<number, Flow>;
  /** 按 row 排序的所有 commit 节点 */
  commits: GitGraphCommit[];
  /** 关系占位 commit（一行无 * 时） */
  relationCommits: RelationCommit[];
  /** 全局包围盒 */
  minRow: number;
  maxRow: number;
  minColumn: number;
  maxColumn: number;
}

/** ============== 构造函数（对齐 Gitea NewGraph / NewFlow） ============== */

export function newGraph(): Graph {
  return {
    flows: new Map(),
    commits: [],
    relationCommits: [],
    minRow: 0,
    maxRow: 0,
    // 用 sentinel 值，让 addGlyphToGraph 的第一笔数据正确更新包围盒
    // （flowId 从 1 开始，初始 0 永远不会被 < 比较覆盖）
    minColumn: Number.MAX_SAFE_INTEGER,
    maxColumn: Number.MIN_SAFE_INTEGER,
  };
}

export function newFlow(id: number, colorNumber: number, row: number, column: number): Flow {
  return {
    id,
    colorNumber,
    glyphs: [],
    commits: [],
    minRow: row,
    maxRow: row,
    minColumn: column,
    maxColumn: column,
  };
}

/** ============== 辅助函数（对齐 Gitea graph_models.go + svgcontainer.tmpl） ============== */

/** ColorNumber → CSS class 名（与 Gitea 一致：flow-color-16-N） */
export function flowColorClass(colorNumber: number): string {
  return `flow-color-16-${colorNumber % 16}`;
}

/** graph 宽度（列数） */
export function graphWidth(g: Graph): number {
  return g.maxColumn - g.minColumn + 1;
}

/** graph 高度（行数） */
export function graphHeight(g: Graph): number {
  return g.maxRow - g.minRow + 1;
}

/**
 * SVG viewBox 字符串
 * - x = minColumn * COL_WIDTH；y = minRow * ROW_HEIGHT
 * - w = (maxColumn - minColumn + 1) * COL_WIDTH + COL_WIDTH + FLOW_LEFT_PAD
 * - h = (maxRow - minRow + 1) * ROW_HEIGHT
 * v2.42：viewBox.x 保持 0-based (minColumn*COL_WIDTH)，**不偏移**。
 *   SVG 内部坐标系起点与 body 左边一致（minColumn=0 时起点=0）。
 *   FLOW_LEFT_PAD 偏移由 path 内部坐标 + dot cx 同步加 4 来实现（保持 path 和 dot 在同一绝对 px 坐标系）。
 *   这样不需要 viewBox 偏移，path 和 dot 计算公式完全一致：column*COL_WIDTH + COL_WIDTH + FLOW_LEFT_PAD。*/
export function svgViewBox(g: Graph): string {
  const x = g.minColumn * COL_WIDTH;
  const y = g.minRow * ROW_HEIGHT;
  const w = graphWidth(g) * COL_WIDTH + COL_WIDTH + FLOW_LEFT_PAD;
  const h = graphHeight(g) * ROW_HEIGHT;
  return `${x} ${y} ${w} ${h}`;
}

/** SVG 显示宽度（px）
 * v2.42：+FLOW_LEFT_PAD 让 SVG 容器宽度多 4px，给 flow 1 圆缘预留 5px 左边距。*/
export function svgWidthPx(g: Graph): string {
  return `${graphWidth(g) * COL_WIDTH * DISPLAY_SCALE + COL_WIDTH * DISPLAY_SCALE + FLOW_LEFT_PAD * DISPLAY_SCALE}px`;
}

/** SVG 显示高度（px） */
export function svgHeightPx(g: Graph): string {
  return `${graphHeight(g) * ROW_HEIGHT * DISPLAY_SCALE}px`;
}

// ============================================================
// 列压缩：flow 尽量左靠，复用已死 column
// ============================================================

/**
 * 压缩列号分配 —— 已废弃（v2.x 修复多 MR 仓库断线）。
 *
 * 历史：v2.6 之前 `column = flowID`，为了让 SVG path 按 lane 紧凑布局，按 flow
 *       时间区间复用 column（不同 flow 时间不重叠时共用 column）。
 * 现状：v2.x 改 `column = ASCII 字符流下标`（lane 编号）以保证 / \ 几何正确连接，
 *       此时 ASCII lane 已是紧凑表示（git log --graph 输出 left-aligned），
 *       不能再压缩：压缩会破坏 / \ 跨 lane 的几何连接（多 MR 仓库断线）。
 *
 * 保留函数签名（no-op）以避免破坏调用方和未来重新设计。
 */
export function compactColumns(graph: Graph): void {
  // no-op: column 已是 ASCII lane，压缩会破坏斜线几何。
  // 若未来要恢复"lane 复用"，需要同时改 svg.ts 用 (column, lane) 两套坐标。
  void graph;
}
