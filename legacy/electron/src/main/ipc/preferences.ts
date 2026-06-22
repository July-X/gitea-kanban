/**
 * IPC 路由：preferences.theme.* 2 个 endpoint（preferences.clipboard 已合并到 clipboard.ts）
 *
 * 契约：02-architecture.md §5.3.6 + ADR-0003 Phase 3
 *
 * 端点（2 个）：
 * - preferences.theme.get → 读 localStore.prefs[THEME_PREF_KEY]
 * - preferences.theme.set → 写 localStore.prefs[THEME_PREF_KEY]
 *
 * 注：preferences.clipboard.set **不**在本文件 —— 那是 clipboard 命名空间，参见 ipc/clipboard.ts
 *
 * ADR-0003 Phase 3：prefs 走 localStore（**完全删** SQLite prefs 表）
 *
 * 边界（任务 prompt §严格边界）：
 * - **不**改 schema / IpcErrorCode / IPC 端点清单
 * - **不**碰 src/renderer/**
 * - wrapIpc 模式与其它 IPC handler 保持一致
 */

import { ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ThemeGetArgsSchema,
  ThemeSetArgsSchema,
  ThemeEnumSchema,
  type ThemeGetArgs,
  type ThemeSetArgs,
  type ThemeGetResult,
  type ThemeSetResult,
  type ThemeName,
} from './schema.js';
import { logger } from '../logger.js';
import { getLocalStore } from '../local/state.js';
import { dispatch, registerOp } from '../sync/dispatch.js';

const THEME_PREF_KEY = 'theme';
const DEFAULT_THEME: ThemeName = 'dark';

/** 统一包装：parse 入参 → 调 handler → 错误转 IpcError */
function wrapIpc<TArgs, TResult>(
  channel: string,
  schema: { parse: (raw: unknown) => TArgs },
  handler: (args: TArgs) => Promise<TResult>,
): void {
  ipcMain.handle(channel, async (_event, rawArgs: unknown) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled('debug')) {
        logger.debug({ channel, latencyMs: Date.now() - start }, 'ipc ok');
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, 'ipc business error');
        throw err.toJSON();
      }
      if (err && typeof err === 'object' && 'issues' in err) {
        const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
        const issue = zodErr.issues[0];
        const path = issue?.path.join('.') ?? '<root>';
        const message = issue?.message ?? '参数校验失败';
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, 'ipc validation failed');
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, 'ipc internal error');
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: '应用内部错误，已记录日志',
        hint: '请稍后重试，或联系开发者',
        cause: err instanceof Error ? err.message : String(err),
      });
      throw i.toJSON();
    }
  });
}

// ============================================================
// ===== handler =====
// ============================================================

/**
 * 读主题偏好
 *
 * 行为：
 * 1. localStore.prefs[THEME_PREF_KEY] 不存在 → 静默返 DEFAULT_THEME
 *    （首次启动 / 用户从未切过主题 —— **不**抛 THEME_NOT_FOUND）
 * 2. row 存在 + JSON.parse 成功 + theme 字段在 enum 2 选 1 → 返 row 里的值
 * 3. row 存在 + JSON.parse 失败 / theme 字段不在 enum → 抛 THEME_NOT_FOUND
 *
 * ADR-0003 Phase 3：走 localStore
 */
function getTheme(_args: ThemeGetArgs): ThemeGetResult {
  const state = getLocalStore().get();
  const stored = state.prefs[THEME_PREF_KEY];

  if (stored === undefined) {
    logger.info({ key: THEME_PREF_KEY }, 'theme pref not set, returning default');
    return {
      theme: DEFAULT_THEME,
      changedAt: new Date().toISOString(),
    };
  }

  // 二次校验：stored.theme 必须是 enum 2 选 1
  if (
    !stored ||
    typeof stored !== 'object' ||
    !('theme' in stored) ||
    typeof (stored as { theme: unknown }).theme !== 'string'
  ) {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: '主题偏好值字段缺失或类型错',
      hint: '请重新设置主题',
    });
  }

  const candidate = (stored as { theme: string }).theme;
  const enumResult = ThemeEnumSchema.safeParse(candidate);
  if (!enumResult.success) {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: `主题偏好值不合法：${candidate}`,
      hint: '请重新设置主题',
    });
  }

  return {
    theme: enumResult.data as ThemeName,
    // Phase 3 已删 updatedAt 字段（prefs 简化成 unknown JSON value）
    // 给前端一个 ISO 时间戳兜底（用 file mtime 太重；用 localStore schemaVersion 也不准）
    changedAt: new Date().toISOString(),
  };
}

/**
 * 写主题偏好（**纯 localStore**，ADR-0003 Phase 3 删 SQLite 写）
 *
 * 每次调用都覆盖 prefs.key='theme' 的 value（不是 patch —— v1 简化）
 */
function setTheme(args: ThemeSetArgs): ThemeSetResult {
  // 二次断言（Zod 在 wrapIpc 入口已校验，这里是"业务层 direct caller 路径"的防御）
  const enumResult = ThemeEnumSchema.safeParse(args.theme);
  if (!enumResult.success) {
    throw new IpcError({
      code: IpcErrorCode.INVALID_THEME,
      message: `theme 必须是 2 选 1：'dark' | 'light'，收到 ${JSON.stringify(args.theme)}`,
      hint: '请传入合法主题',
    });
  }
  const theme = enumResult.data as ThemeName;
  const now = new Date().toISOString();

  // 走 dispatch（纯本地 op，IPC 永远 mode: 'online'）
  void dispatch('preferences.theme.set', { theme });

  return {
    theme,
    changedAt: now,
  };
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerPreferencesIpc(): void {
  // ADR-0003 Phase 3：注册 op（纯本地）
  registerOp<{ theme: ThemeName }, void>('preferences.theme.set', {
    execute: ({ theme }) => {
      const store = getLocalStore();
      store.mutate((s) => {
        s.prefs = { ...s.prefs, [THEME_PREF_KEY]: { theme } };
      });
    },
  });

  wrapIpc(IpcChannel.THEME_GET, ThemeGetArgsSchema, async (args) => getTheme(args));
  wrapIpc(IpcChannel.THEME_SET, ThemeSetArgsSchema, async (args) => setTheme(args));
}

export function unregisterPreferencesIpc(): void {
  ipcMain.removeHandler(IpcChannel.THEME_GET);
  ipcMain.removeHandler(IpcChannel.THEME_SET);
}

// 暴露业务函数供单测 / 集成测试直接调（不走 IPC）
export const _testHelpers = { getTheme, setTheme, THEME_PREF_KEY, DEFAULT_THEME };
