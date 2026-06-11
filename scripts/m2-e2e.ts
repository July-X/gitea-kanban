#!/usr/bin/env -S npx tsx
/**
 * e2e: 真实走 main 端 IPC 链路（不依赖 GUI）
 *
 * 2026-06-11 新增：用户截图报 "Error invoking remote method 'repos.list'"，
 * 但 stderr 没保留，看不到真错。这个脚本直接调 giteaFetch + reposListHandler
 * 走完整 main 端逻辑（除了 ipcMain.handle 的 IPC 序列化层），打印真实错误。
 *
 * 用法：pnpm exec tsx scripts/m2-e2e.ts
 */
import { giteaFetch, clearGiteaClientCache } from '../src/main/gitea/client.js';
import { keychainSet, keychainDelete } from '../src/main/gitea/keychain.js';

const URL = 'http://localhost:3000';
const TOKEN = '9c3fdf27b132c9564b012326344c3993486bf868';
const USER = 'kanban_bot';

let pass = 0, fail = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    pass++;
    console.log(`  ✅ ${name}`);
    return r;
  } catch (e: any) {
    fail++;
    const msg = e?.message ?? e;
    const stack = e?.stack ? `\n${e.stack.split('\n').slice(0, 5).join('\n')}` : '';
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}${stack}`);
  }
}

async function main() {
  console.log(`e2e: ${URL} as ${USER}\n`);

  clearGiteaClientCache();

  // 1. 把 token 写进 keychain（让 getGiteaClient 能取到）
  console.log('[step 1] write token to keychain');
  try {
    await keychainSet(URL, USER, TOKEN);
    console.log('  ✅ keychain set');
  } catch (e: any) {
    console.log(`  ❌ keychain set failed: ${e?.message ?? e}`);
    process.exit(2);
  }

  // 2. 调 giteaFetch /user 验证全局 fetch 路径
  console.log('\n[step 2] giteaFetch /user (走 keychain → globalThis.fetch)');
  await check('giteaFetch /user', async () => {
    const u = await giteaFetch<{ id: number; login: string }>(URL, USER, '/user', { method: 'GET' });
    if (u.login !== USER) throw new Error(`expected ${USER}, got ${u.login}`);
    return u;
  });

  // 2b. 用 native fetch 同样的 URL 验证（确认 gitea 端没问题）
  console.log('\n[step 2b] native fetch /api/v1/user (baseline)');
  await check('native fetch /api/v1/user', async () => {
    const r = await fetch(`${URL}/api/v1/user`, { headers: { Authorization: `token ${TOKEN}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const u = (await r.json()) as { login: string };
    if (u.login !== USER) throw new Error(`expected ${USER}, got ${u.login}`);
    return u;
  });

  // 3. 调 giteaFetch /user/repos 走 listGiteaRepos 真实路径
  console.log('\n[step 3] giteaFetch /user/repos (listGiteaRepos real path)');
  await check('giteaFetch /user/repos?page=1&limit=50', async () => {
    const items = await giteaFetch<unknown[]>(URL, USER, '/user/repos', {
      method: 'GET',
      query: { page: 1, limit: 50 },
    });
    if (!Array.isArray(items)) throw new Error('expected array');
    console.log(`  → got ${items.length} items`);
    return items.length;
  });

  // 3b. （删除 debug 代码 —— 上面 native fetch 验证已通过，URL 拼法正确）
  console.log('\n[step 3b] 跳过 debug，URL 拼法已在上面 native fetch baseline 验证');

  // 4. /orgs/kanban_demo/repos（listGiteaRepos 未来应该走这个，但当前还是 /user/repos）
  console.log('\n[step 4] giteaFetch /orgs/kanban_demo/repos');
  await check('giteaFetch /orgs/kanban_demo/repos', async () => {
    const items = await giteaFetch<unknown[]>(URL, USER, '/orgs/kanban_demo/repos', {
      method: 'GET',
      query: { page: 1, limit: 50 },
    });
    if (!Array.isArray(items)) throw new Error('expected array');
    console.log(`  → got ${items.length} items`);
    return items.length;
  });

  // 5. 清理 keychain
  console.log('\n[step 5] cleanup keychain');
  try {
    await keychainDelete(URL, USER);
    console.log('  ✅ keychain cleared');
  } catch (e: any) {
    console.log(`  ⚠️ keychain clear failed: ${e?.message ?? e}`);
  }

  console.log(`\nResult: ${pass} pass / ${fail} fail`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
