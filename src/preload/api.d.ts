/**
 * window.api 类型声明（preload 桥的 TS 镜像）
 *
 * 渲染端 import 'preload/api.d.ts' 或在 tsconfig.json include 进来即可拿到 window.api 类型。
 *
 * 同步主进程 IPC schema（src/main/ipc/schema.ts）；字段不匹配由 backend agent 改 schema。
 */

import type { Api } from './index.js';

declare global {
  interface Window {
    api: Api;
  }
}

export {};
