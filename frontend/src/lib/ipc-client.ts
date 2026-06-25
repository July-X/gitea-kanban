/**
 * IPC客户端 ——渲染端所有 IPC调用的唯一入口
 *
 *职责（AGENTS.md §5.2 frontend agent + §8.2鉴权铁律 + OVERRIDE §3错误人话）：
 *1.薄封装 `window.api`（preload桥）
 *2. 把 IpcError reject 转成 typed Error形态（"人话"层）
 *3. 提供分类错误码到中文 hint 的映射（O v1：直接用 IpcError.hint；fallback 用 message）
 *4.记录不写明文 token / payload 到 console（避免误入用户屏幕）
 *
 * 不做的事（避免越权）：
 * - 不直接 fetch gitea（必须走 window.api → preload → main）
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
  ListIssuesResp,
  ColumnDto,
  CommitDetailDTO,
  IssueCardDto,
  IssueCommentDto,
  LabelDto,
  PullDto,
  RepoProjectDto,
  GraphResultDto,
} from '@renderer/types/dto';

/** window.api 的精确类型（preload/index.ts导出） */
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
  theme_not_found: '主题偏好有问题',
  invalid_theme: '主题值不合法',
  database_unavailable: '本地数据库不可用',
  database_write_failed: '数据库写入失败',
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
  theme_not_found: true, // 重选主题即可
  invalid_theme: false, // 用户输入错误 → 不重试
  database_unavailable: true, // 重启可恢复
  database_write_failed: true, // 写失败重试
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
  if (err instanceof Error) {
    // 2026-06-12 修复：Electron IPC 把 main process throw 的 plain object
    // (IpcError.toJSON()) 包装成 Error, message = "Error invoking remote method 'xxx': [object Object]"
    // code/hint 等自定义属性丢失——解析 message
    // 2026-06-14 增强：兼容 [object Object] / [object Response] / 任何 [object XXX]
    const ipcMatch = err.message.match(/Error invoking remote method '([^']+)': \[object \w+\]/);
    if (ipcMatch) {
      return {
        code: 'internal',
        messageText: `操作失败：${ipcMatch[1]}`,
        hint: '请稍候重试',
        recoverable: true,
      };
    }
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
        code: 'internal',
        messageText: '应用出错了：window.api 未注入',
        hint: '请检查 preload桥是否正常',
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
  hidePRRefs?: boolean;
}): Promise<GraphResultDto> {
  return getIpcClient().invoke('commits', 'gitgraphLines', args);
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
 * v2.10：增量拉取更多历史记录（用于"加载更多"功能）
 *
 * 使用场景：用户在 Git Graph 底部点击「加载更多」
 * 技术实现：git fetch --deepen=N --filter=blob:none
 *
 * 注意：这个函数直接调用 Wails 绑定，不走 IPC 客户端
 * 因为 DeepenRepo 是新增的 API，使用新的调用方式
 *
 * @param args.projectId 项目 ID
 * @param args.deepenBy 增加的深度（默认 50）
 */
export async function deepenRepo(args: {
  projectId: string;
  deepenBy?: number;
}): Promise<{
  success: boolean;
  message: string;
}> {
  // 动态导入 Wails 绑定（路径相对于 frontend 目录）
  const { DeepenRepo } = await import('../../wailsjs/wailsjs/go/main/App');
  return DeepenRepo(args);
}

/**
 * v1.5.3 应用工作区：读当前 workspace 路径
 *
 * main 端 lazy init 后返回 prefs.app.workspacePath（默认 ~/.gitea-kanban/workspace）
 */
export function commitsGitgraphGetWorkspace(): Promise<{
  cwd: string;
  isDefault: boolean;
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
export function commitsGitgraphSetWorkspace(args: {
  cwd: string;
}): Promise<{ cwd: string; suggestedRepoCwdTemplate: string }> {
  return getIpcClient().invoke('commits', 'gitgraphSetWorkspace', args);
}

/**
 * v1.6 workspace 迁移：列出旧工作区里的仓库
 *
 * @param args.cwd 旧工作区根目录
 * @returns repos 列表（名称 + 路径 + 大小）+ 总大小
 */
export function commitsGitgraphListWorkspaceRepos(args: {
  cwd: string;
}): Promise<{
  repos: Array<{ name: string; fullPath: string; sizeBytes: number }>;
  totalSizeBytes: number;
}> {
  return getIpcClient().invoke('commits', 'gitgraphListWorkspaceRepos', args);
}

/**
 * v1.6 workspace 迁移：从旧工作区复制仓库到新工作区
 *
 * 每复制完一个仓库会通过 event:workspace:migrateProgress 推进度。
 *
 * @param args.oldCwd 旧工作区路径
 * @param args.newCwd 新工作区路径
 * @param args.repoNames 要迁移的仓库目录名列表
 * @returns { migratedCount, failed }
 */
export function commitsGitgraphMigrateWorkspace(args: {
  oldCwd: string;
  newCwd: string;
  repoNames: string[];
}): Promise<{ migratedCount: number; failed: Record<string, string> }> {
  return getIpcClient().invoke('commits', 'gitgraphMigrateWorkspace', args);
}

/**
 * v1.6 workspace 迁移：在系统文件管理器中打开目录
 *
 * @param args.path 要打开的目录路径
 */
export function commitsGitgraphOpenDirectory(args: { path: string }): Promise<void> {
  return getIpcClient().invoke('commits', 'gitgraphOpenDirectory', args);
}

/**
 * v1.6 监听 workspace 迁移进度（main → renderer 推送事件）
 *
 * @returns off() 取消监听函数
 */
export function onWorkspaceMigrateProgress(
  cb: (payload: {
    current: number;
    total: number;
    repoName: string;
    phase: 'copying' | 'done' | 'error';
    error?: string;
  }) => void,
): () => void {
  return getIpcClient().on('workspace:migrateProgress', cb as (payload: unknown) => void);
}

// ============================================================
// ===== preferences.* （v1.1.3 提交号 / 分支名复制）=====
// ============================================================

/** 写系统剪贴板（v1.1.3）—— 走主进程 electron.clipboard.writeText
 *
 * 选 IPC 而非 navigator.clipboard.writeText 的原因（task #20）：
 * 1) Electron renderer 窗口无 focus / 非用户激活时 navigator.clipboard.writeText
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
// ===== system.* （Electron 系统级能力）=====
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

// ============================================================
// ===== pulls.* （A3 补：前端 wrapper，让 MergesView 能调） =====
// ============================================================

/** 合并请求 state（与 src/main/ipc/schema.ts PullStateSchema 同步）
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
  assignee: string;
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

// ============================================================
// ===== board.columns.* （ADR-0002 reset 后 8 个端点，v1.4 加 reset） =====
// ============================================================

/**列出某 project 的看板列 */
export function boardColumnsList(args: { projectId: string }): Promise<ColumnDto[]> {
  return getIpcClient().invokeNested('board', 'columns', 'list', args);
}

/** 新建看板列 */
export function boardColumnsCreate(args: {
  projectId: string;
  title: string;
  position: number;
}): Promise<ColumnDto> {
  return getIpcClient().invokeNested('board', 'columns', 'create', args);
}

/** 更新看板列（标题 /位置） */
export function boardColumnsUpdate(args: {
  columnId: string;
  patch: { title?: string; position?: number };
}): Promise<ColumnDto> {
  return getIpcClient().invokeNested('board', 'columns', 'update', args);
}

/** 列重排序（拖动列头） */
export function boardColumnsReorder(args: {
  projectId: string;
  orderedIds: string[];
}): Promise<ColumnDto[]> {
  return getIpcClient().invokeNested('board', 'columns', 'reorder', args);
}

/** 删除看板列（**危险操作**，UI 必须二次确认） */
export function boardColumnsDelete(args: { columnId: string }): Promise<void> {
  return getIpcClient().invokeNested('board', 'columns', 'delete', args);
}

/**
 * v1.4 增量 · 拍板 2026-06-16 user 拍板"重建视图"按钮
 * 重置 project 的列 + 重新跑 autoInit
 * @returns { resetCount, autoInitCreatedCount } 给前端 toast 文案
 */
export function boardColumnsReset(args: { projectId: string }): Promise<{ resetCount: number }> {
  return getIpcClient().invokeNested('board', 'columns', 'reset', args) as Promise<{
    resetCount: number;
    autoInitCreatedCount: number;
  }>;
}

/** 列绑一个 gitea label（issue 带这个 label 就属于这个列）
 *
 *  2026-06-15 Gitea 优先原则：后端调 gitea 校验 label 真实存在后写 localStore；
 *  返 ColumnDto 含 gitea 实时 name/color（caller 不必再用 labelsList 补 color）
 */
export function boardColumnsMapLabel(args: {
  columnId: string;
  giteaLabelId: number;
  giteaLabelName: string;
}): Promise<ColumnDto> {
  return getIpcClient().invokeNested('board', 'columns', 'mapLabel', args);
}

/** 列解绑一个 gitea label */
export function boardColumnsUnmapLabel(args: {
  columnId: string;
  giteaLabelId: number;
}): Promise<ColumnDto> {
  return getIpcClient().invokeNested('board', 'columns', 'unmapLabel', args);
}

// ============================================================
// ===== issues.* （ADR-0002 reset：卡片 = gitea issue） =====
// ============================================================

/**列出某 project 的 issue（按 columnId过滤走 column_label_mapping）
 *
 * A3 扩展：支持 assignee 过滤（"我的卡片"用，传当前用户名）；
 * 后端 schema 已加 `assignee?: string` 字段（透传到 gitea /issues?assignee=）。
 *
 * v1 简化：assignee 用 gitea username 字符串（不是 userId）—— main 端调
 * gitea api.repos.repoListIssues(..., { assignee }) 时 gitea-js 自己处理。
 */
export function issuesList(args: {
  projectId: string;
  columnId?: string;
  state?: 'open' | 'closed' | 'all';
  labelIds?: number[];
  q?: string;
  /** gitea username 字符串（**不**是 userId）—— "我的卡片" 传当前用户 login */
  assignee?: string;
  page?: number;
  limit?: number;
}): Promise<ListIssuesResp> {
  return getIpcClient().invoke('issues', 'list', args);
}

/**拿单个 issue详情 */
export function issuesGet(args: { projectId: string; issueIndex: number }): Promise<IssueCardDto> {
  return getIpcClient().invoke('issues', 'get', args);
}

/** 新建 issue（**看板列绑 label 时 labelIds 必填**）
 * v1.4 扩展：支持 milestoneId（里程碑 id）+ assignees（gitea username 列表） */
export function issuesCreate(args: {
  projectId: string;
  title: string;
  body?: string;
  labelIds?: number[];
  milestoneId?: number;
  assignees?: string[];
  /** v1.4：关联分支（gitea ref 字段，必填） */
  refBranch: string;
}): Promise<IssueCardDto> {
  return getIpcClient().invoke('issues', 'create', args);
}

/** 更新 issue（标题 / 正文 /状态 /关联分支） */
export function issuesUpdate(args: {
  projectId: string;
  issueIndex: number;
  patch: { title?: string; body?: string; state?: 'open' | 'closed'; refBranch?: string };
}): Promise<IssueCardDto> {
  return getIpcClient().invoke('issues', 'update', args);
}

/** issue 加 label */
export function issuesAddLabel(args: {
  projectId: string;
  issueIndex: number;
  labelId: number;
}): Promise<void> {
  return getIpcClient().invoke('issues', 'addLabel', args);
}

/** issue 去 label */
export function issuesRemoveLabel(args: {
  projectId: string;
  issueIndex: number;
  labelId: number;
}): Promise<void> {
  return getIpcClient().invoke('issues', 'removeLabel', args);
}

/**
 *看板拖拽换列专用端点（原子换绑 label）
 *
 * 后端事务：把 fromColumn绑的 labels 全 remove + toColumn绑的 labels 全 add。
 *失败回滚（在 store 层做）。
 */
export function issuesMoveColumn(args: {
  projectId: string;
  issueIndex: number;
  fromColumnId: string;
  toColumnId: string;
}): Promise<void> {
  return getIpcClient().invoke('issues', 'moveColumn', args);
}

/**
 * 列评论（issue 或合并请求 —— gitea 共享 /repos/{owner}/{repo}/issues/{index}/comments 端点，
 * 合并请求的 index 与 issue 在同一编号空间，所以这个 wrapper 直接复用到合并请求评论）。
 *
 * v1.2 合并请求对话：MergesView 手风琴展开时拉一次，发送评论后再拉一次（策略：展开时拉一次 + 发送后刷新）。
 *
 * @param issueIndex issue 或合并请求的 index（合并请求也是这个数字）
 */
export function issuesCommentList(args: {
  projectId: string;
  issueIndex: number;
}): Promise<IssueCommentDto[]> {
  return getIpcClient().invokeNested('issues', 'comment', 'list', args);
}

/**
 * 发评论（issue 或合并请求）
 *
 * IPC 边界：body 必须是非空字符串（schema NonEmptyStringSchema），渲染端要先 trim。
 * 后端会同步到 gitea 并返回 IssueCommentDto；前端在发送成功后 refresh 评论列表拿到权威回复。
 */
export function issuesCommentCreate(args: {
  projectId: string;
  issueIndex: number;
  body: string;
}): Promise<IssueCommentDto> {
  return getIpcClient().invokeNested('issues', 'comment', 'create', args);
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
 * A3 拍板：channel = `members.list`，后端 src/main/gitea/repos.ts listRepoCollaborators 包装。
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
