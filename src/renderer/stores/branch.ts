/**
 * branch store —— 当前 project 的分支列表（gitea branches）
 *
 * 设计（AGENTS §5.2 + plan_32018da5 c-frontend-4-views-4-stores）：
 *   - 数据源：branches.list IPC（main 端包 listGiteaBranches + 本地 starred JOIN）
 *   - setup store 风格（与 board.ts / useRepoStore / auth.ts 一致）
 *   - **不**持久化（v1 不存；star/unstar 走 branches.star IPC，**不**本地乐观更新）
 *   - 暴露 list / refresh / filter / currentSelectedItem + getByName
 *
 * 零术语：
 *   - state 字段全中文：列表 / 加载中 / 错误 / 选中的
 *   - UI 文本禁用原词："合并请求 / 合并 / 变基 / 派生 / 仓库 / 分支 / 维护者"
 *     → 代码内变量名走 check:no-jargon.ts 白名单
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { branchesList } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { BranchDto, ListBranchesResp } from '../../main/ipc/schema.js';

export const useBranchStore = defineStore('branch', () => {
  // ===== state =====
  /** 全量分支（gitea 返回的顺序，gitea 默认按 name 升序） */
  const items = ref<BranchDto[]>([]);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);
  /** 上次加载的 projectId（用于切 project 时触发刷新） */
  const currentProjectId = ref<string | null>(null);

  // ===== filter state（纯前端 UI 层，**不**走 IPC） =====
  const search = ref('');
  /** 仅看收藏 */
  const onlyStarred = ref(false);

  // ===== selection state（UI 状态，**不**持久化） =====
  const currentSelectedItem = ref<BranchDto | null>(null);

  // ===== getters =====
  const total = computed(() => items.value.length);

  /** 默认分支（v1 简单：取第一项 isDefault=true；gitea 通常只一个） */
  const defaultBranch = computed<BranchDto | null>(
    () => items.value.find((b) => b.isDefault) ?? null,
  );

  /** 收藏的分支（用于"仅看收藏"过滤器） */
  const starredItems = computed<BranchDto[]>(() => items.value.filter((b) => b.starred));

  /**
   * 过滤后的列表（按 search + onlyStarred）
   * 搜索匹配 name 包含子串（不区分大小写）
   */
  const filteredItems = computed<BranchDto[]>(() => {
    const q = search.value.trim().toLowerCase();
    let arr = items.value;
    if (onlyStarred.value) {
      arr = starredItems.value;
    }
    if (!q) return arr;
    return arr.filter((b) => b.name.toLowerCase().includes(q));
  });

  /** 按 name 查分支（v1 简单线性查找，量小<100） */
  function getByName(name: string): BranchDto | null {
    return items.value.find((b) => b.name === name) ?? null;
  }

  // ===== actions =====

  /**
   * 加载某 project 的分支列表
   * @param projectId uuid（来自 useRepoStore().currentProjectId）
   * @param reset 强制刷新（默认 true；翻页场景传 false = 追加，但 v1 不支持翻页）
   */
  async function list(projectId: string, reset = true): Promise<void> {
    loading.value = true;
    error.value = null;
    if (reset) {
      items.value = [];
      currentSelectedItem.value = null;
    }
    try {
      const resp = (await branchesList({
        projectId,
        limit: 100,
        page: 1,
      })) as ListBranchesResp;
      items.value = resp.items;
      currentProjectId.value = projectId;
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 刷新（v1 简化 = 重新 list） */
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

  /** 选中某行（**只** UI 状态，**不**调 IPC） */
  function select(item: BranchDto | null): void {
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
    search,
    onlyStarred,
    // selection
    currentSelectedItem,
    // getters
    total,
    defaultBranch,
    starredItems,
    filteredItems,
    getByName,
    // actions
    list,
    refresh,
    select,
    clearError,
  };
});
