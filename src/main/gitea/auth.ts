/**
 * 鉴权业务层：auth.connect / auth.disconnect / auth.status
 *
 * 流程（02-architecture.md §6.1 + ADR-0001）：
 *
 *  auth.connect(giteaUrl, token):
 *    1. 调 GET /user 验证 token（用一次性 client，**不**走缓存）
 *    2. 存 keychain（keychainSet）
 *    3. 写 SQLite gitea_accounts 行（**不**含 token）
 *    4. 返回 { account, user } —— **不**返回 token
 *
 *  auth.disconnect(giteaUrl):
 *    1. 列 keychain 里这个 url 的所有 account，逐个 delete
 *    2. 删 SQLite gitea_accounts 行（级联删 repo_projects 等）
 *    3. 清 gitea client 缓存
 *
 *  auth.status():
 *    1. 读 SQLite gitea_accounts + gitea_user（denormalized user 信息）
 *    2. **不**读 keychain
 *    3. **不**调 gitea
 *    4. 返回 { accounts, currentUser } —— 渲染端只能看 user 信息
 *
 *  token 内存缓存：5 min（避免每个 IPC 都读 keychain）
 *  当前 account 选择：M0 简化——按 giteaUrl 单 account；M1 多账号时增加 currentAccountId
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { keychainSet, keychainDelete } from './keychain.js';
import { invalidateGiteaClient, clearGiteaClientCache } from './client.js';

// ===== Dev-only token file fallback =====
// 2026-06-12 修复：macOS dev 模式 sandbox 限制 + @napi-rs/keyring napi helper 二进制
// 无法访问 user keychain → auth.connect 永远返 KEYCHAIN_UNAVAILABLE
// dev fallback: 把 token 写到 userData/dev-tokens/<service>.json (0600)
// prod 完全不动（仍走 system keychain）。
//
// 安全妥协：
// - dev only（isDev check）
// - file 路径走 app.getPath('userData')（dev 下已经被我搬到 /tmp/gitea-kanban-dev）
// - permission 0o600 (owner only)
// - 不写日志
function devTokenDir(): string {
  return join(app.getPath('userData'), 'dev-tokens');
}
function devTokenPath(giteaUrl: string, username: string): string {
  // 文件名编码：service:account 是 keychain 语义；这里同样
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(devTokenDir(), `${safe(giteaUrl)}__${safe(username)}.json`);
}
async function persistToken(giteaUrl: string, username: string, token: string): Promise<void> {
  if (!app.isPackaged) {
    // dev fallback path
    try {
      mkdirSync(devTokenDir(), { recursive: true, mode: 0o700 });
      writeFileSync(devTokenPath(giteaUrl, username), JSON.stringify({ token, ts: Date.now() }), { mode: 0o600 });
      return;
    } catch (err) {
      // fall through to keychain
      void err;
    }
  }
  await keychainSet(giteaUrl, username, token);
}
async function clearDevToken(giteaUrl: string, username: string): Promise<void> {
  if (!app.isPackaged) {
    try {
      const p = devTokenPath(giteaUrl, username);
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
      void err;
    }
  }
}
import { getLocalStore } from '../local/state.js';
import type {
  ConnectArgs,
  ConnectResult,
  StatusResult,
  GiteaAccountDto,
  UserDto,
} from '../ipc/schema.js';

/** 单次校验 token 用的临时 client：直接用 fetch，不读 keychain、不入缓存 */
async function verifyToken(giteaUrl: string, token: string): Promise<UserDto> {
  // 用原生 fetch 一次性验证，**不**走 openapi-fetch 缓存
  const url = `${giteaUrl.replace(/\/+$/, '')}/api/v1/user`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new IpcError({
      code: IpcErrorCode.NETWORK_OFFLINE,
      message: '无法连接 gitea',
      hint: '请检查 giteaUrl 和网络',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    const cause = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    if (res.status === 401 || res.status === 403) {
      throw new IpcError({
        code: IpcErrorCode.TOKEN_INVALID,
        message: 'token 无效或权限不足',
        hint: '请到 gitea 重新生成 token（需要 read:user 权限）',
        cause,
        httpStatus: res.status,
      });
    }
    throw new IpcError({
      code: IpcErrorCode.GITEA_ERROR,
      message: `gitea 返回 ${res.status}`,
      cause,
      httpStatus: res.status,
    });
  }
  const json = (await res.json()) as Record<string, unknown>;
  return {
    id: Number(json['id']),
    login: String(json['login'] ?? ''),
    ...(typeof json['full_name'] === 'string' ? { fullName: json['full_name'] } : {}),
    ...(typeof json['email'] === 'string' ? { email: json['email'] } : {}),
    ...(typeof json['avatar_url'] === 'string' ? { avatarUrl: json['avatar_url'] } : {}),
  };
}

// 修 2026-06-14：现在两处都直接从 localStore.accounts 推 username，不需要
//   keychainFindAccounts 反查（而且 keychain 是 source of truth，user 切了 token
//   它会不同步）—— 用 localStore 更稳定。
// function nowIso() {
//   return new Date().toISOString();
// }

/** auth.connect：调一次 /user，存 keychain，写 SQLite */
export async function authConnect(args: ConnectArgs): Promise<ConnectResult> {
  // 1. 验证 token
  const user = await verifyToken(args.giteaUrl, args.token);

  // 2. 存 token（keychain 优先；dev 模式 fallback 到 file）
  await persistToken(args.giteaUrl, user.login, args.token);

  const now = new Date();
  const nowEpochMs = now.getTime();
  const keychainService = `gitea-kanban@${args.giteaUrl}`;

  // 3a. 写 localStore（ADR-0003 Phase 2 双写：localStore 是 source of truth for accounts）
  //     upsert by (giteaUrl, username) → 走 localStore state.accounts.find
  let finalAccountId: string;
  let finalAccountCreatedAt: number;
  const store = getLocalStore();
  const stateNow = store.get();
  const existingLocal = stateNow.accounts.find(
    (a) => a.giteaUrl === args.giteaUrl && a.username === user.login,
  );
  if (existingLocal) {
    finalAccountId = existingLocal.id;
    finalAccountCreatedAt = existingLocal.createdAt;
    store.mutate((s) => {
      const idx = s.accounts.findIndex((a) => a.id === finalAccountId);
      if (idx >= 0) {
        s.accounts[idx] = {
          ...s.accounts[idx]!,
          keychainService,
        };
      }
    });
  } else {
    finalAccountId = randomUUID();
    finalAccountCreatedAt = nowEpochMs;
    store.mutate((s) => {
      s.accounts.push({
        id: finalAccountId,
        giteaUrl: args.giteaUrl,
        username: user.login,
        keychainService,
        createdAt: nowEpochMs,
        userInfo: null, // 下面 upsert
      });
    });
  }

  // upsert userInfo（denormalized 进同 account）
  store.mutate((s) => {
    const idx = s.accounts.findIndex((a) => a.id === finalAccountId);
    if (idx >= 0) {
      s.accounts[idx] = {
        ...s.accounts[idx]!,
        userInfo: {
          giteaUserId: user.id,
          login: user.login,
          ...(user.fullName ? { fullName: user.fullName } : {}),
          ...(user.email ? { email: user.email } : {}),
          ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
          updatedAt: nowEpochMs,
        },
      };
    }
  });

  // 3b. SQLite 镜像已删（ADR-0003 Phase 3：业务表全走 localStore）


  // 4. 返回结果（**不**含 token）
  const accountDto: GiteaAccountDto = {
    id: finalAccountId,
    giteaUrl: args.giteaUrl,
    username: user.login,
    createdAt: new Date(finalAccountCreatedAt).toISOString(),
  };
  return { account: accountDto, user };
}

/** auth.disconnect：清 keychain + 删 gitea_accounts（级联）
 *  ADR-0003 Phase 2：双写期，localStore 同步删（SQLite 仍删给 Phase 3 兜底） */
export async function authDisconnect(args: { giteaUrl: string }): Promise<void> {
  // 1. 取所有 username 用于清 keychain + 删 localStore
  const store = getLocalStore();
  const stateNow = store.get();
  const targetAccounts = stateNow.accounts.filter((a) => a.giteaUrl === args.giteaUrl);

  if (targetAccounts.length === 0) {
    // 没连过 = 静默成功
    return;
  }

  // 2. 清 token（keychain + dev fallback file）
  const usernames = targetAccounts.map((a) => a.username);
  for (const u of usernames) {
    await keychainDelete(args.giteaUrl, u);
    await clearDevToken(args.giteaUrl, u);
    invalidateGiteaClient(args.giteaUrl, u);
  }

  // 3. 删 localStore accounts（**不**级联 repo_projects / columns / labelMaps / starredBranches
  //    —— 它们是项目实体，跨 account 共享不常见但保留语义；Phase 3 改 schema 时一起处理）
  const removeIds = new Set(targetAccounts.map((a) => a.id));
  store.mutate((s) => {
    s.accounts = s.accounts.filter((a) => !removeIds.has(a.id));
  });

  // 4. 删 SQLite accounts（外键 cascade 会自动删 gitea_user / repo_projects 等）
  // SQLite accounts 镜像已删（ADR-0003 Phase 3：业务表全走 localStore）
}

/** auth.status：纯读 localStore，**不**读 keychain / **不**调 gitea（ADR-0003 Phase 2）
 *
 * 历史：v1 走 SQLite（accounts + gitea_user 两张表 JOIN）；
 * Phase 2 accounts + userInfo 已经在 localStore denormalize，**不**走 SQLite。
 *
 * 边界：返回结构与 v1 完全一致（accounts[] + currentUser），渲染端零变化。
 */
export async function authStatus(): Promise<StatusResult> {
  const state = getLocalStore().get();

  if (state.accounts.length === 0) {
    return { accounts: [], currentUser: null };
  }

  // M0 简化：第一个 account 作为 currentUser（M1 多账号时由渲染端选）
  const firstAccount = state.accounts[0]!;
  const firstUserInfo = firstAccount.userInfo;

  const accounts: GiteaAccountDto[] = state.accounts.map((a) => ({
    id: a.id,
    giteaUrl: a.giteaUrl,
    username: a.username,
    createdAt: new Date(a.createdAt).toISOString(),
  }));

  let currentUser: UserDto | null = null;
  if (firstUserInfo) {
    currentUser = {
      id: firstUserInfo.giteaUserId,
      login: firstUserInfo.login,
      ...(firstUserInfo.fullName ? { fullName: firstUserInfo.fullName } : {}),
      ...(firstUserInfo.email ? { email: firstUserInfo.email } : {}),
      ...(firstUserInfo.avatarUrl ? { avatarUrl: firstUserInfo.avatarUrl } : {}),
    };
  }

  return { accounts, currentUser };
}

/** 测试用：清所有 gitea client 缓存 */
export function _resetGiteaClientCacheForTest(): void {
  clearGiteaClientCache();
}
