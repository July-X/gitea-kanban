/**
 * Wails API Shim —— 把 Wails 的 Go bindings 适配成 v1 时代的 window.api 接口
 *
 * 背景：v1 时代前端通过 window.api.<namespace>.<method>(args) 调 IPC。
 * v2.0 起 Wails 架构下 Go 后端方法暴露在 window.go.main.App.<Method>()。
 * 本 shim 在应用启动时注入 window.api，让 v1 时代前端代码不改就能跑。
 *
 * 迁移策略：
 *   - auth.* 已经接入 Wails bindings（v2.0 修复 token 接通链路 bug）
 *     → auth.connect/status/disconnect/disconnectOne/switchAccount 转发到 window.go.main.App.AuthXxx
 *   - 其它方法（repos/branches/commits/issues/...）暂未在 Go 端实现 → 仍走桩化
 *   - 后续迁移：每个 namespace 完成后把对应 shim 方法改为转发到 window.go.main.App.*
 */

/**
 * 桩化错误（表示后端方法尚未实现）
 *
 * 设计：用 ipc.NewValidationFailed 形态让前端能识别 code
 * 实际触发场景：
 *   - 用户点了还没实现的入口（如 GitHub 的 issue 列表）
 *   - 前端 store 没过滤就调了还没接入的方法
 */
function notImplemented(namespace: string, method: string): Promise<never> {
  return Promise.reject({
    code: 'internal',
    message: `${namespace}.${method} 尚未实现（Wails 迁移中）`,
    hint: '此功能正在迁移到 Go+Wails 架构',
  });
}

/** 桩化空数据返回（让前端能加载但不显示数据） */
function stubEmpty<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

/**
 * Wails App binding 的精确类型
 *
 * 由 wails generate module 生成到 frontend/wailsjs/wailsjs/go/main/App.d.ts
 * 这里只在 shim 里用最小子集，避免把整个 .d.ts 复制进来
 */
type WailsApp = {
  AuthConnect?: (args: { platform: string; giteaUrl: string; token: string }) => Promise<unknown>;
  AuthStatus?: () => Promise<unknown>;
  AuthDisconnect?: (args: { giteaUrl: string }) => Promise<unknown>;
  AuthDisconnectOne?: (args: { giteaUrl: string; username: string }) => Promise<unknown>;
  AuthSwitchAccount?: (args: { accountId: string }) => Promise<unknown>;
  /** v2.x：拿数据根目录 + 内部 workspace 子目录
   *  - dataRoot: 用户可感知的"全局路径"，默认 ~/.gitea-kanban
   *  - workspacePath: 内部 git repos 目录 (= dataRoot + "/workspace")，应用自动创建 */
  GetWorkspace?: () => Promise<{
    dataRoot: string;
    workspacePath: string;
    isDefault: boolean;
    validated: boolean;
  }>;
  SetWorkspace?: (a: { cwd: string }) => Promise<void>;
  /** v2.2：用系统文件管理器打开应用数据目录 */
  OpenDataDir?: () => Promise<void>;
  /** v2.3：clone 仓库到本地 workspace（不传 token，从 keychain 拿）
   *  v2.x：优先 projectId（Go 端反查 account），旧协议 platform/hostUrl/username 回退 */
  CloneRepo?: (args: {
    projectId?: string;
    platform: string;
    hostUrl: string;
    username: string;
    owner: string;
    repo: string;
  }) => Promise<{ localPath: string; reused: boolean }>;
  /** v2.3：检查 owner/repo 是否已 clone 本地
   *  v2.5：按账号分层（新增 username 参数） */
  IsRepoCloned?: (args: { username?: string; owner: string; repo: string }) => Promise<boolean>;
  /** v2.3：pull 仓库最新改动（不传 token，从 localPath 反查） */
  PullRepo?: (args: { localPath: string }) => Promise<{
    beforeCount: number;
    afterCount: number;
    addedCommits: number;
    headChanged: boolean;
  }>;
  /** v2.3 修复 StatusBar 刷新按钮：列某账号可访问的仓库（merge isProject） */
  ListRepos?: (args: {
    giteaAccountId: string;
    query?: string;
    limit: number;
    page: number;
  }) => Promise<{
    items: Array<{
      id: number;
      owner: string;
      name: string;
      fullName: string;
      defaultBranch: string;
      description: string;
      archived: boolean;
      private: boolean;
      updatedAt: string;
      permissions?: { pull: boolean; push: boolean; admin: boolean };
      isProject: boolean;
      lastSyncAt?: string;
    }>;
    total: number;
    page: number;
    hasMore: boolean;
  }>;
  /** v2.3 标记仓库为本机 project */
  AddProject?: (args: { giteaAccountId: string; owner: string; name: string }) => Promise<unknown>;
  /** v2.3 取消本机 project 标记 */
  RemoveProject?: (args: { projectId: string }) => Promise<void>;
  /** v2.4 用户偏好（statusbar 选仓库持久化） */
  GetUserPrefs?: (args: { keys: string[] }) => Promise<Record<string, unknown>>;
  SetUserPrefs?: (args: { entries: Record<string, unknown> }) => Promise<{ written: number; deleted: number }>;
  /** v2.4 按 projectId 查项目信息（localPath + cloned 状态） */
  GetRepoById?: (args: { projectId: string }) => Promise<{
    project: { id: string; platform: string; accountId: string; owner: string; name: string; defaultBranch: string; lastSyncAt: number; createdAt: number };
    account: { id: string; platform: string; giteaUrl: string; username: string; keychainService: string; createdAt: number; userInfo?: unknown };
    localPath: string;
    cloned: boolean;
  }>;
  /** v2.15：按本地仓库路径读取 commit 详情（含 files / +/- stats） */
  GetCommitDetail?: (args: { localPath: string; sha: string }) => Promise<unknown>;
  /** v2.4 按 projectId 拉取 Git Graph（反查 localPath + token） */
  GetGitGraph?: (args: { projectId: string; branches?: string[]; maxCount?: number }) => Promise<{
    nodes: Array<{
      row: number;
      lane: number;
      color: number;
      sha: string;
      shortSha: string;
      subject: string;
      authorName: string;
      authorEmail: string;
      date: string;
      isMerge: boolean;
      parents: string[];
      refs?: string[];
      refTypes?: string[];
      isCurrent?: boolean;
      isStash?: boolean;
      /** v3.x：UNCOMMITTED 虚拟节点 = false，常规 commit = true（缺省视作 true） */
      isCommitted?: boolean;
    }>;
    edges: Array<{ fromRow: number; toRow: number; fromLane: number; toLane: number; color: number; type: number }>;
    branches?: Array<{
      color: number;
      end: number;
      lines: Array<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        lockedFirst: boolean;
        /** v3.x：UNCOMMITTED 段 = false，常规段 = true（缺省视作 true） */
        isCommitted?: boolean;
      }>;
    }>;
    maxLane: number;
    truncated: boolean;
  }>;
  /** v2.x：GitHub/gh 超大仓库使用 git log --graph ASCII fallback */
  GetGitGraphAscii?: (args: { projectId: string; branches?: string[]; maxCount?: number }) => Promise<unknown>;
  /** v2.4 按 projectId 拉取（避免前端拼错 localPath） */
  PullRepoByProjectId?: (args: { projectId: string }) => Promise<{
    beforeCount: number;
    afterCount: number;
    addedCommits: number;
    headChanged: boolean;
    headBefore: string;
    headAfter: string;
  }>;
  /**
   * v0.4.0：Git 二进制设置（SettingsView "Git 二进制" 卡片）。
   *
   * - GetGitBinaryConfig: 读当前 userOverride + defaultPath + effectivePath + version
   * - SetGitBinaryPath: 持久化 prefs["app.gitBinaryPath"] + 进程内立刻 SetUserOverride
   * - TestGitBinary: 验证路径是否可执行（macOS quarantine 检测）
   * - StripGitBinaryQuarantine: macOS 主动 xattr -d 剥离
   * - OpenGitBinaryPicker: 平台特定 wailsruntime.OpenFileDialog
   *
   * 任何 binding 缺失都让 shim 返「Wails 未启动」/「重新构建」错误，不静默成功。
   */
  GetGitBinaryConfig?: () => Promise<{
    userOverride: string;
    defaultPath: string;
    embeddedVersion: string;
    effectivePath: string;
    embeddedAvailable: boolean;
  }>;
  SetGitBinaryPath?: (args: { path: string }) => Promise<void>;
  TestGitBinary?: (args: { path: string }) => Promise<{
    ok: boolean;
    version: string;
    path: string;
    message: string;
    hint: string;
  }>;
  StripGitBinaryQuarantine?: (args: { path: string }) => Promise<void>;
  OpenGitBinaryPicker?: () => Promise<string>;
};

/** 拿到 window.go.main.App（Wails 在启动期注入） */
function wailsApp(): WailsApp | undefined {
  return (window as unknown as { go?: { main?: { App?: WailsApp } } })?.go?.main?.App;
}

/**
 * 转发到 Wails binding；如果 Wails 没启动（前端独立跑 dev / 浏览器）则降级到桩化
 *
 * @param fallback Wails 未就绪时的兜底（通常是桩化错误或桩化空数据）
 */
async function forwardToWails<T>(fallback: () => Promise<T>, fn: (app: WailsApp) => Promise<T>): Promise<T> {
  const app = wailsApp();
  if (!app) {
    return fallback();
  }
  return fn(app);
}

/** window.api 的形状（与旧 preload/index.ts 一致） */
const apiShim = {
  auth: {
    /**
     * auth.connect —— v2.0 修复 token 接通链路
     *
     * 转发到 window.go.main.App.AuthConnect({ platform, giteaUrl, token })
     * 旧版 shim 这里返回 notImplemented → 用户填 token 后报错"auth.connect 尚未实现"
     * 现在直接走 Go 后端的 AuthConnect：
     *   1. 调平台 adapter.VerifyToken 验证 token
     *   2. token 写 system keychain（go-keyring）
     *   3. localStore 持久化账号元信息
     *   4. 返 { account, user } 给前端
     */
    connect: (giteaUrl: string, token: string, platform?: string): Promise<unknown> =>
      forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'auth.connect 尚未连接到 Go 后端（Wails 未启动）',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        (app) => {
          if (!app.AuthConnect) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 AuthConnect',
              hint: '请重新构建应用',
            });
          }
          return app.AuthConnect({ platform: platform ?? 'gitea', giteaUrl, token });
        },
      ),
    /**
     * auth.disconnect —— 按 giteaUrl 删整站所有账号
     */
    disconnect: (args: { giteaUrl: string }): Promise<unknown> =>
      forwardToWails(
        () => Promise.reject({ code: 'internal', message: 'auth.disconnect 尚未连接到 Go 后端' }),
        (app) => app.AuthDisconnect?.(args) ?? Promise.reject({ code: 'internal', message: 'Wails 绑定缺失 AuthDisconnect' }),
      ),
    /**
     * auth.disconnectOne —— 按 giteaUrl + username 删单个账号
     */
    disconnectOne: (args: { giteaUrl: string; username: string }): Promise<unknown> =>
      forwardToWails(
        () => Promise.reject({ code: 'internal', message: 'auth.disconnectOne 尚未连接到 Go 后端' }),
        (app) => app.AuthDisconnectOne?.(args) ?? Promise.reject({ code: 'internal', message: 'Wails 绑定缺失 AuthDisconnectOne' }),
      ),
    /**
     * auth.switchAccount —— 把指定账号提到首位
     */
    switchAccount: (args: { accountId: string }): Promise<unknown> =>
      forwardToWails(
        () => Promise.reject({ code: 'internal', message: 'auth.switchAccount 尚未连接到 Go 后端' }),
        (app) => app.AuthSwitchAccount?.(args) ?? Promise.reject({ code: 'internal', message: 'Wails 绑定缺失 AuthSwitchAccount' }),
      ),
    /**
     * auth.status —— 拿所有账号 + 当前用户（**不**含 token）
     */
    status: (): Promise<unknown> =>
      forwardToWails(
        () => stubEmpty({ accounts: [], currentUser: null }),
        (app) => app.AuthStatus?.() ?? stubEmpty({ accounts: [], currentUser: null }),
      ),
  },

  repos: {
    /**
     * repos.list —— v2.3 修复 StatusBar 刷新按钮"没反应"的 bug
     *
     * 旧版 shim 是 stubEmpty({ items: [], hasMore: false })：
     *   - 用户点刷新 → 拉 0 个仓库 → 没法选
     * 现在转发到 window.go.main.App.ListRepos({giteaAccountId, query, limit, page})
     */
    list: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as {
        giteaAccountId: string;
        query?: string;
        limit?: number;
        page?: number;
      };
      return forwardToWails(
        () => stubEmpty({ items: [], total: 0, page: 1, hasMore: false }),
        (app) => {
          if (!app.ListRepos) {
            return stubEmpty({ items: [], total: 0, page: 1, hasMore: false });
          }
          return app.ListRepos({
            giteaAccountId: a.giteaAccountId ?? '',
            query: a.query,
            limit: a.limit ?? 50,
            page: a.page ?? 1,
          });
        },
      );
    },
    addProject: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { giteaAccountId: string; owner: string; name: string };
      return forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'repos.addProject 尚未连接到 Go 后端',
          }),
        (app) => {
          if (!app.AddProject) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 AddProject',
            });
          }
          return app.AddProject({
            giteaAccountId: a.giteaAccountId ?? '',
            owner: a.owner ?? '',
            name: a.name ?? '',
          }).then((res: unknown) => {
            // Go 端返回 { project: store.RepoProject }，前端期望 { ...RepoProjectDto }
            // 把嵌套的 project 字段展开，让 repo store 拿到正确的 uuid
            const r = res as Record<string, unknown>;
            if (r && typeof r === 'object' && 'project' in r) {
              return r.project;
            }
            return res;
          });
        },
      );
    },
    removeProject: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { projectId: string };
      return forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'repos.removeProject 尚未连接到 Go 后端',
          }),
        (app) => {
          if (!app.RemoveProject) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 RemoveProject',
            });
          }
          return app.RemoveProject({ projectId: a.projectId ?? '' });
        },
      );
    },
  },

  branches: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    rename: (_args: unknown): Promise<unknown> => notImplemented('branches', 'rename'),
    star: (_args: unknown): Promise<unknown> => notImplemented('branches', 'star'),
  },

  commits: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    get: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { projectId?: string; sha?: string };
      return forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'commits.get 尚未连接到 Go 后端',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        async (app) => {
          if (!app.GetRepoById || !app.GetCommitDetail) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 GetRepoById / GetCommitDetail',
              hint: '请重新构建应用',
            });
          }
          const repoInfo = await app.GetRepoById({ projectId: a.projectId ?? '' });
          return app.GetCommitDetail({
            localPath: repoInfo.localPath ?? '',
            sha: a.sha ?? '',
          });
        },
      );
    },
    /**
     * gitgraphLines —— v2.4 修复 StatusBar 选完仓库后 Git Graph 不可用
     *
     * 旧版 stubEmpty → 永远返空 graph，看板/TimelineNewView/Merges 都看不见 commit
     * 现在转发到 window.go.main.App.GetGitGraph({projectId, branches, maxCount})
     *   - Go 端按 projectId 反查 localPath + token
     *   - 调 adapter.LogGraph（GitHub 对齐 vscode-git-graph 的 git log 输入 + 自研 layout）
     *   - 返 GraphResultDTO（结构化 nodes + edges + branches）
     */
    gitgraphLines: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as {
        projectId: string;
        branches?: string[];
        limit?: number;
      };
      return forwardToWails(
        () => stubEmpty({ nodes: [], edges: [], maxLane: 0, truncated: false }),
        (app) => {
          if (!app.GetGitGraph) {
            return stubEmpty({ nodes: [], edges: [], maxLane: 0, truncated: false });
          }
          return app.GetGitGraph({
            projectId: a.projectId ?? '',
            branches: a.branches,
            maxCount: a.limit,
          });
        },
      );
    },
    gitgraphAsciiLines: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as {
        projectId: string;
        branches?: string[];
        limit?: number;
      };
      return forwardToWails(
        () => stubEmpty({ lines: [], totalCommits: 0, truncated: false, range: { from: '', to: '' } }),
        (app) => {
          if (!app.GetGitGraphAscii) {
            return stubEmpty({ lines: [], totalCommits: 0, truncated: false, range: { from: '', to: '' } });
          }
          return app.GetGitGraphAscii({
            projectId: a.projectId ?? '',
            branches: a.branches,
            maxCount: a.limit,
          });
        },
      );
    },
    /**
     * gitgraphCloneRepo —— v2.3 转发到 App.CloneRepo
     *
     * 旧版 shim 是 notImplemented。新版：
     *   - 接收 args.projectId（旧协议，向后兼容）
     *   - 实际调 window.go.main.App.CloneRepo({platform, hostUrl, username, owner, repo})
     *   - 前端用 repo.owner + repo.name 直接传 owner/repo（不再需要 projectId）
     */
    gitgraphCloneRepo: (args: unknown): Promise<unknown> => {
      // 优先 projectId（v2.x，与 PullRepoByProjectId 范式对齐）：Go 端反查 account
      // 旧协议回退：{ platform?, hostUrl?, username?, owner, repo }
      const a = (args ?? {}) as {
        projectId?: string;
        platform?: string;
        hostUrl?: string;
        username?: string;
        owner?: string;
        repo?: string;
      };
      return forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'gitgraphCloneRepo 尚未连接到 Go 后端',
          }),
        (app) => {
          if (!app.CloneRepo) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 CloneRepo',
            });
          }
          return app.CloneRepo({
            projectId: a.projectId ?? '',
            platform: a.platform ?? 'gitea',
            hostUrl: a.hostUrl ?? '',
            username: a.username ?? '',
            owner: a.owner ?? '',
            repo: a.repo ?? '',
          });
        },
      );
    },
    /**
     * gitgraphIsRepoCloned —— v2.3 检查 owner/repo 是否已 clone 本地
     * 前端 StatusBar 仓库管理面板用
     *
     * v2.5：按账号分层（args.username 可选；空时 fallback 到旧版路径）
     */
    gitgraphIsRepoCloned: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { username?: string; owner: string; repo: string };
      return forwardToWails(
        () => Promise.resolve(false), // Wails 未启动时降级返 false（按钮显示"同步"）
        (app) => app.IsRepoCloned?.(a) ?? Promise.resolve(false),
      );
    },
    /**
     * gitgraphPull —— v2.4 修复 StatusBar 更新按钮的 localPath 拼接 bug
     *
     * 旧版只接 { localPath }，前端用 `~/.gitea-kanban/workspace/repos/...` 拼错
     * 新版：接 { projectId?, localPath? }，优先用 projectId 让 Go 端按 owner+repo 算
     *   - projectId 走 App.PullRepo 内部按 owner+repo + workspacePath 算
     *   - 兼容旧 caller 仍传 localPath
     */
    gitgraphPull: (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { projectId?: string; localPath?: string };
      return forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'gitgraphPull 尚未连接到 Go 后端',
          }),
        (app) => {
          if (!app.PullRepo) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 PullRepo',
            });
          }
          if (a.projectId) {
            if (!app.PullRepoByProjectId) {
              return Promise.reject({
                code: 'internal',
                message: 'Wails 绑定缺失 PullRepoByProjectId',
              });
            }
            return app.PullRepoByProjectId({ projectId: a.projectId });
          }
          return app.PullRepo({ localPath: a.localPath ?? '' });
        },
      );
    },
    gitgraphGetWorkspace: (): Promise<unknown> => {
      // v2.x：Wails 未启动时 (前端独立 dev) 返回 mock 数据根目录
      const mockRoot = '~/.gitea-kanban';
      return forwardToWails(
        () =>
          stubEmpty({
            dataRoot: mockRoot,
            workspacePath: mockRoot + '/workspace',
            isDefault: true,
            validated: true,
          }),
        (app) =>
          app.GetWorkspace?.() ??
          stubEmpty({
            dataRoot: mockRoot,
            workspacePath: mockRoot + '/workspace',
            isDefault: true,
            validated: true,
          }),
      );
    },
    gitgraphSetWorkspace: (args: { cwd: string }): Promise<unknown> => {
      return forwardToWails(
        () => {
          // Wails 未启动（前端独立运行）— 接受用户输入但仅 console.warn
          console.warn('[gitea-kanban] setWorkspace stub: Wails not running, path not persisted:', args.cwd);
          return stubEmpty({ cwd: args.cwd });
        },
        (app) =>
          app.SetWorkspace?.({ cwd: args.cwd }).then(() => ({ cwd: args.cwd })) ??
          stubEmpty({ cwd: args.cwd }),
      );
    },
    gitgraphListWorkspaceRepos: (_args: unknown): Promise<unknown> => stubEmpty([]),
    gitgraphMigrateWorkspace: (_args: unknown): Promise<unknown> =>
      notImplemented('commits', 'gitgraphMigrateWorkspace'),
    gitgraphOpenDirectory: (_args: unknown): Promise<unknown> =>
      notImplemented('commits', 'gitgraphOpenDirectory'),
  },

  pulls: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    get: (_args: unknown): Promise<unknown> => notImplemented('pulls', 'get'),
    merge: (_args: unknown): Promise<unknown> => notImplemented('pulls', 'merge'),
    close: (_args: unknown): Promise<unknown> => notImplemented('pulls', 'close'),
    updateLabels: (_args: unknown): Promise<unknown> => notImplemented('pulls', 'updateLabels'),
    updateAssignee: (_args: unknown): Promise<unknown> => notImplemented('pulls', 'updateAssignee'),
    updateReviewers: (_args: unknown): Promise<unknown> =>
      notImplemented('pulls', 'updateReviewers'),
  },

  board: {
    columns: {
      list: (_args: unknown): Promise<unknown> => stubEmpty([]),
      create: (_args: unknown): Promise<unknown> => notImplemented('board.columns', 'create'),
      update: (_args: unknown): Promise<unknown> => notImplemented('board.columns', 'update'),
      reorder: (_args: unknown): Promise<unknown> => notImplemented('board.columns', 'reorder'),
      delete: (_args: unknown): Promise<unknown> => notImplemented('board.columns', 'delete'),
      mapLabel: (_args: unknown): Promise<unknown> => notImplemented('board.columns', 'mapLabel'),
      unmapLabel: (_args: unknown): Promise<unknown> =>
        notImplemented('board.columns', 'unmapLabel'),
      reset: (_args: unknown): Promise<unknown> => notImplemented('board.columns', 'reset'),
    },
  },

  issues: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    get: (_args: unknown): Promise<unknown> => notImplemented('issues', 'get'),
    create: (_args: unknown): Promise<unknown> => notImplemented('issues', 'create'),
    update: (_args: unknown): Promise<unknown> => notImplemented('issues', 'update'),
    addLabel: (_args: unknown): Promise<unknown> => notImplemented('issues', 'addLabel'),
    removeLabel: (_args: unknown): Promise<unknown> => notImplemented('issues', 'removeLabel'),
    moveColumn: (_args: unknown): Promise<unknown> => notImplemented('issues', 'moveColumn'),
    comment: {
      list: (_args: unknown): Promise<unknown> => stubEmpty([]),
      create: (_args: unknown): Promise<unknown> => notImplemented('issues.comment', 'create'),
    },
  },

  labels: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    create: (_args: unknown): Promise<unknown> => notImplemented('labels', 'create'),
  },

  members: {
    list: (_args: unknown): Promise<unknown> => stubEmpty([]),
  },

  milestones: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
  },

  user: {
    prefs: {
      /**
       * user.prefs.get —— v2.4 修复
       *
       * 旧版 stubEmpty(null) → 永远返 null，App.vue restoreLastSelected 拿不到 prefs
       * 现在转发到 window.go.main.App.GetUserPrefs({ keys })
       */
      get: (args: unknown): Promise<unknown> => {
        const a = (args ?? {}) as { keys?: string[] };
        return forwardToWails(
          () => stubEmpty(null), // Wails 未启动时降级
          (app) => {
            if (!app.GetUserPrefs) {
              return stubEmpty(null);
            }
            return app.GetUserPrefs({ keys: a.keys ?? [] });
          },
        );
      },
      /**
       * user.prefs.set —— v2.4 修复
       *
       * 旧版 notImplemented → persistLastSelected 写 prefs 永远失败
       * 现在转发到 window.go.main.App.SetUserPrefs({ entries })
       */
      set: (args: unknown): Promise<unknown> => {
        const a = (args ?? {}) as { entries?: Record<string, unknown> };
        return forwardToWails(
          () =>
            Promise.reject({
              code: 'internal',
              message: 'user.prefs.set 尚未连接到 Go 后端',
            }),
          (app) => {
            if (!app.SetUserPrefs) {
              return Promise.reject({
                code: 'internal',
                message: 'Wails 绑定缺失 SetUserPrefs',
              });
            }
            return app.SetUserPrefs({ entries: a.entries ?? {} });
          },
        );
      },
    },
    undo: (_args: unknown): Promise<unknown> => notImplemented('user', 'undo'),
    redo: (_args: unknown): Promise<unknown> => notImplemented('user', 'redo'),
    undoStatus: (_args: unknown): Promise<unknown> => stubEmpty({ canUndo: false, canRedo: false }),
  },

  preferences: {
    theme: {
      get: (): Promise<unknown> => stubEmpty({ theme: 'dark' }),
      set: (_args: unknown): Promise<unknown> => notImplemented('preferences.theme', 'set'),
    },
    clipboard: {
      write: (args: { text: string }): Promise<void> => {
        // 剪贴板在前端直接用 navigator.clipboard（Wails 环境支持）
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          return navigator.clipboard.writeText(args.text).catch(() => undefined);
        }
        return Promise.resolve();
      },
    },
  },

  /**
   * v0.4.0：git binary 子 namespace（"settings.gitBinary"）
   *
   *   - getConfig(): 读当前 userOverride + defaultPath + effectivePath
   *   - setPath({path}): 持久化 + 立即生效
   *   - test({path}): 验证 path 是否合法 git binary
   *   - stripQuarantine({path}): macOS 主动 xattr -d com.apple.quarantine
   *   - pickFile(): 弹平台特定文件选择对话框
   */
  gitBinary: {
    getConfig: (): Promise<{
      userOverride: string;
      defaultPath: string;
      embeddedVersion: string;
      effectivePath: string;
      embeddedAvailable: boolean;
    }> =>
      forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'gitBinary.getConfig 尚未连接到 Go 后端（Wails 未启动）',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        (app) => {
          if (!app.GetGitBinaryConfig) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 GetGitBinaryConfig',
              hint: '请重新构建应用（wails build）',
            });
          }
          return app.GetGitBinaryConfig();
        },
      ),
    setPath: (args: { path: string }): Promise<void> =>
      forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'gitBinary.setPath 尚未连接到 Go 后端',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        (app) => {
          if (!app.SetGitBinaryPath) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 SetGitBinaryPath',
              hint: '请重新构建应用（wails build）',
            });
          }
          return app.SetGitBinaryPath(args);
        },
      ),
    test: (args: { path: string }): Promise<{
      ok: boolean;
      version: string;
      path: string;
      message: string;
      hint: string;
    }> =>
      forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'gitBinary.test 尚未连接到 Go 后端',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        (app) => {
          if (!app.TestGitBinary) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 TestGitBinary',
              hint: '请重新构建应用（wails build）',
            });
          }
          return app.TestGitBinary(args);
        },
      ),
    stripQuarantine: (args: { path: string }): Promise<void> =>
      forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'gitBinary.stripQuarantine 尚未连接到 Go 后端',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        (app) => {
          if (!app.StripGitBinaryQuarantine) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 StripGitBinaryQuarantine',
              hint: '请重新构建应用（wails build）',
            });
          }
          return app.StripGitBinaryQuarantine(args);
        },
      ),
    pickFile: (): Promise<string> =>
      forwardToWails(
        () => Promise.resolve(''),
        (app) => {
          if (!app.OpenGitBinaryPicker) {
            return Promise.resolve('');
          }
          return app.OpenGitBinaryPicker();
        },
      ),
  },

  system: {
    selectDirectory: (): Promise<string | null> => Promise.resolve(null),
    /**
     * system.openPath —— v2.2 设置页"打开应用数据目录"按钮
     *
     * 转发到 window.go.main.App.OpenDataDir()，Go 端用 open/explorer/xdg-open 实现
     */
    openPath: (_args: { path: string }): Promise<unknown> =>
      forwardToWails(
        () =>
          Promise.reject({
            code: 'internal',
            message: 'system.openPath 尚未连接到 Go 后端（Wails 未启动）',
            hint: '请在 Wails 桌面窗口中操作',
          }),
        (app) => {
          if (!app.OpenDataDir) {
            return Promise.reject({
              code: 'internal',
              message: 'Wails 绑定缺失 OpenDataDir',
              hint: '请重新构建应用',
            });
          }
          return app.OpenDataDir();
        },
      ),
  },

  on: (event: string, cb: (payload: unknown) => void): (() => void) => {
    // v2.6 进度事件订阅：转发到 window.runtime.EventsOn
    // （Wails 启动期由 ipc.js 注入 window.runtime；浏览器独立 dev 模式没 runtime，
    //  走 no-op 兜底）
    const runtime = (window as unknown as { runtime?: { EventsOn?: (e: string, c: (...args: unknown[]) => void) => () => void } }).runtime;
    if (runtime?.EventsOn) {
      return runtime.EventsOn(event, cb as (...args: unknown[]) => void);
    }
    return () => undefined;
  },
};

/** 在应用启动前注入 window.api */
export function installApiShim(): void {
  if (typeof window === 'undefined') return;
  // 如果 Wails bindings 已生成且后端方法就绪，可以在这里逐步替换 shim 方法
  // 目前全部走桩化
  (window as unknown as Record<string, unknown>).api = apiShim;
}
