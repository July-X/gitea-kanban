/**
 * IPC 路由：auth.* 三个 endpoint
 *
 * 契约：02-architecture.md §5.3.9 + ADR-0001 §"需更新的下游文件"
 *
 * 铁律（AGENTS.md §8.2 / §8.3 鉴权铁律）：
 * - token 永远不离开主进程内存
 * - auth.connect 是**唯一**接收 token 的 IPC 入口
 * - auth.status / auth.disconnect 出参**不**含 token
 * - keychain 失败时抛 KEYCHAIN_UNAVAILABLE / KEYCHAIN_ACCESS_DENIED
 *
 * 本文件只做：入参 Zod 校验 + 调 gitea/auth.ts + 返回结果
 * 实际鉴权逻辑（gitea HTTP / keychain IO）都在 main/gitea/auth.ts
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { logger } from '../logger.js';
import { IpcError, IpcErrorCode, isIpcError, validationFailed } from '@shared/errors';
import {
  ConnectArgsSchema,
  DisconnectArgsSchema,
  IpcChannel,
  type ConnectResult,
  type DisconnectArgs,
  type StatusResult,
} from './schema.js';
import { installCspHeader } from '../window.js';
import { dispatch, registerOp } from '../sync/dispatch.js';
import {
  authConnect as _authConnect,
  authDisconnect as _authDisconnect,
  authStatus,
} from '../gitea/auth.js';
import { type ConnectArgs } from './schema.js';

/**
 * 同步：把 gitea/auth.ts 业务函数包成 OpHandler 注册到 dispatch
 *
 * 关键：registerOp 必须在 registerAllIpcHandlers 调之前（否则 dispatch 抛 OP_NOT_REGISTERED）
 * —— index.ts 的启动顺序保证：先 registerAllIpcHandlers 内调 registerAuthIpc，
 *    而 registerAuthIpc 内部 registerOp → 然后 IPC handler 调 dispatch
 *
 * ADR-0003 Phase 3 离线语义：
 * - auth.connect / auth.disconnect **不**实现 offlineApply —— 离线时 dispatch 抛 NETWORK_OFFLINE
 * - 简化版保守：gitea 写 op 都不离线写（用户 UI 应禁用按钮 + 提示"网络不可用"）
 *   离线写策略：纯本地 op（board.column.* / setStarred / prefs.set）支持离线（见 Commit C4）
 */

/**
 * 统一包装：parse 入参 → 调 handler → 错误转 IpcError
 *
 * 任何 IPC handler 出错都 throw IpcError，让 preload 桥统一转 reject。
 */
function wrapIpc<TArgs, TResult>(
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
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, 'ipc business error');
        throw err.toJSON();
      }
      // ZodError → VALIDATION_FAILED
      if (err && typeof err === 'object' && 'issues' in err) {
        const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
        const issue = zodErr.issues[0];
        const path = issue?.path.join('.') ?? '<root>';
        const message = issue?.message ?? '参数校验失败';
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, 'ipc validation failed');
        throw v.toJSON();
      }
      // 兜底 INTERNAL
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

// ===== 注册 =====

export function registerAuthIpc(): void {
  // ADR-0003 Phase 3：注册 op 到 dispatch 中心
  //   execute = 业务函数（authConnect / authDisconnect）
  //   不实现 offlineApply → dispatch 离线时抛 NETWORK_OFFLINE（不静默离线写）
  registerOp<ConnectArgs, ConnectResult>('auth.connect', {
    execute: _authConnect,
  });
  registerOp<{ giteaUrl: string }, void>('auth.disconnect', {
    execute: _authDisconnect,
  });

  wrapIpc(IpcChannel.AUTH_CONNECT, ConnectArgsSchema, async (args) => {
    // ADR-0003 Phase 3：auth.connect 走 dispatch
    //   execute = authConnect（必 verifyToken + persistToken + 写 localStore）
    //   **不**实现 offlineApply —— 离线时 verifyToken 失败直接抛 NETWORK_OFFLINE
    //   渲染端收到错应提示"网络不可用，重试"
    const { mode, result } = await dispatch<ConnectArgs, ConnectResult>('auth.connect', args);
    if (mode === 'online') {
      // auth.connect 成功后立刻按 giteaUrl 重装 CSP（AGENTS.md §4.7 + §8.2）
      //   之前 createMainWindow 时 installCspHeader(null) → img-src 'self' data: https:
      //   没 gitea URL → http://127.0.0.1:3000 头像被拦
      // 重装后 img-src 含 giteaUrl（gitea 本地服务）+ connect-src 含 giteaUrl（备用直连）
      installCspHeader(result.account.giteaUrl);
    }
    // offline 模式不重装 CSP（verifyToken 失败时 giteaUrl 不可信；等 sync 后用户重试）
    return result satisfies ConnectResult;
  });

  wrapIpc(IpcChannel.AUTH_DISCONNECT, DisconnectArgsSchema, async (args: DisconnectArgs) => {
    // ADR-0003 Phase 3：auth.disconnect 走 dispatch
    //   execute = authDisconnect（清 keychain + 删 localStore.accounts）
    //   **不**实现 offlineApply —— 简化版保守走 execute 失败重抛
    await dispatch('auth.disconnect', args);
    // disconnect 后按 giteaUrl 重装 CSP（清掉已 disconnect 账号的 giteaUrl 白名单）
    installCspHeader(args.giteaUrl);
    return undefined;
  });

  // auth.status 没有入参 + 纯读 localStore —— 不走 dispatch
  ipcMain.handle(IpcChannel.AUTH_STATUS, async (): Promise<StatusResult> => {
    return authStatus();
  });
}

export function unregisterAuthIpc(): void {
  ipcMain.removeHandler(IpcChannel.AUTH_CONNECT);
  ipcMain.removeHandler(IpcChannel.AUTH_DISCONNECT);
  ipcMain.removeHandler(IpcChannel.AUTH_STATUS);
}

// 导出供测试用：parseAndWrap 让单测能模拟 IPC 路径
export const _testHelpers = { isIpcError };
