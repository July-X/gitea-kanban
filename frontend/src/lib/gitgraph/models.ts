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

/** SVG 单位行高（unit） */
export const ROW_HEIGHT = 12;

/** 显示缩放系数（1 SVG unit = SCALE px） */
export const DISPLAY_SCALE = 2;

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
 * - w = (maxColumn - minColumn + 1) * COL_WIDTH + COL_WIDTH
 * - h = (maxRow - minRow + 1) * ROW_HEIGHT
 */
export function svgViewBox(g: Graph): string {
  const x = g.minColumn * COL_WIDTH;
  const y = g.minRow * ROW_HEIGHT;
  const w = graphWidth(g) * COL_WIDTH + COL_WIDTH;
  const h = graphHeight(g) * ROW_HEIGHT;
  return `${x} ${y} ${w} ${h}`;
}

/** SVG 显示宽度（px） */
export function svgWidthPx(g: Graph): string {
  return `${graphWidth(g) * COL_WIDTH * DISPLAY_SCALE + COL_WIDTH * DISPLAY_SCALE}px`;
}

/** SVG 显示高度（px） */
export function svgHeightPx(g: Graph): string {
  return `${graphHeight(g) * ROW_HEIGHT * DISPLAY_SCALE}px`;
}

// ============================================================
// 列压缩：flow 尽量左靠，复用已死 column
// ============================================================

/**
 * 压缩列号分配 —— 贪心左边缘算法。
 *
 * 扫描所有 flow 的时间区间（minRow..maxRow），为时间上不重叠的
 * flow 复用同一列号，把 active flows 尽可能向左压缩。
 */
export function compactColumns(graph: Graph): void {
  if (graph.flows.size <= 1) return;

  const sorted = [...graph.flows.values()].sort(
    (a, b) => a.minRow - b.minRow || a.id - b.id,
  );

  const assign = new Map<number, number>(); // flowId → 新列号

  for (const flow of sorted) {
    let col = 1;
    while (true) {
      let conflict = false;
      for (const [otherId, otherCol] of assign) {
        if (otherCol !== col) continue;
        const other = graph.flows.get(otherId)!;
        if (flow.minRow <= other.maxRow && other.minRow <= flow.maxRow) {
          conflict = true;
          break;
        }
      }
      if (!conflict) break;
      col++;
    }
    assign.set(flow.id, col);
  }

  const offsets = new Map<number, number>();
  for (const flow of graph.flows.values()) {
    const newCol = assign.get(flow.id);
    if (newCol === undefined) continue;
    offsets.set(flow.id, newCol - flow.minColumn);
  }

  for (const flow of graph.flows.values()) {
    const offset = offsets.get(flow.id);
    if (!offset) continue;

    flow.minColumn += offset;
    flow.maxColumn += offset;
    for (const g of flow.glyphs) {
      g.column += offset;
    }
    for (const g of flow.glyphs) {
      if (g.parentColumn !== undefined) {
        const po = offsets.get(g.parentColumn);
        if (po !== undefined) g.parentColumn += po;
      }
    }
  }

  for (const c of graph.commits) {
    const offset = offsets.get(c.flowId);
    if (offset) c.column += offset;
  }

  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const flow of graph.flows.values()) {
    if (flow.minColumn < minCol) minCol = flow.minColumn;
    if (flow.maxColumn > maxCol) maxCol = flow.maxColumn;
  }
  graph.minColumn = minCol < Infinity ? minCol : 0;
  graph.maxColumn = maxCol > -Infinity ? maxCol : 0;
}
