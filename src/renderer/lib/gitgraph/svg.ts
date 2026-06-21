/**
 * Git Graph SVG path 生成 —— 1:1 对齐 Gitea templates/repo/graph/svgcontainer.tmpl
 *
 * 坐标公式（列宽 5 unit / 行高 12 unit）：
 *   - '*' | '|'      → M (col*5 + 5) (row*12 + 0) v 12
 *                        垂直线，格顶中点 → 格底中点
 *   - '/'            → M (col*5 + 10) (row*12 + 0) l -10 12
 *                        从右上格边界斜向左下格角
 *   - '\\'           → M (col*5 + 0) (row*12 + 0) l 10 12
 *                        从左上格角斜向右下格边界
 *   - '-' | '.'      → M (col*5 + 0) (row*12 + 12) h 5
 *                        底部水平短线（左 → 中点）
 *   - '_'            → M (col*5 + 0) (row*12 + 12) h 10
 *                        底部水平长线（左 → 下一格）
 *
 * 这些公式直接复刻 Gitea svgcontainer.tmpl:5-16 的 {{template "shared/gitgraph/glyph"}}
 * 输出。
 *
 * 一个 flow 的所有 glyph path 段拼接成一个 d 字符串（用空格分隔），
 * 渲染端直接 `<path :d="path.d" ...>`。
 */

import type { Flow, Glyph } from './models.js';

// ============================================================
// 单字形 → path d 段
// ============================================================

/** 单字形 → path d 段字符串（与 svgcontainer.tmpl 公式一致） */
export function glyphToPathD(g: Glyph): string {
  const x = g.column * 5;
  const y = g.row * 12;
  switch (g.glyph) {
    case '*':
    case '|':
      // 垂直线 v 12
      return `M ${x + 5} ${y} v 12`;
    case '/':
      // 右上 → 左下对角线
      return `M ${x + 10} ${y} l -10 12`;
    case '\\':
      // 左上 → 右下对角线
      return `M ${x} ${y} l 10 12`;
    case '-':
    case '.':
      // 底部水平短线（左 → 中点）
      return `M ${x} ${y + 12} h 5`;
    case '_':
      // 底部水平长线（左 → 下一格）
      return `M ${x} ${y + 12} h 10`;
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
