/**
 * Git Graph SVG path 生成 —— 1:1 对齐 Gitea templates/repo/graph/svgcontainer.tmpl
 *
 * 坐标公式（列宽 COL_WIDTH unit / 行高 ROW_HEIGHT unit）：
 *   - '*' | '|'      → M (col*CW + CW) (row*RH + 0) v RH
 *                        垂直线，本 lane 右缘
 *   - '/'            → M ((col+1)*CW + CW) (row*RH + 0) l (-2*CW) RH
 *                        起点：右邻 lane (col+1) 右缘
 *                        终点：左邻 lane (col-1) 右缘
 *                        跨 2 lane（git log --graph 的 / 是合并线，从右上斜向左下）
 *   - '\\'           → M ((col-1)*CW + CW) (row*RH + 0) l (2*CW) RH
 *                        起点：左邻 lane (col-1) 右缘
 *                        终点：右邻 lane (col+1) 右缘
 *                        跨 2 lane（\ 是分叉线，从左上斜向右下）
 *   - '-' | '.'      → M (col*CW) (row*RH + RH) h CW
 *                        底部水平短线（左 → 右）
 *   - '_'            → M (col*CW) (row*RH + RH) h 2*CW
 *                        底部水平长线（左 → 右二格）
 *
 * 这些公式直接复刻 Gitea svgcontainer.tmpl:5-16 的 {{template "shared/gitgraph/glyph"}}
 * 输出。
 *
 * 关键前提：g.column 是 ASCII 字符流下标（lane 编号），不是 flowID。
 * 见 parser.ts addLineToGraph 的注释。
 *
 * 一个 flow 的所有 glyph path 段拼接成一个 d 字符串（用空格分隔），
 * 渲染端直接 `<path :d="path.d" ...>`。
 */

import type { Flow, Glyph } from './models.js';
import { COL_WIDTH, ROW_HEIGHT } from './models.js';

// ============================================================
// 单字形 → path d 段
// ============================================================

/** 单字形 → path d 段字符串 */
export function glyphToPathD(g: Glyph): string {
  const x = g.column * COL_WIDTH;
  const y = g.row * ROW_HEIGHT;
  switch (g.glyph) {
    case '*':
    case '|':
      // 垂直线 v ROW_HEIGHT（本列右缘）
      return `M ${x + COL_WIDTH} ${y} v ${ROW_HEIGHT}`;
    case '/': {
      // / 从右邻 lane (col+1) 右缘斜向左下到左邻 lane (col-1) 右缘（跨 2 lane）
      //
      // 修复"多 MR 仓库 graph 大量断线"：
      // v1 用 g.parentColumn（parser 传入的 flowID）算跨距，但密集 merge 区
      //   parentColumn 可能指向已死 flow（compactColumns 无法修正）→ 斜线端点错位 → 断线。
      // v2 简化为"跨 1 lane (column±1)"，但 git log --graph 的 / 实际跨 2 lane，
      //   起点 / 终点与垂直线 | 错位 1 lane，仍有大量断线。
      // v3 对齐 Gitea svgcontainer.tmpl 几何：跨 2 lane (column-1 ↔ column+1)，
      //   起点 ((col+1)*CW + CW) 与上一行 | 终点 (col*CW + CW) 相差 1 lane，
      //   但 * 在 col+1 的右缘 = (col+1)*CW + CW，所以 / 起点正好接 * 在 col+1 行的底部。
      const sx = (g.column + 1) * COL_WIDTH + COL_WIDTH;
      const ex = (g.column - 1) * COL_WIDTH + COL_WIDTH;
      return `M ${sx} ${y} l ${ex - sx} ${ROW_HEIGHT}`;
    }
    case '\\': {
      // \ 从左邻 lane (col-1) 右缘斜向右下到右邻 lane (col+1) 右缘（跨 2 lane）
      const sx = (g.column - 1) * COL_WIDTH + COL_WIDTH;
      const ex = (g.column + 1) * COL_WIDTH + COL_WIDTH;
      return `M ${sx} ${y} l ${ex - sx} ${ROW_HEIGHT}`;
    }
    case '-':
    case '.':
      // 底部水平短线
      return `M ${x} ${y + ROW_HEIGHT} h ${COL_WIDTH}`;
    case '_':
      // 底部水平长线
      return `M ${x} ${y + ROW_HEIGHT} h ${2 * COL_WIDTH}`;
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
