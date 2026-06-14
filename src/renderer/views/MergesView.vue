<script setup lang="ts">
/**
 * MergesView —— 仓库合并请求列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5 + plan_32018da5）：
 *   - 顶栏：仓库名 + tab 切换（全部 / 开放 / 已合并 / 已关闭）+ 搜索 + 刷新
 *   - 主体：合并请求列表（卡片化：标题 / 编号 / 作者 / 状态徽章 / 合并状态 / 创建时间）
 *   - 详情：点行展开（不跳 gitea web）—— inline 详情 + 合并操作 + 跳 gitea 链接
 *   - 数据：pulls.list IPC → usePullStore
 *
 * 零术语：
 *   - UI 文本**不**出现 PR / merge / rebase 原词
 *     - "合并请求" / "合并" / "变基" / "开放" / "已合并" / "已关闭" / "草稿"
 *     - 禁用词在文案里**不**出现
 *   - 状态徽章：开放（绿）/ 已合并（紫）/ 已关闭（灰）/ 草稿（橙边）
 *   - 卡片左侧：state 色边（OVERRIDE §"lane / 列卡片化"）
 *
 * 危险操作（AGENTS §8.3 + 02-architecture §7.3）：
 *   - 合并操作需二次确认（ConfirmDialog）
 *   - 合并到主线分支额外警告
 *   - 有冲突时禁用合并按钮 + 提示去 gitea 处理
 */
import { computed, onMounted, ref, watch } from 'vue';
import { GitMerge, RefreshCw, Search, ChevronDown, ChevronRight, ExternalLink } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { usePullStore, type PullFilter } from '@renderer/stores/pull';
import { showToast } from '@renderer/lib/toast';
import EmptyState from '@renderer/components/EmptyState.vue';
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import type { PullDto, RepoDto, MergeMethod } from '../../main/ipc/schema.js';

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

// ===== 合并二次确认状态 =====

/** 合并方式选项（人话映射，与 MergeMethodSchema 对齐：gitea swagger 实际支持 4 种） */
const mergeMethods: { value: MergeMethod; label: string; hint: string }[] = [
  { value: 'merge', label: '普通合并', hint: '保留所有提交历史' },
  { value: 'rebase', label: '变基', hint: '重写历史，单一线性' },
  { value: 'rebase-merge', label: '变基+合并', hint: '重写历史 + 保留合并提交' },
  { value: 'squash', label: '压缩', hint: 'N 个提交合成 1 个' },
];

/** 当前选中的合并方式 */
const selectedMethod = ref<MergeMethod>('merge');

/** 当前正在合并的合并请求（null = 没在合并） */
const mergingPull = ref<PullDto | null>(null);
const merging = ref(false);
const squashMessage = ref('');

/** 二次确认弹窗开关 */
const confirmMergeOpen = ref(false);

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

/** 生成 gitea web 链接 */
function giteaPullUrl(p: PullDto): string {
  if (!activeRepo.value) return '#';
  const base = activeRepo.value.url?.replace(/\/+$/, '') ?? `https://${activeRepo.value.fullName}`;
  return `${base}/pulls/${p.index}`;
}

/** 判断目标分支是否是主线分支（需要额外警告） */
function isMainBranch(refName: string): boolean {
  const mainNames = ['main', 'master', 'trunk', 'develop'];
  return mainNames.includes(refName.toLowerCase());
}

/** 需要 squash commitMessage */
function needsCommitMessage(method: MergeMethod): boolean {
  return method === 'squash';
}

/** 点击合并按钮 → 弹二次确认 */
function requestMerge(p: PullDto): void {
  if (p.hasConflicts || !p.mergeable) return;
  mergingPull.value = p;
  selectedMethod.value = 'merge';
  squashMessage.value = '';
  confirmMergeOpen.value = true;
}

/** 二次确认 → 执行合并 */
async function performMerge(): Promise<void> {
  const p = mergingPull.value;
  if (!p || !activeProjectId.value) return;
  confirmMergeOpen.value = false;
  merging.value = true;
  try {
    const result = await pull.mergePull({
      projectId: activeProjectId.value,
      index: p.index,
      method: selectedMethod.value,
      commitMessage: needsCommitMessage(selectedMethod.value) ? squashMessage.value : undefined,
    });
    if (result.merged) {
      showToast({ type: 'success', message: `#${p.index} 合并成功` });
    } else {
      showToast({ type: 'error', message: `#${p.index} 合并未完成：${result.message || '未知原因'}` });
    }
  } catch (e) {
    const err = e as { messageText?: string; hint?: string };
    showToast({ type: 'error', message: err.messageText ?? '合并失败' });
  } finally {
    merging.value = false;
    mergingPull.value = null;
  }
}

/** 取消合并确认 */
function cancelMerge(): void {
  confirmMergeOpen.value = false;
  mergingPull.value = null;
}

/** 生成二次确认描述文案 */
const confirmDescription = computed(() => {
  const p = mergingPull.value;
  if (!p) return '';
  const methodInfo = mergeMethods.find((m) => m.value === selectedMethod.value);
  const methodLabel = methodInfo?.label ?? selectedMethod.value;
  const methodHint = methodInfo?.hint ?? '';
  let desc = `将把 #${p.index}「${p.title}」以「${methodLabel}」方式合并到 ${p.base.ref}。`;
  if (methodHint) desc += `\n\n方式说明：${methodHint}`;
  if (isMainBranch(p.base.ref)) {
    desc += '\n\n⚠️ 目标是主线分支，将影响所有协作者的工作流。';
  }
  return desc;
});

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
          <!-- 操作区 -->
          <div class="merge-item__actions">
            <!-- 合并按钮：仅开放且可合并时显示 -->
            <button
              v-if="p.state === 'open' && !p.draft"
              type="button"
              class="merge-item__btn merge-item__btn--merge"
              :disabled="p.hasConflicts || !p.mergeable || merging"
              :title="p.hasConflicts ? '有冲突，请先在 gitea 页面解决冲突' : !p.mergeable ? '当前不可合并' : '合并此请求'"
              @click.stop="requestMerge(p)"
            >
              <GitMerge :size="14" :stroke-width="2" aria-hidden="true" />
              <span>{{ merging && mergingPull?.index === p.index ? '合并中…' : '合并' }}</span>
            </button>
            <!-- 有冲突时提示 -->
            <span v-if="p.hasConflicts && p.state === 'open'" class="merge-item__conflict-hint">
              有冲突，请先在 gitea 解决
            </span>
            <!-- 跳 gitea 链接 -->
            <a
              :href="giteaPullUrl(p)"
              target="_blank"
              rel="noopener"
              class="merge-item__ext-link"
              :title="'在 gitea 中打开 #' + p.index"
              @click.stop
            >
              <ExternalLink :size="14" :stroke-width="2" aria-hidden="true" />
              <span>在 gitea 中打开</span>
            </a>
          </div>
        </div>
      </li>
    </ul>

    <!-- ============== 合并二次确认弹窗 ============== -->
    <ConfirmDialog
      :open="confirmMergeOpen"
      title="确认合并"
      :description="confirmDescription"
      confirm-label="我了解风险，仍要合并"
      :danger="isMainBranch(mergingPull?.base.ref ?? '')"
      @update:open="confirmMergeOpen = $event"
      @confirm="performMerge"
      @cancel="cancelMerge"
    >
      <!-- 合并方式选择 slot：放在 description 后面、确认按钮前面 -->
      <div class="merge-confirm__methods">
        <p class="merge-confirm__methods-title">选择合并方式：</p>
        <div class="merge-confirm__method-list">
          <label
            v-for="m in mergeMethods"
            :key="m.value"
            class="merge-confirm__method"
            :class="{ 'merge-confirm__method--active': selectedMethod === m.value }"
          >
            <input
              v-model="selectedMethod"
              type="radio"
              :value="m.value"
              class="merge-confirm__radio"
            />
            <span class="merge-confirm__method-label">{{ m.label }}</span>
            <span class="merge-confirm__method-hint">{{ m.hint }}</span>
          </label>
        </div>
        <!-- squash 需要输入 commitMessage -->
        <div v-if="needsCommitMessage(selectedMethod)" class="merge-confirm__message">
          <label class="merge-confirm__message-label" for="squash-msg">合并提交信息（必填）：</label>
          <input
            id="squash-msg"
            v-model="squashMessage"
            type="text"
            class="merge-confirm__message-input"
            placeholder="请输入合并提交信息"
            autocomplete="off"
          />
        </div>
      </div>
    </ConfirmDialog>
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
  /* 防止子 grid/flex 内容把 detail 横向撑出父容器 */
  min-width: 0;
  overflow-x: auto;
}

.merge-item__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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

/* ===== 操作区 ===== */

.merge-item__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-divider);
  /* 窄窗口时允许换行（防止按钮被裁） */
  flex-wrap: wrap;
}

.merge-item__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}

.merge-item__btn--merge {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.merge-item__btn--merge:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.merge-item__btn--merge:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.merge-item__conflict-hint {
  font-size: var(--font-xs);
  color: var(--color-warning);
}

.merge-item__ext-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  background: transparent;
  border-radius: var(--radius-sm);
  transition: background var(--t-fast) var(--ease);
  text-decoration: none;
  /* wrap 时不再用 auto 推到右边，让其自然排到下一行第一个位置 */
}

.merge-item__ext-link:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== 合并确认弹窗内嵌 ===== */

.merge-confirm__methods {
  margin-top: var(--space-3);
}

.merge-confirm__methods-title {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
  margin: 0 0 var(--space-2) 0;
}

.merge-confirm__method-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.merge-confirm__method {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}

.merge-confirm__method:hover {
  background: var(--color-bg-hover);
}

.merge-confirm__method--active {
  background: var(--color-primary-soft);
}

.merge-confirm__radio {
  margin: 0;
  accent-color: var(--color-primary);
}

.merge-confirm__method-label {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
}

.merge-confirm__method-hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.merge-confirm__message {
  margin-top: var(--space-3);
}

.merge-confirm__message-label {
  display: block;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.merge-confirm__message-input {
  width: 100%;
  padding: 4px 8px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-divider);
  font-size: var(--font-sm);
  color: var(--color-text);
}

.merge-confirm__message-input:focus {
  outline: 2px solid var(--color-primary);
  outline-offset: -1px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
