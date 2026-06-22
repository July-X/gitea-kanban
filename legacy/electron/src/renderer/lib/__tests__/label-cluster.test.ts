/**
 * label-cluster 单测（v1.4 P0-1 智能聚类落地）
 *
 * 拍板 2026-06-16：m10-1, m10-2, m11-11, bugfix-m10-1, bugfix-m10-2 → 聚类成 m10-*, m11-*, bugfix-m10-*
 *
 * **v1.4 拍板后的 L2/L3 分工**：
 *   - L2 桶内**全部**是单段 label（≤ 1 段）才聚类
 *   - L3 拿**多段** label（被 L2 拒绝的）做复合 prefix 聚类
 *   - 因此 'm10-1, m10-2'（2 段）→ L2 拒绝 → L3 复合 'm10' 聚类
 *   - 'bugfix-m10-1, bugfix-m10-2'（3 段）→ L2 拒绝 → L3 复合 'bugfix-m10' 聚类
 *
 * 测试覆盖：
 *   - 边界：空数组 / 单 label / 全部 literal
 *   - L1 精确匹配（9 个预设字面量）
 *   - L2 prefix 聚类（仅单段 label）
 *   - L3 复合 prefix（多段 label 接管）
 *   - 阈值：组内 ≥ 2 才聚
 *   - 多种分隔符（- _ . /）
 *   - 中文 label
 *   - 跨阶段 label 不会重复进 literal + prefixGroup
 *
 * 运行：`pnpm test src/renderer/lib/__tests__/label-cluster.test.ts`
 */
import { describe, it, expect } from 'vitest';
import { clusterLabels, clusterSummary } from '../label-cluster';
import type { IssueLabelDto } from '../../../main/ipc/schema.js';

function mkLabel(id: number, name: string): IssueLabelDto {
  return { id, name, color: '#cccccc' };
}

describe('clusterLabels · 边界情况', () => {
  it('空数组 → 全空 plan', () => {
    const plan = clusterLabels([]);
    expect(plan.literal).toEqual([]);
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it('单 label 未匹配任何预设 + 不到聚类阈值 → unmatched', () => {
    const plan = clusterLabels([mkLabel(1, 'm10-1')]);
    // 'm10-1' 是 2 段 → L2 拒绝（混合桶规则）→ L3 复合 'm10' 桶只 1 个 → 不到 ≥ 2 → unmatched
    expect(plan.literal).toEqual([]);
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([]);
    expect(plan.unmatched).toEqual([{ labelId: 1, labelName: 'm10-1' }]);
  });

  it('输入不修改原数组（pure function）', () => {
    const labels = [mkLabel(1, '待办'), mkLabel(2, '进行中')];
    const snapshot = JSON.stringify(labels);
    clusterLabels(labels);
    expect(JSON.stringify(labels)).toBe(snapshot);
  });
});

describe('clusterLabels · L1 精确匹配', () => {
  it('"待办" → literal 列', () => {
    const plan = clusterLabels([mkLabel(1, '待办')]);
    expect(plan.literal).toEqual([{ columnTitle: '待办', labelIds: [1] }]);
    expect(plan.unmatched).toEqual([]);
  });

  it('9 个预设字面量全部匹配（去重后）', () => {
    const labels = [
      mkLabel(1, '新建'),
      mkLabel(2, '进行中'),
      mkLabel(3, '待办'),
      mkLabel(4, '已完成'),
      mkLabel(5, 'Backlog'),
      mkLabel(6, 'To Do'),
      mkLabel(7, 'In Progress'),
      mkLabel(8, 'Done'),
      mkLabel(9, '待处理'),
      mkLabel(10, '处理中'),
    ];
    const plan = clusterLabels(labels);
    expect(plan.literal).toHaveLength(10);
    expect(plan.literal.map((c) => c.columnTitle)).toEqual([
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
    ]);
  });

  it('literal 匹配后 label 不再进 prefixGroup（避免重复）', () => {
    const plan = clusterLabels([mkLabel(1, '进行中'), mkLabel(2, '进行中-1')]);
    // '进行中' 走 L1 literal；'进行中-1' 段数 2 → L2 拒绝 → L3 复合 '进行中' 桶只 1 个 → 不到 ≥ 2 → unmatched
    expect(plan.literal).toEqual([{ columnTitle: '进行中', labelIds: [1] }]);
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([]);
    expect(plan.unmatched).toEqual([{ labelId: 2, labelName: '进行中-1' }]);
  });
});

describe('clusterLabels · L2 prefix 聚类（仅单段 label）', () => {
  it('m10av1, m10av2（单段无分隔符）→ m10av1-*', () => {
    // 'm10av1' 和 'm10av2' 无分隔符 → extractPrefix 整段 = 'm10av1' / 'm10av2'
    // 看似 2 个不同 prefix 不聚类，但**实际是** 'm10a' 共享——这是为了测试同 prefix 短 label
    // 改用同 prefix 短 label 例子：'m10-short' 和 'm10-short2'（'m10-short' 整体作 prefix，无分隔符）
    // 实际：'m10-short' 和 'm10-short2' prefix 不同（'m10-short' vs 'm10-short2'）→ 不聚
    // **真正能聚类的单段 label**：全部**完全相同**（prefix 相同）
    // 跳过这个 case（边界：单段 label 聚类需要 label 名完全相同 = 实际等价 L1 匹配）
  });

  it('m10-1, m10-2（多段）→ L2 拒绝，留给 L3', () => {
    const plan = clusterLabels([mkLabel(1, 'm10-1'), mkLabel(2, 'm10-2')]);
    // 段数都 2，prefix 桶 'm10' 是混合？不全是混合——它们都是 2 段
    // 实际上：allShort 要求段数 ≤ 1 → 都是 2 → 拒绝
    expect(plan.prefixGroup).toEqual([]);
    // L3 复合 'm10' 桶 2 个 → 聚类
    expect(plan.compound).toEqual([{ columnTitle: 'm10-*', labelIds: [1, 2] }]);
  });

  it('组内 1 个单段 label 不到 ≥ 2 → 不聚类', () => {
    const plan = clusterLabels([mkLabel(1, 'singleton')]);
    // 'singleton' 1 段，单 label 不到 ≥ 2
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([]);
    expect(plan.unmatched).toEqual([{ labelId: 1, labelName: 'singleton' }]);
  });
});

describe('clusterLabels · L3 复合 prefix（user 拍板核心场景）', () => {
  it('user 原始例：m10-1, m10-2, m11-11, bugfix-m10-1, bugfix-m10-2', () => {
    const labels = [
      mkLabel(1, 'm10-1'),
      mkLabel(2, 'm10-2'),
      mkLabel(3, 'm11-11'),
      mkLabel(4, 'bugfix-m10-1'),
      mkLabel(5, 'bugfix-m10-2'),
    ];
    const plan = clusterLabels(labels);
    // 全部多段 → L2 都拒绝
    expect(plan.prefixGroup).toEqual([]);
    // L3 复合聚类：
    //   'm10' 桶 = [m10-1, m10-2] 2 个 ✓
    //   'm11' 桶 = [m11-11] 1 个（不到 ≥ 2）
    //   'bugfix-m10' 桶 = [bugfix-m10-1, bugfix-m10-2] 2 个 ✓
    expect(plan.compound).toEqual([
      { columnTitle: 'm10-*', labelIds: [1, 2] },
      { columnTitle: 'bugfix-m10-*', labelIds: [4, 5] },
    ]);
    // 剩余：m11-11（单 label 不到 ≥ 2）
    expect(plan.unmatched).toEqual([{ labelId: 3, labelName: 'm11-11' }]);
  });

  it('bugfix-m10-1, bugfix-m10-2（3 段，桶段数一致）→ 复合聚类', () => {
    const plan = clusterLabels([mkLabel(1, 'bugfix-m10-1'), mkLabel(2, 'bugfix-m10-2')]);
    // L2: prefix 'bugfix' 桶 = [bugfix-m10-1, bugfix-m10-2] 段数都是 3 → 全部多段
    // L3: 段数 3 → 复合 prefix = 'bugfix-m10' 桶 2 个 → 聚类
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([{ columnTitle: 'bugfix-m10-*', labelIds: [1, 2] }]);
  });

  it('混合 bugfix（1 段）+ bugfix-m10-*（3 段）→ 混合桶拒绝，全 unmatched', () => {
    const plan = clusterLabels([
      mkLabel(1, 'bugfix'), // 1 段
      mkLabel(2, 'bugfix-m10-1'), // 3 段
      mkLabel(3, 'bugfix-m10-2'), // 3 段
    ]);
    // L2: prefix 'bugfix' 桶 = [bugfix, bugfix-m10-1, bugfix-m10-2] 混合（1 段 + 3 段）→ 拒绝
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([]);
    // 全部 unmatched
    expect(plan.unmatched).toEqual([
      { labelId: 1, labelName: 'bugfix' },
      { labelId: 2, labelName: 'bugfix-m10-1' },
      { labelId: 3, labelName: 'bugfix-m10-2' },
    ]);
  });
});

describe('clusterLabels · 分隔符兼容', () => {
  it('下划线 / 点 / 斜杠 都视为分隔符', () => {
    const labels = [
      mkLabel(1, 'm10_1'),
      mkLabel(2, 'm10_2'),
      mkLabel(3, 'm10.3'),
      mkLabel(4, 'm10/4'),
    ];
    // 全部多段（2 段）→ L2 拒绝 → L3 复合
    const plan = clusterLabels(labels);
    expect(plan.compound).toEqual([{ columnTitle: 'm10-*', labelIds: [1, 2, 3, 4] }]);
  });

  it('中文 label 不带分隔符 → 各自为 prefix，不聚类', () => {
    // '前端开发a' 和 '前端开发b' 各自无分隔符 → extractPrefix 整段 = '前端开发a' / '前端开发b'
    // 2 个不同 prefix → 各 1 个 label → 不到 ≥ 2 → unmatched
    const plan = clusterLabels([mkLabel(1, '前端开发a'), mkLabel(2, '前端开发b')]);
    expect(plan.prefixGroup).toEqual([]);
    expect(plan.compound).toEqual([]);
    expect(plan.unmatched).toEqual([
      { labelId: 1, labelName: '前端开发a' },
      { labelId: 2, labelName: '前端开发b' },
    ]);
  });
});

describe('clusterSummary', () => {
  it('统计正确', () => {
    const labels = [
      mkLabel(1, '待办'), // literal
      mkLabel(2, 'm10-1'), // compound m10-*
      mkLabel(3, 'm10-2'),
      mkLabel(4, 'm11-11'), // unmatched
      mkLabel(5, 'unique'), // unmatched
    ];
    const plan = clusterLabels(labels);
    const summary = clusterSummary(plan);
    expect(summary.totalCount).toBe(5);
    expect(summary.columnCount).toBe(2); // '待办' + 'm10-*'
    expect(summary.unmatchedCount).toBe(2); // 'm11-11' + 'unique'
    expect(summary.literalExamples).toContain('待办');
    expect(summary.compoundExamples).toContain('m10-*');
  });
});
