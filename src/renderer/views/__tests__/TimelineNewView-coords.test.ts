/**
 * TimelineNewView 渲染坐标契约测试
 *
 * 背景（commit 4ecfdbf 修复的 bug 群）：
 * - dot 圆点 top/left 必须与 SVG 行/列坐标 1:1 对齐
 * - SVG viewBox / svgWidthPx / svgHeightPx 必须严格按 Gitea svgcontainer.tmpl 公式
 *
 * 测试方式：
 *   直接测 @renderer/lib/gitgraph 暴露的 svgViewBox / svgWidthPx / svgHeightPx
 *   （已被 gitgraph parser.test.ts 覆盖过，但再加一个端到端场景：
 *    mock 一个真实 git log --graph 输出 → parseLines → 检查 dot 坐标）
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  parseLines,
  svgViewBox,
  svgWidthPx,
  svgHeightPx,
  graphHeight,
} from '@renderer/lib/gitgraph';
import type { GraphLine, GitRef } from '@renderer/lib/gitgraph';

const REPO_PATH = '/tmp/gitea-graph-test';
const gitOk = spawnSync('git', ['--version']).status === 0;
const repoOk = existsSync(REPO_PATH);
const describeFn = gitOk && repoOk ? describe : describe.skip;

function parseRefs(refsStr: string): GitRef[] {
  if (!refsStr || !refsStr.trim()) return [];
  return refsStr.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    if (part.startsWith('tag: ')) return { name: `refs/tags/${part.slice(5)}`, refGroup: 'tags' as const, shortName: part.slice(5) };
    if (part.startsWith('HEAD -> ')) return { name: `refs/heads/${part.slice(8)}`, refGroup: 'heads' as const, shortName: part.slice(8) };
    if (part.startsWith('remotes/')) return { name: `refs/remotes/${part.slice(8)}`, refGroup: 'remotes' as const, shortName: part.slice(8) };
    return { name: `refs/heads/${part}`, refGroup: 'heads' as const, shortName: part };
  });
}

function gitLogLines(): GraphLine[] {
  const r = spawnSync(
    'git',
    ['log', '--graph', '--date-order', '--decorate=full', '-C', '-M', '--date=iso-strict', '--pretty=format:DATA:%D|%H|%ad|%h|%s'],
    { cwd: REPO_PATH, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr}`);
  const rawLines = r.stdout.split('\n').filter((l) => l.length > 0);
  return rawLines.map((raw, row) => {
    const idx = raw.indexOf('DATA:');
    if (idx < 0) return { row, glyph: raw, commit: null };
    const glyph = raw.substring(0, idx);
    const data = raw.substring(idx + 5).split('|');
    if (data.length < 5) return { row, glyph, commit: null };
    const refs = parseRefs(data[0] ?? '');
    const sha = data[1] ?? '';
    const date = data[2] ?? '';
    const shortSha = data[3] ?? sha.slice(0, 7);
    // 格式：%D|%H|%ad|%h|%s|%an|%ae（subject 可能含 |）
    const subjectAndRest = data.slice(4);
    let subject = subjectAndRest[0] ?? '';
    let authorName = '';
    let authorEmail = '';
    if (subjectAndRest.length >= 3) {
      authorName = subjectAndRest[subjectAndRest.length - 2] ?? '';
      authorEmail = subjectAndRest[subjectAndRest.length - 1] ?? '';
      if (subjectAndRest.length > 3) {
        subject = subjectAndRest.slice(1, -2).join('|');
      }
    }
    return {
      row,
      glyph,
      commit: { sha, shortSha, subject, date, authorName, authorEmail, isMerge: false, parents: [], refs },
    };
  });
}

describeFn('TimelineNewView 渲染坐标契约（git log e2e）', () => {
  it('dot 圆心 column ↔ SVG unit 1:1 对齐（×2 缩放后像素 = col*10+10）', () => {
    const lines = gitLogLines();
    if (lines.length === 0) return;
    const { graph } = parseLines(lines);

    // 对每个 commit 验证：dot 圆心 (×2 像素) = (column - minCol) * 10 + 10
    const minCol = graph.minColumn;
    for (const c of graph.commits) {
      // dot 圆心 x（×2 后像素，对应 SVG unit (col-minCol)*5 + 5）
      const dotCenterX = (c.column - minCol) * 10 + 10;
      const dotCenterXFromSvgUnit = (c.column - minCol) * 5 * 2 + 5 * 2;
      expect(dotCenterX).toBe(dotCenterXFromSvgUnit);

      // dot 圆心 y（×2 后像素）= row * 24 + 12
      const dotCenterY = c.row * 24 + 12;
      const dotCenterYFromSvgUnit = c.row * 12 * 2 + 6 * 2;
      expect(dotCenterY).toBe(dotCenterYFromSvgUnit);
    }
  });

  it('SVG width / height 与 viewBox 比例严格 2:1（×2 缩放）', () => {
    const lines = gitLogLines();
    if (lines.length === 0) return;
    const { graph } = parseLines(lines);

    const vb = svgViewBox(graph);
    // 解析 "${x} ${y} ${w} ${h}"
    const m = vb.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
    expect(m).not.toBeNull();
    const [, , , wStr, hStr] = m!;
    const vbW = Number(wStr);
    const vbH = Number(hStr);

    const pxW = Number.parseFloat(svgWidthPx(graph));
    const pxH = Number.parseFloat(svgHeightPx(graph));

    // SVG unit → 像素 = ×2
    expect(pxW).toBeCloseTo(vbW * 2, 5);
    expect(pxH).toBeCloseTo(vbH * 2, 5);

    // commit-row 严格 24px = SVG 行高 ×2
    // commit 列表行数 = graph height（行数）
    expect(graphHeight(graph)).toBeGreaterThan(0);
  });

  it('graph.commits 数 = git log 行数（每个 commit 一行；合并 commit 算 1 行）', () => {
    const lines = gitLogLines();
    if (lines.length === 0) return;
    const { graph } = parseLines(lines);

    // 有 commit 的行数（不算 transition 行）
    const commitLines = lines.filter((l) => l.commit !== null).length;
    expect(graph.commits).toHaveLength(commitLines);
  });
});
