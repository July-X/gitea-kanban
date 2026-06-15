/**
 * 应用入口：生命周期 + 单实例锁 + IPC 注册
 *
 * 不在这里写业务逻辑（业务在 ipc/* / gitea/* / cache/* 各模块）。
 * 启动顺序：
 *   1. app.requestSingleInstanceLock() —— 第二实例进 IPC 给已有实例
 *   2. app.whenReady() 之后：
 *      a. 升级 logger 到 file transport
 *      b. 初始化 localStore（state.json）+ SyncRunner
 *      c. 注册所有 IPC handler
 *      d. 创建主窗口
 *   3. 监听 window-all-closed（macOS 保留 dock）
 *   4. 监听 activate（macOS 重开窗口）
 */

import { app } from 'electron';
// (touch v3)
import { logger, upgradeLoggerToFile } from './logger.js';
import { createMainWindow, destroyMainWindow, installCspHeader } from './window.js';
import { registerAllIpcHandlers, unregisterAllIpcHandlers } from './ipc/index.js';
import { initLocalStore, closeLocalStore } from './local/state.js';
import { authStatus } from './gitea/auth.js';
import { getSyncRunner } from './sync/runner.js';
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

// ===== 0b. dev only 禁用 Chromium 子进程 sandbox =====
// 2026-06-12 修复：macOS dev 模式没签名 sandbox helper process 启动会报
//   "Failed to initialize sandbox: Operation not permitted"
// → GPU/network service chain crash → Electron 主进程死
// dev 临时关掉（AGENTS §4.7 安全边界：prod 必须 sandbox: true）
if (!app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
  logger.info('chromium sandbox disabled (dev only)');
}

// ===== 0c. dev only 改 userData 目录 =====
// 2026-06-12 修复：Electron 在 macOS userData 路径
//   ~/Library/Application Support/gitea-kanban/ 在 SIP / TCC 受限
// DevToolsActivePort / SingletonLock / Cache 等写不进去 → Electron 退出
// dev 临时改到 /tmp/gitea-kanban-dev（prod 不动：仍走 macOS 标准 userData）
if (!app.isPackaged) {
  app.setPath('userData', '/tmp/gitea-kanban-dev');
  logger.info('userData moved to /tmp/gitea-kanban-dev (dev only)');
}

// ===== 1. 单实例锁（必须在 app.whenReady 之前） =====
// dev 模式跳过单实例锁（dev 启动频繁 + Electron 41 在 macOS sandbox 限制 userData
// 写入导致 SingletonLock 创建失败 → 直接退出；prod 必须保留）
const skipSingleton = !app.isPackaged && process.env['GITEA_KANBAN_SKIP_SINGLETON'] !== '0';
const gotLock = skipSingleton ? true : app.requestSingleInstanceLock({
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
    logger.info('app ready (before upgradeLoggerToFile)');
    upgradeLoggerToFile();
    logger.info({ version: app.getVersion(), isPackaged: app.isPackaged }, 'app ready');

    // 2a. 初始化 localStore（ADR-0003：localStore 是唯一 source of truth，业务态全在此）
    logger.info('initLocalStore start');
    await initLocalStore();
    logger.info('localStore initialized');

    // 2a-bis. Gitea 缓存层启动期 LRU GC（file-store.ts，按 mtime 删到 50MB 预算内）
    //   纯文件系统操作，无 DB 依赖；放 localStore 之后、IPC 之前
    // import 在调用处按需（避免冷启开销）
    const { gcCache } = await import('./cache/file-store.js');
    gcCache();
    logger.info('cache gc done');

    // 2b. 注册 IPC
    logger.info('registerAllIpcHandlers start');
    registerAllIpcHandlers();
    logger.info('IPC handlers registered');

    // 2b-bis. 启动 SyncRunner（ADR-0003 Phase 3）
    //   启动期自动 loadQueue 恢复 + 跑一次（处理上次崩留下的 pending）
    logger.info('SyncRunner start');
    await getSyncRunner().start();
    logger.info('SyncRunner started');

    // 2c. 创建主窗口
    logger.info('createMainWindow start');
    createMainWindow();
    logger.info('createMainWindow done');

    // 2d. restore 路径补 CSP：已存账号但本次启动不会走 AUTH_CONNECT IPC →
    // createMainWindow 内的 installCspHeader(null) 会让 img-src 缺 gitea origin
    // → 头像 / connect 直连被拦。这里按活跃账号补一次重装；细节见
    // src/main/window.ts expandLoopbackOrigins + src/main/ipc/auth.ts AUTH_CONNECT。
    // 内层 try：失败只 warn，不让 boot 失败（auth 表读不出来也能进无账号空状态）。
    try {
      const status = await authStatus();
      const active = status.accounts[0];
      if (active) {
        installCspHeader(active.giteaUrl);
        logger.info({ giteaUrl: active.giteaUrl }, 'CSP reinstalled for restored account');
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'CSP reinstall on boot failed (non-fatal)',
      );
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 'failed during app ready');
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
  // closeLocalStore 保证 last write 落盘；SyncRunner stop 保证 queue 状态持久化
  void closeLocalStore().then(() => getSyncRunner().stop());
});

// 未捕获异常 → 静默兜底（不调 logger.fatal — logger 可能已坏：SonicBoom fd=-1 会循环 RangeError）
process.on('uncaughtException', (err) => {
  void err;
});
process.on('unhandledRejection', (reason) => {
  void reason;
});
