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
import { authConnect, authDisconnect, authDisconnectOne, authStatus, authSwitchAccount } from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
// 渲染端通过 @main/ipc/schema 拿到 IPC 类型（AGENTS §5.5 拍板的"IPC 单一信息源"）；
// src/shared/ipc-types.ts 文件尚未由 backend 创建，frontend 任务**只读** schema.ts,
// 不在 shared 目录新增 re-export 文件以避免改 shared 边界。
import type { GiteaAccountDto, UserDto } from '@renderer/types/dto';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

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

  /**
   * v2.37：按平台查找对应账号的 giteaUrl
   *
   * 历史 Bug：currentGiteaUrl 永远取 accounts[0]，导致用户连了多个平台时
   * "在 GitHub 中打开" 按钮仍跳到 Gitea（第一个账号的 URL）。
   *
   * 用法：
   *   - 当 currentProject.platform === 'github' 时调用 getAccountUrlByPlatform('github')
   *     拿到 GitHub 账号的 URL（https://github.com），拼接 commit 路径正确跳转
   *   - Gitea 平台走旧逻辑（取第一个 Gitea 账号）
   *
   * 找不到对应平台账号时返回 undefined —— 调用方（如 CommitDetailPanel
   * 的 "在 X 中打开" 按钮）会据此隐藏按钮，避免跳到错的平台。
   */
  function getAccountUrlByPlatform(
    platform: 'gitea' | 'github',
  ): string | undefined {
    if (platform === 'github') {
      // v2.38：GitHub 账号后端存的 giteaUrl 是 API 域名 https://api.github.com
      // (见 app.go:1033 giteaURL = github.GitHubAPIBase + adapter.go:34)
      // —— 因为后端所有 HTTP 调用需要走 API。但前端"在 GitHub 中打开 commit"
      //   需要的是**网站 URL** https://github.com/owner/repo/commit/{sha},
      //   跳到 api.github.com 是 API endpoint,浏览器看到 JSON 不是 web 页面。
      // 归一化:任何 github.com 域名(无论 api. 还是裸 github.com)都替换成网站 URL。
      const gh = accounts.value.find((a) => a.platform === 'github');
      const apiUrl = gh?.giteaUrl ?? 'https://github.com';
      return apiUrl.replace('api.github.com', 'github.com');
    }
    // Gitea：取第一个 Gitea 账号（兼容历史 currentGiteaUrl 语义）
    const gitea = accounts.value.find((a) => (a.platform ?? 'gitea') === 'gitea');
    return gitea?.giteaUrl ?? '';
  }

  // ===== actions =====

  /**
   * 拉取连接状态（**不**含 token）
   * 应用启动时调一次，后续 main 端 push 事件后重拉
   */
  async function refreshStatus(): Promise<void> {
    loading.value = true;
    useGlobalLoadingStore().show('auth');
    error.value = null;
    try {
      const resp = (await authStatus()) as {
        accounts: GiteaAccountDto[];
        currentUser: UserDto | null;
      };
      accounts.value = resp.accounts;
      currentUser.value = resp.currentUser;
    } catch (e) {
      error.value = normalizeError(e);
      // status 失败不重置 accounts —— 可能是临时网络问题
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('auth');
    }
  }

  /**
   * 连接 gitea/github（**唯一**接收 token 的入口）
   *
   * v2 多平台：传 platform 决定走 Gitea adapter 还是 GitHub adapter
   *
   * @param giteaUrl gitea 实例 URL（GitHub 时传 https://github.com 即可，Go 端会忽略）
   * @param token 个人访问令牌（8+ 字符，main 端会 trim + 长度校验）
   * @param platform "gitea" | "github"（默认 "gitea"）
   * @returns 成功时返回新账号 + 用户；失败抛 UserFacingError
   */
  async function connect(
    giteaUrl: string,
    token: string,
    platform: 'gitea' | 'github' = 'gitea',
  ): Promise<void> {
    loading.value = true;
    useGlobalLoadingStore().show('auth');
    error.value = null;
    try {
      await authConnect(giteaUrl, token, platform);
      // 连接成功后立即拉一次 status 把账号 + 用户填进 store
      await refreshStatus();
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('auth');
    }
  }

  /**
   * 断开某个 gitea URL 的连接（清 keychain + 内存）
   */
  async function disconnect(giteaUrl: string): Promise<void> {
    loading.value = true;
    useGlobalLoadingStore().show('auth');
    error.value = null;
    try {
      await authDisconnect(giteaUrl);
      await refreshStatus();
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('auth');
    }
  }

  /**
   * v1.6 按 URL+username 断开单个账号（账号管理弹窗用）
   */
  async function disconnectOne(giteaUrl: string, username: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await authDisconnectOne({ giteaUrl, username });
      await refreshStatus();
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /**
   * v1.6 切换到指定账号（重排 accounts 让它排第一 → 变成 currentUser）
   */
  async function switchAccount(accountId: string): Promise<void> {
    await authSwitchAccount(accountId);
    await refreshStatus();
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
    getAccountUrlByPlatform, // v2.37：多平台 URL 查找
    // actions
    refreshStatus,
    connect,
    disconnect,
    disconnectOne,
    switchAccount,
    clearError,
  };
});
