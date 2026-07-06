<script setup lang="ts">
/**
 * GitCommitHeatmap —— 提交热力图组件
 *
 * 类似 GitHub Contributions Calendar，展示过去 12 个月每日提交密度。
 * 本组件只依赖 commit 列表中的 date（ISO 字符串），纯前端聚合计算。
 *
 * 设计约束：
 * - 不引入额外依赖
 * - 使用项目主题 CSS 变量（暗色 / 亮色自动切换）
 * - 小方块颜色走主色 alpha 分档，无贡献走底色
 * - 中文 UI，零术语（AGENTS §9.1）
 * - 横向铺开，类似 GitHub 贡献图
 */

import { computed } from 'vue';

interface HeatmapCommit {
  /** commit 作者日期（ISO 8601，含时区） */
  date: string;
}

const props = withDefaults(
  defineProps<{
    /** commit 数据列表 */
    commits: HeatmapCommit[];
    /** 展示最近多少个月（默认 12，对齐 GitHub 贡献图周期） */
    months?: number;
  }>(),
  {
    months: 12,
  },
);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_NAMES_CN = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];
const WEEKDAY_NAMES_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 将 ISO 日期字符串归一化为本地日期 YYYY-MM-DD
 * 用 Date 的本地年月日，避免 UTC 边界导致周一被算成周日
 */
function toLocalDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 总提交数 */
const totalCommits = computed(() => props.commits.length);

/**
 * 数据周期：开始 = today - months 月（对齐到所在周周日开始），
 * 结束 = 今天（包含）。
 */
const dateRange = computed<{ start: Date; end: Date }>(() => {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const rawStart = new Date(
    end.getFullYear(),
    end.getMonth() - props.months + 1,
    end.getDate(),
  );
  rawStart.setHours(0, 0, 0, 0);
  // 对齐到所在周的周日（GitHub 风格：每周从周日开始）
  const start = new Date(rawStart.getTime() - rawStart.getDay() * ONE_DAY_MS);
  return { start, end };
});

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
 * 生成热力图网格数据。
 * 返回一维数组，每个元素是一周（7 天）的数据。
 * 渲染时使用 CSS grid：grid-template-rows: repeat(7, 11px), grid-auto-flow: column。
 */
const heatmapWeeks = computed(() => {
  const { start, end } = dateRange.value;
  const weeks: {
    dateKey: string;
    count: number;
    dateObj: Date;
    inRange: boolean;
  }[][] = [];
  const daysInPeriod = Math.round((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1;
  const totalDays = daysInPeriod + ((7 - ((daysInPeriod % 7)) % 7) || 0);

  for (let i = 0; i < totalDays; i++) {
    if (i % 7 === 0) weeks.push([]);
    const t = start.getTime() + i * ONE_DAY_MS;
    const d = new Date(t);
    const dateKey = toLocalDateKey(d.toISOString());
    const inRange = i < daysInPeriod;
    weeks[weeks.length - 1].push({
      dateKey,
      count: countByDate.value.get(dateKey) ?? 0,
      dateObj: d,
      inRange,
    });
  }
  return weeks;
});

/**
 * 月份标签：在每周（col）的第一个 inRange 的 cell 判断月份切换。
 * GitHub 风格：只有当该列内首个 inRange 的日期所在月份跟前一列不同时才显示月份名。
 */
const monthLabels = computed(() => {
  const labels: { col: number; text: string }[] = [];
  const weeks = heatmapWeeks.value;
  if (!weeks.length) return labels;

  let lastMonth = -1;
  for (let colIdx = 0; colIdx < weeks.length; colIdx++) {
    const week = weeks[colIdx];
    if (!week) continue;
    const firstInRange = week.find((c) => c.inRange) ?? week[0];
    if (!firstInRange) continue;
    const m = firstInRange.dateObj.getMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      labels.push({ col: colIdx, text: MONTH_NAMES_CN[m] ?? '' });
    }
  }
  return labels;
});

/** 周期小字标签：「M月 YYYY → M月 YYYY」（GitHub 风格） */
const periodLabel = computed(() => {
  const { end } = dateRange.value;
  const endMonth = end.getMonth();
  const endYear = end.getFullYear();
  const startRaw = new Date(end.getFullYear(), end.getMonth() - props.months + 1, end.getDate());
  return `${MONTH_NAMES_CN[startRaw.getMonth()] ?? ''} ${startRaw.getFullYear()} → ${MONTH_NAMES_CN[endMonth] ?? ''} ${endYear}`;
});

/**
 * 获取颜色强度级别（0-4）
 * 0 = 无提交 / 范围外
 * 1 = 1 次
 * 2 = 2-3 次
 * 3 = 4-5 次
 * 4 = 6+ 次
 */
function getLevel(count: number, inRange: boolean): number {
  if (!inRange || count <= 0) return 0;
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
      backgroundColor: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-divider)',
    };
  }
  const alphaMap: Record<number, string> = {
    1: '0.22',
    2: '0.45',
    3: '0.7',
    4: '1',
  };
  return {
    backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(Number(alphaMap[level]) * 100)}%, transparent)`,
    border: '1px solid transparent',
  };
}

/** tooltip 日期 + 提交数量文案 */
function formatTooltip(cell: { dateObj: Date; count: number; inRange: boolean }): string {
  if (!cell.inRange) {
    return `${cell.dateObj.getFullYear()}年${cell.dateObj.getMonth() + 1}月${cell.dateObj.getDate()}日：不在数据周期内`;
  }
  const weekday = WEEKDAY_NAMES_CN[cell.dateObj.getDay()] ?? '';
  if (cell.count === 0) {
    return `${cell.dateObj.getFullYear()}年${cell.dateObj.getMonth() + 1}月${cell.dateObj.getDate()}日 ${weekday}：无提交`;
  }
  return `${cell.dateObj.getFullYear()}年${cell.dateObj.getMonth() + 1}月${cell.dateObj.getDate()}日 ${weekday}：${cell.count} 次提交`;
}
</script>

<template>
  <div class="commit-heatmap">
    <!--
      顶部行：左侧横向铺开月份标签条（absolute 定位到每列），右侧 periodLabel（小字数据周期）
    -->
    <div class="commit-heatmap__top-line">
      <div class="commit-heatmap__months" aria-hidden="true">
        <span
          v-for="label in monthLabels"
          :key="`${label.col}-${label.text}`"
          class="commit-heatmap__month-label"
          :style="{ left: `calc(${label.col} * var(--heatmap-col-width))` }"
        >
          {{ label.text }}
        </span>
      </div>
      <span class="commit-heatmap__period" aria-label="数据时间范围">
        {{ periodLabel }}
      </span>
    </div>

    <!--
      主体：左侧 weekday 栏 + 右侧日格矩阵（CSS grid 横向铺开）
    -->
    <div class="commit-heatmap__body">
      <div class="commit-heatmap__weekdays" aria-hidden="true">
        <span v-for="(d, i) in ['', '周一', '', '周三', '', '周五', '']" :key="i" class="commit-heatmap__weekday">{{ d }}</span>
      </div>
      <div class="commit-heatmap__grid" role="img" :aria-label="`提交热力图：${totalCommits} 次提交，周期 ${periodLabel}`">
        <template v-for="(week, weekIdx) in heatmapWeeks" :key="`week-${weekIdx}`">
          <div
            v-for="(cell, dayIdx) in week"
            :key="`cell-${weekIdx}-${dayIdx}`"
            class="commit-heatmap__cell"
            :class="`commit-heatmap__cell--level-${getLevel(cell.count, cell.inRange)}`"
            :style="getCellStyle(getLevel(cell.count, cell.inRange))"
            :title="formatTooltip(cell)"
          />
        </template>
      </div>
    </div>

    <!-- 图例：少 → 多 -->
    <div class="commit-heatmap__legend">
      <span class="commit-heatmap__legend-label">少</span>
      <div
        v-for="level in 4"
        :key="`legend-${level}`"
        class="commit-heatmap__cell commit-heatmap__cell--legend"
        :style="getCellStyle(level)"
        aria-hidden="true"
      />
      <span class="commit-heatmap__legend-label">多</span>
    </div>
  </div>
</template>

<style scoped>
.commit-heatmap {
  /* 单格尺寸 + 列宽统一变量 */
  --heatmap-cell-size: 11px;
  --heatmap-gap: 3px;
  --heatmap-col-width: calc(var(--heatmap-cell-size) + var(--heatmap-gap));
  --heatmap-radius: 2px;

  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  box-sizing: border-box;
  padding: var(--space-3, 12px) var(--space-4, 16px);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-sans);
  user-select: none;
  display: flex;
  flex-direction: column;
  /* v0.7.5: 避免内部 grid 意外撑开宽度导致 sticky 失效 */
  min-height: 0;
}

/* ===== 顶部行：月份标签条 + 右侧 periodLabel ===== */
.commit-heatmap__top-line {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  margin-bottom: var(--space-2, 8px);
}

/* periodLabel（小字数据周期，GitHub 风格右侧灰字） */
.commit-heatmap__period {
  flex-shrink: 0;
  font-size: var(--font-xs, 11px);
  color: var(--color-text-dim);
  font-weight: 400;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* 月份标签条容器 */
.commit-heatmap__months {
  position: relative;
  height: 16px;
  flex: 1 1 auto;
  min-width: 0;
  /* 让 month-label absolute left=colIdx*col-width 与下方 cell 列对齐 */
  /* 需要与 .commit-heatmap__body 的 weekdays+gap 偏移同步：28+8=36px */
  margin-left: 36px;
}

.commit-heatmap__month-label {
  position: absolute;
  top: 0;
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
  white-space: nowrap;
  line-height: 16px;
}

/* ===== 主体：星期标签 + 网格 ===== */
.commit-heatmap__body {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-height: 0;
  flex-shrink: 0;
}

.commit-heatmap__weekdays {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 28px;
  min-height: calc(7 * var(--heatmap-cell-size) + 6 * var(--heatmap-gap));
  flex-shrink: 0;
}

.commit-heatmap__weekday {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
  line-height: var(--heatmap-cell-size);
  text-align: right;
  height: var(--heatmap-cell-size);
}

/* 网格容器：CSS grid 精确控制 7 行固定高度，每列自动 11px 宽，列从左到右自动 flow */
.commit-heatmap__grid {
  display: grid;
  grid-template-rows: repeat(7, var(--heatmap-cell-size));
  grid-auto-columns: var(--heatmap-cell-size);
  grid-auto-flow: column;
  gap: var(--heatmap-gap);
  min-height: 0;
  flex-shrink: 0;
}


.commit-heatmap__cell {
  width: var(--heatmap-cell-size);
  height: var(--heatmap-cell-size);
  border-radius: var(--heatmap-radius);
  box-sizing: border-box;
  cursor: pointer;
  transition: transform var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease);
}

.commit-heatmap__cell--legend {
  cursor: default;
}

.commit-heatmap__cell:not(.commit-heatmap__cell--legend):hover {
  transform: scale(1.25);
  opacity: 0.9;
  z-index: 1;
}

/* ===== 图例 ===== */
.commit-heatmap__legend {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  margin-top: 4px;
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
}

.commit-heatmap__legend-label {
  line-height: var(--heatmap-cell-size);
}
</style>
