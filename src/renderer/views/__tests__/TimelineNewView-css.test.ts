/**
 * TimelineNewView.vue CSS 布局回归测试（commit 14）
 *
 * 背景：用户报告 Git Graph 渲染"错乱"——dot 圆点与 commit 文字不对齐、SVG 被压缩。
 *
 * 根因 1：`.git-graph-svg-area` 有 `max-width: 240px; overflow: hidden`
 *         当 git graph 多列时（cols ≥ 24）SVG width > 240px，被容器 overflow:hidden 截断；
 *         同时 SVG 元素被强制等比缩放（preserveAspectRatio 默认），dot overlay 与 SVG
 *         视觉位置不再 1:1 对齐
 *
 * 根因 2：`.commit-row` 有 `height: 24px + padding: 8px (top+bottom)` 实际总高度 ≈ 41px
 *         但 SVG ×2 缩放后行高 = 24px，dot top = row*24+12-4 按 SVG 行高算
 *         → dot 圆心永远在 commit 文字**正上方**（错位 ~17px/行 × rows）
 *
 * 修复：
 * 1. .git-graph-svg-area 去掉 max-width + overflow:hidden → 改 overflow-x:auto
 * 2. .git-graph-wrapper 加 min-width: max-content → 触发整体横向滚动
 * 3. .commit-row padding 8px → 0（严格 24px + box-sizing: border-box）
 *
 * 验证：本测试直接 import TimelineNewView.vue + parse CSS-like 字符串，
 *       断言关键 CSS 规则存在 / 不存在。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEW_PATH = resolve(__dirname, '../TimelineNewView.vue');
const viewSource = readFileSync(VIEW_PATH, 'utf-8');

describe('TimelineNewView.vue CSS 回归', () => {
  it('bug fix #1：去掉 .git-graph-svg-area max-width 截断（修复 SVG 被压缩错乱）', () => {
    // 旧代码：max-width: 240px; overflow: hidden → SVG 被压缩，dot 与列表对不齐
    expect(viewSource).not.toMatch(/\.git-graph-svg-area\s*\{[^}]*max-width:\s*240px/);
    // 新代码：overflow-x: auto（多列时整体横向滚动）
    expect(viewSource).toMatch(/\.git-graph-svg-area\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('bug fix #2：commit-row 严格 24px（修复 dot 与 commit 文字错位）', () => {
    // 匹配 .commit-row { ... } 块
    const commitRowMatch = viewSource.match(/\.commit-row\s*\{([^}]+)\}/);
    expect(commitRowMatch).not.toBeNull();
    const block = commitRowMatch![1]!;
    // 严格 24px 行高（不能有 padding 撑高）
    expect(block).toMatch(/height:\s*24px/);
    // padding 不能是 8px（之前 padding: 8px var(--space-3, 12px) 把行高撑到 ~41px）
    expect(block).not.toMatch(/padding:\s*8px/);
    // 必须有 box-sizing: border-box（让 border 不计入 height）
    expect(block).toMatch(/box-sizing:\s*border-box/);
  });

  it('bug fix #3：git-graph-wrapper 加 min-width: max-content（多列时整体横向滚动）', () => {
    expect(viewSource).toMatch(/\.git-graph-wrapper\s*\{[^}]*min-width:\s*max-content/);
  });
});
