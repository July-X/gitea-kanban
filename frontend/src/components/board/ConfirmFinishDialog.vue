<script setup lang="ts">
/**
 * ConfirmFinishDialog —— 拖到"已完成"列二次确认（plan_25cc4562 Task D · BoardView 重构）
 *
 * 设计（v1 二次确认铁律）：
 * - 复用全局 ConfirmDialog，加 keyword="完成"防误触
 * - 危险标记（danger=true）：强调色边框 + 关键词 input
 * - description 文案必须含"关闭 gitea 议题"的人话说明
 *
 * 通信：props + emit
 *   - props.open       : 是否打开
 *   - props.issueIndex : 当前 issue index（description 拼文案用）
 *   - props.issueTitle : 当前 issue title
 *   - emit('update:open')  : 关闭
 *   - emit('confirm')       : 确认（父组件继续走"换列 + issues.update state=closed"）
 */
import ConfirmDialog from '@renderer/components/ConfirmDialog.vue';
import type { IssueCardDto } from '@renderer/types/dto';

interface Props {
  open: boolean;
  issue: IssueCardDto | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm'): void;
}>();

const description = (issue: IssueCardDto | null): string => {
  if (!issue) return '';
  return `把 #${issue.index}「${issue.title}」挪到「已完成」列会在 gitea端**关闭**该议题（不仅是换标签）。如果只是想改分组，请选其他列。`;
};
</script>

<template>
  <ConfirmDialog
    :open="props.open"
    title="标记为已完成？"
    :description="description(props.issue)"
    confirm-label="我了解风险，仍要标记完成"
    cancel-label="取消"
    :danger="true"
    confirm-keyword="完成"
    @update:open="(v) => emit('update:open', v)"
    @confirm="emit('confirm')"
  />
</template>
