<script setup lang="ts">
/**
 * AppShell —— 渲染进程应用外壳
 *
 * 设计（AppShell layout 设计（v1 沿用））：
 *   - 固定布局：左侧 NavRail + 中部主区（router-view）+ 底部 StatusBar
 *   - 主区内部各 view 自己管滚动（StatusBar 高度固定不滚动）
 *   - 顶栏暂不做（M1 补——现在侧栏已经够用，路由切换足以区分页面）
 *
 * 视图层职责：
 *   - 路由切换由 vue-router 4 的 <router-view> 接管
 *   - 顶栏 = 当前 view 内部自带（避免全局顶栏过度复杂）
 *   - 错误捕获：app-level errorHandler 已经在 main.ts 注册；这里只管 layout
 *
 * v1.5（2026-06-22 · user 拍板）：
 *   - 移除全屏 HUD 背景网格（v1.1.2 引入的 .canvas-grid）—— 网格装饰被砍
 *   - 改为"区域边界线"分区视觉：
 *     · 左侧 NavRail 右边界  1px --color-divider-region
 *     · 右侧主区顶 Header 下边界 1px --color-divider（Header / Body 分界）
 *     · 底部 StatusBar 上边界 1px --color-divider-strong（区域边界强度更高）
 *   - 区域边界 token 已在 theme.css 提档（dark 10% / light 12%）保证可读
 */
import NavRail from './NavRail.vue';
import StatusBar from './StatusBar.vue';
</script>

<template>
  <div class="shell">
    <!--
      v1.5：移除 HUD 背景网格（v1.1.2 .shell__grid / .canvas-grid 全删）——
      背景改成纯 --color-bg，每个区域靠 1px 边界线视觉分区
    -->
    <NavRail class="shell__nav" />
    <main class="shell__main">
      <div class="shell__content">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
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
  /* v1.5：删透明透网格 → 走纯色背景，让各区域边界线清晰可读 */
  background: var(--color-bg);
}

.shell__nav {
  position: relative;
  z-index: 1;
  height: 100%;
  flex-shrink: 0;
  width: 70px;
  /* NavRail 内部已经包含实色背景和右边框，这里只做定位 */
}

/* 穿透子组件 scoped style —— 让 NavRail 内部根元素继承 shell__nav 的实色背景 */
.shell__nav :deep(.navrail) {
  background: transparent;
  border-right-color: transparent;
  height: 100%;
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
  /* v1.6.1：右侧主区走专属 token (--color-shell-main-bg)
   * 亮色 = #F8FAFC 极浅灰白（跟左导航/状态栏/卡片的 #FFFFFF 协调，Linear / Notion 风）
   * 暗色 = --color-bg (#0F1115) 最深画布（跟 elevated 卡片 #181C24 形成 9 阶亮度差）
   * 区域分区靠 1px --color-divider-region 边界线 + 4 档单层柔和阴影 */
  background: var(--color-shell-main-bg);
  /* v1.5：右侧主区**不**强制顶部边界线 —— 每个 view 的 topbar 内部已有
   *   border-bottom: 1px solid var(--color-divider) 自带 Header↔Body 分界，
   *   AppShell 不重复添加，避免双线/线偏移
   * 顶部那条线由 view 自己控制（NavRail 也不顶到顶部，缺这条线不影响视觉） */
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
  /* v1.5：实色背景替代半透明 + backdrop-filter */
  background: var(--color-bg-elevated);
  /* v1.5：状态栏上边界用更强的 --color-divider-strong
   * —— 状态栏是"独立工具栏"区域，边界强度要高于一般内容分隔 */
  border-top: 1px solid var(--color-divider-strong);
}

/* 穿透子组件 scoped style —— 让 StatusBar 内部 .statusbar 继承 shell__status 的实色 */
.shell__status :deep(.statusbar) {
  background: transparent;
  border-top-color: transparent; /* 让位给 wrapper 的 border-top */
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
