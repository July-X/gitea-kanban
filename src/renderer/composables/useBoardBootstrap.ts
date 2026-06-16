/**
 * useBoardBootstrap —— BoardView mount 时序串接 + watch + autoInit toast
 *
 * 抽出动机：原 BoardView.vue 内 3 个 onMounted + 2 个 watch + autoInit token
 * 校验共约 60 行；抽成 composable 后 BoardView 只剩模板调用 + onMounted().
 *
 * 业务不变：
 * - onMounted 时 loadRepos → loadBoard (autoInit 弹 toast) → loadUndoStatus
 * - watch(activeProjectId) 切 project 时 dismissToast + loadUndoStatus
 * - watch(auth.isConnected) 鉴权断开跳登录页
 *
 * autoInit token 防陈旧响应：用户切 project 后旧 loadBoard 不应弹旧 toast。
 *
 * v1.4 增强（P0-1 autoInit 透明化落地 · plan_25cc4562 Task C）：
 *   - 加 onAutoInit 回调 props —— BoardView 注入"autoInit 触发时该做什么"
 *   - 不再 composable 内部直接调 openColumnMenu（属于 useColumnManager 私有，跨边界）
 *   - localStorage dismissed 标记：避免重复弹"我帮你建了 N 列"
 *   - duration=6000（场景 1 / 2 / 3 都给 user 6s 看完文案 + 行动按钮）
 */
import { computed, onMounted, ref, watch, type ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import { dismissToast, showToast } from '@renderer/lib/toast';
import type { ColumnDto } from '../../main/ipc/schema.js';

/**
 * autoInit 回调 hook —— BoardView 通过 props 注入
 *
 * 触发时机：loadBoard 完成 + autoInitCreatedCount > 0 + 当前 project 未 dismissed
 *
 * 为什么用回调而不是 emit：
 *   - composable 不是组件（无 lifecycle hooks）
 *   - callback 比 emit 更轻（v-on 链 + 自动 cleanup）
 *   - BoardView 内部把 openColumnMenu 包成 onAutoInitOpenColumnMenu 即可
 */
export interface UseBoardBootstrapCallbacks {
  /**
   * user 点"打开列设置"按钮时触发
   * @param col autoInit 帮建的第一列（board.columns 顺序）
   */
  onAutoInitOpenColumnMenu?: (col: ColumnDto) => void;
}

/** localStorage key：autoInit 已被 dismiss（每个 project 独立标记） */
function dismissedKey(projectId: string): string {
  return `gitea-kanban.autoInit.dismissed.${projectId}`;
}

/**
 * 读 localStorage 判断 autoInit 是否被 dismiss 过
 * 失败（隐私模式 / quota）= 当作未 dismiss，弹 toast
 */
function isDismissed(projectId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(projectId)) === '1';
  } catch {
    return false;
  }
}

/**
 * 写 localStorage 标记 dismiss
 * 失败静默（隐私模式 / quota）—— 不影响 toast 显示
 */
function markDismissed(projectId: string): void {
  try {
    localStorage.setItem(dismissedKey(projectId), '1');
  } catch {
    /* silent */
  }
}

/**
 * 清 dismiss 标记 —— 未来 user 删了所有列再触发 autoInit 时，重新弹
 * 暂未接 P0-1 场景（待 v1.5 监听 column delete 事件），先暴露 helper
 */
export function clearAutoInitDismissed(projectId: string): void {
  try {
    localStorage.removeItem(dismissedKey(projectId));
  } catch {
    /* silent */
  }
}

export interface UseBoardBootstrapReturn {
  /** currentProjectId computed（v1.3 直接读 store 也行，但这里集中一处） */
  activeProjectId: ComputedRef<string | null>;
  /** 暴露给模板的 mount token（debug / 测试用） */
  autoInitToastToken: ReturnType<typeof ref<number>>;
}

export function useBoardBootstrap(
  callbacks: UseBoardBootstrapCallbacks = {},
): UseBoardBootstrapReturn {
  const auth = useAuthStore();
  const repo = useRepoStore();
  const board = useBoardStore();
  const route = useRoute();
  const router = useRouter();

  const activeProjectId = computed<string | null>(() => repo.currentProjectId);
  const autoInitToastToken = ref(0);

  onMounted(async () => {
    try {
      await repo.loadRepos('', true);
    } catch {
      /* error in repo.error */
    }
    const myProjectId = activeProjectId.value;
    if (myProjectId) {
      const myToken = ++autoInitToastToken.value;
      try {
        const loadResult = await board.loadBoard(myProjectId);
        // 场景 1：autoInit 帮建了 N 列 + user 未 dismiss → 透明化 toast
        if (myToken === autoInitToastToken.value && loadResult.autoInitCreatedCount > 0) {
          if (isDismissed(myProjectId)) {
            return; // user 已点过"不再提示"过 → 静默
          }
          const firstCol = board.columns[0];
          if (!firstCol) return;
          const count = loadResult.autoInitCreatedCount;
          showToast({
            type: 'info',
            message: `帮你建了 ${count} 列`,
            description: `gitea 仓库已有匹配的 label，按名字建好了 ${count} 列。点列名可改名 / 解绑 label。`,
            duration: 6000,
            actions: [
              {
                label: '打开列设置',
                variant: 'primary',
                onClick: () => {
                  callbacks.onAutoInitOpenColumnMenu?.(firstCol);
                },
              },
              {
                label: '不再提示',
                variant: 'ghost',
                dismissAfter: true,
                onClick: () => {
                  markDismissed(myProjectId);
                },
              },
            ],
          });
        }
        // 场景 2：autoInitCreatedCount = 0 + 仓库 0 列 → 概念解释 toast
        // 由 BoardView EmptyState 触发（这里**不**主动弹，EmptyState 文档升级留 v1.5 拍板）
      } catch {
        /* error */
      }
      try {
        await board.loadUndoStatus(myProjectId);
      } catch {
        /* error */
      }
    }
  });

  watch(activeProjectId, async (newId, oldId) => {
    if (oldId !== null && oldId !== undefined && oldId !== newId) {
      autoInitToastToken.value++;
      dismissToast();
    }
    if (newId) {
      try {
        await board.loadUndoStatus(newId);
      } catch {
        /* error */
      }
    } else {
      await board.loadUndoStatus('');
    }
  });

  watch(
    () => auth.isConnected,
    async (connected) => {
      if (connected) {
        try {
          await repo.loadRepos('', true);
        } catch {
          /* error */
        }
      } else {
        void router.push({ name: 'auth', query: { from: route.fullPath } });
      }
    },
  );

  return {
    activeProjectId,
    autoInitToastToken,
  };
}