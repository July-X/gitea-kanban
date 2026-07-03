<script setup lang="ts">
/**
 * StatusBarPulse —— 底部状态栏加载动画
 *
 * 设计（v0.6.8 更新）：
 *   - 加载中：周期性从左侧产生一个波形脉冲，从左到右运动，到达右端后消失，然后重新从左侧产生
 *   - 加载完成：过渡到 MiniMax 声纹波形（5 段），5 秒后消散
 *
 * 状态机：
 *   - idle：不可见
 *   - pulsing：周期性波形脉冲从左到右运动
 *   - finishing：MiniMax 波形消散
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

const globalLoading = useGlobalLoadingStore();

type Phase = 'idle' | 'pulsing' | 'finishing';
const phase = ref<Phase>('idle');

let finishTimer: ReturnType<typeof setTimeout> | null = null;
let pulseTimer: ReturnType<typeof setTimeout> | null = null;
const pulseKey = ref(0);

/** 启动周期性脉冲 */
function startPulses(): void {
  // 清除现有定时器
  if (pulseTimer) {
    clearTimeout(pulseTimer);
    pulseTimer = null;
  }

  // 立即触发第一个脉冲
  triggerPulse();

  // 每 4 秒触发一个新脉冲
  pulseTimer = setInterval(() => {
    triggerPulse();
  }, 4000);
}

/** 触发单个脉冲 */
function triggerPulse(): void {
  pulseKey.value++;
}

/** 停止脉冲 */
function stopPulses(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

watch(
  () => globalLoading.visible,
  (visible) => {
    if (visible) {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
      phase.value = 'pulsing';
      startPulses();
    } else if (phase.value === 'pulsing') {
      phase.value = 'finishing';
      stopPulses();
      if (finishTimer) clearTimeout(finishTimer);
      finishTimer = setTimeout(() => {
        phase.value = 'idle';
        finishTimer = null;
      }, 5000);
    }
  },
);

onUnmounted(() => {
  stopPulses();
  if (finishTimer) clearTimeout(finishTimer);
});

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
</script>

<template>
  <Transition name="statusbar-pulse-fade">
    <div
      v-if="phase !== 'idle'"
      class="statusbar-pulse"
      :class="{
        'statusbar-pulse--pulsing': phase === 'pulsing',
        'statusbar-pulse--finishing': phase === 'finishing',
      }"
      :title="phase === 'pulsing' ? `加载中：${activeLabel}` : '加载完成'"
      role="status"
      :aria-label="phase === 'pulsing' ? `加载中：${activeLabel}` : '加载完成'"
    >
      <!-- 加载中：周期性波形脉冲 -->
      <div v-if="phase === 'pulsing'" class="statusbar-pulse__heartbeat" aria-hidden="true">
        <!-- 静态底线 -->
        <div class="statusbar-pulse__baseline"></div>
        <!-- 单个脉冲波形 -->
        <svg
          :key="pulseKey"
          class="statusbar-pulse__pulse"
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <filter id="pulseGlow">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <!-- 单个脉冲：从基线向上尖刺 -->
          <path
            d="M50,20 L50,2 L55,20 L60,20"
            fill="none"
            stroke="var(--color-primary)"
            stroke-width="3"
            stroke-linejoin="miter"
            filter="url(#pulseGlow)"
          />
        </svg>
      </div>

      <!-- 加载完成：MiniMax 波形消散 -->
      <div v-else class="statusbar-pulse__waveform" aria-hidden="true">
        <span class="statusbar-pulse__bar"></span>
        <span class="statusbar-pulse__bar"></span>
        <span class="statusbar-pulse__bar"></span>
        <span class="statusbar-pulse__bar"></span>
        <span class="statusbar-pulse__bar"></span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ===== 容器 ===== */
.statusbar-pulse {
  position: absolute;
  top: -8px;
  left: 0;
  right: 0;
  height: 8px;
  z-index: 1;
  pointer-events: auto;
  cursor: default;
}

/* ===== 加载中：波形脉冲 ===== */
.statusbar-pulse--pulsing {
  overflow: hidden;
}

.statusbar-pulse__heartbeat {
  position: absolute;
  inset: 0;
}

/*
 * 静态底线：始终显示，不被滚动波形覆盖
 */
.statusbar-pulse__baseline {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--color-primary);
  opacity: 0.4;
}

/*
 * 单个脉冲波形：从左侧产生，向右运动
 * 使用 CSS 动画实现从左到右的匀速运动
 */
.statusbar-pulse__pulse {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  animation: statusbar-pulse-move 4s linear forwards;
}

/*
 * 脉冲运动动画：从左侧移动到右侧
 * 0%   → 脉冲在左边缘（x=0）
 * 100% → 脉冲到达右边缘（x=100%）
 */
@keyframes statusbar-pulse-move {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100vw);
  }
}

/* ===== MiniMax 波形消散（加载完成） ===== */
.statusbar-pulse__waveform {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 24px;
  margin-top: -10px;
  animation: statusbar-waveform-disperse 5s ease-out forwards;
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

/* 整体消散：opacity 1→0 + 高度收缩到底线 */
@keyframes statusbar-waveform-disperse {
  0% {
    opacity: 1;
    transform: scaleY(1);
  }
  70% {
    opacity: 0.6;
    transform: scaleY(1);
  }
  100% {
    opacity: 0;
    transform: scaleY(0);
  }
}

/* ===== 进入/退出过渡 ===== */
.statusbar-pulse-fade-enter-active {
  transition: opacity 0.2s ease-out;
}
.statusbar-pulse-fade-leave-active {
  transition: opacity 0.3s ease-in;
}
.statusbar-pulse-fade-enter-from,
.statusbar-pulse-fade-leave-to {
  opacity: 0;
}
</style>
