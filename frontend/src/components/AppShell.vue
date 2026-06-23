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
 *
 * v1.4 第六轮（plan 调整）：
 *   - GlobalLoadingOverlay 从 App.vue 移到 .shell__content 内（v1.4 第六轮 user 拍板）
 *   - 原因：之前 overlay 走 fixed + 半透明蒙版 → 整个主区被"蒙版盖住"
 *   - 现在 overlay 是主区的兄弟节点，position: absolute 居中在 .shell__content
 *   - 不挡内容、不蒙版、不模糊 —— 跟 view 内容同框渲染
 *   - 路由切换 fade 过渡时 overlay 跟 router-view 平级，位置稳定
 */
import NavRail from './NavRail.vue';
import StatusBar from './StatusBar.vue';
import GlobalLoadingOverlay from './GlobalLoadingOverlay.vue';
</script>

<template>
  <div class="shell">
    <!--
      HUD 背景网格（v1.1.2 落地 · tech-refine §6.1）
      挂 .shell 根覆盖整个应用窗口（NavRail 后面也透出）——
      NavRail / StatusBar 改半透明 + backdrop-filter，
      让 grid 当"窗口地"全屏露出，HUD 风才完整
    -->
    <div class="shell__grid canvas-grid" aria-hidden="true" />
    <NavRail class="shell__nav" />
    <main class="shell__main">
      <div class="shell__content">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
        <!--
          v1.4 第六轮：overlay 挂在 .shell__content 内，跟 router-view 平级
          - 不浮在内容之上（无蒙版 / 无 blur / 无 box-shadow）
          - 跟内容同框，pointer-events: none 不抢点击
          - 路由切换时 router-view fade 180ms 期间 overlay 位置稳定
        -->
        <GlobalLoadingOverlay />
      </div>
    </main>
    <StatusBar class="shell__status" />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  display: flex;
  flex-direction: row;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--color-bg);
}

.shell__grid {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  /* 极弱 8% alpha · 走 --grid-color token 3 主题自适应 */
}

.shell__nav {
  position: relative;
  z-index: 1;
  /* v1.4 任务 #statusbar-picker：高度让出底部状态栏 33px，避免左下角折叠按钮被遮
   * 旧值 height: 100%（状态栏 28px 时已经盖住 28px，33px 之后更明显） */
  height: calc(100% - var(--statusbar-height));
  /* 半透明 + **移除 backdrop-filter** —— blur 把 grid 8% alpha 弱线条糊掉看不见
   * alpha 从 60% 降到 35% · 让 24px grid 清晰透出侧栏背景 */
  background: color-mix(in srgb, var(--color-bg-elevated) 35%, transparent);
  /* 强边界阴影（--shadow-navrail token · 3 主题自适应）——
   * 三件套：深底色阴影向右 + 1px 冷白内描边 + 主色外环 glow（亮色关） */
  box-shadow: var(--shadow-navrail);
}

/* 穿透子组件 scoped style —— 让 NavRail 内部根元素继承 shell__nav 的半透明 */
.shell__nav :deep(.navrail) {
  background: transparent;
  border-right-color: transparent; /* 描边让位给 box-shadow 冷白内描边 */
}

.shell__main {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 让出底部状态栏高度 —— .shell__status 是 position:absolute 叠层，
   * .shell__main 不补 padding 就会被状态栏压住最后一行（TimelineView list 519→491） */
  padding-bottom: var(--statusbar-height);
  overflow: hidden;
  background: transparent;
}

.shell__content {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.shell__status {
  position: absolute;
  z-index: 2;
  bottom: 0;
  left: 0;
  right: 0;
  /* 固定高度 —— 让 .shell__main 的 padding-bottom 精确匹配，list 不会被切 */
  height: var(--statusbar-height);
  /* 半透明 · 让 grid 透出 · HUD 风 */
  background: color-mix(in srgb, var(--color-bg-elevated) 60%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* 穿透子组件 scoped style —— 让 StatusBar 内部 .statusbar 继承 shell__status 的半透明 */
.shell__status :deep(.statusbar) {
  background: transparent;
  border-top-color: color-mix(in srgb, var(--color-divider) 60%, transparent);
  /* 确保 statusbar 填满 wrapper */
  height: 100%;
}
/* wrapper 透明，不干扰布局 */
.shell__status :deep(.statusbar-wrap) {
  height: 100%;
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
