<script setup lang="ts">
/**
 * octicon-git-branch 自定义 Vue 组件
 *
 * 用途：delete_branch / restore_branch 事件的 timeline dot icon
 *
 * 选型原因（v0.7.42 user 拍板）：
 *   GitHub web 实际用的是 octicon-git-branch（3 个分支 + 3 个圆点
 *   的复杂图），lucide 的 GitBranch 是简单 2 端点的 T 形，形状差太多。
 *   跟 CrossReference 一样的处理：1:1 复刻 octicon 路径做组件。
 *
 * SVG path 来自 user 23:25 给的 GitHub Primer octicon-git-branch：
 *   <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1
 *            1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1
 *            1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25
 *            2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5
 *            0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75
 *            0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
 *
 * octicon 风格：fill="currentColor"（实心填色），不是 lucide 的 stroke 描边。
 * props.size / props.strokeWidth 保留跟 lucide 一样的接口兼容性
 * （strokeWidth 在 fill 模式下不影响渲染，模板里 <component :is="..."
 * :size="13" :stroke-width="2.5" /> 传过来不会报错）。
 */
defineProps<{
  size?: number | string
  strokeWidth?: number | string
}>()
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
  </svg>
</template>
