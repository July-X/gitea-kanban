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
 */
import { computed, onMounted, ref, watch, type ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import { dismissToast, showToast } from '@renderer/lib/toast';

export interface UseBoardBootstrapReturn {
  /** currentProjectId computed（v1.3 直接读 store 也行，但这里集中一处） */
  activeProjectId: ComputedRef<string | null>;
  /** 暴露给模板的 mount token（debug / 测试用） */
  autoInitToastToken: ReturnType<typeof ref<number>>;
}

export function useBoardBootstrap(): UseBoardBootstrapReturn {
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
        if (myToken === autoInitToastToken.value && loadResult.autoInitCreatedCount > 0) {
          showToast({
            type: 'info',
            message: `已根据仓库现有标签自动建了 ${loadResult.autoInitCreatedCount} 个列（点击列名可改名 / 解绑）`,
            duration: 6000,
          });
        }
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