/**
 * drag-helper —— 看板鼠标拖拽（vue-draggable-plus）的纯函数适配层
 *
 * 用途（v1.3 拖拽链路 + v1.3.1 撤回键盘双模后）：
 * - 封装 `vue-draggable-plus` onEnd 事件 → board.moveIssue 入参
 * - 提供 `isFinishColumnByTitle`（拖到"已完成"列 = 二次确认 + 关闭 gitea issue）
 *
 * 设计约束（AGENTS.md §9.1 + OVERRIDE.md §本项目专属规则 #1）：
 * - **零术语**：本文件不写 UI 文本，纯函数 + 内部类型名
 * - **不依赖 Vue 运行时**：单元测试在 node 环境跑，**不**挂组件
 * - **不依赖 IPC**：返回 board.moveIssue 的入参，由 BoardView 调
 * - **不接 store**：保持纯函数可测；store 注入由 BoardView 负责
 *
 * 列内排序 v1 **不**接后端（gitea label 不存 position；store 端按 index 升序展示），
 * 拖拽仅为视觉占位。moveIssue 永远 append 到目标列末尾。
 *
 * 历史：v1.3 引入键盘双模（Space 拾起 / 方向键 / Space 放下），但 PM/设计师/运营等
 * 非技术受众几乎全部走鼠标路径，键盘双模的测试成本与 UX 价值不匹配。
 * v1.3.1 撤回键盘相关代码：`keyDownToColumn` / `KeyboardDragState` / `makeIdleKeyboardDrag`
 * 整个删除；保留鼠标拖拽路径（vue-draggable-plus）。
 */

import type { ColumnDto } from '@renderer/types/dto';

/** 拖拽结果（BoardView 用此触发 moveIssue） */
export interface DragMoveIntent {
  issueIndex: number;
  fromColumnId: string;
  toColumnId: string;
}

/** drag end 事件（vue-draggable-plus SortableEvent 精简版，纯函数只关心这 4 个） */
export interface DragEndEvent {
  /** 原列 id（来自 SortableEvent.from dataset） */
  fromColumnId: string;
  /** 目标列 id（来自 SortableEvent.to dataset；同列排序时 = fromColumnId） */
  toColumnId: string;
  /** 被拖的 issue 原始 index（来自 SortableEvent.item dataset） */
  issueIndex: number;
}

/**
 * 把 drag end 事件归一化为 moveIssue 入参。
 *
 * 规则：
 * - 同列内排序（fromColumnId === toColumnId）→ 返回 null（v1 不接后端）
 * - 跨列 → 返回 DragMoveIntent
 *
 * BoardView 拿这个返回值决定是否调 `board.moveIssue(...)`。
 */
export function mapDragEndToMoveIntent(event: DragEndEvent): DragMoveIntent | null {
  if (event.fromColumnId === event.toColumnId) return null;
  return {
    issueIndex: event.issueIndex,
    fromColumnId: event.fromColumnId,
    toColumnId: event.toColumnId,
  };
}

/**
 * 判断列是否是"已完成"语义（拖到该列 = 二次确认 + 关闭 gitea issue）
 *
 * 与 BoardView 旧版 isFinishColumn 行为一致：
 * - 标题（trim + toLowerCase）等于 "已完成" / "done" / "closed"
 * - 标题包含"完成"
 */
export function isFinishColumnByTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return t === '已完成' || t === 'done' || t === 'closed' || t.includes('完成');
}

/**
 * vue-draggable-plus 注入 VueDraggable 的 sortablejs 配置（v-bind 直接吃）
 *
 * 关键设计（v1.3 拍板 · 避免 vue-draggable-plus 乐观更新 vs board.moveIssue 乐观更新打架）：
 * - **不**传 v-model:list 给 VueDraggable → vue-draggable-plus 不动 store 的 issuesByColumn
 *   （Sortable 默认会改 DOM 列表，CSS 层面看像移动了，但下一帧 Vue 重新渲染会拉回原位置）
 *   → 这意味着**只有 store.moveIssue 的乐观更新说了算**，避免双源冲突
 * - 列内排序 v1 **不**接后端：mapDragEndToMoveIntent 同列返 null → 不调 store.moveIssue
 * - 列内拖动期间 Sortable 改 DOM 顺序的视觉效果是"占位"，松开后被 Vue 重渲染拉回
 *   → 注释里写明 v2 接 gitea label position 字段后再上
 *
 * sortablejs options（来自 sortabljs Options + vue-draggable-plus UseDraggableOptions）：
 * - group：跨列拖动必须同 group 名
 * - animation：150ms 平滑过渡
 * - ghost/chosen/dragging class：跟 src/renderer/styles/board-drag.css 联动
 * - forceFallback=false + fallbackOnBody=true：桌面 v1.3 不必支持触屏拖拽，但保持不依赖鼠标事件名硬编码
 *   （forceFallback=true 会强制 Sortable 自己的 pointer event 模拟，对触屏友好；v1.3 桌面不需要）
 * - scrollSensitivity：列边缘自动滚动灵敏度（20px，sortablejs 默认 30）
 */
export function columnDragOptions(_col: Pick<ColumnDto, 'id'>): Record<string, unknown> {
  return {
    group: 'kanban-cards',
    animation: 150,
    ghostClass: 'card--ghost',
    chosenClass: 'card--chosen',
    dragClass: 'card--dragging',
    forceFallback: false,
    fallbackOnBody: true,
    scrollSensitivity: 20,
  };
}

/** 从 vue-draggable-plus onEnd 事件（SortableEvent 精简版）抽 drag end 三元组
 *  - 从 evt.from / evt.to / evt.item DOM dataset 抽 columnId / issueIndex
 *  - 防御：dataset 缺失 / evt 整体为 null/undefined 返 null（caller 走"忽略"路径，不调 moveIssue） */
export function extractDragEndFromEvent(
  evt: unknown,
): { fromColumnId: string; toColumnId: string; issueIndex: number } | null {
  if (!evt || typeof evt !== 'object') return null;
  const e = evt as {
    from?: HTMLElement;
    to?: HTMLElement;
    item?: HTMLElement;
  };
  const fromColumnId = e.from?.dataset?.columnId ?? '';
  const toColumnId = e.to?.dataset?.columnId ?? '';
  const issueIndex = Number(e.item?.dataset?.issueIndex ?? NaN);
  if (!fromColumnId || !toColumnId || !Number.isFinite(issueIndex)) return null;
  return { fromColumnId, toColumnId, issueIndex };
}
