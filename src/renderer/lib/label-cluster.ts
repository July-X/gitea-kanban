/**
 * label-cluster —— gitea label 智能聚类（v1.4 P0-1 wireframe 增量 · plan_25cc4562 Task C · 落地）
 *
 * 拍板 2026-06-16（user）：
 *   "autoInit 这个很好，但是需要自动判断识别一类 label，比如
 *    m10-1, m10-2, m11-11, bugfix-m10-1, bugfix-m10-2 等等，
 *    这一类应该是把类似的做成一个列才对比如叫 bugfix-m10-*, m10-* 这种。"
 *
 * v1.4 最终拍板的聚类算法：
 *   1. L1 精确匹配（10 个预设字面量）
 *   2. L2/L3 **同 prefix 分桶**（不用 `${prefix}-${段数}` 双 key）
 *      · 桶里**全部**单段 label → 聚成 `${prefix}-*`（记 prefixGroup）
 *      · 桶里**全部**多段 label → 聚成 `${prefix}-*`（记 compound）
 *      · 混合桶（短+长）→ **拒绝**（避免空泛列名）
 *   3. 未归类进 unmatched
 *
 * 为何混合桶拒绝：
 *   - 'm10a'（1 段）+ 'm10-1'（2 段）都 prefix 'm10'
 *   - 聚成 'm10-*' 太空泛（"m10a" 和 "m10-1" 语义不同）
 *   - 拒绝让短 label 单独 unmatched（"m10a" 单 label 不到 ≥ 2 阈值）
 *   - 拒绝让多段 label 后续**可走更智能的 L4**（v1.5 增量）
 *
 * 边界（AGENTS §5.2 frontend agent）：
 *   - ✅ 纯函数 · 无副作用 · 0 外部依赖
 *   - ❌ 不碰 src/main/** / store / IPC
 *   - ❌ 不引第三方依赖
 *
 * 输入：gitea label 列表
 * 输出：{ literal, prefixGroup, compound, unmatched } —— 后续 P0-1 breakdown 字段
 */

import type { IssueLabelDto } from '../../main/ipc/schema.js';

/**
 * v1.4 预设列名（跟 src/renderer/stores/board.ts presetColumns 完全一致）
 * - 10 个去重后字面量
 */
const LITERAL_PRESETS: readonly string[] = [
  '新建',
  '进行中',
  '待办',
  '已完成',
  'Backlog',
  'To Do',
  'In Progress',
  'Done',
  '待处理',
  '处理中',
];

/** 单一分隔符集合（v1.4 拍板：4 种） */
const SEPARATORS = ['-', '_', '.', '/'] as const;

function extractPrefix(name: string): string {
  for (const sep of SEPARATORS) {
    const idx = name.indexOf(sep);
    if (idx > 0) return name.slice(0, idx);
  }
  return name;
}

function countParts(name: string): number {
  return name.split(/[-_./]/).filter((p) => p.length > 0).length;
}

export interface ColumnGroup {
  columnTitle: string;
  labelIds: number[];
}

export interface ClusterPlan {
  /** L1 精确匹配 */
  literal: ColumnGroup[];
  /** L2 prefix 聚类（桶内**全部**单段 label） */
  prefixGroup: ColumnGroup[];
  /** L3 复合 prefix 聚类（桶内**全部**多段 label） */
  compound: ColumnGroup[];
  /** 未归类 */
  unmatched: { labelId: number; labelName: string }[];
}

const MIN_PREFIX_GROUP_SIZE = 2;

export function clusterLabels(labels: readonly IssueLabelDto[]): ClusterPlan {
  const result: ClusterPlan = {
    literal: [],
    prefixGroup: [],
    compound: [],
    unmatched: [],
  };
  if (labels.length === 0) return result;

  const usedIds = new Set<number>();
  function* remaining() {
    for (const lab of labels) {
      if (!usedIds.has(lab.id)) yield lab;
    }
  }

  // Step 1: L1 精确匹配
  for (const preset of LITERAL_PRESETS) {
    const matched = labels.find((l) => l.name === preset && !usedIds.has(l.id));
    if (matched) {
      result.literal.push({
        columnTitle: preset,
        labelIds: [matched.id],
      });
      usedIds.add(matched.id);
    }
  }

  // Step 2: L2/L3 prefix 聚类
  // L2 桶 = 短 label（段数 ≤ 1）；聚成 `${prefix}-*`
  // L3 桶 = 多段 label（段数 ≥ 2）；聚类**按段数**：
  //   - 段数 = 2 → prefix = `${part0}`（同 L2 单段 prefix，例 'm10-1' → 'm10'）
  //   - 段数 ≥ 3 → prefix = `${part0}-${part1}`（复合，例 'bugfix-m10-1' → 'bugfix-m10'）
  // **桶内段数必须一致**（避免 'm10-1' + 'm10-1-extra' 混桶）
  // **混合桶拒绝**（短+长）：避免 'm10a'（1 段）和 'm10-1'（2 段）空泛归 'm10-*'
  const prefixBuckets = new Map<string, number[]>();
  for (const lab of remaining()) {
    const prefix = extractPrefix(lab.name);
    if (!prefixBuckets.has(prefix)) prefixBuckets.set(prefix, []);
    prefixBuckets.get(prefix)!.push(lab.id);
  }
  for (const [prefix, ids] of prefixBuckets) {
    if (ids.length < MIN_PREFIX_GROUP_SIZE) continue;
    const bucketLabels = labels.filter((l) => ids.includes(l.id));
    const allShort = bucketLabels.every((l) => countParts(l.name) <= 1);
    const allSameLength = bucketLabels.every(
      (l) => countParts(l.name) === countParts(bucketLabels[0]!.name),
    );
    if (allShort) {
      // L2 短 label：单段整体作 prefix
      result.prefixGroup.push({
        columnTitle: `${prefix}-*`,
        labelIds: ids,
      });
      ids.forEach((id) => usedIds.add(id));
    } else if (allSameLength) {
      // L3 多段 label：段数一致 → 复合 prefix
      // 段数 = 2 → 用首段；段数 ≥ 3 → 用前 2 段
      const sampleParts = bucketLabels[0]!.name.split(/[-_./]/).filter((p) => p.length > 0);
      const compoundPrefix =
        sampleParts.length === 2
          ? sampleParts[0]! // 'm10-1' → 'm10'
          : sampleParts.slice(0, 2).join('-'); // 'bugfix-m10-1' → 'bugfix-m10'
      // 桶内所有 label 必须共享同一 compound prefix
      const consistent = bucketLabels.every((l) => {
        const parts = l.name.split(/[-_./]/).filter((p) => p.length > 0);
        const candidate = parts.length === 2 ? parts[0]! : parts.slice(0, 2).join('-');
        return candidate === compoundPrefix;
      });
      if (!consistent) continue;
      result.compound.push({
        columnTitle: `${compoundPrefix}-*`,
        labelIds: ids,
      });
      ids.forEach((id) => usedIds.add(id));
    }
    // 混合桶：拒绝
  }

  // Step 3: 未归类
  for (const lab of remaining()) {
    result.unmatched.push({ labelId: lab.id, labelName: lab.name });
  }

  return result;
}

export function clusterSummary(plan: ClusterPlan): {
  totalCount: number;
  columnCount: number;
  unmatchedCount: number;
  literalExamples: string[];
  prefixExamples: string[];
  compoundExamples: string[];
  unmatchedExamples: string[];
} {
  return {
    totalCount:
      plan.literal.reduce((s, c) => s + c.labelIds.length, 0) +
      plan.prefixGroup.reduce((s, c) => s + c.labelIds.length, 0) +
      plan.compound.reduce((s, c) => s + c.labelIds.length, 0) +
      plan.unmatched.length,
    columnCount: plan.literal.length + plan.prefixGroup.length + plan.compound.length,
    unmatchedCount: plan.unmatched.length,
    literalExamples: plan.literal.map((c) => c.columnTitle).slice(0, 3),
    prefixExamples: plan.prefixGroup.map((c) => c.columnTitle).slice(0, 3),
    compoundExamples: plan.compound.map((c) => c.columnTitle).slice(0, 3),
    unmatchedExamples: plan.unmatched.map((u) => u.labelName).slice(0, 3),
  };
}
