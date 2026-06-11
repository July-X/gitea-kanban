/**
 * BrowserWindow 管理（单实例主窗）
 *
 * 安全配置（AGENTS.md §4.7 / 02-architecture.md §9.3）：
 * - contextIsolation: true（默认；显式写死）
 * - nodeIntegration: false（默认；显式写死）
 * - sandbox: true（默认；显式写死）
 * - CSP header 通过 webRequest.onHeadersReceived 注入（**不**接 user-supplied URL，避免任意跳转）
 *
 * v1 单窗；v2 考虑多窗（设置窗 / 通知窗）
 */

import { app, BrowserWindow, shell, session } from 'electron';
import { join } from 'node:path';
import { logger } from './logger.js';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * 在 default session 注入 CSP header（AGENTS.md §4.7 模板）
 *
 * - default-src 'self'：默认只允许同源
 * - script-src 'self'：禁止内联 script（Vue 编译产物在 'self' 内 OK）
 * - style-src 'self' 'unsafe-inline'：允许 CSS-in-JS / 内联 style
 * - connect-src 'self' <gitea URL>：XHR/fetch 只允许同源 + gitea 实例
 * - img-src 'self' data: https: <gitea URL>：图片允许 base64 + 任何 https + gitea 头像
 *   （2026-06-11 修复：之前只写 https:，本地 gitea http://localhost:3000 头像被拦）
 *
 * 2026-06-11 修复 CSP 重装：cspInstalled 守卫**只**挡重复 webRequest 注册；
 * 真正的 CSP 拼接每次按 giteaUrl 重算（auth connect 后**重新设置**响应头）。
 * 实现：先 removeListener 旧的再重新注册（用 onHeadersReceived 返回的 listener 句柄）。
 */
let cspListener:
  | ((
      details: Electron.OnHeadersReceivedListenerDetails,
      callback: (response: Electron.HeadersReceivedResponse) => void,
    ) => void)
  | null = null;

export function installCspHeader(giteaUrl: string | null = null): void {
  const connectSrc = giteaUrl ? `'self' ${giteaUrl}` : "'self'";
  // img-src：保留 https: 通配（公网 https 头像 / oauth provider logo）+ 加 giteaUrl（http://localhost:3000 等）
  const imgSrc = giteaUrl ? `'self' data: https: ${giteaUrl}` : "'self' data: https:";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    `img-src ${imgSrc}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  // 如果之前注册过 listener，先摘掉（重装支持 giteaUrl 变化）
  if (cspListener) {
    // Electron 41 把 removeListener 改名为 off()；先 off 再重新 onHeadersReceived
    (session.defaultSession.webRequest.onHeadersReceived as unknown as { off: (l: unknown) => void }).off(cspListener);
  }

  cspListener = (details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  };
  session.defaultSession.webRequest.onHeadersReceived(cspListener);
  logger.info({ csp }, 'CSP header installed');
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  // 安装 CSP（首次创建 window 时；giteaUrl 由 auth connect 后调用 installCspHeader 重装）
  installCspHeader();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false, // 加载完再 show，避免白屏
    backgroundColor: '#1a1a1a', // 与设计系统暗色主题 bg 一致
    title: 'gitea-kanban',
    webPreferences: {
      // === 安全铁律（AGENTS.md §4.7） ===
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // preload 脚本（IPC bridge 唯一通道）
      // 产物名 `.cjs` —— 配合 electron.vite.config.ts 的 `output.format: 'cjs'`
      // sandboxed preload 必须 CJS bundle（V8 加载 .mjs 强制 module 模式，
      // 与 sandboxed preload 的 classic-script 上下文不兼容；详见
      // electron.vite.config.ts 注释 + AGENTS.md §8）
      preload: join(__dirname, '../preload/index.cjs'),
      // 关闭 webSecurity 会放开 CORS；这里**不**关
      webSecurity: true,
    },
  });

  // 加载 renderer
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    logger.info({ devUrl }, 'loading renderer from dev server');
    mainWindow.loadURL(devUrl);
  } else {
    const indexPath = join(__dirname, '../renderer/index.html');
    logger.info({ indexPath }, 'loading renderer from file');
    mainWindow.loadFile(indexPath);
  }

  // 加载完成再 show（避免白屏闪烁）
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 拦截外链（避免任意 URL 跳转，02-architecture.md §9.3）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logger.info({ url }, 'window.open intercepted');
    // 外部链接走系统浏览器
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 拦截导航（同上）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (isDev && devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    logger.info({ url }, 'navigation intercepted');
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  logger.info('main window created');
  return mainWindow;
}

export function destroyMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  mainWindow = null;
}
