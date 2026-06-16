<script setup lang="ts">
/**
 * TeamView —— v2 团队视图占位（v1 不实现）
 *
 * v1.4 user 拍板（2026-06-16 · ADR-0004）：
 *   - 当前路由**仅**作占位，不挂任何业务逻辑、不读任何 IPC、不跨仓库聚合
 *   - v2 拍板前**不**挂 NavRail 入口（避免诱导 user 切换）
 *   - 路由保留 = 未来 v2 团队视图实现时**不**用改路由表 / 不用动 NavRail
 *   - 设计边界：团队视图是独立 store / IPC 命名空间（**不**进 board/issue 等现有 namespace）
 *
 * 严禁在此 view 加：
 *   - 跨 project 拉取（违反 ADR-0004）
 *   - 新增 IPC 端点（v2 拍板前不实现）
 *   - NavRail 入口（v2 拍板前不暴露）
 *
 * a11y / 视觉：复用现有 EmptyState 组件，跟其他 view 的"暂无内容"空态一致
 */
import { useRouter } from 'vue-router';
import EmptyState from '@renderer/components/EmptyState.vue';

const router = useRouter();

/**
 * CTA：跳回 /board（user 落地后的合理下一步）
 * - 不做"看 ADR"链（file:// 协议下打开本地 md 不稳，链 GitHub 也得有 repo url）
 * - "看设计边界"信息已在 view 描述里写清楚
 */
function onBackToBoard(): void {
  void router.push({ name: 'board' });
}
</script>

<template>
  <div class="team">
    <EmptyState
      title="团队视图 · v2 拍板后实现"
      description="当前路由仅占位。v1.x 严格走单仓库专注模式（每个 view 只看一个 project），不跨仓库聚合——详见 ADR-0004（docs/adr/0004-single-repo-focus.md）。v2 团队视图将作为独立 store + IPC 命名空间实现，不进 board/issue 等现有 namespace。"
      action-label="回看板"
      @action="onBackToBoard"
    />
  </div>
</template>

<style scoped>
/**
 * v1 占位样式：跟现有 view 的"主区空态"布局一致（BoardView / MembersView 等）
 * 居中显示 EmptyState，不污染 NavRail / StatusBar
 */
.team {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: var(--space-5);
}
</style>
