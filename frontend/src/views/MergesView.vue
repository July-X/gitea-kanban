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
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { GitMerge, GitPullRequestArrow, GitBranch, RefreshCw, Search, ChevronDown, ChevronUp, ExternalLink, XCircle, Pencil, MessageSquare, Send, Loader2, Quote, Timer } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { usePullStore, type PullFilter } from '@renderer/stores/pull';
import { useAuthStore } from '@renderer/stores/auth';
import { showToast } from '@renderer/lib/toast';
import { renderMarkdown } from '@renderer/lib/markdown';
// Wails 运行时：BrowserOpenURL 在系统默认浏览器打开 URL
// （v2 是 Wails WebView，<a target="_blank"> / window.open 在这里不可靠）。
import { BrowserOpenURL } from '../../wailsjs/wailsjs/runtime/runtime';
import {
  pullsCommentCreate,
  pullsCommentDelete,
  pullsCommentList,
  pullsCommentUpdate,
  labelsCreate,
  labelsList,
  membersList,
  pullsUpdateAssignee,
  pullsUpdateLabels,
  pullsReviewCreate,
  pullsReviewsList,
  pullsUpdateReviewers,
} from '@renderer/lib/ipc-client';
import EmptyState from '@renderer/components/EmptyState.vue';
import ReactionBar from '@renderer/components/ReactionBar.vue';
import PullFileComments from '@renderer/components/PullFileComments.vue';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import type { CollaboratorDto, PullDto, RepoDto, MergeMethod } from '@renderer/types/dto';
import type { CreateReviewArgs, IssueCommentDto, PullReviewDto, ReviewEvent } from '@renderer/types/dto';
import type { PullFileDto } from '@renderer/types/dto';

const repo = useRepoStore();
const pull = usePullStore();
const auth = useAuthStore();
const router = useRouter();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

// v0.6+ 滚动到底自动加载分页：哨兵 + IntersectionObserver
// - loadMoreSentinel: <div ref="loadMoreSentinel"> 在 ul 之后
// - loadMoreObserver: onMounted 时建，onUnmounted 时 disconnect 防内存泄露
const loadMoreSentinel = ref<HTMLElement | null>(null);
let loadMoreObserver: IntersectionObserver | null = null;

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/** 展开的合并请求 index Set（UI 状态，**不**持久化） */
const expanded = ref<Set<number>>(new Set());

/** tab 列表：全部 / 待合并 / 已合并 / 已关闭 */
const tabs: { id: PullFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '待合并' },
  { id: 'merged', label: '已合并' },
  { id: 'closed', label: '已关闭' },
];

// ===== 合并二次确认状态 =====

/**
 * 合并方式选项（人话映射，与 MergeMethodSchema 对齐：gitea swagger 实际支持 4 种）
 *
 * A-3 P2 · B5 修法（2026-06-14）：
 * - 普通合并保留并**默认**选中，hint 改更"人话"
 * - 高级方式（变基/变基+合并/压缩）默认折叠在"高级选项" disclosure 下
 *   PM 看不到默认不点 → 不会被技术术语吓到
 * - 4 种 hint 文案统一为"动作 + 影响"两段式（不再纯技术）
 */
const mergeMethods: { value: MergeMethod; label: string; hint: string; advanced?: boolean }[] = [
  { value: 'merge', label: '普通合并', hint: '保留所有提交历史（推荐，最安全）' },
  { value: 'rebase', label: '变基', hint: '重排历史提交（⚠️ 会改写分支历史，慎用）', advanced: true },
  { value: 'rebase-merge', label: '变基 + 合并', hint: '重排后再合并（⚠️ 会改写历史）', advanced: true },
  { value: 'squash', label: '压缩', hint: '把多个提交合成 1 个（⚠️ 会丢掉中间提交信息）', advanced: true },
];

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

const detailTab = ref<'overview' | 'files' | 'conversation'>('overview');

/** 打开删除确认弹窗 */
function confirmDeleteComment(p: PullDto, c: IssueCommentDto): void {
  deletingComment.value = { p, c };
  confirmDeleteOpen.value = true;
}

onMounted(async () => {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  // v1.4 任务 #statusbar-picker：删除"未选就默认选第一个"逻辑
  if (activeProjectId.value) {
    await loadPulls();
  }
  // v0.6+ bugfix：滚动到底自动加载下一页
  // - rootMargin: 200px 预加载（用户还没滚到底就开始拉，体验更顺）
  // - threshold: 0 不需要可见，仅进入 rootMargin 范围即触发
  loadMoreObserver = new IntersectionObserver(
    (entries) => {
      const e = entries[0];
      if (!e || !e.isIntersecting) return;
      // 不在拉中 + 还有更多 才调
      if (pull.loadingMore || !pull.hasMore) return;
      void pull.loadMore();
    },
    { rootMargin: '200px 0px', threshold: 0 },
  );
  if (loadMoreSentinel.value) {
    loadMoreObserver.observe(loadMoreSentinel.value);
  }
});

onUnmounted(() => {
  // v0.6+：避免 component 卸载后 observer 继续触发回调（内存泄露）
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
});

watch(
  () => activeProjectId.value,
  async (id) => {
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

function toggleExpand(idx: number): void {
  const next = new Set<number>();
  if (!expanded.value.has(idx)) next.add(idx);
  expanded.value = next;
}

/**
 * 行点击展开：除切 expanded 外,展开的瞬间调 loadComments 拉评论
 *
 * 收起时**不**清空 panel —— 用户再次展开能秒开（避免重复 IO）
 */
function toggleExpandWithComments(p: PullDto): void {
  const wasExpanded = expanded.value.has(p.index);
  toggleExpand(p.index);
  if (!wasExpanded) {
    void loadComments(p);
    void loadReviews(p); // v0.5.0 M3
  }
}

/**
 * 跳转到 Git Graph 视图（/timeline），查看该合并请求的 head 分支
 *
 * @click.stop 阻止冒泡到 merge-item 行（避免同时触发 toggleExpandWithComments 展开手风琴）
 */
function onJumpToTimeline(p: PullDto): void {
  if (!p.head?.ref || !p.head?.sha) {
    showToast({ type: 'error', message: '这条合并请求没有可跳转的分支信息' });
    return;
  }
  void router.push('/timeline');
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
const editingPull = ref<PullDto | null>(null);
const editingLabels = ref<string[]>([]);
const editingAssignee = ref('');
const editingReviewers = ref<string[]>([]);

/** 可用标签列表（从 store 或 IPC 获取） */
const availableLabels = ref<{ name: string; color: string }[]>([]);
/** 可用成员列表 */
const availableMembers = ref<string[]>([]);

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
  editingAssignee.value = p.assignee?.username ?? '';
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
  const errors: string[] = [];

  // 1. 更新标签（替换所有标签）
  try {
    await pullsUpdateLabels({
      projectId,
      index: p.index,
      labels: editingLabels.value,
    });
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`标签: ${err.messageText ?? err.message ?? '失败'}`);
  }

  // 2. 更新指派人（空串 = 清除指派人）
  try {
    await pullsUpdateAssignee({
      projectId,
      index: p.index,
      assignee: editingAssignee.value,
    });
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`指派人: ${err.messageText ?? err.message ?? '失败'}`);
  }

  // 3. 更新评审人（过滤掉组织账号——gitea 1.x 不允许）
  const validReviewers = editingReviewers.value.filter(r => !nonReviewableMembers.value.has(r));
  try {
    await pullsUpdateReviewers({
      projectId,
      index: p.index,
      reviewers: validReviewers,
    });
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    const msg = err.messageText ?? err.message ?? '失败';
    // 保留 messageText 完整内容（含 gitea 真实原因）
    errors.push(`评审人: ${msg}`);
  }

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

/** 关闭确认描述文案 */
const closeConfirmDescription = computed(() => {
  const p = closingPull.value;
  if (!p) return '';
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
interface CommentPanelState {
  items: IssueCommentDto[];
  loading: boolean;
  posting: boolean;
  error: string | null;
  /** 上一次成功拉取的毫秒时间戳（"刚刚刷新"提示用） */
  lastLoadedAt: number | null;
}

const commentPanels = ref<Map<number, CommentPanelState>>(new Map());

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

/** 每个合并请求的评审列表 */
const reviewPanels = ref<Map<number, PullReviewDto[]>>(new Map());

/** 每个合并请求的评审编辑器开关 + 选中的 event */
const reviewEditorOpen = ref<Set<number>>(new Set());
const reviewEditorEvent = ref<Map<number, ReviewEvent>>(new Map());
const reviewEditorBody = ref<Map<number, string>>(new Map());
const reviewSubmitting = ref(false);

function getReviewPanel(idx: number): PullReviewDto[] {
  return reviewPanels.value.get(idx) ?? [];
}

async function loadReviews(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    const list = await pullsReviewsList({
      projectId: activeProjectId.value,
      index: p.index,
    });
    const reviews = (list ?? []) as PullReviewDto[];
    reviewPanels.value.set(p.index, reviews);
    // v0.5.0 bugfix: 同步写入 store 的 reviewPanels,让 pull.timelineItems computed 能拿到数据
    // (timelineItems 把 review 事件 + 普通评论合并,按时间排序用于对话 Tab 渲染)
    pull.reviewPanels.set(p.index, reviews);
  } catch {
    // 不阻断主流程
  }
}

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
    // 刷新评审列表
    await loadReviews(p);
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

/** 评审状态标签（人话，零术语） */
function reviewStateLabel(state: string): string {
  switch (state) {
    case 'approved': return '已批准';
    case 'changes_requested': return '请求修改';
    case 'commented': return '已评论';
    default: return state;
  }
}

/** 评审事件标签（人话，零术语） */
function reviewEventLabel(event: ReviewEvent): string {
  switch (event) {
    case 'approve': return '批准此合并请求';
    case 'request_changes': return '请求修改';
    case 'comment': return '仅评论';
    default: return event;
  }
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

/** 拿某合并请求的 panel state（没有就初始化一个空的） */
function getPanel(idx: number): CommentPanelState {
  let p = commentPanels.value.get(idx);
  if (!p) {
    // v0.6.26: 用 reactive() 包装 panel,让 panel.items = items 这种直接赋值
    // 能触发模板重新渲染(否则对话 Tab 评论列表不更新)
    p = reactive({ items: [] as IssueCommentDto[], loading: false, posting: false, error: null as string | null, lastLoadedAt: null as number | null });
    commentPanels.value.set(idx, p);
  }
  return p;
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
    const ta = document.querySelector<HTMLTextAreaElement>(
      `.merge-item[data-pr-idx="${idx}"] .merge-item__comment-input`,
    );
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
    const ta = document.querySelector<HTMLTextAreaElement>(
      `.merge-item[data-pr-idx="${idx}"] .merge-item__comment-input`,
    );
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
  const panel = getPanel(p.index);
  // 已加载过且非空，跳过（用户切 tab / 列表 refresh 也不会清空，保留上下文）
  if (panel.lastLoadedAt !== null) return;
  await fetchComments(p);
}

/** 强制重拉评论（发送评论后用 —— 保证看到自己刚发的，带权威 id / 时间戳） */
async function fetchComments(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  const panel = getPanel(p.index);
  panel.loading = true;
  panel.error = null;
  // 评论加载也接 globalLoading（panel 二级加载，多 pr 并发 active 时合并）
  useGlobalLoadingStore().show('merges');
  try {
    const list = (await pullsCommentList({
      projectId: String(activeProjectId.value),
      index: p.index,
    })) as IssueCommentDto[];
    const items = Array.isArray(list) ? list : [];
    panel.items = items;
    panel.lastLoadedAt = Date.now();
    // v0.5.0 bugfix: 同步写入 store 的 commentPanels,让 pull.timelineItems computed 能拿到数据
    // (timelineItems 是 store 端的合并时间线,被对话 Tab 渲染使用)
    pull.getPanel(p.index).items = items;
  } catch (e) {
    const err = e as { messageText?: string };
    panel.error = err.messageText ?? '加载评论失败';
  } finally {
    panel.loading = false;
    useGlobalLoadingStore().hide('merges');
  }
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
  const panel = getPanel(p.index);
  panel.posting = true;
  panel.error = null;
  try {
    await pullsCommentCreate({
      projectId: String(activeProjectId.value),
      index: p.index,
      body,
    });
    setDraft(p.index, '');
    // 发送成功后重拉：拿到权威评论（带 gitea 给的 id / createdAt）
    await fetchComments(p);
    showToast({ type: 'success', message: `评论已发送到 #${p.index}` });
  } catch (e) {
    const err = e as { messageText?: string; hint?: string };
    panel.error = err.messageText ?? '发送失败';
    showToast({
      type: 'error',
      message: err.messageText ?? '发送失败',
      persistent: true,
    });
  } finally {
    panel.posting = false;
  }
}

// ===== 评论编辑 / 删除（v0.5.0 M1） =====

/** 正在编辑的评论 id（仅一个，确保 UI 单一编辑态） */
const editingCommentId = ref<number | null>(null);
/** 编辑中的评论草稿（与新增评论的草稿分开，互不干扰） */
const editDrafts = ref<Map<number, string>>(new Map());

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
  if (draft === c.body.trim()) {
    editingCommentId.value = null;
    return;
  }
  const panel = getPanel(p.index);
  panel.error = null;
  try {
    const updated = (await pullsCommentUpdate({
      projectId: String(activeProjectId.value),
      commentId: c.id,
      body: draft,
    })) as IssueCommentDto;
    // 本地更新对应评论（避免全量刷新）
    const idx = panel.items.findIndex((x) => x.id === c.id);
    if (idx >= 0) {
      panel.items[idx] = updated;
      // v0.5.0 bugfix: 同步 store 的 commentPanels,让 timelineItems 实时反映编辑结果
      pull.getPanel(p.index).items = [...panel.items];
    }
    editingCommentId.value = null;
    editDrafts.value.delete(c.id);
    showToast({ type: 'success', message: '评论已更新' });
  } catch (e) {
    const err = e as { messageText?: string };
    panel.error = err.messageText ?? '编辑失败';
    showToast({ type: 'error', message: err.messageText ?? '编辑失败', persistent: true });
  }
}

/**
 * 删除评论（**危险操作**，调用前 UI 必须弹二次确认）
 */
async function deleteComment(p: PullDto, c: IssueCommentDto): Promise<void> {
  if (!activeProjectId.value) return;
  const panel = getPanel(p.index);
  panel.error = null;
  try {
    await pullsCommentDelete({
      projectId: String(activeProjectId.value),
      commentId: c.id,
    });
    // 本地过滤掉被删除的评论
    const nextItems = panel.items.filter((x) => x.id !== c.id);
    panel.items = nextItems;
    // v0.5.0 bugfix: 同步 store 的 commentPanels,让 timelineItems 实时反映删除结果
    pull.getPanel(p.index).items = nextItems;
    showToast({ type: 'success', message: '评论已删除' });
  } catch (e) {
    const err = e as { messageText?: string };
    panel.error = err.messageText ?? '删除失败';
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

/** 生成二次确认描述文案 */
const confirmDescription = computed(() => {
  const p = mergingPull.value;
  if (!p) return '';
  const methodInfo = mergeMethods.find((m) => m.value === selectedMethod.value);
  const methodLabel = methodInfo?.label ?? selectedMethod.value;
  const methodHint = methodInfo?.hint ?? '';
  let desc = `将把 #${p.index}「${p.title}」以「${methodLabel}」方式合并到 ${p.base.ref}。`;
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

function badgeText(p: PullDto): string {
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
          <h1 class="merges__title-h1">合并请求</h1>
          <p class="merges__repo">{{ activeRepo?.fullName ?? '请选择仓库' }}</p>
        </div>
      </div>
      <div class="merges__topbar-right">
        <span class="merges__counter">共 {{ pull.total }} 个</span>
        <span class="merges__merge-method-hint muted" title="每次合并的默认方式，可在确认时改">
          默认：{{ mergeMethods.find((m) => m.value === selectedMethod)?.label }}
        </span>
        <button
          type="button"
          class="merges__refresh"
          :disabled="pull.loading"
          :title="'刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" />
          <span>刷新</span>
        </button>
      </div>
    </header>

    <!-- ============== Tabs + 搜索 ============== -->
    <div v-if="activeProjectId" class="merges__controls">
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
          placeholder="按标题 / 来源 / 目标搜索"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </div>

    <!-- ============== 错误条 ============== -->
    <div v-if="pull.error" class="merges__error" role="alert">
      <p class="merges__error-msg">{{ pull.error.messageText }}</p>
      <p class="merges__error-hint">{{ pull.error.hint }}</p>
    </div>

    <!--
      主体：5 个独立 v-if 分支。
      注意：v-if/v-else-if/v-else 链要求所有 element 同 tag，且 AST 会"折叠"到第一个 v-if 节点的 children 里——
      也就是说链里最后一个元素如果是 <ul>，那么 <li> 实际成了 <div v-if> 的 child 而不是 <ul> 的 child，
      </li></ul> 闭合会错位（这就是之前"Element is missing end tag" bug 的根因）。
      所以这里直接用独立 v-if，每个分支自己决定渲染什么。
    -->
    <div v-if="!activeRepo" class="merges__placeholder">
      <EmptyState title="还没有选中仓库" description='去"看板"页选一个仓库，再回来这里看合并请求' />
    </div>
    <!--
      v0.6.1+ 拍板"替换模式"：删 v-else-if="pull.loading && ..." 的"加载中…"占位
      全局 StatusBarPulse 接管请求级 loading
    -->
    <div v-else-if="!pull.items.length" class="merges__placeholder">
      <EmptyState
        title="这个仓库还没有合并请求"
        description="去 gitea 创建第一个合并请求，或去时间轴页看分支进度"
      />
    </div>
    <div v-else-if="!pull.filteredItems.length" class="merges__placeholder">
      <EmptyState
        :title="`没有匹配「${tabs.find((t) => t.id === pull.filter)?.label}」的合并请求`"
        description="试试切换其他 tab，或调整搜索词"
      />
    </div>
    <!-- 列表分支：直接用 template v-if（独立判断，避免污染 v-else 链） -->
    <ul v-if="activeRepo && pull.filteredItems.length" class="merges__list">
      <li
        v-for="p in pull.filteredItems"
        :key="p.index"
        class="merge-item"
        :class="{
          'merge-item--open': p.state === 'open',
          'merge-item--merged': p.merged,
          'merge-item--closed': p.state === 'closed' && !p.merged,
        }"
        role="button"
        tabindex="0"
        :aria-expanded="expanded.has(p.index)"
        @click="toggleExpandWithComments(p)"
        @keydown.enter="toggleExpandWithComments(p)"
        @keydown.space.prevent="toggleExpandWithComments(p)"
      >
        <!-- 模仿 gitea /pulls 列表布局：
             [leading: 状态图标] [main: 标题 + #index + 时间/作者 + 分支流向] [trailing: 操作按钮] -->
        <div class="merge-item__leading" aria-hidden="true">
          <GitPullRequestArrow
            v-if="!p.merged && !p.draft && p.state === 'open'"
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--open"
          />
          <GitPullRequestArrow
            v-else-if="p.merged"
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--merged"
          />
          <GitPullRequestArrow
            v-else-if="p.draft"
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--draft"
          />
          <GitPullRequestArrow
            v-else
            :size="16"
            :stroke-width="2"
            class="merge-item__icon merge-item__icon--closed"
          />
        </div>
        <div class="merge-item__main">
          <div class="merge-item__header">
            <span class="merge-item__title" :title="p.title">{{ p.title }}</span>
            <span :class="badgeClass(p)" class="merge-item__badge">{{ badgeText(p) }}</span>
            <!-- v1.4 · 任务 #merge-timeline-jump:
                 跳时间轴定位到本合并请求的 head 提交。
                 默认态用主色软底 + 主色文字 + 主色描边(跟 TimelineView .is-pr-focus
                 同一强调色系,让用户一眼识别"点这个就能跳过去看")。
                 @click.stop 避免同时触发行的 toggleExpandWithComments 展开手风琴 -->
            <button
              type="button"
              class="merge-item__timeline-btn"
              :title="`跳到时间轴，定位到 ${p.head.ref} 上的提交 ${p.head.sha.slice(0, 7)}`"
              :aria-label="`跳到时间轴，定位到 ${p.head.ref} 上的提交 ${p.head.sha.slice(0, 7)}`"
              @click.stop="onJumpToTimeline(p)"
            >
              <Timer :size="13" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <div class="merge-item__body">
            <a
              :href="giteaPullUrl(p)"
              class="merge-item__index mono"
              :title="'在 gitea 中打开 #' + p.index"
              @click.stop.prevent="openPullExternal(p)"
            >#{{ p.index }}</a>
            <span class="merge-item__meta-line">
              <span class="merge-item__meta-text">打开于 {{ formatRelative(p.createdAt) }}</span>
              <span class="merge-item__meta-text">由</span>
              <span class="merge-item__author">{{ p.author.username }}</span>
            </span>
            <!-- 分支流向（base ← head），照搬 gitea /pulls 列表 -->
            <div class="merge-item__branches">
              <span
                class="merge-item__branch"
                :title="p.base.ref"
              ><GitBranch :size="12" :stroke-width="2" aria-hidden="true" />{{ p.base.ref }}</span>
              <span class="merge-item__branch-arrow" aria-hidden="true">←</span>
              <span
                class="merge-item__branch"
                :title="p.head.ref"
              ><GitBranch :size="12" :stroke-width="2" aria-hidden="true" />{{ p.head.ref }}</span>
            </div>
            <!-- 标签 + 里程碑 + 指派人 + 评审人（gitea 合并请求属性块） -->
            <!-- v2.62：attrs 用 v-if 包裹，空 MR 时不渲染空 div -->
            <div v-if="(p.labels ?? []).length > 0 || p.milestone || p.assignee || (p.reviewers ?? []).length > 0 || (p.commentsCount ?? 0) > 0" class="merge-item__attrs">
              <span
                v-for="label in (p.labels ?? [])"
                :key="label.id"
                class="merge-item__label"
                :style="{ '--label-color': '#' + label.color, '--label-bg': '#' + label.color + '22' }"
              >{{ label.name }}</span>
              <span
                v-if="p.milestone"
                class="merge-item__milestone"
                :title="p.milestone.title"
              >🎯 {{ p.milestone.title }}</span>
              <span
                v-if="p.assignee"
                class="merge-item__assignee"
              >👤 {{ p.assignee.username }}</span>
              <span
                v-for="reviewer in (p.reviewers ?? [])"
                :key="reviewer.username"
                class="merge-item__reviewer"
              >👁 {{ reviewer.username }}</span>
              <span
                v-if="(p.commentsCount ?? 0) > 0"
                class="merge-item__comments"
              >💬 {{ p.commentsCount }}</span>
            </div>
          </div>
        </div>
        <!-- trailing: 操作按钮（不展开就能直接看到，符合 gitea 把操作放到行内） -->
        <div class="merge-item__trailing">
          <button
            v-if="p.state === 'open' && !p.draft"
            type="button"
            class="merge-item__btn merge-item__btn--merge"
            :disabled="p.hasConflicts || !p.mergeable || merging"
            :title="p.hasConflicts ? '有冲突，请先在 gitea 页面解决冲突' : !p.mergeable ? '当前不可合并' : '合并此请求'"
            @click.stop="requestMerge(p)"
          >
            <GitMerge :size="14" :stroke-width="2" aria-hidden="true" />
            <span>{{ merging && mergingPull?.index === p.index ? '合并中…' : '合并' }}</span>
          </button>
          <!-- 关闭合并请求（不合并，直接关闭）—— 对应 gitea 关闭操作 -->
          <button
            v-if="p.state === 'open'"
            type="button"
            class="merge-item__btn merge-item__btn--close"
            :disabled="closing"
            :title="'关闭此合并请求（不合并）'"
            @click.stop="requestClose(p)"
          >
            <XCircle :size="14" :stroke-width="2" aria-hidden="true" />
            <span>{{ closing && closingPull?.index === p.index ? '关闭中…' : '关闭' }}</span>
          </button>
          <!-- v0.5.0 M3：评审按钮（仅 open 状态可见） -->
          <template v-if="p.state === 'open'">
            <button
              type="button"
              class="merge-item__btn merge-item__btn--approve"
              :disabled="reviewSubmitting"
              :title="'批准此合并请求'"
              @click.stop="toggleReviewEditor(p, 'approve')"
            >
              <span>批准</span>
            </button>
            <button
              type="button"
              class="merge-item__btn merge-item__btn--request-changes"
              :disabled="reviewSubmitting"
              :title="'请求修改'"
              @click.stop="toggleReviewEditor(p, 'request_changes')"
            >
              <span>请求修改</span>
            </button>
            <button
              type="button"
              class="merge-item__btn merge-item__btn--review-comment"
              :disabled="reviewSubmitting"
              :title="'仅评论（不批准也不请求修改）'"
              @click.stop="toggleReviewEditor(p, 'comment')"
            >
              <span>评论</span>
            </button>
          </template>
          <span
            v-if="p.hasConflicts && p.state === 'open'"
            class="merge-item__conflict-hint"
            :title="'此合并请求存在冲突，请先在 gitea 页面解决'"
          >有冲突</span>
          <a
            :href="giteaPullUrl(p)"
            class="merge-item__ext-link"
            :title="'在 gitea 中打开 #' + p.index"
            @click.stop.prevent="openPullExternal(p)"
          >
            <ExternalLink :size="14" :stroke-width="2" aria-hidden="true" />
          </a>
        </div>
        <!-- 展开区：左 meta + 右 comments 两栏 grid（左 1 / 右 2）
             关键：detail 内部所有 click / keydown 必须 stop 冒泡,
             否则点击 textarea / 输入框 / 滚动评论列表会冒泡到 li 的 click,
             触发 toggleExpand 收起整张卡片（v1.3.1 bugfix）。 -->
        <div
          v-if="expanded.has(p.index)"
          class="merge-item__detail"
          @click.stop
          @keydown.stop
        >
          <!-- ===== 详情头部：meta 一行 + 编辑属性按钮（右对齐）=====
               v1.4 简化：meta 折行紧凑展示 + 编辑按钮同行；评论区独占下面整行 -->
          <div class="merge-item__detail-meta-row">
            <dl class="merge-item__meta-inline">
              <div class="merge-item__meta-chip">
                <dt>作者</dt>
                <dd>{{ p.author.username }}</dd>
              </div>
              <div class="merge-item__meta-chip">
                <dt>创建</dt>
                <dd>{{ formatDate(p.createdAt) }}</dd>
              </div>
              <div class="merge-item__meta-chip">
                <dt>更新</dt>
                <dd>{{ formatDate(p.updatedAt) }}</dd>
              </div>
              <div class="merge-item__meta-chip">
                <dt>冲突</dt>
                <dd>{{ p.hasConflicts ? '有冲突' : '无冲突' }}</dd>
              </div>
              <div class="merge-item__meta-chip">
                <dt>可合并</dt>
                <dd>{{ p.mergeable ? '是' : '否' }}</dd>
              </div>
            </dl>
            <button
              type="button"
              class="merge-item__edit-attrs"
              @click.stop="openAttrEditor(p)"
            >
              <Pencil :size="12" :stroke-width="2" aria-hidden="true" />
              <span>编辑属性</span>
            </button>
          </div>
          <!-- ===== v0.5.0 M4: 三 Tab 切换 ===== -->
          <div class="merge-item__detail-tabs">
            <button
              type="button"
              class="merge-item__detail-tab"
              :class="{ 'merge-item__detail-tab--active': detailTab === 'overview' }"
              @click.stop="detailTab = 'overview'"
            >
              概览
            </button>
            <button
              type="button"
              class="merge-item__detail-tab"
              :class="{ 'merge-item__detail-tab--active': detailTab === 'files' }"
              @click.stop="detailTab = 'files'"
            >
              文件评论
              <span v-if="pull.filesByPR.get(p.index)?.length > 0" class="merge-item__detail-tab-count">
                {{ pull.filesByPR.get(p.index)!.length }}
              </span>
            </button>
            <button
              type="button"
              class="merge-item__detail-tab"
              :class="{ 'merge-item__detail-tab--active': detailTab === 'conversation' }"
              @click.stop="detailTab = 'conversation'"
            >
              对话
              <span v-if="getPanel(p.index).items.length > 0" class="merge-item__detail-tab-count">
                {{ getPanel(p.index).items.length }}
              </span>
            </button>
          </div>

          <!-- ===== Tab 内容 ===== -->

          <!-- 概览 Tab: meta + 审查 -->
          <div v-if="detailTab === 'overview'" class="merge-item__detail-overview">
            <!-- ===== v0.6.26: PR 描述/正文 ===== -->
            <div v-if="p.body" class="merge-item__detail-body">
              <div class="merge-item__detail-body-label">描述</div>
              <div class="merge-item__detail-body-content md-body" v-html="renderMarkdown(p.body)"></div>
            </div>
            <!-- ===== v0.5.0 M3: 评审区 ===== -->
            <div v-if="p.state === 'open'" class="merge-item__reviews">
              <!-- 评审列表 -->
              <div v-if="getReviewPanel(p.index).length > 0" class="merge-item__reviews-list">
                <div
                  v-for="r in getReviewPanel(p.index)"
                  :key="r.id"
                  class="merge-item__review-item"
                  :class="`merge-item__review-item--${r.state}`"
                >
                  <span class="merge-item__review-state-badge">{{ reviewStateLabel(r.state) }}</span>
                  <span class="merge-item__review-author">{{ r.author.username }}</span>
                  <span class="merge-item__review-body">{{ r.body }}</span>
                  <span class="merge-item__review-time">{{ formatRelative(r.submittedAt) }}</span>
                </div>
              </div>
              <!-- 评审编辑器 -->
              <div v-if="reviewEditorOpen.has(p.index)" class="merge-item__review-editor">
                <div class="merge-item__review-editor-header">
                  <span class="merge-item__review-editor-label">{{ reviewEventLabel(reviewEditorEvent.get(p.index) ?? 'comment') }}</span>
                </div>
                <textarea
                  class="merge-item__review-editor-input"
                  rows="3"
                  :value="reviewEditorBody.get(p.index) ?? ''"
                  @input="reviewEditorBody.set(p.index, ($event.target as HTMLTextAreaElement).value)"
                  placeholder="评审总结（可选）"
                  spellcheck="false"
                ></textarea>
                <div class="merge-item__review-editor-actions">
                  <button
                    type="button"
                    class="merge-item__review-submit"
                    :disabled="reviewSubmitting"
                    @click.stop="submitReview(p)"
                  >{{ reviewSubmitting ? '提交中…' : '提交评审' }}</button>
                  <button
                    type="button"
                    class="merge-item__review-cancel"
                    @click.stop="reviewEditorOpen.delete(p.index); reviewEditorBody.delete(p.index)"
                  >取消</button>
                </div>
              </div>
            </div>
            <!-- v0.6.26: 概览空态（无描述 + 无评审） -->
            <div v-if="!p.body && getReviewPanel(p.index).length === 0" class="merge-item__detail-overview-empty">
              暂无描述和评审信息
            </div>
          </div>

          <!-- 文件评论 Tab: PullFileComments 组件 -->
          <div v-if="detailTab === 'files'" class="merge-item__detail-files">
            <PullFileComments
              :pr="p"
              :project-id="activeProjectId ?? ''"
            />
          </div>

          <!-- ===== 评论区：v1.5 header 整行 + 左历史/右输入各 50% ===== -->
            <div v-if="detailTab === 'conversation'" class="merge-item__comments">
              <!-- 顶部：对话标题 + 刷新按钮（整行铺满） -->
              <div class="merge-item__comments-header">
                <div class="merge-item__comments-header-left">
                  <MessageSquare :size="14" :stroke-width="2" aria-hidden="true" />
                  <span class="merge-item__comments-title">对话</span>
                  <span v-if="getPanel(p.index).items.length > 0" class="merge-item__comments-count">
                    {{ getPanel(p.index).items.length }}
                  </span>
                </div>
                <button
                  type="button"
                  class="merge-item__comments-refresh"
                  :disabled="getPanel(p.index).loading"
                  :title="'刷新对话'"
                  @click.stop="fetchComments(p)"
                >
                  <RefreshCw :size="12" :stroke-width="2" aria-hidden="true" />
                  <span>刷新</span>
                </button>
              </div>

              <!-- 主体：历史对话 + 发送评论（上下布局，发送区固定 100px） -->
              <div class="merge-item__comments-body">
                <!-- 上：加载态 / 错误态 / 空态 / 评论列表 -->
                <div class="merge-item__comments-history">
                  <!-- 加载态 -->
                  <div v-if="getPanel(p.index).loading && getPanel(p.index).items.length === 0" class="merge-item__comments-loading">
                    <Loader2 :size="14" :stroke-width="2" class="spin" aria-hidden="true" />
                    <span>正在加载对话…</span>
                  </div>
                  <!-- 错误态 -->
                  <div v-else-if="getPanel(p.index).error && getPanel(p.index).items.length === 0" class="merge-item__comments-error" role="alert">
                    <span>{{ getPanel(p.index).error }}</span>
                    <button type="button" class="merge-item__comments-retry" @click.stop="fetchComments(p)">重试</button>
                  </div>
                  <!-- 空态：暂无评论 + 提示用户第一条由谁起 -->
                  <div v-else-if="getPanel(p.index).items.length === 0" class="merge-item__comments-empty">
                    暂无对话，发起第一条评论开始讨论吧
                  </div>
                  <!-- 评论列表：时间线渲染（评审事件系统消息 + 普通评论混合，按时间排序） -->
                  <ul v-else class="merge-item__comment-list">
                    <template v-for="(item, ti) in pull.timelineItems.get(p.index) ?? []" :key="`${item.source}-${item.id}`">
                      <!-- ===== 评审事件系统卡片 ===== -->
                      <li
                        v-if="item.isReviewEvent"
                        class="merge-item__comment merge-item__comment--review-event"
                        :class="`merge-item__comment--review-${item.state}`"
                      >
                        <div class="merge-item__comment-side">
                          <div class="merge-item__comment-avatar" :class="`merge-item__comment-avatar--${item.state}`">
                            {{ item.state === 'approved' ? '✓' : item.state === 'changes_requested' ? '✗' : '💬' }}
                          </div>
                          <div class="merge-item__comment-name merge-item__comment-name--muted">系统</div>
                        </div>
                        <div class="merge-item__comment-bubble merge-item__comment-bubble--event">
                          <div class="merge-item__comment-meta">
                            <span class="merge-item__review-state-badge" :class="`merge-item__review-state-badge--${item.state}`">{{ reviewStateLabel(item.state) }}</span>
                            <span class="merge-item__comment-time" :title="formatDate(item.submittedAt)">{{ formatRelative(item.submittedAt) }}</span>
                          </div>
                          <div v-if="item.body" class="merge-item__comment-body md-body" v-html="renderMarkdown(item.body)"></div>
                          <div v-if="item.author?.username" class="merge-item__comment-event-author">
                            — {{ item.author.username }}
                          </div>
                        </div>
                      </li>

                      <!-- ===== 普通评论卡片 ===== -->
                      <li
                        v-else
                        class="merge-item__comment"
                        :class="{ 'merge-item__comment--self': currentUsername && item.author.username === currentUsername }"
                      >
                        <div class="merge-item__comment-side">
                          <div
                            class="merge-item__comment-avatar"
                            :title="item.author.username"
                            aria-hidden="true"
                          >{{ (item.author.username || '?').charAt(0).toUpperCase() }}</div>
                          <div class="merge-item__comment-name">{{ item.author.username }}</div>
                        </div>
                        <div
                          class="merge-item__comment-bubble"
                          :class="{ 'merge-item__comment-bubble--editing': editingCommentId === item.id }"
                        >
                          <div class="merge-item__comment-meta">
                            <span v-if="currentUsername && item.author.username === currentUsername" class="merge-item__comment-self-tag">我</span>
                            <span class="merge-item__comment-time" :title="formatDate(item.createdAt)">{{ formatRelative(item.createdAt) }}</span>
                          </div>
                          <!-- 编辑态：textarea 替代渲染后的 markdown (v0.6.26 优化) -->
                          <template v-if="editingCommentId === item.id">
                            <textarea
                              :ref="el => { if (el) editTextareaRef = el as HTMLTextAreaElement }"
                              class="merge-item__comment-edit-input"
                              rows="3"
                              :value="editDrafts.get(item.id) ?? ''"
                              @input="editDrafts.set(item.id, ($event.target as HTMLTextAreaElement).value)"
                              @keydown.escape.stop="cancelEditComment()"
                              @keydown.enter.stop.prevent="submitEditComment(p, item as any)"
                              spellcheck="false"
                            ></textarea>
                            <div class="merge-item__comment-edit-actions">
                              <span class="merge-item__comment-editing-hint">ESC 取消 · Enter 保存</span>
                              <button
                                type="button"
                                class="merge-item__comment-edit-cancel"
                                @click.stop="cancelEditComment()"
                              >取消</button>
                              <button
                                type="button"
                                class="merge-item__comment-edit-save"
                                :disabled="(editDrafts.get(item.id) ?? '').trim().length === 0"
                                @click.stop="submitEditComment(p, item as any)"
                              >保存</button>
                            </div>
                          </template>
                          <!-- 展示态 -->
                          <template v-else>
                            <div class="merge-item__comment-body md-body" v-html="renderMarkdown(item.body)"></div>
                            <!-- v0.5.0 M1：已编辑标记 -->
                            <span
                              v-if="item.updatedAt && item.updatedAt !== item.createdAt"
                              class="merge-item__comment-edited-mark"
                              :title="'编辑于 ' + formatDate(item.updatedAt)"
                            >（已编辑）</span>
                            <!-- v1.5.11：复刻 Gitea 引用评论 -->
                            <div class="merge-item__comment-actions">
                              <button
                                v-if="currentUsername && item.author.username !== currentUsername"
                                type="button"
                                class="merge-item__comment-quote"
                                :title="'引用这条评论'"
                                @click.stop="quoteComment(p.index, item as any)"
                              >
                                <Quote :size="11" :stroke-width="2" aria-hidden="true" />
                                <span>引用</span>
                              </button>
                              <!-- v0.5.0 M1：编辑 / 删除仅作者本人可见 -->
                              <template v-if="currentUsername && item.author.username === currentUsername">
                                <button
                                  type="button"
                                  class="merge-item__comment-edit-btn"
                                  :title="'编辑'"
                                  @click.stop="startEditComment(item as any)"
                                >
                                  <Pencil :size="11" :stroke-width="2" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  class="merge-item__comment-delete-btn"
                                  :title="'删除'"
                                  @click.stop="confirmDeleteComment(p, item as any)"
                                >
                                  <XCircle :size="11" :stroke-width="2" aria-hidden="true" />
                                </button>
                              </template>
                            </div>
                            <!-- v0.5.0 M2：表情反应条 -->
                            <ReactionBar
                              :project-id="activeProjectId"
                              :comment-id="item.id"
                              :editable="p.state === 'open'"
                            />
                          </template>
                        </div>
                      </li>
                    </template>
                  </ul>
                </div>

                <!-- 下：发评论输入区（v2.62 · 改为布局在历史对话下方，固定 120px，发送按钮在输入框内右上角） -->
                <div class="merge-item__comment-compose">
                  <div class="merge-item__comment-input-wrap">
                    <textarea
                      ref="commentInputRef"
                      class="merge-item__comment-input"
                      :value="getDraft(p.index)"
                      @input="onCommentInput(p, $event)"
                      @keydown="onCommentKeydown(p, $event)"
                      :placeholder="'发条评论给 #' + p.index + '\n@ 提及成员，Enter 发送，⌘/Ctrl+Enter 也行'"
                      :disabled="getPanel(p.index).posting"
                      rows="3"
                      maxlength="65535"
                      spellcheck="false"
                    ></textarea>
                    <!-- 发送按钮：绝对定位到输入框右上角 -->
                    <button
                      type="button"
                      class="merge-item__comment-send-absolute"
                      :disabled="getPanel(p.index).posting || getDraft(p.index).trim().length === 0"
                      :title="'发送评论（Enter 也可发送）'"
                      @click.stop="postComment(p)"
                    >
                      <Send :size="14" :stroke-width="2" aria-hidden="true" />
                    </button>
                    <div
                      v-if="isMentionOpen(p.index) && mentionCandidates(p.index).length > 0"
                      class="merge-item__mention-dropdown"
                    >
                      <button
                        v-for="(m, i) in mentionCandidates(p.index)"
                        :key="m"
                        type="button"
                        class="merge-item__mention-item"
                        :class="{ 'merge-item__mention-item--active': i === mentionActiveIdx(p.index) }"
                        @click.stop.prevent="insertMention(p.index, m)"
                      >{{ '@' + m }}</button>
                    </div>
                  </div>
                  <div class="merge-item__comment-actions">
                    <span v-if="getDraft(p.index).length > 0" class="merge-item__comment-counter muted">
                      {{ getDraft(p.index).length }} / 65535
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        <!-- 属性编辑弹窗 -->
        <ConfirmDialog
          :open="attrEditorOpen && editingPull?.index === p.index"
          title="编辑属性"
          :description="`编辑 #${p.index} 的标签、指派人、评审人`"
          confirm-label="保存"
          @update:open="attrEditorOpen = $event"
          @confirm="saveAttrs(p)"
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
                  :title="'新建标签'"
                >+ 新建</button>
              </div>
              <!-- 新建标签输入框（默认隐藏） -->
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
                v-model="editingAssignee"
                class="attr-editor__select"
              >
                <option value="">未指派</option>
                <option
                  v-for="member in availableMembers"
                  :key="member"
                  :value="member"
                >{{ member }}</option>
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
      </li>

      <!-- v2.62 滚动到底自动加载哨兵（在 ul 内部，ul 滚动时随之一超超一上滑，能重复触发 observer） -->
      <!-- v0.6.1+：加载中动画已统一到 StatusBarPulse（底部状态栏心跳脉冲），这里只展示末尾状态 -->
      <li
        ref="loadMoreSentinel"
        class="merges__load-more"
        :data-state="(!pull.hasMore && pull.currentPage >= 1) ? 'end' : 'idle'"
        aria-live="polite"
      >
        <!-- 末尾：已加载全部 -->
        <div v-if="!pull.hasMore && pull.currentPage >= 1" class="merges__load-more-end">
          <span class="merges__load-more-divider" aria-hidden="true"></span>
          <span>已到全部合并请求的末尾</span>
          <span class="merges__load-more-divider" aria-hidden="true"></span>
        </div>
        <!-- idle：占位保持哨兵高度，IntersectionObserver 可检测 -->
        <div v-else class="merges__load-more-idle">
          <span class="merges__load-more-arrow" aria-hidden="true">↓</span>
          <span>继续滚动加载更多…</span>
        </div>
      </li>
    </ul>

    <!-- ============== 合并二次确认弹窗 ============== -->
    <ConfirmDialog
      :open="confirmMergeOpen"
      title="确认合并"
      :description="confirmDescription"
      confirm-label="我了解风险，仍要合并"
      :danger="isMainBranch(mergingPull?.base.ref ?? '')"
      @update:open="confirmMergeOpen = $event"
      @confirm="performMerge"
      @cancel="cancelMerge"
    >
      <!-- 合并方式选择 slot：放在 description 后面、确认按钮前面 -->
      <div class="merge-confirm__methods">
        <p class="merge-confirm__methods-title">选择合并方式：</p>
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
        <!-- A-3 P2：高级方式 disclosure 开关 -->
        <button
          v-if="!showAdvancedMethods"
          type="button"
          class="merge-confirm__advanced-toggle"
          @click="showAdvancedMethods = true"
        >
          <ChevronDown :size="12" :stroke-width="2" aria-hidden="true" />
          <span>高级选项（变基 / 压缩）</span>
        </button>
        <button
          v-else
          type="button"
          class="merge-confirm__advanced-toggle"
          @click="showAdvancedMethods = false"
        >
          <ChevronUp :size="12" :stroke-width="2" aria-hidden="true" />
          <span>收起高级选项</span>
        </button>
        <!-- squash 需要输入 commitMessage -->
        <div v-if="needsCommitMessage(selectedMethod)" class="merge-confirm__message">
          <label class="merge-confirm__message-label" for="squash-msg">合并提交信息（必填）：</label>
          <input
            id="squash-msg"
            v-model="squashMessage"
            type="text"
            class="merge-confirm__message-input"
            placeholder="请输入合并提交信息"
            autocomplete="off"
          />
        </div>
        <!-- v0.6+：合并后顺手删除源分支（PM 选 merge 时最容易忘的清理） -->
        <div v-if="mergingPull" class="merge-confirm__delete-branch">
          <label class="merge-confirm__delete-branch-label">
            <input
              v-model="deleteBranchAfter"
              type="checkbox"
              class="merge-confirm__delete-branch-checkbox"
            />
            <span>合并后删除源分支 <code>{{ mergingPull.head.ref }}</code></span>
          </label>
          <p class="merge-confirm__delete-branch-hint">
            勾选后：合并成功时删除 <code>{{ mergingPull.head.ref }}</code>。
            GitHub 合并成功后会调 DELETE /git/refs/heads/&lt;ref&gt;；Gitea 直接走 /pulls/{index}/merge 内置参数。
          </p>
        </div>
      </div>
    </ConfirmDialog>

    <!-- ============== 删除评论二次确认弹窗（v0.5.0 M1） ============== -->
    <ConfirmDialog
      :open="confirmDeleteOpen"
      title="删除评论"
      description="确定要删除这条评论吗？删除后无法恢复。"
      confirm-label="删除"
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
  border: 1px solid var(--label-color, var(--color-divider));
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
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
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

/* 单条评论 li：横向 flex，avatar + bubble
 * 默认 = 他人：左对齐
 * --self = 我：右对齐（reverse + 行内交换顺序） */
.merge-item__comment {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
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

/* 气泡容器（v1.5.9 撑满剩余空间 + v1.5.11 引用按钮绝对定位在右上角） */
.merge-item__comment-bubble {
  flex: 1 1 0;
  min-width: 0;
  max-width: 100%;
  padding: 6px 10px;
  /* v0.6.26：淡色底纹提升可读性 */
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  position: relative;
  overflow-wrap: break-word;
  word-wrap: break-word;
  word-break: break-word;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
/* v0.6.26：评论区宽度撑满，减少左右留白 */
.merge-item__comment-list {
  padding: 8px 16px;
  display: flex;
  flex-direction: column;
}
/* v1.5.11：只有他人消息才给右侧预留位置（避免引用按钮遮挡 meta），
 * 自己的消息没有引用按钮（不能引用自己），保持默认 padding */
.merge-item__comment:not(.merge-item__comment--self) .merge-item__comment-bubble {
  padding-right: 50px;
}
/* v0.6.26：评论使用全宽，他人靠左，"我"靠右 */
.merge-item__comment {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  margin: 0 0 8px;
  width: 100%;
  transition: opacity var(--t-fast) var(--ease);
}
/* v0.6.26："我"的评论靠右 */
.merge-item__comment--self {
  margin-left: auto;
  flex-direction: row-reverse;
  justify-content: flex-end;
}
/* 气泡小箭头（指向头像）—— 用 CSS border 画三角形 */
.merge-item__comment-bubble::before {
  content: '';
  position: absolute;
  top: 10px;
  width: 8px;
  height: 8px;
  background: inherit;
  border: 1px solid var(--color-divider);
  /* 默认（他人，左侧）：箭头指向左 */
  left: -5px;
  border-right: 1px solid var(--color-divider);
  border-top: none;
  border-bottom: none;
  transform: rotate(45deg);
}
.merge-item__comment-bubble {
  /* 让他人箭头也跟随气泡背景色 */
  background-clip: padding-box;
}
/* v0.6.26："我"的气泡用主色软底 + 主色边框 */
.merge-item__comment--self .merge-item__comment-bubble {
  background: var(--color-primary-soft);
  border-color: var(--color-primary-alpha-45);
  border-width: 1px;
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
  /* v0.6.20：背景透明，箭头跟随边框颜色 */
  background: transparent;
  border-left: none;
  border-bottom: none;
  border-right: 1.5px solid var(--color-primary);
  border-top: 1.5px solid var(--color-primary);
  /* 旋转 45° 让两个边形成指向右的三角箭头 */
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
/* 强制 .merge-item__comment-body 内的所有 markdown 节点都限制在气泡里 */
.merge-item__comment-body > *,
.merge-item__comment-body p,
.merge-item__comment-body pre,
.merge-item__comment-body code,
.merge-item__comment-body ul,
.merge-item__comment-body ol,
.merge-item__comment-body li,
.merge-item__comment-body blockquote,
.merge-item__comment-body h1,
.merge-item__comment-body h2,
.merge-item__comment-body h3,
.merge-item__comment-body h4,
.merge-item__comment-body h5,
.merge-item__comment-body h6,
.merge-item__comment-body table {
  max-width: 100%;
  min-width: 0;
  word-break: break-all;
  overflow-wrap: break-word;
}
.merge-item__comment-body pre,
.merge-item__comment-body pre code {
  white-space: pre-wrap;
}
.merge-item__comment-body code {
  white-space: pre-wrap;
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
 * 颜色用项目主题变量，不写死。 */
.md-body {
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--color-text);
  word-break: break-all;
  overflow-wrap: break-word;
  max-width: 100%;
  min-width: 0;
}
.md-body p {
  margin: 0 0 4px 0;
}
.md-body p:last-child {
  margin-bottom: 0;
}
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
  margin: var(--space-2) 0 4px 0;
  font-weight: 600;
  line-height: 1.3;
}
.md-body h1 { font-size: var(--font-lg); }
.md-body h2 { font-size: var(--font-md); }
.md-body h3 { font-size: var(--font-sm); }
.md-body h4, .md-body h5, .md-body h6 { font-size: var(--font-sm); }
.md-body ul, .md-body ol {
  margin: 4px 0;
  padding-left: var(--space-4);
}
.md-body li { margin: 2px 0; }
.md-body blockquote {
  margin: 4px 0;
  padding: 4px var(--space-3);
  border-left: 3px solid var(--color-divider);
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  /* 强制引用块超长文本自动换行 */
  word-break: break-all;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  max-width: 100%;
  min-width: 0;
}
.md-body blockquote > * {
  word-break: break-all;
  overflow-wrap: break-word;
  max-width: 100%;
  min-width: 0;
}
.md-body code {
  padding: 1px 6px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.9em;
  color: var(--color-accent);
  word-break: break-all;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  max-width: 100%;
}
.md-body pre {
  margin: 4px 0;
  padding: var(--space-2);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: break-word;
  max-width: 100%;
  min-width: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.md-body pre code {
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-size: inherit;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: break-word;
}
.md-body a {
  color: var(--color-primary);
  text-decoration: none;
}
.md-body a:hover {
  text-decoration: underline;
}
.md-body img {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
}
.md-body table {
  border-collapse: collapse;
  margin: 4px 0;
  font-size: var(--font-xs);
}
.md-body th, .md-body td {
  padding: 4px 8px;
  border: 1px solid var(--color-divider);
}
.md-body th {
  background: var(--color-bg);
  font-weight: 600;
}
.md-body hr {
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
}

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

</style>
