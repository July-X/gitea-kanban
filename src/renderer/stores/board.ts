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
  boardColumnsCreate,
  boardColumnsDelete,
  boardColumnsList,
  boardColumnsMapLabel,
  boardColumnsUnmapLabel,
  boardColumnsUpdate,
  issuesAddLabel,
  issuesCreate,
  issuesList,
  issuesMoveColumn,
  issuesUpdate,
  labelsList,
  getIpcClient,
} from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type {
  ColumnDto,
  IssueCardDto,
  IssueLabelDto,
} from '../../main/ipc/schema.js';

/** loadBoard 出参契约（plan_25cc4562 Task C · autoInit 透明化）
 *
 * - `columns`         : 当前 project 实际生效的列（autoInit 触发后含新建列）
 * - `autoInitCreatedCount` : autoInit 帮建的列数（>0 时 UI 应弹 toast 透明化提示）
 *                          · 0 列 + gitea 无 label → 0（不弹 toast，避免"啥都没干"误报）
 *                          · 0 列 + gitea 有 label → >0（已自动建好）
 *                          · N 列 → 0（已建过不干预）
 *                          · loadBoard 抛错 → 0（错误优先）
 */
export interface LoadBoardResult {
  columns: ColumnDto[];
  autoInitCreatedCount: number;
}

/** undo / redo 栈深度（来自 main 端 src/main/board/undo.ts）
 *
 *  M6 undo-by-project：单一 source of truth 在 main 进程；渲染端**不**维护本地栈
 *  - undoSize: 当前 projectId 的 undo 栈深度（>0 时可点撤销）
 *  - redoSize: 当前 projectId 的 redo 栈深度（>0 时可点重做）
 *  - 切 project 时 loadUndoStatus(projectId) 重新拉
 *  - moveIssue / undo / redo 后 loadUndoStatus(projectId) 重新拉
 */
const undoSize = ref(0);
const redoSize = ref(0);

export const useBoardStore = defineStore('board', () => {
 // ===== state =====
 const columns = ref<ColumnDto[]>([]);
 const issuesByColumn = ref<Record<string, IssueCardDto[]>>({});
 /** 未归到任何列的 issue（没带任何"列绑 label"的 issue）——给用户可见出口 */
 const unassignedIssues = ref<IssueCardDto[]>([]);
 const labelsByProject = ref<IssueLabelDto[]>([]);
 const loading = ref(false);
 const loadingIssues = ref<Set<string>>(new Set());
 const error = ref<UserFacingError | null>(null);
 /**记录上一次加载的 projectId，避免切 project残留旧数据 */
 const currentProjectId = ref<string | null>(null);
 /**换列撤销栈（M6 undo-by-project：main 端为 single source of truth）
 *  保留占位以避免改动其他位置；UI 通过 undoSize / redoSize 显示状态 */
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
 // OR 语义：与 matchIssueToColumn 保持一致
 if (colLabelIds.some((id) => issueLabelIds.has(id))) return col.id;
 }
 return null;
 }

 // ===== actions =====

 /**
 *加载某 project 的看板：列 + 每列 issue + 项目级 label列表
 *
 *流程：
 *1.拉 columns（本地 localStore）
 *2.拉 labels（gitea仓库 label列表）——看板列绑 label 用
 *3.拉全量 open issue（不走 columnId过滤，**前端**按 labels交集归类到列）
 *4.**自动初始化**：如果项目没有任何列，根据 gitea label 自动创建默认看板列并绑定
 *
 * 为何不用 `issues.list({ columnId })`？
 * - 后端按 column_label_mapping过滤，可能漏掉新绑 label 的 issue（gitea issue同步有延迟）
 * - 前端用 issue.labels ∩ column.labels自行归类，更稳
 *
 * 自动初始化策略（2026-06-15 新增）：
 * - 新用户首次使用看板时，项目没有列也没有 label 映射
 * - 此时看板显示空状态 "还没有看板列"，用户体验极差
 * - 修复：检测到 0 列 + gitea 有 label 时，自动按 label 名创建列并绑定
 * - 匹配规则：gitea label 名精确匹配预设列名（新建/进行中/待办/已完成/Backlog/In Progress/To Do/Done）
 * - 只在首次（0 列）时触发，用户已手动创建列后不再自动干预
 *
 * 出参 `LoadBoardResult`（plan_25cc4562 Task C · autoInit 透明化）：
 * - `columns` 跟 store.columns 同步——autoInit 触发后含新建列
 * - `autoInitCreatedCount` = 本次 autoInit 帮建的列数
 *   · 0 列 + gitea 无 label → 0（**不**弹 toast，避免"啥都没干"误报）
 *   · 0 列 + gitea 有 label → >0（弹 toast 含具体数字 + "（点击列名可改名 / 解绑）"）
 *   · N 列 → 0（已建过不干预，不弹 toast）
 *   · 抛错 → 0（错误优先，错误走 board.error）
 */
  async function loadBoard(projectId: string): Promise<LoadBoardResult> {
  loading.value = true;
  error.value = null;
  // 局部变量：成功路径才返给 caller；catch 路径返 0 列 + 0 计数（避免 undefined 引用）
  let resultColumns: ColumnDto[] = [];
  let resultAutoInitCount = 0;
  try {
  let cols = await boardColumnsList({ projectId });
  currentProjectId.value = projectId;

  // 并行拉 labels + 全量 open issue（受 gitea API速率限制，量小没事）
  const [labelsResp, issuesResp] = await Promise.all([
  labelsList({ projectId, limit:100, page:1 }),
  issuesList({ projectId, state: 'open', limit:100, page:1 }),
  ]);
  labelsByProject.value = labelsResp.items;

  // === 自动初始化：0 列 + gitea 有可匹配 label → 自动创建列并绑定 ===
  if (cols.length === 0 && labelsResp.items.length > 0) {
  const autoResult = await autoInitColumns(projectId, labelsResp.items);
  resultAutoInitCount = autoResult.length;
  if (autoResult.length > 0) {
  // 重新拉列（后端已写入 localStore；createColumn 已把 cols 同步进 store.columns，
  // 这里再拉一次拿绑 label 后的真实 labels 数据）
  cols = await boardColumnsList({ projectId });
  }
  }

  columns.value = cols;
  resultColumns = cols;
  issuesByColumn.value = Object.fromEntries(cols.map((c) => [c.id, []]));
  //归类：按 issue.labels跟 column.labels交集放列；未匹配的进 unassignedIssues
  const byCol: Record<string, IssueCardDto[]> = Object.fromEntries(cols.map((c) => [c.id, []]));
  const unassigned: IssueCardDto[] = [];
  for (const issue of issuesResp.items) {
  const colId = matchIssueToColumn(issue, cols);
  if (colId) byCol[colId]!.push(issue);
  else unassigned.push(issue);
  }
  issuesByColumn.value = byCol;
  unassignedIssues.value = unassigned;
  return { columns: resultColumns, autoInitCreatedCount: resultAutoInitCount };
  } catch (e) {
  error.value = normalizeError(e);
  throw e;
  } finally {
  loading.value = false;
  }
  }

 /**
 * 自动初始化看板列：当项目没有任何列时，根据 gitea label 自动创建并绑定
 *
 * 策略：
 * 1. 预设列名列表（中文优先，英文兜底）
 * 2. 在 gitea label 中找匹配项（精确匹配名称）
 * 3. 每个匹配到的 label → 创建同名列 → 绑定该 label
 * 4. 如果没有任何匹配，不创建任何列（避免创建无用的空列）
 *
 * @returns 新创建的列数组
 */
 async function autoInitColumns(
 projectId: string,
 giteaLabels: IssueLabelDto[],
 ): Promise<ColumnDto[]> {
 // 预设列名 → 按优先级匹配（第一个匹配到的 label 绑到该列）
 // 同一个 label 只能绑一列，所以用 Set 追踪已使用的 label
 const presetColumns = [
 // 中文常见看板列名
 '新建', '进行中', '待办', '已完成',
 // 英文常见看板列名
 'Backlog', 'To Do', 'In Progress', 'Done',
 // 其他常见
 '待处理', '处理中', '已完成',
 ];
 const usedLabelIds = new Set<number>();
 const createdCols: ColumnDto[] = [];

 for (const presetName of presetColumns) {
 const matchedLabel = giteaLabels.find(
 (l) => l.name === presetName && !usedLabelIds.has(l.id),
 );
 if (!matchedLabel) continue;

 // 创建列
 try {
 const col = await createColumn({ projectId, title: presetName });
 // 绑定 label
 try {
 await mapLabelToColumn({
 columnId: col.id,
 giteaLabelId: matchedLabel.id,
 giteaLabelName: matchedLabel.name,
 });
 } catch {
 // 绑定失败不阻断（列已创建，用户可手动绑）
 }
 usedLabelIds.add(matchedLabel.id);
 createdCols.push(col);
 } catch {
 // 创建失败跳过，继续尝试下一个
 }
 }

 return createdCols;
 }

 /**
 * 把 issue归类到某个 column（按 labels交集）
 *
 * 匹配逻辑：issue 只要拥有列绑的**任意一个** label，就属于该列（OR 语义）
 * - 与 gitea API `?labels=1,2,3` 的 OR 语义一致
 * - 一列绑多个 label 是为了让不同 label 的 issue 都归到同一列
 * - 例：列绑了 "待办"+"前端"，issue 有 "待办" → 归入该列
 *
 * 返回 null 表示没匹配到任何列（"未分类"状态，进 unassignedIssues）
 */
 function matchIssueToColumn(issue: IssueCardDto, cols: ColumnDto[]): string | null {
 const issueLabelIds = new Set(issue.labels.map((l) => l.id));
 for (const col of cols) {
 const colLabelIds = col.labels.map((l) => l.id);
 if (colLabelIds.length ===0) continue;
 // OR 语义：issue 拥有列绑的任意一个 label 即匹配
 if (colLabelIds.some((id) => issueLabelIds.has(id))) return col.id;
 }
 return null;
 }

 /**
 *单独刷新某列的 issue（新建 / 删除 /换列后调）
 */
 async function refreshColumn(projectId: string, columnId: string): Promise<void> {
 loadingIssues.value.add(columnId);
 try {
  const resp = await issuesList({
  projectId,
  state: 'open',
  limit:100,
  page:1,
  });
 const col = columns.value.find((c) => c.id === columnId);
 const byCol: Record<string, IssueCardDto[]> = { ...issuesByColumn.value };
 for (const c of columns.value) byCol[c.id] = [];
 const unassigned: IssueCardDto[] = [];
 for (const issue of resp.items) {
 const cid = columnIdFromIssueLabels(issue);
 if (cid) byCol[cid]!.push(issue);
 else unassigned.push(issue);
 }
 //防御：col 不存在时清空
 if (!col) {
 delete byCol[columnId];
 }
 issuesByColumn.value = byCol;
 unassignedIssues.value = unassigned;
 } catch (e) {
 error.value = normalizeError(e);
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
  const issue = await issuesCreate({
  projectId: args.projectId,
  title: args.title,
  ...(args.body !== undefined ? { body: args.body } : {}),
  ...(labelIds.length >0 ? { labelIds } : {}),
  });
 //追加到本地（不动其他列）
 const existing = issuesByColumn.value[args.columnId] ?? [];
 issuesByColumn.value = {
 ...issuesByColumn.value,
 [args.columnId]: [...existing, issue],
 };
 return issue;
 } catch (e) {
 error.value = normalizeError(e);
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
 // M6 undo-by-project：main 端会自己 pushUndo（src/main/board/move-card.ts:184）
 // 渲染端只刷新按钮状态
 await loadUndoStatus(args.projectId);
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
 error.value = normalizeError(e);
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
  error.value = normalizeError(e);
  throw e;
  }
  }

  /**
 * 把"未分类 issue"归到指定列（plan_25cc4562 Task C · 未分类快捷归类）
 *
 * 业务语义：
 * - 未分类 issue = 不带任何"列绑 label"的 gitea issue（`unassignedIssues`）
 * - 归类 = 给 issue 加目标列绑的**第一个** label（OR 语义下足够让它匹配到该列）
 * - **不**调 `removeLabel`（issue 本来就没这个 label —— gitea 端 addLabel 幂等）
 * - 走的是 `issues.addLabel`（裸 label 端点）**不**是 `issues.moveColumn`（moveColumn 走
 *   "从 fromColumn 全 remove + toColumn 全 add" 流程，而未分类 issue 根本不在 fromColumn）
 *
 * 边界：
 * - 目标列必须**已绑 label**（`col.labels[0]` 必存在）；v1.3 业务上未分类 section 出现
 *   就说明所有列都绑了 label，**不**做空防御 → 让上层 UI 在二次确认前发现
 * - UI 层先弹 ConfirmDialog 二次确认（"归到「列名」？"）→ 确认后调本函数
 * - 成功后乐观更新：unassignedIssues 移除 + issuesByColumn[toColumnId] 追加
 * - 失败回滚：issue 还回 unassignedIssues + 从 issuesByColumn 撤回
 */
  async function assignUnassignedIssue(args: {
  projectId: string;
  issueIndex: number;
  toColumnId: string;
  }): Promise<void> {
  const col = columns.value.find((c) => c.id === args.toColumnId);
  if (!col) {
  throw {
  code: 'not_found',
  messageText: '找不到内容：列已不存在',
  hint: '请刷新看板',
  recoverable: false,
  } satisfies UserFacingError;
  }
  if (col.labels.length === 0) {
  // v1.3 业务上未分类 section 出现时所有列都绑了 label，但**不**假设 UI 层校验过
  throw {
  code: 'validation_failed',
  messageText: '操作冲突：目标列还未绑标签',
  hint: '请给列先绑定一个 Gitea 标签',
  recoverable: false,
  } satisfies UserFacingError;
  }
  // 取目标列绑的第一个 label（OR 语义：任意一个绑 label 都足够让 issue 归到该列）
  const targetLabel = col.labels[0]!;
  const issue = unassignedIssues.value.find((i) => i.index === args.issueIndex);
  if (!issue) {
  throw {
  code: 'not_found',
  messageText: '找不到内容：议题已不在未分类列表',
  hint: '可能已被其他操作归类，请刷新',
  recoverable: false,
  } satisfies UserFacingError;
  }
  //乐观更新：从 unassignedIssues 移到 issuesByColumn[toColumnId]
  const issueWithLabel: IssueCardDto = {
  ...issue,
  labels: [...issue.labels, targetLabel],
  };
  unassignedIssues.value = unassignedIssues.value.filter(
  (i) => i.index !== args.issueIndex,
  );
  const toList = [...(issuesByColumn.value[args.toColumnId] ?? []), issueWithLabel];
  issuesByColumn.value = { ...issuesByColumn.value, [args.toColumnId]: toList };

  try {
  await issuesAddLabel({
  projectId: args.projectId,
  issueIndex: args.issueIndex,
  labelId: targetLabel.id,
  });
  } catch (e) {
  // 回滚：放回 unassigned + 从目标列撤回（label 仍要剔除本地的乐观变更）
  const newIssue = { ...issue }; // 原始未带 label 的 issue
  unassignedIssues.value = [...unassignedIssues.value, newIssue].sort(
  (a, b) => a.index - b.index,
  );
  issuesByColumn.value = {
  ...issuesByColumn.value,
  [args.toColumnId]: (issuesByColumn.value[args.toColumnId] ?? []).filter(
  (i) => i.index !== args.issueIndex,
  ),
  };
  error.value = normalizeError(e);
  throw e;
  }
  }

 // =====撤销 / 重做（M6 undo-by-project：main 端为 single source of truth） =====

 /** 拉当前 projectId 的栈深度（UI 灰化按钮用） */
 async function loadUndoStatus(projectId: string): Promise<void> {
 const result = (await getIpcClient().invoke('user', 'undoStatus', { projectId })) as {
 undoSize: number;
 redoSize: number;
 };
 undoSize.value = result.undoSize;
 redoSize.value = result.redoSize;
 }

 function canUndo(): boolean {
 return undoSize.value >0;
 }

 function canRedo(): boolean {
 return redoSize.value >0;
 }

 /** 撤销最近一次换列（M6 undo-by-project） */
 async function undoLastMove(projectId: string): Promise<void> {
 // main 端弹 undo 栈 → 派发 reverse（即 swap from/to 的 moveIssueColumn）→ 推 redo
 // UI 只需：调 IPC → 等返回 → 刷新栈深度 → 重新拉看板（issue 实际位置变了）
 const result = (await getIpcClient().invoke('user', 'undo', { projectId })) as {
 restored: number;
 undoSize: number;
 redoSize: number;
 };
 undoSize.value = result.undoSize;
 redoSize.value = result.redoSize;
 if (result.restored >0) {
 // 重新拉 columns + issues（issue label 实际变了）
 await loadBoard(projectId);
 }
 }

 /** 重做（M6 undo-by-project） */
 async function redoLastMove(projectId: string): Promise<void> {
 const result = (await getIpcClient().invoke('user', 'redo', { projectId })) as {
 restored: number;
 undoSize: number;
 redoSize: number;
 };
 undoSize.value = result.undoSize;
 redoSize.value = result.redoSize;
 if (result.restored >0) {
 await loadBoard(projectId);
 }
 }

  function clearError(): void {
  error.value = null;
  }

  // ============================================================
  // ===== 列管理（v1.1 补：让 BoardView 真能建列 / 改列 / 删列 / 绑 label） =====
  // ============================================================

  /**
   * 新建列
   * 走 `board.columns.create` IPC（position 由后端 = max + POSITION_STEP 自动算）
   * 成功后插入到 columns 头部（position 升序，新列位置最低在左）
   * 失败抛 UserFacingError
   */
  async function createColumn(args: { projectId: string; title: string }): Promise<ColumnDto> {
  error.value = null;
  try {
  const col = await boardColumnsCreate({
  projectId: args.projectId,
  title: args.title,
  position: 0, // 后端忽略（listColumns 按 position 升序 + createColumn 用 max + STEP）
  });
  // 追加到 columns 列表头部
  columns.value = [col, ...columns.value];
  // 给 issuesByColumn 加空数组
  issuesByColumn.value = { ...issuesByColumn.value, [col.id]: [] };
  return col;
  } catch (e) {
  error.value = normalizeError(e);
  throw e;
  }
  }

  /**
   * 改列属性（v1.1：改名；v1.3：加 wipLimit）
   *
   * 用例：BoardView 列设置弹窗保存时调，可只传 title / 只传 wipLimit / 一起传
   * - reorder 走 v2 拖拽（**不**走此函数）
   * - wipLimit 语义（plan_25cc4562 · Task B）：正整数 = 上限，null = 无限
   *
   * 失败抛 UserFacingError，UI 层 toast 展示
   */
  async function updateColumn(args: {
  columnId: string;
  title?: string;
  wipLimit?: number | null;
  }): Promise<void> {
  error.value = null;
  try {
  // 构造 patch：只传 caller 显式给的字段（保留 updateColumn 在 IPC 层的 "patch 至少含一个字段" 校验）
  const patch: { title?: string; wipLimit?: number | null } = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.wipLimit !== undefined) patch.wipLimit = args.wipLimit;
  await boardColumnsUpdate({
  columnId: args.columnId,
  patch,
  });
  // 同步本地：把 caller 改了的字段都合并进去（**不**用后端 DTO 直接覆盖，
  // 是因为本函数没拿后端返回的 ColumnDto 也没改 IPC 端行为；本地值 = caller 传值兜底）
  columns.value = columns.value.map((c) =>
  c.id === args.columnId
  ? {
  ...c,
  ...(args.title !== undefined ? { title: args.title } : {}),
  ...(args.wipLimit !== undefined ? { wipLimit: args.wipLimit } : {}),
  }
  : c,
  );
  } catch (e) {
  error.value = normalizeError(e);
  throw e;
  }
  }

  /**
   * 删列
   * 二次确认由 UI 层（BoardView）触发
   * 删完同步从 columns / issuesByColumn 移除
   */
  async function deleteColumn(args: { columnId: string }): Promise<void> {
  error.value = null;
  try {
  await boardColumnsDelete({ columnId: args.columnId });
  columns.value = columns.value.filter((c) => c.id !== args.columnId);
  const next = { ...issuesByColumn.value };
  delete next[args.columnId];
  issuesByColumn.value = next;
  } catch (e) {
  error.value = normalizeError(e);
  throw e;
  }
  }

  /**
   * 绑 / 解绑 gitea label 到列
   * mapLabel: column_label_mapping 插一行
   * unmapLabel: 删一行
   * 同步更新 columns[c].labels
   *
   * 注：后端 mapLabel 走 resolveColumn(args.columnId) 拿 projectId，不需要 caller 传
   *
   * 2026-06-15 Gitea 优先原则：mapLabel 后端调 gitea 校验 + 拉实时 name/color 写 localStore，
   * 返 ColumnDto 含完整 label 数据；store 直接用后端 DTO 同步本地，**不**再手 push `color: ''`
   */
  async function mapLabelToColumn(args: {
  columnId: string;
  giteaLabelId: number;
  giteaLabelName: string;
  }): Promise<void> {
  error.value = null;
  try {
  const col = await boardColumnsMapLabel({
  columnId: args.columnId,
  giteaLabelId: args.giteaLabelId,
  giteaLabelName: args.giteaLabelName,
  });
  // 同步本地：用后端 DTO 覆盖（gitea 实时 name/color）
  columns.value = columns.value.map((c) => (c.id === args.columnId ? col : c));
  } catch (e) {
  error.value = normalizeError(e);
  throw e;
  }
  }

  async function unmapLabelFromColumn(args: { columnId: string; giteaLabelId: number }): Promise<void> {
  error.value = null;
  try {
  await boardColumnsUnmapLabel({
  columnId: args.columnId,
  giteaLabelId: args.giteaLabelId,
  });
  columns.value = columns.value.map((c) =>
  c.id === args.columnId
  ? { ...c, labels: c.labels.filter((l) => l.id !== args.giteaLabelId) }
  : c,
  );
  } catch (e) {
  error.value = normalizeError(e);
  throw e;
  }
  }

  return {
  // state
  columns,
  issuesByColumn,
  unassignedIssues,
  labelsByProject,
  loading,
  loadingIssues,
  error,
  currentProjectId,
  undoSize,
  redoSize,
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
  assignUnassignedIssue,
  loadUndoStatus,
  canUndo,
  canRedo,
  undoLastMove,
  redoLastMove,
  createColumn,
  updateColumn,
  deleteColumn,
  mapLabelToColumn,
  unmapLabelFromColumn,
  clearError,
  };
});
