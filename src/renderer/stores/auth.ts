/**
 * auth store —— 当前 gitea 连接状态 + 用户身份
 *
 * 设计（AGENTS §5.2 + §8.2 鉴权铁律）：
 *   - **不**持久化 token（keychain 由 main 端管，store 只持账号元信息）
 *   - **不**直接调 gitea API（必须走 window.api → preload → main → keychain）
 *   - token 在 authConnect 一次性传入后立刻进 main 内存 + keychain，本 store **不**留引用
 *
 * setup store 风格（Pinia + Composition API + 03-frontend §6.1）：
 *   直接 ref + computed + 函数，return 暴露给组件用
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authConnect, authDisconnect, authStatus } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
// 渲染端通过 @main/ipc/schema 拿到 IPC 类型（AGENTS §5.5 拍板的"IPC 单一信息源"）；
// src/shared/ipc-types.ts 文件尚未由 backend 创建，frontend 任务**只读** schema.ts,
// 不在 shared 目录新增 re-export 文件以避免改 shared 边界。
import type { GiteaAccountDto, UserDto } from '../../main/ipc/schema.js';

export const useAuthStore = defineStore('auth', () => {
  // ===== state =====
  const accounts = ref<GiteaAccountDto[]>([]);
  const currentUser = ref<UserDto | null>(null);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);

  // ===== getters =====
  /** 是否至少连了一个 gitea 账号 */
  const isConnected = computed(() => accounts.value.length > 0);
  /** 当前账号的 giteaUrl（多账号时取第一个；UI 上不直接暴露给用户看） */
  const currentGiteaUrl = computed(() => accounts.value[0]?.giteaUrl ?? '');

  // ===== actions =====

  /**
   * 拉取连接状态（**不**含 token）
   * 应用启动时调一次，后续 main 端 push 事件后重拉
   */
  async function refreshStatus(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const resp = (await authStatus()) as {
        accounts: GiteaAccountDto[];
        currentUser: UserDto | null;
      };
      accounts.value = resp.accounts;
      currentUser.value = resp.currentUser;
    } catch (e) {
      error.value = e as UserFacingError;
      // status 失败不重置 accounts —— 可能是临时网络问题
    } finally {
      loading.value = false;
    }
  }

  /**
   * 连接 gitea（**唯一**接收 token 的入口）
   * @param giteaUrl gitea 实例 URL（http/https）
   * @param token 个人访问令牌（8+ 字符，main 端会 trim + 长度校验）
   * @returns 成功时返回新账号 + 用户；失败抛 UserFacingError
   */
  async function connect(giteaUrl: string, token: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await authConnect(giteaUrl, token);
      // 连接成功后立即拉一次 status 把账号 + 用户填进 store
      await refreshStatus();
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 断开某个 gitea URL 的连接（清 keychain + 内存）
   */
  async function disconnect(giteaUrl: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await authDisconnect(giteaUrl);
      await refreshStatus();
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 清错误状态（UI 关闭 toast 时调） */
  function clearError(): void {
    error.value = null;
  }

  return {
    // state
    accounts,
    currentUser,
    loading,
    error,
    // getters
    isConnected,
    currentGiteaUrl,
    // actions
    refreshStatus,
    connect,
    disconnect,
    clearError,
  };
});
