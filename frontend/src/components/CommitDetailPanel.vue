<script setup lang="ts">
/**
 * CommitDetailPanel —— Git Graph commit 详情面板（纯展示组件）
 *
 * 两种宿主：
 *   1. CommitDetailDialog（弹窗壳 + Teleport overlay）
 *   2. TimelineNewView（行下手风琴 inline 展开，固定 260px 高度上限 → 滚动条）
 *
 * props：
 *   - commit:     基础 commit 信息（来自 GraphNodeDto，秒开）
 *   - projectId:  懒加载 commitsGet 用的项目 ID
 *   - giteaRepoUrl: "在 Gitea 打开" 链接用
 *   - variant:    'panel'（默认，inline 用）| 'dialog'（弹窗内用，meta 间距更宽松）
 *
 * 数据加载策略：
 *   - module 级 detailCache（跨 CommitDetailPanel 实例共享，弹窗和手风琴互不重复请求）
 *   - watch(commit) 切 commit 时清 detail → 重新加载
 */

import { ref, watch, computed, onUnmounted } from 'vue';
import {
  Copy,
  ExternalLink,
  GitCommit,
  FileText,
  Plus,
  Minus,
  Link2,
} from 'lucide-vue-next';
import { commitsGet } from '@renderer/lib/ipc-client';
import { showToast } from '@renderer/lib/toast';
// Wails 运行时：BrowserOpenURL 在系统默认浏览器打开 URL（window.open 在 Wails
// WebView 下不可靠——v1 Electron 时代的 setWindowOpenHandler 拦截已不存在）。
import { BrowserOpenURL } from '../../wailsjs/wailsjs/runtime/runtime';

/** 基础 commit 信息（从 graph 数据直接传入，不需要额外请求） */
export interface BasicCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  authorName: string;
  authorEmail?: string;
  authorAvatar?: string;
  /** 引用（branch / remote / tag），v2.6 起直接从 GraphNodeDto 读 */
  refs?: string[];
  /** refs 对应类型（后端 GraphNodeDto.refTypes 是 string[]；运行时取 'branch' | 'remoteBranch' | 'tag'） */
  refTypes?: string[];
}

interface Props {
  commit: BasicCommit | null;
  /** 当前项目 ID（用于 commitsGet 请求）；不传则只显示基本信息不懒加载详情 */
  projectId?: string | null;
  /** 平台类型（用于"在 XXX 中打开"按钮的 tooltip + URL 模板；默认 gitea） */
  platform?: 'gitea' | 'github';
  /** Gitea / GitHub 仓库地址（用于 "在平台打开" 按钮）。
   *  字段名沿用 v2.0 时代的 giteaRepoUrl，实际承载的就是仓库 web URL（GitHub 也是同模板）。 */
  giteaRepoUrl?: string;
  /** 视觉变体：panel（inline 手风琴，紧凑）| dialog（弹窗内，宽松） */
  variant?: 'panel' | 'dialog';
}

const props = withDefaults(defineProps<Props>(), {
  projectId: null,
  platform: 'gitea',
  giteaRepoUrl: undefined,
  variant: 'panel',
});

// ===== 懒加载详情 =====
// 缓存放在 module 作用域 → 多个 CommitDetailPanel 实例共享（弹窗 + 手风琴不重复请求同一 SHA）
interface CommitDetail {
  message: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
  files?: Array<{
    filename: string;
    status?: string;
    additions?: number;
    deletions?: number;
    binary?: boolean;
    previousFilename?: string;
    functions?: string[];
  }>;
  linkedCards?: Array<{ cardId: string; columnName: string }>;
}
const detailCache = new Map<string, CommitDetail>();

const loading = ref(false);
const detail = ref<CommitDetail | null>(null);

/** 加载 commit 详情（带缓存）。失败回退到 subject 作为 message */
async function loadDetail(): Promise<void> {
  if (!props.commit) return;
  const sha = props.commit.sha;

  // 缓存命中
  const cached = detailCache.get(sha);
  if (cached) {
    detail.value = cached;
    return;
  }

  if (!props.projectId) {
    // 没传 projectId → 跳过懒加载，detail 留空（调用方决定是否显示 loading）
    detail.value = null;
    return;
  }

  loading.value = true;
  try {
    const dto = await commitsGet({ projectId: props.projectId, sha });
    const d: CommitDetail = {
      message: dto.message,
      additions: dto.additions,
      deletions: dto.deletions,
      filesChanged: dto.filesChanged,
      files: dto.files,
      linkedCards: dto.linkedCards,
    };
    detailCache.set(sha, d);
    detail.value = d;
  } catch {
    // 失败时用基本信息（subject 作为 message）
    const fallback: CommitDetail = {
      message: props.commit.subject,
    };
    detail.value = fallback;
  } finally {
    loading.value = false;
  }
}

// commit 切换 → 重新加载
watch(
  () => props.commit?.sha,
  async (_newSha, oldSha) => {
    if (!props.commit) {
      detail.value = null;
      return;
    }
    if (props.commit.sha === oldSha) return;
    detail.value = null;
    await loadDetail();
  },
  { immediate: true },
);

// ===== 辅助 =====
function formatFullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
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

async function copySha(): Promise<void> {
  if (!props.commit) return;
  try {
    await navigator.clipboard.writeText(props.commit.sha);
    showToast({ type: 'success', message: '已复制 SHA' });
  } catch {
    showToast({ type: 'error', message: '复制失败' });
  }
}

function openInPlatform(): void {
  if (!props.commit || !props.giteaRepoUrl) return;
  // GitHub / Gitea 的仓库 web URL 模板一致（${hostUrl}/${owner}/${repo}），
  // commit 子路径也都是 /commit/{sha}，所以无需按平台分支拼接。
  const url = `${props.giteaRepoUrl.replace(/\/$/, '')}/commit/${props.commit.sha}`;
  // v2: 必须用 Wails BrowserOpenURL 打开系统浏览器；window.open 在 Wails WebView
  // 下不会打开系统浏览器（之前两次修了 URL 拼接但没动打开方式，所以点了没反应）。
  BrowserOpenURL(url);
}

/** "在平台打开" 按钮的 tooltip 文案 —— 按 platform 切换 */
const openInPlatformTooltip = computed(() =>
  props.platform === 'github' ? '在 GitHub 中打开' : '在 Gitea 中打开',
);

/**
 * v3.7：文件名状态颜色类（复刻 vscode main.ts:598-606 .gitFileName.A/M/D）
 * - A (added)   绿：新增文件
 * - M (modified)黄：修改文件（vscode modified 用 editor.foreground 继承）
 * - D (deleted) 红：删除文件
 * - R (renamed) 蓝：重命名文件
 * - B (binary)  灰：二进制文件
 */
function fileNameClass(status?: string): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'cd-file-name--A';
    case 'deleted':
      return 'cd-file-name--D';
    case 'renamed':
      return 'cd-file-name--R';
    case 'binary':
      return 'cd-file-name--B';
    case 'modified':
    default:
      return 'cd-file-name--M';
  }
}

/** v3.7：复制文件路径（vscode main.ts:2926 triggerCopyFilePath） */
async function copyFilePath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    showToast({ type: 'success', message: '已复制文件路径' });
  } catch {
    showToast({ type: 'error', message: '复制失败' });
  }
}

/** v3.7：点击文件行（目前 placeholder；后期可扩展"在平台打开文件"等功能） */
function handleFileClick(_file: CommitDetail['files'] extends Array<infer T> ? T : never): void {
  // vscode main.ts:2960 triggerOpenFile —— 当前先留空
}

/**
 * v2.55：路径前缀缩写 —— 超长 file path 中间省略，首段 + ... + 末段文件名
 *
 * 目的：长路径如 `src/foo/bar/very/very/long/path/Component.tsx`
 *       → `src/.../Component.tsx`（保留首段让用户看出位置，保留文件名最关键信息）
 *       末尾省略（CSS text-overflow: ellipsis）会让文件名被切，不友好。
 *
 * 策略：
 *   - 段数 ≤ 2：原样返回（dir/file 短，不需要缩）
 *   - 段数 ≥ 3：保留第一段 + `/.../` + 最后一段（文件名）
 *   - 总长度阈值 60：超过才缩写，避免短路径被强行加 ...
 *
 * @param path 完整文件路径（用 / 分隔；Windows 路径也按 / 处理，组件 UI 不展示 Win 路径）
 * @param maxLen 触发缩写的最小长度（默认 60 字符）
 * @returns 缩写后的路径（或原样）
 */
function shortenPathMiddle(path: string, maxLen = 60): string {
  if (!path || path.length <= maxLen) return path;
  const segments = path.split('/').filter((s) => s.length > 0);
  // 只有 1-2 段（根目录文件或单层目录）：保留首段 + /.../ + 文件名（如果有）
  if (segments.length <= 1) return path;
  if (segments.length === 2) {
    // dir/file：首段可能也很长，但用户能看到完整结构，保留原样让 CSS 末尾 ellipsis
    return path;
  }
  // 段数 ≥ 3：首段 + `/.../` + 最后一段（文件名）
  const first = segments[0];
  const last = segments[segments.length - 1];
  return `${first}/.../${last}`;
}

/** 多行 message 拆分：第一行是标题，其余是正文 */
const messageTitle = computed(() => {
  const msg = detail.value?.message ?? props.commit?.subject ?? '';
  return msg.split('\n')[0]?.trim() ?? '';
});
const messageBody = computed(() => {
  const msg = detail.value?.message ?? '';
  const lines = msg.split('\n');
  // 跳过第一行 + 紧跟的空行
  let start = 1;
  while (start < lines.length && !lines[start]?.trim()) start++;
  return lines.slice(start).join('\n').trim();
});

/** refs 类型 → badge 类名（与 TimelineNewView 中的 refBadgeClass 保持一致） */
function refBadgeClass(refType?: string): string {
  switch (refType) {
    case 'tag':
      return 'cd-ref-badge--tag';
    case 'remoteBranch':
      return 'cd-ref-badge--remote';
    case 'branch':
    default:
      return 'cd-ref-badge--branch';
  }
}

// 弹窗内用：监听 Esc（Teleport 到 body 后需要手动捕获）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.variant === 'dialog') {
    e.preventDefault();
    // 由父组件（dialog 壳）负责关闭；这里只阻止默认行为
  }
}
if (typeof document !== 'undefined') {
  // 仅 dialog 变体需要监听；panel 变体在 TimelineNewView 自行处理
  watch(
    () => props.variant,
    (v) => {
      if (v === 'dialog') {
        document.addEventListener('keydown', onGlobalKeydown);
      } else {
        document.removeEventListener('keydown', onGlobalKeydown);
      }
    },
    { immediate: true },
  );
  onUnmounted(() => {
    document.removeEventListener('keydown', onGlobalKeydown);
  });
}

/**
 * v2.41：拦截左/右栏 wheel 事件的滚动穿透。
 *
 * 问题：commit-row 展开后，左栏（commit message + meta）/ 右栏（files）滚到底时，
 *   滚轮事件会穿透到外层 .timeline-new__main，带动整个 commit log 滚动。
 *   overscroll-behavior: contain 在部分 WebView 引擎下支持不完整。
 *
 * 方案：在 panel 变体的左/右栏上拦截 wheel 事件——仅在滚到顶/底边界时
 *   preventDefault() 阻止穿透；中间正常滚动不拦截；容器无溢出时不拦截
 *   （让外层 commit log 正常滚动，与右栏文件列表行为一致）。
 *
 * dialog 变体不需要（弹窗 overlay 本身隔离滚动）。
 */
function onPanelWheel(e: WheelEvent, el: HTMLElement): void {
  const { scrollTop, scrollHeight, clientHeight } = el;
  const maxScroll = scrollHeight - clientHeight;
  // 容器无可滚动空间 → 不拦截，让外层正常滚动
  if (maxScroll <= 0) return;
  const delta = e.deltaY;
  // 滚到底（向下）→ 拦截；滚到顶（向上）→ 拦截
  if ((delta > 0 && scrollTop >= maxScroll) || (delta < 0 && scrollTop <= 0)) {
    e.preventDefault();
  }
}
</script>

<template>
  <div v-if="props.commit" class="cd-panel" :class="`cd-panel--${props.variant}`">
    <!-- 标题栏（短 SHA + 完整日期 + 复制 / 在 Gitea 打开）—— 跨整宽 -->
    <header class="cd-panel__header">
      <div class="cd-panel__header-left">
        <GitCommit :size="14" class="cd-panel__icon" />
        <code class="cd-sha mono">{{ props.commit.shortSha }}</code>
        <span class="cd-date">{{ formatFullDate(props.commit.date) }}</span>
      </div>
      <div class="cd-panel__header-right">
        <button
          type="button"
          class="cd-icon-btn"
          title="复制完整 SHA"
          @click="copySha"
        >
          <Copy :size="13" />
        </button>
        <button
          v-if="props.giteaRepoUrl"
          type="button"
          class="cd-icon-btn"
          :title="openInPlatformTooltip"
          @click="openInPlatform"
        >
          <ExternalLink :size="13" />
        </button>
      </div>
    </header>

    <!-- v2.12：手风琴双栏布局 —— 左 4 (commit message + meta) | 右 6 (files + cards)
         复刻 vscode git graph：左右各独立纵向滚动，互不干扰
         dialog 变体保留单列垂直流（弹窗宽屏更适合纵向堆叠）-->
    <div v-if="props.variant === 'panel'" class="cd-panel__body">
      <!-- 左 4/10：commit message + meta -->
      <div class="cd-panel__left" @wheel="onPanelWheel($event, $event.currentTarget as HTMLElement)">
        <div class="cd-panel__message">
          <!-- v3.7：紧凑 inline meta 行贴在 message title 下方（合并 message+meta，节省空间）
               格式：👤 author &lt;email&gt;  +5 -2  #files  [branch tag]
               无数据时整行不渲染 -->
          <div v-if="props.commit.authorName || detail?.additions != null || props.commit.refs?.length" class="cd-message-meta">
            <span v-if="props.commit.authorName" class="cdm-author">
              <span
                class="cd-avatar-fallback"
                :class="`cd-flow-${(props.commit.authorName.charCodeAt(0) || 0) % 16}`"
                aria-hidden="true"
              >{{ props.commit.authorName.trim().charAt(0).toUpperCase() || '?' }}</span>
              {{ props.commit.authorName }}
              <span v-if="props.commit.authorEmail" class="cdm-email">
                &lt;{{ props.commit.authorEmail }}&gt;
              </span>
            </span>
            <span
              v-if="detail && (detail.additions != null || detail.deletions != null)"
              class="cdm-stats"
            >
              <span v-if="detail.additions != null" class="cdm-add">+{{ detail.additions }}</span>
              <span v-if="detail.deletions != null" class="cdm-del">-{{ detail.deletions }}</span>
              <span v-if="detail.filesChanged != null" class="cdm-files">{{ detail.filesChanged }} 个文件</span>
            </span>
            <span v-if="props.commit.refs && props.commit.refs.length > 0" class="cdm-refs">
              <span
                v-for="(ref, idx) in props.commit.refs"
                :key="`cd-ref-${idx}-${ref}`"
                class="cd-ref-badge"
                :class="refBadgeClass(props.commit.refTypes?.[idx])"
                :title="ref"
              >
                {{ ref }}
              </span>
            </span>
          </div>
          <div class="cd-message__title">{{ messageTitle }}</div>
          <pre v-if="messageBody" class="cd-message__body">{{ messageBody }}</pre>
          <div v-if="loading" class="cd-loading">加载详情中…</div>
        </div>
      </div>

      <!-- 右 6/10：files + cards
           v1.8：右栏内部结构 ——
             cd-files（标题 + 独立滚动区 + 卡片列表）
             cd-files__scroll（flex:1 + overflow-y:auto，独立接管 files 列表滚动）
             cd-cards（始终可见）
           这样右栏总高度 = min(内容自然高度, 父容器 260px - header)，
           files 列表很长时只在 .cd-files__scroll 内部出滚动条，
           cards 始终贴底可见，不会被 files 列表挤出右栏。-->
      <div class="cd-panel__right" @wheel="onPanelWheel($event, $event.currentTarget as HTMLElement)">
        <div v-if="detail?.files && detail.files.length > 0" class="cd-files">
          <div class="cd-section-title">
            <FileText :size="13" />
            文件变更（{{ detail.files.length }}）
          </div>
          <div class="cd-files__scroll">
            <div class="cd-files__list">
            <div
              v-for="f in detail.files"
              :key="f.filename"
              class="cd-file-record"
              :title="f.filename"
            >
              <span class="cd-file" @click.stop="handleFileClick(f)">
                <!-- 文件图标 -->
                <svg class="cd-file-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="14" viewBox="0 0 30 30" aria-hidden="true">
                  <path d="M24.707,8.793l-6.5-6.5C18.019,2.105,17.765,2,17.5,2H7C5.895,2,5,2.895,5,4v22c0,1.105,0.895,2,2,2h16c1.105,0,2-0.895,2-2V9.5C25,9.235,24.895,8.981,24.707,8.793z M18,10c-0.552,0-1-0.448-1-1V3.904L23.096,10H18z"/>
                </svg>
                <!-- 文件名 + (±N | -N)：合并到同一带状态色的 span，截断发生在文件名区域 -->
                <span class="cd-file-name mono" :class="fileNameClass(f.status)">
                  <span class="cd-file-basename">{{ shortenPathMiddle(f.filename) }}</span>
                  <span v-if="!f.binary" class="cd-file-adddel">
                    <span v-if="f.additions != null && f.deletions != null">
                      +{{ f.additions }}&nbsp;<span class="cdm-del">-{{ f.deletions }}</span>
                    </span>
                    <span v-else-if="f.additions != null">+{{ f.additions }}</span>
                    <span v-else-if="f.deletions != null" class="cd-file-del-only">-{{ f.deletions }}</span>
                  </span>
                  <span v-if="f.binary" class="cd-file-binary">二进制</span>
                </span>
                <!-- hover 复制按钮 -->
                <span class="cd-file-actions">
                  <button type="button" class="cd-file-action" title="复制文件路径" @click.stop="copyFilePath(f.filename)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
                      <path fill-rule="evenodd" d="M2 13h4v1H2v-1zm5-6H2v1h5V7zm2 3V8l-3 3 3 3v-2h5v-2H9zM4.5 9H2v1h2.5V9zM2 12h2.5v-1H2v1zm9 1h1v2c-.02.28-.11.52-.3.7-.19.18-.42.28-.7.3H1c-.55 0-1-.45-1-1V4c0-.55.45-1 1-1h3c0-1.11.89-2 2-2 1.11 0 2 .89 2 2h3c.55 0 1 .45 1 1v5h-1V6H1v9h10v-2zM2 5h8c0-.55-.45-1-1-1H8c-.55 0-1-.45-1-1s-.45-1-1-1-1 .45-1 1-.45 1-1 1H3c-.55 0-1 .45-1 1z"/>
                    </svg>
                  </button>
                </span>
              </span>
            </div>
            </div>
          </div>
        </div>

        <div v-if="detail?.linkedCards && detail.linkedCards.length > 0" class="cd-cards">
          <div class="cd-section-title">
            <Link2 :size="13" />
            关联卡片（{{ detail.linkedCards.length }}）
          </div>
          <div class="cd-cards__list">
            <span v-for="card in detail.linkedCards" :key="card.cardId" class="cd-card-chip">
              {{ card.cardId }}
              <span v-if="card.columnName" class="cd-card-col">{{ card.columnName }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- dialog 变体：单列垂直流（弹窗宽屏适合纵向堆叠）-->
    <template v-else>
      <!-- 提交信息 -->
      <div class="cd-panel__message">
        <div class="cd-message__title">{{ messageTitle }}</div>
        <pre v-if="messageBody" class="cd-message__body">{{ messageBody }}</pre>
      </div>

      <!-- 作者 / 统计 / 引用 -->
      <div class="cd-panel__meta">
        <div class="cd-meta__row">
          <span class="cd-meta__label">作者</span>
          <div class="cd-meta__value">
            <span
              class="cd-avatar-fallback"
              :class="`cd-flow-${(props.commit.authorName.charCodeAt(0) || 0) % 16}`"
              aria-hidden="true"
            >{{ props.commit.authorName.trim().charAt(0).toUpperCase() || '?' }}</span>
            <span>{{ props.commit.authorName }}</span>
            <span v-if="props.commit.authorEmail" class="cd-meta__email mono">
              &lt;{{ props.commit.authorEmail }}&gt;
            </span>
          </div>
        </div>
        <!-- 统计行（dialog 变体保留独立行，更宽松间距） -->
        <div
          v-if="detail && (detail.additions != null || detail.deletions != null)"
          class="cd-meta__row"
        >
          <span class="cd-meta__label">统计</span>
          <div class="cd-meta__value cd-stats">
            <span v-if="detail.additions != null" class="cd-stats__add">
              <Plus :size="12" />{{ detail.additions }}
            </span>
            <span v-if="detail.deletions != null" class="cd-stats__del">
              <Minus :size="12" />{{ detail.deletions }}
            </span>
            <span v-if="detail.filesChanged != null" class="cd-stats__files">
              <FileText :size="12" />{{ detail.filesChanged }} 个文件
            </span>
          </div>
        </div>
        <div
          v-if="props.commit.refs && props.commit.refs.length > 0"
          class="cd-meta__row"
        >
          <span class="cd-meta__label">引用</span>
          <div class="cd-meta__value cd-refs">
            <span
              v-for="(ref, idx) in props.commit.refs"
              :key="`cd-ref-${idx}-${ref}`"
              class="cd-ref-badge"
              :class="refBadgeClass(props.commit.refTypes?.[idx])"
              :title="ref"
            >
              {{ ref }}
            </span>
          </div>
        </div>
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="cd-loading">加载详情中…</div>

      <!-- 文件变更列表 -->
      <div v-if="detail?.files && detail.files.length > 0" class="cd-files">
        <div class="cd-section-title">
          <FileText :size="13" />
          文件变更（{{ detail.files.length }}）
        </div>
        <div class="cd-files__list">
          <div
            v-for="f in detail.files"
            :key="f.filename"
            class="cd-file-record"
            :title="f.filename"
          >
            <span class="cd-file" @click.stop="handleFileClick(f)">
              <!-- 文件图标 -->
              <svg class="cd-file-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="14" viewBox="0 0 30 30" aria-hidden="true">
                <path d="M24.707,8.793l-6.5-6.5C18.019,2.105,17.765,2,17.5,2H7C5.895,2,5,2.895,5,4v22c0,1.105,0.895,2,2,2h16c1.105,0,2-0.895,2-2V9.5C25,9.235,24.895,8.981,24.707,8.793z M18,10c-0.552,0-1-0.448-1-1V3.904L23.096,10H18z"/>
              </svg>
              <!-- 文件名 + (±N | -N)：合并到同一带状态色的 span，截断发生在文件名区域 -->
              <span class="cd-file-name mono" :class="fileNameClass(f.status)">
                <span class="cd-file-basename">{{ shortenPathMiddle(f.filename) }}</span>
                <span v-if="!f.binary" class="cd-file-adddel">
                  <span v-if="f.additions != null && f.deletions != null">
                    +{{ f.additions }}&nbsp;<span class="cdm-del">-{{ f.deletions }}</span>
                  </span>
                  <span v-else-if="f.additions != null">+{{ f.additions }}</span>
                  <span v-else-if="f.deletions != null" class="cd-file-del-only">-{{ f.deletions }}</span>
                </span>
                <span v-if="f.binary" class="cd-file-binary">二进制</span>
              </span>
              <!-- hover 复制按钮 -->
              <span class="cd-file-actions">
                <button type="button" class="cd-file-action" title="复制文件路径" @click.stop="copyFilePath(f.filename)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
                    <path fill-rule="evenodd" d="M2 13h4v1H2v-1zm5-6H2v1h5V7zm2 3V8l-3 3 3 3v-2h5v-2H9zM4.5 9H2v1h2.5V9zM2 12h2.5v-1H2v1zm9 1h1v2c-.02.28-.11.52-.3.7-.19.18-.42.28-.7.3H1c-.55 0-1-.45-1-1V4c0-.55.45-1 1-1h3c0-1.11.89-2 2-2 1.11 0 2 .89 2 2h3c.55 0 1 .45 1 1v5h-1V6H1v9h10v-2zM2 5h8c0-.55-.45-1-1-1H8c-.55 0-1-.45-1-1s-.45-1-1-1-1 .45-1 1-.45 1-1 1H3c-.55 0-1 .45-1 1z"/>
                  </svg>
                </button>
              </span>
            </span>
          </div>
        </div>
      </div>

      <!-- 关联看板卡片 -->
      <div v-if="detail?.linkedCards && detail.linkedCards.length > 0" class="cd-cards">
        <div class="cd-section-title">
          <Link2 :size="13" />
          关联卡片（{{ detail.linkedCards.length }}）
        </div>
        <div class="cd-cards__list">
          <span v-for="card in detail.linkedCards" :key="card.cardId" class="cd-card-chip">
            {{ card.cardId }}
            <span v-if="card.columnName" class="cd-card-col">{{ card.columnName }}</span>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ===== Panel 根容器 ===== */
.cd-panel {
  display: flex;
  flex-direction: column;
  color: var(--color-text);
  font-size: var(--font-sm, 13px);
  /* dialog 变体：从弹窗壳继承背景；panel 变体：透明（继承手风琴卡片底色） */
}

/* panel 变体（inline 手风琴）：
 *   - v3.7：改 flex: 1 1 auto → display: block
 *     之前 flex:1 撑满 accordion 容器（=300px），导致 cd-panel__left/right 强制撑到容器高度，
 *     内容 < 容器时空滚动条出现。现在 accordion 自己 max-height + overflow: auto 控制滚动，
 *     panel 用 block 让内容自然撑高。*/
.cd-panel--panel {
  background: transparent;
  border-top: none;
  padding: 0;
  display: block;
  min-height: 0;
}

/* dialog 变体：弹窗内，padding 更宽松 */
.cd-panel--dialog {
  padding: 0;
}

/* ===== Header ===== */
.cd-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2, 8px) var(--space-3, 12px);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elevated, rgba(255, 255, 255, 0.03));
  position: sticky;
  top: 0;
  z-index: 1;
  /* v1.8 bugfix：panel flex column 里 header 必须 flex-shrink:0，
   * 否则会被压缩到 0 高度，body 拿不到准确可用高度，
   * 260px max-height 容器 + body 内容 > 容器时滚动行为失准。*/
  flex-shrink: 0;
}
.cd-panel--panel .cd-panel__header {
  padding: 6px var(--space-3, 12px);
}

/* ===== v2.12 双栏布局（panel 变体专用）=====
 * 复刻 vscode git graph：左 4 (commit meta + message) | 右 6 (files + cards)
 * 左右各自独立纵向滚动（各自 overflow-y: auto），互不干扰。
 * 父容器（手风琴卡片）max-height: 260px 减去 header 高度 ~32px ≈ 228px 是 body 高度上限。
 * min-height: 0 是关键 —— 否则 grid 子元素无法收缩，会撑爆 228px。
 *
 * v2.0 横向滚动策略：
 * - body 用 display: grid (4fr 6fr)，子项各自 overflow-x: auto（继承自 .cd-panel__left/right）
 * - 长 message body 用 <pre> 渲染，自身 white-space: pre-wrap 不应横向溢出；
 *   万一溢出由 .cd-panel__left 的 overflow-x: auto 出横向滚动条
 * - 长 file name 用 text-overflow: ellipsis 截断；超出 .cd-files__scroll 的 overflow-x: auto 出横向滚动
 * - body 自身 overflow: hidden（高度方向）+ 不限制横向（让 4fr 6fr grid 子项自然撑满 body 宽度）
 *
 * 不要把 body 设成 overflow-x: auto —— body 是 grid 容器，它的 overflow-x: auto 会让
 * 左右栏的滚动条互相干扰（一个滚动另一个跟动）。横向滚动交给左右栏各自处理。*/
.cd-panel__body {
  display: grid;
  grid-template-columns: 5fr 5fr;
  /* v3.7：去掉 flex: 1 —— parent (.cd-panel--panel) 现在是 block，flex:1 无效
   * accordion 自身 max-height + overflow: auto 负责整体滚动
   * 之前 max-height:300px + overflow:hidden 时靠 .cd-panel__left/right 各自滚动 */
  min-height: 0;
  min-width: 0; /* v2.0：grid 容器允许子项收缩 */
  /* v3.7：去掉 overflow: hidden —— accordion 自己滚，body 不再裁剪 */
  /* 4:6 之间的纵向分隔线 */
  border-top: 1px solid var(--color-divider);
}
.cd-panel__left {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0; /* v2.0：允许 grid 子项收缩到内容自然宽度以下 */
  /* v2.0 → v3.7：改为纵向滚动限死。*/
  overflow-y: auto;
  overflow-x: hidden; /* 防止任何横向滚动，内容在 min-width:0 的 message 区自动换行 */
  /* v2.34：滚动到底后阻止滚轮事件穿透到外层 .commit-accordion / .timeline-new__main。
   * overscroll-behavior: contain 把滚动链限定在本容器内 —— 用户滚到底时
   * 不再"意外"滚动外层 commit log 或主区，体验与 VSCode Git Graph 一致 */
  overscroll-behavior: contain;
  border-right: 1px solid var(--color-divider);
  /* 滚动条样式 */
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}
.cd-panel__right {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0; /* v2.0：同上 */
  /* v3.8：overflow-x: hidden —— 让 .cd-file-name 的 text-overflow:ellipsis 生效。
   * overflow-x:visible 时 ellipsis 不显示（MDN spec）；vscode #cdvFiles li 也是 overflow-x:hidden。*/
  overflow-y: auto;
  overflow-x: hidden;
  /* v2.34：同上，左/右栏滚到底后阻止滚动事件穿透外层（修复 files 列表滚到底后
   * 带动整个 commit log / 主区滚动的错误体验） */
  overscroll-behavior: contain;
  /* 滚动条样式 */
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}
.cd-panel__left::-webkit-scrollbar,
.cd-panel__right::-webkit-scrollbar {
  width: 8px;
}
.cd-panel__left::-webkit-scrollbar-track,
.cd-panel__right::-webkit-scrollbar-track {
  background: transparent;
}
.cd-panel__left::-webkit-scrollbar-thumb,
.cd-panel__right::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 4px;
}
.cd-panel__left::-webkit-scrollbar-thumb:hover,
.cd-panel__right::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}
/* panel 变体：message 区占满左栏剩余空间（flex:1），body 内部滚动
 * v3.7 重构：
 * - .cd-panel__message：flex-shrink:0，内容自然撑高不压缩，
 *   flex:1 让 message 区填满 .cd-panel__left 剩余空间
 * - .cd-message__body：flex:1 + min-height:0 + overflow-y:auto，
 *   body 填满 message 区余下空间，超出时 body 自身滚动（不是 message 区滚动）
 * - 标题固定不滚，body 内容滚动 —— 跟 vscode cdvSummary 一致 */
.cd-panel--panel .cd-panel__message {
  border-bottom: none;
  flex-shrink: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* v3.8：去掉 overflow:hidden —— 让 message title 自然换行显示，
   * 换行后 title 可能超出左栏高度，由 .cd-panel__left 自身 overflow-y:auto 滚动接管。
   * vscode cdvSummary 的 message 区域也没有 overflow 裁剪。 */
}
.cd-panel--panel .cd-panel__meta {
  border-bottom: none;
  flex-shrink: 0;
  min-height: 0;
}
.cd-panel--panel .cd-files {
  border-bottom: none;
  flex-shrink: 0;
}
.cd-panel--panel .cd-cards {
  border-bottom: none;
  flex-shrink: 0;
}
.cd-panel--panel .cd-message__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* v3.8：限制 body 最大高度 —— 超出时 body 自身滚动，不把左栏撑爆。
   * 150px 给多行 commit message 留足阅读空间；单行消息不受影响。*/
  max-height: 150px;
}
.cd-panel__header-left {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.cd-panel__icon {
  color: var(--color-primary);
  flex-shrink: 0;
}
.cd-sha {
  font-size: 12px;
  color: var(--color-primary);
  font-weight: 600;
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.1));
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.cd-date {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cd-panel__header-right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.cd-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.cd-icon-btn:hover {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text);
}

/* ===== Message ===== */
.cd-panel__message {
  padding: var(--space-2, 8px) var(--space-3, 12px);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  /* 关键：overflow:hidden 让 flex column 约束子元素宽度，
   * 配合 min-width:0，让 title 在 grid 列宽内被强制压缩换行。*/
  min-width: 0;
  overflow: hidden;
}
.cd-panel--dialog .cd-panel__message {
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
.cd-message__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.4;
  /* break-word: 在自然断点（空格）处优先换行，必要时才强制断字
   * break-all: 无视词义强行断字（适合路径 / URL / 无空格长串）
   * 用 break-word 优先自然换行，仅对"fix: update webui/src/components/..."这种
   * 有空格但行尾仍放不下的场景强制在空格后换行，保持可读性。*/
  word-break: break-word;
  overflow-wrap: anywhere;
  /* overflow:hidden 在父级 .cd-panel__message，title 在此约束内必须换行 */
}
.cd-panel--dialog .cd-message__title {
  font-size: var(--font-md, 14px);
}
.cd-message__body {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  font-family: inherit;
  max-height: 120px;
  overflow-y: auto;
}

/* v3.7：紧凑 inline meta（panel 变体专用，替代 .cd-panel__meta 独立区块）
 * 合并到 .cd-panel__message 内，无独立 border/padding。
 * 格式：👤 author <email>  +5 -2  #files  [branch tag]
 * flex-wrap 让各组自然折行，节省纵向空间。*/
.cd-message-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
  line-height: 1.4;
}
.cdm-author {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.cdm-email {
  font-size: 10px;
  word-break: break-all;
  white-space: normal;
}
.cdm-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.cdm-add {
  color: var(--color-success, #7db233);
  font-weight: 500;
}
.cdm-del {
  color: var(--color-danger, #dc2626);
  font-weight: 500;
}
.cdm-files {
  color: var(--color-text-secondary);
}
.cdm-refs {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
}

/* ===== Meta ===== */
/* v3.7：panel 变体不再有独立 .cd-panel__meta 区块，内容合并到 .cd-message-meta。
 * dialog 变体保留独立区块（弹窗空间充足）。*/
.cd-panel__meta {
  display: none;
}
.cd-panel--dialog .cd-panel__meta {
  display: flex;
  flex-direction: column;
  padding: 6px var(--space-3, 12px);
  gap: 4px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.cd-meta__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2, 8px);
  flex-shrink: 0;
}
.cd-meta__label {
  flex: 0 0 36px;
  font-size: 10px;
  color: var(--color-text-muted);
  text-align: right;
  flex-shrink: 0;
}
.cd-panel--dialog .cd-meta__label {
  flex: 0 0 48px;
  font-size: 11px;
}
.cd-meta__value {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text);
  min-width: 0;
  flex: 1;
  flex-wrap: wrap;
  overflow: visible;
}
.cd-meta__email {
  font-size: 10px;
  color: var(--color-text-muted);
  word-break: break-all;
  white-space: normal;
}
.cd-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  line-height: 1;
}
.cd-panel--dialog .cd-avatar-fallback {
  width: 20px;
  height: 20px;
  font-size: 10px;
}
.cd-flow-0 { background-color: var(--color-series-16-0); }
.cd-flow-1 { background-color: var(--color-series-16-1); }
.cd-flow-2 { background-color: var(--color-series-16-2); }
.cd-flow-3 { background-color: var(--color-series-16-3); }
.cd-flow-4 { background-color: var(--color-series-16-4); }
.cd-flow-5 { background-color: var(--color-series-16-5); }
.cd-flow-6 { background-color: var(--color-series-16-6); }
.cd-flow-7 { background-color: var(--color-series-16-7); }
.cd-flow-8 { background-color: var(--color-series-16-8); }
.cd-flow-9 { background-color: var(--color-series-16-9); }
.cd-flow-10 { background-color: var(--color-series-16-10); }
.cd-flow-11 { background-color: var(--color-series-16-11); }
.cd-flow-12 { background-color: var(--color-series-16-12); }
.cd-flow-13 { background-color: var(--color-series-16-13); }
.cd-flow-14 { background-color: var(--color-series-16-14); }
.cd-flow-15 { background-color: var(--color-series-16-15); }

.cd-stats {
  gap: 10px;
}
.cd-stats__add {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-success, #7db233);
  font-weight: 500;
  font-size: 12px;
}
.cd-stats__del {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-danger, #dc2626);
  font-weight: 500;
  font-size: 12px;
}
.cd-stats__files {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.cd-refs {
  flex-wrap: wrap;
  gap: 3px;
}
.cd-ref-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 500;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.cd-ref-badge--branch {
  background-color: var(--color-primary-soft, rgba(116, 184, 48, 0.12));
  color: var(--color-primary, #74b830);
}
.cd-ref-badge--remote {
  background-color: rgba(100, 116, 139, 0.12);
  color: #64748b;
}
.cd-ref-badge--tag {
  background-color: rgba(245, 158, 11, 0.12);
  color: #d97706;
}

/* ===== Files ===== */
.cd-files {
  /* v3.7：紧凑排版，顶部 2px gap */
  padding: 2px 8px 4px 0;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.cd-panel--dialog .cd-files {
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
.cd-section-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 2px;
}
.cd-panel--dialog .cd-section-title {
  font-size: 13px;
  gap: 6px;
  margin: 0 0 6px;
}
.cd-files__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* v2.56：panel 变体下移除独立 background + border + border-radius —
     手风琴已是 elevated 底色 + 边框 + 圆角的卡片（v2.11 视觉卡片化），
     内部 .cd-files__list 再叠一层会显得"加了其他颜色"。
     改为透明继承手风琴背景，仅保留 flex 布局 + 行间分隔线（border-bottom 在 .cd-file-row）。 */
  background: transparent;
  border: none;
  border-radius: 0;
}
/* v2.56：dialog 变体下保留独立的卡片样式（弹窗壳外层是 dialog 背景，
   files__list 需要 border + background 才能跟周围内容区分） */
.cd-panel--dialog .cd-files__list {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg);
}
/* v1.8：右栏内 files 列表独立滚动接管
 *
 * 原结构：.cd-panel__right (flex column, overflow-y:auto) > .cd-files > .cd-files__list
 *   问题：.cd-files 设了 flex-shrink:0，files__list 很长时整体高度撑爆右栏，
 *   撑开 .commit-accordion max-height:260px，撑开整个 commit row 高度。
 *
 * 新结构：.cd-panel__right > .cd-files > .cd-section-title（始终可见）
 *                           > .cd-files__scroll（flex:1, min-height:0, overflow-y:auto）
 *                           > .cd-files__list
 *
 /* v2.0 重构：files 列表滚动接管
 *
 * 历史：
 * - v1.8：右栏本身 overflow-y:hidden，files 滚动由 .cd-files__scroll (flex:1 + overflow-y:auto) 接管
 *   → 右栏不滚动，files 区域内部独立滚动
 * - v2.0：右栏本身 overflow: auto (横纵双向)，接管所有内容滚动
 *   → 简化结构：.cd-files__scroll 退化成 flex item（不再 overflow），files/cards 都在右栏 flex column 内自然堆叠
 *   → 右栏总高度超 228px（手风琴 body 可用高度）时右栏统一出滚动条
 *   → 这样 cards 永远在 files 之后按 DOM 顺序展示，与 4:6 panel 的 1 个滚动条体验一致
 */
.cd-files__scroll {
  /* 容器占位：flex column 内自然占满余下空间，不再单独滚动（v2.0 上交右栏） */
  flex: 1 1 auto;
  min-height: 0;
}
/* v2.0：删除 .cd-files__scroll::-webkit-scrollbar 滚动条样式（已无滚动） */
/* dialog 变体单列流：files__list 自身需 max-height + 滚动（避免文件多撑爆弹窗） */
.cd-panel--dialog .cd-files__list {
  max-height: 240px;
  overflow-y: auto;
}
/* panel 变体：右栏父容器已经滚动，files__list 不再叠滚动条 */
.cd-panel--panel .cd-files__list {
  max-height: none;
  overflow-y: visible;
}
/* v3.8：复刻 vscode main.ts:480 #cdvFiles li
 * - display: flex —— 建立 flex 格式化上下文，让子元素 .cd-file 获得明确宽度约束
 *   vscode 用 <li> 自然建立块级宽度约束；我们用 flex 容器达到同样效果
 * - width: 100% —— 让 .cd-file (flex:1) 知道自己的可用宽度，触发 text-overflow:ellipsis
 * - overflow: hidden —— 裁剪溢出内容（配合 .cd-file flex:1 的宽度约束生效）
 * - margin-top: 4px —— 行间距（vscode 方案）*/
.cd-file-record {
  display: flex;
  align-items: center;
  width: 100%;
  overflow: hidden;
  margin-top: 2px;
}
.cd-file-record:first-child {
  margin-top: 0;
}
.cd-file {
  display: inline-flex;
  align-items: center;
  flex: 1;
  padding: 1px 4px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  border-radius: 3px;
}
.cd-file:hover {
  background: rgba(128, 128, 128, 0.08);
}
/* 文件图标（vscode main.ts:548-554 fileTreeFileIcon） */
.cd-file-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  opacity: 0.6;
}
.cd-file-icon svg {
  fill: currentColor;
}
/* 文件名 + (±N)：统一 flex 容器，截断只发生在 .cd-file-basename 内。
 * .cd-file-name 用 flex + min-width:0 建立宽度约束，
 * .cd-file-basename 用 flex:1 + text-overflow:ellipsis 截断超长文件名。*/
.cd-file-name {
  display: inline-flex;
  align-items: center;
  flex: 1 1 1px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  gap: 0;
}
.cd-file-basename {
  flex: 1 1 1px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-file-name--A {
  color: var(--color-success, #7db233);
}
.cd-file-name--M {
  color: var(--color-text);
}
.cd-file-name--D {
  color: var(--color-danger, #dc2626);
}
.cd-file-name--R {
  color: var(--color-info, #3b82f6);
}
.cd-file-name--B {
  color: var(--color-text-muted);
}
/* (±N)：独立设色，亮/暗模式均清晰可见。
 * 用圆角药片背景区分 +N 和 -N，不依赖文字颜色单独承载语义。 */
.cd-file-adddel {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  white-space: nowrap;
  /* 浅色背景 + 深色文字，保证对比度 */
  padding: 0 3px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
  color: #15803d;
  background: rgba(21, 128, 61, 0.12);
}
/* 只有删除没有新增：红色药丸 */
.cd-file-adddel:has(.cd-file-del-only) {
  color: #b91c1c;
  background: rgba(185, 28, 28, 0.10);
}
/* ± 同时存在时的 -N 片段 */
.cd-file-adddel .cdm-del {
  color: #b91c1c;
  font-weight: 500;
}
.cd-file-binary {
  font-size: 10px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}
/* hover 操作按钮（vscode main.ts:562-569 fileTreeFileAction） */
.cd-file-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.15s;
}
.cd-file-record:hover .cd-file-actions {
  opacity: 1;
}
.cd-file-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  transition: color 0.1s, background 0.1s;
}
.cd-file-action:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
}
.cd-file-action svg {
  fill: currentColor;
}

/* ===== Linked Cards ===== */
.cd-cards {
  padding: 6px var(--space-3, 12px);
  flex-shrink: 0;
}
.cd-panel--dialog .cd-cards {
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
.cd-cards__list {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.cd-card-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.1));
  color: var(--color-primary);
  font-weight: 500;
}
.cd-card-col {
  font-size: 10px;
  color: var(--color-text-muted);
  font-weight: 400;
}

/* ===== Utility ===== */
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
</style>
