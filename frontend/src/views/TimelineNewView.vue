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
  COL_WIDTH as ASCII_COL_WIDTH,
  DISPLAY_SCALE as ASCII_DISPLAY_SCALE,
  ROW_HEIGHT as ASCII_ROW_HEIGHT,
  flowColorClass,
  flowToPathD,
  parseLines,
  svgHeightPx as asciiSvgHeightPx,
  svgViewBox as asciiSvgViewBox,
  svgWidthPx as asciiSvgWidthPx,
  type Flow,
  type GitGraphCommit,
  type Graph,
  type GraphLine,
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
/** v2.6：前端从 GraphResultDto 渲染出的 SVG 数据（paths 按 color 分组） */
const svgRender = ref<SvgRenderResult | null>(null);
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
/** v1.5 本地仓库绝对路径（Header 小字标注用） */
const localPath = ref<string | null>(null);
/** 是否正在 pull */
const pulling = ref(false);

// ============================================================
// v2.9 commit 详情：行下手风琴（inline 展开）
// ============================================================
// 同时只展开 1 个 commit（VSCode Git Graph 默认行为）。
// 展开面板高度上限 260px → 超出出纵向滚动条（panel 内部已 max-height）。
// 复用 CommitDetailPanel 组件（与 CommitDetailDialog 共用同一份面板 + 缓存）。
/** 当前展开的 commit SHA；null = 全部收起 */
const expandedSha = ref<string | null>(null);

/** Gitea 仓库 URL（用于 "在 Gitea/GitHub 打开 commit" 按钮）。
 *  GitHub 仓库 web URL 模板（https://github.com/${owner}/${repo}）与 Gitea 一致，
 *  这里复用一个计算属性即可，panel 内按 platform 切换 tooltip 文案。 */
const giteaRepoUrl = computed(() => {
  if (!repo.currentProject) return undefined;
  const hostUrl = auth.currentGiteaUrl;
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
      localPath.value = null;
      // 不要在这里 return，让 finally 块清理状态
    } else {
      graphDto.value = dto;
      // 直接渲染为 SVG（path 按 color 分组、节点含坐标）
      svgRender.value = renderGraph(dto);
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
      localPath.value = null;
      // 不要在这里 return，让 finally 块清理状态
    } else {
      localError.value = err.hint ? `${msg}（${err.hint}）` : msg;
      graphDto.value = null;
      svgRender.value = null;
      asciiGraph.value = null;
      asciiLines.value = [];
      localPath.value = null;
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
      const resp = await commitsGitgraphCloneRepo({
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
      _ = resp; // localPath 已后端记下,前端不再需要
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
// - SVG 单位：LANE_WIDTH = 10 px / lane，ROW_HEIGHT = 28 px / row
// - dot 圆点用 HTML overlay（不受 SVG 缩放影响）+ commit 列表逐行对齐

const ROW_H = computed(() =>
  useAsciiGraph.value ? ASCII_ROW_HEIGHT * ASCII_DISPLAY_SCALE : STRUCTURED_ROW_HEIGHT,
); // commit 行高（px），与当前 SVG 路径一致

const viewBox = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return asciiSvgViewBox(asciiGraph.value);
  }
  const r = svgRender.value;
  return r ? `0 0 ${r.width} ${r.height}` : '0 0 0 0';
});
const svgWidth = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return asciiSvgWidthPx(asciiGraph.value);
  }
  const r = svgRender.value;
  return r ? `${r.width}px` : '0px';
});
const svgHeight = computed(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return asciiSvgHeightPx(asciiGraph.value);
  }
  const r = svgRender.value;
  return r ? `${r.height}px` : '0px';
});

// ============================================================
// Path 分组（按 color 分组，对齐 Gitea flow-color-16-N 染色）
// ============================================================
interface PathGroup {
  order: number;
  colorIndex: number; // 0..15，对齐 Gitea Color16()
  colorClass: string; // 'flow-color-16-N'
  colorHex?: string; // v2.6 fix：结构化路径用内联 hex；ASCII fallback 走 CSS class
  d: string; // 单条 path 的 d
}

const pathGroups = computed<PathGroup[]>(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    return [...asciiGraph.value.flows.values()]
      .sort((a, b) => a.id - b.id)
      .map((flow: Flow) => ({
        order: flow.id,
        colorIndex: flow.colorNumber % 16,
        colorClass: flowColorClass(flow.colorNumber),
        d: flowToPathD(flow),
      }));
  }
  const r = svgRender.value;
  if (!r) return [];
  // 保持后端 edge 原始顺序，避免按颜色重排后改变 path 覆盖层级。
  return [...r.paths]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      order: p.order,
      colorIndex: p.colorIndex,
      colorClass: `flow-color-16-${p.colorIndex}`,
      colorHex: p.colorHex,
      d: p.d,
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
  if (useAsciiGraph.value && asciiGraph.value) {
    const graph = asciiGraph.value;
    const byRow = new Map<number, GitGraphCommit>();
    for (const commit of graph.commits) byRow.set(commit.row, commit);
    const maxRow = Math.max(graph.maxRow, asciiLines.value.length - 1, 0);
    const out: DisplayRow[] = [];
    for (let row = 0; row <= maxRow; row++) {
      const commit = byRow.get(row);
      const refs = Array.isArray(commit?.refs) ? commit.refs : [];
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
              refs: refs.map((r) => r.shortName),
              refTypes: refs.map((r) => refTypeFromGroup(r.refGroup)),
            }
          : null,
      });
    }
    return out;
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
 * lane 视觉间距（px）：COL_WIDTH * DISPLAY_SCALE = 5px（v2.16 跟 Gitea 一致）
 * 用户要求"flow 线条间隔调整到 5px"，DISPLAY_SCALE 改 1 后 COL_WIDTH=5 → 5px
 */
const laneSpacing = computed(() => ASCII_COL_WIDTH * ASCII_DISPLAY_SCALE);

/**
 * 圆点视觉直径（px）= 8px（v2.29 用户要求：flow 线条上的圆点调整为 8px 宽）
 * 比 lane 间距（5px）大，圆点视觉上"凸"在 lane 线上、跟 flow 路径有明显视觉对比。
 */
const dotSize = computed(() => 8);

interface DotOverlayNode {
  sha: string;
  subject: string;
  cx: number;
  cy: number;
  /** 圆点直径（px），随 lane 缩放（保证圆点跟 lane 一起变密/变疏） */
  size: number;
  colorHex?: string;
  colorClass?: string;
}

const dotNodes = computed<DotOverlayNode[]>(() => {
  if (useAsciiGraph.value && asciiGraph.value) {
    // 圆点 overlay 是 HTML 绝对定位 px，必须与 SVG viewBox 映射后的像素坐标对齐。
    // SVG viewBox 的 minX = graph.minColumn * COL_WIDTH（见 models.ts svgViewBox），
    // 线条经 viewBox 映射后整体左移 minX*SCALE。圆点若用绝对 px (col*CW+CW)*SCALE
    // 不减 minX，会恒定偏右 minX*SCALE（minColumn 几乎总是 1 → 偏右 10px），
    // 表现为"圆点偏右、线条偏左"。这里减去 minX 对齐。
    const minX = asciiGraph.value.minColumn * ASCII_COL_WIDTH;
    // v2.15：SVG 完整渲染不缩放，圆点 cx 直接用 (col*CW+CW-minX)*SCALE，
    // 圆点 size = lane 间距（10px），圆点视觉上落在 lane 右缘，跨 lane 边界（跟 Gitea 一致）。
    const dot = dotSize.value;
    return asciiGraph.value.commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      cx: (commit.column * ASCII_COL_WIDTH + ASCII_COL_WIDTH - minX) * ASCII_DISPLAY_SCALE,
      cy: (commit.row * ASCII_ROW_HEIGHT + ASCII_ROW_HEIGHT / 2) * ASCII_DISPLAY_SCALE,
      size: dot,
      colorClass: flowColorClass(
        asciiGraph.value?.flows.get(commit.flowId)?.colorNumber ?? commit.flowId,
      ),
    }));
  }
  return (svgRender.value?.nodes ?? []).map((node) => ({
    sha: node.sha,
    subject: node.subject,
    cx: node.cx,
    cy: node.cy,
    size: dotSize.value,
    colorHex: node.colorHex,
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

/** handle 物理位置（px），默认 = svgWidth
 * 用户拖拽后停在 [60, 800] 范围内 */
const userHandleLeft = ref<number | null>(null);
/** 是否正在拖拽 */
const dragging = ref(false);
let dragStartX = 0;
let dragStartHandleLeft = 0;

/** handle 实际位置（用户拖拽 > 自动计算 svgWidth 默认） */
const handleLeft = computed(() => {
  if (userHandleLeft.value !== null) return userHandleLeft.value;
  return parseSvgPx(svgWidth.value);
});

function onDragStart(e: MouseEvent): void {
  e.preventDefault();
  dragging.value = true;
  dragStartX = e.clientX;
  dragStartHandleLeft = handleLeft.value;
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e: MouseEvent): void {
  if (!dragging.value) return;
  // 向左拖 delta 为负 → handleLeft 减小
  const delta = e.clientX - dragStartX;
  // 拖拽边界（用户要求）：
  // - 向左最多距离 wrapper 左边 60px（handle 不能再左）
  // - 向右最多让 git-graph 显示 800px（handle 不能超过 800px）
  const minLeft = 60;
  const maxLeft = 800;
  userHandleLeft.value = Math.max(minLeft, Math.min(maxLeft, dragStartHandleLeft + delta));
}

function onDragEnd(): void {
  dragging.value = false;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

/** 将 px 字符串解析为数字 */
function parseSvgPx(value: string): number {
  const n = Number.parseFloat(value.replace(/px$/, ''));
  return Number.isFinite(n) ? n : 0;
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
  desc: 480, // Description 列（refs + subject）
  author: 160, // Author 列
  date: 120, // Date 列
  sha: 80, // SHA 列
};

/** 列宽存储 key */
const COL_WIDTHS_STORAGE_KEY = 'gitea-kanban:gitgraph:column-widths';

/** 加载持久化的列宽（如果有） */
function loadColWidths(): typeof DEFAULT_COL_WIDTHS {
  try {
    const stored = localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        desc: typeof parsed.desc === 'number' ? parsed.desc : DEFAULT_COL_WIDTHS.desc,
        author: typeof parsed.author === 'number' ? parsed.author : DEFAULT_COL_WIDTHS.author,
        date: typeof parsed.date === 'number' ? parsed.date : DEFAULT_COL_WIDTHS.date,
        sha: typeof parsed.sha === 'number' ? parsed.sha : DEFAULT_COL_WIDTHS.sha,
      };
    }
  } catch {
    /* localStorage 可能不可用（SSR/隐私模式） */
  }
  return { ...DEFAULT_COL_WIDTHS };
}

/** 列宽状态（响应式，初始从 localStorage 加载） */
const colWidths = ref({ ...loadColWidths() });

/** 当前正在拖拽的列分隔手柄（-1 表示无） */
const draggingCol = ref<number>(-1); // 0 = desc-author 间，1 = author-date 间，2 = date-sha 间
let colDragStartX = 0;
let colDragStartWidths: typeof DEFAULT_COL_WIDTHS | null = null;

/** grid-template-columns 字符串（用于 commit-row 和表头） */
const gridTemplateColumns = computed(() => {
  const w = colWidths.value;
  return `${w.desc}px ${w.author}px ${w.date}px ${w.sha}px`;
});

/** 列分隔手柄 mousedown */
function onColHandleMouseDown(e: MouseEvent, colIndex: number): void {
  e.preventDefault();
  e.stopPropagation(); // 防止触发 git-graph 的 handle 拖拽
  draggingCol.value = colIndex;
  colDragStartX = e.clientX;
  colDragStartWidths = { ...colWidths.value };
  document.addEventListener('mousemove', onColHandleMouseMove);
  document.addEventListener('mouseup', onColHandleMouseUp);
}

function onColHandleMouseMove(e: MouseEvent): void {
  if (draggingCol.value < 0 || !colDragStartWidths) return;
  const delta = e.clientX - colDragStartX;
  const w = { ...colDragStartWidths };
  // 拖动列 i 改变列 i 和列 i+1 的宽度（保持总宽度不变）
  if (draggingCol.value === 0) {
    // desc-author 分隔线：desc 加宽 = author 减窄
    const minW = 60;
    const newDesc = Math.max(minW, colDragStartWidths.desc + delta);
    const newAuthor = Math.max(minW, colDragStartWidths.author - (newDesc - colDragStartWidths.desc));
    w.desc = newDesc;
    w.author = newAuthor;
  } else if (draggingCol.value === 1) {
    // author-date 分隔线
    const minW = 60;
    const newAuthor = Math.max(minW, colDragStartWidths.author + delta);
    const newDate = Math.max(minW, colDragStartWidths.date - (newAuthor - colDragStartWidths.author));
    w.author = newAuthor;
    w.date = newDate;
  } else if (draggingCol.value === 2) {
    // date-sha 分隔线
    const minW = 60;
    const newDate = Math.max(minW, colDragStartWidths.date + delta);
    const newSha = Math.max(minW, colDragStartWidths.sha - (newDate - colDragStartWidths.date));
    w.date = newDate;
    w.sha = newSha;
  }
  colWidths.value = w;
}

function onColHandleMouseUp(): void {
  if (draggingCol.value >= 0) {
    // 持久化列宽到 localStorage
    try {
      localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(colWidths.value));
    } catch {
      /* 忽略持久化错误 */
    }
  }
  draggingCol.value = -1;
  colDragStartWidths = null;
  document.removeEventListener('mousemove', onColHandleMouseMove);
  document.removeEventListener('mouseup', onColHandleMouseUp);
}

/** 列分隔手柄位置（用于 inline style，v2.27：相对整个 wrapper 起点）
 *  graph 列宽度 = handleLeft 在前，colHandleLeft 算的是 desc 列左边起点
 *  colIndex=0: desc 列右边 = handleLeft + desc
 *  colIndex=1: desc+author 列右边 = handleLeft + desc + author
 *  colIndex=2: desc+author+date 列右边 = handleLeft + desc + author + date */
function colHandleLeft(colIndex: number): number {
  const w = colWidths.value;
  const base = handleLeft.value;
  if (colIndex === 0) return base + w.desc;
  if (colIndex === 1) return base + w.desc + w.author;
  return base + w.desc + w.author + w.date;
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
        <!-- 本地仓库路径小字标注（v1.5 clone 后返） -->
        <span v-if="localPath" class="timeline-new__local-path">{{ localPath }}</span>
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
    <div class="timeline-new__main" :class="{ 'timeline-new__main--dragging': dragging }">
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
        <div class="git-graph-wrapper" :style="{ '--grid-template-columns': gridTemplateColumns }">
          <!-- v2.22：SourceTree 风格表头（5 列：graph + 描述/作者/日期/SHA） -->
          <div class="git-graph-header" @mousedown.stop>
            <!-- v2.27：第一列 graph 标题格（与 commit-row 第一列同宽） -->
            <div
              class="git-graph-header__col git-graph-header__col--graph"
              :style="{ width: `${handleLeft}px` }"
            >
              <span class="git-graph-header__col-label">Graph</span>
            </div>
            <!-- v2.28：移除 graph 列宽拖拽手柄（用户：表头列的拖拽就够用了） -->
            <div class="git-graph-header__col git-graph-header__col--desc">描述</div>
            <div
              class="git-graph-header__resize"
              @mousedown="(e) => onColHandleMouseDown(e, 0)"
              :class="{ 'git-graph-header__resize--active': draggingCol === 0 }"
              :style="{ left: `${colHandleLeft(0)}px` }"
              title="拖动调整 Description 列宽度"
            />
            <div class="git-graph-header__col git-graph-header__col--author">作者</div>
            <div
              class="git-graph-header__resize"
              @mousedown="(e) => onColHandleMouseDown(e, 1)"
              :class="{ 'git-graph-header__resize--active': draggingCol === 1 }"
              :style="{ left: `${colHandleLeft(1)}px` }"
              title="拖动调整 Author 列宽度"
            />
            <div class="git-graph-header__col git-graph-header__col--date">日期</div>
            <div
              class="git-graph-header__resize"
              @mousedown="(e) => onColHandleMouseDown(e, 2)"
              :class="{ 'git-graph-header__resize--active': draggingCol === 2 }"
              :style="{ left: `${colHandleLeft(2)}px` }"
              title="拖动调整 Date 列宽度"
            />
            <div class="git-graph-header__col git-graph-header__col--sha">SHA</div>
          </div>

          <!-- v2.27：body 区（背景层 SVG + dot overlay + 行层 commit-row） -->
          <div class="git-graph-body" :style="{ minHeight: svgHeight }">
            <!-- 背景层：整张 SVG + 圆点 overlay 铺在 body 底层，commit-row 透明显示 -->
            <div
              class="git-graph-bg"
              :style="{
                width: svgWidth,
                height: svgHeight,
              }"
            >
              <svg
                class="git-graph-svg"
                :viewBox="viewBox"
                :width="svgWidth"
                :height="svgHeight"
              >
                <g
                  v-for="pg in pathGroups"
                  :key="`flow-${pg.colorIndex}`"
                  class="flow-group"
                  :class="pg.colorClass"
                  :data-color="pg.colorIndex"
                >
                  <path
                    v-if="pg.d"
                    :d="pg.d"
                    v-bind="pg.colorHex ? { stroke: pg.colorHex } : {}"
                    stroke-width="2"
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
                  :class="c.colorClass"
                  :style="{
                    left: `${c.cx - c.size / 2}px`,
                    top: `${c.cy - c.size / 2}px`,
                    width: `${c.size}px`,
                    height: `${c.size}px`,
                    backgroundColor: c.colorHex,
                  }"
                  :title="c.subject"
                />
              </div>
            </div>

            <!-- 行层：每行 grid 5 列，第一列是 graph 占位让背景 SVG 透出 -->
            <template v-for="r in allRows" :key="`row-${r.row}`">
              <div
                class="commit-row"
                :class="{
                  'commit-row--relation': !r.commit,
                  'commit-row--clickable': r.commit,
                  'commit-row--expanded': r.commit && expandedSha === r.commit.sha,
                  'commit-row--ascii': useAsciiGraph,
                }"
                :style="{ height: ROW_H + 'px' }"
                :role="r.commit ? 'button' : undefined"
                :tabindex="r.commit ? 0 : undefined"
                :aria-expanded="r.commit ? expandedSha === r.commit.sha : undefined"
                @click="r.commit && toggleCommitDetail(r.commit)"
                @keydown.enter.prevent="r.commit && toggleCommitDetail(r.commit)"
                @keydown.space.prevent="r.commit && toggleCommitDetail(r.commit)"
              >
                <!-- v2.27：graph 占位列（与表头第一列同宽，让背景 SVG 透出） -->
                <div
                  class="commit-row__col commit-row__col--graph"
                  :style="{ width: `${handleLeft}px` }"
                />
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
              </div>
               <!-- v2.14：行下手风琴 —— 流式插入 body 内部，跨整宽（不再只是右列），
                    v2.27：跨整宽包含 graph 列背景，accordion 自身有 elevated 底色 -->
               <div
                 v-if="r.commit && expandedSha === r.commit.sha"
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
            </template>
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
/* v1.5.2 本地仓库路径小字标注（紧接 repo-name 之后） */
.timeline-new__local-path {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-disabled);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
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
 * 不再用 flex 两栏 + sticky，避免 v2.18~v2.26 的 z-index 互相干扰 */
.git-graph-wrapper {
  position: relative;
  min-height: 1px;
  display: block;
  /* v2.27：把 grid-template-columns 透传给 header / body 行（5 列：graph + 4 个内容列） */
  --grid-template-columns-5: var(--grid-template-columns-5, 130px 1fr 1fr 1fr 1fr);
}

/* 表头（5 列 grid） */
.git-graph-header {
  display: grid;
  grid-template-columns: auto var(--grid-template-columns, 480px 160px 120px 80px);
  align-items: center;
  height: 32px;
  background: var(--color-bg-soft, rgba(0, 0, 0, 0.03));
  /* v2.29：用 --color-divider 替换 --color-border（border 在两个主题下都是 transparent，
     所以用户看不到表头底下的 1px 线，无法方便拖拽列分隔手柄） */
  border-bottom: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  border-top: 1px solid var(--color-divider, rgba(0, 0, 0, 0.2));
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  user-select: none;
  padding-right: var(--space-3, 12px);
  position: sticky; /* v2.27：表头 sticky 顶部，body 滚动时表头保持可见 */
  top: 0;
  z-index: 2;
}
.git-graph-header__col {
  padding: 0 var(--space-2, 8px);
  overflow: hidden;
  text-overflow: ellipsis;
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
  background: var(--color-bg-soft, rgba(0, 0, 0, 0.02));
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
/* v2.30：列分隔拖拽手柄 = 平时 1px 透明（与表头 .git-graph-header__col 的 border-right 重叠）
 *  - 命中区是 4px 宽（padding 扩展），但 background-clip: content-box 让背景只渲染中间 1px
 *  - 平时看到的"1px 纵向线"是 content-box 的 background = 透明，所以实际可见的是表头 col 的 border-right
 *  - hover/active 时 content-box background 变绿（仍是 1px 居中） + ::before 显示 16px 中心白线指示
 *  - 用户体验：鼠标 hover 到纵向分隔线 → 立刻变绿 → 按下即可拖拽
 *  - 不再有独立的 6px 胖手柄（用户要求："鼠标滑动到这个分割线后就能左右拖动"） */
.git-graph-header__resize {
  position: absolute;
  top: 0;
  width: 4px;            /* 命中区 4px（centered around the 1px line） */
  height: 100%;
  cursor: col-resize;
  z-index: 4;
  background: transparent;
  transition: background 0.12s;
  /* background-clip: content-box 让 background 只在 content 区域渲染（1px），
     padding 区域（左右各 1.5px）保持透明，命中区是整个 4px */
  background-clip: content-box;
  padding-left: 1.5px;
  padding-right: 1.5px;
}
.git-graph-header__resize:hover,
.git-graph-header__resize--active {
  background: var(--color-primary, #74b830);
}
.git-graph-header__resize:hover::before,
.git-graph-header__resize--active::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 16px;
  background: #fff;
  border-radius: 1px;
}

/* v2.27：body 容器（包含背景层 SVG + 行层 commit-row） */
.git-graph-body {
  position: relative;
  display: block;
  overflow: visible;
}

/* 背景层：SVG + dot overlay，整张铺在 body 左上角（z-index 0） */
.git-graph-bg {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  pointer-events: none; /* 不响应鼠标事件，让 commit-row 接收点击 */
}

/* SVG 自身 */
.git-graph-svg {
  display: block;
}

/* 圆点 overlay：绝对定位在 SVG 之上，固定大小 = lane 间距（10px） */
.commit-dots-overlay {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 2; /* 圆点在 commit list 下层（让 commit 文字浮在圆点上方） */
}
.commit-dot {
  position: absolute;
  /* 默认尺寸（被 inline style 覆盖，inline size = lane 间距 跟随缩放） */
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
 * v2.27：加第一列 graph 占位（auto 宽度，与表头 graph 列同宽） */
.commit-row {
  display: grid;
  grid-template-columns: auto var(--grid-template-columns, 480px 160px 120px 80px);
  align-items: center;
  gap: 0;
  /* 高度由内联 style 绑定 ROW_H（ASCII = 12px, structured = 28px），与 SVG 行高 1:1 对齐 */
  height: 28px; /* fallback（被 inline style 覆盖） */
  /* v2.31 revert：恢复 v2.27 的"行透明 + 内容列自身背景"机制
     用户原意："只需要表头是非透明的背景即可"——表头 .git-graph-header 已有 var(--color-bg-soft) 背景，
     内容区 .commit-row 仍保持透明 + 4 个内容列各自用 var(--color-shell-main-bg) 遮罩 SVG 路径 */
  background: transparent;
  padding: 0 var(--space-3, 12px) 0 0;
  font-size: var(--font-sm, 13px);
  white-space: nowrap;
  overflow: hidden;
  /* v2.28：移除 commit-row 的 border-bottom（用户：下方的内容区，暂时不用 1px 的表格线） */
  border-bottom: none;
  box-sizing: border-box;
  position: relative; /* 自身建立 stacking context，让 col 内容在 SVG 之上 */
  z-index: 1;
}
/* v2.16：ASCII 路径 ROW_H=12px，字体缩小到 11px 适配紧凑行高 */
.commit-row--ascii {
  font-size: 11px;
  line-height: 1;
}
/* v2.27：commit-row hover 时给 4 个内容列加背景（不动 graph 占位列，让 SVG 始终透出） */
.commit-row:hover .commit-row__col--desc,
.commit-row:hover .commit-row__col--author,
.commit-row:hover .commit-row__col--date,
.commit-row:hover .commit-row__col--sha {
  background: var(--color-bg-hover);
}
/* v1.6 可点击的 commit 行 */
.commit-row--clickable {
  cursor: pointer;
}
.commit-row--clickable:hover .commit-row__col--desc,
.commit-row--clickable:hover .commit-row__col--author,
.commit-row--clickable:hover .commit-row__col--date,
.commit-row--clickable:hover .commit-row__col--sha {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.06));
}
.commit-row--clickable:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
/* v2.11：行下手风琴 —— 展开 commit 行背景改为 --color-bg-hover（中性 hover 灰），
 * 让手风琴卡片（elevated 灰白）成为视觉主体，展开行只保留轻量状态指示。
 * v2.27：只覆盖 4 个内容列（不动 graph 占位列） */
.commit-row--clickable.commit-row--expanded .commit-row__col--desc,
.commit-row--clickable.commit-row--expanded .commit-row__col--author,
.commit-row--clickable.commit-row--expanded .commit-row__col--date,
.commit-row--clickable.commit-row--expanded .commit-row__col--sha {
  background: var(--color-bg-hover);
  border-bottom-color: transparent;
}
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--desc,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--author,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--date,
.commit-row--clickable.commit-row--expanded:hover .commit-row__col--sha {
  background: var(--color-bg-hover);
  filter: brightness(1.08);
}
/* Transition 行（merge edge 中间段，无 commit）—— 占位用，与 dot overlay 行节奏对齐
 * 必须保持 min-height: 24px（不要合并 / 不要 display:none） */
.commit-row--relation {
  pointer-events: none;
  background: transparent;
  height: 28px; /* 与 commit-row 一致（= ROW_HEIGHT），dot overlay 行节奏对齐 */
}
.commit-row--relation:hover {
  background: transparent;
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

/* commit-refs 容器：多个 badge 横向排列 */
.commit-refs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  /* 与 commit-subject 之间的间距由 commit-row gap 提供 */
}

.commit-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-size: var(--font-sm, 13px);
}

/* v2.22：列容器（grid item） */
.commit-row__col {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
  overflow: hidden;
  /* v2.31 revert：恢复 v2.27 行为——内容列有自身背景，遮住下方背景层 SVG/圆点（commit-row 整行透明） */
  background: var(--color-shell-main-bg);
}
/* v2.27：graph 占位列（透明背景，让背景层 SVG + dot overlay 透出） */
.commit-row__col--graph {
  width: 130px; /* fallback（被 inline 覆盖 = handleLeft） */
  padding: 0;
  border-right: 1px solid var(--color-border);
  background: transparent;
  flex-shrink: 0;
}
.commit-row__col--desc {
  gap: var(--space-2, 8px);
  padding-right: var(--space-2, 8px);
}
.commit-row__col--author {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-secondary);
}
.commit-row__col--date {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-secondary);
  padding: 0 var(--space-2, 8px);
}
.commit-row__col--sha {
  font-family: monospace;
  font-size: 11px;
  color: var(--color-text-secondary);
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
     * max-height 固定 260px（用户拍板固定阈值，跟 VSCode Git Graph 行为对齐）
     */
    .commit-accordion {
      background: var(--color-bg-elevated);
      border: 1px solid var(--color-divider);
      border-radius: var(--radius-card, 8px);
      box-shadow: var(--shadow-sm);
      max-height: 260px;
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
      /* v2.14：list 内嵌流式布局 —— 上下 margin 让手风琴跟展开 row + 下方 row 视觉呼吸 */
      margin: 4px 12px;
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

/* v2.28：移除 .graph-resize-handle 样式（用户：表头列的拖拽就够用了，不再单独提供 graph 列宽拖拽手柄）
 *  旧规则保留注释供 git blame 参考：
 *  - .graph-resize-handle { position: absolute; ... background: transparent; }
 *  - :hover/--active { background: var(--color-primary); } + ::before 中心白线
 *  - 整段 CSS 与模板中的 <div class="graph-resize-handle" @mousedown="onDragStart" /> 一起删除
 *  - onDragStart 仍保留（用于响应 .git-graph-header 的 mousedown.stop 兜底/未来扩展）
 */
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
