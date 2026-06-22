/**
 * accounts 业务接口 —— localStore 中 GiteaAccount[] 的查询
 * (touch v2)
 *
 * 替代 SQLite gitea_accounts + gitea_user（两张表 denormalize 进 accounts[].userInfo）
 *
 * 设计原则（ADR-0003 Phase 2）：
 * - 全部走 LocalStore.get().accounts（**不**走 SQLite）
 * - **不**做缓存（数据小，< 1KB）
 * - 错误处理：找不到 = 返回 null / []，**不**抛 IpcError（与原 SQLite 行为保持一致；
 *   抛错由调用方 resolveGiteaAccount 决定）
 *
 * Phase 2 状态：接口已落地，IPC handler 暂未切（Commit A 准备阶段）
 * 切读路径：把 auth.ts authStatus / authConnect / authDisconnect / ipc/repos.ts resolveGiteaAccount
 * 改成调这里，SQLite 留 fallback（Phase 2 切完后 Phase 3 删 SQLite）
 */

import type { GiteaAccount } from './state.js';

/**
 * 纯函数版：从 LocalState 取所有 account
 *
 * 用法：import { getLocalStore } from './state.js';
 *      const accounts = listAccountsWithStore(getLocalStore().get());
 */
export function listAccountsWithStore(state: { accounts: GiteaAccount[] }): GiteaAccount[] {
  return state.accounts;
}

/**
 * 按 giteaAccountId 找 account —— 替代 resolveGiteaAccount 里的 SELECT WHERE id=?
 *
 * 返回 null 时调用方决定抛什么错（保留原行为：NOT_FOUND + "gitea 账户不存在"）
 */
export function findAccountByIdWithStore(
  state: { accounts: GiteaAccount[] },
  giteaAccountId: string,
): GiteaAccount | null {
  return state.accounts.find((a) => a.id === giteaAccountId) ?? null;
}

/**
 * 按 (giteaUrl, username) 找 account —— 替代 authConnect 里的 upsert 查重
 *
 * 用于 authConnect 判定"是否已有同名 account 决定 update vs insert"
 */
export function findAccountByUrlAndUsernameWithStore(
  state: { accounts: GiteaAccount[] },
  giteaUrl: string,
  username: string,
): GiteaAccount | null {
  return state.accounts.find((a) => a.giteaUrl === giteaUrl && a.username === username) ?? null;
}

/**
 * 取首条 account —— 替代 authStatus 的 "M0 简化：第一个 account 作为 currentUser"
 *
 * 返回 null 时 authStatus 直接返 { accounts: [], currentUser: null }
 */
export function getFirstAccountWithStore(state: { accounts: GiteaAccount[] }): GiteaAccount | null {
  return state.accounts[0] ?? null;
}
