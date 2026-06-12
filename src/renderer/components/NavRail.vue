<script setup lang="ts">
/**
 * NavRail —— 左侧导航栏
 *
 * 设计（03-frontend.md §2.1 / §4.1）：
 *   - 宽度 224px（var(--navrail-width)）
 *   - 7 个 NavItem：看板 / 时间轴 / 分支 / 合并请求 / 我的卡片 / 成员 / 设置
 *   - 选中项 = 主色背景 + 主色微光
 *   - 文字用术语翻译表（OVERRIDE §本项目专属规则 #1）—— **不**出现合并请求/合并/分支/派生 等原词
 *
 * v1 实现：7 个入口全部启用（plan_32018da5 把"即将推出"4 个灰显标记去掉）
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { KanbanSquare, Settings, GitBranch, ListChecks, Users2, GitMerge, Timer } from 'lucide-vue-next';

interface NavItem {
  id: string;
  label: string;
  /** lucide 图标组件 */
  icon: typeof KanbanSquare;
  /** 路由名或路径 */
  to: string;
}

const route = useRoute();

const items: NavItem[] = [
  { id: 'board', label: '看板', icon: KanbanSquare, to: '/board' },
  { id: 'timeline', label: '时间轴', icon: Timer, to: '/timeline' },
  { id: 'branches', label: '分支', icon: GitBranch, to: '/branches' },
  { id: 'merges', label: '合并请求', icon: GitMerge, to: '/merges' },
  { id: 'my-cards', label: '我的卡片', icon: ListChecks, to: '/my-cards' },
  { id: 'members', label: '成员', icon: Users2, to: '/members' },
  { id: 'settings', label: '设置', icon: Settings, to: '/settings' },
];

const currentPath = computed(() => route.path);
</script>

<template>
  <nav class="navrail" aria-label="主导航">
    <ul class="navrail__list">
      <li v-for="item in items" :key="item.id" class="navrail__item-wrap">
        <router-link
          :to="item.to"
          class="navrail__item"
          :class="{
            'navrail__item--active': currentPath.startsWith(item.to),
          }"
        >
          <span class="navrail__icon" aria-hidden="true">
            <component :is="item.icon" :size="20" :stroke-width="1.75" />
          </span>
          <span class="navrail__label">{{ item.label }}</span>
        </router-link>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.navrail {
  width: var(--navrail-width);
  flex-shrink: 0;
  /* v1.1.2 改：半透明让 grid 透出（HUD 风），半透明由 AppShell .shell__nav 容器提供 */
  background: transparent;
  border-right: 1px solid color-mix(in srgb, var(--color-divider) 60%, transparent);
  padding: var(--space-3) var(--space-2);
  overflow-y: auto;
}

.navrail__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.navrail__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-md);
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
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
