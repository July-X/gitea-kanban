/**
 * pull store —— 当前 project 的合并请求列表（gitea /pulls）
 *
 * 设计（AGENTS §5.2）：v1 末 4-store 重构阶段抽出（与 my-card/branch/member 同源）
 *   - 数据源：pulls.list IPC（main 端包 listGiteaPulls + 30s 缓存 + linkedCards JOIN）
 *   - setup store 风格（与 board.ts / branch.ts 一致）
 *   - **不**持久化
 *   - 暴露 list / refresh / filter / currentSelectedItem
 *   - 状态维度：'all' | 'open' | 'closed'；merged 走 PullDto.merged 字段
 *     （gitea 把 merged 合并请求视为 closed）
 *     "全部 / 待合并 / 已合并 / 已关闭" 4 个 tab 拆解：
 *       all    = 全部
 *       open   = state==open
 *       merged = state==closed && merged==true
 *       closed = state==closed && merged==false
 *
 * 零术语：
 *   - 状态文案："全部 / 待合并 / 已合并 / 已关闭"
 *   - 禁用原词（"合并请求 / 合并 / 变基 / 派生 / 仓库 / 分支 / 维护者"）
 *     → 代码内标识符走 check:no-jargon.ts 白名单
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { pullsList, pullsGet, pullsMerge, pullsClose } from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { ListPullsResp, PullDto, PullState, MergeMethod } from '@renderer/types/dto';
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

  // ===== getters =====
  const total = computed(() => items.value.length);

  /** 按 filter 拆 4 类计数（UI tab 角标用） */
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

  /**
   * 过滤后的列表（filter + search）
   * search 匹配 title / head / base 三字段（不区分大小写）
   */
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

  /** 按 index 查合并请求 */
  function getByIndex(index: number): PullDto | null {
    return items.value.find((p) => p.index === index) ?? null;
  }

  // ===== actions =====

  /**
   * 加载某 project 的合并请求列表
   * @param projectId uuid
   * @param reset 强制刷新（默认 true；v1 不翻页）
   */
  async function list(projectId: string, reset = true): Promise<void> {
    loading.value = true;
    useGlobalLoadingStore().show('pull');
    error.value = null;
    if (reset) {
      items.value = [];
      currentSelectedItem.value = null;
    }
    try {
      // A3 拍板 pulls.list 支持 state 过滤；v1 拉全量，UI 层按 merged/closed 拆
      const resp = (await pullsList({
        projectId,
        state: 'all' as PullState | undefined, // gitea /pulls?state=closed 同时含 merged；'all' = 不过滤
        limit: 100,
        page: 1,
      })) as ListPullsResp;
      items.value = resp.items;
      currentProjectId.value = projectId;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('pull');
    }
  }

  /** 刷新 */
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

  /** 切换 tab */
  function setFilter(f: PullFilter): void {
    filter.value = f;
  }

  /** 选中某行 */
  function select(item: PullDto | null): void {
    currentSelectedItem.value = item;
  }

  /** 拿单个合并请求详情 */
  async function get(projectId: string, index: number): Promise<PullDto> {
    const dto = await pullsGet({ projectId, index });
    // 更新本地 items 中对应条目（如果存在）
    const idx = items.value.findIndex((p) => p.index === index);
    if (idx >= 0) {
      items.value[idx] = { ...dto };
    }
    return dto;
  }

  /**
   * 合并合并请求（**危险操作**，调用前 UI 必须弹二次确认）
   *
   * 合并方式人话映射：
   *   - 'merge'        → 普通合并
   *   - 'rebase'       → 变基
   *   - 'rebase-merge' → 变基+合并
   *   - 'squash'       → 压缩
   *
   * @returns 合并结果（含 sha / merged / message）
   */
  async function mergePull(args: {
    projectId: string;
    index: number;
    method: MergeMethod;
    deleteBranchAfter?: boolean;
    commitMessage?: string;
  }): Promise<{ sha: string; merged: boolean; message: string }> {
    const result = (await pullsMerge(args)) as { sha: string; merged: boolean; message: string };
    // 合并成功后刷新列表（缓存已在主进程失效，重新拉取拿最新状态）
    if (result.merged && currentProjectId.value) {
      try {
        await list(currentProjectId.value, true);
      } catch {
        // 刷新失败不影响合并结果
      }
      // v0.6+：合并成功后自动同步 Git Graph
      //   - 远端已产生新 merge commit，本地 refs 不刷新的话 graph 上看不到
      //   - 复用 PullRepoByProjectId 链路（自带进度回调 → StatusBar 行末自动亮）
      //   - 派发 app:refresh 事件 → TimelineNewView.vue 监听后重 loadGraph
      try {
        await useRepoStore().pullRepoByProjectId({ projectId: currentProjectId.value });
      } catch {
        // pull 失败不影响合并结果（前端可在 StatusBar 手动重试）
      }
      try {
        window.dispatchEvent(new CustomEvent('app:refresh'));
      } catch {
        /* 静默 */
      }
    }
    return result;
  }

  /**
   * 关闭合并请求（不合并，直接关闭）—— **危险操作**，调用前 UI 必须弹二次确认
   *
   * 对应 gitea PATCH /pulls/{index} {state: 'closed'}
   * 关闭后合并请求状态变为 closed，不可再合并（除非 reopen）。
   */
  async function closePull(args: {
    projectId: string;
    index: number;
    reason?: string;
  }): Promise<{ closed: boolean }> {
    const result = (await pullsClose(args)) as { closed: boolean };
    // 关闭后刷新列表
    if (result.closed && currentProjectId.value) {
      try {
        await list(currentProjectId.value, true);
      } catch {
        // 刷新失败不影响关闭结果
      }
      // v0.6+：关闭后也派发 app:refresh，让 TimelineNewView 在用户切到 Git Graph 时
      // 能看到关闭事件带来的潜在 DAG 变化（虽然 PR 不直接产 commit，但侧链 fetch 可能更新）
      try {
        window.dispatchEvent(new CustomEvent('app:refresh'));
      } catch {
        /* 静默 */
      }
    }
    return result;
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    // state
    items,
    loading,
    error,
    currentProjectId,
    // filter
    filter,
    search,
    // selection
    currentSelectedItem,
    // getters
    total,
    counts,
    filteredItems,
    getByIndex,
    // actions
    list,
    refresh,
    setFilter,
    select,
    get,
    mergePull,
    closePull,
    clearError,
  };
});

/** 内部 helper：判断某合并请求是否命中 filter 维度 */
function matchFilter(p: PullDto, f: PullFilter): boolean {
  if (f === 'all') return true;
  if (f === 'open') return p.state === 'open';
  if (f === 'merged') return p.state === 'closed' && p.merged;
  // 'closed' = state==closed 但未 merged
  return p.state === 'closed' && !p.merged;
}
