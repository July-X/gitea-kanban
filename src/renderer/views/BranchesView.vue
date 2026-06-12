<script setup lang="ts">
/**
 * BranchesView —— 仓库分支列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5 + plan_32018da5）：
 *   - 顶栏：仓库名 + 总分支数 + 搜索框 + "仅看收藏" toggle + 刷新按钮
 *   - 主体：分支列表（卡片化：name / 默认分支高亮 / 收藏星标 / 最后 commit / 创建时间）
 *   - 数据：branches.list IPC → useBranchStore
 *   - 跳转：双击 name 跳 gitea（v1 走 window.open，**不**直接 gitea 嵌入）
 *
 * 零术语：UI 文本**不**出现 branch 原词（除"分支"）。
 *   - 列表头："分支 / 默认 / 收藏 / 最后提交 / 更新时间"
 *
 * v1 简化：
 *   - **不**做新建/重命名/删除分支（v1 只读）
 *   - 收藏走 branches.star IPC（**不**在 v1 上，留 v2）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { GitBranch, RefreshCw, Search, Star, StarOff } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { showToast } from '@renderer/lib/toast';
import EmptyState from '@renderer/components/EmptyState.vue';
import type { BranchDto, RepoDto } from '../../main/ipc/schema.js';

const auth = useAuthStore();
const repo = useRepoStore();
const branch = useBranchStore();
const router = useRouter();
const route = useRoute();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

onMounted(async () => {
  // 1. 仓库列表就绪
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  // 2. 默认选第一个 project（如果当前没有）
  if (!activeProjectId.value && repo.projects.length > 0) {
    const first = repo.projects[0]!;
    try {
      const project = await repo.addProject({ owner: first.owner, name: first.name });
      repo.selectProject(project);
    } catch {
      /* error in repo.error */
    }
  }
  // 3. 拉分支
  if (activeProjectId.value) {
    await loadBranches();
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    if (id) {
      await loadBranches();
    } else {
      branch.$reset?.();
    }
  },
);

async function loadBranches(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    await branch.list(activeProjectId.value, true);
  } catch (e) {
    // error 已在 store 里
    const err = e as { messageText?: string };
    showToast({
      type: 'error',
      message: err.messageText ?? '加载失败',
      description: '请稍后重试或检查网络',
    });
  }
}

async function onRefresh(): Promise<void> {
  try {
    await branch.refresh();
    showToast({ type: 'success', message: `已刷新，共 ${branch.total} 条` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '刷新失败' });
  }
}

/** 双击 name 跳 gitea（v1 走外部浏览器） */
function onOpenInGitea(b: BranchDto): void {
  if (!activeRepo.value) return;
  const url = `https://${activeRepo.value.owner}/${activeRepo.value.name}/src/branch/${encodeURIComponent(b.name)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 格式化 ISO 时间到本地短格式 */
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

/** commit shortSha 截前 7 */
function shortSha(sha: string | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}
</script>

<template>
  <div class="branches">
    <!-- ============== 顶栏 ============== -->
    <header class="branches__topbar">
      <div class="branches__title">
        <GitBranch :size="18" :stroke-width="1.75" aria-hidden="true" />
        <div class="branches__title-text">
          <h1 class="branches__title-h1">分支</h1>
          <p class="branches__repo">{{ activeRepo?.fullName ?? '请选择仓库' }}</p>
        </div>
      </div>
      <div class="branches__topbar-right">
        <span class="branches__counter">
          共 {{ branch.total }} 个分支<template v-if="branch.total">
            · 收藏 {{ branch.starredItems.length }} 个
          </template>
        </span>
        <button
          type="button"
          class="branches__refresh"
          :disabled="branch.loading"
          :title="'刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: branch.loading }" />
          <span>{{ branch.loading ? '加载中…' : '刷新' }}</span>
        </button>
      </div>
    </header>

    <!-- ============== 搜索 + 过滤 ============== -->
    <div v-if="activeProjectId" class="branches__filters">
      <div class="branches__search">
        <Search :size="14" :stroke-width="2" aria-hidden="true" />
        <input
          v-model="branch.search"
          type="text"
          class="branches__search-input"
          placeholder="按名称搜索"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <label class="branches__toggle" :title="'仅看收藏'">
        <input v-model="branch.onlyStarred" type="checkbox" />
        <Star v-if="branch.onlyStarred" :size="14" :stroke-width="2" aria-hidden="true" />
        <StarOff v-else :size="14" :stroke-width="2" aria-hidden="true" />
        <span>仅看收藏</span>
      </label>
    </div>

    <!-- ============== 错误条 ============== -->
    <div v-if="branch.error" class="branches__error" role="alert">
      <p class="branches__error-msg">{{ branch.error.messageText }}</p>
      <p class="branches__error-hint">{{ branch.error.hint }}</p>
    </div>

    <!-- ============== 主体：列表 ============== -->
    <div v-if="!activeRepo" class="branches__placeholder">
      <EmptyState title="还没有选中仓库" description='去"看板"页选一个仓库，再回来这里看分支' />
    </div>
    <div v-else-if="branch.loading && branch.items.length === 0" class="branches__placeholder">
      <p class="muted">加载中…</p>
    </div>
    <div
      v-else-if="!branch.filteredItems.length && branch.items.length > 0"
      class="branches__placeholder"
    >
      <EmptyState title="没有匹配的分支" description="试试别的搜索词，或取消「仅看收藏」" />
    </div>
    <div v-else-if="!branch.items.length" class="branches__placeholder">
      <EmptyState title="这个仓库还没有分支" description="去 gitea 创建第一个分支" />
    </div>
    <ul v-else class="branches__list">
      <li
        v-for="b in branch.filteredItems"
        :key="b.name"
        class="branch-item"
        :class="{
          'branch-item--default': b.isDefault,
          'branch-item--starred': b.starred,
        }"
        @dblclick="onOpenInGitea(b)"
      >
        <div class="branch-item__head">
          <div class="branch-item__name-wrap">
            <GitBranch :size="14" :stroke-width="2" aria-hidden="true" class="branch-item__icon" />
            <span class="branch-item__name mono">{{ b.name }}</span>
            <span v-if="b.isDefault" class="branch-item__default-tag">默认</span>
            <span v-if="b.protected" class="branch-item__protected-tag" :title="'默认禁止直接推送，需走合并请求'">受保护</span>
          </div>
          <div class="branch-item__star">
            <Star
              v-if="b.starred"
              :size="14"
              :stroke-width="2"
              :fill="'currentColor'"
              aria-hidden="true"
              class="branch-item__star-icon branch-item__star-icon--on"
            />
            <StarOff v-else :size="14" :stroke-width="2" aria-hidden="true" class="branch-item__star-icon" />
          </div>
        </div>
        <div v-if="b.lastCommit" class="branch-item__commit">
          <span class="branch-item__sha mono">{{ shortSha(b.lastCommit.sha) }}</span>
          <span class="branch-item__msg">{{ b.lastCommit.message }}</span>
          <span class="branch-item__author muted">— {{ b.lastCommit.author }}</span>
        </div>
        <div v-else class="branch-item__commit muted">— 暂无提交</div>
        <div class="branch-item__meta muted">
          更新于 {{ formatDate(b.lastCommit?.date) }}
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.branches {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.branches__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
}

.branches__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  min-width: 0;
}

.branches__title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.branches__title-h1 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.branches__repo {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branches__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.branches__counter {
  font-feature-settings: 'tnum';
}

.branches__refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}

.branches__refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.branches__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.branches__filters {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.branches__search {
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

.branches__search-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.branches__search-input:focus {
  background: transparent;
  box-shadow: none;
}

.branches__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
}

.branches__toggle input {
  display: none;
}

.branches__toggle:has(input:checked) {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.branches__error {
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft);
  border-left: 3px solid var(--color-danger);
  font-size: var(--font-sm);
}

.branches__error-msg {
  color: var(--color-text);
  font-weight: 500;
  margin: 0 0 2px;
}

.branches__error-hint {
  color: var(--color-text-secondary);
  margin: 0;
}

.branches__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.branches__list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  overflow-y: auto;
}

.branch-item {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background var(--t-fast) var(--ease);
  cursor: default;
}

.branch-item:hover {
  background: var(--color-bg-hover);
}

.branch-item--default {
  border-left: 3px solid var(--color-primary);
}

.branch-item--starred {
  background: var(--color-primary-soft);
}

.branch-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.branch-item__name-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.branch-item__icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.branch-item__name {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-item__default-tag {
  font-size: var(--font-xs);
  background: var(--color-primary);
  color: var(--color-text-inverse);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  flex-shrink: 0;
}

.branch-item__protected-tag {
  font-size: var(--font-xs);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}

.branch-item__star {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.branch-item__star-icon {
  display: inline-block;
}

.branch-item__star-icon--on {
  color: var(--color-warning);
}

.branch-item__commit {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  overflow: hidden;
}

.branch-item__sha {
  color: var(--color-primary);
  flex-shrink: 0;
}

.branch-item__msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-item__author {
  flex-shrink: 0;
}

.branch-item__meta {
  font-size: var(--font-xs);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
