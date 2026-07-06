/**
 * 渲染端入口（Vue 3 + Pinia + Vue Router 4）
 *
 * 技术栈定型（AGENTS §2.2 + AGENTS §5.2 frontend agent（Vue 3 + Pinia + Vue Router））：
 *   - Vue 3 + Composition API + <script setup>
 *   - Pinia 状态管理（不用 Vuex / Redux）
 *   - Vue Router 4（createWebHashHistory 适配 Wails file://）
 *   - 全部走 ESM 导入（type: module）
 *
 * 全局错误处理（slate 文件 transport + OVERRIDE §本项目专属规则 #3 错误人话）：
 *   - app.config.errorHandler 捕获组件内未处理错误 → Go 端 slog + Toast 提示
 *   - window.onerror 捕获全局 JS 异常（异步、未捕获 promise）
 *   - window.onunhandledrejection 捕获未处理 Promise reject
 *
 * 不做的事：
 *   - 不引 pinia-plugin-persistedstate（AGENTS §2.2 拍板时未列，user_decision 未拍）
 *   - 不引 Vue DevTools（v0.3.0 仍不需要）
 *   - 不引国际化 i18n（v0.3.0 单 zh-Hans，文案硬编码）
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './routes';
import { mountCommandPalette } from './lib/command-palette';
import { useUiStore } from './stores/ui';
import { showToast } from './lib/toast';
import { logError, logWarn } from './lib/frontend-log';

// Wails 注入 window.api shim（替代 v1 Electron 时代的 preload bridge）
// 必须在 createApp / 任何 store 调用前执行（ipc-client 依赖 window.api）
import { installApiShim } from './lib/wails-api-shim';
installApiShim();

// 全局样式（字体声明 + reset + 主题变量）
import './styles/fonts.css';
import './styles/reset.css';
import './styles/theme.css';

// ===== Dev 模式注解插件（v1.1.3 · task #42）=====
//
// 给所有 v-dev-annotate 元素加 `!` 按钮 + 点击 popover 说明数据来源。
// 条件挂载：import.meta.env.DEV 被 Vite 编译期替换为字面量 false，
// `app.use(devAnnotate)` 整段变死代码被 rollup 摇掉。dev-annotate 模块
// 本身仍被 import（sync，v-dev-annotate 指令需要在 mount 前注册），
// 但 install 之外的代码（ref/computed）也很轻，整体 ~2KB 增量。
import { devAnnotate } from './lib/dev-annotate';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

if (import.meta.env.DEV) {
  app.use(devAnnotate);
}

// ===== 全局错误处理 =====
//
// 设计:所有错误源都走两路
//   1. console.error / showToast:开发者 / 用户当下看得到
//   2. logError:走 Go 端 slog → ${dataDir}/logs/main/main.log → 反馈问题时留痕
// (showToast 内已对 warn / error 调 logWarn / logError,所以 errorHandler 触发
//  的 toast 会自动写日志;但我们这里也直接 logError 一次,留原始 info / stack 信息,
//  避免 toast description 只剩 messageText 缺上下文)

/**
 * 组件内未捕获错误（如 setup 抛错、render 抛错）
 * 注意：此 handler **不**返回 fallback UI，只是把错误展示出去；
 * 路由级 fallback / ErrorBoundary 在 v1 暂不做（M1 再补）
 */
app.config.errorHandler = (err, _instance, info) => {
  // eslint-disable-next-line no-console -- 渲染端 console 兜底（开发期可看）
  console.error('[gitea-kanban] 组件错误：', err, '\n触发位置：', info);
  const errMsg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // 文件日志（带 stack / 触发位置,排错关键信息）
  logError(
    'vue.errorHandler',
    errMsg,
    stack ? `info=${info}\nstack=${stack}` : `info=${info}`,
  );
  // toast 是 lib（不是 SFC），直接 static import；之前的 dynamic import 是历史误判 + 触发 vite dynamic+static warning
  showToast({
    type: 'error',
    message: '界面出错了',
    description: errMsg,
    duration: 5000,
  });
};

/** 同步 JS 异常兜底（不在 Vue 树里的代码） */
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[gitea-kanban] window error：', e.error ?? e.message);
  const err = e.error ?? e.message;
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logError(
    'window.error',
    msg,
    [
      `filename=${e.filename ?? ''}`,
      `lineno=${e.lineno ?? ''}`,
      `colno=${e.colno ?? ''}`,
      stack ? `stack=${stack}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
});

/** 未处理的 Promise reject（如 IPC 调用没人 await） */
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[gitea-kanban] unhandled rejection：', e.reason);
  const reason = e.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logError('window.unhandledrejection', msg, stack ?? `reason=${String(reason)}`);
  e.preventDefault(); // 阻止默认控制台报错
});

/**
 * 全局 console.error 拦截 —— 把所有 console.error 调用也写文件
 *
 * 触发场景:库代码 / 第三方组件 / 业务代码自己 console.error
 * 不影响开发期 DevTools 看(走原 console.error),只是再写一份到文件
 *
 * 注意:
 * 1. 不要覆盖 console.error 本身——会让上面的 console.error + Vue errorHandler
 *    都失效。这里改的是 console.error 的引用,让它调原 console.error + 再调 logError
 * 2. logError → send() 内部会用 window.__originalConsoleError（避开此 patch），
 *    防止"logError → console.error → logError"死循环导致 main thread 锁死、UI 冻屏
 *    （v2.5 复现：刷新按钮 → IPC 401 → unhandledrejection → console.error → logError →
 *     send → console.error → ... 164MB 日志无限增长、UI 卡死）
 * 3. v0.7.4 性能优化：日志序列化移出主线程同步路径。
 *    旧版在 monkey-patch 里同步 JSON.stringify(args)，对象大或循环引用时主线程卡顿。
 *    新版只做轻量字符串提取（字符串直拼/Error 取 message），复杂对象只传引用给 logError；
 *    logError 内部走异步批量写入，不再阻塞主线程交互。
 *
 * 顺序：先保存原始引用到 window，再做 monkey-patch。如果顺序反了 patch 又会用上被替换的。
 */
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleLog = console.log.bind(console);
const originalConsoleDebug = console.debug.bind(console);
// 挂到 window 给 frontend-log.ts 用（避开本 patch 的死循环）
(window as unknown as {
  __originalConsoleError: typeof originalConsoleError;
  __originalConsoleWarn: typeof originalConsoleWarn;
  __originalConsoleLog: typeof originalConsoleLog;
  __originalConsoleDebug: typeof originalConsoleDebug;
}).__originalConsoleError = originalConsoleError;
(window as unknown as { __originalConsoleWarn: typeof originalConsoleWarn }).__originalConsoleWarn =
  originalConsoleWarn;
(window as unknown as { __originalConsoleLog: typeof originalConsoleLog }).__originalConsoleLog =
  originalConsoleLog;
(window as unknown as { __originalConsoleDebug: typeof originalConsoleDebug }).__originalConsoleDebug =
  originalConsoleDebug;

/**
 * v0.7.4：轻量字符串提取 —— 只处理基础类型，复杂对象保留引用传给 logError。
 * 避免同步 JSON.stringify 阻塞主线程（尤其 Error 对象含大 stack/stringify 失败时）。
 */
function fastSerialize(a: unknown): string {
  if (a === null || a === undefined) return String(a);
  if (a instanceof Error) return a.message;
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean') return String(a);
  // 其他复杂类型：轻量信息，避免 JSON.stringify 大对象
  try {
    const s = typeof a === 'object' ? `[object ${a?.constructor?.name ?? 'Object'}]` : String(a);
    return s;
  } catch {
    return String(a);
  }
}

console.error = (...args: unknown[]) => {
  originalConsoleError(...args);
  try {
    const msg = args.map(fastSerialize).join(' ');
    logError('console.error', msg);
  } catch {
    // 静默:拦截器本身不能抛
  }
};

// console.warn 拦截 —— 与 console.error 完全对称（level=warn, source='console.warn'）
// 触发场景:库代码 / 第三库组件 / 业务代码自己 console.warn（"deprecated"、"fallback to X"等）
console.warn = (...args: unknown[]) => {
  originalConsoleWarn(...args);
  try {
    const msg = args.map(fastSerialize).join(' ');
    logWarn('console.warn', msg);
  } catch {
    // 静默:拦截器本身不能抛
  }
};

app.mount('#app');

// v1.2 主题切换入口 3：注册全局 ⌘K / Ctrl+K 快捷键 + 注入 dialog DOM
// 必须在 app.use(pinia) 之后调（useUiStore 依赖 active pinia）
// —— task spec §4 明确：本任务范畴
mountCommandPalette();

// ===== 主题启动 reconcile（v1.2 theme-init task · tech-refine §15.5） =====
//
// 启动期时序（避免 0 闪烁）：
// 1. index.html head inline script（同步，parse-time）—— 在 <script type="module"> 之前执行
//    → 读 localStorage 'gitea-kanban.theme' → 设 dataset.theme
//    → CSS 在 0ms 时即拿到正确主题 token
// 2. vite ESM fetch main.ts（异步，~100-300ms） → createApp → mount
//    → 此时 CSS 已应用 localStorage 主题，无白屏闪
//    · ESM 抽到外部 .ts 文件的方案不可行：fetch 是异步的，会闪
// 3. mount 后调 useUiStore().initTheme()（不阻塞 UI）
//    → store 同步再设一次 dataset.theme（防御：index.html inline 被 CSP 拦时兜底）
//    → 异步 fetch preferences.theme.get → 不一致时 applyTheme 覆盖
//    → 与后端 sqlite prefs 表 reconcile（source of truth）
//
// void 显式忽略 Promise：失败时 store 已静默兜底（initTheme 不抛），toast 也不弹
// （启动期"主题加载失败"会让用户感觉系统坏了 —— 设计拍板保持静默）
void useUiStore().initTheme();

// v1.1.3：mount 后调 useUiStore().initNavrail()（不阻塞 UI）
//   - 同步读 localStorage 'gitea-kanban.navCollapsed' → 立即设 navCollapsed
//   - 异步 IPC user.prefs.get → reconcile（跟主题同模式）
void useUiStore().initNavrail();
