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
 *   - isMac prop 由 App.vue 注入（JIT 内 onMounted 检测 navigator.platform），
 *     via class binding "shell--mac" 选中的 macOS 样式 —— 不再用 :global(html[...] .shell)，
 *     后者在 Vue 3 scoped CSS 编译时被错误拆分为只作用 <html>、.shell 选择器被吞掉，
 *     所有 macOS 安全区 CSS 静默失效（StatusBar 一直不可见的真根因 —— 上一回合逃逸）
 *
 * v1.7 拍板 2026-07-04（AppShell layout 重写）：
 *   - 上一回合 `.shell height = calc(100vh - 22)` + `.shell__status position: absolute; bottom: 0`
 *     仍偶发 StatusBar 看不见：100vh 在 WKWebView macOS Big Sur+ 下可能 ≠ NSWindow contentView
 *     frame.height，StatusBar 还是落在 WKWebView frame 底部 macOS 圆角 mask 区被遮。
 *   - 本轮重写 .shell layout 为 **flex column**：
 *     · .shell = flex column，高度 = var(--vheight)（macOS 下让 32px 给圆角）
 *     · .shell__row = flex: 1 的 row 包裹 navrail + main
 *     · .shell__status = flex item （**不是 absolute**）高 33px，flex-shrink: 0
 *     优点：
 *       ① 不依赖 innerHeight 与 NSWindow 精确相等 —— StatusBar 是 flex item
 *         总在 .shell bottom 位置，受 .shell--mac height 控制严格
 *       ② statusbar 在 flex flow 里，不会被 view 内 transform promoted layer 遮
 *       ③ view 主区不会跨越 statusbar 区，避免 list 滚动到底被压
 */
import NavRail from './NavRail.vue';
import StatusBar from './StatusBar.vue';

defineProps<{ isMac: boolean }>();
</script>

<template>
  <div class="shell" :class="{ 'shell--mac': isMac }">
    <!--
      v1.7 拍板 2026-07-04：.shell__row = flex row, 包裹 navrail + main
      (v1.5 旧的 .shell grid + .shell 100vh 不分上下布局 在 v1.7 重写为 flex column)
      .shell__status 不再 absolute，作为 .shell 直接子元素 flex item
    -->
    <div class="shell__row">
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
    </div>
    <StatusBar class="shell__status" />
  </div>
</template>

<style scoped>
/* v1.7 拍板 2026-07-04：AppShell layout 全面重写
 *   - .shell = flex column，高度 = var(--vheight)（macOS 下让 32px 给圆角）
 *   - .shell__row = flex: 1 row 包裹 navrail + main
 *   - .shell__status = flex item（**不是 absolute**），高 33px
 *   - 优点：不依赖 WKWebView innerHeight 与 NSWindow 精确相等、StatusBar 总在 .shell bottom
 */
.shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: var(--vheight, 100vh);
  width: 100vw;
  overflow: hidden;
  /* v1.5：删透明透网格 → 走纯色背景，让各区域边界线清晰可读 */
  background: var(--color-bg);
}

/* v1.9 拍板 2026-07-04：macOS 标准 titlebar + AppShell 让位 32px
 *
 * 背景：macOS TitleBarDefault 下：
 *   - NSWindow chrome (28px titlebar + traffic lights) 系统绘制，macOS dark mode 下 #1e1e1e
 *     跟应用 #0F1115 dark canvas 视觉协调（同一个家族色）
 *   - webview 从 y=28 起，traffic lights 在 y=16~40 (NSWindow 层浮在 webview 上面)
 *   - webview 顶 32px 区 (y=28..60) 会被 traffic lights 徽章遮挡
 *
 * 修法：让 .shell__row (包裹 navrail + main 的 flex row) 在 macOS 下让出 32px top:
 *   - .shell--mac .shell__row { margin-top: 32px; height: calc(100% - 32px) }
 *     高度计算：.shell height = var(--vheight), .shell__status = 33px bottom, .shell__row = flex:1
 *     margin-top: 32 让 NavRail / main 内容起点 = y=28+32 = y=60，刚好避开 traffic lights
 *   - 用户拖窗口：点 y=0..28 NSWindow titlebar 拖 —— NSWindow 标准行为，不需自定义 drag region
 *
 * 不用自定义 .shell--mac::before drag region —— TitleBarDefault 下 NSWindow titlebar 本就可拖，
 * 加 ::before 会遮住 NSWindow titlebar click，影响 traffic lights 区域交互（pointer-events 覆盖）。
 */
.shell--mac {
  height: var(--vheight, 100vh);
}

/* .shell__row = flex row 包裹 navrail + main
 *   - flex: 1 占满 .shell 内容区除 statusbar 外的全部高度
 *   - min-height: 0 让 .shell__main 内部可以滚动 */
.shell__row {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}

/* macOS 下让 .shell__row 从 y=60 起 (避开 traffic lights y=16~40):
 *   - margin-top: 32 让 row 上方留 32px 给 macOS 标题栏重叠区
 *   - flex: 1 + margin-top 共存：flex 容器在 main axis 是 row layout，margin-top 让 main axis 起点下移
 *   - 高度 = 100% − 32 (parent .shell height − margin) —— flex 自动重新计算 */
.shell--mac .shell__row {
  margin-top: 32px;
  height: calc(100% - 32px);
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
  overflow: hidden;
  /* v1.6.1：右侧主区走专属 token (--color-shell-main-bg)
   * 亮色 = #F8FAFC 极浅灰白（跟左导航/状态栏/卡片的 #FFFFFF 协调，Linear / Notion 风）
   * 暗色 = --color-bg (#0F1115) 最深画布（跟 elevated 卡片 #181C24 形成 9 阶亮度差）
   * 区域分区靠 1px --color-divider-region 边界线 + 4 档单层柔和阴影 */
  background: var(--color-shell-main-bg);
  /* v1.7：flex item 后 statusbar 是 flex item 在 .shell bottom，.shell__main 自然让出 33px，
   * 不再需要 padding-bottom */
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
  position: relative;
  /* v1.7 拍板：flex item, 不再 absolute; flex-shrink: 0 保证总是 33px */
  flex-shrink: 0;
  z-index: 1;
  /* 固定高度 —— 让 .shell__row 的 height 精确匹配，list 不会被切 */
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
