<script setup lang="ts">
/**
 * MergesView —— 仓库合并请求列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5 + plan_32018da5）：
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
import { computed, onMounted, ref, watch } from 'vue';
import { GitMerge, GitPullRequestArrow, GitBranch, RefreshCw, Search, ChevronDown, ChevronRight, ChevronUp, ExternalLink, XCircle, Pencil, MessageSquare, Send, Loader2 } from 'lucide-vue-next';
import { useRepoStore } from '@renderer/stores/repo';
import { usePullStore, type PullFilter } from '@renderer/stores/pull';
import { useAuthStore } from '@renderer/stores/auth';
import { showToast } from '@renderer/lib/toast';
import { renderMarkdown } from '@renderer/lib/markdown';
import { issuesCommentCreate, issuesCommentList } from '@renderer/lib/ipc-client';
import EmptyState from '@renderer/components/EmptyState.vue';
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import type { PullDto, RepoDto, MergeMethod } from '../../main/ipc/schema.js';
import type { IssueCommentDto } from '../../main/ipc/schema.js';

const repo = useRepoStore();
const pull = usePullStore();
const auth = useAuthStore();

/** 去掉 URL 末尾的 `/` 字符（gitea URL 拼接用）
 *
 * 为什么不用 template 里的 inline regex literal：
 * Vue 3 SFC compiler 在 attribute expression 里 parse regex literal 时
 * 对 `\\` 转义处理不一致，写 `/\\/$/` 会触发 "Invalid regular expression flag"。
 * 抽成函数 + string method 是最稳的写法。
 */
function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

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

/** 当前正在关闭的合并请求（null = 没在关闭） */
const closingPull = ref<PullDto | null>(null);
const closing = ref(false);

/** 二次确认弹窗开关 */
const confirmMergeOpen = ref(false);

onMounted(async () => {
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  if (!activeProjectId.value && repo.projects.length > 0) {
    const first = repo.projects[0]!;
    try {
      const project = await repo.addProject({ owner: first.owner, name: first.name });
      repo.selectProject(project);
    } catch {
      /* error in repo.error */
    }
  }
  if (activeProjectId.value) {
    await loadPulls();
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
  try {
    await pull.list(activeProjectId.value, true);
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '加载失败', persistent: true });
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
  const next = new Set(expanded.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
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
  }
}

/** 生成 gitea web 链接（reactive：跟随 giteaUrl / activeRepo 变化）
 *
 * 不用 RepoDto.url 字段——schema 里没这个字段，
 * 硬拼会得到 "https://kanban demo/m4java-test" 这种带空格的非法 URL。
 * 用 useAuthStore.currentGiteaUrl + 当前 activeRepo.owner/name 拼接。
 */
function giteaPullUrl(p: PullDto): string {
  if (!activeRepo.value) return '#';
  const giteaUrl = (auth.currentGiteaUrl || '').replace(/\/+$/, '');
  if (!giteaUrl) return '#';
  return `${giteaUrl}/${activeRepo.value.owner}/${activeRepo.value.name}/pulls/${p.index}`;
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
      const labelsResp = await window.api.labels.list(toPlain({ projectId: String(activeProjectId.value) })) as { items: { name: string; color: string }[] };
      availableLabels.value = labelsResp.items ?? [];
    } catch { /* 忽略 */ }
    try {
      // members.list 返回直接是数组（不是 {items}）
      const membersResp = await window.api.members.list(toPlain({ projectId: String(activeProjectId.value) })) as { username: string }[];
      availableMembers.value = (membersResp ?? []).map(m => m.username);
      // 识别组织账号（gitea 1.x 限制：组织不能作评审人，但可以作指派人）
      nonReviewableMembers.value = new Set(membersResp
        .filter((m: { login_type?: string; username: string }) => m.login_type === 'Organization' || m.login_type === 'organization')
        .map((m: { username: string }) => m.username));
    } catch { /* 忽略 */ }
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
    const newLabel = await window.api.labels.create(toPlain({
      projectId: String(activeProjectId.value),
      name: newLabelName.value.trim(),
      color,
    })) as { name: string; color: string };
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

/** 把任意对象深拷贝成可被 structured clone 的纯 plain object
 *
 * Vue 3 ref/computed 在跨 contextBridge 时会被结构化克隆
 * → "An object could not be cloned"
 * 用 JSON parse/stringify 强制展开成 plain data
 */
function toPlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** 保存属性（逐字段尝试，一个失败不影响其他） */
async function saveAttrs(p: PullDto): Promise<void> {
  if (!activeProjectId.value) return;
  const projectId = String(activeProjectId.value); // 显式解 ref
  const errors: string[] = [];

  // 1. 更新标签（替换所有标签）
  try {
    await window.api.pulls.updateLabels(toPlain({
      projectId,
      index: p.index,
      labels: editingLabels.value,
    }));
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`标签: ${err.messageText ?? err.message ?? '失败'}`);
  }

  // 2. 更新指派人（空串 = 清除指派人）
  try {
    await window.api.pulls.updateAssignee(toPlain({
      projectId,
      index: p.index,
      assignee: editingAssignee.value,
    }));
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    errors.push(`指派人: ${err.messageText ?? err.message ?? '失败'}`);
  }

  // 3. 更新评审人（过滤掉组织账号——gitea 1.x 不允许）
  const validReviewers = editingReviewers.value.filter(r => !nonReviewableMembers.value.has(r));
  try {
    await window.api.pulls.updateReviewers(toPlain({
      projectId,
      index: p.index,
      reviewers: validReviewers,
    }));
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
//   - 渲染：markdown-it + DOMPurify（见 src/renderer/lib/markdown.ts）
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
const currentUsername = computed<string | null>(() => auth.currentUsername ?? null);

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
    p = { items: [], loading: false, posting: false, error: null, lastLoadedAt: null };
    commentPanels.value.set(idx, p);
  }
  return p;
}

/** 拿某合并请求的评论草稿 */
function getDraft(idx: number): string {
  return commentDrafts.value.get(idx) ?? '';
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
  try {
    const list = (await issuesCommentList({
      projectId: String(activeProjectId.value),
      issueIndex: p.index,
    })) as IssueCommentDto[];
    panel.items = Array.isArray(list) ? list : [];
    panel.lastLoadedAt = Date.now();
  } catch (e) {
    const err = e as { messageText?: string };
    panel.error = err.messageText ?? '加载评论失败';
  } finally {
    panel.loading = false;
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
    await issuesCommentCreate({
      projectId: String(activeProjectId.value),
      issueIndex: p.index,
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
      hint: err.hint ?? '请检查网络或稍后重试',
      persistent: true,
    });
  } finally {
    panel.posting = false;
  }
}

/**
 * 评论输入框快捷键
 *   - Enter（无 Shift） → 提交
 *   - @ 候选打开时 ↑/↓ 选择 / Enter 选中
 *   - Esc 关闭 @ 候选
 */
function onCommentKeydown(p: PullDto, e: KeyboardEvent): void {
  if (e.nativeEvent.isComposing) return;

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
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: pull.loading }" />
          <span>{{ pull.loading ? '加载中…' : '刷新' }}</span>
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

    <!-- ============== 主体 ============== -->
    <div v-if="!activeRepo" class="merges__placeholder">
      <EmptyState title="还没有选中仓库" description='去"看板"页选一个仓库，再回来这里看合并请求' />
    </div>
    <div v-else-if="pull.loading && pull.items.length === 0" class="merges__placeholder">
      <p class="muted">加载中…</p>
    </div>
    <div
      v-else-if="!pull.filteredItems.length && pull.items.length > 0"
      class="merges__placeholder"
    >
      <EmptyState
        :title="`没有匹配「${tabs.find((t) => t.id === pull.filter)?.label}」的合并请求`"
        description="试试切换其他 tab，或调整搜索词"
      />
    </div>
    <div v-else-if="!pull.items.length" class="merges__placeholder">
      <EmptyState
        title="这个仓库还没有合并请求"
        description="去 gitea 创建第一个合并请求，或去时间轴页看分支进度"
      />
    </div>
    <ul v-else class="merges__list">
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
          </div>
          <div class="merge-item__body">
            <a
              :href="giteaPullUrl(p)"
              target="_blank"
              rel="noopener"
              class="merge-item__index mono"
              @click.stop
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
            <div class="merge-item__attrs">
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
          <span
            v-if="p.hasConflicts && p.state === 'open'"
            class="merge-item__conflict-hint"
            :title="'此合并请求存在冲突，请先在 gitea 页面解决'"
          >有冲突</span>
          <a
            :href="giteaPullUrl(p)"
            target="_blank"
            rel="noopener"
            class="merge-item__ext-link"
            :title="'在 gitea 中打开 #' + p.index"
            @click.stop
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
          <!-- ===== 评论区：v1.4 整行铺满 ===== -->
          <div class="merge-item__comments">
            <div class="merge-item__comments-header">
              <MessageSquare :size="14" :stroke-width="2" aria-hidden="true" />
              <span class="merge-item__comments-title">
                对话
                <span v-if="getPanel(p.index).items.length > 0" class="merge-item__comments-count">
                  ({{ getPanel(p.index).items.length }})
                </span>
              </span>
                <button
                  type="button"
                  class="merge-item__comments-refresh"
                  :disabled="getPanel(p.index).loading"
                  :title="'刷新对话'"
                  @click.stop="fetchComments(p)"
                >
                  <RefreshCw
                    :size="12"
                    :stroke-width="2"
                    :class="{ spin: getPanel(p.index).loading }"
                    aria-hidden="true"
                  />
                  <span>{{ getPanel(p.index).loading ? '加载中…' : '刷新' }}</span>
                </button>
              </div>
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
              <!-- 评论列表：气泡聊天布局 + 滚动 -->
              <ul v-else class="merge-item__comment-list">
                <li
                  v-for="c in getPanel(p.index).items"
                  :key="c.id"
                  class="merge-item__comment"
                  :class="{ 'merge-item__comment--self': currentUsername && c.author.username === currentUsername }"
                >
                  <!-- 头像圈（首字母） -->
                  <div
                    class="merge-item__comment-avatar"
                    :title="c.author.username"
                    aria-hidden="true"
                  >{{ (c.author.username || '?').charAt(0).toUpperCase() }}</div>
                  <div class="merge-item__comment-bubble">
                    <div class="merge-item__comment-meta">
                      <span class="merge-item__comment-author">{{ c.author.username }}</span>
                      <span v-if="currentUsername && c.author.username === currentUsername" class="merge-item__comment-self-tag">我</span>
                      <span class="merge-item__comment-time" :title="formatDate(c.createdAt)">{{ formatRelative(c.createdAt) }}</span>
                    </div>
                    <!-- markdown-it + DOMPurify 渲染的 HTML（src/renderer/lib/markdown.ts 已 sanitize） -->
                    <div class="merge-item__comment-body md-body" v-html="renderMarkdown(c.body)"></div>
                  </div>
                </li>
              </ul>
              <!-- 发评论输入区（v1.4 加大 + @ 提及自动补全） -->
              <div class="merge-item__comment-compose">
                <div class="merge-item__comment-input-wrap">
                  <textarea
                    ref="commentInputRef"
                    class="merge-item__comment-input"
                    :value="getDraft(p.index)"
                    @input="onCommentInput(p, $event)"
                    @keydown="onCommentKeydown(p, $event)"
                    :placeholder="'发条评论给 #' + p.index + '（@ 提及成员，Enter 发送，⌘/Ctrl+Enter 也行）'"
                    :disabled="getPanel(p.index).posting"
                    rows="3"
                    maxlength="65535"
                    spellcheck="false"
                  ></textarea>
                  <!-- @ 提及下拉（v1.4 新增） -->
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
                  <button
                    type="button"
                    class="merge-item__comment-send"
                    :disabled="getPanel(p.index).posting || getDraft(p.index).trim().length === 0"
                    :title="'发送评论'"
                    @click.stop="postComment(p)"
                  >
                    <Send :size="12" :stroke-width="2" aria-hidden="true" />
                    <span>{{ getPanel(p.index).posting ? '发送中…' : '发送' }}</span>
                  </button>
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
      </div>
    </ConfirmDialog>

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
  background: var(--color-bg-elevated);
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
  background: var(--color-bg);
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
  background: var(--color-bg);
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
  background: var(--color-bg);
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
  gap: var(--space-2);
  padding: var(--space-4);
  overflow-y: auto;
}

.merge-item {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  transition: background var(--t-fast) var(--ease);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  /* 关键：父 .merges__list 是 flex column，
  /* 关键：父 .merges__list 是 flex column，
   * 子 item 默认 flex-shrink: 1 会让每个 item 被等比压缩。
   * 43 个 item 共 1870px head 高，容器 622px 会被压缩到每个 15px——
   * 完全看不见。设 flex-shrink: 0 让 item 保持完整高度，
   * 容器才触发 overflow-y: auto 滚动。 */
  flex-shrink: 0;
  /* 模仿 gitea /pulls 列表的 .flex-item 三块布局：leading | main | trailing */
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
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
  /* v1.3：去 padding-top 2px，让 icon 与 main 垂直居中对齐（不再贴首行） */
  padding: 0;
  /* 让 icon 与 main 第一行基线对齐 —— main 第一行是 header (font-md 600),
   * icon 16px 在 main 高度 ~40px 容器里垂直居中即可 */
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
  gap: 4px;
}

.merge-item__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.merge-item__title {
  font-size: var(--font-md);
  color: var(--color-text);
  font-weight: 600;
  text-decoration: none;
  flex: 1 1 0;
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
  /* v1.3 · task #25 调整：gap 缩小,让顶部"创建 / 冲突"等行更紧凑,
   * 把右半空间让给展开后的评论区 */
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
  padding: var(--space-3) 0 0;
  border-top: 1px solid var(--color-divider);
  margin-top: var(--space-3);
  /* v1.3 · task #25 调整：左 meta / 右 comments 两栏
   * v1.4 · task #30 简化：detail 改单列，评论区/输入框**整行铺满**不再受左 meta 限制
   *  左 meta 改为详情区头部一行（折行），评论区拿满整行宽度 */
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
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
  gap: var(--space-2);
  min-width: 0;
  min-height: 0;
  /* 充满整个右栏高度（父 .merge-item__detail 是 grid,align-items: start,
   * 但 detail-right 自身高度 = 右栏行高;用 min-height: 100% 让 compose 区
   * 永远贴底、list 区占满剩余空间） */
  height: 100%;
}

.merge-item__comments-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 4px;
  flex-shrink: 0;
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
}

.merge-item__comments-refresh {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
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

.merge-item__comments-loading,
.merge-item__comments-empty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: var(--space-2) 0;
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
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* v1.3.1：flex 占满右栏剩余垂直空间,不再固定 360px;
   * max-height 改为 60vh,保留上限避免特别高的右栏把列表拉过长 */
  flex: 1 1 0;
  min-height: 0;
  max-height: 60vh;
  overflow-y: auto;
  /* 自定义滚动条样式（webkit only） */
  scrollbar-width: thin;
  scrollbar-color: var(--color-divider) transparent;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
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

.merge-item__comment--self {
  /* "我" 的评论整条反序，让头像+气泡都贴右 */
  flex-direction: row-reverse;
}

/* 头像圈（首字母） */
.merge-item__comment-avatar {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--color-divider);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  user-select: none;
}
.merge-item__comment--self .merge-item__comment-avatar {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

/* 气泡容器 */
.merge-item__comment-bubble {
  max-width: 78%;
  min-width: 0;
  padding: 6px 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: 10px;
  position: relative;
  /* 默认（他人）—— 小尖角在左上角 */
}
.merge-item__comment-bubble::before {
  content: '';
  position: absolute;
  top: 8px;
  left: -5px;
  width: 8px;
  height: 8px;
  background: var(--color-bg-elevated);
  border-left: 1px solid var(--color-divider);
  border-bottom: 1px solid var(--color-divider);
  transform: rotate(45deg);
}
.merge-item__comment--self .merge-item__comment-bubble {
  background: var(--color-primary-soft, var(--color-bg-elevated));
  border-color: var(--color-primary);
}
.merge-item__comment--self .merge-item__comment-bubble::before {
  left: auto;
  right: -5px;
  background: var(--color-primary-soft, var(--color-bg-elevated));
  border-left: none;
  border-bottom: none;
  border-right: 1px solid var(--color-primary);
  border-top: 1px solid var(--color-primary);
}

.merge-item__comment-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
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
  word-break: break-word;
  overflow-wrap: anywhere;
  line-height: 1.5;
}

/* 发评论输入区 */
.merge-item__comment-compose {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

/* textarea + @ 候选下拉的相对定位容器 */
.merge-item__comment-input-wrap {
  position: relative;
}

/* v1.4 输入框更大（min-height 从 56px → 72px） */
.merge-item__comment-input {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  background: transparent;
  border: none;
  outline: none;
  font: inherit;
  font-size: var(--font-sm);
  color: var(--color-text);
  font-family: inherit;
  padding: 0;
}

/* v1.4 @ 提及下拉（绝对定位，浮在 textarea 上方） */
.merge-item__mention-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: 2px;
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
  padding: 6px var(--space-3);
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
  gap: var(--space-2);
}
.merge-item__comment-counter {
  margin-right: auto;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.merge-item__comment-send {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.merge-item__comment-send:hover:not(:disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}
.merge-item__comment-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
}
.md-body code {
  padding: 1px 6px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.9em;
  color: var(--color-accent);
}
.md-body pre {
  margin: 4px 0;
  padding: var(--space-2);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.md-body pre code {
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-size: inherit;
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
</style>
