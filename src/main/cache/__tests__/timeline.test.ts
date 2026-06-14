/**
 * Timeline 缓存层单元测试（M9-task-1 · 分支级 commits 缓存）
 *
 * 测试目标：
 * - 写缓存后 30s 内读 → 命中（payload 正确）
 * - 写缓存后 30s+ → 失效（返回 null）
 * - invalidate 显式调用 → 立即失效（行删除）
 * - 不同 projectId / branch 集合 → key 隔离（互不命中）
 * - 入参 key 序列化稳定（同样 selectedBranches 顺序不影响 cache key）
 *
 * 测试环境：node env（默认） + better-sqlite3 临时 db path
 * - _setSqlitePathForTest 注入 /tmp 路径（避开 ~/.gitea-kanban 副作用）
 * - FK 关掉（cache 层不依赖 FK；repo_projects fixture 不用建）
 * - vi.useFakeTimers 控制"30s+ 之后"的时钟推进
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// logger.ts 在 src/main/cache/sqlite.ts 链上 → 顶层 import 即触发 `app.isPackaged`
// 在纯 node env 跑 vitest 时 electron.app 不存在 → mock 之
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp',
  },
}));
import {
  _setSqlitePathForTest,
  _resetSqliteForTest,
  initSqlite,
  getRawDb,
} from '../sqlite.js';
import {
  makeTimelineCacheKey,
  getTimelineCache,
  setTimelineCache,
  invalidateTimelineCache,
  TIMELINE_TTL_SECONDS,
} from '../timeline.js';
import type { TimelineArgs, TimelineDto } from '../../ipc/schema.js';

const TMP_DB_PATH = join(os.tmpdir(), `gitea-kanban-cache-test-${process.pid}-${Date.now()}.db`);

/** 构造一个最小合法 TimelineDto（满足 .strict() 校验） */
function makeTimelineDto(label: string): TimelineDto {
  return {
    range: {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-14T00:00:00Z',
    },
    lanes: [
      {
        id: `lane-${label}`,
        label: 'main',
        kind: 'branch',
        color: '#74b830',
        order: 0,
      },
    ],
    nodes: [
      {
        id: `node-${label}-1`,
        laneId: `lane-${label}`,
        x: 5,
        y: 0,
        sha: `sha-${label}-0001`,
        shortSha: `sha-${label}`,
        message: `commit ${label}`,
        author: { name: 'alice' },
        timestamp: '2026-06-10T00:00:00Z',
        parents: [],
        isMerge: false,
        branchHints: ['main'],
        linkedCardIds: [],
      },
    ],
    edges: [],
    prs: [],
    truncated: false,
    totalCommits: 1,
  };
}

const BASE_ARGS: TimelineArgs = {
  projectId: 'project-a',
  branches: ['main'],
  maxNodes: 500,
  laneMode: 'branch',
};

beforeAll(async () => {
  _setSqlitePathForTest(TMP_DB_PATH);
  await initSqlite();
  // cache 层不依赖 FK，关闭以避免 fixture 复杂化
  getRawDb().pragma('foreign_keys = OFF');
});

afterAll(async () => {
  await _resetSqliteForTest();
  if (existsSync(TMP_DB_PATH)) {
    try { unlinkSync(TMP_DB_PATH); } catch { /* best effort */ }
  }
});

beforeEach(() => {
  // 每个 case 前清表，避免相互污染
  getRawDb().exec('DELETE FROM cache_entries');
  vi.useRealTimers(); // beforeEach 强制还原，避免上一个 case 的 fake timer 残留
});

describe('TIMELINE_TTL_SECONDS 常量', () => {
  it('导出为 30s（与 pulls TTL 同步）', () => {
    expect(TIMELINE_TTL_SECONDS).toBe(30);
  });
});

describe('makeTimelineCacheKey 序列化稳定', () => {
  it('同样 selectedBranches 不同顺序 → 同样 key', () => {
    const a: TimelineArgs = { ...BASE_ARGS, branches: ['main', 'feature/x', 'feature/y'] };
    const b: TimelineArgs = { ...BASE_ARGS, branches: ['feature/y', 'main', 'feature/x'] };
    expect(makeTimelineCacheKey(a)).toBe(makeTimelineCacheKey(b));
  });

  it('projectId 变化 → key 变', () => {
    const a = makeTimelineCacheKey({ ...BASE_ARGS, projectId: 'project-a' });
    const b = makeTimelineCacheKey({ ...BASE_ARGS, projectId: 'project-b' });
    expect(a).not.toBe(b);
  });

  it('branches 内容变 → key 变（顺序无关）', () => {
    const a = makeTimelineCacheKey({ ...BASE_ARGS, branches: ['main'] });
    const b = makeTimelineCacheKey({ ...BASE_ARGS, branches: ['feature/x'] });
    expect(a).not.toBe(b);
  });

  it('since/until/laneMode/maxNodes 任一字段变 → key 变', () => {
    const base = makeTimelineCacheKey(BASE_ARGS);
    expect(makeTimelineCacheKey({ ...BASE_ARGS, since: '2026-06-01T00:00:00Z' })).not.toBe(base);
    expect(makeTimelineCacheKey({ ...BASE_ARGS, until: '2026-06-14T00:00:00Z' })).not.toBe(base);
    expect(makeTimelineCacheKey({ ...BASE_ARGS, laneMode: 'author' })).not.toBe(base);
    expect(makeTimelineCacheKey({ ...BASE_ARGS, maxNodes: 100 })).not.toBe(base);
  });
});

describe('Timeline cache 读 / 写 / 失效', () => {
  it('写后 30s 内读 → 命中（payload 正确）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T10:00:00Z'));

    const dto = makeTimelineDto('hit');
    const cacheKey = makeTimelineCacheKey(BASE_ARGS);
    setTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey, payload: dto });

    const got = getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey });
    expect(got).not.toBeNull();
    const parsed = JSON.parse(got!);
    expect(parsed.totalCommits).toBe(1);
    expect(parsed.lanes[0].id).toBe('lane-hit');
  });

  it('写后 30s+ → 失效（返回 null）', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-06-14T10:00:00Z');
    vi.setSystemTime(t0);

    const dto = makeTimelineDto('expired');
    const cacheKey = makeTimelineCacheKey(BASE_ARGS);
    setTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey, payload: dto });

    // 推进 31s 超过 TTL（30s）
    vi.setSystemTime(new Date(t0.getTime() + 31_000));

    const got = getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey });
    expect(got).toBeNull();
  });

  it('写后刚好 30s → 边界命中（ageSeconds === ttl）', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-06-14T10:00:00Z');
    vi.setSystemTime(t0);

    const dto = makeTimelineDto('boundary');
    const cacheKey = makeTimelineCacheKey(BASE_ARGS);
    setTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey, payload: dto });

    // 推进 30s 整（不超 TTL）→ 仍应命中（ageSeconds > ttl 才是失效）
    vi.setSystemTime(new Date(t0.getTime() + 30_000));

    const got = getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey });
    expect(got).not.toBeNull();
  });

  it('invalidate 显式调用 → 立即失效（行被删）', () => {
    const dto = makeTimelineDto('inv');
    const cacheKey = makeTimelineCacheKey(BASE_ARGS);
    setTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey, payload: dto });
    expect(getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey })).not.toBeNull();

    invalidateTimelineCache(BASE_ARGS.projectId);
    expect(getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey })).toBeNull();
  });

  it('不同 projectId → key 隔离（互不命中）', () => {
    const dto = makeTimelineCacheKey;
    void dto; // 不使用，仅为 lint 警告

    const aKey = makeTimelineCacheKey({ ...BASE_ARGS, projectId: 'project-a' });
    const bKey = makeTimelineCacheKey({ ...BASE_ARGS, projectId: 'project-b' });

    setTimelineCache({
      projectId: 'project-a',
      cacheKey: aKey,
      payload: makeTimelineDto('a'),
    });
    setTimelineCache({
      projectId: 'project-b',
      cacheKey: bKey,
      payload: makeTimelineDto('b'),
    });

    const gotA = getTimelineCache({ projectId: 'project-a', cacheKey: aKey });
    const gotB = getTimelineCache({ projectId: 'project-b', cacheKey: bKey });
    expect(gotA).not.toBeNull();
    expect(gotB).not.toBeNull();
    const pa = JSON.parse(gotA!);
    const pb = JSON.parse(gotB!);
    expect(pa.lanes[0].id).toBe('lane-a');
    expect(pb.lanes[0].id).toBe('lane-b');

    // 交叉读应 miss（projectA key 不会命中 projectB 的 entry）
    expect(getTimelineCache({ projectId: 'project-a', cacheKey: bKey })).toBeNull();
    expect(getTimelineCache({ projectId: 'project-b', cacheKey: aKey })).toBeNull();
  });

  it('不同 branches 集合 → key 隔离（互不命中）', () => {
    const mainKey = makeTimelineCacheKey({ ...BASE_ARGS, branches: ['main'] });
    const featKey = makeTimelineCacheKey({ ...BASE_ARGS, branches: ['feature/x'] });

    setTimelineCache({
      projectId: BASE_ARGS.projectId,
      cacheKey: mainKey,
      payload: makeTimelineDto('main'),
    });

    expect(getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey: mainKey })).not.toBeNull();
    expect(getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey: featKey })).toBeNull();
  });

  it('invalidate(projectId) 只清指定 projectId，不影响其他 project', () => {
    const aKey = makeTimelineCacheKey({ ...BASE_ARGS, projectId: 'project-a' });
    const bKey = makeTimelineCacheKey({ ...BASE_ARGS, projectId: 'project-b' });

    setTimelineCache({
      projectId: 'project-a',
      cacheKey: aKey,
      payload: makeTimelineDto('a'),
    });
    setTimelineCache({
      projectId: 'project-b',
      cacheKey: bKey,
      payload: makeTimelineDto('b'),
    });

    invalidateTimelineCache('project-a');

    expect(getTimelineCache({ projectId: 'project-a', cacheKey: aKey })).toBeNull();
    expect(getTimelineCache({ projectId: 'project-b', cacheKey: bKey })).not.toBeNull();
  });

  it('setTimelineCache 同 key 二次写 → 覆盖（不新增行）', () => {
    const cacheKey = makeTimelineCacheKey(BASE_ARGS);
    setTimelineCache({
      projectId: BASE_ARGS.projectId,
      cacheKey,
      payload: makeTimelineDto('v1'),
    });
    setTimelineCache({
      projectId: BASE_ARGS.projectId,
      cacheKey,
      payload: makeTimelineDto('v2'),
    });

    const rows = getRawDb()
      .prepare('SELECT COUNT(*) as c FROM cache_entries')
      .get() as { c: number };
    expect(rows.c).toBe(1);

    const got = getTimelineCache({ projectId: BASE_ARGS.projectId, cacheKey });
    const parsed = JSON.parse(got!);
    expect(parsed.lanes[0].id).toBe('lane-v2');
  });
});
