/**
 * repo store —— 当前仓库上下文 + 仓库列表
 *
 * 设计（AGENTS §5.2 + 03-frontend §6.2）：
 *   - 仓库列表从 main 端拉（gitea API + 本机 project 标记聚合）
 *   - "当前仓库"是仓库视图的上下文（看板/时间轴都基于它）
 *   - **不**做仓库分类（starred/archived/owned 等等的过滤放 UI 层）
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { reposAddProject, reposList, reposRemoveProject } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { ListReposResp, RepoDto, RepoProjectDto } from '../../main/ipc/schema.js';
import { useAuthStore } from '@renderer/stores/auth';

export const useRepoStore = defineStore('repo', () => {
  // ===== state =====
  const repos = ref<RepoDto[]>([]);
  const total = ref(0);
  const hasMore = ref(false);
  const currentProjectId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);

  // ===== getters =====
  /** 当前选中的仓库（**不**依赖 giteaAccountId —— 跨账号切仓库走 UI 重新选） */
  const currentRepo = computed<RepoDto | null>(() => {
    if (!currentProjectId.value) return null;
    return repos.value.find((r) => r.fullName === currentProjectId.value) ?? null;
  });
  /** 已加为 project 的仓库（isProject=true） */
  const projects = computed<RepoDto[]>(() => repos.value.filter((r) => r.isProject));

  // ===== actions =====

  /**
   * 拉取当前账号可访问的仓库列表
   * @param query 搜索关键词（gitea API 支持 name/description 模糊匹配）
   * @param reset 是否重置列表（默认 true，传 false = 翻页追加）
   */
  async function loadRepos(query = '', reset = true): Promise<void> {
    const auth = useAuthStore();
    if (!auth.accounts[0]) {
      error.value = {
        code: 'unauthenticated',
        messageText: '需要登录：尚未连接任何 gitea 实例',
        hint: '请先在"连接"页填入 gitea URL 和令牌',
        recoverable: true,
      };
      return;
    }
    const accountId = auth.accounts[0].id;
    loading.value = true;
    error.value = null;
    try {
      const resp = (await reposList({
        giteaAccountId: accountId,
        query: query || undefined,
        limit: 50,
        page: 1,
      })) as ListReposResp;
      if (reset) {
        repos.value = resp.items;
      } else {
        repos.value = [...repos.value, ...resp.items];
      }
      total.value = resp.total;
      hasMore.value = resp.hasMore;
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 选中当前仓库（用于后续看板/时间轴操作） */
  function selectProject(projectId: string | RepoProjectDto | null): void {
    if (!projectId) {
      currentProjectId.value = null;
      return;
    }
    if (typeof projectId === 'string') {
      currentProjectId.value = projectId;
    } else {
      currentProjectId.value = `${projectId.owner}/${projectId.name}`;
    }
  }

  /** 把仓库加为本机 project（加入看板） */
  async function addProject(args: { owner: string; name: string }): Promise<void> {
    const auth = useAuthStore();
    if (!auth.accounts[0]) {
      throw {
        code: 'unauthenticated',
        messageText: '需要登录：尚未连接任何 gitea 实例',
        hint: '请先连接 gitea',
        recoverable: true,
      } satisfies UserFacingError;
    }
    const accountId = auth.accounts[0].id;
    loading.value = true;
    error.value = null;
    try {
      await reposAddProject({ giteaAccountId: accountId, ...args });
      // 刷新列表让 isProject 标记更新
      await loadRepos('', true);
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /** 取消本机 project 标记（**不**删远端仓库） */
  async function removeProject(projectId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await reposRemoveProject({ projectId });
      if (currentProjectId.value === projectId) {
        currentProjectId.value = null;
      }
      await loadRepos('', true);
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    // state
    repos,
    total,
    hasMore,
    currentProjectId,
    loading,
    error,
    // getters
    currentRepo,
    projects,
    // actions
    loadRepos,
    selectProject,
    addProject,
    removeProject,
    clearError,
  };
});
