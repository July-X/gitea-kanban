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

/** 字形：git --graph 输出中的一个字符位置 */
export interface Glyph {
  /** 行号（Y 坐标） */
  row: number;
  /** 列号（X 坐标） */
  column: number;
  /** 字形字符：* | / \ _ - . 或 ' ' */
  glyph: string;
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
    minColumn: 0,
    maxColumn: 0,
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
 * SVG viewBox 字符串（与 Gitea svgcontainer.tmpl 1:1）
 * - 列宽 5 unit / 行高 12 unit
 * - x = minColumn * 5；y = minRow * 12
 * - w = (maxColumn - minColumn + 1) * 5 + 5
 * - h = (maxRow - minRow + 1) * 12
 */
export function svgViewBox(g: Graph): string {
  const x = g.minColumn * 5;
  const y = g.minRow * 12;
  const w = graphWidth(g) * 5 + 5;
  const h = graphHeight(g) * 12;
  return `${x} ${y} ${w} ${h}`;
}

/** SVG 显示宽度（px，列宽 ×2 + 内边距，与 TimelineNewView 缩放系数一致） */
export function svgWidthPx(g: Graph): string {
  return `${graphWidth(g) * 10 + 10}px`;
}

/** SVG 显示高度（px，行高 ×2） */
export function svgHeightPx(g: Graph): string {
  return `${graphHeight(g) * 24}px`;
}
