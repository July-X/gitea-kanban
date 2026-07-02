/**
 * 路由表（Vue Router 4）
 *
 * v2.0 沿用 v1 设计 + Wails hash router：
 *   - 7 个一级路由：/、/auth、/board、/timeline、/merges、/my-cards、/members、/settings
 *   - v1.4 拍板：加 /team 占位路由（v2 团队视图落地前，**不**挂 NavRail 入口）
 *     · 详见 ADR-0004（docs/adr/0004-single-repository-focus.md）
 *     · view 走 TeamView.vue 占位，仅保留路由，**不**进 store / IPC
 *   - 根路径 / 重定向到 /auth（未连接时合理入口）
 *   - 用 createWebHashHistory 适配 Wails file:// 协议
 *   - 懒加载（动态 import）减小首屏 bundle
 *   - 全局守卫：未连接 + 进 requiresAuth 路由 → 跳 /auth
 *
 * 命名空间提醒（AGENTS §6.2 Wails Binding 模式）：
 *   channel 命名 = `<namespace>.<method>`（如 repos.list / board.columns.list），
 *   **不**用资源:动作风格
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@renderer/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/auth',
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
    component: () => import('@renderer/views/TimelineNewView.vue'),
    meta: { title: 'Git Graph', requiresAuth: true },
  },
  {
    path: '/merges',
    name: 'merges',
    component: () => import('@renderer/views/MergesView.vue'),
    meta: { title: '合并请求', requiresAuth: true },
  },
  {
    path: '/my-cards',
    name: 'my-cards',
    component: () => import('@renderer/views/MyCardsView.vue'),
    meta: { title: '我的卡片', requiresAuth: true },
  },
  {
    path: '/members',
    name: 'members',
    component: () => import('@renderer/views/MembersView.vue'),
    meta: { title: '成员', requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/SettingsView.vue'),
    meta: { title: '设置', requiresAuth: true },
  },
  {
    // v1.4 拍板占位（ADR-0004）：v2 团队视图落地前的路由占位
    // - requiresAuth: true（跟其他业务路由一致）
    // - 组件：TeamView.vue 占位（仅 EmptyState，**不**进 store / IPC）
    // - v2 拍板前**不**挂 NavRail 入口（避免诱导 user）
    path: '/team',
    name: 'team',
    component: () => import('@renderer/views/TeamView.vue'),
    meta: { title: '团队视图', requiresAuth: true, placeholder: 'v2' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/board',
  },
];

export const router = createRouter({
  history: createWebHashHistory(), // hash 模式适配 Wails file://
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
