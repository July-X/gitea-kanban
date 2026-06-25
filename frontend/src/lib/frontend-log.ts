/**
 * frontend-log —— 前端日志统一入口（写 Go 后端 slog → 文件）
 *
 * 设计动机：
 *   - 旧版前端 console.error / toast.error 只在 DevTools 看，用户反馈问题时信息丢失
 *   - 现在前端所有 warn / error 级别的事件都通过 Wails IPC 走 Go 端
 *     → 写入 ${dataDir}/logs/main/main.log（与 Go 端日志同一份文件）
 *   - 用户反馈问题时：打开应用数据目录 → tail main.log → 一目了然
 *
 * 使用：
 *   import { logWarn, logError, logInfo } from '@renderer/lib/frontend-log';
 *   logWarn('toast', 'GitHub 返 406', JSON.stringify(detail));
 *
 * 调用约定：
 *   - 全部 fire-and-forget（不 await,不抛错）
 *   - Wails binding 还没注入（极早启动期 / 单测环境）时静默降级到 console
 *   - description 最大 1024 字符（与 Go 端截断对齐）
 *
 * 不做的事：
 *   - 不替代 console.warn / console.error：仍然打到 DevTools（开发期排错用）
 *   - 不持久化到 localStorage（避免爆用户磁盘）
 *   - 不暴露 token / cookie / 任意敏感字段（调用方自己负责）
 */

// 类型与 Go 端 LogFrontendArgs 对齐
// Wails 自动生成的 TS 类型在 frontend/wailsjs/wailsjs/go/main/App.d.ts
// 这里手动写一份最小类型,避免 TS 编译顺序依赖 wails 还没跑过

export type FrontendLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface FrontendLogArgs {
  level: FrontendLogLevel;
  message: string;
  description?: string;
  source: string;
}

/**
 * 调用 window.go.main.App.LogFrontend 的最小化封装
 *
 * - 未注入(单测 / 极早启动期)→ 走 console
 * - 注入但调用失败(IPC 异常)→ 静默降级到 console（不抛 unhandledrejection 死循环）
 * - description 截断到 1024 字符（与 Go 端一致）
 */
function send(args: FrontendLogArgs): void {
  const desc = args.description && args.description.length > 1024
    ? args.description.slice(0, 1024) + '...(truncated)'
    : args.description;

  // Wails binding 注入到 window.go.main.App.*；不依赖 shim,
  // 因为前端日志需求更紧迫——binding 还没就绪也能降级
  const wailsApp = (window as unknown as {
    go?: { main?: { App?: { LogFrontend?: (a: FrontendLogArgs) => Promise<unknown> } } };
  }).go?.main?.App;

  if (wailsApp?.LogFrontend) {
    // fire-and-forget:不 await,不 catch 抛错
    // 失败时落到 console（开发期仍能看）
    wailsApp.LogFrontend({
      level: args.level,
      message: args.message,
      description: desc,
      source: args.source,
    }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[frontend-log] LogFrontend failed:', err);
    });
    return;
  }

  // 降级:Wails binding 还没注入(单测 / SSR / 极早启动)
  // eslint-disable-next-line no-console
  const fallback = args.level === 'error'
    ? console.error
    : args.level === 'warn'
      ? console.warn
      : console.log;
  fallback(`[${args.source}] ${args.message}`, desc ?? '');
}

export function logDebug(source: string, message: string, description?: string): void {
  send({ level: 'debug', message, source, ...(description !== undefined ? { description } : {}) });
}

export function logInfo(source: string, message: string, description?: string): void {
  send({ level: 'info', message, source, ...(description !== undefined ? { description } : {}) });
}

export function logWarn(source: string, message: string, description?: string): void {
  send({ level: 'warn', message, source, ...(description !== undefined ? { description } : {}) });
}

export function logError(source: string, message: string, description?: string): void {
  send({ level: 'error', message, source, ...(description !== undefined ? { description } : {}) });
}