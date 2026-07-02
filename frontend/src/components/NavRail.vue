<script setup lang="ts">
/**
 * NavRail —— 左侧垂直导航栏（参考图风格：图标在上 / 文字在下）
 *
 * 新版布局：
 *   - 中间主菜单：每个菜单项上下排列（图标上方，文字下方）
 *   - 底部功能区：用户头像 / 上传 / 消息 / 主题 / 退出
 *   - 顶部不显示返回箭头（按用户要求）
 *   - 当前有效 NavItem：Git Graph、合并请求、设置（v0.6+ 废弃看板 / 我的卡片 / 成员）
 *   - 文字用术语翻译表（OVERRIDE §本项目专属规则 #1）—— **不**出现合并请求/合并/分支/派生 等原词
 *
 * v0.6+ 废弃看板 / 我的卡片 / 成员：
 *   - 从导航 items 数组移除入口
 *   - 路由保留并加 deprecated 标记，访问时重定向到 Git Graph
 *   - 相关视图文件、stores、composables 标记 @deprecated，待后续彻底清理
 *   - 保留三个原始 DevAnnotation 常量（DEPRECATED_NAV_ANNOTATIONS）以便回滚
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import {
  Settings,
  GitMerge,
  Timer,
  PanelLeftClose,
  PanelLeftOpen,
  Upload,
  Bell,
  Sun,
  Moon,
  User,
  LogOut,
} from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useUiStore, nextThemeInCycle, THEME_DISPLAY_NAME } from '@renderer/stores/ui';
import { showToast } from '@renderer/lib/toast';
import type { DevAnnotation } from '@renderer/lib/dev-annotate';

interface NavItem {
  id: string;
  label: string;
  /** lucide 图标组件 */
  icon: typeof Timer;
  /** 路由名或路径 */
  to: string;
  /** dev 模式注解：点击 ! 看本条目对应 gitea 网页 / API / IPC 数据来源 */
  devAnnotation: DevAnnotation;
  /** 是否只在用户已登录时显示 */
  requiresAuth?: boolean;
}

const route = useRoute();
const uiStore = useUiStore();
const auth = useAuthStore();

const currentThemeName = computed(() => THEME_DISPLAY_NAME[uiStore.currentTheme] ?? uiStore.currentTheme);
const unreadCount = computed(() => 0); // TODO: 后续接入通知系统
const themeIcon = computed(() => (uiStore.currentTheme === 'dark' ? Sun : Moon));

// v0.6+ 软废弃看板/我的卡片/成员：
//   - 从导航 items 中移除入口
//   - 路由仍保留（访问时重定向到 /timeline），store/view 文件加 @deprecated
//   - 保留三个原始 DevAnnotation 常量（DEPRECATED_NAV_NAV_ANNOTATIONS）以便回滚
const DEPRECATED_NAV_ANNOTATIONS = {
  board: {
    web: '/<owner>/<repo>/issues',
    api: 'GET /api/v1/repos/<owner>/<repo>/issues?state=open',
    ipc: 'board.columns.list（列）· issues.list（卡片，按 label 过滤映射）',
    notes: 'v0.6+ 已软废弃：导航栏移除入口，路由重定向到 /timeline',
  },
  myCards: {
    web: '/<owner>/<repo>/issues?q=assignee:@me&state=open',
    api: 'GET /api/v1/repos/<owner>/<repo>/issues?assignee=<me>&state=open',
    ipc: 'issues.list（带 assignee 过滤，per active project）',
    notes: 'v0.6+ 已软废弃：导航栏移除入口，路由重定向到 /timeline',
  },
  members: {
    web: '/<owner>/<repo>/collaborators',
    api: 'GET /api/v1/repos/<owner>/<repo>/collaborators',
    ipc: 'members.list',
    notes: 'v0.6+ 已软废弃：导航栏移除入口，路由重定向到 /timeline',
  },
} as const;

const items: NavItem[] = [
  {
    id: 'timeline',
    label: 'Git Graph',
    icon: Timer,
    to: '/timeline',
    devAnnotation: {
      web: '/<owner>/<repo>/graphs/commits',
      api: 'go-git DAG 图渲染',
      ipc: 'commits.gitgraph.lines',
      notes: 'Git Graph 视图：Go 端输出结构化 nodes+edges，前端 structured.ts 直接渲染 SVG',
    },
  },
  {
    id: 'merges',
    label: '合并请求',
    icon: GitMerge,
    to: '/merges',
    requiresAuth: true,
    devAnnotation: {
      web: '/<owner>/<repo>/pulls',
      api: 'GET /api/v1/repos/<owner>/<repo>/pulls?state=open',
      ipc: 'pulls.list',
    },
  },
  {
    id: 'settings',
    label: '设置',
    icon: Settings,
    to: '/settings',
    devAnnotation: {
      web: '（无 gitea 对应页 · 本地应用设置）',
      ipc: 'preferences.theme.get/set（主题）· auth.connect/disconnect/status（账号）',
      notes: '主题 / 轮询间隔（走 localStorage） / 账号管理（gitea 地址 + 登录用户 + 更新连接）',
    },
  },
];

// v0.6+ 引用 DEPRECATED_NAV_ANNOTATIONS 防 TS unused 警告
void DEPRECATED_NAV_ANNOTATIONS;

const currentPath = computed(() => route.path);

const visibleItems = computed(() =>
  items.filter((item) => !item.requiresAuth || auth.isConnected),
);

/** 折叠 / 展开按钮文案（i18n 占位） */
const toggleLabel = computed(() =>
  uiStore.navCollapsed ? '展开侧栏' : '折叠侧栏',
);

/** 切换主题 */
async function onThemeClick(): Promise<void> {
  const next = nextThemeInCycle(uiStore.currentTheme);
  await uiStore.applyTheme(next);
}

/** 退出登录 */
async function onLogout(): Promise<void> {
  if (!auth.isConnected) return;
  try {
    await auth.disconnect(auth.currentGiteaUrl);
    showToast({ type: 'success', message: '已退出登录' });
  } catch (err) {
    const e = err as { messageText?: string; message?: string };
    showToast({ type: 'error', message: '退出失败', description: e.messageText ?? e.message ?? '请重试' });
  }
}

function onUploadClick(): void {
  showToast({ type: 'info', message: '上传功能暂未接入' });
}
</script>

<template>
  <nav
    class="navrail"
    :class="{ 'navrail--collapsed': uiStore.navCollapsed }"
    aria-label="主导航"
  >
    <!-- 中间主菜单：图标在上，文字在下 -->
    <ul class="navrail__list">
      <li
        v-for="item in visibleItems"
        :key="item.id"
        class="navrail__item-wrap"
      >
        <router-link
          :to="item.to"
          class="navrail__item"
          :class="{
            'navrail__item--active': currentPath.startsWith(item.to),
          }"
          v-dev-annotate="item.devAnnotation"
        >
          <span class="navrail__icon" aria-hidden="true">
            <component :is="item.icon" :size="22" :stroke-width="1.75" />
          </span>
          <span class="navrail__label">{{ item.label }}</span>
        </router-link>
      </li>
    </ul>

    <!-- 底部功能区：头像、上传、消息、主题、折叠/展开 -->
    <div class="navrail__footer">
      <!-- 用户头像 -->
      <button
        v-if="auth.currentUser"
        type="button"
        class="navrail__foot-btn navrail__foot-btn--avatar"
        :title="`当前用户：${auth.currentUser.login}`"
      >
        <img
          v-if="auth.currentUser.avatarUrl"
          :src="auth.currentUser.avatarUrl"
          :alt="`${auth.currentUser.login} 头像`"
          class="navrail__avatar"
        />
        <User v-else :size="18" :stroke-width="1.75" />
      </button>

      <!-- 上传 -->
      <button
        type="button"
        class="navrail__foot-btn"
        title="上传"
        @click="onUploadClick"
      >
        <Upload :size="18" :stroke-width="1.75" />
      </button>

      <!-- 消息 -->
      <button
        type="button"
        class="navrail__foot-btn navrail__foot-btn--badge-wrap"
        title="消息通知"
      >
        <Bell :size="18" :stroke-width="1.75" />
        <span v-if="unreadCount > 0" class="navrail__badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
      </button>

      <!-- 主题切换 -->
      <button
        type="button"
        class="navrail__foot-btn"
        :title="`切换主题（当前：${currentThemeName}）`"
        @click="onThemeClick"
      >
        <component :is="themeIcon" :size="18" :stroke-width="1.75" />
      </button>

      <!-- 退出登录 -->
      <button
        v-if="auth.isConnected"
        type="button"
        class="navrail__foot-btn navrail__foot-btn--danger"
        title="退出登录"
        @click="onLogout"
      >
        <LogOut :size="18" :stroke-width="1.75" />
      </button>

      <!-- 折叠/展开 -->
      <button
        type="button"
        class="navrail__foot-btn navrail__foot-btn--toggle"
        :aria-label="toggleLabel"
        :title="toggleLabel"
        :aria-expanded="!uiStore.navCollapsed"
        @click="uiStore.toggleNavrail()"
      >
        <component
          :is="uiStore.navCollapsed ? PanelLeftOpen : PanelLeftClose"
          :size="18"
          :stroke-width="1.75"
        />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.navrail {
  width: var(--navrail-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  padding: var(--space-3) var(--space-2);
  overflow-y: auto;
  overflow-x: hidden;
  transition: width var(--t-slow) var(--ease-out);
  border-right: 1px solid var(--color-divider-region);
}

.navrail--collapsed {
  width: var(--navrail-collapsed-width);
}

.navrail__list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-height: 0;
  padding-top: var(--space-2);
}

.navrail__item-wrap {
  width: 100%;
}

/* 中间菜单：图标在上，文字在下，垂直居中 */
.navrail__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 8px;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: var(--font-xs);
  text-decoration: none;
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}

.navrail__item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
  text-decoration: none;
}

.navrail__item--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 500;
}

.navrail__item--active:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.navrail__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.navrail__label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  transition:
    opacity var(--t-base) var(--ease-out),
    max-width var(--t-slow) var(--ease-out);
}

/* 折叠态：只显示图标 */
.navrail--collapsed .navrail__item {
  padding: 12px 0;
}

.navrail--collapsed .navrail__label {
  opacity: 0;
  max-width: 0;
  pointer-events: none;
}

/* 底部功能区：图标排成一行，折叠态也保持垂直堆叠 */
.navrail__footer {
  margin-top: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid color-mix(in srgb, var(--color-divider) 50%, transparent);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.navrail--collapsed .navrail__footer {
  padding: var(--space-2) 0;
}

.navrail__foot-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}

.navrail__foot-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.navrail__foot-btn--danger:hover {
  color: var(--color-danger);
  background: rgba(225, 70, 70, 0.12);
}

.navrail__foot-btn--toggle {
  margin-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--color-divider) 50%, transparent);
  border-radius: 0;
  width: 100%;
  padding: 8px 0 0;
}

.navrail__foot-btn--avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  padding: 0;
  background: var(--color-bg-hover);
}

.navrail__avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.navrail__foot-btn--badge-wrap .navrail__badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--color-danger);
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}

.navrail__foot-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
  border-radius: var(--radius-sm);
}
</style>
