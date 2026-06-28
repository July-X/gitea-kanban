/**
 * Git Graph SVG path 生成 —— 对齐 Gitea 路径（structured.ts）的 SourceTree 风格几何
 *
 * v2.46：把 ASCII 路径从"复刻 Gitea git log --graph 字符流"(右缘对齐 5px/lane)
 *        改成"对齐 structured 路径 LANE_WIDTH=10 中线对齐"——两侧视觉规则一致。
 *
 * 坐标公式（列宽 COL_WIDTH unit / 行高 ROW_HEIGHT unit，**lane 中线对齐**）：
 *   - '*' | '|'      → M (col*CW + CW/2) (row*RH + 0) v RH
 *                        垂直线，本 lane 中线
 *   - '/'            → M ((col+1)*CW + CW/2) (row*RH + 0) l (-2*CW) RH
 *                        起点：右邻 lane (col+1) 中线
 *                        终点：左邻 lane (col-1) 中线
 *                        跨 2 lane（git log --graph 的 / 是合并线，从右上斜向左下）
 *   - '\\'           → M ((col-1)*CW + CW/2) (row*RH + 0) l (2*CW) RH
 *                        起点：左邻 lane (col-1) 中线
 *                        终点：右邻 lane (col+1) 中线
 *                        跨 2 lane（\ 是分叉线，从左上斜向右下）
 *   - '-' | '.'      → M (col*CW - CW/2) (row*RH + RH) h CW
 *                        底部水平短线（lane 左缘 → 中线 → 右缘，1 个 lane 宽）
 *   - '_'            → M (col*CW - CW/2) (row*RH + RH) h 2*CW
 *                        底部水平长线（lane 左缘 → 中线 → 右缘 → 右邻中线，2 个 lane 宽）
 *
 * 这些公式跟 structured.ts laneX(lane) = lane*LANE_WIDTH + LANE_WIDTH/2 + FLOW_LEFT_PAD
 * 完全镜像（structured 路径 LANE_WIDTH 与本模块 COL_WIDTH 都是 10）。dot cx 也用中线公式，
 * path d 与 dot 都在 lane 中线对齐（SourceTree 风格）。
 *
 * 关键前提：g.column 是 ASCII 字符流下标（lane 编号），不是 flowID。
 * 见 parser.ts addLineToGraph 的注释。
 *
 * 一个 flow 的所有 glyph path 段拼接成一个 d 字符串（用空格分隔），
 * 渲染端直接 `<path :d="path.d" ...>`。
 */

import type { Flow, Glyph } from './models.js';
import { COL_WIDTH, FLOW_LEFT_PAD, ROW_HEIGHT } from './models.js';

// ============================================================
// 单字形 → path d 段
// ============================================================

/** 单字形 → path d 段字符串
 *
 * v2.42：所有 path 内部 x 坐标 +FLOW_LEFT_PAD（与 dot cx 公式一致）。
 * v2.46：把 path x 从"lane 右缘 (col*CW + CW)"改成"lane 中线 (col*CW + CW/2)"，
 *        与 structured 路径 laneX() 公式对齐（structured LANE_WIDTH=10 → 中线 lane*10+5）。
 *   viewBox.x = minColumn * COL_WIDTH（不偏移），path 内部 +FLOW_LEFT_PAD + COL_WIDTH/2，
 *   path 渲染位置 = (column*10 + 5 + 4 - minColumn*10) = (column-minColumn)*10 + 9，
 *   与 dot cx (column*10 + 5 - minX + 4) = (column-minColumn)*10 + 9 完全一致 ✓。*/
export function glyphToPathD(g: Glyph): string {
  const xCenter = g.column * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
  const y = g.row * ROW_HEIGHT;
  switch (g.glyph) {
    case '*':
    case '|':
      // 垂直线 v ROW_HEIGHT（本列中线）
      return `M ${xCenter} ${y} v ${ROW_HEIGHT}`;
    case '/': {
      // / 从右邻 lane (col+1) 中线斜向左下到左邻 lane (col-1) 中线（跨 2 lane）
      //
      // 跨 2 lane 几何：起点 ((col+1)*CW + CW/2)，终点 ((col-1)*CW + CW/2)，
      // 横向距离 = (col+1 - (col-1)) * CW = 2*CW，纵向 ROW_HEIGHT，斜率 = RH/(2*CW) = 30/20 = 1.5
      // (v2.46 前 CW=5 时斜率 30/10=3.0，更陡)。
      const sx = (g.column + 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      const ex = (g.column - 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      return `M ${sx} ${y} l ${ex - sx} ${ROW_HEIGHT}`;
    }
    case '\\': {
      // \ 从左邻 lane (col-1) 中线斜向右下到右邻 lane (col+1) 中线（跨 2 lane）
      const sx = (g.column - 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      const ex = (g.column + 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      return `M ${sx} ${y} l ${ex - sx} ${ROW_HEIGHT}`;
    }
    case '-':
    case '.':
      // 底部水平短线（从本 lane 左缘 → 右缘，长 1 个 lane = CW）
      return `M ${xCenter - COL_WIDTH / 2} ${y + ROW_HEIGHT} h ${COL_WIDTH}`;
    case '_':
      // 底部水平长线（从本 lane 左缘 → 右邻 lane 中线，长 2 个 lane = 2*CW）
      return `M ${xCenter - COL_WIDTH / 2} ${y + ROW_HEIGHT} h ${2 * COL_WIDTH}`;
    default:
      return '';
  }
}

// ============================================================
// Flow → 单条 path d
// ============================================================

/**
 * 一个 flow 的所有 glyph 拼成一条 path d。
 *
 * 返回空字符串表示该 flow 没有可视 glyph（孤立 commit / 仅含 ' '）。
 *
 * 注：glyphs 应该**已经按 (row, column) 升序排好**（parser.ts 收尾时会排），
 * 渲染出来的 path 在 SVG 里视觉上"自顶向下"扫描，与 commit 列表对齐。
 */
export function flowToPathD(flow: Flow): string {
  if (flow.glyphs.length === 0) return '';
  const parts: string[] = [];
  for (const g of flow.glyphs) {
    const d = glyphToPathD(g);
    if (d) parts.push(d);
  }
  return parts.join(' ');
}
