/**
 * IPC 路由：preferences.*（v1.1.2 主题切换 —— theme-ipc 任务）
 *
 * 契约：design-system/pages/tech-refine.md §16.1-§16.3
 *       端点清单 + 错误码表都在本文件 docstring 里
 *
 * 端点（2 个）：
 * - preferences.theme.get → 读 sqlite prefs 表 key='theme'；未设过返默认 'A-dark'
 * - preferences.theme.set → upsert sqlite prefs 表 key='theme'，value=JSON.stringify(theme)
 *
 * 错误码（4 个，全是 plan_96625ed5 theme-ipc 拍板新增）：
 * - THEME_NOT_FOUND          → row 存在但 value 不可解析（JSON 烂 / 字段不在 enum 3 选 1）
 * - INVALID_THEME            → 防御：Zod enum 严格校验先 reject，业务层 direct caller 兜底用
 * - DATABASE_UNAVAILABLE     → getDb() 抛 "sqlite not initialized"
 * - DATABASE_WRITE_FAILED    → sqlite write 抛异常（disk full / db locked / constraint）
 *
 * 流程：wrapIpc(Zod parse) → 调业务函数（getTheme / setTheme） → 错误转 IpcError
 *
 * 边界（theme-ipc 任务 prompt §严格边界）：
 * - **不**改 schema / IpcErrorCode / IPC 端点清单（除了本文件命名空间内的 2 个）
 * - **不**碰 src/renderer/**
 * - **不**碰 src/preload/**（preload 端在 theme-preload task 改）
 * - **不**改 src/main/cache/schema/prefs.ts（表已存在，prefs.key='theme' 直接用）
 * - wrapIpc 模式与 user.ts / auth.ts / board.ts / commits.ts 等保持一致
 *
 * 与 user.ts 的关系（避免耦合）：
 * - 同样读 sqlite prefs 表，user.ts 用 LOCAL_USER_ID = 'local-user'
 * - preferences.ts 也用 LOCAL_USER_ID = 'local-user'（**不**从 user.ts import，避免循环依赖）
 * - 实际 v1 都是"单本地用户"简化 —— M6 多账号时统一提取到共享模块
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  ThemeEnumSchema,
  ThemeGetArgsSchema,
  ThemeSetArgsSchema,
  DEFAULT_THEME,
  type ThemeGetArgs,
  type ThemeGetResult,
  type ThemeSetArgs,
  type ThemeSetResult,
  type ThemeName,
} from './schema.js';
import { logger } from '../logger.js';
import { getDb } from '../cache/sqlite.js';
import { prefs } from '../cache/schema/index.js';

/** v1 简化：单本地用户（跟 user.ts:49 保持一致；M6 多账号时统一提取到共享模块） */
const LOCAL_USER_ID = 'local-user';

/** sqlite prefs 表里主题偏好的 key 名 —— 跟其他 user.* 偏好的 key 命名空间一致（用 'theme' 平铺） */
const THEME_PREF_KEY = 'theme';

/** 统一包装：parse 入参 → 调 handler → 错误转 IpcError
 *
 *  与 user.ts / auth.ts / board.ts / commits.ts 等保持一致 */
function wrapIpc<TArgs, TResult>(
  channel: string,
  schema: { parse: (raw: unknown) => TArgs },
  handler: (args: TArgs) => Promise<TResult> | TResult,
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
// ===== preferences.theme.get / set 业务函数 =====
// ============================================================

/**
 * 读主题偏好
 *
 * 行为分支：
 * 1. row 不存在（首次启动）→ 返 { theme: 'A-dark', changedAt: <now> } 默认值，**不**抛 NOT_FOUND
 * 2. row 存在 + JSON.parse 成功 + theme 字段在 enum 3 选 1 → 返 row 里的值
 * 3. row 存在 + JSON.parse 失败 / theme 字段不在 enum → 抛 THEME_NOT_FOUND
 *
 * 错误：
 * - DATABASE_UNAVAILABLE：getDb() 抛 "sqlite not initialized"（initSqlite() 没调过）
 * - THEME_NOT_FOUND：见上分支 3
 *
 * 注：db.select() / JSON.parse 抛的"非业务错"会被 wrapIpc 兜底成 INTERNAL（不静默）
 */
function getTheme(_args: ThemeGetArgs): ThemeGetResult {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    throw new IpcError({
      code: IpcErrorCode.DATABASE_UNAVAILABLE,
      message: '数据库未初始化',
      hint: '请重启应用；如反复出现请联系开发者',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const row = db
    .select({ value: prefs.value, updatedAt: prefs.updatedAt })
    .from(prefs)
    .where(and(eq(prefs.userId, LOCAL_USER_ID), eq(prefs.key, THEME_PREF_KEY)))
    .all()[0];

  // 分支 1：首次启动 / 用户从未切过主题 → 静默返默认（**不**抛 THEME_NOT_FOUND）
  if (!row) {
    logger.info(
      { userId: LOCAL_USER_ID, key: THEME_PREF_KEY },
      'theme pref not set, returning default',
    );
    return {
      theme: DEFAULT_THEME,
      changedAt: new Date().toISOString(),
    };
  }

  // 分支 2 + 3：row 存在 → 解析
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch (err) {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: '主题偏好值已损坏（JSON 不可解析）',
      hint: '请重新设置主题',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // 二次校验：parsed.theme 必须是 enum 3 选 1
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('theme' in parsed) ||
    typeof (parsed as { theme: unknown }).theme !== 'string'
  ) {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: '主题偏好值字段缺失或类型错',
      hint: '请重新设置主题',
    });
  }

  const candidate = (parsed as { theme: string }).theme;
  const enumResult = ThemeEnumSchema.safeParse(candidate);
  if (!enumResult.success) {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: `主题偏好值不合法：${candidate}`,
      hint: '请重新设置主题',
    });
  }

  return {
    theme: enumResult.data,
    changedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 写主题偏好（upsert 语义）
 *
 * 每次调用都覆盖 prefs.key='theme' 的 value（不是 patch —— v1 简化，避免 merge 复杂）
 *
 * 错误：
 * - DATABASE_UNAVAILABLE：getDb() 抛 "sqlite not initialized"
 * - DATABASE_WRITE_FAILED：db.transaction 内 update / insert 抛异常
 *
 * 注：INVALID_THEME 错误码在 contract 里列出但实际不可达（Zod enum 在 wrapIpc 入口先 reject）；
 *     保留此错误码供业务层 direct caller 做断言用（防御性）
 */
function setTheme(args: ThemeSetArgs): ThemeSetResult {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    throw new IpcError({
      code: IpcErrorCode.DATABASE_UNAVAILABLE,
      message: '数据库未初始化',
      hint: '请重启应用；如反复出现请联系开发者',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // 二次断言（Zod 在 wrapIpc 入口已校验，这里是"业务层 direct caller 路径"的防御）
  const enumResult = ThemeEnumSchema.safeParse(args.theme);
  if (!enumResult.success) {
    // 业务层 direct caller 路径：直接抛 INVALID_THEME（不走 VALIDATION_FAILED）
    throw new IpcError({
      code: IpcErrorCode.INVALID_THEME,
      message: `theme 必须是 3 选 1：'A-dark' | 'C-dark' | 'light'，收到 ${JSON.stringify(args.theme)}`,
      hint: '请传入合法主题',
    });
  }
  const theme = enumResult.data as ThemeName;

  const now = new Date();
  const jsonStr = JSON.stringify({ theme });

  try {
    db.transaction((tx) => {
      // upsert：先尝试 update
      const updated = tx
        .update(prefs)
        .set({ value: jsonStr, updatedAt: now })
        .where(and(eq(prefs.userId, LOCAL_USER_ID), eq(prefs.key, THEME_PREF_KEY)))
        .run();
      // update 没命中 → insert
      if (updated.changes === 0) {
        tx.insert(prefs)
          .values({
            id: randomUUID(),
            userId: LOCAL_USER_ID,
            key: THEME_PREF_KEY,
            value: jsonStr,
            updatedAt: now,
          })
          .run();
      }
    });
  } catch (err) {
    throw new IpcError({
      code: IpcErrorCode.DATABASE_WRITE_FAILED,
      message: '主题偏好保存失败',
      hint: '请稍后重试；如反复出现请检查磁盘空间',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    theme,
    changedAt: now.toISOString(),
  };
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerPreferencesIpc(): void {
  wrapIpc(IpcChannel.THEME_GET, ThemeGetArgsSchema, getTheme);
  wrapIpc(IpcChannel.THEME_SET, ThemeSetArgsSchema, setTheme);
}

export function unregisterPreferencesIpc(): void {
  ipcMain.removeHandler(IpcChannel.THEME_GET);
  ipcMain.removeHandler(IpcChannel.THEME_SET);
}

// 暴露业务函数供单测 / 集成测试直接调（不走 IPC）
export const _testHelpers = { getTheme, setTheme, LOCAL_USER_ID, THEME_PREF_KEY, DEFAULT_THEME };
