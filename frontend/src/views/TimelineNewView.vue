<script setup lang="ts">
/**
 * TimelineNewView —— 新版 git graph 视图（v2.6 重写：直接消费 Go 端 GraphResultDto）
 *
 * v2.6 关键变化：
 * - 数据来源：Go 后端 GetGitGraph → GraphResultDto（nodes + edges + 16 色字段）
 * - 渲染：前端 lib/gitgraph/structured.ts 的 renderGraph() 直接生成 SVG path + 节点
 * - 颜色：来自后端 GraphEdge.color（对齐 Gitea Color16()），前端不再 % N 自算
 * - 彻底删除 v1 字符流往返（parser.ts / adapter.ts / Flow+Glyph+Column 模型）
 *
 * 设计参考：
 * - Gitea services/repository/gitgraph/parser.go（lane + 16 色分配算法，已移植到 Go）
 * - Gitea templates/repo/graph/svgcontainer.tmpl（SVG path 公式，1:1 对齐）
 * - Gitea web_src/css/features/gitgraph.css（flow-color-16-N 16 色变量）
 */

import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { GitCommit, RotateCw, GitBranch, Tag } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { logError } from '@renderer/lib/frontend-log';
import {
  commitsGitgraphLines,
  commitsGitgraphCloneRepo,
  commitsGitgraphPull,
  getIpcClient,
} from '@renderer/lib/ipc-client';
import { GitSyncProgressEvent } from '@renderer/types/sync-progress';
// v0.4.0：删除 deepenRepo 「加载更多」 import + 调用（GitHub 仓库 UI 与 Gitea 对齐，
//         「加载更多」按钮 + 滚动监听整段移除；commit ba0b41c 一次性收口）
import EmptyState from '@renderer/components/EmptyState.vue';
import CommitDetailPanel from '@renderer/components/CommitDetailPanel.vue';
import type { BasicCommit } from '@renderer/components/CommitDetailPanel.vue';
import { showToast } from '@renderer/lib/toast';

import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import type { GraphResultDto } from '@renderer/lib/gitgraph/structured';
import {
  renderGraphVscode,
  VSCODE_EXPAND_Y,
  VSCODE_GRID_Y,
  VSCODE_COLORS,
  type VscodeSvgRenderResult,
} from '@renderer/lib/gitgraph/vscode-render';
import GitCommitHeatmap from '@renderer/components/GitCommitHeatmap.vue';

// ============================================================
// 常量
// ============================================================
// ROW_H 在下方 SVG 渲染坐标节定义（vscode-port：直接用 VSCODE_GRID_Y）

// ============================================================
// Store & 上下文
// ============================================================
const auth = useAuthStore();
const repo = useRepoStore();

// 初始 graph 上限。
// v2.x 修复 July-X/UnrealEngine 渲染卡死：UnrealEngine release 分支中段有一段超宽 merge
// 历史（单行 1407 lane / 963 flow），-n 5000 会把这段拉进来，前端 6836 div + 963 超长 path
// 直接卡死主线程（用户看到"只有圆点、列表空白"的卡顿中间态）。
// 对齐 vscode-git-graph 默认分页：initialLoad=300。
// v0.4.0：移除「加载更多」分页机制（GitHub 仓库 UI 与 Gitea 对齐），固定用 INITIAL_GRAPH_LIMIT。
const INITIAL_GRAPH_LIMIT = 300;
/**
 * v0.7.3：当前加载上限（对齐 vscode-git-graph 的 maxCommits）。
 * 初始 = INITIAL_GRAPH_LIMIT；每次「加载更多」增加 INITIAL_GRAPH_LIMIT。
 * 后端从 offset=0 拉取 maxCommits+1 条（+1 用于判断 truncated），layout 从 0 分配 row。
 * 前端整体替换 graphDto，不追加 —— 严格复刻 vscode-git-graph 做法。
 */
const maxCommits = ref(INITIAL_GRAPH_LIMIT);
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

/** v2.6：Go 后端直接返回的结构化 Graph（含 nodes+edges+16 色字段） */
const graphDto = ref<GraphResultDto | null>(null);
/** 加载态 */
const loading = ref(false);
/** 加载更多态（分页） */
const loadingMore = ref(false);
/** 是否已加载全部 */
const allLoaded = ref(false);
/** 本地错误信息 */
const localError = ref<string | null>(null);
/** 本地 commit 已全部取出，后端正在后台 deepen 拉取远端更早历史 */
const localExhausted = ref(false);
/** 后端 deepen 已启动，前端等待 repo:sync:progress done 后自动重试 */
const deepenInProgress = ref(false);
/** 等待 deepen 完成的重试定时器（避免内存泄漏） */
let deepenRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Git Graph 加载更多文字显示控制（与 StatusBarPulse 动效同步）：
 * - loadingMore=true：显示"正在加载更多提交记录…"（与 StatusBarPulse 呼吸灯同步）
 * - allLoaded=true：显示"已到全部提交记录的末尾"
 * - 其他情况：不显示文字
 */
const showLoadMoreStatus = computed(() => {
  return graphDto.value !== null && (loadingMore.value || allLoaded.value);
});

const gitGraphLoadMoreClass = computed(() => {
  return loadingMore.value
    ? 'git-graph-load-more-loading'
    : 'git-graph-load-more-end';
});

/** v1.5 功能未启用提示（main handler 返 disabled=true 时设置） */
const featureDisabled = ref(false);
/** v1.5 启用流程：是否正在 git clone */
const cloning = ref(false);
/** v1.5 启用流程：克隆进度 / 错误信息 */
const cloneProgress = ref<string | null>(null);
/** 是否正在 pull */
const pulling = ref(false);

// v0.6.1+ Git Graph 滚动加载更多：哨兵 + IntersectionObserver
const loadMoreSentinel = ref<HTMLElement | null>(null);
let loadMoreObserver: IntersectionObserver | null = null;
// v0.7.4：防抖时间戳 + 冷却常数，避免链式触发
let lastLoadMoreTime = 0;
const LOAD_MORE_COOLDOWN_MS = 400;

/** v0.6.2：滚动容器 ref，用于「刷新」按钮 smooth scroll 到顶部
 *  - 复用现有 .timeline-new__main DOM（无需新增 wrapper）
 *  - 只在 goToLatest 内访问；其他滚动场景（watch(expandedSha)）继续走 querySelector
 *    避免与 watcher 内同名局部变量冲突
 */
const mainScrollEl = ref<HTMLElement | null>(null);


// ============================================================
// v2.9 commit 详情：行下手风琴（inline 展开）
// ============================================================
// 同时只展开 1 个 commit（VSCode Git Graph 默认行为）。
// 展开面板高度上限 300px → 超出出纵向滚动条（panel 内部已 max-height）。
// 复用 CommitDetailPanel 组件（与 CommitDetailDialog 共用同一份面板 + 缓存）。
/** 当前展开的 commit SHA；null = 全部收起 */
const expandedSha = ref<string | null>(null);
/** 当前 hover 的 commit 行，用于同步高亮左侧 graph 圆点 */
const hoveredGraphRow = ref<number | null>(null);
/** v3.0：当前 hover 的 dot（精细化到具体圆点，对齐 vscode-git-graph graphVertexActive 行为）
 *  - dotEnter(c) / dotLeave() 绑在每个 SVG circle 上
 *  - hoveredDotSha === row.commit.sha 时，给该行加 commit-row--dot-active class
 *  - 同时把 lane color 通过 CSS var --active-lane-color 写到 .git-graph-body
 *    （不是 row 上 —— SVG circle 和 row 是兄弟，CSS var 要找共同祖先才能被两边继承）
 *    .commit-row__col--graph 用它做 lane 色软底，.commit-vertex--active 用它做 drop-shadow halo */
const hoveredDotSha = ref<string | null>(null);
const hoveredDotColor = ref<string | null>(null);

/**
 * v3.12：dot hover 状态（tooltip 是普通 HTML div，在 .git-graph-body 内绝对定位）
 *  dotEnter(event, c):
 *    1. 写 --active-lane-color（CSS var 驱动 ref-badge 变色）
 *    2. 置 tooltipPending + 100ms 后显示 tooltip
 *  dotLeave():
 *    1. 立即清 tooltipPending（但不立即清 tooltipVisible，等 dot→tooltip 的几ms）
 *    2. 200ms 后清 tooltipVisible（mouse 离开到 tooltip 外时最终隐藏）
 *  策略：tooltip div 在 .git-graph-body 内（z-index 高于 commit-row），
 *  mouse 从 circle 移到 tooltip 几乎 0ms，tooltipPending 不被清除，tooltip 正常显示。
 *  mouse 离开整个 dot-hover-group 区域后，200ms delay 保证 mouse 有机会到 tooltip div。
 */
const tooltipPending = ref(false);
const tooltipPendingTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const tooltipVisible = ref(false);
const tooltipX = ref(0);
const tooltipY = ref(0);

// 对齐 vscode graph.ts showTooltip 数据结构
interface TooltipSection {
  label: string;
  items: Array<{ text: string; isRef?: boolean }>;
}

const tooltipContent = ref<{
  shortSha: string;
  colorHex: string | undefined;
  sections: TooltipSection[];
  includedInHead?: boolean;
} | null>(null);

/**
 * v3.x：算"当前分支 (按 lane 传播)" Map<sha, branchName>。
 *
 * 需求 (user 拍板): 之前 dotEnter 直接读 c.refs, 只有 branch tip dot 有
 * refs (refs 数组只在指向 branch 标签的 commit 上非空), 中间 commit 的
 * tooltip 不显示 "当前分支" —— 用户希望 lane 上每个 dot hover 都能
 * 明确自己属于哪个 branch。
 *
 * 算法 (memoized DFS, 与 inHeadShaSet 同思路):
 *   1. 构造 child map (parent SHA → [child SHA])
 *   2. 对每个 commit 递归: 优先用自己的 branch ref (refs[0] 非 tag),
 *      没就 walk children, 找最近的 branch tip
 *   3. cache 结果, 避免重复 DFS
 *
 * "PR 已合并" 例外 (user 拍板, 2026-07-01):
 *   feature 分支合并到 main 后, main 上后续 dot 不再显示 feature branch 名
 *   (因为 feature 已经合入 main, 显示 "当前分支: feature" 没意义)。
 *
 *   实现: merge commit (isMerge=true) 引入新 branch 进来, 对于 merge
 *   commit 之后的 commits (同 lane 沿 children 走), "新 branch" 不再
 *   传播。简化: 在 DFS 找 children 的 branch 时, 如果 child 是 merge
 *   commit, 该 child 的 branch 不向更下游的 commits 传播 (但 child
 *   自身仍显示自己的 branch)。
 *
 * 例:
 *   C0 -- "main"  →  C1 (merge) -- "main"  →  C2
 *           ↑
 *   C3 -- "feature"
 *
 *   C0 自己有 "main" ref → 显示 main
 *   C1 是 merge, 自己的 branch "main" → 显示 main
 *   C2: walk children from C1, C1 自己是 merge 但 C2 是 main 后续,
 *        C2 走 children 找 branch → 没 branch (C2 自己无 ref,
 *        children 无 branch ref) → 仍显示 main (从 C1 继承)
 *   C3: 自己有 "feature" ref → 显示 feature
 *
 *   (这里不显示 PR 合并状态, 因为这是 layout 层面已经处理的事, frontend
 *   只负责展示 branch label 在 lane 上的位置)
 */
const currentBranchBySha = computed<Map<string, string>>(() => {
  const dto = graphDto.value;
  if (!dto || !dto.nodes || dto.nodes.length === 0) return new Map();

  // 1. 构造 child map
  const childrenBySha = new Map<string, string[]>();
  // 2. 缓存每个 commit 自己的第一个非 tag ref (branch name)
  const ownBranchBySha = new Map<string, string>();
  for (const n of dto.nodes) {
    if (n.refs && n.refTypes) {
      for (let i = 0; i < n.refs.length; i++) {
        if (n.refTypes[i] !== 'tag' && n.refs[i]) {
          ownBranchBySha.set(n.sha, n.refs[i]!);
          break;
        }
      }
    }
    if (n.parents) {
      for (const parent of n.parents) {
        const list = childrenBySha.get(parent) ?? [];
        list.push(n.sha);
        childrenBySha.set(parent, list);
      }
    }
  }

  // 3. memoized DFS
  const cache = new Map<string, string>();
  const visiting = new Set<string>();

  function dfs(sha: string): string {
    if (cache.has(sha)) return cache.get(sha)!;
    if (visiting.has(sha)) return ''; // cycle guard
    visiting.add(sha);

    // 优先用自己的 branch ref
    const ownBranch = ownBranchBySha.get(sha);
    if (ownBranch) {
      cache.set(sha, ownBranch);
      visiting.delete(sha);
      return ownBranch;
    }

    // 沿 children 找最近的 branch tip
    const children = childrenBySha.get(sha) ?? [];
    let found = '';
    for (const child of children) {
      const childBranch = dfs(child);
      if (childBranch) {
        found = childBranch;
        break;
      }
    }
    cache.set(sha, found);
    visiting.delete(sha);
    return found;
  }

  for (const n of dto.nodes) {
    dfs(n.sha);
  }
  return cache;
});

function dotEnter(event: MouseEvent, c: SvgCircleNode) {
  hoveredDotSha.value = c.sha;
  hoveredDotColor.value = c.colorHex ?? null;
  const body = document.querySelector('.git-graph-body') as HTMLElement | null;
  if (body) {
    if (c.colorHex) {
      body.style.setProperty('--active-lane-color', c.colorHex);
    } else {
      body.style.removeProperty('--active-lane-color');
    }
  }
  // 立即置 pending，100ms 后显示 tooltip
  tooltipPending.value = true;
  if (tooltipPendingTimer.value !== null) {
    clearTimeout(tooltipPendingTimer.value);
    tooltipPendingTimer.value = null;
  }
  tooltipPendingTimer.value = setTimeout(() => {
    tooltipPendingTimer.value = null;
    if (!tooltipPending.value) return; // 已离开，不显示
    // 对齐 vscode graph.ts vertexOver：直接用 circle DOM 元素的 rect 计算 tooltip 锚点
    const circleElem = event.target as SVGCircleElement | null;
    if (!circleElem) {
        return;
    }
    const rect = circleElem.getBoundingClientRect();
    // tooltip box 放在 dot 右侧（viewport 坐标，position: fixed 相对于 viewport）
    // tooltipY = dotCenterY（box 顶部 = dot 中心 Y，即 box 垂直居中于 dot）
    // tooltip box 左侧在 dot 中心 + 30px，pointer（width=30px, left=-30px）从 box 左边缘向左延伸，
    // pointer 右端 = tooltipX，对齐 dot 中心 dotCenterX
    const dotCenterX = rect.left + rect.width / 2;
    const dotCenterY = rect.top + rect.height / 2;
    tooltipX.value = dotCenterX + 30;
    // 先临时存 dotCenterY，后面 setTimeout 里精确计算 tooltipY（box 居中于 dot）
    tooltipY.value = dotCenterY;
    // 当前 commit 自己的 tag refs (tags 本地数组)
    // "当前分支" 用 currentBranchBySha computed: 沿 lane 传播, 让 lane 上
    // 任何 dot hover 都能看到这条 lane 属于哪个 branch (不再只有 branch tip)
    const tags: string[] = [];
    if (c.refs && c.refTypes) {
      for (let i = 0; i < c.refs.length; i++) {
        if (c.refTypes[i] === 'tag' && c.refs[i]) {
          tags.push(c.refs[i]!);
        }
      }
    }
    const currentBranch = currentBranchBySha.value.get(c.sha) || '';
    const sections: TooltipSection[] = [];
    if (currentBranch) {
      sections.push({
        label: '当前分支:',
        items: [{ text: currentBranch, isRef: true }],
      });
    }
    // 标签: 只显示当前 commit 自己的 tag (跟 vscode-git-graph 一致)
    // 当前 commit 没 tag → 整个 section 不显示
    if (tags.length > 0) {
      sections.push({
        label: '标签:',
        items: tags.map((t) => ({ text: t, isRef: true })),
      });
    }
    // "included in HEAD" —— 严格对齐 vscode-git-graph childrenIncludesHead 语义
    // (web/graph.ts:813-825):
    //   C is "in HEAD" ⇔ HEAD is a descendant of C ⇔ C is an ancestor of HEAD
    // c.inHead 由 svgCircleNodes 计算时按祖先 BFS 标记 (见 inHeadShaSet computed),
    // 比单纯 c.isCurrent 覆盖更广 (HEAD 自身 + 所有祖先), 与 vscode-git-graph 一致。
    const includedInHead = c.inHead === true;
    tooltipContent.value = {
      shortSha: c.shortSha,
      colorHex: c.colorHex,
      sections,
      includedInHead,
    };
    tooltipVisible.value = true;
    // pointer 定位分两步：
    //  ① box 几何中心 = dotCenterY → tooltipY = dotCenterY - contentH/2
    //  ② pointer 在 box 内部垂直居中 → pointer.top = contentH/2
    //    pointer 高 2px + margin-top:-1px → visual center = contentH/2
    //    pointer 绝对 Y = box.top + contentH/2 = (dotCenterY - contentH/2) + contentH/2 = dotCenterY ✓
    //  ③ pointer X 用 CSS 默认 { left: -30px, width: 30px }
    //    pointer 绝对 X = (tooltipX - 30) 到 tooltipX = dotCenterX 到 dotCenterX + 30
    //    → 左端精准压到 dot 中心，右端压在 box 左边线上，不进入 box 内部
    // 用 setTimeout 0 等 DOM paint 完成后再测量 contentH
    setTimeout(() => {
      const tooltipEl = document.querySelector<HTMLElement>('.git-graph-tooltip');
      if (tooltipEl) {
        const dotCenterY = tooltipY.value;
        const contentEl = tooltipEl.querySelector<HTMLElement>('.git-graph-tooltip__content');
        const pointer = tooltipEl.querySelector<HTMLElement>('.git-graph-tooltip__pointer');
        if (contentEl && pointer) {
          const contentRect = contentEl.getBoundingClientRect();
          const newTooltipY = dotCenterY - contentRect.height / 2;
          tooltipY.value = newTooltipY;
          pointer.style.top = (contentRect.height / 2) + 'px';
          // pointer.style.left 保持 CSS 默认 (-30px)，不要在这里覆盖
        }
      }
    }, 0);
  }, 100);
}

function dotLeave() {
  tooltipPending.value = false;
  // 不立即清 tooltipVisible，等 mouse 到达/错过 tooltip div（200ms）
  if (tooltipPendingTimer.value !== null) {
    clearTimeout(tooltipPendingTimer.value);
    tooltipPendingTimer.value = null;
  }
  if (tooltipVisible.value) {
    setTimeout(() => {
      if (!tooltipPending.value) {
        tooltipVisible.value = false;
        hoveredDotSha.value = null;
        hoveredDotColor.value = null;
        const body = document.querySelector('.git-graph-body') as HTMLElement | null;
        if (body) body.style.removeProperty('--active-lane-color');
      }
    }, 200);
  }
}

/** v2.65：手风琴展开高度（实际渲染像素，ResizeObserver 实时更新）
 * 用于 SVG path d + dot cy 的 VSCode expandY：手风琴展开时，
 * expanded row 之后的 commit 视觉 y 坐标 = displayRow*ROW_H + expansionHeight
 * （VSCode 行为：lane 直线自动拉伸延伸覆盖展开行） */
const expandedHeight = ref(0);
/** 监听手风琴 DOM 元素的实际高度（max-height 300px，content-driven）
 *  ponytail: rAF 节流 + 值不变不写回，避免 observer 喂回自己触发
 *  "ResizeObserver loop completed with undelivered notifications" */
let accordionResizeObserver: ResizeObserver | null = null;
let accordionResizeRaf = 0;
function bindAccordionObserver(el: HTMLElement | null) {
  if (accordionResizeObserver) {
    accordionResizeObserver.disconnect();
    accordionResizeObserver = null;
  }
  if (!el) {
    // v2.66：保留旧 expandedHeight —— 收起瞬间避免 row 高度闪一下
    // 下一帧再次展开时 ref callback 同步读 offsetHeight 覆盖回真实值
    return;
  }
  // v2.66：accordion mount 瞬间同步读一次高度，避免首帧 expandedHeight=0
  // 导致 row 高度只有 ROW_H，hover 命中基础行而面板溢出可见
  // 但不在 row hover 范围内（用户反馈"hover 没对齐"）。
  // ResizeObserver 是异步的，第一帧不会 fire，必须同步读 offsetHeight。
  const initialH = el.offsetHeight + 8; // 4px margin-top + 4px margin-bottom
  if (initialH > 0) expandedHeight.value = initialH;
  accordionResizeObserver = new ResizeObserver((entries) => {
    if (accordionResizeRaf) return; // ponytail: 已在下一帧排好，丢掉本轮
    accordionResizeRaf = requestAnimationFrame(() => {
      accordionResizeRaf = 0;
      for (const entry of entries) {
        const h = entry.contentRect.height + 8;
        if (expandedHeight.value !== h) expandedHeight.value = h;
      }
    });
  });
  accordionResizeObserver.observe(el);
}
onUnmounted(() => {
  if (accordionResizeRaf) cancelAnimationFrame(accordionResizeRaf);
  accordionResizeRaf = 0;
  if (accordionResizeObserver) {
    accordionResizeObserver.disconnect();
    accordionResizeObserver = null;
  }
  // v3.4：清理动态行高 observer
  if (rowHeightResizeRaf) cancelAnimationFrame(rowHeightResizeRaf);
  rowHeightResizeRaf = 0;
  if (rowHeightResizeObserver) {
    rowHeightResizeObserver.disconnect();
    rowHeightResizeObserver = null;
  }
});

/** 仓库 web URL（用于 "在 Gitea/GitHub 打开 commit" 按钮）。
 *  GitHub 仓库 web URL 模板（https://github.com/${owner}/${repo}）与 Gitea 一致，
 *  区别只在 hostUrl：Gitea 是 auth.currentGiteaUrl,GitHub 是 https://github.com。
 *
 *  v2.37 修复："在 GitHub 中打开" 按钮跳转错误的 Bug。
 *  —— 旧实现用 currentGiteaUrl 永远返回 accounts[0]，当用户先连 Gitea 后连 GitHub 时
 *     GitHub 项目仍跳到 Gitea URL。
 *  —— 新实现按 currentProject.platform 查找对应平台的账号 URL；
 *     找不到对应平台账号时返回 undefined（按钮隐藏）。 */
const giteaRepoUrl = computed(() => {
  if (!repo.currentProject) return undefined;
  const platform = (repo.currentProject.platform ?? 'gitea') as 'gitea' | 'github';
  const hostUrl = auth.getAccountUrlByPlatform(platform);
  if (!hostUrl) return undefined;
  return `${hostUrl.replace(/\/$/, '')}/${repo.currentProject.owner}/${repo.currentProject.name}`;
});

/** 当前仓库所属平台（CommitDetailPanel 用以切换 "在 Gitea/GitHub 中打开" 的 tooltip） */
const currentPlatform = computed<'gitea' | 'github'>(
  () => (repo.currentProject?.platform ?? auth.accounts[0]?.platform ?? 'gitea') as 'gitea' | 'github',
);
interface DisplayCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  authorName: string;
  authorEmail: string;
  /** v2.65：merge commit 标识（来自 GraphLineCommit.isMerge）——用于 .commit-row--merge 视觉降级 */
  isMerge?: boolean;
  refs?: string[];
  refTypes?: string[];
  /** v3.13：commit 所在 lane 的颜色 hex，用于 ref badge 染色（1:1 对齐 VSCode） */
  colorHex: string;
}

/**
 * 点击 commit 行 → 切换展开
 * v2.9：直接从 GraphNodeDto 取数据，inline 展开 CommitDetailPanel
 * - 若点的是已展开的 → 收起
 * - 若点的是另一个 → 切到新 SHA（前一个自动收起）
 */
function toggleCommitDetail(commit: DisplayCommit): void {
  if (expandedSha.value === commit.sha) {
    expandedSha.value = null;
    return;
  }
  expandedSha.value = commit.sha;
}

/** 构造展开面板的 commit prop（与 GraphNodeDto 字段对齐） */
function buildBasicCommit(commit: DisplayCommit): BasicCommit {
  return {
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    date: commit.date,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    refs: commit.refs,
    refTypes: commit.refTypes,
  };
}

const expandedRow = computed<number | null>(() => {
  if (!expandedSha.value) return null;
  const rows = allRows.value;
  for (const row of rows) {
    if (row.commit?.sha === expandedSha.value) return row.row;
  }
  return null;
});

const activeExpandY = computed(() =>
  expandedRow.value !== null && expandedHeight.value > 0
    ? Math.max(VSCODE_EXPAND_Y, expandedHeight.value)
    : 0,
);

/**
 * v3.3：SVG 渲染结果（使用正确的 maxWidth 参数）
 *  对齐 vscode-git-graph main.ts:1713, 1740, 1764 调用 graph.limitMaxWidth() 时
 *  传的是"容器宽度 + padding"
 */
const svgRender = computed<VscodeSvgRenderResult | null>(() => {
  const dto = graphDto.value;
  if (!dto) return null;
  return renderGraphVscode(dto, {
    expandedAt: expandedRow.value,
    expandY: activeExpandY.value || undefined,
    maxWidth: svgMaxWidth.value, // 使用正确的 maxWidth（包含 padding）
    // v3.4：动态行高对齐（vscode main.ts:801,804）
    gridY: dynamicGridY.value,
    offsetY: dynamicOffsetY.value,
  });
});

// ============================================================
// 生命周期
// ============================================================
/** v2.8：响应 StatusBar 全局刷新按钮，重新加载 Git Graph */
function onAppRefresh(): void {
  if (activeProjectId.value) {
    loadGraph();
  }
}

onMounted(async () => {
  // v1.8 KeepAlive：onMounted 仅在首次挂载时触发；数据加载由 activateData() 统一处理
  document.addEventListener('app:refresh', onAppRefresh);
  setupRowHeightObserver();
  setupLoadMoreObserver();
  await activateData();
});

/**
 * v1.8 KeepAlive：视图进入（含首次挂载 + 从缓存恢复）时执行数据加载
 *   - 已缓存 graphDto 时跳过重复请求（切换回来秒开）
 *   - 仓库列表为空时拉一次，避免首次从 /auth 跳过来时显示空状态
 */
async function activateData() {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* */
    }
  }
  if (activeProjectId.value && !graphDto.value) {
    await loadGraph();
  }
  // v0.7.3：KeepAlive 恢复时哨兵 DOM 可能已被重建，需要重新 setup observer
  // 确保重新进入视图后滚动加载功能可用
  if (!loadMoreObserver) {
    setupLoadMoreObserver();
  }
}

/** v1.8 KeepAlive：视图停用（进入缓存）时断开 IntersectionObserver，避免后台误触发 loadMore */
onDeactivated(() => {
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;  // v0.7.3：清空引用，让 activateData 内重新创建
  }
});

/**
 * 设置 Git Graph 滚动到底自动加载更多的 IntersectionObserver。
 *
 * v0.7.3 修复：把 root 设为实际滚动容器 .timeline-new__main（mainScrollEl），
 * 而不是默认的 viewport，让哨兵在滚动容器内的可见性才是正确的判断标准。
 *
 * 背景：哨兵在 .timeline-new__main 内滚动，只有当它出现在滚动容器可见区域内时
 * InterObserver 才应触发。旧实现以 viewport 为 root，当 StatusBar（33px）遮住
 * viewport 底部时，交叉判断可能不稳定。
 *
 * 哨兵变化时的重新观察策略：
 *   - 哨兵从 null → DOM：创建 observer（如果还不存在）+ observe 哨兵
 *   - 哨兵从 DOM → null：disconnect observer 停止观察
 *   - 哨兵 DOM 替换（v-if 重渲染）：unobserve 旧 + observe 新
 */
function setupLoadMoreObserver(): void {
  // 清理旧 observer，避免重复观察
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
  loadMoreObserver = new IntersectionObserver(
    (entries) => {
      const e = entries[0];
      if (!e || !e.isIntersecting) return;
      // v0.6.5：observer 回调里同样加 loadMoreGraph 已有的 guard 条件，
      // 避免在 sentinel 已显示但仍在 IO 队列里重复入队 loadMoreGraph
      if (loadingMore.value || allLoaded.value || !graphDto.value) return;
      void loadMoreGraph();
    },
    {
      // root = 滚动容器（.timeline-new__main），null 时回退到 viewport
      root: mainScrollEl.value ?? null,
      // 哨兵距离滚动容器底部 200px 时提前触发，让用户无感加载
      rootMargin: '0px 0px 200px 0px',
      threshold: 0,
    },
  );
  if (loadMoreSentinel.value) {
    loadMoreObserver.observe(loadMoreSentinel.value);
  }
}

// v0.6.1+ 当哨兵 DOM 因 v-if 重新渲染时，重新 setup observer（重新 observe 新哨兵）
watch(loadMoreSentinel, (el) => {
  if (el && loadMoreObserver) {
    loadMoreObserver.observe(el);
  } else if (!el && loadMoreObserver) {
    // 哨兵移除时清理 observer，避免对已不存在的节点持有引用
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    // v0.7.3：切换仓库时重置 maxCommits，对齐 vscode-git-graph 切换仓库后重新从 0 拉取
    maxCommits.value = INITIAL_GRAPH_LIMIT;
    if (id) await loadGraph();
  },
);

/**
 * v2.14：展开 commit 时，只在 row 不在视口内时**轻微滚动**到 row。
 *
 * v2.13 旧实现（已删）：
 *   - 强制 scrollTo 到 absoluteTop - clientHeight * 0.15（commit-row 顶 + 15% 留白）
 *   - 手风琴绝对定位跨整宽覆盖 SVG
 *
 * v2.14 新行为：
 *   - 手风琴**流式**插入到 .git-graph-list 内部展开行之后（不再 absolute）
 *   - 只占右列宽，**不遮挡左侧 git-graph SVG**（user 反馈）
 *   - 不再强制跳到顶部；只在 row 在视口外时滚动到 row 顶部
 *
 * 滚动策略：判断 row 是否在视口可见区域内。
 *   - 可见（top >= 0 且 bottom <= clientHeight）→ 不滚
 *   - 上方被遮（top < 0）→ 滚到 row.top 贴视口顶
 *   - 下方被遮（bottom > clientHeight）→ 滚到 row.bottom 贴视口底
 */
watch(expandedSha, async (sha) => {
  if (!sha) return;
  await nextTick();
  const expandedRow = document.querySelector(
    '.commit-row--expanded',
  ) as HTMLElement | null;
  const scrollContainer = document.querySelector('.timeline-new__main') as HTMLElement | null;
  if (!expandedRow || !scrollContainer) return;
  const rowRect = expandedRow.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const rowTop = rowRect.top - containerRect.top + scrollContainer.scrollTop;
  const rowBottom = rowTop + rowRect.height;
  const visibleTop = scrollContainer.scrollTop;
  const visibleBottom = visibleTop + containerRect.height;
  // row 已经在视口内 → 不滚
  if (rowTop >= visibleTop && rowBottom <= visibleBottom) return;
  // row 在视口上方或下方 → 滚到 row 顶部贴视口顶（不强行跳到 15% 留白）
  const targetScroll = Math.max(0, rowTop - 8);
  scrollContainer.scrollTo({ top: targetScroll, behavior: 'smooth' });
});

/** 组件卸载时清理事件监听器 */
onUnmounted(() => {
  document.removeEventListener('mousemove', onColDragMove);
  document.removeEventListener('mouseup', onColDragEnd);
  document.removeEventListener('app:refresh', onAppRefresh);
  // v0.6.1+ Git Graph 滚动加载更多：清理 IntersectionObserver
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
  if (colDragRafId !== 0) {
    cancelAnimationFrame(colDragRafId);
    colDragRafId = 0;
  }
  if (deepenRetryTimer) {
    clearTimeout(deepenRetryTimer);
    deepenRetryTimer = null;
  }
});

/**
 * 加载 Git Graph 数据。
 *
 * v0.7.3 修复：严格复刻 vscode-git-graph 的 loadMoreCommits 做法 ——
 * 每次加载更多时从 offset=0 拉取 limit=总数 的全量 commit，后端 layout 算法
 * 对完整数组从 0 分配 row，前端整体替换 graphDto。
 *
 * 旧做法（offset 追加）的 bug：后端 layout 每次对当次返回的 commits 从 0 分配 row，
 * 导致 page1(row 0-299) + page2(row 0-299) 合并时 row 冲突，byRow map 被覆盖，
 * 表现为「总条目增加，但 Commit row 不增加显示」。
 *
 * @param offset 保留参数（兼容旧调用），实际对外只传 0 或 INITIAL_GRAPH_LIMIT 的增量
 */
async function loadGraph(offset = 0): Promise<void> {
  if (!activeProjectId.value) {
    return;
  }
  const isFirstLoad = graphDto.value === null;
  if (isFirstLoad) {
    loading.value = true;
    localError.value = null;
    featureDisabled.value = false;
    allLoaded.value = false;
  } else {
    loadingMore.value = true;
  }
  useGlobalLoadingStore().show('timeline');
  try {
    // v0.7.3：严格复刻 vscode-git-graph 做法 ——
    // 始终从 offset=0 拉取 maxCommits 条，后端 layout 从 0 分配 row，前端整体替换 graphDto。
    // 不追加、不合并，避免行号冲突（旧 bug：page1 row 0-299 + page2 row 0-299 合并时覆盖）。
    const dto = await commitsGitgraphLines({
      projectId: activeProjectId.value,
      limit: maxCommits.value,
      offset: 0,
    });

    const nodes = dto?.nodes ?? [];
    if (isFirstLoad && nodes.length === 0 && (dto as unknown as { disabled?: boolean }).disabled) {
      featureDisabled.value = true;
      graphDto.value = null;
    } else {
      graphDto.value = dto;
      if (isFirstLoad) nextTick(() => measureRowHeights());
    }
    // truncated = false 表示已加载全部
    allLoaded.value = !dto?.truncated;

    // v0.6.2: 后端告知本地 commit 已全部取出，远端可能有更多。
    if (dto?.localExhausted) {
      allLoaded.value = false;
      localExhausted.value = true;
      deepenInProgress.value = !!dto?.deepenTriggered;
      if (dto?.deepenTriggered && !deepenRetryTimer) {
        await waitForDeepenAndRetry(0);
      } else if (!dto?.deepenTriggered) {
        allLoaded.value = true;
        showToast({ type: 'info', message: '没有更多提交记录了', duration: 2200 });
      }
    } else {
      localExhausted.value = false;
      deepenInProgress.value = false;
    }

    expandedSha.value = null;
  } catch (e: unknown) {
    const err = e as {
      code?: string;
      messageText?: string;
      message?: string;
      hint?: string;
    };
    const msg = err.messageText ?? err.message ?? String(e) ?? '加载失败';
    logError('TimelineNewView.loadGraph', msg, e instanceof Error ? e.stack : undefined);

    const looksLikeDisabled =
      err.code === 'internal' &&
      (msg.includes('v1.5') || msg.includes('Git Graph'));
    if (looksLikeDisabled && isFirstLoad) {
      featureDisabled.value = true;
      graphDto.value = null;
    } else if (isFirstLoad) {
      localError.value = err.hint ? `${msg}（${err.hint}）` : msg;
      graphDto.value = null;
    }
  } finally {
    if (isFirstLoad) {
      loading.value = false;
    } else {
      loadingMore.value = false;
    }
    useGlobalLoadingStore().hide('timeline');
  }
}

/**
 * 加载更多 Git Graph 数据（滚动到底自动调）。
 *
 * v0.7.3 修复：严格复刻 vscode-git-graph 做法 —— 增加 maxCommits 后从 offset=0 全量拉取。
 *
 * 根因：旧做法 offset 追加时，后端 layout 每次对当次返回的 commits 从 0 分配 row，
 * 导致 page1(row 0-299) + page2(row 0-299) 合并时 row 冲突，byRow map 被覆盖，
 * 表现为「总条目数增加，但 Commit row 不增加显示」。
 *
 * 做法（对齐 vscode-git-graph loadMoreCommits）：
 *   - maxCommits += INITIAL_GRAPH_LIMIT（每次增加 300）
 *   - 调 loadGraph() 从 offset=0 拉取 maxCommits 条
 *   - 后端 layout 对完整数组从 0 分配 row
 *   - 前端整体替换 graphDto，不追加、不合并
 *
 * v0.7.4 性能优化：
 *   - 加载后不再 scrollIntoView 到底部（旧版：加载后滚到底部 → 哨兵进视口 → 又触发加载 → 链式调用）
 *   - 改为加载前记录当前 scrollHeight，加载后保持相对位置
 *   - 加 400ms 冷却时间避免 IntersectionObserver 快速连续触发
 */
async function loadMoreGraph(): Promise<void> {
  if (loadingMore.value || allLoaded.value || !graphDto.value) return;
  // v0.7.4：冷却时间防抖，避免链式触发
  const now = performance.now();
  if (now - lastLoadMoreTime < LOAD_MORE_COOLDOWN_MS) return;
  lastLoadMoreTime = now;
  const beforeCount = graphDto.value.nodes.length;
  // v0.7.3：增加 maxCommits（对齐 vscode-git-graph 的 maxCommits += config.loadMoreCommits）
  maxCommits.value += INITIAL_GRAPH_LIMIT;
  // v0.7.4：记录当前滚动状态，加载后保持位置
  const scrollContainer = mainScrollEl.value;
  const savedScrollTop = scrollContainer?.scrollTop ?? 0;
  const savedScrollHeight = scrollContainer?.scrollHeight ?? 0;
  try {
    await loadGraph();
  } catch {
    // loadGraph 内部已 logError，回滚 maxCommits 并提示
    maxCommits.value -= INITIAL_GRAPH_LIMIT;
    showToast({ type: 'error', message: '加载更多失败，请稍后重试' });
    return;
  }
  // 等 DOM 更新
  await nextTick();
  const allNodes = graphDto.value?.nodes ?? [];
  const afterCount = allNodes.length;

  // 加载结果 toast 反馈
  if (afterCount > beforeCount) {
    showToast({ type: 'success', message: `已加载 ${afterCount} 条提交`, duration: 1800 });
  } else if (
    allLoaded.value &&
    !localExhausted.value &&
    !deepenInProgress.value
  ) {
    showToast({ type: 'info', message: '没有更多提交记录了', duration: 2200 });
  }

  // v0.7.4：加载后保持滚动位置相对不变，不再 scrollIntoView 到底部
  if (scrollContainer && savedScrollHeight > 0) {
    const newScrollHeight = scrollContainer.scrollHeight;
    const addedHeight = newScrollHeight - savedScrollHeight;
    scrollContainer.scrollTop = savedScrollTop + addedHeight;
  }
}

/**
 * v0.7.0：Q弹 spring 滚动到指定 scrollTop
 *  - 用 requestAnimationFrame 自定义动画曲线，绕开浏览器 scroll-behavior: smooth 的固定缓动
 *  - easeOutBack：t 接近 1 时有过冲（overshoot），再回落，类弹簧手感
 *    公式：1 + c3 * (t - 1)^3 + c1 * (t - 1)^2，c1=1.55, c3=c1+1=2.55
 *  - 距离 < 8px 时直接跳到目标，避免微小滚动触发完整动画
 *  - 用户手动滚动（滚轮/触摸）会触发 scroll 事件，此时取消动画（避免冲突）
 *
 *  @param el 滚动容器
 *  @param targetTop 目标 scrollTop（CSS px）
 *  @param duration 动画时长（ms），默认 560
 */
function springScrollTo(
  el: HTMLElement,
  targetTop: number,
  duration = 560,
): void {
  const startTop = el.scrollTop;
  const distance = targetTop - startTop;
  if (Math.abs(distance) < 8) {
    el.scrollTop = targetTop;
    return;
  }
  // easeOutBack: c1=1.55 → 过冲约 10%，Q弹但不夸张
  const c1 = 1.55;
  const c3 = c1 + 1;
  const easeOutBack = (t: number): number => {
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };
  let rafId = 0;
  let cancelled = false;
  const onUserScroll = (): void => {
    // 用户中途手动滚 → 取消动画，避免 spring 跟用户抢控制权
    cancelled = true;
    cancelAnimationFrame(rafId);
    el.removeEventListener('wheel', onUserScroll);
    el.removeEventListener('touchstart', onUserScroll);
    el.removeEventListener('keydown', onUserScroll);
  };
  // 用户主动输入源：wheel（鼠标滚轮）+ touchstart（移动端触摸）+ keydown（PgDn/Space 等）
  el.addEventListener('wheel', onUserScroll, { passive: true, once: true });
  el.addEventListener('touchstart', onUserScroll, { passive: true, once: true });
  el.addEventListener('keydown', onUserScroll, { once: true });

  const startTime = performance.now();
  const tick = (now: number): void => {
    if (cancelled) return;
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / duration);
    const eased = easeOutBack(t);
    el.scrollTop = startTop + distance * eased;
    if (t < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      // 动画结束 → 清理用户输入监听器
      el.removeEventListener('wheel', onUserScroll);
      el.removeEventListener('touchstart', onUserScroll);
      el.removeEventListener('keydown', onUserScroll);
    }
  };
  rafId = requestAnimationFrame(tick);
}

/**
 * v0.6.2 滚动按需 deepen：loadGraph 返 localExhausted=true + deepenTriggered=true 时调用。
 * 监听 wails runtime EventsEmit("git:sync:progress") 事件，Stage=done 后自动重试 loadMoreGraph。
 *
 * 注意：
 *  - 不依赖 wailsEvents shim，直接用 getIpcClient().on() 与 repo store initProgressEvents 同路径
 *  - 超时 300 秒（相当于 5 分钟，深历史 deepen 可能几十秒 ~ 几分钟）
 *  - 超时后给用户展示「重试」按钮（localExhausted.value=true，但 deepenInProgress.value=false）
 */
async function waitForDeepenAndRetry(_offset: number): Promise<void> {
  if (!activeRepo.value) return;
  const repoKey = activeRepo.value.fullName;
  let off: (() => void) | null = null;
  let timedOut = false;
  deepenInProgress.value = true;
  try {
    const client = getIpcClient();
    await Promise.race([
      new Promise<void>((resolve) => {
        off = client.on(GitSyncProgressEvent, (payload: unknown) => {
          const p = payload as { repoKey?: string; stage?: string };
          if (p?.repoKey === repoKey && p?.stage === 'done') resolve();
        });
      }),
      new Promise<void>((resolve) => {
        deepenRetryTimer = setTimeout(() => { timedOut = true; resolve(); }, 300_000);
      }),
    ]);
  } finally {
    if (off) off();
    if (deepenRetryTimer) { clearTimeout(deepenRetryTimer); deepenRetryTimer = null; }
    deepenInProgress.value = false;
    localExhausted.value = false;
  }
  if (timedOut) return;
  // v0.6.5：deepen 完成后直接调 loadMoreGraph() 重新尝试加载。
  // loadMoreGraph 内部已有 guard (loadingMore/allLoaded/graphDto)，
  // 会重新算 offset = graphDto.value.nodes.length 然后调 loadGraph(offset)。
  // 去掉 `newOffset > offset` 判断：之前该条件不满足时会丢失自动重试，
  // 因为 graphDto.value.nodes.length 在 deepen 后未即时变，但下一次 loadGraph offset 分页能拿到新 commit。
  if (!allLoaded.value && graphDto.value) {
    await loadMoreGraph();
  }
}

/**
 * v0.6.2 重定义：右上角按钮语义从「同步」改为「刷新」
 *
 * 旧版（v2.x）只做 pull + 重新渲染，用户滚到下方翻历史后还得手动滚回顶部；
 * 而且 loadGraph(0) 整页重置会让已经滚动加载到的更深历史 commit 全部丢失。
 *
 * 新版语义（user 拍板 2026-07-04）：
 *   - 拉取远端最新数据（pull / 首次 clone）
 *   - 重新渲染最新 300 条
 *   - **强制 smooth scroll 回列表开头**
 *   用户主动点的按钮，他预期会跳走；想继续看历史？往下滚，loadMore 仍然生效。
 *
 * 流程：
 *   1. 未 clone（clonedMap=false）→ 调 commitsGitgraphCloneRepo（NoCheckout 轻量模式）
 *   2. 已 clone → 调 commitsGitgraphPull（git fetch + 更新本地 HEAD + 统计 addedCommits）
 *   3. loadGraph() 重渲染顶部 300 条
 *   4. nextTick 后 mainScrollEl.scrollTo({ top: 0, behavior: 'smooth' })
 *   5. Toast 反馈：「已刷新」/「已刷新，同步了 N 个新提交」/ 错误
 *
 * 命名说明：
 *   - UI 按钮文案「刷新」传达用户视角：一次性把图谱同步到最新并跳到顶部
 *   - 函数名 `goToLatest` 反映代码逻辑：拉远端 + 跳到顶部（更准确）
 *   - 内部保留 goToLatest / mainScrollEl 等英文命名，避免无谓 churn
 *
 * 与现有机制的关系：
 *   - 与「滚动加载更多」互补，不冲突（loadMore 在用户向下滚时触发）
 *   - 与 StatusBar 全局刷新按钮互补（那个只重新渲染本地数据，不拉远端）
 *   - 与 StatusBar 仓库行末「更新」按钮互补（那个只 pull，不切回顶部）
 */
async function goToLatest(): Promise<void> {
  if (!activeProjectId.value) return;
  // v0.7.3：刷新时重置 maxCommits，回到初始状态
  maxCommits.value = INITIAL_GRAPH_LIMIT;
  pulling.value = true;
  useGlobalLoadingStore().show('timeline');
  try {
    const repo2 = activeRepo.value;
    const cloned = repo2 ? repo.clonedMap[`${repo2.owner}/${repo2.name}`] === true : false;
    let addedCommits = 0;
    if (!cloned) {
      // 未同步本地 → 首次 clone（与旧版 syncRepo 行为一致）
      await commitsGitgraphCloneRepo({
        projectId: activeProjectId.value,
      });
      // 更新 clonedMap 缓存（避免下次又走 clone 分支）
      if (repo2) {
        repo.clonedMap[`${repo2.owner}/${repo2.name}`] = true;
      }
      showToast({
        type: 'success',
        message: '已刷新',
        description: `${repo2?.fullName ?? ''} 首次同步完成`,
      });
    } else {
      // 已同步本地 → pull 更新
      const resp = await commitsGitgraphPull({
        projectId: activeProjectId.value,
      });
      addedCommits = resp.addedCommits ?? 0;
      if (addedCommits > 0) {
        showToast({ type: 'info', message: `已刷新，同步了 ${addedCommits} 个新提交` });
      } else {
        showToast({ type: 'info', message: '已刷新，已是最新版本' });
      }
    }
    // 重新加载 graph（显示最新 commit + 完整 layout）
    await loadGraph();
    // 刷新 clonedMap 缓存（让 StatusBar 仓库行按钮切到「更新」）
    await repo.refreshClonedStatus();
    // 滚动到列表开头：等 nextTick 让 loadGraph 完成的 DOM 更新落地
    await nextTick();
    if (mainScrollEl.value) {
      mainScrollEl.value.scrollTo({ top: 0, behavior: 'smooth' });
    }
  } catch (e: unknown) {
    const err = e as { messageText?: string; message?: string; hint?: string };
    const msg = err.messageText ?? err.message ?? String(e) ?? '刷新失败';
    logError('TimelineNewView.goToLatest', msg, e instanceof Error ? e.stack : undefined);
    showToast({ type: 'error', message: msg });
  } finally {
    pulling.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

/** v0.6.2 按钮文字：根据 pulling 状态显示「刷新」/「正在刷新…」
 *  - UI 文案用「刷新」（与全应用其他「刷新」按钮语义对齐，如 StatusBar 主题旁的全局刷新）
 *  - 内部函数仍叫 goToLatest（更准确表达「拉远端 + 跳到顶部」逻辑）
 *  - loading 期间用户知道正在干啥
 */
const goToLatestLabel = computed<string>(() => {
  if (pulling.value) return '正在刷新…';
  return '刷新';
});

/**
 * 启用流程：用户点「启用 Git Graph」按钮 → Go 端用 go-git 轻量同步仓库
 *
 * 流程：
 *   1. cloning=true，显示"正在同步..."
 *   2. 调 IPC commitsGitgraphCloneRepo（Go 端从 keychain 读 token + go-git NoCheckout clone）
 *   3. 成功 → cloneProgress="已完成" → 重新 loadGraph（基于本地 commit DAG 渲染）
 *   4. 失败 → cloneProgress=错误信息
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
    cloneProgress.value = `已完成：${resp.localPath}${resp.reused ? '（复用已有仓库）' : ''}`;
    // 重新加载；Go binding 会从 projectId 反查本地路径并返回结构化 GraphResult。
    await loadGraph();
  } catch (e: unknown) {
    const err = e as { messageText?: string; message?: string; hint?: string };
    const msg = err.messageText ?? err.message ?? String(e) ?? '启用失败';
    cloneProgress.value = `启用失败：${msg}`;
    logError('TimelineNewView.enableGitGraph', '启用 Git Graph 失败', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  } finally {
    cloning.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

// ============================================================
// SVG 渲染坐标（vscode-port：对齐 vscode-render.ts 的 GRID_Y）
// ============================================================
//
// v2.6 改用结构化渲染（不再走字符流）：
// - dot 圆点用 HTML overlay（不受 SVG 缩放影响）+ commit 列表逐行对齐
//
// v3.4：动态行高对齐（vscode-git-graph main.ts:801,804）
//   - grid.y = (bodyHeight - headerHeight) / commits.length（动态）
//   - offsetY = headerHeight + grid.y / 2（补偿表头）
//   - dot cy 精确落在每行中心，不依赖固定 24px
const ROW_H = VSCODE_GRID_Y;

/** 动态表头高度（ResizeObserver 实时测量 .git-graph-header） */
const headerHeightPx = ref(32);
/** v3.4：wrapper 实际宽度（替代 window.innerWidth，对齐 vscode viewElem.clientWidth） */
const wrapperClientWidth = ref(1200);
/** 动态行高（ResizeObserver 实时测量 .git-graph-body / commits.length） */
const dynamicGridY = ref(VSCODE_GRID_Y);
/**
 * v3.4：动态 offsetY（对齐 vscode main.ts:804）
 *   - vscode: offsetY = headerHeight + gridY/2（SVG 覆盖整个表格含 header）
 *   - 我们: SVG 在 body 内（body 在 header 下方），原点在 body 顶部，
 *     所以 offsetY = gridY/2（不含 headerHeight，让第一行 dot 落在行中心）
 */
const dynamicOffsetY = computed(() => dynamicGridY.value / 2);

/** v3.4：动态行高 observer（测量 header + body 实际渲染高度，对齐 vscode main.ts:801）
 *  ponytail: rAF 节流 + 值不变不写回，避免 observer 喂回自己触发
 *  "ResizeObserver loop completed with undelivered notifications" */
let rowHeightResizeObserver: ResizeObserver | null = null;
let rowHeightResizeRaf = 0;

/** 测量并更新 headerHeightPx / dynamicGridY / wrapperClientWidth */
function measureRowHeights(): void {
  const wrapper = document.querySelector('.git-graph-wrapper') as HTMLElement | null;
  if (!wrapper) return;
  // v3.4：测量 wrapper 实际宽度（替代 window.innerWidth，对齐 vscode viewElem.clientWidth）
  wrapperClientWidth.value = wrapper.clientWidth;
  const header = wrapper.querySelector('.git-graph-header') as HTMLElement | null;
  const body = wrapper.querySelector('.git-graph-body') as HTMLElement | null;
  if (header) {
    headerHeightPx.value = header.clientHeight;
  }
  // vscode main.ts:801: grid.y = (tableHeight - headerHeight) / commits.length
  // 这里用第一个 commit-row 的实际高度作为单行高度（更直接，避免 body 含 accordion 撑高）
  if (body) {
    const firstRow = body.querySelector('.commit-row') as HTMLElement | null;
    if (firstRow) {
      const rowH = firstRow.clientHeight;
      if (rowH > 0) dynamicGridY.value = rowH;
    }
  }
}

/**
 * v3.4：动态行高 observer（对齐 vscode main.ts:801,804）
 *   - grid.y = (bodyHeight - headerHeight) / commits.length（动态）
 *   - offsetY = headerHeight + grid.y/2（补偿表头）
 *   - dot cy 精确落在每行中心，不依赖固定 24px
 */
function setupRowHeightObserver(): void {
  if (rowHeightResizeObserver) rowHeightResizeObserver.disconnect();
  nextTick(() => {
    measureRowHeights();
    const wrapper = document.querySelector('.git-graph-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    rowHeightResizeObserver = new ResizeObserver(() => {
      // ponytail：observer 回调里同步写 dynamicGridY 会让 Vue 重渲，
      // 重渲改 path d 触发新一轮 resize —— Chrome 直接报
      // "ResizeObserver loop completed with undelivered notifications"。
      // rAF 推迟到下一帧，且若已排好就丢本轮，避免在 observer 帧内连环触发。
      // 值相等也不写回（measureRowHeights 内 `if (rowH > 0) dynamicGridY.value = rowH`）
      if (rowHeightResizeRaf) return;
      rowHeightResizeRaf = requestAnimationFrame(() => {
        rowHeightResizeRaf = 0;
        measureRowHeights();
      });
    });
    // v3.4：观察 wrapper（宽度变化）、header（高度变化）、body（行高变化）
    rowHeightResizeObserver.observe(wrapper);
    const header = wrapper.querySelector('.git-graph-header');
    const body = wrapper.querySelector('.git-graph-body');
    if (header) rowHeightResizeObserver.observe(header);
    if (body) rowHeightResizeObserver.observe(body);
  });
}

const maxRowPlusOne = computed(() => {
  const dto = graphDto.value;
  if (!dto || dto.nodes.length === 0) return 0;
  return Math.max(...dto.nodes.map((n) => n.row)) + 1;
});

// v3.5：viewBox computed 已移除——SVG 不用 viewBox，直接像素坐标（对齐 vscode）
/**
 * v3.3：SVG 元素的实际渲染宽度
 *  对齐 vscode-git-graph graph.ts:697-700 setSvgWidth()
 *  SVG width = min(contentWidth, maxWidth)
 *  - contentWidth：所有 lane 完整渲染需要的宽度
 *  - maxWidth：容器限制（来自 svgMaxWidth，包含 padding）
 *  当 contentWidth > maxWidth 时，SVG 截断到 maxWidth，右侧用 CSS mask 渐变淡出
 */
const svgWidth = computed(() => {
  const r = svgRender.value;
  if (!r) return '0px';
  const contentW = r.contentWidth;
  const maxW = svgMaxWidth.value;
  // maxW > 0 时取 min，否则完整渲染
  const w = maxW > 0 ? Math.min(contentW, maxW) : contentW;
  return `${w}px`;
});

/**
 * v3.3：SVG mask 渐变（动态计算）
 *  对齐 vscode-git-graph graph.ts:691-694 applyMaxWidth()
 *  当 contentWidth > maxWidth 时，右侧 12px 渐变淡出
 *  offset1 = (maxWidth - 12) / contentWidth
 *  offset2 = maxWidth / contentWidth
 */
const svgMaskGradient = computed(() => {
  const r = svgRender.value;
  if (!r) return 'none';
  const contentW = r.contentWidth;
  const maxW = svgMaxWidth.value;
  if (maxW <= 0 || contentW <= maxW) return 'none'; // 不需要 mask
  // vscode 渐变：(maxW-12)/contentW → maxW/contentW
  const offset1 = ((maxW - 12) / contentW) * 100;
  const offset2 = (maxW / contentW) * 100;
  return `linear-gradient(to right, black 0%, black ${offset1}%, transparent ${offset2}%)`;
});
const svgHeight = computed(() => {
  const r = svgRender.value;
  return r ? `${r.height}px` : '0px';
});

// ============================================================
// Path 分组（按 color 分组，对齐 Gitea flow-color-16-N 染色）
// ============================================================
interface PathGroup {
  id: string;
  order: number;
  colorIndex: number; // 0..15，对齐 Gitea Color16()
  colorClass: string; // 'flow-color-16-N'
  colorHex?: string;
  d: string; // 单条 path 的 d
  kind?: 'line' | 'shadow'; // vscode Branch.drawPath: shadow (stroke-width=4) + line (stroke-width=2)
  /** v3.x：UNCOMMITTED 触发的灰色段。true 走 lane 色, false 走 #808080 + dasharray。 */
  isCommitted?: boolean;
  /** stroke-dasharray 属性值；isCommitted=false 时固定为 '2px'。 */
  dasharray?: string;
}

const pathGroups = computed<PathGroup[]>(() => {
  const r = svgRender.value;
  if (!r) return [];
  // 保持后端 edge 原始顺序，避免按颜色重排后改变 path 覆盖层级。
  // 每个 vscode path 拆成 shadow + line 两条 (Branch.drawPath:149-159)
  // v3.x：透传 isCommitted / dasharray，让 UNCOMMITTED 灰色虚线段
  return r.paths.map((p) => ({
    id: `structured-${p.kind ?? 'line'}-${p.order}`,
    order: p.order,
    colorIndex: p.colorIndex,
    colorClass: `flow-color-16-${p.colorIndex}`,
    colorHex: p.colorHex,
    d: p.d,
    kind: p.kind,
    isCommitted: p.isCommitted,
    dasharray: p.dasharray,
  }));
});

/**
 * 完整行数组（row 0..maxRow）—— v2.6 简化：
 * 每个 GraphNodeDto 对应一行；后端 lane 算法保证 commit 连续，无 relation 占位
 *
 * 背景 bug（v1）：字符流往返会让 merge edge 中间出现"空 row"（relation 行），
 *   需要前后端共同维护 relationCommits。v2.6 后端 BuildGraph 直接给 row+lane，
 *   前端按 row 平铺，无需任何占位行。
 */
interface DisplayRow {
  row: number;
  commit: DisplayCommit | null;
}
const allRows = computed<DisplayRow[]>(() => {
  const dto = graphDto.value;
  if (!dto) return [];
  const sorted = [...dto.nodes].sort((a, b) => a.row - b.row);
  const maxRow = sorted.length > 0 ? sorted[sorted.length - 1].row : 0;
  const byRow = new Map<number, NonNullable<GraphResultDto['nodes']>[number]>();
  for (const n of sorted) byRow.set(n.row, n);
  const out: DisplayRow[] = [];
  for (let row = 0; row <= maxRow; row++) {
    const commit = byRow.get(row);
    out.push({
      row,
      commit: commit
        ? {
            sha: commit.sha,
            shortSha: commit.shortSha,
            subject: commit.subject,
            date: commit.date,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail,
            isMerge: commit.isMerge,
            refs: commit.refs,
            refTypes: commit.refTypes,
            // v3.13：lane 色 hex，对齐 VSCode Git Graph ref badge 染色
            // dto.color 是 0-15，颜色由 Go 端 BuildGraphVscode 给出，前端用 LANE_COLORS 转 hex
            colorHex: VSCODE_COLORS[commit.color % VSCODE_COLORS.length] ?? VSCODE_COLORS[0] ?? '#0085d9',
          }
        : null,
    });
  }
  return out;
});

const activeCommitCount = computed(() => {
  return graphDto.value?.nodes.length ?? 0;
});

// ============================================================
// ref 颜色（v2.6：refs 由 CommitDetailDialog 内部按需拉，此处不再需要 refColor/refBg）

// ============================================================
// 辅助
// ============================================================
/**
 * v3.8 → v3.9 修复：authorDate 相对时间（对齐 vscode-git-graph web/utils.ts:280-302）
 *
 * v3.9 修复项：
 *   - 新增「周」单位（7 天 = 604800s 边界），旧版缺失导致 7-29 天全显示为 "Xd前"
 *   - 改用 Math.round（四舍五入），旧版用 Math.floor（向下取整）导致偏差大
 *     例：36 小时前 → 旧版 "1天前"，新版 "2天前"（对齐 vscode "2 days ago"）
 *   - 月/年阈值对齐 vscode：2629800s/月（30.4375 天均值）、31557600s/年（365.25 天）
 *     旧版用 Math.floor(day/30)/Math.floor(mo/12) 级联截断，累积误差更大
 *   - 新增防御：无效日期（NaN/空串）返回 "—"，未来日期返回 "刚刚"
 *   - 时间源：go-git commit.Author.When（ISO 8601 字符串），getTime() 返回 UTC 毫秒
 *     Date.now() 也是 UTC 毫秒 → diff 是真实流逝时间，作者时区不影响计算
 *
 * vscode 算法（web/utils.ts formatShortDate.Relative 分支）：
 *   diff = now_seconds - unix_timestamp
 *   < 60s: "X seconds ago"
 *   < 3600s: "X minute(s) ago" (diff/60, round)
 *   < 86400s: "X hour(s) ago" (diff/3600, round)
 *   < 604800s: "X day(s) ago" (diff/86400, round)
 *   < 2629800s: "X week(s) ago" (diff/604800, round)
 *   < 31557600s: "X month(s) ago" (diff/2629800, round)
 *   >= 31557600s: "X year(s) ago" (diff/31557600, round)
 */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return '刚刚';
  let val: number;
  if (diffSec < 3600) {
    val = Math.round(diffSec / 60);
    return `${val}分钟前`;
  }
  if (diffSec < 86400) {
    val = Math.round(diffSec / 3600);
    return `${val}小时前`;
  }
  if (diffSec < 604800) {
    val = Math.round(diffSec / 86400);
    return `${val}天前`;
  }
  if (diffSec < 2629800) {
    val = Math.round(diffSec / 604800);
    return `${val}周前`;
  }
  if (diffSec < 31557600) {
    val = Math.round(diffSec / 2629800);
    return `${val}月前`;
  }
  val = Math.round(diffSec / 31557600);
  return `${val}年前`;
}

/**
 * v3.8：authorDate 完整绝对时间（commit row 日期列 title tooltip）
 *   - 时间源：同 formatRelative（commit.Author.When）
 *   - 时区：用户电脑时区（getHours/getMinutes 自动按浏览器系统时区）
 *     → 例：author 时区是 +08:00 的"2026-06-30 14:23:45"，用户电脑是 +09:00 → 显示 "2026-06-30 15:23:45"
 *   - vscode web/utils.ts:305 title 是同模式（getHours 等 Date 实例方法 → 本地时区）
 *   - 注意：日期部分 getFullYear/getMonth/getDate 也是本地时区，与时间字段语义一致
 */
function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * v2.10：当前展开的 commit node（直接从 allRows 拿，懒加载 detail 用）
 */
const expandedCommitNode = computed<
  DisplayCommit | null
>(() => {
  if (!expandedSha.value) return null;
  const rows = allRows.value;
  for (const r of rows) {
    if (r.commit && r.commit.sha === expandedSha.value) return r.commit;
  }
  return null;
});

// v2.14：手风琴改为流式插入 .git-graph-list 内部（不再 absolute），
// 不再需要 accordionTop / accordionPositionStyle 这两个 computed。
// 高度限制直接通过 CSS .commit-accordion { max-height } 控制。
// 保留 ACCORDION_MAX_HEIGHT 常量供 CSS 注释和 ref 使用。
// const ACCORDION_MAX_HEIGHT = 260;

/**
 * SourceTree 风格布局（v2.15）：
 *   - SVG 完整渲染固定宽度（= svgWidth），不缩放
 *   - commit log 内容浮在 git-graph 上方（盖板），用 padding-left 留出 lane 起点位置
 *   - 不再有\"拉宽/缩窄拖拽缩放\"，避免圆点和线不同步缩放造成视觉错位
 */

interface SvgCircleNode {
  sha: string;
  shortSha: string;
  subject: string;
  title: string;
  row: number;
  cx: number;
  cy: number;
  r: number;
  colorHex?: string;
  isCurrent?: boolean;
  isStash?: boolean;
  isCommitted?: boolean;
  refs?: string[];
  refTypes?: string[];
  authorName: string;
  date: string;
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  /**
   * v3.x：此 commit 是否"包含在 HEAD 中"。
   * 严格对齐 vscode-git-graph web/graph.ts:813-825 的 childrenIncludesHead 语义：
   *   - true ⇔ HEAD 是这个 commit 的 descendant ⇔ 此 commit 是 HEAD 的 ancestor
   *     (git 术语: reachable from HEAD via parents)
   *   - HEAD 自身、所有 77399179 的祖先 (init commit, etc.) 都为 true
   *   - 所有 77399179 之后 (unpulled, descendant) 的 commit 都为 false
   *
   * 旧实现用 c.isCurrent === true 只覆盖 HEAD 自身，太窄; 现在通过 BFS
   * 从 HEAD 沿 parents 走一遍算出祖先集合,所有 visited 节点标 true。
   */
  inHead?: boolean;
}

function dotTitle(subject: string, refs?: string[], refTypes?: string[]): string {
  const branch = refs?.find((_, i) => refTypes?.[i] !== 'tag');
  return branch ?? refs?.[0] ?? subject;
}

/**
 * v3.x：算 HEAD 祖先集合 (strict vscode-git-graph semantic)。
 *
 * 算法: 从 HEAD commit 出发, 沿 node.parents (BFS) 走一遍, 标记所有 visited
 * 为祖先。等价于 "C is reachable from HEAD via parents"。
 *
 * - HEAD 自身、所有 HEAD 的祖先 (older commits on HEAD 所在的 branch)
 *   都在集合里 → tooltip 显示 "包含在 HEAD 中"
 * - 任何 HEAD 的 descendant (unpulled commits, merge 引入的 newer commit)
 *   不在集合里 → tooltip 显示 "不包含在 HEAD 中"
 *
 * 不要用 c.isCurrent: isCurrent 只覆盖 HEAD 自身, 太窄 (vscode-git-graph
 * 把它当 "isCurrent" 是错的, 它真正用的是 ancestor-of-HEAD 语义)。
 */
const inHeadShaSet = computed<Set<string>>(() => {
  const dto = graphDto.value;
  if (!dto || !dto.nodes || dto.nodes.length === 0) return new Set();

  // 1. 找 HEAD SHA (isCurrent=true 的节点)
  let headSha: string | undefined;
  for (const n of dto.nodes) {
    if (n.isCurrent) {
      headSha = n.sha;
      break;
    }
  }
  if (!headSha) return new Set();

  // 2. 构造 child → parents 索引 (走 parent 链找祖先)
  const parentsBySha = new Map<string, string[]>();
  for (const n of dto.nodes) {
    parentsBySha.set(n.sha, n.parents ?? []);
  }

  // 3. BFS 从 HEAD 沿 parents 走, 收集所有 visited
  const visited = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    const parents = parentsBySha.get(sha) ?? [];
    for (const p of parents) {
      if (p && !visited.has(p)) queue.push(p);
    }
  }
  return visited;
});

const svgCircleNodes = computed<SvgCircleNode[]>(() => {
  return (svgRender.value?.nodes ?? []).map((node) => {
    // v3.x：UNCOMMITTED 虚拟 commit 强制 isCurrent=true，让它画成空心圆
    // （对齐 vscode graph.ts:424-426：UNCOMMITTED + OpenCircleAtTheUncommittedChanges
    // 风格默认是空心 + fill=bg + stroke=color）。这里用 sha === '*' 判定比
    // node.isCommitted === false 更稳，避免将来 isCommitted 字段意义被扩展时
    // 误触发。
    const isUncommittedVertex = node.sha === '*';
    const isCurrent = node.isCurrent || isUncommittedVertex;
    return {
      sha: node.sha,
      shortSha: node.shortSha,
      subject: node.subject,
      title: dotTitle(node.subject, node.refs, node.refTypes),
      row: node.row,
      cx: node.cx,
      cy: node.cy,
      r: node.isStash ? 4.5 : 4,
      colorHex: node.colorHex,
      isCurrent,
      isStash: node.isStash && !isUncommittedVertex,
      isCommitted: node.isCommitted,
      refs: node.refs,
      refTypes: node.refTypes,
      authorName: node.authorName,
      date: node.date,
      stroke: isCurrent ? node.colorHex : 'rgba(30, 30, 30, 0.75)',
      strokeWidth: isCurrent ? 2 : 1,
      strokeOpacity: isCurrent ? 1 : 0.75,
      // v3.x: 走 vscode-git-graph ancestor-of-HEAD 语义, 不再用 isCurrent
      inHead: inHeadShaSet.value.has(node.sha),
    };
  });
});

// ============================================================
// v3.0：列宽模型 + 拖动 + 双击隐藏（严格 1:1 复刻 vscode-git-graph）
// 对齐 vscode-git-graph web/main.ts + web/utils.ts + web/styles/main.css：
//   - 5 列：Graph (col 0) / Description (col 1) / Date (col 2) / Author (col 3) / Commit (col 4)
//   - columnWidths: number[] （COLUMN_HIDDEN=-100 / COLUMN_AUTO=-101 / 数字=px）
//   - 拖动：mousedown 缓存 startWidths + startX，mousemove 更新 colDragPreviewWidths ref
//     （DOM 写入，跟 vscode main.ts:1706-1777 行为一致）
//   - 双击 handle：toggle HIDDEN ↔ AUTO/defaultWidth（main.ts:1811-1815）
//   - 右键菜单：toggle Date/Author/Commit 显隐（main.ts:1808-1865）
//   - 持久化：localStorage[COLUMN_WIDTHS_V3_KEY]，旧 key 不用兼容（"丢弃历史包袱"）
//   - 保留中文 UI（AGENTS §9.1 零术语：日期/作者/提交；Graph/Description 保留英文）
// ============================================================

/** vscode constants（对齐 web/utils.ts:69-73） */
const COLUMN_HIDDEN = -100;
const COLUMN_AUTO = -101;
const COLUMN_MIN_WIDTH = 40;
const COLUMN_LEFT_RIGHT_PADDING = 24;

/** 列宽状态类型（数字可以是 HIDDEN/AUTO/px） */
type ColumnWidth = number;

/**
 * v3.3：5 列默认宽度（严格对齐 vscode-git-graph）
 *  对齐 vscode-git-graph web/main.ts:1724 首次跑仓库时的 columnWidths 默认值：
 *    - col 0 Graph：COLUMN_AUTO（自适应 contentWidth，限制在 viewWidth * 0.333）
 *    - col 1 Description：COLUMN_AUTO (1fr 占满)
 *    - col 2-4 Date/Author/Commit：COLUMN_AUTO 或 HIDDEN（按用户配置）
 *  vscode 行为：AUTO 模式下 Graph 列视觉宽度 = min(contentWidth, viewWidth * 0.333)
 *  拖动后变为固定数字，双击恢复为 COLUMN_AUTO（main.ts:1811-1815）
 *  vscode main.ts:1829-1841 双击恢复的 defaultWidth：Date 128 / Author 128 / Commit 80
 */
const DEFAULT_GRAPH_COL_WIDTH = 300; // Graph 列 AUTO 模式下的视觉默认宽度（用于 CSS fallback）
const DEFAULT_COL_WIDTHS: ColumnWidth[] = [
  COLUMN_AUTO, // 0: Graph — 自适应（严格对齐 vscode）
  COLUMN_AUTO, // 1: Description — 1fr 占满
  COLUMN_AUTO, // 2: Date
  COLUMN_AUTO, // 3: Author
  COLUMN_AUTO, // 4: Commit
];

/** 列的默认像素宽（拖动后变数字或双击恢复时用）—— vscode main.ts:1829-1841 defaultWidth */
const DEFAULT_COL_WIDTHS_PIXEL: Record<number, number> = {
  0: DEFAULT_GRAPH_COL_WIDTH, // Graph 双击恢复时用 300（vscode 无 Graph toggleColumnState，这个值仅作 fallback）
  2: 128, // Date
  3: 128, // Author
  4: 80, // Commit
};

/** vscode 实际列宽边界（user 指引：Graph [60, 715]，其他列 [40, ∞)）
 *  对应 vscode COLUMN_MIN_WIDTH=40 通用，但 Graph 列因为有 dot 渲染
 *  实际最小 60（v2.x 旧版也是 MIN_GRAPH_COL_WIDTH=56/60）
 *  Graph 最大 715 防止 lane 太多撑爆视口
 */
const MIN_GRAPH_COL_WIDTH = 60;
const MAX_GRAPH_COL_WIDTH = 715;

/** 列宽存储 key（v3.0 格式：number[]） */
const COLUMN_WIDTHS_V3_KEY = 'gitea-kanban:gitgraph:column-widths-v3';

function loadColumnWidths(): ColumnWidth[] {
  try {
    const stored = localStorage.getItem(COLUMN_WIDTHS_V3_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === 5) {
        return parsed.map((v: unknown, i: number): ColumnWidth => {
          if (v === COLUMN_HIDDEN || v === COLUMN_AUTO) return v;
          if (typeof v === 'number' && v >= COLUMN_MIN_WIDTH) return v;
          return DEFAULT_COL_WIDTHS[i]!;
        });
      }
    }
  } catch {
    /* 忽略 */
  }
  return [...DEFAULT_COL_WIDTHS];
}

const columnWidths = ref<ColumnWidth[]>(loadColumnWidths());

/** 持久化 columnWidths（vscode saveColumnWidths main.ts:739-741） */
function saveColumnWidths(): void {
  try {
    localStorage.setItem(COLUMN_WIDTHS_V3_KEY, JSON.stringify(columnWidths.value));
  } catch {
    /* 忽略 */
  }
}

/** col 是否可见（不是 HIDDEN） */
/** v3.5：拖动时优先读 colDragPreviewWidths */
function isColVisible(col: number): boolean {
  const widths = colDragPreviewWidths.value || columnWidths.value;
  return widths[col] !== COLUMN_HIDDEN;
}

/** 解析某列的实际 px 宽（AUTO 时取默认像素，HIDDEN 时 0，数字时用该数字）
 *  v3.5：拖动时优先读 colDragPreviewWidths，让 3/4/5 列拖动实时响应 */
function resolveColPx(col: number): number {
  const widths = colDragPreviewWidths.value || columnWidths.value;
  const w = widths[col];
  if (w === undefined || w === COLUMN_HIDDEN) return 0;
  if (w === COLUMN_AUTO) return DEFAULT_COL_WIDTHS_PIXEL[col] ?? 0;
  return w;
}

/**
 * v3.3：Graph 列实际像素宽（用于 grid-template-columns）
 *  严格对齐 vscode-git-graph main.ts:1730-1752 两种模式：
 *
 *  1. AUTO 模式（columnWidths[0] === COLUMN_AUTO）：
 *     - Graph 列宽度 = min(contentWidth, viewWidth * 0.333)
 *     - 对齐 vscode main.ts:1738 autoLayout 行为
 *
 *  2. Fixed 模式（columnWidths[0] 为数字）：
 *     - Graph 列宽度 = columnWidths[0]（用户拖动后的固定宽度）
 *     - 对齐 vscode main.ts:1731-1732 fixedLayout 行为
 *
 *  拖动时优先读 colDragPreviewWidths（实时响应）
 */
const graphColumnWidth = computed<number>(() => {
  // 拖动中优先用预览值
  const widths = colDragPreviewWidths.value || columnWidths.value;
  const w = widths[0];
  if (w === undefined || w === COLUMN_HIDDEN) return 0;

  if (w === COLUMN_AUTO) {
    // AUTO 模式：自适应 contentWidth，限制在 wrapperWidth * 0.333
    // v3.4：用 wrapperClientWidth 替代 window.innerWidth（对齐 vscode viewElem.clientWidth）
    const r = svgRender.value;
    if (!r) return DEFAULT_GRAPH_COL_WIDTH; // fallback（渲染前）
    const contentW = r.contentWidth;
    const maxW = Math.round(wrapperClientWidth.value * 0.333);
    return Math.min(contentW, maxW);
  }

  // Fixed 模式：用户拖动后的固定宽度
  return w;
});

/**
 * v3.3：SVG maxWidth 参数（传给 renderGraphVscode）
 *  严格对齐 vscode-git-graph graph.ts:677-700 + main.ts:1713, 1740, 1764
 *  vscode 调用 graph.limitMaxWidth() 时传的是"容器宽度"（= columnWidth + padding）
 *
 *  行为：
 *  - AUTO 模式：maxWidth = viewWidth * 0.333 + COLUMN_LEFT_RIGHT_PADDING
 *  - Fixed 模式：maxWidth = columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING
 *  - renderGraphVscode 内部会用 min(contentWidth, maxWidth) 渲染 SVG
 *
 *  拖动时优先读 colDragPreviewWidths（实时响应）
 */
const svgMaxWidth = computed<number>(() => {
  // 拖动中优先用预览值
  const widths = colDragPreviewWidths.value || columnWidths.value;
  const w = widths[0];

  if (w === COLUMN_AUTO) {
    // AUTO 模式：限制到 wrapperWidth * 0.333 + padding
    // v3.4：用 wrapperClientWidth 替代 window.innerWidth
    const maxW = Math.round(wrapperClientWidth.value * 0.333);
    return maxW + COLUMN_LEFT_RIGHT_PADDING;
  }

  if (typeof w === 'number' && w > 0) {
    // Fixed 模式：用户固定宽度 + padding
    return w + COLUMN_LEFT_RIGHT_PADDING;
  }

  return -1; // 不限制（理论上不会到达）
});

/** 5 列 grid-template-columns 字符串
 *  对齐 vscode CSS #commitTable td nth-child(2) / .dateCol / .authorCol
 *  - col 0: Graph —— graphColumnWidth + COLUMN_LEFT_RIGHT_PADDING (24px)
 *    （跟 .git-graph-bg 容器同宽，dot 视觉位置与 commit-row 第 0 列边界对齐）
 *  - col 1: Description —— minmax(40px, 1fr) 占满余下空间
 *  - col 2-4: Date/Author/Commit —— 数字（HIDDEN 时 0） */
const gridTemplateColumns = computed<string>(() => {
  const graph = graphColumnWidth.value + COLUMN_LEFT_RIGHT_PADDING;
  const desc = 'minmax(40px, 1fr)';
  const date = isColVisible(2) ? `${resolveColPx(2)}px` : '0';
  const author = isColVisible(3) ? `${resolveColPx(3)}px` : '0';
  const commit = isColVisible(4) ? `${resolveColPx(4)}px` : '0';
  return `${graph}px ${desc} ${date} ${author} ${commit}`;
});

/** Description 列最小宽度（minmax 下限） */
const MIN_DESC_COL_WIDTH = 40;

/** 表格最小宽度 = 5 列固定宽 + 12px 边距 */
const tableMinWidth = computed<number>(() => {
  return (
    (graphColumnWidth.value + COLUMN_LEFT_RIGHT_PADDING) +
    MIN_DESC_COL_WIDTH +
    (isColVisible(2) ? resolveColPx(2) : 0) +
    (isColVisible(3) ? resolveColPx(3) : 0) +
    (isColVisible(4) ? resolveColPx(4) : 0) +
    12
  );
});

// ============================================================
// v3.0：通用列宽拖动（vscode column resize 行为 1:1 复刻）
// - mousedown 缓存 startWidths + startX + header cell 引用
// - mousemove 更新 colDragPreviewWidths ref（纯数据驱动，Vue computed 自动响应）
// - mouseup 持久化到 ref + localStorage
// - 双击 handle：toggle HIDDEN ↔ AUTO/default（main.ts:1811-1815）
// ============================================================

type ColIndex = 0 | 1 | 2 | 3 | 4;

const colDragging = ref(false);
let colDragCol: ColIndex | null = null;
let colDragStartX = 0;
let colDragStartWidths: ColumnWidth[] | null = null;
let colDragFinalWidths: ColumnWidth[] | null = null;
let colDragRafId = 0;

/**
 * v3.4：拖动预览状态（纯数据驱动，触发 computed 重算）
 *  mousemove 期间更新此 ref，graphColumnWidth/svgMaxWidth/gridTemplateColumns
 *  computed 自动响应，无需手动操作 DOM
 */
const colDragPreviewWidths = ref<ColumnWidth[] | null>(null);

/**
 * v3.2：列宽 clamp —— 区分 Graph 列 vs 其他列
 *  Graph 列 [60, 715]（vscode 实际边界，user 指引）
 *  其他列 [40, ∞)（vscode COLUMN_MIN_WIDTH=40 通用下限，无上限）
 */
function clampColWidth(col: ColIndex, w: number): number {
  if (col === 0) {
    return Math.max(MIN_GRAPH_COL_WIDTH, Math.min(MAX_GRAPH_COL_WIDTH, w));
  }
  return Math.max(COLUMN_MIN_WIDTH, w);
}

/** 列分隔手柄 mousedown —— 通用 5 列拖动入口 */
function onColDragStart(col: ColIndex, e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  colDragging.value = true;
  colDragCol = col;
  colDragStartX = e.clientX;
  colDragStartWidths = [...columnWidths.value];
  // v3.4：纯数据驱动，不再缓存 DOM 引用（删除手动 style.width 写入）
  document.addEventListener('mousemove', onColDragMove);
  document.addEventListener('mouseup', onColDragEnd);
}

function onColDragMove(e: MouseEvent): void {
  if (
    !colDragging.value ||
    colDragCol === null ||
    !colDragStartWidths
  ) {
    return;
  }
  if (colDragRafId !== 0) return;
  colDragRafId = requestAnimationFrame(() => {
    colDragRafId = 0;
    if (
      !colDragging.value ||
      colDragCol === null ||
      !colDragStartWidths
    ) {
      return;
    }
    const col = colDragCol;
    const delta = e.clientX - colDragStartX;
    const startWidths = colDragStartWidths;

    if (col === 0) {
      // v3.5：拖 Graph 列 —— 纯数据驱动（对齐 vscode main.ts:1759-1764）
      //   Graph 列拖动只调 limitMaxWidth（SVG 坐标不变，释放/隐藏宽度）
      //   边界检查（对齐 vscode main.ts:1760-1761）：
      //   1. col 0 ≥ MIN_GRAPH_COL_WIDTH(60)
      //   2. col 1(Description) 剩余宽度 ≥ MIN_DESC_COL_WIDTH(40)
      //      → col 0 最大 = wrapperWidth - 其他列总宽 - MIN_DESC_COL_WIDTH
      const startW = startWidths[0]!;
      const baseW = startW === COLUMN_AUTO ? graphColumnWidth.value : startW;
      let newW = baseW + delta;
      // 下限：Graph 列最小 60px
      if (newW < MIN_GRAPH_COL_WIDTH) newW = MIN_GRAPH_COL_WIDTH;
      // 上限：Graph 列不能超过 MAX_GRAPH_COL_WIDTH(715)
      if (newW > MAX_GRAPH_COL_WIDTH) newW = MAX_GRAPH_COL_WIDTH;
      // 上限：Description 列(1fr)剩余空间 ≥ MIN_DESC_COL_WIDTH(40)
      //   wrapperWidth - graphCol(with padding) - 其他列总宽 - MIN_DESC_COL_WIDTH
      const otherColsWidth = resolveColPx(2) + resolveColPx(3) + resolveColPx(4);
      const maxByDesc = wrapperClientWidth.value - (newW + COLUMN_LEFT_RIGHT_PADDING) - otherColsWidth - MIN_DESC_COL_WIDTH;
      if (maxByDesc < newW) newW = Math.max(MIN_GRAPH_COL_WIDTH, maxByDesc);
      const next: ColumnWidth[] = [...startWidths];
      next[0] = newW;
      colDragFinalWidths = next;
      colDragPreviewWidths.value = next; // 实时更新，触发 computed 重算
      return;
    }

    if (col === 1) return; // Description 1fr 自动填满，vscode 也不响应拖动（main.ts:1772）

    // v3.4：拖 col 2/3/4 —— 纯数据驱动双列联动 (vscode main.ts:1765-1778)
    //   只更新 colDragPreviewWidths，让 gridTemplateColumns computed 自动响应
    //   删除手动 DOM style.width 写入（与 grid-template-columns CSS 冲突）
    const startW = startWidths[col]!;
    if (startW === COLUMN_HIDDEN) return; // 隐藏列不能拖
    const colWidth = startW === COLUMN_AUTO ? DEFAULT_COL_WIDTHS_PIXEL[col]! : startW;
    let nextCol = col + 1;
    while (nextCol < 5 && startWidths[nextCol] === COLUMN_HIDDEN) nextCol++;
    if (nextCol >= 5) return; // 没 nextCol 就不调整（理论 col 4 没有 nextCol，但保留）
    const nextStartW = startWidths[nextCol]!;
    const nextColWidth = nextStartW === COLUMN_AUTO ? DEFAULT_COL_WIDTHS_PIXEL[nextCol]! : nextStartW;
    // 边界：当前列 + delta ≥ COLUMN_MIN_WIDTH，nextCol - delta ≥ COLUMN_MIN_WIDTH
    let clampedDelta = delta;
    if (colWidth + clampedDelta < COLUMN_MIN_WIDTH) clampedDelta = COLUMN_MIN_WIDTH - colWidth;
    if (nextColWidth - clampedDelta < COLUMN_MIN_WIDTH) clampedDelta = nextColWidth - COLUMN_MIN_WIDTH;
    const newW = colWidth + clampedDelta;
    const newNextW = nextColWidth - clampedDelta;
    const next: ColumnWidth[] = [...startWidths];
    next[col] = newW;
    next[nextCol] = newNextW;
    colDragFinalWidths = next;
    colDragPreviewWidths.value = next; // 实时更新，触发 gridTemplateColumns 重算
  });
}

function onColDragEnd(): void {
  if (colDragRafId !== 0) {
    cancelAnimationFrame(colDragRafId);
    colDragRafId = 0;
  }
  if (colDragging.value && colDragFinalWidths) {
    columnWidths.value = colDragFinalWidths;
    saveColumnWidths();
  }
  colDragging.value = false;
  colDragCol = null;
  colDragStartWidths = null;
  colDragFinalWidths = null;
  colDragPreviewWidths.value = null; // v3.4：清除预览状态
  document.removeEventListener('mousemove', onColDragMove);
  document.removeEventListener('mouseup', onColDragEnd);
}

/** 双击 handle：toggle HIDDEN ↔ AUTO/default
 *  对齐 vscode main.ts:1811-1815 toggleColumnState */
function onColHandleDblClick(col: ColIndex, e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const current = columnWidths.value[col];
  const next: ColumnWidth[] = [...columnWidths.value];
  if (current === COLUMN_HIDDEN) {
    // 恢复：col 1 用 AUTO，col 0/2/3/4 用 defaultWidth
    next[col] = col === 1 ? COLUMN_AUTO : DEFAULT_COL_WIDTHS_PIXEL[col]!;
  } else {
    next[col] = COLUMN_HIDDEN;
  }
  columnWidths.value = next;
  saveColumnWidths();
}

/** 右键菜单状态：当前右键触发的列（null = 未触发） */
const contextMenuCol = ref<ColIndex | null>(null);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

/** 表头 contextmenu：打开列显隐菜单
 *  对齐 vscode main.ts:1808-1865（Date/Author/Commit 显隐） */
function onHeaderContextMenu(e: MouseEvent): void {
  e.preventDefault();
  contextMenuX.value = e.clientX;
  contextMenuY.value = e.clientY;
  const target = e.target as HTMLElement;
  const colAttr = target.closest('[data-col]')?.getAttribute('data-col');
  if (colAttr !== null && colAttr !== undefined) {
    contextMenuCol.value = Number(colAttr) as ColIndex;
  } else {
    contextMenuCol.value = null;
  }
}

/** 列显隐切换（vscode toggleColumnState main.ts:1811-1815） */
function toggleColumnVisibility(col: ColIndex): void {
  const current = columnWidths.value[col];
  const next: ColumnWidth[] = [...columnWidths.value];
  if (current === COLUMN_HIDDEN) {
    next[col] = col === 1 ? COLUMN_AUTO : DEFAULT_COL_WIDTHS_PIXEL[col]!;
  } else {
    next[col] = COLUMN_HIDDEN;
  }
  columnWidths.value = next;
  saveColumnWidths();
  contextMenuCol.value = null;
}

/** 全局点击关闭右键菜单 */
function onDocumentClickForContextMenu(e: MouseEvent): void {
  if (contextMenuCol.value === null) return;
  const target = e.target as HTMLElement | null;
  // 命中菜单内部 → 不关
  if (target?.closest('.git-graph-header__context-menu')) return;
  contextMenuCol.value = null;
}

// 注册/卸载全局点击监听（v3.0 phase 5）
onMounted(() => {
  document.addEventListener('mousedown', onDocumentClickForContextMenu);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentClickForContextMenu);
});

/** 生成 fallback avatar：取名字首字符 */
function avatarInitial(name: string): string {
  if (!name) return '?';
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : '?';
}

/** 基于名字生成稳定的背景色索引（0-15） */
function avatarColorIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 16;
}

/**
 * ref badge 类型判断（v2.8：用后端 refTypes 严格区分，不再启发式猜）
 *
 * 区分 branch / remoteBranch / tag 三大类，前端按类型给不同视觉样式。
 * Gitea 行为：tag 用浅灰底，branch 用绿底，remote branch 用蓝底。
 *
 * 后端 CommitInfo.RefTypes 与 Refs 一一对应：
 *   - "branch"      → 本地分支
 *   - "remoteBranch" → 远程跟踪分支
 *   - "tag"         → tag
 */
function refBadgeClass(refType?: string): string {
  switch (refType) {
    case 'tag':
      return 'ref-badge--tag';
    case 'remoteBranch':
      return 'ref-badge--remote';
    case 'branch':
    default:
      return 'ref-badge--branch';
  }
}
</script>

<template>
  <div class="timeline-new">
<div ref="heatmapStickyEl" class="timeline-new__heatmap-sticky">
      <!-- v0.7.6: 标题栏 + 热力图 同行紧凑布局 -->
      <header class="timeline-new__topbar">
        <div class="timeline-new__title">
          <GitCommit :size="16" />
          <span>Git Graph</span>
          <span v-if="activeRepo" class="timeline-new__repo-name">
            {{ activeRepo.fullName }}
            <span v-if="graphDto" class="timeline-new__commit-count">
              （{{ activeCommitCount }} 条）
            </span>
          </span>
          <span v-else class="timeline-new__repo-name muted">请选择仓库</span>
        </div>
        <div class="timeline-new__actions">
          <button
            class="sync-btn"
            :title="
              repo.clonedMap[`${activeRepo?.owner ?? ''}/${activeRepo?.name ?? ''}`] === true
                ? '拉取远端最新 commit 并回到列表开头'
                : '克隆仓库元信息到本地并回到列表开头（go-git 轻量模式）'"
            :disabled="loading || pulling || !activeProjectId"
            @click="goToLatest"
          >
            <RotateCw :size="15" :class="{ spinning: pulling }" />
            <span class="sync-btn__label">{{ goToLatestLabel }}</span>
          </button>
        </div>
      </header>
            <GitCommitHeatmap
              :commits="graphDto?.nodes ?? []"
              :months="12"
            />
          </div>

          <!-- Git Graph -->
        <!--
          v2.27：git-graph 整合为表格第一列 ...
          - 完全去掉 sticky / flex 两栏的复杂 z-index 体系
        -->

    <!-- ===== 主内容 ===== -->
    <div
      ref="mainScrollEl"
      class="timeline-new__main"
      :class="{ 'timeline-new__main--dragging': colDragging }"
    >
        <div v-if="!activeRepo" class="timeline-new__placeholder">
          <EmptyState title="请先选择一个仓库" />
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
            description="使用 go-git 轻量同步仓库元信息后，基于 commit DAG 渲染接近 Gitea 官方效果的 Git Graph。点下面按钮一键启用，克隆完成后下次进入此页面自动加载。"
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
          v-else
          class="git-graph-wrapper"
          :data-dragging="colDragging ? '' : null"
          :style="{
            '--grid-template-columns': gridTemplateColumns,
            '--git-graph-col-width': `${graphColumnWidth}px`,
            '--git-graph-table-width': `${tableMinWidth}px`,
          }"
        >
          <!--
            v3.0：5 列表头（对齐 vscode-git-graph web/main.ts:821-824）
            列顺序：Graph (col 0) / Description (col 1) / Date (col 2) / Author (col 3) / Commit (col 4)
            列名 UI 翻译（AGENTS §9.1 零术语）：
              - Graph → "Graph"（保留英文，vscode 也用这个）
              - Description → "描述"
              - Date → "日期"
              - Author → "作者"
              - Commit → "提交"（短 SHA 列，区分"提交 SHA"vs"提交内容"）
            每个 col 内嵌 2 个 .resizeCol left/right（vscode styles/main.css:280-294）：
              - left handle 改 col 自身宽度（AUTO 状态下变 HIDDEN/拖宽）
              - right handle 改 col+1 宽度（v3.0 暂用 left 模式，对齐 SourceTree 风格）
            双击 handle → toggle HIDDEN ↔ AUTO/default
            右键 header → 列显隐菜单（v3.0 暂未实现菜单 UI，placeholder）
          -->
          <div class="git-graph-header" @mousedown.stop @contextmenu="onHeaderContextMenu"> col 0: Graph -->
            <div class="git-graph-header__col git-graph-header__col--graph" data-col="0">
              <span class="git-graph-header__col-label">Graph</span>
              <div
                class="resizeCol"
                :class="{ 'resizeCol--active': colDragging && colDragCol === 0 }"
                @mousedown.stop="onColDragStart(0, $event)"
                @dblclick.stop="onColHandleDblClick(0, $event)"
                title="拖动调整 Graph 列宽度（双击隐藏/恢复）"
              />
            </div>
            <!-- col 1: Description -->
            <div class="git-graph-header__col git-graph-header__col--desc" data-col="1">
              描述
            </div>
            <!-- col 2: Date -->
            <div
              v-if="isColVisible(2)"
              class="git-graph-header__col git-graph-header__col--date"
              data-col="2"
            >
              日期
              <div
                class="resizeCol"
                :class="{ 'resizeCol--active': colDragging && colDragCol === 2 }"
                @mousedown.stop="onColDragStart(2, $event)"
                @dblclick.stop="onColHandleDblClick(2, $event)"
                title="拖动调整日期列宽度（双击隐藏/恢复）"
              />
            </div>
            <!-- col 3: Author -->
            <div
              v-if="isColVisible(3)"
              class="git-graph-header__col git-graph-header__col--author"
              data-col="3"
            >
              作者
              <div
                class="resizeCol"
                :class="{ 'resizeCol--active': colDragging && colDragCol === 3 }"
                @mousedown.stop="onColDragStart(3, $event)"
                @dblclick.stop="onColHandleDblClick(3, $event)"
                title="拖动调整作者列宽度（双击隐藏/恢复）"
              />
            </div>
            <!-- col 4: Commit -->
            <div
              v-if="isColVisible(4)"
              class="git-graph-header__col git-graph-header__col--sha"
              data-col="4"
            >
              提交
              <div
                class="resizeCol"
                :class="{ 'resizeCol--active': colDragging && colDragCol === 4 }"
                @mousedown.stop="onColDragStart(4, $event)"
                @dblclick.stop="onColHandleDblClick(4, $event)"
                title="拖动调整提交 SHA 列宽度（双击隐藏/恢复）"
              />
            </div>
          </div>

          <!--
            v0.x：本地 0 提交时空状态嵌入表内，渲染在表头下方的表体区中心。
            对齐 vscode-git-graph 在空仓库时把"无提交"提示画在表格内部的语义，
            替代之前把 .timeline-new__placeholder 放在 wrapper 外（即表格上方）
            的旧布局——用户视角下"表格里看不到任何记录"的体验更自然。
            wrapper 内部的 flex 居中 + min-height 撑出可见区域，EmptyState 走
            自带 padding/居中样式即可。
          -->
          <div v-if="activeCommitCount === 0" class="git-graph-empty">
            <EmptyState title="没有提交记录" />
          </div>

          <!-- v2.27：body 区（背景层 SVG + dot overlay + 行层 commit-row）
               v3.0：mask 渐变遮盖，对齐 vscode-git-graph Graph.applyMaxWidth (graph.ts:689-695)，
               SVG 内部完整渲染 contentWidth，外层 CSS mask 在
               (graphColumnWidth-12)px ~ graphColumnWidth px 区间 12px 渐变 fade，
               超出 graphColumnWidth 的 lane 视觉上消失
               （替代 v2.47 的 .git-graph-bg overflow-x: hidden 物理裁切）-->
          <!--
            v3.0：右键菜单浮层（vscode main.ts:1808-1865）
            - 在表头任意位置点右键 → 打开菜单，可 toggle Date/Author/Commit 列显隐
            - 全局 mousedown 监听关闭（onDocumentClickForContextMenu）
            - 用 fixed 定位 + z-index 高于 sticky header
          -->
          <div
            v-if="contextMenuCol !== null"
            class="git-graph-header__context-menu"
            :style="{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }"
            @click.stop
          >
            <button
              class="git-graph-header__context-menu-item"
              :class="{ 'git-graph-header__context-menu-item--checked': isColVisible(2) }"
              @click="toggleColumnVisibility(2)"
              type="button"
            >
              日期
            </button>
            <button
              class="git-graph-header__context-menu-item"
              :class="{ 'git-graph-header__context-menu-item--checked': isColVisible(3) }"
              @click="toggleColumnVisibility(3)"
              type="button"
            >
              作者
            </button>
            <button
              class="git-graph-header__context-menu-item"
              :class="{ 'git-graph-header__context-menu-item--checked': isColVisible(4) }"
              @click="toggleColumnVisibility(4)"
              type="button"
            >
              提交
            </button>
          </div>
          <!--
            v0.x：本地 0 提交时跳过 body 渲染（避免 0 height 的 SVG / 空 rows 容器
            抢视觉焦点），由上方的 .git-graph-empty 接管。
          -->
          <div
            v-if="activeCommitCount !== 0"
            class="git-graph-body"
            :style="{ minHeight: svgHeight }"
          >
            <!--
              v3.1：背景层视觉宽度 = graphColumnWidth + COLUMN_LEFT_RIGHT_PADDING (24px)
              对齐 vscode main.ts:1713 --limitGraphWidth = columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING
              (cell 视觉边距 24px，SVG 自身不占这个 padding)
              SVG :width 仍 = graphColumnWidth（vscode setSvgWidth 不加 padding，graph.ts:697-700）
            -->
            <div
              class="git-graph-bg"
              :style="{
                width: `${graphColumnWidth + COLUMN_LEFT_RIGHT_PADDING}px`,
                height: svgHeight,
              }"
            >
              <!-- v3.5：移除 viewBox（对齐 vscode-git-graph）
                vscode SVG 不用 viewBox，直接 width/height 像素属性，内部坐标 1:1 映射。
                之前 viewBox + width=min(contentWidth,maxWidth) 导致 maxWidth < contentWidth 时
                浏览器等比缩放整个图形（缩小+下移）。移除后坐标=像素，超出部分 overflow:hidden + mask fade -->
              <svg
                class="git-graph-svg"
                :class="{ 'git-graph-svg--fade': (svgRender?.contentWidth ?? 0) > (svgMaxWidth > 0 ? svgMaxWidth : graphColumnWidth) }"
                :width="svgWidth"
                :height="svgHeight"
              >
                  <!--
                    v2.65：渐变 fade 改用 CSS mask-image（在 .git-graph-svg 上），不再用 SVG <defs>+<mask>。
                    原因：v2.64 的 SVG mask + maskUnits=userSpaceOnUse + 默认 x=-10%/width=120% 在不同浏览器
                    （WebKit/WebView2/Chromium）行为不一致，少数情况下整图被 mask 全黑遮住不可见。
                    CSS mask-image 用 linear-gradient 在 SVG 元素像素坐标下渐变，浏览器一致性更好。
                    视觉等价：黑 0% → 黑 calc(100% - 12px) → 透明 100% = vscode-git-graph (maxWidth-12, maxWidth) 12px 渐变
                  -->

                  <g
                    v-for="pg in pathGroups"
                    :key="pg.id"
                    class="flow-group"
                    :class="[pg.colorClass, { 'flow-group--shadow': pg.kind === 'shadow' }]"
                    :data-color="pg.colorIndex"
                  >
                    <path
                      v-if="pg.d"
                      :d="pg.d"
                      :stroke="pg.kind === 'shadow'
                        ? 'var(--color-graph-bg, var(--color-shell-main-bg))'
                        : (pg.colorHex ?? '#888')"
                      :stroke-width="pg.kind === 'shadow' ? 4 : 2"
                      :stroke-opacity="pg.kind === 'shadow' ? 0.75 : 1"
                      :stroke-dasharray="pg.kind === 'shadow' ? undefined : pg.dasharray"
                      fill="none"
                      stroke-linecap="round"
                      vector-effect="non-scaling-stroke"
                    />
                  </g>
                  <g class="git-graph-vertices">
                    <template v-for="c in svgCircleNodes" :key="`dot-${c.sha}`">
                      <!-- v3.12：每个 dot 一个 <g> 容器，只包含 circle
                           - @mouseenter 写 --active-lane-color + 置 tooltipPending（100ms 后显示）
                           - @mouseleave 立即清 tooltipPending（mouse 到 tooltip 的几ms内不清 tooltip）
                             tooltip div 有 v-show，pending 时不清除，100ms 后显示
                           - foreignObject 不使用：Wails WebKit WebView 会把它渲染成可见元素 -->
                      <g
                        class="dot-hover-group"
                        @mouseenter="dotEnter($event, c)"
                        @mouseleave="dotLeave"
                      >
                        <circle
                          class="commit-vertex"
                          :class="{
                            'commit-vertex--head': c.isCurrent,
                            'commit-vertex--stash': c.isStash && !c.isCurrent,
                          }"
                          :cx="c.cx"
                          :cy="c.cy"
                          :r="c.r"
                          :fill="c.isCurrent ? 'transparent' : (c.colorHex ?? '#888')"
                          :stroke="c.isCommitted === false ? '#808080' : (c.isCurrent ? (c.colorHex ?? '#888') : 'rgba(30, 30, 30, 0.75)')"
                          :stroke-width="c.isCurrent ? 2 : 1"
                          :stroke-opacity="c.isCurrent ? 1 : 0.75"
                        >
                          <title>{{ c.title }}</title>
                        </circle>
                      </g>
                    </template>
                  </g>
                </svg>
            </div>

            <!-- v3.12：dot hover tooltip（普通 HTML div，在 .git-graph-body 内绝对定位）
                 v-show 控制显隐（不用 v-if，保持 DOM 存在，mouse 可达）
                 dotEnter → 100ms 后显示；dotLeave → 200ms 后隐藏
                 背景用 --tooltip-color（由 tooltipContent.colorHex 注入） -->
            <div
              class="git-graph-tooltip"
              v-show="tooltipVisible"
              :style="{
                top: tooltipY + 'px',
                left: tooltipX + 'px',
                '--tooltip-color': tooltipContent?.colorHex ?? '#888',
              }"
            >
              <div class="git-graph-tooltip__pointer"></div>
              <div class="git-graph-tooltip__content">
                <!-- 对齐 vscode graphTooltipTitle -->
                <div class="git-graph-tooltip__title">
                  提交 {{ tooltipContent?.shortSha ?? '' }}
                </div>
                <!-- 对齐 vscode "This commit is included in HEAD" -->
                <div v-if="tooltipContent?.includedInHead !== undefined" class="git-graph-tooltip__section">
                  <template v-if="tooltipContent?.includedInHead">
                    此提交包含在 <span class="git-graph-tooltip__ref">HEAD</span> 中
                  </template>
                  <template v-else>
                    此提交<strong><em>不</em></strong>包含在 <span class="git-graph-tooltip__ref">HEAD</span> 中
                  </template>
                </div>
                <!-- 对齐 vscode Branches / Tags sections -->
                <template v-for="section in tooltipContent?.sections ?? []" :key="section.label">
                  <div v-if="section.items.length > 0" class="git-graph-tooltip__section">
                    <span class="git-graph-tooltip__section-label">{{ section.label }}</span>
                    <span
                      v-for="(item, idx) in section.items"
                      :key="idx"
                      class="git-graph-tooltip__ref"
                      :class="{ 'git-graph-tooltip__ref--highlight': item.isRef }"
                    >{{ item.text }}</span>
                  </div>
                </template>
              </div>
            </div>

            <!-- 行层：每行 grid 5 列，第一列是 graph 占位让背景 SVG 透出
                 v2.47：用 .git-graph-rows 容器包住，flex: 1 + width: handleLeft + 内容列 -->
            <div
              class="git-graph-rows"
              :style="{
                '--git-graph-row-count': maxRowPlusOne,
                '--git-graph-row-height': ROW_H + 'px',
              }"
            >
            <template v-for="r in allRows" :key="`row-${r.row}`">
              <!-- v2.63 GitHub parser 修复：ASCII 路径的 allRows 已经按 displayRow 0..N-1
                   排好（edge 行已被压扁跳过），grid-template-rows = commit 数（不再有
                   "看不见的 30px 空行"被插入到 commit 行间）。
                   v-if="r.commit" 现在只是结构性兜底（理论 allRows 里 commit 永远非空），
                   保留以应对未来 parser 变化。-->
              <div
                v-if="r.commit"
                class="commit-row"
                :data-sha="r.commit.sha"
                :class="{
                  'commit-row--clickable': r.commit,
                  'commit-row--expanded': r.commit && expandedSha === r.commit.sha,
                  'commit-row--merge': r.commit.isMerge,
                  /* v3.0：vscode-git-graph 风格的 dot hover —— 该行 dot 被 hover 时，
                   * 整行 graph 列用 lane 色软底（CSS var --active-lane-color 来自 dot）*/
                  'commit-row--dot-active': r.commit && hoveredDotSha === r.commit.sha,
                }"
                :style="{
                  /* VSCode row model：第一行固定 ROW_H，展开面板作为第二行插入。
                   * 这样 commit 文字仍在 row*24+12 的中心，不会被展开高度挤到中间。 */
                  height: (r.commit && expandedSha === r.commit.sha
                    ? ROW_H + activeExpandY
                    : ROW_H) + 'px',
                  /* v3.13：绑定该 commit 所在 lane 的颜色，供 ref badge 和 dot stroke 使用。
                   * ref badge 的 border/text/icon fill 用它（不依赖 hover） */
                  '--row-lane-color': r.commit ? r.commit.colorHex : 'transparent',
                }"
                :role="r.commit ? 'button' : undefined"
                :tabindex="r.commit ? 0 : undefined"
                :aria-expanded="r.commit ? expandedSha === r.commit.sha : undefined"
                @click="r.commit && toggleCommitDetail(r.commit)"
                @mouseenter="hoveredGraphRow = r.commit ? r.row : null"
                @mouseleave="hoveredGraphRow = null"
                @keydown.enter.prevent="r.commit && toggleCommitDetail(r.commit)"
                @keydown.space.prevent="r.commit && toggleCommitDetail(r.commit)"
              >
                <!-- v3.4：恢复 graph 占位列（第一列，透明让 SVG 透出）
                     v2.48 曾移除它，但导致 commit-row 4 列 vs header 5 列错位。
                     现在统一 5 列，graph 占位列高度 = ROW_H，让背景 SVG dot 精确对齐每行。 -->
                <div class="commit-row__col commit-row__col--graph" aria-hidden="true"></div>
                <template v-if="r.commit">
                  <!-- col 1: Description 列（refs + subject） -->
                  <div class="commit-row__col commit-row__col--desc">
                    <!-- v2.8：refs + refTypes 由后端 LogCommits 附带（branch / remoteBranch / tag），
                         这里按类型渲染 badge 颜色，不再用启发式猜。 -->
                    <span v-if="r.commit.refs && r.commit.refs.length > 0" class="commit-refs">
                      <span
                        v-for="(ref, idx) in r.commit.refs"
                        :key="`ref-${r.commit.sha}-${ref}`"
                        class="ref-badge"
                        :class="refBadgeClass(r.commit.refTypes?.[idx])"
                        :title="ref"
                      >
                        <Tag
                          v-if="r.commit.refTypes?.[idx] === 'tag'"
                          :size="11"
                          class="ref-badge__icon"
                          aria-hidden="true"
                        />
                        <GitBranch
                          v-else
                          :size="11"
                          class="ref-badge__icon"
                          aria-hidden="true"
                        />
                        <span>{{ ref }}</span>
                      </span>
                    </span>
                    <span
                      class="commit-subject"
                      :class="{ 'commit-subject--uncommitted': r.commit.sha === '*' }"
                    >{{ r.commit.subject }}</span>
                  </div>
                  <!-- col 2: Date 列（v3.0：v-if 控制显隐） -->
                  <div
                    v-if="isColVisible(2)"
                    class="commit-row__col commit-row__col--date"
                    data-col="2"
                  >
                    <!-- v3.8：日期列固定展示 authorDate 相对时间（用户电脑时区）
                         - r.commit.date = go-git commit.Author.When = author time（含作者时区 ISO 8601）
                         - 显示：formatRelative（"12m前"/"5天前"等固定相对时间）
                         - title：formatAbsolute（用户电脑时区的完整绝对时间，hover 看） -->
                    <span class="commit-time" :title="formatAbsolute(r.commit.date)">{{ formatRelative(r.commit.date) }}</span>
                  </div>
                  <!-- col 3: Author 列 -->
                  <div
                    v-if="isColVisible(3)"
                    class="commit-row__col commit-row__col--author"
                    data-col="3"
                  >
                    <span
                      class="commit-avatar-fallback"
                      :class="`flow-color-16-${avatarColorIndex(r.commit.authorName)}`"
                      aria-hidden="true"
                    >{{ avatarInitial(r.commit.authorName) }}</span>
                    <span class="commit-author">{{ r.commit.authorName }}</span>
                  </div>
                  <!-- col 4: Commit（短 SHA）列 -->
                  <div
                    v-if="isColVisible(4)"
                    class="commit-row__col commit-row__col--sha"
                    data-col="4"
                  >
                    <span class="commit-sha">{{ r.commit.shortSha }}</span>
                  </div>
                </template>
                <template v-else>
                  <!-- 关系占位行（merge edge 中间段）—— 4 个空 col 占位 -->
                  <div class="commit-row__col commit-row__col--desc" />
                  <div
                    v-if="isColVisible(2)"
                    class="commit-row__col commit-row__col--date"
                    data-col="2"
                  />
                  <div
                    v-if="isColVisible(3)"
                    class="commit-row__col commit-row__col--author"
                    data-col="3"
                  />
                  <div
                    v-if="isColVisible(4)"
                    class="commit-row__col commit-row__col--sha"
                    data-col="4"
                  />
                </template>
                <!-- v2.14：行下手风琴 —— v2.66 改为嵌入 commit-row 内部：
                     让 .commit-row:hover 选择器能覆盖到 accordion 区域，
                     鼠标移到展开面板时 row hover 高亮不中断（用户反馈 hover 高度不对齐）。
                     row 高度已并入 accordion 高度（见上方 :style.height）。-->
                <div
                  v-if="r.commit && expandedSha === r.commit.sha"
                  :ref="(el) => { if (el) bindAccordionObserver(el as HTMLElement) }"
                  class="commit-accordion"
                  :data-sha="r.commit.sha"
                  @click.stop
                >
                  <CommitDetailPanel
                    v-if="expandedCommitNode && expandedCommitNode.sha === r.commit.sha"
                    :commit="buildBasicCommit(r.commit)"
                    :project-id="activeProjectId"
                    :platform="currentPlatform"
                    :gitea-repo-url="giteaRepoUrl"
                    variant="panel"
                  />
                </div>
              </div>
            </template>
            </div><!-- /.git-graph-rows -->

            <!-- v0.6.1+ Git Graph 滚动加载更多哨兵（idle 时占位保持高度让 IntersectionObserver 可检测） -->
            <div
              v-if="!allLoaded && graphDto && !localExhausted"
              ref="loadMoreSentinel"
              class="git-graph-load-more-sentinel"
              aria-hidden="true"
            ></div>
            <!-- v0.6.2: 本地 commit 已全部取出，后台 deepen 进行中 -->
            <div
              v-if="localExhausted && graphDto"
              class="git-graph-load-more git-graph-load-more-deepen"
              role="status"
              aria-live="polite"
            >
              <span class="git-graph-load-more-spinner" aria-hidden="true"></span>
              <span>{{ deepenInProgress ? '正在深化本地历史…' : '本地历史已加载完' }}</span>
            </div>
            <!-- 加载中文字（与 StatusBarPulse 动效同步显示/隐藏，由 globalLoading 控制） -->
            <div
              v-if="showLoadMoreStatus"
              class="git-graph-load-more"
              :class="gitGraphLoadMoreClass"
              role="status"
              aria-live="polite"
            >
              <!--
                v0.7.0：内容切换 Q弹动画（loading → end）
                - Vue Transition + mode="out-in"，旧内容先 180ms fade out，新内容 380ms easeOutBack 弹入
                - c1=1.55 easeOutBack ≈ 10% 过冲后回落，Q弹柔和但不夸张
                - 状态 class 同时在父级 .git-graph-load-more 上，CSS 也能用 :class 触发样式
              -->
              <Transition name="git-graph-load-more-flip" mode="out-in">
                <div
                  v-if="gitGraphLoadMoreClass === 'git-graph-load-more-loading'"
                  key="loading"
                  class="git-graph-load-more__inner"
                >
                  <span class="git-graph-load-more-spinner" aria-hidden="true"></span>
                  <span>正在加载更多提交记录…</span>
                </div>
                <div v-else key="end" class="git-graph-load-more__inner">
                  <span class="git-graph-load-more-divider" aria-hidden="true"></span>
                  <span>已到全部提交记录的末尾</span>
                  <span class="git-graph-load-more-divider" aria-hidden="true"></span>
                </div>
              </Transition>
            </div>
          </div>
        </div><!-- /git-graph-wrapper -->
    </div><!-- /timeline-new__main -->
  </div>
</template>

<style scoped>
.timeline-new {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* v0.6.1+ Git Graph 滚动加载更多（与 MergesView 风格统一） */
.git-graph-load-more {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: var(--space-4) 0;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-height: 56px;
  list-style: none;
  flex-shrink: 0;
  width: 100%;
  text-align: center;
  transition: opacity var(--t-base) var(--ease);
}
/*
 * v0.7.0：内层 flex 容器，让 Transition 子元素参与 flex 布局
 * - 旧版直接挂 spinner/divider/text，会被外层 flex 的 gap 拉扯
 * - 内层 inline-flex 让 loading 状态（spinner+text）和 end 状态（divider+text+divider）
 *   各自紧凑成块，Q弹动画 transform 时不影响外层布局
 */
.git-graph-load-more__inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.git-graph-load-more-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.git-graph-load-more-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2.5px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: git-graph-load-more-spin 0.7s linear infinite;
}
.git-graph-load-more-idle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  animation: git-graph-load-more-idle-breath 2s ease-in-out infinite;
}
.git-graph-load-more-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-divider);
  border-radius: 50%;
  font-size: 12px;
  color: var(--color-text-muted);
}
.git-graph-load-more-end {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-style: normal;
  font-size: var(--font-xs);
}
.git-graph-load-more-divider {
  flex: 0 0 24px;
  height: 1px;
  background: var(--color-divider);
}
/* v0.6.5：哨兵占位必须保持高度让 IntersectionObserver 能触发。
   之前没写 CSS → div 0px 高 → 永远不被触发 → 滚到底加载不了更多 commit。
   对齐 MergesView .merges__load-more min-height: 56px */
.git-graph-load-more-sentinel {
  flex: 0 0 auto;
  width: 100%;
  min-height: 56px;
}
@keyframes git-graph-load-more-spin {
  to { transform: rotate(360deg); }
}
@keyframes git-graph-load-more-idle-breath {
  0%, 100% { opacity: 0.55; transform: translateY(0); }
  50% { opacity: 0.9; transform: translateY(2px); }
}

/*
 * v0.7.0：内容切换 Q弹动画（mode="out-in"）
 * - 旧内容 180ms ease-out 上移淡出
 * - 新内容 380ms easeOutBack 弹入：6px 下移 + 0.92 scale 起手，过冲到 1.04 scale + -2px 上移，落到原位
 * - easeOutBack 公式：1 + c3 * (t-1)^3 + c1 * (t-1)^2，c1=1.55 → ~10% 过冲后回落
 * - 避免与外层 .git-graph-load-more 上 padding/min-height 冲突：transform 只动 inner 自身
 */
.git-graph-load-more-flip-leave-active {
  animation: git-graph-load-more-flip-out 180ms ease-out;
}
.git-graph-load-more-flip-enter-active {
  animation: git-graph-load-more-flip-in 380ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes git-graph-load-more-flip-out {
  to {
    opacity: 0;
    transform: translateY(-4px);
  }
}
@keyframes git-graph-load-more-flip-in {
  0% {
    opacity: 0;
    transform: translateY(6px) scale(0.92);
  }
  60% {
    opacity: 1;
    transform: translateY(-2px) scale(1.04);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* v0.7.6: topbar 在 heatmap-sticky 内部，左边标题右边按钮 */
.timeline-new__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding: var(--space-2, 8px) var(--space-4, 16px);
  background: var(--color-bg, var(--color-canvas));
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
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex-wrap: wrap;
}
.timeline-new__repo-name.muted {
  color: var(--color-text-disabled);
}
/* v0.7.2：commit 数量 badge，紧随仓库名之后弱化显示 */
.timeline-new__commit-count {
  color: var(--color-text-disabled);
  font-weight: 400;
  font-size: var(--font-xs);
  white-space: nowrap;
}
.timeline-new__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  margin-left: auto;
}

/*
 * v0.7.4：提交热力图 sticky 顶部（不参与纵向滚动）+ 横向铺开。
 *  - position: sticky; top: 0 贴在 main 滚动容器顶部，热力图自身不滚动
 *  - 宽 100% 不限 max-width，横向跟随容器铺开
 *  - overflow-x: auto 让数据极多时内部横向滚动（绝不影响外层纵向滚动）
 *  - background 跟主区画布同色，避免 sticky 跟下方 commit 行视觉脱节
 */
.timeline-new__heatmap-sticky {
  position: sticky;
  top: 0;
  z-index: 6;
  width: 100%;
  background: var(--color-bg, var(--color-canvas));
  padding: 0; /* v0.7.6: topbar 自带 padding */
  overflow: hidden;
  flex-shrink: 0;
  /* v0.7.6: 让 topbar 和 heatmap 在同一视觉行 */
  display: flex;
  flex-direction: column;
}

/* v0.7.6: .git-graph-header 不再需要 sticky 规则 */

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

/* ===== Sync 按钮（v2.x：拉取按钮改为同步，跟 StatusBar 一致）===== */
.sync-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-sm, 13px);
  cursor: pointer;
  transition: all 0.15s;
}
.sync-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.sync-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sync-btn__label {
  font-size: var(--font-xs, 11px);
}

/* ===== Git Graph Wrapper ===== */
/* ===== v2.27 Git Graph Wrapper（git-graph 整合为表格第一列）=====
 * 单栏布局：
 *   - header: 5 列 grid（graph + 描述/作者/日期/SHA）
 *   - body: position: relative 包含背景层 (git-graph-bg) 和 行层 (commit-row)
 *   - 背景层 SVG + dot overlay 绝对定位在 body 左上角，z-index: 0
 *   - 行层 commit-row 透明背景，让 SVG 透出；第一列是 graph 占位
 * 不再用 flex 两栏 + sticky，避免 v2.18~v2.26 的 z-index 互相干扰
 *
 * v2.0 宽度语义：
 *   - wrapper width = 100% 父容器（不被内部内容撑开）
 *   - 不再用 width: max-content —— 旧逻辑下 commit-row 长内容会撑大 wrapper
 *   - 表格最小宽度走 header / commit-row 的 min-width（窗口极窄时 header 出横向滚动）
 *   - 展开 commit-accordion 时手风琴宽度 = wrapper 宽度 - graph 列宽 - 4px，
 *     不会再撑大 wrapper（手风琴自身 max-width 锁住）
 *   - panel body 内部 panel 4:6 grid 各自 overflow-x: auto，长 message/file 横向滚动
 */
.git-graph-wrapper {
  position: relative;
  min-height: 1px;
  display: block;
  width: 100%;
  /* v3.5：overflow: visible —— 让 .git-graph-header 的 position:sticky 相对于
   *   .timeline-new__main（overflow:auto）生效，表头固定不随纵向滚动。
   *   之前 overflow-x:auto 让 wrapper 成为 sticky 的滚动祖先，但 wrapper 纵向不滚动，
   *   导致 header sticky 失效。横向溢出改由 .timeline-new__main(overflow:auto) 处理。 */
  overflow: visible;
}

/* v1.7 性能优化：拖拽时布局隔离
 *
 * `contain: layout` 把 wrapper 内部 reflow 隔离，不触发外层 timeline-new__main / topbar 等
 * 元素 reflow。配合 mousemove rAF 节流，1000 行 commit-row 拖拽流畅。
 *
 * 选型：`contain: layout` 而非 `contain: strict` —— strict 会把 paint 也隔离，
 * 但我们拖拽时表头位置、handle 位置都需要 paint 同步更新。*/
.git-graph-wrapper[data-dragging] {
  contain: layout;
  /* `contain: layout` 默认不创建层叠上下文，但拖拽时仍然需要避免与外层复合 —— 加一个
     isolation: isolate 让 wrapper 形成独立合成层，浏览器可以 GPU 加速 wrapper 内部绘制。*/
  isolation: isolate;
}

/* 表头（5 列 grid，对齐 vscode-git-graph web/main.ts:821-824）
 *
 * v3.0：5 列 = Graph (col 0) / Description (col 1) / Date (col 2) / Author (col 3) / Commit (col 4)
 *   - col 0: var(--git-graph-col-width) —— graphColumnWidth
 *   - col 1: minmax(40px, 1fr) —— Description
 *   - col 2/3/4: 固定 px（来自 --grid-template-columns CSS 变量，inline 注入）
 *   - Date/Author/Commit 列 HIDDEN 时 = 0（v-if 不渲染）
 */
.git-graph-header {
  display: grid;
  /* v3.4：5 列统一（gridTemplateColumns 已含 graph 列，不再额外加 --git-graph-col-width）
   *   之前 var(--git-graph-col-width) var(--grid-template-columns) = 6 列，与 commit-row 5 列不匹配 */
  grid-template-columns: var(--grid-template-columns, 96px 1fr 128px 128px 80px);
  align-items: center;
  height: 32px;
  background: var(--color-shell-main-bg);
  border-bottom: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  border-top: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  user-select: none;
  padding-right: var(--space-3, 12px);
  box-sizing: border-box;
  position: sticky;
  /* top 由 .git-graph-header 独立块用 var(--heatmap-sticky-height) 接管（v0.7.4） */
}
.git-graph-header__col {
  padding: 0 var(--space-3, 12px);
  /* v3.5：overflow: visible —— 让 resize handle(right:-3px) 不被裁剪
   *   之前 overflow:hidden 裁剪了 handle 超出 col 右边缘的 3px，导致可点击区域只有 3px
   *   header 文字（"Graph"/"描述"/"日期"/"作者"/"提交"）都很短，不需要 ellipsis 截断 */
  overflow: visible;
  box-sizing: border-box;
  white-space: nowrap;
  text-align: center;
  min-width: 0;
  position: relative;
}
.git-graph-header__col--graph {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: var(--space-2, 8px);
  padding-right: var(--space-2, 8px);
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  background: var(--color-shell-main-bg);
}
.git-graph-header__col--graph .git-graph-header__col-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-disabled);
  letter-spacing: 0.05em;
}
.git-graph-header__col--desc {
  padding-left: 0;
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.git-graph-header__col--author {
  padding-left: var(--space-2, 8px);
  /* v2.29：author 列右侧纵向分隔线 */
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.git-graph-header__col--date {
  padding: 0 var(--space-2, 8px);
  /* v2.29：date 列右侧纵向分隔线（sha 是最后一列不加） */
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.git-graph-header__col--sha {
  padding: 0 var(--space-2, 8px);
}
/* v3.0：resize handle（vscode-git-graph web/styles/main.css:280-294 .resizeCol 1:1 复刻）
 *   - position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize
 *   - 嵌在 .git-graph-header__col 内（col 自身 position: relative）
 *   - 紧贴列右边缘（命中区 6px 跨列右边线 ±3px）
 *   - hover/active 时显示高亮 1px 主色竖线 + soft 背景
 *   - mousedown 触发 onColDragStart(col, e) 调对应列宽
 *   - dblclick 触发 onColHandleDblClick(col, e) toggle HIDDEN ↔ AUTO
 */
.resizeCol {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 6;
  background: transparent;
  transition: background 0.12s;
}
.resizeCol:hover,
.resizeCol--active {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.12));
}
.resizeCol:hover::before,
.resizeCol--active::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 16px;
  background: var(--color-primary, #74b830);
  border-radius: 1px;
}
/* v2.47：body 容器（包含背景层 SVG + 行层 commit-row）
 *
 * 之前 layout：body 是 block + relative，bg 是 absolute + left:0，commit-row 是普通 flow。
 *   问题：多 lane 仓库（svgWidth > handleLeft）下，bg 撑出 commit-row 第一列范围，
 *         圆点散落到 desc/author 列上方（视觉错乱）。
 *
 * 新 layout：body 是 flex + relative，bg 和 commit-rows 容器并列。
 *   - bg (flex-shrink:0 + position:sticky left:0 + overflow-x:auto)：保持 SVG 完整宽度，
 *     多 lane 时内部横向滚动，不影响 commit-row 布局
 *   - commit-rows (flex:1 + width: handleLeft + 内容列)：固定宽度，跟 SVG 横向滚动解耦
 *   - wrapper 不再因为 commit-row min-width 撑出横向滚动条
 */
.git-graph-body {
  /* v3.4：block 布局（bg 改 absolute 后不需要 flex，rows 自然占满宽度）
   *   - position: relative —— bg absolute 的定位上下文
   *   - display: block —— rows 容器占满 body 宽度
   *   - 之前 display: flex 是为了 bg(sticky) + rows 并列，现在 bg absolute 脱离文档流 */
  position: relative;
  display: block;
  min-height: var(--git-graph-row-height, 24px);
}

/* v0.x：本仓库本地 0 提交时把空状态画在表格内部（表头下方的表体区）。
 *
 * 替代之前 .timeline-new__placeholder(height: 300px) 放在 .git-graph-wrapper
 * 之外的旧位置——空状态和表格头/底纹分离感太强，用户视角下更像是「整页空了」。
 * 移到 wrapper 内部 + 表头之后后，视觉重心自然落在表体中心，
 * 配合 EmptyState 自带 padding/flex 居中即可（不需要再写一套 placeholder 高度）。
 *
 * min-height 320px：与原 .timeline-new__placeholder 的视觉占比接近，
 * 在中小窗口下空状态不会被挤到表头边缘位置。 */
.git-graph-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  padding: var(--space-5, 20px) var(--space-5, 20px);
}

/* 背景层：SVG + dot overlay，整张铺在 body 左上角
 *
 * z-index 高于 commit-row，但 pointer-events:none；这样 graph 线和圆点不会被 row hover
 * 背景盖住，鼠标事件仍由 commit-row 接收。
 *
 * v1.7 性能优化：`content-visibility: auto` 让屏幕外 SVG 区域不渲染——
 * SVG 含 1000+ path 时浏览器 paint 成本极高。viewport 不可见区域的 path 完全跳过。
 * v2.40：contain-intrinsic-size 28 → 30，与 commit-row / SVG ROW_HEIGHT 同步。
 *
 * v2.47 改造 (GitHub 风格)：
 *   - 改 `position: absolute` → `position: sticky; top: 0; left: 0`
 *   - 视觉宽度 = handleLeft（不再 = svgWidth，避免 200 lane 把 bg 容器撑成 2014px）
 *   - 内部 .git-graph-bg-scroll 装 SVG + dots，min-width: svgWidth（让 SVG 完整渲染）
 *   - overflow: hidden 真实裁剪 absolute 子元素（让 bgScroll 不超出 bg 容器视觉边界）
 *   - 配合 .git-graph-body 的 `display: flex` 让 commit-rows 容器和 bg 容器并列
 *     → 多 lane 时 bg 容器内部横向滚动，commit-rows 容器固定宽度（不再撑大 wrapper）*/
.git-graph-bg {
  /* v3.4：SVG 绝对定位覆盖 body 顶部（对齐 vscode SVG 覆盖整个表格）
   *   - position: absolute; top: 0; left: 0 —— SVG 原点在 body 顶部
   *   - offsetY = gridY/2，第一行 dot 落在第一个 commit-row 中心
   *   - 之前 position: sticky 会在滚动时偏移，导致 dot 与 row 错位 */
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  background: var(--color-graph-bg, var(--color-shell-main-bg));
  pointer-events: none;
  /* v0.7.4：移除 content-visibility: auto + contain-intrinsic-size，根因同 .commit-row。
   * SVG 跳过屏外渲染后重新实例化时闪烁，滚动时 lane 圆点也出空白。 */
  overflow: visible;
  flex: 0 0 auto;
  display: block;
}

/* v2.66：删除 .git-graph-bg-scroll 中间层——v2.65 的 root cause。
   旧容器 position:absolute + inline style 只设 height → auto width = 0 → SVG 0 宽。
   现在 SVG 直接在 .git-graph-bg 内部，width 由 SVG :width=handleLeft 显式控制。 */

/* v2.65：渐变 fade 改用 CSS mask-image
 *   - 默认无 mask（少量 lane 时 graph 完整显示，无渐变）
 *   - 加 .git-graph-svg--fade 时启用 mask-image：
 *       黑 0% → 黑 calc(100% - 12px) → 透明 100%
 *     等价于 vscode-git-graph (maxWidth-12, maxWidth) 12px 渐变 (graph.ts:689-695)
 *   - mask-image 在 SVG 元素自身像素坐标下渐变，跟 :width 走
 *   - WebKit 前缀兼容 Wails 的 macOS WebKit WebView
 *   - 触发条件：contentWidth > handleLeft（多 lane 场景），
 *     少量 lane 时不加 class，避免误把无渐变的 lane fade 掉
 *   - 12px 渐变落在 SVG 视口最后 12px（handleLeft 实际像素），
 *     对应 viewBox 内部坐标 (contentWidth - 12*contentWidth/handleLeft) .. contentWidth
 */
.git-graph-svg {
  display: block;
  background: var(--color-graph-bg, var(--color-shell-main-bg));
  /* v3.5：overflow:hidden 裁剪超出 width 的 path（对齐 vscode SVG 默认行为）
   *   CSS mask-image 再做渐变 fade（vscode 用 SVG <mask>，等价效果） */
  overflow: hidden;
}
.git-graph-svg--fade {
  -webkit-mask-image: linear-gradient(
    to right,
    black 0%,
    black calc(100% - 12px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    black 0%,
    black calc(100% - 12px),
    transparent 100%
  );
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}

.git-graph-vertices {
  pointer-events: none;
}

.dot-hover-group {
  /* 关键：.git-graph-vertices 有 pointer-events:none，
   * 这里必须显式加回来，否则 dot hover 事件被吞掉 */
  pointer-events: auto;
}
.commit-vertex {
  vector-effect: non-scaling-stroke;
  transition: all 120ms ease;
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

/* v2.47：rows 容器（包住所有 commit-row + accordion，flex 右子项）
 *   - flex: 1 占据剩余空间（跟 bg 容器并排）
 *   - min-width: 0 允许内容收缩（默认 flex item 不会收缩到 min-content 以下）
 *   - overflow: visible 让手风琴展开时自然延伸（手风琴自身 max-width 兜底）
 *
 * v2.65：去掉 display: grid（v2.62 引入）和 grid-template-rows（commit-row grid-row 定位）。
 * 原因：v2.62 的 grid 是为了"edge 行 30px 占位"——但 v2.63 已经把 edge 行完全压扁，
 * 每个 commit-row 都对应一个 commit，不再有空 cell 留给 accordion。
 * 改成普通 block 流式：每个 commit-row 是 30px 块，accordion（手风琴展开时）紧跟其后
 * 自然撑高 rows 容器高度 → SVG 用 rowOffsets 自动同步延伸。
 *
 * 不再用 grid 后：commit-row 不再需要 :style="gridRow: r.row+1"，
 * 改为固定 height: ROW_H，row 顺序由 v-for 自然保证。*/
.git-graph-rows {
  /* v3.4：占满 body 宽度（block 布局，不再 flex:1） */
  width: 100%;
  min-width: 0;
  overflow: visible;
  display: block;
  position: relative;
  z-index: 1;
}


/* Commit 列表（v2.16 SourceTree 风格：浮在 SVG 上方盖板）
 * - position: sticky top:0（跟 SVG area 一起 sticky 跟随垂直滚动，保持圆点和 commit 文字对齐）
 /* v2.24：commit list 在右侧（彻底排查 git-graph 看不到问题）
 *  v2.23 之前问题：position: sticky + z-index: 2 + will-change: transform + transform
 *  全部创建独立 stacking context，list 整体在 svg-area 上面
 *  list 视觉位置 125-1000px（flex: 1 子元素），**应该**不影响 SVG 0-125
 *  实际看不到 SVG 可能是：
 *  - list sticky top:0 触发后顶部 = 屏幕 0px + list 整体 z:2 stacking 覆盖 svg-area
 *  - list 内部 header 840px 溢出 list 容器 875px，header 视觉位置 125-965
 *  - 多个 z-index 互相干扰
/* v2.27：.git-graph-list 已删除（合并到 .git-graph-body）
 * 旧规则保留注释供 git blame 参考 */

/* v2.28：移除 v2.23 旧 .git-graph-header / __col / __resize 规则残留
 * 旧规则定义在 line 1674-1738，grid-template-columns 是 4 列 (480/160/120/80)
 * 没 'auto' 前缀 → 表头没有 graph 占位列 → SHA 被挤到第二行（用户反馈）
 * 当前 v2.27 规则在 line 1407-1465 已是 5 列 (auto + 4 个内容列)
 * 旧 .git-graph-header__resize 规则也保留（v2.27 复用，行为一致） */

/* Commit 列表行 v2.27：5 列 grid（graph + 描述/作者/日期/SHA）
 *  - 第一列是 graph 占位（与表头第一列同宽，背景透出让 SVG 显示）
 *  - 后 4 列用 --grid-template-columns（4 个内容列） */
/* 每行 commit（与 SVG 行高 1:1 对齐，dot 圆心才能与 commit 文字对齐）
 * v1.6 策略：保持单行固定高度 → 分支名完整显示 + 提交信息省略号兜底
 * 这样 SVG 点位永远与 commit 行对齐，不会因换行错位
 * v2.22：display: grid + grid-template-columns（来自 .git-graph-wrapper 的 --grid-template-columns 变量）
 * v2.27：加第一列 graph 占位（auto 宽度，与表头 graph 列同宽）
 * v1.7：加 `content-visibility: auto` 让屏幕外 commit-row 不参与渲染——
 *   1000 行 commit 时，viewport 通常只显示 25 行，剩余 975 行彻底不渲染，
 *   滚动时浏览器按需渲染，滚动 fps 从 30 提到 60。
 *   contain-intrinsic-size 告诉浏览器每行预估高度（= ROW_HEIGHT = 26px），
 *   保证滚动条比例正确（不会因内容不可见突然"弹跳"）。
 *   `contain: layout` 同时把布局重算隔离在此 row 内——拖拽时 1000 行重排也只影响此 row。
 *
 * v2.47：min-width 改成 handleLeft + 4 内容列固定宽，不再依赖 var(--git-graph-table-width)
 *   （之前 .git-graph-table-width = svgWidth + 840 → 撑爆视口）*/
.commit-row {
  display: grid;
  /* v3.4：5 列统一（跟 header 一致，第一列是 graph 占位，透明让 SVG 透出）
   *   gridTemplateColumns = graphPx 1fr datePx authorPx commitPx
   *   之前 v2.48 移除了 graph 占位列导致 commit-row 4 列 vs header 5/6 列错位 */
  grid-template-columns: var(--grid-template-columns, 96px 1fr 128px 128px 80px);
  grid-template-rows: var(--git-graph-row-height, 24px) auto;
  align-items: stretch;
  gap: 0;
  /* VSCode row model：commit line 固定 24px；dot cy = row*24+12。 */
  height: 24px; /* fallback（被 inline style 覆盖） */
  /* v2.31 revert：恢复 v2.27 的"行透明 + 内容列自身背景"机制
     用户原意："只需要表头是非透明的背景即可"——表头 .git-graph-header 使用实色主内容背景，
     内容区 .commit-row 仍保持透明 + 4 个内容列各自用 var(--color-shell-main-bg) 遮罩 SVG 路径 */
  background: transparent;
  padding: 0 var(--space-3, 12px) 0 0;
  /*
   * v0.7.2：scroll-margin-bottom —— 让 scrollIntoView({ block: 'end' }) 留出 StatusBar 高度空间
   * 问题：loadMoreGraph 调 scrollIntoView({ block: 'end' }) 后，最后一行贴到视口底部 = StatusBar 顶，
   *   被 StatusBar 遮挡，用户需手动再滚一下，这个额外滚动会再次触发 IntersectionObserver → loadMoreGraph，
   *   loadingMore guard 拦了重复调用，但整体体验割裂（抖动 + 哨兵再次探测）。
   * 解法：scroll-margin-bottom = StatusBar 高度（--statusbar-height: 33px）+ 8px 余量。
   *   scrollIntoView 会把目标元素底边对齐到「视口底边 - scroll-margin-bottom」位置，
   *   从而把最后一行完整暴露在 StatusBar 上方，用户不再需要手动补滚。
   */
  scroll-margin-bottom: calc(var(--statusbar-height, 33px) + 8px);
  /* v2.0：去掉 min-width: 920px —— 让行宽度跟 wrapper 走，wrapper 已 width:100%，
   * 行不再有"最小 920px 撑大"行为。超长内容（长 ref badge / 长 author 名）
   * 走 .commit-row__col 的 overflow:hidden + ellipsis 截断，不撑列宽。*/
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: var(--git-graph-row-height, 24px);
  color: var(--color-text);
  white-space: nowrap;
  /* v2.66：去掉 overflow: hidden —— 嵌入 .commit-accordion 后需要让它溢出显示。
   * desc/author/date/sha 列的 ellipsis 由各 .commit-row__col 自身 overflow:hidden 兜底。*/
  overflow: visible;
  /* v2.28：移除 commit-row 的 border-bottom（用户：下方的内容区，暂时不用 1px 的表格线） */
  border-bottom: none;
  box-sizing: border-box;
  position: relative; /* 自身建立 stacking context，让 col 内容在 SVG 之上 */
  z-index: 1;
  /* v0.7.4：移除 content-visibility: auto + contain-intrinsic-size。
   * 根因：content-visibility: auto 让浏览器跳过屏外 commit-row 的渲染，
   * 快速滚动时新滚入区域的 DOM 需要即时实例化 + 布局 + 绘制，
   * 出现白色空白闪烁。contain-intrinsic-size: auto 24px 的占位高度
   * 也可能与实际行高(24px + accordion 展开时不固定)不匹配，占位不准加剧空白。
   * 对于 600-900 行的现代浏览器，不依赖 cv: auto 也能流畅滚动。
   * 如果未来行数破千引发性能问题，再考虑改用虚拟滚动(只渲染可视区域+buffer)。 */
}
/* v2.36：commit-row hover 时给 4 个内容列加背景
 * v2.36 改动：graph 占位列也加入 hover 背景(之前注释说"让 SVG 始终透出"故意排除)
 * 右侧内容列用实底色；左侧 graph 列用半透明轨道，让 SVG flow 和圆点仍在轨道上方可见。
 * v3.7：accordion 不再被 hover 选择器命中（详情面板要有自己的 elevated 卡片样式，
 * 不能被 commit-row 整体 hover 覆盖成灰色。彻底对齐 vscode-git-graph——vscode
 * 详情面板有独立背景，hover 不影响。*/
.commit-row:hover .commit-row__col--desc,
.commit-row:hover .commit-row__col--author,
.commit-row:hover .commit-row__col--date,
.commit-row:hover .commit-row__col--sha {
  background: rgba(128, 128, 128, 0.15);
  border-right-color: transparent;
}
/* v3.7：删除 .commit-row:hover .commit-accordion 规则（详情面板不应该被 hover 改动） */
/* v1.6 可点击的 commit 行 */
.commit-row--clickable {
  cursor: pointer;
}
/* v2.36：可点击 commit 行 hover 主色 soft 背景 —— graph 列也跟随(理由同 :hover 规则) */
.commit-row--clickable:hover .commit-row__col--desc,
.commit-row--clickable:hover .commit-row__col--author,
.commit-row--clickable:hover .commit-row__col--date,
.commit-row--clickable:hover .commit-row__col--sha {
  background: rgba(128, 128, 128, 0.15);
  border-right-color: transparent;
}
/* v3.7：删除 .commit-row--clickable:hover .commit-accordion（详情面板不应被 hover 改） */
.commit-row--clickable:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
/* v2.36：行下手风琴 —— 展开 commit 行背景改为 --color-bg-hover（中性 hover 灰），
 * 让手风琴卡片（elevated 灰白）成为视觉主体，展开行只保留轻量状态指示。
 * v2.36：graph 列也跟随(其他 hover 规则的理由一致)*/
.commit-row--clickable.commit-row--expanded .commit-row__col--desc,
.commit-row--clickable.commit-row--expanded .commit-row__col--author,
.commit-row--clickable.commit-row--expanded .commit-row__col--date,
.commit-row--clickable.commit-row--expanded .commit-row__col--sha {
  background: rgba(128, 128, 128, 0.25);
  border-bottom-color: transparent;
  border-right-color: transparent;
}
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--desc,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--author,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--date,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--sha {
  background: rgba(128, 128, 128, 0.35);
}
/* Transition 行（merge edge 中间段，无 commit）—— 占位用，与 dot overlay 行节奏对齐
 * v2.40：26 → 30px，与 commit-row / SVG ROW_HEIGHT 同步（dot 行节奏对齐） */
.commit-row--relation {
  pointer-events: none;
  background: transparent;
  height: 24px; /* 与 commit-row 一致（= ROW_HEIGHT），dot overlay 行节奏对齐 */
}
.commit-row--relation:hover {
  background: transparent;
}

/* v3.0：merge commit（PR 合并提交）视觉降级 ——
 * 旧实现用 opacity: 0.5 直接砍半亮度，user 反馈"commit row 的 PR 信息看不清"
 * （暗色底上 50% opacity ≈ 对比度从 7+ 直接掉到 3.5:1，掉出 AA）。
 *
 * 新实现：改用 --color-text-muted 给 subject 显式降级，
 *   - 仍跟普通 commit（--color-text）形成视觉层级："我的 commit" vs "merge commit"
 *   - 但对比度保留在 6.40:1，过 WCAG AA Large 4.5:1，且跟 hover/状态色叠加不冲突
 *   - 旧的 col--desc opacity 也去掉 —— 容器是 block 不是文字，opacity 砍的是整个盒子透明度（包括未来加的 ref-badge），副作用大
 *   - 跟 MergesView 的 merge-item__meta-text 走同一档 muted，跨视图一致
 *
 * 配色跟 VSCode Git Graph 的 merge commit 灰度策略对齐（VSCode 用 tokenColorModifiers，
 * 本项目用 muted token；语义等价）。*/
.commit-row--merge .commit-subject {
  color: var(--color-text-muted);
}

/* v3.14：ref badge 样式（对齐 VSCode Git Graph .gitRef）
 *  - 小圆角（border-radius: 3px）
 *  - 透明背景，1px solid border 用 lane 色（commit 所在 lane 色）
 *  - 文字颜色保持默认（深色），不随 lane 变色
 *  - 图标背景填充 lane 色，SVG 图形用深色（对比）
 *  - --row-lane-color 由各 commit-row 自身绑定（非 hover 依赖） */
.ref-badge {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 0;
  /* VSCode Git Graph .gitRef 默认样式：灰底 + 灰边框 + 圆角 5px */
  border-radius: 5px;
  border: 1px solid rgba(128, 128, 128, 0.75);
  font-size: 12px;
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
  background-color: rgba(128, 128, 128, 0.15);
  color: var(--color-text, #ccc);
  line-height: 18px;
  height: 18px;
  overflow: hidden;
}
/* 图标容器（VSCode .gitRef > svg）：
 * - 图标背景 = lane 色（--row-lane-color，来自 commit 所在 lane）
 * - 图标 SVG 图形 = 深色（fill = editor-background）
 * dot hover 时通过 .commit-row--dot-active .ref-badge 变 border-color */
.ref-badge__icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  padding: 2px;
  /* 图标背景 = lane 色（VSCode .gitRef > svg） */
  background-color: var(--row-lane-color, rgba(128, 128, 128, 0.5));
  /* SVG 图形 = 深色（VSCode .gitRef > svg fill=editor-background） */
  stroke: var(--color-shell-main-bg, #0f1115);
  stroke-width: 2;
  fill: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* dot-hover 时 border 变 lane 色（对齐 VSCode .gitRef.active） */
.commit-row--dot-active .ref-badge {
  border-color: var(--row-lane-color);
}

/* commit-refs 容器：多个 badge 横向排列，按 VSCode 风格放在 subject 前面。*/
.commit-refs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-right: 8px;
  vertical-align: middle;
}

.commit-subject {
  /* v2.x：行内文字流 —— refs + subject 一起组成 desc 列内容。
     desc 列的 white-space:nowrap + overflow:hidden + text-overflow:ellipsis
     负责整体截断。*/
  display: inline;
  color: inherit;
  font-size: inherit;
}

/* v0.3.0：UNCOMMITTED 行的 subject ("Uncommitted changes (N files)")
   是 worktree dirty 触发的虚拟节点（git status --porcelain 检测），
   加大加粗让用户一眼识别。颜色用 #808080 对齐 lane 灰色。 */
.commit-subject--uncommitted {
   font-size: 1.15em;
   font-weight: 600;
   color: #808080;
   letter-spacing: 0.01em;
 }

/* v2.22：列容器（grid item） */
.commit-row__col {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  grid-row: 1;
  min-width: 0;
  overflow: hidden;
  /* v2.66：border-box 让 padding/border 计入 grid track，hover 背景宽度 = 列宽
   * 旧 content-box 下 12px padding 溢出 track，author/date/sha 实际可见宽度
   * 跟 grid-template-columns 写的 180/120/80 对不上，三列 hover 高亮宽度不一致。*/
  box-sizing: border-box;
  /* v2.31 revert：恢复 v2.27 行为——内容列有自身背景，遮住下方背景层 SVG/圆点（commit-row 整行透明） */
  background: var(--color-shell-main-bg);
}
/* v3.4：graph 占位列（第一列，透明让背景 SVG 透出）
 *   - background: transparent —— 不遮挡 .git-graph-bg 的 SVG
 *   - pointer-events: none —— 鼠标事件穿透到 commit-row（hover 高亮整行）
 *   - 跟 header __col--graph 同宽（var --grid-template-columns 第一列） */
.commit-row__col--graph {
  background: transparent;
  pointer-events: none;
}
/* v3.0：vscode-git-graph 风格的 dot hover —— dot 被 hover 时，该行 graph 列用 lane 色软底
 * （颜色由 dotEnter() 注入到 .git-graph-body 的 --active-lane-color CSS var，
 *  因为 SVG circle 和 commit-row 是兄弟节点，CSS var 必须挂在共同祖先才能被两边继承）
 * - 走 linear-gradient 右淡出，避免色块硬切到 desc 列背景
 * - 38% alpha 让 lane 色在深底上可见但不刺眼（与 commit-row hover 的 rgba(128,128,128,0.15) 灰叠加重）
 * - transition 让 hover/unhover 平滑而非硬切 */
.commit-row--dot-active .commit-row__col--graph {
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--active-lane-color) 38%, transparent) 0%,
    color-mix(in srgb, var(--active-lane-color) 18%, transparent) 70%,
    transparent 100%
  );
  transition: background var(--t-fast, 120ms) var(--ease, ease-out);
}


/* v3.12：dot hover tooltip（普通 HTML div，绝对定位于 .git-graph-body 内）
 *  v-show 控制显隐：tooltip 始终在 DOM 中，mouse 可达
 *  dotEnter 100ms 后显示；dotLeave 200ms 后隐藏
 *  z-index 200 高于 commit-row，保证盖在内容上方 */
.git-graph-tooltip {
  /* 对齐 vscode: position: fixed 相对于 viewport */
  position: fixed;
  z-index: 200;
  pointer-events: none;
}
.git-graph-tooltip__pointer {
  /* pointer: 从 tooltip box 左侧中间水平向左延伸到 dot 中心
   * tooltip box 左侧 = dotCenterX+30，pointer 右端在 tooltipX = dotCenterX+30
   * left=-30px, width=30px → 左端=tooltipX-30=dotCenterX，右端=tooltipX=dotCenterX+30
   * top: 0（初始值，JS 在 nextTick 里动态设为 contentH/2+1px，对齐 dot 中心）
   * margin-top=-1px → pointer 视觉中心 = top - 1 = contentH/2 */
  position: absolute;
  left: -30px;
  top: 0;
  width: 30px;
  height: 2px;
  margin-top: -1px;
  background-color: var(--tooltip-color, #888);
  z-index: 4;
}
/* v3.16: tooltip CSS 对齐 vscode graph.ts */
.git-graph-tooltip__content {
  position: relative;
  /* 内容紧跟 pointer（无额外 margin） */
  margin-left: 0;
  background: var(--color-bg-elevated, #1e1e1e);
  border: 2px solid var(--tooltip-color, #888);
  border-radius: 5px;
  padding: 3px 10px;
  max-width: 600px;
  box-shadow: 0 0 30px 5px rgba(0, 0, 0, 0.4);
}
/* 对齐 vscode graphTooltipTitle */
.git-graph-tooltip__title {
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text, #ccc);
  padding: 3px 0;
}
/* 对齐 vscode graphTooltipSection */
.git-graph-tooltip__section {
  font-size: 13px;
  color: var(--color-text-secondary, #888);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding: 3px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.5);
  line-height: 22px;
}
.git-graph-tooltip__section-label {
  margin-right: 4px;
}
/* 对齐 vscode graphTooltipRef */
.git-graph-tooltip__ref {
  display: inline-flex;
  align-items: center;
  height: 18px;
  line-height: 18px;
  padding: 0 5px;
  border-radius: 5px;
  border: 1px solid rgba(128, 128, 128, 0.75);
  background-color: rgba(128, 128, 128, 0.15);
  color: var(--color-text, #ccc);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
/* 高亮 ref（lane 色边框）：对应当前 lane 的 ref 标签 */
.git-graph-tooltip__ref--highlight {
  border-color: var(--tooltip-color, #888);
}
/* v2.48 旧注释：.commit-row__col--graph 曾被移除，v3.4 恢复（5 列统一对齐） */
.commit-row__col--desc {
  /* v2.x：放弃 flex 布局，改 block 文字流 —— subject 和 refs 都 inline，
     整体被 desc 列的 overflow:hidden + text-overflow:ellipsis 截断。
     这样 refs 和 subject 都在同一行内流里，不会被推到列最右。*/
  display: block;
  padding: 0 12px;
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: var(--git-graph-row-height, 24px);
}
.commit-row__col--author {
  font-size: inherit;
  color: inherit;
  padding: 0 12px;
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.commit-row__col--date {
  font-size: inherit;
  color: inherit;
  padding: 0 12px;
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.commit-row__col--sha {
  font-size: inherit;
  color: inherit;
  /* 右侧间距由 commit-row 的 padding-right 提供，避免叠加 */
  padding: 0 0 0 12px;
}

.commit-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  color: inherit;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: inherit;
}
.commit-time {
  white-space: nowrap;
  font-size: inherit;
}

.commit-sha {
  font-size: inherit;
  color: inherit;
  flex-shrink: 0;
}

/* ===== v2.12 行下手风琴（commit-accordion · 复刻 VSCode Git Graph）=====
     * 跨整宽（position: absolute + left/right: 0）覆盖左侧 SVG 区，
     * 让"展开区域"在视觉上左右对齐成一条横带（左侧 graph 区下方自然留白，
     * 跟 VSCode Git Graph "左侧 lane 在展开行止步"的行为一致）。
     *
     * v2.14 重大布局变化：手风琴**流式插入 .git-graph-list 内部**，
     * 只占右列宽，不再跨整宽覆盖左侧 git-graph SVG（user 反馈）。
     * - 取消 position: absolute + z-index + left/right
     * - 改为 block 流式，作为 commit-row 的兄弟元素自然撑高 list 高度
     * - 左侧 SVG 区保持可见（高度不变 = svgHeight）
     *
     * 双栏 4:6 + 各自滚动（v2.12）：
     * - overflow: hidden 让 panel 内部 grid 消化滚动（避免双滚动条）
     * - display: flex + flex-direction: column 让 panel 用 height: 100% 撑满手风琴
     *
     * 视觉卡片化（v2.11）：
     *   - bg = --color-bg-elevated（vs 主区 canvas 暗色 +14 阶 / 亮色 +9 阶）
     *   - 8px 圆角 + 1px --color-divider 描边
     *   - --shadow-sm 单层柔和阴影
     *
     * max-height 固定 300px（v2.66 由 600 减半，跟 VSCode Git Graph 行为对齐）
     */
    .commit-accordion {
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-divider);
      border-radius: var(--radius-card, 8px);
      box-shadow: var(--shadow-sm);
      grid-column: 2 / 6;
      /* v3.7：禁止 accordion 自身纵向滚动（overflow-y:hidden）。
       * 左栏 / 右栏各自有 overflow-y:auto，内容超限时各自内部滚动，互不干扰。
       * overflow-x:auto 允许文件列表横向滚动（vscode 原始 #cdvFiles li 无横向滚动但保留设置）。
       * max-height: min(70vh, 600px) 限制 accordion 高度上限，超出时内容被裁剪，
       * 由左右栏自身滚动接管 —— 跟 vscode 行为一致。 */
      max-height: min(70vh, 600px);
      overflow: hidden auto; /* x=hidden 禁止纵向滚动；y=auto 内容超限时栏内滚动 */
      /* v3.8：去掉 scrollbar-width——accordion 不再有纵向滚动条，滚动由 .cd-panel__left/right 接管 */
      scrollbar-width: none; /* 隐藏纵向滚动条 */
      scrollbar-gutter: stable; /* 预留滚动条槽位（即使无滚动条也占位，避免宽度跳变） */
      /* 入场动画 */
      animation: cdAccordionOpen 180ms cubic-bezier(0.16, 1, 0.3, 1);
      /* 让内部 panel 用 height: 100% 撑满手风琴 */
      display: flex;
      flex-direction: column;
      /* v2.51：手风琴现在在 .git-graph-rows 内部（rows 是 flex item，已经从 bg 容器右边开始），
         宽度 = 100% 自动填满 rows 容器（=wrapper 宽 - bg 容器宽）。 */
      margin: 4px 0;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      flex-shrink: 0;
    }
.commit-accordion::-webkit-scrollbar {
  width: 8px;
}
.commit-accordion::-webkit-scrollbar-track {
  background: transparent;
}
.commit-accordion::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 4px;
}
.commit-accordion::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}
/* 手风琴内嵌的 panel：撑满父容器；去掉 panel 自带顶部分割线（容器已有）
 * v2.11：panel 自身背景透明，继承手风琴卡片的 elevated 底色，
 * 让"手风琴壳 + panel 内容"看起来是同一张大卡片 */
.commit-accordion > :deep(.cd-panel),
.commit-accordion > :deep(.cd-panel--panel) {
  border-top: none;
  background: transparent;
}

/* v2.14：spacer 已删除 —— 手风琴自身在 list 内嵌流式，自然撑高 list 高度 */

/* 展开动画 */
@keyframes cdAccordionOpen {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .commit-accordion {
    animation: none;
  }
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

/* Graph/描述之间的表头分隔线也是拖拽开关；它移动第一列宽度，从而移动后 4 列内容区。 */
/* v2.21：handle 左侧全屏背景色遮罩（盖被子效果）
 * v2.26：移除此遮罩！它用 `pointer-events:none` 背景色块盖住整个 svg-area，
 * 导致 git-graph 看不到（用户反馈"git-graph 被黑色东西遮挡"）。
 * 改用 svg-area 自身的 background（CSS line 1408）提供遮罩，
 * 而 handle 只做分隔+拖拽指示，不做遮罩。 */

/* 拖拽中防止文本选中 + 全局 cursor */
.timeline-new__main--dragging {
  user-select: none;
  cursor: col-resize;
}
.timeline-new__main--dragging * {
  cursor: col-resize !important;
}

/* v3.0：表头右键菜单浮层（vscode-git-graph contextMenu.show 风格）
 *   - position: fixed，按右键位置 left/top 定位
 *   - z-index 高于 sticky header（5）+ resize handle（6）
 *   - 暗主题：背景 #252526 + 1px border；亮主题：#fff + 1px border
 *   - 每项：hover 时背景 primary-soft，checked 时显示 ✓
 */
.git-graph-header__context-menu {
  position: fixed;
  z-index: 100;
  min-width: 140px;
  background: var(--color-bg-elevated, #252526);
  border: 1px solid var(--color-divider, rgba(128, 128, 128, 0.35));
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
}
.git-graph-header__context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 12px;
  background: transparent;
  border: none;
  color: var(--color-text, #ccc);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.git-graph-header__context-menu-item:hover {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.2));
}
.git-graph-header__context-menu-item--checked::before {
  content: '✓';
  color: var(--color-primary, #74b830);
  font-weight: 600;
}

/* ===== v1.6 Avatar fallback（无头像时显示首字母） ===== */
.commit-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  /* 背景色继承 flow-color-16-N 的 fill 变量 */
  background-color: var(--color-series-16-0);
  line-height: 1;
}

/* fallback 胜景色：复用 16 色系列 */
.commit-avatar-fallback.flow-color-16-0 { background-color: var(--color-series-16-0); }
.commit-avatar-fallback.flow-color-16-1 { background-color: var(--color-series-16-1); }
.commit-avatar-fallback.flow-color-16-2 { background-color: var(--color-series-16-2); }
.commit-avatar-fallback.flow-color-16-3 { background-color: var(--color-series-16-3); }
.commit-avatar-fallback.flow-color-16-4 { background-color: var(--color-series-16-4); }
.commit-avatar-fallback.flow-color-16-5 { background-color: var(--color-series-16-5); }
.commit-avatar-fallback.flow-color-16-6 { background-color: var(--color-series-16-6); }
.commit-avatar-fallback.flow-color-16-7 { background-color: var(--color-series-16-7); }
.commit-avatar-fallback.flow-color-16-8 { background-color: var(--color-series-16-8); }
.commit-avatar-fallback.flow-color-16-9 { background-color: var(--color-series-16-9); }
.commit-avatar-fallback.flow-color-16-10 { background-color: var(--color-series-16-10); }
.commit-avatar-fallback.flow-color-16-11 { background-color: var(--color-series-16-11); }
.commit-avatar-fallback.flow-color-16-12 { background-color: var(--color-series-16-12); }
.commit-avatar-fallback.flow-color-16-13 { background-color: var(--color-series-16-13); }
.commit-avatar-fallback.flow-color-16-14 { background-color: var(--color-series-16-14); }
.commit-avatar-fallback.flow-color-16-15 { background-color: var(--color-series-16-15); }

</style>
