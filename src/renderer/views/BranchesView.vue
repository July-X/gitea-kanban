<script setup lang="ts">
/**
 * BranchesView —— 仓库分支列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5 + plan_32018da5）：
 *   - 顶栏：仓库名 + 总分支数 + 搜索框 + "仅看收藏" toggle + 刷新按钮
 *   - 主体：分支列表（卡片化：name / 默认分支高亮 / 收藏星标 / 最后 commit / 创建时间）
 *   - 数据：branches.list IPC → useBranchStore
 *   - 跳转：双击 name 跳 gitea（v1 走 window.open，**不**直接 gitea 嵌入）
 *   - **点击行**：右侧出 BranchDetailAside（最后 commit + 操作 + commits 分页列表）
 *
 * 零术语：UI 文本**不**出现 branch 原词（除"分支"）。
 *   - 列表头："分支 / 默认 / 收藏 / 最后提交 / 更新时间"
 *
 * v1 简化：
 *   - **不**做新建/重命名/删除分支（v1 只读）
 *   - 收藏走 branches.star IPC（行内点星 + aside 里的按钮都接同一 action）
 *   - **不**做 ahead/behind / 设为默认（用户未拍板）
 *   - 详情 aside 内嵌 commits 分页列表（commits.list 端点已支持 sha + page + hasMore）
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Clipboard,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  Star,
  StarOff,
  Timer,
  X,
} from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { showToast } from '@renderer/lib/toast';
import { clipboardWrite, commitsGet, commitsList, normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type {
  BranchDto,
  CommitDto,
  CommitFileChangeDto,
  ListCommitsResp,
  RepoDto,
} from '../../main/ipc/schema.js';

const auth = useAuthStore();
const repo = useRepoStore();
const branch = useBranchStore();
const router = useRouter();
const route = useRoute();

const activeProjectId = computed<string | null>(() => repo.currentProjectId);

const activeRepo = computed<RepoDto | null>(() => {
  const fn = repo.currentProject ? `${repo.currentProject.owner}/${repo.currentProject.name}` : null;
  return fn ? (repo.repos.find((r) => r.fullName === fn) ?? null) : null;
});

/**
 * 用户填的 gitea 服务器 origin（task #21 —— 跳转 gitea 不再硬拼 `https://`）
 *
 * 路径：auth store → accounts[0].giteaUrl → `new URL().origin`（去掉 path）
 *
 * 为什么不直接 `https://${owner}/...`：
 * 1) 用户可能填 `http://localhost:3000`（自部署 gitea 走 http）
 * 2) 用户可能填 `https://git.example.com/gitea`（子路径部署）
 * 3) 旧实现硬拼 `https://${owner}` 把子路径丢了，跳到错误 URL
 *
 * 兜底：auth.accounts 空（理论上不发生，因为没 auth 进不到 branches 页）→ 退回 owner 推
 */
const giteaUrlBase = computed<string>(() => {
  const raw = auth.currentGiteaUrl;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      /* 解析失败退回下面 */
    }
  }
  // 兜底：按 owner 猜（dev 默认 localhost:3000）
  const owner = activeRepo.value?.owner ?? '';
  return owner ? `https://${owner}` : '';
});

onMounted(async () => {
  // 1. 仓库列表就绪
  if (repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
  }
  // 2. 默认选第一个 project（如果当前没有）
  if (!activeProjectId.value && repo.projects.length > 0) {
    const first = repo.projects[0]!;
    try {
      const project = await repo.addProject({ owner: first.owner, name: first.name });
      repo.selectProject(project);
    } catch {
      /* error in repo.error */
    }
  }
  // 3. 拉分支
  if (activeProjectId.value) {
    await loadBranches();
  }
  // 4. 全局键盘：Esc 关闭 aside
  window.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
});

watch(
  () => activeProjectId.value,
  async (id) => {
    if (id) {
      await loadBranches();
    } else {
      branch.$reset?.();
    }
  },
);

async function loadBranches(): Promise<void> {
  if (!activeProjectId.value) return;
  try {
    await branch.list(activeProjectId.value, true);
  } catch (e) {
    // error 已在 store 里
    const err = e as { messageText?: string };
    showToast({
      type: 'error',
      message: err.messageText ?? '加载失败',
      description: '请稍后重试或检查网络',
    });
  }
}

async function onRefresh(): Promise<void> {
  try {
    await branch.refresh();
    showToast({ type: 'success', message: `已刷新，共 ${branch.total} 条` });
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: err.messageText ?? '刷新失败' });
  }
}

/** 构造 gitea 上某资源 URL（task #21 —— 走用户填的服务器地址）
 *
 *  模板：`<giteaOrigin>/<owner>/<repo>/<path>`
 *  - origin：auth.currentGiteaUrl.origin（http/https + host + port）
 *  - owner / repo：从 activeRepo 取
 *  - path：分支 / 提交 / 合并请求等子路径
 *
 *  注意：gitea 自身 owner 字段可能含 "host/gitea-org" 这种子路径前缀的场景
 * 在 v1 自部署场景不会遇到（owner 总是单纯 gitea 用户/组织名），不做兼容
 */
function giteaUrl(path: string): string {
  if (!giteaUrlBase.value || !activeRepo.value) return '';
  return `${giteaUrlBase.value}/${activeRepo.value.owner}/${activeRepo.value.name}/${path}`;
}

/** 双击 name 跳 gitea（v1 走外部浏览器） */
function onOpenInGitea(b: BranchDto): void {
  if (!activeRepo.value) return;
  const url = giteaUrl(`src/branch/${encodeURIComponent(b.name)}`);
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 选中某行：右出 aside */
function onSelectRow(b: BranchDto): void {
  branch.select(b.name);
}

/** 键盘：上下移动选中行（roving tabindex） */
function onRowKeydown(e: KeyboardEvent, b: BranchDto, idx: number, list: BranchDto[]): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onSelectRow(b);
    return;
  }
  if (e.key === 'ArrowDown' && idx < list.length - 1) {
    e.preventDefault();
    const next = list[idx + 1]!;
    focusedIndex.value = idx + 1;
    document.querySelector<HTMLLIElement>(`[data-branch-name="${CSS.escape(next.name)}"]`)?.focus();
  } else if (e.key === 'ArrowUp' && idx > 0) {
    e.preventDefault();
    const prev = list[idx - 1]!;
    focusedIndex.value = idx - 1;
    document.querySelector<HTMLLIElement>(`[data-branch-name="${CSS.escape(prev.name)}"]`)?.focus();
  }
}

const focusedIndex = ref(0);

/** Esc 关闭 aside */
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && branch.currentSelectedName) {
    e.preventDefault();
    branch.select(null);
  }
}

/** 切换收藏（行内 + aside 都用） */
async function onToggleStar(b: BranchDto, e?: Event): Promise<void> {
  e?.stopPropagation();
  const target = !b.starred;
  try {
    await branch.star(b.name, target);
    showToast({
      type: 'success',
      message: target ? `已收藏 ${b.name}` : `已取消收藏 ${b.name}`,
      duration: 1800,
    });
  } catch (err) {
    showToast({ type: 'error', message: normalizeError(err).messageText });
  }
}

/** 通用：复制文本到剪贴板 —— 走主进程 IPC（task #20 · 绕过 navigator.clipboard 在 Electron 不稳定） */
async function copyText(text: string): Promise<boolean> {
  try {
    await clipboardWrite(text);
    return true;
  } catch {
    return false;
  }
}

/** 复制分支名到剪贴板 */
async function onCopyBranchName(b: BranchDto, e?: Event): Promise<void> {
  e?.stopPropagation();
  const ok = await copyText(b.name);
  if (ok) {
    showToast({ type: 'success', message: `已复制分支名 ${b.name}`, duration: 1500 });
  } else {
    showToast({ type: 'warn', message: '复制失败，请手动选择' });
  }
}

/**
 * 复制提交 hash（行内短 hash 点击 · 展开后完整 hash 点击共用）
 *
 * 关键：必须 stopPropagation —— 短 hash 包在 `.branch-commit-row__head` 这个
 * <button> 里，冒泡会触发 toggleCommitExpand，先复制再展开体验糟。
 * 全量 hash 展示（c.sha）方便用户从 toast 复制走的就是完整的 sha 字符串。
 */
async function onCopyCommitHash(c: CommitDto, e?: Event): Promise<void> {
  e?.stopPropagation();
  const ok = await copyText(c.sha);
  if (ok) {
    showToast({ type: 'success', message: `已复制提交号 ${c.shortSha}`, duration: 1500 });
  } else {
    showToast({ type: 'warn', message: '复制失败，请手动选择' });
  }
}

/** 展开后点「在 gitea 打开此提交」 */
function onOpenCommitInGitea(c: CommitDto, e?: Event): void {
  e?.stopPropagation();
  if (!activeRepo.value) return;
  const url = giteaUrl(`commit/${c.sha}`);
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** "在时间轴查看此分支"——跨视图状态传递 */
function onJumpToTimeline(b: BranchDto, e?: Event): void {
  e?.stopPropagation();
  branch.setPendingTimelineFocus(b.name);
  void router.push({ name: 'timeline' });
  // aside 不关——用户切回时还能看到详情
}

/** aside 里的"在浏览器中打开" */
function onAsideOpenInGitea(b: BranchDto): void {
  onOpenInGitea(b);
}

/** 关闭 aside */
function onCloseAside(): void {
  branch.select(null);
}

/** 格式化 ISO 时间到本地短格式 */
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

/** 相对时间（粗略）：< 1小时 → "X 分钟前"；< 1天 → "X 小时前"；< 7天 → "X 天前"；否则本地短日期 */
function relativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const t = new Date(iso).getTime();
    const now = Date.now();
    const diffMs = now - t;
    if (Number.isNaN(diffMs)) return iso;
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  } catch {
    return iso;
  }
}

/** commit shortSha 截前 7 */
function shortSha(sha: string | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

/** 头像首字母 fallback */
function initial(name: string | undefined): string {
  if (!name) return '?';
  // 跳过 emoji / 多字节字符的首字符，取第一个英文字母
  const m = name.match(/[A-Za-z]/);
  if (m) return m[0]!.toUpperCase();
  return name.charAt(0) || '?';
}

// =============================================================
// 详情面板内嵌的 commits 分页列表（in-file 子状态，**不**抽成子组件）
// =============================================================
//
// 设计：v1 简化下，**不**抽 BranchCommitsPane 组件（避免 §7.1 "新组件 / 新通用 UI"边界）。
// 直接在根 setup 内用顶层 ref 维护 commits 列表状态，watch 选中分支变化时重拉。
//
// 数据源：commits.list IPC（已支持 sha + page + hasMore，零 schema 改动）。
// 限制：list 端点**不**返 additions/deletions/filesChanged（gitea list 不含 stats），
//       列表行 chip **不**显示这些数字。
//
// v1.1.3 · task #23 —— 展开单条 commit 时**显式接受单次 commits.get** 拿 files+patch：
// 用户主动点开才查（不是 list 预拉），单次 N+1 可接受。
// patch 字段在 main 端 toCommitDto 阶段就地解析为 functions（按文件去重），
// patch 字符串**不**进 IPC 边界。

const commits = ref<CommitDto[]>([]);
const commitsPage = ref(1);
const commitsTotal = ref(0);
const commitsHasMore = ref(false);
const commitsLoading = ref(false);
const commitsError = ref<UserFacingError | null>(null);
const commitsExpanded = ref<Set<string>>(new Set());
/** 单条 commit 详情缓存（含 files）。v1 内存 Map，换分支 / 切 project 时清空。 */
const commitDetails = ref<Map<string, CommitDto>>(new Map());
/** 展开时正在拉详情的 sha 集合（用于显示 loader 状态） */
const loadingCommitDetails = ref<Set<string>>(new Set());

async function loadCommitsPage(page: number): Promise<void> {
  const pid = activeProjectId.value;
  const branchName = branch.selectedBranch?.name;
  if (!pid || !branchName) {
    commits.value = [];
    commitsTotal.value = 0;
    commitsHasMore.value = false;
    return;
  }
  commitsLoading.value = true;
  commitsError.value = null;
  try {
    const resp = (await commitsList({
      projectId: pid,
      sha: branchName,
      page,
      limit: 30,
    })) as ListCommitsResp;
    commits.value = resp.items;
    commitsTotal.value = resp.total;
    commitsHasMore.value = resp.hasMore;
    commitsPage.value = page;
  } catch (e) {
    commitsError.value = e as UserFacingError;
    commits.value = [];
    commitsTotal.value = 0;
    commitsHasMore.value = false;
  } finally {
    commitsLoading.value = false;
  }
}

watch(
  () => branch.selectedBranch?.name ?? null,
  (name) => {
    // 切分支时清空详情缓存 + loader 状态
    commitDetails.value = new Map();
    loadingCommitDetails.value = new Set();
    if (!name) {
      commits.value = [];
      commitsTotal.value = 0;
      commitsHasMore.value = false;
      commitsError.value = null;
      return;
    }
    commitsPage.value = 1;
    commitsExpanded.value = new Set();
    void loadCommitsPage(1);
  },
  { immediate: true },
);

function onPagePrev(): void {
  if (commitsPage.value > 1 && !commitsLoading.value) {
    void loadCommitsPage(commitsPage.value - 1);
  }
}

function onPageNext(): void {
  if (commitsHasMore.value && !commitsLoading.value) {
    void loadCommitsPage(commitsPage.value + 1);
  }
}

/**
 * 行内展开/折叠 —— v1.1.3 · task #30 改手风琴
 *
 * 历史（task #23 起）：首次展开走 commits.get 拿 files + functions；
 *   二次展开读 commitDetails Map 缓存；收起不删缓存。
 * 现在（task #30）：手风琴语义 —— 任意点击都"全清再开"。
 *   - 点开着的 → 折叠（commitsExpanded = new Set()）
 *   - 点没开着的 → fetch 后 commitsExpanded = new Set([sha])（其他已开的被自动关掉）
 *
 * 缓存策略零变化：commitDetails 只在 fetch 成功时增（line 463 风格的 detailsNext.set），
 *   收起**不删**；二次展开走 if (!commitDetails.value.has(sha)) 的 false 分支跳过 fetch。
 *   切分支时（line 412 附近 watcher）整张 Map 清空，跨分支不污染。
 */
async function toggleCommitExpand(sha: string): Promise<void> {
  // 手风琴：点开着的 → 关；点没开着的 → fetch 后只开这一条（自动关其他）
  const willOpen = !commitsExpanded.value.has(sha);
  if (!willOpen) {
    commitsExpanded.value = new Set();
    return; // 收起 —— 缓存保留，不再删 commitDetails
  }
  // 首次展开：取 detail（命中缓存则跳过 fetch）
  if (!commitDetails.value.has(sha)) {
    const pid = activeProjectId.value;
    if (!pid) return;
    const loadingNext = new Set(loadingCommitDetails.value);
    loadingNext.add(sha);
    loadingCommitDetails.value = loadingNext;
    try {
      const detail = (await commitsGet({ projectId: pid, sha })) as CommitDto;
      const detailsNext = new Map(commitDetails.value);
      detailsNext.set(sha, detail);
      commitDetails.value = detailsNext;
    } catch (e) {
      showToast({
        type: 'error',
        message: '加载提交详情失败',
        description: (e as Error).message ?? '请稍后重试',
      });
      const loadingDone = new Set(loadingCommitDetails.value);
      loadingDone.delete(sha);
      loadingCommitDetails.value = loadingDone;
      return;
    }
    const loadingDone = new Set(loadingCommitDetails.value);
    loadingDone.delete(sha);
    loadingCommitDetails.value = loadingDone;
  }
  // 手风琴：清空所有已展开的，只开当前这一条
  commitsExpanded.value = new Set([sha]);
}

// ============== v1.1.3 · task #23 · 文件清单统计 helpers ==============
/** 文件清单中是否含非二进制文件（决定是否显示 +/- 行数摘要） */
function filesHasNonBinary(files: CommitFileChangeDto[]): boolean {
  return files.some((f) => !f.binary);
}
/** 非二进制文件的 +行 总和 */
function totalAdditions(files: CommitFileChangeDto[]): number {
  return files.filter((f) => !f.binary).reduce((s, f) => s + (f.additions ?? 0), 0);
}
/** 非二进制文件的 -行 总和 */
function totalDeletions(files: CommitFileChangeDto[]): number {
  return files.filter((f) => !f.binary).reduce((s, f) => s + (f.deletions ?? 0), 0);
}

const commitStartIdx = computed(() => (commitsTotal.value === 0 ? 0 : (commitsPage.value - 1) * 30 + 1));
const commitEndIdx = computed(() => commitStartIdx.value + commits.value.length - 1);
</script>

<template>
  <div class="branches">
    <!-- ============== 顶栏 ============== -->
    <header class="branches__topbar">
      <div class="branches__title">
        <GitBranch :size="18" :stroke-width="1.75" aria-hidden="true" />
        <div class="branches__title-text">
          <h1 class="branches__title-h1">分支</h1>
          <p class="branches__repo">{{ activeRepo?.fullName ?? '请选择仓库' }}</p>
        </div>
      </div>
      <div class="branches__topbar-right">
        <span class="branches__counter">
          共 {{ branch.total }} 个分支<template v-if="branch.total">
            · 收藏 {{ branch.starredItems.length }} 个
          </template>
        </span>
        <button
          type="button"
          class="branches__refresh"
          :disabled="branch.loading"
          :title="'刷新'"
          @click="onRefresh"
        >
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: branch.loading }" />
          <span>{{ branch.loading ? '加载中…' : '刷新' }}</span>
        </button>
      </div>
    </header>

    <!-- ============== 搜索 + 过滤 ============== -->
    <div v-if="activeProjectId" class="branches__filters">
      <div class="branches__search">
        <Search :size="14" :stroke-width="2" aria-hidden="true" />
        <input
          v-model="branch.search"
          type="text"
          class="branches__search-input"
          placeholder="按名称搜索"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <label class="branches__toggle" :title="'仅看收藏'">
        <input v-model="branch.onlyStarred" type="checkbox" />
        <Star v-if="branch.onlyStarred" :size="14" :stroke-width="2" aria-hidden="true" />
        <StarOff v-else :size="14" :stroke-width="2" aria-hidden="true" />
        <span>仅看收藏</span>
      </label>
    </div>

    <!-- ============== 错误条 ============== -->
    <div v-if="branch.error" class="branches__error" role="alert">
      <p class="branches__error-msg">{{ branch.error.messageText }}</p>
      <p class="branches__error-hint">{{ branch.error.hint }}</p>
    </div>

    <!-- ============== 主体：左 rail（分支）+ 右主区（详情） ==============
         布局：左 240px 紧凑 rail（始终显示） + 右主区（占剩余空间 = commits 大面积）
         理由：长期 / 大工程 git 库分支数 50+ 时，rail 让用户能快速定位 + 切换；
              主区 70%+ 宽度给 commits 列表，每行可显示完整 message / hash / 时间
    -->
    <div class="branches__body">
      <!-- ============== 左侧 rail：分支列表（240px） ============== -->
      <aside class="branches__rail" :aria-label="'分支列表'">
        <div v-if="!activeRepo" class="branches__rail-empty">
          <p class="muted text-xs">请先在"看板"页选择仓库</p>
        </div>
        <div v-else-if="branch.loading && branch.items.length === 0" class="branches__rail-empty">
          <p class="muted text-xs">加载中…</p>
        </div>
        <div
          v-else-if="!branch.filteredItems.length && branch.items.length > 0"
          class="branches__rail-empty"
        >
          <p class="muted text-xs">没有匹配的分支</p>
        </div>
        <div v-else-if="!branch.items.length" class="branches__rail-empty">
          <p class="muted text-xs">暂无分支</p>
        </div>
        <ul
          v-else
          class="branches__list"
          role="listbox"
          :aria-label="'分支'"
          @keydown.esc="onCloseAside"
        >
          <li
            v-for="(b, idx) in branch.filteredItems"
            :key="b.name"
            :data-branch-name="b.name"
            class="branch-item"
            :class="{
              'branch-item--default': b.isDefault,
              'branch-item--starred': b.starred,
              'branch-item--selected': branch.currentSelectedName === b.name,
            }"
            :tabindex="0"
            :aria-selected="branch.currentSelectedName === b.name"
            role="option"
            @click="onSelectRow(b)"
            @dblclick="onOpenInGitea(b)"
            @keydown="onRowKeydown($event, b, idx, branch.filteredItems)"
          >
            <div class="branch-item__line">
              <GitBranch
                :size="13"
                :stroke-width="2"
                aria-hidden="true"
                class="branch-item__icon"
                :class="{ 'branch-item__icon--default': b.isDefault }"
              />
              <span class="branch-item__name mono" :title="b.name">{{ b.name }}</span>
              <span
                v-if="b.protected"
                class="branch-item__dot branch-item__dot--protected"
                :title="'受保护'"
                aria-label="'受保护'"
              />
              <span
                v-if="b.starred"
                class="branch-item__dot branch-item__dot--starred"
                :title="'已收藏'"
                aria-label="'已收藏'"
              />
            </div>
            <div class="branch-item__sub muted">
              <span class="mono branch-item__sha">{{ shortSha(b.lastCommit?.sha) }}</span>
              <span class="branch-item__time">· {{ relativeTime(b.lastCommit?.date) }}</span>
            </div>
          </li>
        </ul>
      </aside>

      <!-- ============== 右侧主区：详情（占剩余 70%+ 宽度） ============== -->
      <main class="branches__main">
        <!-- 未选任何分支：空态 -->
        <div v-if="!branch.currentSelectedName" class="branches__main-empty">
          <GitBranch :size="48" :stroke-width="1.25" aria-hidden="true" class="branches__main-empty-icon" />
          <p class="branches__main-empty-title">从左侧选择一个分支</p>
          <p class="muted text-xs branches__main-empty-hint">
            详情会出现在这里 · 上下方向键可切换 · Enter 选中
          </p>
        </div>

        <!-- 选中分支：详情面板 -->
        <div
          v-else-if="branch.selectedBranch"
          class="branches__detail"
          :key="branch.selectedBranch.name"
        >
          <header class="branches__detail-head">
            <div class="branches__detail-title">
              <GitBranch :size="18" :stroke-width="2" aria-hidden="true" />
              <span class="mono branches__detail-name">{{ branch.selectedBranch.name }}</span>
              <div class="branches__detail-tags">
                <span v-if="branch.selectedBranch.isDefault" class="branches__tag branches__tag--default">默认</span>
                <span v-if="branch.selectedBranch.protected" class="branches__tag branches__tag--protected">受保护</span>
                <span v-if="branch.selectedBranch.starred" class="branches__tag branches__tag--starred">已收藏</span>
              </div>
            </div>
            <div class="branches__detail-head-actions">
              <button
                type="button"
                class="branches__chip"
                :class="{ 'branches__chip--starred': branch.selectedBranch.starred }"
                :title="branch.selectedBranch.starred ? '取消收藏' : '收藏'"
                @click="onToggleStar(branch.selectedBranch)"
              >
                <Star
                  v-if="branch.selectedBranch.starred"
                  :size="13"
                  :stroke-width="2"
                  :fill="'currentColor'"
                  aria-hidden="true"
                />
                <StarOff v-else :size="13" :stroke-width="2" aria-hidden="true" />
                <span>{{ branch.selectedBranch.starred ? '取消收藏' : '收藏' }}</span>
              </button>
              <button
                type="button"
                class="branches__detail-close"
                :title="'关闭详情'"
                :aria-label="'关闭详情'"
                @click="onCloseAside"
              >
                <X :size="16" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </header>

          <!-- 操作 + 最后提交 同行（紧凑摘要） -->
          <div class="branches__detail-meta">
            <section v-if="branch.selectedBranch.lastCommit" class="branches__detail-meta-commit">
              <p class="branches__detail-commit-msg" :title="branch.selectedBranch.lastCommit.message">
                {{ branch.selectedBranch.lastCommit.message.split('\n')[0] }}
              </p>
              <p class="branches__detail-commit-sub muted text-xs">
                <span class="mono">{{ shortSha(branch.selectedBranch.lastCommit.sha) }}</span>
                · {{ branch.selectedBranch.lastCommit.author }}
                · {{ formatDate(branch.selectedBranch.lastCommit.date) }}
              </p>
            </section>
            <section class="branches__detail-meta-actions">
              <button
                type="button"
                class="branches__chip"
                :title="`复制分支名 ${branch.selectedBranch.name}`"
                @click="onCopyBranchName(branch.selectedBranch)"
              >
                <Copy :size="13" :stroke-width="2" aria-hidden="true" />
                <span>复制分支名</span>
              </button>
              <button
                type="button"
                class="branches__chip"
                :title="`在浏览器中打开 ${branch.selectedBranch.name}`"
                @click="onAsideOpenInGitea(branch.selectedBranch)"
              >
                <ExternalLink :size="13" :stroke-width="2" aria-hidden="true" />
                <span>在浏览器中打开</span>
              </button>
              <button
                type="button"
                class="branches__chip"
                :title="`在时间轴查看 ${branch.selectedBranch.name}`"
                @click="onJumpToTimeline(branch.selectedBranch)"
              >
                <Timer :size="13" :stroke-width="2" aria-hidden="true" />
                <span>在时间轴查看</span>
              </button>
            </section>
          </div>

          <!-- commits 分页列表（主区核心内容，占据主区主要空间） -->
          <section class="branches__commits-section">
            <div class="branches__commits-head">
              <h3 class="branches__commits-title">提交列表</h3>
              <span v-if="!commitsLoading && commitsTotal > 0" class="branches__commits-count muted text-xs">
                共 {{ commitsTotal }} 条 · 第 {{ commitStartIdx }}-{{ commitEndIdx }} 条
              </span>
              <span v-else-if="commitsLoading" class="branches__commits-count muted text-xs">
                <Loader2 :size="11" :stroke-width="2" class="spin-inline" /> 加载中…
              </span>
            </div>

            <div v-if="commitsError" class="branches__commits-error">
              {{ commitsError.messageText }}
            </div>

            <ul v-else-if="commits.length > 0" class="branches__commits-list">
              <li
                v-for="c in commits"
                :key="c.sha"
                class="branch-commit-row"
                :class="{ 'branch-commit-row--expanded': commitsExpanded.has(c.sha) }"
              >
                <button
                  type="button"
                  class="branch-commit-row__head"
                  :aria-expanded="commitsExpanded.has(c.sha)"
                  :aria-controls="`commit-detail-${c.sha}`"
                  @click="toggleCommitExpand(c.sha)"
                >
                  <span
                    class="branch-commit-row__avatar"
                    :title="c.author.name"
                    aria-hidden="true"
                  >
                    <img
                      v-if="c.author.avatarUrl"
                      :src="c.author.avatarUrl"
                      :alt="c.author.name"
                      class="branch-commit-row__avatar-img"
                      @error="($event.target as HTMLImageElement).style.display='none'"
                    />
                    <span v-else class="branch-commit-row__avatar-fallback">{{ initial(c.author.name) }}</span>
                  </span>
                  <span class="branch-commit-row__name">{{ c.author.name }}</span>
                  <span class="branch-commit-row__msg">{{ c.message.split('\n')[0] }}</span>
                  <span class="branch-commit-row__meta muted">
                    <button
                      type="button"
                      class="branch-commit-row__sha"
                      :title="`复制完整提交号 ${c.sha}`"
                      :aria-label="`复制提交号 ${c.shortSha}`"
                      @click="onCopyCommitHash(c, $event)"
                    >{{ c.shortSha }}</button>
                    · {{ relativeTime(c.date) }}
                  </span>
                </button>
                <Transition name="branch-commit-row" appear>
                  <div
                    v-if="commitsExpanded.has(c.sha)"
                    :id="`commit-detail-${c.sha}`"
                    class="branch-commit-row__detail"
                  >
                    <!--
                      v1.1.3 · task #30 · detail-body 内部可滚容器
                      - 父 li 有 overflow:hidden 防止圆角溢出 → 长内容会被裁
                      - 这里给 detail-body max-height + overflow-y:auto 让长 commit（30+ 文件）完整可达
                      - 关联卡片 / 文件清单都进 body 参与滚动；actions 区留在外面 → 永远可见
                    -->
                    <div class="branch-commit-row__detail-body">
                      <pre class="branch-commit-row__fullmsg">{{ c.message }}</pre>
                      <!-- v1.1.3 · task #23 · 单条 commit 详情：文件清单（展开时按需拉） -->
                      <div
                        v-if="commitDetails.get(c.sha)?.files"
                        class="branch-commit-row__files"
                      >
                        <p class="branch-commit-row__files-summary">
                          共修改 {{ commitDetails.get(c.sha).files.length }} 个文件<span
                            v-if="filesHasNonBinary(commitDetails.get(c.sha).files)"
                          >，包含 <span class="branch-commit-row__files-add">+{{ totalAdditions(commitDetails.get(c.sha).files) }}</span> 行新增 和 <span class="branch-commit-row__files-del">-{{ totalDeletions(commitDetails.get(c.sha).files) }}</span> 行删除</span>
                        </p>
                        <ul class="branch-commit-row__files-list">
                          <li
                            v-for="f in commitDetails.get(c.sha).files"
                            :key="(f.previousFilename ?? f.filename) + '|' + (f.status ?? '')"
                            class="branch-commit-row__file"
                            :class="{ 'branch-commit-row__file--binary': f.binary }"
                          >
                            <span class="branch-commit-row__file-name" :title="f.filename">
                              <span v-if="f.status === 'renamed' && f.previousFilename" class="branch-commit-row__file-rename">
                                {{ f.previousFilename }} → {{ f.filename }}
                              </span>
                              <span v-else>{{ f.filename }}</span>
                            </span>
                            <span v-if="!f.binary" class="branch-commit-row__file-stats">
                              <span class="branch-commit-row__files-add">+{{ f.additions ?? 0 }}</span>
                              <span class="branch-commit-row__files-del">-{{ f.deletions ?? 0 }}</span>
                            </span>
                            <span v-else class="branch-commit-row__file-tag">二进制</span>
                            <span
                              v-if="f.functions && f.functions.length"
                              class="branch-commit-row__file-funcs"
                            >
                              <span
                                v-for="fn in f.functions"
                                :key="fn"
                                class="branch-commit-row__file-func"
                                :title="fn"
                              >{{ fn }}</span>
                            </span>
                          </li>
                        </ul>
                      </div>
                      <p
                        v-else-if="loadingCommitDetails.has(c.sha)"
                        class="branch-commit-row__files-loading muted text-xs"
                      >正在加载文件清单…</p>
                      <p v-if="c.linkedCards && c.linkedCards.length" class="branch-commit-row__cards muted text-xs">
                        关联卡片：{{ c.linkedCards.map((lc) => lc.columnName).join('、') }}
                      </p>
                    </div>
                    <!-- actions 区留在 detail-body 外 —— 永远可见，固定在 detail 底部 -->
                    <div class="branch-commit-row__actions">
                      <button
                        type="button"
                        class="branches__chip"
                        :title="`复制完整提交号 ${c.sha}`"
                        @click="onCopyCommitHash(c, $event)"
                      >
                        <Clipboard :size="13" :stroke-width="2" aria-hidden="true" />
                        <span>复制完整提交号</span>
                      </button>
                      <button
                        type="button"
                        class="branches__chip"
                        :title="`在 gitea 打开此提交 ${c.shortSha}`"
                        @click="onOpenCommitInGitea(c, $event)"
                      >
                        <ExternalLink :size="13" :stroke-width="2" aria-hidden="true" />
                        <span>在 gitea 打开</span>
                      </button>
                    </div>
                  </div>
                </Transition>
              </li>
            </ul>

            <p v-else-if="!commitsLoading" class="branches__commits-empty muted text-xs">
              这个分支还没有提交
            </p>

            <!-- 分页 -->
            <div v-if="commitsTotal > 30 || commitsPage > 1" class="branches__commits-pager">
              <button
                type="button"
                class="branches__chip"
                :disabled="commitsPage <= 1 || commitsLoading"
                @click="onPagePrev"
              >
                <span>上一页</span>
              </button>
              <span class="branches__commits-page muted text-xs">
                第 {{ commitsPage }} 页
              </span>
              <button
                type="button"
                class="branches__chip"
                :disabled="!commitsHasMore || commitsLoading"
                @click="onPageNext"
              >
                <span>下一页</span>
              </button>
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ==========================================================================
 * BranchesView —— 左 rail（240px 分支列表）+ 右主区（70%+ 详情 + commits）
 * 设计：tech-refine §4.5 + 03-frontend §4.3
 * 关键约束：长期 / 大工程 git 库分支 50+ 时，rail 始终可快速定位；
 *         主区 commits 列表占主区主要宽度，每行完整 message / hash / 时间
 * ========================================================================== */

.branches {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ===== 顶栏（沿用 v1） ===== */
.branches__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
  gap: var(--space-3);
}

.branches__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  min-width: 0;
}

.branches__title-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.branches__title-h1 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.branches__repo {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branches__topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.branches__counter {
  font-feature-settings: 'tnum';
}

.branches__refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
}

.branches__refresh:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

/* ===== 搜索 + 过滤 ===== */
.branches__filters {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.branches__search {
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

.branches__search-input {
  flex: 1;
  background: transparent;
  padding: 0;
  border: none;
}

.branches__search-input:focus {
  background: transparent;
  box-shadow: none;
}

.branches__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
}

.branches__toggle input {
  display: none;
}

.branches__toggle:has(input:checked) {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

/* ===== 错误条 ===== */
.branches__error {
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft);
  border-left: 3px solid var(--color-danger);
  font-size: var(--font-sm);
}

.branches__error-msg {
  color: var(--color-text);
  font-weight: 500;
  margin: 0 0 2px;
}

.branches__error-hint {
  color: var(--color-text-secondary);
  margin: 0;
}

/* ===== 主体：左 rail + 右主区 ===== */
.branches__body {
  flex: 1;
  display: flex;
  min-height: 0;
  /* 主体不滚动：rail 和 main 各自内部滚动 */
  overflow: hidden;
}

/* ===== 左侧 rail（240px 紧凑列） ===== */
.branches__rail {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
  border-right: 1px solid var(--color-divider);
}

.branches__rail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  text-align: center;
}

/* rail 内分支列表（一行一项 · 紧凑） */
.branches__list {
  flex: 1;
  list-style: none;
  margin: 0;
  padding: var(--space-2);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}

.branch-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border-left: 2px solid transparent;
  background: transparent;
  cursor: pointer;
  outline: none;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}

.branch-item:hover {
  background: var(--color-bg-hover);
}

.branch-item:focus-visible {
  background: var(--color-bg-hover);
  box-shadow: var(--shadow-focus);
}

.branch-item--default {
  border-left-color: var(--color-primary);
}

.branch-item--starred.branch-item--default {
  /* 收藏 + 默认：保留默认的 2px 左边条语义最强 */
}

.branch-item--starred:not(.branch-item--default) {
  border-left-color: var(--color-warning);
}

.branch-item--selected {
  background: var(--color-primary-soft);
  border-left-color: var(--color-primary);
}

.branch-item--selected.branch-item--default {
  border-left-color: var(--color-primary);
}

.branch-item__line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.branch-item__icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.branch-item__icon--default {
  color: var(--color-primary);
}

.branch-item__name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-item__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.branch-item__dot--protected {
  background: var(--color-warning);
  /* 5x5 圆点 + 受保护橙色 = 紧凑语义标记 */
}

.branch-item__dot--starred {
  background: var(--color-warning);
}

.branch-item__sub {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-xs);
  padding-left: 19px; /* 与 icon 13px + gap 6px 对齐 */
}

.branch-item__sha {
  color: var(--color-primary);
}

.branch-item__time {
  color: var(--color-text-muted);
}

/* ===== 右侧主区（占剩余 70%+ 宽度） ===== */
.branches__main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.branches__main-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
}

.branches__main-empty-icon {
  color: var(--color-text-dim);
}

.branches__main-empty-title {
  font-size: var(--font-md);
  color: var(--color-text-secondary);
  font-weight: 500;
}

.branches__main-empty-hint {
  color: var(--color-text-muted);
}

/* ===== 详情面板（占主区 100% 宽度 · 不再 320px 限制） ===== */
.branches__detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg-elevated);
  overflow: hidden;
}

.branches__detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.branches__detail-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex: 1;
  color: var(--color-text);
}

.branches__detail-name {
  font-size: var(--font-md);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branches__detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}

.branches__detail-head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.branches__detail-close {
  background: transparent;
  border: 1px solid var(--color-divider);
  color: var(--color-text-muted);
  padding: 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.branches__detail-close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
  border-color: var(--color-divider-strong);
}

.branches__tag {
  font-size: var(--font-xs);
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-weight: 500;
}

.branches__tag--default {
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.branches__tag--protected {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.branches__tag--starred {
  background: var(--color-bg);
  color: var(--color-warning);
  border: 1px solid var(--color-warning);
}

/* 详情 meta 区：左边"最后提交" + 右边 3 个 chip（复制 / 跳 gitea / 跳时间轴） */
.branches__detail-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.branches__detail-meta-commit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.branches__detail-commit-msg {
  font-size: var(--font-sm);
  color: var(--color-text);
  margin: 0;
  line-height: var(--line-base);
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.branches__detail-commit-sub {
  margin: 0;
}

.branches__detail-meta-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}

/* chip-style 按钮（复制 / 跳 gitea / 跳时间轴 / 收藏） */
.branches__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}

.branches__chip:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.branches__chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.branches__chip--starred {
  background: var(--color-primary-soft);
  color: var(--color-warning);
  border-color: var(--color-warning);
}

/* ===== commits 分页列表（主区核心内容 · 占主区主要空间） ===== */
.branches__commits-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
  overflow: hidden;
}

.branches__commits-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  flex-shrink: 0;
}

.branches__commits-title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.branches__commits-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.branches__commits-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.branch-commit-row {
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.branch-commit-row--expanded {
  border-color: var(--color-primary);
}

/*
 * 4 列 grid（主区 70%+ 宽度足够）：
 *   1) avatar 28px
 *   2) name + msg 双行（占 1fr）
 *   3) meta（hash + 相对时间，固定 200px）
 *   4) 折叠箭头（24px）
 */
.branch-commit-row__head {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 200px 24px;
  grid-template-areas:
    'avatar name meta  chevron'
    'avatar msg  meta  chevron';
  align-items: center;
  gap: 2px 10px;
  padding: 8px 12px;
  width: 100%;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
}

.branch-commit-row__head:hover {
  background: var(--color-bg-hover);
}

.branch-commit-row__head:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.branch-commit-row__avatar {
  grid-area: avatar;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.branch-commit-row__avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.branch-commit-row__avatar-fallback {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.branch-commit-row__name {
  grid-area: name;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-commit-row__msg {
  grid-area: msg;
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-commit-row__meta {
  grid-area: meta;
  font-size: var(--font-xs);
  white-space: nowrap;
  align-self: center;
  text-align: right;
  color: var(--color-text-muted);
}

.branch-commit-row__meta .mono {
  color: var(--color-primary);
}

.branch-commit-row__detail {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--color-divider);
  background: var(--color-bg-elevated);
}

/*
 * v1.1.3 · task #30 · detail 内部可滚容器
 * - 父 li（.branch-commit-row）有 overflow:hidden 防止圆角溢出
 *   → 长内容会被裁，所以 detail 内部必须自带可滚容器
 * - max-height 用 cqh 容器查询，60vh 兜底
 * - overscroll-behavior:contain 让长内容滚到底时不滚外层 commits list
 * - scrollbar-gutter:stable 滚动条出现时不抖动
 */
.branch-commit-row__detail-body {
  max-height: 60vh;
  max-height: 60cqh; /* container query 优先（外层 flex 列布局时 cqh 更准） */
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

/*
 * v1.1.3 · task #30 · 手风琴展开过渡
 * 用 grid-template-rows 0fr ↔ 1fr 技巧做 height 过渡（CSS 纯 native，无 JS 测量）
 * 兼容性：Chromium 117+ / Edge 117+ / Safari 17.4+ —— 项目锁 Electron ≥ Chromium 120
 *
 * 不用 transition: max-height 0→9999px 的原因：过渡时长会按 9999px 走，
 * 用户感觉"等 1s 还没展开完"。grid-rows 0fr→1fr 走的是实际内容高度，
 * 过渡时长匹配 --t-base。
 */
.branch-commit-row-enter-active,
.branch-commit-row-leave-active {
  display: grid;
  grid-template-rows: 0fr;
  transition:
    opacity var(--t-base) var(--ease),
    grid-template-rows var(--t-base) var(--ease);
}
.branch-commit-row-enter-from,
.branch-commit-row-leave-to {
  opacity: 0;
  grid-template-rows: 0fr;
}
.branch-commit-row-enter-to,
.branch-commit-row-leave-from {
  opacity: 1;
  grid-template-rows: 1fr;
}
/* grid 子项必须 min-height:0 + overflow:hidden 配合 0fr→1fr 真正裁出高度 */
.branch-commit-row-enter-active > .branch-commit-row__detail,
.branch-commit-row-leave-active > .branch-commit-row__detail {
  min-height: 0;
  overflow: hidden;
}

/* 行内短 hash 单独可点击复制（inline 按钮 · 跟 meta 一行 · hover 提示 + focus ring） */
.branch-commit-row__sha {
  font-family: var(--font-mono-stack);
  color: var(--color-primary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 2px;
  /* inline-block 让 button 自适应内容宽度，不影响 grid 布局 */
}

.branch-commit-row__sha:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary-hover);
}

.branch-commit-row__sha:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

/* 展开后底部操作区：复制 / 跳 gitea
 *
 * v1.1.3 · task #40 · 改 sticky bottom 防止长内容（30+ 文件）撑开 li 后
 * actions 被外层 commits-list 滚走遮挡。
 * - position: sticky; bottom: 0 + background = 始终贴 li 底（li 视口内）
 * - 配合 line 1479 `.branch-commit-row { overflow: hidden }`：sticky 边界 = li 边界
 *   → li 整体被外层 list 滚走时 actions 跟着滚走（避免"按钮悬空挂在视口上"）
 * - 顶部 box-shadow 当作"分隔线"（比 border-top + 自身背景更柔和）
 */
.branch-commit-row__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
  padding: 8px 4px 4px;
  position: sticky;
  bottom: 0;
  background: var(--color-bg-elevated);
  z-index: 2;
  box-shadow: 0 -1px 0 var(--color-divider);
}

.branch-commit-row__fullmsg {
  font-family: var(--font-mono-stack);
  font-size: var(--font-xs);
  color: var(--color-text);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: var(--line-base);
}

/* ============== v1.1.3 · task #23 · 单条 commit 文件清单 ============== */
.branch-commit-row__files {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--color-divider);
}
.branch-commit-row__files-summary {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0 0 6px;
  line-height: var(--line-base);
}
.branch-commit-row__files-add {
  color: var(--color-success, #16a34a);
  font-weight: 500;
  font-feature-settings: 'tnum';
}
.branch-commit-row__files-del {
  color: var(--color-danger, #dc2626);
  font-weight: 500;
  font-feature-settings: 'tnum';
}
.branch-commit-row__files-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.branch-commit-row__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  font-size: var(--font-xs);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  min-width: 0;
}
.branch-commit-row__file--binary {
  opacity: 0.85;
}
.branch-commit-row__file-name {
  flex: 0 1 auto;
  font-family: var(--font-mono-stack);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.branch-commit-row__file-rename {
  color: var(--color-text-muted);
}
.branch-commit-row__file-stats {
  display: inline-flex;
  gap: 6px;
  font-family: var(--font-mono-stack);
  font-feature-settings: 'tnum';
  flex: 0 0 auto;
}
.branch-commit-row__file-tag {
  padding: 1px 6px;
  font-size: 10px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-divider);
  flex: 0 0 auto;
}
.branch-commit-row__file-funcs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: auto;
  max-width: 60%;
  justify-content: flex-end;
}
.branch-commit-row__file-func {
  padding: 1px 6px;
  font-family: var(--font-mono-stack);
  font-size: 10px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border-radius: var(--radius-sm);
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.branch-commit-row__files-loading {
  margin: 6px 0 0;
  font-style: italic;
}

.branch-commit-row__cards {
  margin: 6px 0 0;
}

.branches__commits-empty {
  padding: var(--space-4) var(--space-2);
  text-align: center;
  color: var(--color-text-muted);
}

.branches__commits-error {
  padding: var(--space-3);
  background: var(--color-danger-soft);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  color: var(--color-text);
}

.branches__commits-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-3);
  margin-top: var(--space-2);
  border-top: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.branches__commits-page {
  font-feature-settings: 'tnum';
}

/* ===== 全局工具 ===== */
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spin-inline {
  display: inline-block;
  vertical-align: -2px;
  animation: spin 1s linear infinite;
}

/* ===== 响应式：1024 以下 rail 收 200，主区仍能展示完整 commits ===== */
@media (max-width: 1024px) {
  .branches__rail {
    width: 200px;
  }
  .branch-commit-row__head {
    grid-template-columns: 24px minmax(0, 1fr) 160px 20px;
  }
}

/* ===== 极小窗口（800 以下）：rail 收 160，commits 行隐藏 meta 仅留 hash ===== */
@media (max-width: 800px) {
  .branches__rail {
    width: 160px;
  }
  .branch-commit-row__head {
    grid-template-columns: 24px minmax(0, 1fr);
    grid-template-areas:
      'avatar name'
      'avatar msg';
  }
  .branch-commit-row__meta,
  .branches__chip { /* 极小窗口隐藏次要 chip，仅保留 3 个核心 */
    /* 略保留：由浏览器默认 overflow:hidden 处理 */
  }
}
</style>
