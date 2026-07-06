<script setup lang="ts">
/**
 * GitGraphFindWidget —— Git Graph 提交搜索组件
 *
 * 复刻 vscode-git-graph 的 Find Widget 功能：
 * - 搜索输入框（支持正则、大小写敏感）
 * - 上一个/下一个匹配按钮
 * - 匹配计数显示
 * - 关闭按钮
 * - 快捷键：Enter（下一个）、Shift+Enter（上一个）、Escape（关闭）
 */

import { nextTick, ref, watch } from 'vue';
import { Search, X, ChevronUp, ChevronDown, Regex, CaseSensitive } from 'lucide-vue-next';

export interface FindCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: string;
  refs?: string[];
  refTypes?: string[];
}

const props = defineProps<{
  commits: FindCommit[];
}>();

const emit = defineEmits<{
  (e: 'select', sha: string): void;
  (e: 'close'): void;
}>();

const searchText = ref('');
const isRegex = ref(false);
const isCaseSensitive = ref(false);
const matches = ref<string[]>([]);
const currentIndex = ref(-1);
const inputRef = ref<HTMLInputElement | null>(null);
const errorText = ref<string | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function doSearch() {
  errorText.value = null;

  if (!searchText.value) {
    matches.value = [];
    currentIndex.value = -1;
    return;
  }

  const text = searchText.value;
  const flags = isCaseSensitive.value ? 'u' : 'iu';
  let pattern: RegExp | null = null;

  if (isRegex.value) {
    try {
      pattern = new RegExp(text, flags);
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : '无效的正则表达式';
      pattern = null;
    }
  } else {
    try {
      const escaped = text.replace(/[\\\[\](){}|.*+?^$]/g, '\\$&');
      pattern = new RegExp(escaped, flags);
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : '无效的搜索模式';
      pattern = null;
    }
  }

  if (!pattern) {
    matches.value = [];
    currentIndex.value = -1;
    return;
  }

  const result: string[] = [];
  for (const c of props.commits) {
    if (
      pattern.test(c.subject) ||
      pattern.test(c.authorName) ||
      pattern.test(c.shortSha) ||
      pattern.test(c.sha) ||
      (c.refs && c.refs.some((r) => pattern!.test(r)))
    ) {
      result.push(c.sha);
    }
  }
  matches.value = result;
  currentIndex.value = result.length > 0 ? 0 : -1;

  if (matches.value.length > 0) {
    emit('select', matches.value[0]);
  }
}

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSearch, 200);
}

function next() {
  if (matches.value.length === 0) return;
  currentIndex.value = (currentIndex.value + 1) % matches.value.length;
  emit('select', matches.value[currentIndex.value]);
}

function prev() {
  if (matches.value.length === 0) return;
  currentIndex.value =
    (currentIndex.value - 1 + matches.value.length) % matches.value.length;
  emit('select', matches.value[currentIndex.value]);
}

function close() {
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      prev();
    } else {
      next();
    }
    e.preventDefault();
  } else if (e.key === 'Escape') {
    close();
    e.preventDefault();
  }
}

function toggleRegex() {
  isRegex.value = !isRegex.value;
  doSearch();
}

function toggleCaseSensitive() {
  isCaseSensitive.value = !isCaseSensitive.value;
  doSearch();
}

defineExpose({
  focus: () => {
    nextTick(() => inputRef.value?.focus());
  },
});

watch(
  () => props.commits,
  () => {
    doSearch();
  },
  { deep: true },
);
</script>

<template>
  <div class="git-graph-find-widget">
    <div class="git-graph-find-widget__left">
      <Search :size="14" class="git-graph-find-widget__icon" />
      <input
        ref="inputRef"
        v-model="searchText"
        type="text"
        class="git-graph-find-widget__input"
        :class="{ 'git-graph-find-widget__input--error': errorText }"
        placeholder="搜索提交（消息 / 作者 / SHA / 分支）"
        @input="onInput"
        @keydown="onKeydown"
      />
      <span v-if="errorText" class="git-graph-find-widget__error">{{ errorText }}</span>
      <span v-else class="git-graph-find-widget__count">
        {{ matches.length > 0 ? `${currentIndex + 1} / ${matches.length}` : '无结果' }}
      </span>
    </div>
    <div class="git-graph-find-widget__right">
      <button
        class="git-graph-find-widget__btn"
        :class="{ 'git-graph-find-widget__btn--active': isCaseSensitive }"
        title="区分大小写"
        @click="toggleCaseSensitive"
      >
        <CaseSensitive :size="14" />
      </button>
      <button
        class="git-graph-find-widget__btn"
        :class="{ 'git-graph-find-widget__btn--active': isRegex }"
        title="使用正则表达式"
        @click="toggleRegex"
      >
        <Regex :size="14" />
      </button>
      <button
        class="git-graph-find-widget__btn"
        title="上一个匹配 (Shift+Enter)"
        :disabled="matches.length === 0"
        @click="prev"
      >
        <ChevronUp :size="14" />
      </button>
      <button
        class="git-graph-find-widget__btn"
        title="下一个匹配 (Enter)"
        :disabled="matches.length === 0"
        @click="next"
      >
        <ChevronDown :size="14" />
      </button>
      <button
        class="git-graph-find-widget__btn git-graph-find-widget__btn--close"
        title="关闭 (Escape)"
        @click="close"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.git-graph-find-widget {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  background: var(--color-bg-elevated, var(--color-canvas));
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}

.git-graph-find-widget__left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.git-graph-find-widget__icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.git-graph-find-widget__input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: var(--font-sm, 13px);
  color: var(--color-text);
  background: var(--color-input-bg, var(--color-bg));
  border: 1px solid var(--color-input-border, var(--color-divider));
  border-radius: 4px;
  outline: none;
}

.git-graph-find-widget__input:focus {
  border-color: var(--color-primary);
}

.git-graph-find-widget__input--error {
  border-color: var(--color-danger, #e5534b);
}

.git-graph-find-widget__error {
  font-size: var(--font-xs);
  color: var(--color-danger, #e5534b);
  white-space: nowrap;
}

.git-graph-find-widget__count {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.git-graph-find-widget__right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.git-graph-find-widget__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.git-graph-find-widget__btn:hover:not(:disabled) {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text);
}

.git-graph-find-widget__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.git-graph-find-widget__btn--active {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.18));
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.git-graph-find-widget__btn--close:hover:not(:disabled) {
  background: var(--color-danger-soft, rgba(229, 83, 75, 0.16));
  color: var(--color-danger, #e5534b);
}
</style>
