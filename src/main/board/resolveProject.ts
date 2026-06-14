/**
 * board 业务层通用 helper：通过 projectId 拿到 (giteaUrl, username, owner, repo, defaultBranch)
 *
 * ADR-0003 Phase 3：走 localStore；返 defaultBranch（branches.ts 用来判 isDefault）
 */
import { IpcError, IpcErrorCode } from '@shared/errors';
import { getLocalStore } from '../local/state.js';
import { findProjectByIdWithStore } from '../local/projects.js';
import { findAccountByIdWithStore } from '../local/accounts.js';

export function resolveProject(projectId: string): {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  defaultBranch: string | null;
} {
  const state = getLocalStore().get();
  const proj = findProjectByIdWithStore(state, projectId);
  if (!proj) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '项目不存在',
      hint: '请先在仓库列表中重新添加该仓库为项目',
    });
  }
  const acc = findAccountByIdWithStore(state, proj.giteaAccountId);
  if (!acc) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: 'gitea 账户不存在（项目孤儿）',
      hint: '请重新连接 gitea 账户',
    });
  }
  return {
    giteaUrl: acc.giteaUrl,
    username: acc.username,
    owner: proj.owner,
    repo: proj.name,
    defaultBranch: proj.defaultBranch,
  };
}
