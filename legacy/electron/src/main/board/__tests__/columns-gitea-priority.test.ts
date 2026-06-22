/**
 * 看板列 Gitea 优先原则单测（2026-06-15 user 拍板）
 *
 * 覆盖：
 * 1. listColumns 调 gitea 拉实时 label name/color（不依赖 localStore 缓存）
 * 2. listColumns 过滤 gitea 端已删的 label（差集跳过）
 * 3. listColumns gitea 拉失败 → 透传 NETWORK_OFFLINE（不静默降级）
 * 4. listColumns 无绑定 label → 跳过 gitea 调用（空列场景不浪费请求）
 * 5. mapLabel 调 gitea 校验 label 不存在 → 抛 NOT_FOUND
 * 6. mapLabel 调 gitea 校验 label 存在 → 用 gitea 实时 name 写 localStore
 * 7. mapLabel 调 gitea 网络失败 → 透传 NETWORK_OFFLINE（不静默写入 stale 数据）
 *
 * Mock 策略：vi.mock('../gitea/labels.js') 整个模块（避免引 electron）
 *
 * 不依赖真实 gitea server；不依赖 better-sqlite3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== vi.mock 必须放在 import 业务模块之前 =====

// vi.hoisted 让 mock 工厂能引用 top-level mock 对象（vi.mock 会被 hoist）
const mocks = vi.hoisted(() => ({
  listGiteaLabels: vi.fn(),
  resolveProject: vi.fn(),
}));

// mock electron（logger.ts 顶层 import app.isPackaged，node 环境无 electron）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
}));

// mock listGiteaLabels（listColumns / mapLabel 都依赖它）
vi.mock('../../gitea/labels.js', () => ({
  listGiteaLabels: mocks.listGiteaLabels,
}));

// mock resolveProject（走 localStore 读 fixtures；不调 gitea 链路，但 mock 起来更可控）
vi.mock('../resolveProject.js', () => ({
  resolveProject: mocks.resolveProject,
}));

import { listColumns, mapLabel, createColumn, unmapLabel } from '../columns.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { initLocalStore, getLocalStore, _resetLocalStoreForTest } from '../../local/state.js';
import type { ColumnLabelMap, BoardColumn, RepoProject } from '../../local/state.js';

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-columns-test-'));
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
  // 走 mutate 直接写 localStore，绕过 init 链路
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
  // resolveProject 读 localStore，mock 返 proj 字段
  mocks.resolveProject.mockReturnValue({
    giteaUrl: 'https://gitea.example.com',
    username: 'alice',
    owner: 'org1',
    repo: 'web',
    defaultBranch: 'main',
  });
}

function seedColumn(columnId: string, projectId: string, title = 'ToDo'): void {
  getLocalStore().mutate((s) => {
    const col: BoardColumn = {
      id: columnId,
      projectId,
      title,
      position: 1024,
      createdAt: Date.now(),
    };
    s.columns.push(col);
  });
}

function seedLabelMap(
  columnId: string,
  projectId: string,
  giteaLabelId: number,
  giteaLabelName: string,
): void {
  getLocalStore().mutate((s) => {
    const m: ColumnLabelMap = {
      id: `lm-${giteaLabelId}`,
      columnId,
      projectId,
      giteaLabelId: String(giteaLabelId),
      giteaLabelName,
      createdAt: Date.now(),
    };
    s.labelMaps.push(m);
  });
}

// ============================================================
// ===== listColumns =====
// ============================================================

describe('listColumns — Gitea 优先原则', () => {
  it('1. 调 gitea 拉实时 label name/color（不依赖 localStore 缓存）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');
    seedLabelMap('c1', 'p1', 101, 'STALE-NAME-OLD'); // localStore 缓存的 stale name

    // gitea 返的是**新**的 name + color
    mocks.listGiteaLabels.mockResolvedValue({
      items: [{ id: 101, name: 'live-bug', color: '#ff0000' }],
      hasMore: false,
    });

    const result = await listColumns('p1');

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c1');
    // **关键**：name 来自 gitea 实时数据，不是 localStore 缓存的 STALE-NAME-OLD
    expect(result[0]!.labels).toEqual([{ id: 101, name: 'live-bug', color: '#ff0000' }]);
  });

  it('2. 过滤 gitea 端已删的 label（gitea 返的 items 缺少 boundLabelId）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');
    seedLabelMap('c1', 'p1', 101, 'live-bug');
    seedLabelMap('c1', 'p1', 999, 'deleted-in-gitea'); // 绑的但 gitea 删了

    mocks.listGiteaLabels.mockResolvedValue({
      items: [
        { id: 101, name: 'live-bug', color: '#ff0000' },
        // 999 已被 gitea 删
      ],
      hasMore: false,
    });

    const result = await listColumns('p1');

    expect(result[0]!.labels).toEqual([{ id: 101, name: 'live-bug', color: '#ff0000' }]);
  });

  it('3. gitea 拉失败 → 透传 NETWORK_OFFLINE（不静默降级）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');
    seedLabelMap('c1', 'p1', 101, 'live-bug');

    mocks.listGiteaLabels.mockRejectedValue(
      new IpcError({
        code: IpcErrorCode.NETWORK_OFFLINE,
        message: '当前离线或远端不可达',
      }),
    );

    await expect(listColumns('p1')).rejects.toThrow(IpcError);
    await expect(listColumns('p1')).rejects.toMatchObject({
      code: IpcErrorCode.NETWORK_OFFLINE,
    });
  });

  it('4. 无绑定 label → 跳过 gitea 调用（空列场景不浪费请求）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');
    // 不 seedLabelMap

    const result = await listColumns('p1');

    expect(mocks.listGiteaLabels).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]!.labels).toEqual([]);
  });
});

// ============================================================
// ===== mapLabel =====
// ============================================================

describe('mapLabel — Gitea 优先原则', () => {
  it('5. 调 gitea 校验 label 不存在 → 抛 NOT_FOUND', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');

    mocks.listGiteaLabels.mockResolvedValue({
      items: [{ id: 999, name: 'other', color: '#000' }], // 没有 101
      hasMore: false,
    });

    await expect(
      mapLabel({ columnId: 'c1', giteaLabelId: 101, giteaLabelName: 'caller-stale' }),
    ).rejects.toMatchObject({
      code: IpcErrorCode.NOT_FOUND,
    });
  });

  it('6. 调 gitea 校验 label 存在 → 用 gitea 实时 name 写 localStore（caller 传 stale 不写）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');

    mocks.listGiteaLabels.mockResolvedValue({
      items: [{ id: 101, name: 'live-bug', color: '#ff0000' }],
      hasMore: false,
    });

    await mapLabel({
      columnId: 'c1',
      giteaLabelId: 101,
      giteaLabelName: 'STALE-CALLER-NAME', // caller 传的旧名
    });

    // 验证 localStore 写的是 gitea 实时 name，**不**是 caller 传的
    getLocalStore;
    const maps = getLocalStore().get().labelMaps;
    const map = maps.find((m) => m.giteaLabelId === '101');
    expect(map).toBeDefined();
    expect(map!.giteaLabelName).toBe('live-bug');
  });

  it('7. 调 gitea 网络失败 → 透传 NETWORK_OFFLINE（不静默写入 stale 数据）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');

    mocks.listGiteaLabels.mockRejectedValue(
      new IpcError({
        code: IpcErrorCode.NETWORK_OFFLINE,
        message: '当前离线或远端不可达',
      }),
    );

    await expect(
      mapLabel({ columnId: 'c1', giteaLabelId: 101, giteaLabelName: 'any' }),
    ).rejects.toMatchObject({
      code: IpcErrorCode.NETWORK_OFFLINE,
    });

    // 关键：失败时**不**写 localStore
    getLocalStore;
    const maps = getLocalStore().get().labelMaps;
    expect(maps.find((m) => m.giteaLabelId === '101')).toBeUndefined();
  });

  it('8. 漂移修复：caller 之前传的 name 跟 gitea 不一致 → 二次 mapLabel 同步修正', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');
    // localStore 已有 stale name 的 mapping
    seedLabelMap('c1', 'p1', 101, 'STALE-OLD-NAME');

    mocks.listGiteaLabels.mockResolvedValue({
      items: [{ id: 101, name: 'LIVE-NEW-NAME', color: '#00ff00' }],
      hasMore: false,
    });

    await mapLabel({
      columnId: 'c1',
      giteaLabelId: 101,
      giteaLabelName: 'STALE-OLD-NAME', // caller 也传 stale
    });

    getLocalStore;
    const maps = getLocalStore().get().labelMaps;
    const map = maps.find((m) => m.giteaLabelId === '101');
    expect(map!.giteaLabelName).toBe('LIVE-NEW-NAME');
  });
});

// ============================================================
// ===== 回归：unmapLabel / createColumn 不调 gitea =====
// ============================================================

describe('回归：unmapLabel / createColumn 不调 gitea（保持原行为）', () => {
  it('9. unmapLabel 不调 gitea（仅改 localStore）', async () => {
    seedProject('p1');
    seedColumn('c1', 'p1');
    seedLabelMap('c1', 'p1', 101, 'live-bug');

    await unmapLabel({ columnId: 'c1', giteaLabelId: 101 });

    expect(mocks.listGiteaLabels).not.toHaveBeenCalled();
    getLocalStore;
    expect(getLocalStore().get().labelMaps).toHaveLength(0);
  });

  it('10. createColumn 不调 gitea', async () => {
    seedProject('p1');

    const col = await createColumn({ projectId: 'p1', title: 'ToDo', position: 0 });

    expect(mocks.listGiteaLabels).not.toHaveBeenCalled();
    expect(col.title).toBe('ToDo');
    expect(col.labels).toEqual([]);
  });
});
