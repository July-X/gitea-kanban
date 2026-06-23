/**
 * Git Graph renderer 端 legacy 入口
 *
 * 历史上这里暴露过“字符流 Parser”子系统；当前实现已经切到：
 *   - Go 端 `app/git/graph/layout.go` 输出结构化 nodes + edges
 *   - 前端 `structured.ts` 直接渲染 SVG
 *
 * 下面这些导出仅保留给旧代码/参考实现，不再是当前 Git Graph 主路径。
 *
 * legacy 子模块：
 *   - models.ts : Graph / Flow / Glyph / GitGraphCommit 数据模型
 *   - types.ts  : 与 main 端 IPC 协议共享的 DTO（GraphLine / GraphLineCommit / GitRef）
 *   - parser.ts : Parser 状态机（1:1 移植 Gitea parser.go）
 *   - svg.ts    : Glyph → SVG path d（1:1 移植 Gitea svgcontainer.tmpl）
 *
 * 渲染端集成示例：
 *
 *   import { parseLines, svgViewBox, svgWidthPx, svgHeightPx,
 *            flowColorClass, flowToPathD } from '@renderer/lib/gitgraph';
 *
 *   const { graph } = parseLines(lines);
 *   const viewBox = svgViewBox(graph);
 *   const width   = svgWidthPx(graph);
 *   const height  = svgHeightPx(graph);
 *
 *   <svg :viewBox="viewBox" :width="width" :height="height">
 *     <g v-for="flow in graph.flows.values()" :class="flowColorClass(flow.colorNumber)">
 *       <path :d="flowToPathD(flow)" fill="none" stroke-width="1" />
 *     </g>
 *     <!-- 圆点由前端按 graph.commits[i].row/column 单独画 -->
 *   </svg>
 */

export {
  // 模型 + 工具
  type Flow,
  type Glyph,
  type GitGraphCommit,
  type Graph,
  type RelationCommit,
  RELATION_COMMIT_ID,
  COL_WIDTH,
  ROW_HEIGHT,
  DISPLAY_SCALE,
  newGraph,
  newFlow,
  flowColorClass,
  graphWidth,
  graphHeight,
  svgViewBox,
  svgWidthPx,
  svgHeightPx,
  compactColumns,
} from './models.js';

// 与 main 端 IPC 协议共享的 DTO
export type { GitRef, RefGroup, GraphLine, GraphLineCommit, GraphLinesDto } from './types.js';

// Parser
export { Parser, parseGlyphs, addLineToGraph, parseLines } from './parser.js';

// v2.6：直接消费 Go GraphResultDto（nodes+edges+16 色），无需任何适配器
// 旧 adapter.ts / graphResultToGraph 已删除

// SVG 工具
export { glyphToPathD, flowToPathD } from './svg.js';
