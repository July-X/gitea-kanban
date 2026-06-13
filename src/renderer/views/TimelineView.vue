<script setup lang="ts">
/**
 * TimelineView —— 多分支 commit 时间轴（X6@3.1.7）
 *
 * 设计（AGENTS §5.2 + 03-frontend §5 + §5.6）：
 *   - 顶部：仓库选择 + 分支多选（chips）+ 加载按钮
 *   - 主区：X6 graph（多泳道 = 多个 branch lane；commit 节点 = 圆/菱形；merge 边 = 橙色）
 *   - 节点交互：hover tooltip / 单击高亮 / 双击跳 gitea
 *   - 数据源：commits.timeline IPC（v1 拿到的数据量在 200-500 区间）
 *
 * X6 铁律（AGENTS §8.4）：
 *   - interacting.* 回调第一参 = cellView（不是 cell），要 cell 用 view.cell
 *   - 默认 graph.on('node:mouseenter', ...) 第一参 = { cell, view }
 *   - attr 处理器**不**透传 CSS 属性（cursor/pointer-events）→ 必须 CSS 写
 *   - Vue 节点用 @antv/x6-vue-shape 的 register() 注册
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Graph } from '@antv/x6';
import { register as registerVueShape } from '@antv/x6-vue-shape';
import { GitBranch, Loader2, MapPin, Timer } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { branchesList, commitsTimeline } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type {
  BranchDto,
  CommitNode as CommitNodeDto,
  Lane,
  ListBranchesResp,
  ParentEdge,
  TimelineDto,
} from '../../main/ipc/schema.js';
import EmptyState from '@renderer/components/EmptyState.vue';
import CommitNodeVue from '@renderer/views/timeline/CommitNode.vue';

const auth = useAuthStore();
const repo = useRepoStore();
const branch = useBranchStore();

/** gitea 服务器 origin（task #21）—— 走用户填的地址，不再硬拼 https:// */
const giteaUrlBase = computed<string>(() => {
  const raw = auth.currentGiteaUrl;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      /* 解析失败退回 */
    }
  }
  return activeRepo.value ? `https://${activeRepo.value.owner}` : '';
});

/** 构造 gitea 上某资源 URL：`<origin>/<owner>/<name>/<path>` */
function giteaUrl(path: string): string {
  if (!giteaUrlBase.value || !activeRepo.value) return '';
  return `${giteaUrlBase.value}/${activeRepo.value.owner}/${activeRepo.value.name}/${path}`;
}

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const branches = ref<BranchDto[]>([]);
const selectedBranches = ref<Set<string>>(new Set());
const timeline = ref<TimelineDto | null>(null);
const loading = ref(false);
const localError = ref<UserFacingError | null>(null);

const graphRef = shallowRef<Graph | null>(null);
const graphContainer = ref<HTMLDivElement | null>(null);

/** 当前 hover / selected 节点（用于右侧详情面板） */
const hoveredNode = ref<CommitNodeDto | null>(null);
const selectedNode = ref<CommitNodeDto | null>(null);

/** 默认分支优先（来自 branchDto.isDefault） */
const defaultBranch = computed(() => branches.value.find((b) => b.isDefault) ?? null);

const activeRepo = computed(() => {
  // activeProjectId 是 uuid，反查 RepoDto 走 currentProject.fullName
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

onMounted(async () => {
  // 0. 注册 Vue 自定义节点（X6 节点用 SFC 渲染）
  registerVueShape({
    shape: 'commit-node',
    component: CommitNodeVue,
  });

  // 1. 等仓库列表就绪
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  if (!activeProjectId.value && repo.projects.length > 0) {
    // 默认选第一个 project —— addProject 是幂等的（已存在返现有 uuid）
    // selectProject 接收 RepoProjectDto（强类型）保证 IPC 拿到真 uuid
    const first = repo.projects[0]!;
    try {
      const project = await repo.addProject({ owner: first.owner, name: first.name });
      repo.selectProject(project);
    } catch {
      /* error in repo.error */
    }
  }
  // 2. 拉分支列表（内部 loadTimeline 会触发 renderGraph）
  if (activeProjectId.value) {
    await loadBranches();
  }
  // 3. ⚠️ 关键：<div ref="graphContainer"> 在 <template v-else> 里（line 387），
  // 只有 activeRepo && branches.length>0 && !localError 才渲染。
  // 因此 onMounted 阶段 graphContainer.value 一定是 null（branches 异步加载、DOM 还没 patch）。
  // initGraph() 必须在 graphContainer 真出现后调，否则 `if (!graphContainer.value) return` 直接 bail。
  // 之前的 bug 是在 onMounted 末尾调 initGraph（graphContainer=null，silent bail），
  // 或者先 loadBranches 再 initGraph（时机错，renderGraph 跑得比 initGraph 早）。
  // 现在用 watch: 一旦 graphContainer 真的绑定（DOM mount 完成），就立刻 initGraph。
  // initGraph 是幂等的（已存在就 return）；renderGraph 由 watch(() => timeline.value) 兜底触发。
});

onBeforeUnmount(() => {
  graphRef.value?.dispose();
  graphRef.value = null;
});

/** 拉分支列表 + 默认选 default branch + 1 个其他最近活跃分支 */
async function loadBranches(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    const resp = (await branchesList({
      projectId: activeProjectId.value,
      limit: 50,
      page: 1,
    })) as ListBranchesResp;
    branches.value = resp.items;

    // 跨视图状态传递：用户在 BranchesView 点"在时间轴查看此分支"时
    // 会写入 branch.pendingTimelineFocus；命中时只选该分支（覆盖默认行为）
    const pending = branch.consumePendingTimelineFocus();
    if (pending && resp.items.some((b) => b.name === pending)) {
      selectedBranches.value = new Set<string>([pending]);
    } else {
      // 默认选 default
      const nextSelected = new Set<string>();
      if (defaultBranch.value) nextSelected.add(defaultBranch.value.name);
      // 再加一个最近活跃的非 default 分支
      const other = resp.items.find((b) => !b.isDefault);
      if (other) nextSelected.add(other.name);
      selectedBranches.value = nextSelected;
    }
    if (selectedBranches.value.size > 0) {
      await loadTimeline();
    }
  } catch (e) {
    localError.value = e as UserFacingError;
  }
}

/**
 * 用户已在 /timeline 时从 BranchesView 点"在时间轴查看此分支"——
 * 路由没变所以 onMounted 不会再 fire；用 watch(branch.pendingTimelineFocus) 兜底。
 */
watch(
  () => branch.pendingTimelineFocus,
  async (name) => {
    if (!name || !activeProjectId.value) return;
    // 重新消费：让 selectedBranches 立刻变成只含此分支并重画时间轴
    branch.pendingTimelineFocus = null;
    if (branches.value.some((b) => b.name === name)) {
      selectedBranches.value = new Set<string>([name]);
      await loadTimeline();
    }
  },
);

/** 加载时间轴 */
async function loadTimeline(): Promise<void> {
  if (!activeProjectId.value) return;
  if (selectedBranches.value.size === 0) return;
  loading.value = true;
  localError.value = null;
  try {
    const resp = (await commitsTimeline({
      projectId: activeProjectId.value,
      branches: Array.from(selectedBranches.value),
      maxNodes: 500,
      laneMode: 'branch',
    })) as TimelineDto;
    timeline.value = resp;
    renderGraph(resp);
  } catch (e) {
    localError.value = e as UserFacingError;
  } finally {
    loading.value = false;
  }
}

/** 切换分支 chip */
function toggleBranch(name: string): void {
  const next = new Set(selectedBranches.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  selectedBranches.value = next;
  if (next.size > 0) {
    void loadTimeline();
  } else {
    timeline.value = null;
    graphRef.value?.clearCells();
  }
}

/** 初始化 X6 graph */
function initGraph(): void {
  if (!graphContainer.value) return;
  const g = new Graph({
    container: graphContainer.value,
    background: { color: 'transparent' },
    autoResize: true,
    panning: { enabled: true, modifiers: 'shift' },
    mousewheel: {
      enabled: true,
      zoomAtMousePosition: true,
      modifiers: 'ctrl',
    },
    interacting: {
      // AGENTS §8.4 铁律：interacting.* 第一参是 cellView，**不**是 cell
      // 回调里想拿 cell 用 view.cell；这里我们 disable 移动（git graph 节点固定位置）
      nodeMovable: false,
      edgeMovable: false,
      vertexMovable: false,
      arrowheadMovable: false,
    },
  });
  graphRef.value = g;
  // AGENTS §8.4 铁律：默认 graph.on 第一参 = { cell, view }
  g.on('node:mouseenter', ({ cell }) => {
    const data = cell.getData() as CommitNodeDto | undefined;
    if (data) hoveredNode.value = data;
  });
  g.on('node:mouseleave', () => {
    hoveredNode.value = null;
  });
  g.on('node:click', ({ cell }) => {
    const data = cell.getData() as CommitNodeDto | undefined;
    if (data) selectedNode.value = data;
  });
  g.on('node:dblclick', ({ cell }) => {
    const data = cell.getData() as CommitNodeDto | undefined;
    if (data && activeRepo.value) {
      // 改用 /<owner>/<repo>/commit/<sha> 走用户填的 gitea 地址（task #21）——
      // 旧 `/<owner>/-/commit/<sha>` 是 user-level commit 页，跨仓库找 sha，gitea 的子路径
      // 部署也丢了
      const url = giteaUrl(`commit/${data.sha}`);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }
  });
}

/** 画布尺寸（X6 节点坐标 = 绝对像素，需要把后端归一化 0~1 浮点换算成像素） */
const CANVAS_PADDING = 40; // 上下左右留白
const LANE_HEIGHT = 90; // 每条 lane 垂直间距（后端 lane.order → y 像素）

function renderGraph(dto: TimelineDto): void {
  const g = graphRef.value;
  if (!g) return;
  g.clearCells();

  // 取 graph 容器实测宽高作为画布基准（首次渲染时容器可能还没拿到尺寸 → 兜底 1200x600）
  const wrap = graphContainer.value;
  const measuredW = wrap?.clientWidth ?? 0;
  const measuredH = wrap?.clientHeight ?? 0;
  const canvasW = measuredW > 0 ? measuredW : 1200;
  const canvasH = measuredH > 0 ? measuredH : 600;

  // x: 后端 0~1 归一化 → 横向像素（按时间戳跨度，最早的贴左边、最晚的贴右边）
  // y: 后端 lane.order → 纵向像素（lane 0 在最上）
  const drawW = canvasW - CANVAS_PADDING * 2;
  const drawH = canvasH - CANVAS_PADDING * 2;

  // === 节点 ===
  for (const node of dto.nodes) {
    g.addNode({
      id: node.id,
      shape: 'commit-node',
      x: CANVAS_PADDING + node.x * drawW,
      y: CANVAS_PADDING + node.y * LANE_HEIGHT,
      data: node,
    });
  }

  // === 边（按 kind 区分父边 / 合并边颜色） ===
  for (const edge of dto.edges) {
    g.addEdge({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // 父边 = lane 色（这里用次级文字色当占位），合并边 = 强调橙
      attrs: {
        line: {
          stroke: edge.kind === 'merge' ? '#F76707' : 'rgba(220, 233, 240, 0.4)',
          strokeWidth: edge.kind === 'merge' ? 1.5 : 1,
          targetMarker: edge.kind === 'merge' ? null : { name: 'circle', size: 4 },
        },
      },
    });
  }
}

// 监听项目切换（路由参数）
watch(
  () => activeProjectId.value,
  async (id) => {
    if (id) {
      await loadBranches();
    }
  },
);

// 兜底：timeline 数据变就重画（处理 initGraph 早于 loadTimeline 完成 / project 切换 / branch chip 切换）
// renderGraph 内部有 `if (!g) return` 保护，graphRef 还没初始化时静默跳过——首次 mount 时
// loadTimeline 在 initGraph 之后调，所以这条 watch 通常用不到；但 onMounted 之外触发
// （如 toggleBranch → loadTimeline）的路径上提供双保险。
watch(
  () => timeline.value,
  (dto) => {
    if (dto) renderGraph(dto);
  },
);

// 关键兜底：graphContainer ref 在 onMounted 阶段还是 null（因为它在 <template v-else>
// 里、branches 异步加载 + DOM 未 patch），所以 initGraph() 不能放在 onMounted 末尾。
// 用 watch(graphContainer)：一旦 Vue 把 ref 真正绑定到 DOM 节点（DOM mount 完成 + 条件分支命中），
// 就调 initGraph 建 X6 graph。配合 watch(timeline.value) 兜底，graph 一就绪就立刻画当前数据。
watch(
  graphContainer,
  (el) => {
    if (el && !graphRef.value) {
      initGraph();
      // 如果 timeline 数据已经在 loadBranches 异步过程中拿到，但 graphRef 当时为 null，
      // 上面 initGraph 后立即补画一次
      if (timeline.value) renderGraph(timeline.value);
    }
  },
  { flush: 'post' }, // 等待 DOM 更新后再判断（确保 <template v-else> 分支已 patch）
);

/** 简化的 lane 元信息（来自 TimelineDto.lanes，UI 用） */
const lanes = computed<Lane[]>(() => timeline.value?.lanes ?? []);

/** 把 lane id 转成对应 label（用于图左侧说明） */
function laneLabel(id: string): string {
  const lane = lanes.value.find((l) => l.id === id);
  return lane?.label ?? id;
}
</script>

<template>
  <div class="timeline">
    <!-- ============== 顶部分支选择 ============== -->
    <header class="timeline__topbar">
      <div class="timeline__title">
        <Timer :size="18" :stroke-width="1.75" aria-hidden="true" />
        <span class="timeline__repo-name">{{ activeRepo?.fullName ?? '请选择仓库' }}</span>
      </div>
      <div v-if="branches.length" class="timeline__branches">
        <span class="timeline__branches-label">分支：</span>
        <button
          v-for="b in branches.slice(0, 12)"
          :key="b.name"
          type="button"
          class="branch-chip"
          :class="{ 'branch-chip--active': selectedBranches.has(b.name) }"
          :title="`切换分支 ${b.name}`"
          @click="toggleBranch(b.name)"
        >
          <GitBranch :size="12" :stroke-width="2" aria-hidden="true" />
          <span class="mono">{{ b.name }}</span>
        </button>
      </div>
      <div v-if="loading" class="timeline__loading">
        <Loader2 :size="14" :stroke-width="2" class="spin" />
        <span>加载中…</span>
      </div>
    </header>

    <!-- ============== 主区：X6 graph + 右侧详情 ============== -->
    <div class="timeline__main">
      <div v-if="!activeRepo" class="timeline__placeholder">
        <EmptyState
          title="还没有选中仓库"
          description='去"看板"页选一个仓库，再回来这里看时间轴'
        />
      </div>
      <div v-else-if="!branches.length" class="timeline__placeholder">
        <p class="muted">这个仓库还没有分支</p>
      </div>
      <div v-else-if="localError" class="timeline__placeholder">
        <p class="muted">{{ localError.messageText }}</p>
        <p class="muted text-xs">{{ localError.hint }}</p>
      </div>
      <template v-else>
        <div class="timeline__graph-wrap">
          <div ref="graphContainer" class="timeline__graph" />
        </div>
        <aside class="timeline__detail" v-if="hoveredNode || selectedNode">
          <h3 class="timeline__detail-title">
            <MapPin :size="14" :stroke-width="2" aria-hidden="true" />
            <span class="mono">{{ (hoveredNode ?? selectedNode)?.shortSha }}</span>
          </h3>
          <p class="timeline__detail-message">
            {{ (hoveredNode ?? selectedNode)?.message }}
          </p>
          <div class="timeline__detail-meta">
            <div v-if="(hoveredNode ?? selectedNode)?.isMerge" class="timeline__detail-tag">
              合并节点
            </div>
            <div v-if="(hoveredNode ?? selectedNode)?.linkedCardIds.length" class="timeline__detail-tag">
              {{ (hoveredNode ?? selectedNode)?.linkedCardIds.length }} 个关联卡片
            </div>
            <div v-if="(hoveredNode ?? selectedNode)?.filesChanged !== undefined" class="timeline__detail-tag">
              {{ (hoveredNode ?? selectedNode)?.filesChanged }} 个文件
            </div>
          </div>
          <p class="timeline__detail-author muted text-xs">
            {{ (hoveredNode ?? selectedNode)?.author.name }} · {{ (hoveredNode ?? selectedNode)?.timestamp }}
          </p>
        </aside>
      </template>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.timeline__topbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.timeline__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
}

.timeline__repo-name {
  font-size: var(--font-md);
  font-weight: 500;
  color: var(--color-text);
}

.timeline__branches {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  flex: 1;
}

.timeline__branches-label {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin-right: var(--space-1);
}

.branch-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg);
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}

.branch-chip:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.branch-chip--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 500;
}

.branch-chip--active:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.timeline__loading {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-info);
  font-size: var(--font-xs);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.timeline__main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.timeline__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.timeline__graph-wrap {
  flex: 1;
  min-width: 0;
  /* 透明让 AppShell 的 HUD 24px grid + 顶角点阵透出
   * （X6 自身 background: { color: 'transparent' }，graph-wrap 不再加不透明色）
   * 与"主区/弹窗/卡片 z-index 1+ 自然遮住 grid"硬约束一致：wrap 是"画布容器"非"阅读区" */
  position: relative;
}

.timeline__graph {
  width: 100%;
  height: 100%;
  min-height: 400px;
}

.timeline__detail {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--color-bg-elevated);
  border-left: 1px solid var(--color-divider);
  overflow-y: auto;
}

.timeline__detail-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-sm);
  color: var(--color-primary);
  font-weight: 500;
}

.timeline__detail-message {
  font-size: var(--font-md);
  color: var(--color-text);
  line-height: var(--line-base);
  word-break: break-word;
}

.timeline__detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--space-1);
}

.timeline__detail-tag {
  font-size: var(--font-xs);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.timeline__detail-author {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-divider);
}
</style>
