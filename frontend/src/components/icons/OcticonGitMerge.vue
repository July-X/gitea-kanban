<script setup lang="ts">
/**
 * octicon-git-merge 自定义 Vue 组件
 *
 * 用途：merge event timeline dot icon + Closed with unmerged commits 面板 icon
 *
 * 选型原因（v0.7.45 user 拍板）：
 *   GitHub web 实际用的是 octicon-git-merge（3 外圆 + 3 内点 + merge 路径
 *   + 底部弧线 + 垂直线），lucide 的 GitMerge 是简化版（缺 3 外圆+底部弧线），
 *   视觉差异大。1:1 复刻 octicon 路径做组件，跟 CrossReference /
 *   OcticonGitBranch 同样的处理。
 *
 * SVG path 来自 user 23:38 / 06:50 给的 GitHub Primer octicon-git-merge：
 *   <path d="M15 13.25a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm-12.5 6a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm0-14.5a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM5.75 6.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 6.5Zm0 14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 21Zm12.5-6a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 18.25 15ZM6.5 7.25c0 2.9 2.35 5.25 5.25 5.25h4.5V14h-4.5A6.75 6.75 0 0 1 5 7.25ZM5.75 16.75A.75.75 0 0 1 5 16V8a.75.75 0 0 1 1.5 0v8a.75.75 0 0 1-.75.75Z" />传过来还是会按 13px 缩放（保持跟 timeline dot 其他
 * icon 大小一致）。
 *
 * octicon 风格：fill="currentColor"（实心填色），不是 lucide 的 stroke 描边。
 * props.size / props.strokeWidth 保留跟 lucide 一样的接口兼容性
 * （strokeWidth 在 fill 模式下不影响渲染）。
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
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M15 13.25a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm-12.5 6a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm0-14.5a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM5.75 6.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 6.5Zm0 14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 21Zm12.5-6a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 18.25 15ZM6.5 7.25c0 2.9 2.35 5.25 5.25 5.25h4.5V14h-4.5A6.75 6.75 0 0 1 5 7.25ZM5.75 16.75A.75.75 0 0 1 5 16V8a.75.75 0 0 1 1.5 0v8a.75.75 0 0 1-.75.75Z" />
  </svg>
</template>
