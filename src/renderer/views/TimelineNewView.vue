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
import { branchesList, commitsGitgraphLines, commitsGitgraphCloneRepo } from '@renderer/lib/ipc-client';
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
  COL_WIDTH,
  ROW_HEIGHT,
  DISPLAY_SCALE,
  type Flow,
  type Graph,
  type GraphLine,
} from '@renderer/lib/gitgraph';

// ============================================================
// 常量
// ============================================================
const ROW_H = ROW_HEIGHT * DISPLAY_SCALE; // commit 行高（px），与 SVG ROW_HEIGHT × SCALE 一致
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
/** v1.5 功能未启用提示（main handler 返 disabled=true 时设置） */
const featureDisabled = ref(false);
/** v1.5 启用流程：是否正在 git clone */
const cloning = ref(false);
/** v1.5 启用流程：克隆进度 / 错误信息 */
const cloneProgress = ref<string | null>(null);

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

/**
 * v1.5 启用流程：用户点「启用 Git Graph」按钮 → 调 main 端 git clone
 *
 * 流程：
 *   1. cloning=true，显示"正在 clone..."
 *   2. 调 IPC commitsGitgraphCloneRepo（main 端从 keychain 读 token + git clone）
 *   3. 成功 → cloneProgress="已完成" → 重新 loadGraph（这次有 localPath + git 子进程可用）
 *   4. 失败 → cloneProgress=错误信息
 *
 * 注意：现在 main handler 还是 placeholder（return disabled），
 *   clone 完成后再次 loadGraph 仍会返 disabled —— v1.5.1 落地 main handler
 *   走 gitProcess.runGraphLog(listLocalRepoPath(projectId)) 后才真正显示 Git Graph
 */
async function enableGitGraph(): Promise<void> {
  if (!activeProjectId.value) return;
  cloning.value = true;
  cloneProgress.value = '正在 clone 仓库到本地（首次可能需要几十秒）...';
  useGlobalLoadingStore().show('timeline');
  try {
    const resp = await commitsGitgraphCloneRepo({
      projectId: activeProjectId.value,
    });
    cloneProgress.value = `已完成：${resp.cwd}${resp.reused ? '（复用已有仓库）' : ''}`;
    // 重新加载；这次 main handler 应该走 gitProcess 路径（v1.5.1）
    await loadGraph();
  } catch (e: unknown) {
    const err = e as { messageText?: string; message?: string; hint?: string };
    const msg = err.messageText ?? err.message ?? String(e) ?? '启用失败';
    cloneProgress.value = `启用失败：${msg}`;
    console.error('[TimelineNewView] enableGitGraph failed:', e);
  } finally {
    cloning.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
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

/**
 * 完整行数组（row 0..maxRow）—— commit 与 relation 占位交错
 *
 * 背景 bug：之前 v-for="graph.commits" 只渲染真实 commit，跳过 transition 行（merge edge
 * 中间段），导致：
 *   - dot overlay 在 row 0/1/2/3/4 全分布（按 row*24 绝对定位）
 *   - commit-row 只渲染 row 0/2/4 的 commit
 *   - 视觉上：dot 间距 = 24px，但 commit-row 紧挨着 → **dot 与 commit-row 错位**
 *   - 用户看到的"底部 dot 没对应 commitlog"就是这个
 *
 * 修复：按 row 升序铺满所有行，每行要么是真实 commit、要么是 relation 占位（空 row），
 * 与 dot overlay 的 row*24 节奏对齐
 */
interface DisplayRow {
  row: number;
  commit: NonNullable<typeof graph.value>['commits'][number] | null;
  isRelation: boolean;
}
const allRows = computed<DisplayRow[]>(() => {
  if (!graph.value) return [];
  const commitByRow = new Map<number, NonNullable<typeof graph.value>['commits'][number]>();
  for (const c of graph.value.commits) commitByRow.set(c.row, c);
  const relationByRow = new Set<number>(graph.value.relationCommits.map((r) => r.row));
  const out: DisplayRow[] = [];
  for (let row = 0; row <= graph.value.maxRow; row++) {
    const c = commitByRow.get(row) ?? null;
    out.push({
      row,
      commit: c,
      isRelation: !c && relationByRow.has(row),
    });
  }
  return out;
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
          description="v1.5 新增：在本地 clone 仓库后，调 git 二进制拿 `git log --graph` 字符流，与 Gitea 原版 1:1 等价。点下面按钮一键启用（克隆完成后下次进入此页面自动加载 Git Graph）。"
        />
        <button
          v-if="!cloning"
          class="enable-gitgraph-btn"
          @click="enableGitGraph"
        >
          启用 Git Graph（git clone 仓库到本地）
        </button>
        <div v-if="cloneProgress" class="clone-progress">
          {{ cloneProgress }}
        </div>
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
                    stroke-width="1.5"
                    fill="none"
                    stroke-linecap="round"
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
                    left: `${(c.column - minColumnOffset) * COL_WIDTH * DISPLAY_SCALE + COL_WIDTH * DISPLAY_SCALE - 4}px`,
                    top: `${c.row * ROW_HEIGHT * DISPLAY_SCALE + ROW_HEIGHT * DISPLAY_SCALE / 2 - 4}px`,
                  }"
                  :title="c.subject"
                />
              </div>
            </div>
          </div>

          <!-- 右侧：Commit 列表（与 SVG 等高） -->
          <!-- 右侧：Commit 列表（与 SVG 等高，按 row 0..maxRow 全渲染，含 transition 占位） -->
          <div class="git-graph-list" :style="{ minHeight: svgHeight }">
            <div
              v-for="r in allRows"
              :key="`row-${r.row}`"
              class="commit-row"
              :class="{ 'commit-row--relation': r.isRelation }"
              :style="{ height: ROW_H + 'px' }"
            >
              <template v-if="r.commit">
                <span
                  v-for="ref in r.commit.refs.slice(0, 5)"
                  :key="ref.name"
                  class="ref-badge"
                  :style="{ color: refColor(ref.refGroup), background: refBg(ref.refGroup) }"
                >
                  {{ ref.shortName }}
                </span>
                <span class="commit-subject">{{ r.commit.subject }}</span>
                <span class="commit-meta">
                  <img
                    v-if="r.commit.authorAvatar"
                    :src="r.commit.authorAvatar"
                    class="commit-avatar"
                    alt=""
                  />
                  <span class="commit-author">{{ r.commit.authorName }}</span>
                  <span class="commit-time">{{ formatRelative(r.commit.date) }}</span>
                </span>
                <span class="commit-sha">{{ r.commit.shortSha }}</span>
              </template>
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
  flex-direction: column;
  gap: var(--space-4, 16px);
}

.enable-gitgraph-btn {
  padding: 10px 20px;
  background: var(--color-primary);
  color: var(--color-primary-contrast, #fff);
  border: none;
  border-radius: 6px;
  font-size: var(--font-md, 14px);
  cursor: pointer;
  transition: background 0.15s;
}
.enable-gitgraph-btn:hover {
  background: var(--color-primary-hover, #5fa020);
}

.clone-progress {
  font-size: var(--font-sm, 13px);
  color: var(--color-text-secondary);
  text-align: center;
  max-width: 600px;
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
/* Git Graph wrapper：SVG + commit 列表双栏水平排列；
 * SVG 按真实宽度渲染不被压缩；多列时整体可横向滚动（commit 列表横向延伸） */
.git-graph-wrapper {
  display: flex;
  align-items: flex-start;
  /* 多列时 SVG + 列表整体超出 → 触发整体横向滚动；
   * svg-area 内部不再独立 scroll（之前会与列表对不齐） */
  min-width: max-content;
}

/* SVG 区域：sticky 在左侧，跟随 commit 列表垂直滚动；
 * 宽度按实际 svgWidth 自适应，不限制 max-width（git graph 多列时不让 SVG 被压缩——
 * 否则 SVG 内部按 preserveAspectRatio 缩放，commit 列表与 dot overlay 视觉错位）
 *
 * 多列场景：允许内部水平滚动（保留 vertical-align 与 commit 列表一致） */
.git-graph-svg-area {
  position: sticky;
  left: 0;
  z-index: 2;
  min-width: 120px;
  background: transparent;
  border-right: 1px solid var(--color-border);
  overflow-x: auto;     /* 多列时水平滚动而非被压缩 */
  overflow-y: hidden;
  flex-shrink: 0;
}

.git-graph-svg-inner {
  position: relative;
  /* SVG 宽度 = svgWidthPx（×2 缩放），按真实宽度渲染不被压缩 */
  display: inline-block;
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

/* 每行 commit（与 SVG 行高 24px 1:1 对齐，dot 圆心才能与 commit 文字对齐） */
.commit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  /* 高度由内联 style 绑定 ROW_H = ROW_HEIGHT * DISPLAY_SCALE */
  padding: 0 var(--space-3, 12px);
  font-size: var(--font-sm, 13px);
  white-space: nowrap;
  overflow: hidden;
  border-bottom: 1px solid var(--color-border);
  box-sizing: border-box;
}
.commit-row:hover {
  background: var(--color-bg-hover);
}
/* Transition 行（merge edge 中间段，无 commit）—— 占位用，与 dot overlay 行节奏对齐
 * 必须保持 24px 高度（不要合并 / 不要 display:none） */
.commit-row--relation {
  pointer-events: none;
  background: transparent;
}
.commit-row--relation:hover {
  background: transparent;
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
