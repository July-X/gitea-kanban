/**
 * 统一 IPC 错误格式
 *
> **⚠️ 2026-07-01 注释更新（v0.3.0 梳理）**：本文件早期注释引用的 `docs/design/02-architecture.md §5.2/§5.4`（已 DEPRECATED）和 `src/main/ipc/schema.ts`（v2.0 已删除）和 `@napi-rs/keyring`（v2.0 改 zalando/go-keyring）和 `ipcMain.handle`（v2.0 是 Wails binding）已不再适用。当前实现：
> - 错误定义：`app/platform/errors.go`（Go 端 `PlatformError` 类型）+ `app/store/errors.go`（业务错误）
> - 前后端共享：本文件（TypeScript 端）+ Go 端 `app/shared/errors.go`（v2.0 重写）
> - 错误码语义保持不变（unauthenticated / token_invalid / permission_denied / not_found / conflict / rate_limited / network_offline / validation_failed / internal / platform_error 等）
 *
 * 关键约束（来自 AGENTS.md §8.1 鉴权铁律）：
 * - 错误码始终 snake_case 英文，**不做** i18n
 * - message 用 i18n key 占位（zh-Hans / en 由前端按 locale 翻译）
 * - 业务错误 throw PlatformError；底层 Gitea/GitHub 错误码由平台 Adapter `mapHTTPError` 映射
 *
 * 增加/修改错误码 = IPC schema 变更，按 AGENTS.md §13 不决事项需用户拍板。
 */

/**
 * 业务错误码（snake_case 字符串值）
 *
 * 历史来源（v1 时代）：
 * - 02-architecture.md §5.4 的 10 个原始常量：
 *   unauthenticated / token_invalid / permission_denied / not_found /
 *   conflict / rate_limited / network_offline / gitea_error /
 *   validation_failed / internal
 * - docs/adr/0001-keychain.md §"需更新的下游文件" 的 2 个新增常量（v1 候选，v2.0 改 zalando/go-keyring 后由 Go 端自己处理 keychain 错误）：
 *   keychain_unavailable / keychain_access_denied
 * - v1.1.2 主题切换（plan_96625ed5 theme-ipc，2026-06-12）的 4 个新增常量：
 *   theme_not_found / invalid_theme / database_unavailable / database_write_failed
 *   —— v2.0 起主题 IPC 直接走 preferences.* 命名空间；'database_unavailable' 改为 'storage_unavailable'
 *
 * v2.0 起实际生效错误码（以 Wails 生成的类型 + Go 端 `app/shared/errors.go` 为准）：
 * - unauthenticated / token_invalid / permission_denied / not_found / conflict / rate_limited
 * - network_offline / platform_error（原 gitea_error，v2.0 多平台抽象后改名）/ validation_failed / internal
 * - keychain_error（v2.0 统一 Go 端 keychain 错误，代替 v1 的 2 个细分常量）
 * - storage_unavailable / storage_write_failed（v2.0 JSON 文件存储错误，代替 v1 database_*）
 */
export const IpcErrorCode = {
  // === 业务错误（02-architecture.md §5.4 原始 10 个）===
  /** 没接 gitea / token 失效 */
  UNAUTHENTICATED: 'unauthenticated',
  /** 401 from gitea */
  TOKEN_INVALID: 'token_invalid',
  /** 403 from gitea；或本地权限校验失败 */
  PERMISSION_DENIED: 'permission_denied',
  /** 404 */
  NOT_FOUND: 'not_found',
  /** 409 */
  CONFLICT: 'conflict',
  /** 429 */
  RATE_LIMITED: 'rate_limited',
  /** 网络断开 / 远程不可达 */
  NETWORK_OFFLINE: 'network_offline',
  /** 其他 5xx 或 gitea 业务错误 */
  GITEA_ERROR: 'gitea_error',
  /** Zod schema 校验失败 */
  VALIDATION_FAILED: 'validation_failed',
  /** 本地 bug */
  INTERNAL: 'internal',

  // === 鉴权铁律新增（ADR-0001 §"需更新的下游文件"）===
  /** 系统 keychain 不可用（Linux 无 dbus + 无 kwallet/gnome-libsecret） */
  KEYCHAIN_UNAVAILABLE: 'keychain_unavailable',
  /** 系统 keychain 拒绝访问（Windows ACL 拒绝 / macOS Keychain 拒绝） */
  KEYCHAIN_ACCESS_DENIED: 'keychain_access_denied',

  // === v0.7.20 新增：GitHub CLI 未安装 ===
  /** 系统未安装 GitHub CLI（gh）；同步失败时前端展示引导安装按钮 */
  GH_NOT_INSTALLED: 'gh_not_installed',

} as const;

export type IpcErrorCodeValue = (typeof IpcErrorCode)[keyof typeof IpcErrorCode];

/**
 * 统一 IPC 错误对象（class 同时作为类型，TS 允许）
 *
 * 所有 IPC handler 失败时 throw IpcError 实例；
 * preload 桥把它转成 typed reject → 渲染进程 catch 后按 code + hint 展示。
 *
 * 选 class 而不是 interface/type：
 * - 可以在 ipcMain.handle 入口统一 try/catch 抓
 * - 可以 instanceof 判断避免误抓别的 Error
 * - 序列化时通过 .toJSON() 转 IpcError 结构
 */
export class IpcError extends Error {
  /** 业务错误码（snake_case 英文，**不**做 i18n） */
  public readonly code: IpcErrorCodeValue;
  /** 已"人话化"的中文/英文消息（i18n key 形式） */
  public override readonly message: string;
  /** 建议下一步操作（人话） */
  public readonly hint?: string;
  /** 原始错误信息（开发模式可见，生产折叠） */
  public override readonly cause?: string;
  /** 来自 gitea HTTP 时透传状态码 */
  public readonly httpStatus?: number;

  constructor(args: {
    code: IpcErrorCodeValue;
    message: string;
    hint?: string;
    cause?: string;
    httpStatus?: number;
  }) {
    super(args.message);
    this.name = 'IpcError';
    this.code = args.code;
    this.message = args.message;
    if (args.hint !== undefined) this.hint = args.hint;
    if (args.cause !== undefined) this.cause = args.cause;
    if (args.httpStatus !== undefined) this.httpStatus = args.httpStatus;
  }

  /**
   * 序列化为跨 IPC 边界传输的纯对象（结构化 IpcError，不含 name/toJSON）
   *
   * 故意用单独的接口定义，避免循环依赖（class 自身的 typeof 也包含 name/toJSON）。
   */
  toJSON(): IpcErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.cause !== undefined ? { cause: this.cause } : {}),
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
    };
  }
}

/**
 * 跨 IPC 边界传输的纯对象形态（不含 name/toJSON 运行时元数据）
 */
export interface IpcErrorPayload {
  code: IpcErrorCodeValue;
  message: string;
  hint?: string;
  cause?: string;
  httpStatus?: number;
}

/**
 * 类型守卫：unknown 是不是 IpcError
 */
export function isIpcError(err: unknown): err is IpcError {
  return err instanceof IpcError;
}

/**
 * 工厂：Zod 校验失败时统一抛 VALIDATION_FAILED
 *
 * 业务代码用法：
 *   const args = ConnectArgsSchema.parse(rawArgs);
 *
 * 抛错统一走这个工厂，保证 message / hint 文案一致。
 */
export function validationFailed(message: string, cause?: string): IpcError {
  return new IpcError({
    code: IpcErrorCode.VALIDATION_FAILED,
    message,
    ...(cause !== undefined ? { cause } : {}),
    hint: '请检查输入参数',
  });
}
