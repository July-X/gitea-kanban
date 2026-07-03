<script setup lang="ts">
/**
 * StatusBarPulse —— 底部状态栏心跳脉冲加载动画
 *
 * 设计（user 拍板 2026-07-03）：
 *   - 位置：底部 StatusBar 上方（紧贴 StatusBar 顶边）
 *   - 加载中：心跳脉冲线从左到右发射，Gitea 绿色（#74B830 dark / #466B16 light）
 *       模拟心电图 / 心跳节律：快速上升 → 峰值 → 回落 → 短暂间歇 → 重复
 *       一条光带沿水平方向扫描，留下渐隐的拖尾
 *   - 加载完成：展示 MiniMax 波形 icon（4 段声纹条），5 秒后消散（opacity 1→0 + 高度收缩）
 *
 * 状态机：
 *   - idle：不可见
 *   - pulsing：心跳脉冲动画（受 globalLoading.visible 驱动）
 *   - finishing：波形消散动画（5s，从 pulsing 结束触发）
 *
 * 与 global-loading store 的关系：
 *   - 订阅 globalLoading.visible
 *   - visible: false→true → 进入 pulsing
 *   - visible: true→false → 进入 finishing，5s 后回 idle
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
      // 清除 finishing 定时器（如果还在 finishing 阶段又触发新加载）
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
      phase.value = 'pulsing';
    } else if (phase.value === 'pulsing') {
      // 从 pulsing 切换到 finishing
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
      <!-- 心跳脉冲层：loading 时显示 -->
      <div v-if="phase === 'pulsing'" class="statusbar-pulse__heartbeat" aria-hidden="true">
        <div class="statusbar-pulse__heartbeat-line"></div>
        <div class="statusbar-pulse__heartbeat-glow"></div>
      </div>

      <!-- 波形消散层：finishing 时显示 -->
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
  top: -2px; /* 紧贴 StatusBar 顶边上方 2px */
  left: 0;
  right: 0;
  height: 2px;
  z-index: 1;
  pointer-events: auto; /* 允许 tooltip */
  cursor: default;
}

/* ===== 心跳脉冲（加载中） ===== */
.statusbar-pulse--pulsing {
  overflow: hidden;
}

.statusbar-pulse__heartbeat {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/*
 * 心跳脉冲线：一条 Gitea 绿光带从左到右扫描
 * 用 linear-gradient 画一个"尖峰"形状，通过 background-position 动画实现平移
 * 颜色：dark=#74B830 / light=#466B16（与 --color-primary 一致）
 */
.statusbar-pulse__heartbeat-line {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    transparent 70%,
    var(--color-primary) 85%,
    #fff 90%, /* 峰值高亮（白点） */
    var(--color-primary) 95%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: statusbar-heartbeat-scan 1.2s ease-in-out infinite;
}

/*
 * 心跳光晕：在脉冲线后方提供柔和的辉光
 * 用 box-shadow 模拟 ECG 峰值的光晕扩散
 */
.statusbar-pulse__heartbeat-glow {
  position: absolute;
  top: -1px;
  left: 0;
  height: 4px;
  width: 100%;
  background: radial-gradient(
    ellipse 30% 100% at 50% 50%,
    color-mix(in srgb, var(--color-primary) 40%, transparent),
    transparent
  );
  background-size: 200% 100%;
  animation: statusbar-heartbeat-glow 1.2s ease-in-out infinite;
  filter: blur(1px);
}

/*
 * 心跳扫描动画：
 * 0%   → 光带在左侧（未进入）
 * 40%  → 光带到达中心（峰值）—— 模拟心跳 R 波
 * 60%  → 光带继续右行（回落）
 * 100% → 光带离开右侧，准备下一周期
 *
 * 速度曲线用 ease-in-out 模拟心跳的"快升慢落"
 */
@keyframes statusbar-heartbeat-scan {
  0% {
    background-position: 200% 0;
    opacity: 0.6;
  }
  40% {
    background-position: 50% 0;
    opacity: 1;
  }
  60% {
    background-position: 50% 0;
    opacity: 1;
  }
  100% {
    background-position: -100% 0;
    opacity: 0.6;
  }
}

@keyframes statusbar-heartbeat-glow {
  0% {
    background-position: 200% 0;
    opacity: 0.3;
  }
  40% {
    background-position: 50% 0;
    opacity: 0.8;
  }
  60% {
    background-position: 50% 0;
    opacity: 0.8;
  }
  100% {
    background-position: -100% 0;
    opacity: 0.3;
  }
}

/* ===== MiniMax 波形消散（加载完成） ===== */
.statusbar-pulse__waveform {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 16px;
  margin-top: -7px; /* 居中对齐到 StatusBar 顶边 */
  animation: statusbar-waveform-disperse 5s ease-out forwards;
}

.statusbar-pulse__bar {
  display: block;
  width: 2px;
  background: var(--color-primary);
  border-radius: 1px;
  animation: statusbar-waveform-bar 0.6s ease-in-out infinite alternate;
}

/* 5 段声纹条，不同高度 + 错峰浮动 */
.statusbar-pulse__bar:nth-child(1) {
  height: 6px;
  animation-delay: 0s;
}
.statusbar-pulse__bar:nth-child(2) {
  height: 12px;
  animation-delay: 0.1s;
}
.statusbar-pulse__bar:nth-child(3) {
  height: 16px;
  animation-delay: 0.2s;
}
.statusbar-pulse__bar:nth-child(4) {
  height: 10px;
  animation-delay: 0.15s;
}
.statusbar-pulse__bar:nth-child(5) {
  height: 8px;
  animation-delay: 0.05s;
}

/* 波形条上下浮动 */
@keyframes statusbar-waveform-bar {
  0% {
    transform: scaleY(0.5);
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
