<script setup lang="ts">
/**
 * TimelineNewView —— 新版 git graph 视图（v1.4 重构：对齐 Gitea parser.go）
 *
 * v1.4 关键变化：
 * - 数据来源：commits.gitgraph.lines（main 端返 Gitea 字符流协议）
 * - 算法位置：**前端** src/renderer/lib/gitgraph/parser.ts（1:1 移植 Gitea parser.go）
 * - SVG 渲染：前端按 Graph 直接画（与 Gitea svgcontainer.tmpl 1:1）
 *
 * v1.4 状态：main handler 暂未实现（缺仓库本地路径），
 *   view 走"功能暂未启用"占位提示 + emoji 海豚 loading
 *
 * 设计参考（与 src/renderer/lib/gitgraph/ 对齐）：
 * - Gitea services/repository/gitgraph/parser.go（字符流状态机）
 * - Gitea templates/repo/graph/svgcontainer.tmpl（SVG path 公式）
 * - Gitea services/repository/gitgraph/graph_models.go（Graph / Flow / Commit 模型）
 */

import { computed, onMounted, ref, watch } from 'vue';
import { GitBranch, RefreshCw, GitCommit } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { branchesList, commitsGitgraphLines } from '@renderer/lib/ipc-client';
import type { BranchDto, ListBranchesResp } from '../../main/ipc/schema.js';
import EmptyState from '@renderer/components/EmptyState.vue';

import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import {
  parseLines,
  flowColorClass,
  flowToPathD,
  svgViewBox,
  svgWidthPx,
  svgHeightPx,
  graphWidth,
  type Flow,
  type Graph,
  type GraphLine,
} from '@renderer/lib/gitgraph';

// ============================================================
// 常量
// ============================================================
const ROW_H = 24; // commit 行高（px），与 SVG 行高 12 unit ×2 缩放一致
const TOGGLE_DEBOUNCE_MS = 200; // 分支切换防抖

// ============================================================
// Store & 上下文
// ============================================================
const auth = useAuthStore();
const repo = useRepoStore();
const branchStore = useBranchStore();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);
const activeRepo = computed(() => {
  const fn = repo.currentProject
    ? `${repo.currentProject.owner}/${repo.currentProject.name}`
    : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

// ============================================================
// 本地状态
// ============================================================
const branches = ref<BranchDto[]>([]);
const selectedBranches = ref<Set<string>>(new Set());

/** 原始字符流（main 端返） */
const lines = ref<GraphLine[]>([]);
/** 前端 Parser 解析出的 Graph（包含 flows / commits / relationCommits） */
const graph = ref<Graph | null>(null);
/** 加载态 */
const loading = ref(false);
/** 本地错误信息 */
const localError = ref<string | null>(null);
/** v1.5 功能未启用提示（main handler 抛 not_implemented 时设置） */
const featureDisabled = ref(false);

// ============================================================
// 生命周期
// ============================================================
onMounted(async () => {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* */
    }
  }
  if (activeProjectId.value) {
    await loadBranches();
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    if (id) await loadBranches();
  },
);

async function loadBranches(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    const resp = (await branchesList({
      projectId: activeProjectId.value,
      limit: 50,
      page: 1,
    })) as ListBranchesResp;
    branches.value = resp.items;
    if (branches.value.length > 0 && selectedBranches.value.size === 0) {
      selectedBranches.value = new Set([
        branches.value.find((b) => b.isDefault)?.name ?? branches.value[0]!.name,
      ]);
    }
  } catch {
    localError.value = '加载分支失败';
    return;
  }
  scheduleLoadGraph();
}

/** 防抖 timer（分支切换合并请求） */
let loadGraphTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLoadGraph(): void {
  if (loadGraphTimer) clearTimeout(loadGraphTimer);
  loadGraphTimer = setTimeout(() => {
    loadGraphTimer = null;
    void loadGraph();
  }, TOGGLE_DEBOUNCE_MS);
}

function toggleBranch(name: string): void {
  const next = new Set(selectedBranches.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedBranches.value = next;
  scheduleLoadGraph();
}

async function loadGraph(): Promise<void> {
  if (!activeProjectId.value) return;
  if (selectedBranches.value.size === 0) {
    graph.value = null;
    lines.value = [];
    return;
  }
  loading.value = true;
  localError.value = null;
  featureDisabled.value = false;
  useGlobalLoadingStore().show('timeline');
  try {
    const dto = await commitsGitgraphLines({
      projectId: activeProjectId.value,
      branches: [...selectedBranches.value],
      limit: 200,
    });
    // v1.4 placeholder：main handler 返 disabled=true（不抛错）
    if (dto.disabled) {
      featureDisabled.value = true;
      graph.value = null;
      lines.value = [];
      return;
    }
    lines.value = dto.lines;
    // 前端 Parser：Gitea 字符流 → Graph（1:1 移植 Gitea parser.go）
    const { graph: parsed } = parseLines(dto.lines);
    graph.value = parsed;
  } catch (e: unknown) {
    // 真错误（网络 / 解析失败 / schema 不符）才走这里
    console.error('[TimelineNewView] loadGraph failed:', e);
    const err = e as {
      code?: string;
      messageText?: string;
      message?: string;
      hint?: string;
    };
    const msg = err.messageText ?? err.message ?? String(e) ?? '加载失败';

    // v1.4 兼容：旧 main handler 抛 IpcError(code='internal', message 含 'v1.5')
    // 仍识别为"功能未启用"（不弹错误 toast），走占位
    // —— 用户在不重启 Electron 跑旧 handler 时也能看到正确 UI
    const looksLikeDisabled =
      err.code === 'internal' &&
      (msg.includes('v1.5') || msg.includes('Git Graph'));
    if (looksLikeDisabled) {
      featureDisabled.value = true;
      graph.value = null;
      lines.value = [];
      return;
    }

    localError.value = err.hint ? `${msg}（${err.hint}）` : msg;
    graph.value = null;
    lines.value = [];
  } finally {
    loading.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

function refresh(): void {
  void loadGraph();
}

// ============================================================
// SVG 渲染坐标
// ============================================================
//
// 与 Gitea svgcontainer.tmpl 1:1：
// - 列宽 5 unit / 行高 12 unit
// - viewBox 用 backend Graph 全局坐标 → 由前端 svgViewBox() 计算
// - 显示尺寸：×2 缩放（10px / 列、24px / 行）→ svgWidthPx / svgHeightPx
// - dot 圆点用 HTML overlay（不受 SVG 缩放影响）+ commit 列表逐行对齐

const viewBox = computed(() => (graph.value ? svgViewBox(graph.value) : '0 0 0 0'));
const svgWidth = computed(() => (graph.value ? svgWidthPx(graph.value) : '0px'));
const svgHeight = computed(() => (graph.value ? svgHeightPx(graph.value) : '0px'));
const minColumnOffset = computed(() => graph.value?.minColumn ?? 0);

/** dot 圆心 x（SVG unit） */
function dotCx(column: number): number {
  return column * 5 + 5;
}
/** dot 圆心 y（SVG unit） */
function dotCy(row: number): number {
  return row * 12 + 6;
}

// ============================================================
// Flow 分组（按 flowId 聚合）
// ============================================================
interface FlowView {
  flowId: number;
  colorClass: string;
  d: string;
  commits: typeof graph.value extends null ? never[] : NonNullable<typeof graph.value>['commits'];
}

const flowViews = computed<FlowView[]>(() => {
  if (!graph.value) return [];
  // flowId → commits 聚合
  const commitsByFlow = new Map<number, NonNullable<typeof graph.value>['commits']>();
  for (const c of graph.value.commits) {
    const arr = commitsByFlow.get(c.flowId) ?? [];
    arr.push(c);
    commitsByFlow.set(c.flowId, arr);
  }
  // 渲染顺序：按 flowId 升序（与 Gitea svgcontainer.tmpl 一致）
  const sortedFlowIds = Array.from(graph.value.flows.keys()).sort((a, b) => a - b);
  return sortedFlowIds.map((flowId) => {
    const flow: Flow = graph.value!.flows.get(flowId)!;
    return {
      flowId,
      colorClass: flowColorClass(flow.colorNumber),
      d: flowToPathD(flow),
      commits: commitsByFlow.get(flowId) ?? [],
    };
  });
});

// ============================================================
// ref 颜色（与 Gitea design token 对齐）
// ============================================================
function refColor(refGroup: string): string {
  switch (refGroup) {
    case 'heads':
      return 'var(--color-primary)';
    case 'tags':
      return 'var(--color-info)';
    case 'pull':
      return 'var(--color-secondary)';
    default:
      return 'var(--color-text-secondary)';
  }
}
function refBg(refGroup: string): string {
  switch (refGroup) {
    case 'heads':
      return 'var(--color-primary-soft)';
    case 'tags':
      return 'rgba(0, 98, 158, 0.12)';
    case 'pull':
      return 'rgba(108, 117, 125, 0.12)';
    default:
      return 'var(--color-bg-hover)';
  }
}

// ============================================================
// 辅助
// ============================================================
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}m前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}月前`;
  return `${Math.floor(mo / 12)}年前`;
}

/** 全局图总列数（用于左侧 SVG 区域宽度） */
const totalColumns = computed(() => (graph.value ? graphWidth(graph.value) : 0));
</script>

<template>
  <div class="timeline-new">
    <!-- ===== 顶部栏 ===== -->
    <header class="timeline-new__topbar">
      <div class="timeline-new__title">
        <GitCommit :size="16" />
        <span>Git Graph</span>
        <span v-if="activeRepo" class="timeline-new__repo-name">{{ activeRepo.fullName }}</span>
        <span v-else class="timeline-new__repo-name muted">请选择仓库</span>
      </div>

      <div v-if="branches?.length" class="timeline-new__branches">
        <span class="timeline-new__branches-label">分支：</span>
        <button
          v-for="b in branches"
          :key="b.name"
          class="branch-chip"
          :class="{ active: selectedBranches.has(b.name) }"
          @click="toggleBranch(b.name)"
        >
          <GitBranch :size="11" />
          {{ b.name }}
        </button>
      </div>

      <div class="timeline-new__actions">
        <button class="icon-btn" title="刷新" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spinning: loading }" />
        </button>
      </div>
    </header>

    <!-- ===== 主内容 ===== -->
    <div class="timeline-new__main">
      <div v-if="!activeRepo" class="timeline-new__placeholder">
        <EmptyState title="请先选择一个仓库" />
      </div>
      <div v-else-if="!branches.length" class="timeline-new__placeholder">
        <EmptyState title="加载中..." />
      </div>
      <div v-else-if="localError" class="timeline-new__placeholder">
        <EmptyState :title="localError" />
      </div>
      <div
        v-else-if="featureDisabled"
        class="timeline-new__placeholder timeline-new__placeholder--feature"
      >
        <EmptyState
          title="Git Graph 功能暂未启用"
          description="新版本需要等仓库本地路径接入（v1.5 计划），届时直接调 git 二进制拿字符流，与 Gitea 原版 1:1 等价。当前可使用「提交时间轴」视图。"
        />
      </div>
      <div
        v-else-if="!graph || (graph?.commits?.length ?? 0) === 0"
        class="timeline-new__placeholder"
      >
        <EmptyState title="没有提交记录" />
      </div>

      <!-- Git Graph -->
      <template v-else>
        <div class="git-graph-wrapper">
          <!-- 左侧：SVG 图（固定宽度，左侧 sticky） -->
          <div class="git-graph-svg-area">
            <div class="git-graph-svg-inner">
              <!-- SVG：只画线条（path），圆点用 HTML overlay 固定大小） -->
              <svg
                class="git-graph-svg"
                :viewBox="viewBox"
                :width="svgWidth"
                :height="svgHeight"
                style="display: block"
              >
                <!-- 按 flow 分组（对齐 Gitea svgcontainer.tmpl：每 flow 一个 <g>） -->
                <g
                  v-for="fg in flowViews"
                  :key="`flow-${fg.flowId}`"
                  class="flow-group"
                  :class="fg.colorClass"
                  :data-flow="fg.flowId"
                >
                  <!-- 该 flow 的所有字形拼成一条 path（前端 flowToPathD 生成，1:1 对齐 Gitea svgcontainer.tmpl 公式） -->
                  <path
                    v-if="fg.d"
                    :d="fg.d"
                    stroke-width="1"
                    fill="none"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </g>
              </svg>

              <!-- 圆点 overlay：固定大小，不受 SVG 缩放影响） -->
              <div class="commit-dots-overlay" :style="{ width: svgWidth, height: svgHeight }">
                <div
                  v-for="c in graph.commits"
                  :key="`dot-${c.sha}`"
                  class="commit-dot"
                  :class="flowColorClass(graph.flows.get(c.flowId)?.colorNumber ?? 1)"
                  :style="{
                    left: `${(c.column - minColumnOffset) * 10 + 10 - 4}px`,
                    top: `${c.row * 24 + 12 - 4}px`,
                  }"
                  :title="c.subject"
                />
              </div>
            </div>
          </div>

          <!-- 右侧：Commit 列表（与 SVG 等高） -->
          <div class="git-graph-list" :style="{ minHeight: svgHeight }">
            <div v-for="c in graph.commits" :key="c.sha" class="commit-row">
              <span
                v-for="ref in c.refs.slice(0, 5)"
                :key="ref.name"
                class="ref-badge"
                :style="{ color: refColor(ref.refGroup), background: refBg(ref.refGroup) }"
              >
                {{ ref.shortName }}
              </span>
              <span class="commit-subject">{{ c.subject }}</span>
              <span class="commit-meta">
                <img v-if="c.authorAvatar" :src="c.authorAvatar" class="commit-avatar" alt="" />
                <span class="commit-author">{{ c.authorName }}</span>
                <span class="commit-time">{{ formatRelative(c.date) }}</span>
              </span>
              <span class="commit-sha">{{ c.shortSha }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.timeline-new {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ===== 顶部栏 ===== */
.timeline-new__topbar {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: var(--space-3, 12px) var(--space-4, 16px);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.timeline-new__title {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  font-size: var(--font-md, 14px);
  font-weight: 600;
  color: var(--color-text);
}
.timeline-new__repo-name {
  color: var(--color-text-secondary);
  font-weight: 400;
}
.timeline-new__repo-name.muted {
  color: var(--color-text-disabled);
}

.timeline-new__branches {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  flex-wrap: wrap;
}
.timeline-new__branches-label {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-secondary);
}
.timeline-new__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  margin-left: auto;
}

/* ===== 主内容 ===== */
.timeline-new__main {
  flex: 1;
  overflow: auto;
}
.timeline-new__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 300px;
}
.timeline-new__placeholder--feature {
  height: 400px;
  padding: var(--space-6, 24px);
}

/* ===== Branch chips ===== */
.branch-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: var(--font-xs, 11px);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.branch-chip:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.branch-chip.active {
  background: var(--color-primary-soft);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* ===== Git Graph Wrapper ===== */
.git-graph-wrapper {
  display: flex;
  align-items: flex-start;
}

/* SVG 区域：固定最小宽度（容纳至少 8 列），左侧 sticky，背景透明 */
.git-graph-svg-area {
  position: sticky;
  left: 0;
  z-index: 2;
  min-width: 120px;
  max-width: 240px;
  background: transparent;
  border-right: 1px solid var(--color-border);
  overflow: hidden;
  flex-shrink: 0;
}

.git-graph-svg-inner {
  position: relative;
}

.git-graph-svg {
  display: block;
}

/* 圆点 overlay：绝对定位在 SVG 之上，固定大小 */
.commit-dots-overlay {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.commit-dot {
  position: absolute;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-sizing: border-box;
}

/* 圆点背景色（HTML div 用 background-color，不是 SVG fill） */
.commit-dot.flow-color-16-0 {
  background-color: var(--color-series-16-0);
}
.commit-dot.flow-color-16-1 {
  background-color: var(--color-series-16-1);
}
.commit-dot.flow-color-16-2 {
  background-color: var(--color-series-16-2);
}
.commit-dot.flow-color-16-3 {
  background-color: var(--color-series-16-3);
}
.commit-dot.flow-color-16-4 {
  background-color: var(--color-series-16-4);
}
.commit-dot.flow-color-16-5 {
  background-color: var(--color-series-16-5);
}
.commit-dot.flow-color-16-6 {
  background-color: var(--color-series-16-6);
}
.commit-dot.flow-color-16-7 {
  background-color: var(--color-series-16-7);
}
.commit-dot.flow-color-16-8 {
  background-color: var(--color-series-16-8);
}
.commit-dot.flow-color-16-9 {
  background-color: var(--color-series-16-9);
}
.commit-dot.flow-color-16-10 {
  background-color: var(--color-series-16-10);
}
.commit-dot.flow-color-16-11 {
  background-color: var(--color-series-16-11);
}
.commit-dot.flow-color-16-12 {
  background-color: var(--color-series-16-12);
}
.commit-dot.flow-color-16-13 {
  background-color: var(--color-series-16-13);
}
.commit-dot.flow-color-16-14 {
  background-color: var(--color-series-16-14);
}
.commit-dot.flow-color-16-15 {
  background-color: var(--color-series-16-15);
}

/* ===== Flow 分组着色（对齐 Gitea gitgraph.css flow-color-16-N）=====
 * 每个 flow-group 的 path(stroke) 和 circle(fill) 继承对应 16 色变量。
 * 色值在 theme.css [data-theme="dark"] / [data-theme="light"] 定义。
 */
.flow-group {
  /* path 用 stroke，circle 用 fill */
}
.flow-group .flow-commit {
  stroke: none;
}

.flow-color-16-0 {
  stroke: var(--color-series-16-0);
  fill: var(--color-series-16-0);
}
.flow-color-16-1 {
  stroke: var(--color-series-16-1);
  fill: var(--color-series-16-1);
}
.flow-color-16-2 {
  stroke: var(--color-series-16-2);
  fill: var(--color-series-16-2);
}
.flow-color-16-3 {
  stroke: var(--color-series-16-3);
  fill: var(--color-series-16-3);
}
.flow-color-16-4 {
  stroke: var(--color-series-16-4);
  fill: var(--color-series-16-4);
}
.flow-color-16-5 {
  stroke: var(--color-series-16-5);
  fill: var(--color-series-16-5);
}
.flow-color-16-6 {
  stroke: var(--color-series-16-6);
  fill: var(--color-series-16-6);
}
.flow-color-16-7 {
  stroke: var(--color-series-16-7);
  fill: var(--color-series-16-7);
}
.flow-color-16-8 {
  stroke: var(--color-series-16-8);
  fill: var(--color-series-16-8);
}
.flow-color-16-9 {
  stroke: var(--color-series-16-9);
  fill: var(--color-series-16-9);
}
.flow-color-16-10 {
  stroke: var(--color-series-16-10);
  fill: var(--color-series-16-10);
}
.flow-color-16-11 {
  stroke: var(--color-series-16-11);
  fill: var(--color-series-16-11);
}
.flow-color-16-12 {
  stroke: var(--color-series-16-12);
  fill: var(--color-series-16-12);
}
.flow-color-16-13 {
  stroke: var(--color-series-16-13);
  fill: var(--color-series-16-13);
}
.flow-color-16-14 {
  stroke: var(--color-series-16-14);
  fill: var(--color-series-16-14);
}
.flow-color-16-15 {
  stroke: var(--color-series-16-15);
  fill: var(--color-series-16-15);
}

/* Commit 列表 */
.git-graph-list {
  flex: 1;
  overflow-x: auto;
}

/* 每行 commit */
.commit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  height: 24px;
  padding: 8px var(--space-3, 12px);
  font-size: var(--font-sm, 13px);
  white-space: nowrap;
  overflow: hidden;
  border-bottom: 1px solid var(--color-border);
}
.commit-row:hover {
  background: var(--color-bg-hover);
}

.ref-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.commit-subject {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text);
  font-size: var(--font-sm, 13px);
}

.commit-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.commit-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.commit-author {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--font-xs, 11px);
}
.commit-time {
  white-space: nowrap;
  font-size: var(--font-xs, 11px);
}

.commit-sha {
  font-family: monospace;
  font-size: 11px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

/* 刷新旋转 */
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.spinning {
  animation: spin 1s linear infinite;
}

/* Icon button */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
