/**
 * pull store —— 当前 project 的合并请求列表 (gitea /pulls)
 *
 * v0.7.x: 时间轴统一走 /issues/{index}/timeline 端点, 返回 TimelineItem[]。
 * 前端按 type string ("comment"|"review"|"label"|...) 分类渲染, 1:1 对齐 Gitea web。
 */

import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import {
  pullsList, pullsGet, pullsMerge, pullsClose,
  pullsCommentList, pullsCommentCreate, pullsCommentUpdate, pullsCommentDelete,
  pullsReviewsList, pullsReviewCreate,
  pullsReviewCommentsList, pullsFilesList, pullsFileDiffGet, pullsCommitsList,
  pullsCommentReactionsList, pullsCommentReactionAdd, pullsCommentReactionRemove,
  pullsUpdateLabels, pullsUpdateAssignee, pullsUpdateReviewers, pullsUpdateMilestone,
  pullsUpdateTitle,
  labelsList, membersList, milestonesList,
  normalizeError,
} from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type {
  ListPullsResp, PullDto, PullState, MergeMethod,
  TimelineItemDto, PullReviewCommentDto, PullFileDto, PullFileDiffDto, PullReviewDto,
  PullCommitDto,
  MilestoneDto, CollaboratorDto,
} from '@renderer/types/dto';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import { useRepoStore } from '@renderer/stores/repo';

export type PullFilter = 'all' | 'open' | 'merged' | 'closed';

/**
 * v0.7.6：合并连续 type="label" 事件 —— 对齐 Gitea web 行为
 *
 * 根因：Gitea /timeline 端点每个 label 变化返回 1 条独立事件（每条带单数 label +
 * labelAction=add/remove），但 Gitea web 在 web 端按"同作者 + 60s 内连续 label 事件"
 * 合并为 1 条带 addedLabels/removedLabels 数组的事件，再渲染
 * `repo.issues.add_label` / `remove_label` / `add_remove_labels` 三态文案。
 *
 * 我们 app 没 web 端的"修改后渲染"环节，需要在前端 store fetchTimeline 后做同样合并。
 * 算法（对齐 `routers/web/repo/issue_view.go: mergeLabels`）：
 *   1. 遍历 items，找到 type="label" 的事件
 *   2. 与前一条 label 事件比较：
 *      - 同作者 (author.username 相同)
 *      - 时间间隔 < 60s (用 created 字符串 Date.parse 比较)
 *   3. 满足则把当前事件的 addedLabels/removedLabels 累加到前一条，
 *      并把当前事件标记 merged=true（v-for 用 :key 跳过）
 *   4. 边界：标点 add/remove 互转也要正确 —— 比如先 add "bug" 再 remove "bug"
 *      会把"bug"从 AddedLabels 移到 RemovedLabels（与 Gitea web 行为一致）
 *
 * 复杂度：O(n)，最多遍历 2 次（一次累加，一次标 merged）。
 *
 * @returns 新的 TimelineItemDto 数组（不修改原数组）
 */
function mergeLabelEvents(items: TimelineItemDto[]): TimelineItemDto[] {
  const out: TimelineItemDto[] = [];
  // 时间窗 60s —— 对齐 Gitea web `cur.CreatedUnix - prev.CreatedUnix >= 60` 边界
  const LABEL_MERGE_WINDOW_MS = 60 * 1000;

  for (const item of items) {
    if (item.type !== 'label') {
      out.push(item);
      continue;
    }
    // 找前一条 label 事件（最后入 out 列表的）
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const canMerge =
      prev !== null &&
      prev.type === 'label' &&
      !prev.merged &&
      prev.author?.username !== undefined &&
      prev.author.username === item.author?.username &&
      Math.abs(new Date(item.created).getTime() - new Date(prev.created).getTime()) < LABEL_MERGE_WINDOW_MS;

    if (!canMerge) {
      out.push(item);
      continue;
    }

    // 累加 addedLabels / removedLabels 到 prev
    const newAdded = item.addedLabels ?? (item.labelAction === 'add' && item.label ? [item.label] : []);
    const newRemoved = item.removedLabels ?? (item.labelAction === 'remove' && item.label ? [item.label] : []);

    // 标点互转：add X 后 remove X → 把 X 从 AddedLabels 移到 RemovedLabels
    const addedAfterMove: Array<{ id: number; name: string; color: string }> = [];
    const removedAfterMove: Array<{ id: number; name: string; color: string }> = [];
    for (const r of newRemoved) {
      const idx = (prev.addedLabels ?? []).findIndex((a) => a.id === r.id);
      if (idx >= 0) {
        // 从 AddedLabels 移到 RemovedLabels
        const moved = prev.addedLabels![idx];
        prev.addedLabels = prev.addedLabels!.filter((_, i) => i !== idx);
        if (!removedAfterMove.find((x) => x.id === moved.id)) removedAfterMove.push(moved);
      } else if (!removedAfterMove.find((x) => x.id === r.id)) {
        removedAfterMove.push(r);
      }
    }
    for (const a of newAdded) {
      const idx = (prev.removedLabels ?? []).findIndex((r) => r.id === a.id);
      if (idx >= 0) {
        // 从 RemovedLabels 移到 AddedLabels
        const moved = prev.removedLabels![idx];
        prev.removedLabels = prev.removedLabels!.filter((_, i) => i !== idx);
        if (!addedAfterMove.find((x) => x.id === moved.id)) addedAfterMove.push(moved);
      } else if (!addedAfterMove.find((x) => x.id === a.id)) {
        addedAfterMove.push(a);
      }
    }
    prev.addedLabels = [...(prev.addedLabels ?? []), ...addedAfterMove];
    prev.removedLabels = [...(prev.removedLabels ?? []), ...removedAfterMove];
    // 把单数 label 字段清掉，避免渲染 fallback 到 v0.7.2 旧逻辑
    prev.label = undefined;
    prev.labelAction = undefined;
    // 更新 created 为最新事件的时间（与 Gitea web `prev.CreatedUnix = cur.CreatedUnix` 行为一致）
    prev.created = item.created;
    // 当前事件标记 merged，模板用 v-if="item.merged" 跳过渲染
    item.merged = true;
    out.push(item);
  }
  return out;
}

export const usePullStore = defineStore('pull', () => {
  const items = ref<PullDto[]>([]);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);
  const currentProjectId = ref<string | null>(null);
  const filter = ref<PullFilter>('all');
  const search = ref('');
  const currentSelectedItem = ref<PullDto | null>(null);
  const currentPage = ref(0);
  const hasMore = ref(false);
  const loadingMore = ref(false);
  const PAGE_SIZE = 30;

  interface TimelinePanel {
    items: TimelineItemDto[];
    loading: boolean;
    /** 正在发评论/编辑评论 —— 用于禁用 textarea + send 按钮 */
    posting: boolean;
    error: string | null;
  }
  const timelinePanels = ref<Map<number, TimelinePanel>>(new Map());

  const reviewPanels = ref<Map<number, PullReviewDto[]>>(new Map());
  const reviewSubmitting = ref(false);
  const reviewCommentsByPR = ref<Map<number, PullReviewCommentDto[]>>(new Map());
  const filesByPR = ref<Map<number, PullFileDto[]>>(new Map());
  // v0.7.7：PR 全量 commit 列表（head..base 范围，按 head 端时间倒序）—— 用于
  // type=29 push 事件的 inline commit 列表渲染（按 OldCommit..NewCommit 范围过滤）。
  // 缓存按 PR index 索引，跟 reviewCommentsByPR / filesByPR 一样的模式。
  //
  // v0.7.8：commitIds 字段（后端 giteaTimelineToItem 从 body JSON 解析）已能直接
  // 渲染 push event 列表，commitsByPR 缓存主要做"二次匹配 subject / author"用
  // （commitDetails() helper 按 SHA 短码从缓存匹配 PullCommitDto 拿 subject）。
  // 保留缓存 + loadCommits 行为不变，只是渲染逻辑改成"commitIds 数组 + 缓存补全"。
  const commitsByPR = ref<Map<number, PullCommitDto[]>>(new Map());
  // v0.7.8：commitsLoading 状态，tab loading indicator 用（之前组件本地有
  // commitsLoading ref，v0.7.8 删了组件本地版改用 store 这个）
  const commitsLoading = ref(false);
  const fileDiffByPath = ref<Map<string, PullFileDiffDto>>(new Map());
  const availableMilestones = ref<MilestoneDto[]>([]);
  const availableMembers = ref<CollaboratorDto[]>([]);

  const total = computed(() => items.value.length);
  const counts = computed(() => {
    let open = 0, merged = 0, closed = 0;
    for (const p of items.value) {
      if (p.state === 'open') open++;
      else if (p.merged) merged++;
      else closed++;
    }
    return { all: items.value.length, open, merged, closed };
  });

  const reviewCommentsGrouped = computed(() => {
    const result = new Map<number, Map<string, PullReviewCommentDto[]>>();
    for (const [prIdx, comments] of reviewCommentsByPR.value.entries()) {
      const byPath = new Map<string, PullReviewCommentDto[]>();
      for (const c of comments) { const list = byPath.get(c.path) ?? []; list.push(c); byPath.set(c.path, list); }
      result.set(prIdx, byPath);
    }
    return result;
  });

  function matchFilter(p: PullDto, f: PullFilter): boolean {
    if (f === 'open') return p.state === 'open';
    if (f === 'merged') return p.merged;
    if (f === 'closed') return p.state === 'closed' && !p.merged;
    return true;
  }

  const filteredItems = computed<PullDto[]>(() => {
    const q = search.value.trim().toLowerCase();
    let arr = items.value;
    if (filter.value !== 'all') arr = arr.filter((p) => matchFilter(p, filter.value));
    if (!q) return arr;
    return arr.filter((p) => p.title.toLowerCase().includes(q) || p.head.ref.toLowerCase().includes(q) || p.base.ref.toLowerCase().includes(q));
  });

  function getTimelinePanel(index: number): TimelinePanel {
    let p = timelinePanels.value.get(index);
    if (!p) {
      p = reactive({ items: [], loading: false, posting: false, error: null });
      const newMap = new Map(timelinePanels.value); newMap.set(index, p); timelinePanels.value = newMap;
    }
    return p;
  }

  function getReviewPanel(index: number): PullReviewDto[] { return reviewPanels.value.get(index) ?? []; }

  async function list(projectId: string, reset = true): Promise<void> {
    loading.value = true; useGlobalLoadingStore().show('pull'); error.value = null;
    if (reset) { items.value = []; currentSelectedItem.value = null; currentPage.value = 0; hasMore.value = false; }
    try {
      const resp = (await pullsList({ projectId, state: 'all' as PullState | undefined, limit: PAGE_SIZE, page: 1 })) as ListPullsResp;
      items.value = resp.items; currentProjectId.value = projectId; currentPage.value = 1; hasMore.value = resp.hasMore;
    } catch (e) { error.value = normalizeError(e); throw e; }
    finally { loading.value = false; useGlobalLoadingStore().hide('pull'); }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore.value || !hasMore.value || !currentProjectId.value) return;
    loadingMore.value = true; useGlobalLoadingStore().show('pull'); error.value = null;
    try {
      const nextPage = currentPage.value + 1;
      const resp = (await pullsList({ projectId: currentProjectId.value, state: 'all' as PullState | undefined, limit: PAGE_SIZE, page: nextPage })) as ListPullsResp;
      const seen = new Set(items.value.map((p) => p.index)); const fresh: PullDto[] = [];
      for (const p of resp.items) { if (!seen.has(p.index)) { fresh.push(p); seen.add(p.index); } }
      items.value = items.value.concat(fresh); currentPage.value = nextPage; hasMore.value = resp.hasMore;
    } catch (e) { error.value = normalizeError(e); }
    finally { loadingMore.value = false; useGlobalLoadingStore().hide('pull'); }
  }

  async function refresh(): Promise<void> {
    if (!currentProjectId.value) throw { code: 'validation_failed', messageText: '输入有误：尚未选中项目', hint: '请先在"看板"页选择一个仓库', recoverable: false } satisfies UserFacingError;
    await list(currentProjectId.value, true);
  }

  function setFilter(f: PullFilter): void { filter.value = f; }
  function select(item: PullDto | null): void { currentSelectedItem.value = item; }

  async function get(projectId: string, index: number): Promise<PullDto> {
    const dto = await pullsGet({ projectId, index });
    const idx = items.value.findIndex((p) => p.index === index);
    if (idx >= 0) items.value[idx] = { ...dto };
    return dto;
  }

  async function mergePull(args: { projectId: string; index: number; method: MergeMethod; deleteBranchAfter?: boolean; commitMessage?: string }): Promise<{ sha: string; merged: boolean; message: string }> {
    const result = (await pullsMerge(args)) as { sha: string; merged: boolean; message: string };
    if (result.merged && currentProjectId.value) {
      try { await list(currentProjectId.value, true); } catch {}
      try { await useRepoStore().pullRepoByProjectId({ projectId: currentProjectId.value }); } catch {}
      try { window.dispatchEvent(new CustomEvent('app:refresh')); } catch {}
    }
    return result;
  }

  async function closePull(args: { projectId: string; index: number; reason?: string }): Promise<{ closed: boolean }> {
    const result = (await pullsClose(args)) as { closed: boolean };
    if (result.closed && currentProjectId.value) {
      try { await list(currentProjectId.value, true); } catch {}
      try { window.dispatchEvent(new CustomEvent('app:refresh')); } catch {}
    }
    return result;
  }

  async function fetchTimeline(p: PullDto): Promise<void> {
    const panel = getTimelinePanel(p.index); panel.loading = true; panel.error = null;
    try {
      const items = (await pullsCommentList({ projectId: currentProjectId.value!, index: p.index })) as unknown as TimelineItemDto[];
      // v0.7.6：合并连续 type="label" 事件 —— 对齐 Gitea web
      // `routers/web/repo/issue_view.go: mergeLabels` 行为：
      //   - 同作者 + 时间间隔 < 60s
      //   - 把后一条 addedLabels/removedLabels 累加到前一条
      //   - 后一条标记 merged=true，模板里隐藏
      panel.items = mergeLabelEvents(items);
    } catch (e) { const err = e as { messageText?: string }; panel.error = err.messageText ?? '加载时间轴失败'; }
    finally { panel.loading = false; }
  }

  /**
   * v0.7.8：拉 PR 详情（PullDetailAppDTO）补到 currentSelectedItem / patchItem
   *
   * 背景：merge event inline 块渲染需要 mergeCommitSha 字段（Gitea 1.26+ timeline
   * 端点 merge_pull body 是空字符串，SHA 只能从 /pulls/{index} detail 端点拿）。
   * 列表接口 `ListPulls` 不返这个字段，selectPR 时只有轻量 PullDto，没 mergeCommitSha。
   * fetchPullDetail() 调 `pullsGet` IPC（Wails 绑到 `GetPull`），拿到 detail 后用
   * patchItem 浅 patch 列表项 + currentSelectedItem。
   *
   * 缓存：detail 不缓存（PR 状态变化时及时刷新），调用方按需调。
   */
  async function fetchPullDetail(p: PullDto): Promise<void> {
    try {
      const detail = (await pullsGet({ projectId: currentProjectId.value!, index: p.index })) as PullDto & { mergeCommitSha?: string; commits?: number };
      patchItem(p.index, detail);
      if (currentSelectedItem.value?.index === p.index) {
        currentSelectedItem.value = { ...currentSelectedItem.value, ...detail } as PullDto;
      }
    } catch {
      // 失败不阻断（merge 事件 SHA 链接不显示，但 timeline 仍可渲染）
    }
  }

  async function postComment(p: PullDto, body: string): Promise<void> {
    const panel = getTimelinePanel(p.index);
    panel.posting = true;
    try { await pullsCommentCreate({ projectId: currentProjectId.value!, index: p.index, body }); await fetchTimeline(p); }
    catch (e) { const err = e as { messageText?: string }; throw new Error(err.messageText ?? '发布失败'); }
    finally { panel.posting = false; }
  }

  async function editComment(p: PullDto, commentId: number, body: string): Promise<void> {
    try { await pullsCommentUpdate({ projectId: currentProjectId.value!, commentId, body }); await fetchTimeline(p); }
    catch (e) { const err = e as { messageText?: string }; throw new Error(err.messageText ?? '编辑失败'); }
  }

  async function removeComment(p: PullDto, commentId: number): Promise<void> {
    try { await pullsCommentDelete({ projectId: currentProjectId.value!, commentId }); const panel = getTimelinePanel(p.index); panel.items = panel.items.filter((c) => c.id !== commentId); }
    catch (e) { const err = e as { messageText?: string }; throw new Error(err.messageText ?? '删除失败'); }
  }

  async function fetchReviews(p: PullDto): Promise<void> {
    try { const items = await pullsReviewsList({ projectId: currentProjectId.value!, index: p.index }); reviewPanels.value.set(p.index, items); } catch {}
  }

  async function submitReview(p: PullDto, event: 'approve' | 'request_changes' | 'comment', body: string): Promise<void> {
    reviewSubmitting.value = true;
    try { await pullsReviewCreate({ projectId: currentProjectId.value!, index: p.index, event, body }); await Promise.all([fetchTimeline(p), fetchReviews(p)]); }
    finally { reviewSubmitting.value = false; }
  }

  async function loadReviewComments(projectId: string, index: number): Promise<PullReviewCommentDto[]> {
    try { const items = await pullsReviewCommentsList({ projectId, index }); reviewCommentsByPR.value.set(index, items); return items; } catch { return []; }
  }

  /**
   * v0.7.7：加载 PR 全量 commit 列表（按 head..base 范围，从 head 端时间倒序）——
   * 用于 type=29 push 事件的 inline commit 列表渲染。
   *
   * 实现简化：直接返 commitsByPR.get(index) 缓存，不做 push event 范围分组。
   * 模板渲染时全部列出来（用户看 commit 列表 + 跳到 Gitea web 看分组），跟 Gitea web
   * 严格 1:1 分组留给 v0.7.7.1（需要按 OldCommit..NewCommit 范围精确切分）。
   *
   * 复杂度：O(1)（缓存），首次拉一次后续都用缓存。
   */
  async function loadCommits(projectId: string, index: number): Promise<PullCommitDto[]> {
    const cached = commitsByPR.value.get(index);
    if (cached) return cached;
    commitsLoading.value = true;
    try {
      const items = await pullsCommitsList({ projectId, index });
      commitsByPR.value.set(index, items);
      return items;
    } catch {
      return [];
    } finally {
      commitsLoading.value = false;
    }
  }

  async function loadFiles(projectId: string, index: number): Promise<PullFileDto[]> {
    try { const items = await pullsFilesList({ projectId, index }); filesByPR.value.set(index, items); return items; } catch { return []; }
  }

  async function fetchFileDiff(p: PullDto, filePath: string): Promise<PullFileDiffDto | null> {
    try {
      const key = `${p.index}:${filePath}`; const cached = fileDiffByPath.value.get(key); if (cached) return cached;
      const dto = await pullsFileDiffGet({ projectId: currentProjectId.value!, index: p.index, filePath }); fileDiffByPath.value.set(key, dto); return dto;
    } catch { return null; }
  }

  async function fetchCommentReactions(_p: PullDto, commentId: number): Promise<unknown[]> {
    try { return await pullsCommentReactionsList({ projectId: currentProjectId.value!, commentId }); } catch { return []; }
  }
  async function addCommentReaction(_p: PullDto, commentId: number, content: string): Promise<void> { await pullsCommentReactionAdd({ projectId: currentProjectId.value!, commentId, content }); }
  async function removeCommentReaction(_p: PullDto, commentId: number, content: string): Promise<void> { await pullsCommentReactionRemove({ projectId: currentProjectId.value!, commentId, content }); }

  async function loadAttrEditorData(_projectId: string): Promise<void> {
    try {
      const [membersResp, milestonesResp] = await Promise.all([membersList({ projectId: _projectId }), milestonesList({ projectId: _projectId })]);
      availableMembers.value = (membersResp.items ?? []) as CollaboratorDto[];
      availableMilestones.value = (milestonesResp.items ?? []) as MilestoneDto[];
    } catch { availableMilestones.value = []; availableMembers.value = []; }
  }

  // ===== 属性编辑器 save 动作（v0.6.0 起包走 store-first） =====
  //
  // 这些是 v0.6.0 潜伏 store action 缺失 bug 的修复：MergesView.saveAttrs 调
  // pullStore.updateLabels / updateAssignees / updateReviewers / updateMilestone
  // 三参形式（projectId, index, value），但 pullsUpdateXxx IPC 函数只接受单
  // args object。这里 wrap 一次，内部调 IPC + 乐观更新本地 list。

  /** 乐观更新 items 里某 PR 的指定字段（v0.6+） */
  function patchItem(index: number, patch: Partial<PullDto>): void {
    const i = items.value.findIndex(p => p.index === index);
    if (i >= 0) items.value[i] = { ...items.value[i], ...patch } as PullDto;
  }

  /** 更新标签（替换所有标签） */
  async function updateLabels(projectId: string, index: number, labels: string[]): Promise<void> {
    const updated = await pullsUpdateLabels({ projectId, index, labels });
    patchItem(index, { labels: updated.labels });
  }

  /** 更新指派人（多选，空数组 = 清除）—— store 暴露复数名对齐 MergesView 调用 */
  async function updateAssignees(projectId: string, index: number, assignees: string[]): Promise<void> {
    const updated = await pullsUpdateAssignee({ projectId, index, assignees });
    patchItem(index, { assignees: updated.assignees });
  }

  /** 更新评审人（空数组 = 清除） */
  async function updateReviewers(projectId: string, index: number, reviewers: string[]): Promise<void> {
    const updated = await pullsUpdateReviewers({ projectId, index, reviewers });
    patchItem(index, { reviewers: updated.reviewers });
  }

  /** 关联里程碑（空串 = 清除；v0.6.0 Gitea / v0.7.0 GitHub） */
  async function updateMilestone(projectId: string, index: number, milestone: string): Promise<void> {
    const updated = await pullsUpdateMilestone({ projectId, index, milestone });
    patchItem(index, { milestone: updated.milestone });
  }

  /** v0.7.25：修改 PR 标题（用于 WIP toggle 去掉 "WIP:" 前缀） */
  async function updateTitle(projectId: string, index: number, title: string): Promise<void> {
    const updated = await pullsUpdateTitle({ projectId, index, title });
    // updated 含新 title + draft 字段（去掉 WIP: 后 draft=false）
    patchItem(index, { title: updated.title, draft: updated.draft });
  }

  return {
    items, loading, error, currentProjectId, filter, search, currentSelectedItem,
    currentPage, hasMore, loadingMore,
    timelinePanels, reviewPanels, reviewSubmitting,
    reviewCommentsByPR, filesByPR, fileDiffByPath, commitsByPR, commitsLoading,
    availableMilestones, availableMembers,
    total, counts, filteredItems, reviewCommentsGrouped,
    list, loadMore, refresh, setFilter, select, get, mergePull, closePull,
    getTimelinePanel, getReviewPanel,
    fetchTimeline, postComment, editComment, removeComment,
    fetchReviews, submitReview, loadReviewComments, loadFiles, fetchFileDiff, loadCommits,
    // v0.7.8：补 PR 详情（mergeCommitSha 字段）—— 供 timeline merge 事件 SHA 链接用
    fetchPullDetail,
    fetchCommentReactions, addCommentReaction, removeCommentReaction,
    loadAttrEditorData,
    updateLabels, updateAssignees, updateReviewers, updateMilestone,
    // v0.7.25：修改 PR 标题（用于 WIP toggle 去掉 "WIP:" 前缀）
    updateTitle,
    labels: labelsList, members: membersList, milestones: milestonesList,
  };
});
