<script setup lang="ts">
/**
 * StatusBar —— 底部状态栏
 *
 * 设计：
 *   - 高度 28px（var(--statusbar-height)）
 *   - 左侧：连接状态 + 当前仓库上下文 + **刷新按钮** + **主题切换按钮**
 *   - 右侧：当前用户（avatar + login）+ **退出登录**
 *   - 颜色 + 文字 + 图标三重编码（OVERRIDE §本项目专属规则 #8）
 *
 * 主题按钮（v1.2 · tech-refine §15.1 入口 1）：
 *   - 点一下 cycle: 暗色 → 浅色 → 暗色
 *   - 调用 useUiStore.applyTheme(nextThemeInCycle(currentTheme)) —— store 同步改
 *     state/DOM/localStorage + 异步 IPC set（不阻塞 UI）
 *
 * AGENTS §8.5：离线降级不可省。gitea API 失败时**不**直接报"Network Error"，
 * 这里显著提示"当前为离线/缓存模式"。
 */
import { computed } from 'vue';
import { CircleCheck, CircleAlert, CircleSlash, KeyRound, Plug, RefreshCw, LogOut, Palette, User } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useSettingsStore } from '@renderer/stores/settings';
import { useUiStore, nextThemeInCycle, THEME_DISPLAY_NAME } from '@renderer/stores/ui';
import { useRouter } from 'vue-router';
import { showToast } from '@renderer/lib/toast';
import { formatLastUpdated } from '@renderer/lib/last-updated';

const auth = useAuthStore();
const repo = useRepoStore();
const settings = useSettingsStore();
const ui = useUiStore();
const router = useRouter();

/** 主题简称（按钮文字用，跟 LogOut 风格对称：图标 + 短文字） */
const THEME_SHORT_LABEL: Record<string, string> = {
  dark: '暗',
  light: '亮',
};

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
    case 'offline': {
      // v1.4 polish：离线时显示缓存数据年龄（用户最想知道"看到的是多旧的数据"）
      const age = formatLastUpdated();
      return age ? `离线 · 缓存来自 ${age}` : '离线模式（使用本地缓存）';
    }
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

/** 主动刷新：拉最新仓库列表（gitea API + 本地 project 标记聚合） */
async function onRefreshClick(): Promise<void> {
  try {
    await repo.loadRepos('', true);
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: '刷新失败', description: err.messageText ?? '请稍后重试' });
  }
}

/** 主题切换：cycle 到下一个主题（按钮文字显示当前，title 显示完整名 + 切换提示） */
async function onThemeCycleClick(): Promise<void> {
  const next = nextThemeInCycle(ui.currentTheme);
  await ui.applyTheme(next);
}

/** 退出当前 gitea 账号（清 keychain + 内存），跳回 /auth */
async function onLogoutClick(): Promise<void> {
  const url = auth.currentGiteaUrl;
  if (!url) return;
  try {
    await auth.disconnect(url);
    repo.repos.length = 0; // 清空本地仓库缓存
    showToast({ type: 'success', message: '已退出登录' });
    await router.push('/auth');
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: '退出失败', description: err.messageText ?? '请稍后重试' });
  }
}
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
      <button
        v-if="auth.isConnected"
        type="button"
        class="statusbar__action"
        :disabled="repo.loading"
        :title="`刷新仓库（每 ${Math.round(settings.pollingIntervalMs / 60000)} 分钟自动）`"
        @click="onRefreshClick"
      >
        <RefreshCw :size="12" :stroke-width="2" :class="{ 'statusbar__action--spin': repo.loading }" />
      </button>
      <button
        type="button"
        class="statusbar__action"
        :title="`当前：${THEME_DISPLAY_NAME[ui.currentTheme]}（点切换）`"
        @click="onThemeCycleClick"
      >
        <Palette :size="12" :stroke-width="2" aria-hidden="true" />
        <span>{{ THEME_SHORT_LABEL[ui.currentTheme] ?? ui.currentTheme }}</span>
      </button>
    </div>
    <div class="statusbar__right">
      <span v-if="auth.currentUser" class="statusbar__user">
        <img
          v-if="auth.currentUser.avatarUrl"
          :src="auth.currentUser.avatarUrl"
          :alt="`${auth.currentUser.login} 头像`"
          class="statusbar__avatar"
        />
        <User v-else :size="12" :stroke-width="2" aria-hidden="true" />
        <span>{{ auth.currentUser.login }}</span>
      </span>
      <button
        v-if="auth.isConnected"
        type="button"
        class="statusbar__action statusbar__action--danger"
        title="退出当前 gitea 账号"
        @click="onLogoutClick"
      >
        <LogOut :size="12" :stroke-width="2" />
        <span>退出</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-3);
  /* v1.1.2 改：半透明让 grid 透出（HUD 风），半透明由 AppShell .shell__status 容器提供 */
  background: transparent;
  border-top: 1px solid color-mix(in srgb, var(--color-divider) 60%, transparent);
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

.statusbar__avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
  vertical-align: middle;
}

.statusbar__action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.statusbar__action:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.statusbar__action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.statusbar__action--danger:hover:not(:disabled) {
  color: var(--color-danger);
}
.statusbar__action--spin {
  animation: statusbar-spin 1s linear infinite;
}
@keyframes statusbar-spin {
  to {
    transform: rotate(360deg);
  }
}

.statusbar__repo-name {
  font-weight: 500;
  color: var(--color-text);
}
</style>
