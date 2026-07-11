/**
 * pull store —— 当前 project 的合并请求列表（gitea /pulls）
 *
 * 设计（AGENTS §5.2）：v1 末 4-store 重构阶段抽出
 *   - 数据源：pulls.list IPC
 *   - 状态维度：全部 / 待合并 / 已合并 / 已关闭
 *
 * 零术语：
 *   - "合并请求" / "合并" / "变基" / "待合并" / "已合并" / "已关闭" / "草稿"
 */

import { defineStore } from 'pinia';
import { computed, reactive, ref, triggerRef } from 'vue';
import {
  pullsList,
  pullsGet,
  pullsMerge,
  pullsClose,
  pullsCommentList,
  pullsCommentCreate,
  pullsCommentUpdate,
  pullsCommentDelete,
  pullsReviewsList,
  pullsReviewCreate,
  pullsReviewCommentsList,
  pullsFilesList,
  pullsFileDiffGet,
} from '@renderer/lib/ipc-client';
import {
  pullsUpdateLabels,
  pullsUpdateAssignee,
  pullsUpdateReviewers,
  pullsUpdateMilestone,
  labelsList,
  membersList,
  milestonesList,
} from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { ListPullsResp, PullDto, PullState, MergeMethod, IssueCommentDto, PullReviewCommentDto, PullFileDto, PullFileDiffDto, PullReviewDto, MilestoneDto, CollaboratorDto } from '@renderer/types/dto';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import { useRepoStore } from '@renderer/stores/repo';

/** 视图层 tab 维度 */
export type PullFilter = 'all' | 'open' | 'merged' | 'closed';

export const usePullStore = defineStore('pull', () => {
  // ===== state =====
  const items = ref<PullDto[]>([]);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);
  const currentProjectId = ref<string | null>(null);

  // ===== filter state =====
  const filter = ref<PullFilter>('all');
  const search = ref('');

  // ===== selection state =====
  const currentSelectedItem = ref<PullDto | null>(null);

  // ===== 分页状态 =====
  const currentPage = ref(0);
  const hasMore = ref(false);
  const loadingMore = ref(false);
  const PAGE_SIZE = 30;

  // ===== 评论面板状态 =====
  interface CommentPanel {
    items: IssueCommentDto[];
    loading: boolean;
    posting: boolean;
    error: string | null;
  }
  const commentPanels = ref<Map<number, CommentPanel>>(new Map());

  // ===== Review 面板状态 =====
  const reviewPanels = ref<Map<number, PullReviewDto[]>>(new Map());
  const reviewSubmitting = ref(false);
  const reviewEditorOpen = ref<Set<number>>(new Set());
  const reviewEditorEvent = ref<Map<number, string>>(new Map());
  const reviewEditorBody = ref<Map<number, string>>(new Map());

  // ===== 文件评论状态（v0.5.0 M4） =====
  /** 按 PR index 分组的行内评审评论缓存（升序） */
  const reviewCommentsByPR = ref<Map<number, PullReviewCommentDto[]>>(new Map());
  /** 按 PR index 分组的文件列表缓存 */
  const filesByPR = ref<Map<number, PullFileDto[]>>(new Map());
  /** 按 "index:filePath" 的 diff 缓存 */
  const fileDiffByPath = ref<Map<string, PullFileDiffDto>>(new Map());

  // ===== getters =====
  const total = computed(() => items.value.length);

  const counts = computed(() => {
    let open = 0;
    let merged = 0;
    let closed = 0;
    for (const p of items.value) {
      if (p.state === 'open') {
        open++;
      } else if (p.merged) {
        merged++;
      } else {
        closed++;
      }
    }
    return { all: items.value.length, open, merged, closed };
  });

  /** 按文件路径聚合 review comments（按 PR → path → list） */
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

  /**
   * 对话时间线：把评论 + 评审事件 + 系统事件按时间合并，用于对话 Tab 渲染
   *
   * v0.7.x 重构：对齐 Gitea web 行为（templates/repo/issue/view_content/comments.tmpl）。
   * 之前的实现把 review 事件卡 (source: 'review') 跟 comment (source: 'comment')
   * 合并成 timeline，但评审事件卡里**错误地**显示了 review body，且 review body
   * 来自 ListPullReviews (跟 ListPullComments type=21 重复)。Gitea web 实际行为:
   *
   *   - ListPullReviews 返回评审事件（state: approved/changes_requested/commented）
   *   - ListPullComments 返回所有 type 的评论:
   *       type=0  → 普通评论卡
   *       type=21 → 评审 body (Gitea 评审提交时同时插入 1 条 type=21 评论)
   *       type=22 → 评审事件 record (跟 ListPullReviews 一一对应, body 可能为空)
   *       type=1/2/4/7/8/9/10/27/28/29/... → 系统事件 (REOPEN/CLOSE/COMMIT_REF/LABEL/MILESTONE/ASSIGNEE/TITLE/REVIEW_REQUEST/MERGE/PUSH 等)
   *
   * Gitea web 渲染:
   *   - 评审事件卡 (timeline-item event) 显示 author + state + "审批了" + 时间, **没有 body**
   *   - 评审 body 走普通评论卡 (timeline-item comment) 显示
   *   - 评审 event + body 包在 timeline-item-group 容器里, 视觉上紧贴显示
   *   - 其他 type 渲染对应的系统事件卡 (badge + author + locale 文案)
   *
   * 本实现:
   *   - ListPullReviews 拿评审事件, 渲染评审事件卡 (不显示 body)
   *   - ListPullComments 拿所有评论, 按 type 分类:
   *       type=0/21 → source: 'comment' (普通评论卡)
   *       type=22 → 跟对应 review 匹配, body 作为评审 body 卡 (跟 event 一起渲染)
   *       其他 type → source: 'system_event' (系统事件卡, 简单 badge + 文案)
   *   - 全部按时间升序合并
   */
  const timelineItems = computed(() => {
    const result = new Map<number, Array<
      | { source: 'review_event'; id: number; state: string; body: string; author: { username: string }; submittedAt: string; reviewId?: number }
      | { source: 'comment'; id: number; body: string; author: { username: string }; createdAt: string; updatedAt?: string; type: number; reviewId?: number }
      | { source: 'system_event'; id: number; type: number; body: string; author: { username: string }; createdAt: string }
    >>();
    for (const [prIdx, panel] of commentPanels.value.entries()) {
      const items = result.get(prIdx) ?? [];
      for (const c of panel.items) {
        // v0.7.x: 按 type 分类, 全部 1:1 透传, 前端按 type 渲染
        //   type=0 (COMMENT) / type=21 (REVIEW) 走普通评论卡
        //   type=22 (REVIEW) 走评审 body 卡 (跟 review event 一起包 group 渲染)
        //   其他 type 走系统事件卡
        const cType = c.type ?? 0;
        if (cType === 22) {
          // type=22 是 Gitea 的 REVIEW event record 本身 (跟 ListPullReviews 一一对应)
          // 渲染时跟 review event 卡配对, body 一般为空, 跳过独立渲染
          continue;
        }
        if (cType === 0 || cType === 21) {
          // 普通评论 / 评审 body
          items.push({
            source: 'comment',
            id: c.id,
            body: c.body,
            author: { username: c.author?.username ?? '匿名' },
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            type: cType,
          });
        } else {
          // 系统事件 (REOPEN/CLOSE/COMMIT_REF/LABEL/MILESTONE/ASSIGNEE/TITLE/REVIEW_REQUEST/MERGE/PUSH/...)
          items.push({
            source: 'system_event',
            id: c.id,
            type: cType,
            body: c.body,
            author: { username: c.author?.username ?? '匿名' },
            createdAt: c.createdAt,
          });
        }
      }
      result.set(prIdx, items);
    }
    for (const [prIdx, reviews] of reviewPanels.value.entries()) {
      const items = result.get(prIdx) ?? [];
      for (const r of reviews) {
        // 评审事件卡: 只显示 state + author + 时间, 不显示 body
        // (body 由 type=21 评论作为普通评论卡渲染, 这是 Gitea web 实际行为)
        items.push({
          source: 'review_event',
          id: r.id,
          state: r.state,
          body: r.body, // 保留字段以备将来需要, 模板不渲染
          author: { username: r.author?.username ?? '匿名' },
          submittedAt: r.submittedAt,
        });
      }
      result.set(prIdx, items);
    }
    // Sort each PR's items by date (ascending)
    for (const items of result.values()) {
      items.sort((a, b) => {
        const dateA = a.source === 'review_event' ? a.submittedAt : a.createdAt;
        const dateB = b.source === 'review_event' ? b.submittedAt : b.createdAt;
        // 必须用 epoch ms 比较,不能用 localeCompare：Gitea 1.22+ 返回的 createdAt /
        // submittedAt 是带时区的 RFC3339（'+08:00' 或 'Z'）,字典序 'Z'(0x5A) > '+'(0x2B)
        // 会把同一时刻的不同 offset 表达排错序。Date 解析器能正确识别所有 offset。
        return new Date(dateA).getTime() - new Date(dateB).getTime();
      });
    }
    return result;
  });

  const filteredItems = computed<PullDto[]>(() => {
    const q = search.value.trim().toLowerCase();
    let arr = items.value;
    if (filter.value !== 'all') {
      arr = arr.filter((p) => matchFilter(p, filter.value));
    }
    if (!q) return arr;
    return arr.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.head.ref.toLowerCase().includes(q) ||
        p.base.ref.toLowerCase().includes(q),
    );
  });

  function getByIndex(index: number): PullDto | null {
    return items.value.find((p) => p.index === index) ?? null;
  }

  // ===== 评论面板 helpers =====
  function getPanel(index: number): CommentPanel {
    let p = commentPanels.value.get(index);
    if (!p) {
      // v0.5.0 bugfix: 用 reactive() 包装 panel,让 panel.items = items 这种直接赋值
      // 能触发 timelineItems computed 重算(ref(new Map()) 内部对象不是 reactive proxy,
      // 直接赋值属性不会触发响应,导致对话 Tab 标题显示「对话 N」但列表区域空白)
      p = reactive({
        items: [] as IssueCommentDto[],
        loading: false,
        posting: false,
        error: null as string | null,
      });
      // 关键: 用新 Map 替换 ref.value 而不是 Map.set + triggerRef。
      // 替换整个 Map 对象是一致且可靠的响应式触发方式。
      const newMap = new Map(commentPanels.value);
      newMap.set(index, p);
      commentPanels.value = newMap;
    }
    return p;
  }

  function getReviewPanel(index: number): PullReviewDto[] {
    return reviewPanels.value.get(index) ?? [];
  }

  // ===== actions =====

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
      const resp = (await pullsList({
        projectId,
        state: 'all' as PullState | undefined,
        limit: PAGE_SIZE,
        page: 1,
      })) as ListPullsResp;
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
    if (loadingMore.value) return;
    if (!hasMore.value) return;
    if (!currentProjectId.value) return;
    loadingMore.value = true;
    useGlobalLoadingStore().show('pull');
    error.value = null;
    try {
      const nextPage = currentPage.value + 1;
      const resp = (await pullsList({
        projectId: currentProjectId.value,
        state: 'all' as PullState | undefined,
        limit: PAGE_SIZE,
        page: nextPage,
      })) as ListPullsResp;
      const seen = new Set(items.value.map((p) => p.index));
      const fresh: PullDto[] = [];
      for (const p of resp.items) {
        if (!seen.has(p.index)) {
          fresh.push(p);
          seen.add(p.index);
        }
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
    if (!currentProjectId.value) {
      throw {
        code: 'validation_failed',
        messageText: '输入有误：尚未选中项目',
        hint: '请先在"看板"页选择一个仓库',
        recoverable: false,
      } satisfies UserFacingError;
    }
    await list(currentProjectId.value, true);
  }

  function setFilter(f: PullFilter): void {
    filter.value = f;
  }

  function select(item: PullDto | null): void {
    currentSelectedItem.value = item;
  }

  async function get(projectId: string, index: number): Promise<PullDto> {
    const dto = await pullsGet({ projectId, index });
    const idx = items.value.findIndex((p) => p.index === index);
    if (idx >= 0) {
      items.value[idx] = { ...dto };
    }
    return dto;
  }

  async function mergePull(args: {
    projectId: string;
    index: number;
    method: MergeMethod;
    deleteBranchAfter?: boolean;
    commitMessage?: string;
  }): Promise<{ sha: string; merged: boolean; message: string }> {
    const result = (await pullsMerge(args)) as { sha: string; merged: boolean; message: string };
    if (result.merged && currentProjectId.value) {
      try {
        await list(currentProjectId.value, true);
      } catch { /* 静默 */ }
      try {
        await useRepoStore().pullRepoByProjectId({ projectId: currentProjectId.value });
      } catch { /* 静默 */ }
      try {
        window.dispatchEvent(new CustomEvent('app:refresh'));
      } catch { /* 静默 */ }
    }
    return result;
  }

  async function closePull(args: {
    projectId: string;
    index: number;
    reason?: string;
  }): Promise<{ closed: boolean }> {
    const result = (await pullsClose(args)) as { closed: boolean };
    if (result.closed && currentProjectId.value) {
      try {
        await list(currentProjectId.value, true);
      } catch { /* 静默 */ }
      try {
        window.dispatchEvent(new CustomEvent('app:refresh'));
      } catch { /* 静默 */ }
    }
    return result;
  }

  // ===== 评论 actions =====

  /** 加载 PR 评论列表 */
  async function fetchComments(p: PullDto): Promise<void> {
    const panel = getPanel(p.index);
    panel.loading = true;
    panel.error = null;
    try {
      const items = (await pullsCommentList({
        projectId: currentProjectId.value!,
        index: p.index,
      })) as unknown as IssueCommentDto[];
      panel.items = items;
    } catch (e) {
      const err = e as { messageText?: string };
      panel.error = err.messageText ?? '加载评论失败';
    } finally {
      panel.loading = false;
    }
  }

  /** 发布 PR 评论 */
  async function postComment(p: PullDto, body: string): Promise<void> {
    const panel = getPanel(p.index);
    panel.posting = true;
    try {
      await pullsCommentCreate({
        projectId: currentProjectId.value!,
        index: p.index,
        body,
      });
      await fetchComments(p);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '发布失败');
    } finally {
      panel.posting = false;
    }
  }

  /** 编辑 PR 评论 */
  async function editComment(p: PullDto, commentId: number, body: string): Promise<void> {
    try {
      await pullsCommentUpdate({
        projectId: currentProjectId.value!,
        commentId,
        body,
      });
      await fetchComments(p);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '编辑失败');
    }
  }

  /** 删除 PR 评论 */
  async function removeComment(p: PullDto, commentId: number): Promise<void> {
    try {
      await pullsCommentDelete({
        projectId: currentProjectId.value!,
        commentId,
      });
      const panel = getPanel(p.index);
      panel.items = panel.items.filter((c) => c.id !== commentId);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '删除失败');
    }
  }

  // ===== Review actions =====

  /** 加载 PR 评审列表 */
  async function fetchReviews(p: PullDto): Promise<void> {
    try {
      const items = (await pullsReviewsList({
        projectId: currentProjectId.value!,
        index: p.index,
      })) as unknown as PullReviewDto[];
      reviewPanels.value.set(p.index, items);
      // 关键:ref(new Map()) 的 .set 不触发响应,手动 triggerRef 让 timelineItems
      // 重算看到新增的 review 列表。
      triggerRef(reviewPanels);
    } catch { /* 静默 */ }
  }

  /**
  /**
   * 外部代码（如 MergesView.loadReviews）拉到了 review 列表后,同步写入 store
   * 端的 reviewPanels,触发响应式重算。
   *
   * 关键：用新 Map 替换 ref.value 而不是 Map.set + triggerRef。
   * 原因：triggerRef 对 ref(Map) 的可靠性依赖 Vue 内部实现细节，在某些场景下
   * （如 computed 依赖链较深、Map 被多处引用）可能不触发重算。替换整个 Map
   * 对象是一致且可靠的响应式触发方式。
   */
  function setReviewsForIndex(p: PullDto, reviews: PullReviewDto[]): void {
    const newMap = new Map(reviewPanels.value);
    newMap.set(p.index, reviews);
    reviewPanels.value = newMap;
  }

  /** 提交 PR 评审 */
  async function submitReview(p: PullDto, event: string, body: string): Promise<void> {
    reviewSubmitting.value = true;
    try {
      await pullsReviewCreate({
        projectId: currentProjectId.value!,
        index: p.index,
        body,
        event,
      });
      reviewEditorOpen.value.delete(p.index);
      reviewEditorBody.value.delete(p.index);
      await fetchReviews(p);
      // 关键：Gitea 在 POST /pulls/{index}/reviews 时,若 body 非空,会同时插入一条
      // CommentTypeReview 类型的 issue comment 出现在 /issues/{index}/comments。
      // 不重拉的话,对话 Tab 的 comment 部分是陈旧的（用户填的正文不见了）。
      await fetchComments(p);
    } catch (e) {
      const err = e as { messageText?: string };
      throw new Error(err.messageText ?? '提交审查失败');
    } finally {
      reviewSubmitting.value = false;
    }
  }

  // ===== 文件评论 actions（v0.5.0 M4） =====

  /**
   * 加载 PR 行内评审评论
   * 返回指定 PR index 的所有 review comments
   */
  async function loadReviewComments(projectId: string, index: number): Promise<PullReviewCommentDto[]> {
    try {
      const comments = (await pullsReviewCommentsList({
        projectId,
        index,
      })) as unknown as PullReviewCommentDto[];
      reviewCommentsByPR.value.set(index, comments);
      return comments;
    } catch {
      return [];
    }
  }

  /**
   * 加载 PR 修改文件列表
   * 低版本后端不支持时返空数组
   */
  async function loadFiles(projectId: string, index: number): Promise<PullFileDto[]> {
    try {
      const files = (await pullsFilesList({
        projectId,
        index,
      })) as unknown as PullFileDto[];
      filesByPR.value.set(index, files);
      return files;
    } catch {
      return [];
    }
  }

  /**
   * 加载单个文件的 diff（单文件）
   * 返回 PullFileDiffDto（按 hunks 解析）
   */
  async function loadFileDiff(
    projectId: string,
    index: number,
    filePath: string,
  ): Promise<PullFileDiffDto | undefined> {
    const cacheKey = `${index}:${filePath}`;
    const cached = fileDiffByPath.value.get(cacheKey);
    if (cached) return cached;
    try {
      const diff = (await pullsFileDiffGet({
        projectId,
        index,
        filePath,
      })) as unknown as PullFileDiffDto;
      if (diff && diff.filename) {
        fileDiffByPath.value.set(cacheKey, diff);
        return diff;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  // ===== 属性编辑器状态（v0.6.0 PR 属性编辑） =====

  /** 可用里程碑列表（v0.6.0: Gitea 全量 + GitHub state=all） */
  const availableMilestones = ref<MilestoneDto[]>([]);
  /** 可用仓库成员列表（v0.6.0 + v0.7.0 GitHub collaborators） */
  const availableMembers = ref<CollaboratorDto[]>([]);

  /**
   * 加载属性编辑器需要的数据（标签 / 成员 / 里程碑）。
   *
   * v0.6+：labelsList / membersList 走 pulls.* IPC（namespaced），
   *       milestonesList 走 general milestonesList IPC。
   * v0.7.0+：GitHub 数据源下也调用；GitHub 端 milestone 用 number 显示 title
   *          （ListMilestones 已实现 title→number 反查）。
   */
  async function loadAttrEditorData(_projectId: string): Promise<void> {
    const repo = useRepoStore();
    try {
      // 标签（labels.list IPC，供 store 内部备用；MergesView 也可直接走 labelsList）
      const labelsResp = await labelsList({ projectId: _projectId, page: 1, limit: 100 });
      if (Array.isArray(labelsResp.items)) {
        // 仅写入供 store 内部备用；编辑器的 availableLabels 由 MergesView 直接写。
      }
      // 成员（members.list IPC）
      const membersResp = await membersList({ projectId: _projectId });
      availableMembers.value = (membersResp.items ?? []) as CollaboratorDto[];
      // 里程碑（按平台默认 state：gitea='all' / github='open'）
      const state = repo.currentProject?.platform === 'github' ? 'open' : 'all';
      const milestonesResp = await milestonesList({ projectId: _projectId, state });
      availableMilestones.value = (milestonesResp.items ?? []) as MilestoneDto[];
    } catch {
      // 静默失败，不应中断 PR 列表加载
    }
  }

  /** 清空属性编辑器数据（关闭 attr-editor 时调用，避免 stale 数据） */
  function clearAttrEditor(): void {
    availableMilestones.value = [];
    availableMembers.value = [];
  }

  // ===== 属性编辑器 save 动作（v0.6.0 起包走 store-first） =====

  /**
   * 提交标签变更（merge 前 / 后均可用）
   * 走 pulls.updateLabels IPC（vite bindings 自动转 Wails 绑定）
   */
  async function updateLabels(
    projectId: string,
    index: number,
    labels: string[],
  ): Promise<PullDto> {
    const updated = await pullsUpdateLabels({ projectId, index, labels });
    // 本地乐观更新（避免列表现状与服务器不一致）
    const item = items.value.find((x) => x.index === index);
    if (item) {
      item.labels = updated.labels ?? item.labels;
    }
    return updated;
  }

  /** 提交指派人变更（多选支持，v0.6.0） */
  async function updateAssignees(
    projectId: string,
    index: number,
    assignees: string[],
  ): Promise<PullDto> {
    const updated = await pullsUpdateAssignee({ projectId, index, assignees });
    const item = items.value.find((x) => x.index === index);
    if (item) {
      item.assignees = updated.assignees ?? item.assignees;
    }
    return updated;
  }

  /** 提交评审人变更 */
  async function updateReviewers(
    projectId: string,
    index: number,
    reviewers: string[],
  ): Promise<PullDto> {
    const updated = await pullsUpdateReviewers({ projectId, index, reviewers });
    const item = items.value.find((x) => x.index === index);
    if (item) {
      item.reviewers = updated.reviewers ?? item.reviewers;
    }
    return updated;
  }

  /** 提交里程碑变更（v0.6.0） */
  async function updateMilestone(
    projectId: string,
    index: number,
    milestone: string,
  ): Promise<PullDto> {
    const updated = await pullsUpdateMilestone({ projectId, index, milestone });
    const item = items.value.find((x) => x.index === index);
    if (item) {
      item.milestone = updated.milestone ?? item.milestone;
    }
    return updated;
  }

  return {
    // state
    items,
    loading,
    loadingMore,
    error,
    currentProjectId,
    currentPage,
    hasMore,
    PAGE_SIZE,
    filter,
    search,
    currentSelectedItem,
    // 评论面板
    commentPanels,
    // 评审面板
    reviewPanels,
    reviewSubmitting,
    reviewEditorOpen,
    reviewEditorEvent,
    reviewEditorBody,
    // 文件评论状态（v0.5.0 M4）
    reviewCommentsByPR,
    filesByPR,
    fileDiffByPath,
    // getters
    total,
    counts,
    filteredItems,
    getByIndex,
    reviewCommentsGrouped,
    getPanel,
    getReviewPanel,
    timelineItems,
    // actions
    list,
    loadMore,
    refresh,
    setFilter,
    select,
    get,
    mergePull,
    closePull,
    clearError,
    // 评论
    fetchComments,
    postComment,
    editComment,
    removeComment,
    // 评审
    fetchReviews,
    setReviewsForIndex,
    submitReview,
    // 文件评论
    loadReviewComments,
    loadFiles,
    loadFileDiff,
    // 属性编辑器（v0.6.0 + v0.7.0 补全 store action）
    availableMilestones,
    availableMembers,
    loadAttrEditorData,
    clearAttrEditor,
    // 属性编辑器 save 动作（v0.6.0 store-first 封装，v0.7.0 补全）
    updateLabels,
    updateAssignees,
    updateReviewers,
    updateMilestone,
  };
});

function matchFilter(p: PullDto, f: PullFilter): boolean {
  if (f === 'all') return true;
  if (f === 'open') return p.state === 'open';
  if (f === 'merged') return p.state === 'closed' && p.merged;
  return p.state === 'closed' && !p.merged;
}
