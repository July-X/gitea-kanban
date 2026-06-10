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
