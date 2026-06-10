/**
 * preload 桥：contextBridge.exposeInMainWorld('api', api)
 *
 * 铁律（AGENTS.md §8.2 鉴权铁律）：
 * - `api` 上**不暴露 token 字段**（除 auth.connect 入参一次性接收）
 * - 渲染进程只通过 ipcRenderer.invoke('channel', args) → Promise<result>
 * - IpcError reject 时是 plain object（toJSON 输出）
 * - 不暴露 ipcRenderer / process / require
 *
 * M1 状态（plan_373b3dd8 / preload-bridge task）：
 *   - src/main/ipc/schema.ts 已注册 30 个 IpcChannel：
 *     auth×3, repos×3, branches×5, commits×3, pulls×4, board×12
 *   - 本文件暴露完整 30 个 invoke + on() 监听器
 *   - api.d.ts 通过 `Api = typeof api` 自动派生，**不**手改
 *
 * 方法签名约定（除 auth.connect 历史兼容性保留 (giteaUrl, token) 双参）：
 *   `(args: object) => ipcRenderer.invoke(IpcChannel.XXX, args)`
 *   返回 `Promise<unknown>`（由 main 端 handler 给出 Zod-typed 实际类型；
 *   渲染端通过 `Api = typeof api` 在编译时拿到具体返回类型，运行时仍 unknown）
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannel } from '../shared/ipc-channels.js';

/** 标准 invoke 包装：`(args) => ipcRenderer.invoke(channel, args)` */
const invoke =
  (channel: string) =>
  (args: object = {}): Promise<unknown> =>
    ipcRenderer.invoke(channel, args);

/**
 * 白名单 API（**不**含 token 字段）
 *
 * 设计：每个方法都包 try/catch 不需要——ipcRenderer.invoke 本身就是 Promise，
 *       reject 时是 plain object（IpcError.toJSON），渲染端用 instanceof / duck-type 判断
 *
 * 命名空间（02-architecture.md §5.3）：
 *   auth × 3    : connect, disconnect, status
 *   repos × 3   : list, addProject, removeProject
 *   branches × 5: list, create, rename, delete, star
 *   commits × 3 : list, get, timeline
 *   pulls × 4   : list, get, create, merge
 *   board.columns × 5: list, create, update, reorder, delete
 *   board.cards    × 7: list, create, update, move, delete, link, unlink
 *   ─────────────────
 *   合计: 30 个 invoke
 */
const api = {
  // ===== auth namespace（AGENTS §8.2 token 唯一入口）=====
  auth: {
    /**
     * **唯一**接收 token 的入口（AGENTS §8.2 铁律）
     * 签名保留 (giteaUrl, token) 双参以兼容 M0 调用方；
     * token 在 main 端走 keychain.setPassword，**不**留内存外。
     */
    connect: (giteaUrl: string, token: string): Promise<unknown> =>
      ipcRenderer.invoke(IpcChannel.AUTH_CONNECT, { giteaUrl, token }),
    disconnect: (args: { giteaUrl: string }): Promise<unknown> =>
      ipcRenderer.invoke(IpcChannel.AUTH_DISCONNECT, args),
    status: invoke(IpcChannel.AUTH_STATUS),
  },

  // ===== repos namespace =====
  repos: {
    list: invoke(IpcChannel.REPOS_LIST),
    addProject: invoke(IpcChannel.REPOS_ADD_PROJECT),
    removeProject: invoke(IpcChannel.REPOS_REMOVE_PROJECT),
  },

  // ===== branches namespace =====
  branches: {
    list: invoke(IpcChannel.BRANCHES_LIST),
    create: invoke(IpcChannel.BRANCHES_CREATE),
    rename: invoke(IpcChannel.BRANCHES_RENAME),
    delete: invoke(IpcChannel.BRANCHES_DELETE),
    star: invoke(IpcChannel.BRANCHES_STAR),
  },

  // ===== commits namespace =====
  commits: {
    list: invoke(IpcChannel.COMMITS_LIST),
    get: invoke(IpcChannel.COMMITS_GET),
    timeline: invoke(IpcChannel.COMMITS_TIMELINE),
  },

  // ===== pulls namespace =====
  pulls: {
    list: invoke(IpcChannel.PULLS_LIST),
    get: invoke(IpcChannel.PULLS_GET),
    create: invoke(IpcChannel.PULLS_CREATE),
    merge: invoke(IpcChannel.PULLS_MERGE),
  },

  // ===== board namespace（columns + cards 两个子 namespace）=====
  board: {
    columns: {
      list: invoke(IpcChannel.BOARD_COLUMNS_LIST),
      create: invoke(IpcChannel.BOARD_COLUMNS_CREATE),
      update: invoke(IpcChannel.BOARD_COLUMNS_UPDATE),
      reorder: invoke(IpcChannel.BOARD_COLUMNS_REORDER),
      delete: invoke(IpcChannel.BOARD_COLUMNS_DELETE),
    },
    cards: {
      list: invoke(IpcChannel.BOARD_CARDS_LIST),
      create: invoke(IpcChannel.BOARD_CARDS_CREATE),
      update: invoke(IpcChannel.BOARD_CARDS_UPDATE),
      move: invoke(IpcChannel.BOARD_CARDS_MOVE),
      delete: invoke(IpcChannel.BOARD_CARDS_DELETE),
      link: invoke(IpcChannel.BOARD_CARDS_LINK),
      unlink: invoke(IpcChannel.BOARD_CARDS_UNLINK),
    },
  },

  /**
   * 通用 on() 监听主进程事件推送
   *
   * 设计（02-architecture.md §5.1 send/on）：
   *   main → webContents.send('event:<name>', payload)
   *   renderer → window.api.on('<name>', cb)
   *
   * 返回 off() 用于卸载监听（避免内存泄漏）
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
