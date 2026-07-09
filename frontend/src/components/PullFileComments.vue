<script setup lang="ts">
/**
 * PullFileComments.vue — PR 文件评论区（v0.5.0 M4）
 *
 * 位置：PR 详情展开区的「文件评论」Tab 内
 *
 * 视觉：
 *   - 每个文件可折叠展开
 *   - 文件 header: 文件名 + +N / -N + 评论数
 *   - 文件展开后显示 review comments: 头像 + 用户名 + 「第 N 行」+ 正文
 *
 * props:
 *   - pr: PullDto — 关联的合并请求
 *   - projectId: string — 项目 ID
 */
import { computed, ref } from 'vue';
import { ChevronDown, ChevronRight, Plus, Minus, FileText, Loader2 } from 'lucide-vue-next';
import { usePullStore } from '@renderer/stores/pull';
import type { PullDto, PullFileDto, PullReviewCommentDto } from '@renderer/types/dto';
import { renderMarkdown } from '@renderer/lib/markdown';

const pullStore = usePullStore();

const props = defineProps<{
  pr: PullDto;
  projectId: string;
}>();

/** 该 PR 下所有文件的展开 Set */
const expandedFiles = ref<Set<string>>(new Set());

/** 加载状态 */
const loading = ref(true);

/** 该 PR 下的文件列表 */
const files = computed<PullFileDto[]>(() => {
  return pullStore.filesByPR.get(props.pr.index) ?? [];
});

/** 按文件路径分组的 review comments */
const commentsByPath = computed<Map<string, PullReviewCommentDto[]>>(() => {
  const grouped = pullStore.reviewCommentsGrouped.get(props.pr.index);
  return grouped ?? new Map();
});

/** 文件评论数 */
const fileCommentCount = (path: string): number => {
  return commentsByPath.value.get(path)?.length ?? 0;
};

/** 切换文件展开/折叠 */
function toggleFile(path: string): void {
  if (expandedFiles.value.has(path)) {
    expandedFiles.value.delete(path);
  } else {
    expandedFiles.value.add(path);
  }
}

/** 拉取文件评论和文件列表（如果尚未加载） */
async function ensureLoaded(): Promise<void> {
  loading.value = true;
  try {
    await pullStore.loadFiles(props.projectId, props.pr.index);
    await pullStore.loadReviewComments(props.projectId, props.pr.index);
  } finally {
    loading.value = false;
  }
}

// 加载
ensureLoaded();

/** 文本字数截断 */
const truncate = (s: string, n = 50): string => {
  return s.length > n ? s.slice(0, n) + '…' : s;
};
</script>

<template>
  <div class="merge-item__file-comments">
    <!-- 加载中 -->
    <div v-if="loading" class="merge-item__file-comments-loading">
      <Loader2 :size="14" :stroke-width="2" class="spin" aria-hidden="true" />
      <span>正在加载文件列表…</span>
    </div>

    <template v-else>
    <!-- 文件评论区 header -->
    <div class="merge-item__file-comments-header">
      <span class="merge-item__file-comments-title">
        <FileText :size="14" :stroke-width="2" aria-hidden="true" />
        文件评论
      </span>
      <span class="merge-item__file-comments-count">{{ files.length }} 个文件</span>
    </div>

    <!-- 空态：无文件变更 -->
    <div v-if="files.length === 0" class="merge-item__file-comments-empty">
      暂无文件变更（或平台版本不支持文件列表）
    </div>

    <!-- 文件列表 -->
    <div v-else class="merge-item__file-list">
      <div
        v-for="f in files"
        :key="f.filename"
        class="file-item"
      >
        <!-- File header -->
        <div
          class="file-item__header"
          :class="{ 'file-item__header--open': expandedFiles.has(f.filename) }"
          @click="toggleFile(f.filename)"
        >
          <span class="file-item__chevron">
            <ChevronDown v-if="expandedFiles.has(f.filename)" :size="14" aria-hidden="true" />
            <ChevronRight v-else :size="14" aria-hidden="true" />
          </span>
          <span class="file-item__path">{{ f.filename }}</span>
          <span v-if="f.previousFilename" class="file-item__renamed">
            ← 由 {{ f.previousFilename }} 改名
          </span>
          <span class="file-item__stats">
            <span class="file-item__stat file-item__stat--added">+{{ f.additions }}</span>
            <span class="file-item__stat file-item__stat--deleted">-{{ f.deletions }}</span>
          </span>
          <span v-if="fileCommentCount(f.filename) > 0" class="file-item__comment-count">
            {{ fileCommentCount(f.filename) }} 条评论
          </span>
        </div>

        <!-- 文件展开区：review comments -->
        <div
          v-if="expandedFiles.has(f.filename)"
          class="file-item__comments"
        >
          <!-- 无评论 -->
          <div v-if="fileCommentCount(f.filename) === 0" class="file-item__no-comments">
            暂无行内评论
          </div>

          <!-- Review comments list -->
          <div
            v-for="(c, ci) in commentsByPath.get(f.filename) ?? []"
            :key="c.id"
            class="file-item__comment"
          >
            <div class="file-item__comment-side">
              <div class="file-item__comment-avatar">
                {{ (c.author?.username || '?').charAt(0).toUpperCase() }}
              </div>
              <div class="file-item__comment-name">{{ c.author?.username || '匿名' }}</div>
            </div>
            <div class="file-item__comment-body-wrap">
              <div class="file-item__comment-meta">
                <span class="file-item__comment-line">第 {{ c.line }} 行</span>
                <span class="file-item__comment-time">{{ c.createdAt }}</span>
              </div>
              <div class="file-item__comment-body md-body" v-html="renderMarkdown(c.body || '')"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.merge-item__file-comments {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  min-height: 0;
}

.merge-item__file-comments-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
  flex-shrink: 0;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--color-divider-soft);
}

.merge-item__file-comments-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.merge-item__file-comments-count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  font-weight: 400;
}

.merge-item__file-comments-empty {
  padding: 16px 8px;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.merge-item__file-comments-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 8px;
  font-size: var(--font-sm);
  color: var(--color-text-muted);
}

.merge-item__file-comments-loading .spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ===== 文件列表 ===== */
.merge-item__file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.file-item {
  border-bottom: 1px solid var(--color-divider-soft);
}

.file-item:last-child {
  border-bottom: none;
}

.file-item__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--color-bg-elevated);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
  user-select: none;
}

.file-item__header:hover {
  background: var(--color-bg-hover);
}

.file-item__header--open {
  background: var(--color-bg-hover);
  border-bottom: 1px solid var(--color-divider-soft);
}

.file-item__chevron {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.file-item__path {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
  color: var(--color-text);
  word-break: break-all;
  min-width: 0;
  flex: 1 1 0;
}

.file-item__renamed {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.file-item__stats {
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
}

.file-item__stat {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 2px;
}

.file-item__stat--added {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.file-item__stat--deleted {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.file-item__comment-count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

/* ===== 文件展开区 ===== */
.file-item__comments {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--color-bg);
}

.file-item__no-comments {
  padding: 12px 8px;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  border: 1px dashed var(--color-divider);
  border-radius: var(--radius-sm);
}

/* ===== Review comment ===== */
.file-item__comment {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-left: 3px solid var(--color-divider);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--color-bg-elevated);
}

.file-item__comment:has(.file-item__comment-avatar) {
  border-left-color: var(--color-primary);
}

.file-item__comment-side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 40px;
}

.file-item__comment-avatar {
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

.file-item__comment-name {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  max-width: 50px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-item__comment-body-wrap {
  flex: 1 1 0;
  min-width: 0;
}

.file-item__comment-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.file-item__comment-line {
  padding: 1px 6px;
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
}

.file-item__comment-body {
  font-size: var(--font-sm);
  color: var(--color-text);
  word-break: break-all;
  overflow-wrap: break-word;
  white-space: pre-wrap;
}

.file-item__comment-body.md-body :deep(p) { margin: 0 0 4px 0; }
.file-item__comment-body.md-body :deep(p:last-child) { margin-bottom: 0; }
</style>
