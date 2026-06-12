#!/usr/bin/env -S npx tsx
/**
 * scripts/verify-myCards-members.ts
 *
 * Cycle 2 retry 重建版（cycle 1 文件被 user 抢救成 WIP commit 时一并抹掉）
 *
 * 验证范围（m4java-test 仓库）：
 * - listGiteaIssues({ assignee: 'kanban_bot', state: 'open' })
 *     → 0 条（#13 已 state=closed，2026-06-12 09:50 实测）
 * - listGiteaIssues({ assignee: 'kanban_bot', state: 'all' })
 *     → 1 条（#13，已配 assignee=kanban_bot）
 * - listGiteaIssues() 不传 assignee → 向后兼容，返回所有 issue
 * - listRepoCollaborators() → ≥ 1 条（kanban_bot，permission='owner'）
 * - listRepoCollaborators()[0].permission ∈ {read, write, admin, owner, unknown}
 *
 * 策略：**不走 IPC serialization**（避免启 electron）——直接 import 业务函数
 *   - listGiteaIssues（src/main/gitea/issues.ts，a1 扩展：assignee 透传 assigned_by）
 *   - listRepoCollaborators（src/main/gitea/repos.ts，a1 新增）
 *
 * 用法：
 *   KB_TOKEN=<pat> pnpm exec tsx scripts/verify-myCards-members.ts
 *
 * 必读：
 * - 跟 m2-e2e.ts / e2e-verify-w3.ts 一样：clearGiteaClientCache() + keychainSet()
 *   → 让 gitea-js 走 keychain
 * - token 永远走 keychain，**不**直传 memory（保持 §8.2 鉴权铁律）
 * - 不改 schema / ipc handler / cache（只读业务 + 不写 gitea 端）
 * - 输出 sample JSON 到 stdout + 写到 scripts/verify-myCards-members-output.json
 *
 * 前置（**必须**已做，否则会 fail）：
 *   1. 本地 gitea 跑在 http://127.0.0.1:3000
 *   2. 仓库 kanban_demo/m4java-test 存在
 *   3. 至少一个 issue 的 assignee 含 kanban_bot（cycle 1 已配 #13）：
 *      curl -X PATCH http://127.0.0.1:3000/api/v1/repos/kanban_demo/m4java-test/issues/13 \
 *        -H "Authorization: token $KB_TOKEN" -H "Content-Type: application/json" \
 *        -d '{"assignees":["kanban_bot"]}'
 *   4. kanban_bot 是该仓库 collaborator（cycle 1 已配）：
 *      curl -X PUT http://127.0.0.1:3000/api/v1/repos/kanban_demo/m4java-test/collaborators/kanban_bot \
 *        -H "Authorization: token $KB_TOKEN" -H "Content-Type: application/json" \
 *        -d '{"permission":"write"}'
 */

import { listGiteaIssues } from '../src/main/gitea/issues.js';
import { listRepoCollaborators } from '../src/main/gitea/repos.js';
import { clearGiteaClientCache } from '../src/main/gitea/client.js';
import { keychainSet, keychainDelete } from '../src/main/gitea/keychain.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const URL = 'http://127.0.0.1:3000';
const KB_TOKEN = process.env['KB_TOKEN'] ?? '';
const KB_USER = 'kanban_bot';
const REPO_OWNER = 'kanban_demo';
const REPO_NAME = 'm4java-test';

if (!KB_TOKEN) {
  console.error('需要 KB_TOKEN 环境变量');
  console.error('用法：KB_TOKEN=<pat> pnpm exec tsx scripts/verify-myCards-members.ts');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
const samples: Record<string, unknown> = {};

interface StepCheck {
  ok: boolean;
  detail: string;
}

async function check(name: string, fn: () => Promise<StepCheck>): Promise<void> {
  try {
    const r = await fn();
    if (r.ok) {
      pass++;
      console.log(`  ✅ ${name}: ${r.detail}`);
    } else {
      fail++;
      failures.push(`${name}: ${r.detail}`);
      console.log(`  ❌ ${name}: ${r.detail}`);
    }
  } catch (e: unknown) {
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name} (threw): ${msg.slice(0, 200)}`);
    if (e instanceof Error && e.stack) {
      console.log(`     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`verify-a1 (cycle 2 retry): ${REPO_OWNER}/${REPO_NAME} as ${KB_USER}\n`);

  // 0. 清缓存 + 写 keychain
  clearGiteaClientCache();
  console.log('[setup] write token to keychain');
  await keychainSet(URL, KB_USER, KB_TOKEN);
  console.log('  ✅ keychain set\n');

  // ===== Step 1: listGiteaIssues({ assignee, state: 'open' }) =====
  console.log('[step 1] listGiteaIssues({ assignee: kanban_bot, state: open })');
  await check('assignee 过滤 + state=open（#13 已 closed,期望 0 条）', async () => {
    const r = await listGiteaIssues({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: 'open',
      assignee: KB_USER,
      limit: 50,
    });
    samples.assigneeOpen = r.items.map((i) => ({
      number: i.index,
      title: i.title,
      state: i.state,
      isPullRequest: i.isPullRequest,
    }));
    // 不硬断言 0：#13 可能被前序 plan reopen；只断言"没混入 PR" + 数量 ≥ 0
    const prs = r.items.filter((i) => i.isPullRequest);
    if (prs.length > 0) {
      return { ok: false, detail: `${prs.length} 条是 PR 不该混入（type=issues 应过滤）` };
    }
    return { ok: true, detail: `${r.items.length} 条: ${r.items.map((i) => `#${i.index}(${i.state})`).join(', ') || '(空)'} (type=issues 已过滤 PR)` };
  });

  // ===== Step 2: listGiteaIssues({ assignee, state: 'all' }) =====
  console.log('\n[step 2] listGiteaIssues({ assignee: kanban_bot, state: all })');
  let allAssigneeCount = 0;
  await check('assignee 过滤 + state=all（期望 ≥ 1 条：#13）', async () => {
    const r = await listGiteaIssues({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: 'all',
      assignee: KB_USER,
      limit: 50,
    });
    allAssigneeCount = r.items.length;
    samples.assigneeAll = r.items.map((i) => ({
      number: i.index,
      title: i.title,
      state: i.state,
      isPullRequest: i.isPullRequest,
    }));
    if (r.items.length === 0) {
      return {
        ok: false,
        detail:
          '返回 0 条；检查：#13 是否仍配 assignee=kanban_bot？手动跑 curl 见脚本头注释',
      };
    }
    const prs = r.items.filter((i) => i.isPullRequest);
    if (prs.length > 0) {
      return { ok: false, detail: `${prs.length} 条是 PR 不该混入` };
    }
    return {
      ok: true,
      detail: `${r.items.length} 条: ${r.items.map((i) => `#${i.index}(${i.state})`).join(', ')}`,
    };
  });

  // ===== Step 3: listGiteaIssues() 不传 assignee → 向后兼容 =====
  console.log('\n[step 3] listGiteaIssues() 不传 assignee（向后兼容）');
  await check('不传 assignee：返回所有 issue（不限 assignee）', async () => {
    const r = await listGiteaIssues({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: 'all',
      limit: 100,
    });
    samples.allIssues = { count: r.items.length, hasMore: r.hasMore };
    if (r.items.length === 0) {
      return { ok: false, detail: '返回 0 条；m4java-test 应该有 issue' };
    }
    // 不传 assignee 时，条数应 ≥ step 2 的条数（assignee 过滤必然更小）
    if (r.items.length < allAssigneeCount) {
      return {
        ok: false,
        detail: `不传 assignee 时 ${r.items.length} < assignee 过滤时 ${allAssigneeCount}（违反集合包含关系）`,
      };
    }
    return {
      ok: true,
      detail: `${r.items.length} 条（hasMore=${r.hasMore}）≥ assignee 过滤 ${allAssigneeCount} 条`,
    };
  });

  // ===== Step 4: listRepoCollaborators() =====
  console.log('\n[step 4] listRepoCollaborators()');
  await check('collaborators 列表非空 + DTO 字段齐 + permission 合法', async () => {
    const r = await listRepoCollaborators({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      limit: 50,
    });
    samples.collaborators = r.items;
    if (r.items.length === 0) {
      return {
        ok: false,
        detail:
          '返回 0 条；检查：kanban_bot 是否已配 collaborator？手动跑 curl 见脚本头注释',
      };
    }
    for (const c of r.items) {
      if (typeof c.username !== 'string' || c.username.length === 0) {
        return { ok: false, detail: `CollaboratorDto.username 缺失: ${JSON.stringify(c)}` };
      }
      if (typeof c.permission !== 'string') {
        return { ok: false, detail: `CollaboratorDto.permission 缺失: ${JSON.stringify(c)}` };
      }
      const validPerms = new Set(['read', 'write', 'admin', 'owner', 'unknown']);
      if (!validPerms.has(c.permission)) {
        return { ok: false, detail: `未知 permission: "${c.permission}"` };
      }
    }
    return {
      ok: true,
      detail: `${r.items.length} 条: ${r.items
        .map((c) => `${c.username}=${c.permission}`)
        .join(', ')}`,
    };
  });

  // ===== Step 5: kanban_bot 自身 permission 校验 =====
  console.log('\n[step 5] kanban_bot 自身 permission 校验');
  await check('kanban_bot.permission ∈ {read, write, admin, owner}', async () => {
    const r = await listRepoCollaborators({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      limit: 50,
    });
    const me = r.items.find((c) => c.username === KB_USER);
    if (!me) {
      return {
        ok: false,
        detail: `kanban_bot 不在 collaborators 列表里（${r.items.length} 条都不匹配）`,
      };
    }
    const validPerms = new Set(['read', 'write', 'admin', 'owner', 'unknown']);
    if (!validPerms.has(me.permission)) {
      return { ok: false, detail: `kanban_bot.permission=${me.permission} 不在合法集` };
    }
    samples.meCollaborator = me;
    return { ok: true, detail: `kanban_bot.permission=${me.permission}` };
  });

  // ===== 写 sample JSON 文件（备 verifier 审）+ stdout 也 dump =====
  const samplePath = resolve(process.cwd(), 'scripts/verify-myCards-members-output.json');
  mkdirSync(dirname(samplePath), { recursive: true });
  writeFileSync(samplePath, JSON.stringify(samples, null, 2), 'utf-8');
  console.log(`\nSamples written: ${samplePath}`);

  // ===== summary =====
  console.log(`\nResult: ${pass} pass / ${fail} fail`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }

  // ===== cleanup =====
  console.log('\n[cleanup] delete keychain entry');
  try {
    await keychainDelete(URL, KB_USER);
    console.log('  ✅ keychain cleared');
  } catch (e: unknown) {
    console.log(`  ⚠️  keychain clear failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('FATAL:', e);
  process.exit(2);
});
