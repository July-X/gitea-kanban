/**
 * gitgraph.runGraphLog 分支参数修复（commit Y）
 *
 * 背景（用户截图）：
 *   "当分支选择多了之后，连线问题非常明显" —— 多选 branch 后
 *   merge edge (`|` / `/`) 大量缺失，只剩每个 branch 自己的线性 ancestor 链
 *
 * 根因：
 *   - view 传 branches=['feature1', 'feature2']（裸名，来自 gitea REST API BranchDto.name）
 *   - 老 runGraphLog 直接 `args.push(...opts.branches)` → git log 'feature1' 'feature2'
 *   - git 解析为 path/rev，不会自动补 refs/heads/ 前缀
 *   - 即便 git log 能识别，每个 branch 各自 walk 自己的祖先 → merge edge 看不到
 *
 * 修复（对齐 Gitea router/web/repo/commit.go:147-152 + 强制跨分支）：
 *   1. 始终加 `--branches`（让 git 把所有 local branch 当 refs，merge edge 完整）
 *   2. 裸名自动补 `refs/heads/` 前缀（Gitea router 同样的逻辑）
 *   3. 已含 `refs/` 前缀的全名原样传
 *
 * 本测试用 /tmp/multi-branch-test fixture（构造 3 commit / 2 feature branch）跑
 * 真实 git log 子进程，验证 merge edge 完整。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGraphLog } from '../../../../main/gitgraph/gitProcess';

const REPO = '/tmp/multi-branch-test-fixture';

beforeAll(() => {
  // 构造 3 commit / 2 feature branch fixture
  if (existsSync(REPO)) rmSync(REPO, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  const run = (args: string[]) =>
    spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });

  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'x@x']);
  run(['config', 'user.name', 'x']);

  writeFileSync(join(REPO, 'a'), 'a');
  run(['add', 'a']);
  run(['commit', '-q', '-m', 'initial']);
  const initialSha = run(['rev-parse', 'HEAD']).stdout.trim();

  // feature1 branch
  run(['checkout', '-q', '-b', 'feature1']);
  writeFileSync(join(REPO, 'b'), 'b');
  run(['add', 'b']);
  run(['commit', '-q', '-m', 'feature1 commit']);

  // main 推进一个 commit + 开 feature2
  run(['checkout', '-q', 'main']);
  writeFileSync(join(REPO, 'c'), 'c');
  run(['add', 'c']);
  run(['commit', '-q', '-m', 'main commit']);
  run(['checkout', '-q', '-b', 'feature2']);
  writeFileSync(join(REPO, 'd'), 'd');
  run(['add', 'd']);
  run(['commit', '-q', '-m', 'feature2 commit']);

  console.log('fixture initial sha:', initialSha.slice(0, 7));
});

describe('runGraphLog · 分支参数修复（commit Y bug 修复）', () => {
  it('多 branch + 裸名：merge edge 完整（3 commit + 跨列连线）', async () => {
    const result = await runGraphLog(REPO, {
      branches: ['feature1', 'feature2', 'main'], // 裸名（来自 gitea REST API）
      maxCount: 10,
    });

    // 至少 4 commit（含 initial + main commit + feature1 + feature2）
    expect(result.lines.filter((l: { commit: unknown }) => l.commit).length).toBeGreaterThanOrEqual(4);

    // 必须有 merge edge：'|' 或 '/' 或 '\' 字形（flatMap 把字符串拆 char 数组）
    const allGlyphs = result.lines.flatMap((l: { glyph: string }) => Array.from(l.glyph));
    const hasMergeEdge =
      allGlyphs.includes('|') ||
      allGlyphs.includes('/') ||
      allGlyphs.includes('\\');
    expect(hasMergeEdge).toBe(true);

    // 必须有多列（flow 数 >= 2 = 主分支 + 至少一个 feature branch）
    const { parseLines } = await import('@renderer/lib/gitgraph');
    const { graph } = parseLines(result.lines);
    expect(graph.flows.size).toBeGreaterThanOrEqual(2);

    // 关键：必须包含 '/' 字形（merge edge 的斜线）—— 否则 bug 仍在
    const hasSlash = allGlyphs.includes('/') || allGlyphs.includes('\\');
    expect(hasSlash).toBe(true);
  }, 15_000);

  it('空 branches 列表：仍走 --branches（与之前行为一致）', async () => {
    const result = await runGraphLog(REPO, { maxCount: 10 });
    expect(result.lines.filter((l: { commit: unknown }) => l.commit).length).toBeGreaterThan(0);
  }, 10_000);

  it('已含 refs/heads/ 前缀的全名：原样透传', async () => {
    const result = await runGraphLog(REPO, {
      branches: ['refs/heads/main'],
      maxCount: 10,
    });
    // 至少 2 commit（main + main commit）
    expect(result.lines.filter((l: { commit: unknown }) => l.commit).length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
