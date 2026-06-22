/**
 * IPC 路由：preferences.clipboard.write（v1.1.3 提交号 / 分支名复制）
 *
 * 设计：走主进程 electron.clipboard.writeText，绕过 renderer 端
 * navigator.clipboard.writeText 在 Electron 窗口无 focus / 非用户激活时
 * promise reject 的不稳定行为（v1.1.2 主题切换已踩过；详见 task #20）。
 *
 * 端点（1 个）：
 * - preferences.clipboard.write({ text }) → 写系统剪贴板，返 { ok: true }
 *
 * 错误（1 个，由 wrapIpc 兜底）：
 * - INTERNAL：clipboard.writeText 抛异常（理论上不可达；兜底）
 *
 * 边界（task #20 拍板）：
 * - **不**暴露 clipboard.read / clipboard.clear（v1 单向写即可；read 等价于把 token 读出来，攻击面大）
 * - **不**做 debounce / 批量写入（v1 调用频率极低；用户点击一次 = 一次 IPC）
 * - **不**做敏感内容过滤（v1 复制内容全由 UI 控制：分支名 / sha / commit message；不复制 token）
 *
 * 与 user.ts / preferences.ts 关系：
 * - 沿用相同 wrapIpc 模式（parse + handler + IpcError 转换）
 * - 无 sqlite 读写（纯旁路 IPC → electron 模块 → 系统剪贴板）
 */
import { clipboard, ipcMain } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import { IpcChannel } from './schema.js';
import {
  ClipboardWriteArgsSchema,
  type ClipboardWriteArgs,
  type ClipboardWriteResult,
} from './schema.js';
import { logger } from '../logger.js';

/** 统一包装：parse 入参 → 调 handler → 错误转 IpcError
 *
 *  与 auth.ts / preferences.ts / user.ts 保持一致 */
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
        // Zod 校验失败 —— clipboard.write 入参几乎不会触发（schema 仅 1 字段），
        // 但 wrapIpc 统一兜底成 VALIDATION_FAILED 跟其他 handler 一致
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

/** 写系统剪贴板 */
function writeClipboard(args: ClipboardWriteArgs): ClipboardWriteResult {
  // electron.clipboard.writeText 内部用 native API，理论上不会抛；
  // wrapIpc 兜底成 INTERNAL 是为极端环境（无 display server / permissions 缺失）。
  clipboard.writeText(args.text);
  return { ok: true };
}

export function registerClipboardIpc(): void {
  wrapIpc(IpcChannel.CLIPBOARD_WRITE, ClipboardWriteArgsSchema, writeClipboard);
}

export function unregisterClipboardIpc(): void {
  ipcMain.removeHandler(IpcChannel.CLIPBOARD_WRITE);
}
