/**
 * IPC channel 名常量（zod-free）
 *
 * 唯一信息源：AGENTS.md §6.2 Wails Binding 模式 + ADR-0005（v2.0 迁移）+ ADR-0006 §2.2（业务 binding 补全）
 *
> **⚠️ 2026-07-01 注释更新（v0.3.0 梳理）**：本文件早期注释引用的 `docs/design/02-architecture.md §5.1`（已 DEPRECATED）和 `sandboxed preload`（v2.0 起已无 preload 概念）已不再适用。当前实现：
> - v2.0 起无 preload：渲染端通过 `window.go.main.App.<Method>()` 直接调 Go 后端（Wails 自动注入 bindings 到 `frontend/wailsjs/`）
> - 渲染端 IPC 调用走 `ipc-client.ts` → shim（`window.api.*`）→ Wails bindings（`window.go.main.App.*`），详见 `lib/wails-api-shim.ts`。
>
> 端点清单（v0.5.0-m9 当前生效，44 个）：从 `frontend/wailsjs/wailsjs/go/main/App.d.ts` 生成；以 `git diff frontend/wailsjs/ main.go` 验证一致性
 *
 * 为何独立此文件（v1 时代历史背景）：
 * - v1 sandboxed preload 不允许 runtime require external 模块（Electron 沙箱）
 * - v1 preload 也用这些 channel 字符串 → 不能 import 自带 zod 的 src/main/ipc/schema.js
 * - v1 此文件零依赖、零运行时副作用 → 既可被 sandboxed preload 单文件 CJS bundle 静态包含
 *   （不需 externalizeDeps），也可被 main 端 schema.ts re-export
 *
 * 历史：
 * - 2026-06-11：v1 从 src/main/ipc/schema.ts 抽离（修复 preload sandbox module not found: zod）
 * - 2026-06-11 ADR-0002 reset：删 board.cards.* 7 个 + 加 issues.* 7 个 + labels.* 2 个
 * - 2026-06-12 v1 theme-ipc：加 THEME_GET / THEME_SET 2 个端点
 * - 2026-06-13 v1 clipboard：加 CLIPBOARD_WRITE 1 个端点
 * - 2026-06-13 v1 undo-by-project：加 USER_UNDO_STATUS 1 个端点
 * - 2026-06-22 v2.0：Wails 迁移，前端从 `src/renderer/` 迁到 `frontend/src/`；channel 名沿用 `namespace.method` 风格
 * - 2026-07-01 v0.3.0：注释对齐 v2.0/v2.4/v3.0 实际状态
 *
 * 端点清单（v0.5.0-m9，44 个 binding；以 Wails 生成的 App.d.ts 为准）：
 * auth ×5 : connect / status / disconnect / disconnectOne / switchAccount（v2.4 补 disconnectOne/switchAccount）
 * repos ×3 : list / addProject / removeProject（v2.3 修复 StatusBar 刷新）
 * branches ×5 : list / star / unstar / listStarredBranches（v2.x 移除 create/rename/delete）
 * commits ×3 : get / gitgraphCloneRepo / gitgraphIsRepoCloned / gitgraphPull + logGraph（v2.4 补）
 * pulls ×3 : merge（v1 M11）/ get / list（GitHub 暂不支持）
 * board.columns ×5 : list / create / update / delete / mapLabel（v1 M4 + v2 hotfix）
 * issues ×1 : list（其余方法暂未迁移到 Go 端）
 * user ×4 : prefs.get / prefs.set / undo / redo（v2.4 修复 prefs 死链）
 * preferences ×2 : theme.get / theme.set（v1.1.2 主题切换）
 *
 * 命名说明（v1.1.2 主题端点）：
 * - channel 字面量 = `'preferences.theme.get'` / `'preferences.theme.set'` / `'preferences.clipboard.write'`
 * - 走 `preferences.*` 而非 `theme.*`：v1.1.2 之后还会有更多"应用级偏好"共享同一 namespace
 * - 渲染端 API 暴露 = `window.api.*`（Wails API shim 注入，详见 lib/wails-api-shim.ts）
 */

export const IpcChannel = {
  // === auth namespace（02-architecture.md §5.3.1）===
  AUTH_CONNECT: 'auth.connect',
  AUTH_DISCONNECT: 'auth.disconnect',
  AUTH_STATUS: 'auth.status',
  // v1.6 账号管理：按 URL+username 删除单个账号（区别于 disconnect 删整站）
  AUTH_DISCONNECT_ONE: 'auth.disconnectOne',
  // v1.6 账号管理：切换当前活跃账号（重排 accounts 顺序）
  AUTH_SWITCH_ACCOUNT: 'auth.switchAccount',

  // === repos namespace（02-architecture.md §5.3.1）===
  REPOS_LIST: 'repos.list',
  REPOS_ADD_PROJECT: 'repos.addProject',
  REPOS_REMOVE_PROJECT: 'repos.removeProject',

  // === branches namespace（02-architecture.md §5.3.2）===
  // 破坏性操作清理（2026-06-15 用户拍板）：create/delete 已从 App 移除，保留 list/rename/star
  BRANCHES_LIST: 'branches.list',
  BRANCHES_RENAME: 'branches.rename',
  BRANCHES_STAR: 'branches.star',

  // === commits namespace（02-architecture.md §5.3.3 + §5.3.4）===
  COMMITS_LIST: 'commits.list',
  COMMITS_GET: 'commits.get',
  // v2：名称沿用历史 `gitgraph.lines`，实际返回 GraphResultDto（结构化 nodes + edges）
  COMMITS_GITGRAPH_LINES: 'commits.gitgraph.lines',
  // v1.5 启用 Git Graph：自动 git clone 仓库到本地
  COMMITS_GITGRAPH_CLONE_REPO: 'commits.gitgraph.cloneRepo',
  // v1.5.2 pull (merge)：git fetch + pull --rebase，Header 的 pull 按钮调
  COMMITS_GITGRAPH_PULL: 'commits.gitgraph.pull',
  // v1.5.3 workspace：用户配置应用本地仓库工作区根目录
  COMMITS_GITGRAPH_GET_WORKSPACE: 'commits.gitgraph.getWorkspace',
  COMMITS_GITGRAPH_SET_WORKSPACE: 'commits.gitgraph.setWorkspace',
  // v2.3 检查 owner/repo 是否已 clone 本地
  COMMITS_GITGRAPH_IS_REPO_CLONED: 'commits.gitgraph.isRepoCloned',
  // v1.6 workspace 迁移：检测旧仓库 / 迁移 / 打开目录
  COMMITS_GITGRAPH_LIST_WORKSPACE_REPOS: 'commits.gitgraph.listWorkspaceRepos',
  COMMITS_GITGRAPH_MIGRATE_WORKSPACE: 'commits.gitgraph.migrateWorkspace',
  COMMITS_GITGRAPH_OPEN_DIRECTORY: 'commits.gitgraph.openDirectory',

  // === pulls namespace（02-architecture.md §5.3.5 + §5.3.6）===
  // 破坏性操作清理（2026-06-15 用户拍板）：create 已从 App 移除，保留 list/get/merge/close
  PULLS_LIST: 'pulls.list',
  PULLS_GET: 'pulls.get',
  PULLS_MERGE: 'pulls.merge',
  PULLS_CLOSE: 'pulls.close',
  PULLS_UPDATE_LABELS: 'pulls.updateLabels',
  PULLS_UPDATE_ASSIGNEE: 'pulls.updateAssignee',
  PULLS_UPDATE_REVIEWERS: 'pulls.updateReviewers',


  // === issues namespace（ADR-0002 reset：卡片 = gitea issue）===
  ISSUES_LIST: 'issues.list',
  ISSUES_GET: 'issues.get',
  ISSUES_CREATE: 'issues.create',
  ISSUES_UPDATE: 'issues.update',
  ISSUES_ADD_LABEL: 'issues.addLabel',
  ISSUES_REMOVE_LABEL: 'issues.removeLabel',
  ISSUES_MOVE_COLUMN: 'issues.moveColumn',
  // issues.comment 子命名空间（v1 与 issues 同 namespace暴露在 api.issues.comment）
  ISSUES_COMMENT_LIST: 'issues.comment.list',
  ISSUES_COMMENT_CREATE: 'issues.comment.create',

  // === labels namespace（ADR-0002：看板列绑 gitea label 用）===
  LABELS_LIST: 'labels.list',
  LABELS_CREATE: 'labels.create',

  // === members namespace（a3 新增：仓库成员 = gitea repo collaborators）===
  MEMBERS_LIST: 'members.list',

  // === milestones namespace（v1.4 新增：新建议题弹窗选里程碑用）===
  MILESTONES_LIST: 'milestones.list',

  // === user namespace（02-architecture.md §5.3.9；M5补齐 + M6 undo-by-project）===
  USER_PREFS_GET: 'user.prefs.get',
  USER_PREFS_SET: 'user.prefs.set',
  USER_UNDO: 'user.undo',
  USER_REDO: 'user.redo',
  USER_UNDO_STATUS: 'user.undoStatus',

  // === preferences namespace（v1.1.2 主题切换 —— design-system/pages/tech-refine.md §16）===
  // 走 preferences.* 而非 theme.*，为后续"应用级偏好"（通知规则 / 同步周期 / 自定义快捷键等）留 namespace 空间。
  // 持久化走 sqlite prefs 表（M5 已建：key='theme'，value=JSON.stringify(theme)）。
  THEME_GET: 'preferences.theme.get',
  THEME_SET: 'preferences.theme.set',
  // 剪贴板写入（v1.1.3 提交号复制）—— 走主进程 electron.clipboard 模块，
  // 绕过 navigator.clipboard.writeText 在 Electron renderer 窗口无 focus / 非用户激活时的不稳定行为
  CLIPBOARD_WRITE: 'preferences.clipboard.write',

  // === system namespace（系统级能力）===
  // v1.5.3: selectDirectory —— 系统目录选择器
  SYSTEM_SELECT_DIRECTORY: 'system.selectDirectory',
  // v2.2: openPath —— 打开系统文件管理器到指定目录（用于"打开应用数据目录"按钮）
  SYSTEM_OPEN_PATH: 'system.openPath',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

/**
 * main → renderer 推送事件名（通过 webContents.send('event:<name>', payload)）
 *
 * preload 端 api.on(event, cb) 会自动加 'event:' 前缀。
 * 这里只定义事件名本体（不含前缀）。
 */
export const IpcEvent = {
  /** workspace 迁移进度（每个仓库复制完推一次） */
  WORKSPACE_MIGRATE_PROGRESS: 'workspace:migrateProgress',
} as const;
