/**
 * TimelineDtoSchema 单元测试（M9 task 2: Z3 known-issue 修后守卫）
 *
 * 背景：
 * - M4 final-integration 报告 Z3 known-issue——TimelineDtoSchema.parse(buildTimeline 输出) Zod 拒
 * - M5 fix-1 (commit 2834d48) 把 IsoDateSchema 改成 `z.string().datetime({ offset: true })` 修了
 * - M9 task 2 重跑 W3 e2e：Z3 schema parse 实际 100% 通过（"意外通过"）
 * - W3 仍报 1 known-issue 根因是 e2e 脚本 knownIssueCheck helper 无条件 knownIssue++
 *
 * 此测试文件目的（任务 prompt §工作 §4）：
 * 1. 守住 buildTimeline 输出喂给 TimelineDtoSchema 100% parse 通过
 * 2. 守住 IsoDateSchema 在嵌套 schema（nodes[].timestamp / prs[].mergedAt / range.{from,to}）下也接受 +08:00
 * 3. 守住 .strict() 仍拒多余字段
 * 4. 覆盖 prs[].state enum 'open' | 'closed' | 'merged' 三值
 * 5. 覆盖 truncated=true / false + totalCommits 计数
 *
 * 注意：fixture 模拟 buildTimeline 实际输出（src/main/gitea/timeline.ts:47-152），
 * 不依赖 gitea server / 网络 / db。
 */
import { describe, it, expect } from 'vitest';
import {
  TimelineDtoSchema,
  CommitNodeSchema,
  LaneSchema,
  ParentEdgeSchema,
  TimelinePRSchema,
  type TimelineDto,
  type CommitNode,
  type Lane,
  type TimelinePR,
} from '../schema.js';

// ===== fixtures（来自 buildTimeline 实际输出 + W3 e2e 实际采样的 +08:00 时间戳）=====
const MAIN_LANE: Lane = {
  id: 'branch:main',
  label: 'main',
  kind: 'branch',
  color: '#609926',
  order: 0,
};

const FEATURE_KANBAN_LANE: Lane = {
  id: 'branch:feature-kanban',
  label: 'feature-kanban',
  kind: 'branch',
  color: '#f76707',
  order: 1,
};

const COMMIT_MAIN: CommitNode = {
  id: '37bb9a8d68c33f353e66fb5c346ae13105277a76',
  laneId: 'branch:main',
  x: 0.5,
  y: 0,
  sha: '37bb9a8d68c33f353e66fb5c346ae13105277a76',
  shortSha: '37bb9a8',
  message: '看板 UI 改稿（feature-kanban → main） (#11)',
  author: {
    name: 'kanban_bot',
    avatarUrl: 'http://127.0.0.1:3000/avatars/2835a86b80ad0954d2f5ea0942eba30e',
  },
  // +08:00 gitea 默认时区（M5 fix-1 前 z.string().datetime() 拒）
  timestamp: '2026-06-11T20:16:55+08:00',
  parents: ['680b925b31239f4942587933cb0fc5278c12a448'],
  isMerge: true,
  branchHints: ['main', 'feature-kanban'],
  linkedCardIds: [],
};

const PR_11_TIMELINE: TimelinePR = {
  id: 'pr:kanban_demo/m4java-test/11',
  index: 11,
  title: '看板 UI 改稿（feature-kanban → main）',
  state: 'merged',
  head: 'feature-kanban',
  base: 'main',
  author: { name: 'kanban_bot' },
  url: 'http://127.0.0.1:3000/kanban_demo/m4java-test/pulls/11',
  // mergedAt 是 PR merged 时间（gitea 1.x 返 +08:00）
  mergedAt: '2026-06-11T20:16:57+08:00',
};

const SAMPLE_TIMELINE: TimelineDto = {
  // windowStart / windowEnd 是 optional，不传 → 不输出字段
  range: {
    from: '2026-06-11T20:00:00+08:00',
    to: '2026-06-14T08:33:00+08:00',
  },
  lanes: [MAIN_LANE, FEATURE_KANBAN_LANE],
  nodes: [COMMIT_MAIN],
  edges: [],
  prs: [PR_11_TIMELINE],
  truncated: false,
  totalCommits: 1,
};

describe('TimelineDtoSchema (M9 task 2: Z3 known-issue 修后守卫)', () => {
  describe('接受 buildTimeline 实际输出（覆盖 W3 Z3 路径）', () => {
    it('接受最小 timeline（1 commit + 1 PR + 2 lanes + 0 edges）', () => {
      const r = TimelineDtoSchema.safeParse(SAMPLE_TIMELINE);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.totalCommits).toBe(1);
        expect(r.data.truncated).toBe(false);
        expect(r.data.prs).toHaveLength(1);
        expect(r.data.prs[0]?.state).toBe('merged');
        expect(r.data.range.from).toBe('2026-06-11T20:00:00+08:00');
      }
    });

    it('接受带 windowStart/windowEnd（args.since/args.until 都传时）', () => {
      const r = TimelineDtoSchema.safeParse({
        ...SAMPLE_TIMELINE,
        windowStart: '2026-06-11T00:00:00+08:00',
        windowEnd: '2026-06-14T23:59:59+08:00',
      });
      expect(r.success).toBe(true);
    });

    it('接受 truncated=true 终态（节点数 > maxNodes 时）', () => {
      const r = TimelineDtoSchema.safeParse({
        ...SAMPLE_TIMELINE,
        truncated: true,
        totalCommits: 501, // 超过 maxNodes=500
      });
      expect(r.success).toBe(true);
    });

    it('接受空 prs[]（仓库无 PR 时）', () => {
      const r = TimelineDtoSchema.safeParse({ ...SAMPLE_TIMELINE, prs: [] });
      expect(r.success).toBe(true);
    });

    it('接受 prs[].state 3 枚举（open/closed/merged）', () => {
      const prs: TimelinePR[] = [
        { ...PR_11_TIMELINE, id: 'pr:1', index: 1, state: 'open' },
        { ...PR_11_TIMELINE, id: 'pr:2', index: 2, state: 'closed', mergedAt: undefined },
        { ...PR_11_TIMELINE, id: 'pr:3', index: 3, state: 'merged' },
      ];
      // 注意 mergedAt 是 optional，未 merged PR 可以不传
      const pr2 = { ...PR_11_TIMELINE, id: 'pr:2', index: 2, state: 'closed' as const };
      delete (pr2 as Partial<TimelinePR>).mergedAt;
      const r = TimelineDtoSchema.safeParse({ ...SAMPLE_TIMELINE, prs: [prs[0]!, pr2, prs[2]!] });
      expect(r.success).toBe(true);
    });
  });

  describe('嵌套 IsoDateSchema 守卫（regression：M5 fix-1 修后必须仍接受 +08:00）', () => {
    it('CommitNodeSchema.timestamp 接受 +08:00', () => {
      const r = CommitNodeSchema.safeParse({ ...COMMIT_MAIN, timestamp: '2026-06-11T20:16:55+08:00' });
      expect(r.success).toBe(true);
    });

    it('CommitNodeSchema.timestamp 接受 -05:00', () => {
      const r = CommitNodeSchema.safeParse({ ...COMMIT_MAIN, timestamp: '2026-06-11T08:16:55-05:00' });
      expect(r.success).toBe(true);
    });

    it('CommitNodeSchema.timestamp 接受 Z（向后兼容）', () => {
      const r = CommitNodeSchema.safeParse({ ...COMMIT_MAIN, timestamp: '2026-06-11T12:16:55Z' });
      expect(r.success).toBe(true);
    });

    it('TimelinePRSchema.mergedAt 接受 +08:00', () => {
      const r = TimelinePRSchema.safeParse({ ...PR_11_TIMELINE, mergedAt: '2026-06-11T20:16:57+08:00' });
      expect(r.success).toBe(true);
    });

    it('TimelineDtoSchema.range.{from,to} 接受 +08:00', () => {
      const r = TimelineDtoSchema.safeParse({
        ...SAMPLE_TIMELINE,
        range: { from: '2026-06-11T00:00:00+08:00', to: '2026-06-14T23:59:59+08:00' },
      });
      expect(r.success).toBe(true);
    });
  });

  describe('子 schema 独立验证', () => {
    it('LaneSchema 接受 branch 模式 lane', () => {
      const r = LaneSchema.safeParse(MAIN_LANE);
      expect(r.success).toBe(true);
    });

    it('LaneSchema 接受 hidden=true（owner 折叠 lane 时）', () => {
      const r = LaneSchema.safeParse({ ...MAIN_LANE, hidden: true });
      expect(r.success).toBe(true);
    });

    it('LaneSchema 拒非法 color（不是 #RRGGBB）', () => {
      const r = LaneSchema.safeParse({ ...MAIN_LANE, color: 'red' });
      expect(r.success).toBe(false);
    });

    it('ParentEdgeSchema 接受 parent 边', () => {
      const r = ParentEdgeSchema.safeParse({
        id: 'sha1->sha2:parent',
        source: 'sha1',
        target: 'sha2',
        kind: 'parent',
      });
      expect(r.success).toBe(true);
    });

    it('ParentEdgeSchema 接受 merge 边 + prIndex', () => {
      const r = ParentEdgeSchema.safeParse({
        id: 'sha1->sha2:merge:11',
        source: 'sha1',
        target: 'sha2',
        kind: 'merge',
        prIndex: 11,
      });
      expect(r.success).toBe(true);
    });

    it('ParentEdgeSchema 拒 kind 非法值', () => {
      const r = ParentEdgeSchema.safeParse({
        id: 'sha1->sha2:other',
        source: 'sha1',
        target: 'sha2',
        kind: 'cherry-pick',
      });
      expect(r.success).toBe(false);
    });

    it('CommitNodeSchema 接受带 additions/deletions/filesChanged', () => {
      const r = CommitNodeSchema.safeParse({
        ...COMMIT_MAIN,
        additions: 100,
        deletions: 20,
        filesChanged: 4,
      });
      expect(r.success).toBe(true);
    });
  });

  describe('regression 守门：.strict() 拒多余字段（AGENTS §7.1 拍板 #2）', () => {
    it('TimelineDtoSchema 拒 buildTimeline 没输出的字段 e.g. summary', () => {
      const r = TimelineDtoSchema.safeParse({
        ...SAMPLE_TIMELINE,
        summary: 'demo', // 故意加多余字段
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
      }
    });

    it('CommitNodeSchema 拒 gitea 原始 commit 字段 e.g. tree_url', () => {
      const r = CommitNodeSchema.safeParse({
        ...COMMIT_MAIN,
        tree_url: 'http://example.com/tree', // gitea 原始字段
      });
      expect(r.success).toBe(false);
    });

    it('TimelinePRSchema 拒 gitea 原始 PR 字段 e.g. body/html_url', () => {
      const r = TimelinePRSchema.safeParse({
        ...PR_11_TIMELINE,
        body: 'long body', // gitea 原始字段
        html_url: 'http://example.com/pr/11', // gitea 原始字段
      });
      expect(r.success).toBe(false);
    });

    it('TimelineDtoSchema 拒 totalCommits 负数（min(0) 不接受 -1）', () => {
      const r = TimelineDtoSchema.safeParse({ ...SAMPLE_TIMELINE, totalCommits: -1 });
      expect(r.success).toBe(false);
    });

    it('CommitNodeSchema 拒 y 负数（min(0) 不接受 -1）', () => {
      const r = CommitNodeSchema.safeParse({ ...COMMIT_MAIN, y: -1 });
      expect(r.success).toBe(false);
    });

    it("TimelineDtoSchema 拒 prs[].state='all'（TimelinePR 只收 3 枚举）", () => {
      // PullStateSchema 收 'all'，但 TimelinePRSchema 不收（渲染层只画 3 终态）
      const r = TimelineDtoSchema.safeParse({
        ...SAMPLE_TIMELINE,
        prs: [{ ...PR_11_TIMELINE, state: 'all' as 'open' | 'closed' | 'merged' }],
      });
      expect(r.success).toBe(false);
    });
  });
});
