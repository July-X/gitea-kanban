/**
 * preload桥：contextBridge.exposeInMainWorld('api', api)
 *
 *铁律（AGENTS.md §8.2鉴权铁律）：
 * - `api`上**不暴露 token字段**（除 auth.connect入参一次性接收）
 * -渲染进程只通过 ipcRenderer.invoke('channel', args) → Promise<result>
 * - IpcError reject时是 plain object（toJSON输出）
 * -不暴露 ipcRenderer / process / require
 *
 * M3状态（ADR-0002 reset）：
 * - src/main/ipc/schema.ts 注册32 个 IpcChannel（M2是30 个）：
 * auth×3, repos×3, branches×5, commits×3, pulls×4,
 * board.columns×7 (reset后从5→7，加 mapLabel/unmapLabel),
 * issues×9 (新增：list/get/create/update/addLabel/removeLabel/moveColumn + comment.list/create),
 * labels×2 (新增)
 * - 本文件暴露完整32 个 invoke + on()监听器
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
 * ─────────────────
 *合计:32 个 invoke
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
