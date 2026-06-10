<script setup lang="ts">
/**
 * AppShell —— 渲染进程应用外壳
 *
 * 设计（03-frontend.md §2.1 + §4.1）：
 *   - 固定布局：左侧 NavRail + 中部主区（router-view）+ 底部 StatusBar
 *   - 主区内部各 view 自己管滚动（StatusBar 高度固定不滚动）
 *   - 顶栏暂不做（M1 补——现在侧栏已经够用，路由切换足以区分页面）
 *
 * 视图层职责：
 *   - 路由切换由 vue-router 4 的 <router-view> 接管
 *   - 顶栏 = 当前 view 内部自带（避免全局顶栏过度复杂）
 *   - 错误捕获：app-level errorHandler 已经在 main.ts 注册；这里只管 layout
 */
import NavRail from './NavRail.vue';
import StatusBar from './StatusBar.vue';
</script>

<template>
  <div class="shell">
    <NavRail class="shell__nav" />
    <main class="shell__main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
    <StatusBar class="shell__status" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: row;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--color-bg);
}

.shell__nav {
  height: 100%;
}

.shell__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.shell__status {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--t-base) var(--ease);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
