/**
 * schema 完整性 roundtrip 单测（M10 task 2）
 *
 * 目的：用真实 gitea 1.x 响应（fixtures/*.json）验证 10 个核心 DTO schema
 * 跟 src/main/gitea/* toDto() 输出形状一致。
 *
 * 关键路径：
 *   gitea server → 真实响应 (fixtures/*.json, 35+ 字段)
 *               → toDto() (gitea/* wrapper)  [本测试不 import，hand-roll 镜像]
 *               → DTO 形状 (12-13 字段)
 *               → Schema.parse(DTO)          [本测试唯一断言点]
 *
 * 跟 M9 task 2 pullDtoSchema.test.ts 的区别：
 *   - M9:  hand-typed PullDto (mock 性质)
 *   - M10: 从真实 gitea 响应 raw 派生 (fixture-based, 不再 mock)
 *   关系：M9 守 toDto 输出 schema 正确性；M10 守 toDto 跟 gitea 1.x raw 形状对齐。
 *
 * toDto 逻辑**不**直接 import src/main/gitea/*（会拉 electron via client.ts/auth.ts，
 *  详见 docs/adr/0002-... + memory gitea-js-wrap）。
 * 这里 hand-roll 镜像（行数 1:1 对应 gitea/pulls.ts:46-64 等），并在 JSDoc 标
 * "MIRRORS gitea/pulls.ts:46-64 toPullDto" 防止漂移。
 *
 * 真实 fixture 字段集（gitea 1.26 swagger 实际响应）：
 *   - giteaPullSingle.json : 38 字段 → DTO 13 字段 (toDto 裁掉 25 字段)
 *   - giteaCommitSingle.json : 10 字段 → DTO 6-9 字段 (list 端点不返 stats/files)
 *   - giteaIssueSingle.json : 27 字段 → DTO 9 字段 + labels[] + isPullRequest
 *   - giteaRepo.json       : 62 字段 → DTO 11 字段
 *   - giteaBranchList.json : 9 字段 (数组，每条) → DTO 4 字段 + lastCommit
 *   - giteaLabelList.json  : 7 字段 → DTO 3-4 字段
 *   - giteaCollaborators.json : 23 字段 (User) → DTO 2 字段 + permission
 *
 * 修复历史：
 *   - M5 fix-1: IsoDateSchema 改 `z.string().datetime({ offset: true })`，接受 +08:00
 *   - M9 task-2: 43 个单测守 mock PullDto 形状
 *   - M10 task-2 (本文件): 用真实 fixture 验 10 个 schema 一致性
 */
import { describe, it, expect } from 'vitest';
import {
  PullDtoSchema,
  CommitDtoSchema,
  IssueCardDtoSchema,
  RepoDtoSchema,
  ListPullsRespSchema,
  ListCommitsRespSchema,
  ListIssuesRespSchema,
  ListBranchesRespSchema,
  ListLabelsRespSchema,
  ListMembersRespSchema,
  type PullDto,
  type CommitDto,
  type IssueCardDto,
  type RepoDto,
  type BranchDto,
  type LabelDto,
  type CollaboratorDto,
  type ListCommitsResp,
} from '../schema.js';

// ===== fixtures（真实 gitea 1.x 响应；cast 到 unknown 避免 JSON 推断过窄） =====
// JSON 静态导入 TS 会按首项 literal 推断（影响所有 .map() 的 callback type）；
// cast 到 unknown[] / unknown 让 toDto 接收 broad shape，schema.parse 是 type guard。
import giteaPullListJson from './fixtures/giteaPullList.json';
import giteaPullSingleJson from './fixtures/giteaPullSingle.json';
import giteaCommitListJson from './fixtures/giteaCommitList.json';
import giteaCommitSingleJson from './fixtures/giteaCommitSingle.json';
import giteaIssueListJson from './fixtures/giteaIssueList.json';
import giteaIssueSingleJson from './fixtures/giteaIssueSingle.json';
import giteaRepoJson from './fixtures/giteaRepo.json';
import giteaBranchListJson from './fixtures/giteaBranchList.json';
import giteaLabelListJson from './fixtures/giteaLabelList.json';
import giteaCollaboratorsJson from './fixtures/giteaCollaborators.json';

const giteaPullList = giteaPullListJson as unknown[];
const giteaPullSingle = giteaPullSingleJson as Record<string, unknown>;
const giteaCommitList = giteaCommitListJson as unknown[];
const giteaCommitSingle = giteaCommitSingleJson as Record<string, unknown>;
const giteaIssueList = giteaIssueListJson as unknown[];
const giteaIssueSingle = giteaIssueSingleJson as Record<string, unknown>;
const giteaRepo = giteaRepoJson as Record<string, unknown>;
const giteaBranchList = giteaBranchListJson as unknown[];
const giteaLabelList = giteaLabelListJson as unknown[];
const giteaCollaborators = giteaCollaboratorsJson as unknown[];

// ===== gitea 原始响应 raw shape（swag 1.26 实际字段；gitea-js 1.23 类型已覆盖） =====

type GiteaRef = { ref?: string; sha?: string; label?: string; repo_id?: number; repo?: Record<string, unknown> };
type GiteaUser = { login?: string; login_name?: string; full_name?: string; email?: string; avatar_url?: string; id?: number; [k: string]: unknown };
type GiteaPR = {
  id?: number; number?: number; url?: string; diff_url?: string; patch_url?: string; html_url?: string;
  state?: string; title?: string; body?: string; draft?: boolean; mergeable?: boolean; merged?: boolean;
  merged_at?: string; merge_commit_sha?: string; merged_by?: GiteaUser | null;
  base?: GiteaRef; head?: GiteaRef;
  user?: GiteaUser; assignees?: GiteaUser[] | null; requested_reviewers?: GiteaUser[] | null;
  milestone?: Record<string, unknown> | null; labels?: Array<Record<string, unknown>>;
  created_at?: string; updated_at?: string; closed_at?: string; due_date?: string | null;
  additions?: number; deletions?: number; changed_files?: number; comments?: number;
  review_comments?: number; allow_maintainer_edit?: boolean; merge_base?: string;
  pin_order?: number; is_locked?: boolean; content_version?: number;
};
type GiteaCommitFile = {
  filename: string; status?: string; additions?: number; deletions?: number;
  changes?: number; previous_filename?: string; binary_file?: boolean;
};
type GiteaCommitListItem = {
  sha: string; url?: string; html_url?: string;
  commit?: { message?: string; author?: { name?: string; email?: string; date?: string }; committer?: { name?: string; email?: string; date?: string }; tree?: Record<string, unknown>; verification?: Record<string, unknown> };
  author?: GiteaUser; committer?: GiteaUser;
  parents?: Array<{ sha: string; url?: string; created?: string }>;
  files?: GiteaCommitFile[]; stats?: { total?: number; additions?: number; deletions?: number };
  created?: string;
};
type GiteaIssue = {
  id?: number; number?: number; url?: string; html_url?: string;
  state?: string; title?: string; body?: string; user?: GiteaUser;
  labels?: Array<{ id: number; name: string; color: string; description?: string }>;
  assignee?: GiteaUser | null; assignees?: GiteaUser[] | null;
  milestone?: Record<string, unknown> | null;
  created_at?: string; updated_at?: string; closed_at?: string; due_date?: string | null;
  comments?: number; is_locked?: boolean; pin_order?: number; content_version?: number;
  pull_request?: Record<string, unknown> | null;
  repository?: Record<string, unknown>; ref?: string;
  original_author?: string; original_author_id?: number; time_estimate?: number; assets?: unknown[];
};
type GiteaRepo = {
  id: number; name: string; full_name: string; description?: string;
  default_branch?: string; private?: boolean; archived?: boolean;
  owner?: GiteaUser; updated_at?: string;
  permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
  [k: string]: unknown;
};
type GiteaBranch = {
  name: string; protected?: boolean;
  commit?: { id?: string; sha?: string; url?: string; message?: string; author?: { name?: string; email?: string; username?: string }; commit?: { message?: string; author?: { date?: string; name?: string; email?: string } } };
  effective_branch_protection_name?: string; enable_status_check?: boolean;
  required_approvals?: number; status_check_contexts?: string[];
  user_can_merge?: boolean; user_can_push?: boolean;
};
type GiteaLabel = { id: number; name: string; color: string; description?: string; exclusive?: boolean; is_archived?: boolean; url?: string };
type GiteaCollaborator = GiteaUser;

// ===== toDto adapters (MIRRORS src/main/gitea/*.ts) =====

/** MIRRORS src/main/gitea/pulls.ts:46-64 toPullDto */
function toPullDto(raw: GiteaPR): PullDto {
  const number = raw.number ?? raw.id ?? 0;
  const mergeable = raw.mergeable !== false;
  return {
    index: number,
    title: raw.title ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    draft: Boolean(raw.draft),
    merged: Boolean(raw.merged),
    head: { ref: raw.head?.ref ?? '', sha: raw.head?.sha ?? '' },
    base: { ref: raw.base?.ref ?? '', sha: raw.base?.sha ?? '' },
    author: {
      username: raw.user?.login ?? '<unknown>',
      ...(raw.user?.avatar_url ? { avatarUrl: raw.user.avatar_url } : {}),
    },
    createdAt: raw.created_at ?? new Date(0).toISOString(),
    updatedAt: raw.updated_at ?? new Date(0).toISOString(),
    mergeable,
    hasConflicts: !mergeable,
  };
}

/** MIRRORS src/main/gitea/commits.ts list 端点 toCommitDto（无 stats/files） */
function toCommitDtoFromList(raw: GiteaCommitListItem): CommitDto {
  const c = raw.commit ?? {};
  const author = c.author ?? {};
  const committer = c.committer ?? {};
  return {
    sha: raw.sha,
    shortSha: raw.sha.slice(0, 7),
    message: c.message ?? '',
    author: { name: author.name ?? '', ...(author.email ? { email: author.email } : {}) },
    committer: { name: committer.name ?? '', ...(committer.email ? { email: committer.email } : {}) },
    date: author.date ?? new Date(0).toISOString(),
    parents: Array.isArray(raw.parents) ? raw.parents.map((p) => p.sha) : [],
  };
}

/** MIRRORS src/main/gitea/commits.ts single 端点 toCommitDto（带 stats/files） */
function toCommitDtoSingle(raw: GiteaCommitListItem): CommitDto {
  const base = toCommitDtoFromList(raw);
  const stats = raw.stats ?? {};
  return {
    ...base,
    additions: stats.additions,
    deletions: stats.deletions,
    filesChanged: stats.total,
    files: Array.isArray(raw.files)
      ? raw.files.map((f) => ({
          filename: f.filename,
          ...(f.status ? { status: f.status } : {}),
          ...(f.additions !== undefined ? { additions: f.additions } : {}),
          ...(f.deletions !== undefined ? { deletions: f.deletions } : {}),
          ...(f.changes !== undefined ? { changes: f.changes } : {}),
          ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
          ...(f.binary_file ? { binary: true } : {}),
        }))
      : undefined,
  };
}

/** MIRRORS src/main/gitea/issues.ts toIssueCardDto */
function toIssueCardDto(raw: GiteaIssue): IssueCardDto {
  return {
    id: raw.id!,
    index: raw.number!,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    createdAt: raw.created_at ?? new Date(0).toISOString(),
    updatedAt: raw.updated_at ?? new Date(0).toISOString(),
    author: {
      username: raw.user?.login ?? '<unknown>',
      ...(raw.user?.full_name ? { fullName: raw.user.full_name } : {}),
      ...(raw.user?.avatar_url ? { avatarUrl: raw.user.avatar_url } : {}),
    },
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          ...(l.description ? { description: l.description } : {}),
        }))
      : [],
    isPullRequest: Boolean(raw.pull_request),
  };
}

/** MIRRORS src/main/gitea/repos.ts toRepoDto */
function toRepoDto(raw: GiteaRepo): RepoDto {
  return {
    id: raw.id,
    owner: raw.owner?.login ?? '',
    name: raw.name,
    fullName: raw.full_name,
    description: raw.description ?? '',
    defaultBranch: raw.default_branch ?? '',
    archived: Boolean(raw.archived),
    private: Boolean(raw.private),
    updatedAt: raw.updated_at ?? new Date(0).toISOString(),
    permissions: {
      pull: Boolean(raw.permissions?.pull),
      push: Boolean(raw.permissions?.push),
      admin: Boolean(raw.permissions?.admin),
    },
    // RepoDtoSchema.isProject 有 .default(false) —— gitea 端不区分 repo vs project
    // v1 简化：始终 false（项目概念 = Drizzle 的 repo_projects 表派生）
    isProject: false,
  };
}

/** MIRRORS src/main/gitea/branches.ts toBranchDto */
function toBranchDto(raw: GiteaBranch, isDefault: boolean): BranchDto {
  const commit = raw.commit ?? {};
  return {
    name: raw.name,
    sha: commit.id ?? commit.sha ?? '',
    protected: Boolean(raw.protected),
    isDefault,
    starred: false,
    lastCommit: commit.id
      ? {
          sha: commit.id,
          message: commit.commit?.message ?? '',
          // BranchLastCommitDtoSchema.author 必填 string
          // gitea branch 端 commit.author = { name, email, username }（**不**是 user.login）
          author: commit.author?.name ?? '<unknown>',
          date: commit.commit?.author?.date ?? new Date(0).toISOString(),
        }
      : undefined,
  };
}

/** MIRRORS src/main/gitea/labels.ts toLabelDto */
function toLabelDto(raw: GiteaLabel): LabelDto {
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    ...(raw.description ? { description: raw.description } : {}),
  };
}

/** MIRRORS src/main/gitea/repos.ts toCollaboratorDto（实际字段来自 per-user /permission，fixture 没拉所以 = 'unknown'） */
function toCollaboratorDto(raw: GiteaCollaborator): CollaboratorDto {
  return {
    username: raw.login ?? '<unknown>',
    ...(raw.avatar_url ? { avatarUrl: raw.avatar_url } : {}),
    permission: 'unknown', // gitea permission 字段需 per-user /permission 端点单独拉
  };
}

// ===== ROUNDTRIP 断言 =====

describe('schema 完整性 roundtrip — 用真实 gitea 1.x 响应（fixtures/）', () => {
  describe('PullDtoSchema / ListPullsRespSchema', () => {
    it('PullDtoSchema.parse(toDto(giteaPullSingle)) PASS', () => {
      const dto = toPullDto(giteaPullSingle as GiteaPR);
      const r = PullDtoSchema.safeParse(dto);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.index).toBe(11);
        expect(r.data.merged).toBe(true);
        expect(r.data.hasConflicts).toBe(false);
        expect(r.data.createdAt).toBe('2026-06-11T20:00:21+08:00');
        expect(r.data.author.username).toBe('kanban_bot');
      }
    });

    it('ListPullsRespSchema.parse({items: giteaPullList.map(toDto), ...}) PASS', () => {
      const items = giteaPullList.map((r) => toPullDto(r as GiteaPR));
      const r = ListPullsRespSchema.safeParse({
        items,
        total: items.length,
        hasMore: false,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.items).toHaveLength(2);
        expect(r.data.items[0]?.index).toBe(12); // list 顺序按 id desc
        expect(r.data.items[1]?.index).toBe(11);
      }
    });

    it('PullDtoSchema.parse(raw gitea) FAIL（.strict() 拒多余字段，源=生产路径上不会发生）', () => {
      // 兜底回归：.strict() 真生效（gitea raw 38 字段 vs DTO 13 字段）
      const r = PullDtoSchema.safeParse(giteaPullSingle);
      expect(r.success).toBe(false);
    });
  });

  describe('CommitDtoSchema / ListCommitsRespSchema', () => {
    it('ListCommitsRespSchema.parse({items: giteaCommitList.map(toDtoList), ...}) PASS', () => {
      const items = giteaCommitList.map((r) => toCommitDtoFromList(r as GiteaCommitListItem));
      const r = ListCommitsRespSchema.safeParse({
        items,
        total: items.length,
        hasMore: false,
        nextPage: null,
      } satisfies ListCommitsResp);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.items).toHaveLength(5);
        // 全部 commit sha 必填；list 端点 additions/deletions/filesChanged 缺省
        for (const c of r.data.items) {
          expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
          expect(c.shortSha).toHaveLength(7);
          expect(c.additions).toBeUndefined();
          expect(c.files).toBeUndefined();
        }
      }
    });

    it('CommitDtoSchema.parse(toDtoSingle(giteaCommitSingle)) PASS — 含 stats + files', () => {
      const dto = toCommitDtoSingle(giteaCommitSingle as GiteaCommitListItem);
      const r = CommitDtoSchema.safeParse(dto);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.sha).toBe(giteaCommitSingle.sha);
        expect(r.data.additions).toBeDefined();
        expect(r.data.deletions).toBeDefined();
        expect(r.data.filesChanged).toBeDefined();
        expect(r.data.files).toBeDefined();
        expect(r.data.files?.length).toBeGreaterThan(0);
        if (r.data.files && r.data.files[0]) {
          expect(r.data.files[0].filename).toBeTruthy();
          expect(r.data.files[0].status).toBeTruthy();
        }
      }
    });
  });

  describe('IssueCardDtoSchema / ListIssuesRespSchema', () => {
    it('IssueCardDtoSchema.parse(toDto(giteaIssueSingle)) PASS', () => {
      const dto = toIssueCardDto(giteaIssueSingle as GiteaIssue);
      const r = IssueCardDtoSchema.safeParse(dto);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.index).toBe(25);
        // fixture 中第 1 个 issue = closed (e2e-card demo)；gitea state 字符串透传
        expect(r.data.state).toBe('closed');
        expect(r.data.isPullRequest).toBe(false); // pull_request=null 在 fixture 中
      }
    });

    it('ListIssuesRespSchema.parse({items: giteaIssueList.map(toDto), ...}) PASS', () => {
      const items = giteaIssueList.map((r) => toIssueCardDto(r as GiteaIssue));
      const r = ListIssuesRespSchema.safeParse({ items, hasMore: false });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.items).toHaveLength(10);
      }
    });
  });

  describe('RepoDtoSchema', () => {
    it('RepoDtoSchema.parse(toDto(giteaRepo)) PASS', () => {
      const dto = toRepoDto(giteaRepo as GiteaRepo);
      const r = RepoDtoSchema.safeParse(dto);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.owner).toBe('kanban_demo');
        expect(r.data.name).toBe('m4java-test');
        expect(r.data.fullName).toBe('kanban_demo/m4java-test');
        expect(r.data.permissions.admin).toBe(true);
        expect(r.data.archived).toBe(false);
        // gitea 1.x 实际 updatedAt 含 +08:00
        expect(r.data.updatedAt).toBe('2026-06-14T08:33:45+08:00');
      }
    });
  });

  describe('BranchDtoSchema / ListBranchesRespSchema', () => {
    it('ListBranchesRespSchema.parse({items: giteaBranchList.map(toDto), ...}) PASS', () => {
      // gitea 端 branches 列表**不**含 isDefault 标志，用 fixture 第 0 条（'main'）= true
      const items = giteaBranchList.map((b) => toBranchDto(b as GiteaBranch, (b as GiteaBranch).name === 'main'));
      const r = ListBranchesRespSchema.safeParse({
        items,
        total: items.length,
        hasMore: false,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.items).toHaveLength(6);
        const main = r.data.items.find((b) => b.name === 'main');
        expect(main?.isDefault).toBe(true);
        expect(main?.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/);
      }
    });
  });

  describe('LabelDtoSchema / ListLabelsRespSchema', () => {
    it('ListLabelsRespSchema.parse({items: giteaLabelList.map(toDto), ...}) PASS', () => {
      const items = giteaLabelList.map((l) => toLabelDto(l as GiteaLabel));
      const r = ListLabelsRespSchema.safeParse({ items, hasMore: false });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.items).toHaveLength(10);
        for (const l of r.data.items) {
          expect(l.id).toBeGreaterThan(0);
          expect(l.name).toBeTruthy();
          expect(l.color).toMatch(/^[0-9a-fA-F]{6}$/);
        }
      }
    });
  });

  describe('CollaboratorDtoSchema / ListMembersRespSchema', () => {
    it('ListMembersRespSchema.parse(giteaCollaborators.map(toDto)) PASS', () => {
      const items = giteaCollaborators.map((c) => toCollaboratorDto(c as GiteaCollaborator));
      const r = ListMembersRespSchema.safeParse(items);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data).toHaveLength(1);
        expect(r.data[0]?.username).toBeTruthy();
        // fixture 没拉 per-user /permission 端点 → permission='unknown'（toDto 兜底）
        expect(r.data[0]?.permission).toBe('unknown');
      }
    });
  });
});
