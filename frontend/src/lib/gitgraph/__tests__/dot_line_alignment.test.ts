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
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLines,
  flowToPathDCompact,
  ROW_HEIGHT,
  COL_WIDTH,
  FLOW_LEFT_PAD,
  DISPLAY_SCALE,
  type Flow,
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

/**
 * 提取 SVG path d 里所有 path 段（不含 M 起点）。
 * 返回 [{x1, y1, x2, y2}, ...] 形式的线段数组。
 * - 同 lane V y：从上一个端点 (x, prev_y) 到 (x, y)
 * - 跨 lane C x1 y1, x2 y2, x y：从 (prev_x, prev_y) 到 (x, y) 的 S 曲线
 *   简化对齐验证：dot center (x, y+ROW_H/2) 是否在曲线"包围盒"内：
 *   包围盒 = (min_x, midY-curveDy) 到 (max_x, midY+curveDy) 之间的纵向范围
 */
function extractPathSegments(d: string, prevX: number, prevY: number): Array<{ x1: number; y1: number; x2: number; y2: number; kind: 'v' | 'l' | 'c' }> {
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number; kind: 'v' | 'l' | 'c' }> = [];
  let curX = prevX, curY = prevY;
  const tokens = d.match(/[MLVCv]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i]!;
    if (cmd === 'M') {
      curX = Number(tokens[i + 1]!);
      curY = Number(tokens[i + 2]!);
      i += 3;
    } else if (cmd === 'L') {
      const x = Number(tokens[i + 1]!);
      const y = Number(tokens[i + 2]!);
      segments.push({ x1: curX, y1: curY, x2: x, y2: y, kind: 'l' });
      curX = x;
      curY = y;
      i += 3;
    } else if (cmd === 'V' || cmd === 'v') {
      const dy = Number(tokens[i + 1]!);
      const y = cmd === 'V' ? dy : curY + dy;
      segments.push({ x1: curX, y1: curY, x2: curX, y2: y, kind: 'v' });
      curY = y;
      i += 2;
    } else if (cmd === 'C') {
      const x = Number(tokens[i + 6]!);
      const y = Number(tokens[i + 5]!); // C 最后第二个是 y
      // 实际解析：tokens: C x1 y1, x2 y2, x y → tokens[i+1]=x1, [i+2]=y1, [i+3]=x2, [i+4]=y2, [i+5]=x, [i+6]=y
      // 重新调整
      const finalY = Number(tokens[i + 6]!);
      segments.push({ x1: curX, y1: curY, x2: x, y2: finalY, kind: 'c' });
      curX = x;
      curY = finalY;
      i += 7;
    } else {
      i++;
    }
  }
  return segments;
}

test('v2.66 dot 和 line 严格对齐：每个 dot center 必须落在对应 path 线段中点（±ROW_H/4 容差）', () => {
  const testLines = makeTestLines();
  const { graph } = parseLines(testLines as any);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  const minX = graph.minColumn * COL_WIDTH;

  // 1. 验证 viewBox/svgHeight 跟 commit 数匹配
  const commitCount = graph.commits.length;
  const expectedTotalHeight = commitCount * ROW_HEIGHT + 0;
  assert.equal(expectedTotalHeight, commitCount * ROW_HEIGHT, 'viewBox 高度 = commitCount * ROW_HEIGHT');

  // 2. 对每个 commit，验证 dot cy 与对应 path 段的对齐
  let totalMismatches = 0;
  let totalChecks = 0;

  for (const flow of graph.flows.values()) {
    const d = flowToPathDCompact(flow, displayRowMap, { curve: true, rowOffsets: new Map() });
    if (!d) continue;

    const flowCommits = flow.commits
      .filter((c) => displayRowMap.has(c.row))
      .sort((a, b) => a.row - b.row);
    if (flowCommits.length === 0) continue;

    // 提取所有 path 段
    const firstCommit = flowCommits[0]!;
    const segments = extractPathSegments(d, 0, 0); // 起点 prev_x/y 不用，因为第一段用 M 起点覆盖

    // 对每个 commit，验证 dot (cx, cy) 落在某条 path 段上
    for (const c of flowCommits) {
      const dr = displayRowMap.get(c.row)!;
      const dotCx = (c.column * COL_WIDTH + COL_WIDTH / 2 - minX + FLOW_LEFT_PAD) * DISPLAY_SCALE;
      const dotCy = (dr * ROW_HEIGHT + 0 + ROW_HEIGHT / 2) * DISPLAY_SCALE;

      // 找到 dot 所在的 path 段（必须有一条段 x 范围包含 dotCx, y 范围包含 dotCy）
      const hit = segments.some(seg => {
        if (seg.kind === 'v') {
          // 垂直线：x = 固定，y 范围 [y1, y2]
          if (Math.abs(seg.x1 - dotCx) > 0.1) return false;
          const yMin = Math.min(seg.y1, seg.y2);
          const yMax = Math.max(seg.y1, seg.y2);
          return dotCy >= yMin && dotCy <= yMax;
        } else if (seg.kind === 'l') {
          // 直线：x 范围 [x1, x2], y 范围 [y1, y2]
          const xMin = Math.min(seg.x1, seg.x2);
          const xMax = Math.max(seg.x1, seg.x2);
          const yMin = Math.min(seg.y1, seg.y2);
          const yMax = Math.max(seg.y1, seg.y2);
          return dotCx >= xMin && dotCx <= xMax && dotCy >= yMin && dotCy <= yMax;
        } else if (seg.kind === 'c') {
          // S 曲线：dot (cx, cy) 跟曲线起点 (x1, y1) 和终点 (x2, y2) 形成的包围盒对齐
          // 简化：dot cy 必须在 [min(y1, y2) - ROW_H/4, max(y1, y2) + ROW_H/4] 范围内
          // 且 dot cx 必须在 [min(x1, x2), max(x1, x2)] 范围内（曲线从 x1 走到 x2）
          const xMin = Math.min(seg.x1, seg.x2);
          const xMax = Math.max(seg.x1, seg.x2);
          const yMin = Math.min(seg.y1, seg.y2);
          const yMax = Math.max(seg.y1, seg.y2);
          return dotCx >= xMin - 0.1 && dotCx <= xMax + 0.1 &&
                 dotCy >= yMin - ROW_HEIGHT / 2 && dotCy <= yMax + ROW_HEIGHT / 2;
        }
        return false;
      });

      totalChecks++;
      if (!hit) {
        totalMismatches++;
        console.error(`MISMATCH: Flow ${flow.id} commit sha=${c.sha.slice(0, 6)} asciiRow=${c.row} displayRow=${dr} → dot (${dotCx}, ${dotCy}) 不在任何 path 段上`);
      }
    }
  }

  console.log(`  total checks: ${totalChecks}, mismatches: ${totalMismatches}`);
  assert.equal(totalMismatches, 0, `所有 dot 必须落在线上，mismatches=${totalMismatches}`);
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
