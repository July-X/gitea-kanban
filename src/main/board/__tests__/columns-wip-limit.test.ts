/**
 * 看板列 WIP 上限单测（plan_25cc4562 · Task B）
 *
 * 覆盖：
 * 1. updateColumn({ wipLimit: 5 }) 成功，DTO 含 wipLimit=5
 * 2. updateColumn({ wipLimit: 0 }) 抛 VALIDATION_FAILED
 * 3. updateColumn({ wipLimit: -1 }) 抛 VALIDATION_FAILED
 * 4. updateColumn({ wipLimit: 3.5 }) 抛 VALIDATION_FAILED
 *
 * 业务规则（plan_25cc4562 Task B prompt）：
 * - wipLimit 正整数 = 上限，null = 无限
 * - 负数 / 0 / 非整数 → 抛 VALIDATION_FAILED
 * - 列里已有 N 张卡片调小 wipLimit 到 < N → 现有卡片**不**被强制移动
 *   （任务 prompt §"边界情况" — 此单测不直接覆盖换列行为，move-card 测试负责；
 *    本单测只守 updateColumn 写值的正确性）
 *
 * Mock 策略：vi.mock('../gitea/labels.js')（不调 gitea，本单测只测 updateColumn）
 * 不依赖真实 gitea server；不依赖 better-sqlite3
 *
 * 注：与 columns-gitea-priority.test.ts 用同一组 beforeEach/afterEach（共享 localStore fixture）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== vi.mock 必须放在 import 业务模块之前 =====

const mocks = vi.hoisted(() => ({
  listGiteaLabels: vi.fn(),
  resolveProject: vi.fn(),
}));

// mock electron（logger.ts 顶层 import app.isPackaged，node 环境无 electron）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
}));

// mock listGiteaLabels（updateColumn 不调它，但同模块的 listColumns 会，兜底 mock）
vi.mock('../../gitea/labels.js', () => ({
  listGiteaLabels: mocks.listGiteaLabels,
}));

// mock resolveProject（updateColumn 不走 gitea，但本测试不依赖具体行为；mock 起来更可控）
vi.mock('../resolveProject.js', () => ({
  resolveProject: mocks.resolveProject,
}));

import { createColumn, updateColumn } from '../columns.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { initLocalStore, getLocalStore, _resetLocalStoreForTest } from '../../local/state.js';
import type { BoardColumn, RepoProject } from '../../local/state.js';

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-wip-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
  await _resetLocalStoreForTest();
  await initLocalStore();
  mocks.listGiteaLabels.mockReset();
  mocks.resolveProject.mockReset();
});

afterEach(async () => {
  if (savedEnv !== undefined) process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  else delete process.env['GITEA_KANBAN_DATA_DIR'];
  await _resetLocalStoreForTest();
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ===== fixtures =====

function seedProject(projectId = 'p1', accountId = 'a1'): void {
  getLocalStore().mutate((s) => {
    if (!s.accounts.find((a) => a.id === accountId)) {
      s.accounts.push({
        id: accountId,
        giteaUrl: 'https://gitea.example.com',
        username: 'alice',
        keychainService: 'svc1',
        createdAt: Date.now(),
        userInfo: null,
      });
    }
    if (!s.projects.find((p) => p.id === projectId)) {
      const proj: RepoProject = {
        id: projectId,
        giteaAccountId: accountId,
        owner: 'org1',
        name: 'web',
        defaultBranch: 'main',
        lastSyncAt: null,
        createdAt: Date.now(),
      };
      s.projects.push(proj);
    }
  });
  mocks.resolveProject.mockReturnValue({
    giteaUrl: 'https://gitea.example.com',
    username: 'alice',
    owner: 'org1',
    repo: 'web',
    defaultBranch: 'main',
  });
}

/** 直接 seed 一列（绕过 createColumn，便于测 updateColumn 在已有 wipLimit / undefined wipLimit 状态下的行为） */
function seedColumn(
  columnId: string,
  projectId: string,
  title = 'ToDo',
  wipLimit: number | null | undefined = undefined,
): void {
  getLocalStore().mutate((s) => {
    const col: BoardColumn = {
      id: columnId,
      projectId,
      title,
      position: 1024,
      createdAt: Date.now(),
      // 显式写 undefined 时让字段缺失（模拟老数据 / 没设过上限）
      ...(wipLimit === undefined ? {} : { wipLimit }),
    };
    s.columns.push(col);
  });
}

// ============================================================
// ===== updateColumn · wipLimit 写值 =====
// ============================================================

describe('updateColumn — WIP 上限（plan_25cc4562 · Task B）', () => {
  it('1. updateColumn({ wipLimit: 5 }) 成功，DTO 含 wipLimit=5', () => {
    seedProject('p1');
    // 用 createColumn 走完整链路（默认 wipLimit=null），再 update
    const col = createColumn({ projectId: 'p1', title: '进行中', position: 0 });
    expect(col.wipLimit).toBeNull(); // createColumn 默认无限

    const updated = updateColumn({ columnId: col.id, patch: { wipLimit: 5 } });

    expect(updated.id).toBe(col.id);
    expect(updated.wipLimit).toBe(5);

    // 落 localStore 也确实是 5（**不**只是 DTO 透传）
    const row = getLocalStore()
      .get()
      .columns.find((c) => c.id === col.id);
    expect(row).toBeDefined();
    expect(row!.wipLimit).toBe(5);
  });

  it('2. updateColumn({ wipLimit: 0 }) 抛 VALIDATION_FAILED', () => {
    seedProject('p1');
    seedColumn('c1', 'p1');

    expect(() => updateColumn({ columnId: 'c1', patch: { wipLimit: 0 } })).toThrow(IpcError);
    try {
      updateColumn({ columnId: 'c1', patch: { wipLimit: 0 } });
    } catch (e) {
      expect(e).toBeInstanceOf(IpcError);
      expect((e as IpcError).code).toBe(IpcErrorCode.VALIDATION_FAILED);
    }

    // localStore 不动
    const row = getLocalStore()
      .get()
      .columns.find((c) => c.id === 'c1');
    expect(row!.wipLimit).toBeUndefined(); // 没设过上限
  });

  it('3. updateColumn({ wipLimit: -1 }) 抛 VALIDATION_FAILED', () => {
    seedProject('p1');
    seedColumn('c1', 'p1');

    expect(() => updateColumn({ columnId: 'c1', patch: { wipLimit: -1 } })).toThrow(IpcError);
    try {
      updateColumn({ columnId: 'c1', patch: { wipLimit: -1 } });
    } catch (e) {
      expect(e).toBeInstanceOf(IpcError);
      expect((e as IpcError).code).toBe(IpcErrorCode.VALIDATION_FAILED);
    }
  });

  it('4. updateColumn({ wipLimit: 3.5 }) 抛 VALIDATION_FAILED', () => {
    seedProject('p1');
    seedColumn('c1', 'p1');

    expect(() => updateColumn({ columnId: 'c1', patch: { wipLimit: 3.5 } })).toThrow(IpcError);
    try {
      updateColumn({ columnId: 'c1', patch: { wipLimit: 3.5 } });
    } catch (e) {
      expect(e).toBeInstanceOf(IpcError);
      expect((e as IpcError).code).toBe(IpcErrorCode.VALIDATION_FAILED);
    }
  });
});

// ============================================================
// ===== 边界：null = 无限；列里已超 N 时不强制移动 =====
// ============================================================

describe('updateColumn — WIP 边界', () => {
  it('5. updateColumn({ wipLimit: null }) 把已设上限改回无限（列头回到只显示数字）', () => {
    seedProject('p1');
    seedColumn('c1', 'p1', 'ToDo', 5);
    const updated = updateColumn({ columnId: 'c1', patch: { wipLimit: null } });
    expect(updated.wipLimit).toBeNull();
  });

  it('6. updateColumn 同时改 title + wipLimit 都能落 localStore', () => {
    seedProject('p1');
    const col = createColumn({ projectId: 'p1', title: '旧名', position: 0 });
    const updated = updateColumn({
      columnId: col.id,
      patch: { title: '新名', wipLimit: 3 },
    });
    expect(updated.title).toBe('新名');
    expect(updated.wipLimit).toBe(3);
  });
});
