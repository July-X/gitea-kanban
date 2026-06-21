/**
 * Git Graph 本地仓库路径管理（v1.5 · localStore 持久化）
 *
 * 存储位置：localStore.state.prefs['gitgraph.localPath.${projectId}']
 * value: 本地绝对路径字符串
 *
 * 为什么存 prefs 而不是独立模块：
 * - prefs 本身就是 free-form Record<string, unknown>
 * - 加一个独立模块要改 LocalState schema + migration logic
 * - v1.5 是 gitgraph 子系统的内部状态，没必要污染顶层 LocalState
 *
 * 安全：
 * - 只存**路径**，不存 token
 * - 路径由 main 端 cloneRepo() 算出（建议路径）/ 用户手动指定
 * - token 走 keychain（不进 prefs）
 */

import { getLocalStore } from './state.js';

const KEY_PREFIX = 'gitgraph.localPath.';

/** gitgraph 本地路径 pref key（按 projectId 区分） */
export function gitgraphLocalPathKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

/**
 * 读 project 的本地仓库路径
 * @returns 路径字符串；不存在或 store 失败返 null
 */
export function listLocalRepoPath(projectId: string): string | null {
  try {
    const store = getLocalStore();
    const state = store.get();
    const v = state.prefs?.[gitgraphLocalPathKey(projectId)];
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 写 project 的本地仓库路径
 */
export function saveLocalRepoPath(projectId: string, cwd: string): void {
  const store = getLocalStore();
  store.mutate((s) => {
    if (!s.prefs) s.prefs = {};
    s.prefs[gitgraphLocalPathKey(projectId)] = cwd;
  });
}

/**
 * 删 project 的本地仓库路径（用户禁用 Git Graph 时调）
 */
export function deleteLocalRepoPath(projectId: string): void {
  const store = getLocalStore();
  store.mutate((s) => {
    if (s.prefs) delete s.prefs[gitgraphLocalPathKey(projectId)];
  });
}
