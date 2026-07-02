<script setup lang="ts">
/**
 * GlobalLoadingOverlay —— 全局加载动画（海豚吉祥物）
 *
 * 定位：v0.3.0 起，所有远端请求 loading 收口到这一个全局海豚 overlay，
 *       显示在主区中央（v1.4 拍板的 absolute 居中，非 v1.4 之前的 fixed 全屏蒙版）。
 *
 * 用户当前任务（用户原始消息）：
 *   "做一个全局的加载动画，出现的位置主要是 App 右侧的功能区。
 *    动画效果为：一个小海豚转圈"
 *   ——TODO（v0.6+ 单独 plan）：位置从主区中央改成 App 右侧功能区；动画
 *     保留 v1.4 海豚 emoji + 公转。
 *
 * 内容：emoji 🐬 海豚（24px）+ 头顶小气泡
 * 动画：海豚沿 12px 半径小圈公转 4s linear 一圈 + 内层 emoji 上下浮动 1.2s +
 *       气泡错峰浮动 1.6s
 * a11y：
 *   - role="status" aria-live="polite" aria-label="加载中"
 *   - 尊重 prefers-reduced-motion: reduce（停转但保留静态展示）
 * pointer-events: none：不抢点击（用户在主区还能继续交互）
 * 视觉：透明背景（无蒙版 / 无 blur / 无 box-shadow）
 *
 * v0.3.0 注释清理：移除 v1.4 时代的设计系统硬约束 / src/main/** / src/preload/**
 * / src/renderer/styles/theme.css 等 v1 时代溯源。组件代码本身无 v0.3.0 兼容性问题，继续使用。
 */
import { computed } from 'vue';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

const globalLoading = useGlobalLoadingStore();
const visible = computed(() => globalLoading.visible);
</script>

<template>
  <!--
    整个 overlay 用 v-show 隐藏（不是 v-if）—— v-show 保留 DOM，
    切换只改 opacity + display，避免重复 mount SVG 节点带来的 jank
  -->
  <Transition name="dolphin-fade">
    <div
      v-if="visible"
      class="dolphin-overlay"
      role="status"
      aria-live="polite"
      aria-label="加载中"
    >
      <div class="dolphin-overlay__inner">
        <!--
          海豚：emoji 🐬（v1.4 user 拍板推翻 设计系统硬约束）
          - 跨平台 emoji 字体（Apple / Google / Win / Linux）走系统默认
          - 公转 4s linear 沿 12px 半径圆周一圈，头朝右不回转
          - 内层 span 走上下浮动 1.2s（独立 transform 栈）
          - aria-hidden=true：emoji 不进 a11y 树，外面 role=status 负责播报
          - v1.4 早期 user 拍板：删圆环轨道，单纯公转
          - v1.4 中期 user 拍板：海豚大小减半（emoji 48 → 24，wrapper 64 → 32）
        -->
        <div class="dolphin-emoji-wrap" aria-hidden="true">
          <span class="dolphin-emoji">🐬</span>
          <!-- 头顶小气泡：跟着 emoji 一起公转（错峰浮动） -->
          <svg
            class="dolphin-bubble"
            viewBox="0 0 8 8"
            width="8"
            height="8"
            aria-hidden="true"
          >
            <circle cx="4" cy="4" r="3" class="dolphin-bubble__dot" />
          </svg>
        </div>

        <!--
          v1.4 倒数第二轮 user 拍板：删"加载中…"文字
          a11y 仍由外层 div role="status" aria-live="polite" 负责（屏幕阅读器读"加载中"）
        -->
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/**
 * Overlay 几何（v1.4 末轮 user 拍板 · 推翻之前的 fixed 全屏蒙版）：
 *   - 位置：position: absolute 居中在 .shell__content 内（父级 = AppShell.vue 的主区）
 *   - z-index 走 --z-nav（100），比 modal 低
 *   - pointer-events: none：不抢点击（用户在主区还能继续交互）
 *   - **不**再 fixed 全屏 / **不**再有半透明蒙版 / **不**再有 blur / **不**再有 box-shadow
 *     → 海豚"显示在内容区的 DOM 上"，内容完全可见
 *   - 父级 .shell__content 是 position: relative + overflow: hidden + flex column
 *     → overlay 跟 router-view 平级，z-index 让海豚飘在内容之上但**不挡**视觉
 */
.dolphin-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-nav);
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  /* v1.4 末轮：删 background / backdrop-filter / box-shadow —— 纯透明 */
}

.dolphin-overlay__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  /* 中间留 32px padding，让海豚不会贴边 */
  padding: 24px 32px;
  color: var(--color-primary);
  text-shadow: 0 0 8px var(--color-primary-glow);
  /* emoji 公转需要相对定位的容器 */
  position: relative;
}

/* v1.4 早期 user 拍板：删圆环轨道（.dolphin-orbit / .dolphin-orbit__ring 全删） */

/* 海豚 emoji 容器：公转（v1.4 user 拍板 · 第四轮）
 *
 * 关键设计：
 *   - 删自转 + 删圆环：v1.4 早期 user 拍板"圆环应该移除"
 *   - 公转 = transform translate 沿 12px 半径圆周 8 步变化
 *   - 头朝右（emoji 默认），公转期间不翻转
 *   - 视觉是"🐬 绕着 emoji 自己位置的小圈跑步"
 *   - v1.4 中期：海豚大小减半（emoji 48 → 24，wrapper 64 → 32）
 */
.dolphin-emoji-wrap {
  position: absolute;
  z-index: 1;
  /* v1.4 中期 user 拍板：海豚大小减半（64 → 32） */
  width: 32px;
  height: 32px;
  /* 默认在 inner 中心 */
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 公转 = transform translate 沿圆周位移（emoji 自身不旋转） */
  animation: dolphin-orbit 4s linear infinite;
}

.dolphin-emoji {
  /* v1.4 中期：海豚大小减半 · 48px → 24px */
  font-size: 24px;
  line-height: 1;
  /* 不上 text-shadow：emoji 本身是位图，加 shadow 会糊 */
  user-select: none;
  -webkit-user-select: none;
  /* 内层 span 独立 transform 栈，承接上下浮动（不冲突 wrapper 的公转） */
  animation: dolphin-bob 1.2s ease-in-out infinite;
  display: inline-block;
}

/* 海豚气泡：跟 emoji 一起公转 + 错峰浮动（v1.4 早期：放在 wrapper 内）
 * v1.4 中期：海豚缩小后气泡等比缩（top/left 比例调整） */
.dolphin-bubble {
  position: absolute;
  /* emoji 容器 32x32 内，气泡放在 emoji 头部（上方偏左） */
  top: 2px;
  left: 6px;
  animation: dolphin-bubble 1.6s ease-in-out infinite;
  animation-delay: 0.2s;
}

.dolphin-bubble__dot {
  fill: var(--color-info);
  opacity: 0.7;
}

/* v1.4 倒数第二轮 user 拍板：删"加载中…"文字 · .dolphin-overlay__text 样式同时清理 */

/* ============= 动画 =============
 * v1.4 早期修正：删 dolphin-spin 自转 · 改 dolphin-orbit 公转
 * 海豚沿圆环轨道（r=36 viewBox / 实际 ~43px）走一圈，4s linear
 * 头朝右（emoji 默认方向）不翻转 —— 视觉是"🐬 沿大圈跑步"
 */

/* 公转：8 步 keyframes，角度 0°/45°/90°/.../315°
 * 圆心在 .dolphin-overlay__inner 中心
 * v1.4 中期：海豚大小减半（emoji 32px），公转半径 24 → 12
 * 0°  = 右侧 (+12, 0)
 * 45° = 右上 (+9, -9)   ← y 向上为负，sin(45)*12 ≈ 8.5 取 9
 * 90° = 上方 (0, -12)
 * 135°= 左上 (-9, -9)
 * 180°= 左侧 (-12, 0)
 * 225°= 左下 (-9, +9)
 * 270°= 下方 (0, +12)
 * 315°= 右下 (+9, +9)
 */
@keyframes dolphin-orbit {
  0%   { transform: translate(12px, 0); }
  12.5%{ transform: translate(9px, -9px); }
  25%  { transform: translate(0, -12px); }
  37.5%{ transform: translate(-9px, -9px); }
  50%  { transform: translate(-12px, 0); }
  62.5%{ transform: translate(-9px, 9px); }
  75%  { transform: translate(0, 12px); }
  87.5%{ transform: translate(9px, 9px); }
  100% { transform: translate(12px, 0); }
}

/* 上下浮动：4px 范围 · 1.2s 周期 · ease-in-out
 * 注：dolphin-bob 跟 dolphin-orbit 都用 transform 属性——会冲突！
 * 解法：把 dolphin-bob 移到 .dolphin-emoji 内层 span（独立 transform 栈），
 * 见 .dolphin-emoji { animation: dolphin-bob ... } 同步改
 */
@keyframes dolphin-bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-4px);
  }
}

/* 圆环不再旋转 · v1.4 user 拍板：圈静止，删 @keyframes dolphin-orbit-spin */

/* 气泡错峰浮动：1.6s · 略大范围 · delay 200ms */
@keyframes dolphin-bubble {
  0%,
  100% {
    transform: translateY(0) scale(1);
    opacity: 0.7;
  }
  50% {
    transform: translateY(-6px) scale(1.15);
    opacity: 1;
  }
}

/* ============= 入场过渡（200ms）============= */
.dolphin-fade-enter-active,
.dolphin-fade-leave-active {
  transition: opacity 200ms var(--ease);
}

.dolphin-fade-enter-from,
.dolphin-fade-leave-to {
  opacity: 0;
}

/* ============= a11y: prefers-reduced-motion =============
 * 尊重系统级"减少动画"偏好：停转但保留静态展示 + 文案
 * （CSS @media (prefers-reduced-motion: reduce) 标准语法）
 */
@media (prefers-reduced-motion: reduce) {
  /* v1.4 早期：dolphin-emoji-wrap 走公转（不是自转），dolphin-emoji 走浮动 */
  .dolphin-emoji-wrap,
  .dolphin-emoji,
  .dolphin-bubble {
    animation: none !important;
  }
  /* 退场过渡也加速到 0ms，避免晕动症 */
  .dolphin-fade-enter-active,
  .dolphin-fade-leave-active {
    transition: none;
  }
}
</style>
