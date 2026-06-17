<script setup lang="ts">
/**
 * StatusBar —— 底部状态栏
 *
 * 设计（v1.4 · 任务 #statusbar-picker 重构）：
 *   - 高度 33px（var(--statusbar-height)）+5px，留出 dropdown 触发器 + 浮层空间
 *   - 左侧：连接状态 + 当前仓库 dropdown + gitea URL + 刷新按钮 + 主题切换按钮
 *   - 右侧：当前用户（avatar + login）+ 退出登录
 *   - 仓库切换为**全局唯一切换入口**：本组件 dropdown 是状态栏唯一 picker，
 *     BoardTopbar / MyCardsView / TimelineView / MergesView / MembersView 内的 picker 全删,
 *     后续所有视图共用此仓库上下文（v1.4 拍板"全局保存,后续操作都针对这个仓库"）
 *   - 颜色 + 文字 + 图标三重编码（OVERRIDE §本项目专属规则 #8）
 *
 * 主题按钮（v1.2 · tech-refine §15.1 入口 1）：
 *   - 点一下 cycle: 暗色 → 浅色 → 暗色
 *   - 调用 useUiStore.applyTheme(nextThemeInCycle(currentTheme)) —— store 同步改
 *     state/DOM/localStorage + 异步 IPC set（不阻塞 UI）
 *
 * 仓库 dropdown：
 *   - trigger：图标 + 仓库 fullName + chevron，点击切换显隐
 *   - 面板：搜索框 + 仓库列表（v-if filtered.length）+ 空态
 *   - 选中：调 useBoardActions.selectProject(r)（= addProject → selectProject →
 *     router.replace(query.project=fullName) → loadBoard）—— 与原 BoardTopbar picker 行为一致
 *   - 已加为 project 的项显示"已加入" chip
 *
 * AGENTS §8.5：离线降级不可省。gitea API 失败时**不**直接报"Network Error"，
 * 这里显著提示"当前为离线/缓存模式"。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  CircleCheck,
  CircleAlert,
  CircleSlash,
  ChevronDown,
  KeyRound,
  Plug,
  RefreshCw,
  LogOut,
  Package,
  Palette,
  Search,
  User,
} from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useSettingsStore } from '@renderer/stores/settings';
import { useUiStore, nextThemeInCycle, THEME_DISPLAY_NAME } from '@renderer/stores/ui';
import { useBoardActions } from '@renderer/composables/useBoardActions';
import { useRouter } from 'vue-router';
import { showToast } from '@renderer/lib/toast';
import { formatLastUpdated } from '@renderer/lib/last-updated';
import EmptyState from '@renderer/components/EmptyState.vue';

const auth = useAuthStore();
const repo = useRepoStore();
const settings = useSettingsStore();
const ui = useUiStore();
const router = useRouter();

/**
 * 仓库切换统一走 useBoardActions.selectProject —— 与原 BoardTopbar picker 行为一致
 * （addProject → selectProject → router.replace(query.project=fullName) → loadBoard）。
 * activeProjectId 用 repo.currentProjectId 的 computed 引用，避免 watch 重复注册。
 */
const activeProjectId = computed<string | null>(() => repo.currentProjectId);
const { selectProject } = useBoardActions({
  newIssueDrafts: {},
  activeProjectId,
});

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

// ===== 仓库 dropdown（v1.4 任务 #statusbar-picker） =====

const pickerOpen = ref(false);
const pickerSearch = ref('');

/**
 * 过滤后的仓库列表（按 fullName / description 模糊匹配，大小写不敏感）
 * 取 repo.repos 全量，不限 isProject —— 用户可以从"未加入看板"的仓库里临时选一个切过去看
 */
const filteredRepos = computed(() => {
  const q = pickerSearch.value.trim().toLowerCase();
  if (!q) return repo.repos;
  return repo.repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
  );
});

/** 点击 trigger 切换下拉：第一次打开自动 focus 搜索框 */
const pickerEl = ref<HTMLElement | null>(null);
const searchInputEl = ref<HTMLInputElement | null>(null);

function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value;
  if (pickerOpen.value) {
    pickerSearch.value = '';
    // 等下拉挂载完再 focus
    requestAnimationFrame(() => searchInputEl.value?.focus());
  }
}

async function pickRepo(r: { fullName: string; owner: string; name: string }): Promise<void> {
  // RepoDto 的 id 类型是 number；这里把 fullName 凑回去走 useBoardActions.selectProject
  const found = repo.repos.find((x) => x.fullName === r.fullName);
  if (!found) return;
  pickerOpen.value = false;
  pickerSearch.value = '';
  await selectProject(found);
}

/** 点击下拉外部关闭（用 capture + document 监听,避免点 trigger 自己又触发 toggle） */
function onDocClick(e: MouseEvent): void {
  if (!pickerOpen.value) return;
  const target = e.target as Node | null;
  if (target && pickerEl.value && !pickerEl.value.contains(target)) {
    pickerOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
});

/**
 * v1.4 任务 #statusbar-picker：App.vue 在登录完成 / 启动已登录未选仓库时设 true
 * 这里监听 → 自动打开 picker;用户在 picker 里点了仓库 → store 调 consumeGuideOnConnect 清掉
 * （防止后续 watch 误触发）
 */
watch(
  () => repo.guideOnConnect,
  (now) => {
    if (now && !pickerOpen.value) {
      togglePicker();
      // 引导完成 = picker 打开即消费（用户关掉也算消费过）
      repo.consumeGuideOnConnect();
    }
  },
);

// ===== 刷新 / 主题 / 退出 =====

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
    repo.selectProject(null); // 清当前仓库（v1.4：登出时连带清空）
    // v1.4 任务 #statusbar-persist:登出时清掉持久化仓库
    // 让下次登录引导重新选,不"复活"已退账号的旧选择
    void repo.persistLastSelected(null, null, '');
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

      <!-- 仓库 dropdown trigger（v1.4 任务 #statusbar-picker：全局唯一 picker 入口） -->
      <div
        v-if="auth.isConnected"
        ref="pickerEl"
        class="statusbar__picker"
        :class="{ 'statusbar__picker--open': pickerOpen, 'statusbar__picker--empty': !repo.currentRepo }"
      >
        <button
          type="button"
          class="statusbar__picker-trigger"
          :title="repo.currentRepo ? `切换仓库（当前：${repo.currentRepo.fullName}）` : '选择仓库'"
          @click="togglePicker"
        >
          <KeyRound :size="12" :stroke-width="2" aria-hidden="true" />
          <span class="statusbar__repo-name">
            {{ repo.currentRepo?.fullName ?? '请选择仓库' }}
          </span>
          <ChevronDown :size="12" :stroke-width="2" aria-hidden="true" />
        </button>

        <div v-if="pickerOpen" class="statusbar__dropdown" role="dialog" aria-label="选择仓库">
          <div class="statusbar__dropdown-search">
            <Search :size="12" :stroke-width="2" aria-hidden="true" />
            <input
              ref="searchInputEl"
              v-model="pickerSearch"
              type="text"
              class="statusbar__dropdown-input"
              placeholder="搜索仓库（按名称 / 描述）"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <ul v-if="filteredRepos.length" class="statusbar__dropdown-list">
            <li v-for="r in filteredRepos" :key="r.id">
              <button
                type="button"
                class="statusbar__dropdown-item"
                :class="{
                  'statusbar__dropdown-item--active': r.fullName === repo.currentRepo?.fullName,
                }"
                @click="pickRepo(r)"
              >
                <span class="statusbar__dropdown-item-name">{{ r.fullName }}</span>
                <span v-if="r.isProject" class="statusbar__dropdown-item-tag">已加入</span>
              </button>
            </li>
          </ul>
          <div v-else-if="repo.repos.length === 0" class="statusbar__dropdown-empty">
            <EmptyState
              title="仓库列表为空"
              description="刷新一下试试，或去 gitea 添加新仓库"
            />
          </div>
          <EmptyState v-else title="没有匹配的仓库" description="试试别的搜索词" />
        </div>
      </div>

      <span v-if="auth.currentGiteaUrl" class="statusbar__url mono" :title="auth.currentGiteaUrl">
        {{ auth.currentGiteaUrl }}
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
      <span v-if="repo.repos.length" class="statusbar__repo-count">
        <Package :size="12" :stroke-width="2" aria-hidden="true" />
        <span>共 {{ repo.repos.length }} 个</span>
      </span>
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

.statusbar__user,
.statusbar__repo-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-secondary);
}

.statusbar__repo-count {
  font-feature-settings: 'tnum';
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

/* ===== 仓库 dropdown（v1.4 任务 #statusbar-picker）=====
 * 视觉对齐 BoardTopbar picker：
 *   - trigger：浅 chip 底 + 主色边 hover
 *   - 面板：背景 elevated + 圆角 + 主色光晕阴影，向**上**弹（bottom: 100%）
 *   - 列表项：hover bg-hover、当前项 primary-soft + primary
 *   - 整体高度适配 33px 状态栏：trigger 紧凑，padding 2-6px
 */
.statusbar__picker {
  position: relative;
}

.statusbar__picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  border: 1px solid transparent;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: var(--radius-sm);
  cursor: pointer;
  max-width: 320px;
  min-width: 0;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}

.statusbar__picker-trigger:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
}

.statusbar__picker--open .statusbar__picker-trigger {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: color-mix(in srgb, var(--color-primary) 50%, transparent);
  box-shadow: 0 0 0 2px var(--color-primary-soft);
}

.statusbar__picker--empty .statusbar__picker-trigger {
  color: var(--color-text-muted);
  border-color: var(--color-divider);
  border-style: dashed;
}

.statusbar__repo-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.statusbar__picker--empty .statusbar__repo-name {
  color: var(--color-text-muted);
  font-weight: 400;
}

.statusbar__dropdown {
  position: absolute;
  bottom: calc(100% + 6px); /* 向上弹,贴 trigger 顶部留 6px 缝 */
  left: 0;
  width: 360px;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-nav);
  overflow: hidden;
}

.statusbar__dropdown-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-muted);
}

.statusbar__dropdown-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
  font-size: var(--font-sm);
}

.statusbar__dropdown-input:focus {
  background: transparent;
  box-shadow: none;
}

.statusbar__dropdown-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1);
  list-style: none;
  margin: 0;
}

.statusbar__dropdown-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  background: transparent;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}

.statusbar__dropdown-item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.statusbar__dropdown-item--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.statusbar__dropdown-item--active:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.statusbar__dropdown-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statusbar__dropdown-item-tag {
  font-size: var(--font-xs);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}

.statusbar__dropdown-empty {
  padding: var(--space-3);
}
</style>
