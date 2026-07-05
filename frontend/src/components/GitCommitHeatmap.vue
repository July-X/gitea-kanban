<script setup lang="ts">
/**
 * GitCommitHeatmap —— 提交热力图组件
 *
 * 类似 GitHub Contributions Calendar，展示过去 N 个月（默认 12）每日提交密度。
 * 本组件只依赖 commit 列表中的 date（ISO 字符串），纯前端聚合计算。
 *
 * 设计约束：
 * - 不引入额外依赖
 * - 使用项目主题 CSS 变量（暗色 / 亮色自动切换）
 * - 小方块颜色走主色 alpha 分档，无贡献走底色
 * - 标题右侧小字标注数据周期（"Jul 2025 → Jun 2026"）
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
    /** 展示最近多少个月（默认 12，对齐 GitHub 贡献图周期） */
    months?: number;
    /** 标题（不传则显示默认文案） */
    title?: string;
  }>(),
  {
    months: 12,
    title: '提交热力图',
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
const dateRange = computed<{ start: Date; end: Date; totalDays: number }>(() => {
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
  return {
    start,
    end,
    totalDays: Math.floor((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1,
  };
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
 * 网格形状：7 行（周日..周六） × cols 列（周）。
 * 每个单元格：{ dateKey, count, dateObj, inRange }。
 */
const heatmapGrid = computed(() => {
  const { start, end } = dateRange.value;
  const days: {
    dateKey: string;
    count: number;
    dateObj: Date;
    inRange: boolean;
  }[] = [];

  for (let t = start.getTime(); t <= end.getTime(); t += ONE_DAY_MS) {
    const d = new Date(t);
    const dateKey = toLocalDateKey(d.toISOString());
    days.push({
      dateKey,
      count: countByDate.value.get(dateKey) ?? 0,
      dateObj: d,
      inRange: true,
    });
  }
  // 补齐到完整周（右侧可能需要几天才能整除 7）
  const remainder = days.length % 7;
  if (remainder !== 0) {
    const last = days[days.length - 1];
    for (let i = 1; i <= 7 - remainder; i++) {
      const d = new Date(last.dateObj.getTime() + i * ONE_DAY_MS);
      days.push({
        dateKey: toLocalDateKey(d.toISOString()),
        count: 0,
        dateObj: d,
        inRange: false,
      });
    }
  }
  const cols = days.length / 7;
  const rows: typeof days[] = [];
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
 * 月份标签：在每列顶部单元格里判断月份切换。
 * GitHub 风格：只有当该列的日期所在月份跟前一列不同时才显示月份名。
 */
const monthLabels = computed(() => {
  const labels: { col: number; text: string }[] = [];
  const cols = heatmapGrid.value;
  if (!cols.length) return labels;

  let lastMonth = -1;
  for (let colIdx = 0; colIdx < cols.length; colIdx++) {
    const col = cols[colIdx];
    if (!col) continue;
    // 取该列第一个 inRange 的 cell（跳过末尾 padding 周的空 cell）
    let firstCell = col[0];
    if (!firstCell?.inRange) {
      for (let d = 1; d < 7; d++) {
        firstCell = col[d];
        if (firstCell?.inRange) break;
      }
    }
    if (!firstCell) continue;
    const m = firstCell.dateObj.getMonth();
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
  // end 所在周可能不是真正 "今天" 那列，但范围语义按周对齐
  // 显示真实边界：rawStart = today - months+1
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
    // 范围外：仍然显示日期，但提示"不在数据周期内"
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
      头部：左侧 title + count，右侧 periodLabel（小字标注数据周期，对齐 GitHub 风格）
    -->
    <div class="commit-heatmap__header">
      <div class="commit-heatmap__head-main">
        <h3 class="commit-heatmap__title">{{ title }}</h3>
        <span class="commit-heatmap__count">{{ totalCommits }} 次提交</span>
      </div>
      <span class="commit-heatmap__period">{{ periodLabel }}</span>
    </div>

    <!--
      主体：横向铺开——
        - 月份标签条（顶部 absolute 定位到每列）
        - 左侧 weekday 栏（只显示 Mon / Wed / Fri，GitHub 风格）
        - 右侧日格矩阵（7 行 × N 列，cell 颜色按提交数分级）
        - 底部图例（少 → 多）
    -->
    <div class="commit-heatmap__chart" role="img" :aria-label="`提交热力图：${totalCommits} 次提交，周期 ${periodLabel}`">
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

      <div class="commit-heatmap__body">
        <div class="commit-heatmap__weekdays" aria-hidden="true">
          <span v-for="(d, i) in ['', '周一', '', '周三', '', '周五', '']" :key="i" class="commit-heatmap__weekday">{{ d }}</span>
        </div>
        <div class="commit-heatmap__grid">
          <div
            v-for="(col, colIdx) in heatmapGrid"
            :key="`col-${colIdx}`"
            class="commit-heatmap__col"
          >
            <div
              v-for="(cell, dayIdx) in col"
              :key="`cell-${colIdx}-${dayIdx}`"
              class="commit-heatmap__cell"
              :class="`commit-heatmap__cell--level-${getLevel(cell.count, cell.inRange)}`"
              :style="getCellStyle(getLevel(cell.count, cell.inRange))"
              :title="formatTooltip(cell)"
            />
          </div>
        </div>
      </div>
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
  </div>
</template>

<style scoped>
.commit-heatmap {
  /* 单格尺寸 + 列宽统一变量（横向展开时 column width 显式定义，便于月份标签 left 定位） */
  --heatmap-cell-size: 11px;
  --heatmap-gap: 3px;
  --heatmap-col-width: calc(var(--heatmap-cell-size) + var(--heatmap-gap));
  --heatmap-radius: 2px;

  width: 100%;
  padding: var(--space-4, 16px);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-sans);
  overflow: hidden;
  user-select: none;
  box-sizing: border-box;
}

/* ===== 头部 ===== */
.commit-heatmap__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  margin-bottom: var(--space-3, 12px);
  flex-wrap: wrap;
}

.commit-heatmap__head-main {
  display: flex;
  align-items: baseline;
  gap: var(--space-2, 8px);
}

.commit-heatmap__title {
  font-size: var(--font-md, 15px);
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
}

.commit-heatmap__count {
  font-size: var(--font-sm, 13px);
  color: var(--color-text-muted);
  font-weight: 500;
}

/* 小字周期标注（GitHub 风格右侧灰字） */
.commit-heatmap__period {
  font-size: var(--font-xs, 11px);
  color: var(--color-text-dim);
  font-weight: 400;
  letter-spacing: 0.02em;
}

/* ===== 图表区 ===== */
.commit-heatmap__chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  min-width: 0;
}

/* 月份标签条：absolute 定位每个标签 left=列号*列宽 */
.commit-heatmap__months {
  position: relative;
  height: 16px;
  margin-left: 36px; /* 与 weekdays 宽度对齐 */
}

.commit-heatmap__month-label {
  position: absolute;
  top: 0;
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
  white-space: nowrap;
  line-height: 16px;
}

/* 主体：星期标签 + 网格（横向 flex） */
.commit-heatmap__body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2, 8px);
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

.commit-heatmap__grid {
  display: flex;
  gap: var(--heatmap-gap);
  flex-shrink: 0;
}

.commit-heatmap__col {
  display: flex;
  flex-direction: column;
  gap: var(--heatmap-gap);
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

/* 图例 */
.commit-heatmap__legend {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  margin-top: var(--space-2, 8px);
  font-size: var(--font-xs, 11px);
  color: var(--color-text-muted);
}

.commit-heatmap__legend-label {
  line-height: var(--heatmap-cell-size);
}
</style>
