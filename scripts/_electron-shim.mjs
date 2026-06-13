import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const stubPath = url.fileURLToPath(import.meta.url);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') {
    return stubPath;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const stub = {
  app: {
    isPackaged: true,
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    getPath: (name) => {
      if (name === 'userData') {
        return path.join(process.env.HOME || '/tmp', '.gitea-kanban');
      }
      if (name === 'logs') {
        return path.join(process.env.HOME || '/tmp', '.gitea-kanban', 'logs');
      }
      return process.cwd();
    },
    getName: () => 'gitea-kanban',
    getVersion: () => '0.1.0',
    on: () => undefined,
    once: () => undefined,
    quit: () => undefined,
  },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
  contextBridge: {
    exposeInMainWorld: () => undefined,
  },
  BrowserWindow: class BrowserWindow {},
};

export default stub;
// **M6 加**：ESM 命名导出（Node 20+ ESM 解析 'electron' 时走静态分析，'import { app }' 必须能拿到命名导出）
export const { app, ipcMain, contextBridge, BrowserWindow } = stub;
