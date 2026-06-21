/**
 * Git Graph SVG path 生成 —— 1:1 对齐 Gitea templates/repo/graph/svgcontainer.tmpl
 *
 * 坐标公式（列宽 COL_WIDTH unit / 行高 ROW_HEIGHT unit）：
 *   - '*' | '|'      → M (col*CW + CW) (row*RH + 0) v RH
 *                        垂直线，本列右缘
 *   - '/'            → M (col*CW + CW) (row*RH) l -(col-parent)*CW RH
 *                        本列右缘 → parent 列右缘（跨 dead 列也能衔接）
 *   - '\\'           → M (parent*CW + CW) (row*RH) l (col-parent)*CW RH
 *                        parent 列右缘 → 本列右缘（跨 dead 列也能衔接）
 *   - '-' | '.'      → M (col*CW) (row*RH + RH) h CW
 *                        底部水平短线（左 → 右）
 *   - '_'            → M (col*CW) (row*RH + RH) h 2*CW
 *                        底部水平长线（左 → 右二格）
 *
 * 这些公式直接复刻 Gitea svgcontainer.tmpl:5-16 的 {{template "shared/gitgraph/glyph"}}
 * 输出。
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
      // 本列右缘 → parent 列右缘
      const pc = g.parentColumn ?? g.column - 1;
      const span = g.column - pc;
      return `M ${x + COL_WIDTH} ${y} l ${-span * COL_WIDTH} ${ROW_HEIGHT}`;
    }
    case '\\': {
      // parent 列右缘 → 本列右缘
      const pc = g.parentColumn ?? g.column - 1;
      const span = g.column - pc;
      return `M ${pc * COL_WIDTH + COL_WIDTH} ${y} l ${span * COL_WIDTH} ${ROW_HEIGHT}`;
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
