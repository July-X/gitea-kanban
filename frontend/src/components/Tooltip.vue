<script setup lang="ts">
/**
 * Tooltip —— 轻量悬浮提示。
 *
 * 设计目标：
 *   - 鼠标悬停 trigger 一段时间后，在 trigger 上方居中弹出气泡
 *   - 鼠标移开立即消失
 *   - 主题色适配（用 var(--color-text) / var(--color-bg) 反色）
 *   - 不依赖外部 UI 库（项目目前未装 Radix / Headless）
 *
 * 用法：
 *   <Tooltip text="复制版本号">
 *     <button>...</button>
 *   </Tooltip>
 *
 * 可选 props：
 *   - delay: 显示延迟（默认 200ms，避免划过时闪烁）
 *   - placement: 'top' | 'bottom'（默认 top）
 */
import { onBeforeUnmount, ref } from 'vue';

interface Props {
  text: string;
  delay?: number;
  placement?: 'top' | 'bottom';
}

const props = withDefaults(defineProps<Props>(), {
  delay: 200,
  placement: 'top',
});

const triggerRef = ref<HTMLElement | null>(null);
const visible = ref(false);
const pos = ref({ x: 0, y: 0 });
let showTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function computePos(trigger: HTMLElement): { x: number; y: number } {
  const r = trigger.getBoundingClientRect();
  // 水平居中于 trigger；垂直在 trigger 上下 8px
  return {
    x: r.left + r.width / 2,
    y: props.placement === 'bottom' ? r.bottom + 8 : r.top - 8,
  };
}

function onEnter(e: MouseEvent): void {
  const trigger = e.currentTarget as HTMLElement;
  const from = e.relatedTarget as Node | null;
  // mouseover 在子元素间跨越时会冒泡触发——只在真正从 trigger 外部进入时才展示
  if (from && trigger.contains(from)) return;
  triggerRef.value = trigger;
  clearTimer();
  showTimer = setTimeout(() => {
    if (!triggerRef.value) return;
    pos.value = computePos(triggerRef.value);
    visible.value = true;
  }, props.delay);
}

function onLeave(e?: MouseEvent): void {
  const trigger = e?.currentTarget as HTMLElement | undefined;
  const to = e?.relatedTarget as Node | null | undefined;
  // 鼠标进入 trigger 的子元素时不要关闭
  if (trigger && to && trigger.contains(to)) return;
  clearTimer();
  visible.value = false;
  triggerRef.value = null;
}

function onFocus(e: FocusEvent): void {
  // 键盘聚焦时也展示提示（无障碍）—— focus 不冒泡，focusin 冒泡
  const trigger = e.currentTarget as HTMLElement;
  triggerRef.value = trigger;
  clearTimer();
  showTimer = setTimeout(() => {
    if (!triggerRef.value) return;
    pos.value = computePos(triggerRef.value);
    visible.value = true;
  }, props.delay);
}
function onBlur(): void {
  clearTimer();
  visible.value = false;
  triggerRef.value = null;
}

// 滚动 / 窗口变化时关闭（位置会失效）
function onScrollOrResize(): void {
  if (visible.value) onLeave();
}
window.addEventListener('scroll', onScrollOrResize, true);
window.addEventListener('resize', onScrollOrResize);

onBeforeUnmount(() => {
  clearTimer();
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
});
</script>

<template>
  <span
    class="tooltip-trigger"
    @mouseover="onEnter"
    @mouseout="onLeave"
    @focusin="onFocus"
    @focusout="onBlur"
  >
    <slot />
  </span>
  <Teleport to="body">
    <Transition name="tooltip">
      <div
        v-if="visible"
        class="tooltip-bubble"
        :class="`tooltip-bubble--${props.placement}`"
        :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        role="tooltip"
      >{{ text }}</div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tooltip-trigger {
  display: inline-flex;
}

.tooltip-bubble {
  position: fixed;
  transform: translate(-50%, -100%);
  background: var(--color-text);
  color: var(--color-bg);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  z-index: 2000;
  box-shadow: var(--shadow-md);
  font-weight: 500;
}

.tooltip-bubble--bottom {
  transform: translate(-50%, 0%);
}

.tooltip-enter-active,
.tooltip-leave-active {
  transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.tooltip-enter-from,
.tooltip-leave-to {
  opacity: 0;
  transform: translate(-50%, calc(-100% - 4px));
}
.tooltip-bubble--bottom.tooltip-enter-from,
.tooltip-bubble--bottom.tooltip-leave-to {
  transform: translate(-50%, 4px);
}
</style>
