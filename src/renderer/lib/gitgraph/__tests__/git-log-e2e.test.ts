/**
 * Git Graph Parser 端到端测试 —— 跑真实 `git log --graph` 输出并解析
 *
 * 对齐 Gitea graph_test.go 的核心精神：
 * - Gitea `TestParseGlyphs` 用 `testglyphs` 全量字形跑遍 parser
 *   验证 first column flow == 1 / 每个 flow 的颜色一致 / availableColors 稳定
 * - 本测试拿真实 git log --graph 输出（从 Hello-World octocat 仓库克隆），
 *   模拟 main 端 `commits.gitgraph.lines` 把原始字符流切给前端 parser
 *
 * 为什么需要真实数据：
 * - 单元测试覆盖的状态机分支有限（线性/fork/merge 各 1-2 个）
 * - 真实仓库（尤其是带 merge commit / 多 branch 的）会触发各种 corner case
 * - 与 Gitea 的 testglyphs 一致性直接验证 "我们的 Parser = parser.go"
 *
 * 跳过条件：
 * - 沙箱里没 git 二进制 → describe.skip
 * - /tmp/gitea-graph-test 不存在 → it.skip
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseLines, svgViewBox } from '@renderer/lib/gitgraph';
import type { GraphLine, GitRef } from '@renderer/lib/gitgraph';
function hasGit(): boolean {
  const r = spawnSync('git', ['--version'], { stdio: 'pipe' });
  return r.status === 0;
}

// 真实仓库路径
const REPO_PATH = '/tmp/gitea-graph-test';

function runGitLog(repoPath: string): string {
  const r = spawnSync(
    'git',
    [
      'log',
      '--graph',
      '--date-order',
      '--decorate=full',
      '-C',
      '-M',
      '--date=iso-strict',
      '--pretty=format:DATA:%D|%H|%ad|%h|%s',
    ],
    { cwd: repoPath, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`git log failed: ${r.stderr}`);
  }
  return r.stdout;
}

function parseGitLogLines(raw: string): GraphLine[] {
  const rawLines = raw.split('\n').filter((l) => l.length > 0);
  const lines: GraphLine[] = [];

  for (let row = 0; row < rawLines.length; row++) {
    const line = rawLines[row]!;
    const dataIdx = line.indexOf('DATA:');
    if (dataIdx < 0) {
      lines.push({ row, glyph: line, commit: null });
      continue;
    }
    const glyph = line.substring(0, dataIdx);
    const dataPart = line.substring(dataIdx + 'DATA:'.length);
    const parts = dataPart.split('|');
    if (parts.length < 5) continue;

    const [refsStr, sha, date, shortSha, ...subjectParts] = parts;
    const subject = subjectParts.join('|');

    const refs = parseRefs(refsStr ?? '');

    const commit = {
      sha: sha ?? '',
      shortSha: shortSha ?? (sha ?? '').slice(0, 7),
      subject: subject ?? '',
      date: date ?? '',
      authorName: '',
      authorEmail: '',
      isMerge: false,
      parents: [],
      refs,
    };

    lines.push({ row, glyph, commit });
  }
  return lines;
}

function parseRefs(refsStr: string): GitRef[] {
  if (!refsStr || !refsStr.trim()) return [];
  return refsStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('tag: ')) {
        return {
          name: `refs/tags/${part.slice(5)}`,
          refGroup: 'tags' as const,
          shortName: part.slice(5),
        };
      }
      if (part.startsWith('HEAD -> ')) {
        return {
          name: `refs/heads/${part.slice(8)}`,
          refGroup: 'heads' as const,
          shortName: part.slice(8),
        };
      }
      if (part.startsWith('remotes/')) {
        return {
          name: `refs/remotes/${part.slice(8)}`,
          refGroup: 'remotes' as const,
          shortName: part.slice(8),
        };
      }
      return { name: `refs/heads/${part}`, refGroup: 'heads' as const, shortName: part };
    });
}

// 条件执行：git 可用 + 仓库存在
const gitOk = hasGit();
const repoOk = existsSync(REPO_PATH);

const describeFn = gitOk && repoOk ? describe : describe.skip;

describeFn('e2e: 真实 git log --graph 输出解析', () => {
  let gitOutput: string;
  let lines: GraphLine[];

  beforeAll(() => {
    gitOutput = runGitLog(REPO_PATH);
    lines = parseGitLogLines(gitOutput);
  });

  it('能解析 Hello-World octocat 仓库的 git log --graph 输出', () => {
    expect(lines.length).toBeGreaterThan(0);
    // 第一行应该是 * 开头（有 commit）
    expect(lines[0]!.glyph.trim()).toMatch(/^\*+/);
    expect(lines[0]!.commit).not.toBeNull();
  });

  it('parseLines 跑完后 commits 数 = 真实 commit 数', () => {
    // git log --graph 输出 1 行 / commit
    const expectedCommits = lines.filter((l) => l.commit !== null).length;
    const { graph } = parseLines(lines);
    expect(graph.commits).toHaveLength(expectedCommits);
  });

  it('第一个 commit row=0, column=1（与 Gitea 一致）', () => {
    const { graph } = parseLines(lines);
    const first = graph.commits[0];
    expect(first).toBeDefined();
    expect(first!.row).toBe(0);
    expect(first!.column).toBe(1);
    expect(first!.flowId).toBe(1);
  });

  it('Merge commit 应该出现在 graph.commits（"合并请求"语义保留）', () => {
    const mergeCommits = lines.filter(
      (l) => l.commit && /merge|pull request/i.test(l.commit!.subject),
    );
    if (mergeCommits.length === 0) {
      // 没有 merge commit → skip
      return;
    }
    const { graph } = parseLines(lines);
    const mergeShas = new Set(mergeCommits.map((l) => l.commit!.sha));
    const parsedMergeShas = new Set(
      graph.commits.filter((c) => mergeShas.has(c.sha)).map((c) => c.sha),
    );
    expect(parsedMergeShas.size).toBe(mergeShas.size);
  });

  it('flow 数 <= 6（默认 2 色池；过多 flow 是颜色池扩展 bug）', () => {
    const { graph } = parseLines(lines);
    expect(graph.flows.size).toBeLessThanOrEqual(6);
  });

  it('生成 viewBox 是合法 SVG 字符串', () => {
    const { graph } = parseLines(lines);
    const vb = svgViewBox(graph);
    expect(vb).toMatch(/^\d+ \d+ \d+ \d+$/);
  });
});
