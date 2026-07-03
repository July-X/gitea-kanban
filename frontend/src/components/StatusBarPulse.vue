<script setup lang="ts">
/**
 * StatusBarPulse —— 底部状态栏加载动画
 *
 * 设计（v0.6.5 更新）：
 *   - 加载中：单峰尖刺 ^ 从左到右运动，到达右端后重新从左开始，循环往复
 *   - 加载完成：过渡到 MiniMax 声纹波形（5 段），5 秒后消散
 *
 * 状态机：
 *   - idle：不可见
 *   - pulsing：单峰尖刺从左到右循环
 *   - finishing：MiniMax 波形消散
 */
import { computed, ref, watch } from 'vue';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

const globalLoading = useGlobalLoadingStore();

type Phase = 'idle' | 'pulsing' | 'finishing';
const phase = ref<Phase>('idle');

let finishTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => globalLoading.visible,
  (visible) => {
    if (visible) {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
      phase.value = 'pulsing';
    } else if (phase.value === 'pulsing') {
      phase.value = 'finishing';
      if (finishTimer) clearTimeout(finishTimer);
      finishTimer = setTimeout(() => {
        phase.value = 'idle';
        finishTimer = null;
      }, 5000);
    }
  },
);

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
      <!-- 加载中：单峰尖刺从左到右运动 -->
      <div v-if="phase === 'pulsing'" class="statusbar-pulse__heartbeat" aria-hidden="true">
        <div class="statusbar-pulse__spike"></div>
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
  top: -4px;
  left: 0;
  right: 0;
  height: 4px;
  z-index: 1;
  pointer-events: auto;
  cursor: default;
}

/* ===== 加载中：单峰尖刺 ===== */
.statusbar-pulse--pulsing {
  overflow: hidden;
}

.statusbar-pulse__heartbeat {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/*
 * 单峰尖刺：CSS 三角形 ^ 从左到右运动
 * 使用 border 技巧绘制三角形，通过 left 百分比定位
 */
.statusbar-pulse__spike {
  position: absolute;
  top: 50%;
  left: 0;
  width: 0;
  height: 0;
  border-left: 9px solid transparent;
  border-right: 9px solid transparent;
  border-bottom: 15px solid var(--color-primary);
  transform: translate(-50%, -50%);
  animation: statusbar-spike-move 3s ease-in-out infinite;
}

/*
 * 单峰尖刺运动动画：
 * 0%   → 尖刺在左边缘外（不可见）
 * 5%   → 尖刺进入左边缘
 * 50%  → 尖刺到达中心
 * 95%  → 尖刺到达右边缘
 * 100% → 尖刺离开右边缘，瞬间回到左边缘（循环）
 */
@keyframes statusbar-spike-move {
  0% {
    left: -10px;
    opacity: 0;
  }
  5% {
    opacity: 1;
  }
  50% {
    left: 50%;
    opacity: 1;
  }
  95% {
    opacity: 1;
  }
  100% {
    left: calc(100% + 10px);
    opacity: 0;
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
