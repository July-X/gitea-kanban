/**
 * 路由表（Vue Router 4）
 *
 * 设计（03-frontend.md §7 + AGENTS §5.5）：
 *   - 4 个一级路由：/、/auth、/board、/timeline
 *   - 根路径 / 重定向到 /auth（未连接时合理入口）
 *   - 用 createWebHashHistory 适配 Electron file:// 协议
 *   - 懒加载（动态 import）减小首屏 bundle
 *   - 全局守卫：未连接 + 进 /board 或 /timeline → 跳 /auth
 *
 * 命名空间提醒（AGENTS §5.5 + §6）：
 *   channel 命名 = `<namespace>.<method>`（如 repos.list / board.columns.list），
 *   **不**用资源:动作风格
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@renderer/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/board',
  },
  {
    path: '/auth',
    name: 'auth',
    component: () => import('@renderer/views/AuthView.vue'),
    meta: { title: '连接 gitea' },
  },
  {
    path: '/board',
    name: 'board',
    component: () => import('@renderer/views/BoardView.vue'),
    meta: { title: '看板', requiresAuth: true },
  },
  {
    path: '/timeline',
    name: 'timeline',
    component: () => import('@renderer/views/TimelineView.vue'),
    meta: { title: '时间轴', requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/SettingsView.vue'),
    meta: { title: '设置', requiresAuth: true },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/board',
  },
];

export const router = createRouter({
  history: createWebHashHistory(), // hash 模式适配 Electron file://
  routes,
});

/**
 * 全局守卫：未连接时强制进 /auth
 * 已经在 /auth 时不重定向（避免死循环）
 */
router.beforeEach(async (to) => {
  if (to.meta.requiresAuth) {
    const auth = useAuthStore();
    if (!auth.isConnected) {
      // 首次进入尝试拉一次状态（避免 main 端已接好但 store 还没 hydrate）
      if (auth.accounts.length === 0 && !auth.loading) {
        try {
          await auth.refreshStatus();
        } catch {
          /* 失败由 auth.error 处理 */
        }
      }
      if (!auth.isConnected) {
        return { name: 'auth', query: { from: to.fullPath } };
      }
    }
  }
  return true;
});

/** 路由 title 同步到 document.title */
router.afterEach((to) => {
  const base = 'gitea-kanban';
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title ? `${title} · ${base}` : base;
});
