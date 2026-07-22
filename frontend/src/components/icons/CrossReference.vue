<script setup lang="ts">
/**
 * octicon-bookmark 自定义 Vue 组件
 *
 * 用途：所有 timeline 引用类事件（commit_ref / issue_ref / pull_ref /
 *       change_issue_ref / add_dependency / remove_dependency 等）的 timeline dot icon
 *
 * v0.9.x 替换：原本用 octicon-cross-reference（方块+箭头），现改用 octicon-bookmark（书签）
 * —— 跟 lucide 的 Bookmark 形状一致，但路径 1:1 复刻 GitHub Primer octicon-bookmark SVG。
 *
 * SVG path 来源 user 给的 GitHub Primer octicon-bookmark：
 *   <path d="M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5
 *            a.75.75 0 0 1-1.227.579L8 11.722l-3.773 3.107A.751.751 0 0 1 3 14.25
 *            Zm1.75-.25a.25.25 0 0 0-.25.25v9.91l3.023-2.489a.75.75 0 0 1 .954 0
 *            l3.023 2.49V2.75a.25.25 0 0 0-.25-.25Z"></path>
 *
 * octicon 风格：用 fill="currentColor"（实心填色），不是 lucide 的 stroke 描边模式。
 * props.size / props.strokeWidth 保留跟 lucide 一样的接口兼容性（strokeWidth
 * 在 fill 模式下不影响渲染，模板里 <component :is="..." :size="13"
 * :stroke-width="2.5" /> 传过来不会报错）。
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
    <path d="M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5a.75.75 0 0 1-1.227.579L8 11.722l-3.773 3.107A.751.751 0 0 1 3 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.91l3.023-2.489a.75.75 0 0 1 .954 0l3.023 2.49V2.75a.25.25 0 0 0-.25-.25Z" />
  </svg>
</template>
