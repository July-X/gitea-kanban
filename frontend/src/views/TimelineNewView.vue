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

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { GitCommit, RotateCw, GitBranch, Tag } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import {
  commitsGitgraphAsciiLines,
  commitsGitgraphLines,
  commitsGitgraphCloneRepo,
  commitsGitgraphPull,
  deepenRepo,
} from '@renderer/lib/ipc-client';
import EmptyState from '@renderer/components/EmptyState.vue';
import CommitDetailPanel from '@renderer/components/CommitDetailPanel.vue';
import type { BasicCommit } from '@renderer/components/CommitDetailPanel.vue';
import { showToast } from '@renderer/lib/toast';

import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import {
  renderGraph,
  ROW_HEIGHT as STRUCTURED_ROW_HEIGHT,
  type GraphResultDto,
  type SvgRenderResult,
} from '@renderer/lib/gitgraph/structured';
import {
  renderGraphVscode,
  VSCODE_GRID_X as VSCODE_LANE_WIDTH,
  VSCODE_GRID_Y as VSCODE_ROW_HEIGHT,
  type VscodeSvgRenderResult,
} from '@renderer/lib/gitgraph/vscode-render';
import {
  COL_WIDTH as ASCII_COL_WIDTH,
  DISPLAY_SCALE,
  DISPLAY_SCALE as ASCII_DISPLAY_SCALE,
  ROW_HEIGHT,
  ROW_HEIGHT as ASCII_ROW_HEIGHT,
  FLOW_LEFT_PAD,
  flowColorClass,
  layoutVscodeGraph,
  parseLines,
  type GitGraphCommit,
  type Graph,
  type GraphLine,
  type VscodeGraphLayout,
} from '@renderer/lib/gitgraph';

// ============================================================
// 常量
// ============================================================
// ROW_H 在下方 SVG 渲染坐标节定义（v2.6：直接用 STRUCTURED_ROW_HEIGHT）

// ============================================================
// Store & 上下文
// ============================================================
const auth = useAuthStore();
const repo = useRepoStore();

// 初始 graph 上限。
// v2.x 修复 July-X/UnrealEngine 渲染卡死：UnrealEngine release 分支中段有一段超宽 merge
// 历史（单行 1407 lane / 963 flow），-n 5000 会把这段拉进来，前端 6836 div + 963 超长 path
// 直接卡死主线程（用户看到"只有圆点、列表空白"的卡顿中间态）。
// 降到 1000：最近的提交 graph 很窄（列宽 ≤3），DOM 秒渲染；更早历史交给「加载更多」按需拉。
const INITIAL_GRAPH_LIMIT = 1000;
const LOAD_MORE_DEEPEN_BY = 200;
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
/** v2.6 + v2.9 (vscode-port)：前端从 GraphResultDto 渲染出的 SVG 数据 */
const svgRender = ref<VscodeSvgRenderResult | null>(null);
/** GitHub/gh 超大仓库：git log --graph 字符流解析后的 Graph */
const asciiGraph = ref<Graph | null>(null);
/** GitHub/gh 超大仓库：后端返回的原始字符流行 */
const asciiLines = ref<GraphLine[]>([]);
/** 加载态 */
const loading = ref(false);
/** 本地错误信息 */
const localError = ref<string | null>(null);

/** v2.10：加载更多状态 */
const loadingMore = ref(false);
/** v2.10：是否已加载完整历史 */
const hasCompleteHistory = ref(false);
/** 当前 Git Graph 显示上限；初始同步窗口更大，加载更多后继续放宽 */
const graphLimit = ref(INITIAL_GRAPH_LIMIT);

/** v2.10：是否显示「加载更多」按钮 */
const canLoadMore = computed(() => {
  // 必须有当前项目和 commits
  if (!activeProjectId.value || activeCommitCount.value <= 0) return false;
  // 已加载完整历史则不显示
  if (hasCompleteHistory.value) return false;
  // 超大仓库才显示（判断是否用了浅克隆）
  const project = repo.currentProject;
  if (!project) return false;
  const name = project.name.toLowerCase();
  return name.includes('unreal') || name.includes('chromium') ||
         name.includes('linux') || name.includes('webkit');
});
/** v1.5 功能未启用提示（main handler 返 disabled=true 时设置） */
const featureDisabled = ref(false);
/** v1.5 启用流程：是否正在 git clone */
const cloning = ref(false);
/** v1.5 启用流程：克隆进度 / 错误信息 */
const cloneProgress = ref<string | null>(null);
/** 是否正在 pull */
const pulling = ref(false);

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

/** v2.65：手风琴展开高度（实际渲染像素，ResizeObserver 实时更新）
 * 用于 SVG path d + dot cy 的 rowOffsets：手风琴展开时，
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
    // v2.66：保留旧 expandedHeight —— 收起瞬间避免 row 高度 30px 闪一下
    // 下一帧再次展开时 ref callback 同步读 offsetHeight 覆盖回真实值
    return;
  }
  // v2.66：accordion mount 瞬间同步读一次高度，避免首帧 expandedHeight=0
  // 导致 row 高度只有 ROW_H(30px)，hover 命中 30px 而 300px 面板溢出可见
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
const useAsciiGraph = computed(() => currentPlatform.value === 'github');

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
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* */
    }
  }
  if (activeProjectId.value) {
    await loadGraph();
  }
  // 注册全局刷新事件监听器
  document.addEventListener('app:refresh', onAppRefresh);
});

watch(
  () => activeProjectId.value,
  async (id) => {
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

/** 组件卸载时清理事件监听器（v2.16：拖拽已恢复） */
onUnmounted(() => {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  document.removeEventListener('app:refresh', onAppRefresh);
  if (graphDragRafId !== 0) {
    cancelAnimationFrame(graphDragRafId);
    graphDragRafId = 0;
  }
});

/**
 * v2.10：加载更多提交记录（增量拉取历史）
 *
 * 使用场景：用户滚动到 Git Graph 底部，点击「加载更多」按钮
 *
 * 技术实现：
 * 1. 调用 DeepenRepo API（增量拉取 200 层历史）
 * 2. 重新调用 loadGraph 刷新图形
 * 3. 显示成功/失败提示
 */
async function handleLoadMore() {
  if (!activeProjectId.value || loadingMore.value) return;

  loadingMore.value = true;
  try {
    // 1. 增量拉取历史
    const result = await deepenRepo({
      projectId: activeProjectId.value,
      deepenBy: LOAD_MORE_DEEPEN_BY,
    });
    graphLimit.value += LOAD_MORE_DEEPEN_BY;

    // 2. 重新加载 Git Graph
    await loadGraph();

    // 3. 检查是否已到根节点
    if (result.message && result.message.includes('完整历史')) {
      hasCompleteHistory.value = true;
      showToast({ type: 'success', message: '已加载完整历史记录' });
    } else {
      showToast({ type: 'success', message: result.message || '成功加载更多提交记录' });
    }
  } catch (error) {
    console.error('[TimelineNewView] handleLoadMore failed:', error);
    showToast({ type: 'error', message: '加载失败，请重试' });
  } finally {
    loadingMore.value = false;
  }
}


async function loadGraph(): Promise<void> {
  if (!activeProjectId.value) {
    return;
  }
  loading.value = true;
  localError.value = null;
  featureDisabled.value = false;
  useGlobalLoadingStore().show('timeline');
  try {
    if (useAsciiGraph.value) {
      const dto = await commitsGitgraphAsciiLines({
        projectId: activeProjectId.value,
        limit: graphLimit.value,
      });
      asciiLines.value = dto.lines;
      asciiGraph.value = parseLines(dto.lines).graph;
      graphDto.value = null;
      svgRender.value = null;
      expandedSha.value = null;
      return;
    }

    // v2.6：直接消费 Go 端 GraphResultDto（nodes + edges + 16 色字段）
    // 跳过 v1 字符流往返（adapter.ts 反编码 → parser.ts 解析），消除 bug1-bug4
    // v2.10：增加 limit 以支持加载更多功能
    const dto = await commitsGitgraphLines({
      projectId: activeProjectId.value,
      limit: graphLimit.value,
    });

    // 兼容 disabled 提示（main handler 可能返 disabled）
    const nodes = dto?.nodes ?? [];
    if (nodes.length === 0 && (dto as unknown as { disabled?: boolean }).disabled) {
      featureDisabled.value = true;
      graphDto.value = null;
      svgRender.value = null;
      asciiGraph.value = null;
      asciiLines.value = [];
      // 不要在这里 return，让 finally 块清理状态
    } else {
      graphDto.value = dto;
      // v2.9 (vscode-port)：使用 vscode-git-graph 风格 1:1 复刻渲染 (renderGraphVscode)
      // 替代之前的 Gitea 风格 renderGraph。GRID 16x24 + 贝塞尔曲线 + 12 色调色板
      svgRender.value = renderGraphVscode(dto);
      asciiGraph.value = null;
      asciiLines.value = [];
    }
    // v2.9：新数据加载完收起展开（防 SHA 失效）
    expandedSha.value = null;
  } catch (e: unknown) {
    console.error('[TimelineNewView] loadGraph failed:', e);
    const err = e as {
      code?: string;
      messageText?: string;
      message?: string;
      hint?: string;
    };
    const msg = err.messageText ?? err.message ?? String(e) ?? '加载失败';

    const looksLikeDisabled =
      err.code === 'internal' &&
      (msg.includes('v1.5') || msg.includes('Git Graph'));
    if (looksLikeDisabled) {
      featureDisabled.value = true;
      graphDto.value = null;
      svgRender.value = null;
      asciiGraph.value = null;
      asciiLines.value = [];
      // 不要在这里 return，让 finally 块清理状态
    } else {
      localError.value = err.hint ? `${msg}（${err.hint}）` : msg;
      graphDto.value = null;
      svgRender.value = null;
      asciiGraph.value = null;
      asciiLines.value = [];
    }
  } finally {
    loading.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

/**
 * v2.x 同步按钮（v1 旧名 pullRepo）
 *
 * 与 StatusBar 仓库选择界面的「同步/更新」按钮逻辑一致(v2.3 StatusBar 多行重写):
 *   - 未同步本地(clonedMap[owner/repo] = false)→ 调 commitsGitgraphCloneRepo
 *     (首次 clone,go-git NoCheckout 轻量模式,只拉元信息不拉工作区文件)
 *   - 已同步本地(clonedMap = true)→ 调 commitsGitgraphPull
 *     (git fetch + 更新本地 HEAD + 统计 commit 变化)
 *
 * 按钮可用性:`!loading && !pulling && activeProjectId` —— 跟 v1 旧版比,**不再依赖 localPath**:
 *   - 旧版要求 localPath 非空(导致"已 clone 但 view 不知情"时按钮永久 disabled)
 *   - 新版 Go 端 GetGitGraph / PullRepo 都按 projectId 反算 localPath(v2.4 已支持),
 *     所以前端只看 activeProjectId 就够
 *
 * 成功后:刷新本地 clonedMap 缓存 + 重新 loadGraph(显示最新 commit)
 */
async function syncRepo(): Promise<void> {
  if (!activeProjectId.value) return;
  pulling.value = true;
  useGlobalLoadingStore().show('timeline');
  try {
    const repo2 = activeRepo.value;
    const cloned = repo2 ? repo.clonedMap[`${repo2.owner}/${repo2.name}`] === true : false;
    let addedCommits = 0;
    if (!cloned) {
      // 未同步 → 首次 clone
      await commitsGitgraphCloneRepo({
        projectId: activeProjectId.value,
      });
      // 更新 clonedMap 缓存(避免下次又走 clone 分支)
      if (repo2) {
        repo.clonedMap[`${repo2.owner}/${repo2.name}`] = true;
      }
      // clone 完后端会返 localPath,但这里前端不再依赖它;
      // 显式让 loadGraph 重渲染用新的 local commit DAG
      showToast({
        type: 'success',
        message: '同步成功',
        description: `${repo2?.fullName ?? ''} 已同步到本地`,
      });
    } else {
      // 已同步 → pull 更新
      const resp = await commitsGitgraphPull({
        projectId: activeProjectId.value,
      });
      addedCommits = resp.addedCommits ?? 0;
      if (addedCommits > 0) {
        showToast({ type: 'info', message: `同步了 ${addedCommits} 个新提交` });
      } else {
        showToast({ type: 'info', message: '已是最新' });
      }
    }
    // 重新加载 graph（显示最新 commit）
    await loadGraph();
    // 刷新 clonedMap 缓存(让 StatusBar 仓库行按钮切到"更新")
    await repo.refreshClonedStatus();
  } catch (e: unknown) {
    const err = e as { messageText?: string; message?: string; hint?: string };
    const msg = err.messageText ?? err.message ?? String(e) ?? '同步失败';
    console.error('[TimelineNewView] syncRepo failed:', e);
    showToast({ type: 'error', message: msg });
  } finally {
    pulling.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

/** v2.x 按钮文字:根据 cloned 状态显示"同步"/"同步中…"
 *  - 跟 StatusBar 行末按钮文案风格对齐(StatusBar 未同步显示"同步",已同步显示"更新")
 *  - 这里统一叫"同步"(因为按钮在 Header 位置,顶部操作更直白;"更新"暗示已同步)
 */
const syncButtonLabel = computed<string>(() => {
  if (pulling.value) return '同步中…';
  return '同步';
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
    console.error('[TimelineNewView] enableGitGraph failed:', e);
  } finally {
    cloning.value = false;
    useGlobalLoadingStore().hide('timeline');
  }
}

// ============================================================
// SVG 渲染坐标（v2.6：对齐 structured.ts 的 LANE_WIDTH/ROW_HEIGHT）
// ============================================================
//
// v2.6 改用结构化渲染（不再走字符流）：
// - viewBox = `0 0 width height`（width/height 由 renderGraph 计算）
// - SVG 单位：LANE_WIDTH = 10 px / lane，ROW_HEIGHT = 30 px / row（v2.40 26 → 30,密集 commit-row 文字间距 +42%）
// - dot 圆点用 HTML overlay（不受 SVG 缩放影响）+ commit 列表逐行对齐
// v2.45：ASCII 路径 ROW_HEIGHT models.ts 19 → 30px（与 Gitea 路径完全统一，commit-row 行间距统一 8px）

const ROW_H = computed(() =>
  useAsciiGraph.value ? ASCII_ROW_HEIGHT * ASCII_DISPLAY_SCALE : STRUCTURED_ROW_HEIGHT,
); // commit 行高（px），与当前 SVG 路径一致

// v2.62 → v2.63 GitHub parser 修复：grid-template-rows 不再用 maxRow+1（包含 edge 行）
// 而是直接用 commit 数（displayRow 0..N-1 连续），彻底消除"看不见的空行"。
const maxRowPlusOne = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    // ASCII 路径：grid 行数 = commit 数（displayRow 0..N-1 连续，无 edge row 占位）
    return asciiGraph.value.commits.length;
  }
  const dto = graphDto.value;
  if (!dto || dto.nodes.length === 0) return 0;
  return Math.max(...dto.nodes.map((n) => n.row)) + 1;
});

/**
 * v2.63 GitHub parser 修复：ASCII 字符流行号 → displayRow 映射
 *
 * 背景：parseLines 返回的 commit.row 是 git --graph 字符流行号（多 PR 场景
 * 下不连续，row 0/2/3/5/7/8/10 这种，中间有 edge 行）。
 * 修复：commit 排成连续 displayRow 0..N-1，grid 容器跟 commit 数对齐。
 * SVG（path d + dot cy）也要在 displayRow 坐标系里绘制，否则线条跟 commit
 * 错位。
 *
 * - displayRowMap：asciiRow → displayRow
 * - sortedAsciiCommits：按 displayRow 升序的 commit 列表（rendering 用）
 */
const sortedAsciiCommits = computed<GitGraphCommit[]>(() => {
  if (!asciiGraph.value) return [];
  return [...asciiGraph.value.commits].sort((a, b) => a.row - b.row);
});

const displayRowMap = computed<Map<number, number>>(() => {
  const map = new Map<number, number>();
  sortedAsciiCommits.value.forEach((c, i) => map.set(c.row, i));
  return map;
});

/**
 * v2.65：手风琴展开时，expanded row 之后的所有 displayRow 视觉 y 都需要
 * 加上 expandedHeight（手风琴实际渲染高度）。
 * VSCode 行为：lane 直线自动延伸覆盖展开行高度。
 *
 * 关键：offset 应用到 rowOffsets[displayRow > expandedRow]，不加到 expandedRow 自身
 * （expandedRow 自身的视觉位置不变，只是它下面多出一段扩展区域）。
 */
const expandedDisplayRow = computed<number | null>(() => {
  if (!expandedSha.value) return null;
  for (const c of asciiGraph.value?.commits ?? []) {
    if (c.sha === expandedSha.value) {
      return displayRowMap.value.get(c.row) ?? null;
    }
  }
  return null;
});

const asciiRowOffsets = computed<Map<number, number>>(() => {
  const map = new Map<number, number>();
  const expandedAt = expandedDisplayRow.value;
  const offset = expandedHeight.value;
  if (expandedAt === null || offset <= 0) return map;
  // expandedAt 之后的所有 displayRow 都需要 offset
  const total = asciiGraph.value?.commits.length ?? 0;
  for (let r = expandedAt + 1; r < total; r++) {
    map.set(r, offset);
  }
  return map;
});

const asciiLayout = computed<VscodeGraphLayout | null>(() => {
  if (!asciiGraph.value) return null;
  return layoutVscodeGraph(asciiGraph.value, displayRowMap.value, {
    rowOffsets: asciiRowOffsets.value,
  });
});

const asciiWidthUnits = computed(() => {
  const laneCount = Math.max(1, asciiLayout.value?.laneCount ?? 1);
  return laneCount * ASCII_COL_WIDTH + ASCII_COL_WIDTH + FLOW_LEFT_PAD;
});

const viewBox = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    // v2.65：viewBox 高度 = commit 数 * ROW_HEIGHT + 累计 rowOffset
    // 手风琴展开时 viewBox 自动扩张，给 path d 留出延伸空间。
    const commitCount = asciiGraph.value.commits.length;
    const totalHeight = commitCount * ROW_HEIGHT + expandedHeight.value;
    return `0 0 ${asciiWidthUnits.value} ${totalHeight}`;
  }
  const r = svgRender.value;
  return r ? `0 0 ${r.width} ${r.height}` : '0 0 0 0';
});
const svgWidth = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return `${asciiWidthUnits.value * ASCII_DISPLAY_SCALE}px`;
  }
  const r = svgRender.value;
  return r ? `${r.width}px` : '0px';
});
const svgHeight = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    // v2.65：SVG 高度 = commit 数 * ROW_HEIGHT + 累计 rowOffset
    // 手风琴展开时 SVG 自动扩张，跟 commit-row 容器（grid + accordion 流式）视觉一致
    const commitCount = asciiGraph.value.commits.length;
    const totalHeight = (commitCount * ROW_HEIGHT + expandedHeight.value) * DISPLAY_SCALE;
    return `${totalHeight}px`;
  }
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
  colorHex?: string; // v2.6 fix：结构化路径用内联 hex；ASCII fallback 走 CSS class
  d: string; // 单条 path 的 d
  kind?: 'line' | 'shadow'; // vscode Branch.drawPath: shadow (stroke-width=4) + line (stroke-width=2)
}

const pathGroups = computed<PathGroup[]>(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    // GitHub fallback：ASCII 只负责提供 commit + parents，线条按 DAG parent edge 重排。
    // VSCode Git Graph 也是 parent-edge 语义，不等同于 `git log --graph` 字符流。
    return (asciiLayout.value?.paths ?? []).map((path, index) => ({
      id: `ascii-edge-${path.id}`,
      order: index,
      colorIndex: path.colorNumber % 16,
      colorClass: flowColorClass(path.colorNumber),
      d: path.d,
    }));
  }
  const r = svgRender.value;
  if (!r) return [];
  // 保持后端 edge 原始顺序，避免按颜色重排后改变 path 覆盖层级。
  // 每个 vscode path 拆成 shadow + line 两条 (Branch.drawPath:149-159)
  return r.paths.map((p) => ({
    id: `structured-${p.kind ?? 'line'}-${p.order}`,
    order: p.order,
    colorIndex: p.colorIndex,
    colorClass: `flow-color-16-${p.colorIndex}`,
    colorHex: p.colorHex,
    d: p.d,
    kind: p.kind,
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
/**
 * 完整行数组（row 0..maxRow）—— v2.6 简化 + v2.63 修复
 *
 * v2.6 旧逻辑（ASCII 路径）：for row in 0..maxRow → 包含 edge row（commit=null），
 * 渲染时 v-if 跳过 commit=null 容器，但 grid-template-rows: repeat(maxRow+1)
 * 仍然分配 30px 高度的 grid cell → 中间出现"看不见的 30px 空行"。
 *
 * v2.63 新逻辑（ASCII 路径）：allRows 直接由 sortedAsciiCommits 构造，
 * row 字段 = displayRow（0..N-1 连续），grid 行数 = commit 数（无空行）。
 * SVG（path + dot）用 displayRowMap 把 asciiRow 映射到 displayRow，
 * 视觉上 commit 与 flow 线条完全对齐。
 */
const allRows = computed<DisplayRow[]>(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return sortedAsciiCommits.value.map((commit, displayRow) => ({
      row: displayRow,
      commit: {
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        date: commit.date,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        // v2.65：merge commit 视觉降级
        isMerge: commit.isMerge,
        refs: Array.isArray(commit.refs) ? commit.refs.map((r) => r.shortName) : [],
        refTypes: Array.isArray(commit.refs)
          ? commit.refs.map((r) => refTypeFromGroup(r.refGroup))
          : [],
      },
    }));
  }
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
          }
        : null,
    });
  }
  return out;
});

const activeCommitCount = computed(() => {
  if (useAsciiGraph.value) return asciiGraph.value?.commits.length ?? 0;
  return graphDto.value?.nodes.length ?? 0;
});

// ============================================================
// ref 颜色（v2.6：refs 由 CommitDetailDialog 内部按需拉，此处不再需要 refColor/refBg）

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

/**
 * 圆点视觉直径（px）= 8px（v2.29 用户要求：flow 线条上的圆点调整为 8px 宽）
 * 比 lane 间距（5px）大，圆点视觉上"凸"在 lane 线上、跟 flow 路径有明显视觉对比。
 */
const DOT_SIZE = 8;

interface DotOverlayNode {
  sha: string;
  subject: string;
  title: string;
  row: number;
  cx: number;
  cy: number;
  /** 圆点直径（px），随 lane 缩放（保证圆点跟 lane 一起变密/变疏） */
  size: number;
  colorHex?: string;
  colorClass?: string;
  isCurrent?: boolean;
  isStash?: boolean;
}

function dotTitle(subject: string, refs?: string[], refTypes?: string[]): string {
  const branch = refs?.find((_, i) => refTypes?.[i] !== 'tag');
  return branch ?? refs?.[0] ?? subject;
}

const dotNodes = computed<DotOverlayNode[]>(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return asciiGraph.value.commits.map((commit) => {
      const displayRow = displayRowMap.value.get(commit.row) ?? 0;
      const rowOffset = asciiRowOffsets.value.get(displayRow) ?? 0;
      const node = asciiLayout.value?.nodes.get(commit.sha);
      const lane = node?.lane ?? 0;
      const colorNumber = node?.colorNumber ?? 0;
      return {
        sha: commit.sha,
        subject: commit.subject,
        title: dotTitle(
          commit.subject,
          commit.refs.map((r) => r.shortName),
          commit.refs.map((r) => refTypeFromGroup(r.refGroup)),
        ),
        row: displayRow,
        cx: (lane * ASCII_COL_WIDTH + ASCII_COL_WIDTH / 2 + FLOW_LEFT_PAD) * ASCII_DISPLAY_SCALE,
        cy: (displayRow * ASCII_ROW_HEIGHT + rowOffset + ASCII_ROW_HEIGHT / 2) * ASCII_DISPLAY_SCALE,
        size: DOT_SIZE,
        colorClass: flowColorClass(colorNumber),
      };
    });
  }
  return (svgRender.value?.nodes ?? []).map((node) => ({
    sha: node.sha,
    subject: node.subject,
    title: dotTitle(node.subject, node.refs, node.refTypes),
    row: node.row,
    cx: node.cx,
    cy: node.cy,
    size: DOT_SIZE,
    colorHex: node.colorHex,
    isCurrent: node.isCurrent,
    isStash: node.isStash,
  }));
});

// ============================================================
// v2.21：拖拽栅格栏（SourceTree 风格）
// - handle 物理位置：position: absolute，left 由 userHandleLeft 控制
//   - 默认 = svgWidth（handle 在 SVG area 右边缘）
//   - 用户拖拽后停在新位置（不回弹）
//   - 边界：handleLeft ∈ [60, 800]
// - handle 左侧显示背景色遮罩（用 :before 伪元素全宽背景）盖住部分 git-graph
// - commit list 起点 = handleLeft（紧邻 handle 右边）
// - SVG 完整渲染固定不动；handle 物理位置变化
// ============================================================

const MIN_GRAPH_COL_WIDTH = 56;
const MAX_GRAPH_COL_WIDTH = 800;
const MIN_CONTENT_COL_WIDTH = 60;
const GRAPH_WIDTH_STORAGE_KEY = 'gitea-kanban:gitgraph:graph-width';

/** 默认 graph 列宽度（v2.47：脱钩 svgWidth，避免多 lane 仓库把表格撑爆视口）
 * 之前 userHandleLeft 为 null 时 handleLeft = parseSvgPx(svgWidth)，200 lane → 2014px
 * → tableMinWidth 暴涨 → 整个表格出现大横向滚动条 → 用户必须左右扫才能看完整信息
 * 现在默认固定到接近 VSCode Git Graph 的窄列，用户拖过才用持久化值。
 * 真实 lane 数显示靠 SVG 内部横向滚动（见 .git-graph-bg 改造）。 */
const DEFAULT_GRAPH_COL_WIDTH = 96;
function loadGraphWidth(): number | null {
  try {
    const stored = localStorage.getItem(GRAPH_WIDTH_STORAGE_KEY);
    if (!stored) return null;
    const parsed = Number.parseFloat(stored);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(MIN_GRAPH_COL_WIDTH, Math.min(MAX_GRAPH_COL_WIDTH, parsed));
  } catch {
    return null;
  }
}

/** handle 物理位置（px），默认 = DEFAULT_GRAPH_COL_WIDTH（v2.47：脱钩 svgWidth）
 * 用户拖拽后停在 [60, 800] 范围内 */
const userHandleLeft = ref<number | null>(loadGraphWidth());
/** 是否正在拖拽 */
const dragging = ref(false);
let dragStartX = 0;
let dragStartHandleLeft = 0;
let dragLatestX = 0;

/**
 * handle 实际位置：默认窄列；用户拖过后完全尊重持久化宽度。
 */
const handleLeft = computed(() => {
  if (userHandleLeft.value === null) {
    return DEFAULT_GRAPH_COL_WIDTH;
  }
  return Math.max(MIN_GRAPH_COL_WIDTH, Math.min(MAX_GRAPH_COL_WIDTH, userHandleLeft.value));
});

/**
 * graph 列分隔手柄 mousedown —— v2.34：缓存所有需要的 DOM ref 和响应式快照
 *
 * 拖拽期间 mousemove 完全不写响应式 ref（避免触发 1000 行 commit-row 的 CSS 变量
 * 重新解析 + template 重渲染调 colHandleLeft 里的 querySelector + getBoundingClientRect）。
 */
function onDragStart(e: MouseEvent): void {
  e.preventDefault();
  dragging.value = true;
  dragStartX = e.clientX;
  dragLatestX = e.clientX;
  dragStartHandleLeft = handleLeft.value;
  // v2.51：缓存所有需要的 DOM ref 和响应式快照
  graphDragWrapper = document.querySelector('.git-graph-wrapper') as HTMLElement | null;
  if (graphDragWrapper) {
    graphDragHandles = {
      headerGraphCol: graphDragWrapper.querySelector('.git-graph-header__col--graph') as HTMLElement | null,
    };
    // 拖拽 graph 列时内容列不变，mousemove 直接用当前列宽快照。
    graphDragSnapshot = { ...colWidths.value };
  }
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

/**
 * graph 列分隔手柄拖拽 mousemove —— v2.34：完全绕过 Vue 响应式
 *
 * 关键优化（旧版卡顿根因）：
 * - 旧版每帧 rAF 写 `userHandleLeft.value = ...` → 触发 handleLeft / tableMinWidth /
 *   gridTemplateColumns 3 个 computed 重算 → wrapper inline style 重写 → 1000 行
 *   commit-row 重新解析 3 个 CSS 变量 + 重新计算 grid-template-columns → template
 *   重渲染调 colHandleLeft(n) 里 querySelector + getBoundingClientRect（强制 layout）。
 * - 新版 mousemove **完全不写 ref**：只更新 wrapper CSS 变量和表头手柄 DOM，
 *   不逐行写入 commit-row inline style。
 * - rAF pending 期间继续记录最新 clientX，下一帧直接使用最新位置，避免快速拖动滞后。
 * - mouseup 才把最终 handleLeft 写回 userHandleLeft.value，让响应式系统同步一次状态
 *   用于持久化。
 */
let graphDragRafId = 0;
/** 缓存的 DOM ref 和初始 left 值（mousedown 时拿一次） */
let graphDragWrapper: HTMLElement | null = null;
let graphDragHandles: {
  headerGraphCol: HTMLElement | null;
} = {
  headerGraphCol: null,
};
/** 列宽快照（mousedown 时缓存，mousemove 用快照避免读响应式） */
let graphDragSnapshot: { desc: number; author: number; date: number; sha: number } | null = null;

function onDragMove(e: MouseEvent): void {
  if (!dragging.value) return;
  dragLatestX = e.clientX;
  if (graphDragRafId !== 0) return; // 已有 pending frame，跳过
  const startHandleLeft = dragStartHandleLeft;
  graphDragRafId = requestAnimationFrame(() => {
    graphDragRafId = 0;
    if (!dragging.value) return;
    const delta = dragLatestX - dragStartX;
    // 计算新 handleLeft（夹紧到 [MIN, MAX]）
    const newLeft = Math.max(
      MIN_GRAPH_COL_WIDTH,
      Math.min(MAX_GRAPH_COL_WIDTH, startHandleLeft + delta),
    );
    // 缓存最终值（mouseup 时回写响应式）
    graphDragFinalLeft = newLeft;
    // v2.34：完全绕过 Vue 响应式，直接改 DOM
    if (graphDragWrapper) {
      // 1. wrapper 的 CSS 变量（1000 行 commit-row 的 var(--git-graph-col-width) 直接生效）
      graphDragWrapper.style.setProperty('--git-graph-col-width', `${newLeft}px`);
      // 2. tableMinWidth 也要更新（避免外层 timeline-new__main 横向滚动条失准）
      // v2.50：desc 用 1fr，最小宽度基于 MIN_CONTENT_COL_WIDTH 而非 w.desc
      const w = graphDragSnapshot ?? DEFAULT_COL_WIDTHS;
      const newTableMin = newLeft + MIN_CONTENT_COL_WIDTH + w.author + w.date + w.sha;
      graphDragWrapper.style.setProperty('--git-graph-table-width', `${newTableMin}px`);
      // 3. 表头 graph 列宽度（v2.51：列是 grid item，宽度由 grid-template-columns 第一列决定，
      //    这里直接写 inline style 覆盖 grid 值，拖拽期间实时跟随 newLeft）
      if (graphDragHandles.headerGraphCol) {
        graphDragHandles.headerGraphCol.style.width = `${newLeft}px`;
      }
      // v2.51：删除旧版表头手柄 left 和列分隔手柄 0/1/2 left 更新逻辑——
      // 旧版独立 .git-graph-header__resize div 已删除，手柄现在是 GRAPH 列的 ::after 伪元素，
      // 永远紧贴列右边线，无需 left 同步。
    }
  });
}

/** 拖拽结束时的最终 handleLeft（mouseup 时回写响应式用） */
let graphDragFinalLeft: number | null = null;

function onDragEnd(): void {
  if (graphDragRafId !== 0) {
    cancelAnimationFrame(graphDragRafId);
    graphDragRafId = 0;
  }
  if (dragging.value) {
    if (graphDragFinalLeft !== null) {
      userHandleLeft.value = Math.max(
        MIN_GRAPH_COL_WIDTH,
        Math.min(MAX_GRAPH_COL_WIDTH, graphDragFinalLeft),
      );
    }
    if (userHandleLeft.value !== null) {
      try {
        localStorage.setItem(GRAPH_WIDTH_STORAGE_KEY, String(userHandleLeft.value));
      } catch {
        /* 忽略持久化错误 */
      }
    }
  }
  dragging.value = false;
  // 清空缓存
  graphDragWrapper = null;
  graphDragHandles = { headerGraphCol: null };
  graphDragFinalLeft = null;
  graphDragSnapshot = null;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

/** 生成 fallback avatar：取名字首字符 */
function avatarInitial(name: string): string {
  if (!name) return '?';
  // 取第一个非空白字符
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

function refTypeFromGroup(refGroup: string): string {
  switch (refGroup) {
    case 'tags':
      return 'tag';
    case 'remotes':
      return 'remoteBranch';
    case 'heads':
    default:
      return 'branch';
  }
}

// ============================================================
// v2.22：SourceTree 风格表头 —— 列宽状态管理
// 列：Description (refs+subject) / Author / Date / SHA
// 拖动表头列分隔手柄调整列宽（commit-row 同步调整 grid-template-columns）
// 列宽持久化到 localStorage（用户偏好保存）
// ============================================================

/** 列宽状态：每个列的初始宽度（px） */
const DEFAULT_COL_WIDTHS: { desc: number; author: number; date: number; sha: number } = {
  desc: 480, // Description 列（refs + subject）—— v2.48 起用 1fr 占满剩余，此值仅拖拽临时态用
  author: 180, // Author 列——v2.49：160→180，确保常见用户名 + avatar + padding 不被截断
  date: 120, // Date 列
  sha: 96, // SHA 列——v2.49：80→96，确保 7 位 shortSha + padding 不被截断
};

/** 列宽存储 key */
const COL_WIDTHS_STORAGE_KEY = 'gitea-kanban:gitgraph:column-widths';

/** 加载持久化的列宽（如果有） */
function loadColWidths(): typeof DEFAULT_COL_WIDTHS {
  try {
    const stored = localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // v2.49：对每个列宽取 max(存储值, 默认值)，确保旧 localStorage 里的较小值
      //（如 v2.48 之前的 author=160/sha=80）不会覆盖调大的新默认值。
      // 用户拖拽后存的更大值仍保留。
      return {
        desc: typeof parsed.desc === 'number' ? parsed.desc : DEFAULT_COL_WIDTHS.desc,
        author: Math.max(parsed.author ?? DEFAULT_COL_WIDTHS.author, DEFAULT_COL_WIDTHS.author),
        date: Math.max(parsed.date ?? DEFAULT_COL_WIDTHS.date, DEFAULT_COL_WIDTHS.date),
        sha: Math.max(parsed.sha ?? DEFAULT_COL_WIDTHS.sha, DEFAULT_COL_WIDTHS.sha),
      };
    }
  } catch {
    /* localStorage 可能不可用（SSR/隐私模式） */
  }
  return { ...DEFAULT_COL_WIDTHS };
}

/** 列宽状态（响应式，初始从 localStorage 加载） */
const colWidths = ref({ ...loadColWidths() });

/**
 * v1.9 列宽语义重构：
 *   - desc 列：minmax(60px, 1fr) —— 默认占满余下空间，让表格内容区撑满父容器宽度
 *   - author/date/sha 列：固定 px —— 用户拖拽这些列分隔手柄时改变它们的宽度
 *   - 拖 colHandle 0（desc-author 间）实际改变 author 列宽（因为 desc 用 1fr 自然填满，
 *     拖右边就是 author 的左边界）。
 *   - 拖 colHandle 1/2（author-date/date-sha 间）改变 author/date 列宽。
 *
 * 关键：1fr 不带 px 单位，浏览器自动按"父容器 - 其他列总和 - 边距"分配余下空间。
 * 这样窗口 resize / 拖 author 列时，desc 列自动伸缩填满，**手风琴宽度也跟随同步
 * （手风琴用 100% 相对 .git-graph-body，自动同步）**。
 *
 * 持久化：colWidths.author/date/sha 存 px；desc 字段保留旧值兼容历史，但实际渲染
 * 用 1fr 替换。
 */
const gridTemplateColumns = computed(() => {
  const w = colWidths.value;
  return colWidthsToGridTemplate(w);
});

/** 整张 5 列表格的最小宽度，用于让主内容区自然出现横向滚动
 *  v1.9：desc 不再是固定 px，最小宽度 = handleLeft + author + date + sha + MIN_DESC */
/** 表格最小宽度（v2.47：脱钩 svgWidth）
 * 之前 = handleLeft + 内容列宽 + svgWidth → 200 lane 时 2014 + 840 = 2854px，撑爆视口
 * 现在只跟 handleLeft + 内容列固定宽（4 个内容列 + 12px 边距），跟 lane 数完全脱钩。
 * 多 lane 的水平滚动交给 SVG 内部（.git-graph-bg 的横向 overflow），不影响 commit 文字布局。
 * v2.48：desc 用 1fr 占满剩余空间，最小宽度基于 MIN_CONTENT_COL_WIDTH 而非 w.desc。 */
const tableMinWidth = computed(() => {
  const w = colWidths.value;
  return handleLeft.value + MIN_CONTENT_COL_WIDTH + w.author + w.date + w.sha + 12;
});

/** 把 widths 序列化成 CSS grid-template-columns 字符串
 *
 * v2.48：desc 列用 `minmax(MIN_CONTENT_COL_WIDTH, 1fr)` —— 占满剩余屏宽，
 * 让表格显示饱满（用户诉求："描述"列尽可能占用多的屏宽）。
 * v2.49：author/date/sha 用固定 px —— v2.50 起列分隔手柄已移除（只保留 graph 手柄），
 * 这些宽度走 DEFAULT_COL_WIDTHS 默认值，不再支持用户拖拽调整。 */
function colWidthsToGridTemplate(w: { desc: number; author: number; date: number; sha: number }): string {
  return `minmax(${MIN_CONTENT_COL_WIDTH}px, 1fr) ${w.author}px ${w.date}px ${w.sha}px`;
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
    <!-- ===== 顶部栏 ===== -->
    <header class="timeline-new__topbar">
      <div class="timeline-new__title">
        <GitCommit :size="16" />
        <span>Git Graph</span>
        <span v-if="activeRepo" class="timeline-new__repo-name">{{ activeRepo.fullName }}</span>
        <span v-else class="timeline-new__repo-name muted">请选择仓库</span>
      </div>

      <div class="timeline-new__actions">
        <!--
          v2.x：右上角"拉取"按钮 → 改名为"同步",逻辑跟 StatusBar 仓库选择界面一致
            - 未同步本地 → commitsGitgraphCloneRepo(首次 clone)
            - 已同步本地 → commitsGitgraphPull(git fetch + 更新本地 HEAD)
            - 不再依赖 localPath(Go 端按 projectId 反算,v2.4 已支持)
          命名:Header 顶部按钮统一叫"同步",跟 StatusBar 行末按钮文案风格对齐;
          StatusBar 的"更新"暗示已 clone,Header 这里更直白。
        -->
        <button
          class="sync-btn"
          :title="
            repo.clonedMap[
              `${activeRepo?.owner ?? ''}/${activeRepo?.name ?? ''}`
            ] === true
              ? '从远端拉取最新 commit（git fetch + pull --rebase）'
              : '克隆仓库元信息到本地（go-git 轻量模式，只拉 commit / tree / branch / tag）'
          "
          :disabled="loading || pulling || !activeProjectId"
          @click="syncRepo"
        >
          <RotateCw :size="15" :class="{ spinning: pulling }" />
          <span class="sync-btn__label">{{ syncButtonLabel }}</span>
        </button>

        <!-- v2.10：加载更多按钮（放在同步按钮旁边） -->
        <button
          v-if="canLoadMore"
          class="load-more-header-btn"
          :disabled="loadingMore"
          :title="`当前显示 ${activeCommitCount} 个提交，点击加载更多`"
          @click="handleLoadMore"
        >
          <span v-if="loadingMore">加载中...</span>
          <span v-else>加载更多</span>
        </button>
      </div>
    </header>

    <!-- ===== 主内容 ===== -->
    <div
      class="timeline-new__main"
      :class="{ 'timeline-new__main--dragging': dragging }"
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
        v-else-if="activeCommitCount === 0"
        class="timeline-new__placeholder"
      >
        <EmptyState title="没有提交记录" />
      </div>

      <!-- Git Graph -->
      <template v-else>
        <!--
          v2.27：git-graph 整合为表格第一列（用户反馈"应该是整体是表格的一个列，
                 而不是和表头分离的布局模式"）
          - 整张 SVG + dot overlay 作为背景层铺在 body 底层（position: absolute, z-index: 0）
          - header / commit-row 改为 5 列 grid：graph | 描述 | 作者 | 日期 | SHA
          - 每个 commit-row 第一列是占位（高度 = ROW_H），让背景的 SVG 在每行精确对齐
          - 完全去掉 sticky / flex 两栏的复杂 z-index 体系
        -->
        <div
          class="git-graph-wrapper"
          :data-dragging="dragging ? '' : null"
          :style="{
            '--grid-template-columns': gridTemplateColumns,
            '--git-graph-col-width': `${handleLeft}px`,
            '--git-graph-table-width': `${tableMinWidth}px`,
          }"
        >
          <!-- v2.22：SourceTree 风格表头（5 列：graph + 描述/作者/日期/SHA） -->
          <div class="git-graph-header" @mousedown.stop>
            <!-- v2.27：第一列 graph 标题格（与 commit-row 第一列同宽）
                 v2.34：宽度由 grid-template-columns 的 var(--git-graph-col-width) 决定，
                 不再挂 inline style（避免每个 header 跟随 handleLeft 重渲染） -->
            <!-- v2.51：graph 列（与 commit-row graph 列同宽）
                 resize handle 是列的真实右边缘——独立 div 用 right: -3px 定位，
                 永远紧贴列右边线（不再用 :style="{left: handleLeft}" 浮动定位），
                 与列宽变化 1:1 同步，不会出现"手柄位置跟列宽脱节"的视觉错位。
                 这是正常 table column resize 的标准模式：列右边线 = 命中区。 -->
            <div class="git-graph-header__col git-graph-header__col--graph">
              <span class="git-graph-header__col-label">Graph</span>
            </div>
            <!-- resize handle：紧贴 GRAPH 列右边，命中区 6px（中心对齐 1px border-right） -->
            <div
              class="git-graph-header__resize-handle"
              :class="{ 'git-graph-header__resize-handle--active': dragging }"
              @mousedown="onDragStart"
              title="拖动调整 Graph 列宽度"
            />
            <div class="git-graph-header__col git-graph-header__col--desc">描述</div>
            <div class="git-graph-header__col git-graph-header__col--author">作者</div>
            <div class="git-graph-header__col git-graph-header__col--date">日期</div>
            <div class="git-graph-header__col git-graph-header__col--sha">SHA</div>
          </div>

          <!-- v2.27：body 区（背景层 SVG + dot overlay + 行层 commit-row）
               v2.47：bg 容器宽度 = handleLeft（视觉上跟 commit-row 第一列同宽），
               内部 .git-graph-bg-scroll 用 min-width: svgWidth 让 SVG 完整渲染，
               bg 容器 overflow-x: hidden 裁剪掉超出 handleLeft 的部分 -->
          <div class="git-graph-body" :style="{ minHeight: svgHeight }">
            <!-- 背景层：视觉宽度 = handleLeft -->
            <div
              class="git-graph-bg"
              :style="{
                width: `${handleLeft}px`,
                height: svgHeight,
              }"
            >
              <!-- v2.47：bgScroll width = handleLeft (跟 bg 容器同宽,视觉上 130px)，
                   但 bgScroll 内部 SVG 完整渲染 width: svgWidth (2014px) 超出色边界，
                   bgScroll overflow-x: auto 出横向滚动条让用户滚动 SVG -->
              <div class="git-graph-bg-scroll" :style="{ height: svgHeight }">
                <svg
                  class="git-graph-svg"
                  :viewBox="viewBox"
                  :width="svgWidth"
                  :height="svgHeight"
                >
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
                      v-bind="pg.kind === 'shadow'
                        ? (pg.colorHex ? { stroke: pg.colorHex } : {})
                        : (pg.colorHex ? { stroke: pg.colorHex } : {})"
                      :stroke-width="pg.kind === 'shadow' ? 4 : 2"
                      :stroke-opacity="pg.kind === 'shadow' ? 0.25 : 1"
                      fill="none"
                      stroke-linecap="round"
                      vector-effect="non-scaling-stroke"
                    />
                  </g>
                </svg>

                <!-- 圆点 overlay：固定大小 = lane 间距 -->
                <div class="commit-dots-overlay" :style="{ width: svgWidth, height: svgHeight }">
                  <div
                    v-for="c in dotNodes"
                    :key="`dot-${c.sha}`"
                    class="commit-dot"
                    :class="[
                      c.colorClass,
                      { 'commit-dot--active': hoveredGraphRow === c.row },
                      { 'commit-dot--head': c.isCurrent },
                      { 'commit-dot--stash': c.isStash },
                    ]"
                    :style="{
                      left: `${c.cx - c.size / 2}px`,
                      top: `${c.cy - c.size / 2}px`,
                      width: `${c.size}px`,
                      height: `${c.size}px`,
                      ...(c.colorHex && !c.isCurrent ? { backgroundColor: c.colorHex } : {}),
                      ...(c.colorHex && c.isCurrent ? { borderColor: c.colorHex } : {}),
                    }"
                    :title="c.title"
                  />
                </div>
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
                :class="{
                  'commit-row--clickable': r.commit,
                  'commit-row--expanded': r.commit && expandedSha === r.commit.sha,
                  'commit-row--ascii': useAsciiGraph,
                  'commit-row--merge': r.commit.isMerge,
                }"
                :style="{
                  /* v2.66：展开时把 accordion 高度并入 row 高度，让 .commit-row:hover
                   * 选择器能覆盖 row + 下方 accordion 整段（用户反馈 hover 背景高度
                   * 跟展开面板不对齐——row 固定 30px 时 hover 只到 col 顶端）。
                   * 没展开的 row 仍走 ROW_H（30px）。 */
                  height: (r.commit && expandedSha === r.commit.sha
                    ? ROW_H + expandedHeight
                    : ROW_H) + 'px',
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
                <!-- v2.48：移除 graph 占位列——v2.47 改 flex 两栏后 SVG 已在独立 .git-graph-bg
                     容器，commit-row 内的 graph 占位列变成纯空白（描述列左侧 130px 空白根因）。
                     commit-row 改为 4 列 grid（desc/author/date/sha），直接对齐表头 desc 列。 -->
                <template v-if="r.commit">
                  <!-- v2.22：Description 列（refs + subject） -->
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
                    <span class="commit-subject">{{ r.commit.subject }}</span>
                  </div>
                  <!-- v2.22：Author 列 -->
                  <div class="commit-row__col commit-row__col--author">
                    <span
                      class="commit-avatar-fallback"
                      :class="`flow-color-16-${avatarColorIndex(r.commit.authorName)}`"
                      aria-hidden="true"
                    >{{ avatarInitial(r.commit.authorName) }}</span>
                    <span class="commit-author">{{ r.commit.authorName }}</span>
                  </div>
                  <!-- v2.22：Date 列 -->
                  <div class="commit-row__col commit-row__col--date">
                    <span class="commit-time">{{ formatRelative(r.commit.date) }}</span>
                  </div>
                  <!-- v2.22：SHA 列 -->
                  <div class="commit-row__col commit-row__col--sha">
                    <span class="commit-sha">{{ r.commit.shortSha }}</span>
                  </div>
                </template>
                <template v-else>
                  <!-- 关系占位行（merge edge 中间段）—— 4 个空 col 占位 -->
                  <div class="commit-row__col commit-row__col--desc" />
                  <div class="commit-row__col commit-row__col--author" />
                  <div class="commit-row__col commit-row__col--date" />
                  <div class="commit-row__col commit-row__col--sha" />
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
  /* v2.47：去掉 overflow-x: auto —— commit-row 不再跟 svgWidth 撑大 wrapper，
   * wrapper 自身不会出现横向滚动条（避免 ancestor 全局横向溢出）。
   * 多 lane 仓库的横向滚动完全在 .git-graph-bg 内部 SVG container 内部。*/
  overflow: hidden;
  overflow-y: visible;
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

/* 表头（5 列 grid）
 *
 * v2.47：min-width 改成 handleLeft + 4 内容列固定宽（不再依赖 var(--git-graph-table-width)）。
 * 之前 .git-graph-table-width = handleLeft + 4 内容列 + svgWidth（line 1088 旧版），
 * 多 lane 仓库（200 lane）下 .git-graph-table-width = 2854px → 表头撑出 wrapper 横向滚动条。
 * 现在 .git-graph-table-width 只跟 handleLeft + 4 内容列走，多 lane 由 SVG 内部横向滚动兜底。*/
.git-graph-header {
  display: grid;
  grid-template-columns: var(--git-graph-col-width, 96px) var(--grid-template-columns, 480px 160px 120px 80px);
  align-items: center;
  height: 32px;
  background: var(--color-shell-main-bg);
  /* v2.29：用 --color-divider 替换 --color-border（border 在两个主题下都是 transparent，
     所以用户看不到表头底下的 1px 线，无法方便拖拽列分隔手柄） */
  border-bottom: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  border-top: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  user-select: none;
  padding-right: var(--space-3, 12px);
  /* v2.0：去掉 min-width —— 让 header 宽度跟 wrapper 走（wrapper 已 100% 父容器），
   * 不再硬性 920px，避免极窄窗口被强制撑开。表格整体可被 wrapper overflow-x 滚动。*/
  box-sizing: border-box;
  position: sticky; /* v2.27：表头 sticky 顶部，body 滚动时表头保持可见 */
  top: 0;
  /* v2.32：z-index 提高到 5（高于 commit-dots-overlay z-index: 2 和 commit-row z-index: 1），
     让 sticky 表头在向下滚动时浮在 commit-row 之上，避免背景看起来"透明" */
  z-index: 5;
}
.git-graph-header__col {
  padding: 0 var(--space-3, 12px);
  overflow: hidden;
  text-overflow: ellipsis;
  /* v2.66：border-box 让 padding 计入 grid track，表头列宽 = 180/120/80，
   * 与 commit-row 列宽一致（表头 / 行 hover 背景完美对齐） */
  box-sizing: border-box;
  white-space: nowrap;
  /* v2.26：表头中文居中显示（与 SourceTree / VSCode Git Graph 风格一致） */
  text-align: center;
  /* v2.28：min-width: 0 防止内容撑大列宽（否则 SHA 会被挤到下一行） */
  min-width: 0;
}
.git-graph-header__col--graph {
  /* 第一列 graph 标题（宽度由 inline 绑定 handleLeft） */
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: var(--space-2, 8px);
  padding-right: var(--space-2, 8px);
  /* v2.29：用 --color-divider 替换 --color-border（border 在两个主题下都是 transparent，
     用户看不到 graph 列与 desc 列之间的纵向分隔线） */
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  background: var(--color-shell-main-bg);
}
.git-graph-header__col--graph .git-graph-header__col-label {
  font-size: 10px;
  font-weight: 500;
  color: var(--color-text-disabled);
  letter-spacing: 0.05em;
}
.git-graph-header__col--desc {
  padding-left: 0;
  /* v2.29：desc 列右侧纵向分隔线（用 --color-divider 可见） */
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
/* v2.51：GRAPH 列右边缘 resize handle —— 正常 table column resize 模式
 *  - 独立 div 用 right: -3px 定位（不是 :style="{left: handleLeft}" 浮动定位）
 *  - 永远紧贴 GRAPH 列右边线（right: -3px + width: 6px → 中心对齐 1px border-right）
 *  - 与列宽变化 1:1 同步，不会出现"手柄位置跟列宽脱节"
 *  - 这是 mouse 命中区（cursor + mousedown），也是视觉反馈区（hover/active 时高亮）
 *  - 与 v2.50 之前的 .git-graph-header__resize 区别：旧版用 left 浮动定位，
 *    手柄看起来"飘"在某个位置；新版紧贴列真实右边缘，正常 column 缩放体验 */
.git-graph-header__resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 紧贴 GRAPH 列右边缘：right: -3px + width: 6px → 中心在列右边线 */
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 6;
  background: transparent;
  transition: background 0.12s;
}
.git-graph-header__resize-handle:hover,
.git-graph-header__resize-handle--active {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.12));
}
.git-graph-header__resize-handle:hover::before,
.git-graph-header__resize-handle--active::before {
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

/* v2.51：旧 .git-graph-header__resize 规则已删除——v2.50 起不再用浮动定位的独立手柄。
   旧规则保留注释供 git blame 参考。*/

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
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  min-height: var(--git-graph-row-height, 24px);
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
  position: sticky;
  top: 0;
  left: 0;
  z-index: 2;
  pointer-events: none;
  content-visibility: auto;
  contain-intrinsic-size: auto 24px;
  /* 用 overflow: clip 强制裁剪 absolute 子元素（overflow: hidden 对 absolute 子元素不生效） */
  overflow: clip;
  flex: 0 0 auto;
}

/* v2.47：bg 内部 scroll 容器（装 SVG + dots）
 *   - position: absolute 让它脱离 bg 容器 flow，width 不影响 bg 容器宽度
 *   - inline style 设 min-width = svgWidth（多 lane 时完整渲染 SVG）
 *   - left: 0 锚定到 bg 左缘
 *   - overflow-x: auto + bg overflow: hidden 配合，bg 容器外的部分裁剪掉，bgScroll 内部出滚动条
 *   - 注意：不在 CSS 里写 min-width 让 inline 胜出（CSS min-width 会覆盖 inline） */
.git-graph-bg-scroll {
  position: absolute;
  top: 0;
  left: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

/* SVG 自身 */
.git-graph-svg {
  display: block;
}

/* 圆点 overlay：绝对定位在 SVG 之上，固定大小 = lane 间距（10px）
 *
 * v1.7 性能优化：`content-visibility: auto` 让屏幕外圆点不参与渲染——
 * 1000 个 absolute 定位的 div，每个浏览器都要 hit-test + paint，
 * 全部跳过渲染后滚动 fps 显著提升。
 * v2.40：圆点行高 = 30px（与 commit-row / SVG ROW_HEIGHT 同步），整容器高度 = maxRow * 30px。
 * contain-intrinsic-size 26 → 30 与 commit-row 同步。*/
.commit-dots-overlay {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 2;
  content-visibility: auto;
  contain-intrinsic-size: auto 24px;
}
.commit-dot {
  position: absolute;
  /* 默认尺寸（被 inline style 覆盖，inline size = lane 间距 跟随缩放） */
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-sizing: border-box;
  transition:
    box-shadow 0.12s ease,
    transform 0.12s ease;
  /* v2.60：z-index 提高到 3 确保在 SVG path 之上（z-index: 0 默认）
     修复：GitHub ASCII 模式下 dot 视觉反馈不明显（用户反馈 scale 1.5 修复无效），
     实际上是因为 dot 可能被 SVG path 视觉遮挡。加上 z-index 让 dot 始终在 SVG 之上。 */
  z-index: 3;
  /* v2.60：transform-origin 显式 center（默认就是 center，但写明语义清晰） */
  transform-origin: center center;
}
/* v2.42 + v2.57：hover 时只让 dot 变大（scale 1.25 → 1.5，8px → 12px），不再叠加绿色 box-shadow 外圈。
 * 之前 .commit-dot--active 有 3 重 box-shadow（3px shell-bg + 5px 绿色 + 14px glow），
 * 在 dot 周围画一个绿色圆环（用户反馈"外部画一个绿色的圆圈"，不够干净）。
 * 现在只保留 scale(1.5)（v2.57 从 1.25 调到 1.5，更明显的视觉变化），dot 视觉放大，
 * hover 高亮通过尺寸变化表达， 配合 .git-graph-bg:hover / SVG path highlight（如果有）共同传达 focus 状态。*/
.commit-dot--active {
  transform: scale(1.5);
}

/* HEAD 节点 (vscode Vertex.draw:310-315 + main.css:96-99)
   circle.current: fill=editor-bg(白), stroke=color, stroke-width=2 */
.commit-dot--head {
  background-color: var(--app-bg, #fff);
  border-width: 2px;
  border-style: solid;
}

/* stash 节点 (vscode Vertex.draw:318-326 + main.css:105-108)
   外圈 r=4.5 + 内圈 r=2 双圈; inner 用 box-shadow inset 实现 */
.commit-dot--stash {
  position: relative;
}
.commit-dot--stash::after {
  content: '';
  position: absolute;
  inset: 25%; /* (r-r_inner)/r = (4.5-2)/4.5 ≈ 33% */
  border-radius: 50%;
  background: transparent;
  border: 1px solid currentColor;
  pointer-events: none;
}

/* 圆点描边 (vscode main.css:100-103): 非 HEAD 都加 1px 半透明描边 */
.commit-dot:not(.commit-dot--head) {
  border: 1px solid var(--app-bg, #fff);
  border-style: solid;
  border-width: 1px;
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
  flex: 1 1 auto;
  min-width: 0;
  overflow: visible;
  display: block;
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
  /* v2.48：移除 graph 占位列（第一列 var(--git-graph-col-width)），改为 4 列 grid。
     v2.47 改 flex 两栏后 SVG 在独立 .git-graph-bg 容器，commit-row 不再需要 graph 占位列。 */
  grid-template-columns: var(--grid-template-columns, 480px 160px 120px 80px);
  align-items: center;
  gap: 0;
  /* v2.43 高度由内联 style 绑定 ROW_H（ASCII = 19px, structured = 30px），与 SVG 行高 1:1 对齐 */
  height: 24px; /* fallback（被 inline style 覆盖） */
  /* v2.43：行间距统一到 8px（Gitea + GitHub 一致体验）
   *   row 30px = line-box 22px (font 14 × line-height 1.571) + 间距 8px
   *   之前 v2.40 padding 5 + line-height 1.35 = 间距 11.11px（过大）*/
  /* v2.31 revert：恢复 v2.27 的"行透明 + 内容列自身背景"机制
     用户原意："只需要表头是非透明的背景即可"——表头 .git-graph-header 使用实色主内容背景，
     内容区 .commit-row 仍保持透明 + 4 个内容列各自用 var(--color-shell-main-bg) 遮罩 SVG 路径 */
  background: transparent;
  padding: 0 var(--space-3, 12px) 0 0;
  /* v2.0：去掉 min-width: 920px —— 让行宽度跟 wrapper 走，wrapper 已 width:100%，
   * 行不再有"最小 920px 撑大"行为。超长内容（长 ref badge / 长 author 名）
   * 走 .commit-row__col 的 overflow:hidden + ellipsis 截断，不撑列宽。*/
  /* v2.35：用户诉求——commit row 主体字号加大到 15px,提升可读性
   * v2.39：整体调优——字号回归 14px（26px 行高下更舒适），显式声明系统字体栈 +
   *   letter-spacing 微调，各列 padding 统一 12px，避免文字贴边。 */
  /* v2.43：行间距统一 8px（用户要求 Gitea + GitHub 一致）
   *   line-height 1.35 → 1.571（line-box 14×1.571≈22px），row 30px - 22px = 8px 间距。*/
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.571;
  letter-spacing: -0.005em;
  white-space: nowrap;
  /* v2.66：去掉 overflow: hidden —— 嵌入 .commit-accordion 后需要让它溢出
   * 显示（row 高度 = ROW_H + expandedHeight = 338px 容纳 300px 面板 + 余量），
   * 旧 overflow: hidden 会把 accordion 裁掉只剩 30px 可视高度，导致
   * "hover 背景只到 30px = 用户视觉的 row"——也覆盖不到展开面板。
   * desc/author/date/sha 列的 ellipsis 由各 .commit-row__col 自身 overflow:hidden 兜底。*/
  overflow: visible;
  /* v2.28：移除 commit-row 的 border-bottom（用户：下方的内容区，暂时不用 1px 的表格线） */
  border-bottom: none;
  box-sizing: border-box;
  position: relative; /* 自身建立 stacking context，让 col 内容在 SVG 之上 */
  z-index: 1;
  /* v1.7 滚动性能优化：屏幕外 commit-row 跳过渲染（content-visibility + contain）
   * 注意：contain: layout 与 :hover 状态不影响——hover 时只重渲染当前 row，
   * 但浏览器对每个 row 单独走 hit-test 后才知道哪行 hover，所以 c-v: auto 仍有效。*/
  content-visibility: auto;
  /* v2.40：26 → 30px，与 commit-row 高度 + SVG ROW_HEIGHT 同步（content-visibility 离屏预估高度） */
  contain-intrinsic-size: auto 24px;
}
/* v2.44：真正统一 Gitea + GitHub 两个平台 commit-row 视觉表现（用户无感）
 * 之前 v2.43 把 ASCII 路径做"小一号"（font 11px, row 19px, line-height 1.0）让行间距统一 8px，
 * 但行间距统一 ≠ 视觉统一——用户切换平台仍能感受到 row 高度/字号差异。
 * v2.45 方案：彻底删掉 19px 这个中间值，models.ts 的 ROW_HEIGHT 直接 = 30（与 structured.ts 一致），
 * SVG path/dot/容器高度全部走 30px，font 14px、line-height 1.571、line-box 22px、上下气口 8px。
 * 结果：Gitea 和 GitHub 视觉完全一致（font 14px, row 30px, line-height 1.571, 间距 8px），用户无感。
 * 之前 v2.44 注释里"transform: scaleY(19/30)"和"ROW_HEIGHT=19 保持 SVG 几何"是中间方案，
 * 实际并未真正落地（commit-row 容器还是 19px），现在 v2.45 一次性补上。*/
.commit-row--ascii {
  /* 完全继承 .commit-row 样式（font-size, line-height, padding, height = 30px）—— 视觉统一 */
  /* SVG 几何与容器都走 ROW_HEIGHT=30（models.ts v2.45），无需 transform 压缩 */
  /* contain-intrinsic-size 跟随 row 30px 离屏预估 */
  contain-intrinsic-size: auto 24px;
}
/* v2.36：commit-row hover 时给 4 个内容列加背景
 * v2.36 改动：graph 占位列也加入 hover 背景(之前注释说"让 SVG 始终透出"故意排除)
 * 右侧内容列用实底色；左侧 graph 列用半透明轨道，让 SVG flow 和圆点仍在轨道上方可见。
 * v2.66：accordion 嵌入 row 后，hover 选择器也命中展开面板，覆盖其 elevated 底色，
 * 视觉上 row + accordion 整段统一高亮（用户反馈 hover 高度未对齐）。*/
.commit-row:hover .commit-row__col--desc,
.commit-row:hover .commit-row__col--author,
.commit-row:hover .commit-row__col--date,
.commit-row:hover .commit-row__col--sha {
  background: var(--color-bg-hover);
  border-right-color: transparent;
}
.commit-row:hover .commit-accordion {
  background: var(--color-bg-hover);
}
/* v1.6 可点击的 commit 行 */
.commit-row--clickable {
  cursor: pointer;
}
/* v2.36：可点击 commit 行 hover 主色 soft 背景 —— graph 列也跟随(理由同 :hover 规则) */
.commit-row--clickable:hover .commit-row__col--desc,
.commit-row--clickable:hover .commit-row__col--author,
.commit-row--clickable:hover .commit-row__col--date,
.commit-row--clickable:hover .commit-row__col--sha {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.06));
  border-right-color: transparent;
}
.commit-row--clickable:hover .commit-accordion {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.06));
}
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
  background: var(--color-bg-hover);
  border-bottom-color: transparent;
  border-right-color: transparent;
}
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--desc,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--author,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--date,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--sha {
  background: var(--color-bg-hover);
  filter: brightness(1.08);
}
.commit-row--clickable.commit-row--expanded:hover .commit-accordion {
  background: var(--color-bg-hover);
  filter: brightness(1.08);
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

/* v2.65：merge commit 视觉降级（VSCode 风格）
 * - isMerge=true 的 commit（merge / pull request 合并提交）subject 文字用更淡的灰色
 * - 与普通 commit 形成视觉层级，用户一眼能区分"我的 commit" vs "merge commit"
 * - 颜色取自 --color-text-tertiary（设计系统三级文字），比 --color-text-primary 略淡
 *   在 dark mode 下差异更明显，light mode 下也是合理的弱化 */
.commit-row--merge .commit-subject,
.commit-row--merge .commit-row__col--desc {
  /* 用 --color-text-muted 而不是 --color-text-tertiary：
   * muted 在 dark 下 5.29:1 / light 下 6.39:1 ✓ 都过 WCAG AA，
   * 比 tertiary 的 rgba(255,255,255,0.55) 在 light 下几乎不可见友好。*/
  color: var(--color-text-muted, rgba(154, 170, 182, 0.85));
}

.ref-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  /* 不截断 —— 分支名完整显示，单行布局由 commit-row 的 overflow:hidden 兜底 */
  flex-shrink: 0;
  white-space: nowrap;
}
.ref-badge__icon {
  flex: 0 0 auto;
  stroke-width: 2;
}

/* v2.7：refs badge 类型区分（branch 绿、remote 蓝、tag 灰）
 * 后端 LogCommits 收集 refs 时已剥前缀：
 *   - 本地分支: refs/heads/main → "main"
 *   - 远程跟踪分支: refs/remotes/origin/main → "origin/main"
 *   - tag: refs/tags/v1.0 → "v1.0"
 * v2.7 简化按是否含 `/` 区分 branch vs remote（tag v2.8 加 RefType 字段后严格区分）
 */
.ref-badge--branch {
  background-color: var(--color-primary-soft, rgba(116, 184, 48, 0.12));
  color: var(--color-primary, #74b830);
  border: 1px solid var(--color-primary-soft, rgba(116, 184, 48, 0.3));
}
.ref-badge--remote {
  background-color: rgba(100, 116, 139, 0.12);
  color: #64748b;
  border: 1px solid rgba(100, 116, 139, 0.3);
}
.ref-badge--tag {
  background-color: rgba(245, 158, 11, 0.12);
  color: #d97706;
  border: 1px solid rgba(245, 158, 11, 0.3);
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
  color: var(--color-text);
  /* v2.39：15px → 14px，与 26px 行高比例更舒适；letter-spacing 微收紧 */
  font-size: 14px;
  letter-spacing: -0.005em;
}

/* v2.22：列容器（grid item） */
.commit-row__col {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
  overflow: hidden;
  /* v2.66：border-box 让 padding/border 计入 grid track，hover 背景宽度 = 列宽
   * 旧 content-box 下 12px padding 溢出 track，author/date/sha 实际可见宽度
   * 跟 grid-template-columns 写的 180/120/80 对不上，三列 hover 高亮宽度不一致。*/
  box-sizing: border-box;
  /* v2.31 revert：恢复 v2.27 行为——内容列有自身背景，遮住下方背景层 SVG/圆点（commit-row 整行透明） */
  background: var(--color-shell-main-bg);
}
/* v2.48：.commit-row__col--graph 已移除——v2.47 flex 两栏后 SVG 在独立 .git-graph-bg
 * 容器，commit-row 不再需要 graph 占位列（旧规则保留注释供 git blame 参考） */
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
  line-height: inherit;
}
.commit-row__col--author {
  /* v2.39：13px → 12px，与主体(14px)拉开层次但不显拥挤 */
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 0 12px;
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.commit-row__col--date {
  /* v2.39：13px → 12px */
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 0 12px;
  border-right: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
}
.commit-row__col--sha {
  /* v2.39：monospace → var(--font-mono-stack)（JetBrains Mono 优先） */
  font-family: var(--font-mono-stack);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--color-text-secondary);
  /* 右侧间距由 commit-row 的 padding-right 提供，避免叠加 */
  padding: 0 0 0 12px;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* v2.35：从 11px 提升到 13px */
  font-size: 13px;
}
.commit-time {
  white-space: nowrap;
  /* v2.35：从 11px 提升到 13px */
  font-size: 13px;
}

.commit-sha {
  font-family: monospace;
  /* v2.35：从 11px 提升到 12px */
  font-size: 12px;
  color: var(--color-text-secondary);
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
      /* v2.66：嵌入 commit-row 内部后，跨过 4 个内容列占整行宽（与原"流式插入"等效） */
      grid-column: 1 / -1;
      /* v2.66：max-height 600 → 300（用户拍板"缩减一半"）。
         4:6 panel 内部 .cd-panel__left/right 各自有 overflow-y: auto，超出仍可滚。 */
      max-height: 300px;
      /* v2.12：panel 内部 grid 4:6 各自滚，accordion 本身隐藏外层滚动避免双滚动条 */
      overflow: hidden;
      /* 滚动条样式：兜底滚动时使用（理论上不会触发） */
      scrollbar-width: thin;
      scrollbar-color: var(--scrollbar-thumb) transparent;
      /* 入场动画 */
      animation: cdAccordionOpen 180ms cubic-bezier(0.16, 1, 0.3, 1);
      /* 让内部 panel 能用 height: 100% 撑满手风琴（v2.12 双栏 4:6 必需） */
      display: flex;
      flex-direction: column;
      /* v2.51：手风琴现在在 .git-graph-rows 内部（rows 是 flex item，已经从 bg 容器右边开始），
         自然对齐 desc 列左边缘 = 对齐 bg 容器右边缘。不再用 margin-left 推 130px（那是 v2.14
         之前 .git-graph-list 在 wrapper 直接子元素时的旧规则，现在双重偏移会让手风琴左边
         出现 130px 空白"未对齐最左侧"）。
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

/* ===== v2.10: 加载更多按钮（顶部操作区） ===== */
.load-more-header-btn {
  padding: 6px 12px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.load-more-header-btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: var(--color-border-hover);
}

.load-more-header-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
