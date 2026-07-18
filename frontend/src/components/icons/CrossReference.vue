<script setup lang="ts">
/**
 * octicon-cross-reference 自定义 Vue 组件
 *
 * 用途：mentioned / 引用事件（issue_ref / pull_ref / change_issue_ref /
 *       add_dependency / remove_dependency 等）的 timeline dot icon
 *
 * 选型原因（v0.7.41 user 拍板）：
 *   GitHub web 实际用的是 octicon-cross-reference（方块 + 箭头），
 *   lucide 没同名 icon，最近的 Link / Link2 视觉上是 chain link（圆环链），
 *   跟 cross-reference 形状差太多。1:1 复刻 octicon 路径最稳。
 *
 * SVG path 来自 user 23:15 给的 GitHub Primer octicon-cross-reference：
 *   <path d="M2.75 3.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1
 *            .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2.5
 *            a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 13H9.06l-2.573 2.573A1.458
 *            1.458 0 0 1 4 14.543V13H2.75A1.75 1.75 0 0 1 1 11.25v-7.5C1 2.784 1.784 2
 *            2.75 2h5.5a.75.75 0 0 1 0 1.5ZM16 1.25v4.146a.25.25 0 0 1-.427.177L14.03
 *            4.03l-3.75 3.75a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l3.75
 *            -3.75-1.543-1.543A.25.25 0 0 1 11.604 1h4.146a.25.25 0 0 1 .25.25Z"/>
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
    <path d="M2.75 3.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 13H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 14.543V13H2.75A1.75 1.75 0 0 1 1 11.25v-7.5C1 2.784 1.784 2 2.75 2h5.5a.75.75 0 0 1 0 1.5ZM16 1.25v4.146a.25.25 0 0 1-.427.177L14.03 4.03l-3.75 3.75a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l3.75-3.75-1.543-1.543A.25.25 0 0 1 11.604 1h4.146a.25.25 0 0 1 .25.25Z" />
  </svg>
</template>
