/**
 * IPC 路由：user.* 4 个 endpoint
 *
 * 契约：02-architecture.md §5.3.9
 *
 * 端点：
 * - user.prefs.get  → 读 prefs 表（按 userId + keys 过滤）
 * - user.prefs.set  → upsert prefs 表（JSON.stringify value）
 * - user.undo       → pop undo_entries 表最新一条（M5 简化：栈空，返 restored=0）
 * - user.redo       → 同 undo（M5 简化：栈空，返 restored=0）
 *
 * 流程：wrapIpc(Zod parse) → 调业务函数 → 错误转 IpcError
 *
 * 边界（M5 拍板）：
 * - **不**改 schema / IpcErrorCode / IPC 端点清单
 * - **不**碰 src/renderer/**
 * - **不**触发 gitea HTTP（user prefs 是本地）
 * - M5 简化：单本地用户（userId = 'local-user'）；未连 gitea 也能写 prefs
 * - M5 简化：undo / redo 走"空栈 version"（restored=0）；M6 接业务时再实现真栈
 *
 * 与 §8.8 教训对齐：M5 阶段不擅自引入"按 gitea_account_id 切 prefs"或"实现 undo 栈"等新设计；
 * 等 M6 有具体业务接入需求 + 用户拍板后再扩展。
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import {
  IpcChannel,
  UserPrefsGetArgsSchema,
  UserPrefsSetArgsSchema,
  type UserPrefsGetArgs,
  type UserPrefsGetResult,
  type UserPrefsSetArgs,
  type UserUndoResult,
  type UserRedoResult,
} from './schema.js';
import { z } from 'zod';

/** user.undo / user.redo 无入参，但走 wrapIpc 统一处理时需要一个 schema
 *  拍板 = 02 §5.3.9 签名：`() => Promise<{ restored: number }>`，无 args */
const EmptyArgsSchema = z.object({}).strict();
import { logger } from '../logger.js';
import { getDb } from '../cache/sqlite.js';
import { prefs, undoEntries } from '../cache/schema/index.js';

/** M5 简化：单本地用户（M1 多账号时按 giteaAccountId 切分） */
const LOCAL_USER_ID = 'local-user';

/** 统一包装：parse 入参 → 调 handler → 错误转 IpcError
 *
 *  与 auth.ts / board.ts / commits.ts 等保持一致 */
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
// ===== prefs.get / prefs.set 业务函数 =====
// ============================================================

/**
 * 读 prefs
 *
 * 命中：JSON.parse(value)
 * 未命中：跳过（调用方拿到 Record 时不会包含这个 key——和 02 §5.3.9 一致）
 *
 * 不抛 NOT_FOUND：未设置 ≠ 不存在；UI 层默认空即可。
 */
function getPrefs(args: UserPrefsGetArgs): UserPrefsGetResult {
  const db = getDb();
  const rows = db
    .select({ key: prefs.key, value: prefs.value })
    .from(prefs)
    .where(and(eq(prefs.userId, LOCAL_USER_ID), inArray(prefs.key, args.keys)))
    .all();

  const result: UserPrefsGetResult = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      // 烂数据：跳过这一条（不影响其他 key）
      logger.warn(
        { key: row.key, userId: LOCAL_USER_ID },
        'prefs row has invalid JSON value; skipping',
      );
    }
  }
  return result;
}

/**
 * 写 prefs（upsert 语义）
 *
 * 每次调用清空 caller 传的 keys 然后 insert 全量新值——简单粗暴但 v1 OK。
 * 若 caller 只想改部分 key，应把已有 keys 先 get 再 set。
 */
function setPrefs(args: UserPrefsSetArgs): void {
  const db = getDb();
  const entries = Object.entries(args.entries);
  if (entries.length === 0) {
    // 空 entries = 空操作（不抛错；调用方可能用来 ping）
    return;
  }

  const now = new Date();
  db.transaction((tx) => {
    for (const [key, value] of entries) {
      const jsonStr = JSON.stringify(value);
      // upsert: 先尝试 update，再判断是否需要 insert
      const updated = tx
        .update(prefs)
        .set({ value: jsonStr, updatedAt: now })
        .where(and(eq(prefs.userId, LOCAL_USER_ID), eq(prefs.key, key)))
        .run();
      if (updated.changes === 0) {
        tx.insert(prefs)
          .values({
            id: randomUUID(),
            userId: LOCAL_USER_ID,
            key,
            value: jsonStr,
            updatedAt: now,
          })
          .run();
      }
    }
  });
}

// ============================================================
// ===== undo / redo 业务函数（M5 简化：空栈 version） =====
// ============================================================

/**
 * undo —— M5 简化版
 *
 * undo_entries 表存在（schema/undoEntries.ts），但**当前没有业务调用方**往里 push（M5 阶段
 * issues.move / board.columns.* 等都不接栈——M6 接业务时再实现真栈）。
 *
 * 当前行为：直接返 `{ restored: 0 }`，不读 undo_entries 表
 * （避免渲染端误以为真实现了撤销，把 UI 行为错误归因到本端点）。
 *
 * 未来扩展点（M6+）：
 * - pop undo_entries 按 createdAt DESC LIMIT 1
 * - 按 op 字段路由到对应恢复函数（card.move → reverse move）
 * - 同步 push 一条 redo_entries（或用 status 字段区分 undo/redo 栈）
 */
function undo(): UserUndoResult {
  // M5 简化：不读表（业务调用方未实现 push），不删 row
  // 返 restored=0 让 UI 显示"已撤销 0 项"是事实陈述而非错误
  return { restored: 0 };
}

/**
 * redo —— 同 undo（空栈 version）
 */
function redo(): UserRedoResult {
  return { restored: 0 };
}

// ============================================================
// ===== 注册 =====
// ============================================================

export function registerUserIpc(): void {
  wrapIpc(IpcChannel.USER_PREFS_GET, UserPrefsGetArgsSchema, getPrefs);
  wrapIpc(IpcChannel.USER_PREFS_SET, UserPrefsSetArgsSchema, setPrefs);
  wrapIpc(IpcChannel.USER_UNDO, EmptyArgsSchema, () => undo());
  wrapIpc(IpcChannel.USER_REDO, EmptyArgsSchema, () => redo());
}

export function unregisterUserIpc(): void {
  ipcMain.removeHandler(IpcChannel.USER_PREFS_GET);
  ipcMain.removeHandler(IpcChannel.USER_PREFS_SET);
  ipcMain.removeHandler(IpcChannel.USER_UNDO);
  ipcMain.removeHandler(IpcChannel.USER_REDO);
}

// 暴露业务函数供单测 / 集成测试直接调（不走 IPC）
export const _testHelpers = { getPrefs, setPrefs, undo, redo, LOCAL_USER_ID };
// 引用 undoEntries 抑制 unused 警告（M5 阶段业务侧未实际 push，但保留 schema）
void undoEntries;
