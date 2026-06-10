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
import { IpcError, IpcErrorCode } from '@shared/errors';
import { keychainSet, keychainDelete, keychainFindAccounts } from './keychain.js';
import { invalidateGiteaClient, clearGiteaClientCache } from './client.js';
import { getDb } from '../cache/sqlite.js';
import { giteaAccounts, giteaUser } from '../cache/schema/index.js';
import { eq } from 'drizzle-orm';
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

function nowIso(): string {
  return new Date().toISOString();
}

/** auth.connect：调一次 /user，存 keychain，写 SQLite */
export async function authConnect(args: ConnectArgs): Promise<ConnectResult> {
  // 1. 验证 token
  const user = await verifyToken(args.giteaUrl, args.token);

  // 2. 存 keychain
  await keychainSet(args.giteaUrl, user.login, args.token);

  // 3. 写 SQLite
  const db = getDb();
  const accountId = randomUUID();
  const now = new Date();

  // upsert gitea_accounts（同一 giteaUrl+username 幂等）
  const existing = db
    .select()
    .from(giteaAccounts)
    .where(eq(giteaAccounts.giteaUrl, args.giteaUrl))
    .all()
    .find((r) => r.username === user.login);

  let finalAccountId: string;
  if (existing) {
    finalAccountId = existing.id;
    db.update(giteaAccounts)
      .set({ keychainService: `gitea-kanban@${args.giteaUrl}` })
      .where(eq(giteaAccounts.id, existing.id))
      .run();
  } else {
    db.insert(giteaAccounts)
      .values({
        id: accountId,
        giteaUrl: args.giteaUrl,
        username: user.login,
        keychainService: `gitea-kanban@${args.giteaUrl}`,
        createdAt: now,
      })
      .run();
    finalAccountId = accountId;
  }

  // upsert gitea_user（denormalized user info）
  const existingUser = db
    .select()
    .from(giteaUser)
    .where(eq(giteaUser.giteaAccountId, finalAccountId))
    .all()[0];
  if (existingUser) {
    db.update(giteaUser)
      .set({
        giteaUserId: user.id,
        login: user.login,
        fullName: user.fullName ?? null,
        email: user.email ?? null,
        avatarUrl: user.avatarUrl ?? null,
        updatedAt: now,
      })
      .where(eq(giteaUser.id, existingUser.id))
      .run();
  } else {
    db.insert(giteaUser)
      .values({
        id: randomUUID(),
        giteaAccountId: finalAccountId,
        giteaUserId: user.id,
        login: user.login,
        fullName: user.fullName ?? null,
        email: user.email ?? null,
        avatarUrl: user.avatarUrl ?? null,
        updatedAt: now,
      })
      .run();
  }

  // 4. 返回结果（**不**含 token）
  const accountDto: GiteaAccountDto = {
    id: finalAccountId,
    giteaUrl: args.giteaUrl,
    username: user.login,
    createdAt: existing?.createdAt?.toISOString?.() ?? nowIso(),
  };
  return { account: accountDto, user };
}

/** auth.disconnect：清 keychain + 删 gitea_accounts（级联） */
export async function authDisconnect(args: { giteaUrl: string }): Promise<void> {
  const db = getDb();
  const rows = db
    .select()
    .from(giteaAccounts)
    .where(eq(giteaAccounts.giteaUrl, args.giteaUrl))
    .all();

  if (rows.length === 0) {
    // 没连过 = 静默成功
    return;
  }

  // 1. 清 keychain（按 url 列所有 username）
  const usernames = await keychainFindAccounts(args.giteaUrl);
  for (const u of usernames) {
    await keychainDelete(args.giteaUrl, u);
    invalidateGiteaClient(args.giteaUrl, u);
  }

  // 2. 删 SQLite accounts（外键 cascade 会自动删 gitea_user / repo_projects / ...）
  for (const r of rows) {
    db.delete(giteaAccounts).where(eq(giteaAccounts.id, r.id)).run();
  }
}

/** auth.status：纯读 SQLite，**不**读 keychain / **不**调 gitea */
export async function authStatus(): Promise<StatusResult> {
  const db = getDb();
  const accountRows = db.select().from(giteaAccounts).all();

  if (accountRows.length === 0) {
    return { accounts: [], currentUser: null };
  }

  // M0 简化：第一个 account 作为 currentUser（M1 多账号时由渲染端选）
  const firstAccount = accountRows[0]!;
  const userRow = db
    .select()
    .from(giteaUser)
    .where(eq(giteaUser.giteaAccountId, firstAccount.id))
    .all()[0];

  const accounts: GiteaAccountDto[] = accountRows.map((r) => ({
    id: r.id,
    giteaUrl: r.giteaUrl,
    username: r.username,
    createdAt: r.createdAt.toISOString(),
  }));

  let currentUser: UserDto | null = null;
  if (userRow) {
    currentUser = {
      id: userRow.giteaUserId,
      login: userRow.login,
      ...(userRow.fullName ? { fullName: userRow.fullName } : {}),
      ...(userRow.email ? { email: userRow.email } : {}),
      ...(userRow.avatarUrl ? { avatarUrl: userRow.avatarUrl } : {}),
    };
  }

  return { accounts, currentUser };
}

/** 测试用：清所有 gitea client 缓存 */
export function _resetGiteaClientCacheForTest(): void {
  clearGiteaClientCache();
}
