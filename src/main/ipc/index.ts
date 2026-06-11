/**
 * IPC路由统一注册入口
 *
 *加新 namespace时：
 *1.在 src/main/ipc/schema.ts加 Zod schema + channel 常量
 *2.在 src/main/ipc/<namespace>.ts写 handler（参考 auth.ts 的 wrapIpc模式）
 *3.在本文件 import +调 register
 *
 * M3 (ADR-0002 reset)改动：
 * - 加 registerIssuesIpc / registerLabelsIpc（新增 namespace）
 * - board.cards.*7 个端点**已删**（registerBoardIpc 只剩7 个 board.columns.*端点）
 */

import { registerAuthIpc, unregisterAuthIpc } from './auth.js';
import { registerReposIpc, unregisterReposIpc } from './repos.js';
import { registerBranchesIpc, unregisterBranchesIpc } from './branches.js';
import { registerCommitsIpc, unregisterCommitsIpc } from './commits.js';
import { registerPullsIpc, unregisterPullsIpc } from './pulls.js';
import { registerBoardIpc, unregisterBoardIpc } from './board.js';
import { registerIssuesIpc, unregisterIssuesIpc } from './issues.js';
import { registerLabelsIpc, unregisterLabelsIpc } from './labels.js';

export function registerAllIpcHandlers(): void {
 registerAuthIpc();
 registerReposIpc();
 registerBranchesIpc();
 registerCommitsIpc();
 registerPullsIpc();
 registerBoardIpc();
 registerIssuesIpc();
 registerLabelsIpc();
}

export function unregisterAllIpcHandlers(): void {
 unregisterAuthIpc();
 unregisterReposIpc();
 unregisterBranchesIpc();
 unregisterCommitsIpc();
 unregisterPullsIpc();
 unregisterBoardIpc();
 unregisterIssuesIpc();
 unregisterLabelsIpc();
}
