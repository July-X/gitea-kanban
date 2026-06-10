<script setup lang="ts">
/**
 * CommitNode —— X6 自定义节点（Vue SFC 形态）
 *
 * 设计（AGENTS §8.4 + 03-frontend §5.3 + 5.6）：
 *   - 普通 commit = 圆点 + lane 色填充 + hover 变亮
 *   - 合并 commit = 菱形 + 强调橙填充
 *   - 关联卡片 = 2px 黄色描边（visualizer 业务信号）
 *   - 文案：短 sha + 关联卡片数（hover 出现）
 *   - **不**用 attr 处理器写 cursor/pointer-events（CSS 属性透不过去）→ 走 CSS 选择器
 *
 * X6 vue shape 桥接包默认注入 { node, graph } props；这里只用 node
 */
import { computed } from 'vue';
import type { Node } from '@antv/x6';
import type { CommitNode as CommitNodeDto } from '../../main/ipc/schema.js';

const props = defineProps<{
  node: Node;
}>();

const data = computed<CommitNodeDto>(() => props.node.getData() as CommitNodeDto);
const isMerge = computed(() => data.value.parents.length > 1);
const hasLinkedCards = computed(() => data.value.linkedCardIds.length > 0);
const fillColor = computed(() => (isMerge.value ? '#F76707' : '#609926'));
</script>

<template>
  <g class="commit-node" :class="{ 'commit-node--merge': isMerge, 'commit-node--linked': hasLinkedCards }">
    <circle
      v-if="!isMerge"
      class="commit-node__dot"
      r="6"
      :fill="fillColor"
      :stroke="hasLinkedCards ? '#E8B954' : 'transparent'"
      stroke-width="2"
    />
    <polygon
      v-else
      class="commit-node__diamond"
      points="0,-7 7,0 0,7 -7,0"
      :fill="fillColor"
      :stroke="hasLinkedCards ? '#E8B954' : 'transparent'"
      stroke-width="2"
    />
    <text class="commit-node__sha" y="-12" text-anchor="middle">{{ data.shortSha }}</text>
  </g>
</template>

<style scoped>
/* AGENTS §8.4 铁律：cursor/pointer-events 等 CSS 属性**不**走 attr 处理器
   必须用 CSS 选择器在 <style scoped> 写 */
.commit-node {
  cursor: pointer;
  transition: transform var(--t-fast) var(--ease);
  transform-origin: center;
  transform-box: fill-box;
}

.commit-node:hover {
  transform: scale(1.3);
}

.commit-node__dot,
.commit-node__diamond {
  transition: filter var(--t-fast) var(--ease);
}

.commit-node:hover .commit-node__dot,
.commit-node:hover .commit-node__diamond {
  filter: drop-shadow(0 0 6px currentColor);
}

.commit-node__sha {
  font-size: 9px;
  font-family: var(--font-mono);
  fill: var(--color-text-secondary);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease);
}

.commit-node:hover .commit-node__sha {
  opacity: 1;
}

.commit-node--merge .commit-node__sha {
  fill: var(--color-accent);
  font-weight: 500;
}
</style>
