/**
 * vitest setup —— 注入 mock electron 模块
 *
 * 背景：logger.ts 在模块顶层调 `const isDev = !app.isPackaged`；
 * vitest 测试环境无 Electron → app undefined → TypeError。
 *
 * 覆盖：
 * - app.isPackaged = false（dev 行为）
 * - app.getPath('userData') → /tmp/gitea-kanban-test（隔离测试目录）
 * - app.getVersion / app.getName → stub 字符串
 * - app.on / app.whenReady / app.quit → no-op（避免测试残留）
 *
 * 范围：仅 vitest 测试；生产代码 import 'electron' 仍走真实模块。
 */

import { vi } from 'vitest';

// electron stub：满足 logger.ts / window.ts / index.ts 等模块顶层调用
const electronStub = {
  app: {
    isPackaged: false, // dev 行为（logger.ts 期望）
    getName: () => 'gitea-kanban',
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => {
      if (name === 'userData') return '/tmp/gitea-kanban-test/userData';
      if (name === 'appData') return '/tmp/gitea-kanban-test/appData';
      return '/tmp/gitea-kanban-test';
    },
    on: (_event: string, _handler: (...args: unknown[]) => void) => {
      // no-op
    },
    whenReady: () => Promise.resolve(),
    quit: () => {
      // no-op
    },
  },
  // ipcRenderer / contextBridge / BrowserWindow 等其他模块 stub（如有测试用到再补）
  ipcRenderer: { on: () => {}, send: () => {}, invoke: () => Promise.resolve() },
  contextBridge: { exposeInMainWorld: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
};

vi.mock('electron', () => electronStub);
