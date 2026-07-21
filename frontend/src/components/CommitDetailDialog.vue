<script setup lang="ts">
/**
 * CommitDetailDialog —— Git Graph commit 详情弹窗（薄壳）
 *
 * v2.9 重构：从 v1 的"自带所有 UI"改为"弹窗壳 + CommitDetailPanel"
 * - 这个文件只负责：Teleport overlay、关闭按钮、Esc 关闭、点遮罩关闭
 * - 真正的详情 UI 在 CommitDetailPanel.vue（与 TimelineNewView 的行下手风琴共用同一面板）
 */

import { ref, watch, onUnmounted, nextTick } from 'vue';
import { X } from 'lucide-vue-next';
import CommitDetailPanel from '@renderer/components/CommitDetailPanel.vue';
import type { BasicCommit } from '@renderer/components/CommitDetailPanel.vue';

interface Props {
  open: boolean;
  commit: BasicCommit | null;
  /** 当前项目 ID（用于 commitsGet 请求） */
  projectId: string | null;
  /** 平台类型（gitea / github），用于切换 "在 Gitea/GitHub 中打开" 的 tooltip */
  platform?: 'gitea' | 'github';
  /** Gitea 仓库地址（用于 "在 Gitea 打开" 按钮） */
  giteaRepoUrl?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

// ===== 弹窗控制 =====
const overlayRef = ref<HTMLDivElement | null>(null);

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      // 等下一帧 focus overlay（让 Esc 立即生效）
      await nextTick();
      overlayRef.value?.focus();
    }
  },
);

function close(): void {
  emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

// 全局 Escape 监听（Teleport 到 body 后需要手动捕获）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) {
    e.preventDefault();
    close();
  }
}
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      document.addEventListener('keydown', onGlobalKeydown);
    } else {
      document.removeEventListener('keydown', onGlobalKeydown);
    }
  },
);
onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.open && props.commit"
      ref="overlayRef"
      class="cd-overlay"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      @click.self="close"
      @keydown="onKeydown"
    >
      <div class="cd-dialog">
        <!-- 关闭按钮（弹窗自己用，panel 内不再重复放） -->
        <button
          type="button"
          class="cd-dialog__close"
          title="关闭"
          @click="close"
        >
          <X :size="14" />
        </button>

        <!-- 详情面板（dialog 变体） -->
        <CommitDetailPanel
          :commit="props.commit"
          :project-id="props.projectId"
          :platform="props.platform"
          :gitea-repo-url="props.giteaRepoUrl"
          variant="dialog"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ===== Overlay ===== */
.cd-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg-overlay, rgba(0, 0, 0, 0.45));
  z-index: var(--z-modal-overlay, 100);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-6, 24px) var(--space-4, 16px);
  animation: cdFadeIn 150ms ease-out;
  overflow-y: auto;
}

/* ===== Dialog ===== */
.cd-dialog {
  position: relative;
  background: var(--color-bg-elevated, #1a1d23);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.32));
  width: min(640px, 100%);
  max-height: calc(100vh - 38px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: cdSlideUp 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* 弹窗右上角关闭按钮（绝对定位，浮在 panel 之上） */
.cd-dialog__close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.cd-dialog__close:hover {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text);
}

/* ===== Animation ===== */
@keyframes cdFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cdSlideUp {
  from { transform: translateY(8px) scale(0.98); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .cd-overlay,
  .cd-dialog {
    animation: none;
  }
}
</style>
