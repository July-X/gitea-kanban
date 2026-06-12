/**
 * IPC channel 名常量（zod-free）
 *
 *唯一信息源：docs/design/02-architecture.md §5.1（端点命名）+ ADR-0002 reset
 *
 * 为何独立此文件：
 * - sandboxed preload 不允许 runtime require external 模块（AGENTS §8.10）
 * - preload 也用这些 channel字符串 →不能 import 自带 zod 的 src/main/ipc/schema.js
 * -此文件零依赖、零运行时副作用 →既可被 sandboxed preload 单文件 CJS bundle静态包含
 *（不需 externalizeDeps），也可被 main端 schema.ts re-export
 *
 * 历史：
 * -2026-06-11：从 src/main/ipc/schema.ts抽离（修复 preload sandbox module not found: zod）
 * -2026-06-11 ADR-0002 reset：删 board.cards.*7 个 + 加 issues.*7 个 + labels.*2 个
 *
 *端点清单（a3 拍板，37 个）：
 * auth ×3 : connect / disconnect / status
 * repos ×3 : list / addProject / removeProject
 * branches ×5 : list / create / rename / delete / star
 * commits ×3 : list / get / timeline
 * pulls ×4 : list / get / create / merge
 * board.columns ×7 : list / create / update / reorder / delete / mapLabel / unmapLabel
 * issues ×7 : list / get / create / update / addLabel / removeLabel / moveColumn
 * labels ×2 : list / create
 * issues.comment ×2 : list / create（注：在 issues.comment.*命名空间下；callable via issues.comment.list/create）
 * members ×1 : list（a3 新增：仓库成员 = gitea repo collaborators；返 `CollaboratorDto[]` 数组形态）
 * user ×4 : prefs.get / prefs.set / undo / redo（02 §5.3.9；M5补齐）
 *
 * 历史端点计数：M5=36 → a3=37（+1 members.list）
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
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
