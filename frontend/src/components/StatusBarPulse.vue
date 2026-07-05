<script setup lang="ts">
/**
 * StatusBarPulse —— 底部状态栏加载动画
 *
 * 设计（v0.6.16 更新）：
 *   - 加载中：footer 背景色呼吸灯效果（透明度周期变化）
 *   - 加载结束：
 *     1. 呼吸灯渐变消失（0.4s ease-out，Q弹柔和）
 *     2. 声纹波形显示，延后 2 秒消散
 *
 * 状态机：
 *   - idle：不可见
 *   - pulsing：footer 背景呼吸灯
 *   - finishing：呼吸灯**渐变消失** → 声纹波形显示 2 秒后消散
 *
 * v0.7.0 优化：
 *   - 旧实现用 v-if 移除呼吸灯背景层（瞬间消失，用户感知突兀）
 *   - 新实现用 v-show + --fading class：
 *     * 保留 DOM，靠 CSS transition + animation: none 把 opacity 平滑过渡到 0
 *     * 0.4s ease-out 渐变消失，匹配声纹波形的"完成"质感
 *   - showPulseLayer 包含 'pulsing' + 'finishing' 两个阶段，确保渐变有 DOM 渲染
 */
import { computed, ref, watch } from 'vue';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

const globalLoading = useGlobalLoadingStore();

type Phase = 'idle' | 'pulsing' | 'finishing';
const phase = ref<Phase>('idle');

let pulseTimer: ReturnType<typeof setTimeout> | null = null;
let waveformTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => globalLoading.visible,
  (visible) => {
    if (visible) {
      // 清除所有定时器
      if (pulseTimer) {
        clearTimeout(pulseTimer);
        pulseTimer = null;
      }
      if (waveformTimer) {
        clearTimeout(waveformTimer);
        waveformTimer = null;
      }
      phase.value = 'pulsing';
    } else if (phase.value === 'pulsing') {
      phase.value = 'finishing';

      // 加载逻辑完成 → 等所有 namespace 完成后启动消散流程
      if (globalLoading.active.size === 0) {
        startDisperse();
      } else {
        const stop = watch(
          () => globalLoading.active.size,
          (size) => {
            if (size === 0) {
              stop();
              startDisperse();
            }
          },
        );
      }
    }
  },
);

/**
 * 启动消散流程：
 * 1. 呼吸灯渐变消失（finishing 阶段，v-show 保留 DOM, --fading class + transition 0.4s 平滑过渡）
 * 2. 声纹波形继续显示 2 秒后消失
 *
 * v0.7.0 优化：把"立即消失"改为"渐变消失"，避免突兀的视觉跳变
 *  - finishing 阶段：layer 用 --fading class（animation: none 停掉呼吸动画 + opacity: 0）
 *  - .statusbar-pulse__layer 上的 transition: opacity 0.4s ease-out 平滑过渡
 *  - 2 秒后切到 idle，v-show=false 移除 DOM
 */
function startDisperse(): void {
  // 呼吸灯渐变消失（由 --fading class + transition: opacity 接手）
  // 声纹波形延后 2 秒消散
  waveformTimer = setTimeout(() => {
    phase.value = 'idle';
    waveformTimer = null;
  }, 2000);
}

/** 当前活跃的 namespace 列表（tooltip 用） */
const activeNamespaces = computed(() => {
  return Array.from(globalLoading.active);
});

/** 中文命名空间标签 */
const nsLabel: Record<string, string> = {
  auth: '鉴权',
  board: '看板',
  repo: '仓库',
  member: '成员',
  branch: '分支',
  pull: '合并请求',
  myCard: '我的卡片',
  merges: '合并详情',
  timeline: 'Git Graph',
};

const activeLabel = computed(() => {
  return activeNamespaces.value.map((ns) => nsLabel[ns] ?? ns).join(' / ');
});

/**
 * v0.7.0：呼吸灯背景层显示范围
 *  - pulsing：显示（呼吸动画）
 *  - finishing：仍显示，但加 --fading class 触发 opacity 平滑过渡到 0
 *  - idle：不显示（v-show=false）
 *
 * 旧版只包含 pulsing → finishing 时 v-if 立即移除 DOM，没有过渡。
 * 新版包含 pulsing + finishing → 用 transition + animation: none 渐变消失。
 */
const showPulseLayer = computed(() => phase.value === 'pulsing' || phase.value === 'finishing');

/** 是否显示声纹波形：pulsing 和 finishing 都显示 */
const showWaveform = computed(() => phase.value === 'pulsing' || phase.value === 'finishing');
</script>

<template>
  <!--
    v0.7.0 呼吸灯背景层：用 v-show 保留 DOM，靠 --fading class 渐变消失
    - pulsing：纯主色背景 + opacity 周期变化（呼吸节奏）
    - finishing：呼吸动画停止（animation: none），opacity 从当前值平滑过渡到 0
    - idle：v-show=false 移除
  -->
  <div
    v-show="showPulseLayer"
    class="statusbar-pulse__layer"
    :class="{
      'statusbar-pulse__layer--pulsing': phase === 'pulsing',
      'statusbar-pulse__layer--fading': phase === 'finishing',
    }"
    :title="phase === 'pulsing' ? `加载中：${activeLabel}` : '加载完成'"
    role="status"
    :aria-label="phase === 'pulsing' ? `加载中：${activeLabel}` : '加载完成'"
  ></div>

  <!--
    声纹波形层：pulsing 和 finishing 都显示
    - 加载中：与呼吸灯一起显示
    - 加载结束：呼吸灯渐变消失后声纹波形继续显示，延后 2 秒消散
  -->
  <div
    v-if="showWaveform"
    class="statusbar-pulse__waveform"
    :class="{ 'statusbar-pulse__waveform--finishing': phase === 'finishing' }"
    aria-hidden="true"
  >
    <span class="statusbar-pulse__bar"></span>
    <span class="statusbar-pulse__bar"></span>
    <span class="statusbar-pulse__bar"></span>
    <span class="statusbar-pulse__bar"></span>
    <span class="statusbar-pulse__bar"></span>
  </div>
</template>

<style scoped>
/* ===== 加载动画层 ===== */
.statusbar-pulse__layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: 0;
  /*
   * v0.7.0：transition 加长到 0.4s ease-out
   * - 旧版 0.2s 偏快，配合 --fading class 渐变消失时显得急促
   * - 0.4s ease-out 与波形条上下浮动 0.6s 同步，"完成"质感更柔和
   */
  transition: opacity 0.4s ease-out;
}

/*
 * 呼吸灯效果（pulsing）：纯主色背景 + opacity 周期变化
 * - 整条 footer 显示主色背景
 * - 透明度在 0.2 ↔ 0.5 之间周期性变化（呼吸节奏）
 *
 * 主题适配：
 * - dark 主题：opacity 直接控制亮度（无 mix-blend-mode）
 * - light 主题：用 color-mix 降低饱和度，避免 multiply 蒙版效果
 */
.statusbar-pulse__layer--pulsing {
  background: var(--color-primary);
  animation: statusbar-breath 2s ease-in-out infinite;
}

/* light 主题：使用浅色主色，避免 multiply 蒙版 */
:global([data-theme='light']) .statusbar-pulse__layer--pulsing {
  background: color-mix(in srgb, var(--color-primary) 50%, var(--color-bg-elevated));
}

/*
 * v0.7.0：finishing 阶段 — 呼吸灯渐变消失
 * - animation: none 停掉 statusbar-breath，opacity 冻结在当前动画值
 * - opacity: 0 配合 .statusbar-pulse__layer 上的 transition: opacity 0.4s ease-out
 *   平滑过渡到完全透明
 * - 不立即消失，给用户"加载完成"的视觉确认
 */
.statusbar-pulse__layer--fading {
  animation: none;
  opacity: 0;
}

/*
 * 呼吸灯动画：opacity 周期变化（类似呼吸节奏）
 * 0%   → 最低透明度（吸气）
 * 50%  → 最高透明度（呼气峰值）
 * 100% → 最低透明度（吸气结束）
 */
@keyframes statusbar-breath {
  0%,
  100% {
    opacity: 0.2;
  }
  50% {
    opacity: 0.5;
  }
}

/* ===== 声纹波形（pulsing + finishing 都显示） ===== */
.statusbar-pulse__waveform {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  z-index: 1;
  pointer-events: none;
}

/*
 * finishing 阶段：声纹波形单独显示在背景层之上
 * 2 秒后随 phase 切到 idle 一起消失（v-if 控制）
 */
.statusbar-pulse__waveform--finishing {
  /* 单独显示时的样式可以微调，比如更亮 */
}

.statusbar-pulse__bar {
  display: block;
  width: 3px;
  background: var(--color-primary);
  border-radius: 1.5px;
  animation: statusbar-waveform-bar 0.6s ease-in-out infinite alternate;
}

/* 5 段声纹条，不同高度 + 错峰浮动 */
.statusbar-pulse__bar:nth-child(1) {
  height: 10px;
  animation-delay: 0s;
}
.statusbar-pulse__bar:nth-child(2) {
  height: 18px;
  animation-delay: 0.1s;
}
.statusbar-pulse__bar:nth-child(3) {
  height: 24px;
  animation-delay: 0.2s;
}
.statusbar-pulse__bar:nth-child(4) {
  height: 16px;
  animation-delay: 0.15s;
}
.statusbar-pulse__bar:nth-child(5) {
  height: 12px;
  animation-delay: 0.05s;
}

/* 波形条上下浮动 */
@keyframes statusbar-waveform-bar {
  0% {
    transform: scaleY(0.4);
  }
  100% {
    transform: scaleY(1);
  }
}
</style>