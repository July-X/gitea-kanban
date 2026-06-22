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

// === dev only：远程调试端口 + 跨域 allowlist ===
// AGENTS §4.7 安全边界：仅 dev 启用；prod 严禁（任意 JS 注入风险）。
// 用途：chrome-devtools-mcp 用 --browser-url=http://127.0.0.1:9492 attach Renderer 调试
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9492');
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * 在 default session 注入 CSP header（AGENTS.md §4.7 模板）
 *
 * - default-src 'self'：默认只允许同源
 * - script-src 'self' <theme-hash>：禁止任意 inline，但白名单 index.html 唯一一段
 *   theme bootstrap inline（v1.1.2 启动期 0 闪烁硬约束）的 sha256
 * - style-src 'self' 'unsafe-inline'：允许 CSS-in-JS / 内联 style
 * - connect-src 'self' <gitea origins>：XHR/fetch 只允许同源 + gitea 实例（含 loopback pair）
 * - img-src 'self' data: https: <gitea origins>：图片允许 base64 + 任何 https + gitea 头像
 *   （2026-06-11 修复：之前只写 https:，本地 gitea http://localhost:3000 头像被拦）
 *   （2026-06-12 修复：再展开 loopback pair —— Gitea ROOT_URL=127.0.0.1 但 app 存 localhost
 *     时 origin 不等 → avatar 被拦；见 expandLoopbackOrigins 注释）
 *
 * 2026-06-11 修复 CSP 重装：cspInstalled 守卫**只**挡重复 webRequest 注册；
 * 真正的 CSP 拼接每次按 giteaUrl 重算（auth connect 后**重新设置**响应头）。
 *
 * 2026-06-20 修复 Electron 41 webRequest 重装：onHeadersReceived 不是 EventEmitter，
 * 没有 removeListener/off；清理旧 listener 必须调用 onHeadersReceived(null)，否则首次
 * installCspHeader(null) 的 img-src 会一直生效，后续 Gitea 头像仍被旧 CSP 拦。
 */
let cspInstalled = false;

/**
 * 主题 bootstrap inline script 的 SHA-256（对应 src/renderer/index.html line 49-58）。
 *
 * 那段 inline script 是项目**唯一**一处 inline（v1.1.2 启动期 0 闪烁硬约束，
 * 见 index.html 顶部注释），CSP 用 hash 而不是 `'unsafe-inline'`，攻击面最小。
 *
 * ⚠️ 修改 index.html 那段（包括缩进 / 注释 / 换行）后此 hash 必须同步更新，
 *    否则 dev/prod 都会被 webRequest CSP 拦掉 → 报
 *    "Executing inline script violates the following Content Security Policy directive 'script-src 'self''"
 *
 * 重算（与 Chromium 报错日志里的 sha256-xxx 一致）：
 *   1) 浏览器 DevTools console 触发后从错误里直接复制
 *   2) 或：node -e 'crypto.createHash("sha256").update(<script-text>,"utf8").digest("base64")'
 */
const THEME_BOOTSTRAP_SCRIPT_HASH = "'sha256-rMbhPi4NswJ523U4ASP2f+qLN64S5J0P/JJN5QKCkp4='";

/**
 * 把 giteaUrl 展开为 loopback origin 对（localhost ↔ 127.0.0.1）。
 *
 * Gitea 实例 `[server] ROOT_URL` 决定它**返回**的 avatar_url host —— 与用户在 app
 * 里填的 giteaUrl 经常不一致：用户填 `http://localhost:3000`、ROOT_URL 配
 * `http://127.0.0.1:3000` → /user.avatar_url 是 127.0.0.1:3000 → CSP origin
 * mismatch → 头像被 `img-src` 拦（dump：`http://127.0.0.1:3000/avatars/...
 * violates "img-src 'self' data: https:"`）。
 *
 * 解法：host 是 loopback 时把另一个变体也加进 allowlist。非 loopback host 原样返回。
 * `URL.origin` 自动去掉 path/query/fragment（CSP 只看 scheme+host+port）。
 */
function expandLoopbackOrigins(rawUrl: string): string[] {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      const pair = new URL(rawUrl);
      pair.hostname = host === 'localhost' ? '127.0.0.1' : 'localhost';
      return [u.origin, pair.origin];
    }
    return [u.origin];
  } catch {
    // 解析失败 → 退回原字符串（authConnect 调用前已 zod URL 校验，这里几乎不会进）
    return [rawUrl];
  }
}

export function installCspHeader(giteaUrl: string | null = null): void {
  const giteaOrigins = giteaUrl ? expandLoopbackOrigins(giteaUrl) : [];
  const giteaOriginList = giteaOrigins.join(' ');
  const connectSrc = giteaOrigins.length ? `'self' ${giteaOriginList}` : "'self'";
  // img-src：保留 https: 通配（公网 https 头像 / oauth provider logo）+ 加 gitea origins
  const imgSrc = giteaOrigins.length
    ? `'self' data: https: ${giteaOriginList}`
    : "'self' data: https:";
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${THEME_BOOTSTRAP_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    `img-src ${imgSrc}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  // 如果之前注册过 listener，先摘掉（重装支持 giteaUrl 变化）。
  // Electron 41 的 webRequest.onHeadersReceived 不是 EventEmitter，不能 removeListener/off；
  // 官方签名用 null 清理旧 listener，再注册新 listener。
  if (cspInstalled) {
    session.defaultSession.webRequest.onHeadersReceived(null);
  }

  const cspListener = (
    details: Electron.OnHeadersReceivedListenerDetails,
    cb: (response: Electron.HeadersReceivedResponse) => void,
  ) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  };
  session.defaultSession.webRequest.onHeadersReceived(cspListener);
  cspInstalled = true;
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
      // contextIsolation / nodeIntegration 始终写死；sandbox 仅 prod 启用
      // （dev 模式 macOS 没签名 sandbox 启动会报 "Operation not permitted" → GPU/network 链式 crash）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !isDev,
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
