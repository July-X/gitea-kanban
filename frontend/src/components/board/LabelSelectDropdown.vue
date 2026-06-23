<script setup lang="ts">
/**
 * LabelSelectDropdown —— 带搜索过滤的标签多选下拉框（v1.4 · 2026-06-19）
 *
 * 用于 CreateIssueDialog（新建议题选标签）+ IssueDetailDialog（二次修改标签）。
 *
 * 交互（user 拍板 2026-06-19）：
 * - 主输入框就是搜索框：点击展开下拉菜单，输入即过滤
 * - 下拉面板只有标签列表（不再有第二个搜索框）
 * - 第一个匹配项自动高亮；方向键 ↑↓ 切换高亮；回车选中高亮项
 * - 选中后 → 上档到输入框 chip 区 → 输入文本清空（继续搜下一个）
 * - 点击选项同样选中 + 清空输入
 * - 点击外部关闭下拉
 *
 * 通信：props.labels + props.selectedIds + emit('toggle', labelId)
 */
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronDown, X } from 'lucide-vue-next';
import type { IssueLabelDto } from '@renderer/types/dto';

const props = defineProps<{
  /** 仓库全部标签 */
  labels: IssueLabelDto[];
  /** 已选标签 id 集合 */
  selectedIds: Set<number>;
  /** 占位提示（聚焦前） */
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'toggle', labelId: number): void;
}>();

const open = ref(false);
const query = ref('');
/** 当前高亮项索引（-1 = 无高亮） */
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

/** 按搜索词过滤标签（名称包含，不区分大小写） */
const filteredLabels = computed<IssueLabelDto[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.labels;
  return props.labels.filter((l) => l.name.toLowerCase().includes(q));
});

/** 已选标签的完整对象列表（用于输入框内展示 chip） */
const selectedLabels = computed<IssueLabelDto[]>(() =>
  props.labels.filter((l) => props.selectedIds.has(l.id)),
);

/** 输入框聚焦 → 展开下拉 + 重置高亮到第一项 */
function onfocus(): void {
  open.value = true;
  activeIndex.value = filteredLabels.value.length > 0 ? 0 : -1;
}

/** 点击输入框区域 → 聚焦 input + 展开 */
function onFieldClick(): void {
  inputEl.value?.focus();
}

/** 输入文本变化 → 重置高亮到第一项 */
watch(query, () => {
  activeIndex.value = filteredLabels.value.length > 0 ? 0 : -1;
});

/** 选中某个标签（emit toggle + 清空输入文本 + 保持焦点继续搜） */
function selectLabel(id: number): void {
  emit('toggle', id);
  query.value = '';
  // 选中后重置高亮到第一项
  nextTick(() => {
    activeIndex.value = filteredLabels.value.length > 0 ? 0 : -1;
    inputEl.value?.focus();
  });
}

/** 移除已选标签（chip × 按钮） */
function onRemove(id: number): void {
  emit('toggle', id);
}

/** 键盘导航：↑↓ 切换高亮，回车选中，Esc 关闭 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (filteredLabels.value.length === 0) return;
    activeIndex.value = (activeIndex.value + 1) % filteredLabels.value.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (filteredLabels.value.length === 0) return;
    activeIndex.value =
      activeIndex.value <= 0 ? filteredLabels.value.length - 1 : activeIndex.value - 1;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const lab = filteredLabels.value[activeIndex.value];
    if (lab) selectLabel(lab.id);
  } else if (e.key === 'Escape') {
    open.value = false;
    query.value = '';
  } else if (e.key === 'Backspace' && query.value === '' && selectedLabels.value.length > 0) {
    // 输入框空时退格 → 移除最后一个已选标签
    const last = selectedLabels.value[selectedLabels.value.length - 1];
    if (last) onRemove(last.id);
  }
}

/** 输入框 blur：延迟关闭（让下拉面板的 click 先触发） */
function onBlur(): void {
  setTimeout(() => {
    open.value = false;
  }, 150);
}
</script>

<template>
  <div class="label-dropdown">
    <!-- 输入框：已选 chip + 搜索输入（本身就是搜索框） -->
    <div class="label-dropdown__field" @click="onFieldClick">
      <span
        v-for="lab in selectedLabels"
        :key="lab.id"
        class="label-dropdown__chip"
        :style="{ '--label-color': lab.color || '#888' }"
      >
        <span class="label-dropdown__chip-dot" />
        <span class="label-dropdown__chip-name">{{ lab.name }}</span>
        <button
          type="button"
          class="label-dropdown__chip-remove"
          :aria-label="`移除标签 ${lab.name}`"
          @click.stop="onRemove(lab.id)"
        >
          <X :size="11" :stroke-width="2.5" />
        </button>
      </span>
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        class="label-dropdown__input"
        :placeholder="selectedLabels.length === 0 ? (props.placeholder ?? '搜索或选择标签') : ''"
        @focus="onfocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <ChevronDown
        :size="14"
        :stroke-width="2"
        class="label-dropdown__caret"
        :class="{ 'label-dropdown__caret--open': open }"
        aria-hidden="true"
      />
    </div>

    <!-- 下拉面板（只有标签列表，无第二个搜索框） -->
    <div v-if="open" class="label-dropdown__panel">
      <ul class="label-dropdown__list">
        <li v-if="filteredLabels.length === 0" class="label-dropdown__empty muted">
          {{ props.labels.length === 0 ? '仓库暂无标签' : '无匹配标签' }}
        </li>
        <li
          v-for="(lab, i) in filteredLabels"
          :key="lab.id"
          class="label-dropdown__option"
          :class="{
            'label-dropdown__option--active': selectedIds.has(lab.id),
            'label-dropdown__option--hover': i === activeIndex,
          }"
          :title="lab.description || lab.name"
          @mouseenter="activeIndex = i"
          @click="selectLabel(lab.id)"
        >
          <span class="label-dropdown__option-dot" :style="{ background: lab.color || '#888' }" />
          <span class="label-dropdown__option-name">{{ lab.name }}</span>
          <span v-if="selectedIds.has(lab.id)" class="label-dropdown__option-check">✓</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.label-dropdown {
  position: relative;
  width: 100%;
}
/* 输入框：flex-wrap，chip + input 横向排列 */
.label-dropdown__field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 36px;
  padding: 4px 28px 4px 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: text;
  position: relative;
}
.label-dropdown__field:focus-within {
  border-color: var(--color-primary);
}
/* 已选 chip */
.label-dropdown__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 6px;
  background: color-mix(in srgb, var(--label-color, var(--color-bg-hover)) 20%, transparent);
  border: 1px solid var(--label-color, var(--color-divider));
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  color: var(--color-text);
  line-height: 1.4;
}
.label-dropdown__chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--label-color, #888);
  flex-shrink: 0;
}
.label-dropdown__chip-name {
  white-space: nowrap;
}
.label-dropdown__chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.label-dropdown__chip-remove:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
/* 搜索输入（占满剩余宽度，本身就是搜索框） */
.label-dropdown__input {
  flex: 1;
  min-width: 80px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-sm);
  font-family: inherit;
}
.label-dropdown__input::placeholder {
  color: var(--color-text-muted);
}
/* 展开箭头 */
.label-dropdown__caret {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text-muted);
  transition: transform var(--t-fast) var(--ease);
  pointer-events: none;
}
.label-dropdown__caret--open {
  transform: translateY(-50%) rotate(180deg);
}
/* 下拉面板（只有标签列表） */
.label-dropdown__panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  max-height: 240px;
  overflow: hidden;
}
/* 标签列表 */
.label-dropdown__list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  max-height: 232px;
}
.label-dropdown__empty {
  padding: 12px;
  text-align: center;
  font-size: var(--font-xs);
  font-style: italic;
}
.label-dropdown__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--color-text);
  transition: background var(--t-fast) var(--ease);
}
.label-dropdown__option--hover {
  background: var(--color-bg-hover);
}
.label-dropdown__option--active {
  /* v1.6：去 v1.1 强底色，降到 --color-primary-soft */
  background: var(--color-primary-soft);
}
.label-dropdown__option--active.label-dropdown__option--hover {
  /* v1.6：去 v1.1 primary-glow 70% mix, 改 primary-soft + bg-hover mix */
  background: color-mix(in srgb, var(--color-primary-soft) 70%, var(--color-bg-hover));
}
.label-dropdown__option-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.label-dropdown__option-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.label-dropdown__option-check {
  color: var(--color-primary);
  font-weight: 700;
  flex-shrink: 0;
}
</style>
