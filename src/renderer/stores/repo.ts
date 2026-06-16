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
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { ListReposResp, RepoDto, RepoProjectDto } from '../../main/ipc/schema.js';
import { useAuthStore } from '@renderer/stores/auth';

export const useRepoStore = defineStore('repo', () => {
  // ===== state =====
  const repos = ref<RepoDto[]>([]);
  const total = ref(0);
  const hasMore = ref(false);
  /**
   * 权威当前 project（**uuid 源** —— 所有 IPC 端点要的就是这个）
   *
   * 历史（2026-06-11 bug 修复）：
   * - 旧实现 currentProjectId 直接存 fullName，IPC 端点（board.columns.list / branches.list 等）
   *   拿 fullName 去 sqlite 查 repo_projects 主键 = uuid → 全部 not_found
   * - 修复：currentProject 存 RepoProjectDto；currentProjectId 退化成 computed 返 uuid；
   *   currentRepo 仍用 fullName 查（UI 反查 RepoDto 不变）
   * - selectProject 接受 string 时兼容两种语义：先查 projects[] 找 uuid（fullName 匹配），
   *   找不到再当 uuid 直接存（route 跳转/老 caller）。新代码推荐传 RepoProjectDto
   */
  const currentProject = ref<RepoProjectDto | null>(null);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);

  // ===== getters =====
  /** 给 IPC 用的 uuid —— 看板/时间轴/分支/合并的 projectId 参数都走这个 */
  const currentProjectId = computed<string | null>(() => currentProject.value?.id ?? null);
  /** 给 UI 反查 RepoDto（侧栏显示/高亮）用的 fullName —— 兼容 caller 传 fullName 时仍能 find */
  const currentRepo = computed<RepoDto | null>(() => {
    const fullName = currentProject.value
      ? `${currentProject.value.owner}/${currentProject.value.name}`
      : null;
    if (!fullName) return null;
    return repos.value.find((r) => r.fullName === fullName) ?? null;
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
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 选中当前 project（**uuid 源**）
   *
   * 只接受 RepoProjectDto | null —— 强类型保证 IPC 拿到真 uuid，不再有 fullName 误用空间。
   * 老 caller（传 fullName string）已迁移：调 addProject() 拿到 RepoProjectDto 再传进来。
   *
   * 历史（2026-06-11 bug 修复）：
   * 旧实现 selectProject 接受 string + currentProjectId 直接存 fullName，导致
   * 所有 IPC 端点（board.columns.list / branches.list / etc.）拿 fullName 去
   * sqlite 查 repo_projects 主键（uuid）→ 全部 not_found
   */
  function selectProject(project: RepoProjectDto | null): void {
    currentProject.value = project;
  }

  /**
   * 把仓库加为本机 project（加入看板）
   *
   * 修复（2026-06-11）：接收后端返的 RepoProjectDto（uuid 源），**自动选中新加的 project**。
   * 旧实现丢了返回值，uuid 在前端就消失了 → 看板 IPC 全部 not_found。
   */
  async function addProject(args: { owner: string; name: string }): Promise<RepoProjectDto> {
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
      const project = (await reposAddProject({
        giteaAccountId: accountId,
        ...args,
      })) as RepoProjectDto;
      // 刷新列表让 isProject 标记更新
      await loadRepos('', true);
      // 选中新加的 project（uuid 源）
      currentProject.value = project;
      return project;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 取消本机 project 标记（**不**删远端仓库）
   *
   * 接受 fullName 或 uuid（兼容老 caller）。内部解析成 uuid 再调 IPC。
   * 后端 cacheRemoveProject 用 `eq(repoProjects.id, projectId)` 删，必须 uuid。
   */
  async function removeProject(projectId: string): Promise<void> {
    const uuid = resolveProjectUuid(projectId);
    if (!uuid) {
      // 找不到对应 project —— 静默成功（cache 端是幂等的）
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      await reposRemoveProject({ projectId: uuid });
      if (currentProject.value?.id === uuid) {
        currentProject.value = null;
      }
      await loadRepos('', true);
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 内部 helper：把 caller 传的 fullName / uuid 解析成真 uuid
   * - 当前选中的 project（fullName 或 uuid 匹配）→ 用 currentProject.id
   * - projects[] 里的 RepoDto（按 fullName 找）→ **没有真 uuid**（RepoDto 不带 projectId 字段）
   *   这种情况下**返回 null** —— caller 应当用 addProject 的返回值走
   *
   * 已知限制：projects[] 来自 JOIN isProject=true 的 RepoDto，没 projectId（uuid）字段
   * 这是 schema 设计权衡：UI 列的"已加为项目"用 fullName 即可，不需要 uuid
   * 真 uuid 只能从 addProject 返回 / currentProject.id 来
   */
  function resolveProjectUuid(input: string): string | null {
    if (currentProject.value && (currentProject.value.id === input || `${currentProject.value.owner}/${currentProject.value.name}` === input)) {
      return currentProject.value.id;
    }
    return null;
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    // state
    repos,
    total,
    hasMore,
    currentProject,
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
