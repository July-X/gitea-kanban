/**
 * branch store —— 当前 project 的分支列表（gitea branches）
 *
 * 设计（AGENTS §5.2 + plan_32018da5 c-frontend-4-views-4-stores）：
 *   - 数据源：branches.list IPC（main 端包 listGiteaBranches + 本地 starred JOIN）
 *   - setup store 风格（与 board.ts / useRepoStore / auth.ts 一致）
 *   - **不**持久化（v1 不存；star/unstar 走 branches.star IPC，**不**本地乐观更新）
 *   - 暴露 list / refresh / filter / currentSelectedName / currentSelectedItem + getByName
 *   - 跨视图状态传递：pendingTimelineFocus（"在时间轴查看此分支"按钮用）
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
  /**
   * 当前选中行（按 name 引用，**不**直接存 BranchDto 引用 —— 后续 list() 刷新会
   * 让旧引用指向旧数据，存 name 保证 selected 永远指向最新 items 里的对象）
   *
   * 用法：右侧 BranchDetailAside 的 `v-if` 开关、键盘 Esc 关闭
   */
  const currentSelectedName = ref<string | null>(null);
  /** 旧字段保留：currentSelectedItem（兼容历史，**新**代码用 currentSelectedName） */
  const currentSelectedItem = ref<BranchDto | null>(null);

  /**
   * 跨视图状态传递：用户在 BranchesView 点"在时间轴查看此分支"时写入，
   * TimelineView onMounted 调 `consumePendingTimelineFocus()` 读出并清空。
   *
   * 选 Pinia pending 而非 query / route param 的理由（见 plan §4）：
   * router 路径都是 /timeline 不带 param，引入动态路由会影响所有 `router.push({name:'timeline'})`
   * 调用方；Pinia pending 改动最小（1 store + 1 视图）。
   */
  const pendingTimelineFocus = ref<string | null>(null);

  // ===== getters =====
  const total = computed(() => items.value.length);

  /** 默认分支（v1 简单：取第一项 isDefault=true；gitea 通常只一个） */
  const defaultBranch = computed<BranchDto | null>(
    () => items.value.find((b) => b.isDefault) ?? null,
  );

  /** 当前选中的分支（按 currentSelectedName 反查 items） */
  const selectedBranch = computed<BranchDto | null>(
    () => (currentSelectedName.value ? getByName(currentSelectedName.value) : null),
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
      // 注意：**不**清空 currentSelectedName —— 用户切 project 后再切回来时，
      // 如果该分支仍存在，selected 状态可恢复（甚至让 consumed pending 重新生效）。
      // 真正的关闭由 select(null) / 关 aside 显式触发。
    }
    try {
      const resp = (await branchesList({
        projectId,
        limit: 100,
        page: 1,
      })) as ListBranchesResp;
      items.value = resp.items;
      currentProjectId.value = projectId;
      // 重新解析 selectedBranch：旧 selected name 在新 list 里可能不存在了
      if (currentSelectedName.value && !getByName(currentSelectedName.value)) {
        currentSelectedName.value = null;
      }
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

  /**
   * 选中某行（**只** UI 状态，**不**调 IPC）
   *
   * 优先用 name 选中（currentSelectedName）—— BranchesView 点击行时
   * 传 name，selectedBranch getter 会从 items 反查最新对象。
   * 旧接口（传 BranchDto）保留为兼容 stub。
   */
  function select(itemOrName: BranchDto | string | null): void {
    if (itemOrName === null) {
      currentSelectedName.value = null;
      currentSelectedItem.value = null;
      return;
    }
    if (typeof itemOrName === 'string') {
      currentSelectedName.value = itemOrName;
      currentSelectedItem.value = getByName(itemOrName);
    } else {
      currentSelectedName.value = itemOrName.name;
      currentSelectedItem.value = itemOrName;
    }
  }

  /** 写跨视图状态："在时间轴查看此分支"——TimelineView onMounted consume */
  function setPendingTimelineFocus(name: string): void {
    pendingTimelineFocus.value = name;
  }

  /** 读跨视图状态并清空（TimelineView onMounted 调一次） */
  function consumePendingTimelineFocus(): string | null {
    const n = pendingTimelineFocus.value;
    pendingTimelineFocus.value = null;
    return n;
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
    currentSelectedName,
    currentSelectedItem,
    pendingTimelineFocus,
    // getters
    total,
    defaultBranch,
    selectedBranch,
    starredItems,
    filteredItems,
    getByName,
    // actions
    list,
    refresh,
    select,
    setPendingTimelineFocus,
    consumePendingTimelineFocus,
    clearError,
  };
});
