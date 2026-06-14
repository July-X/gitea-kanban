<script setup lang="ts">
/**
 * MergesView —— 仓库合并请求列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5 + plan_32018da5）：
 *   - 顶栏：仓库名 + tab 切换（全部 / 待合并 / 已合并 / 已关闭）+ 搜索 + 刷新
 *   - 主体：合并请求列表（卡片化：标题 / 编号 / 作者 / 状态徽章 / 合并状态 / 创建时间）
 *   - 详情：点行展开（不跳 gitea web）—— inline 详情 + 合并操作 + 跳 gitea 链接
 *   - 数据：pulls.list IPC → usePullStore
 *
 * 零术语：
 *   - UI 文本**不**出现 PR / merge / rebase 原词
 *     - "合并请求" / "合并" / "变基" / "待合并" / "已合并" / "已关闭" / "草稿"
 *     - 禁用词在文案里**不**出现
 *   - 状态徽章：待合并（绿）/ 已合并（紫）/ 已关闭（灰）/ 草稿（橙边）
 *   - 卡片左侧：state 色边（OVERRIDE §"lane / 列卡片化"）
 *
 * 危险操作（AGENTS §8.3 + 02-architecture §7.3）：
 *   - 合并操作需二次确认（ConfirmDialog）
 *   - 合并到主线分支额外警告
 *   - 有冲突时禁用合并按钮 + 提示去 gitea 处理
 */
import { computed, onMounted, ref, watch } from 'vue';
import { GitMerge, GitPullRequestArrow, GitBranch, RefreshCw, Search, ChevronDown, ChevronRight, ExternalLink, XCircle, Pencil } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { usePullStore, type PullFilter } from '@renderer/stores/pull';
import { useAuthStore } from '@renderer/stores/auth';
import { showToast } from '@renderer/lib/toast';
import EmptyState from '@renderer/components/EmptyState.vue';
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import type { PullDto, RepoDto, MergeMethod } from '../../main/ipc/schema.js';

const repo = useRepoStore();
const pull = usePullStore();
const auth = useAuthStore();

/** 去掉 URL 末尾的 `/` 字符（gitea URL 拼接用）
 *
 * 为什么不用 template 里的 inline regex literal：
 * Vue 3 SFC compiler 在 attribute expression 里 parse regex literal 时
 * 对 `\\` 转义处理不一致，写 `/\\/$/` 会触发 "Invalid regular expression flag"。
 * 抽成函数 + string method 是最稳的写法。
 */
function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/** 展开的合并请求 index Set（UI 状态，**不**持久化） */
const expanded = ref<Set<number>>(new Set());

/** tab 列表：全部 / 待合并 / 已合并 / 已关闭 */
const tabs: { id: PullFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '待合并' },
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

/** 当前正在关闭的合并请求（null = 没在关闭） */
const closingPull = ref<PullDto | null>(null);
const closing = ref(false);

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

/** 生成 gitea web 链接（reactive：跟随 giteaUrl / activeRepo 变化）
 *
 * 不用 RepoDto.url 字段——schema 里没这个字段，
 * 硬拼会得到 "https://kanban demo/m4java-test" 这种带空格的非法 URL。
 * 用 useAuthStore.currentGiteaUrl + 当前 activeRepo.owner/name 拼接。
 */
function giteaPullUrl(p: PullDto): string {
  if (!activeRepo.value) return '#';
  const giteaUrl = (auth.currentGiteaUrl || '').replace(/\/+$/, '');
  if (!giteaUrl) return '#';
  return `${giteaUrl}/${activeRepo.value.owner}/${activeRepo.value.name}/pulls/${p.index}`;
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

// ===== 关闭合并请求（不合并） =====

/** 二次确认弹窗开关（关闭用） */
const confirmCloseOpen = ref(false);

// ===== 属性编辑器 =====

/** 属性编辑器状态 */
const attrEditorOpen = ref(false);
const editingPull = ref<PullDto | null>(null);
const editingLabels = ref<string[]>([]);
const editingAssignee = ref('');
const editingReviewers = ref<string[]>([]);

/** 可用标签列表（从 store 或 IPC 获取） */
const availableLabels = ref<{ name: string; color: string }[]>([]);
/** 可用成员列表 */
const availableMembers = ref<string[]>([]);

/** 打开属性编辑器 */
async function openAttrEditor(p: PullDto): Promise<void> {
  editingPull.value = p;
  editingLabels.value = (p.labels ?? []).map(l => l.name);
  editingAssignee.value = p.assignee?.username ?? '';
  editingReviewers.value = (p.reviewers ?? []).map(r => r.username);
  attrEditorOpen.value = true;

  // 加载可用标签和成员
  if (activeProjectId.value) {
    try {
      const labelsResp = await window.api.labels.list({ projectId: activeProjectId.value }) as { items: { name: string; color: string }[] };
      availableLabels.value = labelsResp.items ?? [];
    } catch { /* 忽略 */ }
    try {
      // members.list 返回直接是数组（不是 {items}）
      const membersResp = await window.api.members.list({ projectId: activeProjectId.value }) as { username: string }[];
      availableMembers.value = (membersResp ?? []).map(m => m.username);
    } catch { /* 忽略 */ }
  }
}

/** 关闭属性编辑器 */
function closeAttrEditor(): void {
  attrEditorOpen.value = false;
  editingPull.value = null;
}

/** 切换标签选择 */
function toggleLabel(name: string): void {
  const idx = editingLabels.value.indexOf(name);
  if (idx >= 0) editingLabels.value.splice(idx, 1);
  else editingLabels.value.push(name);
}

/** 切换评审人选择 */
function toggleReviewer(name: string): void {
  const idx = editingReviewers.value.indexOf(name);
  if (idx >= 0) editingReviewers.value.splice(idx, 1);
  else editingReviewers.value.push(name);
}

/** 保存属性 */
async function saveAttrs(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    // 更新标签
    await window.api.pulls.updateLabels({
      projectId: activeProjectId.value,
      index: p.index,
      labels: editingLabels.value,
    });
    // 更新指派人
    if (editingAssignee.value) {
      await window.api.pulls.updateAssignee({
        projectId: activeProjectId.value,
        index: p.index,
        assignee: editingAssignee.value,
      });
    }
    // 更新评审人
    if (editingReviewers.value.length > 0) {
      await window.api.pulls.updateReviewers({
        projectId: activeProjectId.value,
        index: p.index,
        reviewers: editingReviewers.value,
      });
    }
    showToast({ type: 'success', message: `#${p.index} 属性已更新` });
    closeAttrEditor();
    // 刷新列表
    await pull.refresh();
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '更新失败' });
  }
}

/** 点击关闭按钮 → 弹二次确认 */
function requestClose(p: PullDto): void {
  closingPull.value = p;
  confirmCloseOpen.value = true;
}

/** 二次确认 → 执行关闭 */
async function performClose(): Promise<void> {
  const p = closingPull.value;
  if (!p || !activeProjectId.value) return;
  confirmCloseOpen.value = false;
  closing.value = true;
  try {
    const result = await pull.closePull({
      projectId: activeProjectId.value,
      index: p.index,
    });
    if (result.closed) {
      showToast({ type: 'success', message: `#${p.index} 已关闭` });
    }
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '关闭失败' });
  } finally {
    closing.value = false;
    closingPull.value = null;
  }
}

/** 取消关闭确认 */
function cancelClose(): void {
  confirmCloseOpen.value = false;
  closingPull.value = null;
}

/** 关闭确认描述文案 */
const closeConfirmDescription = computed(() => {
  const p = closingPull.value;
  if (!p) return '';
  return `将关闭 #${p.index}「${p.title}」。\n\n关闭后此合并请求将不再可合并，需要在 gitea 页面重新打开。`;
});

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
  if (p.state === 'open') return '待合并';
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

/** 相对时间（"3 小时前" 风格）—— 仿 gitea <relative-time> */
function formatRelative(iso: string | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso ?? '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return formatDate(iso);
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
        <div class="merges__merge-method">
          <label class="merges__merge-method-label" for="default-merge-method">合并方式：</label>
          <select
            id="default-merge-method"
            v-model="selectedMethod"
            class="merges__merge-method-select"
          >
            <option
              v-for="m in mergeMethods"
              :key="m.value"
              :value="m.value"
            >{{ m.label }}</option>
          </select>
        </div>
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
        <!-- 模仿 gitea /pulls 列表布局：
             [leading: 状态图标] [main: 标题 + #index + 时间/作者 + 分支流向] [trailing: 操作按钮] -->
        <div class="merge-item__leading" aria-hidden="true">
          <GitPullRequestArrow
            v-if="!p.merged && !p.draft && p.state === 'open'"
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--open"
          />
          <GitPullRequestArrow
            v-else-if="p.merged"
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--merged"
          />
          <GitPullRequestArrow
            v-else-if="p.draft"
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--draft"
          />
          <GitPullRequestArrow
            v-else
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--closed"
          />
        </div>
        <div class="merge-item__main">
          <div class="merge-item__header">
            <a
              :href="giteaPullUrl(p)"
              target="_blank"
              rel="noopener"
              class="merge-item__title"
              :title="p.title"
            >{{ p.title }}</a>
            <span :class="badgeClass(p)" class="merge-item__badge">{{ badgeText(p) }}</span>
            <button
              type="button"
              class="merge-item__expand"
              :aria-expanded="expanded.has(p.index)"
              :aria-label="expanded.has(p.index) ? '收起详情' : '展开详情'"
              @click="toggleExpand(p.index)"
            >
              <ChevronDown v-if="expanded.has(p.index)" :size="14" :stroke-width="2" />
              <ChevronRight v-else :size="14" :stroke-width="2" />
            </button>
          </div>
          <div class="merge-item__body">
            <a
              :href="giteaPullUrl(p)"
              target="_blank"
              rel="noopener"
              class="merge-item__index mono"
            >#{{ p.index }}</a>
            <span class="merge-item__meta-line">
              <span class="merge-item__meta-text">打开于 {{ formatRelative(p.createdAt) }}</span>
              <span class="merge-item__meta-text">由</span>
              <a
                v-if="activeRepo"
                :href="`${stripTrailingSlash(auth.currentGiteaUrl)}/${activeRepo.owner}`"
                target="_blank"
                rel="noopener"
                class="merge-item__author-link"
              >{{ p.author.username }}</a>
              <span v-else class="merge-item__author">{{ p.author.username }}</span>
            </span>
            <!-- 分支流向（base ← head），照搬 gitea /pulls 列表 -->
            <div class="merge-item__branches">
              <a
                :href="`${stripTrailingSlash(auth.currentGiteaUrl)}/${activeRepo?.owner ?? ''}/${activeRepo?.name ?? ''}/src/branch/${p.base.ref}`"
                target="_blank"
                rel="noopener"
                class="merge-item__branch"
                :title="p.base.ref"
              ><GitBranch :size="12" :stroke-width="2" aria-hidden="true" />{{ p.base.ref }}</a>
              <span class="merge-item__branch-arrow" aria-hidden="true">←</span>
              <a
                :href="`${stripTrailingSlash(auth.currentGiteaUrl)}/${activeRepo?.owner ?? ''}/${activeRepo?.name ?? ''}/src/branch/${p.head.ref}`"
                target="_blank"
                rel="noopener"
                class="merge-item__branch"
                :title="p.head.ref"
              ><GitBranch :size="12" :stroke-width="2" aria-hidden="true" />{{ p.head.ref }}</a>
            </div>
            <!-- 标签 + 里程碑 + 指派人 + 评审人（gitea 合并请求属性块） -->
            <div class="merge-item__attrs">
              <span
                v-for="label in (p.labels ?? [])"
                :key="label.id"
                class="merge-item__label"
                :style="{ '--label-color': '#' + label.color, '--label-bg': '#' + label.color + '22' }"
              >{{ label.name }}</span>
              <span
                v-if="p.milestone"
                class="merge-item__milestone"
                :title="p.milestone.title"
              >🎯 {{ p.milestone.title }}</span>
              <span
                v-if="p.assignee"
                class="merge-item__assignee"
              >👤 {{ p.assignee.username }}</span>
              <span
                v-for="reviewer in (p.reviewers ?? [])"
                :key="reviewer.username"
                class="merge-item__reviewer"
              >👁 {{ reviewer.username }}</span>
              <span
                v-if="(p.commentsCount ?? 0) > 0"
                class="merge-item__comments"
              >💬 {{ p.commentsCount }}</span>
            </div>
          </div>
        </div>
        <!-- trailing: 操作按钮（不展开就能直接看到，符合 gitea 把操作放到行内） -->
        <div class="merge-item__trailing">
          <button
            v-if="p.state === 'open' && !p.draft"
            type="button"
            class="merge-item__btn merge-item__btn--merge"
            :disabled="p.hasConflicts || !p.mergeable || merging"
            :title="p.hasConflicts ? '有冲突，请先在 gitea 页面解决冲突' : !p.mergeable ? '当前不可合并' : '合并此请求'"
            @click="requestMerge(p)"
          >
            <GitMerge :size="14" :stroke-width="2" aria-hidden="true" />
            <span>{{ merging && mergingPull?.index === p.index ? '合并中…' : '合并' }}</span>
          </button>
          <!-- 关闭合并请求（不合并，直接关闭）—— 对应 gitea 关闭操作 -->
          <button
            v-if="p.state === 'open'"
            type="button"
            class="merge-item__btn merge-item__btn--close"
            :disabled="closing"
            :title="'关闭此合并请求（不合并）'"
            @click="requestClose(p)"
          >
            <XCircle :size="14" :stroke-width="2" aria-hidden="true" />
            <span>{{ closing && closingPull?.index === p.index ? '关闭中…' : '关闭' }}</span>
          </button>
          <span
            v-if="p.hasConflicts && p.state === 'open'"
            class="merge-item__conflict-hint"
            :title="'此合并请求存在冲突，请先在 gitea 页面解决'"
          >有冲突</span>
          <a
            :href="giteaPullUrl(p)"
            target="_blank"
            rel="noopener"
            class="merge-item__ext-link"
            :title="'在 gitea 中打开 #' + p.index"
          >
            <ExternalLink :size="14" :stroke-width="2" aria-hidden="true" />
          </a>
        </div>
        <!-- 展开区：补充 meta + 二次确认才弹窗的入口（合并已在 trailing） -->
        <div v-if="expanded.has(p.index)" class="merge-item__detail">
          <dl class="merge-item__meta">
            <div class="merge-item__meta-row">
              <dt>作者</dt>
              <dd>{{ p.author.username }}</dd>
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
          <!-- 编辑属性按钮 -->
          <button
            type="button"
            class="merge-item__edit-attrs"
            @click="openAttrEditor(p)"
          >
            <Pencil :size="12" :stroke-width="2" aria-hidden="true" />
            <span>编辑属性</span>
          </button>
        </div>
        <!-- 属性编辑弹窗 -->
        <ConfirmDialog
          :open="attrEditorOpen && editingPull?.index === p.index"
          title="编辑属性"
          :description="`编辑 #${p.index} 的标签、指派人、评审人`"
          confirm-label="保存"
          @update:open="attrEditorOpen = $event"
          @confirm="saveAttrs(p)"
          @cancel="closeAttrEditor"
        >
          <div class="attr-editor">
            <!-- 标签选择 -->
            <div class="attr-editor__section">
              <label class="attr-editor__label">标签：</label>
              <div class="attr-editor__tags">
                <label
                  v-for="label in availableLabels"
                  :key="label.name"
                  class="attr-editor__tag"
                  :class="{ 'attr-editor__tag--selected': editingLabels.includes(label.name) }"
                  :style="{ '--tag-color': '#' + label.color, '--tag-bg': '#' + label.color + '22' }"
                >
                  <input
                    type="checkbox"
                    :value="label.name"
                    :checked="editingLabels.includes(label.name)"
                    class="attr-editor__checkbox"
                    @change="toggleLabel(label.name)"
                  />
                  <span>{{ label.name }}</span>
                </label>
              </div>
            </div>
            <!-- 指派人 -->
            <div class="attr-editor__section">
              <label class="attr-editor__label" for="attr-assignee">指派人：</label>
              <select
                id="attr-assignee"
                v-model="editingAssignee"
                class="attr-editor__select"
              >
                <option value="">未指派</option>
                <option
                  v-for="member in availableMembers"
                  :key="member"
                  :value="member"
                >{{ member }}</option>
              </select>
            </div>
            <!-- 评审人 -->
            <div class="attr-editor__section">
              <label class="attr-editor__label">评审人：</label>
              <div class="attr-editor__tags">
                <label
                  v-for="member in availableMembers"
                  :key="member"
                  class="attr-editor__tag"
                  :class="{ 'attr-editor__tag--selected': editingReviewers.includes(member) }"
                >
                  <input
                    type="checkbox"
                    :value="member"
                    :checked="editingReviewers.includes(member)"
                    class="attr-editor__checkbox"
                    @change="toggleReviewer(member)"
                  />
                  <span>{{ member }}</span>
                </label>
              </div>
            </div>
          </div>
        </ConfirmDialog>
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

    <!-- ============== 关闭二次确认弹窗 ============== -->
    <ConfirmDialog
      :open="confirmCloseOpen"
      title="确认关闭"
      :description="closeConfirmDescription"
      confirm-label="确认关闭"
      :danger="true"
      @update:open="confirmCloseOpen = $event"
      @confirm="performClose"
      @cancel="cancelClose"
    />
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

.merges__merge-method {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-xs);
}

.merges__merge-method-label {
  color: var(--color-text-muted);
  white-space: nowrap;
}

.merges__merge-method-select {
  padding: 2px 6px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text);
  cursor: pointer;
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
  /* 关键：父 .merges__list 是 flex column，
   * 子 item 默认 flex-shrink: 1 会让每个 item 被等比压缩。
   * 43 个 item 共 1870px head 高，容器 622px 会被压缩到每个 15px——
   * 完全看不见。设 flex-shrink: 0 让 item 保持完整高度，
   * 容器才触发 overflow-y: auto 滚动。 */
  flex-shrink: 0;
  /* 模仿 gitea /pulls 列表的 .flex-item 三块布局：leading | main | trailing */
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
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

/* ===== leading: 状态图标（gitea octicon-git-pull-request 风格） ===== */

.merge-item__leading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 2px;
}

.merge-item__icon--open {
  color: var(--color-success);
}
.merge-item__icon--merged {
  color: var(--color-accent);
}
.merge-item__icon--draft {
  color: var(--color-warning);
}
.merge-item__icon--closed {
  color: var(--color-text-muted);
}

/* ===== main: 标题 + meta + body（gitea .flex-item-main） ===== */

.merge-item__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.merge-item__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.merge-item__title {
  font-size: var(--font-md);
  color: var(--color-text);
  font-weight: 600;
  text-decoration: none;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-item__title:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.merge-item__badge {
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

.merge-item__expand {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  flex-shrink: 0;
}
.merge-item__expand:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
  border-radius: var(--radius-sm);
}

.merge-item__body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-width: 0;
}

.merge-item__index {
  color: var(--color-text-muted);
  font-weight: 600;
  text-decoration: none;
}
.merge-item__index:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.merge-item__meta-line {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex-wrap: wrap;
}

.merge-item__meta-text {
  color: var(--color-text-muted);
}

.merge-item__author-link,
.merge-item__author {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 500;
}
.merge-item__author-link:hover {
  text-decoration: underline;
}

/* 分支流向（gitea .branches 块） */
.merge-item__branches {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-width: 0;
}

.merge-item__branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  text-decoration: none;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-item__branch:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.merge-item__branch-arrow {
  color: var(--color-text-muted);
  font-size: 14px;
}

/* 属性块：标签 + 里程碑 + 指派人 + 评审人（gitea 合并请求属性块） */
.merge-item__attrs {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: var(--font-xs);
}

.merge-item__label {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--label-bg, var(--color-bg));
  color: var(--label-color, var(--color-text));
  border: 1px solid var(--label-color, var(--color-divider));
  font-weight: 500;
  white-space: nowrap;
}

.merge-item__milestone,
.merge-item__assignee,
.merge-item__reviewer,
.merge-item__comments {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* ===== trailing: 操作按钮（gitea 把操作放行内） ===== */

.merge-item__trailing {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
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
  background: transparent;
  color: inherit;
  border: 1px solid var(--color-divider);
}
.merge-item__btn--merge {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-color: var(--color-primary);
}
.merge-item__btn--merge:hover:not(:disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}
.merge-item__btn--close {
  background: transparent;
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.merge-item__btn--close:hover:not(:disabled) {
  background: var(--color-danger-soft);
}
.merge-item__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.merge-item__conflict-hint {
  font-size: var(--font-xs);
  color: var(--color-warning);
  padding: 2px 6px;
  background: var(--color-warning-soft);
  border-radius: var(--radius-sm);
}

.merge-item__ext-link {
  display: inline-flex;
  align-items: center;
  padding: 4px 6px;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  transition: background var(--t-fast) var(--ease);
  text-decoration: none;
}
.merge-item__ext-link:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== 展开区：保留 meta 详细（gitea 合并请求详情页的属性块） ===== */

.merge-item__detail {
  grid-column: 1 / -1;
  padding: var(--space-3) 0 0;
  border-top: 1px solid var(--color-divider);
  margin-top: var(--space-3);
}

/* meta 区使用 2 列定宽布局（响应式：< 600px 降为 1 列）
 * 不使用 auto-fit 避免在中间宽度出现 3 列拥挤；
 * 2 列 是信息密度 + 可读性的最佳平衡。 */
.merge-item__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: 0;
}

@media (max-width: 600px) {
  .merge-item__meta {
    grid-template-columns: 1fr;
  }
}

.merge-item__meta-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
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
  /* 长 branch 名字可以断行 */
  word-break: break-all;
  overflow-wrap: anywhere;
  min-width: 0;
}

/* ===== 操作区 ===== */

/* (trailing/btn/conflict-hint/ext-link 已在前面 .merge-item__trailing 段定义) */

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

/* ===== 编辑属性按钮 ===== */

.merge-item__edit-attrs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  margin-top: var(--space-2);
  background: transparent;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.merge-item__edit-attrs:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== 属性编辑器弹窗内容 ===== */

.attr-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.attr-editor__section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.attr-editor__label {
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--color-text-muted);
}

.attr-editor__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.attr-editor__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--tag-bg, var(--color-bg));
  border: 1px solid var(--tag-color, var(--color-divider));
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.attr-editor__tag--selected {
  background: var(--tag-color, var(--color-primary));
  color: var(--color-text-inverse);
}
.attr-editor__checkbox {
  margin: 0;
  accent-color: var(--color-primary);
}

.attr-editor__select {
  padding: 4px 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  color: var(--color-text);
}
</style>
