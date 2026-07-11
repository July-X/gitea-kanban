/**
 * pull store —— 当前 project 的合并请求列表（gitea /pulls）
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
  pullsReviewCommentsList, pullsFilesList, pullsFileDiffGet,
  pullsCommentReactionsList, pullsCommentReactionAdd, pullsCommentReactionRemove,
  pullsUpdateLabels, pullsUpdateAssignee, pullsUpdateReviewers, pullsUpdateMilestone,
  labelsList, membersList, milestonesList,
  normalizeError,
} from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type {
  ListPullsResp, PullDto, PullState, MergeMethod,
  TimelineItemDto, PullReviewCommentDto, PullFileDto, PullFileDiffDto, PullReviewDto,
  MilestoneDto, CollaboratorDto,
} from '@renderer/types/dto';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import { useRepoStore } from '@renderer/stores/repo';

export type PullFilter = 'all' | 'open' | 'merged' | 'closed';

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

  // v0.7.x: 时间轴面板 — 单一数据源
  interface TimelinePanel {
    items: TimelineItemDto[];
    loading: boolean;
    error: string | null;
  }
  const timelinePanels = ref<Map<number, TimelinePanel>>(new Map());

  const reviewPanels = ref<Map<number, PullReviewDto[]>>(new Map());
  const reviewSubmitting = ref(false);

  const reviewCommentsByPR = ref<Map<number, PullReviewCommentDto[]>>(new Map());
  const filesByPR = ref<Map<number, PullFileDto[]>>(new Map());
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
      for (const c of comments) {
        const list = byPath.get(c.path) ?? [];
        list.push(c);
        byPath.set(c.path, list);
      }
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
    return arr.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      p.head.ref.toLowerCase().includes(q) ||
      p.base.ref.toLowerCase().includes(q),
    );
  });

  function getTimelinePanel(index: number): TimelinePanel {
    let p = timelinePanels.value.get(index);
    if (!p) {
      p = reactive({ items: [] as TimelineItemDto[], loading: false, error: null as string | null });
      const newMap = new Map(timelinePanels.value);
      newMap.set(index, p);
      timelinePanels.value = newMap;
    }
    return p;
  }

  function getReviewPanel(index: number): PullReviewDto[] {
    return reviewPanels.value.get(index) ?? [];
  }

  async function list(projectId: string, reset = true): Promise<void> {
    loading.value = true;
    useGlobalLoadingStore().show('pull');
    error.value = null;
    if (reset) {
      items.value = [];
      currentSelectedItem.value = null;
      currentPage.value = 0;
      hasMore.value = false;
    }
    try {
      const resp = (await pullsList({ projectId, state: 'all' as PullState | undefined, limit: PAGE_SIZE, page: 1 })) as ListPullsResp;
      items.value = resp.items;
      currentProjectId.value = projectId;
      currentPage.value = 1;
      hasMore.value = resp.hasMore;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('pull');
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore.value || !hasMore.value || !currentProjectId.value) return;
    loadingMore.value = true;
    useGlobalLoadingStore().show('pull');
    error.value = null;
    try {
      const nextPage = currentPage.value + 1;
      const resp = (await pullsList({ projectId: currentProjectId.value, state: 'all' as PullState | undefined, limit: PAGE_SIZE, page: nextPage })) as ListPullsResp;
      const seen = new Set(items.value.map((p) => p.index));
      const fresh: PullDto[] = [];
      for (const p of resp.items) {
        if (!seen.has(p.index)) { fresh.push(p); seen.add(p.index); }
      }
      items.value = items.value.concat(fresh);
      currentPage.value = nextPage;
      hasMore.value = resp.hasMore;
    } catch (e) {
      error.value = normalizeError(e);
    } finally {
      loadingMore.value = false;
      useGlobalLoadingStore().hide('pull');
    }
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
      try { await list(currentProjectId.value, true); } catch { /* 静默 */ }
      try { await useRepoStore().pullRepoByProjectId({ projectId: currentProjectId.value }); } catch { /* 静默 */ }
      try { window.dispatchEvent(new CustomEvent('app:refresh')); } catch { /* 静默 */ }
    }
    return result;
  }

  async function closePull(args: { projectId: string; index: number; reason?: string }): Promise<{ closed: boolean }> {
    const result = (await pullsClose(args)) as { closed: boolean };
    if (result.closed && currentProjectId.value) {
      try { await list(currentProjectId.value, true); } catch { /* 静默 */ }
      try { window.dispatchEvent(new CustomEvent('app:refresh')); } catch { /* 静默 */ }
    }
    return result;
  }

  // ===== 时间轴 actions =====

  /** v0.7.x: 加载 PR 时间轴（对齐 Gitea web）— 走 /issues/{index}/timeline */
  async function fetchTimeline(p: PullDto): Promise<void> {
    const panel = getTimelinePanel(p.index);
    panel.loading = true;
    panel.error = null;
    try {
      // pullsCommentList 现在是 timeline 端点的 shim
      const items = (await pullsCommentList({
        projectId: currentProjectId.value!,
        index: p.index,
      })) as unknown as TimelineItemDto[];
      panel.items = items;
    } catch (e) {
      const err = e as { messageText?: string };
      panel.error = err.messageText ?? '加载时间轴失败';
    } finally {
      panel.loading = false;
    }
  }

  async function postComment(p: PullDto, body: string): Promise<void> {
    const panel = getTimelinePanel(p.index);
    try {
      await pullsCommentCreate({ projectId: currentProjectId.value!, index: p.index, body });
      await fetchTimeline(p);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '发布失败');
    } finally {
      panel.loading = false;
    }
  }

  async function editComment(p: PullDto, commentId: number, body: string): Promise<void> {
    try {
      await pullsCommentUpdate({ projectId: currentProjectId.value!, commentId, body });
      await fetchTimeline(p);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '编辑失败');
    }
  }

  async function removeComment(p: PullDto, commentId: number): Promise<void> {
    try {
      await pullsCommentDelete({ projectId: currentProjectId.value!, commentId });
      const panel = getTimelinePanel(p.index);
      panel.items = panel.items.filter((c) => c.id !== commentId);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '删除失败');
    }
  }

  async function fetchReviews(p: PullDto): Promise<void> {
    try {
      const items = await pullsReviewsList({ projectId: currentProjectId.value!, index: p.index });
      reviewPanels.value.set(p.index, items);
    } catch { /* 评审加载失败不阻塞 */ }
  }

  async function submitReview(p: PullDto, event: 'approve' | 'request_changes' | 'comment', body: string): Promise<void> {
    reviewSubmitting.value = true;
    try {
      await pullsReviewCreate({ projectId: currentProjectId.value!, index: p.index, event, body });
      await Promise.all([fetchTimeline(p), fetchReviews(p)]);
    } finally {
      reviewSubmitting.value = false;
    }
  }

  async function loadReviewComments(projectId: string, index: number): Promise<PullReviewCommentDto[]> {
    try {
      const items = await pullsReviewCommentsList({ projectId, index });
      reviewCommentsByPR.value.set(index, items);
      return items;
    } catch { return []; }
  }

  async function loadFiles(projectId: string, index: number): Promise<PullFileDto[]> {
    try {
      const items = await pullsFilesList({ projectId, index });
      filesByPR.value.set(index, items);
      return items;
    } catch { return []; }
  }

  async function fetchFileDiff(p: PullDto, filePath: string): Promise<PullFileDiffDto | null> {
    try {
      const key = `${p.index}:${filePath}`;
      const cached = fileDiffByPath.value.get(key);
      if (cached) return cached;
      const dto = await pullsFileDiffGet({ projectId: currentProjectId.value!, index: p.index, filePath });
      fileDiffByPath.value.set(key, dto);
      return dto;
    } catch { return null; }
  }

  async function fetchCommentReactions(_p: PullDto, commentId: number): Promise<unknown[]> {
    try { return await pullsCommentReactionsList({ projectId: currentProjectId.value!, commentId }); }
    catch { return []; }
  }

  async function addCommentReaction(_p: PullDto, commentId: number, content: string): Promise<void> {
    await pullsCommentReactionAdd({ projectId: currentProjectId.value!, commentId, content });
  }

  async function removeCommentReaction(_p: PullDto, commentId: number, content: string): Promise<void> {
    await pullsCommentReactionRemove({ projectId: currentProjectId.value!, commentId, content });
  }

  async function loadAttrEditorData(_projectId: string): Promise<void> {
    try {
      const [membersResp, milestonesResp] = await Promise.all([
        membersList({ projectId: _projectId }),
        milestonesList({ projectId: _projectId }),
      ]);
      availableMembers.value = (membersResp.items ?? []) as CollaboratorDto[];
      availableMilestones.value = (milestonesResp.items ?? []) as MilestoneDto[];
    } catch {
      availableMilestones.value = [];
      availableMembers.value = [];
    }
  }

  return {
    items, loading, error, currentProjectId, filter, search, currentSelectedItem,
    currentPage, hasMore, loadingMore,
    timelinePanels, reviewPanels, reviewSubmitting,
    reviewCommentsByPR, filesByPR, fileDiffByPath,
    availableMilestones, availableMembers,
    total, counts, filteredItems, reviewCommentsGrouped,
    list, loadMore, refresh, setFilter, select, get, mergePull, closePull,
    getTimelinePanel, getReviewPanel,
    fetchTimeline, postComment, editComment, removeComment,
    fetchReviews, submitReview, loadReviewComments, loadFiles, fetchFileDiff,
    fetchCommentReactions, addCommentReaction, removeCommentReaction,
    loadAttrEditorData,
    updateLabels: pullsUpdateLabels, updateAssignee: pullsUpdateAssignee,
    updateReviewers: pullsUpdateReviewers, updateMilestone: pullsUpdateMilestone,
    labels: labelsList, members: membersList, milestones: milestonesList,
  };
});
