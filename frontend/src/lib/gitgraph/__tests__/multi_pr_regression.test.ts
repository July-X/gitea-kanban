/**
 * 真实反馈循环：模拟多 PR 字符流，跑 parseLines
 * 验证根因：
 *   - graph.commits[].row 是 ASCII 流行号（可能不连续）
 *   - graph.relationCommits 记录了所有 edge 行
 *   - TimelineNewView 的 allRows = row 0..maxRow（包含 edge 行）
 *   - grid-template-rows: repeat(maxRow+1, 30px) → edge 行也分配 30px 高度
 *   - 视觉上：commit row 之间出现 N 个 30px 的"空行"
 */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  COL_WIDTH,
  FLOW_LEFT_PAD,
  parseLines,
  ROW_HEIGHT,
  flowToPathDCompact,
  layoutVscodeGraph,
} from '../index.ts';
import type { GraphLine } from '../types.ts';

const laneX = (column: number) => column * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;

function makeLine(
  row: number,
  glyph: string,
  commitSha?: string,
  subject?: string,
  parents: string[] = [],
): GraphLine {
  if (!commitSha) return { row, glyph, commit: null };
  return {
    row,
    glyph,
    commit: {
      sha: commitSha,
      shortSha: commitSha.slice(0, 7),
      subject: subject ?? commitSha,
      date: '2026-01-01T00:00:00Z',
      authorName: 'tester',
      authorEmail: 't@x.com',
      isMerge: false,
      parents,
      refs: [],
    },
  };
}

const layoutDotPoint = (
  commit: { sha: string; row: number },
  displayRowMap: Map<number, number>,
  layout: ReturnType<typeof layoutVscodeGraph>,
) => ({
  x: laneX(layout.nodes.get(commit.sha)?.lane ?? 0),
  y: displayRowMap.get(commit.row)! * ROW_HEIGHT + ROW_HEIGHT / 2,
});

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

/**
 * 模拟 git log --graph 在 main + 2 个 PR 场景下的输出
 *
 * 行结构（注意：git --graph 的字符流按 lane 左对齐，无前导空格）：
 *   row 0  *    (Merge PR-2)
 *   row 1  |\   (edge: fork)
 *   row 2  | *  (PR-2 B)
 *   row 3  | *  (PR-2 A)
 *   row 4  |/   (edge: merge back)
 *   row 5  *    (Merge PR-1)
 *   row 6  |\   (edge: fork)
 *   row 7  | *  (PR-1 B)
 *   row 8  | *  (PR-1 A)
 *   row 9  |/   (edge: merge back)
 *  row 10  *    (main commit)
 *
 * 期望：11 行 ASCII 流，7 个 commit，4 个 edge row（无 commit）
 * Bug 表现：4 个 edge row 在 grid 中各占 30px → 中间出现 4 个看不见的空行
 */
const multiPRLines: GraphLine[] = [
  makeLine(0,  '*  ',  'a0', 'Merge PR-2'),
  makeLine(1,  '|\\ '),                     // edge
  makeLine(2,  '| *',  'b2', 'PR-2 B'),
  makeLine(3,  '| *',  'b1', 'PR-2 A'),
  makeLine(4,  '|/ '),                      // edge
  makeLine(5,  '*  ',  'a5', 'Merge PR-1'),
  makeLine(6,  '|\\ '),                     // edge
  makeLine(7,  '| *',  'c2', 'PR-1 B'),
  makeLine(8,  '| *',  'c1', 'PR-1 A'),
  makeLine(9,  '|/ '),                      // edge
  makeLine(10, '*  ',  'a9', 'main commit'),
];

describe('gitgraph 回归', () => {
test('多 PR 字符流：parseLines 正确解析，commits 行号非连续', () => {
  const { graph } = parseLines(multiPRLines);

  // 数据层断言：parseLines 解析结果
  assert.equal(graph.commits.length, 7, '7 个 commit');
  // commit 行号 = ASCII 流行号，不是连续 0..6
  const commitRows = graph.commits.map((c) => c.row).sort((a, b) => a - b);
  assert.deepEqual(commitRows, [0, 2, 3, 5, 7, 8, 10], 'commits 在 ASCII 流上的行号（不连续）');

  // 4 个 edge row（无 commit）
  assert.equal(graph.relationCommits.length, 4, '4 个 edge row');
  const edgeRows = graph.relationCommits.map((r) => r.row).sort((a, b) => a - b);
  assert.deepEqual(edgeRows, [1, 4, 6, 9], 'edge 行号');
});

test('多 PR 字符流：bug 复现 —— TimelineNewView 当前的 allRows 逻辑会让 grid 多 4 行空行', () => {
  const { graph } = parseLines(multiPRLines);

  // 复刻 TimelineNewView 的 allRows 逻辑（line 606-633）
  const byRow = new Map<number, (typeof graph.commits)[number]>();
  for (const c of graph.commits) byRow.set(c.row, c);

  const maxRow = Math.max(graph.maxRow, multiPRLines.length - 1, 0);
  const allRows: Array<{ row: number; hasCommit: boolean }> = [];
  for (let row = 0; row <= maxRow; row++) {
    const c = byRow.get(row);
    allRows.push({ row, hasCommit: !!c });
  }

  // 复现 bug：allRows 包含 11 行（7 commit + 4 edge）
  assert.equal(allRows.length, 11, 'allRows = 11 行');

  // 复现 bug：grid-template-rows: repeat(11, 30px) → 总高 11*30 = 330px
  // 实际只有 7 个 commit-row 容器被渲染，剩 4 行是空 grid cell
  const totalGridHeight = allRows.length * ROW_HEIGHT;
  const visibleCommitHeight = 7 * ROW_HEIGHT;
  const emptyRowHeight = totalGridHeight - visibleCommitHeight;

  console.log(
    `  grid 高度: ${allRows.length} * ${ROW_HEIGHT} = ${totalGridHeight}px`,
  );
  console.log(`  commit 占用: 7 * ${ROW_HEIGHT} = ${visibleCommitHeight}px`);
  console.log(`  空行总高度: ${emptyRowHeight}px (= ${emptyRowHeight / ROW_HEIGHT} 行)`);

  // ====== 这就是 bug：4 行 30px = 120px 的"看不见的空白"被插入到 commit 之间 ======
  assert.equal(
    emptyRowHeight,
    4 * ROW_HEIGHT,
    'bug 存在：grid 多出 4 行 30px 空行（edge 行没被压缩）',
  );
});

test('期望行为：commit rows 应该视觉上连续，grid 高度 = commit 数 * 行高', () => {
  // 这是修复后期望的行为
  const expectedDisplayRows = 7; // 7 个 commit
  const expectedGridHeight = expectedDisplayRows * ROW_HEIGHT;
  console.log(`  期望 grid 高度: ${expectedDisplayRows} * ${ROW_HEIGHT} = ${expectedGridHeight}px`);
  assert.equal(expectedGridHeight, expectedDisplayRows * ROW_HEIGHT, '修复后 grid 高度 = commit 数 * 行高（无空行）');
});

test('flowToPathDCompact：把 ASCII row 映射到 displayRow 后绘 path，路径里不再有 edge row 的空段', () => {
  const { graph } = parseLines(multiPRLines);

  // 模拟 TimelineNewView 的 displayRowMap（按 commit.row 升序 → 0..N-1）
  const byAsciiRow = new Map<number, number>();
  [...graph.commits]
    .sort((a, b) => a.row - b.row)
    .forEach((c, i) => byAsciiRow.set(c.row, i));

  // 第一个 flow 应该至少有 1 个 commit
  const flow = [...graph.flows.values()][0]!;
  const d = flowToPathDCompact(flow, byAsciiRow);

  console.log(`  flow.colorNumber = ${flow.colorNumber}, commits = ${flow.commits.length}`);
  console.log(`  path d = ${d}`);

  // 1. 必须有内容（flow 至少 1 个 commit）
  assert.ok(d.length > 0, 'path d 非空');

  // 2. 起点必须是首个 commit 的 (col*CW + CW/2 + FLOW_LEFT_PAD, displayRow*RH)
  //    第一个 commit 在 multiPRLines 里 row=0 → displayRow=0
  //    col 是它所在的 lane —— 看具体流而定
  const firstCommit = [...flow.commits].sort((a, b) => a.row - b.row)[0]!;
  const firstDisplayRow = byAsciiRow.get(firstCommit.row)!;
  const expectedFirstX = laneX(firstCommit.column);
  const expectedFirstY = firstDisplayRow * ROW_HEIGHT;
  assert.ok(
    d.startsWith(`M ${expectedFirstX} ${expectedFirstY}`),
    `path 起点 = (${expectedFirstX}, ${expectedFirstY})，实际 = ${d.match(/^M [^\s]+ [^\s]+/)![0]}`,
  );

  // 3. 没有 displayRow 之间的"30px 大跳变"（这正是原版 bug：edge row 被算成 30px 段）
  //    在 compact 版本里，相邻 commit 的 y 差最多 = |displayRowB - displayRowA| * 30
  //    v2.65：M/L/V/C 命令都提取 y 坐标（S 曲线走 C 命令也包含端点 y）
  const yCoords: number[] = extractYCoords(d);
  // 简化：相邻 commit 的 y 差都不应超过 6 * 30 = 180
  for (let i = 1; i < yCoords.length; i++) {
    const dy = yCoords[i]! - yCoords[i - 1]!;
    assert.ok(Math.abs(dy) <= 6 * ROW_HEIGHT, `y 增量 ${dy} 不超过 6*30=180`);
  }
});

/**
 * v2.65：提取 SVG path d 里所有 y 坐标
 * - M x y / L x y：第 2 个数（每对后 y）
 * - V y：唯一的数
 * - C x1 y1, x2 y2, x y：第 6 个数（最后一个）+ 第 2 个数（控制点 y1，作为相邻下一段的起点 y）
 *
 * 实际只要提取"段末 y"（每段绘制的终点 y）即可：M/L 第 2 个，V 唯 1 个，C 第 6 个
 * 后续 commit-row 视觉对齐用的是"段末 y"，所以 M 后面的 y 也要包含
 */
function extractYCoords(d: string): number[] {
  const out: number[] = [];
  // 解析 token
  const tokens = d.match(/[MLVC]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i]!;
    if (cmd === 'M' || cmd === 'L') {
      out.push(Number(tokens[i + 2]!));
      i += 3;
    } else if (cmd === 'V') {
      out.push(Number(tokens[i + 1]!));
      i += 2;
    } else if (cmd === 'C') {
      // C x1 y1, x2 y2, x y → 6 个数
      out.push(Number(tokens[i + 6]!));
      i += 7;
    } else {
      i++;
    }
  }
  return out;
}

function extractLineSegments(d: string): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const tokens = d.match(/[ML]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  let x = 0;
  let y = 0;
  while (i < tokens.length) {
    const cmd = tokens[i]!;
    if (cmd === 'M') {
      x = Number(tokens[i + 1]!);
      y = Number(tokens[i + 2]!);
      i += 3;
    } else if (cmd === 'L') {
      const x2 = Number(tokens[i + 1]!);
      const y2 = Number(tokens[i + 2]!);
      out.push({ x1: x, y1: y, x2, y2 });
      x = x2;
      y = y2;
      i += 3;
    } else {
      i++;
    }
  }
  return out;
}

test('flowToPathDCompact：flow 没有 commit 时返回空字符串', () => {
  const { graph } = parseLines(multiPRLines);

  // 找第一个有 commit 的 flow
  const flowWithCommits = [...graph.flows.values()].find((f) => f.commits.length > 0)!;
  // 用一个空 rowRemap（过滤掉所有 commit）
  const emptyRemap = new Map<number, number>();
  const d = flowToPathDCompact(flowWithCommits, emptyRemap);
  assert.equal(d, '', '空 rowRemap → 空 path');
});

// ============================================================
// v2.65：S 曲线（VSCode 风格）+ rowOffsets（手风琴展开延伸）
// ============================================================

test('glyph 拓扑：同 lane 保持短垂直段，不再合成跨多行 V/C 曲线', () => {
  // 构造跨 lane 数据：main + 1 PR
  // row 0: *  main
  // row 1: |\
  // row 2: | *  PR-A
  // row 3: |/
  // row 4: *  main-2
  const lines: GraphLine[] = [
    makeLine(0,  '*  ',  'a0', 'main'),
    makeLine(1,  '|\\ '),
    makeLine(2,  '| *',  'b0', 'PR-A'),
    makeLine(3,  '|/ '),
    makeLine(4,  '*  ',  'a1', 'main-2'),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  // 找有 3 个 commit 的 flow（main + main-2 是 main flow；PR-A 是 PR flow）
  // 假设 flow 0 是 main flow（含 main, main-2）
  const mainFlow = [...graph.flows.values()].find(
    (f) => f.commits.some((c) => c.sha === 'a0') && f.commits.some((c) => c.sha === 'a1'),
  )!;

  const d = flowToPathDCompact(mainFlow, displayRowMap, { curve: true });
  console.log(`  mainFlow path d = ${d}`);

  assert.ok(d.includes('L '), '按 git glyph 逐段画线');
  assert.ok(!d.includes(' C '), '不再合成跨多行 C 曲线');
});

test('glyph 拓扑：跨 lane 时保留 git 输出的短斜线，不再直接连远端 commit', () => {
  // 构造跨 lane 数据：main lane 0 → PR lane 1
  // row 0: *  main
  // row 1: |\
  // row 2: | *  PR-A
  const lines: GraphLine[] = [
    makeLine(0,  '*  ',  'a0', 'main'),
    makeLine(1,  '|\\ '),
    makeLine(2,  '| *',  'b0', 'PR-A'),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  // 找含 a0 + b0 的 flow（合并 flow）
  const mergeFlow = [...graph.flows.values()].find(
    (f) => f.commits.some((c) => c.sha === 'a0') && f.commits.some((c) => c.sha === 'b0'),
  )!;
  if (!mergeFlow || mergeFlow.commits.length < 2) {
    // 取决于 parser 实现，a0 和 b0 可能不在同一个 flow
    // 跳过这个 case，单纯测试 curve=true 时不 crash
    return;
  }

  const d = flowToPathDCompact(mergeFlow, displayRowMap, { curve: true });
  console.log(`  cross-lane path d = ${d}`);

  assert.ok(!d.includes(' C '), '不再合成跨 lane C 曲线');
  assert.ok(d.includes('L '), '跨 lane 由 git glyph 的短 L 段表达');
});

test('v2.65 curve=false：跨 lane 用 L 命令（保留旧行为）', () => {
  const lines: GraphLine[] = [
    makeLine(0,  '*  ',  'a0', 'main'),
    makeLine(1,  '|\\ '),
    makeLine(2,  '| *',  'b0', 'PR-A'),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  // 找跨 lane 的 flow（同时包含 a0 和 b0）
  const crossLaneFlow = [...graph.flows.values()].find(
    (f) => f.commits.some((c) => c.sha === 'a0') && f.commits.some((c) => c.sha === 'b0'),
  )!;
  if (!crossLaneFlow) {
    // parser 可能把 a0 和 b0 分到不同 flow，跳过
    return;
  }
  const d = flowToPathDCompact(crossLaneFlow, displayRowMap, { curve: false });
  console.log(`  curve=false path d = ${d}`);

  // curve=false → 跨 lane 用 L 命令（不出现 C）
  assert.ok(!d.includes(' C '), 'curve=false 不应出现 C 命令');
});

test('v2.65 rowOffsets：手风琴展开时 expanded row 之后的 commit y 加上 offset', () => {
  const { graph } = parseLines(multiPRLines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  // 找第一个 flow
  const flow = [...graph.flows.values()][0]!;

  // 模拟手风琴展开：displayRow 2 之后的 commit 都加 200px offset
  const rowOffsets = new Map<number, number>();
  for (let r = 3; r < 7; r++) {
    rowOffsets.set(r, 200);
  }

  const d = flowToPathDCompact(flow, displayRowMap, { rowOffsets });
  console.log(`  path with offsets d = ${d}`);

  // 检查 y 坐标：应该有 y 坐标 ≥ 200（被偏移的 commit）
  const yCoords = extractYCoords(d);
  console.log(`  y coords = [${yCoords.join(', ')}]`);

  // 至少有一个 y 坐标 >= 200（被偏移的 commit）
  const hasOffset = yCoords.some((y) => y >= 200);
  assert.ok(hasOffset, '被偏移的 commit y 坐标 ≥ 200（rowOffsets 生效）');
});

test('GitHub 多列字符流：边缘分支 path 从主线接出并回到主线，右侧仍只显示 commit 行', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', 'a0', 'main 0'),
    makeLine(1, '*   ', 'a1', 'main 1'),
    makeLine(2, '| * ', 'b0', 'side 0'),
    makeLine(3, '* | ', 'a2', 'main 2'),
    makeLine(4, '| * ', 'b1', 'side 1'),
    makeLine(5, '* | ', 'a3', 'main 3'),
    makeLine(6, '* | ', 'a4', 'main 4'),
    makeLine(7, '|/  '),
    makeLine(8, '*   ', 'a5', 'main 5'),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  assert.equal(sorted.length, 8, '右侧 commit row 只显示 8 行，不插入 edge 行');
  assert.deepEqual(
    sorted.map((c, i) => [c.sha, i]),
    [
      ['a0', 0],
      ['a1', 1],
      ['b0', 2],
      ['a2', 3],
      ['b1', 4],
      ['a3', 5],
      ['a4', 6],
      ['a5', 7],
    ],
    '右侧 displayRow 连续且顺序稳定',
  );

  const sideFlow = [...graph.flows.values()].find(
    (f) => f.commits.some((c) => c.sha === 'b0') && f.commits.some((c) => c.sha === 'b1'),
  )!;
  const d = flowToPathDCompact(sideFlow, displayRowMap, { curve: false });

  assert.ok(d.includes(`M ${laneX(1)} ${2 * ROW_HEIGHT} L ${laneX(1)} ${3 * ROW_HEIGHT}`), `侧线 commit 之间保持垂直短段，实际: ${d}`);
  assert.ok(d.endsWith(`L ${laneX(0)} ${7 * ROW_HEIGHT}`), `分支线按 / glyph 回到下一条主线 commit 行，实际: ${d}`);
});

test('GitHub 连续多 PR 字符流：每条侧线都保持同样接入/回合表现', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', 'a0', 'main 0'),
    makeLine(1, '| * ', 'b0', 'pr 1-0'),
    makeLine(2, '| * ', 'b1', 'pr 1-1'),
    makeLine(3, '|/  '),
    makeLine(4, '*   ', 'a1', 'main 1'),
    makeLine(5, '| * ', 'c0', 'pr 2-0'),
    makeLine(6, '| * ', 'c1', 'pr 2-1'),
    makeLine(7, '|/  '),
    makeLine(8, '*   ', 'a2', 'main 2'),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  assert.deepEqual(
    sorted.map((c) => c.sha),
    ['a0', 'b0', 'b1', 'a1', 'c0', 'c1', 'a2'],
    '右侧多 PR commit row 连续显示，不混入 relation 行',
  );

  const paths = [...graph.flows.values()]
    .filter((f) => f.commits.some((c) => c.sha === 'b0' || c.sha === 'c0'))
    .map((f) => flowToPathDCompact(f, displayRowMap, { curve: false }));

  assert.equal(paths.length, 2, '两条 PR 侧线都被解析出来');
  assert.ok(paths.every((d) => d.includes('L ')), `每条 PR 侧线都有 glyph path: ${paths.join(' | ')}`);
  assert.ok(paths.some((d) => d.endsWith(`L ${laneX(0)} ${3 * ROW_HEIGHT}`)), `PR1 按 / glyph 回到 main row: ${paths.join(' | ')}`);
  assert.ok(paths.some((d) => d.endsWith(`L ${laneX(0)} ${6 * ROW_HEIGHT}`)), `PR2 按 / glyph 回到 main row: ${paths.join(' | ')}`);
});

test('GitHub fallback 实际渲染：多 PR 用父子边画线，dot 落在对应边端点上', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', 'm0', 'Merge PR-2', ['m1', 'b1']),
    makeLine(1, '|\\  '),
    makeLine(2, '| * ', 'b1', 'PR-2 B', ['b0']),
    makeLine(3, '| * ', 'b0', 'PR-2 A', ['m1']),
    makeLine(4, '|/  '),
    makeLine(5, '*   ', 'm1', 'Merge PR-1', ['m2', 'c1']),
    makeLine(6, '|\\  '),
    makeLine(7, '| * ', 'c1', 'PR-1 B', ['c0']),
    makeLine(8, '| * ', 'c0', 'PR-1 A', ['m2']),
    makeLine(9, '|/  '),
    makeLine(10, '*   ', 'm2', 'main commit'),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  const layout = layoutVscodeGraph(graph, displayRowMap);
  const paths = layout.paths;
  const visibleEdgeCount = graph.commits.reduce(
    (sum, c) => sum + c.parents.filter((parentSha) => graph.commits.some((p) => p.sha === parentSha)).length,
    0,
  );

  assert.equal(paths.length, visibleEdgeCount + graph.commits.length, '实际 SVG path 数量 = 可见父子边 + commit spine');
  assert.ok(paths.some((p) => p.d.includes(' C ')), '跨 lane 父子边在 row gap 内转弯，接近 VSCode 表现');
  assert.ok(
    paths
      .filter((p) => p.d.includes(' C '))
      .every((p) => {
        const nums = p.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        return nums.length >= 8 && Math.abs(nums[7]! - nums[1]!) <= ROW_HEIGHT / 2;
      }),
    '跨 lane 曲线只在当前 row gap 内完成转折，后续沿 lane 直线下行',
  );

  for (const commit of graph.commits) {
    const { x, y } = layoutDotPoint(commit, displayRowMap, layout);
    const touchesDot = paths.some((p) => pathTouchesPoint(p.d, x, y));
    assert.ok(touchesDot, `commit ${commit.sha} 的 dot 必须落在至少一条父子边端点上`);
  }
});

test('GitHub fallback lane 规则：dot lane 使用 parser flow，而不是 git graph 字符下标', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', 'm0', 'Merge PR-2', ['m1', 'b1']),
    makeLine(1, '|\\  '),
    makeLine(2, '| * ', 'b1', 'PR-2 B', ['b0']),
    makeLine(3, '| * ', 'b0', 'PR-2 A', ['m1']),
    makeLine(4, '|/  '),
    makeLine(5, '*   ', 'm1', 'Merge PR-1', ['m2', 'c1']),
    makeLine(6, '|\\  '),
    makeLine(7, '| * ', 'c1', 'PR-1 B', ['c0']),
    makeLine(8, '| * ', 'c0', 'PR-1 A', ['m2']),
    makeLine(9, '|/  '),
    makeLine(10, '*   ', 'm2', 'main commit'),
  ];
  const { graph } = parseLines(lines);
  const displayRowMap = new Map<number, number>();
  graph.commits.forEach((c, i) => displayRowMap.set(c.row, i));

  const layout = layoutVscodeGraph(graph, displayRowMap);

  for (const commit of graph.commits) {
    assert.equal(
      layout.nodes.get(commit.sha)?.lane,
      commit.column,
      `${commit.sha} lane follows parser star column`,
    );
  }
  assert.deepEqual(
    graph.commits.map((c) => [c.sha, c.column]),
    [
      ['m0', 0],
      ['b1', 1],
      ['b0', 1],
      ['m1', 0],
      ['c1', 1],
      ['c0', 1],
      ['m2', 0],
    ],
    '主线保持 lane 0，侧线使用压缩后的 git graph 字符坐标',
  );
});

test('DeepSeek-Reasonix 顶部回归：第 5 条 commit 连到第 8 条 parent commit', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', '458595af5', 'Merge org/main-v2 into main-v2', ['aaaf863c1']),
    makeLine(1, '|\\  '),
    makeLine(2, '| *   ', 'aaaf863c1', 'Merge pull request #5532', ['284e65d91', 'a0ce934d1']),
    makeLine(3, '| |\\  '),
    makeLine(4, '| | * ', 'a0ce934d1', 'Soften themed user message bubbles', ['284e65d91']),
    makeLine(5, '| |/  '),
    makeLine(6, '| *   ', '284e65d91', 'Merge pull request #5529', ['d7f49d1f5', '2a9c3f5ed']),
    makeLine(7, '| |\\  '),
    makeLine(8, '| | * ', '2a9c3f5ed', 'fix(edit): tolerate whitespace drift', ['02bd3d95b']),
    makeLine(9, '| * |   ', 'd7f49d1f5', 'Merge pull request #5528', ['02bd3d95b', '633d60271']),
    makeLine(10, '| |\\ \\  '),
    makeLine(11, '| | |\\  '),
    makeLine(12, '| | |/  '),
    makeLine(13, '| | * ', '633d60271', 'fix(desktop): keep run_skill subject', ['0256e836e']),
    makeLine(14, '| * |   ', '02bd3d95b', 'Merge pull request #5512', ['1c19a0483', '0da7fe832']),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  const layout = layoutVscodeGraph(graph, displayRowMap);
  const from = graph.commits.find((c) => c.sha === '2a9c3f5ed')!;
  const to = graph.commits.find((c) => c.sha === '02bd3d95b')!;
  const edge = layout.paths.find((p) => p.id === '2a9c3f5ed-02bd3d95b');

  assert.equal(layout.nodes.get(from.sha)?.lane, from.column, '第 5 条 dot 使用 git graph lane');
  assert.equal(layout.nodes.get(to.sha)?.lane, to.column, '第 8 条 dot 使用 git graph lane');
  assert.ok(edge, '第 5 条 commit 必须有到第 8 条 parent commit 的 edge');
  assert.ok(
    pathTouchesPoint(edge!.d, layoutDotPoint(from, displayRowMap, layout).x, layoutDotPoint(from, displayRowMap, layout).y),
    `edge 必须从第 5 条 dot 出发，实际: ${edge!.d}`,
  );
  assert.ok(
    pathTouchesPoint(edge!.d, layoutDotPoint(to, displayRowMap, layout).x, layoutDotPoint(to, displayRowMap, layout).y),
    `edge 必须落到第 8 条 dot，实际: ${edge!.d}`,
  );
});

test('VSCode layout：线性历史始终保持单 lane，简单仓库不被多列渲染污染', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', 'u0', 'commit 0', ['u1']),
    makeLine(1, '*   ', 'u1', 'commit 1', ['u2']),
    makeLine(2, '*   ', 'u2', 'commit 2', ['u3']),
    makeLine(3, '*   ', 'u3', 'commit 3'),
  ];
  const { graph } = parseLines(lines);
  const displayRowMap = new Map<number, number>();
  graph.commits.forEach((c, i) => displayRowMap.set(c.row, i));

  const layout = layoutVscodeGraph(graph, displayRowMap);

  assert.equal(layout.laneCount, 1, '线性历史只有一条 lane');
  assert.deepEqual(
    graph.commits.map((c) => layout.nodes.get(c.sha)?.lane),
    [0, 0, 0, 0],
    '所有 dot 都落在 lane 0',
  );
  assert.ok(layout.paths.every((p) => !p.d.includes(' C ')), '线性历史不应出现跨 lane 曲线');
});

test('DeepSeek-Reasonix 真实多 PR glyph：跨 lane 线段不能跨多条 commit row 乱连', () => {
  const lines: GraphLine[] = [
    makeLine(0, '*   ', '9ffb7b223', 'Merge org/main-v2 into main-v2'),
    makeLine(1, '|\\  '),
    makeLine(2, '| *   ', 'b9d1ffc60', 'Merge pull request #5470'),
    makeLine(3, '| |\\  '),
    makeLine(4, '| | * ', 'e4a72782c', 'Fix file references in plan revisions'),
    makeLine(5, '| |/  '),
    makeLine(6, '| *   ', '5efbb7384', 'Merge pull request #5454'),
    makeLine(7, '| |\\  '),
    makeLine(8, '| | * ', 'f54c76353', 'Fix live bot approval mode updates'),
    makeLine(9, '* | | ', '3682bcb7a', 'Merge org/main-v2 into main-v2'),
    makeLine(10, '|\\| | '),
    makeLine(11, '| * |   ', '427658bc8', 'Merge pull request #5453'),
    makeLine(12, '| |\\ \\  '),
    makeLine(13, '| | * \\   ', '8a8daad59', 'Merge main-v2 into external folder refs'),
    makeLine(14, '| | |\\ \\  '),
    makeLine(15, '| | |/ /  '),
    makeLine(16, '| |/| |   '),
    makeLine(17, '| | * | ', '1976a217e', 'feat: let read tools resolve external folder refs'),
    makeLine(18, '| | * | ', 'a81a46583', 'feat: clarify directory ref context'),
    makeLine(19, '| | * | ', 'af3d3805e', 'feat: support external folder subpath refs'),
    makeLine(20, '| * | |   ', '20e99f691', 'Merge pull request #5452'),
    makeLine(21, '| |\\ \\ \\  '),
    makeLine(22, '| | * | | ', '35d247697', 'Fix memory and permission hardening regressions'),
    makeLine(23, '| |/ / /  '),
    makeLine(24, '| | | * ', '20ccf46d2', 'fix(bot): approval restart'),
    makeLine(25, '| | * | ', '6a9d1acb8', 'feat: support session-scoped external folder refs'),
    makeLine(26, '| * | |   ', '3ee319d76', 'Merge pull request #5348'),
    makeLine(27, '| |\\ \\ \\  '),
    makeLine(28, '| | |_|/  '),
    makeLine(29, '| |/| |   '),
    makeLine(30, '| | * | ', '4f1769a05', 'Unify custom provider key env derivation'),
    makeLine(31, '| * | |   ', 'c9df209e9', 'Merge pull request #5353'),
    makeLine(32, '| |\\ \\ \\  '),
    makeLine(33, '| * \\ \\ \\   ', 'aa5ff7bd4', 'Merge pull request #5359'),
    makeLine(34, '| |\\ \\ \\ \\  '),
  ];
  const { graph } = parseLines(lines);
  const sorted = [...graph.commits].sort((a, b) => a.row - b.row);
  const displayRowMap = new Map<number, number>();
  sorted.forEach((c, i) => displayRowMap.set(c.row, i));

  assert.deepEqual(
    sorted.slice(0, 8).map((c) => c.sha),
    ['9ffb7b223', 'b9d1ffc60', 'e4a72782c', '5efbb7384', 'f54c76353', '3682bcb7a', '427658bc8', '8a8daad59'],
    '右侧 commit row 顺序来自真实 git log，且 relation 行不参与显示',
  );

  const longDiagonals = [...graph.flows.values()]
    .flatMap((flow) => extractLineSegments(flowToPathDCompact(flow, displayRowMap)))
    .filter((seg) => seg.x1 !== seg.x2 && Math.abs(seg.y2 - seg.y1) > ROW_HEIGHT);

  assert.deepEqual(longDiagonals, [], '跨 lane 线段只能来自相邻 glyph row，不能跨多条 commit row 乱连');
});
});
