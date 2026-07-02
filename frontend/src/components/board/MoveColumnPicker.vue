<script setup lang="ts">
/**
 * @deprecated v0.6+ 软废弃：仍保留以便回滚。导航栏已移除"看板"入口。
 */
/**
 * MoveColumnPicker —— 换列目标菜单（v1.3 BoardView 重构（拆 7 子组件））
 *
 * 设计（v1 按钮式换列兜底）：
 * - 顶部：标题"把 #X 挪到…" / "把 #X 归到…"
 * - 列表：所有可选目标列（current 列 disable + 标"当前"）
 * - 底部：hint 文案（"换列 = ..." / "归类 = ..."）
 *
 * 与 ConfirmDialog / LabelPicker / ColumnMenu 区别：体积小、走全屏 overlay + 中央弹层
 * 的"menu 形态"（不是 modal 形态），视觉上沿用原 BoardView.move-menu 样式
 * （Teleport 到 body 后的全局 class .move-menu-overlay / .move-menu*）。
 *
 * 通信：props + emit
 *   - props.open           : 是否打开
 *   - props.issueIndex     : 当前 issue 的 index（标题用）
 *   - props.columns        : 候选列（移动菜单 = 全部；归类菜单 = 仅绑 label 的列）
 *   - props.fromColumnId   : 当前所在列（移动菜单用，标"当前"）
 *   - props.mode           : 'move'（换列）| 'assign'（归类）
 *   - props.emptyHint      : mode='assign' 时没有可选列时的提示
 *   - emit('update:open')  : 关闭
 *   - emit('pick', columnId) : 选中目标列
 */
import { X } from 'lucide-vue-next';
import type { ColumnDto } from '@renderer/types/dto';

interface Props {
  open: boolean;
  issueIndex: number | undefined;
  columns: ColumnDto[];
  fromColumnId: string | null;
  mode: 'move' | 'assign';
  emptyHint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  emptyHint: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'pick', columnId: string): void;
}>();

function close(): void {
  emit('update:open', false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="move-menu-overlay" @click.self="close">
      <div
        class="move-menu"
        role="dialog"
        aria-modal="true"
        :aria-label="props.mode === 'move' ? '选择目标列' : '未分类议题归到…'"
      >
        <header class="move-menu__header">
          <span class="move-menu__title">
            <template v-if="props.mode === 'move'">把 #{{ props.issueIndex }}挪到…</template>
            <template v-else>把 #{{ props.issueIndex }} 归到…</template>
          </span>
          <button type="button" class="move-menu__close" :aria-label="'关闭'" @click="close">
            <X :size="14" :stroke-width="2" />
          </button>
        </header>
        <ul class="move-menu__list">
          <li v-for="col in props.columns" :key="col.id">
            <button
              type="button"
              class="move-menu__item"
              :class="{
                'move-menu__item--current': col.id === props.fromColumnId,
              }"
              :disabled="col.id === props.fromColumnId"
              :title="props.mode === 'assign' ? `归到「${col.title}」` : ''"
              @click="emit('pick', col.id)"
            >
              <span class="move-menu__item-title">{{ col.title }}</span>
              <span
                v-if="props.mode === 'assign'"
                class="muted"
                style="font-size: 11px;"
              >
                {{ col.labels.map((l) => l.name).join(' · ') }}
              </span>
              <span v-if="col.id === props.fromColumnId" class="move-menu__item-tag">当前</span>
            </button>
          </li>
          <li v-if="props.mode === 'assign' && !props.columns.length">
            <p class="muted" style="padding: 8px 12px; font-size: 12px;">
              {{ props.emptyHint || '所有列都还没绑标签。请先给列绑定一个 Gitea 标签，归类才会生效。' }}
            </p>
          </li>
        </ul>
        <footer class="move-menu__footer">
          <span v-if="props.mode === 'move'" class="muted">
            换列 = 在 gitea端改议题标签（原子操作）
          </span>
          <span v-else class="muted">
            归类 = 给议题加上该列绑的第一个标签（gitea 端 addLabel 端点）
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
