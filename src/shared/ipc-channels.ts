/**
 * IPC channel 名常量（zod-free）
 *
 * 唯一信息源：docs/design/02-architecture.md §5.1（端点命名）+ ADR-0002 reset
 *
 * 为何独立此文件：
 * - sandboxed preload 不允许 runtime require external 模块（AGENTS §8.10）
 * - preload 也用这些 channel 字符串 → 不能 import 自带 zod 的 src/main/ipc/schema.js
 * - 此文件零依赖、零运行时副作用 → 既可被 sandboxed preload 单文件 CJS bundle 静态包含
 *   （不需 externalizeDeps），也可被 main 端 schema.ts re-export
 *
 * 历史：
 * - 2026-06-11：从 src/main/ipc/schema.ts 抽离（修复 preload sandbox module not found: zod）
 * - 2026-06-11 ADR-0002 reset：删 board.cards.* 7 个 + 加 issues.* 7 个 + labels.* 2 个
 * - 2026-06-12 theme-ipc（v1.1.2 主题切换）：加 THEME_GET / THEME_SET 2 个端点
 *   （持久化走 sqlite prefs 表，channel 命名沿 preferences.* 而非常规 theme.* —— 见下）
 * - 2026-06-13 clipboard：加 CLIPBOARD_WRITE 1 个端点（preferences.clipboard.write，分支/提交号复制）
 *
 * 端点清单（M6 拍板，44 个）：
 * auth ×3 : connect / disconnect / status
 * repos ×3 : list / addProject / removeProject
 * branches ×5 : list / create / rename / delete / star
 * commits ×3 : list / get / timeline
 * pulls ×4 : list / get / create / merge
 * board.columns ×7 : list / create / update / reorder / delete / mapLabel / unmapLabel
 * issues ×7 : list / get / create / update / addLabel / removeLabel / moveColumn
 * labels ×2 : list / create
 * issues.comment ×2 : list / create（注：在 issues.comment.* 命名空间下；callable via issues.comment.list/create）
 * members ×1 : list（a3 新增：仓库成员 = gitea repo collaborators；返 `CollaboratorDto[]` 数组形态）
 * user ×4 : prefs.get / prefs.set / undo / redo（02 §5.3.9；M5 补齐）
 * preferences ×3 : theme.get / theme.set（v1.1.2 主题切换 —— §16 tech-refine.md 拍板）/ clipboard.write（M6 补：分支/提交号复制）
 *
 * 命名说明（v1.1.2 主题端点）：
 * - channel 字面量 = `'preferences.theme.get'` / `'preferences.theme.set'` / `'preferences.clipboard.write'`
 *   —— 走 `preferences.*` 而非 `theme.*`，理由：v1.1.2 之后还会有更多"应用级偏好"
 *   （如通知规则 / 同步周期 / 自定义快捷键 / 剪贴板等）共享同一个 namespace，主题只是其中之一
 * - 渲染端 API 暴露 = `window.api.preferences.{theme,clipboard}.{get,set,write}`（preload 端在 theme-preload / clipboard task 改）
 *
 * 历史端点计数：M3=32 → M5 fix-3=36（+4 user.prefs）→ a3=37（+1 members）→ theme-ipc=39（+2 preferences.theme）→ clipboard=44（+1 preferences.clipboard.write）
 */

export const IpcChannel = {
 // === auth namespace（02-architecture.md §5.3.1）===
 AUTH_CONNECT: 'auth.connect',
 AUTH_DISCONNECT: 'auth.disconnect',
 AUTH_STATUS: 'auth.status',

 // === repos namespace（02-architecture.md §5.3.1）===
 REPOS_LIST: 'repos.list',
 REPOS_ADD_PROJECT: 'repos.addProject',
 REPOS_REMOVE_PROJECT: 'repos.removeProject',

 // === branches namespace（02-architecture.md §5.3.2）===
 BRANCHES_LIST: 'branches.list',
 BRANCHES_CREATE: 'branches.create',
 BRANCHES_RENAME: 'branches.rename',
 BRANCHES_DELETE: 'branches.delete',
 BRANCHES_STAR: 'branches.star',

 // === commits namespace（02-architecture.md §5.3.3 + §5.3.4）===
 COMMITS_LIST: 'commits.list',
 COMMITS_GET: 'commits.get',
 COMMITS_TIMELINE: 'commits.timeline',

 // === pulls namespace（02-architecture.md §5.3.5 + §5.3.6）===
 PULLS_LIST: 'pulls.list',
 PULLS_GET: 'pulls.get',
 PULLS_CREATE: 'pulls.create',
 PULLS_MERGE: 'pulls.merge',

 // === board.columns namespace（ADR-0002 reset）===
 BOARD_COLUMNS_LIST: 'board.columns.list',
 BOARD_COLUMNS_CREATE: 'board.columns.create',
 BOARD_COLUMNS_UPDATE: 'board.columns.update',
 BOARD_COLUMNS_REORDER: 'board.columns.reorder',
 BOARD_COLUMNS_DELETE: 'board.columns.delete',
 BOARD_COLUMNS_MAP_LABEL: 'board.columns.mapLabel',
 BOARD_COLUMNS_UNMAP_LABEL: 'board.columns.unmapLabel',

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

  // === user namespace（02-architecture.md §5.3.9；M5补齐）===
  USER_PREFS_GET: 'user.prefs.get',
  USER_PREFS_SET: 'user.prefs.set',
  USER_UNDO: 'user.undo',
  USER_REDO: 'user.redo',

  // === preferences namespace（v1.1.2 主题切换 —— design-system/pages/tech-refine.md §16）===
  // 走 preferences.* 而非 theme.*，为后续"应用级偏好"（通知规则 / 同步周期 / 自定义快捷键等）留 namespace 空间。
  // 持久化走 sqlite prefs 表（M5 已建：key='theme'，value=JSON.stringify(theme)）。
  THEME_GET: 'preferences.theme.get',
  THEME_SET: 'preferences.theme.set',
  // 剪贴板写入（v1.1.3 提交号复制）—— 走主进程 electron.clipboard 模块，
  // 绕过 navigator.clipboard.writeText 在 Electron renderer 窗口无 focus / 非用户激活时的不稳定行为
  CLIPBOARD_WRITE: 'preferences.clipboard.write',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
