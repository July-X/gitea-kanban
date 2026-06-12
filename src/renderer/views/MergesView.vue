<script setup lang="ts">
/**
 * MergesView —— 仓库合并请求列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5 + plan_32018da5）：
 *   - 顶栏：仓库名 + tab 切换（全部 / 开放 / 已合并 / 已关闭）+ 搜索 + 刷新
 *   - 主体：合并请求列表（卡片化：标题 / 编号 / 作者 / 状态徽章 / 合并状态 / 创建时间）
 *   - 详情：点行展开（不跳 gitea web）—— **v1 简化** 用 inline 详情
 *   - 数据：pulls.list IPC → usePullStore
 *
 * 零术语：
 *   - UI 文本**不**出现 PR / merge / rebase 原词
 *     - "合并请求" / "合并" / "变基" / "开放" / "已合并" / "已关闭" / "草稿"
 *     - 禁用词在文案里**不**出现
 *   - 状态徽章：开放（绿）/ 已合并（紫）/ 已关闭（灰）/ 草稿（橙边）
 *   - 卡片左侧：state 色边（OVERRIDE §"lane / 列卡片化"）
 *
 * v1 简化：
 *   - **不**做合并操作（v1 只读；要合并走 gitea web；v2 加合并按钮 + 二次确认）
 *   - **不**做时间线展示
 *   - 点行展开 → 抽屉（v1 inline 折叠实现，不开 modal）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { GitMerge, RefreshCw, Search, ChevronDown, ChevronRight } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { usePullStore, type PullFilter } from '@renderer/stores/pull';
import { showToast } from '@renderer/lib/toast';
import EmptyState from '@renderer/components/EmptyState.vue';
import type { PullDto, RepoDto } from '../../main/ipc/schema.js';

const repo = useRepoStore();
const pull = usePullStore();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/** 展开的合并请求 index Set（UI 状态，**不**持久化） */
const expanded = ref<Set<number>>(new Set());

/** tab 列表：全部 / 开放 / 已合并 / 已关闭 */
const tabs: { id: PullFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '开放' },
  { id: 'merged', label: '已合并' },
  { id: 'closed', label: '已关闭' },
];

onMounted(async () => {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  if (!activeProjectId.value && repo.projects.length > 0) {
    const first = repo.projects[0]!;
    try {
      const project = await repo.addProject({ owner: first.owner, name: first.name });
      repo.selectProject(project);
    } catch {
      /* error in repo.error */
    }
  }
  if (activeProjectId.value) {
    await loadPulls();
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    if (id) {
      await loadPulls();
    } else {
      pull.$reset?.();
    }
  },
);

async function loadPulls(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    await pull.list(activeProjectId.value, true);
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '加载失败' });
  }
}

async function onRefresh(): Promise<void> {
  try {
    await pull.refresh();
    showToast({ type: 'success', message: `已刷新，共 ${pull.total} 条` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '刷新失败' });
  }
}

function toggleExpand(idx: number): void {
  const next = new Set(expanded.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  expanded.value = next;
}

/** 状态徽章中文 + 颜色 class */
function badgeClass(p: PullDto): string {
  if (p.draft) return 'merge-badge merge-badge--draft';
  if (p.state === 'open') return 'merge-badge merge-badge--open';
  if (p.merged) return 'merge-badge merge-badge--merged';
  return 'merge-badge merge-badge--closed';
}

function badgeText(p: PullDto): string {
  if (p.draft) return '草稿';
  if (p.state === 'open') return '开放';
  if (p.merged) return '已合并';
  return '已关闭';
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="merges">
    <!-- ============== 顶栏 ============== -->
    <header class="merges__topbar">
      <div class="merges__title">
        <GitMerge :size="18" :stroke-width="1.75" aria-hidden="true" />
        <div class="merges__title-text">
          <h1 class="merges__title-h1">合并请求</h1>
          <p class="merges__repo">{{ activeRepo?.fullName ?? '请选择仓库' }}</p>
        </div>
      </div>
      <div class="merges__topbar-right">
        <span class="merges__counter">共 {{ pull.total }} 个</span>
        <button
          type="button"
          class="merges__refresh"
          :disabled="pull.loading"
          :title="'刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: pull.loading }" />
          <span>{{ pull.loading ? '加载中…' : '刷新' }}</span>
        </button>
      </div>
    </header>

    <!-- ============== Tabs + 搜索 ============== -->
    <div v-if="activeProjectId" class="merges__controls">
      <div class="merges__tabs" role="tablist">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          role="tab"
          class="merges__tab"
          :class="{ 'merges__tab--active': pull.filter === t.id }"
          :aria-selected="pull.filter === t.id"
          @click="pull.setFilter(t.id)"
        >
          <span>{{ t.label }}</span>
          <span class="merges__tab-count">{{ pull.counts[t.id] }}</span>
        </button>
      </div>
      <div class="merges__search">
        <Search :size="14" :stroke-width="2" aria-hidden="true" />
        <input
          v-model="pull.search"
          type="text"
          class="merges__search-input"
          placeholder="按标题 / 来源 / 目标搜索"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </div>

    <!-- ============== 错误条 ============== -->
    <div v-if="pull.error" class="merges__error" role="alert">
      <p class="merges__error-msg">{{ pull.error.messageText }}</p>
      <p class="merges__error-hint">{{ pull.error.hint }}</p>
    </div>

    <!-- ============== 主体 ============== -->
    <div v-if="!activeRepo" class="merges__placeholder">
      <EmptyState title="还没有选中仓库" description='去"看板"页选一个仓库，再回来这里看合并请求' />
    </div>
    <div v-else-if="pull.loading && pull.items.length === 0" class="merges__placeholder">
      <p class="muted">加载中…</p>
    </div>
    <div
      v-else-if="!pull.filteredItems.length && pull.items.length > 0"
      class="merges__placeholder"
    >
      <EmptyState
        :title="`没有匹配「${tabs.find((t) => t.id === pull.filter)?.label}」的合并请求`"
        description="试试切换其他 tab，或调整搜索词"
      />
    </div>
    <div v-else-if="!pull.items.length" class="merges__placeholder">
      <EmptyState
        title="这个仓库还没有合并请求"
        description="去 gitea 创建第一个合并请求，或去时间轴页看分支进度"
      />
    </div>
    <ul v-else class="merges__list">
      <li
        v-for="p in pull.filteredItems"
        :key="p.index"
        class="merge-item"
        :class="{
          'merge-item--open': p.state === 'open',
          'merge-item--merged': p.merged,
          'merge-item--closed': p.state === 'closed' && !p.merged,
        }"
      >
        <button
          type="button"
          class="merge-item__head"
          :aria-expanded="expanded.has(p.index)"
          @click="toggleExpand(p.index)"
        >
          <span class="merge-item__chev" aria-hidden="true">
            <ChevronDown v-if="expanded.has(p.index)" :size="14" :stroke-width="2" />
            <ChevronRight v-else :size="14" :stroke-width="2" />
          </span>
          <span class="merge-item__index mono">#{{ p.index }}</span>
          <span :class="badgeClass(p)">{{ badgeText(p) }}</span>
          <span class="merge-item__title">{{ p.title }}</span>
          <span class="merge-item__author muted">{{ p.author.username }}</span>
        </button>
        <div v-if="expanded.has(p.index)" class="merge-item__detail">
          <dl class="merge-item__meta">
            <div class="merge-item__meta-row">
              <dt>作者</dt>
              <dd>{{ p.author.username }}</dd>
            </div>
            <div class="merge-item__meta-row">
              <dt>来源</dt>
              <dd class="mono">{{ p.head.ref }}</dd>
            </div>
            <div class="merge-item__meta-row">
              <dt>目标</dt>
              <dd class="mono">{{ p.base.ref }}</dd>
            </div>
            <div class="merge-item__meta-row">
              <dt>创建</dt>
              <dd>{{ formatDate(p.createdAt) }}</dd>
            </div>
            <div class="merge-item__meta-row">
              <dt>更新</dt>
              <dd>{{ formatDate(p.updatedAt) }}</dd>
            </div>
            <div class="merge-item__meta-row">
              <dt>冲突</dt>
              <dd>{{ p.hasConflicts ? '有冲突' : '无冲突' }}</dd>
            </div>
            <div class="merge-item__meta-row">
              <dt>可合并</dt>
              <dd>{{ p.mergeable ? '是' : '否' }}</dd>
            </div>
          </dl>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.merges {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.merges__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
}

.merges__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  min-width: 0;
}

.merges__title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.merges__title-h1 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.merges__repo {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merges__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.merges__counter {
  font-feature-settings: 'tnum';
}

.merges__refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}

.merges__refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.merges__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.merges__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.merges__tabs {
  display: flex;
  gap: 2px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  padding: 2px;
}

.merges__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  background: transparent;
}

.merges__tab:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.merges__tab--active {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.merges__tab--active:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-inverse);
}

.merges__tab-count {
  font-size: var(--font-xs);
  background: var(--color-bg);
  color: var(--color-text-muted);
  padding: 0 5px;
  border-radius: var(--radius-pill);
  font-feature-settings: 'tnum';
}

.merges__tab--active .merges__tab-count {
  background: var(--color-primary-active);
  color: var(--color-text-inverse);
}

.merges__search {
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

.merges__search-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.merges__search-input:focus {
  background: transparent;
  box-shadow: none;
}

.merges__error {
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft);
  border-left: 3px solid var(--color-danger);
  font-size: var(--font-sm);
}

.merges__error-msg {
  color: var(--color-text);
  font-weight: 500;
  margin: 0 0 2px;
}

.merges__error-hint {
  color: var(--color-text-secondary);
  margin: 0;
}

.merges__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.merges__list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  overflow-y: auto;
}

.merge-item {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  transition: background var(--t-fast) var(--ease);
  overflow: hidden;
}

.merge-item:hover {
  background: var(--color-bg-hover);
}

.merge-item--open {
  border-left: 3px solid var(--color-success);
}

.merge-item--merged {
  border-left: 3px solid var(--color-accent);
}

.merge-item--closed {
  border-left: 3px solid var(--color-text-muted);
  opacity: 0.85;
}

.merge-item__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  width: 100%;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.merge-item__chev {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.merge-item__index {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 600;
  flex-shrink: 0;
}

.merge-item__title {
  flex: 1;
  font-size: var(--font-sm);
  color: var(--color-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merge-item__author {
  font-size: var(--font-xs);
  flex-shrink: 0;
}

.merge-badge {
  font-size: var(--font-xs);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  flex-shrink: 0;
}

.merge-badge--open {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.merge-badge--merged {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.merge-badge--closed {
  background: var(--color-bg-active);
  color: var(--color-text-secondary);
}

.merge-badge--draft {
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border: 1px solid var(--color-warning);
}

.merge-item__detail {
  padding: var(--space-3);
  border-top: 1px solid var(--color-divider);
  background: var(--color-bg);
}

.merge-item__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
}

.merge-item__meta-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.merge-item__meta-row dt {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 500;
  margin: 0;
}

.merge-item__meta-row dd {
  font-size: var(--font-sm);
  color: var(--color-text);
  margin: 0;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
