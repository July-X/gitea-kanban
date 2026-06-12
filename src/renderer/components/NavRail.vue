<script setup lang="ts">
/**
 * NavRail —— 左侧导航栏
 *
 * 设计（03-frontend.md §2.1 / §4.1）：
 *   - 默认宽度 224px（var(--navrail-width)），折叠态 56px（--navrail-collapsed-width）
 *   - 7 个 NavItem：看板 / 时间轴 / 分支 / 合并请求 / 我的卡片 / 成员 / 设置
 *   - 选中项 = 主色背景 + 主色微光
 *   - 文字用术语翻译表（OVERRIDE §本项目专属规则 #1）—— **不**出现合并请求/合并/分支/派生 等原词
 *
 * v1 实现：7 个入口全部启用（plan_32018da5 把"即将推出"4 个灰显标记去掉）
 * v1.1.3 polish：底部加折叠按钮（PanelLeftClose/Open）—— 折叠态只保留 icon + active 高亮
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import {
  KanbanSquare,
  Settings,
  GitBranch,
  ListChecks,
  Users2,
  GitMerge,
  Timer,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-vue-next';
import { useUiStore } from '@renderer/stores/ui';

interface NavItem {
  id: string;
  label: string;
  /** lucide 图标组件 */
  icon: typeof KanbanSquare;
  /** 路由名或路径 */
  to: string;
}

const route = useRoute();
const uiStore = useUiStore();

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

/** 折叠 / 展开按钮文案（i18n 占位 · cycle 2 接到 src/shared/i18n 文案表） */
const toggleLabel = computed(() =>
  uiStore.navCollapsed ? '展开侧栏' : '折叠侧栏',
);
</script>

<template>
  <nav
    class="navrail"
    :class="{ 'navrail--collapsed': uiStore.navCollapsed }"
    aria-label="主导航"
  >
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
    <div class="navrail__footer">
      <button
        type="button"
        class="navrail__toggle"
        :aria-label="toggleLabel"
        :title="toggleLabel"
        :aria-expanded="!uiStore.navCollapsed"
        @click="uiStore.toggleNavrail()"
      >
        <component
          :is="uiStore.navCollapsed ? PanelLeftOpen : PanelLeftClose"
          :size="20"
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
  /* v1.1.2 半透明由 AppShell .shell__nav 容器提供；v1.1.3 折叠/展开用 width 过渡 */
  background: transparent;
  padding: var(--space-3) var(--space-2);
  overflow-y: auto;
  overflow-x: hidden; /* 折叠态 label 渐隐时不要撑出横向滚动条 */
  transition: width var(--t-slow) var(--ease-out);
}

.navrail--collapsed {
  width: var(--navrail-collapsed-width);
}

.navrail__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* flex: 1 让 list 占满剩余高度，把 footer 推到底部 */
  flex: 1;
  min-height: 0;
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
    color var(--t-fast) var(--ease),
    padding var(--t-slow) var(--ease-out),
    justify-content var(--t-slow) var(--ease-out);
}

.navrail--collapsed .navrail__item {
  /* 折叠态：icon 居中 + 去掉左右 padding 让 icon 真正在 56px 内居中 */
  justify-content: center;
  padding: 8px 0;
  gap: 0;
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
  /* label 渐隐 + 宽度收 0 —— 让 icon 居中时不会出现 "看板" 半截字 */
  transition:
    opacity var(--t-base) var(--ease-out),
    max-width var(--t-slow) var(--ease-out);
  max-width: 160px; /* 约等于"合并请求"4 字宽度 · 防溢出 */
}

.navrail--collapsed .navrail__label {
  opacity: 0;
  max-width: 0;
  pointer-events: none;
}

/* footer · 折叠按钮 · 始终显示（折叠态下也用来"展开回来"） */

.navrail__footer {
  margin-top: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid color-mix(in srgb, var(--color-divider) 50%, transparent);
  display: flex;
  justify-content: center;
  /* footer 本身也走过渡：折叠态 padding 收紧让按钮居中更紧凑 */
  transition: padding var(--t-slow) var(--ease-out);
}

.navrail--collapsed .navrail__footer {
  padding: var(--space-2) 0;
}

.navrail__toggle {
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

.navrail__toggle:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.navrail__toggle:focus-visible {
  /* 沿用全局 button focus-visible 风格（theme.css §2.1 已配 --shadow-focus） */
  outline: none;
  box-shadow: var(--shadow-focus);
  border-radius: var(--radius-sm);
}
</style>
