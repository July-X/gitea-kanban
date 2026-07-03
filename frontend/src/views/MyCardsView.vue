<script setup lang="ts">
/**
 * @deprecated v0.6+ 软废弃：导航栏已移除入口，路由 /my-cards 重定向到 /timeline。
 * 视图文件、stores、composables 暂保留以便回滚，待后续彻底清理。
 *
 * MyCardsView —— "我的卡片"列表（= 当前用户作为 assignee 的 gitea issues）
 *
 * 设计（v1.4 · 任务 #statusbar-picker 重构）：
 *   - v1.4 之前：顶栏有仓库选择器（侧拉从 repo.projects 取）
 *   - v1.4 之后：**仓库选择已下沉到 StatusBar 全局 picker**（状态栏唯一入口），
 *     本视图不再渲染 picker / 不接 selectProject
 *   - 保留：当前用户头像 + 名 + 总卡片数 + tabs + 搜索 + 列表
 *
 * 零术语：UI 文本**不**出现 issue 原词（中文用"议题/卡片"），
 *   - "我的卡片" / "进行中" / "已关闭" / "共 X 张"
 *   - "暂无截止日期"（gitea issue 截止日期为 due_date 字段，**不**在 v1 schema
 *     的 IssueCardDto 里——v1 显示"暂无"占位，**不**调用额外 IPC）
 *
 * v1 简化：
 *   - 跨 project 聚合 v1 不做（拉当前 active project 一份）
 *   - 截止日期列 v1 显示"暂无"（**不**接 gitea issue.due_date——schema 暂未含）
 *   - **不**做"卡片详情抽屉"（v1 只读列表；点行打开 gitea web）
 */
import { computed, onMounted, watch } from 'vue';
import { RefreshCw, Search } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useMyCardStore, type MyCardFilter } from '@renderer/stores/my-card';
import { showToast } from '@renderer/lib/toast';
import EmptyState from '@renderer/components/EmptyState.vue';
import type { RepoDto } from '@renderer/types/dto';

const auth = useAuthStore();
const repo = useRepoStore();
const myCard = useMyCardStore();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/** tabs：全部 / 进行中 / 已关闭 */
const tabs: { id: MyCardFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '进行中' },
  { id: 'closed', label: '已关闭' },
];

onMounted(async () => {
  // 1. 拉账号 + 用户
  if (auth.accounts.length === 0) {
    try {
      await auth.refreshStatus();
    } catch {
      /* error in auth.error */
    }
  }
  // 2. 仓库列表（兜底轮询还没跑的情况;如果 App.vue 引导选仓库成功,这里只是补一次）
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error */
    }
  }
  // v1.4 任务 #statusbar-picker：删除"未选就默认选第一个"逻辑
  // 仓库由 App.vue 在登录/启动期通过 StatusBar picker 引导用户主动选;
  // 没选就展示 EmptyState 提示,让用户去状态栏选仓库
  // 3. 拉"我的卡片"（如果已连 + 有 user.login + 已选仓库）
  if (activeProjectId.value && auth.currentUser?.login) {
    await loadMyCards();
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    if (id && auth.currentUser?.login) {
      await loadMyCards();
    } else {
      myCard.$reset?.();
    }
  },
);

watch(
  () => auth.currentUser?.login,
  async (login) => {
    if (login && activeProjectId.value) {
      await loadMyCards();
    }
  },
);

async function loadMyCards(): Promise<void> {
  if (!activeProjectId.value || !auth.currentUser?.login) return;
  try {
    await myCard.list(activeProjectId.value, auth.currentUser.login, true);
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '加载失败' });
  }
}

async function onRefresh(): Promise<void> {
  try {
    await myCard.refresh();
    showToast({ type: 'success', message: `已刷新，共 ${myCard.total} 张` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '刷新失败' });
  }
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="my-cards">
    <!-- ============== 顶栏（v1.4：删 picker,保留当前用户 + 总卡片数 + 刷新） ============== -->
    <header class="my-cards__topbar">
      <div class="my-cards__user" v-if="auth.currentUser">
        <div class="my-cards__avatar" aria-hidden="true">
          <img
            v-if="auth.currentUser.avatarUrl"
            :src="auth.currentUser.avatarUrl"
            :alt="auth.currentUser.login"
            class="my-cards__avatar-img"
          />
          <span v-else class="my-cards__avatar-fallback">
            {{ auth.currentUser.login.slice(0, 1).toUpperCase() }}
          </span>
        </div>
        <div class="my-cards__user-text">
          <span class="my-cards__user-name">{{ auth.currentUser.fullName || auth.currentUser.login }}</span>
          <span class="my-cards__user-login muted">@{{ auth.currentUser.login }}</span>
        </div>
      </div>
      <div class="my-cards__topbar-right">
        <span class="my-cards__counter">共 {{ myCard.total }} 张</span>
        <button
          type="button"
          class="my-cards__refresh"
          :disabled="myCard.loading"
          :title="'刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" />
          <span>刷新</span>
        </button>
      </div>
    </header>

    <!-- ============== 主体 ============== -->
    <div v-if="!activeRepo" class="my-cards__placeholder">
      <EmptyState
        title="还没有选中仓库"
        description="点状态栏（窗口底部）的仓库名，从下拉里选一个"
      />
    </div>
    <div v-else-if="!auth.currentUser" class="my-cards__placeholder">
      <EmptyState title="未获取到当前用户" description="请确认 gitea 连接" />
    </div>
    <!--
      v0.6.1+ 拍板"替换模式"：删 v-else-if="myCard.loading && ..." 的"加载中…"占位
      全局 StatusBarPulse 接管请求级 loading
    -->

    <template v-else>
      <!-- tabs + search -->
      <div class="my-cards__controls">
        <div class="my-cards__tabs" role="tablist">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            role="tab"
            class="my-cards__tab"
            :class="{ 'my-cards__tab--active': myCard.filter === t.id }"
            :aria-selected="myCard.filter === t.id"
            @click="myCard.setFilter(t.id)"
          >
            <span>{{ t.label }}</span>
            <span class="my-cards__tab-count">{{ myCard.counts[t.id] }}</span>
          </button>
        </div>
        <div class="my-cards__search">
          <Search :size="14" :stroke-width="2" aria-hidden="true" />
          <input
            v-model="myCard.search"
            type="text"
            class="my-cards__search-input"
            placeholder="按标题 / 编号 / 标签搜索"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>

      <!-- 错误条 -->
      <div v-if="myCard.error" class="my-cards__error" role="alert">
        <p class="my-cards__error-msg">{{ myCard.error.messageText }}</p>
        <p class="my-cards__error-hint">{{ myCard.error.hint }}</p>
      </div>

      <!-- 空状态 -->
      <div
        v-if="!myCard.filteredItems.length && myCard.items.length > 0"
        class="my-cards__placeholder"
      >
        <EmptyState
          :title="`没有匹配「${tabs.find((t) => t.id === myCard.filter)?.label}」的卡片`"
          description="试试切换其他 tab，或调整搜索词"
        />
      </div>
      <div v-else-if="!myCard.items.length" class="my-cards__placeholder">
        <EmptyState
          title="你在这个仓库里还没有卡片"
          :description="`@${auth.currentUser.login} 没有作为负责人的议题`"
        />
      </div>

      <!-- 列表 -->
      <ul v-else class="my-cards__list">
        <li
          v-for="i in myCard.filteredItems"
          :key="i.id"
          class="card-row"
          :class="{ 'card-row--closed': i.state === 'closed' }"
        >
          <div class="card-row__head">
            <span class="card-row__index mono">#{{ i.index }}</span>
            <span
              class="card-row__state"
              :class="{
                'card-row__state--open': i.state === 'open',
                'card-row__state--closed': i.state === 'closed',
              }"
            >
              {{ i.state === 'open' ? '进行中' : '已关闭' }}
            </span>
            <span class="card-row__title">{{ i.title }}</span>
          </div>
          <div v-if="i.labels.length" class="card-row__labels">
            <span
              v-for="lab in i.labels"
              :key="lab.id"
              class="card-row__label"
              :style="{ '--label-color': lab.color }"
            >
              {{ lab.name }}
            </span>
          </div>
          <div class="card-row__meta">
            <span class="card-row__author muted">
              {{ i.author.fullName || i.author.username }}
            </span>
            <span class="card-row__date muted">更新于 {{ formatDate(i.updatedAt) }}</span>
            <span class="card-row__due muted" :title="'截止日期（gitea issue.due_date 字段，TODO：等 Go 端 ListIssues 暴露该字段）'">
              截止：暂无
            </span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.my-cards {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.my-cards__topbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  /* v1.6.1 改用主区中性色（--color-shell-main-bg），跟主区同色
   * 区别靠 1px --color-divider 底边线分层（替代纯白 #FFFFFF 跟主区融成片） */
  background: var(--color-shell-main-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}

/* v1.4 任务 #statusbar-picker：删除 .my-cards__picker / .my-cards__picker-name /
 * .my-cards__dropdown / .my-cards__dropdown-search / .my-cards__dropdown-input /
 * .my-cards__dropdown-list / .my-cards__dropdown-item / .my-cards__dropdown-item-name
 * 相关样式 —— 仓库选择已下沉到 StatusBar */

.my-cards__user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  padding: 4px 10px;
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟 topbar / 主体内容同色
   * 旧值 --color-bg (#E8F1F5 浅苍蓝) 在新主区 #F8FAFC 上对比过强 */
  background: var(--color-shell-main-bg);
  border-radius: var(--radius-pill);
}

.my-cards__avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  flex-shrink: 0;
}

.my-cards__avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.my-cards__avatar-fallback {
  font-size: var(--font-xs);
  font-weight: 600;
}

.my-cards__user-text {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
}

.my-cards__user-name {
  font-size: var(--font-xs);
  color: var(--color-text);
  font-weight: 500;
}

.my-cards__user-login {
  font-size: 10px;
  color: var(--color-text-muted);
}

.my-cards__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.my-cards__counter {
  font-feature-settings: 'tnum';
}

.my-cards__refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟 topbar / 主体内容同色
   * 旧值 --color-bg (#E8F1F5 浅苍蓝) 在新主区 #F8FAFC 上对比过强 */
  background: var(--color-shell-main-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}

.my-cards__refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.my-cards__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.my-cards__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟 topbar / 主体内容同色 */
  background: var(--color-shell-main-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.my-cards__tabs {
  display: flex;
  gap: 2px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  padding: 2px;
}

.my-cards__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  background: transparent;
}

.my-cards__tab:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.my-cards__tab--active {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.my-cards__tab--active:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-inverse);
}

.my-cards__tab-count {
  font-size: var(--font-xs);
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟主区同色 */
  background: var(--color-shell-main-bg);
  color: var(--color-text-muted);
  padding: 0 5px;
  border-radius: var(--radius-pill);
  font-feature-settings: 'tnum';
}

.my-cards__tab--active .my-cards__tab-count {
  background: var(--color-primary-active);
  color: var(--color-text-inverse);
}

.my-cards__search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 360px;
  padding: 4px 10px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
}

.my-cards__search-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.my-cards__search-input:focus {
  background: transparent;
  box-shadow: none;
}

.my-cards__error {
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft);
  border-left: 3px solid var(--color-danger);
  font-size: var(--font-sm);
}

.my-cards__error-msg {
  color: var(--color-text);
  font-weight: 500;
  margin: 0 0 2px;
}

.my-cards__error-hint {
  color: var(--color-text-secondary);
  margin: 0;
}

.my-cards__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.my-cards__list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  overflow-y: auto;
  list-style: none;
  margin: 0;
}

.card-row {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-left: 3px solid var(--color-primary);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background var(--t-fast) var(--ease);
}

.card-row:hover {
  background: var(--color-bg-hover);
}

.card-row--closed {
  border-left-color: var(--color-text-muted);
  opacity: 0.75;
}

.card-row__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card-row__index {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 600;
  flex-shrink: 0;
}

.card-row__state {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  flex-shrink: 0;
}

.card-row__state--open {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.card-row__state--closed {
  background: var(--color-bg-active);
  color: var(--color-text-secondary);
}

.card-row__title {
  flex: 1;
  font-size: var(--font-sm);
  color: var(--color-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-row__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.card-row__label {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  white-space: nowrap;
  background-color: var(--label-color, var(--color-bg-active));
  color: var(--color-text-inverse);
}

.card-row__meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-xs);
  margin-top: 2px;
}

.card-row__author {
  font-weight: 500;
}


</style>
