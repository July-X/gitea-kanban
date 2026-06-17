<script setup lang="ts">
/**
 * TimelineView —— 多分支 commit 时间轴（heatmap + 分支提交图）
 *
 * 设计还原（来自 docs/design/wireframe/timeline.html · v1.2 主题方案）：
 *   - 顶部：仓库名 + 分支 chips + 工具栏（时间范围/筛选 chips）
 *   - 上：commit 热力图（GitHub contribution graph 风格，53 周 × 7 天 = 371 格）
 *   - 下：分支提交图（Gitea 提交图风格，8 lane × 紧凑 6px 间距 + bridges 桥接）
 *   - 右：分支列表 sidebar（色块 + 名称 + commit 数）
 *
 * 数据源：commits.timeline IPC（v1 拿到的数据量在 200-500 区间）
 *   - lanes 数组决定 lane 顺序和颜色（order 0 = main）
 *   - nodes 数组按时间戳倒序排列后作为行号
 *   - edges 数组（parent/combined）决定分支曲线
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Clipboard, ExternalLink, GitBranch, RefreshCw, Timer } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { branchesList, commitsGet, commitsTimeline } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import { showToast } from '@renderer/lib/toast';
import { useBranchLoadDebounce } from '@renderer/composables/useBranchLoadDebounce';
import type {
  BranchDto,
  CommitDto,
  CommitNode as CommitNodeDto,
  CommitFileChangeDto,
  Lane,
  ListBranchesResp,
  TimelineDto,
} from '../../main/ipc/schema.js';
import EmptyState from '@renderer/components/EmptyState.vue';
import Tooltip from '@renderer/components/Tooltip.vue';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

const route = useRoute();
const router = useRouter();

const auth = useAuthStore();
const repo = useRepoStore();
const branch = useBranchStore();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/** gitea 服务器 origin（task #21）—— 走用户填的地址，不再硬拼 https:// */
const giteaUrlBase = computed<string>(() => {
  const raw = auth.currentGiteaUrl;
  if (raw) {
    try { return new URL(raw).origin; } catch { /* 解析失败退回 */ }
  }
  return activeRepo.value ? `https://${activeRepo.value.owner}` : '';
});

/** 构造 gitea 上某资源 URL */
function giteaUrl(path: string): string {
  if (!giteaUrlBase.value || !activeRepo.value) return '';
  return `${giteaUrlBase.value}/${activeRepo.value.owner}/${activeRepo.value.name}/${path}`;
}

const branches = ref<BranchDto[]>([]);
const selectedBranches = ref<Set<string>>(new Set());
const timeline = ref<TimelineDto | null>(null);
const loading = ref(false);
const localError = ref<UserFacingError | null>(null);

/**
 * v1.4 · 任务 #merge-timeline-jump:从合并请求跳过来要高亮的 commit sha
 * - 有值 → commit-row 命中该 sha 加 .is-pr-focus 样式 + 自动滚动到视图
 * - 用户主动切分支/刷新后保留高亮,直到主动点别的 commit 或新一次 merge-jump 覆盖
 * - 设置时机:loadBranches 内 pending.sha 有值 / watch pendingTimelineFocus 有值
 */
const prFocusSha = ref<string | null>(null);

const defaultBranch = computed(() => branches.value.find((b) => b.isDefault) ?? null);

onMounted(async () => {
  if (repo.repos.length === 0) {
    try { await repo.loadRepos('', true); } catch { /* error in repo.error */ }
  }
  // v1.4 任务 #statusbar-picker：删除"未选就默认选第一个"逻辑
  // 仓库由 App.vue 在登录/启动期通过 StatusBar picker 引导用户主动选
  if (activeProjectId.value) {
    await loadBranches();
  }
});

async function loadBranches(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    const resp = (await branchesList({
      projectId: activeProjectId.value,
      limit: 50,
      page: 1,
    })) as ListBranchesResp;
    branches.value = resp.items;
    const pending = branch.consumePendingTimelineFocus();
    if (pending && resp.items.some((b) => b.name === pending.ref)) {
      selectedBranches.value = new Set<string>([pending.ref]);
      // v1.4 · 任务 #merge-timeline-jump:pending 携带 sha → timeline 加载后高亮
      if (pending.sha) {
        prFocusSha.value = pending.sha;
      }
    } else {
      const nextSelected = new Set<string>();
      if (defaultBranch.value) nextSelected.add(defaultBranch.value.name);
      const other = resp.items.find((b) => !b.isDefault);
      if (other) nextSelected.add(other.name);
      selectedBranches.value = nextSelected;
    }
    if (selectedBranches.value.size > 0) {
      await debounce.flush();
    }
  } catch (e) {
    localError.value = e as UserFacingError;
  }
}

watch(() => branch.pendingTimelineFocus, (pending) => {
  if (!pending || !activeProjectId.value) return;
  branch.pendingTimelineFocus = null;
  if (branches.value.some((b) => b.name === pending.ref)) {
    selectedBranches.value = new Set<string>([pending.ref]);
    // 同上:刷新 prFocusSha
    if (pending.sha) {
      prFocusSha.value = pending.sha;
    } else {
      prFocusSha.value = null;
    }
    debounce.schedule();
  }
});

/**
 * 加载时间轴数据（active project + selected branches）
 *
 * 早期返回短路：
 * - 无 active project → 不打 gitea
 * - 无 selected branches → 不打 gitea（toggleBranch 把集合清空时已经 cancel 计时器）
 */
async function loadTimeline(): Promise<void> {
  if (!activeProjectId.value) return;
  if (selectedBranches.value.size === 0) return;
  loading.value = true;
  useGlobalLoadingStore().show('timeline');
  localError.value = null;
  try {
    const resp = (await commitsTimeline({
      projectId: activeProjectId.value,
      branches: Array.from(selectedBranches.value),
      maxNodes: 500,
      laneMode: 'branch',
    })) as TimelineDto;
    timeline.value = resp;
  } catch (e) {
    localError.value = e as UserFacingError;
  } finally {
    loading.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

/**
 * v1.4 · 任务 #merge-timeline-jump:timeline 渲染后,如果 prFocusSha 有值,
 * 找到对应 commit-row 滚动到视图。
 *
 * 用 nextTick 等 DOM 渲染完;scrollIntoView 加 block:center 让目标落在中间,
 * 行为:'auto' 异步平滑滚动（用户没主动操作前不抢滚动,符合 a11y 最佳实践）。
 *
 * 高亮 class (.is-pr-focus) 由 :class 表达式直接根据 prFocusSha 计算,
 * 本函数只负责滚动 + 一次"清除 prFocusSha 的轻提示"。
 */
async function scrollToPrFocus(): Promise<void> {
  if (!prFocusSha.value) return;
  const targetSha = prFocusSha.value;
  // 等 v-for 渲染完
  await nextTick();
  // 用 requestAnimationFrame 双保险（v-for 已经 nextTick,但有的浏览器实测还要再等一帧）
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      `.commit-row[data-pr-sha="${CSS.escape(targetSha)}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

/**
 * 分支切换防抖器（封装 setTimeout + clearTimeout 逻辑，行为见 useBranchLoadDebounce.ts）
 * - debounce.schedule()  ⇔  toggleBranch 加分支后 250ms 才拉一次
 * - debounce.flush()     ⇔  refresh() / loadBranches() 主动立即拉（同时取消 pending）
 * - debounce.cancel()    ⇔  toggleBranch 取消最后一个分支时清 timer + 不拉
 */
const debounce = useBranchLoadDebounce(loadTimeline);

/**
 * v1.4 · 任务 #merge-timeline-jump:timeline 加载完后,如果 prFocusSha 有值,
 * 触发滚动到目标 commit-row。
 *
 * watch timeline.value 不带 immediate —— loadTimeline 内部已 timeline.value = resp,
 * watcher 在 DOM 更新后触发,scrollToPrFocus 内部再 nextTick + rAF 兜底
 */
watch(
  () => timeline.value,
  () => {
    if (prFocusSha.value) {
      void scrollToPrFocus();
    }
  },
);

function toggleBranch(name: string): void {
  const next = new Set(selectedBranches.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedBranches.value = next;
  if (next.size > 0) {
    debounce.schedule();
  } else {
    debounce.cancel();
    timeline.value = null;
  }
}

// ============================================================
// 提交详情弹窗（v1.3 需求：点击 commit-row 弹窗 + 穿透到分支视图）
// ============================================================

const detailOpen = ref(false);
const detailNode = ref<CommitNodeDto | null>(null);
/** 完整 commit 详情缓存（sha → CommitDto）—— 含 files、functions、linkedCards
 *  v1.3 任务 #commit-detail-agg：弹窗聚合展示文件清单 */
const detailDetailCache = ref<Map<string, CommitDto>>(new Map());
const detailLoadingSet = ref<Set<string>>(new Set());

function openCommitDetail(n: CommitNodeDto): void {
  detailNode.value = n;
  detailOpen.value = true;
  // 懒加载完整 detail（拿 files + linkedCards）
  if (!detailDetailCache.value.has(n.sha)) {
    void loadDetailDetail(n.sha);
  }
}
function closeCommitDetail(): void {
  detailOpen.value = false;
  // 保留 detailNode 一帧让过渡动画播完再清，避免内容突变
  setTimeout(() => { if (!detailOpen.value) detailNode.value = null; }, 200);
}

/**
 * Esc 关闭提交详情弹窗（A-3 P1 · B1 修法）
 * - watch detailOpen → add/remove window listener，避免常驻监听
 * - 仅在 detailOpen=true 时拦截 Esc，避免干扰其他弹窗（gitea-confirm 等）
 */
function onDetailEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && detailOpen.value) {
    e.preventDefault();
    closeCommitDetail();
  }
}
watch(detailOpen, (open) => {
  if (open) window.addEventListener('keydown', onDetailEsc);
  else window.removeEventListener('keydown', onDetailEsc);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onDetailEsc);
});

/** 拉完整 commit 详情（gitea /git/commits/{sha}）—— 含 stats + files */
async function loadDetailDetail(sha: string): Promise<void> {
  const pid = activeProjectId.value;
  if (!pid) return;
  if (detailLoadingSet.value.has(sha)) return;
  const loadingNext = new Set(detailLoadingSet.value);
  loadingNext.add(sha);
  detailLoadingSet.value = loadingNext;
  // 详情懒加载也接 globalLoading（共用 'timeline' namespace · 多 commit 并发自动合并）
  useGlobalLoadingStore().show('timeline');
  try {
    const detail = (await commitsGet({ projectId: pid, sha })) as CommitDto;
    const next = new Map(detailDetailCache.value);
    next.set(sha, detail);
    detailDetailCache.value = next;
  } catch (e) {
    showToast({
      type: 'error',
      message: '加载文件清单失败',
      description: (e as Error)?.message ?? '请稍后重试',
    });
  } finally {
    const loadingDone = new Set(detailLoadingSet.value);
    loadingDone.delete(sha);
    detailLoadingSet.value = loadingDone;
    useGlobalLoadingStore().hide('timeline');
  }
}

function detailAuthorInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/** v1.3 文件清单 helpers（聚合规则见 commit-detail 任务 #commit-detail-agg） */
function detailFilesHasNonBinary(files: CommitFileChangeDto[]): boolean {
  return files.some((f) => !f.binary);
}
function detailFilesTotalAdditions(files: CommitFileChangeDto[]): number {
  return files.filter((f) => !f.binary).reduce((s, f) => s + (f.additions ?? 0), 0);
}
function detailFilesTotalDeletions(files: CommitFileChangeDto[]): number {
  return files.filter((f) => !f.binary).reduce((s, f) => s + (f.deletions ?? 0), 0);
}

/** 详情弹窗里"在 gitea 打开此提交" */
function onDetailOpenInGitea(n: CommitNodeDto): void {
  const url = giteaUrl(`commit/${n.sha}`);
  if (!url) {
    showToast({ type: 'warn', message: '未配置 gitea 地址' });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 详情弹窗里"复制版本号"（复制完整 sha，便于 checkout / 引用） */
async function onDetailCopySha(n: CommitNodeDto): Promise<void> {
  try {
    await navigator.clipboard.writeText(n.sha);
    showToast({ type: 'success', message: `已复制版本号 ${n.shortSha}`, duration: 1500 });
  } catch {
    showToast({ type: 'warn', message: '复制失败，请手动选择' });
  }
}

function refresh(): void {
  void debounce.flush();
}

watch(() => activeProjectId.value, async (id) => {
  if (id) await loadBranches();
});

// ============================================================
// 数据布局计算（commit 排序 / lane 映射 / heatmap / SVG 路径）
// ============================================================

const ROW_H = 32;
const GRAPH_W = 100; // 8 lane 间距 12px（5 + 7×12 + 7 padding ≈ 100）

/** 节点按时间戳倒序（新 → 旧） */
const sortedNodes = computed<CommitNodeDto[]>(() => {
  if (!timeline.value) return [];
  return [...timeline.value.nodes].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
});

/** laneId → x 中心点（lane.order 0 = main @ x=5；12px 步进到 x=89） */
const laneXMap = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  if (!timeline.value) return map;
  const lanes = [...timeline.value.lanes].sort((a, b) => a.order - b.order);
  lanes.forEach((lane, i) => {
    map.set(lane.id, 5 + i * 12);
  });
  return map;
});

/** commitId → y 中心点（row index × 36 + 18） */
const nodeYMap = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  sortedNodes.value.forEach((n, i) => {
    map.set(n.id, i * ROW_H + 18);
  });
  return map;
});

/** 主 lane（order=0） */
const mainLane = computed<Lane | null>(() => {
  if (!timeline.value) return null;
  return timeline.value.lanes.find((l) => l.order === 0) ?? timeline.value.lanes[0] ?? null;
});

/** lane.label → CSS 颜色 token（按命名约定匹配） */
function laneColorToken(laneId: string): string {
  if (!timeline.value) return 'var(--color-text-secondary)';
  const lane = timeline.value.lanes.find((l) => l.id === laneId);
  if (!lane) return 'var(--color-text-secondary)';
  const label = lane.label.toLowerCase();
  if (label === 'main' || label.startsWith('main')) return 'var(--color-primary)';
  if (label.startsWith('feature/') || label.startsWith('feat/')) return 'var(--color-accent)';
  if (label.startsWith('hotfix/') || label.startsWith('fix/')) return 'var(--color-info)';
  if (label.includes('exp')) return 'var(--color-purple)';
  if (label.startsWith('chore/') || label.startsWith('chore')) return 'var(--color-teal)';
  if (label.startsWith('refactor/')) return 'var(--color-amber)';
  if (label.startsWith('docs/')) return 'var(--color-pink)';
  if (label.startsWith('spike/')) return 'var(--color-lime)';
  return lane.color; // fallback: 后端给的 hex
}

/** 分支名 → chip 样式（与外部 commit-row__branch pill 视觉一致） */
function branchChipStyle(name: string): string {
  if (!timeline.value) return '';
  const lane = timeline.value.lanes.find((l) => l.label === name);
  if (!lane) return `background: var(--color-bg-hover); color: var(--color-text);`;
  return `background: ${laneSoftToken(lane.id)}; color: ${laneColorToken(lane.id)};`;
}

/** lane.label → soft token（pill 背景用） */
function laneSoftToken(laneId: string): string {
  if (!timeline.value) return 'var(--color-bg-hover)';
  const lane = timeline.value.lanes.find((l) => l.id === laneId);
  if (!lane) return 'var(--color-bg-hover)';
  const label = lane.label.toLowerCase();
  if (label === 'main' || label.startsWith('main')) return 'var(--color-primary-soft)';
  if (label.startsWith('feature/') || label.startsWith('feat/')) return 'var(--color-accent-soft)';
  if (label.startsWith('hotfix/') || label.startsWith('fix/')) return 'var(--color-info-soft)';
  if (label.includes('exp')) return 'var(--color-purple-soft)';
  if (label.startsWith('chore/') || label.startsWith('chore')) return 'var(--color-teal-soft)';
  if (label.startsWith('refactor/')) return 'var(--color-amber-soft)';
  if (label.startsWith('docs/')) return 'var(--color-pink-soft)';
  if (label.startsWith('spike/')) return 'var(--color-lime-soft)';
  return 'var(--color-bg-hover)';
}

// ============================================================
// Heatmap
// ============================================================

interface HeatCell { date: string; count: number; level: number; }
interface HeatWeek { cells: HeatCell[]; }

const heatmap = computed(() => {
  if (!timeline.value) return null;

  // 1. 按 YYYY-MM-DD 分桶
  const counts = new Map<string, number>();
  for (const n of timeline.value.nodes) {
    const d = n.timestamp.slice(0, 10);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  // 2. 计算 35 周（≈8 个月）的网格起点：本周日往前推 34 周
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun
  const endSunday = new Date(today);
  endSunday.setDate(endSunday.getDate() + (6 - dow));
  const startSunday = new Date(endSunday);
  startSunday.setDate(startSunday.getDate() - 34 * 7);

  // 3. 生成 weeks
  const weeks: HeatWeek[] = [];
  const monthLabels: { week: number; label: string }[] = [];
  let lastMonth = -1;
  for (let w = 0; w < 35; w++) {
    const cells: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startSunday);
      date.setDate(startSunday.getDate() + w * 7 + d);
      const dateStr = date.toISOString().slice(0, 10);
      const count = counts.get(dateStr) ?? 0;
      const level =
        count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : count <= 10 ? 3 : 4;
      cells.push({ date: dateStr, count, level });
    }
    weeks.push({ cells });
    // 月份标签：本列第一天是几月
    const firstDay = new Date(startSunday);
    firstDay.setDate(startSunday.getDate() + w * 7);
    const m = firstDay.getMonth();
    if (m !== lastMonth) {
      monthLabels.push({ week: w, label: `${m + 1}月` });
      lastMonth = m;
    }
  }

  // 4. 总数
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  return {
    weeks,
    monthLabels,
    total,
  };
});

// ============================================================
// Branch graph SVG paths
// ============================================================

interface GraphPath {
  d: string;
  color: string;
  dashed?: boolean;
  isBridge?: boolean;
}

const graphPaths = computed<GraphPath[]>(() => {
  if (!timeline.value || sortedNodes.value.length === 0) return [];
  const nodes = sortedNodes.value;
  const xMap = laneXMap.value;
  const yMap = nodeYMap.value;
  const main = mainLane.value;
  if (!main) return [];
  const mainX = xMap.get(main.id) ?? 5;
  const mainColor = laneColorToken(main.id);
  const lastY = yMap.get(nodes[nodes.length - 1]!.id) ?? 0;

  const paths: GraphPath[] = [];

  // === 1. main 贯穿线（贯穿整列）===
  paths.push({ d: `M ${mainX} 18 L ${mainX} ${lastY}`, color: mainColor });

  // === 2. 每个 branch lane 的曲线 ===
  const branchLanes = timeline.value.lanes.filter((l) => l.order > 0);
  for (const lane of branchLanes) {
    const laneNodes = nodes.filter((n) => n.laneId === lane.id);
    if (laneNodes.length === 0) continue;
    const x = xMap.get(lane.id) ?? 0;
    const color = laneColorToken(lane.id);
    // 第一个节点（最新）
    const firstY = yMap.get(laneNodes[0]!.id) ?? 0;
    // 最后一个节点（最旧）
    const lastBranchY = yMap.get(laneNodes[laneNodes.length - 1]!.id) ?? 0;
    // 是否合并到 main（存在 isMerge 节点 = 合并过；否则视为 unmerged）
    const hasMerge = laneNodes.some((n) => n.isMerge);

    // (a) 入口曲线：mainX at firstY+ROW_H → x at firstY
    //     （如果第一个节点就是分支首 commit，从它下面进入 main）
    if (firstY + ROW_H <= lastY) {
      paths.push({
        d: `M ${mainX} ${firstY + ROW_H} C ${mainX} ${firstY + ROW_H + 8}, ${x} ${firstY + ROW_H + 8}, ${x} ${firstY}`,
        color,
      });
    }

    // (b) 节点之间的垂直线
    for (let i = 0; i < laneNodes.length - 1; i++) {
      const y1 = yMap.get(laneNodes[i]!.id) ?? 0;
      const y2 = yMap.get(laneNodes[i + 1]!.id) ?? 0;
      paths.push({ d: `M ${x} ${y1} L ${x} ${y2}`, color });
    }

    // (c) 出口曲线 或 dashed 延展
    if (hasMerge && lastBranchY - ROW_H >= 0) {
      // 合并回 main：x at lastBranchY → mainX at lastBranchY - ROW_H
      paths.push({
        d: `M ${x} ${lastBranchY} C ${x} ${lastBranchY - 8}, ${mainX} ${lastBranchY - 8}, ${mainX} ${lastBranchY - ROW_H}`,
        color,
      });
    } else if (!hasMerge) {
      // 未合并：dashed 延展到列表末尾
      paths.push({ d: `M ${x} ${lastBranchY} L ${x} ${lastY}`, color, dashed: true });
    }
  }

  // === 3. bridges：在 exp 虚线被 chore/refactor/docs/spike 交叉处画背景色小段 ===
  //     exp lane（order=3）虚线延展会被后续 branch lane 曲线穿过。
  //     找穿越的 y 位置：在每条 branch curve 穿过 exp 虚线 x=expX 处加桥
  //     简化策略：找所有与 exp lane x 接近的 crossing y
  const expLane = branchLanes.find((l) => l.label.toLowerCase().includes('exp'));
  if (expLane) {
    const expX = xMap.get(expLane.id) ?? 41;
    // 找所有穿过 expX 的非 exp 曲线 / 直线：每条 branch lane 都可能穿过
    // 简化：遍历所有 path，估算与 expX 相交的 y
    // 这里采用更简单的方法：基于 lane order 推算 — order 3 之后的所有 lane 都会有曲线穿过 expX
    const laterLanes = branchLanes.filter((l) => l.order > (expLane.order ?? 3));
    for (const lane of laterLanes) {
      const laneNodesInOrder = nodes.filter((n) => n.laneId === lane.id);
      if (laneNodesInOrder.length === 0) continue;
      // 入口曲线穿过 expX 的 y ≈ enterY + ROW_H/2 + 8
      const firstY = yMap.get(laneNodesInOrder[0]!.id) ?? 0;
      const y1 = firstY + ROW_H + 8;
      if (y1 > 0 && y1 < lastY) {
        paths.push({ isBridge: true, d: '', color: 'var(--color-bg)', x: expX, y: y1 });
      }
      // 出口曲线：x at lastBranchY-ROW_H/2 处
      if (laneNodesInOrder.some((n) => n.isMerge)) {
        const lastBranchY = yMap.get(laneNodesInOrder[laneNodesInOrder.length - 1]!.id) ?? 0;
        const y2 = lastBranchY - 8;
        if (y2 > 0 && y2 < lastY) {
          paths.push({ isBridge: true, d: '', color: 'var(--color-bg)', x: expX, y: y2 });
        }
      }
    }
  }

  return paths;
});

// ============================================================
// 行数据（commit row）
// ============================================================

interface CommitRow {
  node: CommitNodeDto;
  dotX: number;
  rowY: number;
  isHead: boolean;
  isMerge: boolean;
  branchPill: string;
  branchPillStyle: string;
  authorInitials: string;
  authorColor: string;
}

const commitRows = computed<CommitRow[]>(() => {
  if (!timeline.value) return [];
  const xMap = laneXMap.value;
  const yMap = nodeYMap.value;
  return sortedNodes.value.map((n, i) => {
    const dotX = xMap.get(n.laneId) ?? 5;
    const rowY = i * ROW_H + 18;
    // 分支 pill：取 branchHints[0] 或 lane.label
    const branchPill = n.branchHints[0] ?? timeline.value!.lanes.find((l) => l.id === n.laneId)?.label ?? '';
    const branchPillStyle = `background: ${laneSoftToken(n.laneId)}; color: ${laneColorToken(n.laneId)};`;
    // 作者头像首字母 + 颜色
    const authorInitials = n.author.name.slice(0, 2).toUpperCase();
    // 用 lane color 作为 author avatar 背景（简化）
    const authorColor = laneColorToken(n.laneId);
    return {
      node: n,
      dotX,
      rowY,
      isHead: i === 0,
      isMerge: n.isMerge,
      branchPill,
      branchPillStyle,
      authorInitials,
      authorColor,
    };
  });
});

const totalRows = computed(() => commitRows.value.length);

/** 把 ISO 时间戳转成"X 天前 / X 小时前"——简化版 */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
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
      <div class="timeline__actions">
        <button
          v-if="timeline"
          type="button"
          class="icon-btn"
          :title="'刷新'"
          :disabled="loading"
          @click="refresh"
        >
          <RefreshCw :size="14" :stroke-width="1.75" />
        </button>
        <!--
          v1.4 拍板"替换模式"：删顶栏右侧"加载中…"文字 + Loader2 spin
          全局海豚 overlay 接管请求级 loading 指示
        -->
      </div>
    </header>

    <!-- ============== 主区 ============== -->
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
      <template v-else-if="timeline && heatmap">
        <!-- 上：commit 热力图 -->
        <section class="timeline__heatmap">
          <div class="heatmap__head">
            <div class="heatmap__title">
              <span class="heatmap__count">{{ heatmap.total }}</span>
              <span class="heatmap__count-label">次提交 · 最近8个月</span>
            </div>
          </div>
          <div class="heatmap__body">
            <div class="heatmap__months">
              <span
                v-for="(m, i) in heatmap.monthLabels"
                :key="i"
                class="heatmap__month"
                :style="{ gridColumnStart: m.week + 1 }"
              >{{ m.label }}</span>
            </div>
            <div class="heatmap__grid">
              <div
                v-for="(week, wi) in heatmap.weeks"
                :key="wi"
                class="heatmap__week"
              >
                <div
                  v-for="cell in week.cells"
                  :key="cell.date"
                  class="heatmap__cell"
                  :class="`heatmap__cell--lv${cell.level}`"
                  :title="cell.count > 0 ? `${cell.count} 次提交 · ${cell.date}` : cell.date"
                />
              </div>
            </div>
            <div class="heatmap__legend">
              <span class="heatmap__legend-label">少</span>
              <span class="heatmap__legend-cell heatmap__cell--lv0" />
              <span class="heatmap__legend-cell heatmap__cell--lv1" />
              <span class="heatmap__legend-cell heatmap__cell--lv2" />
              <span class="heatmap__legend-cell heatmap__cell--lv3" />
              <span class="heatmap__legend-cell heatmap__cell--lv4" />
              <span class="heatmap__legend-label">多</span>
            </div>
          </div>
        </section>

        <!-- 下：分支提交图 + 侧边栏 -->
        <section class="timeline__graph-section">
          <div class="commit-graph">
            <div class="commit-list">
              <div class="commit-list__inner">
                <!-- 内嵌 SVG 画分支曲线（绝对定位在 rows 之上） -->
                <svg
                  class="commit-list__edges"
                  :width="GRAPH_W"
                  :height="totalRows * ROW_H"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <path
                    v-for="(p, i) in graphPaths"
                    :key="i"
                    :d="p.isBridge ? `M ${(p.x ?? 0) - 4} ${p.y} L ${(p.x ?? 0) + 4} ${p.y}` : p.d"
                    :stroke="p.color"
                    :stroke-width="p.isBridge ? '2.5' : '1.5'"
                    :stroke-dasharray="p.dashed ? '4 3' : undefined"
                    :opacity="p.dashed ? '0.55' : (p.isBridge ? '1' : '1')"
                    stroke-linecap="round"
                    fill="none"
                  />
                </svg>
                <!-- 行 -->
                <div
                  v-for="row in commitRows"
                  :key="row.node.id"
                  class="commit-row"
                  :class="{
                    'is-head-row': row.isHead,
                    'is-pr-focus': row.node.sha === prFocusSha,
                  }"
                  :data-pr-sha="row.node.sha"
                  role="button"
                  tabindex="0"
                  :aria-label="`查看提交 ${row.node.shortSha} 详情`"
                  @click="openCommitDetail(row.node)"
                  @keydown.enter.prevent="openCommitDetail(row.node)"
                  @keydown.space.prevent="openCommitDetail(row.node)"
                >
                  <div class="commit-row__graph">
                    <div
                      class="commit-row__dot"
                      :class="{ 'is-combined': row.isMerge, 'is-head': row.isHead }"
                      :style="{
                        left: row.dotX + 'px',
                        '--dot-color': row.authorColor,
                        background: row.authorColor,
                      }"
                    />
                  </div>
                  <div class="commit-row__hash mono">{{ row.node.shortSha }}</div>
                  <div class="commit-row__msg" :title="row.node.message">{{ row.node.message }}</div>
                  <div class="commit-row__meta">
                    <div
                      class="commit-row__branch"
                      :class="{ combined: row.isMerge }"
                      :style="row.branchPillStyle"
                    >
                      <template v-if="row.isMerge">← {{ row.branchPill }}</template>
                      <template v-else>{{ row.branchPill }}</template>
                    </div>
                    <div class="commit-row__author">
                      <span
                        class="commit-row__avatar"
                        :style="{ background: row.authorColor }"
                      >{{ row.authorInitials }}</span>
                      <span>{{ row.node.author.name }}</span>
                    </div>
                    <div class="commit-row__time">{{ formatRelative(row.node.timestamp) }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>

    <!-- ============================================================
         提交详情弹窗（v1.3 · 任务 #commit-detail）
         - 点 commit-row 触发 openCommitDetail → detailOpen=true
         - 内部 2 个动作：在 gitea 打开、复制链接
         - 关闭方式（A-3 P1 · B1 修法 · 2026-06-14）：
           · 点空白遮罩（@click.self）关闭
           · 按 Esc 关闭（onDetailEsc 全局监听）
           · 点右上角 × 按钮关闭（保留）
           旧版 v1.3 故意不绑 backdrop/Esc 是因为 PM 找不到关，反而
           成了"PM 以为应用卡了"的阻塞痛点。
         ============================================================ -->
    <Teleport to="body">
      <Transition name="commit-detail">
        <div
          v-if="detailOpen && detailNode"
          class="commit-detail-overlay"
          role="dialog"
          aria-modal="true"
          :aria-label="`提交 ${detailNode.shortSha} 详情`"
          @click.self="closeCommitDetail"
        >
          <div class="commit-detail">
            <header class="commit-detail__head">
              <div class="commit-detail__head-left">
                <code class="commit-detail__hash mono">{{ detailNode.sha.slice(0, 12) }}</code>
                <Tooltip :text="`复制版本号 ${detailNode.shortSha}`">
                  <button
                    type="button"
                    class="commit-detail__hash-copy"
                    :aria-label="`复制版本号 ${detailNode.shortSha}`"
                    @click="onDetailCopySha(detailNode)"
                  >
                    <Clipboard :size="12" :stroke-width="2" aria-hidden="true" />
                  </button>
                </Tooltip>
                <span class="commit-detail__head-divider" aria-hidden="true"></span>
                <Tooltip text="在 gitea 打开此提交">
                  <button
                    type="button"
                    class="commit-detail__hash-link"
                    aria-label="在 gitea 打开此提交"
                    @click="onDetailOpenInGitea(detailNode)"
                  >
                    <ExternalLink :size="12" :stroke-width="2" aria-hidden="true" />
                  </button>
                </Tooltip>
                <span v-if="detailNode.isHead" class="commit-detail__head-badge">HEAD</span>
              </div>
              <div class="commit-detail__head-right">
                <span class="commit-detail__time">{{ formatRelative(detailNode.timestamp) }}</span>
                <span class="commit-detail__time-sep">·</span>
                <span class="commit-detail__author-name">{{ detailNode.author.name }}</span>
              </div>
            </header>

            <h2 class="commit-detail__msg" :title="detailNode.message">
              {{ detailNode.message.split('\n')[0] }}
            </h2>

            <!--
              v1.3 · 内容体（msg + fullmsg + meta + files + cards）
              包在 commit-detail__body 里：
              - 弹窗 max-height:calc(100vh-64px) + overflow:hidden
              - body 用 overflow-y:auto 滚动
              - head / footer 留在 body 外 → 永远可见
            -->
            <div class="commit-detail__body">
            <pre
              v-if="detailNode.message.includes('\n')"
              class="commit-detail__fullmsg"
            >{{ detailNode.message }}</pre>

            <dl class="commit-detail__meta">
              <div class="commit-detail__meta-row">
                <dt>作者</dt>
                <dd>
                  <span class="commit-detail__avatar">
                    <img
                      v-if="detailNode.author.avatarUrl"
                      :src="detailNode.author.avatarUrl"
                      :alt="detailNode.author.name"
                      class="commit-detail__avatar-img"
                      @error="($event.target as HTMLImageElement).style.display='none'"
                    />
                    <span v-else class="commit-detail__avatar-fallback">
                      {{ detailAuthorInitial(detailNode.author.name) }}
                    </span>
                  </span>
                  <span class="commit-detail__author-name-text">{{ detailNode.author.name }}</span>
                </dd>
              </div>
              <div class="commit-detail__meta-row">
                <dt>改动</dt>
                <dd>
                  <span class="commit-detail__stat-add">+{{ detailNode.additions ?? 0 }}</span>
                  <span class="commit-detail__stat-sep">/</span>
                  <span class="commit-detail__stat-del">-{{ detailNode.deletions ?? 0 }}</span>
                  <span class="commit-detail__stat-files">· {{ detailNode.filesChanged ?? '—' }} 个文件</span>
                </dd>
              </div>
              <div v-if="detailNode.branchHints.length" class="commit-detail__meta-row">
                <dt>分支</dt>
                <dd>
                  <span
                    v-for="b in detailNode.branchHints"
                    :key="b"
                    class="commit-detail__branch-chip"
                    :style="branchChipStyle(b)"
                  >{{ b }}</span>
                </dd>
              </div>
            </dl>

            <!--
              v1.3 · 任务 #commit-detail-agg
              把"完整 message + 文件清单"聚合进弹窗
              （后续会考虑移除"分支"菜单，这个弹窗就是它的接班人）
            -->
            <div class="commit-detail__files">
              <div
                v-if="detailDetailCache.get(detailNode.sha)?.files?.length"
                class="commit-detail__files-block"
              >
                <p class="commit-detail__files-summary">
                  共修改 {{ detailDetailCache.get(detailNode.sha).files.length }} 个文件<span
                    v-if="detailFilesHasNonBinary(detailDetailCache.get(detailNode.sha).files)"
                  >，包含 <span class="commit-detail__files-add">+{{ detailFilesTotalAdditions(detailDetailCache.get(detailNode.sha).files) }}</span> 行新增 和 <span class="commit-detail__files-del">-{{ detailFilesTotalDeletions(detailDetailCache.get(detailNode.sha).files) }}</span> 行删除</span>
                </p>
                <ul class="commit-detail__files-list">
                  <li
                    v-for="f in detailDetailCache.get(detailNode.sha).files"
                    :key="(f.previousFilename ?? f.filename) + '|' + (f.status ?? '')"
                    class="commit-detail__file"
                    :class="{ 'commit-detail__file--binary': f.binary }"
                  >
                    <span class="commit-detail__file-name" :title="f.filename">
                      <span
                        v-if="f.status === 'renamed' && f.previousFilename"
                        class="commit-detail__file-rename"
                      >{{ f.previousFilename }} → {{ f.filename }}</span>
                      <span v-else>{{ f.filename }}</span>
                    </span>
                    <span v-if="!f.binary" class="commit-detail__file-stats">
                      <span class="commit-detail__files-add">+{{ f.additions ?? 0 }}</span>
                      <span class="commit-detail__files-del">-{{ f.deletions ?? 0 }}</span>
                    </span>
                    <span v-else class="commit-detail__file-tag">二进制</span>
                  </li>
                </ul>
              </div>
              <p
                v-else-if="detailLoadingSet.has(detailNode.sha)"
                class="commit-detail__files-loading muted"
              >正在加载文件清单…</p>
            </div>

            <div
              v-if="detailNode.linkedCardIds && detailNode.linkedCardIds.length"
              class="commit-detail__cards"
            >
              <div class="commit-detail__cards-title">
                关联 {{ detailNode.linkedCardIds.length }} 张卡片：
                <span class="commit-detail__cards-msg">{{ detailNode.message.split('\n')[0] }}</span>
              </div>
              <div class="commit-detail__cards-ids">
                编号
                <span
                  v-for="cid in detailNode.linkedCardIds"
                  :key="cid"
                  class="commit-detail__card-id mono"
                >#{{ cid }}</span>
              </div>
            </div>
            </div><!-- /commit-detail__body -->

            <button
              type="button"
              class="commit-detail__close"
              aria-label="关闭"
              @click="closeCommitDetail"
            >×</button>
          </div>
        </div>
      </Transition>
    </Teleport>
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
.branch-chip:hover { background: var(--color-bg-hover); color: var(--color-text); }
.branch-chip--active { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 500; }
.branch-chip--active:hover { background: var(--color-primary-soft); color: var(--color-primary); }

.timeline__actions { display: flex; align-items: center; gap: var(--space-2); }
.timeline__loading { display: inline-flex; align-items: center; gap: 4px; color: var(--color-info); font-size: var(--font-xs); }
/* v1.4 拍板"替换模式"：顶栏的 spin/Loader2 已删；全局海豚 overlay 接管 loading
   .spin / @keyframes spin CSS 也删（不再使用） */

.timeline__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.timeline__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

/* ============== Heatmap ============== */
.timeline__heatmap {
  flex-shrink: 0;
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  background: var(--color-bg);
}
.heatmap__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
  gap: var(--space-3);
}
.heatmap__title { display: flex; align-items: baseline; gap: 6px; }
.heatmap__count { font-size: var(--font-2xl); font-weight: 600; color: var(--color-primary); }
.heatmap__count-label { font-size: var(--font-sm); color: var(--color-text-secondary); }
.heatmap__body {
  /* 居中显示 heatmap —— 默认宽度（35 周 × 14px ≈ 490px）比容器窄，
   * 用 flex column + align-items: center 让月标 + grid 整体居中 */
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-x: auto;
}
.heatmap__months {
  display: grid;
  grid-template-columns: repeat(35, 12px);
  gap: 2px;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--color-text-muted);
  height: 14px;
}
.heatmap__month { white-space: nowrap; }
.heatmap__grid { display: flex; gap: 2px; }
.heatmap__week {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* week 列宽 = 12px 跟 months 列宽对齐；cell 10px 在内左对齐 */
  width: 12px;
}
.heatmap__cell {
  width: 10px; height: 10px;
  border-radius: 2px;
  transition:
    transform var(--t-fast) var(--ease),
    box-shadow var(--t-fast) var(--ease);
}
/*
 * C-3 硬约束 #5（TimelineView · state）修法（2026-06-14）：
 * 旧版 :hover transform: scale(1.3) 违反 OVERRIDE §15.2 "禁用 scale"，
 * 改成 translateY(-1px) + box-shadow，保持 layout-shift-free。
 */
.heatmap__cell:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}
/* C-3 硬约束 #4（TimelineView · color）修法：rgba 硬编码 → alpha token */
.heatmap__cell--lv0 { background: var(--color-bg-hover); }
.heatmap__cell--lv1 { background: var(--color-primary-soft); }
.heatmap__cell--lv2 { background: var(--color-primary-alpha-45); }
.heatmap__cell--lv3 { background: var(--color-primary-alpha-70); }
.heatmap__cell--lv4 { background: var(--color-primary); box-shadow: 0 0 4px var(--color-primary-glow); }
.heatmap__legend {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--space-2);
  font-size: 10px;
  color: var(--color-text-muted);
}
.heatmap__legend-label { padding: 0 4px; }
.heatmap__legend-cell { width: 10px; height: 10px; border-radius: 2px; }

/* ============== Commit graph + sidebar ============== */
.timeline__graph-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.commit-graph {
  flex: 1; min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  overflow: hidden;
}
.commit-list { position: relative; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0; scrollbar-gutter: stable; }
.commit-list::-webkit-scrollbar { width: 10px; }
.commit-list::-webkit-scrollbar-track { background: transparent; }
.commit-list::-webkit-scrollbar-thumb { background: var(--color-divider); border-radius: 5px; }
.commit-list::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }
/*
 * C-3 硬约束 #6（TimelineView · responsive）修法（2026-06-14）：
 * 旧版 min-width: 880px 阻塞 960×600 最小窗口布局。
 * 窗口 960 - navrail 224 - statusbar 28 = 708px 主区，
 * 880px > 708px 必须横向滚动。改用 auto-fit grid 自适应。
 * 注：commit-row 4 列 grid 在 1024×720 仍能完整显示（720 - 224 - 28 ≈ 468px），
 * 用 fr 单位让列宽自动按比例缩小；窄于 600px 退化为 2 列（桌面断点）。
 */
.commit-list__inner { position: relative; min-width: 0; }
.commit-list__edges {
  position: absolute; top: 0; left: 0;
  width: 54px; height: 100%;
  pointer-events: none;
  z-index: 1;
}

.commit-row {
  position: relative;
  /*
   * C-3 硬约束 #6 配套：4 列 grid 用 minmax + 1fr 自适应；
   * 1024×720 窗口（主区 ~468px）下，最右 meta 列缩到 min 80，
   * 中间 msg 列吃 1fr 弹性扩展，作者/分支/时间最小化。
   */
  display: grid;
  grid-template-columns: 60px 64px minmax(80px, 1fr) minmax(80px, 240px);
  align-items: center;
  height: var(--row-h, 32px);
  padding: 0 var(--space-3) 0 0;
  cursor: pointer;
  transition: background-color var(--t-base) var(--ease);
  z-index: 2;
}
.commit-row__meta {
  display: grid;
  /* 后两列 auto 缩到内容，避免 "kanban_bot" 跟 "2 天前" 中间留一大段空 */
  grid-template-columns: 120px auto auto;
  align-items: center;
  justify-content: end;
  gap: var(--space-2);
  min-width: 0;
}
.commit-row:hover { background: var(--color-bg-hover); }
.commit-row.is-head-row { background: linear-gradient(90deg, var(--color-primary-soft) 0%, transparent 70%); }

/* v1.4 · 任务 #merge-timeline-jump:
   从合并请求跳过来要高亮的 commit。
   - 主色软底 + 主色左边框 + 主色微光 ring 让用户一眼看到
   - 比 is-head-row 更显眼（这是用户主动跳过来的目标） */
.commit-row.is-pr-focus {
  background: var(--color-primary-soft);
  box-shadow: inset 3px 0 0 0 var(--color-primary), 0 0 0 1px var(--color-primary-alpha-45);
}
.commit-row.is-pr-focus:hover {
  background: color-mix(in srgb, var(--color-primary-soft) 70%, var(--color-primary) 8%);
}

.commit-row__graph { position: relative; width: 100px; height: 100%; }
.commit-row__dot {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 10px; height: 10px;
  border-radius: 50%;
  color: var(--dot-color, var(--color-primary));
  box-shadow: 0 0 0 2px var(--color-bg), 0 0 0 3px var(--color-divider-strong);
  transition: transform var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease);
  z-index: 3;
}
/*
 * C-3 硬约束 #5 配套：commit-row hover dot 去掉 scale(1.4)，
 * 与 heatmap__cell 保持一致（OVERRIDE §15.2 "禁用 scale"）。
 * 保留 z-index 提到 5 让 dot 在 hover 时仍在 SVG edges 之上。
 */
.commit-row:hover .commit-row__dot { z-index: 5; }
.commit-row__dot.is-combined { border-radius: 2px; }
.commit-row__dot.is-head {
  box-shadow:
    0 0 0 2px var(--color-bg),
    0 0 0 3px var(--color-primary),
    0 0 6px var(--color-primary);
}
.commit-row__dot.is-head::after {
  content: ''; position: absolute; left: 50%; top: -8px;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: var(--color-primary);
  filter: drop-shadow(0 0 2px var(--color-primary));
}

.commit-row__hash { font-size: var(--font-xs); color: var(--color-info); font-weight: 600; padding-left: 4px; }
.commit-row__msg { font-size: var(--font-sm); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: var(--space-3); }
.commit-row__branch {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  justify-self: end;
}
.commit-row__branch.combined { color: var(--color-accent) !important; background: var(--color-accent-soft) !important; }
.commit-row__author { display: flex; align-items: center; gap: 6px; font-size: var(--font-xs); color: var(--color-text-secondary); min-width: 0; }
.commit-row__avatar {
  display: inline-grid;
  place-items: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}
.commit-row__time { font-size: var(--font-xs); color: var(--color-text-muted); text-align: right; }

.mono { font-family: var(--font-mono-stack); }
.muted { color: var(--color-text-muted); }
.text-xs { font-size: var(--font-xs); }

/* ============== Commit Detail Dialog（v1.3 任务 #commit-detail）============== */
.commit-detail-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, #000 50%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.commit-detail {
  position: relative;
  width: 540px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-divider);
}
.commit-detail__close {
  position: absolute;
  top: 8px;
  right: 8px;
  background: transparent;
  border: 0;
  color: var(--color-text-muted);
  font-size: 22px;
  line-height: 1;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.commit-detail__close:hover { background: var(--color-bg-hover); color: var(--color-text); }

.commit-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /*
   * v1.3 fix #commit-detail-close-policy
   * 右边多留 36px = 28px(×按钮宽度) + 8px(×按钮 right 偏移)
   * 防止 head-right 里的"时间 · 作者"被右上角 × 按钮遮挡
   */
  padding: var(--space-3) calc(var(--space-4) + 36px) var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  gap: var(--space-3);
}
.commit-detail__head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.commit-detail__hash {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.commit-detail__hash-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.commit-detail__hash-copy:hover {
  background: var(--color-bg-hover);
  color: var(--color-primary);
}
.commit-detail__hash-copy:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.commit-detail__head-divider {
  width: 1px;
  height: 16px;
  background: var(--color-divider);
  margin: 0 4px;
  flex-shrink: 0;
}
.commit-detail__hash-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.commit-detail__hash-link:hover {
  background: var(--color-bg-hover);
  color: var(--color-primary);
}
.commit-detail__hash-link:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.commit-detail__head-badge {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-bg);
  background: var(--color-primary);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  letter-spacing: 0.5px;
}
.commit-detail__head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.commit-detail__time-sep { opacity: 0.5; }

.commit-detail__msg {
  margin: 0;
  padding: var(--space-4) var(--space-4) var(--space-2);
  font-size: var(--font-md);
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.commit-detail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  /* 自定义 webkit 滚动条 —— 跟 commit-list 一致风格 */
}
.commit-detail__body::-webkit-scrollbar { width: 10px; }
.commit-detail__body::-webkit-scrollbar-track { background: transparent; }
.commit-detail__body::-webkit-scrollbar-thumb {
  background: var(--color-divider);
  border-radius: 5px;
  border: 2px solid var(--color-bg-elevated);
}
.commit-detail__body::-webkit-scrollbar-thumb:hover { background: var(--color-divider-strong); }
.commit-detail__fullmsg {
  margin: 0 var(--space-4) var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 100px;
  overflow-y: auto;
}

.commit-detail__meta {
  margin: 0 var(--space-4) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.commit-detail__meta-row {
  display: grid;
  grid-template-columns: 56px 1fr;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
}
.commit-detail__meta-row dt {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-xs);
}
.commit-detail__meta-row dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--color-text);
}
.commit-detail__avatar {
  display: inline-flex;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--color-primary);
  color: #fff;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
.commit-detail__avatar-img { width: 100%; height: 100%; object-fit: cover; }
/*
 * C-3 硬约束 #7（TimelineView · dark mode）修法（2026-06-14）：
 * 删 fallback `#2da44e` / `#cf222e` —— gitea 默认绿/红在 light 主题下对比度仅 3.6:1，
 * 不达 WCAG AA。改纯 token，让 theme.css 中 light/dark 双版本自动适配。
 */
.commit-detail__stat-add { color: var(--color-success); font-weight: 600; }
.commit-detail__stat-del { color: var(--color-danger); font-weight: 600; }
.commit-detail__stat-sep { color: var(--color-text-muted); margin: 0 2px; }
.commit-detail__stat-files { color: var(--color-text-secondary); }
.commit-detail__branch-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 500;
  font-family: var(--font-mono-stack);
  /* 背景 / 文字色由 :style 绑定（与外部 commit-row__branch pill 一致） */
}

.commit-detail__cards {
  margin: 0 var(--space-4) var(--space-3);
  padding: var(--space-3);
  background: var(--color-success-soft, color-mix(in srgb, var(--color-primary) 12%, transparent));
  border: 1px solid color-mix(in srgb, var(--color-primary) 35%, transparent);
  border-radius: var(--radius-md);
}
.commit-detail__cards-title {
  font-size: var(--font-sm);
  color: var(--color-text);
  margin-bottom: 4px;
}
.commit-detail__cards-msg { color: var(--color-text-secondary); }
.commit-detail__cards-ids {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.commit-detail__card-id {
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
}

/* v1.3 · 文件清单（commit-detail 弹窗聚合展示） */
.commit-detail__files {
  margin: 0 var(--space-4) var(--space-3);
}
.commit-detail__files-block {
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.commit-detail__files-summary {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-divider);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}
.commit-detail__files-add { color: var(--color-success); font-weight: 600; }
.commit-detail__files-del { color: var(--color-danger); font-weight: 600; }
.commit-detail__files-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}
.commit-detail__file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  font-size: var(--font-xs);
  color: var(--color-text);
  border-bottom: 1px solid var(--color-divider);
}
.commit-detail__file:last-child { border-bottom: 0; }
.commit-detail__file:hover { background: var(--color-bg-hover); }
.commit-detail__file--binary { color: var(--color-text-muted); }
.commit-detail__file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono-stack);
}
.commit-detail__file-rename { color: var(--color-text-muted); }
.commit-detail__file-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono-stack);
  flex-shrink: 0;
}
.commit-detail__file-tag {
  display: inline-block;
  padding: 1px 6px;
  background: var(--color-bg-hover);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 10px;
  flex-shrink: 0;
}
.commit-detail__files-loading {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-xs);
  text-align: center;
}

/* 提交详情弹窗的 footer / 卡片式按钮已移除（v1.5 · 动作上移到 head 区） */

/* Transition：淡入淡出（commit-detail name） */
.commit-detail-enter-active,
.commit-detail-leave-active {
  transition: opacity var(--t-base) var(--ease);
}
.commit-detail-enter-active .commit-detail,
.commit-detail-leave-active .commit-detail {
  transition: transform var(--t-base) var(--ease), opacity var(--t-base) var(--ease);
}
.commit-detail-enter-from,
.commit-detail-leave-to {
  opacity: 0;
}
.commit-detail-enter-from .commit-detail,
.commit-detail-leave-to .commit-detail {
  transform: translateY(8px) scale(0.98);
  opacity: 0;
}
</style>
