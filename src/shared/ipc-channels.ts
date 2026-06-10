/**
 * IPC channel 名常量（zod-free）
 *
 * 唯一信息源：docs/design/02-architecture.md §5.1（端点命名）+ §5.3（10 个 namespace）
 *
 * 为何独立此文件：
 * - sandboxed preload 不允许 runtime require external 模块（AGENTS §8.10）
 * - preload 也用这些 channel 字符串 → 不能 import 自带 zod 的 src/main/ipc/schema.js
 * - 此文件零依赖、零运行时副作用 → 既可被 sandboxed preload 单文件 CJS bundle 静态包含
 *   （不需 externalizeDeps），也可被 main 端 schema.ts re-export
 *
 * 历史：
 * - 2026-06-11：从 src/main/ipc/schema.ts 抽离（修复 preload sandbox module not found: zod）
 *
 * 端点清单（30 个）：
 *   auth          × 3   : connect / disconnect / status
 *   repos         × 3   : list / addProject / removeProject
 *   branches      × 5   : list / create / rename / delete / star
 *   commits       × 3   : list / get / timeline
 *   pulls         × 4   : list / get / create / merge
 *   board.columns × 5   : list / create / update / reorder / delete
 *   board.cards   × 7   : list / create / update / move / delete / link / unlink
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

  // === board.columns namespace（02-architecture.md §5.3.7）===
  BOARD_COLUMNS_LIST: 'board.columns.list',
  BOARD_COLUMNS_CREATE: 'board.columns.create',
  BOARD_COLUMNS_UPDATE: 'board.columns.update',
  BOARD_COLUMNS_REORDER: 'board.columns.reorder',
  BOARD_COLUMNS_DELETE: 'board.columns.delete',

  // === board.cards namespace（02-architecture.md §5.3.8）===
  BOARD_CARDS_LIST: 'board.cards.list',
  BOARD_CARDS_CREATE: 'board.cards.create',
  BOARD_CARDS_UPDATE: 'board.cards.update',
  BOARD_CARDS_MOVE: 'board.cards.move',
  BOARD_CARDS_DELETE: 'board.cards.delete',
  BOARD_CARDS_LINK: 'board.cards.link',
  BOARD_CARDS_UNLINK: 'board.cards.unlink',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
