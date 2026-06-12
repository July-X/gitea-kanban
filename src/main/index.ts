/**
 * 应用入口：生命周期 + 单实例锁 + IPC 注册
 *
 * 不在这里写业务逻辑（业务在 ipc/* / gitea/* / cache/* 各模块）。
 * 启动顺序：
 *   1. app.requestSingleInstanceLock() —— 第二实例进 IPC 给已有实例
 *   2. app.whenReady() 之后：
 *      a. 升级 logger 到 file transport
 *      b. 初始化 sqlite（建表 / 跑迁移）
 *      c. 注册所有 IPC handler
 *      d. 创建主窗口
 *   3. 监听 window-all-closed（macOS 保留 dock）
 *   4. 监听 activate（macOS 重开窗口）
 */

import { app } from 'electron';
import { logger, upgradeLoggerToFile } from './logger.js';
import { createMainWindow, destroyMainWindow } from './window.js';
import { registerAllIpcHandlers, unregisterAllIpcHandlers } from './ipc/index.js';
import { initSqlite, closeSqlite } from './cache/sqlite.js';
import { APP_NAME, APP_SINGLE_INSTANCE_LOCK_NAME } from '@shared/constants';

// ===== 0. 启用 Electron 远程调试（仅 dev / unpackaged） =====
// 监听端口：9492（与 chrome-devtools-mcp / debugger clients 通用约定）
// 生产构建（packaged）默认不开，避免泄漏内部 Chromium DevTools。
// 关掉方式：GITEA_KANBAN_DISABLE_REMOTE_DEBUG=1
if (!app.isPackaged && process.env['GITEA_KANBAN_DISABLE_REMOTE_DEBUG'] !== '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9492');
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  logger.info({ port: 9492 }, 'electron remote debugging enabled (dev only)');
}

// ===== 1. 单实例锁（必须在 app.whenReady 之前） =====
const gotLock = app.requestSingleInstanceLock({
  name: APP_SINGLE_INSTANCE_LOCK_NAME,
  appName: APP_NAME,
});

if (!gotLock) {
  // 第二实例：直接退出
  logger.warn('another instance is running, exiting');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // 第二实例启动时：激活已有窗口
  logger.info('second instance detected, focusing main window');
  createMainWindow();
});

// ===== 2. 生命周期 =====
app.on('ready', async () => {
  try {
    upgradeLoggerToFile();
    logger.info({ version: app.getVersion(), isPackaged: app.isPackaged }, 'app ready');

    // 2a. 初始化 sqlite（创建 $GITEA_KANBAN_DATA_DIR/kanban.db 或 ~/.gitea-kanban/kanban.db + 跑迁移，详见 AGENTS §8.15）
    await initSqlite();
    logger.info('sqlite initialized');

    // 2b. 注册 IPC
    registerAllIpcHandlers();
    logger.info('IPC handlers registered');

    // 2c. 创建主窗口
    createMainWindow();
  } catch (err) {
    logger.fatal({ err }, 'failed during app ready');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS 重新激活（createMainWindow 自带 idempotent 逻辑：已存在则返回）
  if (app.isReady()) {
    createMainWindow();
  }
});

app.on('before-quit', () => {
  logger.info('app quitting');
  unregisterAllIpcHandlers();
  destroyMainWindow();
  closeSqlite();
});

// 未捕获异常 → 日志
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  // 不立刻退出；让 pino 落盘后由 OS 决定
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandledRejection');
});
