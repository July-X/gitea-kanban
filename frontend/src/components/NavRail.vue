<script setup lang="ts">
/**
 * NavRail —— 左侧窄导航栏（70px 固定宽度，图标在上 / 文字在下）
 *
 * 当前有效 NavItem：Git Graph、合并请求、设置（v0.6+ 废弃看板 / 我的卡片 / 成员）
 * 文字用术语翻译表（OVERRIDE §本项目专属规则 #1）—— **不**出现合并请求/合并/分支/派生 等原词
 *
 * v0.6+ 废弃看板 / 我的卡片 / 成员：
 *   - 从导航 items 数组移除入口
 *   - 路由保留并加 deprecated 标记，访问时重定向到 Git Graph
 *   - 相关视图文件、stores、composables 标记 @deprecated，待后续彻底清理
 *   - 保留三个原始 DevAnnotation 常量（DEPRECATED_NAV_ANNOTATIONS）以便回滚
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Settings, GitMerge, Timer } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import type { DevAnnotation } from '@renderer/lib/dev-annotate';

interface NavItem {
  id: string;
  label: string;
  icon: typeof Timer;
  to: string;
  devAnnotation: DevAnnotation;
  requiresAuth?: boolean;
}

const route = useRoute();
const auth = useAuthStore();

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

void DEPRECATED_NAV_ANNOTATIONS;

const currentPath = computed(() => route.path);

const visibleItems = computed(() =>
  items.filter((item) => !item.requiresAuth || auth.isConnected),
);
</script>

<template>
  <nav class="navrail" aria-label="主导航">
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
  </nav>
</template>

<style scoped>
.navrail {
  width: 70px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  padding: var(--space-3) 0;
  overflow-y: auto;
  overflow-x: hidden;
  border-right: 1px solid var(--color-divider-region);
}

.navrail__list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-height: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}

.navrail__item-wrap {
  width: 100%;
}

.navrail__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 10px 0;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: 10px;
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
  font-size: 10px;
  line-height: 1;
}
</style>
