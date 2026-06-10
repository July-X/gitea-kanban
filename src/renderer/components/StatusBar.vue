<script setup lang="ts">
/**
 * StatusBar —— 底部状态栏
 *
 * 设计：
 *   - 高度 28px（var(--statusbar-height)）
 *   - 左侧：连接状态 + 当前仓库上下文
 *   - 中部：占位 / 进度条
 *   - 右侧：当前用户 + 版本
 *   - 颜色 + 文字 + 图标三重编码（OVERRIDE §本项目专属规则 #8）
 *
 * AGENTS §8.5：离线降级不可省。gitea API 失败时**不**直接报"Network Error"，
 * 这里显著提示"当前为离线/缓存模式"。
 */
import { computed } from 'vue';
import { CircleCheck, CircleAlert, CircleSlash, KeyRound, Plug, User } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';

const auth = useAuthStore();
const repo = useRepoStore();

type ConnState = 'connected' | 'offline' | 'error' | 'unauthenticated';

const connState = computed<ConnState>(() => {
  if (auth.error && (auth.error.code === 'network_offline' || auth.error.code === 'gitea_error')) {
    return 'offline';
  }
  if (auth.error) return 'error';
  if (auth.isConnected) return 'connected';
  return 'unauthenticated';
});

const stateText = computed(() => {
  switch (connState.value) {
    case 'connected':
      return '已连接';
    case 'offline':
      return '离线模式（使用本地缓存）';
    case 'error':
      return '连接异常';
    case 'unauthenticated':
      return '未连接';
  }
});

const stateIcon = computed(() => {
  switch (connState.value) {
    case 'connected':
      return CircleCheck;
    case 'offline':
      return CircleSlash;
    case 'error':
      return CircleAlert;
    case 'unauthenticated':
      return Plug;
  }
});
</script>

<template>
  <footer class="statusbar" :data-state="connState" role="status" aria-live="polite">
    <div class="statusbar__left">
      <span class="statusbar__chip" :class="`statusbar__chip--${connState}`">
        <component :is="stateIcon" :size="12" :stroke-width="2.5" aria-hidden="true" />
        <span>{{ stateText }}</span>
      </span>
      <span v-if="auth.currentGiteaUrl" class="statusbar__url mono" :title="auth.currentGiteaUrl">
        {{ auth.currentGiteaUrl }}
      </span>
      <span v-if="repo.currentRepo" class="statusbar__repo">
        <KeyRound :size="12" :stroke-width="2" aria-hidden="true" />
        <span class="statusbar__repo-name">{{ repo.currentRepo.fullName }}</span>
      </span>
    </div>
    <div class="statusbar__right">
      <span v-if="auth.currentUser" class="statusbar__user">
        <User :size="12" :stroke-width="2" aria-hidden="true" />
        <span>{{ auth.currentUser.login }}</span>
      </span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  height: var(--statusbar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-3);
  background: var(--color-bg);
  border-top: 1px solid var(--color-divider);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  user-select: none;
}

.statusbar__left,
.statusbar__right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.statusbar__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
}

.statusbar__chip--connected {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.statusbar__chip--offline {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.statusbar__chip--error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.statusbar__url {
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}

.statusbar__repo,
.statusbar__user {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-secondary);
}

.statusbar__repo-name {
  font-weight: 500;
  color: var(--color-text);
}
</style>
