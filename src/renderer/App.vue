<script setup lang="ts">
/**
 * App.vue —— 根 SFC
 *
 * 设计（AGENTS §5.2 + 03-frontend §3）：
 *   - 单根 <AppShell>（NavRail + 主区 + StatusBar 三件套）
 *   - 全局 <Toast /> 挂在 body 层（Teleport 出去）
 *   - 不在 App 层做业务（业务在 view + store 里）
 *   - 被动轮询：每 N 分钟（settings 可配，默认 5min）拉一次仓库列表
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import AppShell from '@renderer/components/AppShell.vue';
import Toast from '@renderer/components/Toast.vue';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useSettingsStore } from '@renderer/stores/settings';

const auth = useAuthStore();
const repo = useRepoStore();
const settings = useSettingsStore();

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 启动 / 重新设置 interval 用的内部函数 */
function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!auth.isConnected) return; // 未连接就不拉
    void repo.loadRepos('', true).catch(() => {
      /* 静默：用户已经看到错误提示，轮询触发的错误不再弹 toast */
    });
  }, settings.pollingIntervalMs);
}

onMounted(async () => {
  // 启动时拉一次连接状态（让路由守卫能正确分流）
  try {
    await auth.refreshStatus();
  } catch {
    /* 错误已存到 auth.error，由 StatusBar 提示 */
  }
  // 启动被动轮询（连接后才有效，函数内已守卫）
  startPolling();
});

// 用户改了 polling interval → 重启 timer
watch(
  () => settings.pollingIntervalMs,
  () => startPolling(),
);

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <AppShell />
  <Toast />
</template>
