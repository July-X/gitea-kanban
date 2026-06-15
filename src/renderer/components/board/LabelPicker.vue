<script setup lang="ts">
/**
 * LabelPicker —— 绑 label 子弹窗（plan_25cc4562 Task D · BoardView 重构）
 *
 * 设计（v1.1）：
 * - 列出 gitea 仓库里所有 label（boardStore.labelsByProject）
 * - 已绑的 label 标"已绑"+ disable；其他点 → 触发绑
 * - v1.1 风格：每个 label 一行，颜色点 + 名 + 状态（"已绑" / "+ 绑"）
 *
 * 通信：props + emit
 *   - props.open       : 是否打开
 *   - props.column     : 当前列（决定哪些 label 算"已绑"）
 *   - props.labels     : 项目级 label 全集
 *   - props.binding    : 绑 label 时的 loading 态
 *   - emit('update:open')    : 关闭
 *   - emit('bind-label', { id, name }) : 点"+ 绑"
 */
import { X } from 'lucide-vue-next';
import type { ColumnDto, IssueLabelDto } from '../../../main/ipc/schema.js';

interface Props {
  open: boolean;
  column: ColumnDto | null;
  labels: IssueLabelDto[];
  binding: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'bind-label', payload: { id: number; name: string }): void;
}>();

function close(): void {
  emit('update:open', false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="modal-overlay" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" aria-label="绑定标签">
        <header class="modal__header">
          <h2 class="modal__title">绑定标签到 {{ props.column ? props.column.title : '' }}</h2>
          <button type="button" class="modal__close" :aria-label="'关闭'" @click="close">
            <X :size="16" :stroke-width="2" />
          </button>
        </header>
        <div class="modal__body">
          <p class="muted">
            gitea 仓库里所有标签都在这里;勾上 = 绑到当前列,议题带这个标签就会进此列
          </p>
          <ul class="modal__label-list">
            <li v-for="lab in props.labels" :key="lab.id">
              <button
                type="button"
                class="modal__label-item"
                :class="{
                  'modal__label-item--bound':
                    props.column &&
                    props.column.labels &&
                    props.column.labels.some((l) => l.id === lab.id),
                }"
                :disabled="
                  props.binding ||
                  !!(props.column &&
                    props.column.labels &&
                    props.column.labels.some((l) => l.id === lab.id))
                "
                @click="emit('bind-label', { id: lab.id, name: lab.name })"
              >
                <span class="modal__label-dot" :style="{ background: lab.color || '#888' }" />
                <span class="modal__label-name">{{ lab.name }}</span>
                <span
                  v-if="
                    props.column &&
                    props.column.labels &&
                    props.column.labels.some((l) => l.id === lab.id)
                  "
                  class="modal__label-state"
                >
                  已绑
                </span>
                <span v-else class="modal__label-state modal__label-state--add">+ 绑</span>
              </button>
            </li>
          </ul>
        </div>
        <footer class="modal__footer">
          <button type="button" class="modal__btn modal__btn--ghost" @click="close">关闭</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
