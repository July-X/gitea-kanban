import { app, BrowserWindow, shell, session, ipcMain, clipboard } from "electron";
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, isAbsolute, dirname, basename } from "node:path";
import os from "node:os";
import { pino } from "pino";
import { z } from "zod";
import { appendFile, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { Api } from "gitea-js";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const APP_SINGLE_INSTANCE_LOCK_NAME = "io.gitea-kanban.app.single-instance";
const APP_NAME = "gitea-kanban";
const LOG_SUBDIR = "main";
const LOG_RETENTION_DAYS = 14;
const KEYCHAIN_SERVICE_PREFIX = "gitea-kanban@";
const isDev$1 = !app.isPackaged;
const REDACT_PATHS = [
  "*.token",
  "*.password",
  "*.key",
  "token",
  "password",
  "*.apiKey",
  "apiKey",
  "*.secret",
  "secret",
  "req.headers.authorization",
  'res.headers["set-cookie"]'
];
function resolveDataRoot() {
  const fromEnv = process.env.GITEA_KANBAN_DATA_DIR;
  if (fromEnv) {
    if (!isAbsolute(fromEnv)) {
      throw new Error(`GITEA_KANBAN_DATA_DIR must be absolute, got: ${fromEnv}`);
    }
    return fromEnv;
  }
  return join(os.homedir(), ".gitea-kanban");
}
const baseOptions = {
  level: isDev$1 ? "debug" : "info",
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]"
  },
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime
};
function buildLogger() {
  if (isDev$1) {
    const candidates = [
      join(resolveDataRoot(), "logs", LOG_SUBDIR),
      "/tmp/gitea-kanban-logs"
    ];
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    for (const logDir of candidates) {
      try {
        mkdirSync(logDir, { recursive: true, mode: 448 });
        const probePath = join(logDir, `.probe-${process.pid}-${Date.now()}`);
        const fd = require2("node:fs").openSync(probePath, "a");
        require2("node:fs").closeSync(fd);
        require2("node:fs").unlinkSync(probePath);
        const filename = join(logDir, `main-${date}.log`);
        cleanupOldLogs(logDir);
        return pino({
          ...baseOptions
        }, pino.destination({
          dest: filename,
          sync: true,
          mkdir: true,
          mode: 384
        }));
      } catch (err) {
      }
    }
    return pino({ ...baseOptions, level: "silent" });
  }
  return pino(baseOptions);
}
const logger = buildLogger();
function upgradeLoggerToFile() {
  logger.info("upgradeLoggerToFile: skipped (logger already at file destination from module init)");
}
function cleanupOldLogs(logDir) {
  try {
    const { readdirSync: readdirSync2, statSync: statSync2, unlinkSync: unlinkSync2 } = require2("node:fs");
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    for (const name of readdirSync2(logDir)) {
      if (!name.startsWith("main-") || !name.endsWith(".log")) continue;
      const path = join(logDir, name);
      try {
        const stat = statSync2(path);
        if (stat.mtimeMs < cutoff) {
          unlinkSync2(path);
        }
      } catch {
      }
    }
  } catch {
  }
}
const isDev = !app.isPackaged;
if (isDev) {
  app.commandLine.appendSwitch("remote-debugging-port", "9492");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}
let mainWindow = null;
let cspInstalled = false;
const THEME_BOOTSTRAP_SCRIPT_HASH = "'sha256-rMbhPi4NswJ523U4ASP2f+qLN64S5J0P/JJN5QKCkp4='";
function expandLoopbackOrigins(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      const pair = new URL(rawUrl);
      pair.hostname = host === "localhost" ? "127.0.0.1" : "localhost";
      return [u.origin, pair.origin];
    }
    return [u.origin];
  } catch {
    return [rawUrl];
  }
}
function installCspHeader(giteaUrl = null) {
  const giteaOrigins = giteaUrl ? expandLoopbackOrigins(giteaUrl) : [];
  const giteaOriginList = giteaOrigins.join(" ");
  const connectSrc = giteaOrigins.length ? `'self' ${giteaOriginList}` : "'self'";
  const imgSrc = giteaOrigins.length ? `'self' data: https: ${giteaOriginList}` : "'self' data: https:";
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${THEME_BOOTSTRAP_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    `img-src ${imgSrc}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
  if (cspInstalled) {
    session.defaultSession.webRequest.onHeadersReceived(null);
  }
  const cspListener = (details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp]
      }
    });
  };
  session.defaultSession.webRequest.onHeadersReceived(cspListener);
  cspInstalled = true;
  logger.info({ csp }, "CSP header installed");
}
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  installCspHeader();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 加载完再 show，避免白屏
    backgroundColor: "#1a1a1a",
    // 与设计系统暗色主题 bg 一致
    title: "gitea-kanban",
    webPreferences: {
      // === 安全铁律（AGENTS.md §4.7） ===
      // contextIsolation / nodeIntegration 始终写死；sandbox 仅 prod 启用
      // （dev 模式 macOS 没签名 sandbox 启动会报 "Operation not permitted" → GPU/network 链式 crash）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !isDev,
      // preload 脚本（IPC bridge 唯一通道）
      // 产物名 `.cjs` —— 配合 electron.vite.config.ts 的 `output.format: 'cjs'`
      // sandboxed preload 必须 CJS bundle（V8 加载 .mjs 强制 module 模式，
      // 与 sandboxed preload 的 classic-script 上下文不兼容；详见
      // electron.vite.config.ts 注释 + AGENTS.md §8）
      preload: join(__dirname, "../preload/index.cjs"),
      // 关闭 webSecurity 会放开 CORS；这里**不**关
      webSecurity: true
    }
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (isDev && devUrl) {
    logger.info({ devUrl }, "loading renderer from dev server");
    mainWindow.loadURL(devUrl);
  } else {
    const indexPath = join(__dirname, "../renderer/index.html");
    logger.info({ indexPath }, "loading renderer from file");
    mainWindow.loadFile(indexPath);
  }
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logger.info({ url }, "window.open intercepted");
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl2 = process.env["ELECTRON_RENDERER_URL"];
    if (isDev && devUrl2 && url.startsWith(devUrl2)) return;
    if (url.startsWith("file://")) return;
    event.preventDefault();
    logger.info({ url }, "navigation intercepted");
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  logger.info("main window created");
  return mainWindow;
}
function destroyMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  mainWindow = null;
}
const IpcErrorCode = {
  // === 业务错误（02-architecture.md §5.4 原始 10 个）===
  /** 没接 gitea / token 失效 */
  UNAUTHENTICATED: "unauthenticated",
  /** 401 from gitea */
  TOKEN_INVALID: "token_invalid",
  /** 403 from gitea；或本地权限校验失败 */
  PERMISSION_DENIED: "permission_denied",
  /** 404 */
  NOT_FOUND: "not_found",
  /** 409 */
  CONFLICT: "conflict",
  /** 429 */
  RATE_LIMITED: "rate_limited",
  /** 网络断开 / 远程不可达 */
  NETWORK_OFFLINE: "network_offline",
  /** 其他 5xx 或 gitea 业务错误 */
  GITEA_ERROR: "gitea_error",
  /** Zod schema 校验失败 */
  VALIDATION_FAILED: "validation_failed",
  /** 本地 bug */
  INTERNAL: "internal",
  // === 鉴权铁律新增（ADR-0001 §"需更新的下游文件"）===
  /** 系统 keychain 不可用（Linux 无 dbus + 无 kwallet/gnome-libsecret） */
  KEYCHAIN_UNAVAILABLE: "keychain_unavailable",
  /** 系统 keychain 拒绝访问（Windows ACL 拒绝 / macOS Keychain 拒绝） */
  KEYCHAIN_ACCESS_DENIED: "keychain_access_denied",
  // === v1.1.2 主题切换新增（plan_96625ed5 theme-ipc）===
  /**
   * preferences.theme.get：row 存在但 value 不可解析（JSON 烂 / 字段不对 / 不是 enum 3 选 1）
   * —— 跟 NOT_FOUND 区分：NOT_FOUND 是"业务实体不存在"（如 projectId 找不到）；
   *    THEME_NOT_FOUND 是"偏好值存在但语义损坏"
   * —— 触发条件：sqlite row 存在但 JSON.parse 失败 / parse 后 theme 字段不在 enum 3 选 1
   */
  THEME_NOT_FOUND: "theme_not_found",
  /**
   * preferences.theme.set：theme 不是合法 3 选 1（防御代码）
   * —— 实际不可达：Zod z.enum() 在 IPC 入口先 reject 抛 VALIDATION_FAILED
   * —— 保留此常量供业务层 direct caller（如 store 直接调 setTheme 跳过 IPC）做断言用
   */
  INVALID_THEME: "invalid_theme"
};
class IpcError extends Error {
  /** 业务错误码（snake_case 英文，**不**做 i18n） */
  code;
  /** 已"人话化"的中文/英文消息（i18n key 形式） */
  message;
  /** 建议下一步操作（人话） */
  hint;
  /** 原始错误信息（开发模式可见，生产折叠） */
  cause;
  /** 来自 gitea HTTP 时透传状态码 */
  httpStatus;
  constructor(args) {
    super(args.message);
    this.name = "IpcError";
    this.code = args.code;
    this.message = args.message;
    if (args.hint !== void 0) this.hint = args.hint;
    if (args.cause !== void 0) this.cause = args.cause;
    if (args.httpStatus !== void 0) this.httpStatus = args.httpStatus;
  }
  /**
   * 序列化为跨 IPC 边界传输的纯对象（结构化 IpcError，不含 name/toJSON）
   *
   * 故意用单独的接口定义，避免循环依赖（class 自身的 typeof 也包含 name/toJSON）。
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.hint !== void 0 ? { hint: this.hint } : {},
      ...this.cause !== void 0 ? { cause: this.cause } : {},
      ...this.httpStatus !== void 0 ? { httpStatus: this.httpStatus } : {}
    };
  }
}
function validationFailed(message, cause) {
  return new IpcError({
    code: IpcErrorCode.VALIDATION_FAILED,
    message,
    ...cause !== void 0 ? { cause } : {},
    hint: "请检查输入参数"
  });
}
const IpcChannel = {
  // === auth namespace（02-architecture.md §5.3.1）===
  AUTH_CONNECT: "auth.connect",
  AUTH_DISCONNECT: "auth.disconnect",
  AUTH_STATUS: "auth.status",
  // === repos namespace（02-architecture.md §5.3.1）===
  REPOS_LIST: "repos.list",
  REPOS_ADD_PROJECT: "repos.addProject",
  REPOS_REMOVE_PROJECT: "repos.removeProject",
  // === branches namespace（02-architecture.md §5.3.2）===
  // 破坏性操作清理（2026-06-15 用户拍板）：create/delete 已从 App 移除，保留 list/rename/star
  BRANCHES_LIST: "branches.list",
  BRANCHES_RENAME: "branches.rename",
  BRANCHES_STAR: "branches.star",
  // === commits namespace（02-architecture.md §5.3.3 + §5.3.4）===
  COMMITS_LIST: "commits.list",
  COMMITS_GET: "commits.get",
  COMMITS_TIMELINE: "commits.timeline",
  // === pulls namespace（02-architecture.md §5.3.5 + §5.3.6）===
  // 破坏性操作清理（2026-06-15 用户拍板）：create 已从 App 移除，保留 list/get/merge/close
  PULLS_LIST: "pulls.list",
  PULLS_GET: "pulls.get",
  PULLS_MERGE: "pulls.merge",
  PULLS_CLOSE: "pulls.close",
  PULLS_UPDATE_LABELS: "pulls.updateLabels",
  PULLS_UPDATE_ASSIGNEE: "pulls.updateAssignee",
  PULLS_UPDATE_REVIEWERS: "pulls.updateReviewers",
  // === board.columns namespace（ADR-0002 reset）===
  BOARD_COLUMNS_LIST: "board.columns.list",
  BOARD_COLUMNS_CREATE: "board.columns.create",
  BOARD_COLUMNS_UPDATE: "board.columns.update",
  BOARD_COLUMNS_REORDER: "board.columns.reorder",
  BOARD_COLUMNS_DELETE: "board.columns.delete",
  BOARD_COLUMNS_MAP_LABEL: "board.columns.mapLabel",
  BOARD_COLUMNS_UNMAP_LABEL: "board.columns.unmapLabel",
  BOARD_COLUMNS_RESET: "board.columns.reset",
  // === issues namespace（ADR-0002 reset：卡片 = gitea issue）===
  ISSUES_LIST: "issues.list",
  ISSUES_GET: "issues.get",
  ISSUES_CREATE: "issues.create",
  ISSUES_UPDATE: "issues.update",
  ISSUES_ADD_LABEL: "issues.addLabel",
  ISSUES_REMOVE_LABEL: "issues.removeLabel",
  ISSUES_MOVE_COLUMN: "issues.moveColumn",
  // issues.comment 子命名空间（v1 与 issues 同 namespace暴露在 api.issues.comment）
  ISSUES_COMMENT_LIST: "issues.comment.list",
  ISSUES_COMMENT_CREATE: "issues.comment.create",
  // === labels namespace（ADR-0002：看板列绑 gitea label 用）===
  LABELS_LIST: "labels.list",
  LABELS_CREATE: "labels.create",
  // === members namespace（a3 新增：仓库成员 = gitea repo collaborators）===
  MEMBERS_LIST: "members.list",
  // === milestones namespace（v1.4 新增：新建议题弹窗选里程碑用）===
  MILESTONES_LIST: "milestones.list",
  // === user namespace（02-architecture.md §5.3.9；M5补齐 + M6 undo-by-project）===
  USER_PREFS_GET: "user.prefs.get",
  USER_PREFS_SET: "user.prefs.set",
  USER_UNDO: "user.undo",
  USER_REDO: "user.redo",
  USER_UNDO_STATUS: "user.undoStatus",
  // === preferences namespace（v1.1.2 主题切换 —— design-system/pages/tech-refine.md §16）===
  // 走 preferences.* 而非 theme.*，为后续"应用级偏好"（通知规则 / 同步周期 / 自定义快捷键等）留 namespace 空间。
  // 持久化走 sqlite prefs 表（M5 已建：key='theme'，value=JSON.stringify(theme)）。
  THEME_GET: "preferences.theme.get",
  THEME_SET: "preferences.theme.set",
  // 剪贴板写入（v1.1.3 提交号复制）—— 走主进程 electron.clipboard 模块，
  // 绕过 navigator.clipboard.writeText 在 Electron renderer 窗口无 focus / 非用户激活时的不稳定行为
  CLIPBOARD_WRITE: "preferences.clipboard.write"
};
const UuidSchema = z.string().uuid();
const NonEmptyStringSchema = z.string().min(1).max(1024);
const IsoDateSchema = z.string().datetime({ offset: true });
const GiteaUrlSchema = z.string().url().refine(
  (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "giteaUrl 必须是 http(s) URL" }
);
const TokenSchema = z.string().min(8, "token 长度至少 8").max(512, "token 长度不超过 512").transform((s) => s.trim());
const ConnectArgsSchema = z.object({
  giteaUrl: GiteaUrlSchema,
  token: TokenSchema
});
const UserDtoSchema = z.object({
  id: z.number().int().positive(),
  login: NonEmptyStringSchema,
  fullName: z.string().optional(),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional()
}).strict();
const GiteaAccountDtoSchema = z.object({
  id: UuidSchema,
  giteaUrl: z.string(),
  username: NonEmptyStringSchema,
  createdAt: IsoDateSchema
}).strict();
z.object({
  account: GiteaAccountDtoSchema,
  user: UserDtoSchema
}).strict();
const DisconnectArgsSchema = z.object({
  giteaUrl: GiteaUrlSchema
});
z.object({
  accounts: z.array(GiteaAccountDtoSchema),
  currentUser: UserDtoSchema.nullable()
}).strict();
const PermissionsSchema = z.object({
  pull: z.boolean(),
  push: z.boolean(),
  admin: z.boolean()
}).strict();
const RepoDtoSchema = z.object({
  id: z.number().int().positive(),
  owner: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  fullName: NonEmptyStringSchema,
  description: z.string().default(""),
  defaultBranch: NonEmptyStringSchema,
  archived: z.boolean(),
  private: z.boolean(),
  updatedAt: IsoDateSchema,
  permissions: PermissionsSchema,
  isProject: z.boolean().default(false),
  lastSyncAt: IsoDateSchema.optional()
}).strict();
z.object({
  id: NonEmptyStringSchema,
  giteaAccountId: NonEmptyStringSchema,
  owner: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  defaultBranch: z.string().nullable(),
  lastSyncAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema
}).strict();
const ListReposArgsSchema = z.object({
  giteaAccountId: NonEmptyStringSchema,
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  page: z.number().int().min(1).default(1)
}).strict();
z.object({
  items: z.array(RepoDtoSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  hasMore: z.boolean()
}).strict();
const AddProjectArgsSchema = z.object({
  giteaAccountId: NonEmptyStringSchema,
  owner: NonEmptyStringSchema,
  name: NonEmptyStringSchema
}).strict();
const RemoveProjectArgsSchema = z.object({
  projectId: NonEmptyStringSchema
}).strict();
const BranchLastCommitDtoSchema = z.object({
  sha: NonEmptyStringSchema,
  message: z.string(),
  author: z.string(),
  date: IsoDateSchema
}).strict();
const BranchDtoSchema = z.object({
  name: NonEmptyStringSchema,
  sha: NonEmptyStringSchema,
  protected: z.boolean(),
  isDefault: z.boolean(),
  starred: z.boolean().default(false),
  lastCommit: BranchLastCommitDtoSchema.optional()
}).strict();
const ListBranchesArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  page: z.number().int().min(1).default(1)
}).strict();
z.object({
  items: z.array(BranchDtoSchema),
  total: z.number().int().min(0),
  hasMore: z.boolean()
}).strict();
const RenameBranchArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  oldName: NonEmptyStringSchema,
  newName: NonEmptyStringSchema
}).strict();
const StarBranchArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  branch: NonEmptyStringSchema,
  starred: z.boolean()
}).strict();
const LinkedCardDtoSchema = z.object({
  cardId: NonEmptyStringSchema,
  columnName: NonEmptyStringSchema
}).strict();
const CommitAuthorDtoSchema = z.object({
  name: NonEmptyStringSchema,
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional()
}).strict();
const CommitCommitterDtoSchema = z.object({
  name: NonEmptyStringSchema,
  email: z.string().email().optional()
}).strict();
const CommitFileChangeDtoSchema = z.object({
  filename: z.string(),
  /** 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' —— gitea 原值 */
  status: z.string().optional(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  /** gitea 端 total changes（≠ additions+deletions，因 whitespace 等），按 gitea 原值存 */
  changes: z.number().int().min(0).optional(),
  /** 旧名（status=renamed 时才有） */
  previousFilename: z.string().optional(),
  /** 是否二进制 —— gitea 端 binary_file 字段 OR status='binary'（任一为真） */
  binary: z.boolean().optional(),
  /** hunk 头解析出的"改动函数/方法"列表（已按文件合并去重）；二进制文件不解析 */
  functions: z.array(z.string()).optional()
}).strict();
const CommitDtoSchema = z.object({
  sha: NonEmptyStringSchema,
  shortSha: NonEmptyStringSchema,
  message: z.string(),
  author: CommitAuthorDtoSchema,
  committer: CommitCommitterDtoSchema,
  date: IsoDateSchema,
  parents: z.array(NonEmptyStringSchema),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  filesChanged: z.number().int().min(0).optional(),
  /** 单条 commit 详情才返（list 端点不返）—— v1.1.3 task #23 */
  files: z.array(CommitFileChangeDtoSchema).optional(),
  linkedCards: z.array(LinkedCardDtoSchema).optional()
}).strict();
const ListCommitsArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  sha: z.string().optional(),
  path: z.string().optional(),
  author: z.string().optional(),
  since: IsoDateSchema.optional(),
  until: IsoDateSchema.optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();
z.object({
  items: z.array(CommitDtoSchema),
  total: z.number().int().min(0),
  hasMore: z.boolean(),
  nextPage: z.number().int().min(1).nullable()
}).strict();
const GetCommitArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  sha: NonEmptyStringSchema
}).strict();
const PullRefDtoSchema = z.object({
  ref: NonEmptyStringSchema,
  sha: NonEmptyStringSchema
}).strict();
const PullAuthorDtoSchema = z.object({
  username: NonEmptyStringSchema,
  avatarUrl: z.string().url().optional()
}).strict();
const PullStateSchema = z.enum(["open", "closed", "all"]);
const PullDtoSchema = z.object({
  index: z.number().int().positive(),
  title: NonEmptyStringSchema,
  state: PullStateSchema,
  draft: z.boolean(),
  merged: z.boolean(),
  head: PullRefDtoSchema,
  base: PullRefDtoSchema,
  author: PullAuthorDtoSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  mergeable: z.boolean(),
  hasConflicts: z.boolean(),
  linkedCards: z.array(LinkedCardDtoSchema).optional(),
  // ===== v1.1 补充字段（对齐 gitea PR 详情页属性块） =====
  labels: z.array(z.object({ id: z.number(), name: z.string(), color: z.string() })).optional(),
  milestone: z.object({ id: z.number(), title: z.string() }).nullable().optional(),
  assignee: z.object({ username: z.string() }).nullable().optional(),
  assignees: z.array(z.object({ username: z.string() })).optional(),
  reviewers: z.array(z.object({ username: z.string() })).optional(),
  mergedBy: z.object({ username: z.string() }).nullable().optional(),
  commentsCount: z.number().int().optional(),
  body: z.string().optional()
}).strict();
const ListPullsArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  state: PullStateSchema.optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  author: z.string().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();
z.object({
  items: z.array(PullDtoSchema),
  total: z.number().int().min(0),
  hasMore: z.boolean()
}).strict();
const GetPullArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  index: z.number().int().positive()
}).strict();
const MergeMethodSchema = z.enum([
  "merge",
  "rebase",
  "rebase-merge",
  "squash"
]).describe(
  [
    'merge        → "普通合并（保留所有提交历史）"',
    'rebase       → "变基后快进（重写历史，单一线性）"',
    'rebase-merge → "变基后 merge commit（重写历史 + 保留 merge commit）"',
    'squash       → "压缩为单提交（合并请求内 N 个提交合成 1 个）"'
  ].join("\n")
);
const MergePrArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  index: z.number().int().positive(),
  method: MergeMethodSchema,
  deleteBranchAfter: z.boolean().optional(),
  commitMessage: z.string().optional()
}).strict().refine(
  (a) => {
    if (a.method === "squash") {
      return typeof a.commitMessage === "string" && a.commitMessage.length > 0;
    }
    return true;
  },
  {
    message: "method=squash 时 commitMessage 必填",
    path: ["commitMessage"]
  }
);
z.object({
  /** 合并后的 commit SHA（gitea 合并成功时可能返回空 body，此时为空字符串） */
  sha: z.string(),
  merged: z.boolean(),
  message: z.string()
}).strict();
const ClosePrArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  index: z.number().int().positive(),
  /** 关闭原因（可选，传给 gitea 的 comment body） */
  reason: z.string().optional()
}).strict();
const UpdatePullLabelsArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  index: z.number().int().positive(),
  labels: z.array(z.string())
}).strict();
const UpdatePullAssigneeArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  index: z.number().int().positive(),
  assignee: z.string()
}).strict();
const UpdatePullReviewersArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  index: z.number().int().positive(),
  reviewers: z.array(z.string())
}).strict();
const ColumnLabelDtoSchema = z.object({
  id: z.number().int().positive(),
  // gitea label id
  name: NonEmptyStringSchema,
  color: z.string()
}).strict();
const WipLimitSchema = z.union([z.number().int().positive(), z.null()]).describe("WIP 上限：正整数 = 上限，null = 无限");
z.object({
  id: NonEmptyStringSchema,
  projectId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  position: z.number().int().min(0),
  labels: z.array(ColumnLabelDtoSchema),
  wipLimit: WipLimitSchema.optional()
}).strict();
const ListBoardColumnsArgsSchema = z.object({
  projectId: NonEmptyStringSchema
}).strict();
const CreateBoardColumnArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  position: z.number().int().min(0)
}).strict();
const UpdateBoardColumnArgsSchema = z.object({
  columnId: NonEmptyStringSchema,
  patch: z.object({
    title: NonEmptyStringSchema.optional(),
    position: z.number().int().min(0).optional(),
    wipLimit: WipLimitSchema.optional()
  }).strict().refine(
    (p) => p.title !== void 0 || p.position !== void 0 || p.wipLimit !== void 0,
    {
      message: "patch 必须至少含一个字段"
    }
  )
}).strict();
const ReorderBoardColumnsArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  orderedIds: z.array(NonEmptyStringSchema).min(1)
}).strict();
const DeleteBoardColumnArgsSchema = z.object({
  columnId: NonEmptyStringSchema
}).strict();
const ResetBoardColumnsArgsSchema = z.object({
  projectId: NonEmptyStringSchema
}).strict();
z.object({
  resetCount: z.number().int().min(0)
});
const MapColumnLabelArgsSchema = z.object({
  columnId: NonEmptyStringSchema,
  giteaLabelId: z.number().int().positive(),
  giteaLabelName: NonEmptyStringSchema
}).strict();
const UnmapColumnLabelArgsSchema = z.object({
  columnId: NonEmptyStringSchema,
  giteaLabelId: z.number().int().positive()
}).strict();
const IssueStateSchema = z.enum(["open", "closed", "all"]);
const IssueLabelDtoSchema = z.object({
  id: z.number().int().positive(),
  name: NonEmptyStringSchema,
  color: z.string(),
  description: z.string().optional()
}).strict();
const IssueAuthorDtoSchema = z.object({
  username: NonEmptyStringSchema,
  fullName: z.string().optional(),
  avatarUrl: z.string().url().optional()
}).strict();
const IssueCardDtoSchema = z.object({
  id: z.number().int().positive(),
  index: z.number().int().positive(),
  title: NonEmptyStringSchema,
  body: z.string(),
  state: z.enum(["open", "closed"]),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  author: IssueAuthorDtoSchema,
  labels: z.array(IssueLabelDtoSchema),
  /**
  * true 当 gitea response包含非空 pull_request（gitea 把 PR 也列在 /issues）；
  *看板拖拽换列时只对纯 issue生效。
  */
  isPullRequest: z.boolean(),
  /** v1.4：gitea issue ref 字段（关联分支/Git 标签），无关联时为空串 */
  refBranch: z.string().default("")
}).strict();
const ListIssuesArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  columnId: NonEmptyStringSchema.optional(),
  state: IssueStateSchema.optional(),
  labelIds: z.array(z.number().int().positive()).optional(),
  q: z.string().optional(),
  /**
   * gitea username 字符串（**不**是 userId）—— "我的卡片"视图用。
   * 透传到 gitea `/issues?assigned_by=<username>`。
   * 不传 = 走原行为（不过滤 assignee，向后兼容）。
   *
   * a3 拍板：gitea 端不识别 'me' magic string，业务层（IPC handler / store）
   * 拿到 'me' 后必须先 resolve 成当前连接 username 再传进来。
   */
  assignee: z.string().min(1).optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();
z.object({
  items: z.array(IssueCardDtoSchema),
  hasMore: z.boolean()
}).strict();
const GetIssueArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  issueIndex: z.number().int().positive()
}).strict();
const CreateIssueArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  body: z.string().optional(),
  labelIds: z.array(z.number().int().positive()).optional(),
  /** v1.4 新增：里程碑 id（gitea issueCreateIssue 的 milestone 字段） */
  milestoneId: z.number().int().positive().optional(),
  /** v1.4 新增：指派人 gitea username 列表（gitea issueCreateIssue 的 assignees 字段） */
  assignees: z.array(NonEmptyStringSchema).optional(),
  /** v1.4 新增：关联分支（gitea issueCreateIssue 的 ref 字段，必填） */
  refBranch: NonEmptyStringSchema
}).strict();
const UpdateIssueArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  issueIndex: z.number().int().positive(),
  patch: z.object({
    title: NonEmptyStringSchema.optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
    /** v1.4 新增：关联分支（gitea issueEditIssue 的 ref 字段） */
    refBranch: z.string().optional()
  }).strict().refine(
    (p) => p.title !== void 0 || p.body !== void 0 || p.state !== void 0 || p.refBranch !== void 0,
    { message: "patch 必须至少含一个字段" }
  )
}).strict();
const IssueLabelActionArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  issueIndex: z.number().int().positive(),
  labelId: z.number().int().positive()
}).strict();
const MoveIssueColumnArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  issueIndex: z.number().int().positive(),
  fromColumnId: NonEmptyStringSchema,
  toColumnId: NonEmptyStringSchema
}).strict().refine((a) => a.fromColumnId !== a.toColumnId, {
  message: "fromColumnId 与 toColumnId 不能相同"
});
z.object({
  id: z.number().int().positive(),
  body: z.string(),
  author: IssueAuthorDtoSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).strict();
const ListIssueCommentsArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  issueIndex: z.number().int().positive()
}).strict();
const CreateIssueCommentArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  issueIndex: z.number().int().positive(),
  body: NonEmptyStringSchema
}).strict();
const LabelDtoSchema = z.object({
  id: z.number().int().positive(),
  name: NonEmptyStringSchema,
  color: z.string(),
  description: z.string().optional()
}).strict();
const ListLabelsArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();
z.object({
  items: z.array(LabelDtoSchema),
  hasMore: z.boolean()
}).strict();
const CreateLabelArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  color: z.string(),
  description: z.string().optional()
}).strict();
const MilestoneDtoSchema = z.object({
  id: z.number().int().positive(),
  title: NonEmptyStringSchema,
  state: z.enum(["open", "closed", "all"]).default("open"),
  description: z.string().optional()
}).strict();
const ListMilestonesArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  /** gitea state 过滤：默认 'all'（弹窗要列全部里程碑供选择） */
  state: z.enum(["open", "closed", "all"]).default("all"),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();
z.object({
  items: z.array(MilestoneDtoSchema),
  hasMore: z.boolean()
}).strict();
const CollaboratorDtoSchema = z.object({
  username: NonEmptyStringSchema,
  avatarUrl: z.string().url().optional(),
  /**
   * gitea 用户真名（来自 /repos/{owner}/{repo}/collaborators 返回的 User.full_name）。
   *
   * A-3 P3 · W7 修法（2026-06-14）：非破坏性新增 optional 字段——
   * 旧客户端忽略 fullName 不受影响；新客户端用 fullName 做"按姓名搜索"。
   * 旧版 gitea 实例 full_name 可能为空字符串 → main 端过滤掉，不下发。
   */
  fullName: z.string().min(1).optional(),
  /**
   * gitea 权限字符串：'read' | 'write' | 'admin' | 'unknown'。
   * 字符串而不是 enum：gitea 历史版本字段值漂移，v1 简化不锁死。
   */
  permission: z.string()
}).strict();
const ListMembersArgsSchema = z.object({
  projectId: NonEmptyStringSchema
}).strict();
z.array(CollaboratorDtoSchema);
const UserPrefsGetArgsSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(64)
}).strict();
z.record(z.string(), z.unknown());
const UserPrefsSetArgsSchema = z.object({
  entries: z.record(z.string(), z.unknown())
}).strict();
const UserUndoArgsSchema = z.object({
  projectId: z.string().min(1).optional()
}).strict();
const UserRedoArgsSchema = UserUndoArgsSchema;
z.object({
  restored: z.number().int().min(0).max(1),
  op: z.string().min(1).optional(),
  undoSize: z.number().int().min(0),
  redoSize: z.number().int().min(0)
}).strict();
const UserUndoStatusArgsSchema = z.object({
  projectId: z.string().min(1)
}).strict();
z.object({
  undoSize: z.number().int().min(0),
  redoSize: z.number().int().min(0)
}).strict();
const ThemeEnumSchema = z.enum(["dark", "light"]);
const ThemeGetArgsSchema = z.object({}).strict();
z.object({
  theme: ThemeEnumSchema,
  changedAt: IsoDateSchema
}).strict();
const ThemeSetArgsSchema = z.object({
  theme: ThemeEnumSchema
}).strict();
z.object({
  theme: ThemeEnumSchema,
  changedAt: IsoDateSchema
}).strict();
const ClipboardWriteArgsSchema = z.object({
  text: z.string().min(1).max(8192)
}).strict();
z.object({
  ok: z.literal(true)
}).strict();
const LaneModeSchema = z.enum(["branch", "author", "pr"]);
const LaneColorHexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const LaneSchema = z.object({
  id: NonEmptyStringSchema,
  // "branch:main" / "author:alice" / "pr:42"
  label: NonEmptyStringSchema,
  kind: LaneModeSchema,
  color: LaneColorHexSchema,
  order: z.number().int().min(0),
  hidden: z.boolean().optional()
}).strict();
const CommitNodeSchema = z.object({
  id: NonEmptyStringSchema,
  // sha
  laneId: NonEmptyStringSchema,
  x: z.number(),
  y: z.number().int().min(0),
  sha: NonEmptyStringSchema,
  shortSha: NonEmptyStringSchema,
  message: z.string(),
  author: z.object({
    name: NonEmptyStringSchema,
    avatarUrl: z.string().url().optional()
  }).strict(),
  timestamp: IsoDateSchema,
  parents: z.array(NonEmptyStringSchema),
  isMerge: z.boolean(),
  branchHints: z.array(NonEmptyStringSchema),
  linkedCardIds: z.array(NonEmptyStringSchema),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  filesChanged: z.number().int().min(0).optional()
}).strict();
const ParentEdgeSchema = z.object({
  id: NonEmptyStringSchema,
  source: NonEmptyStringSchema,
  // source node id (sha)
  target: NonEmptyStringSchema,
  // target node id (sha)
  kind: z.enum(["parent", "merge"]),
  prIndex: z.number().int().positive().optional()
}).strict();
const TimelinePRSchema = z.object({
  id: NonEmptyStringSchema,
  index: z.number().int().positive(),
  title: NonEmptyStringSchema,
  state: z.enum(["open", "closed", "merged"]),
  head: NonEmptyStringSchema,
  base: NonEmptyStringSchema,
  author: z.object({
    name: NonEmptyStringSchema,
    avatarUrl: z.string().url().optional()
  }).strict(),
  url: z.string().url(),
  mergedAt: IsoDateSchema.optional()
}).strict();
z.object({
  windowStart: IsoDateSchema.optional(),
  windowEnd: IsoDateSchema.optional(),
  range: z.object({
    from: IsoDateSchema,
    to: IsoDateSchema
  }).strict(),
  lanes: z.array(LaneSchema),
  nodes: z.array(CommitNodeSchema),
  edges: z.array(ParentEdgeSchema),
  prs: z.array(TimelinePRSchema),
  truncated: z.boolean(),
  totalCommits: z.number().int().min(0)
}).strict();
const TimelineArgsSchema = z.object({
  projectId: NonEmptyStringSchema,
  branches: z.array(NonEmptyStringSchema).min(1).max(10),
  since: IsoDateSchema.optional(),
  until: IsoDateSchema.optional(),
  maxNodes: z.number().int().min(1).max(500).default(500),
  laneMode: LaneModeSchema.default("branch")
}).strict();
const log$4 = pino({ name: "sync-queue", level: process.env["LOG_LEVEL"] ?? "info" });
const QUEUE_FILENAME = "queue.jsonl";
const GC_DONE_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
const GC_FAILED_LIMIT = 1e3;
function resolveQueuePath() {
  const dataDir = process.env["GITEA_KANBAN_DATA_DIR"] ?? join(process.env["HOME"] ?? "/tmp", ".gitea-kanban");
  return join(dataDir, QUEUE_FILENAME);
}
async function loadQueue() {
  const file = resolveQueuePath();
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8").catch((err) => {
    log$4.error({ err: err instanceof Error ? err.message : String(err), file }, "loadQueue: readFile failed");
    return "";
  });
  if (!raw) return [];
  const byId = /* @__PURE__ */ new Map();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.status === "in-flight") {
        e.status = "pending";
      }
      byId.set(e.id, e);
    } catch (err) {
      log$4.warn(
        { line: i + 1, err: err instanceof Error ? err.message : String(err) },
        "loadQueue: skip malformed line"
      );
    }
  }
  const entries = [...byId.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  log$4.info({ file, total: entries.length }, "loadQueue: loaded");
  return entries;
}
async function enqueueEntry(args) {
  const entry = {
    id: `q-${randomUUID()}`,
    op: args.op,
    args: args.payload,
    queuedAt: Date.now(),
    attempt: 0,
    status: "pending"
  };
  await appendToFile(entry);
  log$4.debug({ id: entry.id, op: entry.op }, "queue: enqueued");
  return entry;
}
async function markEntryDone(id) {
  const file = resolveQueuePath();
  const update = {
    status: "done",
    doneAt: Date.now()
  };
  await appendToFile({ id, ...update });
  log$4.debug({ id, file }, "queue: marked done");
}
async function markEntryFailed(id, err) {
  const update = {
    status: "failed",
    lastError: err,
    failedAt: Date.now()
  };
  await appendToFile({ id, ...update });
  log$4.warn({ id, err }, "queue: marked failed");
}
async function markEntryAbandoned(id) {
  const update = {
    status: "abandoned"
  };
  await appendToFile({ id, ...update });
  log$4.info({ id }, "queue: marked abandoned");
}
async function appendToFile(entry) {
  const file = resolveQueuePath();
  if (!existsSync(dirname(file))) {
    mkdirSync(dirname(file), { recursive: true, mode: 448 });
  }
  const line = JSON.stringify(entry) + "\n";
  await appendFile(file, line, { mode: 384 });
}
async function gcQueue() {
  const file = resolveQueuePath();
  if (!existsSync(file)) return { removed: 0, remaining: 0 };
  const all = await loadQueue();
  const cutoff = Date.now() - GC_DONE_AGE_MS;
  const done = [];
  const failed = [];
  for (const e of all) {
    if (e.status === "done" && (e.doneAt ?? 0) < cutoff) {
      done.push(e);
    } else if (e.status === "failed") {
      failed.push(e);
    } else ;
  }
  if (failed.length > GC_FAILED_LIMIT) {
    failed.sort((a, b) => (a.failedAt ?? 0) - (b.failedAt ?? 0));
    const excess = failed.length - GC_FAILED_LIMIT;
    done.push(...failed.splice(0, excess));
  }
  const toRemove = new Set(done.map((e) => `${e.id}|${e.queuedAt}|${e.status}`));
  const remaining = all.filter((e) => !toRemove.has(`${e.id}|${e.queuedAt}|${e.status}`));
  if (toRemove.size === 0) {
    return { removed: 0, remaining: all.length };
  }
  const tmp = `${file}.gc.${process.pid}.${Date.now()}`;
  const lines = remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : "");
  await writeFile(tmp, lines, { mode: 384 });
  await rename(tmp, file);
  log$4.info({ removed: toRemove.size, remaining: remaining.length }, "queue: gc done");
  return { removed: toRemove.size, remaining: remaining.length };
}
const log$3 = pino({ name: "sync-dispatch", level: process.env["LOG_LEVEL"] ?? "info" });
const registry = /* @__PURE__ */ new Map();
function registerOp(op, handler) {
  if (registry.has(op)) {
    log$3.warn({ op }, "dispatch: op already registered, overwriting");
  }
  registry.set(op, handler);
}
function getRegisteredOp(op) {
  return registry.get(op);
}
async function dispatch(op, args) {
  const handler = registry.get(op);
  if (!handler) {
    log$3.error({ op }, "dispatch: op not registered");
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: `内部错误：op ${op} 未注册`
    });
  }
  try {
    const result = await handler.execute(args);
    return { mode: "online", result };
  } catch (err) {
    if (!isNetworkOffline(err) || !handler.offlineApply) {
      throw err;
    }
    log$3.info(
      { op, err: err instanceof Error ? err.message : String(err) },
      "dispatch: gitea unreachable, falling back to offlineApply"
    );
    const optimistic = await handler.offlineApply(args);
    const entry = await enqueueEntry({ op, payload: args });
    return { mode: "offline", result: optimistic, entryId: entry.id };
  }
}
function isNetworkOffline(err) {
  if (err instanceof IpcError) {
    return err.code === IpcErrorCode.NETWORK_OFFLINE;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("econnreset") || msg.includes("fetch failed") || msg.includes("network");
  }
  return false;
}
function makeService(giteaUrl) {
  return `${KEYCHAIN_SERVICE_PREFIX}${giteaUrl}`;
}
function makeEntry(giteaUrl, username) {
  return new AsyncEntry(makeService(giteaUrl), username);
}
function mapKeyringError(err, op) {
  if (!err) return null;
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("no entry") || msg.includes("noentry")) {
    return null;
  }
  if (msg.includes("platform failure") || msg.includes("no storage access") || msg.includes("nosecret") || msg.includes("no such file") || // libsecret shared object missing
  msg.includes("dbus") || msg.includes("failed to load") || msg.includes("kwallet")) {
    return new IpcError({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
      message: "系统 keychain 不可用",
      hint: "Linux：请安装 gnome-keyring 或 kwallet5；macOS：检查 Keychain Access.app 是否被禁用；Windows：检查 Credential Manager 服务",
      cause: err instanceof Error ? err.message : String(err)
    });
  }
  if (msg.includes("access denied") || msg.includes("permission denied") || msg.includes("accessdenied")) {
    return new IpcError({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
      message: "系统拒绝了 keychain 访问权限",
      hint: "请检查系统 keychain 的访问权限设置",
      cause: err instanceof Error ? err.message : String(err)
    });
  }
  return new IpcError({
    code: IpcErrorCode.INTERNAL,
    message: `keychain ${op} 失败`,
    hint: "请稍后重试，或联系开发者",
    cause: err instanceof Error ? err.message : String(err)
  });
}
async function keychainSet(giteaUrl, username, token) {
  const entry = makeEntry(giteaUrl, username);
  try {
    await entry.setPassword(token);
  } catch (err) {
    const mapped = mapKeyringError(err, "set");
    if (mapped) throw mapped;
    throw err;
  }
}
async function keychainGet(giteaUrl, username) {
  const entry = makeEntry(giteaUrl, username);
  try {
    const result = await entry.getPassword();
    return result ?? null;
  } catch (err) {
    const mapped = mapKeyringError(err, "get");
    if (mapped) {
      if (mapped.code === IpcErrorCode.KEYCHAIN_UNAVAILABLE || mapped.code === IpcErrorCode.KEYCHAIN_ACCESS_DENIED) {
        throw mapped;
      }
      throw mapped;
    }
    return null;
  }
}
async function keychainDelete(giteaUrl, username) {
  const entry = makeEntry(giteaUrl, username);
  try {
    const ok = await entry.deletePassword();
    return Boolean(ok);
  } catch (err) {
    const mapped = mapKeyringError(err, "delete");
    if (mapped) {
      if (mapped.code === IpcErrorCode.KEYCHAIN_UNAVAILABLE || mapped.code === IpcErrorCode.KEYCHAIN_ACCESS_DENIED) {
        throw mapped;
      }
      throw mapped;
    }
    return false;
  }
}
function devTokenPath$1(giteaUrl, username) {
  const safe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(app.getPath("userData"), "dev-tokens", `${safe(giteaUrl)}__${safe(username)}.json`);
}
async function readToken(giteaUrl, username) {
  if (!app.isPackaged) {
    try {
      const p = devTokenPath$1(giteaUrl, username);
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf8"));
        return j.token ?? null;
      }
    } catch {
    }
  }
  return await keychainGet(giteaUrl, username);
}
const cache = /* @__PURE__ */ new Map();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1e3;
function cacheKey(giteaUrl, username) {
  return `${giteaUrl}::${username}`;
}
function httpErrorToIpcError(status, body, fallbackMessage) {
  const cause = typeof body === "string" ? body : JSON.stringify(body ?? {});
  switch (status) {
    case 401:
      return new IpcError({
        code: IpcErrorCode.TOKEN_INVALID,
        message: "登录已过期或 token 无效",
        hint: "请到 gitea重新生成 token 后重新连接",
        cause,
        httpStatus: 401
      });
    case 403:
      return new IpcError({
        code: IpcErrorCode.PERMISSION_DENIED,
        message: "没有该操作权限",
        hint: "请联系仓库管理员",
        cause,
        httpStatus: 403
      });
    case 404:
      return new IpcError({
        code: IpcErrorCode.NOT_FOUND,
        message: "找不到该资源（可能已被删除）",
        hint: "请刷新列表",
        cause,
        httpStatus: 404
      });
    case 405:
      return new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: "操作冲突：资源状态不允许该操作（如合并请求已合并或已关闭）",
        hint: "请刷新后查看最新状态",
        cause,
        httpStatus: 405
      });
    case 409:
      return new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: "操作冲突：资源已存在或状态不允许",
        cause,
        httpStatus: 409
      });
    case 422:
      return new IpcError({
        code: IpcErrorCode.VALIDATION_FAILED,
        message: "请求参数不被服务端接受",
        hint: "请检查输入内容",
        cause,
        httpStatus: 422
      });
    case 429:
      return new IpcError({
        code: IpcErrorCode.RATE_LIMITED,
        message: "请求过于频繁",
        hint: "请稍后重试",
        cause,
        httpStatus: 429
      });
    case 0:
    case 502:
    case 503:
    case 504:
      return new IpcError({
        code: IpcErrorCode.NETWORK_OFFLINE,
        message: "当前离线或远端不可达",
        hint: "请检查网络后重试",
        cause,
        httpStatus: status
      });
    default:
      return new IpcError({
        code: IpcErrorCode.GITEA_ERROR,
        message: fallbackMessage,
        cause,
        httpStatus: status
      });
  }
}
function normalizeBaseUrl(giteaUrl) {
  return giteaUrl.replace(/\/+$/, "");
}
function makeGiteaSecurityWorker() {
  return async (securityData) => {
    if (!securityData) return;
    return {
      secure: true,
      headers: {
        Authorization: `token ${String(securityData)}`
      }
    };
  };
}
async function getGiteaClient(giteaUrl, username) {
  const key = cacheKey(giteaUrl, username);
  const now = Date.now();
  let entry = cache.get(key);
  const needRefresh = !entry || !entry.token || now - entry.tokenFetchedAt > TOKEN_CACHE_TTL_MS;
  if (needRefresh) {
    const token = await readToken(giteaUrl, username);
    if (!token) {
      throw new IpcError({
        code: IpcErrorCode.UNAUTHENTICATED,
        message: "请先在 设置 →账户 连接 gitea",
        hint: "跳转到连接页"
      });
    }
    if (!entry) {
      entry = {
        api: new Api({
          baseUrl: `${normalizeBaseUrl(giteaUrl)}/api/v1`,
          baseApiParams: { format: "json" },
          securityWorker: makeGiteaSecurityWorker()
        }),
        baseUrl: normalizeBaseUrl(giteaUrl),
        tokenFetchedAt: 0
      };
      cache.set(key, entry);
    }
    entry.token = token;
    entry.tokenFetchedAt = now;
    entry.api.setSecurityData(token);
  }
  if (!entry) {
    throw new IpcError({
      code: IpcErrorCode.GITEA_ERROR,
      message: "getGiteaClient cache state corruption"
    });
  }
  return { api: entry.api, baseUrl: entry.baseUrl, token: entry.token };
}
function invalidateGiteaClient(giteaUrl, username) {
  cache.delete(cacheKey(giteaUrl, username));
}
function unwrapGitea(res, fallbackMessage) {
  if (!res.ok) {
    const data = res.data;
    const dataObj = typeof data === "object" && data !== null ? data : null;
    const errObj = dataObj && typeof dataObj["error"] === "object" && dataObj["error"] !== null ? dataObj["error"] : null;
    const cause = typeof dataObj?.["message"] === "string" && dataObj["message"] || typeof errObj?.["message"] === "string" && errObj["message"] || (res.statusText || `HTTP ${res.status}`);
    throw httpErrorToIpcError(res.status, cause, fallbackMessage);
  }
  return res.data;
}
const FLUSH_DEBOUNCE_MS = 100;
const FLUSH_RETRY_MAX_MS = 5e3;
const log$2 = pino({ name: "local-store", level: process.env["LOG_LEVEL"] ?? "info" });
class LocalStore {
  cache = null;
  dirty = false;
  flushTimer = null;
  flushing = false;
  retryDelay = 0;
  file;
  defaults;
  constructor(args) {
    this.file = args.file;
    this.defaults = args.defaults;
  }
  /**
   * 启动期调用：读磁盘 + 解析 + 内存镜像
   *
   * ENOENT → 用 defaults 初始化（写盘一次）
   * 解析失败 → throw（**不**自动清空，避免丢用户数据；启动期显式报警让用户处理）
   */
  async load() {
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        log$2.info({ file: this.file }, "localStore: file missing, init with defaults");
        this.cache = structuredClone(this.defaults);
        this.dirty = true;
        await this.doFlush();
        return this.cache;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log$2.fatal({ file: this.file, err }, "localStore: JSON parse failed; refusing to start");
      throw new Error(
        `localStore 解析失败: ${this.file}。请检查文件是否被外部工具改坏；备份后删除此文件可恢复默认状态。`
      );
    }
    this.cache = { ...structuredClone(this.defaults), ...parsed };
    log$2.info({ file: this.file, keys: Object.keys(this.cache) }, "localStore: loaded");
    return this.cache;
  }
  /**
   * 同步读内存镜像
   *
   * 必须在 load() 之后调用；否则 throw
   */
  get() {
    if (!this.cache) {
      throw new Error("localStore not loaded; call load() first");
    }
    return this.cache;
  }
  /**
   * 修改内存态（同步）+ 触发 debounce flush
   *
   * 使用模式：
   * ```ts
   * store.mutate(s => {
   *   s.prefs.theme = 'light';
   * });
   * ```
   */
  mutate(fn) {
    if (!this.cache) {
      throw new Error("localStore not loaded; call load() first");
    }
    const r = fn(this.cache);
    this.dirty = true;
    this.scheduleFlush();
    return r;
  }
  /**
   * 立刻同步 flush（不等待 debounce）
   *
   * 用途：before-quit hook；测试断言
   */
  async flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.doFlush();
  }
  /**
   * 关停（before-quit 调用）
   */
  async close() {
    await this.flushNow();
  }
  // ===== 私有 =====
  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.doFlush();
    }, FLUSH_DEBOUNCE_MS);
  }
  async doFlush() {
    if (this.flushing) return;
    if (!this.dirty || !this.cache) return;
    this.flushing = true;
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    try {
      const snapshot = JSON.stringify(this.cache, null, 2);
      await mkdir(dirname(this.file), { recursive: true, mode: 448 });
      await writeFile(tmp, snapshot, { mode: 384 });
      await rename(tmp, this.file);
      this.dirty = false;
      this.retryDelay = 0;
      log$2.debug({ file: this.file, bytes: snapshot.length }, "localStore: flushed");
    } catch (err) {
      try {
        const { unlink } = await import("node:fs/promises");
        const { readdirSync: readdirSync2 } = await import("node:fs");
        if (existsSync(dirname(this.file))) {
          const stalePrefix = `${basename(this.file)}.tmp.${process.pid}.`;
          for (const f of readdirSync2(dirname(this.file))) {
            if (f.startsWith(stalePrefix)) {
              await unlink(join(dirname(this.file), f)).catch(() => {
              });
            }
          }
        }
      } catch {
      }
      this.retryDelay = Math.min(
        this.retryDelay === 0 ? 200 : this.retryDelay * 2,
        FLUSH_RETRY_MAX_MS
      );
      log$2.error(
        { file: this.file, err, retryDelayMs: this.retryDelay },
        "localStore: flush failed; will retry"
      );
      setTimeout(() => void this.doFlush(), this.retryDelay);
    } finally {
      this.flushing = false;
    }
  }
}
function resolveStatePath() {
  const dataDir = process.env["GITEA_KANBAN_DATA_DIR"] ?? join(os.homedir(), ".gitea-kanban");
  if (!isAbsolute(dataDir)) {
    throw new Error(`data dir must be absolute, got: ${dataDir}`);
  }
  return join(dataDir, "state.json");
}
const STATE_SCHEMA_VERSION = 1;
const defaultState = () => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  accounts: [],
  users: [
    {
      id: "local-user",
      displayName: "Local User",
      createdAt: Date.now()
    }
  ],
  prefs: {},
  projects: [],
  columns: [],
  labelMaps: [],
  starredBranches: []
});
let storeInstance = null;
let loaded = false;
async function initLocalStore() {
  if (loaded && storeInstance) return storeInstance;
  const file = resolveStatePath();
  storeInstance = new LocalStore({ file, defaults: defaultState() });
  await storeInstance.load();
  loaded = true;
  logger.info({ file }, "localStore initialized");
  return storeInstance;
}
function getLocalStore() {
  if (!storeInstance || !loaded) {
    throw new Error("localStore not initialized; call initLocalStore() first");
  }
  return storeInstance;
}
async function closeLocalStore() {
  if (storeInstance) {
    await storeInstance.close();
    storeInstance = null;
    loaded = false;
  }
}
function devTokenDir() {
  return join(app.getPath("userData"), "dev-tokens");
}
function devTokenPath(giteaUrl, username) {
  const safe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(devTokenDir(), `${safe(giteaUrl)}__${safe(username)}.json`);
}
async function persistToken(giteaUrl, username, token) {
  if (!app.isPackaged) {
    try {
      mkdirSync(devTokenDir(), { recursive: true, mode: 448 });
      writeFileSync(devTokenPath(giteaUrl, username), JSON.stringify({ token, ts: Date.now() }), { mode: 384 });
      return;
    } catch (err) {
    }
  }
  await keychainSet(giteaUrl, username, token);
}
async function clearDevToken(giteaUrl, username) {
  if (!app.isPackaged) {
    try {
      const p = devTokenPath(giteaUrl, username);
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
    }
  }
}
async function verifyToken(giteaUrl, token) {
  const url = `${giteaUrl.replace(/\/+$/, "")}/api/v1/user`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json"
      }
    });
  } catch (err) {
    throw new IpcError({
      code: IpcErrorCode.NETWORK_OFFLINE,
      message: "无法连接 gitea",
      hint: "请检查 giteaUrl 和网络",
      cause: err instanceof Error ? err.message : String(err)
    });
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    const cause = typeof body === "string" ? body : JSON.stringify(body ?? {});
    if (res.status === 401 || res.status === 403) {
      throw new IpcError({
        code: IpcErrorCode.TOKEN_INVALID,
        message: "token 无效或权限不足",
        hint: "请到 gitea 重新生成 token（需要 read:user 权限）",
        cause,
        httpStatus: res.status
      });
    }
    throw new IpcError({
      code: IpcErrorCode.GITEA_ERROR,
      message: `gitea 返回 ${res.status}`,
      cause,
      httpStatus: res.status
    });
  }
  const json = await res.json();
  return {
    id: Number(json["id"]),
    login: String(json["login"] ?? ""),
    ...typeof json["full_name"] === "string" ? { fullName: json["full_name"] } : {},
    ...typeof json["email"] === "string" ? { email: json["email"] } : {},
    ...typeof json["avatar_url"] === "string" ? { avatarUrl: json["avatar_url"] } : {}
  };
}
async function authConnect(args) {
  const user = await verifyToken(args.giteaUrl, args.token);
  await persistToken(args.giteaUrl, user.login, args.token);
  const now = /* @__PURE__ */ new Date();
  const nowEpochMs = now.getTime();
  const keychainService = `gitea-kanban@${args.giteaUrl}`;
  let finalAccountId;
  let finalAccountCreatedAt;
  const store = getLocalStore();
  const stateNow = store.get();
  const existingLocal = stateNow.accounts.find(
    (a) => a.giteaUrl === args.giteaUrl && a.username === user.login
  );
  if (existingLocal) {
    finalAccountId = existingLocal.id;
    finalAccountCreatedAt = existingLocal.createdAt;
    store.mutate((s) => {
      const idx = s.accounts.findIndex((a) => a.id === finalAccountId);
      if (idx >= 0) {
        s.accounts[idx] = {
          ...s.accounts[idx],
          keychainService
        };
      }
    });
  } else {
    finalAccountId = randomUUID();
    finalAccountCreatedAt = nowEpochMs;
    store.mutate((s) => {
      s.accounts.push({
        id: finalAccountId,
        giteaUrl: args.giteaUrl,
        username: user.login,
        keychainService,
        createdAt: nowEpochMs,
        userInfo: null
        // 下面 upsert
      });
    });
  }
  store.mutate((s) => {
    const idx = s.accounts.findIndex((a) => a.id === finalAccountId);
    if (idx >= 0) {
      s.accounts[idx] = {
        ...s.accounts[idx],
        userInfo: {
          giteaUserId: user.id,
          login: user.login,
          ...user.fullName ? { fullName: user.fullName } : {},
          ...user.email ? { email: user.email } : {},
          ...user.avatarUrl ? { avatarUrl: user.avatarUrl } : {},
          updatedAt: nowEpochMs
        }
      };
    }
  });
  const accountDto = {
    id: finalAccountId,
    giteaUrl: args.giteaUrl,
    username: user.login,
    createdAt: new Date(finalAccountCreatedAt).toISOString()
  };
  return { account: accountDto, user };
}
async function authDisconnect(args) {
  const store = getLocalStore();
  const stateNow = store.get();
  const targetAccounts = stateNow.accounts.filter((a) => a.giteaUrl === args.giteaUrl);
  if (targetAccounts.length === 0) {
    return;
  }
  const usernames = targetAccounts.map((a) => a.username);
  for (const u of usernames) {
    await keychainDelete(args.giteaUrl, u);
    await clearDevToken(args.giteaUrl, u);
    invalidateGiteaClient(args.giteaUrl, u);
  }
  const removeIds = new Set(targetAccounts.map((a) => a.id));
  store.mutate((s) => {
    s.accounts = s.accounts.filter((a) => !removeIds.has(a.id));
  });
}
async function authStatus() {
  const state = getLocalStore().get();
  if (state.accounts.length === 0) {
    return { accounts: [], currentUser: null };
  }
  const firstAccount = state.accounts[0];
  const firstUserInfo = firstAccount.userInfo;
  const accounts = state.accounts.map((a) => ({
    id: a.id,
    giteaUrl: a.giteaUrl,
    username: a.username,
    createdAt: new Date(a.createdAt).toISOString()
  }));
  let currentUser = null;
  if (firstUserInfo) {
    currentUser = {
      id: firstUserInfo.giteaUserId,
      login: firstUserInfo.login,
      ...firstUserInfo.fullName ? { fullName: firstUserInfo.fullName } : {},
      ...firstUserInfo.email ? { email: firstUserInfo.email } : {},
      ...firstUserInfo.avatarUrl ? { avatarUrl: firstUserInfo.avatarUrl } : {}
    };
  }
  return { accounts, currentUser };
}
function wrapIpc$c(channel, schema, handler) {
  ipcMain.handle(channel, async (event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args, event);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function registerAuthIpc() {
  registerOp("auth.connect", {
    execute: authConnect
  });
  registerOp("auth.disconnect", {
    execute: authDisconnect
  });
  wrapIpc$c(IpcChannel.AUTH_CONNECT, ConnectArgsSchema, async (args) => {
    const { mode, result } = await dispatch("auth.connect", args);
    if (mode === "online") {
      installCspHeader(result.account.giteaUrl);
    }
    return result;
  });
  wrapIpc$c(IpcChannel.AUTH_DISCONNECT, DisconnectArgsSchema, async (args) => {
    await dispatch("auth.disconnect", args);
    installCspHeader(args.giteaUrl);
    return void 0;
  });
  ipcMain.handle(IpcChannel.AUTH_STATUS, async () => {
    return authStatus();
  });
}
function unregisterAuthIpc() {
  ipcMain.removeHandler(IpcChannel.AUTH_CONNECT);
  ipcMain.removeHandler(IpcChannel.AUTH_DISCONNECT);
  ipcMain.removeHandler(IpcChannel.AUTH_STATUS);
}
async function listGiteaRepos(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.user.userCurrentListRepos({ page, limit });
  const raws = unwrapGitea(res, "/user/repos列表失败");
  const filtered = args.query ? raws.filter((r) => {
    const q = args.query.toLowerCase();
    return (r.full_name ?? "").toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);
  }) : raws;
  const items = filtered.map(rawToRepoDto);
  return {
    items,
    total: items.length,
    hasMore: raws.length === limit
    // gitea还有下一页的信号
  };
}
function rawToRepoDto(r) {
  return {
    id: r.id ?? 0,
    owner: r.owner?.login ?? "<unknown>",
    name: r.name ?? "",
    fullName: r.full_name ?? r.name ?? "",
    description: r.description ?? "",
    defaultBranch: r.default_branch || "main",
    archived: Boolean(r.archived),
    private: Boolean(r.private),
    updatedAt: r.updated_at ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    permissions: {
      pull: Boolean(r.permissions?.pull ?? true),
      push: Boolean(r.permissions?.push ?? false),
      admin: Boolean(r.permissions?.admin ?? false)
    },
    isProject: false
    // 由 cache/repos.ts 的 JOIN 覆盖
  };
}
async function listRepoCollaborators(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoListCollaborators(args.owner, args.repo, { page, limit });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/collaborators列表失败`);
  if (raws.length === 0) {
    return { items: [], hasMore: false };
  }
  const perms = await Promise.all(
    raws.map(
      (u) => api.repos.repoGetRepoPermissions(args.owner, args.repo, u.login ?? "").then(
        (r) => ({ login: u.login ?? "", permResp: r }),
        (err) => ({ login: u.login ?? "", permResp: null, err })
      )
    )
  );
  const permByLogin = /* @__PURE__ */ new Map();
  for (const p of perms) {
    if (p.permResp && p.permResp.ok) {
      const perm = p.permResp.data?.permission;
      permByLogin.set(p.login, perm ?? "unknown");
    } else if (p.permResp && !p.permResp.ok) {
      if (process.env["DEBUG_COLLAB_PERM"]) {
        console.debug(
          `[repos] collaborator permission 降级: ${args.owner}/${args.repo} user=${p.login} status=${p.permResp.status}`
        );
      }
      permByLogin.set(p.login, "unknown");
    } else if (p.permResp === null) {
      const errInfo = p.err;
      if (process.env["DEBUG_COLLAB_PERM"]) {
        console.debug(
          `[repos] collaborator permission fetch threw: ${args.owner}/${args.repo} user=${p.login} err=${String(errInfo)}`
        );
      }
      permByLogin.set(p.login, "unknown");
    }
  }
  const items = raws.map((u) => {
    const username = u.login ?? "<unknown>";
    return {
      username,
      ...u.avatar_url ? { avatarUrl: u.avatar_url } : {},
      // A-3 P3 · W7 修法：full_name 非空才下发（旧 gitea 可能为空，schema 验证过滤）
      ...u.full_name ? { fullName: u.full_name } : {},
      permission: permByLogin.get(username) ?? "unknown"
    };
  });
  return { items, hasMore: raws.length === limit };
}
const log$1 = pino({ name: "cache-file-store", level: process.env["LOG_LEVEL"] ?? "info" });
const DEFAULT_LRU_BUDGET_BYTES = 50 * 1024 * 1024;
function makeEntryPath(rootDir, resource, projectId, key) {
  return join(rootDir, resource, `${projectId}__${key}.json`);
}
function resolveCacheDir() {
  const dataDir = process.env["GITEA_KANBAN_DATA_DIR"] ?? join(process.env["HOME"] ?? "/tmp", ".gitea-kanban");
  if (!isAbsolute(dataDir)) {
    throw new Error(`data dir must be absolute, got: ${dataDir}`);
  }
  return join(dataDir, "cache");
}
function getCache(args) {
  const file = makeEntryPath(resolveCacheDir(), args.resource, args.projectId, args.key);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    log$1.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      "fileStore.get: readFile failed, treat as miss"
    );
    return null;
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    log$1.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      "fileStore.get: JSON.parse failed, treat as miss"
    );
    return null;
  }
  try {
    const stat = statSync(file);
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1e3;
    if (ageSeconds > entry.ttlSeconds) {
      return null;
    }
  } catch {
    return null;
  }
  return entry.payload;
}
function setCache(args) {
  const rootDir = resolveCacheDir();
  const dir = join(rootDir, args.resource);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 448 });
  }
  const file = makeEntryPath(rootDir, args.resource, args.projectId, args.key);
  const entry = {
    payload: args.payload,
    fetchedAt: Date.now(),
    ttlSeconds: args.ttlSeconds
  };
  const raw = JSON.stringify(entry);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, raw, { mode: 384 });
  renameSync(tmp, file);
  log$1.debug(
    { file, bytes: raw.length, ttl: args.ttlSeconds },
    "fileStore.set: written"
  );
}
function deleteCache(args) {
  const file = makeEntryPath(resolveCacheDir(), args.resource, args.projectId, args.key);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch (err) {
    log$1.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      "fileStore.delete: unlink failed"
    );
  }
}
function invalidateCache(args) {
  const dir = join(resolveCacheDir(), args.resource);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir);
  const prefix = args.projectId ? `${args.projectId}__` : null;
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (prefix && !f.startsWith(prefix)) continue;
    try {
      unlinkSync(join(dir, f));
      removed++;
    } catch (err) {
      log$1.warn(
        { file: f, err: err instanceof Error ? err.message : String(err) },
        "fileStore.invalidate: unlink failed"
      );
    }
  }
  log$1.debug(
    { resource: args.resource, projectId: args.projectId, removed },
    "fileStore.invalidate: done"
  );
}
function gcCache(args = {}) {
  const budget = args.budgetBytes ?? DEFAULT_LRU_BUDGET_BYTES;
  const rootDir = resolveCacheDir();
  if (!existsSync(rootDir)) {
    return { removed: 0, remaining: 0, bytesBefore: 0, bytesAfter: 0 };
  }
  const all = [];
  const resources = readdirSync(rootDir);
  for (const r of resources) {
    const dir = join(rootDir, r);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const file = join(dir, f);
      try {
        const st = statSync(file);
        all.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
      }
    }
  }
  const bytesBefore = all.reduce((s, e) => s + e.size, 0);
  const total = all.length;
  if (bytesBefore <= budget) {
    return { removed: 0, remaining: total, bytesBefore, bytesAfter: bytesBefore };
  }
  all.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytesAfter = bytesBefore;
  let removed = 0;
  for (const e of all) {
    if (bytesAfter <= budget) break;
    try {
      unlinkSync(e.file);
      bytesAfter -= e.size;
      removed++;
    } catch {
    }
  }
  log$1.info(
    {
      removed,
      remaining: total - removed,
      bytesBefore,
      bytesAfter,
      budget
    },
    "fileStore.gc: done"
  );
  return { removed, remaining: total - removed, bytesBefore, bytesAfter };
}
const fileStore = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  deleteCache,
  gcCache,
  getCache,
  invalidateCache,
  resolveCacheDir,
  setCache
}, Symbol.toStringTag, { value: "Module" }));
function findProjectWithStore(state, args) {
  return state.projects.find(
    (p) => p.giteaAccountId === args.giteaAccountId && p.owner === args.owner && p.name === args.name
  ) ?? null;
}
function findProjectByIdWithStore(state, projectId) {
  return state.projects.find((p) => p.id === projectId) ?? null;
}
function findProjectsByOwnerNameWithStore(state, giteaAccountId, pairs) {
  const result = /* @__PURE__ */ new Map();
  for (const p of state.projects) {
    if (p.giteaAccountId !== giteaAccountId) continue;
    if (pairs.some((q) => q.owner === p.owner && q.name === p.name)) {
      result.set(`${p.owner}/${p.name}`, p);
    }
  }
  return result;
}
function findAccountByIdWithStore(state, giteaAccountId) {
  return state.accounts.find((a) => a.id === giteaAccountId) ?? null;
}
const CACHE_RESOURCE$4 = "repos";
const REPOS_LIST_TTL_SECONDS = 5 * 60;
function findProjectsByOwnerName(giteaAccountId, pairs) {
  const m = findProjectsByOwnerNameWithStore(getLocalStore().get(), giteaAccountId, pairs);
  const out = /* @__PURE__ */ new Map();
  for (const [k, v] of m) {
    const dto = projectRowToDto(v);
    if (dto) out.set(k, dto);
  }
  return out;
}
function addProject(args) {
  const store = getLocalStore();
  const stateNow = store.get();
  if (!findAccountByIdWithStore(stateNow, args.giteaAccountId)) {
    throw new Error(
      `gitea_accounts row not found: ${args.giteaAccountId}（先调 auth.connect）`
    );
  }
  const existingLocal = findProjectWithStore(stateNow, {
    giteaAccountId: args.giteaAccountId,
    owner: args.owner,
    name: args.name
  });
  if (existingLocal) return projectRowToDto(existingLocal);
  const nowEpochMs = Date.now();
  const id = randomUUID();
  const createdRow = {
    id,
    giteaAccountId: args.giteaAccountId,
    owner: args.owner,
    name: args.name,
    defaultBranch: args.defaultBranch ?? null,
    lastSyncAt: nowEpochMs,
    createdAt: nowEpochMs
  };
  store.mutate((s) => {
    s.projects.push(createdRow);
  });
  invalidateReposCache(args.giteaAccountId);
  return projectRowToDto(createdRow);
}
function removeProject(projectId) {
  const store = getLocalStore();
  const stateNow = store.get();
  const existingLocal = stateNow.projects.find((p) => p.id === projectId);
  if (!existingLocal) {
    return;
  }
  store.mutate((s) => {
    s.projects = s.projects.filter((p) => p.id !== projectId);
  });
  invalidateReposCache(existingLocal.giteaAccountId);
}
function touchLastSync(args) {
  const store = getLocalStore();
  const whenMs = (args.when ?? /* @__PURE__ */ new Date()).getTime();
  store.mutate((s) => {
    const idx = s.projects.findIndex(
      (p) => p.giteaAccountId === args.giteaAccountId && p.owner === args.owner && p.name === args.name
    );
    if (idx >= 0) {
      s.projects[idx] = { ...s.projects[idx], lastSyncAt: whenMs };
    }
  });
}
function backfillDefaultBranch(args) {
  const store = getLocalStore();
  store.mutate((s) => {
    const idx = s.projects.findIndex(
      (p) => p.giteaAccountId === args.giteaAccountId && p.owner === args.owner && p.name === args.name
    );
    if (idx < 0) return;
    if (s.projects[idx].defaultBranch !== null) return;
    s.projects[idx] = { ...s.projects[idx], defaultBranch: args.defaultBranch };
  });
}
function getReposCache(args) {
  return getCache({ resource: CACHE_RESOURCE$4, projectId: args.giteaAccountId, key: args.cacheKey });
}
function setReposCache(args) {
  setCache({
    resource: CACHE_RESOURCE$4,
    projectId: args.giteaAccountId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? REPOS_LIST_TTL_SECONDS
  });
}
function invalidateReposCache(giteaAccountId) {
  invalidateCache({ resource: CACHE_RESOURCE$4, projectId: giteaAccountId });
}
function projectRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    giteaAccountId: row.giteaAccountId,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
    lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString()
  };
}
function wrapIpc$b(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function resolveGiteaAccount(giteaAccountId) {
  const state = getLocalStore().get();
  const acc = state.accounts.find((a) => a.id === giteaAccountId);
  if (!acc) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "gitea 账户不存在",
      hint: "请先在 设置 → 账户 连接 gitea"
    });
  }
  return { giteaUrl: acc.giteaUrl, username: acc.username };
}
function makeCacheKey$1(args) {
  return `account=${args.giteaAccountId}|query=${args.query ?? ""}|page=${args.page}|limit=${args.limit}`;
}
async function reposListHandler(args) {
  const start = Date.now();
  const op = "repos.list";
  logger.info({ op, args: { accountId: args.giteaAccountId, query: args.query, page: args.page, limit: args.limit } }, "ipc start");
  const cacheKey2 = makeCacheKey$1(args);
  const cached = getReposCache({ giteaAccountId: args.giteaAccountId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const { giteaUrl, username } = resolveGiteaAccount(args.giteaAccountId);
  const giteaResult = await listGiteaRepos({
    giteaUrl,
    username,
    query: args.query,
    page: args.page,
    limit: args.limit
  });
  const projectMap = findProjectsByOwnerName(
    args.giteaAccountId,
    giteaResult.items.map((r) => ({ owner: r.owner, name: r.name }))
  );
  for (const item of giteaResult.items) {
    const proj = projectMap.get(`${item.owner}/${item.name}`);
    if (proj) {
      touchLastSync({ giteaAccountId: args.giteaAccountId, owner: item.owner, name: item.name });
      if (!proj.defaultBranch && item.defaultBranch) {
        backfillDefaultBranch({
          giteaAccountId: args.giteaAccountId,
          owner: item.owner,
          name: item.name,
          defaultBranch: item.defaultBranch
        });
      }
    }
  }
  const items = giteaResult.items.map((r) => {
    const proj = projectMap.get(`${r.owner}/${r.name}`);
    return {
      ...r,
      isProject: Boolean(proj),
      lastSyncAt: proj?.lastSyncAt ?? void 0
    };
  });
  const resp = {
    items,
    total: items.length,
    page: args.page,
    hasMore: giteaResult.hasMore
  };
  setReposCache({
    giteaAccountId: args.giteaAccountId,
    cacheKey: cacheKey2,
    payload: JSON.stringify(resp)
  });
  logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, "ipc done");
  return resp;
}
async function reposAddProjectHandler(args) {
  const start = Date.now();
  const op = "repos.addProject";
  logger.info({ op, args }, "ipc start");
  resolveGiteaAccount(args.giteaAccountId);
  const { result: project } = await dispatch("repos.addProject", args);
  logger.info({ op, latencyMs: Date.now() - start, projectId: project.id }, "ipc done");
  return project;
}
async function reposRemoveProjectHandler(args) {
  const start = Date.now();
  const op = "repos.removeProject";
  logger.info({ op, args }, "ipc start");
  await dispatch("repos.removeProject", args);
  logger.info({ op, latencyMs: Date.now() - start }, "ipc done");
}
function registerReposIpc() {
  registerOp("repos.addProject", {
    execute: async (a) => addProject(a)
  });
  registerOp("repos.removeProject", {
    execute: async (a) => removeProject(a.projectId)
  });
  wrapIpc$b(IpcChannel.REPOS_LIST, ListReposArgsSchema, reposListHandler);
  wrapIpc$b(IpcChannel.REPOS_ADD_PROJECT, AddProjectArgsSchema, reposAddProjectHandler);
  wrapIpc$b(IpcChannel.REPOS_REMOVE_PROJECT, RemoveProjectArgsSchema, reposRemoveProjectHandler);
}
function unregisterReposIpc() {
  ipcMain.removeHandler(IpcChannel.REPOS_LIST);
  ipcMain.removeHandler(IpcChannel.REPOS_ADD_PROJECT);
  ipcMain.removeHandler(IpcChannel.REPOS_REMOVE_PROJECT);
}
function resolveProject(projectId) {
  const state = getLocalStore().get();
  const proj = findProjectByIdWithStore(state, projectId);
  if (!proj) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "项目不存在",
      hint: "请先在仓库列表中重新添加该仓库为项目"
    });
  }
  const acc = findAccountByIdWithStore(state, proj.giteaAccountId);
  if (!acc) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "gitea 账户不存在（项目孤儿）",
      hint: "请重新连接 gitea 账户"
    });
  }
  return {
    giteaUrl: acc.giteaUrl,
    username: acc.username,
    owner: proj.owner,
    repo: proj.name,
    defaultBranch: proj.defaultBranch
  };
}
function branchToDto(b) {
  return {
    name: b.name ?? "<unknown>",
    sha: b.commit?.id ?? "",
    protected: Boolean(b.protected),
    isDefault: false,
    // 由 IPC handler 跟 repo_projects.defaultBranch 比对后填充
    starred: false
    // 由 cache/branches.ts 的 starred_branches JOIN 覆盖
  };
}
async function listGiteaBranches(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoListBranches(args.owner, args.repo, { page, limit });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/branches列表失败`);
  const items = raws.map(branchToDto);
  return {
    items,
    hasMore: raws.length === limit
  };
}
async function renameGiteaBranch(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoUpdateBranch(args.owner, args.repo, args.oldName, { name: args.newName });
  const raw = unwrapGitea(res, `重命名分支 ${args.oldName}失败`);
  return branchToDto(raw);
}
function listStarredBranchesWithStore(state, projectId) {
  return new Set(
    state.starredBranches.filter((s) => s.projectId === projectId).map((s) => s.branch)
  );
}
const CACHE_RESOURCE$3 = "branches";
const BRANCHES_LIST_TTL_SECONDS = 1 * 60;
function listStarredBranches(projectId) {
  return listStarredBranchesWithStore(getLocalStore().get(), projectId);
}
function setStarred(args) {
  const store = getLocalStore();
  if (args.starred) {
    const existing = store.get().starredBranches.some(
      (s) => s.projectId === args.projectId && s.branch === args.branch
    );
    if (!existing) {
      const newRow = {
        id: randomUUID(),
        projectId: args.projectId,
        branch: args.branch,
        createdAt: Date.now()
      };
      store.mutate((s) => {
        s.starredBranches.push(newRow);
      });
    }
  } else {
    const existingLocal = store.get().starredBranches.find(
      (s) => s.projectId === args.projectId && s.branch === args.branch
    );
    if (existingLocal) {
      store.mutate((s) => {
        s.starredBranches = s.starredBranches.filter(
          (s2) => !(s2.projectId === args.projectId && s2.branch === args.branch)
        );
      });
    }
  }
  invalidateBranchesCache(args.projectId);
}
function getBranchesCache(args) {
  return getCache({ resource: CACHE_RESOURCE$3, projectId: args.projectId, key: args.cacheKey });
}
function setBranchesCache(args) {
  setCache({
    resource: CACHE_RESOURCE$3,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? BRANCHES_LIST_TTL_SECONDS
  });
}
function invalidateBranchesCache(projectId) {
  invalidateCache({ resource: CACHE_RESOURCE$3, projectId });
}
function wrapIpc$a(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function makeCacheKey(args) {
  return `project=${args.projectId}|query=${args.query ?? ""}|page=${args.page}|limit=${args.limit}`;
}
async function branchesListHandler(args) {
  const start = Date.now();
  const op = "branches.list";
  logger.info({ op, args: { projectId: args.projectId, query: args.query, page: args.page, limit: args.limit } }, "ipc start");
  const cacheKey2 = makeCacheKey(args);
  const cached = getBranchesCache({ projectId: args.projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const proj = resolveProject(args.projectId);
  const giteaResult = await listGiteaBranches({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    page: args.page,
    limit: args.limit
  });
  const starredSet = listStarredBranches(args.projectId);
  const items = giteaResult.items.map((b) => ({
    ...b,
    isDefault: proj.defaultBranch != null && b.name === proj.defaultBranch,
    starred: starredSet.has(b.name)
  }));
  const resp = {
    items,
    total: items.length,
    hasMore: giteaResult.hasMore
  };
  setBranchesCache({ projectId: args.projectId, cacheKey: cacheKey2, payload: JSON.stringify(resp) });
  logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, "ipc done");
  return resp;
}
async function branchesRenameHandler(args) {
  const start = Date.now();
  const op = "branches.rename";
  logger.info({ op, args }, "ipc start");
  const proj = resolveProject(args.projectId);
  if (proj.defaultBranch === args.oldName) {
    throw new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: "不能重命名默认分支",
      hint: "默认分支在 gitea 端有特殊处理，不允许重命名"
    });
  }
  const renamed = await renameGiteaBranch({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    oldName: args.oldName,
    newName: args.newName
  });
  invalidateBranchesCache(args.projectId);
  setStarred({ projectId: args.projectId, branch: args.newName, starred: true });
  setStarred({ projectId: args.projectId, branch: args.oldName, starred: false });
  logger.info({ op, latencyMs: Date.now() - start, oldName: args.oldName, newName: args.newName }, "ipc done");
  return { ...renamed, isDefault: false };
}
async function branchesStarHandler(args) {
  const start = Date.now();
  const op = "branches.star";
  logger.info({ op, args: { projectId: args.projectId, branch: args.branch, starred: args.starred } }, "ipc start");
  await dispatch("branches.star", args);
  logger.info({ op, latencyMs: Date.now() - start }, "ipc done");
}
function registerBranchesIpc() {
  registerOp("branches.star", {
    execute: setStarred
  });
  wrapIpc$a(IpcChannel.BRANCHES_LIST, ListBranchesArgsSchema, branchesListHandler);
  wrapIpc$a(IpcChannel.BRANCHES_RENAME, RenameBranchArgsSchema, branchesRenameHandler);
  wrapIpc$a(IpcChannel.BRANCHES_STAR, StarBranchArgsSchema, branchesStarHandler);
}
function unregisterBranchesIpc() {
  ipcMain.removeHandler(IpcChannel.BRANCHES_LIST);
  ipcMain.removeHandler(IpcChannel.BRANCHES_RENAME);
  ipcMain.removeHandler(IpcChannel.BRANCHES_STAR);
}
function extractFunctionsFromPatch(patch) {
  if (!patch) return [];
  const headings = [];
  const re = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@\s*(.*)$/gm;
  for (let m = re.exec(patch); m !== null; m = re.exec(patch)) {
    const h = m[1]?.trim() ?? "";
    if (h) headings.push(h);
  }
  return headings;
}
function parseUnifiedDiff(diff) {
  if (!diff) return [];
  const out = [];
  const fileHeaders = diff.split(/^diff --git /m);
  for (let i = 1; i < fileHeaders.length; i++) {
    const section = fileHeaders[i];
    const entry = parseOneFileSection(section);
    if (entry) out.push(entry);
  }
  return out;
}
function parseOneFileSection(section) {
  const lines = section.split("\n");
  const firstLine = lines[0] ?? "";
  const m = firstLine.match(/^a\/(.+?)\s+b\/(.+?)$/);
  if (!m) return null;
  let newPath = m[2];
  let status = "modified";
  let previousFilename;
  let binary = false;
  let patchStartIdx = 0;
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("new file mode")) {
      status = "added";
      patchStartIdx = i + 1;
    } else if (ln.startsWith("deleted file mode")) {
      status = "deleted";
      patchStartIdx = i + 1;
    } else if (ln.startsWith("rename from ")) {
      status = "renamed";
      previousFilename = ln.slice("rename from ".length);
      patchStartIdx = i + 1;
    } else if (ln.startsWith("rename to ")) {
      newPath = ln.slice("rename to ".length);
    } else if (ln.startsWith("Binary files ")) {
      status = "binary";
      binary = true;
      patchStartIdx = i + 1;
      break;
    } else if (ln.startsWith("@@")) {
      patchStartIdx = i;
      break;
    }
  }
  const patch = lines.slice(patchStartIdx).join("\n");
  let additions = 0;
  let deletions = 0;
  if (!binary) {
    for (const ln of lines.slice(patchStartIdx)) {
      if (ln.startsWith("+") && !ln.startsWith("+++")) additions++;
      else if (ln.startsWith("-") && !ln.startsWith("---")) deletions++;
    }
  }
  return {
    status,
    filename: newPath,
    previousFilename,
    additions,
    deletions,
    binary,
    patch
  };
}
function mergeToFileChangeDtos(diffParse, giteaFiles) {
  const giteaStatusByName = /* @__PURE__ */ new Map();
  for (const f of giteaFiles) {
    if (f.filename) giteaStatusByName.set(f.filename, f.status);
  }
  return diffParse.map((entry) => {
    const fallbackStatus = giteaStatusByName.get(entry.filename);
    const status = entry.status !== "unknown" ? entry.status : fallbackStatus ?? "unknown";
    const functions = entry.binary ? void 0 : extractFunctionsFromPatch(entry.patch);
    return {
      filename: entry.filename,
      status,
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.additions + entry.deletions,
      ...entry.previousFilename ? { previousFilename: entry.previousFilename } : {},
      ...entry.binary ? { binary: true } : {},
      ...functions && functions.length > 0 ? { functions } : {}
    };
  });
}
function toCommitDto(c) {
  const authorName = c.commit?.author?.name ?? "<unknown>";
  const authorEmail = c.commit?.author?.email ?? "";
  const authorDate = c.commit?.author?.date ?? (/* @__PURE__ */ new Date(0)).toISOString();
  const committerName = c.commit?.committer?.name ?? authorName;
  const committerEmail = c.commit?.committer?.email ?? authorEmail;
  const authorAvatar = c.author?.avatar_url;
  const author = {
    name: authorName,
    email: authorEmail,
    ...authorAvatar ? { avatarUrl: authorAvatar } : {}
  };
  const committer = {
    name: committerName,
    email: committerEmail
  };
  const base = {
    sha: c.sha ?? "",
    shortSha: (c.sha ?? "").slice(0, 7),
    message: c.commit?.message ?? "",
    author,
    committer,
    date: authorDate,
    parents: (c.parents ?? []).map((p) => p.sha ?? "").filter((s) => s !== "")
  };
  const stats = c.stats;
  const filesArr = c.files ?? [];
  const hasFiles = filesArr.length > 0;
  if (stats) {
    return {
      ...base,
      ...stats.additions !== void 0 ? { additions: stats.additions } : {},
      ...stats.deletions !== void 0 ? { deletions: stats.deletions } : {},
      ...hasFiles ? { filesChanged: filesArr.length } : {}
    };
  }
  if (hasFiles) {
    return { ...base, filesChanged: filesArr.length };
  }
  return base;
}
async function listGiteaCommits(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoGetAllCommits(args.owner, args.repo, {
    ...args.sha !== void 0 ? { sha: args.sha } : {},
    ...args.path !== void 0 ? { path: args.path } : {},
    ...args.author !== void 0 ? { author: args.author } : {},
    ...args.since !== void 0 ? { since: args.since } : {},
    ...args.until !== void 0 ? { until: args.until } : {},
    page,
    limit
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/commits列表失败`);
  const items = raws.map(toCommitDto);
  return {
    items,
    hasMore: raws.length === limit
  };
}
async function getGiteaCommit(args) {
  const { api, baseUrl, token } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoGetAllCommits(args.owner, args.repo, {
    sha: args.sha,
    limit: 1,
    stat: true,
    files: true
  });
  const raws = unwrapGitea(
    res,
    `获取 commit ${args.sha} 失败`
  );
  const raw = raws[0];
  if (!raw) {
    throw new Error(`commit ${args.sha} 不存在或仓库不可达`);
  }
  const dto = toCommitDto(raw);
  logger.info(
    {
      op: "commits.get",
      sha: args.sha,
      hasStats: !!raw.stats,
      fileCount: raw.files?.length ?? 0,
      adds: raw.stats?.additions,
      dels: raw.stats?.deletions
    },
    "list endpoint returned"
  );
  let diffText = null;
  let diffFetchError = null;
  try {
    const diffUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1/repos/${args.owner}/${args.repo}/git/commits/${args.sha}.diff`;
    logger.info({ op: "commits.get.diff", sha: args.sha, diffUrl }, "fetching diff");
    const dr = await globalThis.fetch(diffUrl, {
      headers: {
        Accept: "text/plain",
        ...token ? { Authorization: `token ${token}` } : {}
      }
    });
    if (dr.ok) {
      diffText = await dr.text();
      logger.info({ op: "commits.get.diff", sha: args.sha, diffLen: diffText.length }, "diff fetched");
    } else {
      diffFetchError = `HTTP ${dr.status}`;
      logger.warn({ op: "commits.get.diff", sha: args.sha, status: dr.status }, "diff fetch non-ok");
    }
  } catch (e) {
    diffFetchError = e.message;
    logger.warn({ op: "commits.get.diff", sha: args.sha, err: diffFetchError }, "diff fetch threw");
  }
  if (diffText) {
    const parsed = parseUnifiedDiff(diffText);
    logger.info({ op: "commits.get.parse", sha: args.sha, parsedCount: parsed.length }, "diff parsed");
    const giteaFiles = raw.files ?? [];
    const files = mergeToFileChangeDtos(parsed, giteaFiles);
    if (files.length > 0) {
      dto.files = files;
      dto.filesChanged = files.length;
      if (dto.additions === void 0 || dto.deletions === void 0) {
        const adds = files.reduce((s, f) => s + (f.binary ? 0 : f.additions ?? 0), 0);
        const dels = files.reduce((s, f) => s + (f.binary ? 0 : f.deletions ?? 0), 0);
        dto.additions = adds;
        dto.deletions = dels;
      }
      logger.info(
        {
          op: "commits.get",
          sha: args.sha,
          fileCount: files.length,
          adds: dto.additions,
          dels: dto.deletions
        },
        "files attached"
      );
    }
  } else if (diffFetchError) {
    logger.warn(
      { op: "commits.get", sha: args.sha, diffFetchError },
      "no per-file details (diff fetch failed); 顶层 stats 保留"
    );
  }
  return dto;
}
function toPullDto(r) {
  const number = r.number ?? r.id ?? 0;
  const mergeable = r.mergeable === true;
  return {
    index: number,
    title: r.title ?? "",
    state: r.state === "closed" ? "closed" : "open",
    draft: Boolean(r.draft),
    merged: Boolean(r.merged),
    head: { ref: r.head?.ref ?? "", sha: r.head?.sha ?? "" },
    base: { ref: r.base?.ref ?? "", sha: r.base?.sha ?? "" },
    author: {
      username: r.user?.login ?? "<unknown>",
      ...r.user?.avatar_url ? { avatarUrl: r.user.avatar_url } : {}
    },
    createdAt: r.created_at ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: r.updated_at ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    mergeable,
    // 关键映射：gitea mergeable=false → 我们 hasConflicts=true
    hasConflicts: !mergeable,
    // ===== v1.1 补充字段 =====
    labels: (r.labels ?? []).map((l) => ({
      id: l.id ?? 0,
      name: l.name ?? "",
      color: l.color ?? "#ccc"
    })),
    milestone: r.milestone ? { id: r.milestone.id ?? 0, title: r.milestone.title ?? "" } : null,
    assignee: r.assignee ? { username: r.assignee.login ?? "" } : null,
    assignees: (r.assignees ?? []).map((a) => ({ username: a.login ?? "" })),
    reviewers: (r.requested_reviewers ?? []).map((u) => ({ username: u.login ?? "" })),
    mergedBy: r.merged_by ? { username: r.merged_by.login ?? "" } : null,
    commentsCount: r.comments ?? 0,
    body: r.body ?? ""
  };
}
async function listGiteaPulls(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoListPullRequests(args.owner, args.repo, {
    ...args.state !== void 0 ? { state: args.state } : {},
    ...args.sort !== void 0 ? { sort: args.sort } : {},
    ...args.milestone !== void 0 ? { milestone: args.milestone } : {},
    ...args.labels !== void 0 ? { labels: args.labels } : {},
    ...args.poster !== void 0 ? { poster: args.poster } : {},
    page,
    limit
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/pulls列表失败`);
  const items = raws.map(toPullDto);
  return { items, hasMore: raws.length === limit };
}
async function getGiteaPull(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.repoGetPullRequest(args.owner, args.repo, args.index);
  const raw = unwrapGitea(res, `获取 PR #${args.index}失败`);
  return toPullDto(raw);
}
async function mergeGiteaPull(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  try {
    const res = await api.repos.repoMergePullRequest(args.owner, args.repo, args.index, {
      Do: args.method,
      ...args.deleteBranchAfter !== void 0 ? { delete_branch_after_merge: args.deleteBranchAfter } : {},
      ...args.commitMessage !== void 0 ? { MergeMessageField: args.commitMessage } : {}
    });
    if (res.ok) {
      return {
        sha: "",
        merged: true,
        message: "merge success"
      };
    }
    const raw = unwrapGitea(res, `合并 PR #${args.index}失败`);
    return {
      sha: raw?.sha ?? "",
      merged: raw?.merged ?? true,
      message: raw?.message ?? ""
    };
  } catch (err) {
    if (err && typeof err === "object" && "ok" in err && "status" in err) {
      const httpErr = err;
      unwrapGitea(httpErr, `合并 PR #${args.index}失败`);
    }
    throw err;
  }
}
async function closeGiteaPull(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  try {
    const res = await api.repos.repoEditPullRequest(args.owner, args.repo, args.index, {
      state: "closed"
    });
    if (res.ok) {
      return { closed: true };
    }
    unwrapGitea(res, `关闭 PR #${args.index}失败`);
    return { closed: true };
  } catch (err) {
    if (err && typeof err === "object" && "ok" in err && "status" in err) {
      const httpErr = err;
      unwrapGitea(httpErr, `关闭 PR #${args.index}失败`);
    }
    throw err;
  }
}
async function updatePullLabels(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueReplaceLabels(args.owner, args.repo, args.index, {
    labels: args.labels
  });
  if (!res.ok) {
    unwrapGitea(res, `更新 PR #${args.index}标签失败`);
  }
}
async function updatePullAssignee(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueEditIssue(args.owner, args.repo, args.index, {
    assignee: args.assignee
  });
  if (!res.ok) {
    unwrapGitea(res, `更新 PR #${args.index}指派人失败`);
  }
}
async function updatePullReviewers(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  try {
    const res = await api.repos.repoCreatePullReviewRequests(args.owner, args.repo, args.index, {
      reviewers: args.reviewers
    });
    if (res.ok) return;
    unwrapGitea(res, `更新 PR #${args.index}评审人失败`);
  } catch (err) {
    if (err && typeof err === "object" && "ok" in err && "status" in err) {
      const httpErr = err;
      unwrapGitea(httpErr, `更新 PR #${args.index}评审人失败`);
    }
    throw err;
  }
}
const CACHE_RESOURCE$2 = "commits";
const COMMITS_LIST_TTL_SECONDS = 2 * 60;
function getLinkedCardsForCommits(_args) {
  return /* @__PURE__ */ new Map();
}
function getLinkedCardsForCommit(_args) {
  return [];
}
function getLinkedCardsForPulls(_args) {
  return /* @__PURE__ */ new Map();
}
function getLinkedCardsForPull(_args) {
  return [];
}
function getCommitsCache(args) {
  return getCache({ resource: CACHE_RESOURCE$2, projectId: args.projectId, key: args.cacheKey });
}
function setCommitsCache(args) {
  setCache({
    resource: CACHE_RESOURCE$2,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? COMMITS_LIST_TTL_SECONDS
  });
}
function invalidateCommitsCache(projectId) {
  invalidateCache({ resource: CACHE_RESOURCE$2, projectId });
}
const CACHE_RESOURCE$1 = "pulls";
const PULLS_LIST_TTL_SECONDS = 30;
function getPullsCache(args) {
  return getCache({ resource: CACHE_RESOURCE$1, projectId: args.projectId, key: args.cacheKey });
}
function setPullsCache(args) {
  setCache({
    resource: CACHE_RESOURCE$1,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? PULLS_LIST_TTL_SECONDS
  });
}
function invalidatePullsCache(projectId) {
  invalidateCache({ resource: CACHE_RESOURCE$1, projectId });
}
const CACHE_RESOURCE = "timeline";
const TIMELINE_TTL_SECONDS = 30;
function makeTimelineCacheKey(args) {
  const branches = [...args.branches].sort();
  return [
    `project=${args.projectId}`,
    `branches=${branches.join(",")}`,
    `since=${args.since ?? ""}`,
    `until=${args.until ?? ""}`,
    `laneMode=${args.laneMode}`,
    `maxNodes=${args.maxNodes}`
  ].join("|");
}
function getTimelineCache(args) {
  return getCache({ resource: CACHE_RESOURCE, projectId: args.projectId, key: args.cacheKey });
}
function setTimelineCache(args) {
  setCache({
    resource: CACHE_RESOURCE,
    projectId: args.projectId,
    key: args.cacheKey,
    payload: args.payload,
    ttlSeconds: args.ttlSeconds ?? TIMELINE_TTL_SECONDS
  });
}
const LANE_COLOR_PRIMARY = "#609926";
const LANE_COLOR_ACTIVE = "#f76707";
const LANE_COLOR_ARCHIVED = "#6c757d";
function buildTimeline(input) {
  const { args, commitsByBranch, pulls, linkedCardIdsBySha } = input;
  const maxNodes = args.maxNodes;
  const commitMap = /* @__PURE__ */ new Map();
  const branchHintsBySha = /* @__PURE__ */ new Map();
  for (const branch of args.branches) {
    const list = commitsByBranch[branch] ?? [];
    for (const c of list) {
      const existing = commitMap.get(c.sha);
      if (existing) {
        existing.branchHints.push(branch);
      } else {
        commitMap.set(c.sha, {
          id: c.sha,
          laneId: "",
          // 后面 lane 分配阶段填
          x: 0,
          // 后面归一化阶段填
          y: 0,
          // 后面 lane.order 填
          sha: c.sha,
          shortSha: c.shortSha,
          message: c.message.split("\n", 1)[0] ?? c.message,
          author: { name: c.author.name, ...c.author.avatarUrl ? { avatarUrl: c.author.avatarUrl } : {} },
          timestamp: c.date,
          parents: [...c.parents],
          isMerge: c.parents.length > 1,
          branchHints: [branch],
          linkedCardIds: linkedCardIdsBySha.get(c.sha) ?? [],
          ...c.additions !== void 0 ? { additions: c.additions } : {},
          ...c.deletions !== void 0 ? { deletions: c.deletions } : {},
          ...c.filesChanged !== void 0 ? { filesChanged: c.filesChanged } : {}
        });
      }
      const hints = branchHintsBySha.get(c.sha) ?? [];
      if (!hints.includes(branch)) hints.push(branch);
      branchHintsBySha.set(c.sha, hints);
    }
  }
  const lanes = buildLanes(args.laneMode, args.branches, commitMap, pulls);
  assignLanes(args.laneMode, lanes, commitMap, pulls);
  const timestamps = [...commitMap.values()].map((n) => Date.parse(n.timestamp));
  const minT = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxT = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const tRange = maxT - minT || 1;
  for (const n of commitMap.values()) {
    n.x = (Date.parse(n.timestamp) - minT) / tRange;
    n.y = lanes.find((l) => l.id === n.laneId)?.order ?? 0;
  }
  const edges = [];
  for (const n of commitMap.values()) {
    for (const parentSha of n.parents) {
      if (commitMap.has(parentSha)) {
        edges.push({
          id: `${n.sha}->${parentSha}:parent`,
          source: n.sha,
          target: parentSha,
          kind: "parent"
        });
      }
    }
  }
  for (const pr of pulls) {
    if (pr.state !== "merged") continue;
    if (!pr.mergedAt) continue;
  }
  const allNodes = [...commitMap.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const totalCommits = allNodes.length;
  const truncated = totalCommits > maxNodes;
  const nodes = truncated ? allNodes.slice(-maxNodes) : allNodes;
  const nodeShaSet = new Set(nodes.map((n) => n.sha));
  const edgesFiltered = edges.filter((e) => nodeShaSet.has(e.source) && nodeShaSet.has(e.target));
  const from = args.since ?? (totalCommits > 0 ? new Date(minT).toISOString() : (/* @__PURE__ */ new Date()).toISOString());
  const to = args.until ?? (totalCommits > 0 ? new Date(maxT).toISOString() : (/* @__PURE__ */ new Date()).toISOString());
  return {
    ...args.since ? { windowStart: args.since } : {},
    ...args.until ? { windowEnd: args.until } : {},
    range: { from, to },
    lanes,
    nodes,
    edges: edgesFiltered,
    prs: pulls,
    truncated,
    totalCommits
  };
}
function buildLanes(mode, branches, commitMap, pulls) {
  if (mode === "branch") {
    return branches.map((b, idx) => ({
      id: `branch:${b}`,
      label: b,
      kind: "branch",
      // 拍板 02 §5.3.4：main 在最上用主色；其它按出现顺序交替 active/archived
      color: idx === 0 && b === "main" ? LANE_COLOR_PRIMARY : idx % 2 === 0 ? LANE_COLOR_ACTIVE : LANE_COLOR_ARCHIVED,
      order: idx
    }));
  }
  if (mode === "author") {
    const authors = /* @__PURE__ */ new Set();
    for (const n of commitMap.values()) authors.add(n.author.name);
    const sortedAuthors = [...authors].sort();
    return sortedAuthors.map((a, idx) => ({
      id: `author:${a}`,
      label: a,
      kind: "author",
      color: idx === 0 ? LANE_COLOR_PRIMARY : idx % 2 === 0 ? LANE_COLOR_ACTIVE : LANE_COLOR_ARCHIVED,
      order: idx
    }));
  }
  return pulls.filter((p) => p.state === "merged").map((p, idx) => ({
    id: `pr:${p.index}`,
    label: `#${p.index} ${p.title}`,
    kind: "pr",
    color: idx === 0 ? LANE_COLOR_PRIMARY : idx % 2 === 0 ? LANE_COLOR_ACTIVE : LANE_COLOR_ARCHIVED,
    order: idx
  }));
}
function assignLanes(mode, lanes, commitMap, pulls) {
  if (lanes.length === 0) return;
  const fallbackLane = lanes[0].id;
  if (mode === "branch") {
    for (const n of commitMap.values()) {
      const first = n.branchHints[0];
      const lane = first ? lanes.find((l) => l.id === `branch:${first}`) : void 0;
      n.laneId = lane?.id ?? fallbackLane;
    }
    return;
  }
  if (mode === "author") {
    for (const n of commitMap.values()) {
      const lane = lanes.find((l) => l.id === `author:${n.author.name}`);
      n.laneId = lane?.id ?? fallbackLane;
    }
    return;
  }
  const firstMergedPr = pulls.find((p) => p.state === "merged");
  const prFallbackLane = firstMergedPr ? `pr:${firstMergedPr.index}` : fallbackLane;
  for (const n of commitMap.values()) {
    if (n.isMerge) {
      n.laneId = prFallbackLane;
    } else {
      n.laneId = fallbackLane;
    }
  }
}
function wrapIpc$9(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
async function listGiteaPullsCached(projectId, proj, state, limit) {
  const cacheKey2 = `state=${state}|page=1|limit=${limit}`;
  const cached = getPullsCache({ projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
    }
  }
  const r = await listGiteaPulls({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    state,
    limit
  });
  setPullsCache({
    projectId,
    cacheKey: cacheKey2,
    payload: JSON.stringify(r),
    ttlSeconds: PULLS_LIST_TTL_SECONDS
  });
  return r;
}
function makeListCacheKey$1(args) {
  return [
    `project=${args.projectId}`,
    `sha=${args.sha ?? ""}`,
    `path=${args.path ?? ""}`,
    `author=${args.author ?? ""}`,
    `since=${args.since ?? ""}`,
    `until=${args.until ?? ""}`,
    `page=${args.page}`,
    `limit=${args.limit}`
  ].join("|");
}
function makeBranchCommitsCacheKey(projectId, branch, since, until, limit) {
  return [
    `project=${projectId}`,
    `sha=${branch}`,
    `since=${since ?? ""}`,
    `until=${until ?? ""}`,
    `limit=${limit}`
  ].join("|");
}
async function commitsListHandler(args) {
  const start = Date.now();
  const op = "commits.list";
  logger.info({ op, args: { projectId: args.projectId, page: args.page, limit: args.limit } }, "ipc start");
  const cacheKey2 = makeListCacheKey$1(args);
  const cached = getCommitsCache({ projectId: args.projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const proj = resolveProject(args.projectId);
  try {
    const giteaResult = await listGiteaCommits({
      giteaUrl: proj.giteaUrl,
      username: proj.username,
      owner: proj.owner,
      repo: proj.repo,
      sha: args.sha,
      path: args.path,
      author: args.author,
      since: args.since,
      until: args.until,
      page: args.page,
      limit: args.limit
    });
    const linkedCardsMap = getLinkedCardsForCommits({
      owner: proj.owner,
      repo: proj.repo,
      shas: giteaResult.items.map((c) => c.sha)
    });
    const items = giteaResult.items.map((c) => ({
      ...c,
      linkedCards: linkedCardsMap.get(c.sha) ?? []
    }));
    const resp = {
      items,
      total: items.length,
      hasMore: giteaResult.hasMore,
      nextPage: giteaResult.hasMore ? args.page + 1 : null
    };
    setCommitsCache({ projectId: args.projectId, cacheKey: cacheKey2, payload: JSON.stringify(resp) });
    logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, "ipc done");
    return resp;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn({ op, latencyMs: Date.now() - start }, "gitea unreachable, falling back to cache");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          parsed["__offline"] = true;
          logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, offline: true }, "ipc done (offline)");
          return parsed;
        } catch {
        }
      }
      const offlineResp = { items: [], total: 0, hasMore: false, nextPage: null };
      offlineResp["__offline"] = true;
      logger.info({ op, latencyMs: Date.now() - start, offline: true }, "ipc done (offline, no cache)");
      return offlineResp;
    }
    throw err;
  }
}
async function commitsGetHandler(args) {
  const start = Date.now();
  const op = "commits.get";
  logger.info({ op, args }, "ipc start");
  const cacheKey2 = `project=${args.projectId}|sha=${args.sha}`;
  const cached = getCommitsCache({ projectId: args.projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, sha: args.sha, hit: true }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const proj = resolveProject(args.projectId);
  const commit = await getGiteaCommit({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    sha: args.sha
  });
  const linkedCards = getLinkedCardsForCommit({
    sha: args.sha
  });
  const dto = { ...commit, linkedCards };
  setCommitsCache({
    projectId: args.projectId,
    cacheKey: cacheKey2,
    payload: JSON.stringify(dto),
    ttlSeconds: 5 * 60
  });
  logger.info({ op, latencyMs: Date.now() - start, sha: args.sha, hit: false }, "ipc done");
  return dto;
}
async function commitsTimelineHandler(args) {
  const start = Date.now();
  const op = "commits.timeline";
  logger.info(
    { op, args: { projectId: args.projectId, branches: args.branches.length, laneMode: args.laneMode, maxNodes: args.maxNodes } },
    "ipc start"
  );
  const cacheKey2 = makeTimelineCacheKey(args);
  const cached = getTimelineCache({ projectId: args.projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, hit: true, totalCommits: parsed.totalCommits }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const proj = resolveProject(args.projectId);
  try {
    const commitsByBranch = {};
    for (const branch of args.branches) {
      const branchCacheKey = makeBranchCommitsCacheKey(
        args.projectId,
        branch,
        args.since,
        args.until,
        args.maxNodes
      );
      const cachedBranch = getCommitsCache({ projectId: args.projectId, cacheKey: branchCacheKey });
      if (cachedBranch) {
        try {
          const parsed = JSON.parse(cachedBranch);
          commitsByBranch[branch] = parsed.items;
          continue;
        } catch {
        }
      }
      const r = await listGiteaCommits({
        giteaUrl: proj.giteaUrl,
        username: proj.username,
        owner: proj.owner,
        repo: proj.repo,
        sha: branch,
        since: args.since,
        until: args.until,
        page: 1,
        limit: args.maxNodes
        // 拉够 maxNodes 即可（任务 prompt §关键约束 12）
      });
      commitsByBranch[branch] = r.items;
      setCommitsCache({
        projectId: args.projectId,
        cacheKey: branchCacheKey,
        payload: JSON.stringify({ items: r.items }),
        ttlSeconds: COMMITS_LIST_TTL_SECONDS
      });
    }
    const prsOpen = await listGiteaPullsCached(args.projectId, proj, "open", 100);
    const prsClosed = await listGiteaPullsCached(args.projectId, proj, "closed", 100);
    const timelinePrs = [...prsOpen.items, ...prsClosed.items].map((p) => {
      const state = p.merged ? "merged" : p.state === "all" ? "open" : p.state;
      return {
        id: `pr:${proj.owner}/${proj.repo}/${p.index}`,
        index: p.index,
        title: p.title,
        state,
        head: p.head.ref,
        base: p.base.ref,
        author: { name: p.author.username, ...p.author.avatarUrl ? { avatarUrl: p.author.avatarUrl } : {} },
        url: `${proj.giteaUrl.replace(/\/+$/, "")}/${proj.owner}/${proj.repo}/pulls/${p.index}`,
        ...p.merged && p.updatedAt ? { mergedAt: p.updatedAt } : {}
      };
    });
    const allShas = /* @__PURE__ */ new Set();
    for (const list of Object.values(commitsByBranch)) {
      for (const c of list) allShas.add(c.sha);
    }
    const linkedCardsMap = getLinkedCardsForCommits({
      owner: proj.owner,
      repo: proj.repo,
      shas: [...allShas]
    });
    const linkedCardIdsBySha = /* @__PURE__ */ new Map();
    for (const [sha, links] of linkedCardsMap.entries()) {
      linkedCardIdsBySha.set(sha, links.map((l) => l.cardId));
    }
    const dto = buildTimeline({ args, commitsByBranch, pulls: timelinePrs, linkedCardIdsBySha });
    setTimelineCache({ projectId: args.projectId, cacheKey: cacheKey2, payload: JSON.stringify(dto) });
    logger.info(
      { op, latencyMs: Date.now() - start, totalCommits: dto.totalCommits, nodes: dto.nodes.length, truncated: dto.truncated },
      "ipc done"
    );
    return dto;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn({ op, latencyMs: Date.now() - start }, "gitea unreachable, falling back to timeline cache");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          parsed["__offline"] = true;
          logger.info({ op, latencyMs: Date.now() - start, offline: true, totalCommits: parsed.totalCommits }, "ipc done (offline)");
          return parsed;
        } catch {
        }
      }
      const offlineDto = {
        windowStart: void 0,
        windowEnd: void 0,
        range: {
          from: args.since ?? (/* @__PURE__ */ new Date(0)).toISOString(),
          to: args.until ?? (/* @__PURE__ */ new Date()).toISOString()
        },
        lanes: [],
        nodes: [],
        edges: [],
        prs: [],
        truncated: false,
        totalCommits: 0
      };
      offlineDto["__offline"] = true;
      logger.info({ op, latencyMs: Date.now() - start, offline: true }, "ipc done (offline, no cache)");
      return offlineDto;
    }
    throw err;
  }
}
function registerCommitsIpc() {
  wrapIpc$9(IpcChannel.COMMITS_LIST, ListCommitsArgsSchema, commitsListHandler);
  wrapIpc$9(IpcChannel.COMMITS_GET, GetCommitArgsSchema, commitsGetHandler);
  wrapIpc$9(IpcChannel.COMMITS_TIMELINE, TimelineArgsSchema, commitsTimelineHandler);
}
function unregisterCommitsIpc() {
  ipcMain.removeHandler(IpcChannel.COMMITS_LIST);
  ipcMain.removeHandler(IpcChannel.COMMITS_GET);
  ipcMain.removeHandler(IpcChannel.COMMITS_TIMELINE);
}
function wrapIpc$8(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function makeListCacheKey(args) {
  return [
    `project=${args.projectId}`,
    `state=${args.state ?? ""}`,
    `head=${args.head ?? ""}`,
    `base=${args.base ?? ""}`,
    `author=${args.author ?? ""}`,
    `page=${args.page}`,
    `limit=${args.limit}`
  ].join("|");
}
async function pullsListHandler(args) {
  const start = Date.now();
  const op = "pulls.list";
  logger.info({ op, args: { projectId: args.projectId, state: args.state, page: args.page } }, "ipc start");
  const cacheKey2 = makeListCacheKey(args);
  const cached = getPullsCache({ projectId: args.projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, hit: true }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const proj = resolveProject(args.projectId);
  try {
    const giteaResult = await listGiteaPulls({
      giteaUrl: proj.giteaUrl,
      username: proj.username,
      owner: proj.owner,
      repo: proj.repo,
      state: args.state,
      page: args.page,
      limit: args.limit
    });
    const linkedCardsMap = getLinkedCardsForPulls({
      owner: proj.owner,
      repo: proj.repo,
      indexes: giteaResult.items.map((p) => p.index)
    });
    const items = giteaResult.items.map((p) => ({
      ...p,
      linkedCards: linkedCardsMap.get(p.index) ?? []
    }));
    const resp = {
      items,
      total: giteaResult.hasMore ? items.length + 1 : items.length,
      // hasMore 时 total 至少比当前页多 1
      hasMore: giteaResult.hasMore
    };
    setPullsCache({ projectId: args.projectId, cacheKey: cacheKey2, payload: JSON.stringify(resp) });
    logger.info({ op, latencyMs: Date.now() - start, resultSize: items.length, hit: false }, "ipc done");
    return resp;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn({ op, latencyMs: Date.now() - start }, "gitea unreachable, falling back to cache");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          parsed["__offline"] = true;
          logger.info({ op, latencyMs: Date.now() - start, resultSize: parsed.items.length, offline: true }, "ipc done (offline)");
          return parsed;
        } catch {
        }
      }
      const offlineResp = { items: [], total: 0, hasMore: false };
      offlineResp["__offline"] = true;
      logger.info({ op, latencyMs: Date.now() - start, offline: true }, "ipc done (offline, no cache)");
      return offlineResp;
    }
    throw err;
  }
}
async function pullsGetHandler(args) {
  const start = Date.now();
  const op = "pulls.get";
  logger.info({ op, args }, "ipc start");
  const cacheKey2 = `project=${args.projectId}|index=${args.index}`;
  const cached = getPullsCache({ projectId: args.projectId, cacheKey: cacheKey2 });
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({ op, latencyMs: Date.now() - start, index: args.index, hit: true }, "ipc done");
      return parsed;
    } catch {
    }
  }
  const proj = resolveProject(args.projectId);
  const pull = await getGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index
  });
  const linkedCards = getLinkedCardsForPull({
    index: args.index
  });
  const dto = { ...pull, linkedCards };
  setPullsCache({ projectId: args.projectId, cacheKey: cacheKey2, payload: JSON.stringify(dto) });
  logger.info({ op, latencyMs: Date.now() - start, index: args.index, hit: false }, "ipc done");
  return dto;
}
async function pullsMergeHandler(args) {
  const start = Date.now();
  const op = "pulls.merge";
  logger.info({ op, args: { projectId: args.projectId, index: args.index, method: args.method } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await mergeGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    method: args.method,
    deleteBranchAfter: args.deleteBranchAfter,
    commitMessage: args.commitMessage
  });
  invalidatePullsCache(args.projectId);
  invalidateCommitsCache(args.projectId);
  invalidateBranchesCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start, sha: result.sha, merged: result.merged }, "ipc done");
  return result;
}
async function pullsCloseHandler(args) {
  const start = Date.now();
  const op = "pulls.close";
  logger.info({ op, args: { projectId: args.projectId, index: args.index } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await closeGiteaPull({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    reason: args.reason
  });
  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start, closed: result.closed }, "ipc done");
  return result;
}
async function pullsUpdateLabelsHandler(args) {
  const start = Date.now();
  const op = "pulls.updateLabels";
  logger.info({ op, args: { projectId: args.projectId, index: args.index, labels: args.labels } }, "ipc start");
  const proj = resolveProject(args.projectId);
  await updatePullLabels({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    labels: args.labels
  });
  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start }, "ipc done");
}
async function pullsUpdateAssigneeHandler(args) {
  const start = Date.now();
  const op = "pulls.updateAssignee";
  logger.info({ op, args: { projectId: args.projectId, index: args.index, assignee: args.assignee } }, "ipc start");
  const proj = resolveProject(args.projectId);
  await updatePullAssignee({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    assignee: args.assignee
  });
  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start }, "ipc done");
}
async function pullsUpdateReviewersHandler(args) {
  const start = Date.now();
  const op = "pulls.updateReviewers";
  logger.info({ op, args: { projectId: args.projectId, index: args.index, reviewers: args.reviewers } }, "ipc start");
  const proj = resolveProject(args.projectId);
  await updatePullReviewers({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.index,
    reviewers: args.reviewers
  });
  invalidatePullsCache(args.projectId);
  logger.info({ op, latencyMs: Date.now() - start }, "ipc done");
}
function registerPullsIpc() {
  wrapIpc$8(IpcChannel.PULLS_LIST, ListPullsArgsSchema, pullsListHandler);
  wrapIpc$8(IpcChannel.PULLS_GET, GetPullArgsSchema, pullsGetHandler);
  wrapIpc$8(IpcChannel.PULLS_MERGE, MergePrArgsSchema, pullsMergeHandler);
  wrapIpc$8(IpcChannel.PULLS_CLOSE, ClosePrArgsSchema, pullsCloseHandler);
  wrapIpc$8(IpcChannel.PULLS_UPDATE_LABELS, UpdatePullLabelsArgsSchema, pullsUpdateLabelsHandler);
  wrapIpc$8(IpcChannel.PULLS_UPDATE_ASSIGNEE, UpdatePullAssigneeArgsSchema, pullsUpdateAssigneeHandler);
  wrapIpc$8(IpcChannel.PULLS_UPDATE_REVIEWERS, UpdatePullReviewersArgsSchema, pullsUpdateReviewersHandler);
}
function unregisterPullsIpc() {
  ipcMain.removeHandler(IpcChannel.PULLS_LIST);
  ipcMain.removeHandler(IpcChannel.PULLS_GET);
  ipcMain.removeHandler(IpcChannel.PULLS_MERGE);
  ipcMain.removeHandler(IpcChannel.PULLS_CLOSE);
  ipcMain.removeHandler(IpcChannel.PULLS_UPDATE_LABELS);
  ipcMain.removeHandler(IpcChannel.PULLS_UPDATE_ASSIGNEE);
  ipcMain.removeHandler(IpcChannel.PULLS_UPDATE_REVIEWERS);
}
function listColumnsByProjectWithStore(state, projectId) {
  return state.columns.filter((c) => c.projectId === projectId).sort((a, b) => a.position - b.position);
}
function maxColumnPositionByProjectWithStore(state, projectId) {
  let max = -1024;
  for (const c of state.columns) {
    if (c.projectId === projectId && c.position > max) {
      max = c.position;
    }
  }
  return max;
}
function findColumnByIdWithStore(state, columnId) {
  return state.columns.find((c) => c.id === columnId) ?? null;
}
function columnIdsByProjectWithStore(state, projectId) {
  return state.columns.filter((c) => c.projectId === projectId).map((c) => c.id);
}
function listLabelMapsByColumnWithStore(state, columnId) {
  return state.labelMaps.filter((m) => m.columnId === columnId).sort((a, b) => a.createdAt - b.createdAt);
}
function findLabelMapByProjectAndLabelWithStore(state, args) {
  return state.labelMaps.find(
    (m) => m.projectId === args.projectId && m.giteaLabelId === args.giteaLabelId
  ) ?? null;
}
function findLabelMapByColumnAndLabelWithStore(state, args) {
  return state.labelMaps.find(
    (m) => m.columnId === args.columnId && m.giteaLabelId === args.giteaLabelId
  ) ?? null;
}
function toLabelDto(r) {
  return {
    id: r.id ?? 0,
    name: r.name ?? "",
    color: r.color ?? "#000000",
    ...r.description ? { description: r.description } : {}
  };
}
async function listGiteaLabels(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueListLabels(args.owner, args.repo, { page, limit });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/labels列表失败`);
  const items = raws.map(toLabelDto);
  return { items, hasMore: raws.length === limit };
}
async function createGiteaLabel(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueCreateLabel(args.owner, args.repo, {
    name: args.name,
    color: args.color,
    ...args.description !== void 0 ? { description: args.description } : {}
  });
  const raw = unwrapGitea(res, `创建 label失败`);
  return toLabelDto(raw);
}
const POSITION_STEP = 1024;
function projectExists(projectId) {
  return getLocalStore().get().projects.some((p) => p.id === projectId);
}
function resolveColumn(columnId) {
  const col = findColumnByIdWithStore(getLocalStore().get(), columnId);
  if (!col) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "列不存在",
      hint: "可能已被删除，请刷新看板"
    });
  }
  return { projectId: col.projectId };
}
function toColumnDto(col, boundLabelIds, liveLabelsById) {
  const labels = boundLabelIds.map((id) => {
    const live = liveLabelsById.get(id);
    if (!live) return null;
    return { id, name: live.name, color: live.color };
  }).filter((l) => l !== null);
  return {
    id: col.id,
    projectId: col.projectId,
    title: col.title,
    position: col.position,
    labels,
    wipLimit: normalizeWipLimit(col.wipLimit)
  };
}
function toColumnDtoFromLabels(col, labels) {
  return {
    id: col.id,
    projectId: col.projectId,
    title: col.title,
    position: col.position,
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    wipLimit: normalizeWipLimit(col.wipLimit)
  };
}
function normalizeWipLimit(raw) {
  if (raw === null || raw === void 0) return null;
  if (!Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}
async function listColumns(projectId) {
  const state = getLocalStore().get();
  const cols = listColumnsByProjectWithStore(state, projectId);
  const allLabelMaps = state.labelMaps.filter((m) => m.projectId === projectId);
  const boundLabelIds = Array.from(new Set(allLabelMaps.map((m) => Number(m.giteaLabelId))));
  let liveLabelsById = /* @__PURE__ */ new Map();
  if (boundLabelIds.length > 0) {
    const proj = resolveProject(projectId);
    const resp = await listGiteaLabels({
      giteaUrl: proj.giteaUrl,
      username: proj.username,
      owner: proj.owner,
      repo: proj.repo,
      page: 1,
      limit: 50
      // 单仓库 label 通常 < 50，gitea 端无 project 概念后全 repo label 拉一次
    });
    liveLabelsById = new Map(resp.items.map((l) => [l.id, { name: l.name, color: l.color }]));
  }
  return cols.map((c) => {
    const colBoundIds = listLabelMapsByColumnWithStore(state, c.id).map((m) => Number(m.giteaLabelId));
    return toColumnDto(c, colBoundIds, liveLabelsById);
  });
}
function createColumn(args) {
  const maxPos = maxColumnPositionByProjectWithStore(getLocalStore().get(), args.projectId);
  const newPosition = maxPos + POSITION_STEP;
  const id = randomUUID();
  const nowEpochMs = Date.now();
  const createdRow = {
    id,
    projectId: args.projectId,
    title: args.title,
    position: newPosition,
    createdAt: nowEpochMs,
    wipLimit: null
    // v1.3 默认无限（UI 列设置弹窗可改）
  };
  getLocalStore().mutate((s) => {
    s.columns.push(createdRow);
  });
  return toColumnDtoFromLabels(createdRow, []);
}
function updateColumn(args) {
  const store = getLocalStore();
  const existing = findColumnByIdWithStore(store.get(), args.columnId);
  if (!existing) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "列不存在",
      hint: "可能已被删除，请刷新看板"
    });
  }
  if (args.patch.wipLimit !== void 0) {
    if (args.patch.wipLimit !== null && (!Number.isInteger(args.patch.wipLimit) || args.patch.wipLimit <= 0)) {
      throw new IpcError({
        code: IpcErrorCode.VALIDATION_FAILED,
        message: "wipLimit 必须是正整数或 null（无限）",
        hint: "请输入 ≥ 1 的整数，留空表示无限"
      });
    }
  }
  store.mutate((s) => {
    const idx = s.columns.findIndex((c) => c.id === args.columnId);
    if (idx < 0) return;
    s.columns[idx] = {
      ...s.columns[idx],
      ...args.patch.title !== void 0 ? { title: args.patch.title } : {},
      ...args.patch.position !== void 0 ? { position: args.patch.position } : {},
      ...args.patch.wipLimit !== void 0 ? { wipLimit: args.patch.wipLimit } : {}
    };
  });
  const refreshed = findColumnByIdWithStore(store.get(), args.columnId);
  const labels = listLabelMapsByColumnWithStore(store.get(), args.columnId).map((m) => ({
    id: Number(m.giteaLabelId),
    name: m.giteaLabelName,
    color: ""
  }));
  return toColumnDtoFromLabels(refreshed, labels);
}
function reorderColumns(args) {
  const store = getLocalStore();
  const existing = columnIdsByProjectWithStore(store.get(), args.projectId).sort();
  const inputSorted = [...args.orderedIds].sort();
  if (existing.length !== inputSorted.length || existing.some((id, i) => id !== inputSorted[i])) {
    throw new IpcError({
      code: IpcErrorCode.VALIDATION_FAILED,
      message: "orderedIds 必须完整覆盖该 project 的所有列 id",
      hint: "请重新拉取列列表后重排"
    });
  }
  store.mutate((s) => {
    for (let idx = 0; idx < args.orderedIds.length; idx++) {
      const id = args.orderedIds[idx];
      const pos = (idx + 1) * POSITION_STEP;
      const cIdx = s.columns.findIndex((c) => c.id === id);
      if (cIdx >= 0) {
        s.columns[cIdx] = { ...s.columns[cIdx], position: pos };
      }
    }
  });
}
function deleteColumn(args) {
  resolveColumn(args.columnId);
  getLocalStore().mutate((s) => {
    s.columns = s.columns.filter((c) => c.id !== args.columnId);
    s.labelMaps = s.labelMaps.filter((m) => m.columnId !== args.columnId);
  });
}
async function mapLabel(args) {
  const store = getLocalStore();
  const { projectId } = resolveColumn(args.columnId);
  const proj = resolveProject(projectId);
  const resp = await listGiteaLabels({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    page: 1,
    limit: 50
  });
  const liveLabel = resp.items.find((l) => l.id === args.giteaLabelId);
  if (!liveLabel) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "该 gitea label 已不存在",
      hint: "请在 label 选择器中刷新后重选",
      cause: `giteaLabelId=${args.giteaLabelId} not found in repo ${proj.owner}/${proj.repo}`
    });
  }
  const conflict = findLabelMapByProjectAndLabelWithStore(store.get(), {
    projectId,
    giteaLabelId: String(args.giteaLabelId)
  });
  if (conflict && conflict.columnId !== args.columnId) {
    throw new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: "该 gitea label 已被另一列绑定",
      hint: "一个 label 只能属于一个列；请先在原列 unmap",
      cause: `existing columnId=${conflict.columnId}, new columnId=${args.columnId}`
    });
  }
  const existing = findLabelMapByColumnAndLabelWithStore(store.get(), {
    columnId: args.columnId,
    giteaLabelId: String(args.giteaLabelId)
  });
  if (!existing) {
    const newMap = {
      id: randomUUID(),
      columnId: args.columnId,
      projectId,
      giteaLabelId: String(args.giteaLabelId),
      giteaLabelName: liveLabel.name,
      // Gitea 优先：以 gitea 实时 name 写
      createdAt: Date.now()
    };
    store.mutate((s) => {
      s.labelMaps.push(newMap);
    });
  } else if (existing.giteaLabelName !== liveLabel.name) {
    store.mutate((s) => {
      const idx = s.labelMaps.findIndex(
        (m) => m.columnId === args.columnId && m.giteaLabelId === String(args.giteaLabelId)
      );
      if (idx >= 0) {
        s.labelMaps[idx] = { ...s.labelMaps[idx], giteaLabelName: liveLabel.name };
      }
    });
  }
  const refreshed = findColumnByIdWithStore(store.get(), args.columnId);
  return toColumnDtoFromLabels(refreshed, [
    { id: liveLabel.id, name: liveLabel.name, color: liveLabel.color }
  ]);
}
function unmapLabel(args) {
  const store = getLocalStore();
  resolveColumn(args.columnId);
  store.mutate((s) => {
    s.labelMaps = s.labelMaps.filter(
      (m) => !(m.columnId === args.columnId && m.giteaLabelId === String(args.giteaLabelId))
    );
  });
  const refreshed = findColumnByIdWithStore(store.get(), args.columnId);
  const labels = listLabelMapsByColumnWithStore(store.get(), args.columnId).map((m) => ({
    id: Number(m.giteaLabelId),
    name: m.giteaLabelName,
    color: ""
  }));
  return toColumnDtoFromLabels(refreshed, labels);
}
function wrapIpc$7(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
async function listBoardColumnsHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.list", args }, "ipc start");
  if (!projectExists(args.projectId)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "项目不存在",
      hint: "请先在仓库列表中重新添加该仓库为项目"
    });
  }
  try {
    const result = await listColumns(args.projectId);
    logger.info({ op: "board.columns.list", latencyMs: Date.now() - start, count: result.length }, "ipc done");
    return result;
  } catch (err) {
    if (err instanceof IpcError && err.code === IpcErrorCode.NETWORK_OFFLINE) {
      logger.warn({ op: "board.columns.list", latencyMs: Date.now() - start }, "gitea unreachable, falling back to localStore");
      const state = getLocalStore().get();
      const cols = listColumnsByProjectWithStore(state, args.projectId);
      const result = cols.map((c) => {
        const boundLabelIds = listLabelMapsByColumnWithStore(state, c.id).map((m) => Number(m.giteaLabelId));
        const labels = boundLabelIds.map((id) => {
          const lm = state.labelMaps.find(
            (m) => m.columnId === c.id && Number(m.giteaLabelId) === id
          );
          return lm ? { id, name: lm.giteaLabelName, color: "" } : { id, name: `<label-${id}>`, color: "" };
        });
        return {
          id: c.id,
          projectId: c.projectId,
          title: c.title,
          position: c.position,
          labels,
          wipLimit: c.wipLimit ?? null
        };
      });
      result["__offline"] = true;
      logger.info({ op: "board.columns.list", latencyMs: Date.now() - start, count: result.length, __offline: true }, "ipc done (offline)");
      return result;
    }
    throw err;
  }
}
async function createBoardColumnHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.create", args: { projectId: args.projectId, title: args.title } }, "ipc start");
  if (!projectExists(args.projectId)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "项目不存在"
    });
  }
  const { result } = await dispatch("board.columns.create", args);
  logger.info({ op: "board.columns.create", latencyMs: Date.now() - start, columnId: result.id }, "ipc done");
  return result;
}
async function updateBoardColumnHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.update", args: { columnId: args.columnId } }, "ipc start");
  const { result } = await dispatch("board.columns.update", args);
  logger.info({ op: "board.columns.update", latencyMs: Date.now() - start, columnId: result.id }, "ipc done");
  return result;
}
async function reorderBoardColumnsHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.reorder", args: { projectId: args.projectId, count: args.orderedIds.length } }, "ipc start");
  if (!projectExists(args.projectId)) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "项目不存在"
    });
  }
  await dispatch("board.columns.reorder", args);
  logger.info({ op: "board.columns.reorder", latencyMs: Date.now() - start }, "ipc done");
}
async function deleteBoardColumnHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.delete", args: { columnId: args.columnId } }, "ipc start");
  await dispatch("board.columns.delete", args);
  logger.info({ op: "board.columns.delete", latencyMs: Date.now() - start }, "ipc done");
}
async function mapColumnLabelHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.mapLabel", args: { columnId: args.columnId, giteaLabelId: args.giteaLabelId } }, "ipc start");
  const { result } = await dispatch("board.columns.mapLabel", args);
  logger.info({ op: "board.columns.mapLabel", latencyMs: Date.now() - start, columnId: result.id }, "ipc done");
  return result;
}
async function unmapColumnLabelHandler(args) {
  const start = Date.now();
  logger.info({ op: "board.columns.unmapLabel", args: { columnId: args.columnId, giteaLabelId: args.giteaLabelId } }, "ipc start");
  const { result } = await dispatch("board.columns.unmapLabel", args);
  logger.info({ op: "board.columns.unmapLabel", latencyMs: Date.now() - start, columnId: result.id }, "ipc done");
  return result;
}
async function _resetBoardColumns(args) {
  const { projectId } = args;
  const state = getLocalStore().get();
  const beforeCols = state.columns.filter((c) => c.projectId === projectId);
  const resetCount = beforeCols.length;
  for (const col of beforeCols) {
    try {
      await deleteColumn({ columnId: col.id });
    } catch {
    }
  }
  return { resetCount };
}
function registerBoardIpc() {
  registerOp("board.columns.create", {
    execute: createColumn
  });
  registerOp("board.columns.update", {
    execute: updateColumn
  });
  registerOp("board.columns.reorder", {
    execute: reorderColumns
  });
  registerOp("board.columns.delete", {
    execute: deleteColumn
  });
  registerOp("board.columns.mapLabel", {
    execute: mapLabel
  });
  registerOp("board.columns.unmapLabel", {
    execute: unmapLabel
  });
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_LIST, ListBoardColumnsArgsSchema, listBoardColumnsHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_CREATE, CreateBoardColumnArgsSchema, createBoardColumnHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_UPDATE, UpdateBoardColumnArgsSchema, updateBoardColumnHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_REORDER, ReorderBoardColumnsArgsSchema, reorderBoardColumnsHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_DELETE, DeleteBoardColumnArgsSchema, deleteBoardColumnHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_MAP_LABEL, MapColumnLabelArgsSchema, mapColumnLabelHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_UNMAP_LABEL, UnmapColumnLabelArgsSchema, unmapColumnLabelHandler);
  wrapIpc$7(IpcChannel.BOARD_COLUMNS_RESET, ResetBoardColumnsArgsSchema, _resetBoardColumns);
}
function unregisterBoardIpc() {
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_LIST);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_CREATE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_UPDATE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_REORDER);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_DELETE);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_MAP_LABEL);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_UNMAP_LABEL);
  ipcMain.removeHandler(IpcChannel.BOARD_COLUMNS_RESET);
}
function toIssueDto(r) {
  const number = r.number ?? r.id ?? 0;
  return {
    id: number,
    index: number,
    title: r.title ?? "",
    body: r.body ?? "",
    state: r.state ?? "open",
    createdAt: r.created_at ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: r.updated_at ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    author: {
      username: r.user?.login ?? "<unknown>",
      ...r.user?.full_name ? { fullName: r.user.full_name } : {},
      ...r.user?.avatar_url ? { avatarUrl: r.user.avatar_url } : {}
    },
    labels: (r.labels ?? []).map((l) => labelToDto(l)),
    // true 当 gitea response 包含非空 pull_request（gitea 把 PR 也列在 /issues）
    isPullRequest: r.pull_request != null,
    // v1.4：gitea issue ref 字段（关联分支/Git 标签），无关联时为空串
    refBranch: r.ref ?? ""
  };
}
function labelToDto(l) {
  return {
    id: l.id ?? 0,
    name: l.name ?? "",
    color: l.color ?? "#000000",
    ...l.description ? { description: l.description } : {}
  };
}
async function listGiteaIssues(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueListIssues(args.owner, args.repo, {
    ...args.state !== void 0 ? { state: args.state } : {},
    ...args.labelIds && args.labelIds.length > 0 ? { labels: args.labelIds.join(",") } : {},
    ...args.assignee !== void 0 && args.assignee.length > 0 ? { assigned_by: args.assignee } : {},
    ...args.q !== void 0 ? { q: args.q } : {},
    type: "issues",
    //排除 PR（gitea /issues 也会列 PR；看板只看纯 issue）
    page,
    limit
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/issues列表失败`);
  const items = raws.map(toIssueDto);
  return { items, hasMore: raws.length === limit };
}
async function getGiteaIssue(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueGetIssue(args.owner, args.repo, args.index);
  const raw = unwrapGitea(res, `获取 issue #${args.index}失败`);
  return toIssueDto(raw);
}
async function createGiteaIssue(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueCreateIssue(args.owner, args.repo, {
    title: args.title,
    ...args.body !== void 0 ? { body: args.body } : {},
    ...args.labelIds && args.labelIds.length > 0 ? { labels: args.labelIds } : {},
    // v1.4 扩展：里程碑（gitea milestone 字段 = milestone id）+ 指派人（gitea username 列表）
    ...args.milestoneId !== void 0 ? { milestone: args.milestoneId } : {},
    ...args.assignees && args.assignees.length > 0 ? { assignees: args.assignees } : {},
    // v1.4：关联分支（gitea ref 字段）
    ...args.refBranch ? { ref: args.refBranch } : {}
  });
  const raw = unwrapGitea(res, `创建 issue失败`);
  return toIssueDto(raw);
}
async function editGiteaIssue(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueEditIssue(args.owner, args.repo, args.index, {
    ...args.title !== void 0 ? { title: args.title } : {},
    ...args.body !== void 0 ? { body: args.body } : {},
    ...args.state !== void 0 ? { state: args.state } : {},
    ...args.refBranch !== void 0 ? { ref: args.refBranch } : {}
  });
  const raw = unwrapGitea(res, `编辑 issue #${args.index}失败`);
  return toIssueDto(raw);
}
async function addGiteaIssueLabel(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueAddLabel(args.owner, args.repo, args.index, {
    labels: [args.labelId]
  });
  unwrapGitea(res, `添加 label失败`);
}
async function removeGiteaIssueLabel(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueRemoveLabel(args.owner, args.repo, args.index, args.labelId);
  unwrapGitea(res, `移除 label失败`);
}
async function listGiteaIssueComments(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueGetComments(args.owner, args.repo, args.index);
  const raws = unwrapGitea(res, `列 issue #${args.index}评论失败`);
  return raws.map((c) => commentToDto(c));
}
async function createGiteaIssueComment(args) {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueCreateComment(args.owner, args.repo, args.index, {
    body: args.body
  });
  const raw = unwrapGitea(res, `创建评论失败`);
  return commentToDto(raw);
}
function commentToDto(c) {
  return {
    id: c.id ?? 0,
    body: c.body ?? "",
    author: {
      username: c.user?.login ?? "<unknown>",
      ...c.user?.avatar_url ? { avatarUrl: c.user.avatar_url } : {}
    },
    createdAt: c.created_at ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: c.updated_at ?? (/* @__PURE__ */ new Date(0)).toISOString()
  };
}
async function listIssuesFromGitea(args) {
  const proj = resolveProject(args.projectId);
  let labelIds = args.labelIds;
  if (args.columnId !== void 0) {
    const state = getLocalStore().get();
    const col = findColumnByIdWithStore(state, args.columnId);
    if (!col) {
      return { items: [], hasMore: false };
    }
    if (col.projectId !== args.projectId) {
      return { items: [], hasMore: false };
    }
    const mappings = listLabelMapsByColumnWithStore(state, args.columnId);
    if (mappings.length === 0) {
      return { items: [], hasMore: false };
    }
    labelIds = mappings.map((m) => Number(m.giteaLabelId));
  }
  const result = await listGiteaIssues({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    ...args.state !== void 0 ? { state: args.state } : {},
    ...labelIds !== void 0 && labelIds.length > 0 ? { labelIds: labelIds.map(String) } : {},
    ...args.q !== void 0 ? { q: args.q } : {},
    // a3 补：透传 assignee 到 gitea /issues?assigned_by=<username>（"我的卡片"用）
    //   不传 = 走 gitea 包装层原行为（不过滤 assignee，向后兼容）
    ...args.assignee !== void 0 && args.assignee.length > 0 ? { assignee: args.assignee } : {},
    page: args.page,
    limit: args.limit
  });
  const items = result.items.filter((it) => !it.isPullRequest);
  return {
    items,
    hasMore: result.hasMore
  };
}
const MAX_STACK_SIZE = 50;
const handlers = /* @__PURE__ */ new Map();
function registerUndoHandler(op, handler) {
  handlers.set(op, handler);
}
const undoStacks = /* @__PURE__ */ new Map();
const redoStacks = /* @__PURE__ */ new Map();
function getOrCreate(map, key) {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  return arr;
}
function pushBounded(stack, entry) {
  stack.push(entry);
  while (stack.length > MAX_STACK_SIZE) {
    stack.shift();
  }
}
function pushUndo(op, projectId, forwardArgs, reverseArgs) {
  const stack = getOrCreate(undoStacks, projectId);
  pushBounded(stack, {
    op,
    projectId,
    forwardArgs,
    reverseArgs,
    createdAt: Date.now()
  });
  const redo2 = redoStacks.get(projectId);
  if (redo2 && redo2.length > 0) {
    redoStacks.set(projectId, []);
  }
}
function undoStackSize(projectId) {
  return undoStacks.get(projectId)?.length ?? 0;
}
function redoStackSize(projectId) {
  return redoStacks.get(projectId)?.length ?? 0;
}
function getHandler(op) {
  const h = handlers.get(op);
  if (!h) {
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: `未注册的 undo op: ${op}`,
      hint: "业务侧 registerUndoHandler 未在启动期调用"
    });
  }
  return h;
}
async function undoOne(args) {
  if (args?.projectId) {
    const stack = undoStacks.get(args.projectId);
    const entry = stack?.pop();
    if (!entry) {
      return {
        restored: 0,
        undoSize: undoStackSize(args.projectId),
        redoSize: redoStackSize(args.projectId)
      };
    }
    const redo2 = getOrCreate(redoStacks, args.projectId);
    pushBounded(redo2, entry);
    const handler = getHandler(entry.op);
    await handler.reverse(entry.reverseArgs);
    return {
      restored: 1,
      op: entry.op,
      undoSize: undoStackSize(args.projectId),
      redoSize: redoStackSize(args.projectId)
    };
  }
  return { restored: 0, undoSize: 0, redoSize: 0 };
}
async function redoOne(args) {
  if (args?.projectId) {
    const stack = redoStacks.get(args.projectId);
    const entry = stack?.pop();
    if (!entry) {
      return {
        restored: 0,
        undoSize: undoStackSize(args.projectId),
        redoSize: redoStackSize(args.projectId)
      };
    }
    const undo2 = getOrCreate(undoStacks, args.projectId);
    pushBounded(undo2, entry);
    const handler = getHandler(entry.op);
    await handler.forward(entry.forwardArgs);
    return {
      restored: 1,
      op: entry.op,
      undoSize: undoStackSize(args.projectId),
      redoSize: redoStackSize(args.projectId)
    };
  }
  return { restored: 0, undoSize: 0, redoSize: 0 };
}
function undoStatus(projectId) {
  return {
    undoSize: undoStackSize(projectId),
    redoSize: redoStackSize(projectId)
  };
}
async function moveIssueColumn(args) {
  const proj = resolveProject(args.projectId);
  const state = getLocalStore().get();
  const fromLabels = listLabelMapsByColumnWithStore(state, args.fromColumnId);
  const toLabels = listLabelMapsByColumnWithStore(state, args.toColumnId);
  const fromCol = findColumnByIdWithStore(state, args.fromColumnId);
  if (!fromCol || fromCol.projectId !== args.projectId) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "fromColumnId 不存在或不在该项目下"
    });
  }
  const toCol = findColumnByIdWithStore(state, args.toColumnId);
  if (!toCol || toCol.projectId !== args.projectId) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: "toColumnId 不存在或不在该项目下"
    });
  }
  const currentIssue = await getGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex
  });
  const currentLabelIds = new Set(currentIssue.labels.map((l) => l.id));
  for (const fl of fromLabels) {
    const id = Number(fl.giteaLabelId);
    if (!currentLabelIds.has(id)) {
      throw new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: "该列绑的 label 已在 gitea 端变更（issue 不再带该 label）",
        hint: "请刷新看板",
        cause: `columnId=${args.fromColumnId}, giteaLabelId=${fl.giteaLabelId}, issue=${args.issueIndex}`
      });
    }
  }
  const addedLabelIds = [];
  try {
    for (const tl of toLabels) {
      const id = Number(tl.giteaLabelId);
      if (currentLabelIds.has(id)) continue;
      await addGiteaIssueLabel({
        giteaUrl: proj.giteaUrl,
        username: proj.username,
        owner: proj.owner,
        repo: proj.repo,
        index: args.issueIndex,
        labelId: id
      });
      addedLabelIds.push(id);
    }
  } catch (e) {
    for (const id of addedLabelIds) {
      try {
        await removeGiteaIssueLabel({
          giteaUrl: proj.giteaUrl,
          username: proj.username,
          owner: proj.owner,
          repo: proj.repo,
          index: args.issueIndex,
          labelId: id
        });
      } catch {
      }
    }
    throw e;
  }
  try {
    for (const fl of fromLabels) {
      const id = Number(fl.giteaLabelId);
      await removeGiteaIssueLabel({
        giteaUrl: proj.giteaUrl,
        username: proj.username,
        owner: proj.owner,
        repo: proj.repo,
        index: args.issueIndex,
        labelId: id
      });
    }
  } catch (e) {
    throw new IpcError({
      code: IpcErrorCode.INTERNAL,
      message: "已加 toColumn labels，但移除 fromColumn labels 时部分失败",
      hint: "请手动检查 issue 标签",
      cause: e instanceof Error ? e.message : String(e)
    });
  }
  const result = await getGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex
  });
  pushUndo(
    "issues.moveColumn",
    args.projectId,
    args,
    { ...args, fromColumnId: args.toColumnId, toColumnId: args.fromColumnId }
  );
  return result;
}
registerUndoHandler("issues.moveColumn", {
  // 包装为 (args: unknown) => ...，类型断言回 MoveIssueColumnArgs
  // （OpHandler 故意用 unknown 走弱耦合；moveIssueColumn 自己会做 zod / DB 校验）
  forward: (args) => moveIssueColumn(args),
  reverse: (args) => moveIssueColumn(args)
});
function wrapIpc$6(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
async function listIssuesHandler(args) {
  const start = Date.now();
  logger.info(
    { op: "issues.list", args: { projectId: args.projectId, columnId: args.columnId, page: args.page, limit: args.limit } },
    "ipc start"
  );
  const result = await listIssuesFromGitea(args);
  logger.info({ op: "issues.list", latencyMs: Date.now() - start, count: result.items.length }, "ipc done");
  return result;
}
async function getIssueHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.get", args: { projectId: args.projectId, issueIndex: args.issueIndex } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await getGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex
  });
  logger.info({ op: "issues.get", latencyMs: Date.now() - start, issueIndex: args.issueIndex }, "ipc done");
  return result;
}
async function createIssueHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.create", args: { projectId: args.projectId, title: args.title } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await createGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    title: args.title,
    ...args.body !== void 0 ? { body: args.body } : {},
    ...args.labelIds && args.labelIds.length > 0 ? { labelIds: args.labelIds } : {},
    // v1.4 扩展：里程碑 + 指派人透传到 gitea issueCreateIssue
    ...args.milestoneId !== void 0 ? { milestoneId: args.milestoneId } : {},
    ...args.assignees && args.assignees.length > 0 ? { assignees: args.assignees } : {},
    // v1.4：关联分支（gitea ref 字段，必填）
    refBranch: args.refBranch
  });
  logger.info({ op: "issues.create", latencyMs: Date.now() - start, issueIndex: result.index }, "ipc done");
  return result;
}
async function updateIssueHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.update", args: { projectId: args.projectId, issueIndex: args.issueIndex } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await editGiteaIssue({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    ...args.patch.title !== void 0 ? { title: args.patch.title } : {},
    ...args.patch.body !== void 0 ? { body: args.patch.body } : {},
    ...args.patch.state !== void 0 ? { state: args.patch.state } : {},
    // v1.4：关联分支（gitea ref 字段）
    ...args.patch.refBranch !== void 0 ? { refBranch: args.patch.refBranch } : {}
  });
  logger.info({ op: "issues.update", latencyMs: Date.now() - start, issueIndex: args.issueIndex }, "ipc done");
  return result;
}
async function addIssueLabelHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.addLabel", args: { projectId: args.projectId, issueIndex: args.issueIndex, labelId: args.labelId } }, "ipc start");
  const proj = resolveProject(args.projectId);
  await addGiteaIssueLabel({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    labelId: args.labelId
  });
  logger.info({ op: "issues.addLabel", latencyMs: Date.now() - start }, "ipc done");
}
async function removeIssueLabelHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.removeLabel", args: { projectId: args.projectId, issueIndex: args.issueIndex, labelId: args.labelId } }, "ipc start");
  const proj = resolveProject(args.projectId);
  await removeGiteaIssueLabel({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    labelId: args.labelId
  });
  logger.info({ op: "issues.removeLabel", latencyMs: Date.now() - start }, "ipc done");
}
async function moveIssueColumnHandler(args) {
  const start = Date.now();
  logger.info(
    { op: "issues.moveColumn", args: { projectId: args.projectId, issueIndex: args.issueIndex, from: args.fromColumnId, to: args.toColumnId } },
    "ipc start"
  );
  const result = await moveIssueColumn(args);
  logger.info({ op: "issues.moveColumn", latencyMs: Date.now() - start, issueIndex: args.issueIndex }, "ipc done");
  return result;
}
async function listIssueCommentsHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.comment.list", args: { projectId: args.projectId, issueIndex: args.issueIndex } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await listGiteaIssueComments({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex
  });
  logger.info({ op: "issues.comment.list", latencyMs: Date.now() - start, count: result.length }, "ipc done");
  return result;
}
async function createIssueCommentHandler(args) {
  const start = Date.now();
  logger.info({ op: "issues.comment.create", args: { projectId: args.projectId, issueIndex: args.issueIndex } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await createGiteaIssueComment({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    index: args.issueIndex,
    body: args.body
  });
  logger.info({ op: "issues.comment.create", latencyMs: Date.now() - start, commentId: result.id }, "ipc done");
  return result;
}
function registerIssuesIpc() {
  wrapIpc$6(IpcChannel.ISSUES_LIST, ListIssuesArgsSchema, listIssuesHandler);
  wrapIpc$6(IpcChannel.ISSUES_GET, GetIssueArgsSchema, getIssueHandler);
  wrapIpc$6(IpcChannel.ISSUES_CREATE, CreateIssueArgsSchema, createIssueHandler);
  wrapIpc$6(IpcChannel.ISSUES_UPDATE, UpdateIssueArgsSchema, updateIssueHandler);
  wrapIpc$6(IpcChannel.ISSUES_ADD_LABEL, IssueLabelActionArgsSchema, addIssueLabelHandler);
  wrapIpc$6(IpcChannel.ISSUES_REMOVE_LABEL, IssueLabelActionArgsSchema, removeIssueLabelHandler);
  wrapIpc$6(IpcChannel.ISSUES_MOVE_COLUMN, MoveIssueColumnArgsSchema, moveIssueColumnHandler);
  wrapIpc$6(IpcChannel.ISSUES_COMMENT_LIST, ListIssueCommentsArgsSchema, listIssueCommentsHandler);
  wrapIpc$6(IpcChannel.ISSUES_COMMENT_CREATE, CreateIssueCommentArgsSchema, createIssueCommentHandler);
}
function unregisterIssuesIpc() {
  ipcMain.removeHandler(IpcChannel.ISSUES_LIST);
  ipcMain.removeHandler(IpcChannel.ISSUES_GET);
  ipcMain.removeHandler(IpcChannel.ISSUES_CREATE);
  ipcMain.removeHandler(IpcChannel.ISSUES_UPDATE);
  ipcMain.removeHandler(IpcChannel.ISSUES_ADD_LABEL);
  ipcMain.removeHandler(IpcChannel.ISSUES_REMOVE_LABEL);
  ipcMain.removeHandler(IpcChannel.ISSUES_MOVE_COLUMN);
  ipcMain.removeHandler(IpcChannel.ISSUES_COMMENT_LIST);
  ipcMain.removeHandler(IpcChannel.ISSUES_COMMENT_CREATE);
}
function wrapIpc$5(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
async function listLabelsHandler(args) {
  const start = Date.now();
  logger.info({ op: "labels.list", args: { projectId: args.projectId } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await listGiteaLabels({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    page: args.page,
    limit: args.limit
  });
  logger.info({ op: "labels.list", latencyMs: Date.now() - start, count: result.items.length }, "ipc done");
  return { items: result.items, hasMore: result.hasMore };
}
async function createLabelHandler(args) {
  const start = Date.now();
  logger.info({ op: "labels.create", args: { projectId: args.projectId, name: args.name } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await createGiteaLabel({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    name: args.name,
    color: args.color,
    ...args.description !== void 0 ? { description: args.description } : {}
  });
  logger.info({ op: "labels.create", latencyMs: Date.now() - start, labelId: result.id }, "ipc done");
  return result;
}
function registerLabelsIpc() {
  wrapIpc$5(IpcChannel.LABELS_LIST, ListLabelsArgsSchema, listLabelsHandler);
  wrapIpc$5(IpcChannel.LABELS_CREATE, CreateLabelArgsSchema, createLabelHandler);
}
function unregisterLabelsIpc() {
  ipcMain.removeHandler(IpcChannel.LABELS_LIST);
  ipcMain.removeHandler(IpcChannel.LABELS_CREATE);
}
function wrapIpc$4(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
async function listMembersHandler(args) {
  const start = Date.now();
  const op = "members.list";
  logger.info({ op, args: { projectId: args.projectId } }, "ipc start");
  const proj = resolveProject(args.projectId);
  const result = await listRepoCollaborators({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo
  });
  const resp = result.items;
  logger.info(
    { op, latencyMs: Date.now() - start, count: resp.length, hasMore: result.hasMore },
    "ipc done"
  );
  return resp;
}
function registerMembersIpc() {
  wrapIpc$4(IpcChannel.MEMBERS_LIST, ListMembersArgsSchema, listMembersHandler);
}
function unregisterMembersIpc() {
  ipcMain.removeHandler(IpcChannel.MEMBERS_LIST);
}
function toMilestoneDto(r) {
  return {
    id: r.id ?? 0,
    title: r.title ?? "",
    state: r.state ?? "open",
    ...r.description ? { description: r.description } : {}
  };
}
async function listGiteaMilestones(args) {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const state = args.state ?? "all";
  const { api } = await getGiteaClient(args.giteaUrl, args.username);
  const res = await api.repos.issueGetMilestonesList(args.owner, args.repo, {
    state,
    page,
    limit
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/milestones 列表失败`);
  const items = raws.map(toMilestoneDto);
  return { items, hasMore: raws.length === limit };
}
function wrapIpc$3(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
async function listMilestonesHandler(args) {
  const start = Date.now();
  logger.info(
    { op: "milestones.list", args: { projectId: args.projectId, state: args.state } },
    "ipc start"
  );
  const proj = resolveProject(args.projectId);
  const result = await listGiteaMilestones({
    giteaUrl: proj.giteaUrl,
    username: proj.username,
    owner: proj.owner,
    repo: proj.repo,
    state: args.state,
    page: args.page,
    limit: args.limit
  });
  logger.info(
    { op: "milestones.list", latencyMs: Date.now() - start, count: result.items.length },
    "ipc done"
  );
  return { items: result.items, hasMore: result.hasMore };
}
function registerMilestonesIpc() {
  wrapIpc$3(IpcChannel.MILESTONES_LIST, ListMilestonesArgsSchema, listMilestonesHandler);
}
function unregisterMilestonesIpc() {
  ipcMain.removeHandler(IpcChannel.MILESTONES_LIST);
}
function wrapIpc$2(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function getPrefs(args) {
  const state = getLocalStore().get();
  const result = {};
  for (const key of args.keys) {
    if (key in state.prefs) {
      result[key] = state.prefs[key];
    }
  }
  return result;
}
async function setPrefs(args) {
  await dispatch("user.prefs.set", { entries: args.entries });
}
async function undo(args) {
  return await undoOne(args);
}
async function redo(args) {
  return await redoOne(args);
}
function getUndoStatus(args) {
  return undoStatus(args.projectId);
}
function registerUserIpc() {
  registerOp("user.prefs.set", {
    execute: async ({ entries }) => {
      if (Object.keys(entries).length === 0) return;
      const store = getLocalStore();
      store.mutate((s) => {
        s.prefs = { ...s.prefs, ...entries };
      });
      logger.debug({ keys: Object.keys(entries) }, "prefs: written to localStore");
    }
  });
  wrapIpc$2(IpcChannel.USER_PREFS_GET, UserPrefsGetArgsSchema, getPrefs);
  wrapIpc$2(IpcChannel.USER_PREFS_SET, UserPrefsSetArgsSchema, setPrefs);
  wrapIpc$2(IpcChannel.USER_UNDO, UserUndoArgsSchema, undo);
  wrapIpc$2(IpcChannel.USER_REDO, UserRedoArgsSchema, redo);
  wrapIpc$2(IpcChannel.USER_UNDO_STATUS, UserUndoStatusArgsSchema, getUndoStatus);
}
function unregisterUserIpc() {
  ipcMain.removeHandler(IpcChannel.USER_PREFS_GET);
  ipcMain.removeHandler(IpcChannel.USER_PREFS_SET);
  ipcMain.removeHandler(IpcChannel.USER_UNDO);
  ipcMain.removeHandler(IpcChannel.USER_REDO);
  ipcMain.removeHandler(IpcChannel.USER_UNDO_STATUS);
}
const THEME_PREF_KEY = "theme";
const DEFAULT_THEME = "dark";
function wrapIpc$1(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function getTheme(_args) {
  const state = getLocalStore().get();
  const stored = state.prefs[THEME_PREF_KEY];
  if (stored === void 0) {
    logger.info(
      { key: THEME_PREF_KEY },
      "theme pref not set, returning default"
    );
    return {
      theme: DEFAULT_THEME,
      changedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  if (!stored || typeof stored !== "object" || !("theme" in stored) || typeof stored.theme !== "string") {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: "主题偏好值字段缺失或类型错",
      hint: "请重新设置主题"
    });
  }
  const candidate = stored.theme;
  const enumResult = ThemeEnumSchema.safeParse(candidate);
  if (!enumResult.success) {
    throw new IpcError({
      code: IpcErrorCode.THEME_NOT_FOUND,
      message: `主题偏好值不合法：${candidate}`,
      hint: "请重新设置主题"
    });
  }
  return {
    theme: enumResult.data,
    // Phase 3 已删 updatedAt 字段（prefs 简化成 unknown JSON value）
    // 给前端一个 ISO 时间戳兜底（用 file mtime 太重；用 localStore schemaVersion 也不准）
    changedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function setTheme(args) {
  const enumResult = ThemeEnumSchema.safeParse(args.theme);
  if (!enumResult.success) {
    throw new IpcError({
      code: IpcErrorCode.INVALID_THEME,
      message: `theme 必须是 2 选 1：'dark' | 'light'，收到 ${JSON.stringify(args.theme)}`,
      hint: "请传入合法主题"
    });
  }
  const theme = enumResult.data;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  void dispatch("preferences.theme.set", { theme });
  return {
    theme,
    changedAt: now
  };
}
function registerPreferencesIpc() {
  registerOp("preferences.theme.set", {
    execute: ({ theme }) => {
      const store = getLocalStore();
      store.mutate((s) => {
        s.prefs = { ...s.prefs, [THEME_PREF_KEY]: { theme } };
      });
    }
  });
  wrapIpc$1(IpcChannel.THEME_GET, ThemeGetArgsSchema, async (args) => getTheme(args));
  wrapIpc$1(IpcChannel.THEME_SET, ThemeSetArgsSchema, async (args) => setTheme(args));
}
function unregisterPreferencesIpc() {
  ipcMain.removeHandler(IpcChannel.THEME_GET);
  ipcMain.removeHandler(IpcChannel.THEME_SET);
}
function wrapIpc(channel, schema, handler) {
  ipcMain.handle(channel, async (_event, rawArgs) => {
    const start = Date.now();
    try {
      const args = schema.parse(rawArgs);
      const result = await handler(args);
      if (logger.isLevelEnabled("debug")) {
        logger.debug({ channel, latencyMs: Date.now() - start }, "ipc ok");
      }
      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof IpcError) {
        logger.warn({ channel, code: err.code, latencyMs, msg: err.message }, "ipc business error");
        throw err.toJSON();
      }
      if (err && typeof err === "object" && "issues" in err) {
        const zodErr = err;
        const issue = zodErr.issues[0];
        const path = issue?.path.join(".") ?? "<root>";
        const message = issue?.message ?? "参数校验失败";
        const v = validationFailed(`${path}: ${message}`, JSON.stringify(zodErr.issues));
        logger.warn({ channel, code: v.code, latencyMs, path, message }, "ipc validation failed");
        throw v.toJSON();
      }
      logger.error({ channel, latencyMs, err }, "ipc internal error");
      const i = new IpcError({
        code: IpcErrorCode.INTERNAL,
        message: "应用内部错误，已记录日志",
        hint: "请稍后重试，或联系开发者",
        cause: err instanceof Error ? err.message : String(err)
      });
      throw i.toJSON();
    }
  });
}
function writeClipboard(args) {
  clipboard.writeText(args.text);
  return { ok: true };
}
function registerClipboardIpc() {
  wrapIpc(IpcChannel.CLIPBOARD_WRITE, ClipboardWriteArgsSchema, writeClipboard);
}
function unregisterClipboardIpc() {
  ipcMain.removeHandler(IpcChannel.CLIPBOARD_WRITE);
}
function registerAllIpcHandlers() {
  registerAuthIpc();
  registerReposIpc();
  registerBranchesIpc();
  registerCommitsIpc();
  registerPullsIpc();
  registerBoardIpc();
  registerIssuesIpc();
  registerLabelsIpc();
  registerMembersIpc();
  registerMilestonesIpc();
  registerUserIpc();
  registerPreferencesIpc();
  registerClipboardIpc();
}
function unregisterAllIpcHandlers() {
  unregisterAuthIpc();
  unregisterReposIpc();
  unregisterBranchesIpc();
  unregisterCommitsIpc();
  unregisterPullsIpc();
  unregisterBoardIpc();
  unregisterIssuesIpc();
  unregisterLabelsIpc();
  unregisterMembersIpc();
  unregisterMilestonesIpc();
  unregisterUserIpc();
  unregisterPreferencesIpc();
  unregisterClipboardIpc();
}
const log = pino({ name: "sync-runner", level: process.env["LOG_LEVEL"] ?? "info" });
const POLL_INTERVAL_MS = 30 * 1e3;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_BASE_MS = 5 * 1e3;
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1e3;
class SyncRunner {
  timer = null;
  running = false;
  inFlight = /* @__PURE__ */ new Map();
  stopped = false;
  /** 内存里的 pending/failed 列表（按 queuedAt 升序） */
  entries = [];
  /**
   * 启动 runner：
   * 1. loadQueue 恢复
   * 2. gcQueue 清理
   * 3. 立即跑一次（处理上次崩留下的 pending）
   * 4. 起定时器
   */
  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    log.info("SyncRunner: starting");
    this.entries = await loadQueue();
    const gc = await gcQueue();
    log.info({ entries: this.entries.length, gc }, "SyncRunner: queue restored");
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
  }
  /**
   * 停 runner（before-quit）
   * 等待 in-flight 完成
   */
  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all(this.inFlight.values());
    this.running = false;
    log.info("SyncRunner: stopped");
  }
  /**
   * 触发一次轮询（IPC handler 主动调，e.g. 网络恢复时）
   */
  triggerNow() {
    if (this.stopped) return;
    void this.runOnce();
  }
  /**
   * 当前 pending + failed 列表（PreferencesView 待处理面板用）
   */
  listPending() {
    return this.entries.filter(
      (e) => e.status === "pending" || e.status === "failed"
    );
  }
  /**
   * 重试一条 failed entry（用户手动重试按钮）
   */
  async retryEntry(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.attempt = 0;
    e.status = "pending";
    e.lastError = void 0;
    e.failedAt = void 0;
    this.triggerNow();
  }
  /**
   * 放弃一条 entry（用户主动放弃按钮）
   */
  async abandonEntry(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.status = "abandoned";
    await markEntryAbandoned(id);
  }
  /**
   * 内部：跑一轮所有 pending/failed
   *
   * 串行执行（v1 单实例，单条 op 失败不影响其他）
   */
  async runOnce() {
    if (this.stopped) return;
    const work = this.entries.filter(
      (e) => e.status === "pending" || e.status === "failed"
    );
    for (const e of work) {
      if (this.stopped) return;
      if (e.status === "failed" && e.failedAt) {
        const delay = this.backoffMs(e.attempt);
        if (Date.now() - e.failedAt < delay) continue;
      }
      await this.runOne(e);
    }
  }
  /**
   * 内部：跑单条 entry
   */
  async runOne(e) {
    const handler = getRegisteredOp(e.op);
    if (!handler) {
      log.error({ op: e.op, id: e.id }, "SyncRunner: op no longer registered, abandoning");
      e.status = "abandoned";
      await markEntryAbandoned(e.id);
      return;
    }
    e.status = "in-flight";
    e.attempt += 1;
    const inflight = (async () => {
      try {
        await handler.execute(e.args);
        e.status = "done";
        await markEntryDone(e.id);
        log.info(
          { id: e.id, op: e.op, attempt: e.attempt },
          "SyncRunner: entry done"
        );
      } catch (err) {
        e.failedAt = Date.now();
        if (e.attempt >= MAX_ATTEMPTS) {
          e.status = "abandoned";
          await markEntryAbandoned(e.id);
          log.error(
            { id: e.id, op: e.op, attempt: e.attempt, err: errMsg(err) },
            "SyncRunner: max attempts reached, abandoning"
          );
        } else {
          e.status = "failed";
          await markEntryFailed(e.id, errMsg(err));
          log.warn(
            { id: e.id, op: e.op, attempt: e.attempt, err: errMsg(err) },
            "SyncRunner: entry failed, will retry"
          );
        }
      } finally {
        this.inFlight.delete(e.id);
      }
    })();
    this.inFlight.set(e.id, inflight);
    await inflight;
  }
  /**
   * 内部：指数退避（5s, 10s, 20s, 40s, 80s, 160s, capped 5min）
   */
  backoffMs(attempt) {
    return Math.min(
      RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
      RETRY_BACKOFF_MAX_MS
    );
  }
}
function errMsg(err) {
  if (err instanceof IpcError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
let runnerInstance = null;
function getSyncRunner() {
  if (!runnerInstance) {
    runnerInstance = new SyncRunner();
  }
  return runnerInstance;
}
if (!app.isPackaged && process.env["GITEA_KANBAN_DISABLE_REMOTE_DEBUG"] !== "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9492");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
  logger.info({ port: 9492 }, "electron remote debugging enabled (dev only)");
}
if (!app.isPackaged) {
  app.commandLine.appendSwitch("no-sandbox");
  logger.info("chromium sandbox disabled (dev only)");
}
if (!app.isPackaged) {
  app.setPath("userData", "/tmp/gitea-kanban-dev");
  logger.info("userData moved to /tmp/gitea-kanban-dev (dev only)");
}
const skipSingleton = !app.isPackaged && process.env["GITEA_KANBAN_SKIP_SINGLETON"] !== "0";
const gotLock = skipSingleton ? true : app.requestSingleInstanceLock({
  name: APP_SINGLE_INSTANCE_LOCK_NAME,
  appName: APP_NAME
});
if (!gotLock) {
  logger.warn("another instance is running, exiting");
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  logger.info("second instance detected, focusing main window");
  createMainWindow();
});
app.on("ready", async () => {
  try {
    logger.info("app ready (before upgradeLoggerToFile)");
    upgradeLoggerToFile();
    logger.info({ version: app.getVersion(), isPackaged: app.isPackaged }, "app ready");
    logger.info("initLocalStore start");
    await initLocalStore();
    logger.info("localStore initialized");
    const { gcCache: gcCache2 } = await Promise.resolve().then(() => fileStore);
    gcCache2();
    logger.info("cache gc done");
    logger.info("registerAllIpcHandlers start");
    registerAllIpcHandlers();
    logger.info("IPC handlers registered");
    logger.info("SyncRunner start");
    await getSyncRunner().start();
    logger.info("SyncRunner started");
    logger.info("createMainWindow start");
    createMainWindow();
    logger.info("createMainWindow done");
    try {
      const status = await authStatus();
      const active = status.accounts[0];
      if (active) {
        installCspHeader(active.giteaUrl);
        logger.info({ giteaUrl: active.giteaUrl }, "CSP reinstalled for restored account");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "CSP reinstall on boot failed (non-fatal)"
      );
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : void 0 }, "failed during app ready");
    app.quit();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (app.isReady()) {
    createMainWindow();
  }
});
app.on("before-quit", () => {
  logger.info("app quitting");
  unregisterAllIpcHandlers();
  destroyMainWindow();
  void closeLocalStore().then(() => getSyncRunner().stop());
});
process.on("uncaughtException", (err) => {
});
process.on("unhandledRejection", (reason) => {
});
