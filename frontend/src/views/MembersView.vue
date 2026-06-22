<script setup lang="ts">
/**
 * MembersView —— 仓库成员列表（= gitea repo collaborators）
 *
 * 设计（AGENTS §5.2 + plan_32018da5）：
 *   - 顶栏：仓库名 + 总成员数 + 权限 tab 切换（全部 / 管理员 / 可写 / 只读）+ 搜索
 *   - 主体：成员列表（卡片化：头像 / 用户名 / 权限级别 / 卡片数）
 *   - 卡片数：v1 简化 = 在 issues.list 全量基础上本地按 author.username 聚合（**不**调额外 IPC）
 *     没拉的仓库显示 "—" 占位
 *   - 数据：members.list IPC → useMemberStore
 *
 * 零术语：
 *   - "成员" / "管理员" / "可写" / "只读" / "总计 N 人"
 *   - 禁用词：PR / merge / rebase / fork / repo / branch / maintainer
 *     → 权限翻译"管理员"对应 gitea 'admin'（gitea 自己也用"维护者"，按翻译表
 *     走"维护者"；本视图用"管理员"更通俗，PM 更易理解 —— 此项已在
 *     OVERRIDE §本项目专属规则 #1 范围内，**不**算新增）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { Users2, RefreshCw, Search } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { useMemberStore, type MemberFilter, type MemberDto } from '@renderer/stores/member';
import { useBoardStore } from '@renderer/stores/board';
import { showToast } from '@renderer/lib/toast';
import EmptyState from '@renderer/components/EmptyState.vue';
import type { RepoDto } from '@renderer/types/dto';

const repo = useRepoStore();
const member = useMemberStore();
const board = useBoardStore();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

const tabs: { id: MemberFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'admin', label: '管理员' },
  { id: 'write', label: '可写' },
  { id: 'read', label: '只读' },
];

/** 按 username 统计卡片数（v1 简化：来自 board store 当前 open issues；无则 "—"） */
const issueCountByAuthor = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {};
  for (const issues of Object.values(board.issuesByColumn)) {
    for (const i of issues) {
      const u = i.author?.username;
      if (u) map[u] = (map[u] ?? 0) + 1;
    }
  }
  return map;
});

onMounted(async () => {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  // v1.4 任务 #statusbar-picker：删除"未选就默认选第一个"逻辑
  if (activeProjectId.value) {
    await loadMembers();
    // 拉一下看板只为统计卡片数（失败不阻塞）
    try {
      await board.loadBoard(activeProjectId.value);
    } catch {
      /* 静默 */
    }
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    if (id) {
      await loadMembers();
      try {
        await board.loadBoard(id);
      } catch {
        /* 静默 */
      }
    } else {
      member.$reset?.();
    }
  },
);

async function loadMembers(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    await member.list(activeProjectId.value, true);
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '加载失败' });
  }
}

async function onRefresh(): Promise<void> {
  try {
    await member.refresh();
    if (activeProjectId.value) {
      try {
        await board.loadBoard(activeProjectId.value);
      } catch {
        /* 静默 */
      }
    }
    showToast({ type: 'success', message: `已刷新，共 ${member.total} 人` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '刷新失败' });
  }
}

/** 权限 -> 中文 */
function permissionLabel(m: MemberDto): string {
  switch (m.permission) {
    case 'admin':
      return '管理员';
    case 'write':
      return '可写';
    case 'read':
      return '只读';
    default:
      return m.permission;
  }
}

/** 权限 -> 颜色 class */
function permissionClass(m: MemberDto): string {
  switch (m.permission) {
    case 'admin':
      return 'member-perm member-perm--admin';
    case 'write':
      return 'member-perm member-perm--write';
    case 'read':
      return 'member-perm member-perm--read';
    default:
      return 'member-perm';
  }
}
</script>

<template>
  <div class="members">
    <!-- ============== 顶栏 ============== -->
    <header class="members__topbar">
      <div class="members__title">
        <Users2 :size="18" :stroke-width="1.75" aria-hidden="true" />
        <div class="members__title-text">
          <h1 class="members__title-h1">成员</h1>
          <p class="members__repo">{{ activeRepo?.fullName ?? '请选择仓库' }}</p>
        </div>
      </div>
      <div class="members__topbar-right">
        <span class="members__counter">总计 {{ member.total }} 人</span>
        <button
          type="button"
          class="members__refresh"
          :disabled="member.loading"
          :title="'刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" />
          <span>刷新</span>
        </button>
      </div>
    </header>

    <!-- ============== Tabs + 搜索 ============== -->
    <div v-if="activeProjectId" class="members__controls">
      <div class="members__tabs" role="tablist">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          role="tab"
          class="members__tab"
          :class="{ 'members__tab--active': member.filter === t.id }"
          :aria-selected="member.filter === t.id"
          @click="member.setFilter(t.id)"
        >
          <span>{{ t.label }}</span>
          <span class="members__tab-count">{{ member.counts[t.id] }}</span>
        </button>
      </div>
      <div class="members__search">
        <Search :size="14" :stroke-width="2" aria-hidden="true" />
        <input
          v-model="member.search"
          type="text"
          class="members__search-input"
          placeholder="按姓名 / 用户名搜索"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </div>

    <!-- ============== 错误条 ============== -->
    <div v-if="member.error" class="members__error" role="alert">
      <p class="members__error-msg">{{ member.error.messageText }}</p>
      <p class="members__error-hint">{{ member.error.hint }}</p>
    </div>

    <!-- ============== 主体 ============== -->
    <div v-if="!activeRepo" class="members__placeholder">
      <EmptyState title="还没有选中仓库" description='去"看板"页选一个仓库，再回来这里看成员' />
    </div>
    <!--
      v1.4 拍板"替换模式"：删 v-else-if="member.loading && ..." 的"加载中…"占位
      全局海豚 overlay（GlobalLoadingOverlay）接管请求级 loading 指示
    -->
    <div
      v-else-if="!member.filteredItems.length && member.items.length > 0"
      class="members__placeholder"
    >
      <EmptyState
        :title="`没有匹配「${tabs.find((t) => t.id === member.filter)?.label}」的成员`"
        description="试试切换其他 tab，或调整搜索词"
      />
    </div>
    <div v-else-if="!member.items.length" class="members__placeholder">
      <EmptyState title="这个仓库还没有成员" description="去 gitea 邀请第一位协作者" />
    </div>
    <ul v-else class="members__list">
      <li v-for="m in member.filteredItems" :key="m.username" class="member-card">
        <div class="member-card__avatar" aria-hidden="true">
          <img
            v-if="m.avatarUrl"
            :src="m.avatarUrl"
            :alt="m.username"
            class="member-card__avatar-img"
          />
          <span v-else class="member-card__avatar-fallback">
            {{ m.username.slice(0, 1).toUpperCase() }}
          </span>
        </div>
        <div class="member-card__body">
          <div class="member-card__name-wrap">
            <!-- A-3 P3 · W7 修法：有 fullName 时显示「张三（zhang.s）」让 PM 一眼认出 -->
            <span class="member-card__name">
              <template v-if="m.fullName">{{ m.fullName }}<span class="member-card__name-username muted">（{{ m.username }}）</span></template>
              <template v-else>{{ m.username }}</template>
            </span>
            <span :class="permissionClass(m)">{{ permissionLabel(m) }}</span>
          </div>
          <div class="member-card__meta muted">
            卡片数：
            <strong v-if="issueCountByAuthor[m.username] !== undefined" class="member-card__count">
              {{ issueCountByAuthor[m.username] }}
            </strong>
            <span v-else class="member-card__count-na">—</span>
            （按本仓库开放议题统计）
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.members {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.members__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
}

.members__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  min-width: 0;
}

.members__title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.members__title-h1 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.members__repo {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.members__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.members__counter {
  font-feature-settings: 'tnum';
}

.members__refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}

.members__refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.members__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.members__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.members__tabs {
  display: flex;
  gap: 2px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  padding: 2px;
}

.members__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  background: transparent;
}

.members__tab:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.members__tab--active {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.members__tab--active:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-inverse);
}

.members__tab-count {
  font-size: var(--font-xs);
  background: var(--color-bg);
  color: var(--color-text-muted);
  padding: 0 5px;
  border-radius: var(--radius-pill);
  font-feature-settings: 'tnum';
}

.members__tab--active .members__tab-count {
  background: var(--color-primary-active);
  color: var(--color-text-inverse);
}

.members__search {
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

.members__search-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.members__search-input:focus {
  background: transparent;
  box-shadow: none;
}

.members__error {
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft);
  border-left: 3px solid var(--color-danger);
  font-size: var(--font-sm);
}

.members__error-msg {
  color: var(--color-text);
  font-weight: 500;
  margin: 0 0 2px;
}

.members__error-hint {
  color: var(--color-text-secondary);
  margin: 0;
}

.members__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.members__list {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-3);
  padding: var(--space-4);
  overflow-y: auto;
  list-style: none;
  margin: 0;
}

.member-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  transition: background var(--t-fast) var(--ease);
}

.member-card:hover {
  background: var(--color-bg-hover);
}

.member-card__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  flex-shrink: 0;
}

.member-card__avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.member-card__avatar-fallback {
  font-size: var(--font-md);
  font-weight: 600;
}

.member-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.member-card__name-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.member-card__name {
  font-size: var(--font-sm);
  color: var(--color-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A-3 P3 · W7 修法：用户名括号里的弱化显示 */
.member-card__name-username {
  font-weight: 400;
  font-size: var(--font-xs);
}

.member-card__meta {
  font-size: var(--font-xs);
  display: flex;
  align-items: center;
  gap: 4px;
}

.member-card__count {
  color: var(--color-primary);
  font-weight: 600;
  font-feature-settings: 'tnum';
}

.member-card__count-na {
  color: var(--color-text-muted);
}

.member-perm {
  font-size: var(--font-xs);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  flex-shrink: 0;
}

.member-perm--admin {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.member-perm--write {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.member-perm--read {
  background: var(--color-bg-active);
  color: var(--color-text-secondary);
}


</style>
