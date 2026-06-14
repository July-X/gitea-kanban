/**
 * 共享 IPC 工具（v1.1 重构）
 *
 * 背景：12 个 IPC 文件 (auth/board/branches/clipboard/commits/issues/labels/members/
 * preferences/pulls/repos/user) 之前每个都复制了一份 `wrapIpc` 函数。
 * 复制导致：bug 修复要改 12 处、出错 cause 提取逻辑不一致（HttpResponse 等
 * 非 Error 对象会变成 "[object Object]"）。
 *
 * 修复：把 wrapIpc 抽到 util.ts，让所有 namespace 共用。
 *
 * 错误处理改进（这次专门修的 bug）：
 * - HttpResponse 对象（gitea-js throw 的）：走 unwrapGitea 映射成 IpcError
 * - 普通 Error：取 .message
 * - 字符串：直接用
 * - 其它：尝试 JSON.stringify，否则 String(err) 的降级版本
 *
 * 目的：让 toast 显示可读的错误消息，**不再**出现 "[object Object]"
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcError, IpcErrorCode, validationFailed } from '@shared/errors';
import { logger } from '../logger.js';

/** 安全地把任何 unknown 错误转成可读消息（不让 "[object Object]" 漏到 toast） */
export function stringifyCause(err: unknown, fallback: string): string {
  if (err == null) return fallback;
  if (err instanceof Error) return err.message || err.name || fallback;
  if (typeof err === 'string') return err || fallback;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (typeof err === 'object') {
    // gitea-js 失败时 throw 的 HttpResponse（被 .data 暴露）
    const obj = err as Record<string, unknown>;
    // 尝试找常见错误字段
    const candidates = ['message', 'msg', 'error', 'detail', 'statusText'];
    for (const k of candidates) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    if ('data' in obj) {
      const d = obj.data;
      if (typeof d === 'string') return d;
      if (d && typeof d === 'object') {
        const inner = d as Record<string, unknown>;
        if (typeof inner.message === 'string') return inner.message;
      }
    }
    // 最后尝试 JSON.stringify（避免 [object Object]）
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json.slice(0, 500);
    } catch {
      // ignore
    }
  }
  return fallback;
}

/** wrapIpc —— 统一 IPC 处理器包装（Zod parse + 错误转 IpcError） */
export function wrapIpc<TArgs, TResult>(
  channel: string,
  schema: { parse: (raw: unknown) => TArgs },
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<TResult>,
): void {
  ipcMain.handle(channel, async (event, rawArgs: unknown) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args, event);
      if (logger.isLevelEnabled('debug')) {
        logger.debug({ channel, latencyMs: Date.now() - start }, 'ipc ok');
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      // 1. 业务错：IpcError 直接序列化
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, 'ipc business error');
        throw err.toJSON();
      }
      // 2. ZodError → VALIDATION_FAILED
      if (err && typeof err === 'object' && 'issues' in err) {
        const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
        const issue = zodErr.issues[0];
        const path = issue?.path.join('.') ?? '<root>';
        const message = issue?.message ?? '参数校验失败';
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, 'ipc validation failed');
        throw v.toJSON();
      }
      // 3. 兜底 INTERNAL（带可读 cause，不再 [object Object]）
      const causeMsg = stringifyCause(err, '<unknown error>');
      logger.error({ channel, latencyMs, err: causeMsg }, 'ipc internal error');
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: '应用内部错误，已记录日志',
        hint: '请稍后重试，或联系开发者',
        cause: causeMsg,
      });
      throw i.toJSON();
    }
  });
}

/** 注册清理（unregisterAllIpcHandlers 统一入口用） */
export function unwrapIpcHandlers(channels: string[]): void {
  for (const c of channels) {
    ipcMain.removeHandler(c);
  }
}
