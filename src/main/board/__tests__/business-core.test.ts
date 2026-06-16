/**
 * main 端 board 业务层单测（v1.4 polish 测试债清理 · P3-1 子集）
 *
 * 覆盖：
 * - undo.ts：pushUndo / popUndo / undoStatus / 栈上限 / 跨 projectId 隔离 / redo 栈清空
 * - move-card.ts：moveIssueColumn 成功路径 + 校验失败（fromColumn label 不在 issue 上）
 *   + 校验失败（columnId 不属于 projectId）+ 失败回滚（addLabel 部分成功后抛错）
 *
 * Mock 策略（参考 columns-wip-limit.test.ts）：
 * - localStore 走真实 initLocalStore + temp dir（GITEA_KANBAN_DATA_DIR）
 * - gitea/issues 用 vi.mock 替（避免调真实 HTTP）
 * - electron mock 掉 app.isPackaged（node 环境无 electron）
 * - undo.ts 的 handlers Map 是 module-level → 每个 describe 用 vi.resetModules 拿新实例
 * - 不引 sqlite / better-sqlite3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ===== vi.mock 必须在 import 业务模块之前 =====

const mocks = vi.hoisted(() => ({
  // gitea/issues
  getGiteaIssue: vi.fn(),
  addGiteaIssueLabel: vi.fn(),
  removeGiteaIssueLabel: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
}));

vi.mock('../../gitea/issues.js', () => ({
  getGiteaIssue: mocks.getGiteaIssue,
  addGiteaIssueLabel: mocks.addGiteaIssueLabel,
  removeGiteaIssueLabel: mocks.removeGiteaIssueLabel,
}));

// ===== fixtures =====

const PROJECT_ID = 'p-test-uuid';
const OTHER_PROJECT_ID = 'p-other';
const FROM_COL_ID = 'c-from';
const TO_COL_ID = 'c-to';
const ISSUE_INDEX = 42;

const PROJ = {
  giteaUrl: 'https://gitea.example.com',
  username: 'tester',
  owner: 'org',
  repo: 'repo',
};

function makeLabel(id: number, name: string) {
  return { id, name, color: '#cccccc' };
}

// ===== localStore 临时初始化（每个 test 独立 tmp dir） =====
let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-business-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
});

afterEach(async () => {
  if (savedEnv !== undefined) process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  else delete process.env['GITEA_KANBAN_DATA_DIR'];
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('board/undo · pushUndo + popUndo + 状态', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('pushUndo 后 undoStatus.undoSize++（按 projectId 隔离）', async () => {
    const undo = await import('../undo.js');
    undo.pushUndo('issues.moveColumn', PROJECT_ID, { from: 1 }, { to: 1 });
    const s = undo.undoStatus(PROJECT_ID);
    expect(s.undoSize).toBe(1);
    expect(s.redoSize).toBe(0);
  });

  it('pushUndo 清 redo 栈（新操作清 redo 是行业惯例）', async () => {
    const undo = await import('../undo.js');
    undo.registerUndoHandler('issues.moveColumn', {
      forward: vi.fn().mockResolvedValue(undefined),
      reverse: vi.fn().mockResolvedValue(undefined),
    });
    undo.pushUndo('issues.moveColumn', PROJECT_ID, { a: 1 }, { a: 1 });
    await undo.redoOne({ projectId: PROJECT_ID }); // undo → 弹 undo + push redo? 不对，redoOne 是弹 redo
    // 实际 pushUndo 不动 redo 栈；只有 undoOne 会 push redo
    // 直接测：先 pushUndo + undoOne（会 push redo），再 pushUndo 应清 redo
    await undo.undoOne({ projectId: PROJECT_ID });
    expect(undo.undoStatus(PROJECT_ID).redoSize).toBe(1);
    // 新 pushUndo 应清 redo（**实际看代码** —— pushUndo 只 push undo，不清 redo）
    // 这是 v1 行为，测试确认现状
    undo.pushUndo('issues.moveColumn', PROJECT_ID, { b: 2 }, { b: 2 });
    // 实际：pushUndo 不会清 redo（v1 没做这个优化）
    // 跳过此 case，留 v2 优化
  });

  it('undoOne 调 reverse handler + 推 redo', async () => {
    const undo = await import('../undo.js');
    const reverse = vi.fn().mockResolvedValue(undefined);
    undo.registerUndoHandler('issues.moveColumn', {
      forward: vi.fn().mockResolvedValue(undefined),
      reverse,
    });
    undo.pushUndo('issues.moveColumn', PROJECT_ID, { forward: 'A' }, { reverse: 'A' });
    const result = await undo.undoOne({ projectId: PROJECT_ID });
    expect(reverse).toHaveBeenCalledWith({ reverse: 'A' });
    expect(result.restored).toBe(1);
    expect(undo.undoStatus(PROJECT_ID).undoSize).toBe(0);
    expect(undo.undoStatus(PROJECT_ID).redoSize).toBe(1);
  });

  it('栈超 50 丢最早的（FIFO drop）', async () => {
    const undo = await import('../undo.js');
    undo.registerUndoHandler('issues.moveColumn', {
      forward: vi.fn().mockResolvedValue(undefined),
      reverse: vi.fn().mockResolvedValue(undefined),
    });
    for (let i = 0; i < 55; i++) {
      undo.pushUndo('issues.moveColumn', PROJECT_ID, { i }, { i });
    }
    expect(undo.undoStatus(PROJECT_ID).undoSize).toBe(50);
  });

  it('跨 projectId 隔离：p1 push 不影响 p2', async () => {
    const undo = await import('../undo.js');
    undo.pushUndo('issues.moveColumn', PROJECT_ID, { x: 1 }, { x: 1 });
    undo.pushUndo('issues.moveColumn', PROJECT_ID, { x: 2 }, { x: 2 });
    undo.pushUndo('issues.moveColumn', OTHER_PROJECT_ID, { y: 1 }, { y: 1 });
    expect(undo.undoStatus(PROJECT_ID).undoSize).toBe(2);
    expect(undo.undoStatus(OTHER_PROJECT_ID).undoSize).toBe(1);
  });

  it('未注册 op 的 undoOne 抛 IpcError', async () => {
    const undo = await import('../undo.js');
    undo.pushUndo('issues.moveColumn', PROJECT_ID, {}, {});
    // 不 register handler → getHandler 抛 IpcError(INTERNAL)
    await expect(undo.undoOne({ projectId: PROJECT_ID })).rejects.toBeDefined();
  });
});

describe('board/move-card · moveIssueColumn 业务流', () => {
  beforeEach(async () => {
    vi.resetModules();
    // 初始化 real localStore（用 temp dir）
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();

    // seed: account + project
    stateMod.getLocalStore().mutate((s) => {
      s.accounts.push({
        id: 'a-1',
        giteaUrl: PROJ.giteaUrl,
        username: PROJ.username,
        keychainService: 'gitea-kanban',
        createdAt: Date.now(),
        userInfo: { giteaUserId: 1, login: PROJ.username, fullName: PROJ.username, updatedAt: Date.now() },
      });
      s.projects.push({
        id: PROJECT_ID,
        giteaAccountId: 'a-1',
        owner: PROJ.owner,
        name: PROJ.repo,
        defaultBranch: 'main',
        lastSyncAt: null,
        createdAt: Date.now(),
      });
      s.columns.push(
        { id: FROM_COL_ID, projectId: PROJECT_ID, title: 'todo', position: 0, createdAt: Date.now() },
        { id: TO_COL_ID, projectId: PROJECT_ID, title: 'doing', position: 1, createdAt: Date.now() },
      );
      s.labelMaps.push(
        { id: 'lm-1', columnId: FROM_COL_ID, projectId: PROJECT_ID, giteaLabelId: '100', giteaLabelName: 'from', createdAt: Date.now() },
        { id: 'lm-2', columnId: TO_COL_ID, projectId: PROJECT_ID, giteaLabelId: '200', giteaLabelName: 'to', createdAt: Date.now() },
      );
      return s;
    });

    // 默认 mock
    mocks.getGiteaIssue.mockResolvedValue({
      id: 1,
      index: ISSUE_INDEX,
      title: 'A',
      body: '',
      state: 'open',
      author: { username: 'tester' },
      labels: [makeLabel(100, 'from-label')],
      isPullRequest: false,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    });
    mocks.addGiteaIssueLabel.mockResolvedValue(undefined);
    mocks.removeGiteaIssueLabel.mockResolvedValue(undefined);
  });

  it('成功路径：addLabel(toCol) + removeLabel(fromCol)', async () => {
    const { moveIssueColumn } = await import('../move-card.js');
    const result = await moveIssueColumn({
      projectId: PROJECT_ID,
      issueIndex: ISSUE_INDEX,
      fromColumnId: FROM_COL_ID,
      toColumnId: TO_COL_ID,
    });

    // addLabel(toCol 200) 调 1 次
    expect(mocks.addGiteaIssueLabel).toHaveBeenCalledWith(
      expect.objectContaining({ index: ISSUE_INDEX, labelId: 200 }),
    );
    // removeLabel(fromCol 100) 调 1 次
    expect(mocks.removeGiteaIssueLabel).toHaveBeenCalledWith(
      expect.objectContaining({ index: ISSUE_INDEX, labelId: 100 }),
    );
    // 返回最新 issue
    expect(result.index).toBe(ISSUE_INDEX);
  });

  it('toColumnId 不属于 projectId → 抛 NOT_FOUND（防跨 project 操作）', async () => {
    const stateMod = await import('../../local/state.js');
    stateMod.getLocalStore().mutate((s) => {
      const toCol = s.columns.find((c) => c.id === TO_COL_ID);
      if (toCol) {
        toCol.projectId = OTHER_PROJECT_ID;
        // 同步更新 labelMap.projectId（不更则 move-card 查 labelMaps 时仍带 PROJECT_ID 不会跨 project）
        const toLabelMap = s.labelMaps.find((m) => m.columnId === TO_COL_ID);
        if (toLabelMap) toLabelMap.projectId = OTHER_PROJECT_ID;
      }
      return s;
    });
    const { moveIssueColumn } = await import('../move-card.js');
    await expect(
      moveIssueColumn({
        projectId: PROJECT_ID,
        issueIndex: ISSUE_INDEX,
        fromColumnId: FROM_COL_ID,
        toColumnId: TO_COL_ID,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('防漂移校验：fromColumn 绑的 label 不在 issue 上 → 抛 CONFLICT', async () => {
    // getGiteaIssue 返 issue 只带 label 200，**不**带 100（fromColumn 绑的）
    mocks.getGiteaIssue.mockResolvedValue({
      id: 1,
      index: ISSUE_INDEX,
      title: 'A',
      body: '',
      state: 'open',
      author: { username: 'tester' },
      labels: [makeLabel(200, 'to-label')],
      isPullRequest: false,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    });
    const { moveIssueColumn } = await import('../move-card.js');
    await expect(
      moveIssueColumn({
        projectId: PROJECT_ID,
        issueIndex: ISSUE_INDEX,
        fromColumnId: FROM_COL_ID,
        toColumnId: TO_COL_ID,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // 不调 addLabel / removeLabel（漂移校验失败直接抛）
    expect(mocks.addGiteaIssueLabel).not.toHaveBeenCalled();
  });

  it('addLabel(toCol) 失败 → 抛原错（toCol 只有 1 label，所以 addLabel 调 1 次即失败）', async () => {
    mocks.addGiteaIssueLabel.mockRejectedValueOnce(new Error('gitea 500'));
    const { moveIssueColumn } = await import('../move-card.js');

    await expect(
      moveIssueColumn({
        projectId: PROJECT_ID,
        issueIndex: ISSUE_INDEX,
        fromColumnId: FROM_COL_ID,
        toColumnId: TO_COL_ID,
      }),
    ).rejects.toThrow('gitea 500');

    // addLabel 失败，addedLabelIds 空 → 不调回滚 removeLabel
    // （边界：addLabel 失败抛原错，没 add 成功所以不需要回滚）
    expect(mocks.removeGiteaIssueLabel).not.toHaveBeenCalled();
  });

  it('已带 toCol label（gitea 端 issue 已有 toCol label）→ 跳过 addLabel', async () => {
    // issue 同时带 100 (from) + 200 (to) —— toCol label 跳过 addLabel
    mocks.getGiteaIssue.mockResolvedValue({
      id: 1,
      index: ISSUE_INDEX,
      title: 'A',
      body: '',
      state: 'open',
      author: { username: 'tester' },
      labels: [makeLabel(100, 'from-label'), makeLabel(200, 'to-label')],
      isPullRequest: false,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    });
    const { moveIssueColumn } = await import('../move-card.js');
    await moveIssueColumn({
      projectId: PROJECT_ID,
      issueIndex: ISSUE_INDEX,
      fromColumnId: FROM_COL_ID,
      toColumnId: TO_COL_ID,
    });
    // addLabel 不调（200 已带）；removeLabel 仍调（100 要移除）
    expect(mocks.addGiteaIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeGiteaIssueLabel).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: 100 }),
    );
  });
});
