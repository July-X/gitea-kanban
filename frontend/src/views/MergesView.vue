<script setup lang="ts">
/**
 * MergesView —— 仓库合并请求列表
 *
 * 设计（AGENTS §5.2 + ADR-0002（Board 数据模型））：
 *   - 顶栏：仓库名 + tab 切换（全部 / 待合并 / 已合并 / 已关闭）+ 搜索 + 刷新
 *   - 主体：合并请求列表（卡片化：标题 / 编号 / 作者 / 状态徽章 / 合并状态 / 创建时间）
 *   - 详情：点行展开（不跳 gitea web）—— inline 详情 + 合并操作 + 跳 gitea 链接
 *   - 数据：pulls.list IPC → usePullStore
 *
 * 零术语：
 *   - UI 文本**不**出现 PR / merge / rebase 原词
 *     - "合并请求" / "合并" / "变基" / "待合并" / "已合并" / "已关闭" / "草稿"
 *     - 禁用词在文案里**不**出现
 *   - 状态徽章：待合并（绿）/ 已合并（紫）/ 已关闭（灰）/ 草稿（橙边）
 *   - 卡片左侧：state 色边（OVERRIDE §"lane / 列卡片化"）
 *
 * 危险操作（AGENTS §8.3 + 02-architecture §7.3）：
 *   - 合并操作需二次确认（ConfirmDialog）
 *   - 合并到主线分支额外警告
 *   - 有冲突时禁用合并按钮 + 提示去 gitea 处理
 */
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch, type Component } from 'vue';
import {
  GitMerge, GitPullRequestArrow, GitBranch, GitCommit, RefreshCw, Search, ChevronDown, ChevronUp, ChevronRight, ExternalLink,
  XCircle, Pencil, MessageSquare, Send, Loader2, Quote, Copy,
  // v0.7.2 + v0.7.35: 系统事件图标（对齐 Gitea web + GitHub web octicon-* 体系）
  RotateCcw, Bookmark, Tag, Milestone, UserPlus, UserMinus, Calendar,
  Lock, Key, Eye, ArrowLeftRight, Folder, Pin,
  MessageCircle,
  // v0.7.3: 评审事件状态图标
  CheckCircle2,
  // v0.7.4: 评论 header 右侧图标 (smile 表情 / more-horizontal ... 菜单)
  Smile, MoreHorizontal, Link as LinkIcon,
  // v0.7.26: 过期警告行 icon (AlertTriangle 对应 Gitea web octicon-alert)
  AlertTriangle,
} from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { usePullStore, type PullFilter } from '@renderer/stores/pull';
import { useAuthStore } from '@renderer/stores/auth';
import { showToast } from '@renderer/lib/toast';
import { renderMarkdown } from '@renderer/lib/markdown';
// Wails 运行时：BrowserOpenURL 在系统默认浏览器打开 URL
// （v2 是 Wails WebView，<a target="_blank"> / window.open 在这里不可靠）。
import { BrowserOpenURL } from '../../wailsjs/wailsjs/runtime/runtime';
import {
  labelsCreate,
  labelsList,
  membersList,
  pullsReviewCreate,
  pullsUploadAttachment,
} from '@renderer/lib/ipc-client';
import EmptyState from '@renderer/components/EmptyState.vue';
import ReactionBar from '@renderer/components/ReactionBar.vue';
import PullFileComments from '@renderer/components/PullFileComments.vue';
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import type { CollaboratorDto, PullDto, RepoDto, MergeMethod, IssueCommentDto, PullCommitDto, ReviewEvent, TimelineItemDto } from '@renderer/types/dto';

const repo = useRepoStore();
const pullStore = usePullStore();
const pull = pullStore;
const auth = useAuthStore();
/** v0.7.26：当前激活账号的平台（gitea / github）—— merge warning 区域平台感知
 *  - Gitea：WIP toggle 按钮 + "查看命令行提示"折叠块（Gitea web pull_merge_box 真实布局）
 *  - GitHub：只渲染 "Update branch" 按钮（GitHub 端 draft 不可在 conversation 改，
 *    没有"查看命令行提示"折叠块，命令行直接在 merge 按钮下） */
const currentPlatform = computed<'gitea' | 'github'>(() => auth.currentPlatform);
const isGithub = computed<boolean>(() => currentPlatform.value === 'github');
const activeProjectId = computed<string | null>(() => repo.currentProjectId);

// v0.6+ 滚动到底自动加载分页：哨兵 + IntersectionObserver
// - loadMoreSentinel: <li> 在 ul 之后
// - mergesScrollEl: ul 自身（滚动容器，IntersectionObserver 的 root）
const loadMoreSentinel = ref<HTMLElement | null>(null);
const mergesScrollEl = ref<HTMLElement | null>(null);
let loadMoreObserver: IntersectionObserver | null = null;

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/** 评论/描述 markdown 渲染时用的 base URL。v0.7.0 加：把 Gitea web 评论里
 * `[/attachments/...]`、`[/avatars/...]` 这种相对路径改写为绝对 URL，
 * 避免 Wails WebView 的 `wails://wails/` base URL 拼出来请求不到。
 * 取 auth.getAccountUrlByPlatform 走与「在 GitHub 中打开」同逻辑：
 *   Gitea 走 account.giteaUrl，GitHub 自动把 api.github.com → github.com。
 */
const markdownBaseUrl = computed<string | undefined>(() => {
  const platform = (repo.currentProject?.platform ?? 'gitea') as 'gitea' | 'github';
  const url = auth.getAccountUrlByPlatform(platform);
  return url ? url.replace(/\/+$/, '') : undefined;
});

/**
 * 标签颜色样式：对齐 Gitea web 标签渲染
 *
 * Gitea / GitHub API 返回 color 为 6 位 hex 字符串（不含 #）。
 * 防御性处理：如果 color 已带 # 或为空，做归一化避免 ## 前缀或空值。
 *
 * 对齐 Gitea web `modules/templates/util_render.go: RenderLabel` +
 * `modules/util/color.go: ContrastColor`：
 *   - 背景 = label.Color（不透明全色，跟 Gitea web `background-color: #xxxxxx !important` 一致）
 *   - 文字色 = UseLightText 决定（白字/黑字）
 *   - 不需要边框（实心 + 文字色已经够清晰）
 *
 * 之前的 22% alpha 透明背景 + 边框风格在暗色主题下看着太"淡"：
 *   - 暗色背景 + 13% 透明彩色背景 ≈ 看不到
 *   - 边框是唯一辨识，颜色深的话边框也接近看不到
 * 实心全色背景修复后，无论亮 / 暗主题都有强对比，标签一眼能识别。
 *
 * UseLightText 阈值 0.453（相对亮度 WCAG 算法 0.2126R + 0.7152G + 0.0722B），
 * 与 Gitea 端 `web_src/js/utils/color.js` 保持一致。
 */
function labelStyle(color: string | undefined): Record<string, string> {
  const hex = (color ?? '').replace(/^#/, '');
  if (!hex || hex.length < 6) {
    return { '--label-color': '#fff', '--label-bg': '#888' };
  }
  // WCAG 相对亮度 (Gitea `GetRelativeLuminance` 同源)
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const textColor = luminance < 0.453 ? '#fff' : '#1a1a1a';
  return {
    '--label-color': textColor,
    '--label-bg': `#${hex}`,
    '--label-border': 'transparent', // 实心背景后边框无意义，去掉
  };
}

/** 当前选中的合并请求（左右布局：左列表点击 → 右侧详情，null = 未选中显示空态） */
const selectedPR = ref<PullDto | null>(null);

/** v0.7.30 平台感知：tab 列表
 *  - Gitea: 全部 / 待合并 / 已合并 / 已关闭（CLAUDE.md 零术语）
 *  - GitHub: All / Open / Merged / Closed */
const tabs = computed<{ id: PullFilter; label: string }[]>(() => {
  if (isGithub.value) {
    return [
      { id: 'all', label: 'All' },
      { id: 'open', label: 'Open' },
      { id: 'merged', label: 'Merged' },
      { id: 'closed', label: 'Closed' },
    ];
  }
  return [
    { id: 'all', label: '全部' },
    { id: 'open', label: '待合并' },
    { id: 'merged', label: '已合并' },
    { id: 'closed', label: '已关闭' },
  ];
});

// ===== 合并二次确认状态 =====

/**
 * 合并方式选项（人话映射，与 MergeMethodSchema 对齐：gitea swagger 实际支持 4 种）
 *
 * A-3 P2 · B5 修法（2026-06-14）：
 * - 普通合并保留并**默认**选中，hint 改更"人话"
 * - 高级方式（变基/变基+合并/压缩）默认折叠在"高级选项" disclosure 下
 *   PM 看不到默认不点 → 不会被技术术语吓到
 * - 4 种 hint 文案统一为"动作 + 影响"两段式（不再纯技术）
 *
 * v0.7.30 平台感知：GitHub 端走英文 "Create a merge commit" / "Squash and merge" /
 * "Rebase and merge"。GitHub API 不区分 rebase / rebase-merge（统一 rebase），
 * 后端 mapMergeMethodToGitHub 已经把 'rebase-merge' 映射为 'rebase'。
 */
const mergeMethods = computed<{ value: MergeMethod; label: string; hint: string; advanced?: boolean }[]>(() => {
  if (isGithub.value) {
    return [
      { value: 'merge', label: 'Create a merge commit', hint: 'All commits from the head branch will be combined into the base branch via a merge commit.' },
      { value: 'squash', label: 'Squash and merge', hint: 'Combine all commits into a single commit on the base branch.', advanced: true },
      { value: 'rebase', label: 'Rebase and merge', hint: 'Replay all commits onto the base branch (⚠️ rewrites history).', advanced: true },
      // GitHub 没区分 rebase-merge，这里隐藏掉（GitHub adapter 已经把 rebase-merge 映射为 rebase）
    ];
  }
  return [
    { value: 'merge', label: '普通合并', hint: '保留所有提交历史（推荐，最安全）' },
    { value: 'rebase', label: '变基', hint: '重排历史提交（⚠️ 会改写分支历史，慎用）', advanced: true },
    { value: 'rebase-merge', label: '变基 + 合并', hint: '重排后再合并（⚠️ 会改写历史）', advanced: true },
    { value: 'squash', label: '压缩', hint: '把多个提交合成 1 个（⚠️ 会丢掉中间提交信息）', advanced: true },
  ];
});

/** 当前选中的合并方式（A-3 P2：默认走普通合并，避免 PM 被迫选高级） */
const selectedMethod = ref<MergeMethod>('merge');

/** 高级选项 disclosure 开关（A-3 P2 · B5 修法，默认收起） */
const showAdvancedMethods = ref(false);

/** 当前正在合并的合并请求（null = 没在合并） */
const mergingPull = ref<PullDto | null>(null);
const merging = ref(false);
const squashMessage = ref('');
/** v0.6+ 用户拍板：合并后顺手删源分支（默认 false，PM 选 merge 时最容易忘） */
const deleteBranchAfter = ref(false);

/** 当前正在关闭的合并请求（null = 没在关闭） */
const closingPull = ref<PullDto | null>(null);
const closing = ref(false);

/** 二次确认弹窗开关 */
const confirmMergeOpen = ref(false);

/** 删除评论二次确认弹窗开关（v0.5.0 M1） */
const confirmDeleteOpen = ref(false);
/** 待删除的评论信息 */
const deletingComment = ref<{ p: PullDto; c: IssueCommentDto } | null>(null);

/**
 * 合并检查警告区展开状态（v0.7.x 修正）
 *
 * 历史：之前想用 <details>/<summary> 对齐 Gitea web，但用户实际反馈是
 * "点击后只有命令行文字隐藏，外框、图标没有恢复到展开前状态"。
 * 用户明确拍板："收起后只保留标题和图标，连'查看命令行提示'文字链接也隐藏"。
 *
 * 当前实现（用户自定义 UX）：
 *   - 标题行永远在，右侧放一个 Chevron 图标按钮作为 toggle 入口
 *   - 收起时：GitBranch 图标 + 红色标题 + ChevronDown（没有文字链接）
 *   - 展开时：GitBranch 图标 + 红色标题 + ChevronUp + 命令行 help 块
 *   - 完全由 Vue state 控制 v-if 显隐，红框高度跟随内容自适应
 *
 * 这不再是 Gitea web 1:1，而是用户根据实际使用场景拍板的 UX。
 * Gitea web 是把命令行块作为 details 子内容，用户这里是把命令行块作为
 * 标题行下方的可选展开区域，入口换成图标按钮以节省空间。
 */
// v0.7.25：merge warning 拆 3 个独立 state —— 对齐 Gitea web pull_merge_box 多个 item 块
//
// Gitea web 端 pull_merge_box.tmpl 真实布局：
// - WIP 警告：独立 item（带"删除 WIP: 前缀"按钮）
// - 过期警告：独立 item（带"通过合并更新分支"按钮，v0.7.26 TODO）
// - 命令行提示：独立 item（details 默认折叠，展开显示 检出+合并 2 个步骤）
// - 冲突警告：独立 item（v0.7.25 user 反馈后删除 —— Gitea web 冲突在 InfoSections 内）
//
// v0.7.21 之前用 1 个 `mergeWarningOpen` 控制所有 item 展开/折叠 —— 错。
// WIP 警告在 v0.7.23 删了"展开"概念（Gitea web 也没展开），只剩 cmd 提示展开。
const cmdHintOpen = ref(false);
const wipToggleLoading = ref(false);
const branchUpdateLoading = ref(false);

/** v0.7.26："通过合并更新分支"按钮 handler —— 调 store.updateBranch
 *  成功后 store 自动 patchItem 把 commitsBehind 重置为 0，
 *  过期警告行自动隐藏。 */
async function updateBranchByMerge(): Promise<void> {
  const pr = selectedPR.value;
  if (!pr) return;
  if (branchUpdateLoading.value) return;
  branchUpdateLoading.value = true;
  try {
    const projectId = pull.currentProjectId;
    if (!projectId) return;
    await pull.updateBranch(projectId, pr.index, 'merge');
    showToast({ type: 'success', message: '已通过合并更新分支' });
  } catch (e) {
    console.error('[updateBranchByMerge] failed', e);
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '更新分支失败', persistent: true });
  } finally {
    branchUpdateLoading.value = false;
  }
}

/** v0.7.25：从 PR 标题中删除 WIP: / Draft: / [WIP] 前缀 —— 对齐 Gitea web "删除 WIP: 前缀" 按钮 */
async function removeWipPrefix(): Promise<void> {
  const pr = selectedPR.value;
  if (!pr) return;
  const currentTitle = pr.title ?? '';
  // Gitea 默认 WIP prefix 列表（app.ini 可自定义，常见值：WIP: / WIP / Draft: / [WIP] / [Draft]）
  const prefixRegex = /^\s*(?:WIP:\s*|WIP\s+|Draft:\s*|Draft\s+|\[WIP\]\s*|\[Draft\]\s*)+/i;
  const newTitle = currentTitle.replace(prefixRegex, '').trim();
  if (newTitle === currentTitle.trim()) {
    // 没有匹配的前缀，避免误改 —— 给个轻提示
    showToast({ type: 'info', message: '当前标题没有 WIP / Draft 前缀' });
    return;
  }
  wipToggleLoading.value = true;
  try {
    const projectId = pull.currentProjectId;
    if (!projectId) return;
    await pull.updateTitle(projectId, pr.index, newTitle);
    showToast({ type: 'success', message: '已删除 WIP: 前缀' });
  } catch (e) {
    console.error('[removeWipPrefix] failed', e);
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '删除 WIP: 前缀失败', persistent: true });
  } finally {
    wipToggleLoading.value = false;
  }
}

const detailTab = ref<'conversation' | 'commits' | 'files'>('conversation');

/** 模板 ref：评论输入框 + 编辑评论 textarea */
const commentInputRef = ref<HTMLTextAreaElement | null>(null);
const editTextareaRef = ref<HTMLTextAreaElement | null>(null);

/** 打开删除确认弹窗 */
function confirmDeleteComment(p: PullDto, c: IssueCommentDto): void {
  deletingComment.value = { p, c };
  confirmDeleteOpen.value = true;
}

onMounted(async () => {
  // v1.8 KeepAlive：onMounted 仅在首次挂载时触发；数据加载由 activateData() 统一处理
  setupLoadMoreObserver();
  await activateData();
});

/** v1.8 KeepAlive：创建 IntersectionObserver，root 设为滚动容器 mergesScrollEl */
function createLoadMoreObserver(): IntersectionObserver {
  return new IntersectionObserver(
    (entries) => {
      const e = entries[0];
      if (!e || !e.isIntersecting) return;
      // 不在拉中 + 还有更多 才调
      if (pull.loadingMore || !pull.hasMore) return;
      void pull.loadMore();
    },
    {
      root: mergesScrollEl.value ?? null,
      // 哨兵距离滚动容器底部 200px 时提前触发，让用户无感加载
      rootMargin: '0px 0px 200px 0px',
      threshold: 0,
    },
  );
}

/** 首次挂载时：创建 observer + 监听 ref 变化（KeepAlive 恢复时 ref 会重置） */
function setupLoadMoreObserver(): void {
  loadMoreObserver = createLoadMoreObserver();
  if (loadMoreSentinel.value) {
    loadMoreObserver.observe(loadMoreSentinel.value);
  }
}

// v1.8 KeepAlive：从缓存恢复时 ref 可能尚未重新绑定，watch ref 变化后重建 observer
watch([mergesScrollEl, loadMoreSentinel], ([el, sentinel]) => {
  if (!el || !sentinel) return;
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
  }
  loadMoreObserver = createLoadMoreObserver();
  loadMoreObserver.observe(sentinel);
});

/** v1.8 KeepAlive：每次进入视图（含从缓存恢复）时拉数据，已缓存则跳过 */
async function activateData() {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  // v1.4 任务 #statusbar-picker：删除"未选就默认选第一个"逻辑
  if (activeProjectId.value && pull.items.length === 0 && !pull.loading) {
    await loadPulls();
  }
}

/** v1.8 KeepAlive：视图停用（进入缓存）时断开 observer，避免后台内存泄露 */
onDeactivated(() => {
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
});

/**
 * v1.8 KeepAlive：视图从缓存恢复时重建 observer + 按需加载数据
 *
 * 与 onDeactivated 成对：observer 在停用时断开，在恢复时重建。
 * activateData() 内部用 pull.items.length === 0 守卫，仅首次或已清空时发起 IPC，
 * 避免缓存恢复后重复拉取已有数据。
 */
onActivated(() => {
  setupLoadMoreObserver();
  void activateData();
});

onUnmounted(() => {
  // v0.6+：避免 component 卸载后 observer 继续触发回调（内存泄露）
  // v1.8 KeepAlive：非缓存淘汰场景（max 溢出或整个 shell 卸载）仍需清理
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
    // Bug fix: 切换仓库时必须清空右侧详情面板，否则旧 PR 的评论/评审状态
    // 会残留到新仓库，导致操作逻辑错乱（评论发到旧 PR、评审面板错位等）
    selectedPR.value = null;
    detailTab.value = 'conversation';
    // v0.7.8：组件本地 commitsByPR 已删，store 缓存 + reviews / files / files
    // diff 用 store 自己的清空逻辑（store.$reset 或者重新调 list 时按需清）。
    // 这里只清 selectedPR / detailTab 状态。
    if (id) {
      await loadPulls();
    } else {
      pull.$reset?.();
    }
  },
);

async function loadPulls(): Promise<void> {
  if (!activeProjectId.value) return;
  // v0.6+ bugfix：预加载仓库成员，让评论 @ 唤出成员名（之前只在打开属性编辑器才加载）
  await loadMembers();
  try {
    await pull.list(activeProjectId.value, true);
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '加载失败', persistent: true });
  }
}

/**
 * 加载仓库成员，填充 availableMembers（评论 @ 候选）
 *
 * v0.6+ bugfix：之前 availableMembers 只在 openAttrEditor 里加载，
 * 评论 @ 不会触发那个函数 → 候选始终空。
 * 现在在 loadPulls / openAttrEditor 两处都加载，互不干扰。
 */
async function loadMembers(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    const membersResp = await membersList({ projectId: String(activeProjectId.value) });
    const members = (membersResp.items ?? []) as (CollaboratorDto & { login_type?: string })[];
    availableMembers.value = members.map((m) => m.username);
    nonReviewableMembers.value = new Set(
      members
        .filter(
          (m) => m.login_type === 'Organization' || m.login_type === 'organization',
        )
        .map((m) => m.username),
    );
  } catch {
    // 失败不报 toast（评论 @ 是 nice-to-have，不应中断 PR 列表加载）
  }
}

async function onRefresh(): Promise<void> {
  try {
    await pull.refresh();
    showToast({ type: 'success', message: `已刷新，共 ${pull.total} 条` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '刷新失败', persistent: true });
  }
}

/**
 * 选中一个合并请求：左侧列表点击 → 右侧加载详情 + 评论 + 评审
 *
 * 已加载过的评论 panel 不重复拉（避免抖动）
 */
/** v0.7.8：删 v0.7.7 组件本地的 commitsByPR / loadCommits —— push 事件 commit 列表
 * 改用 TimelineItemDto.commitIds 数组（后端 giteaTimelineToItem 解析 body JSON
 * 拿到），不再调 /pulls/{index}/commits 端点做时间窗分组。"代码提交" tab 仍
 * 走 store.pull.loadCommits（拿全量 commits + 提交消息），不依赖这里。
 *
 * 根因（v0.7.7 bug）：
 *   1. 组件本地 commitsByPR 跟 store.pull.commitsByPR 是两个独立 Map，loadCommits
 *      写到组件本地，但 pushEventCommits() 读的是 store —— 永远空
 *   2. pushEventCommits() key 写错（activeRepo.value.id 而不是 pr.index）
 *   3. 即使修了 Map 一致性，v0.7.7 加的 4 个独立字段（OldCommit / NewCommit /
 *      CommitsNum / IsForcePush 顶层）Gitea 1.26+ API 根本不返回，永远空
 */
const filesLoading = ref(false);

const tabLoading = computed(() => ({
  conversation: getTimelinePanel()?.loading ?? false,
  commits: pull.commitsLoading,
  files: filesLoading.value,
}));

function selectPR(p: PullDto): void {
  selectedPR.value = p;
  void loadComments(p);
  // v0.7.x: loadReviews -> store
  if (activeProjectId.value) {
    void pull.loadCommits(activeProjectId.value, p.index);
  }
  void loadFilesForPR(p);
}

/** 加载 PR 文件变动列表（并发，selectPR 时触发） */
async function loadFilesForPR(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  if (pull.filesByPR.get(p.index)?.length) return;
  filesLoading.value = true;
  try {
    await pull.loadFiles(activeProjectId.value, p.index);
    await pull.loadReviewComments(activeProjectId.value, p.index);
  } catch {
    // 失败不阻断
  } finally {
    filesLoading.value = false;
  }
}

/**
 * 生成 commit 在 Git Server（Gitea / GitHub）的 web 链接
 * Gitea:  {baseUrl}/{owner}/{repo}/commit/{sha}
 * GitHub: {baseUrl}/{owner}/{repo}/commit/{sha}
 */
function commitWebUrl(sha: string): string {
  if (!activeRepo.value) return '#';
  const platform = (repo.currentProject?.platform ?? 'gitea') as 'gitea' | 'github';
  const baseUrl = (auth.getAccountUrlByPlatform(platform) || '').replace(/\/+$/, '');
  if (!baseUrl) return '#';
  return `${baseUrl}/${activeRepo.value.owner}/${activeRepo.value.name}/commit/${sha}`;
}

/**
 * v0.7.8：从 store 缓存 pull.commitsByPR.get(pr.index) 按 SHA 短码匹配找
 * commit 详情（subject / authorName）—— 用于 push event commit 列表渲染时
 * 补全 Gitea web 模板显示的提交消息 + 提交者。匹配规则：commit.sha 前 7 位
 * 等于传入 sha 前 7 位（短码匹配，兼容 Gitea 短码 / 全码混用）。
 * 找不到返 null（API 限制 / 缓存未填 / 老 Gitea 不支持），模板降级到只显示 SHA。
 */
function commitDetails(sha: string): PullCommitDto | null {
  if (!selectedPR.value) return null;
  const list = pull.commitsByPR.get(selectedPR.value.index) ?? [];
  const short = sha.slice(0, 7);
  return list.find((c) => c.sha === sha || c.sha.startsWith(short) || sha.startsWith(c.shortSha)) ?? null;
}

/**
 * v0.7.9：head ref 显示文本 —— 优先用 label（真实分支名 `pr-with-labels-366575`），
 * 兜底用 ref（git ref 全路径 `refs/pull/72/head`）。
 *
 * 根因：v0.7.6 改 PR header 格式时只用了 `head.ref` 字段，渲染出 ref id（看着像
 * 一串 ref 路径而不是分支名，user 反馈 "缺少明确的分支记录"）。Gitea 1.20+ API
 * 在 head/base 嵌套对象里额外返 label 字段（真实分支名），Gitea web 端模板用
 * label 渲染，我们对齐这个行为。
 *
 * 兜底场景：GitHub API label == ref / 老 Gitea（< 1.20）没 label 字段 → 用 ref。
 */
function headLabel(p: PullDto): string {
  return p.head.label || p.head.ref;
}
function baseLabel(p: PullDto): string {
  return p.base.label || p.base.ref;
}

/**
 * v0.7.34：head 分支当前是否被删除
 *
 * GitHub Issue Events API:
 *   - `head_ref_deleted` 事件 → 触发 type="delete_branch"（GitHub adapter 映射）
 *   - `head_ref_restored` 事件 → 触发 type="restore_branch"（v0.7.29 加）
 *
 * 当前分支状态由"最后一次相关事件"决定：
 *   - 最后一次是 head_ref_deleted（无后续 restore）→ 分支当前被删
 *   - 最后一次是 head_ref_restored / 没有相关事件 → 分支当前存在
 *
 * UI 表现（对齐 GitHub web）：
 *   - 分支被删：timeline 上 delete_branch event 旁显示 "Restore branch" 按钮
 *     + panel "Closed with unmerged commits" 描述简化成 "This pull request is closed."（不提及 branch）
 *     + panel 不显示 "Delete branch" 按钮（branch 已经被删了，再删一次是 no-op）
 *   - 分支存在：timeline 上 delete_branch event 旁**不**显示按钮
 *     + panel 描述 "This pull request is closed, but the `{branch}` branch has unmerged commits."
 *     + panel 显示 "Delete branch" 按钮
 *
 * timeline 已按 v0.7.33 升序（oldest first），item.created 是 ISO 8601 字符串可直接比较。
 */
const isBranchCurrentlyDeleted = computed<boolean>(() => {
  const items = getTimelinePanel().items ?? [];
  let lastDeleteAt = '';
  let lastRestoreAt = '';
  for (const item of items) {
    if (item.type === 'delete_branch') lastDeleteAt = item.created;
    else if (item.type === 'restore_branch') lastRestoreAt = item.created;
  }
  return lastDeleteAt > lastRestoreAt; // ISO 8601 字符串比较：最后 delete 晚于最后 restore → 当前被删
});

/** 在系统浏览器打开 commit 页面 */
function openCommitExternal(sha: string): void {
  const url = commitWebUrl(sha);
  if (url && url !== '#') BrowserOpenURL(url);
}

/** 复制 SHA 到剪贴板 */
async function copySha(sha: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sha);
    showToast({ type: 'success', message: '已复制 SHA' });
  } catch {
    showToast({ type: 'error', message: '复制失败' });
  }
}

/** 生成 gitea / github web 链接（reactive：跟随 giteaUrl / activeRepo 变化）
 *
 * v0.6+ bugfix：原代码走 auth.currentGiteaUrl，对 GitHub 账号会拼出
 *   https://api.github.com/{owner}/{repo}/pulls/{N}
 * —— api.github.com 是 API endpoint，不是网页，浏览器看到 JSON。
 *
 * 现在走 auth.getAccountUrlByPlatform(currentProject.platform)，
 * 与 CommitDetailPanel 「在 GitHub 中打开」 同逻辑（见 auth.ts 注释）。
 */
function giteaPullUrl(p: PullDto): string {
  if (!activeRepo.value) return '#';
  const platform = (repo.currentProject?.platform ?? 'gitea') as 'gitea' | 'github';
  // v0.6+ bugfix：GitHub 账号走专用 helper，自动把 api.github.com → github.com
  const baseUrl = (auth.getAccountUrlByPlatform(platform) || '').replace(/\/+$/, '');
  if (!baseUrl) return '#';
  // v0.6+ bugfix：GitHub web URL 用单数 /pull/N，Gitea web URL 用复数 /pulls/N
  //   https://github.com/{owner}/{repo}/pull/{N}     ← GitHub
  //   https://gitea.example.com/{owner}/{repo}/pulls/{N}  ← Gitea
  // 上次错拼 GitHub 为 /pulls/N → GitHub 返 404
  const pathSegment = platform === 'github' ? 'pull' : 'pulls';
  return `${baseUrl}/${activeRepo.value.owner}/${activeRepo.value.name}/${pathSegment}/${p.index}`;
}

/**
 * v0.7.6：生成分支 web 链接 —— 对齐 Gitea web `templates/repo/issue/view_title.tmpl`
 * 中分支链接的格式 /{owner}/{repo}/src/branch/{ref}。
 *
 * GitHub web URL 用 /{owner}/{repo}/tree/{ref}（不是 branch）。
 */
function branchWebUrl(ref: string): string {
  if (!activeRepo.value) return '#';
  const platform = (repo.currentProject?.platform ?? 'gitea') as 'gitea' | 'github';
  const baseUrl = (auth.getAccountUrlByPlatform(platform) || '').replace(/\/+$/, '');
  if (!baseUrl) return '#';
  // Gitea: /{owner}/{repo}/src/branch/{ref} | GitHub: /{owner}/{repo}/tree/{ref}
  const pathSegment = platform === 'github' ? 'tree' : 'src/branch';
  return `${baseUrl}/${activeRepo.value.owner}/${activeRepo.value.name}/${pathSegment}/${encodeURIComponent(ref)}`;
}

/** 在系统浏览器打开合并请求页面（Wails BrowserOpenURL，window.open / <a target=_blank>
 * 在 Wails WebView 下不可靠）。 */
function openPullExternal(p: PullDto): void {
  const url = giteaPullUrl(p);
  if (url && url !== '#') BrowserOpenURL(url);
}

/** 判断目标分支是否是主线分支（需要额外警告） */
function isMainBranch(refName: string): boolean {
  const mainNames = ['main', 'master', 'trunk', 'develop'];
  return mainNames.includes(refName.toLowerCase());
}

/** 需要 squash commitMessage */
function needsCommitMessage(method: MergeMethod): boolean {
  return method === 'squash';
}

/** 点击合并按钮 → 弹二次确认 */
function requestMerge(p: PullDto): void {
  if (p.hasConflicts || !p.mergeable) return;
  mergingPull.value = p;
  selectedMethod.value = 'merge';
  squashMessage.value = '';
  deleteBranchAfter.value = false;
  confirmMergeOpen.value = true;
}

/** 二次确认 → 执行合并 */
async function performMerge(): Promise<void> {
  const p = mergingPull.value;
  if (!p || !activeProjectId.value) return;
  confirmMergeOpen.value = false;
  merging.value = true;
  try {
    const result = await pull.mergePull({
      projectId: activeProjectId.value,
      index: p.index,
      method: selectedMethod.value,
      commitMessage: needsCommitMessage(selectedMethod.value) ? squashMessage.value : undefined,
      deleteBranchAfter: deleteBranchAfter.value || undefined,
    });
    if (result.merged) {
      showToast({ type: 'success', message: `#${p.index} 合并成功` });
    } else {
      showToast({ type: 'error', message: `#${p.index} 合并未完成：${result.message || '未知原因'}`, persistent: true });
    }
  } catch (e) {
    const err = e as { messageText?: string; hint?: string };
    showToast({ type: 'error', message: err.messageText ?? '合并失败', persistent: true });
  } finally {
    merging.value = false;
    mergingPull.value = null;
  }
}

/** 取消合并确认 */
function cancelMerge(): void {
  confirmMergeOpen.value = false;
  mergingPull.value = null;
}

// ===== 关闭合并请求（不合并） =====

/** 二次确认弹窗开关（关闭用） */
const confirmCloseOpen = ref(false);

// ===== 属性编辑器 =====

/** 属性编辑器状态 */
const attrEditorOpen = ref(false);
const attrEditorSaving = ref(false);
const editingPull = ref<PullDto | null>(null);
const editingLabels = ref<string[]>([]);
const editingAssignees = ref<string[]>([]);
const editingReviewers = ref<string[]>([]);
const editingMilestone = ref('');

/** 可用标签列表（从 store 或 IPC 获取） */
const availableLabels = ref<{ name: string; color: string }[]>([]);
/** 可用成员列表 */
const availableMembers = ref<string[]>([]);
/** 可用里程碑列表（v0.6.0） */
const availableMilestones = ref<{ title: string; state: string }[]>([]);

/** 不可作评审人的成员（gitea 1.x 限制：组织账号不能作评审人） */
const nonReviewableMembers = ref<Set<string>>(new Set());

/** 新建标签相关 state */
const showNewLabelInput = ref(false);
const newLabelName = ref('');
const newLabelColor = ref('#fbca04');
const creatingLabel = ref(false);

/** 打开属性编辑器 */
async function openAttrEditor(p: PullDto): Promise<void> {
  editingPull.value = p;
  editingLabels.value = (p.labels ?? []).map(l => l.name);
  editingAssignees.value = (p.assignees ?? []).map(a => a.username);
  editingReviewers.value = (p.reviewers ?? []).map(r => r.username);
  attrEditorOpen.value = true;

  // 加载可用标签和成员
  if (activeProjectId.value) {
    try {
      const labelsResp = await labelsList({ projectId: String(activeProjectId.value) });
      availableLabels.value = labelsResp.items ?? [];
    } catch { /* 忽略 */ }
    // v0.6+ bugfix：复用 loadMembers，避免重复代码
    await loadMembers();
    // v0.7.0：加载里程碑 / 成员（gitea state='all' / github state='open'）
    // loadAttrEditorData 内部按 platform 派发 state，不再需前端 v-if 守护。
    try {
      await pullStore.loadAttrEditorData(String(activeProjectId.value));
      availableMilestones.value = pullStore.availableMilestones;
      // loadMembers 已设置 availableMembers = string[]；这里覆盖为 rich 对象
      availableMembers.value = pullStore.availableMembers.map((m) => m.username ?? '');
    } catch { /* 静默 */ }
  }
}

/** 关闭属性编辑器 */
function closeAttrEditor(): void {
  attrEditorOpen.value = false;
  editingPull.value = null;
}

/** 切换标签选择 */
function toggleLabel(name: string): void {
  const idx = editingLabels.value.indexOf(name);
  if (idx >= 0) editingLabels.value.splice(idx, 1);
  else editingLabels.value.push(name);
}

/** 切换评审人选择 */
function toggleReviewer(name: string): void {
  const idx = editingReviewers.value.indexOf(name);
  if (idx >= 0) editingReviewers.value.splice(idx, 1);
  else editingReviewers.value.push(name);
}

/** 创建新标签（同步到 gitea） */
async function createNewLabel(): Promise<void> {
  if (!activeProjectId.value || !newLabelName.value.trim()) return;
  creatingLabel.value = true;
  try {
    // 去掉 # 前缀
    const color = newLabelColor.value.replace(/^#/, '');
    const newLabel = await labelsCreate({
      projectId: String(activeProjectId.value),
      name: newLabelName.value.trim(),
      color,
    });
    // 立即加到可用列表和已选列表
    availableLabels.value = [...availableLabels.value, { name: newLabel.name, color: newLabel.color }];
    if (!editingLabels.value.includes(newLabel.name)) {
      editingLabels.value = [...editingLabels.value, newLabel.name];
    }
    // 隐藏输入框 + 重置
    showNewLabelInput.value = false;
    newLabelName.value = '';
    showToast({ type: 'success', message: `标签 "${newLabel.name}" 已创建` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '创建标签失败', persistent: true });
  } finally {
    creatingLabel.value = false;
  }
}

/** 保存属性（逐字段尝试，一个失败不影响其他） */
async function saveAttrs(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  const projectId = String(activeProjectId.value); // 显式解 ref
  attrEditorSaving.value = true;
  const errors: string[] = [];

  // 1. 更新标签（替换所有标签）
  try {
    await pullStore.updateLabels(projectId, p.index, editingLabels.value);
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`标签: ${err.messageText ?? err.message ?? '失败'}`);
  }

  // 2. 更新指派人（多选，空数组 = 清除指派人）
  try {
    await pullStore.updateAssignees(projectId, p.index, editingAssignees.value);
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`指派人: ${err.messageText ?? err.message ?? '失败'}`);
  }

  // 3. 更新评审人（过滤掉组织账号——gitea 1.x 不允许）
  const validReviewers = editingReviewers.value.filter(r => !nonReviewableMembers.value.has(r));
  try {
    await pullStore.updateReviewers(projectId, p.index, validReviewers);
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    const msg = err.messageText ?? err.message ?? '失败';
    // 保留 messageText 完整内容（含 gitea 真实原因）
    errors.push(`评审人: ${msg}`);
  }

  // 4. 更新里程碑（v0.6.0）
  try {
    await pullStore.updateMilestone(projectId, p.index, editingMilestone.value);
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`里程碑: ${err.messageText ?? err.message ?? '失败'}`);
  }

  attrEditorSaving.value = false;

  if (errors.length > 0) {
    // 错误（业务/系统）→ persistent toast（不自动消失，必须用户点击关闭）
    showToast({
      type: 'error',
      message: errors.join('\n'),
      persistent: true,
    });
  } else {
    showToast({ type: 'success', message: `#${p.index} 属性已更新` });
    closeAttrEditor();
  }
  // 始终刷新列表（部分成功也能看到最新状态）
  await pull.refresh();
}

/** 点击关闭按钮 → 弹二次确认 */
function requestClose(p: PullDto): void {
  closingPull.value = p;
  confirmCloseOpen.value = true;
}

/** 二次确认 → 执行关闭 */
async function performClose(): Promise<void> {
  const p = closingPull.value;
  if (!p || !activeProjectId.value) return;
  confirmCloseOpen.value = false;
  closing.value = true;
  try {
    const result = await pull.closePull({
      projectId: activeProjectId.value,
      index: p.index,
    });
    if (result.closed) {
      showToast({ type: 'success', message: `#${p.index} 已关闭` });
    }
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '关闭失败', persistent: true });
  } finally {
    closing.value = false;
    closingPull.value = null;
  }
}

/** 取消关闭确认 */
function cancelClose(): void {
  confirmCloseOpen.value = false;
  closingPull.value = null;
}

/** v0.7.30 平台感知：关闭确认描述文案
 *  - Gitea 端：中文 + "在 gitea 页面重新打开"
 *  - GitHub 端：英文 + "on GitHub" */
const closeConfirmDescription = computed(() => {
  const p = closingPull.value;
  if (!p) return '';
  if (isGithub.value) {
    return `Will close #${p.index} "${p.title}".\n\nAfter closing, this pull request cannot be merged again — you'll need to reopen it on GitHub.`;
  }
  return `将关闭 #${p.index}「${p.title}」。\n\n关闭后此合并请求将不再可合并，需要在 gitea 页面重新打开。`;
});

// ===== 合并请求对话（评论）=====
//
// 设计（v1.2 · task #25）：
//   - 策略：展开手风琴时拉一次评论；发送评论后立即重拉（拿到权威评论；新评论 id / 时间）
//   - 数据源：复用 issues.comment.list / create（gitea 共享 /issues/{index}/comments 端点）
//   - 渲染：markdown-it + DOMPurify（见 frontend/src/lib/markdown.ts）
//   - 状态：Map<index, { items, loading, error, posting }> —— 一个仓库手风琴可同时展开多个合并请求，
//     每个合并请求维护自己的评论 state（避免互相污染，也避免刷新合并请求列表时清空评论）
//   - 当前用户评论高亮：拿到 auth.currentUsername 后做 author === self 判断（v1.2 best-effort）

/** 每合并请求一份评论 state */
// v0.7.x

/** 新评论输入草稿（每个合并请求一份，避免切到别的合并请求输入框被清空） */
const commentDrafts = ref<Map<number, string>>(new Map());

/** v1.4 · @ 提及状态：每个合并请求维护自己的"@ 候选" + "激活索引"
 *   mentionKey: 输入框内当前 @ 触发的关键词（不含 @ 本身）
 *   mentionOpenIdx: 下拉中当前选中项的索引
 */
const mentionState = ref<Map<number, { key: string; cursor: number; activeIdx: number }>>(new Map());

/** 当前用户 username（用来在评论旁标"我" / 加视觉高亮） */
const currentUsername = computed<string | null>(() => auth.currentUser?.login ?? null);

// ===== 评审（v0.5.0 M3） =====

// v0.7.x: reviewPanels 移到 store

/** 每个合并请求的评审编辑器开关 + 选中的 event */
const reviewEditorOpen = ref<Set<number>>(new Set());
const reviewEditorEvent = ref<Map<number, ReviewEvent>>(new Map());
const reviewEditorBody = ref<Map<number, string>>(new Map());
const reviewSubmitting = ref(false);

// v0.7.x: getReviewPanel/loadReviews 移到 store

function toggleReviewEditor(p: PullDto, event: ReviewEvent): void {
  if (reviewEditorOpen.value.has(p.index)) {
    reviewEditorOpen.value.delete(p.index);
    reviewEditorBody.value.delete(p.index);
  } else {
    reviewEditorOpen.value = new Set([p.index]); // 单一编辑态
    reviewEditorEvent.value.set(p.index, event);
    reviewEditorBody.value.set(p.index, '');
  }
}

async function submitReview(p: PullDto): Promise<void> {
  if (!activeProjectId.value || reviewSubmitting.value) return;
  const event = reviewEditorEvent.value.get(p.index);
  if (!event) return;
  const body = reviewEditorBody.value.get(p.index) ?? '';
  reviewSubmitting.value = true;
  try {
    await pullsReviewCreate({
      projectId: activeProjectId.value,
      index: p.index,
      body: body.trim(),
      event,
    });
    // 刷新评审列表（让 review 事件卡片进 timelineItems）
    await pull.fetchReviews(p);
    // 关键：Gitea 在 POST /pulls/{index}/reviews 时,若 body 非空,会同时插入一条
    // CommentTypeReview 类型的 issue comment,该 comment 出现在 /issues/{index}/comments
    // 端点；不重拉的话,对话 Tab 的 comment 部分是陈旧的（用户填的正文不见了）。
    // 同步 store.commentPanels,让 pull.timelineItems 实时反映新内容。
    await fetchComments(p);
    reviewEditorOpen.value.delete(p.index);
    reviewEditorBody.value.delete(p.index);
    showToast({ type: 'success', message: '评审已提交' });
  } catch (e) {
    const err = e as { messageText?: string; hint?: string };
    showToast({ type: 'error', message: err.messageText ?? '提交评审失败', persistent: true });
  } finally {
    reviewSubmitting.value = false;
  }
}

/** v0.7.30：评审状态标签 platform-aware
 *  Gitea 端走中文（零术语）："已批准" / "请求修改" / "已评论"
 *  GitHub 端走英文：approved / requested changes / commented */
function reviewStateLabel(state: string | undefined): string {
  if (isGithub.value) {
    switch (state) {
      case 'approved': return 'approved these changes';
      case 'changes_requested': return 'requested changes';
      case 'commented': return 'left a comment';
      case 'dismissed': return 'dismissed';
      default: return state ?? 'left a comment';
    }
  }
  switch (state) {
    case 'approved': return '已批准';
    case 'changes_requested': return '请求修改';
    case 'commented': return '已评论';
    default: return state ?? '已评论';
  }
}

/** v0.7.30：评审事件标签 platform-aware */
function reviewEventLabel(event: ReviewEvent): string {
  if (isGithub.value) {
    switch (event) {
      case 'approve': return 'Approve';
      case 'request_changes': return 'Request changes';
      case 'comment': return 'Comment';
      default: return event;
    }
  }
  switch (event) {
    case 'approve': return '批准此合并请求';
    case 'request_changes': return '请求修改';
    case 'comment': return '仅评论';
    default: return event;
  }
}

/**
 * v0.7.5：系统事件 verb 文本（item 级别）
 *
 * 严格对齐 Gitea web 中文 locale（options/locale/locale_en-US.json + locales/zh-CN）：
 *   - type='assignees' + removedAssignee=true  → '取消了自指派' / '取消了指派'
 *   - type='assignees' + removedAssignee=false → '自指派' / '指派给'
 *   - type='review_request' + !removed         → '请求评审'
 *   - type='review_request' + removed          → '取消了评审请求'
 *   - type='merge'                              → '合并了提交'（SHA + branch 在 inline）
 *   - type='close' / 'reopen' / 'pin' / 'unpin' → '关闭了此合并请求' / '重新开启了此合并请求' / '置顶了此合并请求' / '取消了此合并请求的置顶'
 *   - type='ref'                                → '引用了' / '关闭了引用' / '重新开启了引用'（refAction 区分）
 */
function systemEventVerb(item: TimelineItemDto): string {
  if (item.type === 'assignees') {
    // v0.7.13 根因修复：assignees verb 文案对齐 Gitea web 中文 locale
    // （user 反馈 ⑫"自指派应该改成指派给自己，指派给其他人应该是指派给X"）：
    //   - assignee.login == user.login（自指派）：
    //     - add → '指派给自己'
    //     - remove → '取消指派给自己'
    //   - 否则指派给其他人（带 assignee 用户名）：
    //     - add → '指派给 {X}'
    //     - remove → '取消指派给 {X}'
    // v0.7.11 写"自指派" + "指派给" + "取消自指派" + "取消了指派" 4 字符串，
    // v0.7.13 改成"指派给自己" + "指派给 X" + "取消指派给自己" + "取消指派给 X"，
    // 对齐 Gitea web `repo.issues.self_assigned` / `assigned_to` / `unassigned` /
    // `unassigned_from` 中文 locale。
    const isSelfAssign = item.assignee?.username && item.author?.username
      && item.assignee.username === item.author.username;
    const assigneeName = displayName(item.assignee);
    if (isSelfAssign) {
      return item.removedAssignee ? '取消指派给自己' : '指派给自己';
    }
    return item.removedAssignee ? `取消指派给 ${assigneeName}` : `指派给 ${assigneeName}`;
  }
  if (item.type === 'review_request') {
    return item.removedAssignee ? '取消了评审请求' : '请求评审';
  }
  if (item.type === 'close') return '关闭了此合并请求';
  if (item.type === 'reopen') return '重新开启了此合并请求';
  if (item.type === 'merge') return '合并提交'; // v0.7.15：去掉"了"字 —— 对齐 Gitea web "合并提交 {sha} 到 {branch}" 渲染（SHA + branch 在主行）
  if (item.type === 'push') {
    // v0.7.8 根因修复：v0.7.5 写的 body regex `/(\d+)\s*(commits?|个?提交|...)/i`
    // 抠数字 —— 实际 Gitea 1.26+ body 是 JSON 字符串 `{"is_force_push":false,
    // "commit_ids":["sha1"]}`，永远不匹配。v0.7.8 改：直接用 commitIds 数组长度
    // （后端 giteaTimelineToItem 解析 body JSON 拿到的）。
    //
    // 对齐 Gitea web 中文 locale（`repo.pulls.push_commit_1` / `push_commits_n`），
    // 单复数走 TrN：`n=1 → '推送了 1 个提交'` / `n>1 → '推送了 N 个提交'`。
    const n = item.commitIds?.length ?? 0;
    if (n === 1) return '推送了 1 个提交';
    if (n > 1) return `推送了 ${n} 个提交`;
    // 0 个 commit（body 解析失败 / 老 Gitea 兼容路径）→ 兜底
    return '推送了新提交';
  }
  if (item.type === 'pin') return '置顶了此合并请求';
  if (item.type === 'unpin') return '取消了此合并请求的置顶';
  if (item.type === 'label') {
    // v0.7.6：label 事件三态文案 —— 对齐 Gitea web
    // `repo.issues.add_label` / `remove_label` / `add_remove_labels` 中文 locale +
    // TrN 单复数（TrN(len(added), "add_label", "add_labels", ...)）。
    //
    // 单条 label event 也有 addedLabels/removedLabels 数组（store 拆好了），
    // 三态判定走数组长度：added && !removed → "添加了" / !added && removed → "移除了" /
    // 都存在 → "修改了"（add+remove 混合）。
    const added = item.addedLabels ?? [];
    const removed = item.removedLabels ?? [];
    if (added.length > 0 && removed.length === 0) {
      return added.length === 1 ? '添加了标签' : '添加了多个标签';
    }
    if (added.length === 0 && removed.length > 0) {
      return removed.length === 1 ? '移除了标签' : '移除了多个标签';
    }
    if (added.length > 0 && removed.length > 0) {
      return '修改了标签';
    }
    // 兼容：合并前单数 label 字段（store 未处理）
    return '修改了标签';
  }
  if (item.type === 'milestone') return '修改了里程碑';
  if (item.type === 'title' || item.type === 'change_title') {
    // v0.7.6：WIP toggle 特殊渲染 —— 对齐 Gitea web
    // `modules/templates/util_render_comment.go: commentTimelineEventIsWipToggle` +
    // `repo.pulls.marked_as_work_in_progress_at` / `marked_as_ready_for_review_at` 中文 locale。
    //
    // 当用户在 PR 详情页拖"标记为 WIP / 标记为可评审"按钮时，Gitea 端会改标题
    // 加/去掉 "WIP:" / "Draft:" 前缀，并触发一条 change_title 事件。
    // 后端检测到这种特殊改标题会设 isWipToggle=true，前端走下面 2 个分支。
    if (item.isWipToggle) {
      return item.isWip ? '已将合并请求标记为进行中' : '已将合并请求标记为可评审';
    }
    return '修改了标题';
  }
  // v0.7.12 根因修复：delete_branch 事件分支名从 inline 块移到主行 verb，
  // 保证显示（user 反馈 ⑨ / ⑪ "分支信息还是有缺失"——v0.7.4 加的 inline 块
  // 代码逻辑对，但 v0.7.10 改 CSS 后 user 实际看不到 inline 块）。
  // verb 直接拼接分支名（去掉 refs/heads/ 前缀兜底）：
  //   - Gitea: 通常返 "cx-same-057405" 短码
  //   - 老 Gitea / GitHub: 返 "refs/heads/branch" 全路径 → strip 掉前缀
  // 对齐 Gitea web "kanban_bot 于 3 周前 删除分支 cx-same-057405" 渲染。
  //
  // v0.7.27.1 根因修复：GitHub Issue Events 端 `head_ref_deleted` event **不**返
  // head ref name（只有 GraphQL timelineItems 才返），item.oldRef 一直是空。
  // 之前 v0.7.27 错把 commit SHA 填到 OldRef 字段，verb 拼接出错的"SHA 字符串"。
  // 修法：OldRef 为空时，兜底用 selectedPR?.head?.label（PR 详情 head 字段，
  // v0.7.9 已有 Gitea 1.20+ / GitHub 全支持，返真实分支名如 "int-test-1783..."）。
  // 跟 Gitea 端行为对齐："X 于 Y 删除分支 feature-branch-123"。
  const headRef = item.oldRef?.replace(/^refs\/heads\//, '') || selectedPR.value?.head?.label;
  if (item.type === 'delete_branch' && headRef) {
    return `删除分支 ${headRef}`;
  }
  if (item.type === 'delete_branch') return '删除分支'; // v0.7.11 去掉"了"字（无 oldRef fallback）
  // v0.7.29：head_ref_restored event 渲染（GitHub 端独立 type="restore_branch"）
  // verb 拼接分支名（走 selectedPR.head.label 兜底，GitHub events 端不返 head ref name）
  if (item.type === 'restore_branch' && headRef) {
    return `恢复了分支 ${headRef}`;
  }
  if (item.type === 'restore_branch') return '恢复了分支';

  // v0.7.27.1 平台感知：change_target_branch 在 GitHub 端 `base_ref_changed` event
  // 不返 base ref name（只有 GraphQL 返），item.oldRef/newRef 留空。
  // 兜底用 selectedPR?.base?.label（当前 base，跟 item 时间点不严格匹配，但 80% 场景够用）。
  // v0.7.28 计划从 GraphQL 拉 base ref 改前/改后名字。
  if (item.type === 'change_target_branch' && (item.oldRef || item.newRef)) {
    return `修改了目标分支 ${item.oldRef || '?'} → ${item.newRef || '?'}`;
  }
  if (item.type === 'change_target_branch' && selectedPR.value?.base?.label) {
    return `修改了目标分支（当前 base: ${selectedPR.value.base.label}）`;
  }
  if (item.type === 'change_target_branch') return '修改了目标分支';
  if (item.type === 'lock') return '锁定了此合并请求';
  if (item.type === 'unlock') return '解锁了此合并请求';
  if (item.type === 'due_date') return '设置了截止日期';
  if (item.type === 'change_due_date') return '修改了截止日期';
  if (item.type === 'remove_due_date') return '移除了截止日期';
  if (item.type === 'commit_ref') return '引用了此提交';
  if (item.type === 'issue_ref' || item.type === 'pull_ref' || item.type === 'comment_ref' || item.type === 'change_issue_ref') {
    if (item.refAction === 'close') return '通过引用关闭了';
    if (item.refAction === 'reopen') return '通过引用重新开启了';
    if (item.refAction === 'cross') return '交叉引用了';
    return '引用了';
  }
  if (item.type === 'add_dependency') return '添加了依赖';
  if (item.type === 'remove_dependency') return '移除了依赖';
  if (item.type === 'dismiss_review') return '驳回了评审';
  if (item.type === 'move') return '移动了项目';
  // v0.7.5 补全：之前字典缺这些 type → 走 '事件' fallback
  if (item.type === 'start_tracking') return '开始工作';
  if (item.type === 'stop_tracking') return '完成了计时';
  if (item.type === 'add_time_manual') return '添加了工作时间';
  if (item.type === 'cancel_tracking') return '取消了计时';
  if (item.type === 'delete_time_manual') return '删除了工作时间';
  if (item.type === 'change_time_estimate') return '修改了时间估算';
  if (item.type === 'pr_scheduled_to_auto_merge') return '已排定自动合并';
  if (item.type === 'pr_unscheduled_to_auto_merge') return '已取消排定自动合并';
  if (item.type === 'project') return '修改了项目';
  if (item.type === 'project_column') return '移动到了项目列';
  return '';  // 未识别 type：返回空字符串，不显示 verb（不显示 '事件' 通用词）
}

/**
 * v0.7.30：GitHub 端 systemEventVerb —— 严格对齐 GitHub web 实际渲染
 *
 * 与 Gitea 端 systemEventVerb 的关键差异：
 *  1. 格式：GitHub web 走 "actor verb body time"（无"于"介词），不是 Gitea "actor 于 time verb"
 *  2. 语言：英文（GitHub web 端 i18n 默认是英文 locale en-US）
 *  3. body 字段：GitHub 端 verb 自带 body（如 "added the {label} label" / "closed this"），
 *     Gitea 端 verb 只返回短语主体（"添加了标签"），body 在模板中拼接
 *
 * Verb 列表参考 GitHub web timeline 实际渲染 + Issues Events API event type 文档
 * (https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)。
 *
 * 调用方式：systemEventVerb(item) wrapper 根据 isGithub.value 自动选 Gitea / GitHub 风格。
 */
function githubSystemEventVerb(item: TimelineItemDto): string {
  // 辅助：根据 isSelfAssign 判断自指派 / 指派他人
  const isSelfAssignForAssignees = (() => {
    const a = item.assignee;
    const u = item.author;
    if (!a || !u) return false;
    return a.username === u.username;
  })();

  if (item.type === 'assignees') {
    if (isSelfAssignForAssignees) {
      return item.removedAssignee ? 'removed their assignment' : 'self-assigned this';
    }
    const name = displayName(item.assignee);
    return item.removedAssignee ? `unassigned ${name}` : `assigned ${name}`;
  }
  if (item.type === 'review_request') {
    const name = displayName(item.assignee);
    if (item.removedAssignee) return `removed the review request for ${name}`;
    return `requested a review from ${name}`;
  }
  if (item.type === 'close') return 'closed this pull request';
  if (item.type === 'reopen') return 'reopened this pull request';
  if (item.type === 'merge') return 'merged commit'; // SHA + branch 在主行 v-else-if 块拼接
  if (item.type === 'push') {
    const n = item.commitIds?.length ?? 0;
    if (n === 1) return 'added 1 commit';
    if (n > 1) return `added ${n} commits`;
    return 'pushed new commits';
  }
  if (item.type === 'pin') return 'pinned this pull request';
  if (item.type === 'unpin') return 'unpinned this pull request';
  if (item.type === 'label') {
    const added = item.addedLabels ?? [];
    const removed = item.removedLabels ?? [];
    if (added.length > 0 && removed.length === 0) {
      if (added.length === 1) return `added the ${added[0].name} label`;
      return `added ${added.length} labels`;
    }
    if (added.length === 0 && removed.length > 0) {
      if (removed.length === 1) return `removed the ${removed[0].name} label`;
      return `removed ${removed.length} labels`;
    }
    if (added.length > 0 && removed.length > 0) {
      return 'added and removed labels';
    }
    return 'changed labels';
  }
  if (item.type === 'milestone') {
    if (item.milestone) return `added the ${item.milestone.title} milestone`;
    if (item.oldMilestone) return `removed the ${item.oldMilestone.title} milestone`;
    return 'changed the milestone';
  }
  if (item.type === 'title' || item.type === 'change_title') {
    if (item.isWipToggle) {
      return item.isWip
        ? 'marked the pull request as work in progress'
        : 'marked the pull request as ready for review';
    }
    if (item.oldTitle && item.newTitle) return 'changed the title';
    return 'changed the title';
  }
  // delete_branch / restore_branch 走 selectedPR.head.label 兜底（GitHub events 不返 head ref name）
  const headRef = item.oldRef?.replace(/^refs\/heads\//, '') || selectedPR.value?.head?.label;
  if (item.type === 'delete_branch' && headRef) {
    return `deleted the ${headRef} branch`;
  }
  if (item.type === 'delete_branch') return 'deleted a branch';
  if (item.type === 'restore_branch' && headRef) {
    return `restored the ${headRef} branch`;
  }
  if (item.type === 'restore_branch') return 'restored a branch';
  if (item.type === 'change_target_branch') {
    if (item.oldRef && item.newRef) {
      return `changed the base branch from ${item.oldRef} to ${item.newRef}`;
    }
    if (item.newRef) return `changed the base branch to ${item.newRef}`;
    return 'changed the base branch';
  }
  if (item.type === 'lock') return 'locked this pull request';
  if (item.type === 'unlock') return 'unlocked this pull request';
  if (item.type === 'due_date') return 'set the due date';
  if (item.type === 'change_due_date') return 'changed the due date';
  if (item.type === 'remove_due_date') return 'removed the due date';
  if (item.type === 'commit_ref') return 'referenced this commit';
  if (item.type === 'issue_ref' || item.type === 'pull_ref' ||
      item.type === 'comment_ref' || item.type === 'change_issue_ref') {
    const target = item.refIssue
      ? (item.refIssue.repoFullName
          ? `${item.refIssue.repoFullName}#${item.refIssue.index}`
          : `#${item.refIssue.index}`)
      : 'an issue';
    if (item.refAction === 'close') return `closed this via ${target}`;
    if (item.refAction === 'reopen') return `reopened this via ${target}`;
    return `linked ${target}`;
  }
  if (item.type === 'add_dependency') return 'added a dependency';
  if (item.type === 'remove_dependency') return 'removed a dependency';
  if (item.type === 'dismiss_review') return 'dismissed a review';
  if (item.type === 'move') return 'moved this pull request';
  if (item.type === 'pr_scheduled_to_auto_merge') return 'enabled auto-merge';
  if (item.type === 'pr_unscheduled_to_auto_merge') return 'disabled auto-merge';
  if (item.type === 'project') return 'added this to a project';
  if (item.type === 'project_column') return 'moved this to another column';
  // Gitea 专属事件（GitHub 端没对应）—— 不显示 verb
  if (['start_tracking', 'stop_tracking', 'add_time_manual', 'cancel_tracking',
    'delete_time_manual', 'change_time_estimate'].includes(item.type)) {
    return '';
  }
  // 未识别 type：返回空字符串
  return '';
}

/**
 * v0.7.30：systemEventVerb wrapper —— 根据 platform 自动选 Gitea / GitHub 风格 verb
 *
 * - Gitea 端：走 systemEventVerb（中文 verb，对齐 Gitea web 中文 locale，CLAUDE.md 锁的零术语）
 * - GitHub 端：走 githubSystemEventVerb（英文 verb，对齐 GitHub web 实际渲染）
 *
 * 上层模板（v-else-if 链、head_ref_deleted event、merge event 块、label chip 等）
 * 不用改 —— 都按 verb 文案渲染，对两边都自然。
 */
function platformSystemEventVerb(item: TimelineItemDto): string {
  return isGithub.value ? githubSystemEventVerb(item) : systemEventVerb(item);
}

/**
 * v0.7.4：用户显示名
 *
 * Gitea web 的 shared/user/authorlink.tmpl 优先用 User.FullName（display name，
 * 用户在 web 显示成 "M4JAVA" 这种大写），回退到 User.Login（@username）。
 * 之前前端只显示 username（@login），display name 用户看到 "m4java" 小写，
 * 跟 Gitea web 不一致。
 *
 * 本函数：优先 fullName（display name），空时回退 username。
 */
function displayName(user: { fullName?: string; username: string } | null | undefined): string {
  if (!user) return isGithub.value ? 'ghost' : '匿名';
  return user.fullName || user.username || (isGithub.value ? 'ghost' : '匿名');
}

/**
 * v0.7.4：合并事件 commit SHA 短码（7 位）
 *
 * v0.7.8 删 v0.7.4 的 mergeCommitSha(item) + v0.7.7 的 fullMergeSha(item) helper：
 * Gitea 1.26+ timeline 端点 merge_pull event body 是空字符串（不像 v0.7.4-v0.7.7
 * 假设的 "merged commit {sha} into {branch}" 文本格式），body regex 抠 SHA 永远 null。
 * v0.7.8 修：merge 事件 SHA 从 PR 详情端点 PullDetailDTO.MergeCommitSha 拿
 * （giteaPullRaw 漏映射 v0.7.8 补），模板 inline 块直接用 selectedPR.value?.mergeCommitSha。
 *
 * v0.7.8 删 v0.7.7 的 pushEventCommits(item) helper：v0.7.7 假设 Gitea timeline
 * 端点顶层会返 OldCommit / NewCommit / CommitsNum 字段，**实际 Gitea 1.26+ API
 * 根本不返回**这些字段，真实 commit_ids 在 body JSON 字符串里。
 * v0.7.8 改：giteaTimelineToItem 解析 body JSON → TimelineItemDto.commitIds
 * 数组，模板直接用 item.commitIds 渲染 commit 列表（不再调 /pulls/{index}/commits
 * 做时间窗分组，也不需要 store.pull.commitsByPR 缓存）。
 */

/**
 * v0.7.5：系统事件 verb 文案（type 级别，fallback）
 *
 * 严格对齐 Gitea web 中文 locale（locales/zh-CN/options/locale/translation.go）：
 *   - close: "关闭了此合并请求"（含 "此" 限定词）
 *   - reopen: "重新开启了此合并请求"
 *   - merge: "合并了提交"（SHA + branch 在 event-inline）
 *   - delete_branch: "删除了分支"（分支名在 inline）
 *   - push: "推送了新提交"
 *
 * 22+ 种 Gitea CommentType 全部覆盖，**移除 v0.7.x 的 '事件' 通用 fallback**
 * （之前有 4-5 种 type 走 fallback 显示 "事件"，Gitea web 没这个通用词，
 * 看着不专业）。
 *
 * type 级别 vs item 级别：v0.7.5 后统一用 systemEventVerb(item)，
 * 它已经覆盖 type 字符串的 22+ 种分支。type 级别是降级场景（item 不可用时）。
 */

/**
 * v0.7.2 + v0.7.35：系统事件图标 —— 从 Unicode 字符迁到 lucide-vue-next，
 * 视觉上对齐 Gitea web 的 octicon-* 体系（GitHub Primer Icons 风格）。
 * v0.7.35 user 反馈 ⑱：GitHub 数据源各 event icon 要对齐 GitHub web。
 * GitHub Primer Octicons 实际映射（实测 GitHub web PR timeline + 官方 octicon 库）：
 *   - close (octicon-issue-closed)         → XCircle（红圈 X，对齐 GitHub web）
 *   - reopen (octicon-issue-reopened)      → RotateCcw（v0.7.2 已有，绿圈）
 *   - merge (octicon-git-merge)            → GitMerge（v0.7.35 改 GitPullRequest → GitMerge，紫圈 merge icon）
 *   - push / committed (octicon-git-commit) → GitCommit（v0.7.35 改 ArrowUp → GitCommit，小圆点）
 *   - head_ref_force_pushed                 → GitCommit（v0.7.35 新增 entry，force push 走 isForcePush 提示）
 *   - delete_branch (octicon-git-branch)    → GitBranch（v0.7.2 已有）
 *   - restore_branch (octicon-git-branch)   → GitBranch（v0.7.35 改 RotateCcw → GitBranch，
 *                                              跟 delete_branch 同 icon，靠颜色 + 按钮区分）
 *   - commit_ref (octicon-bookmark)         → Bookmark（v0.7.2 已有）
 *   - label (octicon-tag)                   → Tag（v0.7.2 已有）
 *   - milestone (octicon-milestone)         → Milestone（v0.7.2 已有）
 *   - assignee (octicon-person-add)         → UserPlus（v0.7.2 已有，移除走 UserMinus）
 *   - title / change_title (octicon-pencil) → Pencil（v0.7.35 改 Type → Pencil，GitHub web 实际）
 *   - issue_ref / pull_ref (octicon-link)   → LinkIcon（v0.7.35 新增，跨引用）
 *   - change_issue_ref (octicon-link)       → LinkIcon（v0.7.35 新增）
 *   - add_dependency / remove_dependency   → LinkIcon（v0.7.35 新增，依赖关联）
 *   - due_date (octicon-clock)              → Calendar（v0.7.2 已有）
 *   - lock (octicon-lock)                   → Lock（v0.7.2 已有）
 *   - unlock (octicon-key)                  → Key（v0.7.2 已有）
 *   - review_request (octicon-eye)          → Eye（v0.7.2 已有）
 *   - dismiss_review (octicon-x)            → XCircle（v0.7.2 已有）
 *   - pin (octicon-pin)                     → Pin（v0.7.2 已有）
 *   - unpin (octicon-pin)                   → Pin（v0.7.2 已有）
 *   - move (octicon-project)                → Folder（v0.7.2 已有）
 *
 * 返回 lucide Vue component（VNode），模板用 <component :is="..."> 渲染。
 */
const SYSTEM_EVENT_ICON: Record<string, Component> = {
  reopen: RotateCcw,
  // v0.7.35：XIcon → XCircle（GitHub web octicon-issue-closed 红圈 X）
  close: XCircle,
  commit_ref: Bookmark,
  label: Tag,
  milestone: Milestone,
  assignee: UserPlus,
  // v0.7.35：Type → Pencil（GitHub web octicon-pencil，rename 实际是 pencil icon）
  title: Pencil,
  // v0.7.35：change_title 跟 title 一样走 pencil（GitHub web 同 icon）
  change_title: Pencil,
  delete_branch: GitBranch,
  // v0.7.35：RotateCcw → GitBranch（GitHub web 跟 delete_branch 同 icon，靠颜色 + 按钮区分）
  restore_branch: GitBranch,
  due_date: Calendar,
  change_due_date: Calendar,
  remove_due_date: Calendar,
  lock: Lock,
  unlock: Key,
  change_target_branch: ArrowLeftRight,
  review_request: Eye,
  // v0.7.35：GitPullRequest → GitMerge（GitHub web octicon-git-merge 紫圈 merge icon）
  merge: GitMerge,
  // v0.7.35：ArrowUp → GitCommit（GitHub web octicon-git-commit 小圆点）
  push: GitCommit,
  // v0.7.35 新增：单 commit push（GitHub events 端 committed event，走 type=push）
  committed: GitCommit,
  // v0.7.35 新增：force push（GitHub events 端 head_ref_force_pushed event，走 type=push + IsForcePush=true）
  head_ref_force_pushed: GitCommit,
  // v0.7.35 新增：跨引用（GitHub web octicon-link，跟 commit_ref 的 Bookmark 区分）
  issue_ref: LinkIcon,
  pull_ref: LinkIcon,
  change_issue_ref: LinkIcon,
  // v0.7.35 新增：依赖关联（GitHub web octicon-package / link 近似）
  add_dependency: LinkIcon,
  remove_dependency: LinkIcon,
  move: Folder,
  dismiss_review: XCircle,
  pin: Pin,
  unpin: Pin,
};
function systemEventIcon(type: string): Component {
  return SYSTEM_EVENT_ICON[type] ?? MessageCircle;
}

/**
 * v0.7.2：系统事件颜色档（对齐 Gitea web `.badge` 颜色 token）
 *
 * Gitea web 用语义色编码：
 *   - success (tw-bg-green):  reopen / review_approved / push
 *   - danger  (tw-bg-red):    close / review_rejected
 *   - merge   (tw-bg-purple): merge_pull
 *   - warn    (tw-bg-orange): due_date / time tracking 类
 *   - neutral (tw-bg-grey):   其他系统事件 + dismiss_review
 *
 * CSS 变量在 :root 主题 token 里定义（见 styles.css v0.7.2）。
 * 返回 className 模板里用：`:class="systemEventColor(item.type)"`
 */
type SystemEventColor = 'success' | 'danger' | 'merge' | 'warn' | 'neutral';
const SYSTEM_EVENT_COLOR: Record<string, SystemEventColor> = {
  reopen: 'success',
  close: 'danger',
  merge: 'merge',
  dismiss_review: 'neutral',
  review_request: 'neutral',
  push: 'neutral', /* v0.7.21 根因修复：push 事件颜色从 success 绿改成 neutral 灰 —— 对齐 Gitea web 端 timeline 实际渲染（看 Gitea web #81 PR push 事件 dot 是灰色 octicon-repo-push，不是绿色）。v0.7.2 我假设 push 跟 reopen 一样 success 绿，但 Gitea web 实际是灰色 .tw-bg-grey。 */
  // 时间类（orange warn）
  due_date: 'warn',
  change_due_date: 'warn',
  remove_due_date: 'warn',
  // 锁/解锁/引脚类（neutral）
  lock: 'neutral',
  unlock: 'neutral',
  pin: 'neutral',
  unpin: 'neutral',
  // 修改类（neutral）
  label: 'neutral',
  milestone: 'neutral',
  assignee: 'neutral',
  title: 'neutral',
  delete_branch: 'neutral',
  restore_branch: 'neutral',
  change_target_branch: 'neutral',
  commit_ref: 'neutral',
  move: 'neutral',
};
function systemEventColor(type: string): SystemEventColor {
  return SYSTEM_EVENT_COLOR[type] ?? 'neutral';
}

/**
 * v0.7.3：判断 system event item 是否需要渲染二级详情
 *
 * 拆成 inline + block 两类：
 *   - inline：单行内嵌的小信息（label chip / milestone 名 / branch ref / assignee / title 旧新）
 *     Gitea web 里这些都是 inline 在 timeline-item event 同一行
 *   - block：换行展示的（ref issue 链接 + 标题 / dependency 链接 + 标题）
 *     因为带外部链接 + 标题会拉长，单独一行更清晰
 */
function hasSystemEventInlineDetail(item: TimelineItemDto): boolean {
  if (item.type === 'label') return !!item.label;
  if (item.type === 'milestone') return !!(item.oldMilestone || item.milestone);
  if (item.type === 'assignees') return !!item.assignee;
  if (item.type === 'review_request') return !!item.assignee;
  if (item.type === 'title' || item.type === 'change_title') return !!(item.oldTitle || item.newTitle);
  if (item.type === 'delete_branch') return !!item.oldRef;
  if (item.type === 'change_target_branch') return !!(item.oldRef || item.newRef);
  if (item.type === 'commit_ref') return !!item.refCommitSha;
  // v0.7.8 根因修复：merge 事件 inline 块要显示 SHA 链接 + "到 {branch}"，需要
  // 1. PR 详情已加载（selectedPR 有值）
  // 2. PR 详情 mergeCommitSha 有值（PR 合并后才会回填）
  // 3. PR 详情 base ref 有值（要显示 "到 main"）
  // 之前 v0.7.7 只看 base.ref（merge_pull body 是空，body regex 抠不到 SHA），
  // 现在 SHA 来自 PR 详情端点 PullDetailDTO.MergeCommitSha 字段（v0.7.8 修 raw 映射）。
  if (item.type === 'merge') return !!(selectedPR.value?.mergeCommitSha && selectedPR.value?.base?.ref);
  // v0.7.8 根因修复：push 事件 inline 块 —— 显示 commit 列表（直接用 commitIds
  // 数组，v0.7.7 假设的 NewCommit/CommitsNum 顶层字段 Gitea API 不返回）。
  if (item.type === 'push') return !!(item.commitIds && item.commitIds.length > 0);
  return false;
}

function hasSystemEventBlockDetail(item: TimelineItemDto): boolean {
  if (item.type === 'issue_ref' || item.type === 'pull_ref' || item.type === 'comment_ref' || item.type === 'change_issue_ref') return !!item.refIssue;
  if (item.type === 'add_dependency' || item.type === 'remove_dependency') return !!item.dependentIssue;
  return false;
}

/**
 * v0.7.2：生成 timeline 内引用 issue / 依赖 issue 的 web 链接
 *
 * 三步：
 *   1. 用 auth.getAccountUrlByPlatform 拿当前账号的 baseUrl（自动处理 GitHub api.github.com → github.com）
 *   2. 拼 ref.repoFullName (owner/repo)
 *   3. 按 isPull 走 /pulls/N 或 /issues/N
 */
function refIssueWebUrl(refIssue: { repoFullName?: string; index: number; isPull: boolean }): string {
  const platform = (repo.currentProject?.platform ?? 'gitea') as 'gitea' | 'github';
  const baseUrl = (auth.getAccountUrlByPlatform(platform) || '').replace(/\/+$/, '');
  if (!baseUrl || !refIssue.repoFullName) return '#';
  const path = refIssue.isPull ? 'pulls' : 'issues';
  return `${baseUrl}/${refIssue.repoFullName}/${path}/${refIssue.index}`;
}

/** @ 提及下拉是否打开 */
function isMentionOpen(idx: number): boolean {
  const s = mentionState.value.get(idx);
  if (!s) return false;
  return s.key.length > 0 && mentionCandidates(idx).length > 0;
}

/** @ 候选成员列表（按 key 过滤） */
function mentionCandidates(idx: number): string[] {
  const s = mentionState.value.get(idx);
  if (!s) return [];
  const key = s.key.toLowerCase();
  return availableMembers.value
    .filter(m => m.toLowerCase().includes(key))
    .slice(0, 6);
}

/** 候选激活索引（用于键盘上下键） */
function mentionActiveIdx(idx: number): number {
  const s = mentionState.value.get(idx);
  return s?.activeIdx ?? 0;
}

/** v0.7.x: 拿时间轴面板 (对齐 Gitea web) */
function getTimelinePanel(): { items: TimelineItemDto[]; loading: boolean; posting: boolean; error: string | null } {
  const idx = selectedPR.value?.index ?? -1;
  if (idx < 0) return { items: [], loading: false, posting: false, error: null };
  const panel = pull.getTimelinePanel(idx);
  return { items: panel.items, loading: panel.loading, posting: panel.posting, error: panel.error };
}

/** 拿某合并请求的评论草稿 */
function getDraft(idx: number): string {
  return commentDrafts.value.get(idx) ?? '';
}

/** 写某合并请求的评论草稿（v1.5 补：之前 onCommentInput 调用了未定义的 setDraft 导致 ReferenceError） */
function setDraft(idx: number, val: string): void {
  if (val === '') {
    commentDrafts.value.delete(idx);
  } else {
    commentDrafts.value.set(idx, val);
  }
}

/**
 * Markdown 工具栏：在光标位置插入格式化标记
 * 对齐 GitHub 评论编辑器工具栏行为
 */
function insertMarkdown(idx: number, type: string): void {
  const ta = commentInputRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const draft = getDraft(idx);
  const selected = draft.slice(start, end);
  let insert = '';
  let cursorOffset = 0;
  switch (type) {
    case 'bold':
      insert = `**${selected || '粗体'}**`;
      cursorOffset = selected ? insert.length : 2;
      break;
    case 'italic':
      insert = `*${selected || '斜体'}*`;
      cursorOffset = selected ? insert.length : 1;
      break;
    case 'code':
      insert = selected.includes('\n') ? `\n\`\`\`\n${selected}\n\`\`\`\n` : `\`${selected || '代码'}\``;
      cursorOffset = selected ? insert.length : 1;
      break;
    case 'link':
      insert = `[${selected || '链接文字'}](https://)`;
      cursorOffset = insert.length;
      break;
    case 'image':
      insert = `![${selected || '图片描述'}](https://)`;
      cursorOffset = insert.length;
      break;
    case 'quote':
      insert = `> ${selected || '引用'}`;
      cursorOffset = insert.length;
      break;
    case 'list':
      insert = `- ${selected || '列表项'}`;
      cursorOffset = insert.length;
      break;
    case 'task':
      insert = `- [ ] ${selected || '待办事项'}`;
      cursorOffset = insert.length;
      break;
  }
  const next = draft.slice(0, start) + insert + draft.slice(end);
  setDraft(idx, next);
  nextTick(() => {
    ta.focus();
    const pos = start + cursorOffset;
    ta.setSelectionRange(pos, pos);
  });
}

/**
 * 处理图片文件上传（paste 和 drop 共用）
 *
 * 对齐 Gitea 官方 handleUploadFiles（EditorUpload.ts）：
 *   插入 [name](uploading ...) 占位符 → 上传 → 替换为 ![name](/attachments/{uuid})
 */
async function handleImageFile(idx: number, file: File): Promise<void> {
  const altText = file.name.replace(/\.[^.]+$/, '') || '贴图';
  const placeholder = `[${altText}](uploading ...)`;
  const draftBefore = getDraft(idx);
  setDraft(idx, draftBefore + placeholder + '\n');
  try {
    const url = await uploadPastedImage(file);
    const md = `![${altText}](${url})\n`;
    const draftAfter = getDraft(idx);
    setDraft(idx, draftAfter.replace(placeholder + '\n', md));
    showToast({ type: 'success', message: '图片已上传并插入' });
  } catch (err) {
    const draftAfter = getDraft(idx);
    setDraft(idx, draftAfter.replace(placeholder + '\n', ''));
    // eslint-disable-next-line no-console
    console.error('[handleImageFile] upload failed:', err);
    const e2 = err as { messageText?: string; message?: string; cause?: unknown };
    const detail = e2.messageText || e2.message || (e2.cause ? String(e2.cause) : '未知错误');
    showToast({ type: 'error', message: `图片上传失败：${detail}`, persistent: true });
  }
}

/**
 * 剪贴板贴图：对齐 Gitea 官方做法
 *
 * Gitea 官方流程（web_src/js/features/comp/EditorUpload.ts + dropzone.ts）：
 *  1. 监听 paste 事件，提取 image 类型的 File
 *  2. 通过 Dropzone 上传到 issue attachments 端点
 *  3. 拿到 uuid 后生成 markdown：![filename](/attachments/{uuid})
 *  4. 上传失败 → Dropzone error toast，不降级 data URI
 *
 * 我们的流程（对齐 Gitea）：
 *  1. 监听 paste 事件，提取 image 类型的 File
 *  2. 走 App.UploadPullAttachment → Gitea API POST /repos/.../issues/{index}/assets
 *  3. 拿到 uuid 后生成 markdown：![filename](/attachments/{uuid})
 *  4. 上传失败 → toast 报错，不降级 data URI
 *
 * 关键：用 /attachments/{uuid} 相对路径（Gitea 官方格式），不用 browser_download_url。
 * Gitea markdown 渲染器会把 /attachments/{uuid} 解析为正确的附件 URL。
 *
 * 不降级 data URI 的原因：data URI 只有我们的 app 能渲染（DOMPurify 允许），
 * Gitea web 端不渲染 data URI → 用户看到「贴图」占位符 → 图片丢失。
 */
async function onCommentPaste(idx: number, e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      await handleImageFile(idx, file);
      return;
    }
  }
}

/**
 * 拖拽上传图片：对齐 Gitea 官方 initTextareaEvents 的 drop 事件处理
 */
async function onCommentDrop(idx: number, e: DragEvent): Promise<void> {
  if (!e.dataTransfer?.files.length) return;
  for (const file of e.dataTransfer.files) {
    if (file.type.startsWith('image/')) {
      e.preventDefault();
      await handleImageFile(idx, file);
    }
  }
}

/**
 * 把粘贴的 File 上传到当前 PR 的 issue attachments，返回 /attachments/{uuid} 格式 URL
 *
 * 对齐 Gitea 官方 dropzone.ts:generateMarkdownLinkForAttachment：
 *   用 /attachments/{uuid} 相对路径，不用 browser_download_url 完整 URL。
 *
 * 原因：browser_download_url 依赖 Gitea 的 ROOT_URL 配置，如果配置不对
 * （反向代理 / 子路径部署），URL 会指向错误地址。/attachments/{uuid} 由
 * Gitea markdown 渲染器解析为正确的附件 URL，更健壮。
 *
 * Wails 2.x TS 类型对 binary 字段在 binding 上支持差，前端转 base64 字符串传过去，
 * Go 端解码还原成 []byte 再走 multipart。
 */
async function uploadPastedImage(file: File): Promise<string> {
  if (!activeProjectId.value) {
    throw new Error('未选中项目');
  }
  // FileReader.readAsDataURL 返回 data:image/png;base64,iVBORw0... 截掉前缀
  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  const base64 = dataUri.split(',', 2)[1] ?? '';
  if (!base64) {
    throw new Error('文件为空');
  }
  const currentPR = selectedPR.value;
  if (!currentPR) {
    throw new Error('未选中合并请求');
  }
  const fileName = file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] || 'png')}`;
  const result = await pullsUploadAttachment({
    projectId: String(activeProjectId.value),
    index: currentPR.index,
    fileName,
    fileBase64: base64,
  });
  if (!result || !result.uuid) {
    throw new Error('服务端未返回附件 UUID');
  }
  // 对齐 Gitea 官方：用 /attachments/{uuid} 相对路径
  return `/attachments/${result.uuid}`;
}

/**
 * 引用一条评论：把评论作为 markdown 引用块插入草稿。
 * Gitea 风格：```> @username 写了：\n> 原评论内容```（多行用 > 续行）
 */
function quoteComment(idx: number, c: IssueCommentDto): void {
  const author = c.author.username;
  // 把原评论的换行用 \n> 续行（markdown 引用块的写法）
  const quotedBody = c.body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const quote = `> **@${author}** 写了：\n${quotedBody}\n\n`;
  // 追加到现有草稿末尾（如果有内容则加换行分隔）
  const cur = getDraft(idx);
  const next = cur ? `${cur}\n${quote}` : quote;
  setDraft(idx, next);
  // 关闭当前合并请求的 mention 状态
  mentionState.value.delete(idx);
  // 让 textarea 反映新值 + 自动 focus + 光标移到末尾
  nextTick(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.pr-detail__comment-input');
    if (ta) {
      ta.focus();
      const pos = next.length;
      ta.setSelectionRange(pos, pos);
    }
  });
}

/**
 * 输入评论 → 同步草稿 + 解析 @ 触发
 */
function onCommentInput(p: PullDto, e: Event): void {
  const ta = e.target as HTMLTextAreaElement;
  const val = ta.value;
  setDraft(p.index, val);
  // 找 @ 触发位置：从光标往前找最近的 @ + 连续非空白
  const cursor = ta.selectionStart ?? val.length;
  const before = val.slice(0, cursor);
  const m = /@([^\s@]*)$/.exec(before);
  if (m) {
    mentionState.value.set(p.index, { key: m[1] ?? '', cursor, activeIdx: 0 });
  } else {
    mentionState.value.delete(p.index);
  }
}

/**
 * 选一个 @ 候选插入
 *   - 替换"@key"为"@member "
 *   - 光标移到插入后
 */
function insertMention(idx: number, member: string): void {
  const s = mentionState.value.get(idx);
  if (!s) return;
  const draft = getDraft(idx);
  const before = draft.slice(0, s.cursor);
  const after = draft.slice(s.cursor);
  // 替换 before 末尾的 "@key" 为 "@member "
  const replaced = before.replace(/@[^\s@]*$/, `@${member} `);
  const newVal = replaced + after;
  setDraft(idx, newVal);
  mentionState.value.delete(idx);
  // 让 textarea 反映新值
  nextTick(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.pr-detail__comment-input');
    if (ta) {
      const pos = replaced.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    }
  });
}

/**
 * 展开手风琴时拉评论 —— 已被展开的合并请求不会重复拉（避免抖动）
 *
 * 性能：单个仓库合并请求数通常 < 50；用户一次只展开 1-3 个；评论接口本身 < 1s
 */
async function loadComments(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  const panel = getTimelinePanel();
  // 已加载过且非空，跳过（用户切 tab / 列表 refresh 也不会清空，保留上下文）
  if (panel.items.length > 0) return;
  // v0.7.8：先并行拉 PR 详情（mergeCommitSha 字段）+ timeline + 全量 commits
  // —— merge event inline 块需要 selectedPR.mergeCommitSha 渲染 SHA 链接
  await Promise.all([
    pull.fetchPullDetail(p),
    pull.fetchTimeline(p),
    pull.loadCommits(activeProjectId.value, p.index),
  ]);
}

/** 强制重拉评论（发送评论后用 —— 保证看到自己刚发的，带权威 id / 时间戳） */
async function fetchComments(p: PullDto): Promise<void> {
  await pull.fetchTimeline(p);
}

/**
 * 发送评论
 *
 * 流程：
 *   1. trim 草稿；空 → 静默返回（不发 toast，零打扰）
 *   2. posting=true → issues.comment.create → 成功后 fetchComments 重拉列表
 *   3. 失败 → 错误 toast（persistent = true）；state 保留方便用户改完重发
 *   4. 成功 → 清空草稿 + success toast
 */
async function postComment(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  const body = getDraft(p.index).trim();
  if (!body) return;
  try {
    await pull.postComment(p, body);
    setDraft(p.index, '');
    showToast({ type: 'success', message: `评论已发送到 #${p.index}` });
  } catch (e) {
    const err = e as { messageText?: string; hint?: string };
    showToast({ type: 'error', message: err.messageText ?? '发送失败', persistent: true });
  }
}

// ===== 评论编辑 / 删除（v0.5.0 M1） =====

/** 正在编辑的评论 id（仅一个，确保 UI 单一编辑态） */
const editingCommentId = ref<number | null>(null);
/** 编辑中的评论草稿（与新增评论的草稿分开，互不干扰） */
const editDrafts = ref<Map<number, string>>(new Map());

/**
 * v0.7.4：评论 header 右侧 popover 状态
 *
 * commentSmileOpen: 哪个 commentId 的表情选择器打开（null = 全部关闭）
 * commentMenuOpen: 哪个 commentId 的 ... 菜单打开（null = 全部关闭）
 *
 * 用 ref<number | null> 而不是 ref<Set<number>> 是因为 UX 上同一时刻只
 * 期望 1 个评论的 popover/menu 打开（点别处关闭时 1 个就够了），
 * 也避免多 popover 重叠的视觉混乱。
 */
const commentSmileOpen = ref<number | null>(null);
const commentMenuOpen = ref<number | null>(null);

/** 8 种可选表情（对齐 Gitea / GitHub 体系 + ReactionBar 复用） */
const COMMENT_EMOJI_CHOICES = [
  { content: '+1', emoji: '👍', label: '赞同' },
  { content: '-1', emoji: '👎', label: '反对' },
  { content: 'laugh', emoji: '😄', label: '笑脸' },
  { content: 'confused', emoji: '😕', label: '困惑' },
  { content: 'heart', emoji: '❤️', label: '喜爱' },
  { content: 'hooray', emoji: '🎉', label: '庆祝' },
  { content: 'eyes', emoji: '👀', label: '关注' },
  { content: 'rocket', emoji: '🚀', label: '火箭' },
] as const;

/**
 * v0.7.4：判断评论作者是否是 PR 作者（用于显示 [所有者] label）
 *
 * Gitea web 的 shared/user/authorlink 模板配合 show_role role 模板使用，
 * 最简版本：评论作者 == PR 作者 → 显示"所有者"角色标签。
 */
function isPRAuthor(comment: TimelineItemDto): boolean {
  return !!(selectedPR.value?.author?.username && comment.author?.username === selectedPR.value.author.username);
}

/** 切换表情选择器显示状态 */
function toggleSmilePicker(commentId: number): void {
  commentSmileOpen.value = commentSmileOpen.value === commentId ? null : commentId;
  // 互斥：打开表情时关闭 ... 菜单
  if (commentSmileOpen.value !== null) commentMenuOpen.value = null;
}

/** 切换 ... 菜单显示状态 */
function toggleCommentMenu(commentId: number): void {
  commentMenuOpen.value = commentMenuOpen.value === commentId ? null : commentId;
  // 互斥：打开 ... 菜单时关闭表情选择器
  if (commentMenuOpen.value !== null) commentSmileOpen.value = null;
}

/**
 * 添加表情到评论（简化版：直接调 reaction add）
 *
 * v0.7.4 简化：只支持 add reaction（toggle 移除表情在 ReactionBar 已有）。
 * 完整 toggle 留给 v0.7.5（需要 viewerReacted 状态联动 + ReactionBar 重构）。
 */
async function addCommentReaction(p: PullDto, commentId: number, content: string): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    await pull.addCommentReaction(p, commentId, content);
    showToast({ type: 'success', message: '已添加表情' });
    commentSmileOpen.value = null;
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '添加表情失败', persistent: true });
  }
}

/** 复制评论链接到剪贴板 */
async function copyCommentLink(commentId: number): Promise<void> {
  if (!activeRepo.value) return;
  const url = giteaPullUrl(selectedPR.value!).split('/pulls/').join('/issues/') + `#issuecomment-${commentId}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast({ type: 'success', message: '已复制评论链接' });
  } catch {
    showToast({ type: 'error', message: '复制失败' });
  }
  commentMenuOpen.value = null;
}

/**
 * v0.7.4：点击外部关闭 popover / 菜单
 *
 * 用 document 监听 mousedown，命中 action-btn / popover 元素则忽略，
 * 否则关闭所有打开的表情选择器 + 菜单。
 */
function onDocumentClick(_e: MouseEvent): void {
  const target = _e.target as HTMLElement | null;
  if (!target) {
    commentSmileOpen.value = null;
    commentMenuOpen.value = null;
    return;
  }
  if (target.closest('.pr-detail__comment-action-wrap')) return;
  commentSmileOpen.value = null;
  commentMenuOpen.value = null;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentClick);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentClick);
});

/**
 * 进入编辑态
 * - 仅评论作者本人可调（调用方已做权限检查）
 * - 自动把原 body 装进编辑草稿
 */
function startEditComment(c: IssueCommentDto): void {
  editingCommentId.value = c.id;
  editDrafts.value.set(c.id, c.body);
}

/** 取消编辑态（Esc 键或用户点取消） */
function cancelEditComment(): void {
  editingCommentId.value = null;
}

/** 编辑态自动聚焦（v0.6.26） */
watch(editingCommentId, async (newId) => {
  if (newId === null) return;
  await nextTick();
  editTextareaRef.value?.focus();
  editTextareaRef.value?.select();
});

/**
 * 提交编辑
 * 流程：
 *   1. 草稿 trim → 空 → 静默返回
 *   2. 与原 body 相同 → 静默取消编辑态（不发请求）
 *   3. 调 pullsCommentUpdate → 成功 → 更新 panel.items 中对应评论
 *   4. 失败 → toast
 */
async function submitEditComment(p: PullDto, c: IssueCommentDto): Promise<void> {
  if (!activeProjectId.value) return;
  const draft = (editDrafts.value.get(c.id) ?? '').trim();
  if (!draft) return;
  if (draft === c.body.trim()) { editingCommentId.value = null; return; }
  try {
    await pull.editComment(p, c.id, draft);
    editingCommentId.value = null;
    editDrafts.value.delete(c.id);
    showToast({ type: 'success', message: '评论已更新' });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '编辑失败', persistent: true });
  }
}

/**
 * 删除评论（**危险操作**，调用前 UI 必须弹二次确认）
 */
async function deleteComment(p: PullDto, c: IssueCommentDto): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    await pull.removeComment(p, c.id);
    showToast({ type: 'success', message: '评论已删除' });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '删除失败', persistent: true });
  }
}

/**
 * 评论输入框快捷键
 *   - Enter（无 Shift） → 提交
 *   - @ 候选打开时 ↑/↓ 选择 / Enter 选中
 *   - Esc 关闭 @ 候选
 */
function onCommentKeydown(p: PullDto, e: KeyboardEvent): void {
  // 防御性：KeyboardEvent.isComposing 是 DOM 标准属性，直接读；不要走 e.nativeEvent（v1.5 修复 devtool 报错 e.nativeEvent is undefined）
  if (e.isComposing) return;

  // @ 候选打开时的特殊键
  if (isMentionOpen(p.index)) {
    const candidates = mentionCandidates(p.index);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const s = mentionState.value.get(p.index);
      if (s) s.activeIdx = (s.activeIdx + 1) % candidates.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const s = mentionState.value.get(p.index);
      if (s) s.activeIdx = (s.activeIdx - 1 + candidates.length) % candidates.length;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const s = mentionState.value.get(p.index);
      if (s) {
        const m = candidates[s.activeIdx];
        if (m) insertMention(p.index, m);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionState.value.delete(p.index);
      return;
    }
  }

  // 普通 Enter 提交（无 Shift）
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void postComment(p);
  }
}

/** v0.7.30 平台感知：生成二次确认描述文案
 *  - Gitea: 中文 + 人话（CLAUDE.md 零术语）
 *  - GitHub: 英文 + GitHub web merge commit dialog 风格 */
const confirmDescription = computed(() => {
  const p = mergingPull.value;
  if (!p) return '';
  const methodInfo = mergeMethods.value.find((m) => m.value === selectedMethod.value);
  const methodLabel = methodInfo?.label ?? selectedMethod.value;
  const methodHint = methodInfo?.hint ?? '';
  if (isGithub.value) {
    let desc = `Will merge #${p.index} "${p.title}" into ${baseLabel(p)} using **${methodLabel}**.`;
    if (methodHint) desc += `\n\nMethod: ${methodHint}`;
    if (isMainBranch(p.base.ref)) {
      desc += '\n\n⚠️ Target is a main branch — this will affect all collaborators.';
    }
    return desc;
  }
  let desc = `将把 #${p.index}「${p.title}」以「${methodLabel}」方式合并到 ${baseLabel(p)}。`;
  if (methodHint) desc += `\n\n方式说明：${methodHint}`;
  if (isMainBranch(p.base.ref)) {
    desc += '\n\n⚠️ 目标是主线分支，将影响所有协作者的工作流。';
  }
  return desc;
});

/** 状态徽章中文 + 颜色 class */
function badgeClass(p: PullDto): string {
  if (p.draft) return 'merge-badge merge-badge--draft';
  if (p.state === 'open') return 'merge-badge merge-badge--open';
  if (p.merged) return 'merge-badge merge-badge--merged';
  return 'merge-badge merge-badge--closed';
}

/** v0.7.27 平台感知：GitHub web 风格用英文 Closed / Merged / Open / Draft
 *  - Gitea: "草稿" / "待合并" / "已合并" / "已关闭"（CLAUDE.md 零术语锁死的中文）
 *  - GitHub: "Draft" / "Open" / "Merged" / "Closed"（GitHub web 实际就是英文，user 反馈对齐）
 *  颜色 class 跟 Gitea 共用 4 档语义色（draft=warn/orange / open=success/green /
 *  merged=purple / closed=danger/red），不变。 */
function badgeText(p: PullDto): string {
  if (isGithub.value) {
    if (p.draft) return 'Draft';
    if (p.state === 'open') return 'Open';
    if (p.merged) return 'Merged';
    return 'Closed';
  }
  if (p.draft) return '草稿';
  if (p.state === 'open') return '待合并';
  if (p.merged) return '已合并';
  return '已关闭';
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** 相对时间（"3 小时前" 风格）—— 仿 gitea <relative-time> */
function formatRelative(iso: string | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso ?? '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return formatDate(iso);
}
</script>

<template>
  <div class="merges">
    <!-- ============== 顶栏 ============== -->
    <header class="merges__topbar">
      <div class="merges__title">
        <GitMerge :size="18" :stroke-width="1.75" aria-hidden="true" />
        <div class="merges__title-text">
          <h1 class="merges__title-h1">{{ isGithub ? 'Pull requests' : '合并请求' }}</h1>
          <p class="merges__repo">{{ activeRepo?.fullName ?? (isGithub ? 'Select a repository' : '请选择仓库') }}</p>
        </div>
      </div>
      <div class="merges__topbar-right">
        <span class="merges__counter">{{ isGithub ? `${pull.total} total` : `共 ${pull.total} 个` }}</span>
        <span class="merges__merge-method-hint muted" :title="isGithub ? 'Default merge method — change before confirming' : '每次合并的默认方式，可在确认时改'">
          {{ isGithub ? 'Default:' : '默认：' }}{{ mergeMethods.find((m) => m.value === selectedMethod)?.label }}
        </span>
        <button
          type="button"
          class="merges__refresh"
          :disabled="pull.loading"
          :title="isGithub ? 'Refresh' : '刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" />
          <span>{{ isGithub ? 'Refresh' : '刷新' }}</span>
        </button>
      </div>
    </header>

    <!-- ============== 错误条 ============== -->
    <div v-if="pull.error" class="merges__error" role="alert">
      <p class="merges__error-msg">{{ pull.error.messageText }}</p>
      <p class="merges__error-hint">{{ pull.error.hint }}</p>
    </div>

    <!--
      主体空态判断（独立 v-if，避免污染 v-else 链）
    -->
    <div v-if="!activeRepo" class="merges__placeholder">
      <EmptyState
        :title="isGithub ? 'No repository selected' : '还没有选中仓库'"
        :description="isGithub ? 'Go to the Kanban page to select a repository, then come back to see pull requests' : '去「看板」页选一个仓库，再回来这里看合并请求'"
      />
    </div>
    <div v-else-if="!pull.items.length" class="merges__placeholder">
      <EmptyState
        :title="isGithub ? 'This repository has no pull requests' : '这个仓库还没有合并请求'"
        :description="isGithub ? 'Create the first pull request on GitHub, or visit the timeline page to track branch progress' : '去 gitea 创建第一个合并请求，或去时间轴页看分支进度'"
      />
    </div>
    <div v-else-if="!pull.filteredItems.length" class="merges__placeholder">
      <EmptyState
        :title="isGithub ? `No pull requests match “${tabs.find((t) => t.id === pull.filter)?.label}”` : `没有匹配「${tabs.find((t) => t.id === pull.filter)?.label}」的合并请求`"
        :description="isGithub ? 'Try switching tabs or adjusting your search' : '试试切换其他 tab，或调整搜索词'"
      />
    </div>

    <!-- ===== 左右分栏主体（空态已在上方判断，此处有数据才渲染） ===== -->
    <div v-if="activeRepo && pull.filteredItems.length" class="pr-split">
      <!-- ===== 左侧：PR 列表面板 ===== -->
      <aside class="pr-list-panel">
        <!-- 工具栏：筛选 tabs + 搜索 -->
        <div class="pr-list-toolbar">
          <div class="merges__tabs" role="tablist">
            <button
              v-for="t in tabs"
              :key="t.id"
              type="button"
              role="tab"
              class="merges__tab"
              :class="{ 'merges__tab--active': pull.filter === t.id }"
              :aria-selected="pull.filter === t.id"
              @click="pull.setFilter(t.id)"
            >
              <span>{{ t.label }}</span>
              <span class="merges__tab-count">{{ pull.counts[t.id] }}</span>
            </button>
          </div>
          <div class="merges__search">
            <Search :size="14" :stroke-width="2" aria-hidden="true" />
            <input
              v-model="pull.search"
              type="text"
              class="merges__search-input"
              :placeholder="isGithub ? 'Search by title / source / target' : '按标题 / 来源 / 目标搜索'"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        </div>

        <!-- PR 列表滚动区 -->
        <ul ref="mergesScrollEl" class="pr-list-scroll">
          <li
            v-for="p in pull.filteredItems"
            :key="p.index"
            class="pr-card"
            :class="{
              'pr-card--selected': selectedPR?.index === p.index,
              'pr-card--open': p.state === 'open',
              'pr-card--merged': p.merged,
              'pr-card--closed': p.state === 'closed' && !p.merged,
            }"
            role="button"
            tabindex="0"
            @click="selectPR(p)"
            @keydown.enter="selectPR(p)"
            @keydown.space.prevent="selectPR(p)"
          >
            <!-- 状态图标 -->
            <div class="pr-card__icon" aria-hidden="true">
              <GitPullRequestArrow
                v-if="!p.merged && !p.draft && p.state === 'open'"
                :size="16" :stroke-width="2"
                class="pr-card__icon--open"
              />
              <GitPullRequestArrow
                v-else-if="p.merged"
                :size="16" :stroke-width="2"
                class="pr-card__icon--merged"
              />
              <GitPullRequestArrow
                v-else-if="p.draft"
                :size="16" :stroke-width="2"
                class="pr-card__icon--draft"
              />
              <GitPullRequestArrow
                v-else
                :size="16" :stroke-width="2"
                class="pr-card__icon--closed"
              />
            </div>
            <!-- 卡片主体 -->
            <div class="pr-card__body">
              <div class="pr-card__title-row">
                <span class="pr-card__title" :title="p.title">{{ p.title }}</span>
                <span class="pr-card__num mono">#{{ p.index }}</span>
              </div>
              <div class="pr-card__branches">
                <span class="pr-card__branch mono" :title="p.head.label || p.head.ref">{{ headLabel(p) }}</span>
                <span class="pr-card__branch-arrow">→</span>
                <span class="pr-card__branch pr-card__branch--dst mono" :title="p.base.label || p.base.ref">{{ baseLabel(p) }}</span>
              </div>
              <div class="pr-card__meta">
                <span class="pr-card__author">{{ p.author.username }}</span>
                <span class="pr-card__time">{{ formatRelative(p.createdAt) }}</span>
                <span :class="badgeClass(p)" class="pr-card__badge">{{ badgeText(p) }}</span>
                <span v-if="p.hasConflicts && p.state === 'open'" class="pr-card__conflict">{{ isGithub ? 'Conflicts' : '有冲突' }}</span>
                <span v-if="(p.commentsCount ?? 0) > 0" class="pr-card__comments">💬 {{ p.commentsCount }}</span>
              </div>
            </div>
          </li>

          <!-- 滚动加载更多哨兵 -->
          <li
            ref="loadMoreSentinel"
            class="merges__load-more"
            :data-state="(!pull.hasMore && pull.currentPage >= 1) ? 'end' : 'idle'"
            aria-live="polite"
          >
            <div v-if="!pull.hasMore && pull.currentPage >= 1" class="merges__load-more-end">
              <span class="merges__load-more-divider" aria-hidden="true"></span>
              <span>已到全部合并请求的末尾</span>
              <span class="merges__load-more-divider" aria-hidden="true"></span>
            </div>
            <div v-else class="merges__load-more-idle">
              <span class="merges__load-more-arrow" aria-hidden="true">↓</span>
              <span>继续滚动加载更多…</span>
            </div>
          </li>
        </ul>
      </aside>

      <!-- ===== 右侧：PR 详情面板 ===== -->
      <section v-if="selectedPR" class="pr-detail-panel" :key="selectedPR.index">
        <div class="pr-detail-layout">
          <!-- v0.7.28：主内容列（PR 详情 / 评论 / timeline） -->
          <div class="pr-detail-content">
        <!-- 详情头部：标题 + 状态 -->
        <div class="pr-detail-header">
          <div class="pr-detail-header__top">
            <div class="pr-detail-header__status-icon" aria-hidden="true">
              <GitPullRequestArrow
                v-if="!selectedPR.merged && !selectedPR.draft && selectedPR.state === 'open'"
                :size="22" :stroke-width="2.5"
                class="pr-card__icon--open"
              />
              <GitPullRequestArrow
                v-else-if="selectedPR.merged"
                :size="22" :stroke-width="2.5"
                class="pr-card__icon--merged"
              />
              <GitPullRequestArrow
                v-else
                :size="22" :stroke-width="2.5"
                class="pr-card__icon--closed"
              />
            </div>
            <div class="pr-detail-header__title-area">
              <h2 class="pr-detail-header__title">{{ selectedPR.title }}</h2>
              <div class="pr-detail-header__subtitle">
                <span :class="badgeClass(selectedPR)" class="pr-detail-header__badge">{{ badgeText(selectedPR) }}</span>
                <!-- v0.7.6：分支信息对齐 Gitea web `templates/repo/issue/view_title.tmpl` 渲染
                     格式："{author} 请求将 {N} 次代码提交从 {head} 合并至 {base}"
                     分支名加链接到 /src/branch/{ref}，点击可在 Gitea web 看分支历史
                     v0.7.27 平台感知：
                     - Gitea 风格（CLAUDE.md 零术语）："X 请求将 N 次代码提交从 head 合并至 base"
                     - GitHub web 风格（user 截图反馈）："X wants to merge N commit into base from head"
                     GitHub 端的"X wants to merge"是固定句式（不像 Gitea "请求将"），
                     介词是 "into base from head"（注意 from head 在最后，跟 Gitea 顺序相反） -->
                <span v-if="!isGithub"><strong style="color: var(--color-text);">{{ displayName(selectedPR.author) }}</strong> 请求将
                  <strong>{{ Math.max(selectedPR.commits ?? 1, 1) }}</strong> 次代码提交从
                  <a
                    v-if="activeRepo"
                    class="mono pr-detail__branch pr-detail__branch--link"
                    :href="branchWebUrl(headLabel(selectedPR))"
                    target="_blank"
                    rel="noopener"
                    :title="`在 Gitea 打开 ${headLabel(selectedPR)} 分支`"
                  >{{ headLabel(selectedPR) }}</a>
                  <code v-else class="mono pr-detail__branch">{{ headLabel(selectedPR) }}</code>
                  合并至
                  <a
                    v-if="activeRepo"
                    class="mono pr-detail__branch pr-detail__branch--dst pr-detail__branch--link"
                    :href="branchWebUrl(baseLabel(selectedPR))"
                    target="_blank"
                    rel="noopener"
                    :title="`在 Gitea 打开 ${baseLabel(selectedPR)} 分支`"
                  >{{ baseLabel(selectedPR) }}</a>
                  <code v-else class="mono pr-detail__branch pr-detail__branch--dst">{{ baseLabel(selectedPR) }}</code>
                </span>
                <span v-else><strong style="color: var(--color-text);">{{ displayName(selectedPR.author) }}</strong> wants to merge
                  <strong>{{ Math.max(selectedPR.commits ?? 1, 1) }}</strong> commit into
                  <a
                    v-if="activeRepo"
                    class="mono pr-detail__branch pr-detail__branch--dst pr-detail__branch--link"
                    :href="branchWebUrl(baseLabel(selectedPR))"
                    target="_blank"
                    rel="noopener"
                    :title="`在 GitHub 打开 ${baseLabel(selectedPR)} 分支`"
                  >{{ baseLabel(selectedPR) }}</a>
                  <code v-else class="mono pr-detail__branch pr-detail__branch--dst">{{ baseLabel(selectedPR) }}</code>
                  from
                  <a
                    v-if="activeRepo"
                    class="mono pr-detail__branch pr-detail__branch--link"
                    :href="branchWebUrl(headLabel(selectedPR))"
                    target="_blank"
                    rel="noopener"
                    :title="`在 GitHub 打开 ${headLabel(selectedPR)} 分支`"
                  >{{ headLabel(selectedPR) }}</a>
                  <code v-else class="mono pr-detail__branch">{{ headLabel(selectedPR) }}</code>
                </span>
              </div>
            </div>
            <div class="pr-detail-header__ext">
              <button
                type="button"
                class="btn-ghost-sm"
                :title="isGithub ? 'Open in browser' : '在浏览器打开'"
                @click="openPullExternal(selectedPR)"
              >
                <ExternalLink :size="14" :stroke-width="2" aria-hidden="true" />
                {{ isGithub ? 'Open in browser' : '在浏览器打开' }}
              </button>
            </div>
          </div>
        </div>

        <!-- Meta 信息条 -->
        <dl class="pr-detail-meta">
          <div class="pr-detail-meta__item"><dt>{{ isGithub ? 'Created' : '创建' }}</dt><dd>{{ formatDate(selectedPR.createdAt) }}</dd></div>
          <div class="pr-detail-meta__item"><dt>{{ isGithub ? 'Updated' : '更新' }}</dt><dd>{{ formatRelative(selectedPR.updatedAt) }}</dd></div>
          <div class="pr-detail-meta__item"><dt>{{ isGithub ? 'Conflicts' : '冲突' }}</dt><dd>{{ selectedPR.hasConflicts ? (isGithub ? 'Yes' : '有冲突') : (isGithub ? 'No' : '无冲突') }}</dd></div>
          <div class="pr-detail-meta__item"><dt>{{ isGithub ? 'Mergeable' : '可合并' }}</dt><dd>{{ selectedPR.mergeable ? (isGithub ? 'Yes' : '是') : (isGithub ? 'No' : '否') }}</dd></div>
          <div class="pr-detail-meta__item" v-if="(selectedPR.labels ?? []).length > 0">
            <dt>{{ isGithub ? 'Labels' : '标签' }}</dt>
            <dd>
              <span
                v-for="label in (selectedPR.labels ?? [])"
                :key="label.id"
                class="pr-detail__label"
                :style="labelStyle(label.color)"
              >{{ label.name }}</span>
            </dd>
          </div>
          <div class="pr-detail-meta__item" v-if="selectedPR.milestone">
            <dt>{{ isGithub ? 'Milestone' : '里程碑' }}</dt><dd>{{ selectedPR.milestone.title }}</dd>
          </div>
          <div class="pr-detail-meta__item" v-if="(selectedPR.assignees ?? []).length > 0">
            <dt>{{ isGithub ? 'Assignees' : '指派人' }}</dt><dd>{{ (selectedPR.assignees ?? []).map(a => a.username).join(isGithub ? ', ' : '、') }}</dd>
          </div>
          <button
            type="button"
            class="pr-detail__edit-attrs"
            @click="openAttrEditor(selectedPR)"
          >
            <Pencil :size="12" :stroke-width="2" aria-hidden="true" />
            <span>{{ isGithub ? 'Edit' : '编辑属性' }}</span>
          </button>
          <!-- 操作按钮（靠右贴边） -->
          <div class="pr-detail-meta__actions">
            <span
              v-if="selectedPR.hasConflicts && selectedPR.state === 'open'"
              class="pr-detail__conflict-hint"
              :title="isGithub ? 'This pull request has conflicts, please resolve them on GitHub first' : '此合并请求存在冲突，请先在 gitea 页面解决'"
            >{{ isGithub ? 'Conflicts' : '有冲突' }}</span>
            <button
              v-if="selectedPR.state === 'open' && !selectedPR.draft"
              type="button"
              class="btn-primary-sm"
              :disabled="selectedPR.hasConflicts || !selectedPR.mergeable || merging"
              :title="selectedPR.hasConflicts ? (isGithub ? 'Conflicts — please resolve them on GitHub first' : '有冲突，请先在 gitea 页面解决冲突') : !selectedPR.mergeable ? (isGithub ? 'Not mergeable' : '当前不可合并') : (isGithub ? 'Merge pull request' : '合并此请求')"
              @click="requestMerge(selectedPR)"
            >
              <GitMerge :size="14" :stroke-width="2" aria-hidden="true" />
              <span>{{ merging && mergingPull?.index === selectedPR.index ? (isGithub ? 'Merging…' : '合并中…') : (isGithub ? 'Merge' : '合并') }}</span>
            </button>
            <template v-if="selectedPR.state === 'open'">
              <button
                type="button"
                class="btn-approve-sm"
                :disabled="reviewSubmitting"
                :title="isGithub ? 'Approve these changes' : '批准此合并请求'"
                @click="toggleReviewEditor(selectedPR, 'approve')"
              ><span>{{ isGithub ? 'Approve' : '批准' }}</span></button>
              <button
                type="button"
                class="btn-request-changes-sm"
                :disabled="reviewSubmitting"
                :title="isGithub ? 'Request changes' : '请求修改'"
                @click="toggleReviewEditor(selectedPR, 'request_changes')"
              ><span>{{ isGithub ? 'Request changes' : '请求修改' }}</span></button>
            </template>
            <button
              v-if="selectedPR.state === 'open'"
              type="button"
              class="btn-ghost-sm"
              :disabled="closing"
              :title="isGithub ? 'Close this pull request (without merging)' : '关闭此合并请求（不合并）'"
              @click="requestClose(selectedPR)"
            >
              <XCircle :size="14" :stroke-width="2" aria-hidden="true" />
              <span>{{ closing && closingPull?.index === selectedPR.index ? (isGithub ? 'Closing…' : '关闭中…') : (isGithub ? 'Close' : '关闭') }}</span>
            </button>
          </div>
        </dl>

        <!-- 评审编辑器（内联在操作按钮下方） -->
        <div v-if="reviewEditorOpen.has(selectedPR.index)" class="pr-detail__review-editor">
          <div class="pr-detail__review-editor-header">
            <span class="pr-detail__review-editor-label">{{ reviewEventLabel(reviewEditorEvent.get(selectedPR.index) ?? 'comment') }}</span>
          </div>
          <textarea
            class="pr-detail__review-editor-input"
            rows="3"
            :value="reviewEditorBody.get(selectedPR.index) ?? ''"
            @input="reviewEditorBody.set(selectedPR.index, ($event.target as HTMLTextAreaElement).value)"
            :placeholder="isGithub ? 'Leave a comment (optional)' : '评审总结（可选）'"
            spellcheck="false"
          ></textarea>
          <div class="pr-detail__review-editor-actions">
            <button
              type="button"
              class="btn-primary-sm"
              :disabled="reviewSubmitting"
              @click="submitReview(selectedPR)"
            >{{ reviewSubmitting ? (isGithub ? 'Submitting…' : '提交中…') : (isGithub ? 'Submit review' : '提交评审') }}</button>
            <button
              type="button"
              class="btn-ghost-sm"
              @click="reviewEditorOpen.delete(selectedPR.index); reviewEditorBody.delete(selectedPR.index)"
            >{{ isGithub ? 'Cancel' : '取消' }}</button>
          </div>
        </div>

        <!-- Tab 导航：对话 / 代码提交 / 文件变动（对齐 Gitea）
             v0.7.27 平台感知：
             - Gitea: "对话" / "代码提交" / "文件变动"（CLAUDE.md 零术语中文）
             - GitHub web: "Conversation" / "Commits" / "Files changed"（user 截图反馈）
             GitHub 端 4 tab "Conversation / Commits / Checks / Files changed"，
             我们的 "Checks" 暂未集成（v0.7.28 TODO 调 GitHub Check Runs API），
             暂保持 3 tab，标签名按平台切换 -->
        <div class="pr-detail-tabs">
          <button
            type="button"
            class="pr-detail-tab"
            :class="{ 'pr-detail-tab--active': detailTab === 'conversation' }"
            @click="detailTab = 'conversation'"
          >
            {{ isGithub ? 'Conversation' : '对话' }}
            <span v-if="tabLoading.conversation" class="pr-detail-tab__wave" aria-hidden="true">
              <i></i><i></i><i></i>
            </span>
            <span v-if="getTimelinePanel().items.length > 0" class="pr-detail-tab__count">
              {{ getTimelinePanel().items.length }}
            </span>
          </button>
          <button
            type="button"
            class="pr-detail-tab"
            :class="{ 'pr-detail-tab--active': detailTab === 'commits' }"
            @click="detailTab = 'commits'"
          >
            {{ isGithub ? 'Commits' : '代码提交' }}
            <span v-if="tabLoading.commits" class="pr-detail-tab__wave" aria-hidden="true">
              <i></i><i></i><i></i>
            </span>
            <span v-if="pull.commitsByPR.get(selectedPR.index)?.length" class="pr-detail-tab__count">
              {{ pull.commitsByPR.get(selectedPR.index)!.length }}
            </span>
          </button>
          <button
            type="button"
            class="pr-detail-tab"
            :class="{ 'pr-detail-tab--active': detailTab === 'files' }"
            @click="detailTab = 'files'"
          >
            {{ isGithub ? 'Files changed' : '文件变动' }}
            <span v-if="tabLoading.files" class="pr-detail-tab__wave" aria-hidden="true">
              <i></i><i></i><i></i>
            </span>
            <span v-if="pull.filesByPR.get(selectedPR?.index ?? -1)?.length" class="pr-detail-tab__count">
              {{ pull.filesByPR.get(selectedPR?.index ?? -1)?.length ?? 0 }}
            </span>
          </button>
          <!-- v0.7.28：GitHub web 4 tab Checks 占位
               - 暂不实现：GitHub Check Runs API 端点 GET /repos/{}/{}/commits/{}/check-runs
                 + 还要聚合 commit head SHA + per-commit status，scope 较大
               - 留 v0.7.29 TODO：参考 GitHub Check Runs / Check Suites API
               - 当前显示 disabled 状态 + "0" 计数（GitHub PR 还没 Checks 时也是 0） -->
          <button
            v-if="isGithub"
            type="button"
            class="pr-detail-tab pr-detail-tab--disabled"
            disabled
            title="Checks — not yet integrated (planned for v0.7.30+)"
          >
            Checks
            <span class="pr-detail-tab__count">0</span>
          </button>
        </div>

        <!-- ===== Tab 内容滚动区 ===== -->
        <div class="pr-detail-body">
          <!-- 对话 Tab -->
          <div v-if="detailTab === 'conversation'" class="pr-detail__conversation">
            <!-- PR 描述（对齐 Gitea：对话流顶部显示） -->
            <div v-if="selectedPR.body" class="pr-detail__section">
              <div class="pr-detail__section-label">描述</div>
              <div class="pr-detail__section-content md-body" v-html="renderMarkdown(selectedPR.body, markdownBaseUrl)"></div>
            </div>
            <!-- 合并检查警告区（对齐 Gitea web pull_merge_box 模板：显示在描述下方、对话上方） -->
            <div
              v-if="selectedPR.state === 'open' && (selectedPR.draft || (selectedPR.commitsBehind && selectedPR.commitsBehind > 0) || cmdHintOpen)"
              class="pr-detail__merge-warning-list"
              role="alert"
            >
              <!-- v0.7.25 根因修复：完全按 Gitea web pull_merge_box.tmpl 真实布局重写
                   —— 多个 item 块分别渲染：
                     - WIP 警告 + "删除 WIP: 前缀" 按钮（调 updateTitle API 去掉 WIP: 前缀）
                     - 过期警告 + "通过合并更新分支" 按钮（v0.7.26 TODO：调 Gitea update branch by merge API）
                     - 命令行提示 + 默认折叠 + 展开显示 检出 + 合并 2 个步骤（仿 Gitea web pull_merge_instruction.tmpl）

                   v0.7.25 follow-up（user 反馈 ⑭）：
                     - 删 "此合并请求有冲突。" 独立红色 item
                       （Gitea web 冲突在 InfoSections flex-text-block 内，
                        不是独立红色 item；InfoSections 还包含其他 info 块）
                     - 改顺序：WIP → 过期 → 命令行提示
                       （user 截图 2 Gitea web 实际渲染顺序）

                   v0.7.24 漏改：
                     - 缺 "删除 WIP: 前缀" 按钮（Gitea web 调 data-update-url 更新 title）
                     - 命令行提示展开区缺"合并"步骤（只显示"检出"步骤）
                     - 多行布局没对齐 Gitea web flex-divided-list

                   Gitea web pull_merge_box.tmpl 实际结构（实测 ~/2026/code/gitea 仓库）：
                   - 冲突 infoSection：flex-text-block 普通布局（不在 red box 内）
                   - 过期警告行：<div class="item"> 包含 update_branch_by_merge 模板
                   - WIP 警告行：<div class="item flex-left-right"> 左 icon+文字 + 右 button
                   - 命令行提示：<div class="item"> 包含 pull_merge_instruction 模板 -->
              <!-- WIP 警告：左 icon+文字 + 右"删除 WIP: 前缀"按钮
                   v0.7.26 平台感知：仅 Gitea 平台渲染
                   - Gitea：WIP 状态可由用户在 conversation 改 title（PATCH /issues/{index}）
                   - GitHub：draft 不可在 conversation 改（必须 Edit PR title），GitHub 原生
                     "Draft" 徽章已经够清晰，不需要额外 WIP 警告行 -->
              <div
                v-if="selectedPR.draft && !isGithub"
                class="pr-detail__merge-warning pr-detail__merge-warning--wip pr-detail__merge-warning--flex"
              >
                <div class="pr-detail__merge-warning-row">
                  <XCircle :size="16" :stroke-width="2" aria-hidden="true" class="pr-detail__merge-warning-icon" />
                  <span class="pr-detail__merge-warning-text">此合并请求被标记为正在进行的工作。</span>
                  <button
                    type="button"
                    class="btn-ghost-sm pr-detail__merge-warning-action"
                    :disabled="wipToggleLoading"
                    @click="removeWipPrefix"
                  >删除 WIP: 前缀</button>
                </div>
              </div>
              <!-- 过期警告：v0.7.26 集成 Gitea API /compare 端点拿 commits_behind
                   + 调 Gitea /update?style=merge 端点。当前 commitsBehind 字段没集成，
                   暂不渲染（条件 v-if="commitsBehind > 0"）。预期对齐 Gitea web：
                   - 左 icon(AlertTriangle) + "此分支相比基础分支已过期"
                   - 右 ui buttons 组件：主按钮 "通过合并更新分支" + 下拉（条件）"通过变基更新分支"
                   v0.7.26 候选 PR 范围：后端 PullDetailDTO 加 commitsBehind 字段 +
                   platform.PlatformAdapter 加 GetPullCommitsBehind 接口（调 /compare 端点） +
                   前端 store.fetchPullDetail 集成 + 本占位行 v-if 切到 commitsBehind > 0 -->
              <!-- v0.7.26 激活：过期警告行（commits_behind > 0 时显示）
                   条件：selectedPR.commitsBehind 来自 store.fetchPullDetail 调
                   platform.GetPullCommitsBehind 拿到的值（Gitea 1.26+ /pulls/{index}
                   端点不返 commits_behind，必须调 /compare 端点）。
                   "通过合并更新分支"按钮调 updateBranchByMerge handler（store.updateBranch
                   → platform.UpdatePullBranch 调 Gitea /pulls/{index}/update?style=merge）。
                   变基按钮下拉留 v0.7.27 TODO（Gitea 端 /update?style=rebase 已支持，
                   前端需要单独的 UpdateStyle 字段判断仓库 admin 允许哪种）。

                   v0.7.26 平台感知：两平台都显示"过期警告"行，按钮文案 + 调用的
                   adapter 端点不同：
                   - Gitea："通过合并更新分支"（POST /pulls/{index}/update?style=merge）
                   - GitHub："Update branch"（PUT /pulls/{index}/update-branch，GitHub 端
                     merge/rebase 由仓库 admin 设置决定，不由 API 参数控制）
                   adapter 端 v0.7.26 UpdatePullBranch 已经实现两套，Gitea 走 style=merge
                   走 ?style=merge 端点，GitHub 走 update-branch 端点（style 忽略）。 -->
              <div
                v-if="selectedPR.commitsBehind && selectedPR.commitsBehind > 0"
                class="pr-detail__merge-warning pr-detail__merge-warning--outdated pr-detail__merge-warning--flex"
              >
                <div class="pr-detail__merge-warning-row">
                  <AlertTriangle :size="16" :stroke-width="2" aria-hidden="true" class="pr-detail__merge-warning-icon" />
                  <span class="pr-detail__merge-warning-text">
                    {{ isGithub ? '此分支相比基础分支已过期（GitHub 端将通过 Update branch API 同步）' : '此分支相比基础分支已过期' }}
                  </span>
                  <button
                    type="button"
                    class="btn-ghost-sm pr-detail__merge-warning-action"
                    :disabled="branchUpdateLoading"
                    @click="updateBranchByMerge"
                  >{{ isGithub ? 'Update branch' : '通过合并更新分支' }}</button>
                </div>
              </div>
              <!-- 命令行提示：默认折叠，点击展开 检出+合并 2 个步骤
                   v0.7.26 平台感知：仅 Gitea 平台渲染
                   - Gitea：Gitea web 端"查看命令行提示"折叠块（pull_merge_instruction.tmpl）
                   - GitHub：GitHub 端没有这个折叠块，命令行提示直接显示在 merge form 下
                     （GitHub web 端 merge form 用 3 个 button：Merge Pull Request /
                     Squash and merge / Rebase and merge，每个下面有自己的命令行） -->
              <div
                v-if="!isGithub"
                class="pr-detail__merge-warning pr-detail__merge-warning--cmd"
                :class="{ 'pr-detail__merge-warning--collapsed': !cmdHintOpen }"
              >
                <div
                  class="pr-detail__merge-warning-row pr-detail__merge-warning-row--toggle"
                  role="button"
                  tabindex="0"
                  :aria-expanded="cmdHintOpen"
                  @click="cmdHintOpen = !cmdHintOpen"
                  @keydown.enter.prevent="cmdHintOpen = !cmdHintOpen"
                  @keydown.space.prevent="cmdHintOpen = !cmdHintOpen"
                >
                  <ChevronRight v-if="!cmdHintOpen" :size="14" :stroke-width="2" aria-hidden="true" />
                  <ChevronDown v-else :size="14" :stroke-width="2" aria-hidden="true" />
                  <span class="pr-detail__merge-warning-text">查看命令行提示</span>
                </div>
                <div v-if="cmdHintOpen" class="pr-detail__merge-warning-help">
                  <div class="pr-detail__merge-warning-step">检出</div>
                  <div class="pr-detail__merge-warning-desc">从您的仓库中检出一个新的分支并测试变更。</div>
                  <pre class="pr-detail__merge-warning-cmd">git fetch -u origin {{ headLabel(selectedPR) }}:{{ headLabel(selectedPR) }}
git checkout {{ headLabel(selectedPR) }}</pre>
                  <div class="pr-detail__merge-warning-step">合并</div>
                  <div class="pr-detail__merge-warning-desc">合并变更并更新到 Gitea 上</div>
                  <pre class="pr-detail__merge-warning-cmd">git checkout {{ baseLabel(selectedPR) }}
git merge --no-ff {{ headLabel(selectedPR) }}
git push origin {{ baseLabel(selectedPR) }}</pre>
                </div>
              </div>
            </div>
            <!-- v0.7.10：移除对话标题 div（user 反馈 "pr-detail__conv-header 对话标题这个
                 div 移除，不需要展示出来"）。原本的"对话"+计数 badge + 刷新按钮整块
                 一起删，下方 timeline 列表直接显示。刷新按钮如果需要可以走 tab 切换
                 或后续加到 PR header 工具栏，不影响 timeline 渲染逻辑。
                 同步删 .pr-detail__conv-header / .pr-detail__conv-header-left /
                 .pr-detail__conv-count CSS（不再被引用）。 -->

            <!-- 对话列表 -->
            <div class="pr-detail__conv-list">
              <div v-if="getTimelinePanel().loading && getTimelinePanel().items.length === 0" class="pr-detail__conv-loading">
                <Loader2 :size="14" :stroke-width="2" class="spin" aria-hidden="true" />
                <span>{{ isGithub ? 'Loading conversation…' : '正在加载对话…' }}</span>
              </div>
              <div v-else-if="getTimelinePanel().error && getTimelinePanel().items.length === 0" class="pr-detail__conv-error" role="alert">
                <span>{{ getTimelinePanel().error }}</span>
                <button type="button" class="btn-ghost-sm" @click="fetchComments(selectedPR)">{{ isGithub ? 'Retry' : '重试' }}</button>
              </div>
              <div v-else-if="getTimelinePanel().items.length === 0" class="pr-detail__conv-empty">
                {{ isGithub ? 'No conversation yet — add the first comment to start the discussion' : '暂无对话，发起第一条评论开始讨论吧' }}
              </div>
              <ul v-else class="pr-detail__timeline">
                <!-- v0.7.6：v-for 过滤掉 label 合并后被标记 merged=true 的事件（避免重复渲染） -->
                <template v-for="(item) in (getTimelinePanel().items ?? []).filter((it) => !it.merged)" :key="`tl-${item.id}`">
                  <!-- 评审事件 (v0.7.3：紧凑单行 —— 对齐 Gitea web .timeline-item.event) -->
                  <li
                    v-if="item.type === 'review'"
                    :key="`${item.type}-${item.id}`"
                    class="pr-detail__timeline-item pr-detail__timeline-item--event pr-detail__timeline-item--review"
                    :class="`pr-detail__timeline-item--review-${item.state}`"
                  >
                    <div class="pr-detail__timeline-rail">
                      <div class="pr-detail__timeline-dot" :class="`pr-detail__timeline-dot--review-${item.state}`">
                        <component
                          :is="item.state === 'approved' ? CheckCircle2 : item.state === 'changes_requested' ? XCircle : MessageCircle"
                          :size="13"
                          :stroke-width="2.5"
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                    <div class="pr-detail__event-line">
                      <span class="pr-detail__event-text">
                        <span class="pr-detail__event-author">{{ displayName(item.author) }}</span>
                        <!-- v0.7.31 平台感知：review event 时间 layout
                             - Gitea: actor + time + verb（Gitea web .timeline-item.event 渲染顺序）
                             - GitHub web: actor + verb + time（"X approved these changes 2 weeks ago"） -->
                        <span v-if="!isGithub" class="pr-detail__event-time" :title="formatDate(item.created)">{{ formatRelative(item.created) }}</span>
                        <span class="pr-detail__event-verb">{{ reviewStateLabel(item.state) }}</span>
                        <span v-if="isGithub" class="pr-detail__event-time" :title="formatDate(item.created)">{{ formatRelative(item.created) }}</span>
                      </span>
                    </div>
                  </li>
                  <!-- v0.7.21 根因修复：review 事件下补 comment 卡显示 review body —— 对齐
                       Gitea web 端 #74 PR 底部"kanban_bot 留下了一条评论 + 测试 approve"渲染。
                       Gitea 1.26+ timeline 端 review event body 字段就是 review body 内容
                       （实测 pr74 id=578 body="测试 approve" / id=579 body="评审+1"），
                       Gitea web 把 review event 拆 2 卡显示：系统事件卡（"评审"）+
                       comment 卡（"留下了一条评论" + body）。v0.7.1 我只拆了
                       dismiss_review，没拆 review event，导致 user 反馈
                       "Gitea web #74 底部信息展示没对齐"。

                       Gitea web 端 comment 卡样式：左侧大头像（review 作者）+ 右侧气泡
                       （气泡顶部 "kanban_bot 留下了一条评论" + 时间，气泡底部 body
                       内容 markdown 渲染）。我们走 pr-detail__comment-bubble 样式
                       （v0.7.5 review event 评论卡已有），复用。

                       限制：review_id 关联 PullReviewDTO state 信息在 Gitea 1.26+
                       timeline 端没返（state=null），但 Gitea web 端能正确显示
                       approve / request_changes / comment 状态——可能 Gitea web
                       调了 `/repos/{owner}/{repo}/reviews/{id}` 单个 review API
                       拿 state。我们暂不实现（review event dot 走 item.state 字段，
                       state=null 时 dot 走 MessageCircle 灰色，跟 v0.7.18 之前
                       行为一致）。 -->
                  <li
                    v-if="item.type === 'review' && item.body"
                    :key="`${item.type}-${item.id}-body`"
                    class="pr-detail__timeline-item pr-detail__timeline-item--comment pr-detail__timeline-item--review-body"
                  >
                    <div class="pr-detail__timeline-rail">
                      <div class="pr-detail__timeline-avatar" :title="displayName(item.author)" aria-hidden="true">
                        <MessageSquare :size="13" :stroke-width="2" />
                      </div>
                    </div>
                    <div class="pr-detail__comment-bubble">
                      <div class="pr-detail__comment-meta">
                        <span class="pr-detail__comment-author">{{ displayName(item.author) }}</span>
                        <!-- v0.7.24 根因修复：review event 拆 2 卡的 comment 卡
                             也加"所有者"标签（v0.7.4 加过，普通 comment card 有，
                             v0.7.21 review event 拆 2 卡时漏加）。user 反馈
                             "评审事件、评审评论，这些展示没有对齐 Gitea web"
                             —— Gitea web 端 review event comment card 右上角
                             也显示 [所有者] 角色标签（`show_role` 模板，
                             评论作者 == PR 作者时显示）。
                             v0.7.32：GitHub 端统一用 "commented" verb（跟普通
                             comment card 一致），去掉 "left a comment"。
                             GitHub web 实际渲染 "X commented time" 1 行。 -->
                        <span v-if="isPRAuthor(item)" class="pr-detail__comment-role-tag" :title="isGithub ? 'This user is the pull request author' : '合并请求作者'">{{ isGithub ? 'Author' : '所有者' }}</span>
                        <span class="pr-detail__comment-verb">{{ isGithub ? 'commented' : '留下了一条评论' }}</span>
                        <a
                          class="pr-detail__comment-time"
                          :title="formatDate(item.created)"
                        >{{ formatRelative(item.created) }}</a>
                      </div>
                      <div
                        class="pr-detail__comment-body md-body"
                        v-html="renderMarkdown(item.body, markdownBaseUrl)"
                      ></div>
                    </div>
                  </li>

                  <!-- 普通评论卡片 (v0.7.3：左 avatar 移到 timeline rail 位置，bubble 不变) -->
                  <li
                    v-else-if="item.type === 'comment'"
                    :key="`${item.type}-${item.id}`"
                    class="pr-detail__timeline-item pr-detail__timeline-item--comment"
                    :class="{ 'pr-detail__timeline-item--self': currentUsername && item.author?.username === currentUsername }"
                  >
                    <div class="pr-detail__timeline-rail">
                      <div class="pr-detail__timeline-avatar" :title="displayName(item.author)" aria-hidden="true">
                        {{ (item.author?.username || '?').charAt(0).toUpperCase() }}
                      </div>
                    </div>
                    <div class="pr-detail__comment-bubble" :class="{ 'pr-detail__comment-bubble--editing': editingCommentId === item.id }">
                      <div class="pr-detail__comment-meta">
                        <div class="pr-detail__comment-meta-left">
                          <!-- v0.7.32：GitHub 端不渲染"我"标签（GitHub web 没有 self tag，
                               只显示 username）。Gitea 端继续渲染"我"标签方便 PM 识别自己的评论。 -->
                          <span v-if="!isGithub && currentUsername && item.author?.username === currentUsername" class="pr-detail__comment-self-tag">我</span>
                          <span class="pr-detail__comment-author">{{ displayName(item.author) }}</span>
                          <span v-if="isPRAuthor(item)" class="pr-detail__comment-role-tag" :title="isGithub ? 'This user is the pull request author' : '合并请求作者'">{{ isGithub ? 'Author' : '所有者' }}</span>
                          <span class="pr-detail__comment-verb">{{ isGithub ? 'commented' : '评论于' }}</span>
                          <a
                            class="pr-detail__comment-time"
                            :title="formatDate(item.created)"
                            @click.prevent
                          >{{ formatRelative(item.created) }}</a>
                        </div>
                        <!-- v0.7.4：comment header 右侧 actions —— 对齐 Gitea web show_role + add_reaction + context_menu
                             表情选择器 + ... 菜单在外部渲染（避免 popover 嵌套在 comment-meta 里影响布局） -->
                        <div v-if="editingCommentId !== item.id" class="pr-detail__comment-meta-right">
                          <!-- 表情添加按钮（点击展开 emoji 选择器） -->
                          <div class="pr-detail__comment-action-wrap">
                            <button
                              type="button"
                              class="pr-detail__comment-action-btn"
                              :class="{ 'pr-detail__comment-action-btn--active': commentSmileOpen === item.id }"
                              :title="isGithub ? 'Add reaction' : '添加表情'"
                              :aria-label="isGithub ? 'Add reaction' : '添加表情'"
                              @click.stop="toggleSmilePicker(item.id)"
                            >
                              <Smile :size="14" :stroke-width="2" aria-hidden="true" />
                            </button>
                            <div
                              v-if="commentSmileOpen === item.id"
                              class="pr-detail__comment-popover pr-detail__comment-popover--emoji"
                              @click.stop
                            >
                              <button
                                v-for="e in COMMENT_EMOJI_CHOICES"
                                :key="e.content"
                                type="button"
                                class="pr-detail__comment-emoji-btn"
                                :title="e.label"
                                @click="addCommentReaction(selectedPR!, item.id, e.content)"
                              >{{ e.emoji }}</button>
                            </div>
                          </div>
                          <!-- ... 菜单（引用 / 复制链接 / 编辑 / 删除） -->
                          <div class="pr-detail__comment-action-wrap">
                            <button
                              type="button"
                              class="pr-detail__comment-action-btn"
                              :class="{ 'pr-detail__comment-action-btn--active': commentMenuOpen === item.id }"
                              :title="isGithub ? 'More actions' : '更多操作'"
                              :aria-label="isGithub ? 'More actions' : '更多操作'"
                              @click.stop="toggleCommentMenu(item.id)"
                            >
                              <MoreHorizontal :size="14" :stroke-width="2" aria-hidden="true" />
                            </button>
                            <div
                              v-if="commentMenuOpen === item.id"
                              class="pr-detail__comment-popover pr-detail__comment-popover--menu"
                              @click.stop
                            >
                              <button
                                v-if="currentUsername && item.author?.username !== currentUsername"
                                type="button"
                                class="pr-detail__comment-menu-item"
                                @click="quoteComment(selectedPR.index, item as any); commentMenuOpen = null"
                              >
                                <Quote :size="13" :stroke-width="2" aria-hidden="true" />
                                <span>{{ isGithub ? 'Quote' : '引用' }}</span>
                              </button>
                              <button
                                type="button"
                                class="pr-detail__comment-menu-item"
                                @click="copyCommentLink(item.id)"
                              >
                                <LinkIcon :size="13" :stroke-width="2" aria-hidden="true" />
                                <span>{{ isGithub ? 'Copy link' : '复制链接' }}</span>
                              </button>
                              <button
                                v-if="currentUsername && item.author?.username === currentUsername"
                                type="button"
                                class="pr-detail__comment-menu-item"
                                @click="startEditComment(item as any); commentMenuOpen = null"
                              >
                                <Pencil :size="13" :stroke-width="2" aria-hidden="true" />
                                <span>{{ isGithub ? 'Edit' : '编辑' }}</span>
                              </button>
                              <button
                                v-if="currentUsername && item.author?.username === currentUsername"
                                type="button"
                                class="pr-detail__comment-menu-item pr-detail__comment-menu-item--danger"
                                @click="confirmDeleteComment(selectedPR, item as any); commentMenuOpen = null"
                              >
                                <XCircle :size="13" :stroke-width="2" aria-hidden="true" />
                                <span>{{ isGithub ? 'Delete' : '删除' }}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                      <!-- 编辑态 -->
                      <template v-if="editingCommentId === item.id">
                        <textarea
                          :ref="el => { if (el) editTextareaRef = el as HTMLTextAreaElement }"
                          class="pr-detail__comment-edit-input"
                          rows="3"
                          :value="editDrafts.get(item.id) ?? ''"
                          @input="editDrafts.set(item.id, ($event.target as HTMLTextAreaElement).value)"
                          @keydown.escape.stop="cancelEditComment()"
                          @keydown.enter.stop.prevent="submitEditComment(selectedPR, item as any)"
                          spellcheck="false"
                        ></textarea>
                        <div class="pr-detail__comment-edit-actions">
                          <span class="pr-detail__comment-editing-hint">{{ isGithub ? 'ESC to cancel · Enter to save' : 'ESC 取消 · Enter 保存' }}</span>
                          <button type="button" class="btn-ghost-sm" @click.stop="cancelEditComment()">{{ isGithub ? 'Cancel' : '取消' }}</button>
                          <button
                            type="button"
                            class="btn-primary-sm"
                            :disabled="(editDrafts.get(item.id) ?? '').trim().length === 0"
                            @click.stop="submitEditComment(selectedPR, item as any)"
                          >{{ isGithub ? 'Save' : '保存' }}</button>
                        </div>
                      </template>
                      <!-- 展示态 -->
                      <template v-else>
                        <!-- v0.7.6 修复：v-if="item.body" 防御性渲染 —— v-html 空字符串会渲染空 div
                             （不显示但占位），加 v-if 让空 body 评论跳过这个 div，body 完全缺失时
                             也不至于误判为 "评论内容未显示"。这种情况会显示 "无内容" 占位。 -->
                        <div
                          v-if="item.body"
                          class="pr-detail__comment-body md-body"
                          v-html="renderMarkdown(item.body, markdownBaseUrl)"
                        ></div>
                        <div v-else class="pr-detail__comment-body pr-detail__comment-body--empty">
                          （无内容）
                        </div>
                        <span
                          v-if="item.updated && item.updated !== item.created"
                          class="pr-detail__comment-edited-mark"
                          :title="isGithub ? `Edited ${formatDate(item.updated)}` : `编辑于 ${formatDate(item.updated)}`"
                        >{{ isGithub ? '(edited)' : '（已编辑）' }}</span>
                        <div class="pr-detail__comment-actions">
                          <button
                            v-if="currentUsername && item.author?.username !== currentUsername"
                            type="button"
                            class="pr-detail__comment-quote"
                            :title="isGithub ? 'Quote this comment' : '引用这条评论'"
                            @click.stop="quoteComment(selectedPR.index, item as any)"
                          >
                            <Quote :size="11" :stroke-width="2" aria-hidden="true" />
                            <span>{{ isGithub ? 'Quote' : '引用' }}</span>
                          </button>
                          <template v-if="currentUsername && item.author?.username === currentUsername">
                            <button type="button" class="pr-detail__comment-edit-btn" :title="isGithub ? 'Edit' : '编辑'" @click.stop="startEditComment(item as any)">
                              <Pencil :size="11" :stroke-width="2" aria-hidden="true" />
                            </button>
                            <button type="button" class="pr-detail__comment-delete-btn" :title="isGithub ? 'Delete' : '删除'" @click.stop="confirmDeleteComment(selectedPR, item as any)">
                              <XCircle :size="11" :stroke-width="2" aria-hidden="true" />
                            </button>
                          </template>
                        </div>
                        <ReactionBar
                          :project-id="activeProjectId ?? ''"
                          :comment-id="item.id"
                          :editable="selectedPR.state === 'open'"
                        />
                      </template>
                    </div>
                  </li>

                  <!-- 系统事件 (v0.7.3：紧凑单行 —— 对齐 Gitea web .timeline-item.event)
                       行内：username + event verb + 时间 + 小图标
                       行内附加 (event-inline)：label chip / milestone name / branch ref / assignee 等
                       块级 (event-block)：ref issue 链接 + 标题 / dependency 链接 + 标题
                  -->
                  <li
                    v-else-if="!['review', 'comment', 'code'].includes(item.type)"
                    :key="`${item.type}-${item.id}`"
                    class="pr-detail__timeline-item pr-detail__timeline-item--event pr-detail__timeline-item--system"
                    :class="[
                      `pr-detail__timeline-item--system-type-${item.type}`,
                      `pr-detail__timeline-item--system-color-${systemEventColor(item.type)}`,
                    ]"
                  >
                    <div class="pr-detail__timeline-rail">
                      <div class="pr-detail__timeline-dot" :class="`pr-detail__timeline-dot--${systemEventColor(item.type)}`">
                        <component :is="systemEventIcon(item.type)" :size="13" :stroke-width="2.5" aria-hidden="true" />
                      </div>
                    </div>
                    <div class="pr-detail__event-content">
                      <div class="pr-detail__event-line">
                        <!-- v0.7.32：GitHub 端单 commit push 不显示 author + verb
                             GitHub web 实际渲染："commit subject" + "short SHA" 单行，无
                             "X added 1 commit" verb，也无 pusher 名字（commit author 在 commit
                             详情里，不在 timeline event 上）。
                             Gitea 端：actor + 于 + time + verb + body（保持 v0.7.31 布局）。 -->
                        <span
                          v-if="!(isGithub && item.type === 'push' && item.commitIds && item.commitIds.length === 1 && commitDetails(item.commitIds[0])?.subject)"
                          class="pr-detail__event-author"
                        >{{ displayName(item.author) }}</span>
                        <!-- v0.7.31 平台感知：主行 layout
                             - Gitea: actor + 于 + time + verb + body（CLAUDE.md 零术语中文）
                             - GitHub web: actor + verb + body + time（无"于"介词，时间放 verb 后
                               跟 GitHub web "X closed this 2 weeks ago" 格式 1:1 对齐）
                             时间用 v-if 分两处渲染：
                             - Gitea 端在 verb 前
                             - GitHub 端在 body 之后
                             保留 v-else-if 链渲染 verb + body（label chip / merge SHA / force push hint），
                             时间在 v-else-if 链外独立 v-if="isGithub" 渲染。 -->
                        <span v-if="!isGithub" class="pr-detail__event-prep">于</span>
                        <span
                          v-if="!(isGithub && item.type === 'push' && item.commitIds && item.commitIds.length === 1 && commitDetails(item.commitIds[0])?.subject)"
                        >
                          <span v-if="!isGithub" class="pr-detail__event-time" :title="formatDate(item.created)">{{ formatRelative(item.created) }}</span>
                        </span>
                        <span
                          v-if="!(isGithub && item.type === 'push' && item.commitIds && item.commitIds.length === 1 && commitDetails(item.commitIds[0])?.subject)"
                          class="pr-detail__event-verb"
                        >{{ platformSystemEventVerb(item) }}</span>
                        <!-- v0.7.14：label 事件 chip 移到主行（跟 push/merge/delete_branch
                             一致），不单独换 div 块 —— user 反馈 ⑬"修改了标签" 后面 chip
                             不要单独换一行显示。Gitea web 渲染 "X 于 Y 修改了标签
                             [bug] [feature] [needs-review]" 同一行，我们对齐。
                             之前 v0.7.6 把 label chip 放在独立 <div pr-detail__event-inline>
                             块（缩进显示），跟 push/merge 的"verb 同 span"风格不一致。
                             保留 v-else-if="item.type === 'label' && item.label" 单 chip
                             兜底（合并前单条 label event 仍走单 chip 渲染）。
                             注意：这里不能 inline 整段（verb 后直接接 chip），v-else-if
                             链里其他 type（push/merge）也用同样模式。 -->
                        <span
                          v-if="item.type === 'label' && (item.addedLabels?.length || item.removedLabels?.length)"
                          class="pr-detail__event-labels"
                        >
                          <span
                            v-for="lbl in item.addedLabels"
                            :key="`add-${lbl.id}`"
                            class="pr-detail__event-label pr-detail__event-label--add"
                            :style="labelStyle(lbl.color)"
                          >{{ lbl.name }}</span>
                          <span
                            v-for="lbl in item.removedLabels"
                            :key="`rm-${lbl.id}`"
                            class="pr-detail__event-label pr-detail__event-label--remove"
                            :style="labelStyle(lbl.color)"
                          >{{ lbl.name }}</span>
                        </span>
                        <span
                          v-else-if="item.type === 'label' && item.label"
                          class="pr-detail__event-label"
                          :style="labelStyle(item.label.color)"
                        >{{ item.label.name }}</span>
                        <!-- v0.7.18 根因修复：merge 事件 SHA + branch 真正搬到主行
                             （v0.7.15 注释说要搬但实际没动代码——inline 块作为子 div
                             必然另起一行，从 UI 看就是 2 行 "合并提交" + "7db04cd 到 main"）。
                             现在跟 v0.7.14 label chip 一样，主行 v-else-if 链渲染。
                             user 反馈 "kanban_bot 于 27 天前 合并提交 7db04cd 到 main"
                             必须 1 行显示，跟 Gitea web 一致。
                             主行 pr-detail__event-merge span 加 class="pr-detail__event-merge"
                             （v0.7.16 white-space: nowrap）保证整段 1 行不换行。
                             SHA 来源仍是 selectedPR.mergeCommitSha（v0.7.8 修的
                             PR 详情端点字段映射，PullDetailDTO camelCase 字段），
                             不是 TimelineItemDto.mergeCommitSha（Gitea 1.26+ timeline
                             端点不返 SHA）。 -->
                        <span
                          v-else-if="item.type === 'merge' && selectedPR?.mergeCommitSha && selectedPR?.base?.ref"
                          class="pr-detail__event-merge"
                        >
                          <a
                            class="mono pr-detail__event-branch pr-detail__branch--link"
                            :href="commitWebUrl(selectedPR.mergeCommitSha)"
                            target="_blank"
                            rel="noopener"
                            :title="`${isGithub ? 'Open commit' : '在 Gitea 打开'} ${selectedPR.mergeCommitSha.slice(0, 7)} ${isGithub ? 'on GitHub' : '合并提交'}`"
                          >{{ selectedPR.mergeCommitSha.slice(0, 7) }}</a>
                          <span class="pr-detail__event-hint">{{ isGithub ? 'into' : '到' }}</span>
                          <code class="pr-detail__event-branch">{{ baseLabel(selectedPR) }}</code>
                        </span>
                        <!-- v0.7.32：push event GitHub 端单 commit 特殊渲染
                             GitHub web 实际渲染："commit subject" + "short SHA" 同行（右侧），
                             不显示 "X added 1 commit" verb 也不显示 commit 列表。
                             参考 https://github.com/July-X/kanban-test/pull/21 截图：
                             "integration test fixture" + "973c6cd" 单行。
                             Gitea web 走 Gitea 风格："X 推送了 N 个提交" + 下面 commits_list_small
                             块（v0.7.8 / v0.7.19 修过），保持不变。
                             多 commit push：GitHub 端也走 "added N commits" + 列表（Gitea 风格）
                             —— 避免信息丢失。
                             限制：必须 commitDetails(sha) 拿得到 subject（store 缓存走
                             fetchCommitsByPr 拉过），否则 fallback 到 Gitea 风格 verb。 -->
                        <span
                          v-else-if="item.type === 'push' && isGithub && item.commitIds && item.commitIds.length === 1 && commitDetails(item.commitIds[0])?.subject"
                          class="pr-detail__event-push-github"
                        >
                          <a
                            class="pr-detail__event-commit-subject pr-detail__branch--link"
                            :href="commitWebUrl(item.commitIds[0])"
                            target="_blank"
                            rel="noopener"
                            :title="`Open commit ${item.commitIds[0].slice(0, 7)} on GitHub`"
                          >{{ commitDetails(item.commitIds[0])?.subject }}</a>
                          <a
                            class="mono pr-detail__event-commit-sha pr-detail__branch--link"
                            :href="commitWebUrl(item.commitIds[0])"
                            target="_blank"
                            rel="noopener"
                            :title="`Open commit ${item.commitIds[0].slice(0, 7)} on GitHub`"
                          >{{ item.commitIds[0].slice(0, 7) }}</a>
                        </span>
                        <!-- v0.7.19 根因修复：force push 提示搬到主行（v0.7.8 加的 inline 块
                             跟 block 块 v-for 重复，v0.7.19 删 inline 块后 force 提示
                             搬主行："kanban_demo 于 28 天前 推送了 1 个提交 (强制推送)" 1 行
                             + 下面 commits_list_small 块。
                             v0.7.30 平台感知：GitHub 端走 "(force pushed)"。 -->
                        <span
                          v-else-if="item.type === 'push' && item.isForcePush"
                          class="pr-detail__event-hint"
                        >{{ isGithub ? '(force pushed)' : '(强制推送)' }}</span>
                        <!-- v0.7.31 平台感知：GitHub 端时间放 verb 后 + Restore branch 按钮
                             跟 deleted event 同行（右侧）—— user 反馈 ⑭ "Restore branch 也是和
                             删除事件一行显示"（参考 GitHub 官方示意图）。
                             v0.7.34 user 反馈 ⑰ 显示逻辑修复：Restore branch 按钮**仅在
                             分支当前被删**时显示（看 isBranchCurrentlyDeleted，遍历 timeline
                             判断最后一次 head_ref_deleted / head_ref_restored 事件）。
                             修前 bug：每次 delete_branch event 都显示按钮，但分支可能已经被
                             restore（delete → restore 之后），再显示 Restore 按钮是错的。
                             对齐 GitHub web：分支当前被删才显示，已 restore 不显示。
                             - Gitea 端：时间已在 verb 前渲染（v-if="!isGithub" 上面那个 span），
                               这里不再渲染时间
                             - GitHub 端：时间 + restore button 放 verb 后，跟 GitHub web
                               "X deleted the `branch` branch 2 weeks ago [Restore branch]" 1 行
                             Restore branch 按钮条件：
                             - 仅 GitHub（Gitea 没这个概念）
                             - 仅 delete_branch event
                             - **仅当分支当前被删**（isBranchCurrentlyDeleted）
                             - 需要 selectedPR.head.sha + selectedPR.head.label（v0.7.28 修） -->
                        <span v-if="isGithub" class="pr-detail__event-time" :title="formatDate(item.created)">{{ formatRelative(item.created) }}</span>
                        <button
                          v-if="isGithub && item.type === 'delete_branch' && selectedPR && selectedPR.head?.sha && selectedPR.head?.label && isBranchCurrentlyDeleted"
                          type="button"
                          class="btn-primary-sm pr-detail__restore-btn pr-detail__restore-btn--inline"
                          :disabled="pull.restoreBranchLoading"
                          @click="pull.restoreBranch(activeProjectId!, selectedPR.index, selectedPR.head.label, selectedPR.head.sha)"
                        >{{ pull.restoreBranchLoading ? 'Restoring…' : 'Restore branch' }}</button>
                      </div>
                      <!-- 行内附加：label chip / milestone / branch / assignees / title 等小信息 -->
                      <div
                        v-if="hasSystemEventInlineDetail(item)"
                        class="pr-detail__event-inline"
                      >
                        <!-- v0.7.20 根因修复：label 事件 chip 已在主行 pr-detail__event-line
                             渲染（紧跟 verb "添加了标签" / "修改了标签" 后面）——
                             v0.7.14 注释说要删 inline 块重复渲染但**代码没真删**
                             （v0.7.14 漏改，跟 v0.7.18 merge 事件同样问题）。user 反馈
                             "kanban_bot 于 27 天前 添加了标签 [+待办]" 主行 + 下一行
                             重复渲染 "▢ +待办" chip（缩进显示），跟 Gitea web 不一致。
                             修法：删 inline 块 v-if="item.type === 'label' && ..."
                             整段（v0.7.20 改成 milestone 段做新的 v-if 起始，因为
                             v-else/v-else-if 必须有 adjacent v-if/v-else-if）。label
                             事件主行 chip 已经在 line 2557 渲染，inline 块不需要再渲染。
                             修后：label 事件只有 1 个主行 "kanban_bot 于 27 天前
                             添加了标签 [+待办]" 1 行 + 1 个 chip，无重复。 -->

                        <span v-if="item.type === 'milestone'">
                          <template v-if="item.oldMilestone && item.milestone">
                            <span class="pr-detail__event-strike">{{ item.oldMilestone.title }}</span>
                            <span class="pr-detail__event-arrow">→</span>
                            <span class="pr-detail__event-emphasis">{{ item.milestone.title }}</span>
                          </template>
                          <template v-else-if="item.milestone">
                            <span class="pr-detail__event-emphasis">{{ item.milestone.title }}</span>
                          </template>
                          <template v-else-if="item.oldMilestone">
                            <span class="pr-detail__event-strike">{{ item.oldMilestone.title }}</span>
                          </template>
                        </span>

                        <!-- v0.7.12 根因修复：assignees 事件 v0.7.4 加的 inline 块
                             （"X 添加了指派 / 移除了指派" 缩进）跟 Gitea web 渲染不一致
                             —— Gitea web 把所有 assignee 信息合并到主行 verb 文案
                             （"X 于 Y 指派给自己" / "X 于 Y 取消指派"），不显示
                             缩进的 "X 添加了指派" 块。
                             实际渲染对比：
                             Gitea web:        "kanban_bot 于 上个月 指派给自己"
                             v0.7.4-v0.7.11: "kanban_bot 于 27 天前 自指派"
                                                + "kanban_bot 添加了指派"  (缩进块)
                             v0.7.12 改：去掉整块 inline 渲染（v-if 条件 false），
                             主行 systemEventVerb 已经有完整文案（"自指派" / "取消自指派" /
                             "指派给" / "取消了指派"），selfAssign 判断由 v0.7.11 修。
                             注：assignee 用户名仍通过 v-if="item.type === 'assignees' && item.assignee"
                             在 hasSystemEventInlineDetail 里返回 true，但实际模板不再
                             渲染这段 block。改 hasSystemEventInlineDetail 同步返 false。 -->
                        <!-- v0.7.12: assignees 事件不再有 inline 块，verb 在主行完整 -->


                        <!-- v0.7.4：review_request 评审请求详情
                             Gitea web: "X 请求 Y 评审" / "X 移除了 Y 评审请求"
                             X = actor (item.author), Y = requested reviewer (item.assignee) -->
                        <span v-else-if="item.type === 'review_request' && item.assignee">
                          <UserPlus v-if="!item.removedAssignee" :size="12" :stroke-width="2" aria-hidden="true" />
                          <UserMinus v-else :size="12" :stroke-width="2" aria-hidden="true" />
                          <span class="pr-detail__event-username">{{ displayName(item.assignee) }}</span>
                          <!-- v0.7.30 平台感知：review_request inline hint
                               - Gitea: "请求评审" / "移除了评审请求"
                               - GitHub web: 不显示该 hint（actor + reviewer + icon 已表达语义） -->
                          <span v-if="!isGithub" class="pr-detail__event-hint">{{ item.removedAssignee ? '移除了评审请求' : '请求评审' }}</span>
                        </span>

                        <!-- v0.7.8 根因修复：push 事件详情
                             Gitea 1.26+ timeline 端点 body 是 JSON 字符串
                             `{"is_force_push":false,"commit_ids":["sha1"]}`，
                             后端 giteaTimelineToItem 解析后存到
                             TimelineItemDto.commitIds []string + isForcePush 字段。
                             之前 v0.7.7 假设的 item.newCommit（顶层独立字段）Gitea API
                             不返回，inline 块永远不渲染。
                             push event 的完整 commit 列表在下方 block 块单独渲染
                             （Gitea web `commits_list_small` 模板风格：缩进 + GitCommit
                             icon + 短 SHA 链接 + 提交消息可选）。
                             v0.7.19 根因修复：v0.7.8 加的 inline 块 head commit 短码
                             链接（"91d5126"）跟下面 block 块 v-for 渲染的 commit 列表
                             重复——同一个 push event 在 UI 上看到 2 个 commit 行：
                             inline 块的 1 个 head commit 短码链接 + block 块的 1 个
                             commit 列表行（短 SHA + subject + author）。Gitea web
                             端 block 块只有 1 个 commit 行（"feat: branch line-4 (057405)"）
                             不显示短 SHA。我们 v0.7.8 把 inline 块的 head commit 短码
                             链接留作"主行 head commit 链接"用，但跟 block 块 v-for
                             重复了。
                             修法：v0.7.19 删 inline 块的 head commit 短码链接（block
                             块已经渲染完整 commit 列表，inline 块冗余），跟 v0.7.18
                             merge 事件搬主行同理。force push 提示也一并搬主行：
                             "kanban_demo 于 28 天前 推送了 1 个提交 (强制推送)" 1 行
                             + 下面 commits_list_small 块。 -->

                        <!-- v0.7.15 根因修复：merge 事件 SHA + branch 移到主行（跟 v0.7.14
                             label chip 移到主行同理）—— user 反馈"文本说明中合并提交 X 到 Y"
                             要按 Gitea web 1:1 一行渲染。Gitea web 实际：
                             "X 于 Y 合并 commit f30ece070c 到 main"  （X = actor，Y = time，
                             "合并 commit {sha}" verb 段，"到 {branch}" 介词段，SHA 是 7 位短码）
                             我们 v0.7.14 改前：主行 "X 于 Y 合并了提交" + 缩进块 "到 main f30ece070c"
                             跨 2 div 块显示，user 看到是 2 行。
                             v0.7.15 改：verb "合并了提交" → "合并提交"（去"了"字对齐 Gitea web
                             "合并 commit" 无"了"字），SHA + branch 拼到主行 verb 后
                             （紧跟 `<span class="pr-detail__event-verb">合并提交</span>` 后面），
                             跟 label / push / delete_branch 一样主行 v-else-if 链渲染。
                             实际效果："X 于 Y 合并提交 f30ece070c 到 main"  同一行。
                             注：merge SHA 来源仍是 selectedPR.mergeCommitSha（v0.7.8
                             修的 PR 详情端点字段映射），不是 TimelineItemDto.mergeCommitSha
                             （Gitea 1.26+ timeline 端点不返 SHA）。
                             v0.7.18 备注：v0.7.15 注释说要搬主行但**实际没动代码**——
                             span 还留在 inline 块里（子 div 必然另起一行），导致 user
                             反馈"分支信息还是换行了"。v0.7.18 把 v-else-if span 真正
                             搬到主行 pr-detail__event-line（紧跟 verb 后），inline 块
                             那个 span 删掉。 -->

                        <!-- v0.7.6：WIP toggle 时不显示 oldTitle → newTitle（标题内容没意义） -->
                        <span v-else-if="(item.type === 'title' || item.type === 'change_title') && !item.isWipToggle">
                          <span class="pr-detail__event-strike">{{ item.oldTitle }}</span>
                          <span class="pr-detail__event-arrow">→</span>
                          <span class="pr-detail__event-emphasis">{{ item.newTitle }}</span>
                        </span>

                        <!-- v0.7.12 根因修复：delete_branch 事件分支名从 inline 块移到主行 verb
                             （见 systemEventVerb delete_branch 分支），保证显示。
                             这里不再有 delete_branch inline 块（v0.7.4 加的 inline 块
                             代码逻辑对但 user 反馈 v0.7.10 后看不到，原因可能是
                             v0.7.10 dot 22→26 + 主行字号 13→14 后 layout 变化
                             引起 inline 块被遮盖。v0.7.12 走 verb 拼接方案兜底）。 -->

                        <span v-else-if="item.type === 'change_target_branch'">
                          <GitBranch :size="12" :stroke-width="2" aria-hidden="true" />
                          <code class="pr-detail__event-branch">{{ item.oldRef }}</code>
                          <span class="pr-detail__event-arrow">→</span>
                          <code class="pr-detail__event-branch">{{ item.newRef }}</code>
                        </span>

                        <span v-else-if="item.type === 'commit_ref' && item.refCommitSha">
                          <code class="pr-detail__event-branch">{{ item.refCommitSha!.slice(0, 7) }}</code>
                        </span>
                      </div>
                      <!-- 块级：ref issue / dependency 等需要换行展示的 (对齐 Gitea web .detail) -->
                      <div
                        v-if="hasSystemEventBlockDetail(item)"
                        class="pr-detail__event-block"
                      >
                        <span v-if="(item.type === 'issue_ref' || item.type === 'pull_ref' || item.type === 'comment_ref' || item.type === 'change_issue_ref') && item.refIssue">
                          <!-- v0.7.30 平台感知：ref action hint
                               - Gitea: "关闭了" / "重开了" / "引用了"
                               - GitHub web 渲染：GitHub 端 timeline 这种 event verb 主体已
                                 自带动作（"closed this via #N" / "linked #N"），inline 块
                                 不再需要 verb 提示。 -->
                          <span v-if="!isGithub && item.refAction === 'close'" class="pr-detail__event-hint">关闭了</span>
                          <span v-else-if="!isGithub && item.refAction === 'reopen'" class="pr-detail__event-hint">重开了</span>
                          <span v-else-if="!isGithub" class="pr-detail__event-hint">引用了</span>
                          <a
                            v-if="item.refIssue.repoFullName"
                            :href="refIssueWebUrl(item.refIssue)"
                            class="pr-detail__event-link"
                            target="_blank"
                            rel="noopener"
                          >
                            {{ item.refIssue.repoFullName }}#{{ item.refIssue.index }}
                          </a>
                          <span v-else class="pr-detail__event-link">#{{ item.refIssue.index }}</span>
                          <span class="pr-detail__event-emphasis">{{ item.refIssue.title }}</span>
                        </span>

                        <span v-else-if="(item.type === 'add_dependency' || item.type === 'remove_dependency') && item.dependentIssue">
                          <component
                            :is="item.dependentIssue.isPull ? GitPullRequestArrow : MessageSquare"
                            :size="12"
                            :stroke-width="2"
                            aria-hidden="true"
                          />
                          <a
                            v-if="item.dependentIssue.repoFullName"
                            :href="refIssueWebUrl(item.dependentIssue)"
                            class="pr-detail__event-link"
                            target="_blank"
                            rel="noopener"
                          >
                            {{ item.dependentIssue.repoFullName }}#{{ item.dependentIssue.index }}
                          </a>
                          <span v-else class="pr-detail__event-link">#{{ item.dependentIssue.index }}</span>
                          <span class="pr-detail__event-emphasis">{{ item.dependentIssue.title }}</span>
                        </span>
                      </div>
                      <!-- v0.7.8 根因修复：push 事件 commit 列表块（独立于 hasSystemEventBlockDetail 链）——
                           对齐 Gitea web `templates/repo/commits_list_small.tmpl` 渲染：
                           缩进 + GitCommit icon + 短 SHA 链接 + commit 提交者。
                           Gitea 1.26+ timeline 端点 body JSON 里的 commit_ids 数组
                           （后端 giteaTimelineToItem v0.7.8 解析后存到
                           TimelineItemDto.commitIds []string）就是该次 push 的完整
                           commit 列表 —— 直接用 v-for 渲染，不调 /pulls/{index}/commits
                           做时间窗分组（v0.7.7 简化版算法 v0.7.8 弃用）。Gitea web
                           端模板 `repo/issue/view_content/comments.tmpl` 用的就是
                           `commit_ids` 数组，我们对齐这个行为。
                           限制：commit 消息 / 提交者不在 commit_ids 里（API 不返），
                           只显示 SHA 短码链接 + 完整 SHA title（hover 看）。
                           v0.7.9 计划：拉 /pulls/{index}/commits 二次匹配补
                           subject / author 信息（按 SHA 短码 7 位匹配）。 -->
                      <!-- v0.7.32：GitHub 端单 commit push 不渲染 commit 列表块
                           （已经在主行 v-else-if 链 pr-detail__event-push-github 里渲染
                           commit subject + short SHA 同行，避免重复）。多 commit 或
                           Gitea 端继续渲染列表块。 -->
                      <div
                        v-if="item.type === 'push' && item.commitIds && item.commitIds.length > 0 && !(isGithub && item.commitIds.length === 1 && commitDetails(item.commitIds[0])?.subject)"
                        class="pr-detail__event-block pr-detail__event-block--commits"
                      >
                        <div
                          v-for="(sha, idx) in item.commitIds"
                          :key="`${item.id}-${idx}-${sha}`"
                          class="pr-detail__event-commit-row"
                        >
                          <GitCommit :size="12" :stroke-width="2" aria-hidden="true" class="pr-detail__event-commit-icon" />
                          <!-- v0.7.19 根因修复：按 Gitea web 1:1 对齐
                               `templates/repo/commits_list_small.tmpl` 渲染 —— Gitea web
                               commit 列表只显示 commit 消息（带链接到 commit 页）+ author，
                               **没有短 SHA 前缀**。v0.7.8 加的短 SHA 前缀是冗余的
                               （commit 消息本身是链接，user 点击跳转 Gitea web 不需要
                               单独短 SHA 链接）。修法：把 short SHA 链接改成链接
                               commit 消息（跟 Gitea web RenderCommitMessageLinkSubject
                               helper 一致），保留 commitDetails(sha)?.subject 渲染。 -->
                          <a
                            v-if="commitDetails(sha)?.subject"
                            class="pr-detail__event-commit-subject pr-detail__branch--link"
                            :href="commitWebUrl(sha)"
                            target="_blank"
                            rel="noopener"
                            :title="`${isGithub ? 'Open commit' : '在 Gitea 打开'} ${sha.slice(0, 7)} ${isGithub ? 'on GitHub' : ''}`"
                          >{{ commitDetails(sha)?.subject }}</a>
                          <a
                            v-else
                            class="mono pr-detail__event-commit-sha pr-detail__branch--link"
                            :href="commitWebUrl(sha)"
                            target="_blank"
                            rel="noopener"
                            :title="`${isGithub ? 'Open commit' : '在 Gitea 打开'} ${sha.slice(0, 7)} ${isGithub ? 'on GitHub' : ''}`"
                          >{{ sha.slice(0, 7) }}</a>
                          <span
                            v-if="commitDetails(sha)?.authorName"
                            class="pr-detail__event-commit-author"
                          >{{ commitDetails(sha)?.authorName }}</span>
                        </div>
                      </div>
                    </div>
                  </li>

                  <!-- v0.7.28-29 注释保留：早期版本 Restore branch 按钮是独立 <li>
                       （在 delete_branch event 之后另起一行）。v0.7.31 user 反馈 ⑭
                       "Restore branch 也是和删除事件一行显示，参考 GitHub 官方示意图" —
                       已搬到 delete_branch event 主行 pr-detail__event-line 内
                       （v-if="isGithub && item.type === 'delete_branch' && ..."），
                       Gitea 端不显示（Gitea 没 Restore branch 概念），GitHub 端跟
                       "X deleted the `branch` branch 2 weeks ago [Restore branch]" 同行。
                       早期独立 <li> 代码已删。下面这条注释留着是方便历史溯源。 -->

                  <!-- v0.7.3：dismiss_review 拆 2 卡 —— event 卡已在上面 system-event 块渲染，
                       这里补 reason comment 卡（独立 timeline item，按 comment 卡样式渲染） -->
                  <li
                    v-if="item.type === 'dismiss_review' && item.body"
                    :key="`${item.type}-${item.id}-reason`"
                    class="pr-detail__timeline-item pr-detail__timeline-item--comment pr-detail__timeline-item--dismiss-reason"
                  >
                    <div class="pr-detail__timeline-rail">
                      <div class="pr-detail__timeline-avatar pr-detail__timeline-avatar--dismiss" :title="displayName(item.author)" aria-hidden="true">
                        <MessageSquare :size="13" :stroke-width="2" />
                      </div>
                    </div>
                    <div class="pr-detail__comment-bubble">
                      <div class="pr-detail__comment-meta">
                        <span class="pr-detail__comment-dismiss-reason-tag">{{ isGithub ? 'Dismissal reason' : '驳回原因' }}</span>
                        <span class="pr-detail__comment-author">{{ displayName(item.author) }}</span>
                        <span class="pr-detail__comment-verb">{{ isGithub ? 'commented' : '评论于' }}</span>
                        <a
                          class="pr-detail__comment-time"
                          :title="formatDate(item.created)"
                          @click.prevent
                        >{{ formatRelative(item.created) }}</a>
                      </div>
                      <div class="pr-detail__comment-body md-body" v-html="renderMarkdown(item.body, markdownBaseUrl)"></div>
                    </div>
                  </li>
                </template>
              </ul>
            </div>

            <!-- v0.7.28 + v0.7.30 + v0.7.34 platform-aware 改进：
                 - 关闭但未合并：渲染 "Closed with unmerged commits" panel
                   - 分支存在：描述带 branch 名 + Delete branch 按钮
                     · Gitea: "此合并请求已关闭，但 {branch} 分支有未合并的提交。"
                     · GitHub: "This pull request is closed, but the `{branch}` branch has unmerged commits."
                   - 分支被删：描述简化 + 无 Delete branch 按钮（已被删，删第二次是 no-op）
                     · Gitea: "此合并请求已关闭。"
                     · GitHub: "This pull request is closed."
                   分支状态由 isBranchCurrentlyDeleted（看 timeline 最后一次 head_ref_*
                   事件）决定。
                 - 关闭且已合并：渲染 "Merged" + merge commit 链接
                   - Gitea: "此合并请求通过提交 {sha} 合并至 {base}。"
                   - GitHub: "This pull request was merged via commit {sha} into {base}."
                 - 草稿 / 开放：什么都不渲染 -->
            <div
              v-if="selectedPR.state === 'closed' && !selectedPR.merged"
              class="pr-detail__closed-banner pr-detail__closed-banner--unmerged"
              role="status"
            >
              <GitBranch :size="18" :stroke-width="2" aria-hidden="true" class="pr-detail__closed-banner-icon" />
              <div class="pr-detail__closed-banner-text">
                <div class="pr-detail__closed-banner-title">{{ isGithub ? 'Closed with unmerged commits' : '有未合并的提交' }}</div>
                <div class="pr-detail__closed-banner-desc">
                  <!-- v0.7.34：分支被删时不带 branch 描述（对齐 GitHub web "This pull request is closed."） -->
                  <template v-if="isBranchCurrentlyDeleted">
                    <template v-if="isGithub">This pull request is closed.</template>
                    <template v-else>此合并请求已关闭。</template>
                  </template>
                  <template v-else-if="isGithub">
                    This pull request is closed, but the
                    <a
                      v-if="headLabel(selectedPR)"
                      class="mono pr-detail__branch pr-detail__branch--link"
                      :href="branchWebUrl(headLabel(selectedPR))"
                      target="_blank"
                      rel="noopener"
                    >{{ headLabel(selectedPR) }}</a>
                    <code v-else class="mono pr-detail__branch">{{ selectedPR.head?.ref }}</code>
                    branch has unmerged commits.
                  </template>
                  <template v-else>
                    此合并请求已关闭，但
                    <a
                      v-if="headLabel(selectedPR)"
                      class="mono pr-detail__branch pr-detail__branch--link"
                      :href="branchWebUrl(headLabel(selectedPR))"
                      target="_blank"
                      rel="noopener"
                    >{{ headLabel(selectedPR) }}</a>
                    <code v-else class="mono pr-detail__branch">{{ selectedPR.head?.ref }}</code>
                    分支有未合并的提交。
                  </template>
                </div>
              </div>
              <!-- v0.7.29 + v0.7.30 + v0.7.34：Delete branch 按钮 platform-aware + 仅在分支存在时显示
                   （分支被删时按钮无意义，再点一次是 no-op，且 v0.7.34 之前 v-if="headLabel(...)"
                   无条件显示是 bug，参考 user 反馈 ⑰ "Delete branch 和 Restore branch 的显示
                   位置不正确，以及显示逻辑" —— GitHub web 只在分支存在时显示 Delete branch）。 -->
              <button
                v-if="!isBranchCurrentlyDeleted && headLabel(selectedPR)"
                type="button"
                class="btn-ghost-sm pr-detail__closed-banner-action"
                :disabled="pull.deleteBranchLoading"
                @click="pull.deleteBranch(activeProjectId!, selectedPR.index, headLabel(selectedPR))"
              >{{ pull.deleteBranchLoading ? (isGithub ? 'Deleting…' : '删除中…') : (isGithub ? 'Delete branch' : '删除分支') }}</button>
            </div>
            <div
              v-else-if="selectedPR.state === 'closed' && selectedPR.merged"
              class="pr-detail__closed-banner pr-detail__closed-banner--merged"
              role="status"
            >
              <GitPullRequestArrow :size="18" :stroke-width="2" aria-hidden="true" class="pr-detail__closed-banner-icon" />
              <div class="pr-detail__closed-banner-text">
                <div class="pr-detail__closed-banner-title">{{ isGithub ? 'Merged' : '已合并' }}</div>
                <div
                  v-if="selectedPR.mergeCommitSha"
                  class="pr-detail__closed-banner-desc"
                >
                  <template v-if="isGithub">
                    This pull request was merged via commit
                    <a
                      class="mono pr-detail__branch pr-detail__branch--link"
                      :href="commitWebUrl(selectedPR.mergeCommitSha)"
                      target="_blank"
                      rel="noopener"
                    >{{ selectedPR.mergeCommitSha.slice(0, 7) }}</a>
                    into {{ baseLabel(selectedPR) }}.
                  </template>
                  <template v-else>
                    此合并请求通过提交
                    <a
                      class="mono pr-detail__branch pr-detail__branch--link"
                      :href="commitWebUrl(selectedPR.mergeCommitSha)"
                      target="_blank"
                      rel="noopener"
                    >{{ selectedPR.mergeCommitSha.slice(0, 7) }}</a>
                    合并至 {{ baseLabel(selectedPR) }}。
                  </template>
                </div>
              </div>
            </div>

            <!-- 评论输入区
                 v0.7.30 平台感知：GitHub 端 tooltips 走英文
                 (保持按钮文字在 Gitea 端中文，跟 Gitea 现有 locale 一致) -->
            <div class="pr-detail__comment-compose">
              <!-- Markdown 工具栏 -->
              <div class="pr-detail__md-toolbar">
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Bold' : '粗体'" @click="insertMarkdown(selectedPR.index, 'bold')"><strong>B</strong></button>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Italic' : '斜体'" @click="insertMarkdown(selectedPR.index, 'italic')"><em>I</em></button>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Inline code' : '行内代码'" @click="insertMarkdown(selectedPR.index, 'code')"><code>{ }</code></button>
                <span class="md-toolbar-divider"></span>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Link' : '链接'" @click="insertMarkdown(selectedPR.index, 'link')">链接</button>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Image' : '图片'" @click="insertMarkdown(selectedPR.index, 'image')">图片</button>
                <span class="md-toolbar-divider"></span>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Quote' : '引用'" @click="insertMarkdown(selectedPR.index, 'quote')">引用</button>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'List' : '列表'" @click="insertMarkdown(selectedPR.index, 'list')">列表</button>
                <button type="button" class="md-toolbar-btn" :title="isGithub ? 'Task' : '待办'" @click="insertMarkdown(selectedPR.index, 'task')">待办</button>
              </div>
              <div class="pr-detail__comment-input-wrap">
                <textarea
                  ref="commentInputRef"
                  class="pr-detail__comment-input"
                  :value="getDraft(selectedPR.index)"
                  @input="onCommentInput(selectedPR, $event)"
                  @keydown="onCommentKeydown(selectedPR, $event)"
                  @paste="void onCommentPaste(selectedPR.index, $event)"
                  @drop="void onCommentDrop(selectedPR.index, $event)"
                  @dragover.prevent
                  :placeholder="isGithub ? `Add your comment to #${selectedPR.index}\n@ to mention, Enter to submit` : `发条评论给 #${selectedPR.index}\n@ 提及成员，Enter 发送`"
                  :disabled="getTimelinePanel().posting"
                  rows="3"
                  maxlength="65535"
                  spellcheck="false"
                ></textarea>
                <button
                  type="button"
                  class="pr-detail__comment-send"
                  :disabled="getTimelinePanel().posting || getDraft(selectedPR.index).trim().length === 0"
                  :title="isGithub ? 'Submit comment (Enter also works)' : '发送评论（Enter 也可发送）'"
                  @click.stop="postComment(selectedPR)"
                >
                  <Send :size="14" :stroke-width="2" aria-hidden="true" />
                </button>
                <div
                  v-if="isMentionOpen(selectedPR.index) && mentionCandidates(selectedPR.index).length > 0"
                  class="pr-detail__mention-dropdown"
                >
                  <button
                    v-for="(m, i) in mentionCandidates(selectedPR.index)"
                    :key="m"
                    type="button"
                    class="pr-detail__mention-item"
                    :class="{ 'pr-detail__mention-item--active': i === mentionActiveIdx(selectedPR.index) }"
                    @click.stop.prevent="insertMention(selectedPR.index, m)"
                  >{{ '@' + m }}</button>
                </div>
              </div>
              <div class="pr-detail__comment-actions">
                <span v-if="getDraft(selectedPR.index).length > 0" class="muted">
                  {{ getDraft(selectedPR.index).length }} / 65535
                </span>
              </div>
            </div>
          </div>

          <!-- 代码提交 Tab -->
          <div v-if="detailTab === 'commits'" class="pr-detail__commits">
            <div v-if="pull.commitsLoading" class="pr-detail__conv-loading">
              <Loader2 :size="14" :stroke-width="2" class="spin" aria-hidden="true" />
              <span>{{ isGithub ? 'Loading commits…' : '正在加载提交列表…' }}</span>
            </div>
            <div v-else-if="pull.commitsByPR.get(selectedPR.index)?.length" class="pr-detail__commit-scroll">
            <table class="pr-detail__commit-table">
              <thead>
                <tr>
                  <th class="pr-detail__commit-th-author">{{ isGithub ? 'Author' : '作者' }}</th>
                  <th class="pr-detail__commit-th-sha">SHA1</th>
                  <th class="pr-detail__commit-th-subject">{{ isGithub ? 'Message' : '备注' }}</th>
                  <th class="pr-detail__commit-th-date">{{ isGithub ? 'Date' : '提交日期' }}</th>
                  <th class="pr-detail__commit-th-actions">{{ isGithub ? 'Actions' : '操作' }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in pull.commitsByPR.get(selectedPR.index)"
                  :key="c.sha"
                  class="pr-detail__commit-row"
                >
                  <td class="pr-detail__commit-td-author">{{ c.authorName }}</td>
                  <td class="pr-detail__commit-td-sha">
                    <code class="pr-detail__commit-sha-code" :title="c.sha">{{ c.shortSha }}</code>
                  </td>
                  <td class="pr-detail__commit-td-subject">{{ c.subject }}</td>
                  <td class="pr-detail__commit-td-date">{{ formatDate(c.authoredAt) }}</td>
                  <td class="pr-detail__commit-td-actions">
                    <button
                      type="button"
                      class="pr-detail__commit-action-btn"
                      :title="isGithub ? 'Copy full SHA' : '复制完整 SHA'"
                      @click="copySha(c.sha)"
                    >
                      <Copy :size="12" :stroke-width="2" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="pr-detail__commit-action-btn"
                      :title="isGithub ? 'View commit on GitHub' : '在 Git Server 中查看此提交'"
                      @click="openCommitExternal(c.sha)"
                    >
                      <ExternalLink :size="12" :stroke-width="2" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <div v-else class="pr-detail__empty-hint">{{ isGithub ? 'No commits' : '暂无提交信息' }}</div>
          </div>

          <!-- 文件变动 Tab -->
          <div v-if="detailTab === 'files'" class="pr-detail__files">
            <PullFileComments
              :pr="selectedPR"
              :project-id="activeProjectId ?? ''"
            />
          </div>
        </div>
          </div>
          <!-- v0.7.28：右侧 sidebar（GitHub web 风格：Reviewers / Assignees / Labels /
               Projects / Milestone / Development / Notifications）
               v0.7.28 简版：渲染 4 个常用块（Reviewers / Assignees / Labels / Milestone）。
               Projects / Development / Notifications 留 v0.7.29 补（Projects 端点要
               调 GitHub GraphQL 拿 issue/71 项目关联，scope 较大）。 -->
          <aside class="pr-detail-sidebar" v-if="selectedPR">
            <!-- Reviewers -->
            <div class="pr-sidebar-block">
              <h3 class="pr-sidebar-block__title">{{ isGithub ? 'Reviewers' : '审阅人' }}</h3>
              <div class="pr-sidebar-block__content">
                <div
                  v-if="(selectedPR.reviewers ?? []).length === 0"
                  class="pr-sidebar-block__empty"
                >{{ isGithub ? 'No reviews' : '暂无审阅人' }}</div>
                <div
                  v-for="r in (selectedPR.reviewers ?? [])"
                  :key="r.username"
                  class="pr-sidebar-block__user"
                >
                  <div class="pr-sidebar-block__avatar">{{ r.username.charAt(0).toUpperCase() }}</div>
                  <span class="pr-sidebar-block__username">{{ r.username }}</span>
                </div>
              </div>
            </div>
            <!-- Assignees -->
            <div class="pr-sidebar-block">
              <h3 class="pr-sidebar-block__title">{{ isGithub ? 'Assignees' : '指派人' }}</h3>
              <div class="pr-sidebar-block__content">
                <div
                  v-if="(selectedPR.assignees ?? []).length === 0"
                  class="pr-sidebar-block__empty"
                >{{ isGithub ? 'No one—' : '尚未指派 — ' }}<span class="pr-sidebar-block__assign-link">{{ isGithub ? 'assign yourself' : '指派自己' }}</span></div>
                <div
                  v-for="a in (selectedPR.assignees ?? [])"
                  :key="a.username"
                  class="pr-sidebar-block__user"
                >
                  <div class="pr-sidebar-block__avatar">{{ a.username.charAt(0).toUpperCase() }}</div>
                  <span class="pr-sidebar-block__username">{{ a.username }}</span>
                </div>
              </div>
            </div>
            <!-- Labels -->
            <div class="pr-sidebar-block">
              <h3 class="pr-sidebar-block__title">{{ isGithub ? 'Labels' : '标签' }}</h3>
              <div class="pr-sidebar-block__content">
                <div
                  v-if="(selectedPR.labels ?? []).length === 0"
                  class="pr-sidebar-block__empty"
                >{{ isGithub ? 'None yet' : '暂无标签' }}</div>
                <div class="pr-sidebar-block__label-list">
                  <span
                    v-for="label in (selectedPR.labels ?? [])"
                    :key="label.id"
                    class="pr-sidebar-block__label"
                    :style="labelStyle(label.color)"
                  >{{ label.name }}</span>
                </div>
              </div>
            </div>
            <!-- Milestone -->
            <div class="pr-sidebar-block">
              <h3 class="pr-sidebar-block__title">{{ isGithub ? 'Milestone' : '里程碑' }}</h3>
              <div class="pr-sidebar-block__content">
                <div
                  v-if="!selectedPR.milestone"
                  class="pr-sidebar-block__empty"
                >{{ isGithub ? 'No milestone' : '暂无里程碑' }}</div>
                <div v-else class="pr-sidebar-block__milestone">
                  <GitBranch :size="14" :stroke-width="2" aria-hidden="true" />
                  <span>{{ selectedPR.milestone.title }}</span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <!-- 未选中 PR 空态 -->
      <section v-else class="pr-detail-panel pr-detail-panel--empty">
        <EmptyState
          :title="isGithub ? 'Select a pull request' : '选择一个合并请求'"
          :description="isGithub ? 'Click a pull request from the list to view details, comments, and actions' : '点击左侧列表查看详情、评论和操作'"
        />
      </section>
    </div>

    <!-- ============== 合并二次确认弹窗 ============== -->
    <ConfirmDialog
      :open="confirmMergeOpen"
      :title="isGithub ? 'Confirm merge' : '确认合并'"
      :description="confirmDescription"
      :confirm-label="isGithub ? 'I understand the risks, merge anyway' : '我了解风险，仍要合并'"
      :danger="isMainBranch(mergingPull?.base.ref ?? '')"
      @update:open="confirmMergeOpen = $event"
      @confirm="performMerge"
      @cancel="cancelMerge"
    >
      <!-- 合并方式选择 slot：放在 description 后面、确认按钮前面 -->
      <div class="merge-confirm__methods">
        <p class="merge-confirm__methods-title">{{ isGithub ? 'Choose merge method:' : '选择合并方式：' }}</p>
        <!-- A-3 P2 · B5 修法：默认只显示普通合并，高级方式折叠 -->
        <div class="merge-confirm__method-list">
          <label
            v-for="m in mergeMethods.filter((x) => !x.advanced || showAdvancedMethods)"
            :key="m.value"
            class="merge-confirm__method"
            :class="{ 'merge-confirm__method--active': selectedMethod === m.value }"
          >
            <input
              v-model="selectedMethod"
              type="radio"
              :value="m.value"
              class="merge-confirm__radio"
            />
            <span class="merge-confirm__method-label">{{ m.label }}</span>
            <span class="merge-confirm__method-hint">{{ m.hint }}</span>
          </label>
        </div>
        <!-- A-3 P2：高级方式 disclosure 开关
             v0.7.30 平台感知：GitHub 端走 "Advanced options" -->
        <button
          v-if="!showAdvancedMethods"
          type="button"
          class="merge-confirm__advanced-toggle"
          @click="showAdvancedMethods = true"
        >
          <ChevronDown :size="12" :stroke-width="2" aria-hidden="true" />
          <span>{{ isGithub ? 'Advanced options (rebase / squash)' : '高级选项（变基 / 压缩）' }}</span>
        </button>
        <button
          v-else
          type="button"
          class="merge-confirm__advanced-toggle"
          @click="showAdvancedMethods = false"
        >
          <ChevronUp :size="12" :stroke-width="2" aria-hidden="true" />
          <span>{{ isGithub ? 'Hide advanced options' : '收起高级选项' }}</span>
        </button>
        <!-- squash 需要输入 commitMessage -->
        <div v-if="needsCommitMessage(selectedMethod)" class="merge-confirm__message">
          <label class="merge-confirm__message-label" for="squash-msg">{{ isGithub ? 'Commit message (required):' : '合并提交信息（必填）：' }}</label>
          <input
            id="squash-msg"
            v-model="squashMessage"
            type="text"
            class="merge-confirm__message-input"
            :placeholder="isGithub ? 'Enter the commit message' : '请输入合并提交信息'"
            autocomplete="off"
          />
        </div>
        <!-- v0.6+：合并后顺手删除源分支（PM 选 merge 时最容易忘的清理）
             v0.7.30 平台感知：GitHub 端走 "Delete the source branch after merging" 文案 -->
        <div v-if="mergingPull" class="merge-confirm__delete-branch">
          <label class="merge-confirm__delete-branch-label">
            <input
              v-model="deleteBranchAfter"
              type="checkbox"
              class="merge-confirm__delete-branch-checkbox"
            />
            <span v-if="isGithub">Delete the source branch <code>{{ headLabel(mergingPull) }}</code> after merging</span>
            <span v-else>合并后删除源分支 <code>{{ headLabel(mergingPull) }}</code></span>
          </label>
          <p class="merge-confirm__delete-branch-hint">
            <template v-if="isGithub">
              When enabled, the <code>{{ headLabel(mergingPull) }}</code> branch will be deleted after the merge succeeds via <code>DELETE /git/refs/heads/&lt;ref&gt;</code>.
            </template>
            <template v-else>
              勾选后：合并成功时删除 <code>{{ headLabel(mergingPull) }}</code>。
              GitHub 合并成功后会调 DELETE /git/refs/heads/&lt;ref&gt;；Gitea 直接走 /pulls/{index}/merge 内置参数。
            </template>
          </p>
        </div>
      </div>
    </ConfirmDialog>

    <!-- ============== 删除评论二次确认弹窗（v0.5.0 M1） ============== -->
    <ConfirmDialog
      :open="confirmDeleteOpen"
      :title="isGithub ? 'Delete comment' : '删除评论'"
      :description="isGithub ? 'Are you sure you want to delete this comment? It cannot be recovered.' : '确定要删除这条评论吗？删除后无法恢复。'"
      :confirm-label="isGithub ? 'Delete' : '删除'"
      :danger="true"
      @update:open="confirmDeleteOpen = $event"
      @confirm="deletingComment && deleteComment(deletingComment.p, deletingComment.c)"
      @cancel="confirmDeleteOpen = false; deletingComment = null"
    />

    <!-- ============== 关闭二次确认弹窗 ============== -->
    <ConfirmDialog
      :open="confirmCloseOpen"
      title="确认关闭"
      :description="closeConfirmDescription"
      confirm-label="确认关闭"
      :danger="true"
      @update:open="confirmCloseOpen = $event"
      @confirm="performClose"
      @cancel="cancelClose"
    />

    <!-- ============== 属性编辑弹窗 ============== -->
    <ConfirmDialog
      :open="attrEditorOpen"
      title="编辑属性"
      :description="editingPull ? `编辑 #${editingPull.index} 的标签、指派人、评审人` : ''"
      confirm-label="保存"
      @update:open="attrEditorOpen = $event"
      @confirm="editingPull && saveAttrs(editingPull)"
      @cancel="closeAttrEditor"
    >
      <div class="attr-editor">
        <!-- 标签选择 -->
        <div class="attr-editor__section">
          <div class="attr-editor__label-row">
            <label class="attr-editor__label">标签：</label>
            <button
              type="button"
              class="attr-editor__add-btn"
              @click="showNewLabelInput = !showNewLabelInput"
              title="新建标签"
            >+ 新建</button>
          </div>
          <div v-if="showNewLabelInput" class="attr-editor__new-label">
            <input
              v-model="newLabelName"
              type="text"
              class="attr-editor__new-label-input"
              placeholder="标签名"
              autocomplete="off"
            />
            <input
              v-model="newLabelColor"
              type="color"
              class="attr-editor__new-label-color"
              title="标签颜色"
            />
            <button
              type="button"
              class="attr-editor__new-label-confirm"
              :disabled="!newLabelName.trim()"
              @click="createNewLabel"
            >{{ creatingLabel ? '创建中…' : '创建' }}</button>
          </div>
          <div class="attr-editor__tags">
            <label
              v-for="label in availableLabels"
              :key="label.name"
              class="attr-editor__tag"
              :class="{ 'attr-editor__tag--selected': editingLabels.includes(label.name) }"
              :style="{ '--tag-color': '#' + label.color, '--tag-bg': '#' + label.color + '22' }"
            >
              <input
                type="checkbox"
                :value="label.name"
                :checked="editingLabels.includes(label.name)"
                class="attr-editor__checkbox"
                @change="toggleLabel(label.name)"
              />
              <span>{{ label.name }}</span>
            </label>
          </div>
        </div>
        <!-- 指派人 -->
        <div class="attr-editor__section">
          <label class="attr-editor__label" for="attr-assignee">指派人：</label>
          <select
            id="attr-assignee"
            v-model="editingAssignees"
            class="attr-editor__select"
            multiple
          >
            <option
              v-for="member in availableMembers"
              :key="member"
              :value="member"
            >{{ member }}</option>
          </select>
          <span class="attr-editor__hint">按住 ⌘/Ctrl 多选</span>
        </div>
        <!-- 里程碑：v0.7.0 起 GitHub 数据源也开放（加载 GitHub milestones） -->
        <div class="attr-editor__section">
          <label class="attr-editor__label" for="attr-milestone">里程碑：</label>
          <select
            id="attr-milestone"
            v-model="editingMilestone"
            class="attr-editor__select"
          >
            <option value="">无</option>
            <option
              v-for="ms in availableMilestones"
              :key="ms.title"
              :value="ms.title"
            >{{ ms.title }}</option>
          </select>
        </div>
        <!-- 评审人 -->
        <div class="attr-editor__section">
          <label class="attr-editor__label">评审人：<span class="attr-editor__hint" v-if="nonReviewableMembers.size > 0">（组织账号不可作评审人）</span></label>
          <div class="attr-editor__tags">
            <label
              v-for="member in availableMembers"
              :key="member"
              class="attr-editor__tag"
              :class="{
                'attr-editor__tag--selected': editingReviewers.includes(member),
                'attr-editor__tag--disabled': nonReviewableMembers.has(member),
              }"
              :title="nonReviewableMembers.has(member) ? '组织账号不能作评审人' : ''"
            >
              <input
                type="checkbox"
                :value="member"
                :checked="editingReviewers.includes(member)"
                :disabled="nonReviewableMembers.has(member)"
                class="attr-editor__checkbox"
                @change="toggleReviewer(member)"
              />
              <span>{{ member }}{{ nonReviewableMembers.has(member) ? ' (组织)' : '' }}</span>
            </label>
          </div>
        </div>
      </div>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.merges {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.merges__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  /* v1.6.1 改用主区中性色（--color-shell-main-bg），跟主区同色
   * 区别靠 1px --color-divider 底边线分层 */
  background: var(--color-shell-main-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
}

.merges__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  min-width: 0;
}

.merges__title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.merges__title-h1 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.merges__repo {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merges__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.merges__counter {
  font-feature-settings: 'tnum';
}

/* A-3 P2 · B5 修法：顶栏只显示"默认：xxx" 提示文字，4 种合并方式不再
 * 用 select 全展开，避免 PM 默认看到所有技术选项 */
.merges__merge-method-hint {
  font-size: var(--font-xs);
  white-space: nowrap;
}

.merges__refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟 topbar / 主体内容同色
   * 旧值 --color-bg (#E8F1F5 浅苍蓝) 在新主区 #F8FAFC 上对比过强 */
  background: var(--color-shell-main-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}

.merges__refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.merges__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.merges__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟 topbar / 主体内容同色
   * 工具栏 = topbar 跟主体内容之间的"内嵌工具区", 视觉上跟两边同色 */
  background: var(--color-shell-main-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.merges__tabs {
  display: flex;
  gap: 2px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  padding: 2px;
}

.merges__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  background: transparent;
}

.merges__tab:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.merges__tab--active {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.merges__tab--active:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-inverse);
}

.merges__tab-count {
  font-size: var(--font-xs);
  /* v1.6.1 改主区中性色（--color-shell-main-bg），跟主区同色 */
  background: var(--color-shell-main-bg);
  color: var(--color-text-muted);
  padding: 0 5px;
  border-radius: var(--radius-pill);
  font-feature-settings: 'tnum';
}

.merges__tab--active .merges__tab-count {
  background: var(--color-primary-active);
  color: var(--color-text-inverse);
}

.merges__search {
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

.merges__search-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.merges__search-input:focus {
  background: transparent;
  box-shadow: none;
}

.merges__error {
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft);
  border-left: 3px solid var(--color-danger);
  font-size: var(--font-sm);
}

.merges__error-msg {
  color: var(--color-text);
  font-weight: 500;
  margin: 0 0 2px;
}

.merges__error-hint {
  color: var(--color-text-secondary);
  margin: 0;
}

.merges__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.merges__list {
  flex: 1;
  display: flex;
  flex-direction: column;
  /* v2.62：用 margin-top 替代 gap（某些 WebKit flex gap 有 bug，多 item 时产生多余空白） */
  margin: 0;
  padding: var(--space-4);
  overflow-y: auto;
  /* v0.6+ bugfix：防止 PR row 内部内容撑出整页横向滚动条 */
  overflow-x: hidden;
  & > li + li {
    margin-top: 2px;
  }
}

/* v2.62 滚动到底自动加载分页：哨兵 + 三状态视觉反馈 */
/* v0.6.1+：加载中动画已统一到 StatusBarPulse（底部状态栏心跳脉冲），merges__load-more-loading 和 merges__load-more-spinner 已移除 */
.merges__load-more {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: var(--space-4) 0;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-height: 56px;                /* v2.62：加大保证 IntersectionObserver 能可靠检测 */
  list-style: none;                /* li 默认有 disc bullet，去掉 */
  /* v2.62：idle 状态走脉冲呼吸动画提示用户可加载 */
  transition: opacity var(--t-base) var(--ease);
}
/* 不同状态的边框/背景提示 */
.merges__load-more[data-state='idle'] {
  opacity: 0.6;
}
.merges__load-more[data-state='end'] {
  opacity: 0.5;
}
.merges__load-more-idle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  animation: merges-load-idle-breath 2s ease-in-out infinite;
}
.merges__load-more-arrow {
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
.merges__load-more-end {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-style: normal;
  font-size: var(--font-xs);
}
.merges__load-more-divider {
  flex: 0 0 24px;
  height: 1px;
  background: var(--color-divider);
}
@keyframes merges-load-idle-breath {
  0%, 100% { opacity: 0.55; transform: translateY(0); }
  50% { opacity: 0.9; transform: translateY(2px); }
}

.merge-item {
  /* v0.6.24：去掉浅苍蓝背景色，使用透明背景，让整页背景色统一 */
  background: transparent;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  transition: background var(--t-fast) var(--ease);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: var(--space-3);
  /* v2.59：紧凑布局——padding 12px → 8px（v2.62 再降至 4px，消灭超多 MR 时的空行）。
     padding(4px)+gap(2px)=8px/item 间距，极致紧凑。 */
  padding: 4px var(--space-3);
}

.merge-item:hover {
  background: var(--color-bg-hover);
}
.merge-item:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.merge-item--open {
  border-left: 3px solid var(--color-success);
}

.merge-item--merged {
  border-left: 3px solid var(--color-accent);
}

.merge-item--closed {
  border-left: 3px solid var(--color-text-muted);
  opacity: 0.85;
}

/* ===== leading: 状态图标（gitea octicon-git-pull-request 风格） ===== */

.merge-item__leading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  align-self: center;
}

.merge-item__icon--open {
  color: var(--color-success);
}
.merge-item__icon--merged {
  color: var(--color-accent);
}
.merge-item__icon--draft {
  color: var(--color-warning);
}
.merge-item__icon--closed {
  color: var(--color-text-muted);
}

/* ===== main: 标题 + meta + body（gitea .flex-item-main） ===== */

.merge-item__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.merge-item__header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: nowrap;
}

.merge-item__title {
  font-size: var(--font-md);
  color: var(--color-text);
  font-weight: 600;
  text-decoration: none;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-item__title:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.merge-item__badge {
  font-size: var(--font-xs);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-weight: 500;
  flex-shrink: 0;
  /* title → badge 间距跟 .merge-item__timeline-btn 宽度(22px)等宽
   * —— header 自身 gap 4px + 本 margin 18px = 22px,视觉上像
   * "title 后留出一格时钟按钮的位置再放 badge"，
   * 让 title 跟 [badge+clock] 这一组在视觉上明确分块。
   * 一改时钟按钮宽度,这个值要跟着改。 */
  margin-left: 18px;
}

/* v1.4 · 任务 #merge-timeline-jump:
   header 上的时钟按钮 —— 跳时间轴定位到本合并请求的 head 提交
   视觉强调：默认就用主色软底 + 主色文字 + 主色描边(跟 TimelineView
   .commit-row.is-pr-focus 同一主色系),用户一眼能识别"点这个跳过去"。

   跟 title / badge 一起走 header 的 4px gap 紧贴成一组。 */
.merge-item__timeline-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  /* 默认态：主色软底 + 主色文字 + 1px 主色描边 —— 强调色,与 is-pr-focus 同源 */
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border: 1px solid color-mix(in srgb, var(--color-primary) 35%, transparent);
  flex-shrink: 0;
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    box-shadow var(--t-fast) var(--ease);
}
.merge-item__timeline-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 22%, transparent);
}
.merge-item__timeline-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}
.merge-badge--open {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.merge-badge--merged {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.merge-badge--closed {
  background: var(--color-bg-active);
  color: var(--color-text-secondary);
}
.merge-badge--draft {
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border: 1px solid var(--color-warning);
}

.merge-item__expand {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  flex-shrink: 0;
}
.merge-item__expand:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
  border-radius: var(--radius-sm);
}

.merge-item__body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px var(--space-2);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-width: 0;
}

.merge-item__index {
  color: var(--color-text-muted);
  font-weight: 600;
  text-decoration: none;
}
.merge-item__index:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.merge-item__meta-line {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  flex-wrap: wrap;
}

.merge-item__meta-text {
  color: var(--color-text-muted);
}

.merge-item__author-link,
.merge-item__author {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 500;
}
.merge-item__author-link:hover {
  text-decoration: underline;
}

/* 分支流向（gitea .branches 块） */
.merge-item__branches {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-width: 0;
}

.merge-item__branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  text-decoration: none;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-item__branch:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.merge-item__branch-arrow {
  color: var(--color-text-muted);
  font-size: 14px;
}

/* 属性块：标签 + 里程碑 + 指派人 + 评审人（gitea 合并请求属性块） */
.merge-item__attrs {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: var(--font-xs);
}

.merge-item__label {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--label-bg, var(--color-bg));
  color: var(--label-color, var(--color-text));
  /* v0.7.6：实心背景后边框去掉（labelStyle 返回 --label-border: transparent）——
     之前用 --label-color 当边框色会让深色 label 出现白边，跟 Gitea web 不一致。 */
  border: 1px solid transparent;
  font-weight: 500;
  white-space: nowrap;
}

.merge-item__milestone,
.merge-item__assignee,
.merge-item__reviewer,
.merge-item__comments {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* ===== trailing: 操作按钮（gitea 把操作放行内） ===== */

.merge-item__trailing {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.merge-item__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
  background: transparent;
  color: inherit;
  border: 1px solid var(--color-divider);
}
.merge-item__btn--merge {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-color: var(--color-primary);
}
.merge-item__btn--merge:hover:not(:disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}
.merge-item__btn--close {
  background: transparent;
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.merge-item__btn--close:hover:not(:disabled) {
  background: var(--color-danger-soft);
}
.merge-item__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.merge-item__conflict-hint {
  font-size: var(--font-xs);
  color: var(--color-warning);
  padding: 2px 6px;
  background: var(--color-warning-soft);
  border-radius: var(--radius-sm);
}

.merge-item__ext-link {
  display: inline-flex;
  align-items: center;
  padding: 4px 6px;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  transition: background var(--t-fast) var(--ease);
  text-decoration: none;
}
.merge-item__ext-link:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== 展开区：保留 meta 详细（gitea 合并请求详情页的属性块） ===== */

.merge-item__detail {
  grid-column: 1 / -1;
  padding: 5px var(--space-4) var(--space-4);
  border-top: 1px solid var(--color-divider);
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* v0.6.26: 加高对话区，让核心内容有更多空间 */
  min-height: 520px;
  max-height: min(90vh, 1000px);
  overflow: hidden;
}

.merge-item__detail-left {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

/* ===== v0.5.0 M4: 三 Tab 切换 —— 视觉区分 ===== */
.merge-item__detail-tabs {
  display: flex;
  gap: 0;
  margin: 4px 0 var(--space-3);
  padding: 0;
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  /* v0.6.30: 让 tabs 在上方固定，下方 tab 内容可以独立滚动 */
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--color-shell-main-bg);
}

.merge-item__detail-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 14px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px; /* 让 active 底边线和容器底边线重叠 */
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  white-space: nowrap;
  border-radius: 4px 4px 0 0;
  line-height: 1.3;
}

.merge-item__detail-tab:hover {
  color: var(--color-text);
  background: var(--color-primary-soft);
}

.merge-item__detail-tab--active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}

.merge-item__detail-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  border-radius: 9px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  line-height: 1;
}

.merge-item__detail-tab--active .merge-item__detail-tab-count {
  background: var(--color-primary);
  color: var(--color-shell-main-bg);
}

/* ===== v0.5.0 M4: Tab 内容区 公共边距 ===== */
.merge-item__detail-overview,
.merge-item__detail-files {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-top: var(--space-1);
}


/* v1.4 · 详情头部一行：meta 紧凑 + 编辑按钮（同行右对齐）*/
.merge-item__detail-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.merge-item__meta-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  padding: 0;
  flex: 1 1 auto;
  min-width: 0;
}
.merge-item__meta-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-width: 0;
}
.merge-item__meta-chip dt {
  margin: 0;
  color: var(--color-text-muted);
  font-weight: 500;
  white-space: nowrap;
}
.merge-item__meta-chip dd {
  margin: 0;
  color: var(--color-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.merge-item__detail-right {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* meta 区使用单列紧凑布局（v1.3：左栏只占 1/3，多列会挤） */
.merge-item__meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
}

.merge-item__meta-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: var(--font-xs);
}

.merge-item__meta-row dt {
  color: var(--color-text-muted);
  font-weight: 500;
  margin: 0;
  flex-shrink: 0;
  min-width: 36px;
}

.merge-item__meta-row dd {
  font-size: var(--font-sm);
  color: var(--color-text);
  margin: 0;
  /* 长 branch 名字可以断行 */
  word-break: break-all;
  overflow-wrap: anywhere;
  min-width: 0;
  flex: 1 1 0;
}

/* ===== 操作区 ===== */

/* (trailing/btn/conflict-hint/ext-link 已在前面 .merge-item__trailing 段定义) */

/* ===== 合并确认弹窗内嵌 ===== */

.merge-confirm__methods {
  margin-top: var(--space-3);
}

.merge-confirm__methods-title {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
  margin: 0 0 var(--space-2) 0;
}

.merge-confirm__method-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.merge-confirm__method {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}

.merge-confirm__method:hover {
  background: var(--color-bg-hover);
}

.merge-confirm__method--active {
  background: var(--color-primary-soft);
}

.merge-confirm__radio {
  margin: 0;
  accent-color: var(--color-primary);
}

.merge-confirm__method-label {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
}

.merge-confirm__method-hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

/* A-3 P2 · B5 修法：高级方式 disclosure 按钮 */
.merge-confirm__advanced-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--space-2);
  padding: 4px 8px;
  background: transparent;
  border: 1px dashed var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.merge-confirm__advanced-toggle:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-secondary);
}

.merge-confirm__message {
  margin-top: var(--space-3);
}

.merge-confirm__message-label {
  display: block;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.merge-confirm__message-input {
  width: 100%;
  padding: 4px 8px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-divider);
  font-size: var(--font-sm);
  color: var(--color-text);
}

.merge-confirm__message-input:focus {
  outline: 2px solid var(--color-primary);
  outline-offset: -1px;
}

/* v0.6+：合并后顺手删除源分支 checkbox */
.merge-confirm__delete-branch {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--color-divider) 70%, transparent);
}

.merge-confirm__delete-branch-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: var(--font-sm);
  color: var(--color-text);
}

.merge-confirm__delete-branch-label code {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
  padding: 1px 6px;
  background: var(--color-bg-hover);
  border-radius: 3px;
  color: var(--color-primary);
}

.merge-confirm__delete-branch-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--color-primary);
}

.merge-confirm__delete-branch-hint {
  margin: 6px 0 0 22px;
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.merge-confirm__delete-branch-hint code {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
  padding: 0 4px;
  background: var(--color-bg-hover);
  border-radius: 3px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ===== 编辑属性按钮 ===== */

.merge-item__edit-attrs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  margin-top: var(--space-2);
  background: transparent;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.merge-item__edit-attrs:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== 合并请求对话区（v1.3 · task #25 改）=====
 *
 * 移到右栏：占 detail 的 2/3 宽度。
 * 评论布局 = 聊天气泡：他人评论靠左 + 头像在左；"我"评论靠右 + 头像在右。
 * 评论列表在右栏内 flex:1 占满垂直空间（不再固定 max-height: 360px,
 * 跟右栏高度自适应），数据多了支持滚动。
 *
 * 设计参考：gitea 评论右栏、微信聊天风格。
 */

.merge-item__detail-right {
  /* v1.3.1：让右栏成为 flex column 容器,
   * 子项（header / list / compose）能按 flex 规则分配高度 */
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.merge-item__comments {
  display: flex;
  flex-direction: column;
  gap: 6px;                     /* v1.5.8：12 → 6，评论区子块紧凑 */
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
  /* v0.6.25：强制透明背景，去掉浅苍蓝强调色 */
  background: transparent;
  /* v0.6+ bugfix：保证评论体长文本不越出面板边缘，避免出现整页横向滚动条 */
  overflow-x: hidden;
}

/* ===== 顶部 header：左标题 + 右刷新按钮 ===== */
.merge-item__comments-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  flex-shrink: 0;
  padding-bottom: 5px;          /* v1.5.8：8 → 5 */
  border-bottom: 1px solid var(--color-divider-soft);
}

.merge-item__comments-header-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.merge-item__comments-title {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}

.merge-item__comments-count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 400;
  margin-left: 2px;
}

.merge-item__comments-refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;        /* v1.5：稍微大一点，方便点 */
  background: transparent;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.merge-item__comments-refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.merge-item__comments-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== v2.62 主体：历史对话 + 发送评论（上下布局，发送评论固定 100px） ===== */
.merge-item__comments-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  width: 100%;
  margin-bottom: 5px;
  /* v0.6.25：强制透明背景 */
  background: transparent;
}

/* 上：历史评论 + 各种态（loading/error/empty） */
.merge-item__comments-history {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
  overflow: hidden;
}

.merge-item__comments-loading,
.merge-item__comments-empty {
  display: flex;
  align-items: center;
  justify-content: center;  /* v1.5：水平居中 */
  gap: 6px;
  padding: 16px 8px;         /* v1.5：上下 padding 加大，让空态/加载态有"呼吸" */
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.merge-item__comments-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--color-warning-soft);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-warning);
}
.merge-item__comments-retry {
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-warning);
  cursor: pointer;
}
.merge-item__comments-retry:hover {
  background: var(--color-warning);
  color: var(--color-text-inverse);
}

/* ===== 气泡聊天列表（v1.3 重做）===== */

.merge-item__comment-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
  max-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  /* 独立响应：滚动到顶部/底部时不冒泡到外层 .merges__list */
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--color-divider) transparent;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
}

.merge-item__comment-list::-webkit-scrollbar {
  width: 6px;
}
.merge-item__comment-list::-webkit-scrollbar-track {
  background: transparent;
}
.merge-item__comment-list::-webkit-scrollbar-thumb {
  background: var(--color-divider);
  border-radius: 3px;
}
.merge-item__comment-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* 单条评论 li：聊天气泡布局（v0.6.26）
 * 默认 = 他人：左对齐，max-width 95%
 * --self = 我：右对齐，max-width 95% */
.merge-item__comment {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  margin: 0 0 10px;
  max-width: 95%;
  transition: opacity var(--t-fast) var(--ease);
}
.merge-item__comment--self {
  margin-left: auto;
  flex-direction: row-reverse;
  justify-content: flex-end;
}

/* v0.6.26：评论侧栏（头像 + 用户名垂直排列）— 更紧凑 */
.merge-item__comment-side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 40px;
  max-width: 50px;
}

/* 头像圈（首字母）— v0.6.26：彩色底区分作者 */
.merge-item__comment-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-bg-elevated);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  user-select: none;
  border: 1.5px solid var(--color-divider);
  flex-shrink: 0;
}
.merge-item__comment--self .merge-item__comment-avatar {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
}

/* 头像下方的用户名 */
.merge-item__comment-name {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  max-width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.merge-item__comment--self .merge-item__comment-name {
  color: var(--color-primary);
  font-weight: 500;
}

/* 气泡容器（v0.6.26 恢复聊天气泡效果） */
.merge-item__comment-bubble {
  flex: 1 1 0;
  min-width: 0;
  max-width: 100%;
  padding: 8px 12px;
  background: var(--color-bg-elevated);
  border: 1px solid rgba(128,128,128,0.3);
  border-radius: var(--radius-md);
  position: relative;
  overflow-wrap: break-word;
  word-wrap: break-word;
  word-break: break-word;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
/* 气泡小箭头（指向头像）—— 用 CSS border 画三角形（v0.6.26 恢复可见性） */
.merge-item__comment-bubble::before {
  content: '';
  position: absolute;
  top: 10px;
  width: 8px;
  height: 8px;
  background: var(--color-bg-elevated);
  border: 1px solid rgba(128,128,128,0.3);
  /* 默认（他人，左侧）：箭头指向左 */
  left: -5px;
  border-right: none;
  border-bottom: none;
  transform: rotate(45deg);
}

/* v0.6.26："我"的气泡用主色软底 + 主色边框 */
.merge-item__comment--self .merge-item__comment-bubble {
  background: var(--color-primary-alpha-22);
  border: 1.5px solid var(--color-primary-alpha-45);
  color: var(--color-text);
}
/* "我"的气泡里所有文字保持默认色（背景已透明） */
.merge-item__comment--self .merge-item__comment-author,
.merge-item__comment--self .merge-item__comment-time,
.merge-item__comment--self .merge-item__comment-self-tag,
.merge-item__comment--self .merge-item__comment-body {
  color: var(--color-text);
}
/* "我"的气泡里 markdown body 内链接保持默认主色 */
.merge-item__comment--self .merge-item__comment-body a {
  color: var(--color-primary);
  text-decoration: underline;
}

/* v1.5.11：复刻 Gitea 引用评论（v0.6.26 适配淡色气泡） */
.merge-item__comment-quote {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.merge-item__comment-bubble:hover .merge-item__comment-quote {
  opacity: 1;
}
.merge-item__comment-quote:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border-color: var(--color-primary);
}
/* v1.5.11：自己消息的气泡，hover 引用按钮也保持反色（深背景上） */
.merge-item__comment--self .merge-item__comment-quote {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
  color: var(--color-text-inverse);
}
.merge-item__comment--self .merge-item__comment-quote:hover {
  background: rgba(255, 255, 255, 0.25);
  color: var(--color-text-inverse);
  border-color: var(--color-text-inverse);
}
.merge-item__comment--self .merge-item__comment-bubble::before {
  left: auto;
  right: -5px;
  background: var(--color-primary-alpha-22);
  border-left: none;
  border-bottom: none;
  border-right: 1.5px solid var(--color-primary-alpha-45);
  border-top: 1.5px solid var(--color-primary-alpha-45);
  transform: rotate(45deg);
}

.merge-item__comment-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 5px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  flex-wrap: wrap;
}
.merge-item__comment-author {
  font-weight: 600;
  color: var(--color-text);
}
.merge-item__comment-self-tag {
  padding: 0 6px;
  font-size: 10px;
  font-weight: 500;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-radius: var(--radius-pill);
  line-height: 1.6;
}
.merge-item__comment-time {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.merge-item__comment-body {
  font-size: var(--font-sm);
  color: var(--color-text);
  word-break: break-all;
  overflow-wrap: break-word;
  white-space: normal;
  line-height: 1.5;
  max-width: 100%;
  min-width: 0;
}
/* 强制 .merge-item__comment-body 内的所有 markdown 节点都限制在气泡里（v0.6.26 用 :deep 穿透 v-html） */
.merge-item__comment-body > :deep(*),
.merge-item__comment-body :deep(p),
.merge-item__comment-body :deep(pre),
.merge-item__comment-body :deep(code),
.merge-item__comment-body :deep(ul),
.merge-item__comment-body :deep(ol),
.merge-item__comment-body :deep(li),
.merge-item__comment-body :deep(blockquote),
.merge-item__comment-body :deep(h1),
.merge-item__comment-body :deep(h2),
.merge-item__comment-body :deep(h3),
.merge-item__comment-body :deep(h4),
.merge-item__comment-body :deep(h5),
.merge-item__comment-body :deep(h6),
.merge-item__comment-body :deep(table) {
  max-width: 100%;
  min-width: 0;
  overflow-wrap: break-word;
  word-break: break-all;
}
.merge-item__comment-body :deep(pre),
.merge-item__comment-body :deep(pre code) {
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  overflow-x: auto;
  max-width: 100%;
}
.merge-item__comment-body :deep(code) {
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  overflow-x: auto;
  max-width: 100%;
}

/* 发评论输入区（v2.62 · 改到历史对话下方，固定 120px，发送按钮在输入框内右上角） */
.merge-item__comment-compose {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px;
  background: transparent;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  min-width: 0;
  height: 120px;
  flex-shrink: 0;
  overflow: hidden;
  transition: border-color var(--t-fast) var(--ease);
}
.merge-item__comment-compose:focus-within {
  border-color: var(--color-primary-alpha-45);
  box-shadow: 0 0 0 2px var(--color-primary-softer);
}

/* textarea + @ 候选下拉的相对定位容器（v2.62：内部右上角放发送按钮） */
.merge-item__comment-input-wrap {
  position: relative;
  display: flex;
  flex: 1 1 0;
  min-height: 0;
}

/* v2.62：发送按钮定位在输入框内右上角（圆形主色实色 + 阴影，复刻参考图） */
.merge-item__comment-send-absolute {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    opacity var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
  z-index: 2;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}
.merge-item__comment-send-absolute:hover:not(:disabled) {
  background: var(--color-primary-hover);
  transform: scale(1.08);
  box-shadow: 0 2px 6px rgba(var(--shadow-rgb), 0.22);
}
.merge-item__comment-send-absolute:active:not(:disabled) {
  transform: scale(0.96);
}
.merge-item__comment-send-absolute:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.merge-item__comment-send-absolute:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

/* v1.5.4：去掉 min-height，按你要求只保留 max-height 兜底
 *  - 高度由 rows 决定基础（rows=8 ≈ 8 行高），用 flex:1 在右列空间大时撑满
 *  - 空间不够时 flex shrink 到 rows 大小，输入框换行溢出由 max-height 触发滚动 */
.merge-item__comment-input {
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  max-height: 100%;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  font: inherit;
  font-size: var(--font-sm);
  color: var(--color-text);
  font-family: inherit;
  /* v2.62：右侧留 40px 给绝对定位的发送按钮，避免文本压在按钮下 */
  padding: 6px 40px 6px 8px;
  line-height: 1.5;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* v1.4 @ 提及下拉（绝对定位，浮在 textarea 上方） */
.merge-item__mention-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  max-height: 180px;
  overflow-y: auto;
  z-index: 5;
}

.merge-item__mention-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px var(--space-3);  /* v1.5：6 → 8，更易点 */
  background: transparent;
  border: none;
  font-size: var(--font-sm);
  color: var(--color-text);
  cursor: pointer;
}
.merge-item__mention-item:hover,
.merge-item__mention-item--active {
  background: var(--color-primary-soft, var(--color-bg-hover));
  color: var(--color-primary);
}
.merge-item__comment-input:focus {
  outline: none;
}
.merge-item__comment-input::placeholder {
  color: var(--color-text-muted);
}
.merge-item__comment-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.merge-item__comment-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-top: 2px;
  flex-shrink: 0;
}
.merge-item__comment-counter {
  margin-right: auto;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

/* ===== markdown 正文全局样式（v1.2）=====
 *
 * 给所有 .md-body 内的元素加 reset，避免 markdown-it 产出的 HTML 走浏览器默认样式
 * （gitea 评论在暗色主题下默认 <code> 黑色字看不清；<pre> 没滚动条等）。
 * 颜色用项目主题变量，不写死。
 *
 * v0.6.26: 所有子元素选择器用 :deep() 穿透 scoped CSS
 * (vhtml 动态内容没有 data-v-xxx 属性，普通子选择器不生效)
 */
.md-body {
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--color-text);
  word-break: break-all;
  overflow-wrap: break-word;
  max-width: 100%;
  min-width: 0;
}
.md-body :deep(p) {
  margin: 0 0 4px 0;
}
.md-body :deep(p:last-child) {
  margin-bottom: 0;
}
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3), .md-body :deep(h4), .md-body :deep(h5), .md-body :deep(h6) {
  margin: var(--space-3) 0 6px 0;
  font-weight: 700;
  line-height: 1.3;
  /* v0.7.x：让标题在 PR/评论正文里视觉层次明显（之前 h3=sm=13px 与正文同大） */
}
/* 仿 GitHub markdown-body：h1/h2 加顶 line 与 PR 描述区分段对齐 */
.md-body :deep(h1) { font-size: var(--font-xl); padding-bottom: 4px; border-bottom: 1px solid var(--color-divider); }
.md-body :deep(h2) { font-size: 18px; padding-bottom: 3px; border-bottom: 1px solid var(--color-divider); }
.md-body :deep(h3) { font-size: var(--font-lg); }
.md-body :deep(h4) { font-size: var(--font-md); }
.md-body :deep(h5), .md-body :deep(h6) { font-size: var(--font-sm); }
/* v0.7.x：PR 描述里 **Description:**、**Environment:** 等 “mac 伪 section header” */
.md-body :deep(strong) { font-weight: 700; color: var(--color-text); }
.md-body :deep(ul), .md-body :deep(ol) {
  margin: 6px 0;
  padding-left: 24px;
}
/* v0.7.x：reset.css 把 ul/ol 的 list-style 全局抹了，需要在 .md-body 内恢复。
   不动 reset.css 是避免全局反洗（评论 / 看板 依赖 list-style: none 的样式）。
   GitHub 也是在 .markdown-body 内独立恢复。 */
.md-body :deep(ul) {
  list-style-type: disc;
}
.md-body :deep(ol) {
  list-style-type: decimal;
}
.md-body :deep(ul ul),
.md-body :deep(ol ul) {
  list-style-type: circle;
  margin: 2px 0;
}
.md-body :deep(ol ol),
.md-body :deep(ul ol) {
  list-style-type: lower-alpha;
  margin: 2px 0;
}
.md-body :deep(li) { margin: 3px 0; }
/* v0.7.x：任务列表项（GFM 【- [ 】/- [X]）不应前置 ● bullet，
   只保留勾选框。GitHub .markdown-body 同款处理。 */
.md-body :deep(li.task-list-item) {
  list-style: none;
  position: relative;
}

/* v0.7.x：勾选框视觉与 GitHub .markdown-body 对齐
   markdown.ts 注入了 <span class="md-task-checkbox"></span> 占位 span，
   下面用 CSS 伪元素画真框（不依赖 emoji 字符大小）。
   与主题色 token 对齐：勾选用 --color-primary 填充。 */
.md-body :deep(.md-task-checkbox) {
  /* v0.7.x bugfix-2：用 inline-block + box-sizing: border-box，明确尺寸边界。
     之前 16/18px 在 inline 上下文里被父级 line-height 拦了一下，肉眼看不见。
     改 inline-flex 后尺寸永远 fixed，不受父级文字流约束。 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  /* v0.7.x bugfix-2（关键）：不要紧贴基线，不要受 line-height 压扁。
     把 vertical-align 设回 baseline 配 4px 偏移，让 span 在文本流里也稳。 */
  vertical-align: middle;
  margin: 0 8px 0 0;
  padding: 0;
  border: 2px solid var(--color-text-secondary);
  border-radius: 4px;
  background: transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
  cursor: default;
  flex-shrink: 0;
  /* v0.7.x 防护：min-w/h 防止 inline-block 在某些浏览器被压成 0 */
  min-width: 18px;
  min-height: 18px;
}
.md-body :deep(.md-task-checkbox::after) {
  /* v0.7.x bugfix-2：用 ::after 替代 ::before 画勾选
     某些浏览器对 inline-flex span 的 first-letter/::before 表现怪异，
     ::after 在 inline-flex 容器内更稳。 */
  content: '';
  width: 5px;
  height: 9px;
  border-right: 2.5px solid transparent;
  border-bottom: 2.5px solid transparent;
  transform: rotate(45deg) translate(0, -1px) scale(0);
  transition: transform 0.12s ease, border-color 0.12s ease;
  margin-top: -2px; /* 让勾选微微上抬对齐 checkbox 中心 */
}
.md-body :deep(.md-task-checkbox--checked) {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.md-body :deep(.md-task-checkbox--checked::after) {
  border-right-color: #fff;
  border-bottom-color: #fff;
  transform: rotate(45deg) translate(0, -1px) scale(1);
}
.md-body :deep(li > p) { margin: 0; }
.md-body :deep(blockquote) {
  margin: 4px 0;
  padding: 4px var(--space-3);
  border-left: 3px solid var(--color-divider);
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  word-break: break-all;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  max-width: 100%;
  min-width: 0;
}
.md-body :deep(blockquote > *) {
  word-break: break-all;
  overflow-wrap: break-word;
  max-width: 100%;
  min-width: 0;
}
.md-body :deep(code) {
  padding: 1px 6px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.9em;
  color: var(--color-accent);
  word-break: break-all;
  overflow-wrap: anywhere;
  overflow-x: auto;
  white-space: pre-wrap;
  max-width: 100%;
}
.md-body :deep(pre) {
  margin: 4px 0;
  padding: var(--space-2);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  overflow-x: auto;
  max-width: 100%;
  min-width: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.md-body :deep(pre code) {
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-size: inherit;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  overflow-x: auto;
  max-width: 100%;
}
.md-body :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
}
.md-body :deep(a:hover) {
  text-decoration: underline;
}
.md-body :deep(img) {
  max-width: 100%;
  max-height: 400px; /* v0.7.20：#74 PR 评论 body 含 200KB base64 大图，max-width 100% 后
    高度可能撑爆评论气泡（auto 让原图等比缩放，宽度 100% 时高度可能 3000+px）。
    限制 max-height 400px 保持气泡紧凑 + 避免加载慢（webview 解码 200KB base64
    慢，截图时图还没加载完 user 看到"评论信息不显示"）。点击图片看完整原图。 */
  height: auto;
  border-radius: var(--radius-sm);
}
.md-body :deep(table) {
  border-collapse: collapse;
  margin: 4px 0;
  font-size: var(--font-xs);
}
.md-body :deep(th), .md-body :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--color-divider);
}
.md-body :deep(th) {
  background: var(--color-bg);
  font-weight: 600;
}
.md-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--color-divider);
  margin: var(--space-2) 0;
}

/* ===== 属性编辑器弹窗内容 ===== */

.attr-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
  max-height: 60vh;
  overflow-y: auto;
  padding-right: var(--space-2);
}

.attr-editor__section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.attr-editor__label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.attr-editor__add-btn {
  background: transparent;
  border: 1px dashed var(--color-divider);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.attr-editor__add-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.attr-editor__new-label {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
}

.attr-editor__new-label-input {
  flex: 1;
  background: transparent;
  border: none;
  font-size: var(--font-sm);
  color: var(--color-text);
}
.attr-editor__new-label-input:focus { outline: none; }

.attr-editor__new-label-color {
  width: 28px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.attr-editor__new-label-confirm {
  padding: 2px 8px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  cursor: pointer;
}
.attr-editor__new-label-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.attr-editor__label {
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--color-text-muted);
}

.attr-editor__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  padding: 2px;
}

.attr-editor__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--tag-bg, var(--color-bg));
  border: 1px solid var(--tag-color, var(--color-divider));
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.attr-editor__tag--selected {
  background: var(--tag-color, var(--color-primary));
  color: var(--color-text-inverse);
}
.attr-editor__tag--disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.attr-editor__hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 400;
  margin-left: 4px;
}
.attr-editor__checkbox {
  margin: 0;
  accent-color: var(--color-primary);
}
.attr-editor__checkbox:disabled {
  cursor: not-allowed;
}

.attr-editor__select {
  padding: 4px 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  color: var(--color-text);
}

/* ===== v0.5.0 M1: 评论编辑 / 删除 ===== */
.merge-item__comment-edit-input {
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  border: 1.5px solid var(--color-primary-alpha-45);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--font-sm);
  line-height: 1.6;
  resize: vertical;
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.merge-item__comment-edit-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-softer);
}
.merge-item__comment-edit-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.merge-item__comment-edit-save,
.merge-item__comment-edit-cancel {
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  border: 1px solid;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.merge-item__comment-edit-save {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
}
.merge-item__comment-edit-save:hover:not(:disabled) {
  background: var(--color-primary-hover);
  transform: translateY(-1px);
}
.merge-item__comment-edit-save:active:not(:disabled) {
  transform: translateY(0);
}
.merge-item__comment-edit-save:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.merge-item__comment-edit-cancel {
  background: transparent;
  border-color: var(--color-divider);
  color: var(--color-text-muted);
}
.merge-item__comment-edit-cancel:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.merge-item__comment-editing-hint {
  font-size: 10px;
  color: var(--color-text-dim);
  margin-right: auto;
  font-style: italic;
}
.merge-item__comment-edited-mark {
  display: inline-block;
  font-size: 10px;
  color: var(--color-text-dim);
  margin-left: 6px;
  padding: 1px 5px;
  background: var(--color-bg-subtle);
  border-radius: var(--radius-xs);
  font-style: italic;
}
.merge-item__comment-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.merge-item__comment-edit-btn,
.merge-item__comment-delete-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  background: var(--color-bg-subtle);
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.merge-item__comment:hover .merge-item__comment-edit-btn,
.merge-item__comment:hover .merge-item__comment-delete-btn {
  opacity: 1;
}
.merge-item__comment-edit-btn:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-divider);
  color: var(--color-text);
}
.merge-item__comment-delete-btn:hover {
  background: var(--color-danger-soft);
  border-color: var(--color-danger);
  color: var(--color-danger);
}


/* ===== v0.5.0 M2: 评论表情反应 ===== */
.merge-item__comment-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}


/* ===== v0.5.0 M3: 评审按钮 ===== */
.merge-item__btn--approve {
  background: var(--color-success-soft, #dcfce7);
  border-color: var(--color-success, #16a34a);
  color: var(--color-success, #16a34a);
}
.merge-item__btn--approve:hover {
  background: var(--color-success, #16a34a);
  color: white;
}
.merge-item__btn--request-changes {
  background: var(--color-danger-soft, #fef2f2);
  border-color: var(--color-danger, #dc2626);
  color: var(--color-danger, #dc2626);
}
.merge-item__btn--request-changes:hover {
  background: var(--color-danger, #dc2626);
  color: white;
}
.merge-item__btn--review-comment {
  background: var(--color-bg-subtle);
  border-color: var(--color-border);
  color: var(--color-text-muted);
}
.merge-item__btn--review-comment:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== v0.6.26: PR 描述/正文 ===== */
.merge-item__detail-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-divider-soft);
  margin-bottom: 8px;
}
.merge-item__detail-body-label {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.merge-item__detail-body-content {
  font-size: var(--font-sm);
  color: var(--color-text);
  line-height: 1.6;
  word-break: break-word;
  overflow-wrap: break-word;
  max-width: 100%;
  min-width: 0;
}
.merge-item__detail-body-content :deep(p) { margin: 0 0 6px; }
.merge-item__detail-body-content :deep(p:last-child) { margin-bottom: 0; }
.merge-item__detail-body-content :deep(code) {
  background: var(--color-bg-subtle);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  font-size: 0.9em;
}
.merge-item__detail-body-content :deep(pre) {
  background: var(--color-bg-subtle);
  padding: 8px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.merge-item__detail-body-content :deep(pre code) {
  background: transparent;
  padding: 0;
}
.merge-item__detail-body-content :deep(a) {
  color: var(--color-primary);
  text-decoration: underline;
}
.merge-item__detail-body-content :deep(ul),
.merge-item__detail-body-content :deep(ol) {
  padding-left: 20px;
  list-style-type: revert; /* 恢复 GFM 默认 disc/decimal */
}
.merge-item__detail-body-content :deep(ul) {
  list-style-type: disc;
}
.merge-item__detail-body-content :deep(ol) {
  list-style-type: decimal;
}
.merge-item__detail-body-content :deep(li) { margin: 3px 0; }

/* ===== v0.5.0 M3: 评审区 ===== */
.merge-item__reviews {
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 12px;
}
.merge-item__reviews-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.merge-item__review-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  border-left: 3px solid var(--color-border);
  font-size: var(--font-sm);
}
.merge-item__review-item--approved {
  border-left-color: var(--color-success, #16a34a);
  background: var(--color-success-softer, #f0fdf4);
}
.merge-item__review-item--changes_requested {
  border-left-color: var(--color-danger, #dc2626);
  background: var(--color-danger-softer, #fef2f2);
}
.merge-item__review-item--commented {
  border-left-color: var(--color-text-muted);
}
.merge-item__review-state-badge {
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  white-space: nowrap;
}
.merge-item__review-item--approved .merge-item__review-state-badge {
  color: var(--color-success, #16a34a);
}
.merge-item__review-item--changes_requested .merge-item__review-state-badge {
  color: var(--color-danger, #dc2626);
}
.merge-item__review-author {
  font-weight: 600;
  color: var(--color-text);
}
.merge-item__review-body {
  flex: 1;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-item__review-time {
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  white-space: nowrap;
}

/* ===== v0.5.0 M3: 评审编辑器 ===== */
.merge-item__review-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.merge-item__review-editor-label {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-text-muted);
}
.merge-item__review-editor-input {
  width: 100%;
  min-height: 60px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
  color: var(--color-text);
  font-size: var(--font-sm);
  resize: vertical;
}
.merge-item__review-editor-input:focus {
  outline: none;
  border-color: var(--color-primary);
}
.merge-item__review-editor-actions {
  display: flex;
  gap: 6px;
}
.merge-item__review-submit {
  padding: 4px 14px;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: white;
  font-size: var(--font-xs);
  cursor: pointer;
}
.merge-item__review-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.merge-item__review-cancel {
  padding: 4px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
}
.merge-item__review-cancel:hover {
  background: var(--color-bg-hover);
}

/* ===== v0.5.0 M4: Review Event 系统卡片 (v0.6.26 优化) ===== */
.merge-item__comment--review-event {
  background: transparent;
  border-style: dashed;
  opacity: 0.9;
  padding-left: 4px;
}

/* ===== v0.6.26: 编辑态气泡高亮 ===== */
.merge-item__comment-bubble--editing {
  border-color: var(--color-primary-alpha-45) !important;
  box-shadow: 0 0 0 2px var(--color-primary-softer) !important;
}

.merge-item__comment--review-approved {
  border-left: 3px solid var(--color-success, #16a34a);
}
.merge-item__comment--review-changes_requested {
  border-left: 3px solid var(--color-danger, #dc2626);
}
.merge-item__comment--review-commented {
  border-left: 3px solid var(--color-text-muted);
}
.merge-item__comment-avatar--approved {
  background: var(--color-success, #16a34a);
  color: #fff;
}
.merge-item__comment-avatar--changes_requested {
  background: var(--color-danger, #dc2626);
  color: #fff;
}
.merge-item__comment-avatar--commented {
  background: var(--color-text-muted);
  color: #fff;
}
.merge-item__comment-bubble--event {
  border-style: dashed;
  background: transparent;
}
.merge-item__review-state-badge--approved {
  color: var(--color-success, #16a34a);
}
.merge-item__review-state-badge--changes_requested {
  color: var(--color-danger, #dc2626);
}
.merge-item__review-state-badge--commented {
  color: var(--color-text-muted);
}
.merge-item__comment-name--muted {
  font-style: italic;
}
.merge-item__comment-event-author {
  margin-top: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

/* ============================================================
 * v0.7 左右分栏布局（设计稿 merge-split-layout.html）
 * 左侧 PR 列表 380px + 右侧详情面板自适应
 * ============================================================ */

/* ===== 分栏容器 ===== */
.pr-split {
  flex: 1;
  display: grid;
  grid-template-columns: 380px 1fr;
  min-height: 0;
  overflow: hidden;
}

/* ===== 左侧 PR 列表面板 ===== */
.pr-list-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--color-divider);
  background: var(--color-shell-main-bg);
}

/* 左侧工具栏：筛选 + 搜索 */
.pr-list-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.pr-list-toolbar .merges__tabs {
  flex-wrap: wrap;
}

/* PR 列表滚动区 */
.pr-list-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  margin: 0;
  padding: var(--space-2);
  list-style: none;
}
.pr-list-scroll > li + li {
  margin-top: 2px;
}

/* PR 卡片（左侧列表项） */
.pr-card {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color var(--t-base) var(--ease);
  border: 1px solid transparent;
  list-style: none;
}
.pr-card:hover {
  background: var(--color-bg-hover);
}
.pr-card--selected {
  background: var(--color-bg-elevated);
  border-color: var(--color-primary);
}
.pr-card__icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  margin-top: 1px;
}
.pr-card__icon--open { color: var(--color-success); }
.pr-card__icon--merged { color: var(--color-primary-bright, var(--color-primary)); }
.pr-card__icon--draft { color: var(--color-warning); }
.pr-card__icon--closed { color: var(--color-text-muted); }

.pr-card__body {
  flex: 1;
  min-width: 0;
}
.pr-card__title-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin-bottom: 2px;
}
.pr-card__title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.pr-card__num {
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  font-weight: 400;
  flex-shrink: 0;
}
.pr-card__branches {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: var(--space-1);
}
.pr-card__branch {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--color-bg-elevated);
  border-radius: 3px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-card__branch--dst {
  background: var(--color-primary-soft);
  color: var(--color-primary-bright, var(--color-primary));
  font-weight: 600;
}
.pr-card__branch-arrow {
  color: var(--color-text-muted);
  font-size: 10px;
}
.pr-card__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.pr-card__author {
  font-weight: 500;
  color: var(--color-text-secondary);
}
.pr-card__badge {
  margin-left: auto;
}
.pr-card__conflict {
  color: var(--color-danger);
  font-weight: 500;
}

/* ===== 右侧 PR 详情面板 ===== */
.pr-detail-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-shell-main-bg);
  overflow: hidden;
}
.pr-detail-panel--empty {
  align-items: center;
  justify-content: center;
}

/* v0.7.28：两列布局（主内容 + 右侧 sidebar，GitHub web 风格） */
.pr-detail-layout {
  display: flex;
  height: 100%;
  min-height: 0;
}
.pr-detail-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.pr-detail-sidebar {
  width: 280px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-divider);
  padding: var(--space-4);
  overflow-y: auto;
  background: var(--color-shell-main-bg);
}
.pr-sidebar-block {
  margin-bottom: var(--space-4);
}
.pr-sidebar-block__title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: var(--space-2);
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--color-divider);
}
.pr-sidebar-block__empty {
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  font-style: italic;
}
.pr-sidebar-block__assign-link {
  color: var(--color-link);
  cursor: pointer;
}
.pr-sidebar-block__user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 0;
  font-size: var(--font-sm);
}
.pr-sidebar-block__avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-accent);
  color: var(--color-shell-main-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}
.pr-sidebar-block__username {
  color: var(--color-text);
}
.pr-sidebar-block__label-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pr-sidebar-block__label {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.pr-sidebar-block__milestone {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-sm);
  color: var(--color-text);
}

/* 详情头部 */
.pr-detail-header {
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.pr-detail-header__top {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
.pr-detail-header__status-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  margin-top: 2px;
}
.pr-detail-header__title-area {
  flex: 1;
  min-width: 0;
}
.pr-detail-header__title {
  font-size: var(--font-xl);
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
  line-height: 1.3;
}
.pr-detail-header__subtitle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  flex-wrap: wrap;
}
.pr-detail-header__badge {
  font-size: var(--font-xs);
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
.pr-detail-header__ext {
  flex-shrink: 0;
}

/* Meta 信息条 */
.pr-detail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  flex-shrink: 0;
}
.pr-detail-meta__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pr-detail-meta__item dt {
  color: var(--color-text-muted);
  font-weight: 500;
  margin: 0;
}
.pr-detail-meta__item dd {
  color: var(--color-text);
  font-weight: 500;
  margin: 0;
}
.pr-detail__branch {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--color-bg-elevated);
  border-radius: 3px;
}
.pr-detail__branch--dst {
  background: var(--color-primary-soft);
  color: var(--color-primary-bright, var(--color-primary));
  font-weight: 600;
}
/* v0.7.6：分支链接样式 —— 鼠标 hover 出现下划线 + 颜色变深，跟 Gitea web
   蓝色分支链接行为一致；不破坏默认 inline 紧凑布局。 */
.pr-detail__branch--link {
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s, background 0.15s;
}
.pr-detail__branch--link:hover {
  text-decoration: underline;
  filter: brightness(1.1);
}
.pr-detail__label {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  margin-right: 2px;
  color: var(--label-color);
  background: var(--label-bg);
  border: 1px solid var(--label-border, transparent);
  font-weight: 500;
}
.pr-detail__edit-attrs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--color-divider);
  color: var(--color-text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.pr-detail__edit-attrs:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* 操作按钮区（内嵌在 Meta 信息条右侧，靠右贴边） */
.pr-detail-meta__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pr-detail__conflict-hint {
  color: var(--color-danger);
  font-size: var(--font-xs);
  font-weight: 500;
  padding: 2px 8px;
  background: var(--color-danger-soft);
  border-radius: var(--radius-sm);
}

/* 按钮样式（复用现有 btn 系统，补充 sm 变体） */
.btn-primary-sm {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-text-inverse, #fff);
  font-size: var(--font-sm);
  font-weight: 600;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--t-base) var(--ease);
}
.btn-primary-sm:hover:not(:disabled) {
  background: var(--color-primary-hover);
}
.btn-primary-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-ghost-sm {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-sm);
  border: 1px solid var(--color-divider);
  cursor: pointer;
  font-family: inherit;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.btn-ghost-sm:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.btn-ghost-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-approve-sm {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-success-soft);
  border: 1px solid var(--color-success);
  color: var(--color-success);
  font-size: var(--font-sm);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.btn-approve-sm:hover:not(:disabled) {
  background: var(--color-success);
  color: #fff;
}
.btn-approve-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-request-changes-sm {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  border: 1px solid var(--color-warning);
  color: var(--color-warning);
  font-size: var(--font-sm);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.btn-request-changes-sm:hover:not(:disabled) {
  background: var(--color-warning);
  color: #1a1a1a;
}
.btn-request-changes-sm:disabled { opacity: 0.5; cursor: not-allowed; }

/* 评审编辑器 */
.pr-detail__review-editor {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.pr-detail__review-editor-header {
  margin-bottom: var(--space-2);
}
.pr-detail__review-editor-label {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
}
.pr-detail__review-editor-input {
  width: 100%;
  min-height: 60px;
  padding: var(--space-2);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-sm);
  font-family: inherit;
  resize: vertical;
  outline: none;
}
.pr-detail__review-editor-input:focus {
  border-color: var(--color-primary);
}
.pr-detail__review-editor-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

/* Tab 导航 */
.pr-detail-tabs {
  display: flex;
  gap: var(--space-1);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  height: 38px;
  flex-shrink: 0;
}
.pr-detail-tab {
  height: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-3);
  border-bottom: 2px solid transparent;
  border-top: none;
  border-left: none;
  border-right: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: var(--font-sm);
  cursor: pointer;
  font-family: inherit;
  transition: color var(--t-base) var(--ease), border-color var(--t-base) var(--ease);
}
.pr-detail-tab:hover { color: var(--color-text); }
.pr-detail-tab--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.pr-detail-tab--disabled:hover { color: var(--color-text-secondary); }
.pr-detail-tab--active {
  color: var(--color-text);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}
.pr-detail-tab__count {
  font-size: var(--font-xs);
  padding: 0 5px;
  border-radius: 8px;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
}
.pr-detail-tab--active .pr-detail-tab__count {
  background: var(--color-primary-soft);
  color: var(--color-primary-bright, var(--color-primary));
}

/* Tab 加载波形动画（声纹风格） */
.pr-detail-tab__wave {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  height: 14px;
}
.pr-detail-tab__wave i {
  display: block;
  width: 2px;
  height: 4px;
  background: var(--color-primary);
  border-radius: 1px;
  animation: tab-wave 0.8s ease-in-out infinite;
}
.pr-detail-tab__wave i:nth-child(2) {
  animation-delay: 0.15s;
  height: 8px;
}
.pr-detail-tab__wave i:nth-child(3) {
  animation-delay: 0.3s;
  height: 6px;
}
@keyframes tab-wave {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
}

/* Tab 内容滚动区 */
.pr-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  min-height: 0;
}

/* 概览 Tab */
.pr-detail__overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pr-detail__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pr-detail__section-label {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pr-detail__section-content {
  padding: var(--space-3);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--color-text-secondary);
}
/* 合并检查警告区（v0.7.0：对齐 Gitea web 的「此分支已包含」红框） */
.pr-detail__merge-warning {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  margin: var(--space-3) 0;
  color: var(--color-danger);
  transition: padding 0.15s ease;
}
/* 收起态：红框整体变矮 — padding 缩小，让外框跟着内容收缩 */
.pr-detail__merge-warning--collapsed {
  padding: var(--space-2) var(--space-3);
}
.pr-detail__merge-warning--collapsed .pr-detail__merge-warning-title {
  font-size: var(--font-sm);
}
.pr-detail__merge-warning svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.pr-detail__merge-warning-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pr-detail__merge-warning-title {
  font-weight: 600;
  color: var(--color-danger);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  cursor: pointer; /* v0.7.x: 标题行整体作为 toggle 入口，鼠标变手型 */
  user-select: none;
}
.pr-detail__merge-warning-title:hover {
  background: var(--color-bg-hover);
  border-radius: var(--radius-sm);
  padding: var(--space-1);
  margin: calc(-1 * var(--space-1)); /* 抵消 padding，避免外框抖动 */
}
.pr-detail__merge-warning-title:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
.pr-detail__merge-warning-toggle {
  /* Chevron 图标装饰元素 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.pr-detail__merge-warning-help {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
}

/* ===== v0.7.28 PR 关闭状态块（GitHub web 风格，timeline 下方） ===== */
.pr-detail__closed-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  margin-top: var(--space-3);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
}
.pr-detail__closed-banner-icon {
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.pr-detail__closed-banner--merged .pr-detail__closed-banner-icon {
  color: #8957e5; /* GitHub merged 紫 */
}
.pr-detail__closed-banner--unmerged .pr-detail__closed-banner-icon {
  color: #cf222e; /* GitHub closed 红 */
}
.pr-detail__closed-banner-text {
  flex: 1;
  min-width: 0;
}
.pr-detail__closed-banner-title {
  font-weight: 600;
  color: var(--color-text);
}
.pr-detail__closed-banner-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-sm);
  margin-top: 2px;
}
/* v0.7.29：Delete branch 按钮（Closed 状态块右侧，GitHub web 风格） */
.pr-detail__closed-banner-action {
  flex-shrink: 0;
  margin-left: auto;
}

/* v0.7.28-29 注释保留：早期版本 Restore branch 按钮是独立 <li>（带 left rail
   RotateCcw icon dot）。v0.7.31 已搬到 delete_branch event 主行 pr-detail__event-line 内
   （v-if="isGithub && item.type === 'delete_branch' && ..."），独立 <li> 删了。
   下面 2 条 CSS 规则已无引用，删掉避免 dead code：
     - .pr-detail__timeline-item--restore-action
     - .pr-detail__timeline-dot--restore
   保留这条注释是方便历史溯源。 */

.pr-detail__restore-btn {
  margin-left: var(--space-2);
}
/* v0.7.31：Restore branch 按钮在 event-line 内（同行右侧）样式微调
   比独立 <li> 时的版本小一号，跟主行文字大小一致（Gitea web 实际就是小按钮） */
.pr-detail__restore-btn--inline {
  margin-left: auto;       /* flex 推到最右 */
  padding: 2px 10px;
  font-size: var(--font-sm);
  line-height: 1.4;
}
.pr-detail__merge-warning-step {
  font-weight: 600;
  margin-bottom: var(--space-1);
}
.pr-detail__merge-warning-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-sm);
  margin-bottom: var(--space-2);
}
.pr-detail__merge-warning-cmd {
  margin: 0;
  padding: var(--space-2);
  background: var(--color-code-bg, #0d1117);
  color: var(--color-code-text, #c9d1d9);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-sm);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  white-space: pre;
}

/* v0.7.25：Gitea web pull_merge_box.tmpl 真实布局 —— 多个 item 块
   1. WIP 警告 + 右侧"删除 WIP: 前缀"按钮（flex-left-right）
   2. 过期警告 + 右侧"通过合并更新分支"按钮（v0.7.26 TODO）
   3. 命令行提示 + 默认折叠 + 展开显示 检出+合并 2 步骤
   4. 冲突警告 */
.pr-detail__merge-warning--flex {
  /* WIP 警告行：左 icon+文字 + 右按钮，flex 分两端 */
  display: block;
  padding: var(--space-3) var(--space-4);
}
.pr-detail__merge-warning-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pr-detail__merge-warning-row--toggle {
  cursor: pointer;
  user-select: none;
  padding: var(--space-1) var(--space-2);
  margin: calc(-1 * var(--space-1)) calc(-1 * var(--space-2));
  border-radius: var(--radius-sm);
}
.pr-detail__merge-warning-row--toggle:hover {
  background: var(--color-bg-hover);
}
.pr-detail__merge-warning-row--toggle:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.pr-detail__merge-warning-icon {
  flex-shrink: 0;
  color: var(--color-danger);
}
.pr-detail__merge-warning-text {
  flex: 1;
  font-weight: 500;
  color: var(--color-danger);
}
.pr-detail__merge-warning-action {
  flex-shrink: 0;
  margin-left: auto;
}
.pr-detail__review-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pr-detail__review-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px dashed var(--color-divider);
  font-size: var(--font-sm);
}
.pr-detail__review-item--approved { border-color: var(--color-success); background: var(--color-success-soft); }
.pr-detail__review-item--changes_requested { border-color: var(--color-warning); background: var(--color-warning-soft); }
.pr-detail__review-item--commented { border-color: var(--color-divider); }
.pr-detail__review-state-badge {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
  flex-shrink: 0;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
}
.pr-detail__review-state-badge--approved { background: var(--color-success); color: #fff; }
.pr-detail__review-state-badge--changes_requested { background: var(--color-warning); color: #1a1a1a; }
.pr-detail__review-author { font-weight: 600; color: var(--color-text); }
.pr-detail__review-body { color: var(--color-text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-detail__review-time { color: var(--color-text-muted); font-size: var(--font-xs); flex-shrink: 0; }
.pr-detail__empty-hint { color: var(--color-text-muted); font-size: var(--font-sm); padding: var(--space-3); }

/* ===== v0.7.3：dismiss_review reason comment 卡（拆 2 卡） =====
   复用 .pr-detail__timeline-avatar + .pr-detail__comment-bubble 通用样式，
   这里只调特定 sub-modifier：avatar 灰底 + "驳回原因" tag */
.pr-detail__comment-dismiss-reason-tag {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.pr-detail__comment-dismiss-reason-tag {
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.pr-detail__comment-event-detail {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  width: 100%;
}
.pr-detail__comment-event-detail > span,
.pr-detail__comment-event-detail > a {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.pr-detail__event-strike {
  text-decoration: line-through;
  color: var(--color-text-muted);
}
.pr-detail__event-arrow {
  color: var(--color-text-muted);
  font-size: 11px;
  margin: 0 2px;
}
.pr-detail__event-emphasis {
  font-weight: 600;
  color: var(--color-text);
}
.pr-detail__event-username {
  font-family: var(--font-mono);
  color: var(--color-text);
}
.pr-detail__event-plus,
.pr-detail__event-minus {
  font-weight: 700;
  font-size: 13px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.pr-detail__event-plus { background: var(--color-success, #2da44e); }
.pr-detail__event-minus { background: var(--color-danger,  #cf222e); }
.pr-detail__event-hint {
  color: var(--color-text-muted);
  font-size: 11px;
}
.pr-detail__event-branch {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider-soft);
  border-radius: 3px;
  color: var(--color-text);
}
.pr-detail__event-link {
  color: var(--color-link, var(--color-primary));
  text-decoration: none;
  font-weight: 500;
}
.pr-detail__event-link:hover {
  text-decoration: underline;
}
/* Label chip —— 复用属性编辑器的 labelStyle 颜色逻辑（v0.7.6：实心 + 自动文字色） */
.pr-detail__event-label {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 500;
  border: 1px solid var(--label-border, transparent);
  background: var(--label-bg, var(--color-bg-hover));
  color: var(--label-color, var(--color-text));
}

/* v0.7.6：label 事件多 chip 容器（合并后 add+remove 多个 label 横向排列） */
.pr-detail__event-labels {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
/* v0.7.6：add label 加左边 + 号提示（去掉后用 line-through + 灰底区分） */
.pr-detail__event-label--add {
  position: relative;
  padding-left: 14px;
}
.pr-detail__event-label--add::before {
  content: "+";
  position: absolute;
  left: 5px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  font-weight: 700;
  /* 实心 label 背景上 + 号用半透明白，跟 label 文字色协调（亮 / 暗都可见） */
  color: var(--label-color);
  opacity: 0.75;
}
.pr-detail__event-label--remove {
  position: relative;
  padding-left: 14px;
  text-decoration: line-through;
  text-decoration-color: var(--label-color);
  text-decoration-thickness: 1.5px;
  opacity: 0.75;
}
.pr-detail__event-label--remove::before {
  content: "−";
  position: absolute;
  left: 5px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  font-weight: 700;
  color: var(--label-color);
  opacity: 0.75;
}

/* v0.7.6：评论 body 缺失占位 —— 显示 "(无内容)" 让用户知道这是服务端没 body，
   不是 bug。颜色用 muted 跟"已编辑"mark 风格一致。 */
.pr-detail__comment-body--empty {
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--color-text-muted);
  font-style: italic;
}

/* v0.7.3：review event 不再需要独立的虚线边框样式（avatar 节点颜色档已表达 review state） */

/* 文件变动 Tab */
.pr-detail__files {
  min-height: 0;
}

/* 代码提交 Tab —— 撑满 body 并用负 margin 抵消 body padding，让 thead sticky 贴顶 */
.pr-detail__commits {
  min-height: 0;
  margin: calc(-1 * var(--space-4));
  margin-bottom: 0;
  /* v0.7.x bugfix：用 flex column 撑满 pr-detail-body 高度，让 table 内部滚动条能正常工作。
     pr-detail-body 本身有 overflow-y: auto；这里把 pr-detail__commits 改为 flex 容器，
     把 table 滚动画限在 .pr-detail__commit-scroll 里。 */
  display: flex;
  flex-direction: column;
  height: calc(100% + var(--space-4));
}
/* v0.7.x bugfix：table 外包一层独立滚动容器，让 thead sticky 真正在这个容器里生效。
   直接让 pr-detail-body 滚的话，sticky 会被祖先滚动条的 overflow 屏障淹没，
   导致部分浏览器表现异常 —— 这也是行内容透出 sticky 表的根因之一。 */
.pr-detail__commit-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  position: relative;
}
.pr-detail__commit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.pr-detail__commit-table thead {
  position: sticky;
  top: 0;
  z-index: 2;
  /* v0.7.x bugfix：thead background 给 thead 本身还不够，滚动时 tbody 行仍会从 th 间隙透出。
     background 必须显式标给 th —— th 默认 background: transparent，会透出下方行文字。 */
  background: var(--color-bg);
  box-shadow: inset 0 -1px 0 var(--color-border);
}
.pr-detail__commit-table thead th {
  background: var(--color-bg);
}
.pr-detail__commit-row {
  border-bottom: 1px solid var(--color-border);
  transition: background 0.12s;
}
.pr-detail__commit-row:hover {
  background: var(--color-bg-hover);
}
.pr-detail__commit-table td {
  padding: 6px 10px;
  vertical-align: middle;
}
.pr-detail__commit-td-author {
  font-weight: 600;
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pr-detail__commit-td-sha {
  white-space: nowrap;
}
.pr-detail__commit-sha-code {
  font-family: var(--font-mono, 'SF Mono', monospace);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--color-bg-secondary, rgba(128, 128, 128, 0.15));
  color: var(--color-text-secondary);
  cursor: pointer;
}
.pr-detail__commit-td-subject {
  color: var(--color-text);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-detail__commit-td-date {
  color: var(--color-text-secondary);
  white-space: nowrap;
  font-size: 12px;
}
.pr-detail__commit-td-actions {
  white-space: nowrap;
  display: flex;
  gap: 4px;
}
.pr-detail__commit-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.12s;
}
.pr-detail__commit-action-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: var(--color-primary);
}

/* 对话 Tab */
.pr-detail__conversation {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* v0.7.10：删 .pr-detail__conv-header / .pr-detail__conv-header-left /
   .pr-detail__conv-count —— 对话标题 div 整块移除（user 反馈），CSS 同步删。 */
.pr-detail__conv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.pr-detail__conv-loading,
.pr-detail__conv-error,
.pr-detail__conv-empty {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--font-sm);
}
.pr-detail__conv-error { color: var(--color-danger); }

/* ===== v0.7.3：PR timeline —— 对齐 Gitea web .comment-list timeline 视觉 =====
   关键视觉：
   1. .pr-detail__timeline::before 在 ul 上画左侧贯穿灰色竖线（2px，颜色 --color-timeline）
   2. 每个 timeline-item 用绝对定位把 avatar/icon 节点放到竖线上
   3. avatar/icon 节点是圆形，背景与卡片背景同色，把竖线"切断"在节点处
   4. system event / review event 是单行紧凑布局 —— 不像 comment 那样有大块气泡
   5. comment 卡保持原 bubble 布局（header + body + actions） */
.pr-detail__timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 32px;       /* 左侧留 32px 给 avatar/icon 节点 */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pr-detail__timeline::before {
  content: "";
  position: absolute;
  top: 14px;                  /* 第一个 avatar 中心对齐 */
  bottom: 14px;               /* 最后一个 avatar 中心对齐 */
  left: 14px;                 /* 竖线在 padding 32px 的中间 */
  width: 2px;
  /* v0.7.4：用 --color-timeline（专门 token，比 --color-divider 略亮）——
     暗色 18% / 亮色 16% alpha，确保 timeline 序列感可见但不喧宾夺主 */
  background: var(--color-timeline, var(--color-divider));
  border-radius: 1px;
  z-index: 0;
}
.pr-detail__timeline-item {
  position: relative;         /* 让 .pr-detail__timeline-rail 绝对定位生效 */
  padding: 2px 0;
  min-height: 28px;
}
/* 普通评论卡 (timeline-item--comment) —— 用大块气泡布局 */
.pr-detail__timeline-item--comment {
  padding: 6px 0;
}
/* 评审事件 / 系统事件 (timeline-item--event) —— 单行紧凑 */
.pr-detail__timeline-item--event {
  display: flex;
  align-items: center;
  gap: 0;                     /* gap 在 rail / event-content 内各自定义 */
  min-height: 26px;
  padding: 4px 0;
}

/* ===== Avatar (comment) / Dot (event) 节点 —— 定位在 timeline 竖线上 ===== */
.pr-detail__timeline-rail {
  position: absolute;
  left: -32px;                /* 对齐 ul 的 padding-left: 32px */
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  z-index: 1;                 /* 盖住竖线 */
  display: flex;
  align-items: center;
  justify-content: center;
}
/* comment avatar：圆形 + 边框（边框色 == ul 背景色 = 切断竖线） */
.pr-detail__timeline-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-bg-elevated);
  border: 2px solid var(--color-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 12px;
  color: var(--color-text-secondary);
  user-select: none;
}
.pr-detail__timeline-avatar--dismiss {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
}
/* v0.7.21 根因修复：恢复 v0.7.10 之前的 22px dot + 13px icon 设定 —— 对齐 Gitea web
   端 timeline 实际渲染大小（Gitea web 端 dot 是 22px + icon 13px + 文字 13px）。
   v0.7.10 我把 dot 22→26 + icon 13→15 + 文字 13→14 是基于 user "icon 大一点点"
   反馈放大，但实际对齐 Gitea web 应该回到原值。user 反馈 "icon、文字需要恢复
   之前设定的大小"，指的就是这个。 */
.pr-detail__timeline-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--color-bg-elevated);
  border: 1.5px solid var(--color-divider);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  flex-shrink: 0;
}
/* 5 档颜色 —— 对齐 Gitea web .badge 语义色 */
.pr-detail__timeline-dot--success { color: var(--color-success); border-color: var(--color-success); }
.pr-detail__timeline-dot--danger  { color: var(--color-danger);  border-color: var(--color-danger); }
.pr-detail__timeline-dot--merge   { color: #8250df;             border-color: #8250df; }
.pr-detail__timeline-dot--warn    { color: #d4a72c;             border-color: #d4a72c; }
.pr-detail__timeline-dot--neutral { color: var(--color-text-muted); border-color: var(--color-divider); }
/* 评审事件 dot 颜色按 state */
.pr-detail__timeline-dot--review-approved { color: var(--color-success); border-color: var(--color-success); }
.pr-detail__timeline-dot--review-changes_requested { color: var(--color-danger); border-color: var(--color-danger); }
.pr-detail__timeline-dot--review-commented { color: var(--color-text-muted); border-color: var(--color-divider); }

/* ===== System Event 紧凑单行（对齐 Gitea web .timeline-item event） ===== */
.pr-detail__timeline-item--system .pr-detail__event-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  /* v0.7.17 根因修复：pr-detail__event-content 内部子块（主行 + inline + block）
     各自保持 1 行渲染，超出部分溢出隐藏 —— user 反馈"pr-detail__event-content
     当中内容，应该尽量 1 行显示完，不要多行显示"。主行 / inline 块强制不换行
     （v0.7.10 加的 flex-wrap: wrap 让长内容在主行宽度不够时换行成 2 行，user
     期望跟 Gitea web 1 行渲染一致）。block 块（push event commit 列表）保留
     column 布局（每 commit 一行对齐 Gitea web `commits_list_small` 模板）。 */
  overflow: hidden;
}
/* v0.7.17 根因修复：event-line 主行强制 1 行（之前 v0.7.10 加的 flex-wrap: wrap
   让长内容"X 于 Y 合并提交 f30ece070c 到 main" 换行成 2 行）。white-space: nowrap
   + flex-wrap: nowrap 双保险，溢出部分 hidden（不撑爆容器）。Gitea web 实际
   "X 于 Y 合并提交 f30ece070c 到 main" 1 行渲染，我们对齐。 */
.pr-detail__event-line {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  white-space: nowrap;
  overflow: hidden;
  font-size: var(--font-sm); /* v0.7.21 根因修复：var(--font-body) 14px → var(--font-sm) 13px，对齐 Gitea web 端 timeline 文字大小。v0.7.10 我把 event-line 显式 14px 是基于 user "文字可以再增加一个字号"反馈放大，但实际对齐 Gitea web 应该回到 13px。 */
}
/* v0.7.16 根因修复：merge 事件整段（verb "合并提交" + ShortSha + 到 + branch）
   加 white-space: nowrap，强制 1 行渲染 —— 之前 v0.7.10 加的 flex-wrap: wrap
   让长内容（"X 于 Y 合并提交 f30ece070c 到 main"）在主行宽度不够时换行
   成 2 行（"X 于 Y 合并提交" 主行 + "f30ece070c 到 main" 下一行）。
   Gitea web 实际 1 行渲染。merge / push / label 等核心事件用 nowrap，
   时间 / 用户名太长可换行（v0.7.10 行为）。 */
.pr-detail__event-merge {
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pr-detail__event-author {
  font-weight: 600;
  color: var(--color-text);
}
/* v0.7.5：'于' 介词 —— 对齐 Gitea web 中文 'X 于 Y verb' 时间格式
   （之前是 'X verb' 独立在右，'Y 天前' 时间独立） */
.pr-detail__event-prep {
  color: var(--color-text-muted);
  font-size: var(--font-body);
}
.pr-detail__event-verb {
  color: var(--color-text-secondary);
}
.pr-detail__event-time {
  color: var(--color-text-muted);
  font-size: 12px; /* v0.7.10：11px → 12px（time 字号升一档）；用 inline 值不引 --font-mono（mono 字体不适合中文） */
  flex-shrink: 0;
}
.pr-detail__event-inline {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: var(--font-body);
}
.pr-detail__event-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.pr-detail__event-block > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* v0.7.20 根因修复：push 事件 commit 列表块 —— 对齐 Gitea web
   `templates/repo/commits_list_small.tmpl` 渲染（Gitea web 端 commit 列表**没有
   缩进**，是直接跟在 push event 后面渲染，每个 commit 一行简单布局）。
   v0.7.7 我加的 `padding: 6px 0 6px 22px` + `border-left: 2px` + `margin-left: 8px`
   缩进是错的对齐"假想 Gitea web 缩进"——实测 Gitea web `comments.tmpl` push event
   渲染直接 `{{template "repo/commits_list_small" dict "comment" . "root" $}}`，
   commits_list_small 模板用 `<div class="flex-text-block">` 简单布局，没有 padding-left。
   修法：删 padding-left + border-left + margin-left，commit 列表跟主行同一缩进
   渲染（连接到主时间轴上），不再单独缩进。user 反馈"分支信息也和其他事件一起
   对齐，连接到主时间轴上，而不是进行一个小的缩进，单独显示一行"。 */
.pr-detail__event-block--commits {
  margin-top: 2px;
  padding: 0;
}
/* v0.7.32：GitHub 端单 commit push 主行内 commit subject + short SHA 同行布局
   跟 Gitea web commits_list_small 模板不同，GitHub web 是单行 "subject" + "short SHA"
   （右侧），无 GitCommit icon 无 author。 */
.pr-detail__event-push-github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.pr-detail__event-push-github .pr-detail__event-commit-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-detail__event-commit-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: var(--font-xs);
  color: var(--color-text);
}
.pr-detail__event-commit-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.pr-detail__event-commit-sha {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  padding: 1px 6px;
  background: var(--color-bg-hover);
  border-radius: 3px;
  flex-shrink: 0;
  text-decoration: none;
  color: var(--color-text);
}
.pr-detail__event-commit-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-detail__event-commit-author {
  color: var(--color-text-muted);
  font-size: 11px;
  flex-shrink: 0;
}

/* ===== 评审事件（review_event，单行） ===== */
.pr-detail__timeline-item--review {
  font-size: var(--font-sm);
}
.pr-detail__event-line .pr-detail__event-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pr-detail__comment-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: var(--font-xs);
  font-weight: 600;
  color: #fff;
  background: var(--color-info);
}
/* v0.7.3：pr-detail__comment-author —— username 在 comment bubble 的 meta header 里
   不再独立成 pr-detail__comment-name（独立列在 avatar 下方） */
.pr-detail__comment-author {
  font-weight: 600;
  font-size: var(--font-sm);
  color: var(--color-text);
}
/* v0.7.4：'评论于' 动词 —— 对齐 Gitea web 评论头 'X 评论于 {时间}' 格式 */
.pr-detail__comment-verb {
  color: var(--color-text-muted);
  font-size: var(--font-sm);
}
.pr-detail__comment-time {
  /* 提升为链接样式，Gitea web 风格（'X 评论于 <a href="...">2小时前</a>'） */
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  text-decoration: none;
  cursor: default;
}
.pr-detail__comment-time:hover {
  color: var(--color-link, var(--color-primary));
  text-decoration: underline;
  cursor: pointer;
}
/* merge event 短 SHA 显示（去掉左右空白） */
.pr-detail__event-merge-sha {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* ===== v0.7.4：comment header 右侧 actions ===== */
.pr-detail__comment-meta {
  /* 改用 flex space-between，让左侧（author + time）和右侧（actions）撑满 */
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
  min-height: 24px;
}
.pr-detail__comment-meta-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.pr-detail__comment-meta-right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;                 /* 默认隐藏，hover comment 时显示（Gitea web 行为） */
  transition: opacity 0.15s ease;
}
.pr-detail__comment-bubble:hover .pr-detail__comment-meta-right,
.pr-detail__comment-meta-right:has(.pr-detail__comment-action-btn--active) {
  opacity: 1;
}
.pr-detail__comment-action-wrap {
  position: relative;
  display: inline-flex;
}
.pr-detail__comment-action-btn {
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--t-fast, 0.12s) ease, border-color var(--t-fast, 0.12s) ease, color var(--t-fast, 0.12s) ease;
}
.pr-detail__comment-action-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: var(--color-divider);
}
.pr-detail__comment-action-btn--active {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: var(--color-divider);
}
.pr-detail__comment-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  padding: 4px;
  min-width: max-content;
}
.pr-detail__comment-popover--emoji {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
  max-width: 240px;
}
.pr-detail__comment-popover--menu {
  min-width: 140px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pr-detail__comment-emoji-btn {
  width: 28px;
  height: 28px;
  font-size: 18px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast, 0.12s) ease, transform var(--t-fast, 0.12s) ease;
}
.pr-detail__comment-emoji-btn:hover {
  background: var(--color-bg-hover);
  transform: scale(1.15);
}
.pr-detail__comment-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  color: var(--color-text);
  font-size: var(--font-sm);
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background var(--t-fast, 0.12s) ease;
}
.pr-detail__comment-menu-item:hover {
  background: var(--color-bg-hover);
}
.pr-detail__comment-menu-item--danger {
  color: var(--color-danger, #cf222e);
}
.pr-detail__comment-menu-item--danger:hover {
  background: rgba(207, 34, 46, 0.1);
}
/* v0.7.4：[所有者] 角色标签 —— 对齐 Gitea web show_role.tmpl 的 Owner 标签 */
.pr-detail__comment-role-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
  background: var(--color-primary-soft, rgba(9, 105, 218, 0.15));
  color: var(--color-primary, #0969da);
  flex-shrink: 0;
}
.pr-detail__comment-bubble {
  flex: 1;
  min-width: 0;
  padding: var(--space-3);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  /* v0.7.3：左箭头 —— 对齐 Gitea web .avatar-content-left-arrow。
     三角形 ::before 指向左侧 timeline-rail 节点，模拟气泡箭头。
     event（review / system）通过 timeline-item--event 不用 bubble，没箭头。 */
  position: relative;
}
.pr-detail__comment-bubble::before {
  content: "";
  position: absolute;
  left: -6px;
  top: 12px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 6px 6px 6px 0;
  border-color: transparent var(--color-bg-elevated) transparent transparent;
}
.pr-detail__comment-bubble--editing { background: var(--color-bg-elevated); }
.pr-detail__comment-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.pr-detail__comment-self-tag {
  font-size: var(--font-xs);
  padding: 0 5px;
  border-radius: 8px;
  background: var(--color-primary-soft);
  color: var(--color-primary-bright, var(--color-primary));
  font-weight: 600;
}
.pr-detail__comment-time { color: var(--color-text-muted); font-size: var(--font-xs); }
.pr-detail__comment-body { font-size: var(--font-sm); line-height: 1.6; color: var(--color-text); }
.pr-detail__comment-event-author { font-size: var(--font-xs); color: var(--color-text-muted); margin-top: 2px; }
.pr-detail__comment-edited-mark { font-size: var(--font-xs); color: var(--color-text-muted); }
.pr-detail__comment-actions {
  display: flex;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.pr-detail__comment-quote {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
  font-family: inherit;
}
.pr-detail__comment-quote:hover { background: var(--color-bg-hover); color: var(--color-text); }
.pr-detail__comment-edit-btn,
.pr-detail__comment-delete-btn {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.pr-detail__comment:hover .pr-detail__comment-edit-btn,
.pr-detail__comment:hover .pr-detail__comment-delete-btn { opacity: 1; }
.pr-detail__comment-edit-btn:hover { background: var(--color-bg-hover); color: var(--color-text); }
.pr-detail__comment-delete-btn:hover { background: var(--color-danger-soft); color: var(--color-danger); }
.pr-detail__comment-edit-input {
  width: 100%;
  min-height: 60px;
  padding: var(--space-2);
  background: var(--color-bg);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-sm);
  font-family: inherit;
  resize: vertical;
  outline: none;
}
.pr-detail__comment-edit-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.pr-detail__comment-editing-hint { font-size: var(--font-xs); color: var(--color-text-muted); margin-right: auto; }

/* 评论输入区 */
.pr-detail__md-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.md-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 26px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.md-toolbar-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.md-toolbar-btn code {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
.md-toolbar-divider {
  width: 1px;
  height: 16px;
  background: var(--color-divider);
  margin: 0 4px;
}
.pr-detail__comment-compose {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.pr-detail__comment-input-wrap {
  position: relative;
}
.pr-detail__comment-input {
  width: 100%;
  min-height: 72px;
  padding: var(--space-3);
  padding-right: 40px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-sm);
  font-family: inherit;
  resize: vertical;
  outline: none;
  transition: border-color var(--t-base) var(--ease);
}
.pr-detail__comment-input:focus { border-color: var(--color-primary); }
.pr-detail__comment-send {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  border: none;
  cursor: pointer;
  transition: background var(--t-base) var(--ease);
}
.pr-detail__comment-send:hover:not(:disabled) { background: var(--color-primary-hover); }
.pr-detail__comment-send:disabled { opacity: 0.4; cursor: not-allowed; }
.pr-detail__comment-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.pr-detail__mention-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 10;
  max-width: 240px;
}
.pr-detail__mention-item {
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: var(--font-sm);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.pr-detail__mention-item--active { background: var(--color-primary-soft); }

/* 响应式：窄屏切换为上下布局 */
@media (max-width: 900px) {
  .pr-split {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
  .pr-list-panel {
    border-right: none;
    border-bottom: 1px solid var(--color-divider);
    max-height: 300px;
  }
}

</style>
