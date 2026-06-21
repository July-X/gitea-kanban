/**
 * TimelineNewView 渲染契约测试（commit-row 全 row 渲染）
 *
 * 背景（用户截图）：
 *   - dot overlay 在 row 0/2/4 画 3 个 dot（按 row*24 绝对定位）
 *   - commit-row v-for="graph.commits" 只渲染 3 个有 commit 的行
 *   - 视觉上：dot 在 row 0, 2, 4（中间空 24px 空隙），但 commit-row 紧挨着
 *   - **底部 dot 没对应 commitlog** —— 因为 row 4 的 dot 在底部，但 row 4 的 commit-row 是第 3 个
 *     v-for 元素，被 flex 自然排列到 list 中间位置（前面两个 row 0, 2 之间没空行占位）
 *
 * 修复（commit X）：
 *   1. 加 `allRows` computed —— row 0..maxRow 顺序铺满，commit 与 relation 占位交错
 *   2. commit-row v-for 改用 allRows（每行 24px 一致节奏）
 *   3. relation 行加 `.commit-row--relation` 类（高度 24px、不可点、透明）
 *
 * 本测试断言（直接 grep TimelineNewView.vue 源码）：
 *   - 有 `allRows` computed
 *   - v-for 用 allRows（不是 graph.commits）
 *   - 有 .commit-row--relation 样式（24px + pointer-events: none + transparent）
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEW_PATH = resolve(__dirname, '../TimelineNewView.vue');
const viewSource = readFileSync(VIEW_PATH, 'utf-8');

describe('TimelineNewView allRows + relation 占位（dot 与 commit-row 行节奏对齐）', () => {
  it('有 allRows computed（铺满 row 0..maxRow）', () => {
    expect(viewSource).toMatch(/const\s+allRows\s*=\s*computed/);
    // allRows 内部 for 0..maxRow
    expect(viewSource).toMatch(/for\s*\(\s*let\s+row\s*=\s*0;\s*row\s*<=\s*graph\.value\.maxRow/);
  });

  it('commit-row v-for 用 allRows（不是 graph.commits）', () => {
    // 必须 v-for="r in allRows"（不再 v-for="c in graph.commits"）
    expect(viewSource).toMatch(/v-for=["']r\s+in\s+allRows["']/);
    expect(viewSource).not.toMatch(/v-for=["']c\s+in\s+graph\.commits["']\s+class=["']commit-row/);
  });

  it('relation 行加 .commit-row--relation 样式（24px + pointer-events:none + transparent）', () => {
    // 类名存在
    expect(viewSource).toMatch(/commit-row--relation/);
    // 样式块：height: 24px
    const relMatch = viewSource.match(/\.commit-row--relation\s*\{([^}]+)\}/);
    expect(relMatch).not.toBeNull();
    const block = relMatch![1]!;
    expect(block).toMatch(/height:\s*24px/);
    expect(block).toMatch(/pointer-events:\s*none/);
    expect(block).toMatch(/background:\s*transparent/);
  });

  it('dot 与 commit-row 行节奏对齐：commit-row 高度严格 24px', () => {
    // .commit-row { ... height: 24px ... }（不允许 padding 撑高）
    const rowMatch = viewSource.match(/\.commit-row\s*\{([^}]+)\}/);
    expect(rowMatch).not.toBeNull();
    const block = rowMatch![1]!;
    expect(block).toMatch(/height:\s*24px/);
    expect(block).toMatch(/padding:\s*0\s+var\(--space-3/); // padding 0 不能有 top/bottom
  });
});
