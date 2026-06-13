/**
 * preload桥：contextBridge.exposeInMainWorld('api', api)
 *
 *铁律（AGENTS.md §8.2鉴权铁律）：
 * - `api`上**不暴露 token字段**（除 auth.connect入参一次性接收）
 * -渲染进程只通过 ipcRenderer.invoke('channel', args) → Promise<result>
 * - IpcError reject时是 plain object（toJSON输出）
 * -不暴露 ipcRenderer / process / require
 *
 * M6状态（M5 补齐 user.* 4 个，a3 补齐 members.* 1 个，theme-preload 补齐 preferences.theme.* 2 个，clipboard 补齐 preferences.clipboard.write 1 个，undo-by-project 补齐 user.undoStatus 1 个）：
 * - src/main/ipc/schema.ts 注册 45 个 IpcChannel（M3=32 → M5 fix-3=36 → a3=37 → theme-preload=39 → clipboard=44 → undo-by-project=45）：
 * auth×3, repos×3, branches×5, commits×3, pulls×4,
 * board.columns×7 (reset后从5→7，加 mapLabel/unmapLabel),
 * issues×9 (新增：list/get/create/update/addLabel/removeLabel/moveColumn + comment.list/create),
 * labels×2 (新增), members×1 (a3 新增：list — 仓库成员 = gitea repo collaborators),
 * user×5 (M5补齐：prefs.get/set + undo/redo；M6 undo-by-project：undoStatus),
 * preferences×3 (v1.1.2 主题切换：preferences.theme.get / preferences.theme.set；M6补：preferences.clipboard.write — 分支/提交号复制)
 * - 本文件暴露完整45 个 invoke + on()监听器
 * - api.d.ts通过 `Api = typeof api`自动派生，**不**手改
 *
 * 方法签名约定（除 auth.connect历史兼容性保留 (giteaUrl, token) 双参）：
 * `(args: object) => ipcRenderer.invoke(IpcChannel.XXX, args)`
 * 返回 `Promise<unknown>`（由 main端 handler给出 Zod-typed实际类型；
 *渲染端通过 `Api = typeof api`在编译时拿到具体返回类型，运行时仍 unknown）
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannel } from '../shared/ipc-channels.js';

/**标准 invoke包装：`(args) => ipcRenderer.invoke(channel, args)` */
const invoke =
 (channel: string) =>
 (args: object = {}): Promise<unknown> =>
 ipcRenderer.invoke(channel, args);

/**
 * 白名单API（**不**含 token字段）
 *
 *设计：每个方法都包 try/catch不需要——ipcRenderer.invoke本身就是 Promise，
 * reject时是 plain object（IpcError.toJSON），渲染端用 instanceof / duck-type判断
 *
 *命名空间（ADR-0002 +02-architecture.md §5.3）：
 * auth ×3 : connect, disconnect, status
 * repos ×3 : list, addProject, removeProject
 * branches ×5 : list, create, rename, delete, star
 * commits ×3 : list, get, timeline
 * pulls ×4 : list, get, create, merge
 * board.columns ×7 : list, create, update, reorder, delete, mapLabel, unmapLabel
 * issues ×7 : list, get, create, update, addLabel, removeLabel, moveColumn
 * issues.comment ×2 : list, create
 * labels ×2 : list, create
 * members ×1 : list（a3 新增；返 `CollaboratorDto[]` 数组）
 * user ×5 : prefs.get, prefs.set, undo, redo, undoStatus（M6 undo-by-project：栈深度查询）
 * preferences ×3 : preferences.theme.get, preferences.theme.set（v1.1.2 主题切换 —— design-system/pages/tech-refine.md §16.3）;
 * preferences.clipboard.write（M6 补：分支/提交号复制；commit 588da2b）
 * 走 preferences.* 而非 theme.*，为后续"应用级偏好"（通知规则 / 同步周期 / 自定义快捷键 / 剪贴板等）留 namespace 空间
 * ─────────────────
 *合计:45 个 invoke
 */
const api = {
 //===== auth namespace（AGENTS §8.2 token唯一入口）=====
 auth: {
 /**
 * **唯一**接收 token的入口（AGENTS §8.2铁律）
 *签名保留 (giteaUrl, token) 双参以兼容 M0 调用方；
 * token在 main端走 keychain.setPassword，**不**留内存外。
 */
 connect: (giteaUrl: string, token: string): Promise<unknown> =>
 ipcRenderer.invoke(IpcChannel.AUTH_CONNECT, { giteaUrl, token }),
 disconnect: (args: { giteaUrl: string }): Promise<unknown> =>
 ipcRenderer.invoke(IpcChannel.AUTH_DISCONNECT, args),
 status: invoke(IpcChannel.AUTH_STATUS),
 },

 //===== repos namespace =====
 repos: {
 list: invoke(IpcChannel.REPOS_LIST),
 addProject: invoke(IpcChannel.REPOS_ADD_PROJECT),
 removeProject: invoke(IpcChannel.REPOS_REMOVE_PROJECT),
 },

 //===== branches namespace =====
 branches: {
 list: invoke(IpcChannel.BRANCHES_LIST),
 create: invoke(IpcChannel.BRANCHES_CREATE),
 rename: invoke(IpcChannel.BRANCHES_RENAME),
 delete: invoke(IpcChannel.BRANCHES_DELETE),
 star: invoke(IpcChannel.BRANCHES_STAR),
 },

 //===== commits namespace =====
 commits: {
 list: invoke(IpcChannel.COMMITS_LIST),
 get: invoke(IpcChannel.COMMITS_GET),
 timeline: invoke(IpcChannel.COMMITS_TIMELINE),
 },

 //===== pulls namespace =====
 pulls: {
 list: invoke(IpcChannel.PULLS_LIST),
 get: invoke(IpcChannel.PULLS_GET),
 create: invoke(IpcChannel.PULLS_CREATE),
 merge: invoke(IpcChannel.PULLS_MERGE),
 },

 //===== board.columns namespace (ADR-0002 reset 后 board.cards.*已删)=====
 board: {
 columns: {
 list: invoke(IpcChannel.BOARD_COLUMNS_LIST),
 create: invoke(IpcChannel.BOARD_COLUMNS_CREATE),
 update: invoke(IpcChannel.BOARD_COLUMNS_UPDATE),
 reorder: invoke(IpcChannel.BOARD_COLUMNS_REORDER),
 delete: invoke(IpcChannel.BOARD_COLUMNS_DELETE),
 mapLabel: invoke(IpcChannel.BOARD_COLUMNS_MAP_LABEL),
 unmapLabel: invoke(IpcChannel.BOARD_COLUMNS_UNMAP_LABEL),
 },
 },

 //===== issues namespace (新增 ADR-0002 reset)=====
 //卡片 = gitea issue（ADR-0002 §"数据模型"）
 issues: {
 list: invoke(IpcChannel.ISSUES_LIST),
 get: invoke(IpcChannel.ISSUES_GET),
 create: invoke(IpcChannel.ISSUES_CREATE),
 update: invoke(IpcChannel.ISSUES_UPDATE),
 addLabel: invoke(IpcChannel.ISSUES_ADD_LABEL),
 removeLabel: invoke(IpcChannel.ISSUES_REMOVE_LABEL),
 //拖拽换列专用端点（issues.moveColumn = board.move-card）
 moveColumn: invoke(IpcChannel.ISSUES_MOVE_COLUMN),
 comment: {
 list: invoke(IpcChannel.ISSUES_COMMENT_LIST),
 create: invoke(IpcChannel.ISSUES_COMMENT_CREATE),
 },
 },

  //===== labels namespace (新增 ADR-0002)=====
  labels: {
  list: invoke(IpcChannel.LABELS_LIST),
  create: invoke(IpcChannel.LABELS_CREATE),
  },

  //===== members namespace (a3 新增)=====
  //仓库成员 = gitea repo collaborators；返 `CollaboratorDto[]` 数组形态（**不**包 {items, hasMore}）
  //前端 src/renderer/stores/member.ts useMemberStore.list 直接 `as MemberDto[]` 读
  members: {
  list: invoke(IpcChannel.MEMBERS_LIST),
  },

  //===== user namespace (M5 补齐)=====
  //本机用户偏好（prefs）+ undo/redo（M6 真栈版，按 projectId 弹栈）
  //详见 02-architecture.md §5.3.9 + src/main/ipc/user.ts + src/main/board/undo.ts
  //M6 undo-by-project：args = { projectId }，防跨看板误撤销
  user: {
  prefs: {
  get: invoke(IpcChannel.USER_PREFS_GET),
  set: invoke(IpcChannel.USER_PREFS_SET),
  },
  undo: invoke(IpcChannel.USER_UNDO),
  redo: invoke(IpcChannel.USER_REDO),
  //栈深度查询（UI 灰化按钮用）—— M6 undo-by-project 加
  undoStatus: invoke(IpcChannel.USER_UNDO_STATUS),
  },

  //===== preferences namespace (v1.2 主题切换 — design-system/pages/tech-refine.md §16.3)=====
  //走 preferences.* 而非 theme.*：为后续"应用级偏好"（通知规则 / 同步周期 / 自定义快捷键等）
  // 留 namespace 空间，主题只是其中之一（与 src/shared/ipc-channels.ts v1.2 命名说明一致）。
  //渲染端调用：window.api.preferences.theme.get() / window.api.preferences.theme.set({ theme: 'dark' })
  //持久化走 sqlite prefs 表（main 端 src/main/ipc/preferences.ts），无需手动传 userId。
  // 命名说明：preferences.theme.get / preferences.theme.set 是 channel 字面量也是 window.api 调用路径。
  preferences: {
  theme: {
  get: invoke(IpcChannel.THEME_GET),
  set: invoke(IpcChannel.THEME_SET),
  },
  // v1.1.3 提交号 / 分支名复制（task #20）—— 走主进程 electron.clipboard，
  // 绕过 navigator.clipboard 在 Electron renderer 的不稳定行为
  clipboard: {
  write: invoke(IpcChannel.CLIPBOARD_WRITE),
  },
  },

  /**
   *通用 on()监听主进程事件推送
   *
   * 设计（02-architecture.md §5.1 send/on）：
   * main → webContents.send('event:<name>', payload)
   * renderer → window.api.on('<name>', cb)
   *
   * 返回 off()用于卸载监听（避免内存泄漏）
   */
  on: (event: string, cb: (payload: unknown) => void): (() => void) => {
 const channel = `event:${event}`;
 const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
 ipcRenderer.on(channel, listener);
 return () => ipcRenderer.removeListener(channel, listener);
 },
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
