<script setup lang="ts">
/**
 * CommitDetailDialog —— Git Graph commit 详情弹窗
 *
 * 点击 commit 行弹出，展示：
 *   - SHA（可复制）+ 在 Gitea 打开按钮
 *   - 完整提交信息（多行）
 *   - 作者 + 提交者 + 时间
 *   - 变更统计（+N / -N · N files）
 *   - 文件变更列表（名称 + 行数 + 状态）
 *   - 关联看板卡片
 *
 * 设计：基本信息从 graph commit 直接读（秒开），
 *       files/stats/linkedCards 通过 commitsGet 懒加载。
 */
import { ref, watch, computed, nextTick, onUnmounted } from 'vue';
import {
  X,
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

/** 基础 commit 信息（从 graph 数据直接传入，不需要额外请求） */
interface BasicCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  authorName: string;
  authorEmail?: string;
  authorAvatar?: string;
  refs?: Array<{ shortName: string; refGroup: string }>;
}

interface Props {
  open: boolean;
  commit: BasicCommit | null;
  /** 当前项目 ID（用于 commitsGet 请求） */
  projectId: string | null;
  /** Gitea 仓库地址（用于 "在 Gitea 打开" 按钮） */
  giteaRepoUrl?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

// ===== 懒加载详情 =====
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

const loading = ref(false);
const detail = ref<CommitDetail | null>(null);
const detailCache = new Map<string, CommitDetail>();

/** 加载 commit 详情（带缓存） */
async function loadDetail(): Promise<void> {
  if (!props.commit || !props.projectId) return;
  const sha = props.commit.sha;

  // 缓存命中
  if (detailCache.has(sha)) {
    detail.value = detailCache.get(sha)!;
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
  } catch (e) {
    // 失败时用基本信息（subject 作为 message）
    const fallback: CommitDetail = {
      message: props.commit.subject,
    };
    detail.value = fallback;
  } finally {
    loading.value = false;
  }
}

// ===== 弹窗控制 =====
const overlayRef = ref<HTMLDivElement | null>(null);

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen && props.commit) {
      detail.value = null;
      await loadDetail();
      nextTick(() => overlayRef.value?.focus());
    }
  },
);

function close(): void {
  emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

// 全局 Escape 监听（Teleport 到 body 后需要手动捕获）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) {
    e.preventDefault();
    close();
  }
}
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      document.addEventListener('keydown', onGlobalKeydown);
    } else {
      document.removeEventListener('keydown', onGlobalKeydown);
    }
  },
);
onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});

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

function openInGitea(): void {
  if (!props.commit || !props.giteaRepoUrl) return;
  const url = `${props.giteaRepoUrl.replace(/\/$/, '')}/commit/${props.commit.sha}`;
  window.open(url, '_blank');
}

/** 文件状态中文 */
function fileStatusLabel(status?: string): string {
  switch (status) {
    case 'added':
      return '新增';
    case 'modified':
      return '修改';
    case 'deleted':
      return '删除';
    case 'renamed':
      return '重命名';
    case 'binary':
      return '二进制';
    default:
      return status ?? '';
  }
}

/** 文件状态颜色 */
function fileStatusColor(status?: string): string {
  switch (status) {
    case 'added':
      return 'var(--color-success, #7db233)';
    case 'deleted':
      return 'var(--color-danger, #dc2626)';
    case 'renamed':
      return 'var(--color-info, #3b82f6)';
    default:
      return 'var(--color-text-secondary)';
  }
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
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.open && props.commit"
      ref="overlayRef"
      class="cd-overlay"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      @click.self="close"
      @keydown="onKeydown"
    >
      <div class="cd-dialog">
        <!-- 标题栏 -->
        <header class="cd-header">
          <div class="cd-header__left">
            <GitCommit :size="16" class="cd-header__icon" />
            <code class="cd-sha mono">{{ props.commit.shortSha }}</code>
            <span class="cd-date">{{ formatFullDate(props.commit.date) }}</span>
          </div>
          <div class="cd-header__right">
            <button
              type="button"
              class="cd-icon-btn"
              title="复制完整 SHA"
              @click="copySha"
            >
              <Copy :size="14" />
            </button>
            <button
              v-if="props.giteaRepoUrl"
              type="button"
              class="cd-icon-btn"
              title="在 Gitea 中打开"
              @click="openInGitea"
            >
              <ExternalLink :size="14" />
            </button>
            <button type="button" class="cd-icon-btn" title="关闭" @click="close">
              <X :size="14" />
            </button>
          </div>
        </header>

        <!-- 提交信息 -->
        <div class="cd-message">
          <h2 class="cd-message__title">{{ messageTitle }}</h2>
          <pre v-if="messageBody" class="cd-message__body">{{ messageBody }}</pre>
        </div>

        <!-- 作者信息 -->
        <div class="cd-meta">
          <div class="cd-meta__row">
            <span class="cd-meta__label">作者</span>
            <div class="cd-meta__value">
              <img
                v-if="props.commit.authorAvatar"
                :src="props.commit.authorAvatar"
                class="cd-avatar"
                alt=""
              />
              <span>{{ props.commit.authorName }}</span>
              <span v-if="props.commit.authorEmail" class="cd-meta__email mono">
                &lt;{{ props.commit.authorEmail }}&gt;
              </span>
            </div>
          </div>
          <div v-if="detail && (detail.additions != null || detail.deletions != null)" class="cd-meta__row">
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
          <div v-if="props.commit.refs && props.commit.refs.length > 0" class="cd-meta__row">
            <span class="cd-meta__label">引用</span>
            <div class="cd-meta__value cd-refs">
              <span v-for="ref in props.commit.refs" :key="ref.shortName" class="cd-ref-badge">
                {{ ref.shortName }}
              </span>
            </div>
          </div>
        </div>

        <!-- 加载中 -->
        <div v-if="loading" class="cd-loading">加载详情中…</div>

        <!-- 文件变更列表 -->
        <div v-if="detail?.files && detail.files.length > 0" class="cd-files">
          <h3 class="cd-section-title">
            <FileText :size="14" />
            文件变更（{{ detail.files.length }}）
          </h3>
          <div class="cd-files__list">
            <div v-for="f in detail.files" :key="f.filename" class="cd-file-row">
              <span class="cd-file-status" :style="{ color: fileStatusColor(f.status) }">
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
          <h3 class="cd-section-title">
            <Link2 :size="14" />
            关联卡片（{{ detail.linkedCards.length }}）
          </h3>
          <div class="cd-cards__list">
            <span v-for="card in detail.linkedCards" :key="card.cardId" class="cd-card-chip">
              {{ card.cardId }}
              <span v-if="card.columnName" class="cd-card-col">{{ card.columnName }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ===== Overlay ===== */
.cd-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg-overlay, rgba(0, 0, 0, 0.45));
  z-index: var(--z-modal-overlay, 100);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-6, 24px) var(--space-4, 16px);
  animation: cdFadeIn 150ms ease-out;
  overflow-y: auto;
}

/* ===== Dialog ===== */
.cd-dialog {
  background: var(--color-bg-elevated, #1a1d23);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.32));
  width: min(640px, 100%);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  animation: cdSlideUp 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* ===== Header ===== */
.cd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3, 12px) var(--space-4, 16px);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  background: var(--color-bg-elevated, #1a1d23);
  z-index: 1;
}
.cd-header__left {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
}
.cd-header__icon {
  color: var(--color-primary);
  flex-shrink: 0;
}
.cd-sha {
  font-size: var(--font-sm, 13px);
  color: var(--color-primary);
  font-weight: 600;
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.1));
  padding: 1px 6px;
  border-radius: 4px;
}
.cd-date {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
}
.cd-header__right {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
}
.cd-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
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
.cd-message {
  padding: var(--space-4, 16px);
  border-bottom: 1px solid var(--color-border);
}
.cd-message__title {
  font-size: var(--font-lg, 16px);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-2, 8px);
  line-height: 1.4;
}
.cd-message__body {
  font-size: var(--font-sm, 13px);
  color: var(--color-text-secondary);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  font-family: inherit;
}

/* ===== Meta ===== */
.cd-meta {
  padding: var(--space-3, 12px) var(--space-4, 16px);
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  border-bottom: 1px solid var(--color-border);
}
.cd-meta__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-3, 12px);
}
.cd-meta__label {
  flex: 0 0 48px;
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
  text-align: right;
}
.cd-meta__value {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  font-size: var(--font-sm, 13px);
  color: var(--color-text);
  min-width: 0;
}
.cd-meta__email {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
}
.cd-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

/* Stats */
.cd-stats {
  gap: var(--space-3, 12px);
}
.cd-stats__add {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-success, #7db233);
  font-size: var(--font-sm, 13px);
  font-weight: 500;
}
.cd-stats__del {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-danger, #dc2626);
  font-size: var(--font-sm, 13px);
  font-weight: 500;
}
.cd-stats__files {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-text-secondary);
  font-size: var(--font-sm, 13px);
}

/* Refs */
.cd-refs {
  flex-wrap: wrap;
  gap: var(--space-1, 4px);
}
.cd-ref-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-secondary);
}

/* Loading */
.cd-loading {
  padding: var(--space-4, 16px);
  text-align: center;
  font-size: var(--font-sm, 13px);
  color: var(--color-text-muted);
}

/* ===== Files ===== */
.cd-files {
  padding: var(--space-3, 12px) var(--space-4, 16px);
  border-bottom: 1px solid var(--color-border);
}
.cd-section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  font-size: var(--font-sm, 13px);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-2, 8px);
}
.cd-files__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg);
}
.cd-file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: 4px var(--space-3, 12px);
  font-size: var(--font-xs, 11px);
  border-bottom: 1px solid var(--color-divider, var(--color-border));
}
.cd-file-row:last-child {
  border-bottom: none;
}
.cd-file-status {
  flex: 0 0 40px;
  font-weight: 500;
  font-size: 10px;
  text-align: right;
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
  gap: var(--space-2, 8px);
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
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
.cd-cards__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1, 4px);
}
.cd-card-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
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

/* ===== Animation ===== */
@keyframes cdFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cdSlideUp {
  from { transform: translateY(8px) scale(0.98); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .cd-overlay,
  .cd-dialog {
    animation: none;
  }
}
</style>
