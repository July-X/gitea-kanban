/**
 * board store ——看板列 + issue卡片（ADR-0002 reset）
 *
 * 设计（AGENTS §5.2 + ADR-0002 +03-frontend §4.5）：
 * -看板列走 `board.columns.*`（本地 sqlite实体）
 * -卡片走 `issues.*`（gitea issue，column_label_mapping派生）
 * -拖拽换列 = `issues.moveColumn`（后端原子换绑 label）
 * - **v1 不**做真拖拽（用按钮式换列，避免 vuedraggable越权）
 * -撤销栈 =纯前端 UI 层 ref（最近 N 次换列记录 + 反向调 moveColumn）
 * 后端 src/main/board/undo.ts已被 reset 删除；sqlite undo_entries 表保留但暂未接 IPC
 *
 *边界：
 * - **不**做跨 project看板切换缓存（每次切 project重新拉）
 * - **不**过滤合并请求（isPullRequest=true 也作为卡片展示，让 PM看到完整工作流）
 * （合并请求也在 gitea /issues列表里，与 issue 一致处理；v2看板列区分）
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
 boardColumnsList,
 issuesCreate,
 issuesList,
 issuesMoveColumn,
 issuesUpdate,
 labelsList,
} from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type {
 ColumnDto,
 IssueCardDto,
 IssueLabelDto,
 ListIssuesResp,
} from '../../main/ipc/schema.js';

/**撤销栈单条记录（前端 UI 层纯 ref，**不**持久化） */
interface UndoEntry {
 issueIndex: number;
 fromColumnId: string;
 toColumnId: string;
 ts: number;
}

const UNDO_STACK_LIMIT =20;

export const useBoardStore = defineStore('board', () => {
 // ===== state =====
 const columns = ref<ColumnDto[]>([]);
 const issuesByColumn = ref<Record<string, IssueCardDto[]>>({});
 const labelsByProject = ref<IssueLabelDto[]>([]);
 const loading = ref(false);
 const loadingIssues = ref<Set<string>>(new Set());
 const error = ref<UserFacingError | null>(null);
 /**记录上一次加载的 projectId，避免切 project残留旧数据 */
 const currentProjectId = ref<string | null>(null);
 /**换列撤销栈（纯前端 UI ref；后端 undo端点 M3 未提供） */
 const undoStack = ref<UndoEntry[]>([]);

 // ===== getters =====
 /**所有 issue 总数（跨列累加） */
 const totalIssues = computed(() =>
 Object.values(issuesByColumn.value).reduce((sum, arr) => sum + arr.length,0),
 );
 /**取某列 issue（按 index升序，让新 issue 在末尾） */
 function issuesOf(columnId: string): IssueCardDto[] {
 return issuesByColumn.value[columnId] ?? [];
 }
 /**根据 issueIndex找所在列 id */
 function findIssueColumnId(issueIndex: number): string | null {
 for (const [colId, issues] of Object.entries(issuesByColumn.value)) {
 if (issues.some((i) => i.index === issueIndex)) return colId;
 }
 return null;
 }
 /**某列绑的 label ids（去重扁平） */
 function labelIdsOf(columnId: string): number[] {
 const col = columns.value.find((c) => c.id === columnId);
 if (!col) return [];
 const ids = new Set<number>();
 for (const lab of col.labels) ids.add(lab.id);
 return Array.from(ids);
 }
 /**找某 issue 当前 labels里的"列绑 label ids"交集（用于确定它在哪个列里） */
 function columnIdFromIssueLabels(issue: IssueCardDto): string | null {
 const issueLabelIds = new Set(issue.labels.map((l) => l.id));
 for (const col of columns.value) {
 const colLabelIds = col.labels.map((l) => l.id);
 if (colLabelIds.length ===0) continue;
 if (colLabelIds.every((id) => issueLabelIds.has(id))) return col.id;
 }
 return null;
 }

 // ===== actions =====

 /**
 *加载某 project 的看板：列 + 每列 issue + 项目级 label列表
 *
 *流程：
 *1.拉 columns（本地 sqlite）
 *2.拉 labels（gitea仓库 label列表）——看板列绑 label 用
 *3.拉全量 open issue（不走 columnId过滤，**前端**按 labels交集归类到列）
 *
 * 为何不用 `issues.list({ columnId })`？
 * - 后端按 column_label_mapping过滤，可能漏掉新绑 label 的 issue（gitea issue同步有延迟）
 * - 前端用 issue.labels ∩ column.labels自行归类，更稳
 */
 async function loadBoard(projectId: string): Promise<void> {
 loading.value = true;
 error.value = null;
 try {
 const cols = (await boardColumnsList({ projectId })) as ColumnDto[];
 columns.value = cols;
 currentProjectId.value = projectId;
 issuesByColumn.value = Object.fromEntries(cols.map((c) => [c.id, []]));
 // 并行拉 labels + 全量 open issue（受 gitea API速率限制，量小没事）
 const [labelsResp, issuesResp] = await Promise.all([
 labelsList({ projectId, limit:100, page:1 }) as Promise<{ items: IssueLabelDto[]; hasMore: boolean }>,
 issuesList({ projectId, state: 'open', limit:100, page:1 }) as Promise<ListIssuesResp>,
 ]);
 labelsByProject.value = labelsResp.items;
 //归类：按 issue.labels跟 column.labels交集放列；未匹配的丢进"未分类"
 const byCol: Record<string, IssueCardDto[]> = Object.fromEntries(cols.map((c) => [c.id, []]));
 for (const issue of issuesResp.items) {
 const colId = matchIssueToColumn(issue, cols);
 if (colId) byCol[colId]!.push(issue);
 }
 issuesByColumn.value = byCol;
 } catch (e) {
 error.value = e as UserFacingError;
 throw e;
 } finally {
 loading.value = false;
 }
 }

 /**
 * 把 issue归类到某个 column（按 labels交集）
 * 返回 null 表示没匹配到任何列（"未分类"状态，v1 不渲染）
 */
 function matchIssueToColumn(issue: IssueCardDto, cols: ColumnDto[]): string | null {
 const issueLabelIds = new Set(issue.labels.map((l) => l.id));
 for (const col of cols) {
 const colLabelIds = col.labels.map((l) => l.id);
 if (colLabelIds.length ===0) continue;
 if (colLabelIds.every((id) => issueLabelIds.has(id))) return col.id;
 }
 return null;
 }

 /**
 *单独刷新某列的 issue（新建 / 删除 /换列后调）
 */
 async function refreshColumn(projectId: string, columnId: string): Promise<void> {
 loadingIssues.value.add(columnId);
 try {
 const resp = (await issuesList({
 projectId,
 state: 'open',
 limit:100,
 page:1,
 })) as ListIssuesResp;
 const col = columns.value.find((c) => c.id === columnId);
 const byCol: Record<string, IssueCardDto[]> = { ...issuesByColumn.value };
 for (const c of columns.value) byCol[c.id] = [];
 for (const issue of resp.items) {
 const cid = columnIdFromIssueLabels(issue);
 if (cid) byCol[cid]!.push(issue);
 }
 //防御：col 不存在时清空
 if (!col) {
 delete byCol[columnId];
 }
 issuesByColumn.value = byCol;
 } catch (e) {
 error.value = e as UserFacingError;
 throw e;
 } finally {
 loadingIssues.value.delete(columnId);
 }
 }

 /**
 * 新建 issue（**看板列绑 label 时**自动带上 column绑的 label）
 */
 async function createIssue(args: {
 projectId: string;
 columnId: string;
 title: string;
 body?: string;
 }): Promise<IssueCardDto> {
 error.value = null;
 try {
 const labelIds = labelIdsOf(args.columnId);
 const issue = (await issuesCreate({
 projectId: args.projectId,
 title: args.title,
 ...(args.body !== undefined ? { body: args.body } : {}),
 ...(labelIds.length >0 ? { labelIds } : {}),
 })) as IssueCardDto;
 //追加到本地（不动其他列）
 const existing = issuesByColumn.value[args.columnId] ?? [];
 issuesByColumn.value = {
 ...issuesByColumn.value,
 [args.columnId]: [...existing, issue],
 };
 return issue;
 } catch (e) {
 error.value = e as UserFacingError;
 throw e;
 }
 }

 /**
 *换列（**按钮式**调 issues.moveColumn —— 后端原子换绑 label）
 *
 *流程：
 *1.乐观更新：本地把 issue 从 fromColumn挪到 toColumn
 *2.调 main端 moveColumn
 *3.失败回滚 +抛 UserFacingError
 *4.成功 →记录撤销栈（最近 N 条）
 *
 *边界：**不**做位置拖拽（toPosition 没传），issue永远按 index排到目标列末尾
 */
 async function moveIssue(args: {
 projectId: string;
 issueIndex: number;
 fromColumnId: string;
 toColumnId: string;
 }): Promise<void> {
 if (args.fromColumnId === args.toColumnId) return; //no-op
 const fromList = (issuesByColumn.value[args.fromColumnId] ?? []).filter(
 (i) => i.index !== args.issueIndex,
 );
 const issue = (issuesByColumn.value[args.fromColumnId] ?? []).find(
 (i) => i.index === args.issueIndex,
 );
 if (!issue) {
 throw {
 code: 'not_found',
 messageText: '找不到内容：议题已不存在',
 hint: '请刷新看板',
 recoverable: false,
 } satisfies UserFacingError;
 }
 const toList = [...(issuesByColumn.value[args.toColumnId] ?? []), issue];
 //乐观更新
 issuesByColumn.value = {
 ...issuesByColumn.value,
 [args.fromColumnId]: fromList,
 [args.toColumnId]: toList,
 };
 try {
 await issuesMoveColumn(args);
 //记录撤销栈
 pushUndo({
 issueIndex: args.issueIndex,
 fromColumnId: args.fromColumnId,
 toColumnId: args.toColumnId,
 ts: Date.now(),
 });
 } catch (e) {
 //失败回滚
 issuesByColumn.value = {
 ...issuesByColumn.value,
 [args.fromColumnId]: [...(issuesByColumn.value[args.fromColumnId] ?? []), issue].sort(
 (a, b) => a.index - b.index,
 ),
 [args.toColumnId]: (issuesByColumn.value[args.toColumnId] ?? []).filter(
 (i) => i.index !== args.issueIndex,
 ),
 };
 error.value = e as UserFacingError;
 throw e;
 }
 }

 /**
 * 删除 issue（**v1走 issues.update({ state: 'closed' }）** —— gitea1.x 没 DELETE issue API）
 *
 *二次确认由 UI 层（BoardView）触发，本函数**不**弹确认。
 */
 async function closeIssue(args: { projectId: string; issueIndex: number }): Promise<void> {
 const colId = findIssueColumnId(args.issueIndex);
 if (!colId) return; // 已经不在看板里
 const before = issuesByColumn.value[colId] ?? [];
 const issue = before.find((i) => i.index === args.issueIndex);
 //乐观移除
 issuesByColumn.value = {
 ...issuesByColumn.value,
 [colId]: before.filter((i) => i.index !== args.issueIndex),
 };
 try {
 await issuesUpdate({
 projectId: args.projectId,
 issueIndex: args.issueIndex,
 patch: { state: 'closed' },
 });
 } catch (e) {
 // 回滚
 issuesByColumn.value = {
 ...issuesByColumn.value,
 [colId]: [...(issuesByColumn.value[colId] ?? []), issue!].sort((a, b) => a.index - b.index),
 };
 error.value = e as UserFacingError;
 throw e;
 }
 }

 // =====撤销栈（纯前端 UI 层） =====

 function pushUndo(entry: UndoEntry): void {
 undoStack.value = [...undoStack.value, entry].slice(-UNDO_STACK_LIMIT);
 }

 function canUndo(): boolean {
 return undoStack.value.length >0;
 }

 /**撤销最近一次换列 */
 async function undoLastMove(projectId: string): Promise<void> {
 const entry = undoStack.value[undoStack.value.length -1];
 if (!entry) return;
 await moveIssue({
 projectId,
 issueIndex: entry.issueIndex,
 fromColumnId: entry.toColumnId,
 toColumnId: entry.fromColumnId,
 });
 undoStack.value = undoStack.value.slice(0, -1);
 }

 function clearError(): void {
 error.value = null;
 }

 return {
 // state
 columns,
 issuesByColumn,
 labelsByProject,
 loading,
 loadingIssues,
 error,
 currentProjectId,
 undoStack,
 // getters
 totalIssues,
 issuesOf,
 findIssueColumnId,
 labelIdsOf,
 // actions
 loadBoard,
 refreshColumn,
 createIssue,
 moveIssue,
 closeIssue,
 pushUndo,
 canUndo,
 undoLastMove,
 clearError,
 };
});
