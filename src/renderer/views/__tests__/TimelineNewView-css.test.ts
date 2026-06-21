/**
 * TimelineNewView.vue CSS 布局回归测试
 *
 * 覆盖 3 个 bug 修复（不锁死具体实现方式）：
 *
 * bug #1：.git-graph-svg-area { max-width: 240px; overflow: hidden }
 *        当 git graph 多列时 SVG 被容器截断/压缩，dot overlay 与 SVG 视觉错位
 *        修复：去 max-width + overflow:hidden
 *
 * bug #2：.commit-row 实际行高 ≠ SVG 行高
 *        旧 padding: 8px + height: 24px → 实际 ~41px
 *        但 dot top = row*24+12-4 按 SVG 行高算 → dot 永远在 commit 文字上方
 *        修复：commit-row 高度严格 24px（CSS 或内联 style 都行）
 *
 * bug #3：多列时整体横向滚动
 *        修复：.git-graph-wrapper 加 min-width: max-content
 *
 * 实现兼容：commit `c3e40e1` 把高度改成 ROW_H = ROW_HEIGHT * DISPLAY_SCALE
 * 内联 style 绑定；旧实现是 CSS height:24px。两种模式都接受。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEW_PATH = resolve(__dirname, '../TimelineNewView.vue');
const viewSource = readFileSync(VIEW_PATH, 'utf-8');

describe('TimelineNewView.vue CSS 回归', () => {
  it('bug fix #1：去掉 .git-graph-svg-area max-width 截断', () => {
    // 旧 bug：max-width: 240px + overflow: hidden
    expect(viewSource).not.toMatch(/\.git-graph-svg-area\s*\{[^}]*max-width:\s*240px/);
    // 修复后：overflow-x: auto（多列整体横向滚动）
    expect(viewSource).toMatch(/\.git-graph-svg-area\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('bug fix #2：commit-row 严格 24px（修复 dot 与 commit 文字错位）', () => {
    // 匹配 .commit-row { ... } 块
    const commitRowMatch = viewSource.match(/\.commit-row\s*\{([^}]+)\}/);
    expect(commitRowMatch).not.toBeNull();
    const block = commitRowMatch![1]!;

    // 高度来源有两种实现方式（任一即可）：
    //   (a) CSS 块里 height: 24px
    //   (b) 内联 style 绑 ROW_H 常量（ROW_HEIGHT * DISPLAY_SCALE = 12 * 2 = 24）
    const hasCssHeight = block.includes('height: 24px');
    const hasInlineRowH =
      /:style\s*=\s*["']\{\s*height:\s*ROW_H/.test(viewSource) ||
      /:style\s*=\s*["']\{\s*height:\s*\$\{?ROW_H\}?/.test(viewSource);
    expect(hasCssHeight || hasInlineRowH).toBe(true);

    // padding 不能是 8px（之前把行高撑到 ~41px）
    expect(block).not.toMatch(/padding:\s*8px/);

    // 必须有 box-sizing: border-box（让 border 不计入 height）
    expect(block).toMatch(/box-sizing:\s*border-box/);
  });

  it('bug fix #3：git-graph-wrapper 加 min-width: max-content（多列整体横向滚动）', () => {
    expect(viewSource).toMatch(/\.git-graph-wrapper\s*\{[^}]*min-width:\s*max-content/);
  });
});
