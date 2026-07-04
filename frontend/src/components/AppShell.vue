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
 *
 * v1.x 拍板 2026-07-04 v2.1（macOS 标题栏主题跟随 + 不破坏 StatusBar）：
 *   - 配套 main.go `Mac.TitleBar = mac.TitleBarHiddenInset()`：标题栏背景透明 + webview 占满整 NSWindow
 *   - 颜色由 AppShell .shell 的 background: var(--color-bg) 接管：
 *     dark=#0F1115 / light=#e8f1f5，主题切换时自动跟随
 *   - traffic lights (红/黄/绿) 仍显示（macOS 浮层在 webview 上面）
 *   - **不给 .shell padding-top: 28**（上一版这么做让 StatusBar 落在 webview 圆角区被遮挡）
 *     只给 .shell__nav (NavRail) 加 padding-top: 32 仅 macOS，让位 28px+给 traffic lights
 *   - **.shell height = var(--vheight) - 22px** 仅 macOS，让 22px 给 macOS Big Sur/Sonoma+ 圆角，
 *     .shell__status `bottom: 0` 现在落在屏幕安全区内，StatusBar 33px 完整可见可点
 *   - .shell__status z-index: 9999 保持，避免 view 内 transform promoted layer 覆盖
 *   - data-platform 是 index.html 内联脚本同步设的 attr，first paint 之前可用
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
  /* v1.x 拍板 2026-07-04：用 var(--vheight) 替代 100vh，App.vue mount + resize
   * 时把 window.innerHeight 注入 --vheight，避免 WKWebView 中 100vh ≠ NSWindow 高度。 */
  height: var(--vheight, 100vh);
  width: 100vw;
  overflow: hidden;
  /* v1.5：删透明透网格 → 走纯色背景，让各区域边界线清晰可读 */
  background: var(--color-bg);
}

/* v1.x 拍板 2026-07-04 v2（macOS 标题栏主题跟随）：
 * TitleBarHiddenInset 让 webview 占满整个 NSWindow（含原标题栏区 0..28px），
 * traffic lights 浮在该 28px 区上方。
 *
 * v2.1 拍板 2026-07-04（macOS 圆角修复）：
 * TitleBarHiddenInset + FullSizeContent 让 webview 占满 NSWindow，但 macOS Sonoma+
 * 默认 NSWindow 底部圆角 ~22px 在系统层 visual clip，**.shell__status (height 33px,
 * bottom: 0) 落在圆角区被遮 22px**，按钮下半截看不到也点不到（被 GitGraph 加载更多等
 * 上层元素接收 hit）。
 * 修法：让 .shell 整体上抬 22px（仅 macOS），让那 22px 给 macOS 圆角：
 *   - .shell height = var(--vheight) - 22px
 *   - .shell__status bottom: 0 现在落在 webview 内容底部 = 屏幕安全区
 *   - StatusBar 33px 完整可见可点
 *   - NSWindow 底部 22px 圆角 transparent 区显示 NSWindow bg (#0F1115) 与 .shell bg 视觉一致
 *
 * v2 拍板：不给 .shell padding-top: 28，让位 NavRail 内部 padding-top: 32 + ::before drag region
 *
 * 用 :global() 穿透 scoped style 选择 html[data-platform='mac']（index.html 内联脚本同步设置） */
:global(html[data-platform='mac']) .shell {
  /* macOS Big Sur / Monterey / Ventura ~14-16px, Sonoma+ ~22px。Sonoma 是当前主流 release，
   * 取 22px 保守估计覆盖 Sonoma/Sequoia。如果未来 macOS 再增，让这个值同步增长 */
  height: calc(var(--vheight, 100vh) - 22px);
}
:global(html[data-platform='mac']) .shell__nav :deep(.navrail) {
  /* 让 navrail 内部 logo / 按钮从 y=32 开始 (traffic lights 在 y=16~40)，
   * Header↔Body 分界仍由 1px navrail border 提供。 */
  padding-top: 32px;
}
/* 顶部 32px drag region —— 让用户能拖窗口 + 避免 navrail / main 元素遮 traffic lights
 *   - ::before pointer-events: auto 让 NSWindow 处理 drag（Wails v2.5+ 默认 CSSDragProperty="--wails-draggable"）
 *   - background 透明，让 .shell 的 var(--color-bg) 透上来 → 标题栏颜色跟主题走
 *   - z-index 99999 高于所有 layer，但 macOS traffic lights 在更上层 NSWindow，永远可点 */
:global(html[data-platform='mac']) .shell::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 32px;
  background: transparent;
  --wails-draggable: drag;
  z-index: 99999;
  pointer-events: auto;
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
  /* v1.x 2026-07-04:z-index 提到 9999，确保在所有 view 内部 transform stacking context
   * 之上（比如 GitGraph 滚动容器 transform / opacity 触发的 promoted layer，
   * 之前 z-index: 2 时偶发"压住状态栏"） */
  z-index: 9999;
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
