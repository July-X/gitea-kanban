/**
 * dispatch —— 写 op 的统一入口
 *
 * ADR-0003 Phase 3 设计：
 * - 所有"写" IPC handler 改调 dispatch(op, args) 而不是直接调业务函数
 * - dispatch 根据"在线/离线"决定走 execute 还是 offlineApply + enqueue
 * - **网络错误驱动**：不预探测（gitea 客户端捕 NETWORK_OFFLINE 自动 fallback）
 * - **不**支持离线的 op：不实现 offlineApply → dispatch 抛 OFFLINE_WRITE_UNAVAILABLE
 *
 * OpHandler 接口：
 *   - execute(args)：永远执行（调 gitea + 改 localStore），返业务结果
 *   - offlineApply?(args)：**仅**改 localStore + 返预测结果；缺省 = 调 execute（纯本地 op）
 *
 * 错误处理：
 * - op 未注册 → 抛 OP_NOT_REGISTERED（内部错误，IPC 不该走到这）
 * - gitea 客户端抛 NETWORK_OFFLINE → 走 offlineApply（如有）否则重抛
 * - gitea 客户端抛其他错（CONFLICT / VALIDATION_FAILED / INTERNAL）→ 重抛
 *   （写 op 业务错误必须告诉用户，**不**能离线降级）
 *
 * 边界（Phase 3）：
 * - **不**支持 multi-op 事务
 * - **不**支持 undo/redo 走队列（undo 栈仍 in-memory，Phase 3 不切）
 * - **不**支持离线 op 的 rollback（failed entry 留给用户手动处理）
 */

import { IpcError, IpcErrorCode } from '@shared/errors';
import { pino } from 'pino';

/**
 * 内部独立 pino 实例（同 queue.ts 原因）
 */
const log = pino({ name: 'sync-dispatch', level: process.env['LOG_LEVEL'] ?? 'info' });
import { enqueueEntry, type QueueEntry } from './queue.js';

/**
 * OpHandler：每个写 op 在注册时给一对执行入口
 *
 * execute 可以是 sync 或 async 函（dispatch 内部会包成 Promise）
 */
export interface OpHandler<TArgs, TResult> {
  /** 永远执行：调 gitea（如果需要）+ 改 localStore + 返结果。sync / async 都行。 */
  execute(args: TArgs): TResult | Promise<TResult>;
  /**
   * 离线预应用：仅改 localStore + 返预测结果
   * 缺省：调 execute（纯本地 op 不实现这个）
   * 不可离线写：不实现 + dispatch 返 OFFLINE_WRITE_UNAVAILABLE
   */
  offlineApply?(args: TArgs): TResult | Promise<TResult>;
}

const registry = new Map<string, OpHandler<unknown, unknown>>();

/**
 * 注册 op（业务层启动时调）
 */
export function registerOp<TArgs, TResult>(op: string, handler: OpHandler<TArgs, TResult>): void {
  if (registry.has(op)) {
    log.warn({ op }, 'dispatch: op already registered, overwriting');
  }
  registry.set(op, handler as OpHandler<unknown, unknown>);
}

/**
 * 取注册的 handler（测试用）
 */
export function getRegisteredOp(op: string): OpHandler<unknown, unknown> | undefined {
  return registry.get(op);
}

/**
 * 列出所有已注册 op（PreferencesView 待处理面板用）
 */
export function listRegisteredOps(): string[] {
  return [...registry.keys()].sort();
}

/**
 * dispatch 一次写 op
 *
 * @returns DispatchResult
 *   - mode: 'online' | 'offline'
 *   - result: 业务结果（execute 或 offlineApply 的返回）
 *   - entryId: 离线模式下 queue entry id（用户后续查看状态用）
 */
export interface DispatchResult<TResult> {
  mode: 'online' | 'offline';
  result: TResult;
  entryId?: string;
}

export async function dispatch<TArgs, TResult>(
  op: string,
  args: TArgs,
): Promise<DispatchResult<TResult>> {
  const handler = registry.get(op);
  if (!handler) {
    log.error({ op }, 'dispatch: op not registered');
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: `内部错误：op ${op} 未注册`,
    });
  }

  // 试 execute；网络错误 → fallback offlineApply（如有）
  try {
    const result = await (handler.execute as (a: unknown) => unknown)(args);
    return { mode: 'online', result: result as TResult };
  } catch (err) {
    if (!isNetworkOffline(err) || !handler.offlineApply) {
      // 非网络错误 OR 不可离线写 → 重抛
      throw err;
    }
    // 离线降级
    log.info(
      { op, err: err instanceof Error ? err.message : String(err) },
      'dispatch: gitea unreachable, falling back to offlineApply',
    );
    const optimistic = await (handler.offlineApply as (a: unknown) => unknown)(args);
    const entry = await enqueueEntry({ op, payload: args });
    return { mode: 'offline', result: optimistic as TResult, entryId: entry.id };
  }
}

/**
 * 判定错误是否是"网络离线"（gitea 客户端已映射为 IpcError.NETWORK_OFFLINE）
 */
function isNetworkOffline(err: unknown): boolean {
  if (err instanceof IpcError) {
    return err.code === IpcErrorCode.NETWORK_OFFLINE;
  }
  // 兜底：原生 fetch / DNS 错误（IPC handler 捕获前抛出）
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('econnreset') ||
      msg.includes('fetch failed') ||
      msg.includes('network')
    );
  }
  return false;
}

// ===== 测试 helper =====

/** 测试用：清空注册表（**不**在生产代码用） */
export function _resetRegistryForTest(): void {
  registry.clear();
}

/** 测试用：当前注册 op 数 */
export function _registrySize(): number {
  return registry.size;
}

// 引用 QueueEntry 类型避免 unused（外部用户可能导入）
export type { QueueEntry };
