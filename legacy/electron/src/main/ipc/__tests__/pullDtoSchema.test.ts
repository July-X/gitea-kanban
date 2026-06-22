/**
 * PullDtoSchema 单元测试（M9 task 2: Z1/Z2 known-issue 修后守卫）
 *
 * 背景：
 * - M4 final-integration 报告 Z1/Z2 known-issue——PullDtoSchema.parse(gitea 实际响应) Zod 拒
 * - M5 fix-1 (commit 2834d48) 把 IsoDateSchema 从 `z.string().datetime()` 改成
 *   `z.string().datetime({ offset: true })` 修了单字段单测（isoDateSchema.test.ts 4/4 PASS）
 * - M9 task 2 重跑 W3 e2e：Z1/Z2 schema parse 实际 100% 通过（"意外通过"）
 * - W3 仍报 2 known-issue 根因是 e2e 脚本 knownIssueCheck helper 无条件 knownIssue++，
 *   **不是** schema bug（见 deliverable.md §"根因诊断"）
 *
 * 此测试文件目的（任务 prompt §工作 §4）：
 * 1. 守住修后 schema 接受 gitea 1.x 实际响应（+08:00 时区）
 * 2. 守住 .strict() 仍拒多余字段（防止后续回归）
 * 3. 守住 PullAuthorDtoSchema / PullRefDtoSchema 子 schema 行为
 * 4. 守住 ListPullsRespSchema.items[] 数组形态
 *
 * 注意：本测试不依赖 gitea server / 网络 / db，全部输入是构造的对象（fixtures/），
 * 跟 src/main/gitea/pulls.ts:36 toPullDto 实际输出字段集一致。
 */
import { describe, it, expect } from 'vitest';
import {
  PullDtoSchema,
  PullAuthorDtoSchema,
  PullRefDtoSchema,
  ListPullsRespSchema,
  PullStateSchema,
  type PullDto,
  type ListPullsResp,
} from '../schema.js';

// ===== fixtures（来自 /tmp/gitea-pulls.json + toPullDto 实际输出结构）=====
const PR_11_FETCHED: PullDto = {
  index: 11,
  title: '看板 UI 改稿（feature-kanban → main）',
  state: 'closed',
  draft: false,
  merged: true,
  head: { ref: 'feature-kanban', sha: 'c23c6ee07f55a2d0525f9f112ee0a1564af50f32' },
  base: { ref: 'main', sha: '37bb9a8d68c33f353e66fb5c346ae13105277a76' },
  author: {
    username: 'kanban_bot',
    avatarUrl: 'http://127.0.0.1:3000/avatars/2835a86b80ad0954d2f5ea0942eba30e',
  },
  // gitea 1.x 实际返 +08:00 时区（M5 fix-1 前 z.string().datetime() 拒）
  createdAt: '2026-06-11T20:00:21+08:00',
  updatedAt: '2026-06-11T20:16:57+08:00',
  // gitea mergeable=true → 业务 hasConflicts=false（02-architecture.md §5.3.5 反向映射）
  mergeable: true,
  hasConflicts: false,
};

const PR_12_FETCHED: PullDto = {
  ...PR_11_FETCHED,
  index: 12,
  title: '合并工作流（feature-merge → main）',
  state: 'closed',
  merged: true,
  head: { ref: 'feature-merge', sha: '7a2bf143ddab1edf900a15dbea99d712c3b1fd59' },
  createdAt: '2026-06-11T20:00:23+08:00',
  updatedAt: '2026-06-11T20:00:29+08:00',
};

const PR_OPEN: PullDto = {
  ...PR_11_FETCHED,
  index: 13,
  title: '未合并草稿',
  state: 'open',
  merged: false,
  draft: true,
};

describe('PullDtoSchema (M9 task 2: Z1/Z2 known-issue 修后守卫)', () => {
  describe('接受 gitea 1.x 实际响应（M5 fix-1 +08:00 时区）', () => {
    it('接受已合并 PR（#11）的 PullDto（覆盖 W3 Z2 路径）', () => {
      const r = PullDtoSchema.safeParse(PR_11_FETCHED);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.index).toBe(11);
        expect(r.data.state).toBe('closed');
        expect(r.data.merged).toBe(true);
        expect(r.data.createdAt).toBe('2026-06-11T20:00:21+08:00');
      }
    });

    it('接受带 +08:00 时区日期（gitea 默认时区）', () => {
      // 独立验证 IsoDateSchema 在 PullDtoSchema 嵌套时也接受 +08:00
      const r = PullDtoSchema.safeParse({
        ...PR_11_FETCHED,
        createdAt: '2026-06-11T20:00:21+08:00',
        updatedAt: '2026-06-11T20:00:29+08:00',
      });
      expect(r.success).toBe(true);
    });

    it('接受带 -05:00 时区日期（北美/南美 gitea 实例）', () => {
      const r = PullDtoSchema.safeParse({
        ...PR_11_FETCHED,
        createdAt: '2026-06-11T08:00:21-05:00',
        updatedAt: '2026-06-11T08:16:57-05:00',
      });
      expect(r.success).toBe(true);
    });

    it('接受 Z 后缀 UTC 日期（向后兼容）', () => {
      const r = PullDtoSchema.safeParse({
        ...PR_11_FETCHED,
        createdAt: '2026-06-11T12:00:21Z',
        updatedAt: '2026-06-11T12:16:57Z',
      });
      expect(r.success).toBe(true);
    });

    it('接受 open + draft + merged=false 的 PR', () => {
      const r = PullDtoSchema.safeParse(PR_OPEN);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.state).toBe('open');
        expect(r.data.draft).toBe(true);
        expect(r.data.merged).toBe(false);
      }
    });
  });

  describe('ListPullsRespSchema（覆盖 W3 Z1 路径）', () => {
    it('接受 listGiteaPulls({state:all}) wrap 形态（items+total+hasMore）', () => {
      const wrap: ListPullsResp = {
        items: [PR_11_FETCHED, PR_12_FETCHED],
        total: 2,
        hasMore: false,
      };
      const r = ListPullsRespSchema.safeParse(wrap);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.items).toHaveLength(2);
        expect(r.data.items[0]?.index).toBe(11);
        expect(r.data.items[1]?.index).toBe(12);
      }
    });

    it('接受空 items（hasMore=true 时序翻页中途）', () => {
      const r = ListPullsRespSchema.safeParse({ items: [], total: 0, hasMore: true });
      expect(r.success).toBe(true);
    });

    it('接受 hasMore=false 终态', () => {
      const r = ListPullsRespSchema.safeParse({ items: [PR_11_FETCHED], total: 1, hasMore: false });
      expect(r.success).toBe(true);
    });
  });

  describe('子 schema 独立验证', () => {
    it('PullRefDtoSchema 接受典型 ref/sha', () => {
      const r = PullRefDtoSchema.safeParse({ ref: 'feature-x', sha: 'abc123' });
      expect(r.success).toBe(true);
    });

    it('PullAuthorDtoSchema 接受 username + avatarUrl', () => {
      const r = PullAuthorDtoSchema.safeParse({
        username: 'alice',
        avatarUrl: 'https://example.com/a.png',
      });
      expect(r.success).toBe(true);
    });

    it('PullAuthorDtoSchema 接受 username 单独（avatarUrl optional）', () => {
      const r = PullAuthorDtoSchema.safeParse({ username: 'alice' });
      expect(r.success).toBe(true);
    });

    it('PullStateSchema 接受 open/closed/all 三个值', () => {
      expect(PullStateSchema.safeParse('open').success).toBe(true);
      expect(PullStateSchema.safeParse('closed').success).toBe(true);
      expect(PullStateSchema.safeParse('all').success).toBe(true);
    });

    it('PullStateSchema 拒非法值（regression 守门）', () => {
      const r = PullStateSchema.safeParse('merged'); // TimelinePR 才用 'merged'，PullState 不收
      expect(r.success).toBe(false);
    });
  });

  describe('regression 守门：.strict() 拒多余字段（AGENTS §7.1 拍板 #2）', () => {
    it('PullDtoSchema 拒 gitea 原始 PR 字段 id（toPullDto 剥离但 schema 不认）', () => {
      // gitea PR 顶层有 id/url/number/diff_url/patch_url 等 36 个字段
      // toPullDto 只挑 12 个 → schema 严格拒 schema 未声明的字段
      const r = PullDtoSchema.safeParse({
        ...PR_11_FETCHED,
        id: 1, // gitea 原始字段，未在 PullDtoSchema 声明
        url: 'http://example.com/pr/11', // 同上
        diff_url: 'http://example.com/pr/11.diff', // 同上
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        const codes = r.error.issues.map((i) => i.code);
        expect(codes).toContain('unrecognized_keys');
      }
    });

    it('PullAuthorDtoSchema 拒 gitea 原始 user 字段 full_name/email', () => {
      const r = PullAuthorDtoSchema.safeParse({
        username: 'kanban_bot',
        full_name: '', // gitea 原始 user 字段
        email: 'kanban_bot@local.dev', // gitea 原始 user 字段
      });
      expect(r.success).toBe(false);
    });

    it('ListPullsRespSchema 拒 page 字段（v1 IPC 不分页，schema 不认 page）', () => {
      const r = ListPullsRespSchema.safeParse({
        items: [PR_11_FETCHED],
        total: 1,
        hasMore: false,
        page: 1, // 故意加多余字段
      });
      expect(r.success).toBe(false);
    });

    it('PullDtoSchema 拒 index=0（positive() 不接受 0）', () => {
      const r = PullDtoSchema.safeParse({ ...PR_11_FETCHED, index: 0 });
      expect(r.success).toBe(false);
    });

    it('PullDtoSchema 拒 index=-1（positive() 不接受负数）', () => {
      const r = PullDtoSchema.safeParse({ ...PR_11_FETCHED, index: -1 });
      expect(r.success).toBe(false);
    });

    it('PullDtoSchema 拒 createdAt 缺时区（IsoDateSchema 严格）', () => {
      const r = PullDtoSchema.safeParse({ ...PR_11_FETCHED, createdAt: '2026-06-11T20:00:21' });
      expect(r.success).toBe(false);
    });

    it('PullDtoSchema 拒 author 缺 username', () => {
      const r = PullDtoSchema.safeParse({
        ...PR_11_FETCHED,
        author: { avatarUrl: 'http://x.com/a.png' }, // username 缺失
      });
      expect(r.success).toBe(false);
    });
  });
});
