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

/** SVG 单位列宽（unit），控制 flow lane 之间的间距
 *
 * v2.46：5 → 10，与 structured 路径 LANE_WIDTH=10 对齐
 *   —— 之前 GitHub 仓库用 ASCII 路径 5px/lane、Gitea 仓库用 structured 路径 10px/lane，
 *      切换平台时 lane 视觉密度明显不一致（5px 看起来"挤"，10px 看起来"宽松"）。
 *   现在两边统一 10px/lane，跨平台视觉一致。
 *
 *   ⚠️ 同步影响 svg.ts（所有 path d x 坐标 ×2）+ TimelineNewView.vue 的 dot cx + svgWidth
 *   全部从 5 翻 10。viewBox 同步翻倍（容器自动 stretch）。
 *   ROW_HEIGHT=30 不变，所以 / \ 斜线斜率从 30/10=3.0 变 30/20=1.5（更平），这是为了
 *   配合 SourceTree 风格 (structured 路径) 的视觉，ASCII 路径的字符流语义不再保留。
 *
 *   ⚠️ 此改动只影响 ASCII 路径（git --graph 字符流渲染）。
 *   structured 路径用 structured.ts 自己的 LANE_WIDTH=10，与本常量无关。
 *   - svgWidth = graphWidth * 10 + 10（与 Gitea SVG 容器一致）
 *   - 之前是 5（lane 5px），改 10 后 ASCII git-graph 整体更接近 structured 视觉
 */
export const COL_WIDTH = 10;

/** SVG 单位行高（unit）。
 *  v2.45 调整到 30px，让 ASCII 路径 commit-row 容器与 Gitea 路径完全统一
 *  （font 14px × line-height 1.571 ≈ 22px line-box, row 30px - 22px = 8px 上下气口）。
 *
 *  ⚠️ 同步影响：svg.ts（ASCII 路径 path d 生成）+ TimelineNewView.vue 的 ROW_H / dot cy
 *  / svgHeight 全部从 19 变 30，commit-row 容器高度跟着抬到 30px。
 *  structured 路径独立维护自己的 ROW_HEIGHT=30（structured.ts:76），本来就一致。
 */
export const ROW_HEIGHT = 30;

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
 *   path 和 dot 计算公式完全一致：column*COL_WIDTH + COL_WIDTH/2 + FLOW_LEFT_PAD（中线）。*/
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
//
// v2.6 前 column = flowID（按时间复用已死 flow 的 column）。
// v2.x 后 column = ASCII lane 下标（/ \ 跨 lane 几何正确），
// ASCII lane 已是紧凑表示，不能再压缩，compress 会破坏斜线几何。
// 旧 no-op `compactColumns` 已删除。
