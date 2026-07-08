<script setup lang="ts">
/**
 * ConfirmDialog —— 危险操作二次确认弹窗
 *
 * 设计（AGENTS §8.3 + OVERRIDE §本项目专属规则 #2 二次确认）：
 *   - 默认要求用户在输入框打"确认关键词"才能点确认（防误触）
 *   - 标题用"人话"说明会怎样（如"将删除分支 xxx，影响 3 个合并请求"）
 *   - 危险操作按钮 = 强调色（橙）+ 主按钮样式 + 1px 描边
 *   - Esc = 取消，Enter = 确认（仅在 keyword 正确时）
 *   - 支持 v-model:open 双向控制
 */
import { computed, nextTick, ref, watch } from 'vue';
import { AlertTriangle } from 'lucide-vue-next';
import { checkCanConfirm } from '@renderer/lib/confirm';

interface Props {
  /** 是否打开 */
  open: boolean;
  /** 标题（人话） */
  title: string;
  /** 详细说明（写明将影响什么） */
  description: string;
  /** 确认按钮文字 */
  confirmLabel?: string;
  /** 取消按钮文字 */
  cancelLabel?: string;
  /** 需要的确认关键词（不传 = 不要求输入） */
  confirmKeyword?: string;
  /** 危险级别（控制按钮颜色 + icon） */
  danger?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  confirmLabel: '确认',
  cancelLabel: '取消',
  confirmKeyword: '',
  danger: true,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const inputText = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

/** 委托给纯函数 lib/confirm（测试可独立覆盖） */
const canConfirm = computed(() => checkCanConfirm(inputText.value, props.confirmKeyword));

watch(
  () => props.open,
  (open) => {
    if (open) {
      inputText.value = '';
      nextTick(() => inputRef.value?.focus());
    }
  },
);

function close(): void {
  emit('update:open', false);
  emit('cancel');
}

function confirm(): void {
  if (!canConfirm.value) return;
  emit('confirm');
  emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Enter' && canConfirm.value) {
    e.preventDefault();
    confirm();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="dialog-overlay" role="dialog" aria-modal="true" @keydown="onKeydown">
      <div class="dialog" :class="{ 'dialog--danger': props.danger }">
        <header class="dialog__header">
          <span v-if="props.danger" class="dialog__icon" aria-hidden="true">
            <AlertTriangle :size="20" :stroke-width="2" />
          </span>
          <h2 class="dialog__title">{{ props.title }}</h2>
        </header>
        <p class="dialog__description">{{ props.description }}</p>
        <!-- 默认 slot：在 description 和确认按钮之间插入自定义内容 -->
        <slot />
        <div v-if="props.confirmKeyword" class="dialog__keyword">
          <label class="dialog__keyword-label">
            请输入 <code class="mono">{{ props.confirmKeyword }}</code> 以确认操作
          </label>
          <input
            ref="inputRef"
            v-model="inputText"
            type="text"
            class="dialog__keyword-input"
            :placeholder="props.confirmKeyword"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <footer class="dialog__footer">
          <button type="button" class="dialog__btn dialog__btn--cancel" @click="close">
            {{ props.cancelLabel }}
          </button>
          <button
            type="button"
            class="dialog__btn"
            :class="props.danger ? 'dialog__btn--danger' : 'dialog__btn--primary'"
            :disabled="!canConfirm"
            @click="confirm"
          >
            {{ props.confirmLabel }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg-overlay);
  z-index: var(--z-modal-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--t-base) var(--ease);
}

.dialog {
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-5);
  min-width: 360px;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  animation: slideUp var(--t-base) var(--ease);
}

.dialog--danger {
  border-top: 2px solid var(--color-accent);
}

.dialog__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dialog__icon {
  color: var(--color-accent);
  display: inline-flex;
  align-items: center;
}

.dialog__title {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.dialog__description {
  font-size: var(--font-md);
  color: var(--color-text-secondary);
  line-height: var(--line-relaxed);
  margin: 0;
}

.dialog__keyword {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.dialog__keyword-label {
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
}

.dialog__keyword-label code {
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--color-accent);
  font-size: var(--font-sm);
}

.dialog__keyword-input {
  width: 100%;
}

.dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.dialog__btn {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
  font-weight: 500;
  cursor: pointer;
  min-width: 80px;
  transition:
    background var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}

.dialog__btn--cancel {
  background: var(--color-bg);
  color: var(--color-text);
}

.dialog__btn--cancel:hover {
  background: var(--color-bg-hover);
}

.dialog__btn--primary {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  /* v1.6 去 v1.1 主色外环 glow · 走单层柔和阴影 */
  box-shadow: var(--shadow-sm);
}

.dialog__btn--primary:hover {
  background: var(--color-primary-hover);
}

.dialog__btn--primary:disabled {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.dialog__btn--danger {
  background: var(--color-accent);
  color: var(--color-text-inverse);
  box-shadow:
    0 0 0 1px var(--color-accent),
    0 0 12px var(--color-accent-soft);
}

.dialog__btn--danger:hover {
  background: var(--color-accent-hover);
}

.dialog__btn--danger:disabled {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { transform: translateY(8px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
