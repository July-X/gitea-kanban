<script setup lang="ts">
/**
 * Toast —— 全局提示 UI 组件（**纯渲染**，不持有状态）
 *
 * 设计：
 *   - 状态 + 控制 API 拆到 lib/toast.ts（可被 main.ts 动态 import）
 *   - 本组件只 import { toast, showToast, dismissToast, TOAST_ICONS } 订阅
 *   - type: success / info / warn / error
 *   - 颜色 + 图标 + 文字三重编码（OVERRIDE §本项目专属规则 #8 a11y）
 *
 * v1.4 增强（P0-1 autoInit 透明化落地）：
 *   - 加 actions 按钮区（最多 2 个），点击后调 onClick，默认 dismissAfter=true
 *   - 移除 body 整块 @click 关闭（避免误触 + 避免 action 按钮 click 穿透关闭）
 *   - 只 × 按钮关闭（明确语义）
 */
import { toast, dismissToast, TOAST_ICONS } from '@renderer/lib/toast';

function onDismiss(): void {
  dismissToast();
}

/**
 * v1.4：action 按钮点击
 * - 调 onClick（异步也行，await 完才决定是否关闭）
 * - dismissAfter 决定是否关 toast（默认 true）
 */
async function onActionClick(action: (typeof toast.value) extends infer T
  ? T extends { actions: infer A }
    ? A extends Array<infer Item>
      ? Item
      : never
    : never
  : never): Promise<void> {
  try {
    await action.onClick();
  } catch {
    // 用户写错 onClick 也不应影响 toast 行为（不崩 toast）
  }
  if (action.dismissAfter !== false) {
    dismissToast();
  }
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
      >
        <span class="toast__icon" aria-hidden="true">
          <component :is="TOAST_ICONS[toast.type]" :size="20" :stroke-width="2" />
        </span>
        <div class="toast__body">
          <div class="toast__message">{{ toast.message }}</div>
          <div v-if="toast.description" class="toast__description">
            {{ toast.description }}
          </div>
          <!--
            v1.4：action 按钮区（最多 2 个）
            · variant=primary 走主色（默认）
            · variant=ghost 走透明边框（"不再提示"等次要动作）
            · onClick 是用户传入的回调，错误不外泄
          -->
          <div v-if="toast.actions && toast.actions.length > 0" class="toast__actions">
            <button
              v-for="(action, idx) in toast.actions"
              :key="`${toast.message}-${idx}`"
              type="button"
              class="toast__action"
              :class="`toast__action--${action.variant ?? 'primary'}`"
              @click.stop="onActionClick(action)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="toast__close"
          aria-label="关闭"
          title="关闭"
          @click="onDismiss"
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
  /* v1.4：移除 body 整块 cursor:pointer + @click onDismiss
   * 原因：action 按钮不能 click 穿透到 toast 关闭（破坏 P0-1 wireframe 流程）
   * 关闭路径显式化：× 按钮 / action 按钮（dismissAfter=true） */
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

/* v1.4 新增：actions 按钮区 */
.toast__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
  /* 不让按钮被 message/description 的 word-break 拉到变形 */
  flex-wrap: wrap;
}

.toast__action {
  font-family: inherit;
  font-size: var(--font-sm);
  font-weight: 500;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  /* 默认 120ms 过渡，跟项目其他按钮一致（避免 jank） */
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease);
}

/* primary variant：主色背景 + 主文字色（v1.1 三件套：1px 主色描边 + 12% 外环 glow） */
.toast__action--primary {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
}

.toast__action--primary:hover {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

/* ghost variant：透明 + 弱描边（次要动作） */
.toast__action--ghost {
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-divider);
}

.toast__action--ghost:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
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

