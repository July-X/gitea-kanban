/**
 * IPC客户端 ——渲染端所有 IPC调用的唯一入口
 *
 *职责（AGENTS.md §5.2 frontend agent + §8.2鉴权铁律 + OVERRIDE §3错误人话）：
 *1.薄封装 `window.api`（Wails API shim 注入，详见 lib/wails-api-shim.ts）
 *2. 把 IpcError reject 转成 typed Error形态（"人话"层）
 *3. 提供分类错误码到中文 hint 的映射（O v1：直接用 IpcError.hint；fallback 用 message）
 *4.记录不写明文 token / payload 到 console（避免误入用户屏幕）
 *
 * 不做的事（避免越权）：
 * - 不直接 fetch gitea（必须走 window.api → Wails bindings → main）
 * - 不持久化 token（keychain 由 main端管，详见 AGENTS §8.2）
 * - 不在 localStorage写任何 IPC 数据
 *
 *错误处理模型（ipcRenderer.invoke 的 reject形态）：
 * main端 throw new IpcError(...).toJSON() → 通过 structured clone到达 renderer
 * →渲染端拿到纯对象 { code, message, hint?, cause?, httpStatus? }
 * → 这里做 duck-type 判断 +重新包装成 Error形态（保留原字段 + 加本地化的 messageText）
 */

import type { IpcErrorPayload, IpcErrorCodeValue } from '@shared/errors';
import { markUpdated } from './last-updated';
import type {
  ConnectResult,
  StatusResult,
  ListReposResp,
  ListBranchesResp,
  ListCommitsResp,
  ListPullsResp,
  MergePrResult,
  ListLabelsResp,
  ListMembersResp,
  ListMilestonesResp,
  CommitDetailDTO,
  IssueCommentDto,
  TimelineItemDto,
  LabelDto,
  PullDto,
  PullFileDto,
  PullFileDiffDto,
  PullCommitDto,
  PullReviewCommentDto,
  RepoProjectDto,
  GraphResultDto,
  GraphLinesDto,
  ReactionDto,
  PullReviewDto,
} from '@renderer/types/dto';

/** window.api 的精确类型（Wails API shim 注入，详见 lib/wails-api-shim.ts） */
export type WindowApi = NonNullable<typeof window.api>;

/**渲染端友好的"人话"错误形态 */
export interface UserFacingError {
  /**原始业务错误码（snake_case英文） */
  code: IpcErrorCodeValue;
  /** 已本地化的中文提示（zh-Hans v1） */
  messageText: string;
  /**建议下一步（人话） */
  hint: string;
  /**原始 cause（开发模式 / 日志用，生产折叠） */
  cause?: string;
  /** gitea HTTP状态码（如有） */
  httpStatus?: number;
  /**是不是可恢复（如 token失效需要重连） */
  recoverable: boolean;
}

/**
 * duck-type 判断：unknown是不是 IpcError
 *
 * preload 把 IpcError 实例 toJSON() 后跨 IPC边界传过来，渲染端**没有**
 * instanceof链，只能靠字段形状判断。
 */
export function isIpcErrorPayload(err: unknown): err is IpcErrorPayload {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    //业务错误码白名单 ——防止误抓 zod错误或 gitea原始错误
    KNOWN_ERROR_CODES.has(e.code as IpcErrorCodeValue)
  );
}

/**12 个已知 IpcErrorCode 值（与 src/shared/errors.ts IpcErrorCode同步） */
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

/**错误码 → 中文类别前缀（OVERRIDE §本项目专属规则 #3错误人话） */
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

/**错误码 → 是否可恢复（引导用户重试 / 重连） */
const RECOVERABLE: Record<IpcErrorCodeValue, boolean> = {
  unauthenticated: true, // 重连
  token_invalid: true, // 重连
  permission_denied: false, // 联系管理员
  not_found: false, // 内容已被删除
  conflict: true, //刷新后重试
  rate_limited: true, //稍候
  network_offline: true, // 网络恢复后重试
  gitea_error: true, // 服务器恢复后重试
  validation_failed: false, //改输入
  internal: true, //通用重试
  keychain_unavailable: false, //平台问题
  keychain_access_denied: true, //引导用户授权
};

/** 把 IpcErrorPayload 转成渲染端 UserFacingError（"人话"层）
 *
 * 错误文案组装（从重到轻）：
 *   1. payload.cause（gitea 真实消息）—— **优先**（用户最想知道"具体错在哪"）
 *   2. payload.message（IpcError 中文摘要）
 *   3. payload.hint（操作建议）
 */
export function toUserFacingError(payload: IpcErrorPayload): UserFacingError {
  const code = payload.code;
  const category = CODE_CATEGORY[code] ?? '出错了';
  const hint = payload.hint ?? '请稍候重试';
  // gitea 真实消息（如"Organization can't be doer to add reviewer"）放在最前
  // 这是用户最想知道的具体原因
  const giteaCause = payload.cause ? `\n[${code}] ${payload.cause}` : '';
  // 主消息：中文摘要 + gitea 真实消息
  const messageText = `${category}：${payload.message}${giteaCause}`;
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
 * 把 unknown错误规整为 UserFacingError
 *
 *优先级：
 *1. 是 IpcErrorPayload（duck-type 通过） → toUserFacingError
 *2. 是普通 Error（有 message） → 包成"internal"形态
 *3. 其他 unknown（null / string / object） → 包成"internal" + 占位文案
 */
export function normalizeError(err: unknown): UserFacingError {
  if (isIpcErrorPayload(err)) {
    return toUserFacingError(err);
  }
  // Wails ErrorFormatter 兜底时返回 err.Error() 字符串，序列化后前端收到 string
  // 这种情况必须把 string 本身当 message，否则用户看到"未知错误"占位文案
  // (v2.x 修复：用户反馈"应用出错了:未知错误"，根因就是 Wails 把 network 层 err
  // 序列化后丢光了字段，前端 normalizeError 没拿到具体原因)
  if (typeof err === 'string' && err.trim()) {
    return {
      code: 'internal',
      messageText: `应用出错了：${err}`,
      hint: '请稍候重试',
      recoverable: true,
    };
  }
  if (err instanceof Error) {
    // v1 时代踩坑（2026-06-12 修复）：v1 Electron IPC 把 main process throw 的 plain object
    // "Error invoking remote method 'repos.list': 请求失败: Get ...: TLS handshake timeout"
    // 这种 message 包含 Go 端 err.Error() 全文，对用户排障很有用——直接展示
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
 * IpcClient 类 ——渲染端所有 IPC调用的统一包装
 *
 * 用法：
 * const ipc = useIpcClient(); //拿到单例
 * try {
 * const cols = await ipc.invoke('board.columns.list', { projectId });
 * } catch (e) {
 * // e 是 UserFacingError形态
 * showToast(e.messageText);
 * }
 *
 * 设计（AGENTS §5.2 + §8.2）：
 * - 单例（worker视图 + main 全局一致）
 * -错误 reject 时抛 UserFacingError（而不是原始 IpcErrorPayload）
 * - 不在内部做重试（让上层 store决定要不要重试）
 */
export class IpcClient {
  private readonly api: WindowApi;

  constructor(api: WindowApi) {
    this.api = api;
  }

  /**
   *通用 invoke —— 把 window.api.<namespace>.<method>(args)调到 main端,
   *错误 reject 时把 IpcErrorPayload 转成 UserFacingError 后再抛
   *
   * namespace 用 string 不用 `keyof WindowApi` 约束 —— A3 等后端新增 namespace
   * （members.*）时 WindowApi 类型**先**在 preload 加，**然后**前端 store 调。
   * 这里放宽到 string 让前端代码能"先写后端对齐"（A3 拍板的契约驱动开发）。
   * 运行时仍然校验 ns[method] 是函数才发，**不**会泄漏到 main。
   */
  /**
   * 通用 invoke —— 把 window.api.<namespace>.<method>(args) 调到 main 端，
   * 错误 reject 时把 IpcErrorPayload 转成 UserFacingError 后再抛。
   *
   * 泛型 `<T = unknown>`：wrapper 调用方可以指定期望返回类型（如 `invoke<ColumnDto[]>(...)`），
   * 让跨 IPC 边界的 `unknown` 在封装层一次性 narrow 到业务 DTO。store 层就**不需要**再 `as` 强转。
   *
   * namespace 用 string 不用 `keyof WindowApi` 约束 —— A3 等后端新增 namespace
   * （members.*）时 WindowApi 类型**先**在 preload 加，**然后**前端 store 调。
   * 这里放宽到 string 让前端代码能"先写后端对齐"（A3 拍板的契约驱动开发）。
   * 运行时仍然校验 ns[method] 是函数才发，**不**会泄漏到 main。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async invoke<T = unknown>(
    namespace: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (this.api as unknown as Record<string, any>)[namespace];
    if (!ns || typeof ns[method] !== 'function') {
      throw {
        code: 'internal' as IpcErrorCodeValue,
        messageText: `IPC端点不存在：${namespace}.${method}`,
        hint: '请刷新应用或重启',
        recoverable: false,
      } satisfies UserFacingError;
    }
    try {
      // 唯一例外：auth.connect 走 (giteaUrl, token, platform) 三参而不是 (args) 单参
      // platform 是 v2 新增（"gitea" | "github"），shim 的 connect 第三参透传到 Wails AuthConnect
      if (namespace === 'auth' && method === 'connect') {
        const a = args as { giteaUrl: string; token: string; platform?: string };
        const r = (await (this.api.auth.connect as (
          g: string,
          t: string,
          p?: string,
        ) => Promise<unknown>)(a.giteaUrl, a.token, a.platform)) as T;
        markUpdated();
        return r;
      }
      const r = (await ns[method](args)) as T;
      markUpdated();
      return r;
    } catch (err) {
      // v2.6 调试：在 normalizeError 之前先打一份原始 err 到 frontend-log
      //
      // 背景：之前遇到"更新失败 应用出错了：未知错误"，normalizeError 走到末尾的 fallback
      // 返回 '未知错误'，前端啥也看不到。根因是 Wails 把 Go 抛的 error 包装成 Error instance，
      // 但 message 形如 "Error invoking remote method 'App.PullRepoByProjectId': <go-err-msg>"，
      // 其中 <go-err-msg> 部分是经过 toString 化的字符串，再被 normalizeError 当 err.message 用，
      // 就吃掉了原始错误细节。
      //
      // 修复：rawErr 单独存进 UserFacingError.cause，前端能看到完整 stack；console.error 同
      // 时给 DevTools 一份（v2.x 全局 console.error 拦截已修复死循环，不会爆日志）。
      try {
        const raw = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
          : (() => {
              try {
                return JSON.stringify(err);
              } catch {
                return String(err);
              }
            })();
        // eslint-disable-next-line no-console
        console.error('[ipc] invoke failed:', namespace + '.' + method, raw);
      } catch {
        /* 静默 */
      }
      throw normalizeError(err);
    }
  }

  /**
   *嵌套 invoke —— 处理 `board.columns.list` 这种 namespace.sub.method 三段式
   *
   * 用法：await ipc.invokeNested('board', 'columns', 'list', { projectId })
   *错误处理同 invoke()
   */
  async invokeNested<T = unknown>(
    namespace: string,
    sub: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    // ns 的类型在 TS看来是 Record<string, T> 但 T是个函数,所以 ns[sub] 不能再用 string索引
    // 用 any绕过这条狭窄的索引约束（语义上正确：sub 是动态字符串）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (this.api as unknown as Record<string, any>)[namespace];
    const subNs = ns?.[sub];
    if (!subNs || typeof subNs[method] !== 'function') {
      throw {
        code: 'internal' as IpcErrorCodeValue,
        messageText: `IPC端点不存在：${namespace}.${sub}.${method}`,
        hint: '请刷新应用或重启',
        recoverable: false,
      } satisfies UserFacingError;
    }
    try {
      const r = (await subNs[method](args)) as T;
      markUpdated();
      return r;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /**
   * 深层嵌套 invoke —— 处理 `pulls.comment.reactions.list` 这种 namespace.sub.subMethod.method 四段式
   *
   * 用法：await ipc.invokeDeepNested('pulls', 'comment', 'reactions', 'list', { projectId, commentId })
   */
  async invokeDeepNested<T = unknown>(
    namespace: string,
    sub: string,
    subMethod: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (this.api as unknown as Record<string, any>)[namespace];
    const subNs = ns?.[sub];
    const deepNs = subNs?.[subMethod];
    if (!deepNs || typeof deepNs[method] !== 'function') {
      throw {
        code: 'internal' as IpcErrorCodeValue,
        messageText: `IPC端点不存在：${namespace}.${sub}.${subMethod}.${method}`,
        hint: '请刷新应用或重启',
        recoverable: false,
      } satisfies UserFacingError;
    }
    try {
      const r = (await deepNs[method](args)) as T;
      markUpdated();
      return r;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /**通用事件监听（main → renderer推送） */
  on(event: string, cb: (payload: unknown) => void): () => void {
    return this.api.on(event, cb);
  }
}

// ===== 单例工厂 =====

let _instance: IpcClient | null = null;

/**拿到 IPC客户端单例（每次调用拿到同一引用） */
export function getIpcClient(): IpcClient {
  if (!_instance) {
    if (typeof window === 'undefined' || !window.api) {
      throw {
        code: 'internal' as IpcErrorCodeValue,
        messageText: '应用出错了：window.api 未注入',
        hint: '请刷新应用或重启（Wails bindings 加载失败）',
        recoverable: false,
      } satisfies UserFacingError;
    }
    _instance = new IpcClient(window.api);
  }
  return _instance;
}

// =====便捷具名方法（给 store / view 用，比 ipc.invoke('namespace.method', args)直观） =====

/**列出所有已连接的 gitea账号 + 当前用户（**不**含 token） */
export function authStatus(): Promise<StatusResult> {
  return getIpcClient().invoke('auth', 'status');
}

/**
 * 连接 gitea/github（**唯一**接收 token 的入口）
 *
 * @param giteaUrl gitea 实例 URL（GitHub 时传 https://github.com 即可，后端忽略）
 * @param token 个人访问令牌（8+ 字符，main 端会 trim + 长度校验）
 * @param platform "gitea" | "github"（v2 新增，默认 "gitea"）
 */
export function authConnect(
  giteaUrl: string,
  token: string,
  platform: 'gitea' | 'github' = 'gitea',
): Promise<ConnectResult> {
  return getIpcClient().invoke('auth', 'connect', { giteaUrl, token, platform });
}

/**断开某个 gitea URL 的连接 */
export function authDisconnect(giteaUrl: string): Promise<void> {
  return getIpcClient().invoke('auth', 'disconnect', { giteaUrl });
}

/** v1.6 按 URL+username 断开单个账号（区别于 authDisconnect 删整站） */
export function authDisconnectOne(args: { giteaUrl: string; username: string }): Promise<void> {
  return getIpcClient().invoke('auth', 'disconnectOne', args);
}

/** v1.6 切换当前活跃账号（重排 accounts 顺序，指定 accountId 变成第一个） */
export function authSwitchAccount(accountId: string): Promise<void> {
  return getIpcClient().invoke('auth', 'switchAccount', { accountId });
}

/**列出某账号可访问的仓库 + 已加为 project 的标记 */
export function reposList(args: {
  giteaAccountId: string;
  query?: string;
  limit?: number;
  page?: number;
}): Promise<ListReposResp> {
  return getIpcClient().invoke('repos', 'list', args);
}

/**标记某个仓库为 project（加入本机看板） */
export function reposAddProject(args: {
  giteaAccountId: string;
  owner: string;
  name: string;
}): Promise<RepoProjectDto> {
  return getIpcClient().invoke('repos', 'addProject', args);
}

/**取消标记 */
export function reposRemoveProject(args: { projectId: string }): Promise<void> {
  return getIpcClient().invoke('repos', 'removeProject', args);
}

/**列出某 project 的分支 */
export function branchesList(args: {
  projectId: string;
  query?: string;
  limit?: number;
  page?: number;
}): Promise<ListBranchesResp> {
  return getIpcClient().invoke('branches', 'list', args);
}

/**
 * 收藏/取消收藏某分支（v1：只更本地 starred_branches 表，**不**调 gitea）
 *
 * 入参契约见 StarBranchArgsSchema。后端处理：setStarred(args)
 * （cache/branches.ts:UPSERT/DELETE）。
 */
export function branchesStar(args: {
  projectId: string;
  branch: string;
  starred: boolean;
}): Promise<void> {
  return getIpcClient().invoke('branches', 'star', args);
}

/**
 * 列出某 project 的 commit（gitea /repos/{owner}/{repo}/commits）
 *
 * 契约：ListCommitsArgsSchema
 * - sha?: 按分支头拉（v1 简化的"按分支查提交"用此字段）
 * - path?: 按文件路径过滤
 * - author?: 按作者过滤（gitea username 字符串）
 * - since/until?: ISO 时间过滤
 * - page/limit?: 分页
 *
 * 出参 ListCommitsResp：{ items, total, hasMore, nextPage }。
 *
 * 注意：list 端点**不**返 additions/deletions/filesChanged（gitea 端 list 不含 stats）——
 * 业务上需 stats 时调 `commitsGet`（单条接口走 /git/commits/{sha}，含 stats）。
 */
export function commitsList(args: {
  projectId: string;
  sha?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  page?: number;
  limit?: number;
}): Promise<ListCommitsResp> {
  return getIpcClient().invoke('commits', 'list', args);
}

/** 拿单个 commit 详情（gitea /repos/{owner}/{repo}/git/commits/{sha}，含 stats） */
export function commitsGet(args: { projectId: string; sha: string }): Promise<CommitDetailDTO> {
  return getIpcClient().invoke('commits', 'get', args);
}

/** 拿结构化 Git Graph（Go 端基于 go-git commit DAG 生成 nodes + edges） */
export function commitsGitgraphLines(args: {
  projectId: string;
  branches?: string[];
  limit?: number;
  offset?: number;
  hidePRRefs?: boolean;
}): Promise<GraphResultDto> {
  return getIpcClient().invoke('commits', 'gitgraphLines', args);
}

/** 拿 ASCII Git Graph（GitHub/gh 超大仓库 fallback，前端复用旧 parser） */
export function commitsGitgraphAsciiLines(args: {
  projectId: string;
  branches?: string[];
  limit?: number;
  hidePRRefs?: boolean;
}): Promise<GraphLinesDto> {
  return getIpcClient().invoke('commits', 'gitgraphAsciiLines', args);
}

/**
 * 启用 Git Graph：自动用 go-git 轻量 clone 仓库元信息到本地
 *
 * UI 流程：
 *   用户点「启用 Git Graph」按钮 → 调本函数 → clone 完成自动回到 TimelineNewView
 *   看到基于本地 commit DAG 渲染的 Git Graph
 *
 * v2.3 修复：token 不再走 IPC（AGENTS §8.2 鉴权铁律）
 *   - 旧版调 gitgraphCloneRepo 时传 token → 违反铁律
 *   - 新版 Go 端 App.CloneRepo 自己从 keychain 拿（按 platform+hostUrl+username 定位）
 *   - 前端只传 platform+hostUrl+username+owner+repo
 *
 * @param args.platform gitea | github（默认 gitea）
 * @param args.hostUrl 用户连接的 gitea/github URL
 * @param args.username 用户登录名
 * @param args.owner 仓库 owner
 * @param args.repo 仓库名
 */
export function commitsGitgraphCloneRepo(args: {
  /** v2.4 推荐：传 projectId，Go 端按 owner+repo 反查 localPath + token */
  projectId?: string;
  platform?: 'gitea' | 'github';
  hostUrl?: string;
  username?: string;
  owner?: string;
  repo?: string;
}): Promise<{ localPath: string; reused: boolean }> {
  return getIpcClient().invoke('commits', 'gitgraphCloneRepo', args);
}

/**
 * v2.3 检查 owner/repo 是否已 clone 本地 workspace
 *
 * StatusBar 仓库管理面板用：判断行末按钮是"同步"还是"更新"
 *
 * v2.5：按账号分层（新增 username 参数）
 *   - 旧版：只查 ${workspace}/repos/<owner>__<repo>/
 *   - 新版：查 ${workspace}/repos/<username>/<owner>__<repo>/
 *   - username 为空时 fallback 到旧版路径（兼容旧 caller）
 */
export function commitsGitgraphIsRepoCloned(args: {
  username?: string;
  owner: string;
  repo: string;
}): Promise<boolean> {
  return getIpcClient().invoke('commits', 'gitgraphIsRepoCloned', args);
}

/**
 * v1.5.2 pull (merge)：git fetch + pull --rebase
 *
 * Header 的 pull 按钮调：拉取远端最新 commit → 成功后重新 loadGraph
 *
 * v2.3：token 字段删除（AGENTS §8.2 鉴权铁律），Go 端从 localPath 反查 token
 * v2.4：优先用 projectId（Go 端按 owner+repo 反查 localPath + token），
 *      避免前端拼错 localPath 路径。兼容老 caller 传 localPath。
 *
 * @param args.projectId 优先（v2.4 推荐）
 * @param args.localPath 兼容旧 caller
 */
export function commitsGitgraphPull(args: {
  projectId?: string;
  localPath?: string;
}): Promise<{
  beforeCount: number;
  afterCount: number;
  addedCommits: number;
  headChanged: boolean;
  headBefore: string;
  headAfter: string;
}> {
  return getIpcClient().invoke('commits', 'gitgraphPull', args);
}

/**
 * v2.x 应用数据目录：读数据根目录 + 内部 workspace 子目录
 *
 * 数据根目录 = 用户可感知的"全局路径"，默认 ~/.gitea-kanban (macOS/Linux)
 * 或 %USERPROFILE%\.gitea-kanban (Windows)，启动期不存在会自动 mkdir -p。
 * workspace 子目录 (= dataRoot + "/workspace") 由应用根据业务自动创建，
 * 放 git repos，UI 不暴露、用户不应直接选择。
 */
export function commitsGitgraphGetWorkspace(): Promise<{
  /** 数据根目录（如 ~/.gitea-kanban） */
  dataRoot: string;
  /** 内部 git 仓库目录 (= dataRoot + "/workspace") */
  workspacePath: string;
  /** 永远是 true（数据根目录不可改 → 永远默认） */
  isDefault: boolean;
  /** 数据根目录存在且可写 */
  validated: boolean;
}> {
  return getIpcClient().invoke('commits', 'gitgraphGetWorkspace', {});
}

/**
 * v1.5.3 应用工作区：设置新 workspace 路径
 *
 * @param args.cwd 新的工作区根目录（绝对路径；不存在会 mkdir -p）
 * @returns new cwd + 仓库路径模板（提示后续 gitgraph 仓库放哪）
 */

// ============================================================
// ===== preferences.* （v1.1.3 提交号 / 分支名复制）=====
// ============================================================

/** 写系统剪贴板（v1.1.3）—— 走主进程 electron.clipboard.writeText
 *
 * 选 IPC 而非 navigator.clipboard.writeText 的原因（task #20）：
 * 1) v1 时代 renderer 窗口无 focus / 非用户激活时 navigator.clipboard.writeText
 *    promise reject，v1.1.2 主题切换踩过 → 主进程永远可靠
 * 2) 主进程走 system clipboard API，与 webview focus 解耦
 * 3) 沙箱合规：renderer 不直接调系统 API
 */
export function clipboardWrite(text: string): Promise<void> {
  // 调用 window.api.preferences.clipboard.write({text}) —— 三段式 path，
  // 必须用 invokeNested('preferences', 'clipboard', 'write', ...)；
  return getIpcClient().invokeNested('preferences', 'clipboard', 'write', { text });
}

// ============================================================
// ===== system.* （Wails 系统级能力，v1 时代是 Electron 系统能力）=====
// ============================================================

/** 系统目录选择器（v1.5.3 SettingsView 用，v2.2 已移除选择目录功能，保留 stub） */
export function systemSelectDirectory(): Promise<string | null> {
  return getIpcClient().invoke('system', 'selectDirectory');
}

/**
 * 用系统文件管理器打开目录
 *
 * v2.2：设置页"打开应用数据目录"按钮调。Go 端 App.OpenDataDir 跨平台实现
 *   - macOS: `open <path>`
 *   - Windows: `explorer <path>`
 *   - Linux: `xdg-open <path>`
 */
export function systemOpenPath(args: { path: string }): Promise<void> {
  return getIpcClient().invoke('system', 'openPath', args);
}

/** 打开用户桌面目录（openDesktopFolder） */
export function openDesktopFolder(): Promise<void> {
  return getIpcClient().invoke('system', 'openDesktopFolder');
}

// ============================================================
// ===== pulls.* （A3 补：前端 wrapper，让 MergesView 能调） =====
// ============================================================

/** 合并请求 state（与 frontend/wailsjs/wailsjs/go/main/App.d.ts PullStateSchema 同步）
 *
 * a3 拍板加 'all'：前端"合并请求"页要拉全量，然后按 merged 二次过滤拆"全部 / 待合并 /
 * 已合并 / 已关闭"4 个 tab。gitea 端 /pulls?state=closed 同时含 merged，'all' 是
 * "既含 open 也含 closed" 唯一安全的取值（gitea 默认不传=open）。
 */
export type PullState = 'open' | 'closed' | 'all';

/** 列出某 project 的合并请求（= gitea /pulls）
 *
 * A3 拍板：channel = `pulls.list`；后端支持 state 过滤 + linkedCards JOIN。
 *
 * v1 简化：state 只接 'open' | 'closed'（gitea 把 merged 合并请求视为 closed，
 * merged 标志走 PullDto.merged 字段；store 层按 merged 二次过滤）。
 */
export function pullsList(args: {
  projectId: string;
  state?: PullState;
  head?: string;
  base?: string;
  author?: string;
  page?: number;
  limit?: number;
}): Promise<ListPullsResp> {
  return getIpcClient().invoke('pulls', 'list', args);
}

/** 拿单个合并请求详情 */
export function pullsGet(args: { projectId: string; index: number }): Promise<PullDto> {
  return getIpcClient().invoke('pulls', 'get', args);
}

/**
 * 合并合并请求（**危险操作**，UI 层必须二次确认）
 *
 * 合并方式（MergeMethodSchema，与 gitea 1.26 swagger 一致）：
 *   - 'merge'        → 普通合并（保留所有提交历史）
 *   - 'rebase'       → 变基后快进（重写历史，单一线性）
 *   - 'rebase-merge' → 变基后 merge commit
 *   - 'squash'       → 压缩为单提交
 *
 * 业务规则：
 *   - method='squash' 时 commitMessage 必填
 *   - deleteBranchAfter 仅透传给 gitea（不主动调 branches.delete）
 *   - 合并到主线分支（如 main）时 UI 层额外二次确认
 */
export function pullsMerge(args: {
  projectId: string;
  index: number;
  method: 'merge' | 'rebase' | 'rebase-merge' | 'squash';
  deleteBranchAfter?: boolean;
  commitMessage?: string;
}): Promise<MergePrResult> {
  return getIpcClient().invoke('pulls', 'merge', args);
}

/**
 * 关闭合并请求（不合并，直接关闭）—— UI 层应二次确认
 *
 * 对应 gitea PATCH /pulls/{index} {state: 'closed'}
 * 关闭后合并请求状态变为 closed，不可再合并（除非 reopen）。
 */
export function pullsClose(args: {
  projectId: string;
  index: number;
  reason?: string;
}): Promise<{ closed: boolean }> {
  return getIpcClient().invoke('pulls', 'close', args);
}

/** 更新合并请求标签（替换所有标签） */
export function pullsUpdateLabels(args: {
  projectId: string;
  index: number;
  labels: string[];
}): Promise<PullDto> {
  return getIpcClient().invoke('pulls', 'updateLabels', args);
}

/** 更新合并请求指派人 */
export function pullsUpdateAssignee(args: {
  projectId: string;
  index: number;
  assignees: string[];
}): Promise<PullDto> {
  return getIpcClient().invoke('pulls', 'updateAssignee', args);
}

/** 更新合并请求评审人（添加） */
export function pullsUpdateReviewers(args: {
  projectId: string;
  index: number;
  reviewers: string[];
}): Promise<PullDto> {
  return getIpcClient().invoke('pulls', 'updateReviewers', args);
}

/** 给合并请求关联里程碑（v0.6.0，仅 Gitea 数据源） */
export function pullsUpdateMilestone(args: {
  projectId: string;
  index: number;
  milestone: string; // 空串 = 清除
}): Promise<PullDto> {
  return getIpcClient().invoke('pulls', 'updateMilestone', args);
}

/**
 * 上传 PR/issue 附件（v0.7.0 贴图支持）
 *
 * 端点：Gitea POST /repos/{owner}/{repo}/issues/{index}/assets（form field: attachment）
 *       GitHub POST /repos/{owner}/{repo}/issues/{issue_number}/assets（form field: file）
 * 返回 browserDownloadUrl，可直接塞到 markdown `![](url)` 让 Gitea/GitHub 渲染。
 *
 * 设计：前端把 File 转 base64 通过 Wails binding 传过去，Go 端解码还原成 []byte
 * 再走 multipart 提交。Wails 2.x 不支持 binary 字段在 binding 上直接传（TS 端类型
 * 系统限制），所以走 base64 字符串这条稳妥的路。
 *
 * 回归证据：v0.7.0 之前 PR 评论贴图走前端 FileReader.readAsDataURL 转 data URI
 * 嵌入 markdown，Gitea 不存图片，渲染时只看到"贴图"占位符。
 */
export function pullsUploadAttachment(args: {
  projectId: string;
  index: number;
  fileName: string;
  fileBase64: string;
}): Promise<{ id: number; name: string; size: number; uuid: string; browserDownloadUrl: string }> {
  return getIpcClient().invoke('pulls', 'uploadAttachment', args);
}



// ============================================================
// ===== pulls.comment.* （v0.6+ PR 评论 —— 修复 issues.comment.create stub bug） =====
// ============================================================
//
// 背景：MergesView 调用 issuesCommentList / issuesCommentCreate 发 PR 评论，
// 这两个函数还路由到 issues.comment.* ，但后端 issues.comment.* 是 stub，
// 返 "尚未实现（Wails 迁移中）" error → toast "应用出错了"。
//
// v0.6+ 修复方案：PR 上下文走独立的 pulls.comment.* 命名空间（Issue 评论待 v0.7）。
// Gitea 与 GitHub 都支持。
// 端点：/repos/{owner}/{repo}/issues/{index}/comments（PR 与 issue 共享编号空间）。

/** 列合并请求时间轴 (v0.7.x 走 /issues/{index}/timeline) */
export function pullsCommentList(args: {
  projectId: string;
  index: number;
}): Promise<TimelineItemDto[]> {
  return getIpcClient().invokeNested('pulls', 'comment', 'list', args);
}

/** 发合并请求评论。body 会在 UI 层 trim；后端还会走防御性 short-circuit */
export function pullsCommentCreate(args: {
  projectId: string;
  index: number;
  body: string;
}): Promise<IssueCommentDto> {
  return getIpcClient().invokeNested('pulls', 'comment', 'create', args);
}

/** 编辑合并请求评论。body 会在 UI 层 trim；后端还会走防御性 short-circuit */
export function pullsCommentUpdate(args: {
  projectId: string;
  commentId: number;
  body: string;
}): Promise<IssueCommentDto> {
  return getIpcClient().invokeNested('pulls', 'comment', 'update', args);
}

/** 删除合并请求评论。已删除的评论重复删除也返成功（幂等） */
export function pullsCommentDelete(args: {
  projectId: string;
  commentId: number;
}): Promise<void> {
  return getIpcClient().invokeNested('pulls', 'comment', 'delete', args);
}

/** 列评论表情反应 */
export function pullsCommentReactionsList(args: {
  projectId: string;
  commentId: number;
}): Promise<ReactionDto[]> {
  return getIpcClient().invokeDeepNested('pulls', 'comment', 'reactions', 'list', args);
}

/** 添加评论表情反应 */
export function pullsCommentReactionAdd(args: {
  projectId: string;
  commentId: number;
  content: string;
}): Promise<ReactionDto> {
  return getIpcClient().invokeDeepNested('pulls', 'comment', 'reactions', 'add', args);
}

/** 移除评论表情反应 */
export function pullsCommentReactionRemove(args: {
  projectId: string;
  commentId: number;
  content: string;
}): Promise<void> {
  return getIpcClient().invokeDeepNested('pulls', 'comment', 'reactions', 'remove', args);
}

/** 列合并请求评审 */
export function pullsReviewsList(args: {
  projectId: string;
  index: number;
}): Promise<PullReviewDto[]> {
  return getIpcClient().invokeNested('pulls', 'reviews', 'list', args);
}

/** 创建合并请求评审（批准 / 请求修改 / 仅评论，v0.6.0 支持附带行内评论） */
export function pullsReviewCreate(args: {
  projectId: string;
  index: number;
  commitId?: string;
  body?: string;
  event: string;
  comments?: { body: string; path: string; position: number }[];
}): Promise<PullReviewDto> {
  return getIpcClient().invokeNested('pulls', 'reviews', 'create', args);
}

// ============================================================
// ===== 文件评论 / 文件 diff（v0.5.0 M4） =====
// ============================================================

/** 列 PR 行内评审评论（按文件分组） */
export function pullsReviewCommentsList(args: {
  projectId: string;
  index: number;
}): Promise<PullReviewCommentDto[]> {
  return getIpcClient().invokeNested('pulls', 'reviewComments', 'list', args);
}

/** 创建 PR 行内评审评论 */
export function pullsReviewCommentCreate(args: {
  projectId: string;
  index: number;
  body: string;
  path: string;
  line: number;
}): Promise<PullReviewCommentDto> {
  return getIpcClient().invokeNested('pulls', 'reviewComments', 'create', args);
}

/** 列 PR 修改的文件列表 */
export function pullsFilesList(args: {
  projectId: string;
  index: number;
}): Promise<PullFileDto[]> {
  return getIpcClient().invokeNested('pulls', 'files', 'list', args);
}

/** 列 PR 中包含的提交列表 */
export function pullsCommitsList(args: {
  projectId: string;
  index: number;
}): Promise<PullCommitDto[]> {
  return getIpcClient().invokeNested('pulls', 'commits', 'list', args);
}

/** 获取单个文件的 diff 内容 */
export function pullsFileDiffGet(args: {
  projectId: string;
  index: number;
  filePath: string;
}): Promise<PullFileDiffDto> {
  return getIpcClient().invokeNested('pulls', 'fileDiff', 'get', args);
}

// ============================================================
// ===== labels.* （ADR-0002：看板列绑 gitea label 用） =====
// ============================================================

/**列出某 project 的 gitea label */
export function labelsList(args: {
  projectId: string;
  page?: number;
  limit?: number;
}): Promise<ListLabelsResp> {
  return getIpcClient().invoke('labels', 'list', args);
}

/** 新建 gitea label */
export function labelsCreate(args: {
  projectId: string;
  name: string;
  color: string;
  description?: string;
}): Promise<LabelDto> {
  return getIpcClient().invoke('labels', 'create', args);
}

// ============================================================
// ===== members.* （A3 新增：仓库成员 = gitea collaborators） =====
// ============================================================

/** 列出某 project 的成员（= gitea repo collaborators）
 *
 * A3 拍板：channel = `members.list`，后端 app/platform/gitea/adapter.go ListMembers
 * 包装（v2.0 改 Go net/http 手写，替代 v1 的 gitea-js swagger 客户端 + src/main/gitea/）。
 *
 * 兼容层：
 * - 旧实现可能直接返数组
 * - 当前前端统一吃 `{ items, hasMore }`
 *
 * gitea collaborators 接口无分页，统一包装时 `hasMore=false`。
 */
export function membersList(args: { projectId: string }): Promise<ListMembersResp> {
  return getIpcClient()
    .invoke('members', 'list', args)
    .then((resp) => {
      if (Array.isArray(resp)) {
        return { items: resp, hasMore: false } satisfies ListMembersResp;
      }
      return resp as ListMembersResp;
    });
}

/** 列仓库里程碑（v1.4 新增：新建议题弹窗选里程碑用）
 * 返 { items: MilestoneDto[], hasMore }，items 含仓库全部里程碑（state=all） */
export function milestonesList(args: {
  projectId: string;
  state?: 'open' | 'closed' | 'all';
  page?: number;
  limit?: number;
}): Promise<ListMilestonesResp> {
  return getIpcClient().invoke('milestones', 'list', args);
}

/**
 * v0.4.0：git 二进制设置（SettingsView "Git 二进制" 卡片）
 *
 * - getGitBinaryConfig: 读 userOverride / defaultPath / effectivePath
 * - setGitBinaryPath: 持久化 prefs["app.gitBinaryPath"] + 进程内立即生效
 * - testGitBinary: 验证 path 是否可执行（macOS quarantine 检测）
 * - stripGitBinaryQuarantine: macOS 主动 xattr -d 剥离
 * - openGitBinaryPicker: 平台特定文件选择对话框
 */
export interface GitBinaryConfig {
  /** 用户填的路径；空字符串 = 用默认（内嵌或 PATH） */
  userOverride: string;
  /** 内嵌二进制实际释放路径（dev 期可能为空字符串：0 字节 placeholder） */
  defaultPath: string;
  /** 内嵌版本号（当前固定 "2.55.0"） */
  embeddedVersion: string;
  /** 当前进程实际用的 git 路径（= ResolveGitBinaryPath 解析结果） */
  effectivePath: string;
  /** 当前平台是否真嵌入二进制（linux 永远 false） */
  embeddedAvailable: boolean;
}

export interface TestGitBinaryResult {
  ok: boolean;
  version: string;
  path: string;
  message: string;
  hint: string;
}

export function getGitBinaryConfig(): Promise<GitBinaryConfig> {
  return getIpcClient().invoke('gitBinary', 'getConfig', {});
}

export function setGitBinaryPath(path: string): Promise<void> {
  return getIpcClient().invoke('gitBinary', 'setPath', { path });
}

export function testGitBinary(path: string): Promise<TestGitBinaryResult> {
  return getIpcClient().invoke('gitBinary', 'test', { path });
}

export function stripGitBinaryQuarantine(path: string): Promise<void> {
  return getIpcClient().invoke('gitBinary', 'stripQuarantine', { path });
}

/** 平台特定文件选择对话框；用户取消返空字符串 */
export function openGitBinaryPicker(): Promise<string> {
  return getIpcClient().invoke('gitBinary', 'pickFile', {});
}

// ============================================================
// ===== v0.6.0 日志导出 / Bug 上报 =====
// ============================================================
//
// 把 app/logexport 包的能力通过 Wails binding 暴露给前端：
//   - exportLogs: 一键打包 zip 到桌面（logs + state.json 脱敏 + 元信息）
//   - copyRecentLogs: 读最近 N 条日志到剪贴板（贴 issue 用）

/** 导出日志参数 */
export interface ExportLogsArgs {
  /** 最多包含几个日志文件（默认 5，按修改时间倒序） */
  maxLogs?: number;
}

/** 导出结果 */
export interface ExportLogsResult {
  zipPath: string;
  logCount: number;
  logBytes: number;
  stateBytes: number;
  generatedAt: string;
  logFiles: string[];
}

/** 复制最近日志参数 */
export interface CopyRecentLogsArgs {
  /** 字节上限（默认 64KB） */
  maxBytes?: number;
}

/** 复制结果 */
export interface CopyRecentLogsResult {
  content: string;
  bytes: number;
}

/**
 * 一键导出日志 zip 到桌面
 *
 * 打包内容：
 *   - app.json（版本/平台/数据目录/时间戳等元信息）
 *   - state.json（token/password/secret 字段自动脱敏）
 *   - logs/main-YYYY-MM-DD.log（最近 N 天）
 *
 * 文件名：gitea-kanban-logs-YYYY-MM-DD-HHMMSS.zip
 */
export function exportLogs(args: ExportLogsArgs = {}): Promise<ExportLogsResult> {
  // Wails 自动生成的 ExportLogsArgs 是 class，无 index signature；cast 到 Record
  // 兼容 invoke 签名。运行时 Wails 端按 class 字段读取。
  return getIpcClient().invoke('logs', 'export', args as unknown as Record<string, unknown>);
}

/**
 * 读最近 N 条日志（贴 issue 用）
 *
 * 读最近 3 天的 main-*.log，截取尾部 maxBytes 字节。
 * 前端拿到 content 后调剪贴板 API 复制。
 */
export function copyRecentLogs(args: CopyRecentLogsArgs = {}): Promise<CopyRecentLogsResult> {
  return getIpcClient().invoke('logs', 'copyRecent', args as unknown as Record<string, unknown>);
}

// Re-export types used by ReactionBar component
export type { ReactionDto, PullReviewDto } from '@renderer/types/dto';
