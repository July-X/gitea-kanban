<script setup lang="ts">
/**
 * StatusBar —— 底部状态栏
 *
 * v1.4 · 任务 #statusbar-picker 重构：左侧连接状态 + 仓库 dropdown + URL + 刷新 + 主题
 *                                  + 右侧当前用户 + 退出
 *
 * v2.3 · user 拍板 2026-06-22 StatusBar 仓库管理面板：
 *   - App.vue 启动期自动 fetch 用户可管理的仓库（已有：App.vue mount 调 loadRepos）
 *   - 仓库 dropdown 升级：每个仓库多行显示（fullName + 描述 + 状态），行末操作按钮
 *   - 未同步本地的仓库 → 行末按钮 = "同步"（调 gitgraphCloneRepo）
 *   - 已同步本地的仓库 → 行末按钮 = "更新"（调 gitgraphPull）
 *   - 旧的"切换仓库"语义**保留**：点 fullName 文字区域仍调 useBoardActions.selectProject
 *   - 行末按钮 click 不触发切换（独立按钮 stop propagation）
 *
 * 多行布局：
 *   ┌────────────────────────────────────────────────────────┐
 *   │ org/repo-name                       [✓ 已同步]  [更新] │
 *   │ 描述文字...                                             │
 *   │ ──────────────────────────────────────────────────────  │
 *   │ other/repo                                              │
 *   │ 描述文字...                           [同步]            │
 *   └────────────────────────────────────────────────────────┘
 *
 * 状态管理：
 *   - 仓库列表来自 repo store (repos.value)
 *   - 同步状态来自 clonedMap (key = owner/repo → boolean)
 *   - loadRepos 后调 repo.refreshClonedStatus() 批量更新
 *   - clone/pull 成功后立即更新 clonedMap
 *
 * AGENTS §8.5 离线降级：gitea API 失败时不直接报 Network Error，显著提示"离线模式"
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
  Loader2,
} from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useSettingsStore } from '@renderer/stores/settings';
import { useUiStore, nextThemeInCycle, THEME_DISPLAY_NAME } from '@renderer/stores/ui';
import { useBoardActions } from '@renderer/composables/useBoardActions';
import { showToast } from '@renderer/lib/toast';
import { formatLastUpdated } from '@renderer/lib/last-updated';
import type { SyncProgress } from '@renderer/types/sync-progress';
import EmptyState from '@renderer/components/EmptyState.vue';
import AccountManagerDialog from '@renderer/components/AccountManagerDialog.vue';
import type { RepoDto } from '@renderer/types/dto';

const auth = useAuthStore();
const repo = useRepoStore();
const settings = useSettingsStore();
const ui = useUiStore();

/**
 * 仓库切换统一走 useBoardActions.selectProject —— 与原 BoardTopbar picker 行为一致
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

// ===== 仓库 dropdown（v1.4 任务 #statusbar-picker + v2.3 多行重写） =====

const pickerOpen = ref(false);
const pickerSearch = ref('');

/**
 * 过滤后的仓库列表（按 fullName / description 模糊匹配，大小写不敏感）
 */
const filteredRepos = computed(() => {
  const q = pickerSearch.value.trim().toLowerCase();
  if (!q) return repo.repos;
  return repo.repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
  );
});

const pickerEl = ref<HTMLElement | null>(null);
const searchInputEl = ref<HTMLInputElement | null>(null);

function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value;
  if (pickerOpen.value) {
    pickerSearch.value = '';
    requestAnimationFrame(() => searchInputEl.value?.focus());
  }
}

/**
 * 打开 picker 时如果 clonedMap 是空 → 批量刷一次
 * （启动期 App.vue mount 也会调一次，但用户中途连接新账号后状态是空）
 */
watch(pickerOpen, async (open) => {
  if (open && auth.isConnected) {
    if (Object.keys(repo.clonedMap).length === 0) {
      await repo.refreshClonedStatus();
    }
  }
});

/** 是否已 clone 本地（从 clonedMap 读） */
function isCloned(r: RepoDto): boolean {
  return repo.clonedMap[`${r.owner}/${r.name}`] === true;
}

/** 当前正在操作哪个仓库（clone/pull 按钮的 loading 态） */
const busyRepoKey = ref<string | null>(null);
function repoKey(r: RepoDto): string {
  return `${r.owner}/${r.name}`;
}

const activeProgressRepo = computed<RepoDto | null>(() => {
  if (busyRepoKey.value) {
    return repo.repos.find((r) => repoKey(r) === busyRepoKey.value) ?? repo.currentRepo;
  }

  // Git Graph 顶部的“加载更多”不经过 StatusBar 行末按钮，但复用同一条
  // git:sync:progress 事件流；当前仓库有进度时也要在触发器里显示细进度条。
  const current = repo.currentRepo;
  if (current && syncProgress(current)) return current;
  return null;
});

// ===== v2.6 进度条渲染辅助 =====

/**
 * 同步按钮文案：根据进度阶段显示 "同步"/"同步中 N%"/"同步完成" 等
 *   - 有进度且 percent >= 0 → "同步中 45%"
 *   - 有进度但 percent < 0（go-git 还没出百分比） → "同步中…"
 *   - StageDone → "同步完成"
 *   - StageError → "同步失败"
 *   - 无进度（未点过）→ "同步"
 */
function syncButtonLabel(r: RepoDto): string {
  const p = rowActionProgress(r);
  if (!p) return '同步';
  if (p.stage === 'done') return '同步完成';
  if (p.stage === 'error') return '同步失败';
  if (p.percent >= 0) return `同步中 ${p.percent}%`;
  return '同步中…';
}

/** 更新按钮文案：同上但词换成"更新" */
function updateButtonLabel(r: RepoDto): string {
  const p = rowActionProgress(r);
  if (!p) return '更新';
  if (p.stage === 'done') return '更新完成';
  if (p.stage === 'error') return '更新失败';
  if (p.percent >= 0) return `更新中 ${p.percent}%`;
  return '更新中…';
}

/** 取出当前 repo 的 SyncProgress（无则 undefined） */
function syncProgress(r: RepoDto): SyncProgress | undefined {
  return repo.progressByRepo[repoKey(r)];
}

/** 仓库列表行按钮只展示由该按钮触发的同步/更新进度，避免“加载更多”污染列表文案 */
function rowActionProgress(r: RepoDto): SyncProgress | undefined {
  if (busyRepoKey.value !== repoKey(r)) return undefined;
  return syncProgress(r);
}

/** 进度条 class：根据 stage 切换颜色（done=绿，error=红，普通=主色） */
function progressClass(r: RepoDto): string {
  const p = syncProgress(r);
  if (!p) return '';
  if (p.stage === 'done') return 'statusbar__progress--done';
  if (p.stage === 'error') return 'statusbar__progress--error';
  return '';
}

/** 进度条宽度：percent 0..100 → width%；percent<0 → indeterminate（CSS keyframe 走） */
function progressStyle(r: RepoDto): Record<string, string> {
  const p = syncProgress(r);
  if (!p) return { width: '0%' };
  if (p.percent < 0) {
    // indeterminate:用 CSS 动画，width 给一个基线值；left 由 keyframe 控制
    return { '--progress-indeterminate': '1' } as Record<string, string>;
  }
  return { width: `${Math.min(100, Math.max(0, p.percent))}%` };
}

/** 进度条 tooltip：完整侧带消息文本 */
function progressTooltip(r: RepoDto): string {
  const p = syncProgress(r);
  if (!p) return '';
  const stageZh: Record<string, string> = {
    counting: '计数中',
    compressing: '压缩中',
    receiving: '接收对象',
    resolving: '解析增量',
    checkout: '签出文件',
    updating: '更新文件',
    done: '完成',
    error: '失败',
    unknown: p.stage,
  };
  const stage = stageZh[p.stage] ?? p.stage;
  if (p.percent >= 0) return `${stage} ${p.percent}% · ${p.cur}/${p.total}`;
  return stage;
}

/** 同步（clone）仓库 */
async function onSyncClick(r: RepoDto, e: Event): Promise<void> {
  e.stopPropagation();
  const key = repoKey(r);
  busyRepoKey.value = key;
  try {
    await repo.cloneRepo(r.owner, r.name);
    await repo.loadRepos('', true);
    showToast({ type: 'success', message: '同步成功', description: `${r.fullName} 已同步到本地` });
  } catch (err) {
    const e2 = err as { messageText?: string; message?: string };
    showToast({ type: 'error', message: '同步失败', description: e2.messageText ?? e2.message ?? '请稍后重试' });
  } finally {
    busyRepoKey.value = null;
  }
}

/** 更新（pull）仓库 —— v2.4 修复 localPath 拼接 bug
 *
 * 旧版用 `import.meta.env.VITE_GITEA_KANBAN_WORKSPACE` 拼 `~/.gitea-kanban/workspace/...`
 * 但 Go 端 workspacePath 是绝对路径（如 `/Users/xxx/.gitea-kanban/workspace`），
 * 带 `~` 的 localPath 被 Go 端 resolveTokenByLocalPath 拒绝。
 *
 * v2.4：传 projectId，Go 端按 owner+repo + workspacePath 反算
 */
async function onUpdateClick(r: RepoDto, e: Event): Promise<void> {
  e.stopPropagation();
  const key = repoKey(r);
  busyRepoKey.value = key;
  try {
    // 用被点击行的 projectId，避免行内"更新"误拉当前选中的其它仓库。
    let projectId = r.projectId ?? null;
    if (!projectId && repo.currentRepo?.fullName === r.fullName) {
      projectId = repo.currentProjectId;
    }
    if (!projectId) {
      await repo.loadRepos('', true);
      projectId = repo.repos.find((item) => item.owner === r.owner && item.name === r.name)?.projectId ?? null;
    }
    if (!projectId) {
      showToast({ type: 'error', message: '更新失败', description: '请先同步该仓库，或刷新仓库列表后重试' });
      return;
    }
    const result = await repo.pullRepoByProjectId({ projectId });
    const added = (result as { addedCommits?: number }).addedCommits ?? 0;
    showToast({
      type: 'success',
      message: '更新成功',
      description: added > 0 ? `${r.fullName} 新增 ${added} 个提交` : `${r.fullName} 已是最新`,
    });
  } catch (err) {
    const e2 = err as { messageText?: string; message?: string };
    showToast({ type: 'error', message: '更新失败', description: e2.messageText ?? e2.message ?? '请稍后重试' });
  } finally {
    busyRepoKey.value = null;
  }
}

/** 点仓库行（不含按钮区域）= 切到该仓库上下文 */
async function pickRepo(r: RepoDto): Promise<void> {
  pickerOpen.value = false;
  pickerSearch.value = '';
  await selectProject(r);
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node | null;
  // 仓库 picker：点外部关闭
  if (pickerOpen.value && pickerEl.value && !pickerEl.value.contains(target)) {
    pickerOpen.value = false;
  }
  // 账号 picker：点外部关闭
  if (accountPickerOpen.value && accountPickerEl.value && !accountPickerEl.value.contains(target)) {
    accountPickerOpen.value = false;
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
 */
watch(
  () => repo.guideOnConnect,
  (now) => {
    if (now && !pickerOpen.value) {
      togglePicker();
      repo.consumeGuideOnConnect();
    }
  },
);

// ===== 刷新 / 主题 / 退出 =====

/** 主动刷新：拉最新仓库列表 + 重新检查 clone 状态，并广播全局刷新事件 */
async function onRefreshClick(): Promise<void> {
  try {
    await repo.loadRepos('', true);
    // 刷新 clone 状态缓存
    await repo.refreshClonedStatus();
    // v2.8 修复：StatusBar 刷新按钮不能只刷新仓库列表，
    // 还要通知当前活动视图重新加载自身数据（Git Graph / 看板 / 合并请求等）
    window.dispatchEvent(new CustomEvent('app:refresh'));
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

/** 退出按钮 → 打开账号管理弹窗 */
const accountDialogOpen = ref(false);
function onLogoutClick(): void {
  accountDialogOpen.value = true;
}

// ===== 账号 picker（仿仓库 picker 模式） =====
// 点击用户名 → 弹出 popover：顶部显示当前账号详情 + 下方列表可切换其他账号
// 如果只绑定了 1 个或 0 个账号 → trigger 不可点击（忽略）

/** 是否有 2+ 个已绑定账号（picker 才可交互） */
const hasMultipleAccounts = computed(() => auth.accounts.length > 1);
/** picker 当前打开状态 */
const accountPickerOpen = ref(false);
/** picker 容器 DOM ref（onDocClick 关闭用） */
const accountPickerEl = ref<HTMLElement | null>(null);

/** 切换账号 picker 显隐（只绑定了 1 个或 0 个账号时忽略） */
function toggleAccountPicker(): void {
  if (!hasMultipleAccounts.value) return;
  accountPickerOpen.value = !accountPickerOpen.value;
}

/** 选中其他账号 → 切换（后端会重排 accounts 让该账号排第一 + 刷新 currentUser） */
async function pickAccount(account: (typeof auth.accounts)[number]): Promise<void> {
  if (account.id === auth.accounts[0]?.id) {
    // 点击的是当前账号 → 只关闭 picker，不重新切
    accountPickerOpen.value = false;
    return;
  }
  accountPickerOpen.value = false;
  try {
    await auth.switchAccount(account.id);
    // 切账号后必须重新加载仓库列表（旧列表是旧账号的）+ 重新检查 clone 状态
    // loadRepos 用 auth.accounts[0] 拉取，新账号已排第一会自动用新账号
    await repo.loadRepos('', true);
    await repo.refreshClonedStatus();
    // 通知当前活动视图重新加载自身数据（Git Graph / 看板 / 合并请求等可能依赖旧账号上下文）
    window.dispatchEvent(new CustomEvent('app:refresh'));
    showToast({
      type: 'success',
      message: '已切换账号',
      description: `当前账号：${account.userInfo?.login ?? account.username}`,
    });
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    showToast({ type: 'error', message: '切换账号失败', description: err.messageText ?? err.message ?? '请稍后重试' });
  }
}
</script>

<template>
  <div class="statusbar-wrap">
    <footer class="statusbar" :data-state="connState" role="status" aria-live="polite">
      <div class="statusbar__left">
        <span class="statusbar__chip" :class="`statusbar__chip--${connState}`">
          <component :is="stateIcon" :size="12" :stroke-width="2.5" aria-hidden="true" />
          <span>{{ stateText }}</span>
        </span>

        <!--
          v2.3 仓库 dropdown：每个仓库多行显示 + 行末操作按钮
          - 未同步 → 按钮"同步"（调 gitgraphCloneRepo）
          - 已同步 → 按钮"更新"（调 gitgraphPull）
          - 点 fullName 文字区域 → 切到该仓库上下文
          - 点行末按钮 → 只触发按钮 action（不切换仓库）
        -->
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
            <div
              v-if="activeProgressRepo && syncProgress(activeProgressRepo)"
              class="statusbar__progress statusbar__progress--trigger"
              :class="progressClass(activeProgressRepo)"
              :title="progressTooltip(activeProgressRepo)"
            >
              <div class="statusbar__progress-bar" :style="progressStyle(activeProgressRepo)" />
            </div>
            <ChevronDown :size="12" :stroke-width="2" aria-hidden="true" />
          </button>

          <div v-if="pickerOpen" class="statusbar__dropdown" role="dialog" aria-label="仓库管理">
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
              <li
                v-for="r in filteredRepos"
                :key="r.id"
                class="statusbar__row"
                :class="{
                  'statusbar__row--active': r.fullName === repo.currentRepo?.fullName,
                  'statusbar__row--cloned': isCloned(r),
                }"
                @click="pickRepo(r)"
              >
                <div class="statusbar__row-main">
                  <div class="statusbar__row-line1">
                    <span class="statusbar__row-name">{{ r.fullName }}</span>
                    <span v-if="r.isProject" class="statusbar__row-tag">已加入</span>
                    <span v-if="isCloned(r)" class="statusbar__row-tag statusbar__row-tag--cloned">已同步</span>
                  </div>
                  <p v-if="r.description" class="statusbar__row-desc">{{ r.description }}</p>
                </div>
                <div class="statusbar__row-actions" @click.stop>
                  <button
                    v-if="!isCloned(r)"
                    type="button"
                    class="statusbar__row-btn statusbar__row-btn--sync"
                    :disabled="busyRepoKey === repoKey(r)"
                    :title="`同步 ${r.fullName} 到本地 workspace`"
                    @click="onSyncClick(r, $event)"
                  >
                    <Loader2 v-if="busyRepoKey === repoKey(r) && !rowActionProgress(r)" :size="12" :stroke-width="2" class="statusbar__spin" />
                    <span>{{ syncButtonLabel(r) }}</span>
                  </button>
                  <button
                    v-else
                    type="button"
                    class="statusbar__row-btn statusbar__row-btn--update"
                    :disabled="busyRepoKey === repoKey(r)"
                    :title="`从远端拉取 ${r.fullName} 最新 commit`"
                    @click="onUpdateClick(r, $event)"
                  >
                    <Loader2 v-if="busyRepoKey === repoKey(r) && !rowActionProgress(r)" :size="12" :stroke-width="2" class="statusbar__spin" />
                    <span>{{ updateButtonLabel(r) }}</span>
                  </button>
                </div>
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
        <!-- v2.52：账号 picker —— 点击用户名弹出 popover（仿仓库 picker 风格）
             顶部显示当前账号详情（avatar / login / platform / giteaUrl），
             下方列表显示其他已绑定账号可切换。
             只绑定了 1 个或 0 个账号 → trigger 不可点击（忽略）。 -->
        <div
          v-if="auth.currentUser"
          ref="accountPickerEl"
          class="statusbar__account-picker"
          :class="{ 'statusbar__account-picker--open': accountPickerOpen }"
        >
          <button
            type="button"
            class="statusbar__account-trigger"
            :class="{ 'statusbar__account-trigger--disabled': !hasMultipleAccounts }"
            :title="hasMultipleAccounts ? `切换账号（当前：${auth.currentUser.login}）` : '只绑定了 1 个账号'"
            :disabled="!hasMultipleAccounts"
            @click="toggleAccountPicker"
          >
            <img
              v-if="auth.currentUser.avatarUrl"
              :src="auth.currentUser.avatarUrl"
              :alt="`${auth.currentUser.login} 头像`"
              class="statusbar__avatar"
            />
            <User v-else :size="12" :stroke-width="2" aria-hidden="true" />
            <span>{{ auth.currentUser.login }}</span>
            <ChevronDown
              v-if="hasMultipleAccounts"
              :size="12"
              :stroke-width="2"
              aria-hidden="true"
            />
          </button>

          <div
            v-if="accountPickerOpen && hasMultipleAccounts"
            class="statusbar__account-dropdown"
            role="dialog"
            :aria-label="`账号管理（当前：${auth.currentUser.login}）`"
          >
            <!-- 顶部：当前账号详情（展开界面显示账号信息） -->
            <div class="statusbar__account-info">
              <img
                v-if="auth.currentUser.avatarUrl"
                :src="auth.currentUser.avatarUrl"
                :alt="`${auth.currentUser.login} 头像`"
                class="statusbar__account-info-avatar"
              />
              <div v-else class="statusbar__account-info-avatar statusbar__account-info-avatar--placeholder">
                <User :size="20" :stroke-width="2" aria-hidden="true" />
              </div>
              <div class="statusbar__account-info-main">
                <div class="statusbar__account-info-line1">
                  <span class="statusbar__account-info-login">{{ auth.currentUser.login }}</span>
                  <span class="statusbar__account-info-tag">当前</span>
                </div>
                <p class="statusbar__account-info-url">
                  {{ auth.currentGiteaUrl || (auth.accounts[0]?.giteaUrl ?? '') }}
                </p>
              </div>
            </div>

            <!-- 列表分隔线 -->
            <div v-if="auth.accounts.length > 1" class="statusbar__account-divider">
              <span>切换到其他账号</span>
            </div>

            <!-- 其他账号列表（点击切换） -->
            <ul class="statusbar__account-list">
              <li
                v-for="acc in auth.accounts.filter((a) => a.id !== auth.accounts[0]?.id)"
                :key="acc.id"
                class="statusbar__account-row"
                :title="`切换到 ${acc.userInfo?.login ?? acc.username}@${acc.giteaUrl}`"
                @click="pickAccount(acc)"
              >
                <img
                  v-if="acc.userInfo?.avatarUrl"
                  :src="acc.userInfo.avatarUrl"
                  :alt="`${acc.userInfo?.login ?? acc.username} 头像`"
                  class="statusbar__account-row-avatar"
                />
                <div v-else class="statusbar__account-row-avatar statusbar__account-row-avatar--placeholder">
                  <User :size="12" :stroke-width="2" aria-hidden="true" />
                </div>
                <div class="statusbar__account-row-main">
                  <div class="statusbar__account-row-line1">
                    <span class="statusbar__account-row-login">{{ acc.userInfo?.login ?? acc.username }}</span>
                    <span v-if="(acc.platform ?? 'gitea') === 'github'" class="statusbar__account-row-tag">GitHub</span>
                  </div>
                  <p class="statusbar__account-row-url">{{ acc.giteaUrl }}</p>
                </div>
              </li>
            </ul>
          </div>
        </div>
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

    <!-- 账号管理弹窗 -->
    <AccountManagerDialog v-model:open="accountDialogOpen" />
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-3);
  background: transparent;
  /* v1.5：border-top 由 .shell__status (AppShell.vue) 接管，避免双线 */
  border-top: 1px solid transparent;
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

.statusbar__repo-count {
  font-feature-settings: 'tnum';
  /* v2.56：inline-flex + align-items: center 让 Package svg 与文本在同一行垂直居中
     （之前是默认 inline，svg 走 baseline 对齐被推到容器顶部） */
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* v2.53：保持单行显示——窗口窄时数字过长用 ellipsis 截断
     （避免布局变动：N 个仓库 / N+M 个仓库 / Nx10 个仓库 都是不同宽度，
     单行 + ellipsis 保证 StatusBar 布局稳定，"保持单行显示是基本要求"）。
     flex-shrink: 0 保证不被 flex 压缩到不可见（完全消失），只会 ellipsis。 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 160px;
  /* line-height: 1 让 svg baseline 不被行高推上去 */
  line-height: 1;
}
/* v2.56：svg 显式 vertical-align: middle 防止 baseline 对齐推 icon 到顶部 */
.statusbar__repo-count :deep(svg) {
  vertical-align: middle;
  flex-shrink: 0;
}

.statusbar__avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
  vertical-align: middle;
}

/* ===== v2.52 账号 picker（仿仓库 picker 风格） =====
   - trigger：avatar + login + ChevronDown，hover 高亮，disabled 态（只 1 个账号）不可点
   - dropdown：顶部当前账号详情 + 下方其他账号列表（点击切换） */
.statusbar__account-picker {
  position: relative;
}
.statusbar__account-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  /* v2.54：显式重置 line-height —— button 默认 line-height 加上 svg 文本基线对齐
     会让 User 图标被挤到容器顶部（icon 上方出现空隙）。统一 line-height: 1
     + svg vertical-align: middle 解决垂直对齐问题。 */
  line-height: 1;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: var(--radius-sm);
  cursor: pointer;
  max-width: 220px;
  min-width: 0;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.statusbar__account-trigger :deep(svg) {
  /* v2.54：svg 显式 vertical-align: middle，避免与文本基线对齐导致 icon 顶部空隙 */
  vertical-align: middle;
  flex-shrink: 0;
}
.statusbar__account-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.statusbar__account-trigger:not(.statusbar__account-trigger--disabled):hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
}
.statusbar__account-picker--open .statusbar__account-trigger {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: color-mix(in srgb, var(--color-primary) 50%, transparent);
}
.statusbar__account-trigger--disabled {
  cursor: default;
  opacity: 0.7;
}

.statusbar__account-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  width: 320px;
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

/* 顶部：当前账号详情卡（展开界面显示账号信息） */
.statusbar__account-info {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: var(--color-primary-soft);
  border-bottom: 1px solid var(--color-divider);
}
.statusbar__account-info-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.statusbar__account-info-avatar--placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  /* v2.54：line-height: 1 + svg vertical-align: middle 避免 icon 被推到顶部 */
  line-height: 1;
}
.statusbar__account-info-avatar--placeholder :deep(svg) {
  vertical-align: middle;
  flex-shrink: 0;
}
.statusbar__account-info-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.statusbar__account-info-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.statusbar__account-info-login {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.statusbar__account-info-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--color-primary);
  color: #fff;
  flex-shrink: 0;
}
.statusbar__account-info-url {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.statusbar__account-divider {
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-divider);
}

/* 下方：其他账号列表 */
.statusbar__account-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1);
  list-style: none;
  margin: 0;
}
.statusbar__account-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.statusbar__account-row + .statusbar__account-row {
  margin-top: 2px;
}
.statusbar__account-row:hover {
  background: var(--color-bg-hover);
}
.statusbar__account-row-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.statusbar__account-row-avatar--placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  /* v2.54：line-height: 1 + svg vertical-align: middle 避免 icon 被推到顶部 */
  line-height: 1;
}
.statusbar__account-row-avatar--placeholder :deep(svg) {
  vertical-align: middle;
  flex-shrink: 0;
}
.statusbar__account-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.statusbar__account-row-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.statusbar__account-row-login {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.statusbar__account-row-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(100, 116, 139, 0.12);
  color: #64748b;
  border: 1px solid rgba(100, 116, 139, 0.3);
  flex-shrink: 0;
}
.statusbar__account-row-url {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

/* v2.52：删除旧 .statusbar__user 规则 —— 已被 .statusbar__account-picker 替代。
   旧规则保留注释供 git blame 参考。 */

.statusbar__action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  /* v2.54：line-height: 1 修复 button 默认行高让 svg baseline 推 icon 到顶部的问题 */
  line-height: 1;
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
/* v2.54：svg 显式 vertical-align: middle 防止与文本 baseline 对齐导致 icon 顶部空隙 */
.statusbar__action :deep(svg) {
  vertical-align: middle;
  flex-shrink: 0;
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

/* ===== 仓库 dropdown（v1.4 + v2.3 多行重写）===== */
.statusbar__picker {
  position: relative;
}

.statusbar__picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  /* v2.54：line-height: 1 修复 button 默认行高让 svg baseline 推 icon 到顶部的问题 */
  line-height: 1;
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
/* v2.62：svg 显式 vertical-align: middle + display: block + height:1em，
   彻底防止 svg 被 button 默认行高推到顶部（v2.54 只加了 vertical-align 仍不够）。 */
.statusbar__picker-trigger :deep(svg) {
  display: block;
  vertical-align: middle;
  height: 1em;
  width: auto;
  flex-shrink: 0;
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

/* dropdown 容器升级：宽 480 容纳多行 + 描述 */
.statusbar__dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 480px;
  max-height: 540px;
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

/* ===== v2.3 多行仓库行（替代旧 dropdown-item）=====
 * 布局：左侧 main（fullName + 描述），右侧 actions（按钮）
 * hover：行底色变 bg-hover
 * active（当前选中）：底色 primary-soft
 * cloned（已同步）：行末有"已同步" chip + 按钮换"更新"
 */
.statusbar__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  background: transparent;
  border: none;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.statusbar__row + .statusbar__row {
  margin-top: 2px;
}
.statusbar__row:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.statusbar__row--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.statusbar__row--active:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.statusbar__row--cloned {
  /* 已同步的仓库加左侧 2px 指示条（绿色） */
  border-left: 2px solid var(--color-success);
  padding-left: 8px;
}

.statusbar__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.statusbar__row-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.statusbar__row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.statusbar__row-desc {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  line-height: var(--line-base);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.statusbar__row--active .statusbar__row-desc {
  color: var(--color-primary);
  opacity: 0.85;
}

.statusbar__row-tag {
  font-size: 10px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
  font-weight: 500;
}
.statusbar__row-tag--cloned {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.statusbar__row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  margin-left: var(--space-2);
}

.statusbar__row-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  /* v2.54：line-height: 1 修复 button 默认行高让 svg baseline 推 icon 到顶部的问题 */
  line-height: 1;
  border: 1px solid var(--color-divider);
  background: var(--color-bg-elevated);
  color: var(--color-text);
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
  min-width: 64px;
  justify-content: center;
}
/* v2.54：svg 显式 vertical-align: middle 防止与文本 baseline 对齐导致 icon 顶部空隙 */
.statusbar__row-btn :deep(svg) {
  vertical-align: middle;
  flex-shrink: 0;
}
.statusbar__row-btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.statusbar__row-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.statusbar__row-btn--sync:hover:not(:disabled) {
  background: var(--color-primary-soft);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.statusbar__row-btn--update:hover:not(:disabled) {
  background: var(--color-success-soft);
  border-color: var(--color-success);
  color: var(--color-success);
}

.statusbar__spin {
  animation: statusbar-spin 1s linear infinite;
}

/* ===== v2.6 同步进度条 =====
 * 位置：仓库行内、按钮下方（不在 dropdown 底部，独立于全局海豚 overlay）
 * 高度 2px（极细），避免 dropdown 内容膨胀
 * 三种状态：
 *   - 普通（蓝）：进行中
 *   - done（绿）：完成后短暂保留
 *   - error（红）：失败后短暂保留
 * indeterminate（percent < 0）用 keyframe 滑条动画，给"在动"的反馈
 */
.statusbar__progress {
  position: relative;
  flex: 1;
  min-width: 80px;
  height: 2px;
  background: var(--color-bg-hover);
  border-radius: 1px;
  overflow: hidden;
  align-self: stretch;
  margin-left: var(--space-2);
}

.statusbar__progress--trigger {
  flex: 0 0 92px;
  min-width: 92px;
  align-self: center;
  margin-left: 0;
}

.statusbar__progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--color-primary);
  border-radius: 1px;
  transition: width 200ms ease-out;
}

.statusbar__progress--done .statusbar__progress-bar {
  background: var(--color-success);
}
.statusbar__progress--error .statusbar__progress-bar {
  background: var(--color-danger);
}

/* indeterminate（go-git 还没出百分比时）—— 50% 宽的滑条从左滑到右循环 */
@keyframes statusbar-progress-indeterminate {
  0% {
    left: -50%;
  }
  100% {
    left: 100%;
  }
}
.statusbar__progress-bar[style*='--progress-indeterminate'] {
  width: 50%;
  animation: statusbar-progress-indeterminate 1.4s ease-in-out infinite;
}

.statusbar__dropdown-empty {
  padding: var(--space-3);
}
</style>
