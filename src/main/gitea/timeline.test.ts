/**
 * src/main/gitea/timeline.ts 单测
 *
 * 覆盖（任务 prompt §关键约束 12 + 02-architecture §5.3.4）：
 * - laneMode='branch'：每条 branch 一条 lane
 * - laneMode='author'：每个 author 一条 lane
 * - laneMode='pr'：每个 merged PR 一条 lane
 * - maxNodes 500 硬上限：超 500 → truncated=true + nodes 长度 500
 * - 边的 kind 区分：parent vs merge（merge 边 v1 占位）
 * - 归一化 x: 0-1 浮点（min→0, max→1）
 * - range.from / range.to：min/max timestamp
 * - 截断时 edges 清理（不指向被截断节点）
 */

import { describe, it, expect } from 'vitest';
import { buildTimeline, LANE_COLOR_PRIMARY, LANE_COLOR_ACTIVE, LANE_COLOR_ARCHIVED } from './timeline.js';
import type { CommitDto, TimelinePR, TimelineArgs } from '../ipc/schema.js';

function makeCommit(args: { sha: string; date: string; authorName?: string; parents?: string[]; message?: string }): CommitDto {
  return {
    sha: args.sha,
    shortSha: args.sha.slice(0, 7),
    message: args.message ?? `commit ${args.sha}`,
    author: { name: args.authorName ?? 'alice' },
    committer: { name: args.authorName ?? 'alice' },
    date: args.date,
    parents: args.parents ?? [],
  };
}

const baseArgs: TimelineArgs = {
  projectId: 'p-1',
  branches: ['main'],
  maxNodes: 500,
  laneMode: 'branch',
};

describe('buildTimeline - laneMode', () => {
  it('laneMode=branch：每条 branch 一条 lane（顺序与 branches[] 一致）', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main', 'feature/a', 'feature/b'], laneMode: 'branch' },
      commitsByBranch: { main: [], 'feature/a': [], 'feature/b': [] },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.lanes).toHaveLength(3);
    expect(r.lanes[0]!.id).toBe('branch:main');
    expect(r.lanes[0]!.label).toBe('main');
    expect(r.lanes[0]!.color).toBe(LANE_COLOR_PRIMARY); // main 是第一个 → 主色
    expect(r.lanes[1]!.id).toBe('branch:feature/a');
    expect(r.lanes[2]!.id).toBe('branch:feature/b');
  });

  it('laneMode=author：每个 author 一条 lane（按字母升序）', () => {
    const r = buildTimeline({
      args: { ...baseArgs, laneMode: 'author', branches: ['main'] },
      commitsByBranch: {
        main: [
          makeCommit({ sha: 'aaa', date: '2026-01-01T00:00:00.000Z', authorName: 'zoe' }),
          makeCommit({ sha: 'bbb', date: '2026-01-02T00:00:00.000Z', authorName: 'alice' }),
          makeCommit({ sha: 'ccc', date: '2026-01-03T00:00:00.000Z', authorName: 'mike' }),
        ],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.lanes).toHaveLength(3);
    expect(r.lanes.map((l) => l.label).sort()).toEqual(['alice', 'mike', 'zoe']);
  });

  it('laneMode=pr：只取 merged PR，每条 PR 一条 lane（index asc）', () => {
    const pulls: TimelinePR[] = [
      { id: 'pr:1', index: 1, title: 'open PR', state: 'open', head: 'a', base: 'main', author: { name: 'alice' }, url: 'http://x/1' },
      { id: 'pr:2', index: 2, title: 'merged PR', state: 'merged', head: 'a', base: 'main', author: { name: 'alice' }, url: 'http://x/2', mergedAt: '2026-01-05T00:00:00.000Z' },
      { id: 'pr:3', index: 3, title: 'closed PR', state: 'closed', head: 'a', base: 'main', author: { name: 'alice' }, url: 'http://x/3' },
      { id: 'pr:4', index: 4, title: 'another merged', state: 'merged', head: 'a', base: 'main', author: { name: 'bob' }, url: 'http://x/4', mergedAt: '2026-01-06T00:00:00.000Z' },
    ];
    const r = buildTimeline({
      args: { ...baseArgs, laneMode: 'pr', branches: ['main'] },
      commitsByBranch: { main: [] },
      pulls,
      linkedCardIdsBySha: new Map(),
    });
    expect(r.lanes).toHaveLength(2);
    expect(r.lanes[0]!.id).toBe('pr:2');
    expect(r.lanes[1]!.id).toBe('pr:4');
  });
});

describe('buildTimeline - maxNodes 截断', () => {
  it('超 500 → truncated=true + nodes 长度 500（取最近 500）', () => {
    const commits: CommitDto[] = [];
    for (let i = 0; i < 600; i++) {
      const date = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      commits.push(makeCommit({ sha: `sha-${i.toString().padStart(4, '0')}`, date }));
    }
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'], maxNodes: 500 },
      commitsByBranch: { main: commits },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.totalCommits).toBe(600);
    expect(r.truncated).toBe(true);
    expect(r.nodes).toHaveLength(500);
    // 取最近 500 → 索引 100..599
    expect(r.nodes[0]!.sha).toBe('sha-0100');
    expect(r.nodes[499]!.sha).toBe('sha-0599');
  });

  it('未超 500 → truncated=false + nodes 长度 = 实际', () => {
    const commits: CommitDto[] = [];
    for (let i = 0; i < 50; i++) {
      const date = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      commits.push(makeCommit({ sha: `sha-${i}`, date }));
    }
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'], maxNodes: 500 },
      commitsByBranch: { main: commits },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.totalCommits).toBe(50);
    expect(r.truncated).toBe(false);
    expect(r.nodes).toHaveLength(50);
  });
});

describe('buildTimeline - 边的 kind', () => {
  it('parent 边：commit C 父为 P → 边 kind=parent', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: {
        main: [
          makeCommit({ sha: 'parent', date: '2026-01-01T00:00:00.000Z', parents: [] }),
          makeCommit({ sha: 'child', date: '2026-01-02T00:00:00.000Z', parents: ['parent'] }),
        ],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.kind).toBe('parent');
    expect(r.edges[0]!.source).toBe('child');
    expect(r.edges[0]!.target).toBe('parent');
  });

  it('parent 边：commits[] 中的 parent 不存在（不在该 branch 上）→ 该边不出现在结果里', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: {
        main: [makeCommit({ sha: 'child', date: '2026-01-02T00:00:00.000Z', parents: ['unknown-parent'] })],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.edges).toHaveLength(0);
  });

  it('merge commit（parents.length > 1）→ isMerge=true', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: {
        main: [
          makeCommit({ sha: 'a', date: '2026-01-01T00:00:00.000Z' }),
          makeCommit({ sha: 'b', date: '2026-01-02T00:00:00.000Z' }),
          makeCommit({ sha: 'm', date: '2026-01-03T00:00:00.000Z', parents: ['a', 'b'] }),
        ],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    const mergeNode = r.nodes.find((n) => n.sha === 'm');
    expect(mergeNode?.isMerge).toBe(true);
    // 2 条 parent 边
    const parentEdges = r.edges.filter((e) => e.kind === 'parent');
    expect(parentEdges).toHaveLength(2);
  });
});

describe('buildTimeline - 归一化 x 坐标 + range', () => {
  it('x 坐标归一化到 0-1（min→0, max→1）', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: {
        main: [
          makeCommit({ sha: 'first', date: '2026-01-01T00:00:00.000Z' }),
          makeCommit({ sha: 'mid', date: '2026-01-15T00:00:00.000Z' }),
          makeCommit({ sha: 'last', date: '2026-01-30T00:00:00.000Z' }),
        ],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    const first = r.nodes.find((n) => n.sha === 'first')!;
    const mid = r.nodes.find((n) => n.sha === 'mid')!;
    const last = r.nodes.find((n) => n.sha === 'last')!;
    expect(first.x).toBeCloseTo(0, 5);
    expect(last.x).toBeCloseTo(1, 5);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(1);
  });

  it('range.from / range.to = min/max commit timestamp', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: {
        main: [
          makeCommit({ sha: 'a', date: '2026-01-05T00:00:00.000Z' }),
          makeCommit({ sha: 'b', date: '2026-01-15T00:00:00.000Z' }),
          makeCommit({ sha: 'c', date: '2026-01-25T00:00:00.000Z' }),
        ],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.range.from).toBe('2026-01-05T00:00:00.000Z');
    expect(r.range.to).toBe('2026-01-25T00:00:00.000Z');
  });

  it('空 commits：range = 当前时间 + totalCommits=0', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: { main: [] },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.nodes).toHaveLength(0);
    expect(r.totalCommits).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('since/until 指定 → range 透传', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'], since: '2026-01-01T00:00:00.000Z', until: '2026-01-31T00:00:00.000Z' },
      commitsByBranch: {
        main: [
          makeCommit({ sha: 'a', date: '2026-01-05T00:00:00.000Z' }),
          makeCommit({ sha: 'b', date: '2026-01-15T00:00:00.000Z' }),
        ],
      },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.windowStart).toBe('2026-01-01T00:00:00.000Z');
    expect(r.windowEnd).toBe('2026-01-31T00:00:00.000Z');
  });
});

describe('buildTimeline - 截断时 edges 清理', () => {
  it('截断后不指向被截断节点（edge.source/target 都不在 nodes 里 → edge 被清）', () => {
    const commits: CommitDto[] = [];
    for (let i = 0; i < 510; i++) {
      const date = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      // 每个 commit 父是前一个
      const parents = i > 0 ? [`sha-${(i - 1).toString().padStart(4, '0')}`] : [];
      commits.push(makeCommit({ sha: `sha-${i.toString().padStart(4, '0')}`, date, parents }));
    }
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'], maxNodes: 500 },
      commitsByBranch: { main: commits },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    const nodeShaSet = new Set(r.nodes.map((n) => n.sha));
    for (const e of r.edges) {
      expect(nodeShaSet.has(e.source)).toBe(true);
      expect(nodeShaSet.has(e.target)).toBe(true);
    }
  });
});

describe('buildTimeline - 跨 branch 去重（commit.sha 重复）', () => {
  it('同 sha 出现在多个 branches → node.branchHints 累积', () => {
    const shared = makeCommit({ sha: 'shared', date: '2026-01-05T00:00:00.000Z' });
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main', 'feature/a'] },
      commitsByBranch: { main: [shared], 'feature/a': [shared] },
      pulls: [],
      linkedCardIdsBySha: new Map(),
    });
    expect(r.totalCommits).toBe(1);
    const node = r.nodes[0]!;
    expect(node.branchHints).toEqual(expect.arrayContaining(['main', 'feature/a']));
    expect(node.branchHints).toHaveLength(2);
  });
});

describe('buildTimeline - linkedCardIds 透传', () => {
  it('node.linkedCardIds = linkedCardIdsBySha.get(sha)', () => {
    const r = buildTimeline({
      args: { ...baseArgs, branches: ['main'] },
      commitsByBranch: {
        main: [makeCommit({ sha: 'a', date: '2026-01-01T00:00:00.000Z' })],
      },
      pulls: [],
      linkedCardIdsBySha: new Map([['a', ['card-1', 'card-2']]]),
    });
    expect(r.nodes[0]!.linkedCardIds).toEqual(['card-1', 'card-2']);
  });
});

describe('LANE_COLOR 常量', () => {
  it('三色 hex 符合拍板', () => {
    expect(LANE_COLOR_PRIMARY).toBe('#609926');
    expect(LANE_COLOR_ACTIVE).toBe('#f76707');
    expect(LANE_COLOR_ARCHIVED).toBe('#6c757d');
  });
});
