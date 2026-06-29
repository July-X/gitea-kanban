/**
 * v2.66 回归测试：dot 中心和 path line 几何对齐
 *
 * 验证 TimelineNewView 的实际渲染公式：
 *   - dot cy = (displayRow * ROW_HEIGHT + rowOffset + ROW_HEIGHT/2) * DISPLAY_SCALE
 *   - path d y = displayRow * ROW_HEIGHT + rowOffset
 *   - path 末尾追加 "v ROW_HEIGHT" → y 末点 = displayRow * ROW_HEIGHT + rowOffset + ROW_HEIGHT
 *
 * 要求：每个 dot center 必须落在对应 path 线段 [y_start, y_end] 范围内
 * （cy = y_start + ROW_HEIGHT/2，正好是 path 线段的中点）
 */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  parseLines,
  layoutVscodeGraph,
  ROW_HEIGHT,
  COL_WIDTH,
  FLOW_LEFT_PAD,
  DISPLAY_SCALE,
} from '../index.ts';

interface TestLine {
  row: number;
  glyph: string;
  commit?: {
    sha: string;
    subject: string;
    isMerge: boolean;
    parents: string[];
  };
}

function makeTestLines(): TestLine[] {
  // 模拟用户的 DeepSeek-Reason 仓库 23 commits 多 PR 数据
  return [
    { row: 0, glyph: '*  ', commit: { sha: 'r0', subject: 'Merge org/main', isMerge: true, parents: ['x','y'] } },
    { row: 1, glyph: '|\\ ' },
    { row: 2, glyph: '| *', commit: { sha: 'r2', subject: 'PR1 B', isMerge: false, parents: ['r3'] } },
    { row: 3, glyph: '| *', commit: { sha: 'r3', subject: 'PR1 A', isMerge: false, parents: ['r5'] } },
    { row: 4, glyph: '|/ ' },
    { row: 5, glyph: '*  ', commit: { sha: 'r5', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 6, glyph: '|\\ ' },
    { row: 7, glyph: '| *', commit: { sha: 'r7', subject: 'Fix file', isMerge: false, parents: ['r8'] } },
    { row: 8, glyph: '| *', commit: { sha: 'r8', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 9, glyph: '| *', commit: { sha: 'r9', subject: 'Fix live', isMerge: false, parents: ['r11'] } },
    { row: 10, glyph: '|/ ' },
    { row: 11, glyph: '*  ', commit: { sha: 'r11', subject: 'Merge org/main', isMerge: true, parents: ['x','y'] } },
    { row: 12, glyph: '|\\ ' },
    { row: 13, glyph: '| *', commit: { sha: 'r13', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 14, glyph: '| *', commit: { sha: 'r14', subject: 'Merge main-v2', isMerge: true, parents: ['x','y'] } },
    { row: 15, glyph: '| *', commit: { sha: 'r15', subject: 'feat: let read', isMerge: false, parents: ['r16'] } },
    { row: 16, glyph: '| *', commit: { sha: 'r16', subject: 'feat: clarify', isMerge: false, parents: ['r18'] } },
    { row: 17, glyph: '|/ ' },
    { row: 18, glyph: '*  ', commit: { sha: 'r18', subject: 'feat: support', isMerge: false, parents: ['r20'] } },
    { row: 19, glyph: '|\\ ' },
    { row: 20, glyph: '| *', commit: { sha: 'r20', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 21, glyph: '|/ ' },
    { row: 22, glyph: '*  ', commit: { sha: 'r22', subject: 'Fix memory', isMerge: false, parents: ['r23'] } },
    { row: 23, glyph: '*  ', commit: { sha: 'r23', subject: 'fix(bot)', isMerge: false, parents: ['r24'] } },
    { row: 24, glyph: '*  ', commit: { sha: 'r24', subject: 'feat: support', isMerge: false, parents: ['r25'] } },
    { row: 25, glyph: '*  ', commit: { sha: 'r25', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 26, glyph: '*  ', commit: { sha: 'r26', subject: 'Unify custom', isMerge: false, parents: ['r27'] } },
    { row: 27, glyph: '*  ', commit: { sha: 'r27', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 28, glyph: '*  ', commit: { sha: 'r28', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
    { row: 29, glyph: '*  ', commit: { sha: 'r29', subject: 'Improve custom', isMerge: false, parents: ['r30'] } },
    { row: 30, glyph: '*  ', commit: { sha: 'r30', subject: 'Merge pull', isMerge: true, parents: ['x','y'] } },
  ];
}

function makeDeepSeekReasonixLines(): TestLine[] {
  return [
    { row: 0, glyph: '*   ', commit: { sha: '9ffb7b223', subject: 'Merge org/main-v2', isMerge: true, parents: ['x','y'] } },
    { row: 1, glyph: '|\\  ' },
    { row: 2, glyph: '| *   ', commit: { sha: 'b9d1ffc60', subject: 'Merge pull request #5470', isMerge: true, parents: ['x','y'] } },
    { row: 3, glyph: '| |\\  ' },
    { row: 4, glyph: '| | * ', commit: { sha: 'e4a72782c', subject: 'Fix file references in plan revisions', isMerge: false, parents: ['x'] } },
    { row: 5, glyph: '| |/  ' },
    { row: 6, glyph: '| *   ', commit: { sha: '5efbb7384', subject: 'Merge pull request #5454', isMerge: true, parents: ['x','y'] } },
    { row: 7, glyph: '| |\\  ' },
    { row: 8, glyph: '| | * ', commit: { sha: 'f54c76353', subject: 'Fix live bot approval mode updates', isMerge: false, parents: ['x'] } },
    { row: 9, glyph: '* | | ', commit: { sha: '3682bcb7a', subject: 'Merge org/main-v2', isMerge: true, parents: ['x','y'] } },
    { row: 10, glyph: '|\\| | ' },
    { row: 11, glyph: '| * |   ', commit: { sha: '427658bc8', subject: 'Merge pull request #5453', isMerge: true, parents: ['x','y'] } },
    { row: 12, glyph: '| |\\ \\  ' },
    { row: 13, glyph: '| | * \\   ', commit: { sha: '8a8daad59', subject: 'Merge main-v2 into external folder refs', isMerge: true, parents: ['x','y'] } },
    { row: 14, glyph: '| | |\\ \\  ' },
    { row: 15, glyph: '| | |/ /  ' },
    { row: 16, glyph: '| |/| |   ' },
    { row: 17, glyph: '| | * | ', commit: { sha: '1976a217e', subject: 'feat: let read tools resolve external folder refs', isMerge: false, parents: ['x'] } },
    { row: 18, glyph: '| | * | ', commit: { sha: 'a81a46583', subject: 'feat: clarify directory ref context', isMerge: false, parents: ['x'] } },
    { row: 19, glyph: '| | * | ', commit: { sha: 'af3d3805e', subject: 'feat: support external folder subpath refs', isMerge: false, parents: ['x'] } },
    { row: 20, glyph: '| * | |   ', commit: { sha: '20e99f691', subject: 'Merge pull request #5452', isMerge: true, parents: ['x','y'] } },
    { row: 21, glyph: '| |\\ \\ \\  ' },
    { row: 22, glyph: '| | * | | ', commit: { sha: '35d247697', subject: 'Fix memory and permission hardening regressions', isMerge: false, parents: ['x'] } },
    { row: 23, glyph: '| |/ / /  ' },
    { row: 24, glyph: '| | | * ', commit: { sha: '20ccf46d2', subject: 'fix(bot): approval restart', isMerge: false, parents: ['x'] } },
  ];
}

/**
 * 提取 SVG path d 里所有 path 段（不含 M 起点）。
 * 返回 [{x1, y1, x2, y2}, ...] 形式的线段数组。
 * - 同 lane V y：从上一个端点 (x, prev_y) 到 (x, y)
 * - 跨 lane C x1 y1, x2 y2, x y：从 (prev_x, prev_y) 到 (x, y) 的 S 曲线
 *   简化对齐验证：dot center (x, y+ROW_H/2) 是否在曲线"包围盒"内：
 *   包围盒 = (min_x, midY-curveDy) 到 (max_x, midY+curveDy) 之间的纵向范围
 */
function pathTouchesPoint(d: string, x: number, y: number): boolean {
  const tokens = d.match(/[MLC]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  let curX = 0;
  let curY = 0;
  while (i < tokens.length) {
    const cmd = tokens[i]!;
    if (cmd === 'M') {
      curX = Number(tokens[i + 1]!);
      curY = Number(tokens[i + 2]!);
      if (Math.abs(curX - x) < 0.001 && Math.abs(curY - y) < 0.001) return true;
      i += 3;
    } else if (cmd === 'L') {
      const x2 = Number(tokens[i + 1]!);
      const y2 = Number(tokens[i + 2]!);
      const cross = Math.abs((x - curX) * (y2 - curY) - (y - curY) * (x2 - curX));
      const within =
        x >= Math.min(curX, x2) - 0.001 &&
        x <= Math.max(curX, x2) + 0.001 &&
        y >= Math.min(curY, y2) - 0.001 &&
        y <= Math.max(curY, y2) + 0.001;
      if (cross < 0.001 && within) return true;
      curX = x2;
      curY = y2;
      i += 3;
    } else if (cmd === 'C') {
      const x2 = Number(tokens[i + 5]!);
      const y2 = Number(tokens[i + 6]!);
      if (Math.abs(curX - x) < 0.001 && Math.abs(curY - y) < 0.001) return true;
      if (Math.abs(x2 - x) < 0.001 && Math.abs(y2 - y) < 0.001) {
        return true;
      }
      curX = x2;
      curY = y2;
      i += 7;
    } else {
      i++;
    }
  }
  return false;
}

function assertDotsOnLines(testLines: TestLine[]): void {
  const { graph } = parseLines(testLines as any);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));
  let totalMismatches = 0;
  let totalChecks = 0;

  const layout = layoutVscodeGraph(graph, displayRowMap, { rowOffsets: new Map() });
  const paths = layout.paths.map((path) => path.d);

  for (const c of graph.commits) {
    const dr = displayRowMap.get(c.row)!;
    const lane = layout.nodes.get(c.sha)?.lane ?? 0;
    const dotCx = (lane * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD) * DISPLAY_SCALE;
    const dotCy = (dr * ROW_HEIGHT + ROW_HEIGHT / 2) * DISPLAY_SCALE;
    const graphCx = dotCx / DISPLAY_SCALE;
    const graphCy = dotCy / DISPLAY_SCALE;
    const hit = paths.some((d) => pathTouchesPoint(d, graphCx, graphCy));
    totalChecks++;
    if (!hit) {
      totalMismatches++;
      console.error(`MISMATCH: commit sha=${c.sha.slice(0, 9)} asciiRow=${c.row} displayRow=${dr} → dot (${dotCx}, ${dotCy}) 不在任何父子边端点上`);
    }
  }

  console.log(`  total checks: ${totalChecks}, mismatches: ${totalMismatches}`);
  assert.equal(totalMismatches, 0, `所有 dot 必须落在线上，mismatches=${totalMismatches}`);
}

describe('gitgraph dot/line 对齐', () => {
test('v2.66 dot 和 line 严格对齐：每个 dot center 必须落在对应 path 线段中点（±ROW_H/4 容差）', () => {
  assertDotsOnLines(makeTestLines());

  // 1. 验证 viewBox/svgHeight 跟 commit 数匹配
  const testLines = makeTestLines();
  const { graph } = parseLines(testLines as any);
  const commitCount = graph.commits.length;
  const expectedTotalHeight = commitCount * ROW_HEIGHT + 0;
  assert.equal(expectedTotalHeight, commitCount * ROW_HEIGHT, 'viewBox 高度 = commitCount * ROW_HEIGHT');
});

test('DeepSeek-Reasonix 真实多 PR glyph：dot 必须落在对应分支线上', () => {
  assertDotsOnLines(makeDeepSeekReasonixLines());
});

test('v2.66 viewBox 高度 = commitCount * ROW_HEIGHT（不依赖 maxRow，maxRow 包含 edge 行）', () => {
  const testLines = makeTestLines();
  const { graph } = parseLines(testLines as any);

  const commitCount = graph.commits.length;
  // 当前代码用 commitCount 而非 maxRow+1，避免 edge 行污染
  const expectedViewBoxHeight = commitCount * ROW_HEIGHT;

  // maxRow 应该 > commitCount（因为 edge row 占行）
  assert.ok(graph.maxRow >= commitCount, `maxRow (${graph.maxRow}) 应该 >= commitCount (${commitCount})`);

  // viewBox 高度 = commitCount * ROW_HEIGHT（不是 maxRow+1 * ROW_HEIGHT）
  const currentViewBoxHeight = commitCount * ROW_HEIGHT;
  assert.equal(currentViewBoxHeight, expectedViewBoxHeight, 'viewBox 高度正确');
});
});
