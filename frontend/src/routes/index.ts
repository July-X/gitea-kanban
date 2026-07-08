/**
 * 路由表（Vue Router 4）
 *
 * v2.0 沿用 v1 设计 + Wails hash router：
 *   - 7 个一级路由：/、/auth、/board、/timeline、/merges、/my-cards、/members、/settings
 *   - v1.4 拍板：加 /team 占位路由（v2 团队视图落地前，**不**挂 NavRail 入口）
 *     · 详见 ADR-0004（docs/adr/0004-single-repository-focus.md）
 *     · view 走 TeamView.vue 占位，仅保留路由，**不**进 store / IPC
 *
 * v0.6+ 软废弃 /board、/my-cards、/members 三个入口：
 *   - 路由仍保留（向后兼容 + 文档/书签外链）
 *   - 访问这些路径时强制重定向到 /timeline（Git Graph）
 *   - 相关视图文件、stores、composables 标记 @deprecated，待后续彻底清理
 *   - 路由 meta.deprecated: true 标识已废弃入口
 *
 * 守卫规则：
 *   - 根路径 / 重定向到 /auth（未连接时合理入口）
 *   - 用 createWebHashHistory 适配 Wails file:// 协议
 *   - 懒加载（动态 import）减小首屏 bundle
 *   - 全局守卫：
 *     1. 未连接 + 进 requiresAuth 路由 → 跳 /auth
 *     2. 进入 meta.deprecated 路由 → 重定向到 /timeline（v0.6+ 软废弃）
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
    // v0.6+ 软废弃：导航栏移除入口，访问 URL 时重定向到 /timeline
    // 视图文件 / stores / composables 保留并加 @deprecated 标记，待后续彻底清理
    path: '/board',
    name: 'board',
    redirect: '/timeline',
    meta: { title: '看板', requiresAuth: true, deprecated: true, deprecatedReason: 'v0.6+ 软废弃' },
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
    // v0.6+ 软废弃
    path: '/my-cards',
    name: 'my-cards',
    redirect: '/timeline',
    meta: { title: '我的卡片', requiresAuth: true, deprecated: true, deprecatedReason: 'v0.6+ 软废弃' },
  },
  {
    // v0.6+ 软废弃
    path: '/members',
    name: 'members',
    redirect: '/timeline',
    meta: { title: '成员', requiresAuth: true, deprecated: true, deprecatedReason: 'v0.6+ 软废弃' },
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
    redirect: '/timeline',
  },
];

export const router = createRouter({
  history: createWebHashHistory(), // hash 模式适配 Wails file://
  routes,
});

/**
 * 全局守卫：
 * 1. 未连接时强制进 /auth（避免死循环：已在 /auth 时不重定向）
 * 2. v0.6+ 软废弃路由（/board、/my-cards、/members）：强制重定向到 /timeline
 *
 * v0.7.4 性能优化：守卫改为同步判断，不再 await IPC。
 *   - 旧版在 requiresAuth 路由切换时 await auth.refreshStatus()，
 *     导致每次切页都要等 IPC 返回，导航被同步卡住。
 *   - 新版只做同步判断：auth.isConnected 在 App.vue mount 时已一次性拉好，
 *     守卫直接读 store 状态，不阻塞导航。
 */
router.beforeEach((to) => {
  // v0.6+ 软废弃路由访问保护：进入 deprecated 路由直接跳到 Git Graph
  if (to.meta.deprecated === true) {
    return { name: 'timeline' };
  }

  if (to.meta.requiresAuth) {
    const auth = useAuthStore();
    if (!auth.isConnected) {
      return { name: 'auth', query: { from: to.fullPath } };
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
