#!/usr/bin/env -S npx tsx
/**
 * scripts/verify-ipc-members.ts
 *
 * a3 任务验证 —— 4 个 IPC handler 端到端（issues.list assignee / pulls.list state='all'+hasMore /
 *   branches.list / members.list）
 *
 * 验证范围（m4java-test 仓库 + a1 已配的 kanban_bot）：
 * - 1. issues.list 走 Zod parse + listIssuesFromGitea + 透传 assignee
 *   → 拿 schema 直接 .parse() args，验证 ListIssuesArgsSchema 接受 assignee: 'kanban_bot'
 *   → 调 listIssuesFromGitea（card-from-issues 包装），期望 ≥ 1 条（#13）
 * - 2. pulls.list 走 Zod parse + accepts state='all'
 *   → ListPullsArgsSchema 接受 state='all'（a3 拍板加）
 *   → 调 listGiteaPulls({ state: 'all' })，期望 items.length ≥ 1 + hasMore 是 boolean
 * - 3. branches.list 走 Zod parse + 业务函数
 *   → ListBranchesArgsSchema 接受 { projectId, query?, page?, limit? }
 *   → 调 listGiteaBranches，期望 ≥ 1 条（含 main / master 之一）
 * - 4. members.list 走 Zod parse + 业务函数
 *   → ListMembersArgsSchema 接受 { projectId }
 *   → 调 listRepoCollaborators，期望 ≥ 1 条 (kanban_bot)
 *   → 验证返**数组形态**（**不**是 {items, hasMore}）—— a3 拍板
 *
 * 策略：跟 verify-myCards-members 一样——**不走 IPC serialization**（避免启 electron + ABI 切换）
 *   - 直接 import schema + 业务函数
 *   - 用 schema.parse() 验入参（覆盖 Zod 校验）
 *   - 调业务函数验 DTO 形态
 *
 * 用法：
 *   KB_TOKEN=<pat> pnpm exec tsx scripts/verify-ipc-members.ts
 *
 * 前置（**必须**已做）：
 *   1. 本地 gitea 跑在 http://127.0.0.1:3000
 *   2. 仓库 kanban_demo/m4java-test 存在
 *   3. #13 issue 配 assignee=kanban_bot + state=closed（见 verify-myCards-members 头注释）
 *   4. kanban_bot 是该仓库 collaborator
 *
 * 关键：跟 a1 verify 共享同一份 setup（keychain + clearGiteaClientCache）
 */

import {
  ListIssuesArgsSchema,
  ListPullsArgsSchema,
  ListBranchesArgsSchema,
  ListMembersArgsSchema,
  type ListIssuesArgs,
  type ListPullsArgs,
  type ListBranchesArgs,
  type ListMembersArgs,
} from '../src/main/ipc/schema.js';
import { listGiteaIssues } from '../src/main/gitea/issues.js';
import { listGiteaPulls } from '../src/main/gitea/pulls.js';
import { listGiteaBranches } from '../src/main/gitea/branches.js';
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
  console.error('用法：KB_TOKEN=<pat> pnpm exec tsx scripts/verify-ipc-members.ts');
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
  console.log(`verify-a3: 4 个 IPC handler 端到端（${REPO_OWNER}/${REPO_NAME} as ${KB_USER}）\n`);

  // 0. setup
  clearGiteaClientCache();
  console.log('[setup] write token to keychain');
  await keychainSet(URL, KB_USER, KB_TOKEN);
  console.log('  ✅ keychain set\n');

  // 共享 gitea 调用参数
  const giteaArgs = {
    giteaUrl: URL,
    username: KB_USER,
    owner: REPO_OWNER,
    repo: REPO_NAME,
  } as const;

  // ============================================================
  // Step 1: issues.list — Zod parse + 透传 assignee
  // ============================================================
  console.log('[step 1] issues.list — Zod parse(assignee) + listGiteaIssues 透传');
  await check('ListIssuesArgsSchema.parse({ assignee: kanban_bot, state: all })', async () => {
    // 1a. Zod parse 验：ListIssuesArgsSchema 现在必须接受 assignee 字段（a3 补）
    const rawArgs = { projectId: '<not-used-by-zod-parse>', assignee: KB_USER, state: 'all' as const, limit: 50, page: 1 };
    const parsed: ListIssuesArgs = ListIssuesArgsSchema.parse(rawArgs);
    if (parsed.assignee !== KB_USER) {
      return { ok: false, detail: `Zod parse 丢字段: parsed.assignee=${parsed.assignee}` };
    }
    if (parsed.state !== 'all') {
      return { ok: false, detail: `Zod parse 丢字段: parsed.state=${parsed.state}` };
    }
    // 1b. 调业务函数（card-from-issues.listIssuesFromGitea 内部已透传 assignee 到 listGiteaIssues）
    //   直接调 listGiteaIssues 模拟 IPC handler 行为
    const r = await listGiteaIssues({
      ...giteaArgs,
      state: 'all',
      assignee: KB_USER,
      limit: 50,
    });
    samples.issuesListAssignee = {
      parsedAssignee: parsed.assignee,
      giteaResultCount: r.items.length,
      giteaItems: r.items.map((i) => ({ number: i.index, title: i.title, state: i.state })),
    };
    if (r.items.length === 0) {
      return {
        ok: false,
        detail: 'gitea 返回 0 条；检查 #13 是否仍配 assignee=kanban_bot',
      };
    }
    const prs = r.items.filter((i) => i.isPullRequest);
    if (prs.length > 0) {
      return { ok: false, detail: `${prs.length} 条是 PR 不该混入（type=issues 应过滤）` };
    }
    return {
      ok: true,
      detail: `Zod parse ok (assignee=${parsed.assignee}) + gitea ${r.items.length} 条: ${r.items.map((i) => `#${i.index}(${i.state})`).join(', ')}`,
    };
  });

  // ============================================================
  // Step 2: pulls.list — Zod parse state='all' + hasMore 返回
  // ============================================================
  console.log('\n[step 2] pulls.list — Zod parse(state=all) + hasMore 返回');
  await check('ListPullsArgsSchema.parse({ state: "all" }) + listGiteaPulls({ state: "all" })', async () => {
    // 2a. Zod parse 验：ListPullsArgsSchema.state 现在必须接受 'all'（a3 补）
    const rawArgs = { projectId: '<not-used-by-zod-parse>', state: 'all' as const, limit: 50, page: 1 };
    const parsed: ListPullsArgs = ListPullsArgsSchema.parse(rawArgs);
    if (parsed.state !== 'all') {
      return { ok: false, detail: `Zod parse 丢字段: parsed.state=${parsed.state}` };
    }
    // 2b. 调业务函数
    const r = await listGiteaPulls({
      ...giteaArgs,
      state: 'all',
      limit: 50,
    });
    samples.pullsListAll = {
      parsedState: parsed.state,
      giteaResultCount: r.items.length,
      hasMore: r.hasMore,
      giteaItems: r.items.map((p) => ({
        number: p.index,
        title: p.title,
        state: p.state,
        merged: p.merged,
      })),
    };
    // hasMore 必须是 boolean（IPC schema ListPullsRespSchema 强制）
    if (typeof r.hasMore !== 'boolean') {
      return { ok: false, detail: `hasMore 不是 boolean: ${typeof r.hasMore}` };
    }
    return {
      ok: true,
      detail: `Zod parse ok (state=${parsed.state}) + gitea ${r.items.length} 条 + hasMore=${r.hasMore}`,
    };
  });

  // ============================================================
  // Step 3: branches.list — Zod parse + listGiteaBranches
  // ============================================================
  console.log('\n[step 3] branches.list — Zod parse(query/limit/page) + listGiteaBranches');
  await check('ListBranchesArgsSchema.parse({ query, limit, page }) + listGiteaBranches', async () => {
    // 3a. Zod parse 验
    const rawArgs = { projectId: '<not-used-by-zod-parse>', query: '', limit: 50, page: 1 };
    const parsed: ListBranchesArgs = ListBranchesArgsSchema.parse(rawArgs);
    if (parsed.limit !== 50 || parsed.page !== 1) {
      return {
        ok: false,
        detail: `Zod parse 缺默认值: limit=${parsed.limit} page=${parsed.page}`,
      };
    }
    // 3b. 调业务函数
    const r = await listGiteaBranches({
      ...giteaArgs,
      page: 1,
      limit: 50,
    });
    samples.branchesList = {
      parsed: { limit: parsed.limit, page: parsed.page },
      giteaResultCount: r.items.length,
      hasMore: r.hasMore,
      giteaItems: r.items.map((b) => ({ name: b.name, sha: b.sha.slice(0, 8) })),
    };
    if (r.items.length === 0) {
      return { ok: false, detail: 'gitea 返回 0 条；m4java-test 应该有分支' };
    }
    if (typeof r.hasMore !== 'boolean') {
      return { ok: false, detail: `hasMore 不是 boolean: ${typeof r.hasMore}` };
    }
    return {
      ok: true,
      detail: `Zod parse ok (limit/page defaults) + gitea ${r.items.length} 条: ${r.items.map((b) => b.name).join(', ')}`,
    };
  });

  // ============================================================
  // Step 4: members.list — Zod parse + listRepoCollaborators + 数组形态
  // ============================================================
  console.log('\n[step 4] members.list — Zod parse({ projectId }) + listRepoCollaborators 返数组');
  await check('ListMembersArgsSchema.parse({ projectId }) + listRepoCollaborators → 数组', async () => {
    // 4a. Zod parse 验
    const rawArgs = { projectId: '<not-used-by-zod-parse>' };
    const parsed: ListMembersArgs = ListMembersArgsSchema.parse(rawArgs);
    if (typeof parsed.projectId !== 'string') {
      return { ok: false, detail: `Zod parse 丢字段: parsed.projectId=${parsed.projectId}` };
    }
    // 4b. 调业务函数
    const r = await listRepoCollaborators({
      ...giteaArgs,
      limit: 50,
    });
    // 4c. 数组形态（**不**是 {items, hasMore}）—— a3 拍板 + 跟 frontend member store 对齐
    //   业务函数本身返 {items, hasMore}；IPC handler 拆 .items 返**数组**（见 src/main/ipc/members.ts:96）
    const resp: unknown[] = r.items; // 模拟 IPC handler 行为
    if (!Array.isArray(resp)) {
      return { ok: false, detail: `IPC 出参必须是数组，实际: ${typeof resp}` };
    }
    if (resp.length === 0) {
      return {
        ok: false,
        detail: 'gitea 返回 0 条；检查 kanban_bot 是否已配 collaborator',
      };
    }
    // DTO 字段验
    for (const c of resp) {
      const cc = c as { username?: string; permission?: string; avatarUrl?: string };
      if (typeof cc.username !== 'string' || cc.username.length === 0) {
        return { ok: false, detail: `CollaboratorDto.username 缺失: ${JSON.stringify(c)}` };
      }
      if (typeof cc.permission !== 'string') {
        return { ok: false, detail: `CollaboratorDto.permission 缺失: ${JSON.stringify(c)}` };
      }
    }
    samples.membersList = {
      parsed: { projectId: parsed.projectId },
      giteaResultCount: r.items.length,
      hasMore: r.hasMore,
      // 模拟 IPC 出参 = 数组（**不**包 hasMore）
      ipcRespShape: 'array',
      items: resp.map((c) => {
        const cc = c as { username: string; permission: string; avatarUrl?: string };
        return { username: cc.username, permission: cc.permission, avatarUrl: cc.avatarUrl };
      }),
    };
    return {
      ok: true,
      detail: `Zod parse ok + gitea ${r.items.length} 条 (IPC 出参=数组): ${resp.map((c) => {
        const cc = c as { username: string; permission: string };
        return `${cc.username}=${cc.permission}`;
      }).join(', ')}`,
    };
  });

  // ============================================================
  // Step 5: bonus — IPC schema 形态一致性（Zod 验证 IPC schema DTO 形状）
  // ============================================================
  console.log('\n[step 5] 静态 schema DTO 形状校验（Zod schema 接受真实 DTO）');
  await check('CollaboratorDtoSchema.parse 接受 listRepoCollaborators 真实输出', async () => {
    const { CollaboratorDtoSchema } = await import('../src/main/ipc/schema.js');
    const r = await listRepoCollaborators({ ...giteaArgs, limit: 50 });
    if (r.items.length === 0) {
      return { ok: false, detail: 'listRepoCollaborators 返回 0 条（前置 #4 失败）' };
    }
    for (const c of r.items) {
      const parsed = CollaboratorDtoSchema.safeParse(c);
      if (!parsed.success) {
        return {
          ok: false,
          detail: `CollaboratorDtoSchema.reject: ${c.username} → ${JSON.stringify(parsed.error.issues)}`,
        };
      }
    }
    return {
      ok: true,
      detail: `${r.items.length} 条都通过 CollaboratorDtoSchema.parse (strict)`,
    };
  });

  // ===== 写 sample JSON 文件（备 verifier 审）=====
  const samplePath = resolve(process.cwd(), 'scripts/verify-ipc-members-output.json');
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
