/**
 * member store —— 当前 project 的成员列表（gitea repo collaborators）
 *
 * 设计（AGENTS §5.2 + plan_32018da5 c-frontend-4-views-4-stores）：
 *   - 数据源：members.list IPC（main 端包 listRepoCollaborators，gitea /repos/{owner}/{repo}/collaborators）
 *   - setup store 风格
 *   - **不**持久化
 *   - 暴露 list / refresh / filter / currentSelectedItem
 *   - 权限维度：gitea collaborator permission 字段是 'read' | 'write' | 'admin'
 *     v1 UI 翻译："只读" / "可写" / "管理员"
 *
 * 零术语：
 *   - 状态文案："成员 / 总计 N 人"
 *   - 禁用词同上
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { membersList } from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';
import type { MemberDto as RendererMemberDto } from '@renderer/types/dto';

/** 视图层权限维度 */
export type MemberFilter = 'all' | 'admin' | 'write' | 'read';

export type MemberDto = RendererMemberDto;

export const useMemberStore = defineStore('member', () => {
  // ===== state =====
  const items = ref<MemberDto[]>([]);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);
  const currentProjectId = ref<string | null>(null);

  // ===== filter state =====
  const filter = ref<MemberFilter>('all');
  const search = ref('');

  // ===== selection state =====
  const currentSelectedItem = ref<MemberDto | null>(null);

  // ===== getters =====
  const total = computed(() => items.value.length);

  const counts = computed(() => {
    let admin = 0;
    let write = 0;
    let read = 0;
    for (const m of items.value) {
      if (m.permission === 'admin') admin++;
      else if (m.permission === 'write') write++;
      else if (m.permission === 'read') read++;
    }
    return { all: items.value.length, admin, write, read };
  });

  const filteredItems = computed<MemberDto[]>(() => {
    const q = search.value.trim().toLowerCase();
    let arr = items.value;
    if (filter.value !== 'all') {
      arr = arr.filter((m) => m.permission === filter.value);
    }
    if (!q) return arr;
    // A-3 P3 · W7 修法：双字段匹配——按 username **或** fullName 搜
    // fullName 可能 undefined（旧版 gitea）→ optional chain 兜底
    return arr.filter((m) => {
      if (m.username.toLowerCase().includes(q)) return true;
      const fn = m.fullName?.toLowerCase();
      if (fn && fn.includes(q)) return true;
      return false;
    });
  });

  function getByUsername(username: string): MemberDto | null {
    return items.value.find((m) => m.username === username) ?? null;
  }

  // ===== actions =====

  /**
   * 加载某 project 的成员
   * @param projectId uuid
   * @param reset 强制刷新
   */
  async function list(projectId: string, reset = true): Promise<void> {
    loading.value = true;
    useGlobalLoadingStore().show('member');
    error.value = null;
    if (reset) {
      items.value = [];
      currentSelectedItem.value = null;
    }
    try {
      const resp = await membersList({ projectId });
      items.value = resp.items as MemberDto[];
      currentProjectId.value = projectId;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('member');
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

  function setFilter(f: MemberFilter): void {
    filter.value = f;
  }

  function select(item: MemberDto | null): void {
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
    // filter
    filter,
    search,
    // selection
    currentSelectedItem,
    // getters
    total,
    counts,
    filteredItems,
    getByUsername,
    // actions
    list,
    refresh,
    setFilter,
    select,
    clearError,
  };
});
