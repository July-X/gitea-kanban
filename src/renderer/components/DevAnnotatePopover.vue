<!--
  DevAnnotatePopover —— dev 模式注解 popover

  设计：
    - 单例组件，订阅 lib/dev-annotate 的 annotation ref
    - Teleport 到 body 避免被父元素 overflow/transform 截断
    - 位置策略：优先放在 anchor 右下方，溢出视口时自动翻面（左/上）
    - Esc / 点击外部 / 点关闭按钮 都能 dismiss

  生命周期：
    - 永远在 App.vue 里挂载（v-if="isDev"），生产构建 isDev=false → v-if 整段消除

  样式：
    - scoped + design token 配色（警告色 dev-only 语义，醒目但不刺眼）
    - 用 dev class 包一层方便 CSS 命中
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { annotation, annotationAnchor, dismissAnnotation } from '@renderer/lib/dev-annotate';

const popoverEl = ref<HTMLElement | null>(null);

interface PopoverPosition {
  top: number;
  left: number;
  /** popover 落在 anchor 哪个方向（'br' = bottom-right, 'bl', 'tr', 'tl'） */
  placement: 'br' | 'bl' | 'tr' | 'tl';
}

const POPOVER_W_ESTIMATE = 360;
const POPOVER_H_ESTIMATE = 200;
const GAP = 8;

/**
 * 根据 anchor 位置 + 视口尺寸计算 popover 最佳落点
 * 优先级：br > bl > tr > tl
 */
function computePosition(anchor: HTMLElement): PopoverPosition {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 默认 br（anchor 右下）
  let top = r.bottom + GAP;
  let left = r.right;
  let placement: PopoverPosition['placement'] = 'br';

  // 右边超出 → 改成 bl（anchor 左下，popover 从 right 往左延伸）
  if (left + POPOVER_W_ESTIMATE > vw) {
    left = r.left;
    placement = 'bl';
  }
  // 底部超出 → 翻到 anchor 上方
  if (top + POPOVER_H_ESTIMATE > vh) {
    top = r.top - GAP;
    if (placement === 'br') placement = 'tr';
    else placement = 'tl';
  }
  return { top, left, placement };
}

const position = computed<PopoverPosition | null>(() => {
  if (!annotation.value || !annotationAnchor.value) return null;
  return computePosition(annotationAnchor.value);
});

/** Esc 关闭 + 点击 popover 外关闭 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && annotation.value) {
    e.preventDefault();
    dismissAnnotation();
  }
}

function onDocumentClick(e: MouseEvent): void {
  if (!annotation.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  // 1. popover 内部不关
  if (popoverEl.value && popoverEl.value.contains(target)) return;
  // 2. ! 触发器本身不关（点击其他 ! 应该先关再开，但同一点击不应被拦）
  if (annotationAnchor.value && annotationAnchor.value.contains(target)) return;
  // 其他位置都关
  dismissAnnotation();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  // mousedown 早于 click 触发，能更好避免冒泡时序问题
  document.addEventListener('mousedown', onDocumentClick, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('mousedown', onDocumentClick, true);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="annotation && position"
      ref="popoverEl"
      class="dev-annotate-popover"
      :class="`dev-annotate-popover--${position.placement}`"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      role="dialog"
      aria-label="数据来源注解（仅开发模式）"
    >
      <header class="dev-annotate-popover__head">
        <span class="dev-annotate-popover__title">数据来源（仅开发）</span>
        <button
          type="button"
          class="dev-annotate-popover__close"
          aria-label="关闭"
          @click="dismissAnnotation"
        >×</button>
      </header>
      <dl class="dev-annotate-popover__body">
        <template v-if="annotation.web">
          <dt>Gitea 网页</dt>
          <dd><code>{{ annotation.web }}</code></dd>
        </template>
        <template v-if="annotation.api">
          <dt>Gitea API</dt>
          <dd><code>{{ annotation.api }}</code></dd>
        </template>
        <template v-if="annotation.ipc">
          <dt>本地 IPC</dt>
          <dd><code>{{ annotation.ipc }}</code></dd>
        </template>
        <template v-if="annotation.notes">
          <dt>备注</dt>
          <dd>{{ annotation.notes }}</dd>
        </template>
      </dl>
    </div>
  </Teleport>
</template>

<style scoped>
.dev-annotate-popover {
  position: fixed;
  z-index: 9999;
  min-width: 280px;
  max-width: 420px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: var(--font-sm);
  color: var(--color-text);
  /* dev 模式专属样式：左边一道警告色竖条强化"这是 dev 工具"语义 */
  border-left-width: 4px;
}

.dev-annotate-popover__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px 6px;
  border-bottom: 1px dashed var(--color-divider);
}

.dev-annotate-popover__title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-warning);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.dev-annotate-popover__close {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.dev-annotate-popover__close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.dev-annotate-popover__body {
  margin: 0;
  padding: 8px 10px 10px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
}

.dev-annotate-popover__body dt {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 500;
  align-self: start;
  padding-top: 1px;
}

.dev-annotate-popover__body dd {
  margin: 0;
  font-family: var(--font-mono-stack);
  font-size: var(--font-xs);
  color: var(--color-text);
  word-break: break-all;
  line-height: var(--line-base);
}

.dev-annotate-popover__body code {
  font-family: var(--font-mono-stack);
  font-size: inherit;
  color: inherit;
  background: transparent;
  padding: 0;
}
</style>
