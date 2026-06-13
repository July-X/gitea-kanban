/**
 * IPC 路由统一注册入口
 *
 * 加新 namespace 时：
 * 1. 在 src/main/ipc/schema.ts 加 Zod schema + channel 常量
 * 2. 在 src/main/ipc/<namespace>.ts 写 handler（参考 auth.ts 的 wrapIpc 模式）
 * 3. 在本文件 import + 调 register
 *
 * M3 (ADR-0002 reset) 改动：
 * - 加 registerIssuesIpc / registerLabelsIpc（新增 namespace）
 * - board.cards.* 7 个端点**已删**（registerBoardIpc 只剩 7 个 board.columns.* 端点）
 *
 * theme-ipc（v1.1.2 主题切换，2026-06-12）改动：
 * - 加 registerPreferencesIpc（preferences.theme.get / set 2 个端点）
 *   —— 持久化走 sqlite prefs 表（M5 已建）
 *   —— 契约来源：design-system/pages/tech-refine.md §16
 */

import { registerAuthIpc, unregisterAuthIpc } from './auth.js';
import { registerReposIpc, unregisterReposIpc } from './repos.js';
import { registerCommitsIpc, unregisterCommitsIpc } from './commits.js';
import { registerPullsIpc, unregisterPullsIpc } from './pulls.js';
import { registerBoardIpc, unregisterBoardIpc } from './board.js';
import { registerIssuesIpc, unregisterIssuesIpc } from './issues.js';
import { registerLabelsIpc, unregisterLabelsIpc } from './labels.js';
import { registerMembersIpc, unregisterMembersIpc } from './members.js';
import { registerUserIpc, unregisterUserIpc } from './user.js';
import { registerPreferencesIpc, unregisterPreferencesIpc } from './preferences.js';
import { registerClipboardIpc, unregisterClipboardIpc } from './clipboard.js';

export function registerAllIpcHandlers(): void {
  registerAuthIpc();
  registerReposIpc();
  registerCommitsIpc();
  registerPullsIpc();
  registerBoardIpc();
  registerIssuesIpc();
  registerLabelsIpc();
  registerMembersIpc();
  registerUserIpc();
  registerPreferencesIpc();
  registerClipboardIpc();
}

export function unregisterAllIpcHandlers(): void {
  unregisterAuthIpc();
  unregisterReposIpc();
  unregisterCommitsIpc();
  unregisterPullsIpc();
  unregisterBoardIpc();
  unregisterIssuesIpc();
  unregisterLabelsIpc();
  unregisterMembersIpc();
  unregisterUserIpc();
  unregisterPreferencesIpc();
  unregisterClipboardIpc();
}
