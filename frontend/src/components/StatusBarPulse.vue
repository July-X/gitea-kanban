<script setup lang="ts">
/**
 * StatusBarPulse —— 底部状态栏加载动画
 *
 * 设计（v0.6.16 更新）：
 *   - 加载中：footer 背景色呼吸灯效果（透明度周期变化）
 *   - 加载结束：
 *     1. 呼吸灯立即消失
 *     2. 声纹波形显示，延后 2 秒消散
 *
 * 状态机：
 *   - idle：不可见
 *   - pulsing：footer 背景呼吸灯
 *   - finishing：呼吸灯立即消散 → 声纹波形显示 2 秒后消散
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
 * 1. 呼吸灯立即消失（finishing 阶段立即移除 background 层）
 * 2. 声纹波形继续显示 2 秒后消失
 */
function startDisperse(): void {
  // 1. 呼吸灯立即消失：phase 切到 finishing 后不再渲染背景层
  // 2. 声纹波形延后 2 秒消散
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

/** 是否显示呼吸灯背景层：仅 pulsing 显示，finishing 不显示（立即消失） */
const showPulseLayer = computed(() => phase.value === 'pulsing');

/** 是否显示声纹波形：pulsing 和 finishing 都显示 */
const showWaveform = computed(() => phase.value === 'pulsing' || phase.value === 'finishing');
</script>

<template>
  <!--
    呼吸灯背景层：仅在 pulsing 阶段显示
    - 加载中：纯主色背景 + opacity 周期变化（呼吸节奏）
    - 加载结束瞬间：立即消失
  -->
  <div
    v-if="showPulseLayer"
    class="statusbar-pulse__layer statusbar-pulse__layer--pulsing"
    :title="`加载中：${activeLabel}`"
    role="status"
    :aria-label="`加载中：${activeLabel}`"
  ></div>

  <!--
    声纹波形层：pulsing 和 finishing 都显示
    - 加载中：与呼吸灯一起显示
    - 加载结束：呼吸灯消失后声纹波形继续显示，延后 2 秒消散
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
  transition: opacity 0.2s ease-out;
}

/*
 * 呼吸灯效果（pulsing）：纯主色背景 + opacity 周期变化
 * - 整条 footer 显示主色背景
 * - 透明度在 0.2 ↔ 0.5 之间周期性变化（呼吸节奏）
 * - 仅在 pulsing 阶段显示，加载结束瞬间立即消失
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