<script setup lang="ts">
/**
 * Toast —— 全局提示 UI 组件（**纯渲染**，不持有状态）
 *
 * 设计：
 *   - 状态 + 控制 API 拆到 lib/toast.ts（可被 main.ts 动态 import）
 *   - 本组件只 import { toast, showToast, dismissToast, TOAST_ICONS } 订阅
 *   - type: success / info / warn / error
 *   - 颜色 + 图标 + 文字三重编码（OVERRIDE §本项目专属规则 #8 a11y）
 */
import { toast, dismissToast, TOAST_ICONS } from '@renderer/lib/toast';

function onDismiss(): void {
  dismissToast();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="toast">
      <div
        v-if="toast"
        :key="toast.message"
        class="toast"
        :class="`toast--${toast.type} ${toast.persistent ? 'toast--persistent' : ''}`"
        role="status"
        :aria-live="toast.persistent ? 'assertive' : 'polite'"
        @click="onDismiss"
      >
        <span class="toast__icon" aria-hidden="true">
          <component :is="TOAST_ICONS[toast.type]" :size="20" :stroke-width="2" />
        </span>
        <div class="toast__body">
          <div class="toast__message">{{ toast.message }}</div>
          <div v-if="toast.description" class="toast__description">{{ toast.description }}</div>
        </div>
        <button
          type="button"
          class="toast__close"
          aria-label="关闭"
          title="关闭"
          @click.stop="onDismiss"
        >
          ×
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.toast {
  position: fixed;
  top: var(--space-4);
  right: var(--space-4);
  z-index: var(--z-toast);
  min-width: 280px;
  max-width: 420px;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  border-left: 3px solid var(--color-info);
  cursor: pointer;
}

.toast--success { border-left-color: var(--color-success); }
.toast--success .toast__icon { color: var(--color-success); }
.toast--info { border-left-color: var(--color-info); }
.toast--info .toast__icon { color: var(--color-info); }
.toast--warn { border-left-color: var(--color-warning); }
.toast--warn .toast__icon { color: var(--color-warning); }
.toast--error { border-left-color: var(--color-danger); }
.toast--error .toast__icon { color: var(--color-danger); }

.toast__icon {
  color: var(--color-info);
  flex-shrink: 0;
  margin-top: 2px;
}

.toast__body {
  flex: 1;
  min-width: 0;
}

.toast__message {
  font-size: var(--font-md);
  font-weight: 500;
  color: var(--color-text);
  line-height: var(--line-tight);
  /* 多行消息（gitea 真实原因 + 字段名）可保留换行 */
  white-space: pre-line;
  word-break: break-word;
}

.toast__description {
  margin-top: var(--space-1);
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  line-height: var(--line-base);
}

.toast--persistent {
  border-left-width: 4px;
  box-shadow: var(--shadow-lg), 0 0 0 1px var(--color-danger-soft);
}

.toast__close {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-lg);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  min-width: 22px;
}

.toast__close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    transform var(--t-base) var(--ease),
    opacity var(--t-base) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  transform: translateX(20px);
  opacity: 0;
}
</style>
