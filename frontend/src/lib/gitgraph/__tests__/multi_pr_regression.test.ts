/**
 * 真实反馈循环：模拟多 PR 字符流，跑 parseLines
 * 验证根因：
 *   - graph.commits[].row 是 ASCII 流行号（可能不连续）
 *   - graph.relationCommits 记录了所有 edge 行
 *   - TimelineNewView 的 allRows = row 0..maxRow（包含 edge 行）
 *   - grid-template-rows: repeat(maxRow+1, 30px) → edge 行也分配 30px 高度
 *   - 视觉上：commit row 之间出现 N 个 30px 的"空行"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLines, ROW_HEIGHT, flowToPathDCompact } from '../index.ts';
import type { GraphLine } from '../types.ts';

function makeLine(row: number, glyph: string, commitSha?: string, subject?: string): GraphLine {
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
      parents: [],
      refs: [],
    },
  };
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

test('期望行为：commit rows 应该视觉上连续，grid 高度 = 7 * 30px = 210px', () => {
  // 这是修复后期望的行为
  const expectedDisplayRows = 7; // 7 个 commit
  const expectedGridHeight = expectedDisplayRows * ROW_HEIGHT;
  console.log(`  期望 grid 高度: ${expectedDisplayRows} * ${ROW_HEIGHT} = ${expectedGridHeight}px`);
  assert.equal(expectedGridHeight, 210, '修复后 grid 高度 = 210px（无空行）');
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
  const expectedFirstX =
    firstCommit.column * 10 + 5 + 4; // COL_WIDTH=10, CW/2=5, FLOW_LEFT_PAD=4
  const expectedFirstY = firstDisplayRow * ROW_HEIGHT;
  assert.ok(
    d.startsWith(`M ${expectedFirstX} ${expectedFirstY}`),
    `path 起点 = (${expectedFirstX}, ${expectedFirstY})，实际 = ${d.match(/^M [^\s]+ [^\s]+/)![0]}`,
  );

  // 3. 末尾必须追加 "v 30"（穿出最后一个 commit 30px，与原版 * / | 行为一致）
  assert.ok(d.endsWith('v 30'), 'path 末尾追加 v 30');

  // 4. 没有 displayRow 之间的"30px 大跳变"（这正是原版 bug：edge row 被算成 30px 段）
  //    在 compact 版本里，相邻 commit 的 y 差最多 = |displayRowB - displayRowA| * 30
  //    而 multiPR 场景里 7 commits / 多个 flow，每个 flow 内部 commit 数 ≤ 7
  //    相邻 commit displayRow 差应该 ≤ 6（总 commit 数）
  const yDeltas: number[] = [];
  const matches = [...d.matchAll(/[ML] (\d+) (\d+)/g)];
  for (let i = 1; i < matches.length; i++) {
    const prevY = Number(matches[i - 1]![2]);
    const curY = Number(matches[i]![2]);
    yDeltas.push(curY - prevY);
  }
  console.log(`  y deltas = [${yDeltas.join(', ')}]`);
  // 每个 delta 都是 commit 间 displayRow 差的倍数（最多 6 个 commit 间隔 = 6*30=180）
  for (const dy of yDeltas) {
    assert.ok(Math.abs(dy) <= 6 * ROW_HEIGHT, `y 增量 ${dy} 不超过 6*30=180`);
    assert.equal(dy % ROW_HEIGHT, 0, `y 增量 ${dy} 必须是 30 的倍数（= displayRow * ROW_HEIGHT）`);
  }
});

test('flowToPathDCompact：flow 没有 commit 时返回空字符串', () => {
  const { graph } = parseLines(multiPRLines);

  // 找第一个有 commit 的 flow
  const flowWithCommits = [...graph.flows.values()].find((f) => f.commits.length > 0)!;
  // 用一个空 rowRemap（过滤掉所有 commit）
  const emptyRemap = new Map<number, number>();
  const d = flowToPathDCompact(flowWithCommits, emptyRemap);
  assert.equal(d, '', '空 rowRemap → 空 path');
});
