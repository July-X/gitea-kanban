<script setup lang="ts">
/**
 * octicon-person 自定义 Vue 组件
 *
 * 用途：assignee 事件（指派 / 取消指派 / 自指派）timeline dot icon
 *
 * 选型原因（v0.7.46 user 拍板）：
 *   GitHub web 实际用的是 octicon-person（人头+身体，不带 +/- 符号），
 *   lucide 的 UserPlus / UserMinus 是带 + / - 符号的"增加/减少"含义。
 *   GitHub web 区分 add/remove 不靠 icon（icon 都是同一个人），
 *   靠 verb 文案区分（"指派给" / "取消了指派给" / "指派给自己"）。
 *   1:1 复刻 octicon 路径做组件，跟 CrossReference / OcticonGitBranch /
 *   OcticonGitMerge 同样的处理。
 *
 * SVG path 来自 user 06:58 给的 GitHub Primer octicon-person：
 *   <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1
 *            -1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07
 *            6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123
 *            0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
 *   （2 段 path 用 M 合并成 1 个 <path>：body + head）
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
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
  </svg>
</template>
