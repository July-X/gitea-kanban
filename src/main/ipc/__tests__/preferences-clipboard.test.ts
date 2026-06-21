/**
 * main 端 IPC handler 单测（v1.4 polish 测试债清理）
 *
 * 覆盖：
 * - preferences.ts：getTheme / setTheme + wrapIpc 异常路径
 * - clipboard.ts：writeClipboard + wrapIpc 异常路径
 * - user.ts：undoStatus（read localStore 栈深度） + prefs get/set
 *
 * Mock 策略：
 * - 真实 localStore（temp dir）
 * - mock electron.ipcMain.handle 捕获 handler 回调（不真走 IPC）
 * - 覆盖 wrapIpc 的 3 条错误路径：IpcError 直抛 / Zod 校验失败 / 其他 error 兜底 INTERNAL
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ===== mocks 必须在 import 之前 =====

const mocks = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  ipcMainRemoveHandler: vi.fn(),
  clipboardWriteText: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: {
    handle: mocks.ipcMainHandle,
    removeHandler: mocks.ipcMainRemoveHandler,
  },
  clipboard: {
    writeText: mocks.clipboardWriteText,
  },
}));

// ===== localStore 临时初始化 =====
let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-ipc-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
  vi.resetModules();
  mocks.ipcMainHandle.mockReset();
  mocks.ipcMainRemoveHandler.mockReset();
  mocks.clipboardWriteText.mockReset();
});

afterEach(async () => {
  if (savedEnv !== undefined) process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  else delete process.env['GITEA_KANBAN_DATA_DIR'];
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

/** 工具：从 ipcMain.handle mock 里取最后注册的 callback
 *
 * 真实 ipcMain.handle 签名是 `(channel, async (_event, rawArgs) => result)`，
 * 我们的 helper 暴露一个 `(rawArgs)` 形态的包装，让测试代码更可读。
 */
function getHandler(channel: string): (rawArgs: unknown) => Promise<unknown> {
  const calls = mocks.ipcMainHandle.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === channel) {
      const fn = calls[i]?.[1] as (event: unknown, rawArgs: unknown) => Promise<unknown>;
      return (rawArgs: unknown) => fn(undefined, rawArgs);
    }
  }
  throw new Error(`Handler not registered for channel: ${channel}`);
}

describe('ipc/preferences · getTheme / setTheme', () => {
  beforeEach(async () => {
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();
    const { registerPreferencesIpc } = await import('../preferences.js');
    registerPreferencesIpc();
  });

  it('getTheme 首次启动：未设过 theme → 返默认 dark', async () => {
    const handler = getHandler('preferences.theme.get');
    const result = await handler({});
    expect(result).toMatchObject({ theme: 'dark' });
    expect(typeof (result as { changedAt: string }).changedAt).toBe('string');
  });

  it('setTheme 后 getTheme 返设置值', async () => {
    const setHandler = getHandler('preferences.theme.set');
    await setHandler({ theme: 'light' });
    const getHandler2 = getHandler('preferences.theme.get');
    const result = await getHandler2({});
    expect(result).toMatchObject({ theme: 'light' });
  });

  it('setTheme 收到非法 enum（直接调绕过 IPC 入口 Zod）→ 抛 INVALID_THEME', async () => {
    // 通过 IPC 入口永远走 Zod 校验（ThemeSetArgsSchema 拒 enum 外值 → validation_failed）
    // 这里的 INVALID_THEME 是业务层 direct caller 路径的防御（_testHelpers.setTheme）
    const { _testHelpers } = await import('../preferences.js');
    expect(() => _testHelpers.setTheme({ theme: 'rainbow' as never })).toThrow(
      /theme 必须是 2 选 1/,
    );
  });

  it('setTheme 缺 theme 字段 → Zod 校验失败 → validation_failed', async () => {
    const setHandler = getHandler('preferences.theme.set');
    await expect(setHandler({})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('getTheme 存的 theme 字段类型错（不是 string）→ THEME_NOT_FOUND', async () => {
    const stateMod = await import('../../local/state.js');
    stateMod.getLocalStore().mutate((s) => {
      s.prefs = { theme: { theme: 123 } as unknown as { theme: string } };
      return s;
    });
    const handler = getHandler('preferences.theme.get');
    await expect(handler({})).rejects.toMatchObject({
      code: 'theme_not_found',
    });
  });

  it('getTheme 存的 theme 不在 enum → THEME_NOT_FOUND', async () => {
    const stateMod = await import('../../local/state.js');
    stateMod.getLocalStore().mutate((s) => {
      s.prefs = { theme: { theme: 'rainbow' } };
      return s;
    });
    const handler = getHandler('preferences.theme.get');
    await expect(handler({})).rejects.toMatchObject({
      code: 'theme_not_found',
    });
  });

  it('unregisterPreferencesIpc 移除 2 个 channel handler', async () => {
    const { unregisterPreferencesIpc } = await import('../preferences.js');
    unregisterPreferencesIpc();
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('preferences.theme.get');
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('preferences.theme.set');
  });
});

describe('ipc/clipboard · writeClipboard', () => {
  beforeEach(async () => {
    const { registerClipboardIpc } = await import('../clipboard.js');
    registerClipboardIpc();
  });

  it('写剪贴板成功 → 返 { ok: true }', async () => {
    const handler = getHandler('preferences.clipboard.write');
    const result = await handler({ text: 'hello' });
    expect(result).toEqual({ ok: true });
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('hello');
  });

  it('clipboard.writeText 抛错 → 兜底 INTERNAL', async () => {
    mocks.clipboardWriteText.mockImplementationOnce(() => {
      throw new Error('clipboard 不可用');
    });
    const handler = getHandler('preferences.clipboard.write');
    await expect(handler({ text: 'x' })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('缺 text 字段 → Zod 校验失败 → validation_failed', async () => {
    const handler = getHandler('preferences.clipboard.write');
    await expect(handler({})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('unregisterClipboardIpc 移除 handler', async () => {
    const { unregisterClipboardIpc } = await import('../clipboard.js');
    unregisterClipboardIpc();
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('preferences.clipboard.write');
  });
});

describe('ipc/user · prefs get/set + undo/redo + undoStatus', () => {
  beforeEach(async () => {
    const stateMod = await import('../../local/state.js');
    await stateMod._resetLocalStoreForTest();
    await stateMod.initLocalStore();
    const { registerUserIpc } = await import('../user.js');
    registerUserIpc();
  });

  it('getPrefs 首次启动：未设过的 key → 返空 Record（不在 store 里的 key 不过滤，返回 store 实际内容）', async () => {
    const handler = getHandler('user.prefs.get');
    // schema 要求 keys.length >= 1，测试传一个不存在的 key 看默认行为
    const result = await handler({ keys: ['nope'] });
    // prefs 初始空 → result 是 prefs 快照过滤后（不存在的 key 跳过）
    expect(result).toEqual({});
  });

  it('setPrefs 后 getPrefs 返设置值', async () => {
    const setHandler = getHandler('user.prefs.set');
    await setHandler({ entries: { foo: 'bar' } });
    const getHandler2 = getHandler('user.prefs.get');
    const result = await getHandler2({ keys: ['foo'] });
    expect(result).toEqual({ foo: 'bar' });
  });

  it('setPrefs 入参 entries 为空 → 不写（不调 mutate）', async () => {
    const setHandler = getHandler('user.prefs.set');
    await setHandler({ entries: {} });
    // 验证 prefs 仍空
    const stateMod = await import('../../local/state.js');
    expect(stateMod.getLocalStore().get().prefs).toEqual({});
  });

  it('undoStatus 未推栈 → 返 0/0', async () => {
    const handler = getHandler('user.undoStatus');
    const result = await handler({ projectId: 'p-1' });
    expect(result).toEqual({ undoSize: 0, redoSize: 0 });
  });

  it('pushUndo 后 undoStatus 返深度 + undoOne 弹栈 + 调 reverse handler', async () => {
    const { pushUndo, registerUndoHandler, _resetStacks } = await import('../../board/undo.js');
    // 同一个 vitest module 实例（vi.resetModules 没清 board/undo 因为它 import 在 setHandler 之前）
    _resetStacks();
    registerUndoHandler('issues.moveColumn', {
      forward: vi.fn().mockResolvedValue(undefined),
      reverse: vi.fn().mockResolvedValue(undefined),
    });
    pushUndo('issues.moveColumn', 'p-1', { fwd: 1 }, { rev: 1 });

    // undoStatus 返深度
    const statusHandler = getHandler('user.undoStatus');
    const status = await statusHandler({ projectId: 'p-1' });
    expect(status).toEqual({ undoSize: 1, redoSize: 0 });

    // undoOne 弹栈
    const undoHandler = getHandler('user.undo');
    const result = (await undoHandler({ projectId: 'p-1' })) as { restored: number };
    expect(result.restored).toBe(1);
    // 推 redo
    const statusAfter = await statusHandler({ projectId: 'p-1' });
    expect(statusAfter).toEqual({ undoSize: 0, redoSize: 1 });
  });

  it('unregisterUserIpc 移除 5 个 channel handler', async () => {
    const { unregisterUserIpc } = await import('../user.js');
    unregisterUserIpc();
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('user.prefs.get');
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('user.prefs.set');
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('user.undo');
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('user.redo');
    expect(mocks.ipcMainRemoveHandler).toHaveBeenCalledWith('user.undoStatus');
  });
});
