/**
 * projects 业务接口 —— localStore 中 RepoProject[] 的查询
 * (touch v2)
 *
 * 替代 SQLite repo_projects 表
 *
 * 设计原则（ADR-0003 Phase 2）：
 * - 全部走 LocalState.projects
 * - **不**做缓存
 * - 错误：找不到返 null
 *
 * 关联表：
 * - resolveProject.ts：用 findProjectById 拿 (giteaUrl/username/owner/repo)
 * - ipc/repos.ts addProject / removeProject / touchLastSync：Phase 2 切写路径
 *   时再加，本文件 Commit A 只暴露读
 */

import type { RepoProject } from './state.js';

/**
 * 按 giteaAccountId 列该账号下所有 project —— 替代 cache/repos.ts listProjectsForAccount
 */
export function listProjectsByAccountWithStore(
  state: { projects: RepoProject[] },
  giteaAccountId: string,
): RepoProject[] {
  return state.projects.filter((p) => p.giteaAccountId === giteaAccountId);
}

/**
 * 按 (giteaAccountId, owner, name) 找 project —— 替代 findProject
 */
export function findProjectWithStore(
  state: { projects: RepoProject[] },
  args: { giteaAccountId: string; owner: string; name: string },
): RepoProject | null {
  return (
    state.projects.find(
      (p) =>
        p.giteaAccountId === args.giteaAccountId &&
        p.owner === args.owner &&
        p.name === args.name,
    ) ?? null
  );
}

/**
 * 按 projectId 找 project —— 替代 board/resolveProject.ts 的 SELECT WHERE id=?
 *
 * 用法：resolveProject.ts 切读路径后调这里
 */
export function findProjectByIdWithStore(
  state: { projects: RepoProject[] },
  projectId: string,
): RepoProject | null {
  return state.projects.find((p) => p.id === projectId) ?? null;
}

/**
 * 批量按 (owner, name) 找 —— 替代 cache/repos.ts findProjectsByOwnerName
 *
 * 返回 Map<"owner/name", RepoProject>，用于 repos.list 渲染时 JOIN gitea 仓库跟本地项目状态
 */
export function findProjectsByOwnerNameWithStore(
  state: { projects: RepoProject[] },
  giteaAccountId: string,
  pairs: ReadonlyArray<{ owner: string; name: string }>,
): Map<string, RepoProject> {
  const result = new Map<string, RepoProject>();
  for (const p of state.projects) {
    if (p.giteaAccountId !== giteaAccountId) continue;
    if (pairs.some((q) => q.owner === p.owner && q.name === p.name)) {
      result.set(`${p.owner}/${p.name}`, p);
    }
  }
  return result;
}
