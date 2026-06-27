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

/** 文件状态缩写 —— 用 Gitea 通用单字母风格(A/M/D/R/B)
 * 替代原中文标签"新增/修改/删除/重命名/二进制"，更紧凑、更符合开发者习惯。
 * 配合 fileStatusStyle() 返回 Gitea badge 配色:绿/黄/红/蓝/灰 */
function fileStatusLabel(status?: string): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'binary':
      return 'B';
    default:
      return status ?? '';
  }
}

/** 文件状态颜色 —— Gitea 配色:
 *   A (added)    绿  --color-success
 *   M (modified) 黄  --color-warning (Gitea 默认 modified 用黄/橙,提示注意)
 *   D (deleted)  红  --color-danger
 *   R (renamed)  蓝  --color-info
 *   B (binary)   灰  --color-text-secondary
 * 返回 [主色, 浅底色] 数组 —— 浅底色 = 主色 14% alpha,Gitea diff badge 风格 */
function fileStatusPalette(status?: string): [string, string] {
  switch (status) {
    case 'added':
      return ['var(--color-success, #7db233)', 'rgba(125, 178, 51, 0.14)'];
    case 'modified':
      return ['var(--color-warning, #d29922)', 'rgba(210, 153, 34, 0.14)'];
    case 'deleted':
      return ['var(--color-danger, #dc2626)', 'rgba(220, 38, 38, 0.14)'];
    case 'renamed':
      return ['var(--color-info, #3b82f6)', 'rgba(59, 130, 246, 0.14)'];
    default:
      return ['var(--color-text-secondary)', 'rgba(127, 127, 127, 0.14)'];
  }
}

/** 文件状态 inline style(Gitea badge: 主色文字 + 浅底色)
 * v2.36 替代旧的 `color: fileStatusColor(f.status)` 单属性绑定 */
function fileStatusStyle(status?: string): { color: string; backgroundColor: string } {
  const [color, bg] = fileStatusPalette(status);
  return { color, backgroundColor: bg };
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
      <div class="cd-panel__left">
        <div class="cd-panel__message">
          <div class="cd-message__title">{{ messageTitle }}</div>
          <pre v-if="messageBody" class="cd-message__body">{{ messageBody }}</pre>
        </div>

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
      <div class="cd-panel__right">
        <div v-if="detail?.files && detail.files.length > 0" class="cd-files">
          <div class="cd-section-title">
            <FileText :size="13" />
            文件变更（{{ detail.files.length }}）
          </div>
          <div class="cd-files__scroll">
            <div class="cd-files__list">
            <div v-for="f in detail.files" :key="f.filename" class="cd-file-row">
              <!-- v2.36：单字母 A/M/D/R/B + Gitea badge 风格(浅底色 + 主色文字) -->
              <span
                class="cd-file-status"
                :style="fileStatusStyle(f.status)"
              >
                {{ fileStatusLabel(f.status) }}
              </span>
              <span class="cd-file-name mono" :title="f.filename">
                {{ f.filename }}
                <span v-if="f.previousFilename" class="cd-file-rename">
                  ← {{ f.previousFilename }}
                </span>
              </span>
              <span class="cd-file-stats">
                <span v-if="f.additions" class="cd-stats__add">+{{ f.additions }}</span>
                <span v-if="f.deletions" class="cd-stats__del">-{{ f.deletions }}</span>
                <span v-if="f.binary" class="cd-file-binary">二进制</span>
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
          <div v-for="f in detail.files" :key="f.filename" class="cd-file-row">
            <!-- v2.36：单字母 A/M/D/R/B + Gitea badge 风格 -->
            <span
              class="cd-file-status"
              :style="fileStatusStyle(f.status)"
            >
              {{ fileStatusLabel(f.status) }}
            </span>
            <span class="cd-file-name mono" :title="f.filename">
              {{ f.filename }}
              <span v-if="f.previousFilename" class="cd-file-rename">
                ← {{ f.previousFilename }}
              </span>
            </span>
            <span class="cd-file-stats">
              <span v-if="f.additions" class="cd-stats__add">+{{ f.additions }}</span>
              <span v-if="f.deletions" class="cd-stats__del">-{{ f.deletions }}</span>
              <span v-if="f.binary" class="cd-file-binary">二进制</span>
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
 *   - flex column：header 顶 + body 撑开
 *   - 让内部子元素可以各自滚动 */
.cd-panel--panel {
  background: transparent;
  border-top: none;
  padding: 0;
  /* v1.8 bugfix：原 `height: 100%` 在 flex column 父容器 (.commit-accordion) 里
   * 不会起作用 —— flex 子元素的高度由 flex 属性决定，height:100% 被忽略。
   * 结果：cd-panel 高度 = 内容自然高度，accordion 容器 260px max-height 形同虚设，
   * 整个面板撑开到屏幕底部。
   * 改用 `flex: 1 1 auto` + `min-height: 0`：
   *   - flex:1 让它撑满 accordion 容器剩余空间（260px - 自身 margin 等）
   *   - min-height:0 允许内部 body/左右栏被压缩、出现滚动条
   * 配合 .commit-accordion 的 max-height:260px + overflow:hidden 形成完整裁剪。*/
  flex: 1 1 auto;
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
  grid-template-columns: 4fr 6fr;
  flex: 1;
  min-height: 0;
  min-width: 0; /* v2.0：grid 容器允许子项收缩 */
  overflow: hidden;
  /* 4:6 之间的纵向分隔线 */
  border-top: 1px solid var(--color-divider);
}
.cd-panel__left {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0; /* v2.0：允许 grid 子项收缩到内容自然宽度以下 */
  /* v2.0：横纵双向滚动 —— 长 commit message / 长 author email / 长 ref badge list
   * 在左栏内部独立滚动，不撑开 grid 容器、不撑开手风琴、不撑开 commit-row */
  overflow: auto;
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
  /* v2.0：横纵双向滚动 —— 长 file path / 长 card chip 列表在右栏内部独立滚动 */
  overflow: auto;
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
/* panel 变体下的 message / meta / files 都不再需要 border-bottom（左右两栏 + header 已分割）
 * flex-shrink 不强制 0 —— 允许右栏内容在 260px max-height 容器内被压缩，
 * 由 .cd-panel__left/right 的 overflow-y: auto 接管滚动（v2.12 设计意图）。
 * v1.8：原 flex-shrink: 0 会让右栏内 .cd-files + .cd-cards 撑爆父容器，导致
 *   .commit-accordion 高度被撑开，进而把整个 .commit-row 流式高度变大，
 *   Git Graph 表格高度跟着膨胀。改为 flex-shrink: 1 + min-height: 0 后，
 *   右栏在 260px 容器内自然出滚动条，左右栏各自独立滚动。
 *
 * 注：.cd-cards 仍保持 flex-shrink: 0（在下面单独规则）—— cards 是关联卡片 chip，
 * 数量有限（通常 <10），让它始终贴底完整可见；files 列表可能 50+ 文件才需要滚动。*/
.cd-panel--panel .cd-panel__message,
.cd-panel--panel .cd-panel__meta,
.cd-panel--panel .cd-files {
  border-bottom: none;
  flex-shrink: 1;
  min-height: 0;
}
.cd-panel--panel .cd-cards {
  border-bottom: none;
  /* v1.8：cards 在右栏 flex 中保持完整可见（flex-shrink:0），
   * 让 files 列表在 cd-files__scroll 内独立滚动，
   * cards 始终贴底显示，不被 files 列表挤出右栏。*/
  flex-shrink: 0;
}
/* panel 变体下的 message body 不再叠 120px max-height 滚动（外层已是滚动容器） */
.cd-panel--panel .cd-message__body {
  max-height: none;
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
}
.cd-panel--dialog .cd-panel__message {
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
.cd-message__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.4;
  word-break: break-word;
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

/* ===== Meta ===== */
.cd-panel__meta {
  padding: 6px var(--space-3, 12px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.cd-panel--dialog .cd-panel__meta {
  padding: var(--space-3, 12px) var(--space-4, 16px);
  gap: var(--space-2, 8px);
}
.cd-meta__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2, 8px);
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
  overflow: hidden;
}
.cd-panel--dialog .cd-meta__value {
  font-size: 13px;
  gap: 8px;
}
.cd-meta__email {
  font-size: 10px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* fallback 背景：复用 16 色变量（与 gitgraph 保持视觉一致） */
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

/* Stats */
.cd-stats {
  gap: 10px;
}
.cd-panel--dialog .cd-stats {
  gap: 12px;
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

/* Refs */
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

/* Loading */
.cd-loading {
  padding: var(--space-3, 12px);
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

/* ===== Files ===== */
.cd-files {
  padding: 6px var(--space-3, 12px);
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
  margin: 0 0 4px;
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
.cd-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 11px;
  border-bottom: 1px solid var(--color-divider, var(--color-border));
}
.cd-file-row:last-child {
  border-bottom: none;
}
.cd-file-status {
  /* v2.36：单字母 A/M/D/R/B 用更紧凑布局 + Gitea 风格色块背景
   * - flex-basis 从 36px 降到 22px(单字符宽度)
   * - 加圆角 + 浅背景,让状态标识有"badge"质感(Gitea diff 风格)
   * - 加 letter-spacing 让大写字母更挺 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 22px;
  width: 22px;
  height: 18px;
  border-radius: 3px;
  font-family: var(--font-mono-stack, ui-monospace, monospace);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0;
  text-align: center;
  flex-shrink: 0;
  /* background 由内联 :style 注入半透明色 —— 比 css variable 更易调 */
}
.cd-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.cd-file-rename {
  color: var(--color-text-muted);
  font-size: 10px;
}
.cd-file-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.cd-file-binary {
  font-size: 10px;
  color: var(--color-text-muted);
  padding: 0 4px;
  background: var(--color-bg-hover);
  border-radius: 3px;
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
