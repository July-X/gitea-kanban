/**
 * 渲染端入口（Vue 3 + Pinia + Vue Router 4）
 *
 * 技术栈定型（AGENTS §2.2 + 03-frontend §6.1）：
 *   - Vue 3 + Composition API + <script setup>
 *   - Pinia 状态管理（不用 Vuex / Redux）
 *   - Vue Router 4（createWebHashHistory 适配 Electron file://）
 *   - 全部走 ESM 导入（type: module）
 *
 * 全局错误处理（AGENTS §4.5 日志 + OVERRIDE §本项目专属规则 #3 错误人话）：
 *   - app.config.errorHandler 捕获组件内未处理错误 → pino 日志 + Toast 提示
 *   - window.onerror 捕获全局 JS 异常（异步、未捕获 promise）
 *   - window.onunhandledrejection 捕获未处理 Promise reject
 *
 * 不做的事：
 *   - 不引 pinia-plugin-persistedstate（AGENTS §2.2 拍板时未列，user_decision 未拍）
 *   - 不引 Vue DevTools（v1 不需要）
 *   - 不引国际化 i18n（v1 单 zh-Hans，文案硬编码）
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './routes';
import { mountCommandPalette } from './lib/command-palette';
import { useUiStore } from './stores/ui';

// 全局样式（reset + 主题变量）
import './styles/reset.css';
import './styles/theme.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// ===== 全局错误处理 =====

/**
 * 组件内未捕获错误（如 setup 抛错、render 抛错）
 * 注意：此 handler **不**返回 fallback UI，只是把错误展示出去；
 * 路由级 fallback / ErrorBoundary 在 v1 暂不做（M1 再补）
 */
app.config.errorHandler = (err, _instance, info) => {
  // eslint-disable-next-line no-console -- 渲染端 console 兜底（开发期可看）
  console.error('[gitea-kanban] 组件错误：', err, '\n触发位置：', info);
  // 从 lib/toast.ts 拿 showToast（不用 import SFC,因为 SFC 顶层变量是组件实例）
  void import('./lib/toast').then(({ showToast }) => {
    showToast({
      type: 'error',
      message: '界面出错了',
      description: err instanceof Error ? err.message : String(err),
      duration: 5000,
    });
  });
};

/** 同步 JS 异常兜底（不在 Vue 树里的代码） */
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[gitea-kanban] window error：', e.error ?? e.message);
});

/** 未处理的 Promise reject（如 IPC 调用没人 await） */
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[gitea-kanban] unhandled rejection：', e.reason);
  e.preventDefault(); // 阻止默认控制台报错
});

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
