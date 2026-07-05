<script setup lang="ts">
/**
 * GitCommitHeatmap —— 提交热力图组件
 *
 * 类似 GitHub Contributions 贡献日历，展示过去 N 个月内每日提交密度。
 * 本组件只依赖 commit 列表中的 date（ISO 字符串）和 authorName，纯前端聚合计算。
 *
 * 设计约束：
 * - 不引入额外依赖
 * - 使用项目主题 CSS 变量（暗色/亮色自动切换）
 * - 小方块颜色走主色 alpha 分档，无贡献走底色
 * - 中文 UI，零术语（AGENTS §9.1）
 */

import { computed } from 'vue';

interface HeatmapCommit {
  /** commit 作者日期（ISO 8601，含时区） */
  date: string;
  /** 作者名（可选，仅用于 tooltip 信息） */
  authorName?: string;
}

const props = withDefaults(
  defineProps<{
    /** commit 数据列表 */
    commits: HeatmapCommit[];
    /** 展示最近多少个月（默认 6） */
    months?: number;
    /** 标题前缀（不传则显示默认文案） */
    title?: string;
  }>(),
  {
    months: 6,
    title: '',
  },
);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 将 ISO 日期字符串归一化为本地日期 YYYY-MM-DD
 * 注意：用 Date 的本地年月日，避免 UTC 边界导致周一被算成周日
 */
function toLocalDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 聚合 commit：Map<dateKey, count>
 */
const countByDate = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  for (const c of props.commits) {
    const key = toLocalDateKey(c.date);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
});

/**
 * 总提交数
 */
const totalCommits = computed(() => props.commits.length);

/**
 * 生成热力图网格数据。
 *
 * 网格形状：7 行（周日..周六，与 GitHub 一致） × 若干列（周）。
 * 时间窗口：从今天往前推 N 个月，并对齐到周日开始（取整周）。
 * 每个单元格：{ dateKey, count, dateObj }。
 */
const heatmapGrid = computed(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 结束日期：今天
  const endDate = new Date(today);
  // 开始日期：N 个月前
  const startDate = new Date(
    today.getFullYear(),
    today.getMonth() - props.months,
    today.getDate(),
  );
  startDate.setHours(0, 0, 0, 0);

  // 对齐到所在周的周日（GitHub 风格：每周从周日开始）
  const startDay = startDate.getDay(); // 0=周日
  const alignedStart = new Date(startDate.getTime() - startDay * ONE_DAY_MS);

  // 生成从 alignedStart 到 endDate（含）的每一天
  const days: { dateKey: string; count: number; dateObj: Date }[] = [];
  for (let t = alignedStart.getTime(); t <= endDate.getTime(); t += ONE_DAY_MS) {
    const d = new Date(t);
    const dateKey = toLocalDateKey(d.toISOString());
    days.push({
      dateKey,
      count: countByDate.value.get(dateKey) ?? 0,
      dateObj: d,
    });
  }

  // 补齐到完整的 7 行 × N 列（右侧可能需要多几天）
  const remainder = days.length % 7;
  if (remainder !== 0) {
    const last = days[days.length - 1];
    for (let i = 1; i <= 7 - remainder; i++) {
      const d = new Date(last.dateObj.getTime() + i * ONE_DAY_MS);
      days.push({
        dateKey: toLocalDateKey(d.toISOString()),
        count: 0,
        dateObj: d,
      });
    }
  }

  // 组织成 7 行 × (days.length / 7) 列
  const cols = days.length / 7;
  const rows: Array<typeof days[number][]> = [];
  for (let row = 0; row < 7; row++) {
    const rowCells: typeof days[number][] = [];
    for (let col = 0; col < cols; col++) {
      rowCells.push(days[col * 7 + row]);
    }
    rows.push(rowCells);
  }
  return rows;
});

/**
 * 月份标签：在顶部显示每个月第一次出现的列
 */
const monthLabels = computed(() => {
  const labels: { col: number; text: string }[] = [];
  const seen = new Set<string>();
  const rows = heatmapGrid.value;
  if (!rows.length || !rows[0].length) return labels;

  const months = [
    '1月', '2月', '3月', '4月', '5月', '6月',
    '7月', '8月', '9月', '10月', '11月', '12月',
  ];

  for (let col = 0; col < rows[0].length; col++) {
    const cell = rows[0][col];
    if (!cell) continue;
    const key = `${cell.dateObj.getFullYear()}-${cell.dateObj.getMonth()}`;
    if (!seen.has(key)) {
      seen.add(key);
      labels.push({
        col,
        text: months[cell.dateObj.getMonth()] ?? '',
      });
    }
  }
  return labels;
});

/**
 * 获取颜色强度级别（0-4）
 * 0 = 无提交
 * 1 = 1 次
 * 2 = 2-3 次
 * 3 = 4-5 次
 * 4 = 6+ 次
 */
function getLevel(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}

/**
 * 根据级别获取内联颜色样式（使用 CSS 变量，主题自动切换）
 */
function getCellStyle(level: number): Record<string, string> {
  if (level === 0) {
    return {
      backgroundColor: 'var(--color-elevated)',
      border: '1px solid var(--color-divider)',
    };
  }
  const alphas: Record<number, string> = {
    1: '0.22',
    2: '0.45',
    3: '0.7',
    4: '1',
  };
  return {
    backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(Number(alphas[level]) * 100)}%, transparent)`,
    border: '1px solid transparent',
  };
}

/**
 * 格式化 tooltip 日期：YYYY年M月D日 星期X
 */
function formatTooltipDate(dateObj: Date): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日 ${weekdays[dateObj.getDay()]}`;
}

/**
 * 格式化 tooltip 提交数量文案
 */
function formatCountText(count: number): string {
  if (count === 0) return '无提交';
  return `${count} 次提交`;
}
</script>

<template>
  <div class="commit-heatmap">
    <div class="commit-heatmap__header">
      <h3 class="commit-heatmap__title">
        {{ title || `近 ${months} 个月提交热力图` }}
      </h3>
      <span class="commit-heatmap__total">{{ totalCommits }} 次提交</span>
    </div>

    <div class="commit-heatmap__chart">
      <!-- 月份标签 -->
      <div class="commit-heatmap__months" aria-hidden="true">
        <span
          v-for="label in monthLabels"
          :key="label.col"
          class="commit-heatmap__month-label"
          :style="{ left: `calc(${label.col} * (var(--heatmap-cell-size) + var(--heatmap-gap)))` }"
        >
          {{ label.text }}
        </span>
      </div>

      <!-- 主体：星期侧边标签 + 网格 -->
      <div class="commit-heatmap__body">
        <div class="commit-heatmap__weekdays" aria-hidden="true">
          <span>周日</span>
          <span>周二</span>
          <span>周四</span>
          <span>周六</span>
        </div>
        <div class="commit-heatmap__grid" role="img" :aria-label="`近 ${months} 个月提交热力图，共 ${totalCommits} 次提交`">
          <div
            v-for="(row, rowIndex) in heatmapGrid"
            :key="rowIndex"
            class="commit-heatmap__row"
          >
            <div
              v-for="(cell, colIndex) in row"
              :key="`${rowIndex}-${colIndex}`"
              class="commit-heatmap__cell"
              :class="`commit-heatmap__cell--level-${getLevel(cell.count)}`"
              :style="getCellStyle(getLevel(cell.count))"
              :title="`${formatTooltipDate(cell.dateObj)}：${formatCountText(cell.count)}`"
            />
          </div>
        </div>
      </div>

      <!-- 图例 -->
      <div class="commit-heatmap__legend">
        <span class="commit-heatmap__legend-label">少</span>
        <div
          v-for="level in 4"
          :key="level"
          class="commit-heatmap__cell"
          :style="getCellStyle(level)"
          aria-hidden="true"
        />
        <span class="commit-heatmap__legend-label">多</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.commit-heatmap {
  --heatmap-cell-size: 10px;
  --heatmap-gap: 3px;
  --heatmap-radius: 2px;

  padding: var(--space-4, 16px);
  background: var(--color-bg, var(--color-canvas));
  border-radius: var(--radius-md, 8px);
  font-family: var(--font-sans);
  color: var(--color-text);
  overflow: hidden;
  user-select: none;
}

.commit-heatmap__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  margin-bottom: var(--space-4, 16px);
}

.commit-heatmap__title {
  font-size: var(--font-md, 15px);
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
}

.commit-heatmap__total {
  font-size: var(--font-sm, 13px);
  color: var(--color-text-muted);
  font-weight: 500;
}

.commit-heatmap__chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  overflow-x: auto;
  padding-bottom: var(--space-2, 8px);
}

/* 月份标签条 */
.commit-heatmap__months {
  position: relative;
  height: 16px;
  margin-left: 32px; /* 与 weekdays 宽度对齐 */
}

.commit-heatmap__month-label {
  position: absolute;
  top: 0;
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
  white-space: nowrap;
  line-height: 16px;
}

/* 主体：星期标签 + 网格 */
.commit-heatmap__body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2, 8px);
}

.commit-heatmap__weekdays {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 24px;
  min-height: calc(7 * var(--heatmap-cell-size) + 6 * var(--heatmap-gap));
  padding-top: 0;
  padding-bottom: 0;
  flex-shrink: 0;
}

.commit-heatmap__weekdays span {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
  line-height: var(--heatmap-cell-size);
  text-align: right;
  height: var(--heatmap-cell-size);
}

.commit-heatmap__grid {
  display: flex;
  gap: var(--heatmap-gap);
  flex-shrink: 0;
}

.commit-heatmap__row {
  display: flex;
  flex-direction: column;
  gap: var(--heatmap-gap);
}

.commit-heatmap__cell {
  width: var(--heatmap-cell-size);
  height: var(--heatmap-cell-size);
  border-radius: var(--heatmap-radius);
  box-sizing: border-box;
  transition: transform var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease);
  cursor: pointer;
}

.commit-heatmap__cell:hover {
  transform: scale(1.25);
  opacity: 0.9;
  z-index: 1;
}

/* 图例 */
.commit-heatmap__legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1, 4px);
  margin-top: var(--space-2, 8px);
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
}

.commit-heatmap__legend-label {
  line-height: var(--heatmap-cell-size);
}
</style>
