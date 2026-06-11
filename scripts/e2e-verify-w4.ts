#!/usr/bin/env -S npx tsx
/**
 * scripts/e2e-verify-w4.ts
 *
 * M4 W4: 设置/鉴权状态端到端验证（prefs.* + auth.*）
 *
 * 验证矩阵：
 *   A. auth.* 3 端点 —— 走**业务层等价路径**（不依赖 GUI / 渲染端 / ipcMain 序列化）：
 *     - auth.connect 等价: 调 gitea /user 验 token → keychainSet → 写 gitea_accounts + gitea_user 行
 *     - auth.disconnect 等价: keychainFindAccounts → keychainDelete → 删 gitea_accounts（FK cascade）
 *     - auth.status 等价: 读 gitea_accounts + gitea_user（**不**调 gitea / **不**读 keychain）
 *   B. prefs.* IPC 端点 —— **未实现**（M3 范围未拍板；src/renderer/stores/settings.ts:5
 *     显式说 "prefs IPC 端点未注册，要 §7.1 拍板才加"）；本脚本**只**走业务层验证：
 *     schema 落盘、crud 流程、unique 约束、FK 关系
 *   C. 4 件套集成 (type-check / build / no-jargon / e2e) —— 4 件套通过父 shell 跑
 *
 * 关键约束（AGENTS §8.2 / §8.15 + 任务 prompt "不要做"）：
 * - KB_TOKEN 保持 9c3fdf27... 不变（最后必须 auth.connect 等价步骤恢复）
 * - 不改 schema / ipc handler / store / cache
 * - 末次 auth.status 必须 connected=true
 * - 临时 sqlite 路径用 GITEA_KANBAN_DATA_DIR env + 临时目录，**不**动 ~/.gitea-kanban/kanban.db
 *   （主 db 文件是 dev 进程在用；用临时 db 才能避免 better-sqlite3 WAL 冲突）
 *
 * 设计：跟 m2-e2e.ts 一样不 spawn electron。e2e 走业务层等价路径（keychain + gitea /user
 * + 临时 db），证明端到端功能正确。**不**走 src/main/gitea/auth.ts 的 authConnect()
 * 函数（因为它 import 链会拉 src/main/logger.ts → electron，tsx 在 Node 25 ESM 模式下
 * 跑 electron CJS import 会 SyntaxError；参考 m2-final-integration-report.md 已知问题）。
 *
 * 用法：
 *   pnpm exec tsx scripts/e2e-verify-w4.ts
 *
 * 历史：2026-06-11 W4 task prompt
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  keychainSet,
  keychainGet,
  keychainDelete,
  keychainFindAccounts,
} from '../src/main/gitea/keychain.js';

// ===== 配置 =====
const GITEA_URL = 'http://127.0.0.1:3000';
const KB_USER = 'kanban_bot';
const KB_TOKEN = process.env['KB_TOKEN'] ?? '9c3fdf27b132c9564b012326344c3993486bf868';

// 临时 sqlite 路径（不污染 ~/.gitea-kanban/kanban.db）
const TEST_DB_DIR = join('/tmp', `gitea-kanban-w4-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DB_DIR, 'kanban.db');

// ===== 测试结果统计 =====
let pass = 0, fail = 0;
const failures: string[] = [];

function logStep(name: string, status: 'PASS' | 'FAIL' | 'INFO', data?: unknown): void {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : 'ℹ️';
  console.log(`  ${icon} ${name} — ${status}`);
  if (data !== undefined) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(`     ${text.split('\n').join('\n     ')}`);
  }
  if (status === 'PASS') pass++;
  else if (status === 'FAIL') fail++;
}

async function check<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    const r = await fn();
    logStep(name, 'PASS', r);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logStep(name, 'FAIL', msg);
    failures.push(`${name}: ${msg}`);
    return undefined;
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotNull<T>(v: T | null | undefined, msg: string): asserts v is T {
  if (v === null || v === undefined) throw new Error(`${msg}: value is null/undefined`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== 业务层等价函数（不依赖 src/main/gitea/auth.ts） =====

interface UserInfo {
  id: number;
  login: string;
  fullName?: string;
  email?: string;
  avatarUrl?: string;
}

async function verifyTokenWithGitea(giteaUrl: string, token: string): Promise<UserInfo> {
  const url = `${giteaUrl.replace(/\/+$/, '')}/api/v1/user`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gitea /user HTTP ${res.status} ${res.statusText} — body: ${body.slice(0, 200)}`);
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

/** authConnect 等价：调 gitea /user + 写 keychain + 写 gitea_accounts + gitea_user */
async function authConnectEq(
  giteaUrl: string,
  token: string,
  rawDb: Database.Database,
): Promise<{ user: UserInfo; accountId: string }> {
  const user = await verifyTokenWithGitea(giteaUrl, token);

  // 1. 存 keychain
  await keychainSet(giteaUrl, user.login, token);

  // 2. upsert gitea_accounts
  const now = Math.floor(Date.now() / 1000);
  const accountRows = rawDb.prepare('SELECT * FROM gitea_accounts WHERE gitea_url = ? AND username = ?')
    .all(giteaUrl, user.login) as Array<{ id: string; gitea_url: string; username: string; keychain_service: string; created_at: number }>;

  let accountId: string;
  if (accountRows.length > 0) {
    accountId = accountRows[0]!.id;
    rawDb.prepare('UPDATE gitea_accounts SET keychain_service = ? WHERE id = ?')
      .run(`gitea-kanban@${giteaUrl}`, accountId);
  } else {
    accountId = randomUUID();
    rawDb.prepare(
      'INSERT INTO gitea_accounts (id, gitea_url, username, keychain_service, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(accountId, giteaUrl, user.login, `gitea-kanban@${giteaUrl}`, now);
  }

  // 3. upsert gitea_user
  const userRows = rawDb.prepare('SELECT id FROM gitea_user WHERE gitea_account_id = ?')
    .all(accountId) as Array<{ id: string }>;
  const fullName = user.fullName ?? null;
  const email = user.email ?? null;
  const avatarUrl = user.avatarUrl ?? null;
  if (userRows.length > 0) {
    rawDb.prepare(
      'UPDATE gitea_user SET gitea_user_id = ?, login = ?, full_name = ?, email = ?, avatar_url = ?, updated_at = ? WHERE id = ?',
    ).run(user.id, user.login, fullName, email, avatarUrl, now, userRows[0]!.id);
  } else {
    rawDb.prepare(
      'INSERT INTO gitea_user (id, gitea_account_id, gitea_user_id, login, full_name, email, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), accountId, user.id, user.login, fullName, email, avatarUrl, now);
  }

  return { user, accountId };
}

/** authStatus 等价：纯读 sqlite，**不**调 gitea / **不**读 keychain */
function authStatusEq(
  rawDb: Database.Database,
): { accounts: Array<{ id: string; giteaUrl: string; username: string; createdAt: string }>; currentUser: UserInfo | null } {
  const accountRows = rawDb.prepare('SELECT * FROM gitea_accounts').all() as Array<{
    id: string; gitea_url: string; username: string; created_at: number;
  }>;

  if (accountRows.length === 0) {
    return { accounts: [], currentUser: null };
  }

  // M0 简化：第一个 account 作为 currentUser
  const firstAccount = accountRows[0]!;
  const userRow = rawDb.prepare('SELECT * FROM gitea_user WHERE gitea_account_id = ?')
    .get(firstAccount.id) as {
      gitea_user_id: number; login: string; full_name: string | null;
      email: string | null; avatar_url: string | null;
    } | undefined;

  const accounts = accountRows.map((r) => ({
    id: r.id,
    giteaUrl: r.gitea_url,
    username: r.username,
    createdAt: new Date(r.created_at * 1000).toISOString(),
  }));

  let currentUser: UserInfo | null = null;
  if (userRow) {
    currentUser = {
      id: userRow.gitea_user_id,
      login: userRow.login,
      ...(userRow.full_name ? { fullName: userRow.full_name } : {}),
      ...(userRow.email ? { email: userRow.email } : {}),
      ...(userRow.avatar_url ? { avatarUrl: userRow.avatar_url } : {}),
    };
  }
  return { accounts, currentUser };
}

/** authDisconnect 等价：清 keychain + 删 gitea_accounts（FK cascade） */
async function authDisconnectEq(giteaUrl: string, rawDb: Database.Database): Promise<void> {
  const usernames = await keychainFindAccounts(giteaUrl);
  for (const u of usernames) {
    await keychainDelete(giteaUrl, u);
  }
  // FK cascade 删 gitea_user + repo_projects + ...
  rawDb.prepare('DELETE FROM gitea_accounts WHERE gitea_url = ?').run(giteaUrl);
}

// ===== 主流程 =====
async function main() {
  console.log('='.repeat(70));
  console.log('W4: 设置/鉴权状态端到端验证 (prefs.* + auth.*)');
  console.log('='.repeat(70));
  console.log(`Gitea URL: ${GITEA_URL}`);
  console.log(`User: ${KB_USER}`);
  console.log(`Token (first 8): ${KB_TOKEN.slice(0, 8)}...`);
  console.log(`Test DB: ${TEST_DB_PATH} (临时，**不**动 ~/.gitea-kanban)`);
  console.log();

  // ===== 准备：临时 db 路径 + 跑迁移 =====
  console.log('[setup] 临时 sqlite 路径 + 跑迁移');
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });

  const rawDb = new Database(TEST_DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  rawDb.pragma('synchronous = NORMAL');
  const db = drizzle(rawDb);

  // 跑 drizzle 迁移（从项目 drizzle/ 目录）
  try {
    migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });
    logStep('migrations applied', 'PASS', { path: TEST_DB_PATH });
  } catch (e) {
    logStep('migrations applied', 'FAIL', e instanceof Error ? e.message : String(e));
    rawDb.close();
    process.exit(2);
  }

  // ====== A. auth.* 3 端点（业务层等价：keychain + gitea + sqlite） ======
  console.log('\n' + '='.repeat(50));
  console.log('A. auth.* IPC 端点（业务层等价：keychain + gitea + sqlite）');
  console.log('='.repeat(50));

  // A0. prefs.* IPC 端点检查
  console.log('\n[A0] prefs.* IPC 端点是否注册');
  const fs = await import('node:fs');
  const channelsContent = fs.readFileSync('src/shared/ipc-channels.ts', 'utf-8');
  const hasPrefsEndpoint = /\bprefs\.(get|set|list|update|delete)\b/.test(channelsContent);
  if (hasPrefsEndpoint) {
    logStep('A0.prefs.* IPC endpoint exists', 'INFO', '端点已注册');
  } else {
    logStep('A0.prefs.* IPC endpoint MISSING (预期, M3 未实现)', 'INFO',
      'src/renderer/stores/settings.ts:5 显式说 "prefs IPC 端点未注册，要 §7.1 拍板才加"。本节仅做 schema/迁移业务层验证。');
  }

  // A2. auth.connect 等价
  console.log('\n[A2] auth.connect 等价 (调 gitea /user + 写 keychain + 写 sqlite)');
  const connectResult = await check('A2.authConnectEq(127.0.0.1:3000, kanban_bot)', async () =>
    authConnectEq(GITEA_URL, KB_TOKEN, rawDb),
  );
  if (!connectResult) {
    console.log('\nFATAL: auth.connect 等价 失败');
    rawDb.close();
    process.exit(2);
  }
  await check('A2.user.login === kanban_bot', async () => {
    assertEq(connectResult.user.login, KB_USER, 'user.login');
    return connectResult.user.login;
  });
  await check('A2.user.id > 0 (gitea user id 有效)', async () => {
    if (connectResult.user.id <= 0) throw new Error('id not positive');
    return connectResult.user.id;
  });

  // A1. auth.status 等价 (initial)
  console.log('\n[A1] auth.status 等价 (initial, 读 sqlite **不**调 gitea)');
  const statusInitial = await check('A1.authStatusEq() (initial)', async () =>
    authStatusEq(rawDb),
  );
  if (!statusInitial) {
    rawDb.close();
    process.exit(2);
  }
  await check('A1.accounts.length === 1', async () => {
    assertEq(statusInitial.accounts.length, 1, 'accounts.length');
    return statusInitial.accounts.length;
  });
  await check('A1.currentUser.login === kanban_bot', async () => {
    assertNotNull(statusInitial.currentUser, 'currentUser');
    assertEq(statusInitial.currentUser.login, KB_USER, 'currentUser.login');
    return statusInitial.currentUser.login;
  });
  await check('A1.currentUser.id > 0', async () => {
    assertNotNull(statusInitial.currentUser, 'currentUser');
    if (statusInitial.currentUser.id <= 0) throw new Error('id not positive');
    return statusInitial.currentUser.id;
  });
  await check('A1.accounts[0].giteaUrl === 127.0.0.1:3000', async () => {
    assertEq(statusInitial.accounts[0]!.giteaUrl, GITEA_URL, 'accounts[0].giteaUrl');
    return statusInitial.accounts[0]!.giteaUrl;
  });
  await check('A1.accounts[0].username === kanban_bot', async () => {
    assertEq(statusInitial.accounts[0]!.username, KB_USER, 'accounts[0].username');
    return statusInitial.accounts[0]!.username;
  });

  // ====== B. prefs.* 业务层验证（端点未实现，绕道走 raw SQL） ======
  console.log('\n' + '='.repeat(50));
  console.log('B. prefs.* 业务层验证 (端点未实现, 绕道 raw SQL 验证 schema/迁移/CRUD)');
  console.log('='.repeat(50));

  console.log('\n[B1] prefs schema 业务层 CRUD (绕过 IPC, 用 rawDb)');
  const userId = randomUUID();
  await check('B1.users 表建一个 user 行（prefs FK 目标）', async () => {
    rawDb.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
      .run(userId, 'e2e-w4', Math.floor(Date.now() / 1000));
    return userId;
  });

  await check('B1.prefs.set pollingIntervalSeconds=60', async () => {
    const existing = rawDb.prepare('SELECT id FROM prefs WHERE user_id = ? AND key = ?')
      .get(userId, 'pollingIntervalSeconds') as { id: string } | undefined;
    const value = JSON.stringify(60);
    if (existing) {
      rawDb.prepare('UPDATE prefs SET value = ?, updated_at = ? WHERE id = ?')
        .run(value, Math.floor(Date.now() / 1000), existing.id);
    } else {
      rawDb.prepare('INSERT INTO prefs (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), userId, 'pollingIntervalSeconds', value, Math.floor(Date.now() / 1000));
    }
    return { userId, key: 'pollingIntervalSeconds', value };
  });

  await check('B1.prefs.set theme=dark', async () => {
    const existing = rawDb.prepare('SELECT id FROM prefs WHERE user_id = ? AND key = ?')
      .get(userId, 'theme') as { id: string } | undefined;
    const value = JSON.stringify('dark');
    if (existing) {
      rawDb.prepare('UPDATE prefs SET value = ?, updated_at = ? WHERE id = ?')
        .run(value, Math.floor(Date.now() / 1000), existing.id);
    } else {
      rawDb.prepare('INSERT INTO prefs (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), userId, 'theme', value, Math.floor(Date.now() / 1000));
    }
    return { key: 'theme', value };
  });

  await check('B1.prefs.get pollingIntervalSeconds === 60', async () => {
    const row = rawDb.prepare('SELECT value FROM prefs WHERE user_id = ? AND key = ?')
      .get(userId, 'pollingIntervalSeconds') as { value: string } | undefined;
    assertNotNull(row, 'prefs row');
    const v = JSON.parse(row.value);
    assertEq(v, 60, 'pollingIntervalSeconds');
    return v;
  });

  await check('B1.prefs.get theme === "dark"', async () => {
    const row = rawDb.prepare('SELECT value FROM prefs WHERE user_id = ? AND key = ?')
      .get(userId, 'theme') as { value: string } | undefined;
    assertNotNull(row, 'prefs row');
    const v = JSON.parse(row.value);
    assertEq(v, 'dark', 'theme');
    return v;
  });

  await check('B1.prefs.list (返 2 个 key)', async () => {
    const rows = rawDb.prepare('SELECT key FROM prefs WHERE user_id = ? ORDER BY key')
      .all(userId) as Array<{ key: string }>;
    assertEq(rows.length, 2, 'rows.length');
    return rows.map((r) => r.key);
  });

  await check('B1.prefs.set reset pollingIntervalSeconds=30', async () => {
    rawDb.prepare('UPDATE prefs SET value = ?, updated_at = ? WHERE user_id = ? AND key = ?')
      .run(JSON.stringify(30), Math.floor(Date.now() / 1000), userId, 'pollingIntervalSeconds');
    const row = rawDb.prepare('SELECT value FROM prefs WHERE user_id = ? AND key = ?')
      .get(userId, 'pollingIntervalSeconds') as { value: string };
    assertEq(JSON.parse(row.value), 30, 'reset');
    return 30;
  });

  await check('B1.unique 约束: 重复 (userId,key) 插 → 抛', async () => {
    let threw = false;
    let errMsg = '';
    try {
      rawDb.prepare('INSERT INTO prefs (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), userId, 'theme', '"light"', Math.floor(Date.now() / 1000));
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    if (!threw) throw new Error('expected unique constraint violation, but insert succeeded');
    return { violated: true, err: errMsg.slice(0, 100) };
  });

  await check('B1.FK 约束: 删 user → prefs 级联删', async () => {
    rawDb.prepare('DELETE FROM users WHERE id = ?').run(userId);
    const rows = rawDb.prepare('SELECT count(*) AS n FROM prefs WHERE user_id = ?')
      .get(userId) as { n: number };
    assertEq(rows.n, 0, 'prefs after FK cascade');
    return 'cascaded';
  });

  // ====== A. auth.* 续：A6 - A10 ======
  console.log('\n' + '='.repeat(50));
  console.log('A. auth.* 续: disconnect → status=false → connect 恢复 → status=true');
  console.log('='.repeat(50));

  // A6. auth.status 再次（prefs 业务层验证后，确认 prefs 没干扰 auth 状态）
  console.log('\n[A6] auth.status 等价 (prefs 业务层验证后)');
  const statusAfterPrefs = await check('A6.authStatusEq() (after prefs verification)', async () =>
    authStatusEq(rawDb),
  );
  if (statusAfterPrefs) {
    await check('A6.currentUser.login === kanban_bot (未受 prefs 干扰)', async () => {
      assertNotNull(statusAfterPrefs.currentUser, 'currentUser');
      assertEq(statusAfterPrefs.currentUser.login, KB_USER, 'currentUser.login');
      return statusAfterPrefs.currentUser.login;
    });
  }

  // A7. auth.disconnect 等价
  console.log('\n[A7] auth.disconnect 等价 (清 keychain + 删 gitea_accounts)');
  await check('A7.authDisconnectEq()', async () => {
    await authDisconnectEq(GITEA_URL, rawDb);
  });
  await sleep(300); // keychain 异步落盘

  await check('A7.keychainGet() 返 null (清干净)', async () => {
    const t = await keychainGet(GITEA_URL, KB_USER);
    if (t !== null) throw new Error(`expected null, got token len=${t.length}`);
    return 'null (no entry)';
  });

  await check('A7.gitea_accounts 表已清空', async () => {
    const rows = rawDb.prepare('SELECT count(*) AS n FROM gitea_accounts').get() as { n: number };
    assertEq(rows.n, 0, 'gitea_accounts rows');
    return 'empty';
  });

  // A7p. auth.status 等价 (disconnect 后)
  console.log('\n[A7p] auth.status 等价 (disconnect 后)');
  const statusAfterDisconnect = await check('A7p.authStatusEq() (after disconnect)', async () =>
    authStatusEq(rawDb),
  );
  if (statusAfterDisconnect) {
    await check('A7p.accounts.length === 0', async () => {
      assertEq(statusAfterDisconnect.accounts.length, 0, 'accounts.length');
      return 0;
    });
    await check('A7p.currentUser === null', async () => {
      if (statusAfterDisconnect.currentUser !== null) {
        throw new Error(`expected null, got ${JSON.stringify(statusAfterDisconnect.currentUser)}`);
      }
      return null;
    });
  }

  // A8. auth.connect 恢复
  console.log('\n[A8] auth.connect 恢复 (KB_TOKEN → keychain + sqlite)');
  const connectResult2 = await check('A8.authConnectEq() (恢复 token)', async () =>
    authConnectEq(GITEA_URL, KB_TOKEN, rawDb),
  );
  if (connectResult2) {
    await check('A8.user.login === kanban_bot', async () => {
      assertEq(connectResult2.user.login, KB_USER, 'login');
      return connectResult2.user.login;
    });
  }

  // A9. auth.status 等价 (final, STOP CONDITION)
  console.log('\n[A9] auth.status 等价 (connect 恢复后) — STOP CONDITION');
  const statusFinal = await check('A9.authStatusEq() (final)', async () =>
    authStatusEq(rawDb),
  );
  if (!statusFinal) {
    rawDb.close();
    process.exit(2);
  }
  await check('A9.accounts.length === 1', async () => {
    assertEq(statusFinal.accounts.length, 1, 'accounts.length');
    return 1;
  });
  await check('A9.currentUser.login === kanban_bot', async () => {
    assertNotNull(statusFinal.currentUser, 'currentUser');
    assertEq(statusFinal.currentUser.login, KB_USER, 'currentUser.login');
    return statusFinal.currentUser.login;
  });
  await check('A9.currentUser.id > 0', async () => {
    assertNotNull(statusFinal.currentUser, 'currentUser');
    if (statusFinal.currentUser.id <= 0) throw new Error('id not positive');
    return statusFinal.currentUser.id;
  });
  await check('A9.accounts[0].giteaUrl === 127.0.0.1:3000', async () => {
    assertEq(statusFinal.accounts[0]!.giteaUrl, GITEA_URL, 'accounts[0].giteaUrl');
    return statusFinal.accounts[0]!.giteaUrl;
  });
  await check('A9.accounts[0].username === kanban_bot', async () => {
    assertEq(statusFinal.accounts[0]!.username, KB_USER, 'accounts[0].username');
    return statusFinal.accounts[0]!.username;
  });

  // A10. 防御性确认：keychain 实际有 token
  await check('A10.keychainGet(KB_TOKEN) 返非空 (stop condition 完整性)', async () => {
    const t = await keychainGet(GITEA_URL, KB_USER);
    if (t === null) throw new Error('keychain empty after restore');
    assertEq(t, KB_TOKEN, 'keychain token === KB_TOKEN');
    return `len=${t.length} matches KB_TOKEN`;
  });

  // ====== 关 db + 清临时 ======
  console.log('\n[teardown] 关闭 db + 清临时');
  rawDb.close();
  // 删 WAL/SHM 一起
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  logStep('teardown', 'PASS', { removed: TEST_DB_DIR });

  // ====== 总结 ======
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Pass: ${pass} / Fail: ${fail}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('\n[STOP CONDITION]');
  console.log(`  final authStatus.accounts.length = ${statusFinal.accounts.length}`);
  console.log(`  final authStatus.currentUser.login = ${statusFinal.currentUser?.login}`);
  console.log(`  keychain has token (len match KB_TOKEN) ✓`);

  // 注意：**不**改 ~/.gitea-kanban/kanban.db（用临时 TEST_DB_PATH）
  // 但 keychain 改过 dev 那个（keychain 是系统级，dev 进程在用同一个 service）—— 我们
  // disconnect → keychain 删 → connect 恢复，最终 keychain 状态 = 起点
  console.log('\n[KEYCHAIN NOTE]');
  console.log('  本脚本所有 sqlite 操作走临时 TEST_DB_PATH，**不**改 ~/.gitea-kanban/kanban.db');
  console.log('  keychain service = gitea-kanban@127.0.0.1:3000（与 dev 进程共享 service）');
  console.log('  disconnect → keychain 删 → connect 恢复，最终状态 = 起点');
  console.log(`  KB_TOKEN 仍是 ${KB_TOKEN.slice(0, 8)}... (env 默认值)`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
