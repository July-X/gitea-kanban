/**
 * preload 桥：contextBridge.exposeInMainWorld('api', api)
 *
 * 铁律（AGENTS.md §8.2 鉴权铁律）：
 * - `api` 上**不暴露 token 字段**（除 auth.connect 入参一次性接收）
 * - 渲染进程只通过 ipcRenderer.invoke('channel', args) → Promise<result>
 * - IpcError reject 时是 plain object（toJSON 输出）
 * - 不暴露 ipcRenderer / process / require
 *
 * 当前 M0 暴露：
 *   auth.connect / auth.disconnect / auth.status
 *
 * Plan 2 起按 02 §5.3 顺序补全。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannel } from '../main/ipc/schema.js';

/**
 * 白名单 API（**不**含 token 字段）
 *
 * 设计：每个方法都包 try/catch 不需要——ipcRenderer.invoke 本身就是 Promise，
 *       reject 时是 plain object（IpcError.toJSON），渲染端用 instanceof / duck-type 判断
 */
const api = {
  auth: {
    connect: (giteaUrl: string, token: string) =>
      ipcRenderer.invoke(IpcChannel.AUTH_CONNECT, { giteaUrl, token }),
    disconnect: (giteaUrl: string) =>
      ipcRenderer.invoke(IpcChannel.AUTH_DISCONNECT, { giteaUrl }),
    status: () => ipcRenderer.invoke(IpcChannel.AUTH_STATUS),
  },
  // === Plan 2 占位 ===
  // repos: { list: (args) => ipcRenderer.invoke(IpcChannel.REPOS_LIST, args) },
  // ...
  /**
   * 通用 on() 监听主进程事件推送
   *
   * 设计（02-architecture.md §5.1 send/on）：
   *   main → webContents.send('event:webhook', payload)
   *   renderer → window.api.on('webhook', cb)
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
