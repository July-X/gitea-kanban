<script setup lang="ts">
/**
 * BoardView —— 仓库选择 + 看板
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5）：
 *   - 三段式：仓库下拉 / 看板列 / 列内卡片
 *   - 仓库从 repoStore.repos 来（默认取已加为 project 的）
 *   - 选仓库 → 触发 boardStore.loadBoard(projectId) 拉列 + 卡片
 *   - 列渲染：从左到右，宽度自适应（min 280px，gap 14px 显 canvas）
 *   - 卡片：标题 + 标签（颜色 chip）+ 关联数（卡片右侧 hover 显示）
 *   - 危险操作（删卡片）**必须**走二次确认弹窗（OVERRIDE §本项目专属规则 #2）
 *   - 零术语：UI 不出现 PR/merge/rebase/fork/branch/issue/repo/maintainer（走翻译表）
 *
 * v1 简化（与任务边界对齐）：
 *   - 看板列**不**做拖拽（v1.1 补；当前任务范围外，避免一上来就 15min runtime 装不下）
 *   - 新建卡片用 input + Enter 提交，**不**做富文本编辑器
 *   - 卡片详情抽屉 v1 暂不做（M1 补）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronDown,
  GitBranch,
  KeyRound,
  Package,
  Plus,
  Search,
  Trash2,
} from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import type { CardDto, ColumnDto, RepoDto } from '../../main/ipc/schema.js';
import EmptyState from '@renderer/components/EmptyState.vue';
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import { showToast } from '@renderer/lib/toast';

const auth = useAuthStore();
const repo = useRepoStore();
const board = useBoardStore();
const route = useRoute();
const router = useRouter();

const search = ref('');
const showProjectPicker = ref(false);
const confirmDelete = ref<{ open: boolean; card: CardDto | null }>({
  open: false,
  card: null,
});
const newCardDrafts = ref<Record<string, string>>({});

/** 过滤后的仓库列表（搜索框） */
const filteredRepos = computed<RepoDto[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return repo.repos;
  return repo.repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
  );
});

/** 当前选中的 projectId（优先 URL query > store current） */
const activeProjectId = computed<string | null>(() => {
  const qp = route.query.project;
  if (typeof qp === 'string' && qp) return qp;
  return repo.currentProjectId;
});

/** 当前选中的 repo 元信息 */
const activeRepo = computed<RepoDto | null>(() => {
  if (!activeProjectId.value) return null;
  return repo.repos.find((r) => r.fullName === activeProjectId.value) ?? null;
});

/** 选仓库 → 触发加载 + 同步到 URL */
async function selectProject(r: RepoDto): Promise<void> {
  if (!r.isProject) {
    try {
      await repo.addProject({ owner: r.owner, name: r.name });
      showToast({ type: 'success', message: '已加入看板' });
    } catch {
      return;
    }
  }
  repo.selectProject(r.fullName);
  showProjectPicker.value = false;
  void router.replace({ query: { ...route.query, project: r.fullName } });
  try {
    await board.loadBoard(r.fullName);
  } catch {
    /* error 已存 board.error */
  }
}

/** 新建卡片（按列） */
async function createCardInColumn(col: ColumnDto): Promise<void> {
  const title = (newCardDrafts.value[col.id] ?? '').trim();
  if (!title) return;
  try {
    await board.createCard({
      columnId: col.id,
      title,
      position: board.cardsOf(col.id).length,
    });
    newCardDrafts.value[col.id] = '';
    showToast({ type: 'success', message: '卡片已创建' });
  } catch {
    /* error in board.error */
  }
}

/** 触发删除卡片（先弹二次确认） */
function requestDeleteCard(card: CardDto): void {
  confirmDelete.value = { open: true, card };
}

/** 二次确认后真正删除 */
async function performDelete(): Promise<void> {
  const card = confirmDelete.value.card;
  if (!card) return;
  try {
    await board.deleteCard(card.id);
    showToast({ type: 'success', message: '卡片已删除' });
  } catch {
    /* error in board.error */
  }
  confirmDelete.value = { open: false, card: null };
}

onMounted(async () => {
  // 1. 拉仓库列表
  try {
    await repo.loadRepos('', true);
  } catch {
    /* error in repo.error */
  }
  // 2. 如果有活跃 project → 拉看板
  if (activeProjectId.value) {
    try {
      await board.loadBoard(activeProjectId.value);
    } catch {
      /* error */
    }
  }
});

// 监听 auth 状态（断线 / 重连）刷新
watch(
  () => auth.isConnected,
  async (connected) => {
    if (connected) {
      try {
        await repo.loadRepos('', true);
      } catch {
        /* error */
      }
    } else {
      void router.push({ name: 'auth', query: { from: route.fullPath } });
    }
  },
);
</script>

<template>
  <div class="board">
    <!-- ============== 顶部仓库选择条 ============== -->
    <header class="board__topbar">
      <div class="board__picker" @click="showProjectPicker = !showProjectPicker">
        <KeyRound :size="18" :stroke-width="1.75" aria-hidden="true" />
        <span class="board__picker-label">
          <span class="muted text-xs">当前仓库</span>
          <span class="board__picker-name">{{ activeRepo?.fullName ?? '请选择仓库' }}</span>
        </span>
        <ChevronDown :size="16" :stroke-width="2" aria-hidden="true" />
      </div>
      <div class="board__topbar-right">
        <span class="board__counter">
          <Package :size="14" :stroke-width="2" aria-hidden="true" />
          <span>共 {{ repo.repos.length }} 个仓库</span>
        </span>
        <span v-if="board.loading" class="board__loading">加载中…</span>
      </div>
    </header>

    <!-- ============== 仓库下拉面板 ============== -->
    <div v-if="showProjectPicker" class="board__dropdown" role="dialog" aria-label="选择仓库">
      <div class="board__dropdown-search">
        <Search :size="14" :stroke-width="2" aria-hidden="true" />
        <input
          v-model="search"
          type="text"
          class="board__dropdown-input"
          placeholder="搜索仓库（按名称 / 描述）"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <ul v-if="filteredRepos.length" class="board__dropdown-list">
        <li v-for="r in filteredRepos" :key="r.id">
          <button
            type="button"
            class="board__dropdown-item"
            :class="{ 'board__dropdown-item--active': r.fullName === activeProjectId }"
            @click="selectProject(r)"
          >
            <GitBranch :size="14" :stroke-width="2" aria-hidden="true" />
            <span class="board__dropdown-item-name">{{ r.fullName }}</span>
            <span v-if="r.isProject" class="board__dropdown-item-tag">已加入</span>
          </button>
        </li>
      </ul>
      <EmptyState
        v-else
        title="没有匹配的仓库"
        description="试试别的搜索词，或去 gitea 添加新仓库"
      />
    </div>

    <!-- ============== 主区：看板列 ============== -->
    <div v-if="!activeRepo" class="board__placeholder">
      <EmptyState
        title="还没有选中仓库"
        description="点击左上角选择仓库，或去 gitea 添加新仓库"
      />
    </div>
    <div v-else-if="board.loading && board.columns.length === 0" class="board__placeholder">
      <p class="muted">正在加载看板…</p>
    </div>
    <div v-else-if="board.columns.length === 0" class="board__placeholder">
      <EmptyState
        title="这个仓库还没有看板"
        description="让管理员在 gitea 上为这个仓库创建项目看板"
      />
    </div>
    <div v-else class="board__columns">
      <section v-for="col in board.columns" :key="col.id" class="column">
        <header class="column__header">
          <h3 class="column__title">{{ col.name }}</h3>
          <span class="column__count">
            {{ board.cardsOf(col.id).length
            }}<template v-if="col.wipLimit"> / {{ col.wipLimit }}</template>
          </span>
        </header>
        <ul class="column__cards">
          <li
            v-for="card in board.cardsOf(col.id)"
            :key="card.id"
            class="card"
            :style="card.color ? { borderLeftColor: card.color } : undefined"
          >
            <div class="card__title">{{ card.title }}</div>
            <div v-if="card.links.length" class="card__links">
              <span class="card__links-count">{{ card.links.length }} 个关联</span>
            </div>
            <div class="card__actions">
              <button
                type="button"
                class="card__action"
                :aria-label="`删除卡片 ${card.title}`"
                :title="`删除卡片 ${card.title}`"
                @click="requestDeleteCard(card)"
              >
                <Trash2 :size="14" :stroke-width="2" />
              </button>
            </div>
          </li>
        </ul>
        <div class="column__new">
          <input
            v-model="newCardDrafts[col.id]"
            type="text"
            class="column__new-input"
            :placeholder="`在「${col.name}」新建卡片`"
            :disabled="board.loading"
            @keydown.enter="createCardInColumn(col)"
          />
          <button
            type="button"
            class="column__new-btn"
            :disabled="!(newCardDrafts[col.id] ?? '').trim() || board.loading"
            :title="'新建卡片'"
            @click="createCardInColumn(col)"
          >
            <Plus :size="16" :stroke-width="2" />
          </button>
        </div>
      </section>
    </div>

    <!-- ============== 二次确认弹窗 ============== -->
    <ConfirmDialog
      :open="confirmDelete.open"
      title="删除这张卡片？"
      :description="
        confirmDelete.card
          ? `卡片「${confirmDelete.card.title}」将被永久删除，包括它关联的提交、合并请求、议题等。删除后无法撤销。`
          : ''
      "
      confirm-label="我了解风险，仍要删除"
      cancel-label="取消"
      danger
      @update:open="(v) => (confirmDelete.open = v)"
      @confirm="performDelete"
    />
  </div>
</template>

<style scoped>
.board {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.board__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
}

.board__picker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--color-text-secondary);
  transition: background var(--t-fast) var(--ease);
  min-width: 240px;
}

.board__picker:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.board__picker-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.board__picker-name {
  font-size: var(--font-md);
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
}

.board__counter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.board__loading {
  color: var(--color-info);
  font-size: var(--font-xs);
}

.board__dropdown {
  position: absolute;
  top: 64px;
  left: var(--space-4);
  width: 360px;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-nav);
  overflow: hidden;
}

.board__dropdown-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-muted);
}

.board__dropdown-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.board__dropdown-input:focus {
  background: transparent;
  box-shadow: none;
}

.board__dropdown-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1);
}

.board__dropdown-item {
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
}

.board__dropdown-item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.board__dropdown-item--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.board__dropdown-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board__dropdown-item-tag {
  font-size: var(--font-xs);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.board__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.board__columns {
  flex: 1;
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4);
  overflow-x: auto;
  overflow-y: hidden;
  align-items: flex-start;
}

.column {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}

.column__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-3) var(--space-2);
  flex-shrink: 0;
}

.column__title {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--color-text);
}

.column__count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: var(--color-bg);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-feature-settings: 'tnum';
}

.column__cards {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  overflow-y: auto;
  min-height: 60px;
}

.card {
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  border-left: 3px solid var(--color-primary);
  position: relative;
  transition: background var(--t-fast) var(--ease);
}

.card:hover {
  background: var(--color-bg-hover);
}

.card__title {
  font-size: var(--font-sm);
  color: var(--color-text);
  line-height: var(--line-base);
  word-break: break-word;
}

.card__links {
  margin-top: var(--space-2);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.card__links-count {
  display: inline-block;
}

.card__actions {
  position: absolute;
  top: 4px;
  right: 4px;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease);
}

.card:hover .card__actions {
  opacity: 1;
}

.card__action {
  padding: 4px;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.card__action:hover {
  background: var(--color-bg-active);
  color: var(--color-danger);
}

.column__new {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) var(--space-3);
  flex-shrink: 0;
}

.column__new-input {
  flex: 1;
  background: var(--color-bg);
  font-size: var(--font-sm);
}

.column__new-btn {
  padding: 6px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 0 0 1px var(--color-primary-active),
    0 0 8px var(--color-primary-glow);
  transition: background var(--t-fast) var(--ease);
}

.column__new-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.column__new-btn:disabled {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}
</style>
