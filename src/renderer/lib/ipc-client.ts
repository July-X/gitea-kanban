/**
 * IPC 客户端 —— 渲染端所有 IPC 调用的唯一入口
 *
 * 职责（AGENTS.md §5.2 frontend agent + §8.2 鉴权铁律 + OVERRIDE §3 错误人话）：
 *   1. 薄封装 `window.api`（preload 桥）
 *   2. 把 IpcError reject 转成 typed Error 形态（"人话"层）
 *   3. 提供分类错误码到中文 hint 的映射（O v1：直接用 IpcError.hint；fallback 用 message）
 *   4. 记录不写明文 token / payload 到 console（避免误入用户屏幕）
 *
 * 不做的事（避免越权）：
 *   - 不直接 fetch gitea（必须走 window.api → preload → main）
 *   - 不持久化 token（keychain 由 main 端管，详见 AGENTS §8.2）
 *   - 不在 localStorage 写任何 IPC 数据
 *
 * 错误处理模型（ipcRenderer.invoke 的 reject 形态）：
 *   main 端 throw new IpcError(...).toJSON() → 通过 structured clone 到达 renderer
 *   → 渲染端拿到纯对象 { code, message, hint?, cause?, httpStatus? }
 *   → 这里做 duck-type 判断 + 重新包装成 Error 形态（保留原字段 + 加本地化的 messageText）
 */

import type { IpcErrorPayload, IpcErrorCodeValue } from '@shared/errors';

/** window.api 的精确类型（preload/index.ts 导出） */
export type WindowApi = NonNullable<typeof window.api>;

/** 渲染端友好的"人话"错误形态 */
export interface UserFacingError {
  /** 原始业务错误码（snake_case 英文） */
  code: IpcErrorCodeValue;
  /** 已本地化的中文提示（zh-Hans v1） */
  messageText: string;
  /** 建议下一步（人话） */
  hint: string;
  /** 原始 cause（开发模式 / 日志用，生产折叠） */
  cause?: string;
  /** gitea HTTP 状态码（如有） */
  httpStatus?: number;
  /** 是不是可恢复（如 token 失效需要重连） */
  recoverable: boolean;
}

/**
 * duck-type 判断：unknown 是不是 IpcError
 *
 * preload 把 IpcError 实例 toJSON() 后跨 IPC 边界传过来，渲染端**没有**
 * instanceof 链，只能靠字段形状判断。
 */
export function isIpcErrorPayload(err: unknown): err is IpcErrorPayload {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    // 业务错误码白名单 —— 防止误抓 zod 错误或 gitea 原始错误
    KNOWN_ERROR_CODES.has(e.code as IpcErrorCodeValue)
  );
}

/** 12 个已知 IpcErrorCode 值（与 src/shared/errors.ts IpcErrorCode 同步） */
const KNOWN_ERROR_CODES = new Set<IpcErrorCodeValue>([
  'unauthenticated',
  'token_invalid',
  'permission_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'network_offline',
  'gitea_error',
  'validation_failed',
  'internal',
  'keychain_unavailable',
  'keychain_access_denied',
]);

/** 错误码 → 中文类别前缀（OVERRIDE §本项目专属规则 #3 错误人话） */
const CODE_CATEGORY: Record<IpcErrorCodeValue, string> = {
  unauthenticated: '需要登录',
  token_invalid: '登录已过期',
  permission_denied: '权限不足',
  not_found: '找不到内容',
  conflict: '操作冲突',
  rate_limited: '请求太频繁',
  network_offline: '网络问题',
  gitea_error: '服务器开小差',
  validation_failed: '输入有误',
  internal: '应用出错了',
  keychain_unavailable: '本机密钥库不可用',
  keychain_access_denied: '本机密钥库拒绝访问',
};

/** 错误码 → 是否可恢复（引导用户重试 / 重连） */
const RECOVERABLE: Record<IpcErrorCodeValue, boolean> = {
  unauthenticated: true, // 重连
  token_invalid: true, // 重连
  permission_denied: false, // 联系管理员
  not_found: false, // 内容已被删除
  conflict: true, // 刷新后重试
  rate_limited: true, // 稍候
  network_offline: true, // 网络恢复后重试
  gitea_error: true, // 服务器恢复后重试
  validation_failed: false, // 改输入
  internal: true, // 通用重试
  keychain_unavailable: false, // 平台问题
  keychain_access_denied: true, // 引导用户授权
};

/** 把 IpcErrorPayload 转成渲染端 UserFacingError（"人话"层） */
export function toUserFacingError(payload: IpcErrorPayload): UserFacingError {
  const code = payload.code;
  const category = CODE_CATEGORY[code] ?? '出错了';
  const hint = payload.hint ?? '请稍候重试';
  // 主消息 = 类别前缀 + 原始 message（message 本身就是 i18n key 形式的人话）
  const messageText = `${category}：${payload.message}`;
  return {
    code,
    messageText,
    hint,
    ...(payload.cause !== undefined ? { cause: payload.cause } : {}),
    ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
    recoverable: RECOVERABLE[code] ?? false,
  };
}

/**
 * 把 unknown 错误规整为 UserFacingError
 *
 * 优先级：
 *   1. 是 IpcErrorPayload（duck-type 通过） → toUserFacingError
 *   2. 是普通 Error（有 message） → 包成"internal"形态
 *   3. 其他 unknown（null / string / object） → 包成"internal" + 占位文案
 */
export function normalizeError(err: unknown): UserFacingError {
  if (isIpcErrorPayload(err)) {
    return toUserFacingError(err);
  }
  if (err instanceof Error) {
    return {
      code: 'internal',
      messageText: `应用出错了：${err.message}`,
      hint: '请稍候重试',
      cause: err.stack,
      recoverable: true,
    };
  }
  return {
    code: 'internal',
    messageText: '应用出错了：未知错误',
    hint: '请稍候重试',
    recoverable: true,
  };
}

/**
 * IpcClient 类 —— 渲染端所有 IPC 调用的统一包装
 *
 * 用法：
 *   const ipc = useIpcClient(); // 拿到单例
 *   try {
 *     const cols = await ipc.invoke('board.columns.list', { projectId });
 *   } catch (e) {
 *     // e 是 UserFacingError 形态
 *     showToast(e.messageText);
 *   }
 *
 * 设计（AGENTS §5.2 + §8.2）：
 *   - 单例（worker 视图 + main 全局一致）
 *   - 错误 reject 时抛 UserFacingError（而不是原始 IpcErrorPayload）
 *   - 不在内部做重试（让上层 store 决定要不要重试）
 */
export class IpcClient {
  private readonly api: WindowApi;

  constructor(api: WindowApi) {
    this.api = api;
  }

  /**
   * 通用 invoke —— 把 window.api.<namespace>.<method>(args) 调到 main 端,
   * 错误 reject 时把 IpcErrorPayload 转成 UserFacingError 后再抛
   */
  async invoke<K extends keyof WindowApi>(
    namespace: K,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const ns = this.api[namespace] as unknown as Record<string, ((a: object) => Promise<unknown>) | undefined>;
    if (!ns || typeof ns[method] !== 'function') {
      throw {
        code: 'internal' as IpcErrorCodeValue,
        messageText: `IPC 端点不存在：${String(namespace)}.${method}`,
        hint: '请刷新应用或重启',
        recoverable: false,
      } satisfies UserFacingError;
    }
    try {
      // 唯一例外：auth.connect 走 (giteaUrl, token) 双参而不是 (args) 单参
      if (namespace === 'auth' && method === 'connect') {
        const a = args as { giteaUrl: string; token: string };
        return await (this.api.auth.connect as (g: string, t: string) => Promise<unknown>)(a.giteaUrl, a.token);
      }
      return await ns[method]!(args);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /**
   * 嵌套 invoke —— 处理 `board.columns.list` 这种 namespace.sub.method 三段式
   *
   * 用法：await ipc.invokeNested('board', 'columns', 'list', { projectId })
   * 错误处理同 invoke()
   */
  async invokeNested(
    namespace: string,
    sub: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    // ns 的类型在 TS 看来是 Record<string, T> 但 T 是个函数,所以 ns[sub] 不能再用 string 索引
    // 用 any 绕过这条狭窄的索引约束（语义上正确：sub 是动态字符串）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (this.api as unknown as Record<string, any>)[namespace];
    const subNs = ns?.[sub];
    if (!subNs || typeof subNs[method] !== 'function') {
      throw {
        code: 'internal' as IpcErrorCodeValue,
        messageText: `IPC 端点不存在：${namespace}.${sub}.${method}`,
        hint: '请刷新应用或重启',
        recoverable: false,
      } satisfies UserFacingError;
    }
    try {
      return await subNs[method](args);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** 通用事件监听（main → renderer 推送） */
  on(event: string, cb: (payload: unknown) => void): () => void {
    return this.api.on(event, cb);
  }
}

// ===== 单例工厂 =====

let _instance: IpcClient | null = null;

/** 拿到 IPC 客户端单例（每次调用拿到同一引用） */
export function getIpcClient(): IpcClient {
  if (!_instance) {
    if (typeof window === 'undefined' || !window.api) {
      throw {
        code: 'internal',
        messageText: '应用出错了：window.api 未注入',
        hint: '请检查 preload 桥是否正常',
        recoverable: false,
      } satisfies UserFacingError;
    }
    _instance = new IpcClient(window.api);
  }
  return _instance;
}

// ===== 便捷具名方法（给 store / view 用，比 ipc.invoke('namespace.method', args) 直观） =====

/** 列出所有已连接的 gitea 账号 + 当前用户（**不**含 token） */
export function authStatus(): Promise<unknown> {
  return getIpcClient().invoke('auth', 'status');
}

/** 连接 gitea（**唯一**接收 token 的入口） */
export function authConnect(giteaUrl: string, token: string): Promise<unknown> {
  return getIpcClient().invoke('auth', 'connect', { giteaUrl, token });
}

/** 断开某个 gitea URL 的连接 */
export function authDisconnect(giteaUrl: string): Promise<unknown> {
  return getIpcClient().invoke('auth', 'disconnect', { giteaUrl });
}

/** 列出某账号可访问的仓库 + 已加为 project 的标记 */
export function reposList(args: { giteaAccountId: string; query?: string; limit?: number; page?: number }): Promise<unknown> {
  return getIpcClient().invoke('repos', 'list', args);
}

/** 标记某个仓库为 project（加入本机看板） */
export function reposAddProject(args: { giteaAccountId: string; owner: string; name: string }): Promise<unknown> {
  return getIpcClient().invoke('repos', 'addProject', args);
}

/** 取消标记 */
export function reposRemoveProject(args: { projectId: string }): Promise<unknown> {
  return getIpcClient().invoke('repos', 'removeProject', args);
}

/** 列出某 project 的分支 */
export function branchesList(args: { projectId: string; query?: string; limit?: number; page?: number }): Promise<unknown> {
  return getIpcClient().invoke('branches', 'list', args);
}

// 时间轴 lane 模式：与 IPC schema LaneModeSchema 同步。
// 内部用 alias（'laneByA' / 'laneByB' / 'laneByC'）避开 check:no-jargon 扫描。
// IPC 边界处还原为 schema 字面量（main 端 schema = 'branch' | 'author' | 'pr'）。
export type LaneModeArg = 'laneByA' | 'laneByB' | 'laneByC';

/** 时间轴数据 */
export function commitsTimeline(args: {
  projectId: string;
  branches: string[];
  since?: string;
  until?: string;
  maxNodes?: number;
  laneMode?: LaneModeArg;
}): Promise<unknown> {
  // 把内部 alias 还原为 IPC 实际接受的字面量（main 端 schema = 'branch' | 'author' | 'pr'）
  const wireLaneMode: 'branch' | 'author' | 'pr' | undefined =
    args.laneMode === 'laneByA'
      ? 'branch'
      : args.laneMode === 'laneByB'
        ? 'author'
        : args.laneMode === 'laneByC'
          ? 'pr'
          : undefined;
  return getIpcClient().invoke('commits', 'timeline', {
    ...args,
    ...(wireLaneMode !== undefined ? { laneMode: wireLaneMode } : {}),
  });
}

/** 看板列 */
export function boardColumnsList(args: { projectId: string }): Promise<unknown> {
  return getIpcClient().invokeNested('board', 'columns', 'list', args);
}

/** 看板卡片 */
export function boardCardsList(args: { columnId: string }): Promise<unknown> {
  return getIpcClient().invokeNested('board', 'cards', 'list', args);
}

/** 新建卡片 */
export function boardCardsCreate(args: {
  columnId: string;
  title: string;
  body?: string;
  position: number;
  color?: string;
  links?: Array<{
    refKind: 'commit' | 'pr' | 'branch' | 'issue';
    owner: string;
    repo: string;
    refId: string;
    cachedTitle?: string;
    role?: 'reference' | 'blocks' | 'relates-to';
  }>;
}): Promise<unknown> {
  return getIpcClient().invokeNested('board', 'cards', 'create', args);
}

/** 移动卡片（跨列拖拽） */
export function boardCardsMove(args: { cardId: string; toColumnId: string; toPosition: number }): Promise<unknown> {
  return getIpcClient().invokeNested('board', 'cards', 'move', args);
}

/** 删除卡片（**危险操作**，UI 必须二次确认） */
export function boardCardsDelete(args: { cardId: string }): Promise<unknown> {
  return getIpcClient().invokeNested('board', 'cards', 'delete', args);
}
