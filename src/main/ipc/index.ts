/**
 * IPC 路由统一注册入口
 *
 * 加新 namespace 时：
 *   1. 在 src/main/ipc/schema.ts 加 Zod schema + channel 常量
 *   2. 在 src/main/ipc/<namespace>.ts 写 handler（参考 auth.ts 的 wrapIpc 模式）
 *   3. 在本文件 import + 调 register
 */

import { registerAuthIpc, unregisterAuthIpc } from './auth.js';
import { registerReposIpc, unregisterReposIpc } from './repos.js';
import { registerBranchesIpc, unregisterBranchesIpc } from './branches.js';

export function registerAllIpcHandlers(): void {
  registerAuthIpc();
  registerReposIpc();
  registerBranchesIpc();
  // === 后续 namespace 在此追加 ===
  // registerCommitsIpc();
  // registerPullsIpc();
  // ...
}

export function unregisterAllIpcHandlers(): void {
  unregisterAuthIpc();
  unregisterReposIpc();
  unregisterBranchesIpc();
}
