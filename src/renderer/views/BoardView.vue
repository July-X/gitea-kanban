<script setup lang="ts">
/**
 * BoardView ——仓库选择 +看板（ADR-0002 reset 后版本）
 *
 * 设计（AGENTS §5.2 + ADR-0002 +03-frontend §4.5）：
 * - 三段式：仓库下拉 /看板列 / 列内议题卡片
 * -仓库从 repoStore.repos来（默认取已加为 project的）
 * -选仓库 →触发 boardStore.loadBoard(projectId)拉列 +卡片
 * - 列渲染：从左到右，宽度自适应（min280px，gap14px显 canvas）
 * -卡片：标题 +编号 +标签（颜色 chip）+ 作者 +换列 / 删除按钮
 * -危险操作（删议题 /拖到"已完成"列）**必须**走二次确认弹窗（OVERRIDE §本项目专属规则 #2）
 * - **v1**按钮式换列（点卡片 →弹目标列菜单 →调 issues.moveColumn）
 * 真拖拽（vuedraggable）需 §7.1拍板，v1 不上
 * -零术语：UI 不出现 PR/merge/rebase/fork/branch/repo/maintainer（走翻译表）
 *
 * v1简化：
 * -卡片详情抽屉 v1 不做（M1/M2补）
 * - 富文本编辑器 v1 不做（input + Enter提交）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
 ChevronDown,
 KeyRound,
 Package,
 Plus,
 RotateCcw,
 RotateCw,
 Search,
 Tag,
 Trash2,
 X,
} from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import type { ColumnDto, IssueCardDto, RepoDto } from '../../main/ipc/schema.js';
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
/**换列目标菜单（v1按钮式：点卡片 →选目标列 →调 IPC） */
const moveMenu = ref<{ open: boolean; issue: IssueCardDto | null; fromColumnId: string | null }>({
 open: false,
 issue: null,
 fromColumnId: null,
});
/**删除二次确认 */
const confirmDelete = ref<{ open: boolean; issue: IssueCardDto | null; columnId: string | null }>({
 open: false,
 issue: null,
 columnId: null,
});
/**换到"已完成"列二次确认（v1拖到"已完成"列 = issues.update state=closed，**真**会关 gitea issue） */
const confirmFinish = ref<{
 open: boolean;
 issue: IssueCardDto | null;
 fromColumnId: string | null;
 toColumnId: string | null;
}>({
 open: false,
 issue: null,
 fromColumnId: null,
 toColumnId: null,
});
const newIssueDrafts = ref<Record<string, string>>({});
// v1.1: 列管理 state
const showCreateColumn = ref(false);
const newColumnTitle = ref('');
const creatingColumn = ref(false);
const showColumnMenu = ref<{ open: boolean; column: ColumnDto | null }>({ open: false, column: null });
const editingColumnTitle = ref('');
const confirmDeleteColumn = ref<{ open: boolean; column: ColumnDto | null }>({ open: false, column: null });
const showBindLabel = ref(false);
const bindingLabel = ref(false);

/**过滤后的仓库列表（搜索框） */
const filteredRepos = computed<RepoDto[]>(() => {
 const q = search.value.trim().toLowerCase();
 if (!q) return repo.repos;
 return repo.repos.filter(
 (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
 );
});

/**当前选中的 projectId（优先 URL query > store current） */
const activeProjectId = computed<string | null>(() => repo.currentProjectId);

/**当前选中的仓库元信息 */
const activeRepo = computed<RepoDto | null>(() => {
 if (!activeProjectId.value) return null;
 // store 持有 currentProject（带 owner/name），用 fullName 反查 RepoDto
 const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
 return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/**选仓库 →触发加载 +同步到 URL */
async function selectProject(r: RepoDto): Promise<void> {
 let project;
 if (!r.isProject) {
 try {
 // addProject 返回 RepoProjectDto（uuid 源），store 内部已自动 selectProject
 project = await repo.addProject({ owner: r.owner, name: r.name });
 showToast({ type: 'success', message: '已加入看板' });
 } catch {
 return;
 }
 } else {
 // 已加为 project 的：addProject 是幂等的（cacheAddProject 已存在返现有），
 // 调一次拿真 uuid 给 selectProject
 try {
 project = await repo.addProject({ owner: r.owner, name: r.name });
 } catch {
 return;
 }
 }
 if (project) {
 // 持有真 uuid，IPC 端走 uuid（addProject 内部已经 selectProject 进去了，再调一次显式声明意图）
 repo.selectProject(project);
 }
  showProjectPicker.value = false;
  void router.replace({ query: { ...route.query, project: r.fullName } });
  try {
  // 走 uuid 给 IPC（route query 仍存 fullName 给 UI 友好）
  await board.loadBoard(repo.currentProjectId ?? r.fullName);
  } catch {
  /* error 已存 board.error */
 }
 }

/** 新建议题（按列，自动带上该列绑的 label） */
async function createIssueInColumn(col: ColumnDto): Promise<void> {
 const title = (newIssueDrafts.value[col.id] ?? '').trim();
 if (!title) return;
 try {
 await board.createIssue({
 projectId: activeProjectId.value!,
 columnId: col.id,
 title,
 });
 newIssueDrafts.value[col.id] = '';
 showToast({ type: 'success', message: '已创建议题' });
 } catch {
 /* error in board.error */
 }
 }

/**打开换列菜单（卡片右上角"换列"按钮） */
function openMoveMenu(issue: IssueCardDto, fromColumnId: string): void {
 moveMenu.value = { open: true, issue, fromColumnId };
}

/**关闭换列菜单 */
function closeMoveMenu(): void {
 moveMenu.value = { open: false, issue: null, fromColumnId: null };
}

// v1.1: 列管理 actions
function openCreateColumn(): void { showCreateColumn.value = true; newColumnTitle.value = ''; }
function closeCreateColumn(): void { showCreateColumn.value = false; newColumnTitle.value = ''; }
async function confirmCreateColumn(): Promise<void> {
 const title = newColumnTitle.value.trim();
 if (!title || !activeProjectId.value) return;
 creatingColumn.value = true;
 try {
  await board.createColumn({ projectId: activeProjectId.value, title });
  showToast({ type: 'success', message: '已新增列 ' + title });
  closeCreateColumn();
 } catch { /* board.error */ } finally { creatingColumn.value = false; }
}
function openColumnMenu(col: ColumnDto): void { showColumnMenu.value = { open: true, column: col }; editingColumnTitle.value = col.title; }
function closeColumnMenu(): void { showColumnMenu.value = { open: false, column: null }; editingColumnTitle.value = ''; }
async function confirmUpdateColumn(): Promise<void> {
 const col = showColumnMenu.value.column;
 if (!col) return;
 const title = editingColumnTitle.value.trim();
 if (!title || title === col.title) { closeColumnMenu(); return; }
 try {
  await board.updateColumn({ columnId: col.id, title });
  showToast({ type: 'success', message: '列已改名为 ' + title });
  closeColumnMenu();
 } catch { /* board.error */ }
}
function requestDeleteColumn(): void {
 const col = showColumnMenu.value.column;
 if (!col) return;
 closeColumnMenu();
 confirmDeleteColumn.value = { open: true, column: col };
}
async function performDeleteColumn(): Promise<void> {
 const col = confirmDeleteColumn.value.column;
 if (!col) return;
 confirmDeleteColumn.value = { open: false, column: null };
 try {
  await board.deleteColumn({ columnId: col.id });
  showToast({ type: 'success', message: '列已删除' });
 } catch { /* board.error */ }
}
function openBindLabelPicker(): void { showBindLabel.value = true; }
function closeBindLabelPicker(): void { showBindLabel.value = false; }
async function bindLabel(labelId: number, labelName: string): Promise<void> {
 const col = showColumnMenu.value.column;
 if (!col) return;
 bindingLabel.value = true;
 try {
  await board.mapLabelToColumn({ columnId: col.id, giteaLabelId: labelId, giteaLabelName: labelName });
  showToast({ type: 'success', message: '已绑标签 ' + labelName + ' 到列' });
 } catch { /* board.error */ } finally { bindingLabel.value = false; }
}
async function unbindLabel(labelId: number): Promise<void> {
 const col = showColumnMenu.value.column;
 if (!col) return;
 try {
  await board.unmapLabelFromColumn({ columnId: col.id, giteaLabelId: labelId });
  showToast({ type: 'success', message: '已解绑标签' });
 } catch { /* board.error */ }
}

/** 选择目标列 → 判断是否需要二次确认 */
async function pickTargetColumn(toColumnId: string): Promise<void> {
 const issue = moveMenu.value.issue;
 const fromColumnId = moveMenu.value.fromColumnId;
 if (!issue || !fromColumnId) return;
 closeMoveMenu();
 if (fromColumnId === toColumnId) return;
 //判断：目标列标题是否"已完成"语义 →触发二次确认
 const toCol = board.columns.find((c) => c.id === toColumnId);
 if (toCol && isFinishColumn(toCol)) {
 confirmFinish.value = { open: true, issue, fromColumnId, toColumnId };
 return;
 }
 await performMove(issue, fromColumnId, toColumnId);
}

/**判断列是否"已完成"语义（"已完成" / "Done" / "Closed"，v1简单实现） */
function isFinishColumn(col: ColumnDto): boolean {
 const t = col.title.trim().toLowerCase();
 return t === '已完成' || t === 'done' || t === 'closed' || t.includes('完成');
}

/** 执行换列 */
async function performMove(issue: IssueCardDto, fromColumnId: string, toColumnId: string): Promise<void> {
 try {
 await board.moveIssue({
 projectId: activeProjectId.value!,
 issueIndex: issue.index,
 fromColumnId,
 toColumnId,
 });
 } catch {
 /* error in board.error */
 }
}

/**二次确认后真正换到"已完成"列（顺手把 issue state 关了，**真**会关 gitea issue） */
async function performFinishMove(): Promise<void> {
 const { issue, fromColumnId, toColumnId } = confirmFinish.value;
 if (!issue || !fromColumnId || !toColumnId) return;
 confirmFinish.value = { open: false, issue: null, fromColumnId: null, toColumnId: null };
 try {
 await board.moveIssue({
 projectId: activeProjectId.value!,
 issueIndex: issue.index,
 fromColumnId,
 toColumnId,
 });
 //同步关掉 gitea issue
 const { issuesUpdate } = await import('@renderer/lib/ipc-client');
 await issuesUpdate({
 projectId: activeProjectId.value!,
 issueIndex: issue.index,
 patch: { state: 'closed' },
 });
 showToast({ type: 'success', message: `议题 #${issue.index} 已标记完成` });
 } catch {
 /* error in board.error */
 }
}

/**触发删除议题（先弹二次确认） */
function requestDeleteIssue(issue: IssueCardDto, columnId: string): void {
 confirmDelete.value = { open: true, issue, columnId };
}

/**二次确认后真正关闭议题 */
async function performDelete(): Promise<void> {
 const { issue, columnId } = confirmDelete.value;
 if (!issue || !columnId) return;
 try {
 await board.closeIssue({
 projectId: activeProjectId.value!,
 issueIndex: issue.index,
 });
 showToast({ type: 'success', message: `议题 #${issue.index} 已关闭` });
 } catch {
 /* error in board.error */
 }
 confirmDelete.value = { open: false, issue: null, columnId: null };
}

/**撤销最近一次换列 */
async function undoLastMove(): Promise<void> {
 try {
 await board.undoLastMove(activeProjectId.value!);
 showToast({ type: 'success', message: '已撤销换列' });
 } catch {
 /* error */
 }
}

/**重做最近一次换列 */
async function redoLastMove(): Promise<void> {
 try {
 await board.redoLastMove(activeProjectId.value!);
 showToast({ type: 'success', message: '已重做换列' });
 } catch {
 /* error */
 }
}

onMounted(async () => {
 //1.拉仓库列表
 try {
 await repo.loadRepos('', true);
 } catch {
 /* error in repo.error */
 }
 //2. 如果有活跃 project →拉看板
 if (activeProjectId.value) {
 try {
 await board.loadBoard(activeProjectId.value);
 } catch {
 /* error */
 }
 //3. M6 undo-by-project：拉栈深度（UI 灰化按钮用）
 try {
 await board.loadUndoStatus(activeProjectId.value);
 } catch {
 /* error */
 }
 }
});

//监听 activeProjectId 变化（切仓库时重拉栈深度）
watch(activeProjectId, async (newId) => {
 if (newId) {
 try {
 await board.loadUndoStatus(newId);
 } catch {
 /* error */
 }
 } else {
 // 清空栈深度（避免旧 project 状态残留）
 await board.loadUndoStatus('');
 }
});

//监听 auth状态（断线 / 重连）刷新
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
 <!-- ==============顶部仓库选择条 ============== -->
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
 <button
 v-if="board.canUndo()"
 type="button"
 class="board__undo-btn"
 :disabled="board.loading"
 :title="`撤销最近一次换列（共 ${board.undoSize}步可撤销）`"
 @click="undoLastMove"
 >
 <RotateCcw :size="14" :stroke-width="2" />
 <span>撤销</span>
 </button>
 <button
 v-if="board.canRedo()"
 type="button"
 class="board__redo-btn"
 :disabled="board.loading"
 :title="`重做最近一次换列（共 ${board.redoSize}步可重做）`"
 @click="redoLastMove"
 >
 <RotateCw :size="14" :stroke-width="2" />
 <span>重做</span>
 </button>
 <span class="board__counter">
 <Package :size="14" :stroke-width="2" aria-hidden="true" />
 <span>共 {{ repo.repos.length }} 个仓库</span>
 </span>
 <span v-if="board.loading" class="board__loading">加载中…</span>
 </div>
 </header>

 <!-- ==============仓库下拉面板 ============== -->
 <div v-if="showProjectPicker" class="board__dropdown" role="dialog" aria-label="选择仓库">
 <div class="board__dropdown-search">
 <Search :size="14" :stroke-width="2" aria-hidden="true" />
 <input
 v-model="search"
 type="text"
 class="board__dropdown-input"
 placeholder="搜索仓库（按名称 /描述）"
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
 <div v-else-if="board.loading && board.columns.length ===0" class="board__placeholder">
 <p class="muted">正在加载看板…</p>
 </div>
 <div v-else-if="board.columns.length ===0" class="board__placeholder">
 <EmptyState
 title="这个仓库还没有看板列"
 description="点下方“新增列”创建第一个列，再把 gitea 上的 label绑到列上"
 />
 <button
 type="button"
 class="board__add-col-btn"
 @click="openCreateColumn"
 >
 <Plus :size="16" :stroke-width="2" />
 <span>新增列</span>
 </button>
 </div>
 <div v-else class="board__columns">
 <section v-for="col in board.columns" :key="col.id" class="column">
 <header class="column__header">
 <div class="column__title-wrap">
 <h3 class="column__title">{{ col.title }}</h3>
 <span class="column__count">
 {{ board.issuesOf(col.id).length
 }}<template v-if="col.labels.length"> 个标签</template>
 </span>
 </div>
 <div v-if="col.labels.length" class="column__labels">
 <Tag
 v-for="lab in col.labels"
 :key="lab.id"
 :size="11"
 :stroke-width="2"
 aria-hidden="true"
 class="column__label-icon"
 />
 <span class="column__label-text">{{ col.labels.map((l) => l.name).join(' · ') }}</span>
 </div>
 </header>
  <ul class="column__cards">
  <li
  v-for="issue in board.issuesOf(col.id)"
  :key="issue.id"
  class="card"
  :class="{ 'card--closed': issue.state === 'closed' }"
  tabindex="0"
  role="article"
  :aria-label="`议题 #${issue.index}：${issue.title}`"
  >
 <div class="card__head">
 <span class="card__index mono">#{{ issue.index }}</span>
 <span v-if="issue.state === 'closed'" class="card__state">已关闭</span>
 </div>
 <div class="card__title">{{ issue.title }}</div>
 <div v-if="issue.labels.length" class="card__labels">
 <span
 v-for="lab in issue.labels"
 :key="lab.id"
 class="card__label"
 :style="{ '--label-color': lab.color }"
 >
 {{ lab.name }}
 </span>
 </div>
 <div v-if="issue.author?.fullName || issue.author?.username" class="card__author muted">
 {{ issue.author.fullName || issue.author.username }}
 </div>
 <div class="card__actions">
 <button
 type="button"
 class="card__action"
 :title="`换列：${issue.title}`"
 :disabled="board.loading"
 @click="openMoveMenu(issue, col.id)"
 >
 <ChevronDown :size="14" :stroke-width="2" />
 </button>
 <button
 type="button"
 class="card__action card__action--danger"
 :title="`关闭议题 #${issue.index}`"
 :disabled="board.loading"
 @click="requestDeleteIssue(issue, col.id)"
 >
 <Trash2 :size="14" :stroke-width="2" />
 </button>
 </div>
 </li>
 </ul>
 <div class="column__new">
 <input
 v-model="newIssueDrafts[col.id]"
 type="text"
 class="column__new-input"
 :placeholder="`在「${col.title}」新建议题`"
 :disabled="board.loading"
 @keydown.enter="createIssueInColumn(col)"
 />
 <button
 type="button"
 class="column__new-btn"
 :disabled="!(newIssueDrafts[col.id] ?? '').trim() || board.loading"
 :title="'新建议题'"
 @click="createIssueInColumn(col)"
 >
 <Plus :size="16" :stroke-width="2" />
 </button>
 </div>
 </section>
 </div>

 <!-- ==============换列目标菜单（v1按钮式） ============== -->
 <Teleport to="body">
 <div v-if="moveMenu.open" class="move-menu-overlay" @click.self="closeMoveMenu">
 <div class="move-menu" role="dialog" aria-label="选择目标列">
 <header class="move-menu__header">
 <span class="move-menu__title">把 #{{ moveMenu.issue?.index }}挪到…</span>
 <button type="button" class="move-menu__close" @click="closeMoveMenu">
 <X :size="14" :stroke-width="2" />
 </button>
 </header>
 <ul class="move-menu__list">
 <li v-for="col in board.columns" :key="col.id">
 <button
 type="button"
 class="move-menu__item"
 :class="{ 'move-menu__item--current': col.id === moveMenu.fromColumnId }"
 :disabled="col.id === moveMenu.fromColumnId"
 @click="pickTargetColumn(col.id)"
 >
 <span class="move-menu__item-title">{{ col.title }}</span>
 <span v-if="col.id === moveMenu.fromColumnId" class="move-menu__item-tag">当前</span>
 </button>
 </li>
 </ul>
 <footer class="move-menu__footer">
 <span class="muted">换列 = 在 gitea端改议题标签（原子操作）</span>
 </footer>
 </div>
 </div>
 </Teleport>

 <!-- ============== 删除二次确认 ============== -->
 <ConfirmDialog
 :open="confirmDelete.open"
 title="关闭这张议题？"
 :description="
 confirmDelete.issue
 ? `议题 #${confirmDelete.issue.index}「${confirmDelete.issue.title}」将在 gitea 上标记为已关闭（v1 不真删除）。关闭后你仍能在 gitea 的「已关闭」列表里找到它。`
 : ''
 "
 confirm-label="我了解风险，仍要关闭"
 cancel-label="取消"
 danger
 confirm-keyword="关闭"
 @update:open="(v) => (confirmDelete.open = v)"
 @confirm="performDelete"
 />

 <!-- ==============拖到"已完成"列二次确认 ============== -->
<!-- v1.1: 新增列弹窗 -->
<Teleport to="body">
<div v-if="showCreateColumn" class="modal-overlay" @click.self="closeCreateColumn">
<div class="modal" role="dialog" aria-label="新增列">
<header class="modal__header">
<h2 class="modal__title">新增列</h2>
<button type="button" class="modal__close" @click="closeCreateColumn">
<X :size="16" :stroke-width="2" />
</button>
</header>
<div class="modal__body">
<label class="modal__label" for="new-col-title">列名</label>
<input id="new-col-title" v-model="newColumnTitle" type="text" class="modal__input" placeholder="例如: 待办 / 进行中 / 已完成" :disabled="creatingColumn" maxlength="32" autofocus @keydown.enter="confirmCreateColumn" />
<p class="modal__hint muted">列会按从左到右展示;之后可改列名、删除、或绑 gitea 仓库里的标签</p>
</div>
<footer class="modal__footer">
<button type="button" class="modal__btn modal__btn--ghost" :disabled="creatingColumn" @click="closeCreateColumn">取消</button>
<button type="button" class="modal__btn modal__btn--primary" :disabled="!newColumnTitle.trim() || creatingColumn" @click="confirmCreateColumn">
  {{ creatingColumn ? '创建中...' : '新增列' }}
</button>
</footer>
</div>
</div>
</Teleport>

<!-- v1.1: 列设置弹窗 -->
<Teleport to="body">
<div v-if="showColumnMenu.open" class="modal-overlay" @click.self="closeColumnMenu">
<div class="modal" role="dialog" :aria-label="'设置列 ' + (showColumnMenu.column && showColumnMenu.column.title)">
<header class="modal__header">
<h2 class="modal__title">设置列</h2>
<button type="button" class="modal__close" @click="closeColumnMenu">
<X :size="16" :stroke-width="2" />
</button>
</header>
<div class="modal__body">
<label class="modal__label" for="edit-col-title">列名</label>
<input id="edit-col-title" v-model="editingColumnTitle" type="text" class="modal__input" maxlength="32" @keydown.enter="confirmUpdateColumn" />
<div class="modal__sub">
<p class="modal__sub-title">已绑定的标签</p>
<div v-if="showColumnMenu.column && showColumnMenu.column.labels && showColumnMenu.column.labels.length" class="modal__chip-list">
<span v-for="lab in showColumnMenu.column.labels" :key="lab.id" class="modal__chip" :style="{ '--label-color': lab.color || '#888' }">
  <span class="modal__chip-dot" />
  <span class="modal__chip-name">{{ lab.name }}</span>
  <button type="button" class="modal__chip-rm" :title="'解绑 ' + lab.name" @click="unbindLabel(lab.id)">×</button>
</span>
</div>
<p v-else class="muted modal__empty">还没绑标签</p>
<button type="button" class="modal__btn modal__btn--ghost modal__btn--block" @click="openBindLabelPicker">+ 绑定 gitea 标签</button>
</div>
</div>
<footer class="modal__footer">
<button type="button" class="modal__btn modal__btn--danger" @click="requestDeleteColumn">
  <Trash2 :size="14" :stroke-width="2" />
  <span>删除此列</span>
</button>
<div class="modal__footer-right">
  <button type="button" class="modal__btn modal__btn--ghost" @click="closeColumnMenu">取消</button>
  <button type="button" class="modal__btn modal__btn--primary" :disabled="!editingColumnTitle.trim() || editingColumnTitle === (showColumnMenu.column && showColumnMenu.column.title)" @click="confirmUpdateColumn">
    保存
  </button>
</div>
</footer>
</div>
</div>
</Teleport>

<!-- v1.1: 绑 label picker -->
<Teleport to="body">
<div v-if="showBindLabel" class="modal-overlay" @click.self="closeBindLabelPicker">
<div class="modal" role="dialog" aria-label="绑定标签">
<header class="modal__header">
<h2 class="modal__title">绑定标签到 {{ showColumnMenu.column ? showColumnMenu.column.title : '' }}</h2>
<button type="button" class="modal__close" @click="closeBindLabelPicker">
<X :size="16" :stroke-width="2" />
</button>
</header>
<div class="modal__body">
<p class="muted">gitea 仓库里所有标签都在这里;勾上 = 绑到当前列,议题带这个标签就会进此列</p>
<ul class="modal__label-list">
<li v-for="lab in board.labelsByProject" :key="lab.id">
<button type="button" class="modal__label-item" :class="{ 'modal__label-item--bound': showColumnMenu.column && showColumnMenu.column.labels && showColumnMenu.column.labels.some((l) => l.id === lab.id) }" :disabled="bindingLabel" @click="bindLabel(lab.id, lab.name)">
  <span class="modal__label-dot" :style="{ background: lab.color || '#888' }" />
  <span class="modal__label-name">{{ lab.name }}</span>
  <span v-if="showColumnMenu.column && showColumnMenu.column.labels && showColumnMenu.column.labels.some((l) => l.id === lab.id)" class="modal__label-state">已绑</span>
  <span v-else class="modal__label-state modal__label-state--add">+ 绑</span>
</button>
</li>
</ul>
</div>
<footer class="modal__footer">
<button type="button" class="modal__btn modal__btn--ghost" @click="closeBindLabelPicker">关闭</button>
</footer>
</div>
</div>
</Teleport>

<!-- v1.1: 删列二次确认 -->
<ConfirmDialog
 :open="confirmDeleteColumn.open"
 :title="'删除列 ' + (confirmDeleteColumn.column ? confirmDeleteColumn.column.title : '')"
 description="删除后无法恢复。如果列里有议题,它们不会消失,只是不再被这个看板列归类。"
 confirm-label="我了解风险,仍要删除"
 cancel-label="取消"
 danger
 confirm-keyword="删除"
 @update:open="(v) => (confirmDeleteColumn.open = v)"
 @confirm="performDeleteColumn"
/>

 <ConfirmDialog
 :open="confirmFinish.open"
 title="标记为已完成？"
 :description="
 confirmFinish.issue
 ? `把 #${confirmFinish.issue.index}「${confirmFinish.issue.title}」挪到「已完成」列会在 gitea端**关闭**该议题（不仅是换标签）。如果只是想改分组，请选其他列。`
 : ''
 "
 confirm-label="我了解风险，仍要标记完成"
 cancel-label="取消"
 danger
 confirm-keyword="完成"
 @update:open="(v) => (confirmFinish.open = v)"
 @confirm="performFinishMove"
 />
 </div>
</template>

<style scoped>
.board {
 flex:1;
 display: flex;
 flex-direction: column;
 min-height:0;
 position: relative;
}

.board__topbar {
 display: flex;
 align-items: center;
 justify-content: space-between;
 padding: var(--space-3) var(--space-4);
 background: var(--color-bg-elevated);
 border-bottom:1px solid var(--color-divider);
 flex-shrink:0;
 gap: var(--space-3);
}

.board__picker {
 display: flex;
 align-items: center;
 gap: var(--space-2);
 padding:6px12px;
 background: var(--color-bg);
 border-radius: var(--radius-sm);
 cursor: pointer;
 color: var(--color-text-secondary);
 transition: background var(--t-fast) var(--ease);
 min-width:240px;
}

.board__picker:hover {
 background: var(--color-bg-hover);
 color: var(--color-text);
}

.board__picker-label {
 display: flex;
 flex-direction: column;
 gap:2px;
 flex:1;
 min-width:0;
}

.board__picker-name {
 font-size: var(--font-md);
 font-weight:500;
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

.board__undo-btn {
 display: inline-flex;
 align-items: center;
 gap:4px;
 padding:4px10px;
 background: var(--color-warning-soft);
 color: var(--color-warning);
 border-radius: var(--radius-sm);
 font-size: var(--font-xs);
 cursor: pointer;
 transition: background var(--t-fast) var(--ease);
}

.board__undo-btn:hover:not(:disabled) {
 background: var(--color-warning);
 color: var(--color-text-inverse);
}

.board__undo-btn:disabled {
 opacity:0.4;
 cursor: not-allowed;
}

/** 重做按钮（M6 undo-by-project 落地）—— 视觉沿用 undo 按钮（warning 色），仅文案不同 */
.board__redo-btn {
 display: inline-flex;
 align-items: center;
 gap:4px;
 padding:4px10px;
 background: var(--color-warning-soft);
 color: var(--color-warning);
 border-radius: var(--radius-sm);
 font-size: var(--font-xs);
 cursor: pointer;
 transition: background var(--t-fast) var(--ease);
}

.board__redo-btn:hover:not(:disabled) {
 background: var(--color-warning);
 color: var(--color-text-inverse);
}

.board__redo-btn:disabled {
 opacity:0.4;
 cursor: not-allowed;
}

.board__counter {
 display: inline-flex;
 align-items: center;
 gap:4px;
}

.board__loading {
 color: var(--color-info);
 font-size: var(--font-xs);
}

.board__dropdown {
 position: absolute;
 top:64px;
 left: var(--space-4);
 width:360px;
 max-height:480px;
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
 border-bottom:1px solid var(--color-divider);
 color: var(--color-text-muted);
}

.board__dropdown-input {
 flex:1;
 background: transparent;
 padding:0;
 border: none;
}

.board__dropdown-input:focus {
 background: transparent;
 box-shadow: none;
}

.board__dropdown-list {
 flex:1;
 overflow-y: auto;
 padding: var(--space-1);
}

.board__dropdown-item {
 display: flex;
 align-items: center;
 gap: var(--space-2);
 width:100%;
 padding:8px12px;
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
 flex:1;
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
}

.board__dropdown-item-tag {
 font-size: var(--font-xs);
 background: var(--color-primary-soft);
 color: var(--color-primary);
 padding:2px8px;
 border-radius: var(--radius-pill);
}

.board__placeholder {
 flex:1;
 display: flex;
 flex-direction: column;
 align-items: center;
 justify-content: center;
 gap: var(--space-4);
}

.board__add-col-btn {
 display: inline-flex;
 align-items: center;
 gap:6px;
 padding:8px16px;
 background: var(--color-primary);
 color: var(--color-text-inverse);
 border-radius: var(--radius-sm);
 font-size: var(--font-sm);
 cursor: pointer;
 box-shadow:
0001px var(--color-primary-active),
0012px var(--color-primary-glow);
}

.board__columns {
 flex:1;
 display: flex;
 gap: var(--space-3);
 padding: var(--space-4);
 overflow-x: auto;
 overflow-y: hidden;
 align-items: flex-start;
}

.column {
 flex:00280px;
 display: flex;
 flex-direction: column;
 max-height:100%;
 background: var(--color-bg-elevated);
 border-radius: var(--radius-md);
 box-shadow: var(--shadow-sm);
}

.column__header {
 display: flex;
 flex-direction: column;
 gap:4px;
 padding: var(--space-3) var(--space-3) var(--space-2);
 flex-shrink:0;
 border-bottom:1px solid var(--color-divider);
}

.column__title-wrap {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: var(--space-2);
}

.column__title {
 font-size: var(--font-md);
 font-weight:600;
 color: var(--color-text);
 margin:0;
}

.column__count {
 font-size: var(--font-xs);
 color: var(--color-text-muted);
 background: var(--color-bg);
 padding:2px8px;
 border-radius: var(--radius-pill);
 font-feature-settings: 'tnum';
 white-space: nowrap;
}

.column__labels {
 display: flex;
 align-items: center;
 gap:4px;
 font-size: var(--font-xs);
 color: var(--color-text-muted);
}

.column__label-icon {
 color: var(--color-accent);
 flex-shrink:0;
}

.column__label-text {
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
}

.column__cards {
 flex:1;
 display: flex;
 flex-direction: column;
 gap: var(--space-2);
 padding: var(--space-3);
 overflow-y: auto;
 min-height:60px;
}

.card {
 background: var(--color-bg);
 border-radius: var(--radius-sm);
 padding: var(--space-3);
 border-left:3px solid var(--color-primary);
 position: relative;
 transition: background var(--t-fast) var(--ease);
}

.card:hover {
 background: var(--color-bg-hover);
}

.card--closed {
 opacity:0.6;
 border-left-color: var(--color-text-muted);
}

.card__head {
 display: flex;
 align-items: center;
 gap: var(--space-2);
 margin-bottom:4px;
}

.card__index {
 font-size: var(--font-xs);
 color: var(--color-text-muted);
 font-weight:600;
}

.card__state {
 font-size: var(--font-xs);
 color: var(--color-text-muted);
 background: var(--color-bg-active);
 padding:1px6px;
 border-radius: var(--radius-pill);
}

.card__title {
 font-size: var(--font-sm);
 color: var(--color-text);
 line-height: var(--line-base);
 word-break: break-word;
}

.card__labels {
 margin-top: var(--space-2);
 display: flex;
 flex-wrap: wrap;
 gap:4px;
}

.card__label {
 font-size: var(--font-xs);
 padding:1px6px;
 border-radius: var(--radius-pill);
 font-weight:500;
 white-space: nowrap;
 background-color: var(--label-color, var(--color-bg-active));
 /* 优先走 CSS Color 4 color-contrast()：根据 label 底色亮度自动挑白字 / 黑字，
    保证 gitea label 调色板（亮蓝/亮红/亮绿/亮紫等）上文字都过 AA 4.5:1。
    Electron 内置 Chromium ≥120（2023+）原生支持。 */
 color: color-contrast(
   var(--label-color, var(--color-bg-active)) vs
   #FFFFFF, #0F1A24
 );
 /* 老 Chromium / WebView 兜底：--label-fg 在 light 主题下被覆盖为 --color-text（深色字），
    dark 主题下不设 → 走 inverse（白字，主色 / 暗 label 上 OK）。
    CSS 变量 fallback 链：--label-fg → --color-text-inverse → #FFF。 */
 color: var(--label-fg, var(--color-text-inverse, #FFFFFF));
}

.card__author {
 margin-top: var(--space-2);
 font-size: var(--font-xs);
}

.card__actions {
  position: absolute;
  top:4px;
  right:4px;
  display: flex;
  gap:2px;
  opacity:0;
  transition: opacity var(--t-fast) var(--ease);
}

/*
 * C-3 硬约束 #1（BoardView · state）修法（2026-06-14）：
 * hover-only → hover + :focus-within，让键盘 Tab 进入卡片后
 * 换列 / 删除按钮也能可见可操作（解决 a11y blocker）
 */
.card:hover .card__actions,
.card:focus-within .card__actions {
  opacity:1;
}

/* C-3 硬约束 #1 配套：卡片本身 keyboard focus 视觉反馈 */
.card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.card__action {
 padding:4px;
 color: var(--color-text-muted);
 border-radius: var(--radius-sm);
 cursor: pointer;
 display: inline-flex;
 align-items: center;
 justify-content: center;
 background: transparent;
 border: none;
 transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}

.card__action:hover:not(:disabled) {
 background: var(--color-bg-active);
 color: var(--color-text);
}

.card__action--danger:hover:not(:disabled) {
 color: var(--color-danger);
}

.card__action:disabled {
 opacity:0.4;
 cursor: not-allowed;
}

.column__new {
 display: flex;
 align-items: center;
 gap: var(--space-1);
 padding: var(--space-2) var(--space-3) var(--space-3);
 flex-shrink:0;
 border-top:1px solid var(--color-divider);
}

.column__new-input {
 flex:1;
 background: var(--color-bg);
 font-size: var(--font-sm);
}

.column__new-btn {
 padding:6px;
 background: var(--color-primary);
 color: var(--color-text-inverse);
 border-radius: var(--radius-sm);
 cursor: pointer;
 display: inline-flex;
 align-items: center;
 justify-content: center;
 box-shadow:
0001px var(--color-primary-active),
008px var(--color-primary-glow);
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

/* =====换列目标菜单 ===== */
.move-menu-overlay {
 position: fixed;
 inset:0;
 background: var(--color-bg-overlay);
 z-index: var(--z-modal-overlay);
 display: flex;
 align-items: center;
 justify-content: center;
 animation: fadeIn var(--t-base) var(--ease);
}

.move-menu {
 background: var(--color-bg-elevated);
 border-radius: var(--radius-lg);
 box-shadow: var(--shadow-lg);
 padding: var(--space-4);
 min-width:320px;
 max-width:400px;
 display: flex;
 flex-direction: column;
 gap: var(--space-3);
 animation: slideUp var(--t-base) var(--ease);
}

.move-menu__header {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: var(--space-2);
}

.move-menu__title {
 font-size: var(--font-md);
 font-weight:600;
 color: var(--color-text);
}

.move-menu__close {
 padding:4px;
 background: transparent;
 border: none;
 color: var(--color-text-muted);
 cursor: pointer;
 border-radius: var(--radius-sm);
 display: inline-flex;
 align-items: center;
}

.move-menu__close:hover {
 background: var(--color-bg-hover);
 color: var(--color-text);
}

.move-menu__list {
 display: flex;
 flex-direction: column;
 gap:4px;
 padding:0;
 margin:0;
 list-style: none;
}

.move-menu__item {
 display: flex;
 align-items: center;
 justify-content: space-between;
 width:100%;
 padding:8px12px;
 background: transparent;
 border:1px solid var(--color-divider);
 border-radius: var(--radius-sm);
 color: var(--color-text);
 font-size: var(--font-sm);
 cursor: pointer;
 text-align: left;
 transition: background var(--t-fast) var(--ease);
}

.move-menu__item:hover:not(:disabled) {
 background: var(--color-bg-hover);
}

.move-menu__item:disabled {
 opacity:0.5;
 cursor: not-allowed;
 background: var(--color-bg);
}

.move-menu__item--current {
 background: var(--color-primary-soft);
 color: var(--color-primary);
 border-color: var(--color-primary);
}

.move-menu__item-tag {
 font-size: var(--font-xs);
 background: var(--color-primary);
 color: var(--color-text-inverse);
 padding:1px6px;
 border-radius: var(--radius-pill);
}

.move-menu__footer {
 padding-top: var(--space-2);
 border-top:1px solid var(--color-divider);
 font-size: var(--font-xs);
}

@keyframes fadeIn {
 from { opacity:0; }
 to { opacity:1; }
}

@keyframes slideUp {
 from { transform: translateY(8px); opacity:0; }
 to { transform: translateY(0); opacity:1; }
}

/* gitea label颜色 →背景/前景转换（OVERRIDE §"无障碍"颜色 +文字 双编码） */
</style>

<!-- v1.1 列管理 UI 样式（不 scoped：Teleport 到 body 后 data-v-xxx 失效） -->
<style>
.column__header { display:flex; align-items:flex-start; gap: var(--space-2); }
.column__title-wrap { flex:1; min-width:0; }
.column__settings-btn { flex-shrink:0; background:transparent; border:1px solid var(--color-divider); border-radius:var(--radius-sm); padding:4px 6px; color:var(--color-text-muted); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:background var(--t-fast) var(--ease); }
.column__settings-btn:hover { background:var(--color-bg-hover); color:var(--color-text); }
.column__label-chip { display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px 6px; background:var(--color-bg-hover); border:1px solid var(--label-color, #888); border-radius:var(--radius-sm); font-size:var(--font-xs); color:var(--color-text); }
.column__label-dot { width:6px; height:6px; border-radius:50%; background:var(--label-color, #888); flex-shrink:0; }
.column__label-name { line-height:1; }
.column__label-unbind { background:transparent; border:0; color:var(--color-text-muted); font-size:var(--font-md); line-height:1; padding:0 2px; cursor:pointer; border-radius:var(--radius-sm); }
.column__label-unbind:hover { color:var(--color-danger); background:var(--color-danger-soft); }
.column__add-label-btn { background:transparent; border:1px dashed var(--color-divider); color:var(--color-text-muted); padding:2px 8px; border-radius:var(--radius-sm); font-size:var(--font-xs); cursor:pointer; }
.column__add-label-btn:hover { border-color:var(--color-primary); color:var(--color-primary); }
.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; z-index:1000; animation:fadeIn var(--t-base) var(--ease); }
.modal { width:480px; max-width:calc(100vw - 32px); max-height:calc(100vh - 64px); background:var(--color-bg-elevated); border-radius:var(--radius-md); box-shadow:var(--shadow-lg); display:flex; flex-direction:column; overflow:hidden; animation:slideUp var(--t-base) var(--ease); }
.modal__header { display:flex; align-items:center; justify-content:space-between; padding:var(--space-4); border-bottom:1px solid var(--color-divider); }
.modal__title { font-size:var(--font-lg); font-weight:600; margin:0; }
.modal__close { background:transparent; border:0; color:var(--color-text-muted); cursor:pointer; padding:4px; border-radius:var(--radius-sm); display:inline-flex; }
.modal__close:hover { background:var(--color-bg-hover); color:var(--color-text); }
.modal__body { padding:var(--space-4); overflow-y:auto; display:flex; flex-direction:column; gap:var(--space-3); }
.modal__label { font-size:var(--font-sm); font-weight:500; color:var(--color-text-secondary); }
.modal__input { width:100%; padding:8px 10px; background:var(--color-bg); border:1px solid var(--color-divider); border-radius:var(--radius-sm); color:var(--color-text); font-size:var(--font-md); font-family:inherit; box-sizing:border-box; }
.modal__input:focus { outline:none; border-color:var(--color-primary); }
.modal__input:disabled { opacity:0.5; cursor:not-allowed; }
.modal__hint { font-size:var(--font-xs); margin:0; }
.modal__sub { display:flex; flex-direction:column; gap:var(--space-2); }
.modal__sub-title { font-size:var(--font-sm); font-weight:500; color:var(--color-text-secondary); margin:0; }
.modal__empty { margin:0; }
.modal__chip-list { display:flex; flex-wrap:wrap; gap:var(--space-1); }
.modal__chip { display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px 6px; background:var(--color-bg-hover); border:1px solid var(--label-color, #888); border-radius:var(--radius-sm); font-size:var(--font-xs); }
.modal__chip-dot { width:6px; height:6px; border-radius:50%; background:var(--label-color, #888); }
.modal__chip-rm { background:transparent; border:0; color:var(--color-text-muted); font-size:var(--font-md); line-height:1; padding:0 2px; cursor:pointer; border-radius:var(--radius-sm); }
.modal__chip-rm:hover { color:var(--color-danger); background:var(--color-danger-soft); }
.modal__label-list { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:var(--space-1); }
.modal__label-item { display:flex; align-items:center; gap:var(--space-2); width:100%; padding:8px 10px; background:var(--color-bg); border:1px solid var(--color-divider); border-radius:var(--radius-sm); color:var(--color-text); cursor:pointer; text-align:left; font-family:inherit; font-size:var(--font-sm); transition:background var(--t-fast) var(--ease); }
.modal__label-item:hover:not(:disabled) { background:var(--color-bg-hover); }
.modal__label-item:disabled { opacity:0.5; cursor:not-allowed; }
.modal__label-item--bound { opacity:0.7; }
.modal__label-name { flex:1; }
.modal__label-state { font-size:var(--font-xs); color:var(--color-text-muted); }
.modal__label-state--add { color:var(--color-primary); }
.modal__footer { display:flex; align-items:center; justify-content:space-between; padding:var(--space-3) var(--space-4); border-top:1px solid var(--color-divider); background:var(--color-bg); }
.modal__footer-right { display:flex; gap:var(--space-2); }
.modal__btn { display:inline-flex; align-items:center; gap:4px; padding:6px 12px; background:var(--color-bg-elevated); border:1px solid var(--color-divider); border-radius:var(--radius-sm); color:var(--color-text); font-size:var(--font-sm); cursor:pointer; font-family:inherit; transition:background var(--t-fast) var(--ease); }
.modal__btn:hover:not(:disabled) { background:var(--color-bg-hover); }
.modal__btn:disabled { opacity:0.5; cursor:not-allowed; }
.modal__btn--primary { background:var(--color-primary); border-color:var(--color-primary); color:var(--color-text-inverse, #fff); }
.modal__btn--primary:hover:not(:disabled) { filter:brightness(1.1); background:var(--color-primary); }
.modal__btn--ghost { background:transparent; }
.modal__btn--danger { background:var(--color-danger-soft); border-color:var(--color-danger); color:var(--color-danger); }
.modal__btn--danger:hover:not(:disabled) { background:var(--color-danger); color:var(--color-text-inverse, #fff); }
.modal__btn--block { width:100%; justify-content:center; }
</style>
