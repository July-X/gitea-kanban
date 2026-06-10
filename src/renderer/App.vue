<script setup lang="ts">
/**
 * App.vue —— 根 SFC
 *
 * 设计（AGENTS §5.2 + 03-frontend §3）：
 *   - 单根 <AppShell>（NavRail + 主区 + StatusBar 三件套）
 *   - 全局 <Toast /> 挂在 body 层（Teleport 出去）
 *   - 不在 App 层做业务（业务在 view + store 里）
 */
import { onMounted } from 'vue';
import AppShell from '@renderer/components/AppShell.vue';
import Toast from '@renderer/components/Toast.vue';
import { useAuthStore } from '@renderer/stores/auth';

const auth = useAuthStore();

onMounted(async () => {
  // 启动时拉一次连接状态（让路由守卫能正确分流）
  try {
    await auth.refreshStatus();
  } catch {
    /* 错误已存到 auth.error，由 StatusBar 提示 */
  }
});
</script>

<template>
  <AppShell />
  <Toast />
</template>
