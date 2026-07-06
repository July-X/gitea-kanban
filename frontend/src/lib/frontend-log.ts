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
 * - 未注入(单测 / 极早启动期)→ 走 console（用原始 console.error，避免 main.ts monkey-patch 死循环）
 * - 注入但调用失败(IPC 异常)→ 静默降级到 console（不抛 unhandledrejection 死循环）
 * - description 截断到 1024 字符（与 Go 端一致）
 *
 * v2.x 增强:每次 send() 都在 DevTools 打一条 console 记录（带 [frontend-log] 前缀）
 * 这样开发期 / 反馈问题期用户能立刻确认 "send() 被调了",
 * 排错"日志没出现"时区分是 send() 没被调,还是 IPC 链路断。
 *
 * v2.5 修复:DevTools 打 console 必须走原始 console.error（window.__originalConsoleError），
 * 否则会被 main.ts 的 monkey-patch 拦截 → logError → send() → 死循环，
 * 把 main thread 锁死、UI 冻屏、frontend-log 文件无限膨胀到 GB 级
 * （v2.5 实测：刷新仓库按钮 IPC 失败 → 164MB 日志，几秒内卡死 UI）。
 */
type OriginalConsole = {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

function getOriginalConsole(): OriginalConsole {
  const w = window as unknown as {
    __originalConsoleError?: (...args: unknown[]) => void;
    __originalConsoleWarn?: (...args: unknown[]) => void;
    __originalConsoleLog?: (...args: unknown[]) => void;
    __originalConsoleDebug?: (...args: unknown[]) => void;
  };
  return {
    error: w.__originalConsoleError ?? console.error.bind(console),
    warn: w.__originalConsoleWarn ?? console.warn.bind(console),
    log: w.__originalConsoleLog ?? console.log.bind(console),
    debug: w.__originalConsoleDebug ?? console.debug.bind(console),
  };
}

function send(args: FrontendLogArgs): void {
  const desc = args.description && args.description.length > 1024
    ? args.description.slice(0, 1024) + '...(truncated)'
    : args.description;

  // 始终在 DevTools 打一条记录（用原始 console.* 避开 main.ts monkey-patch 死循环）
  const oc = getOriginalConsole();
  const consoleFn = args.level === 'error'
    ? oc.error
    : args.level === 'warn'
      ? oc.warn
      : args.level === 'debug'
        ? oc.debug
        : oc.log;
  consoleFn(
    `[frontend-log] ${args.level.toUpperCase()} src=${args.source} msg=${args.message}`,
    desc ?? '',
  );

  // Wails binding 注入到 window.go.main.App.*；不依赖 shim,
  // 因为前端日志需求更紧迫——binding 还没就绪也能降级
  const wailsApp = (window as unknown as {
    go?: { main?: { App?: { LogFrontend?: (a: FrontendLogArgs) => Promise<unknown> } } };
  }).go?.main?.App;

  if (wailsApp?.LogFrontend) {
    // fire-and-forget:不 await,不 catch 抛错
    // 失败时落到 console（开发期仍能看,上面的 consoleFn 已经先打过一次）
    wailsApp.LogFrontend({
      level: args.level,
      message: args.message,
      description: desc,
      source: args.source,
    }).catch((err: unknown) => {
      // 用原始 console.error 避免 patch 死循环
      oc.error('[frontend-log] LogFrontend IPC failed:', err);
    });
    return;
  }

  // 降级:Wails binding 还没注入(单测 / SSR / 极早启动)
  // 这种情况 consoleFn 已经打过,前端能看到
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