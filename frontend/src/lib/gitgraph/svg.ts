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
      // / 从本列右缘斜向左下到左邻列右缘（git graph 的 / 每条只跨 1 lane）
      //
      // 修复"多 MR 仓库 graph 大量断线"：
      // 旧代码用 g.parentColumn（parser 传入的 flowID）当列坐标，但密集 merge 区
      // parentColumn 可能指向已死 flow（compactColumns 无法修正）→ 斜线起点 x 错位 → 断线。
      // git log --graph 的 / \ 几何上恒跨相邻 1 lane，parent 列恒为 column-1，无需依赖 parentColumn。
      return `M ${x + COL_WIDTH} ${y} l ${-COL_WIDTH} ${ROW_HEIGHT}`;
    }
    case '\\': {
      // \ 从左邻列右缘斜向右下到本列右缘（跨相邻 1 lane）
      return `M ${x} ${y} l ${COL_WIDTH} ${ROW_HEIGHT}`;
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
