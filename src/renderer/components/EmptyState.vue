<script setup lang="ts">
/**
 * EmptyState —— 空状态展示（带可选 CTA）
 *
 * 设计（OVERRIDE §本项目专属规则 #8 a11y）：
 *   - 插画区 + 主文案 + 副文案 + 可选 CTA
 *   - 颜色 + 图标 + 文字三重编码（避免只靠颜色）
 *   - 图标用 lucide-vue-next（无 emoji，跟 OVERRIDE 一致）
 */
import { Inbox } from 'lucide-vue-next';

interface Props {
  /** 主标题（一句话） */
  title: string;
  /** 副标题（补充说明） */
  description?: string;
  /** CTA 按钮文字（不传 = 不显示按钮） */
  actionLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  actionLabel: '',
});

const emit = defineEmits<{
  (e: 'action'): void;
}>();

function onAction(): void {
  emit('action');
}
</script>

<template>
  <div class="empty">
    <div class="empty__icon" :title="props.title">
      <slot name="icon">
        <Inbox :size="48" :stroke-width="1.5" aria-hidden="true" />
      </slot>
    </div>
      <h3 class="empty__title">{{ props.title }}</h3>
    <p v-if="props.description" class="empty__description">{{ props.description }}</p>
    <button v-if="props.actionLabel" type="button" class="empty__action" @click="onAction">
      {{ props.actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-7) var(--space-5);
  gap: var(--space-3);
  color: var(--color-text-secondary);
  text-align: center;
  min-height: 200px;
}

.empty__icon {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.empty__title {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.empty__description {
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  max-width: 360px;
  margin: 0;
}

.empty__action {
  margin-top: var(--space-3);
  padding: 8px 16px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-radius: var(--radius-sm);
  font-weight: 500;
  font-size: var(--font-md);
  cursor: pointer;
  box-shadow:
    0 0 0 1px var(--color-primary-active),
    0 0 16px var(--color-primary-glow);
  transition:
    background var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}

.empty__action:hover {
  background: var(--color-primary-hover);
}

.empty__action:active {
  background: var(--color-primary-active);
  transform: translateY(1px);
}
</style>
