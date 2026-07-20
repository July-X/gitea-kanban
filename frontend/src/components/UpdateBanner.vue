<script setup lang="ts">
/**
 * UpdateBanner.vue —— AppShell 顶部 banner
 *
 * v0.8.0 引入。当 useUpdate().status.kind === 'available' / 'downloading' / 'downloaded'
 * 时显示一行 banner + 按钮。
 *
 * 设计目标（对齐 Gitea web 一行布局，AGENTS §9.1 零术语）：
 *   - 高度 40px
 *   - 图标：🔔 Bell
 *   - 文案："发现新版本 v0.8.0（当前 v0.7.19）"
 *   - 操作：下载 / 稍后提醒 / 查看更新日志 / 重启以安装
 *   - 进度条：100% 宽度细线 + "已下载 23.4MB / 45.6MB"
 *   - macOS 未签名 build：「前往下载页」替代「下载」
 *
 * 注意：
 *   - 不要阻塞 mount（check 在 AppShell onMounted 异步调用）
 *   - 用户点「下载」后按钮立即变「下载中...（不可点）」，符合 AGENTS §14.3
 */
import { computed } from 'vue';
import { useUpdate, formatBytes } from '@renderer/composables/useUpdate';

const { status, check, download, install, openDownloadPage, dismiss } = useUpdate();

// 只在 available / downloading / verifying / downloaded 时显示 banner
const showBanner = computed(() => {
  const k = status.value.kind;
  return k === 'available' || k === 'downloading' || k === 'verifying' || k === 'downloaded';
});

const info = computed(() => {
  const k = status.value.kind;
  if (k === 'available' || k === 'downloading' || k === 'verifying' || k === 'downloaded') {
    return status.value.info;
  }
  return null;
});

const isMacUnsigned = computed(() => info.value?.manualOnly === true);

const progressPercent = computed(() => {
  const k = status.value.kind;
  if (k !== 'downloading') return 0;
  const { received, total } = status.value;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((received / total) * 100));
});

const progressText = computed(() => {
  const k = status.value.kind;
  if (k === 'downloading') {
    const { received, total } = status.value;
    if (total > 0) {
      return `${formatBytes(received)} / ${formatBytes(total)}`;
    }
    return formatBytes(received);
  }
  if (k === 'verifying') {
    return '正在校验...';
  }
  return '';
});

const bannerText = computed(() => {
  const i = info.value;
  if (!i) return '';
  if (i.manualOnly && i.manualReason) {
    return `发现新版本 ${i.latest}（当前 ${i.current}）— ${i.manualReason}`;
  }
  return `发现新版本 ${i.latest}（当前 ${i.current}）`;
});

function onDownloadClick(): void {
  if (isMacUnsigned.value) {
    void openDownloadPage();
    return;
  }
  void download();
}

function onInstallClick(): void {
  void install();
}

function onDismissClick(): void {
  dismiss();
}

function onRefreshClick(): void {
  void check();
}
</script>

<template>
  <div v-if="showBanner" class="update-banner">
    <div class="update-banner__main">
      <span class="update-banner__icon">🔔</span>
      <span class="update-banner__text">{{ bannerText }}</span>

      <template v-if="status.kind === 'available'">
        <button
          v-if="!isMacUnsigned"
          class="update-banner__btn update-banner__btn--primary"
          @click="onDownloadClick"
        >
          下载
        </button>
        <button
          v-else
          class="update-banner__btn update-banner__btn--primary"
          @click="onDownloadClick"
        >
          前往下载页
        </button>
        <button class="update-banner__btn" @click="onDismissClick">
          稍后提醒
        </button>
        <button v-if="info?.notes" class="update-banner__btn update-banner__btn--ghost">
          查看更新日志
        </button>
      </template>

      <template v-else-if="status.kind === 'downloading' || status.kind === 'verifying'">
        <span class="update-banner__progress-text">{{ progressText }}</span>
        <button class="update-banner__btn" disabled>下载中...</button>
      </template>

      <template v-else-if="status.kind === 'downloaded'">
        <button
          class="update-banner__btn update-banner__btn--primary"
          @click="onInstallClick"
        >
          {{ isMacUnsigned ? '前往下载页' : '重启以安装' }}
        </button>
        <button class="update-banner__btn" @click="onDismissClick">
          稍后
        </button>
      </template>

      <button
        class="update-banner__btn update-banner__btn--refresh"
        title="重新检查"
        @click="onRefreshClick"
      >
        ↻
      </button>
    </div>

    <div
      v-if="status.kind === 'downloading' || status.kind === 'verifying'"
      class="update-banner__progress-bar"
    >
      <div
        class="update-banner__progress-fill"
        :style="{ width: progressPercent + '%' }"
      />
    </div>
  </div>
</template>

<style scoped>
.update-banner {
  display: flex;
  flex-direction: column;
  background: var(--color-info, #1a73e8);
  color: #fff;
  font-size: 13px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  animation: slide-down 0.2s ease-out;
}

.update-banner__main {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: 8px 16px;
  min-height: 40px;
}

.update-banner__icon {
  font-size: 14px;
}

.update-banner__text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.update-banner__btn {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: #fff;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s ease;
}

.update-banner__btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.update-banner__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.update-banner__btn--primary {
  background: #fff;
  color: var(--color-info, #1a73e8);
  border-color: #fff;
  font-weight: 500;
}

.update-banner__btn--primary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.92);
}

.update-banner__btn--ghost {
  border-color: transparent;
}

.update-banner__btn--refresh {
  border-color: transparent;
  padding: 4px 8px;
}

.update-banner__progress-text {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  opacity: 0.9;
  white-space: nowrap;
}

.update-banner__progress-bar {
  height: 2px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}

.update-banner__progress-fill {
  height: 100%;
  background: #fff;
  transition: width 0.3s ease-out;
}

@keyframes slide-down {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
