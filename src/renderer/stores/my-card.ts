/**
 * my-card store —— "我的卡片"列表（gitea issues where assignee == me）
 *
 * 设计（AGENTS §5.2 + plan_32018da5 c-frontend-4-views-4-stores）：
 *   - 数据源：issues.list({ assignee: <currentUser.login> }) IPC
 *     A3 拍板 issues.list 支持 assignee 过滤（gitea /issues?assignee=username）
 *   - 跨 project 聚合：
 *     v1 简化 —— 走当前 active project 拉一次，**不**做"全账号下所有仓库聚合"
 *     PM 用户看"我手头有哪些活儿" —— 一开始就 1-3 个活跃仓库，足够
 *   - setup store 风格
 *   - **不**持久化
 *
 * 零术语：
 *   - 状态文案："我的卡片 / 已完成 / 进行中 / 共 X 张"
 *   - 禁用原词（"合并请求 / 合并 / 变基 / 派生 / 仓库 / 分支 / 维护者"）
 *     → 代码内标识符走 check:no-jargon.ts 白名单
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { issuesList } from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { IssueCardDto } from '../../main/ipc/schema.js';

/** 视图层状态维度 */
export type MyCardFilter = 'all' | 'open' | 'closed';

export const useMyCardStore = defineStore('my-card', () => {
  // ===== state =====
  const items = ref<IssueCardDto[]>([]);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);
  const currentProjectId = ref<string | null>(null);
  /** 当前拉到的 assignee（gitea username）—— 用于 UI 显示"我是 xxx" */
  const currentAssignee = ref<string | null>(null);

  // ===== filter state =====
  const filter = ref<MyCardFilter>('open'); // 默认看"进行中"—— PM 视角
  const search = ref('');

  // ===== selection state =====
  const currentSelectedItem = ref<IssueCardDto | null>(null);

  // ===== getters =====
  const total = computed(() => items.value.length);

  const counts = computed(() => {
    let open = 0;
    let closed = 0;
    for (const i of items.value) {
      if (i.state === 'open') open++;
      else closed++;
    }
    return { all: items.value.length, open, closed };
  });

  const filteredItems = computed<IssueCardDto[]>(() => {
    const q = search.value.trim().toLowerCase();
    let arr = items.value;
    if (filter.value !== 'all') {
      arr = arr.filter((i) => i.state === filter.value);
    }
    if (!q) return arr;
    return arr.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        String(i.index).includes(q) ||
        i.labels.some((l) => l.name.toLowerCase().includes(q)),
    );
  });

  function getByIndex(index: number): IssueCardDto | null {
    return items.value.find((i) => i.index === index) ?? null;
  }

  // ===== actions =====

  /**
   * 加载"我的卡片"
   * @param projectId uuid
   * @param assignee gitea username（用 auth.currentUser.login）
   * @param reset 强制刷新
   */
  async function list(
    projectId: string,
    assignee: string,
    reset = true,
  ): Promise<void> {
    loading.value = true;
    error.value = null;
    if (reset) {
      items.value = [];
      currentSelectedItem.value = null;
    }
    try {
      const resp = await issuesList({
        projectId,
        assignee, // A3：透传到 gitea /issues?assignee=<username>
        state: 'all',
        limit: 100,
        page: 1,
      });
      items.value = resp.items;
      currentProjectId.value = projectId;
      currentAssignee.value = assignee;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 刷新（用上次 projectId + assignee） */
  async function refresh(): Promise<void> {
    if (!currentProjectId.value || !currentAssignee.value) {
      throw {
        code: 'validation_failed',
        messageText: '输入有误：尚未初始化"我的卡片"',
        hint: '请重新进入"我的卡片"页',
        recoverable: false,
      } satisfies UserFacingError;
    }
    await list(currentProjectId.value, currentAssignee.value, true);
  }

  function setFilter(f: MyCardFilter): void {
    filter.value = f;
  }

  function select(item: IssueCardDto | null): void {
    currentSelectedItem.value = item;
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
    currentAssignee,
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
    clearError,
  };
});
