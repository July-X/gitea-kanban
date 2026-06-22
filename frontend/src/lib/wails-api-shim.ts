/**
 * Wails API Shim —— 把 Wails 的 Go bindings 适配成旧前端 window.api 接口
 *
 * 背景：旧 Electron 前端通过 window.api.<namespace>.<method>(args) 调 IPC。
 * Wails 架构下 Go 后端方法暴露在 window.go.main.App.<Method>()。
 * 本 shim 在应用启动时注入 window.api，让旧前端代码不改就能跑。
 *
 * 迁移策略（步骤 1.3 桩化阶段）：
 *   - 所有方法先返回桩数据或 reject（表示尚未实现）
 *   - 后续步骤（2.3 GiteaAdapter / 4.1 go-git 等）逐步在 Go 侧实现真实方法后，
 *     把对应 shim 方法改为转发到 window.go.main.App.*
 *
 * 真实转发示例（后续步骤）：
 *   auth: {
 *     status: () => window.go.main.App.AuthStatus(),
 *     connect: (giteaUrl, token) => window.go.main.App.AuthConnect(giteaUrl, token),
 *   }
 */

/** 桩化错误（表示后端方法尚未实现） */
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

/** window.api 的形状（与旧 preload/index.ts 一致） */
const apiShim = {
  auth: {
    connect: (giteaUrl: string, token: string, platform?: string): Promise<unknown> =>
      notImplemented('auth', 'connect'),
    disconnect: (_args: { giteaUrl: string }): Promise<unknown> =>
      notImplemented('auth', 'disconnect'),
    disconnectOne: (_args: { giteaUrl: string; username: string }): Promise<unknown> =>
      notImplemented('auth', 'disconnectOne'),
    switchAccount: (_args: { accountId: string }): Promise<unknown> =>
      notImplemented('auth', 'switchAccount'),
    status: (): Promise<unknown> => stubEmpty({ accounts: [], currentUser: null }),
  },

  repos: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    addProject: (_args: unknown): Promise<unknown> => notImplemented('repos', 'addProject'),
    removeProject: (_args: unknown): Promise<unknown> => notImplemented('repos', 'removeProject'),
  },

  branches: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    rename: (_args: unknown): Promise<unknown> => notImplemented('branches', 'rename'),
    star: (_args: unknown): Promise<unknown> => notImplemented('branches', 'star'),
  },

  commits: {
    list: (_args: unknown): Promise<unknown> => stubEmpty({ items: [], hasMore: false }),
    get: (_args: unknown): Promise<unknown> => notImplemented('commits', 'get'),
    gitgraphLines: (_args: unknown): Promise<unknown> =>
      stubEmpty({ nodes: [], edges: [], maxLane: 0, truncated: false }),
    gitgraphCloneRepo: (_args: unknown): Promise<unknown> =>
      notImplemented('commits', 'gitgraphCloneRepo'),
    gitgraphPull: (_args: unknown): Promise<unknown> =>
      notImplemented('commits', 'gitgraphPull'),
    gitgraphGetWorkspace: (): Promise<unknown> =>
      stubEmpty({ path: '', defaultPath: '' }),
    gitgraphSetWorkspace: (_args: unknown): Promise<unknown> =>
      notImplemented('commits', 'gitgraphSetWorkspace'),
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
      get: (_args: unknown): Promise<unknown> => stubEmpty(null),
      set: (_args: unknown): Promise<unknown> => notImplemented('user.prefs', 'set'),
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

  system: {
    selectDirectory: (): Promise<string | null> => Promise.resolve(null),
  },

  on: (_event: string, _cb: (payload: unknown) => void): (() => void) => {
    // 桩化事件监听（Wails 用 EventsOn/EventsOff，后续步骤接入）
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
