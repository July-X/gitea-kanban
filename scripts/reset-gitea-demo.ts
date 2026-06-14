#!/usr/bin/env node
/**
 * scripts/reset-gitea-demo.ts
 *
 * 把 demo gitea 仓库 `kanban_demo/m4java-test` 重置回 M9 e2e baseline：
 * 1. 关掉所有 `[mock]` 前缀的 PR（state: open → closed）
 * 2. 删除所有 `pr-*` 命名的分支（保留 main + feature-* + develop）
 *
 * 已知限制（透明记录，**不**做 workaround，**不**改 e2e baseline 掩盖）：
 * - 不 reset main HEAD commit 历史（gitea REST API 不支持 force push to default branch）
 * - 不删 main 上的 `pr-mock-*` 目录文件（删文件本身会加 commit 数，污染 commits baseline）
 * - commits baseline 仍偏离（M9 期望 15 commits；实际 main 上多了 seed 阶段加的 commit）
 * - 想彻底恢复 main baseline 需在 docker 容器内手动 git reset + push -f
 *
 * 用法：
 *   KB_TOKEN=xxx tsx scripts/reset-gitea-demo.ts
 *
 * 退出码：
 *   0 = reset 完成（含部分失败的告警，但 PR 数 / 分支数已对齐 baseline）
 *   1 = fatal error
 *   2 = 缺少 KB_TOKEN
 *
 * 设计目标：
 *   - 重置后 e2e W3 step 1（pulls.list expected 2 PR）应 PASS
 *   - 重置后 e2e W3 step 3（commits.timeline expected 15 commits）仍 FAIL（透明记录）
 *   - 重置后 e2e W3 step 5b（merge 幂等）应 PASS（PR #11 仍 closed/merged）
 */
import http from 'node:http';
import https from 'node:https';

const GITEA_URL = process.env.GITEA_URL ?? 'http://127.0.0.1:3000';
const OWNER = 'kanban_demo';
const REPO = 'm4java-test';
const TOKEN = process.env.KB_TOKEN;

if (!TOKEN) {
  console.error('需要 KB_TOKEN 环境变量（gitea kanban_demo personal access token）');
  console.error('用法: KB_TOKEN=xxx tsx scripts/reset-gitea-demo.ts');
  process.exit(2);
}

interface GiteaPR {
  number: number;
  state: 'open' | 'closed';
  title: string;
}

interface GiteaBranch {
  name: string;
}

function fetchJson<T = unknown>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body: unknown = null): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GITEA_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method,
        headers: {
          Authorization: `token ${TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : ({} as T);
            // Node 22+ http.IncomingMessage.statusCode is `number | undefined`
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) {
              resolve(parsed as T);
            } else {
              reject(new Error(`HTTP ${code} ${method} ${path}: ${data.slice(0, 300)}`));
            }
          } catch (e) {
            reject(new Error(`parse fail: ${(e as Error).message}\n${data.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function closeMockPRs(): Promise<{ total: number; closed: number }> {
  console.log('[1/2] close all [mock] PRs');
  // gitea PR list 默认按更新时间倒序，state=open 取所有打开的
  const allPRs = await fetchJson<GiteaPR[]>(
    `/api/v1/repos/${OWNER}/${REPO}/pulls?state=open&limit=100`,
  );
  const mockPRs = allPRs.filter((p) => p.title.startsWith('[mock]'));
  console.log(`  found ${mockPRs.length} open [mock] PRs`);
  let closed = 0;
  for (const pr of mockPRs) {
    try {
      // gitea PR 在 issue API 层（pull request = issue + extra metadata）
      await fetchJson(
        `/api/v1/repos/${OWNER}/${REPO}/issues/${pr.number}`,
        'PATCH',
        { state: 'closed' },
      );
      closed++;
    } catch (e) {
      console.warn(`  ! failed to close PR #${pr.number}: ${(e as Error).message}`);
    }
  }
  console.log(`  closed ${closed}/${mockPRs.length}\n`);
  return { total: mockPRs.length, closed };
}

async function deleteMockBranches(): Promise<{ total: number; deleted: number }> {
  console.log('[2/2] delete all pr-* branches (keep main + feature-* + develop)');
  const branches = await fetchJson<GiteaBranch[]>(
    `/api/v1/repos/${OWNER}/${REPO}/branches?limit=100`,
  );
  const toDelete = branches.filter(
    (b) =>
      b.name !== 'main' &&
      b.name !== 'develop' &&
      !b.name.startsWith('feature-') &&
      (b.name.startsWith('pr-') || b.name.startsWith('feature-pr-')),
  );
  console.log(`  found ${toDelete.length} branches to delete`);
  let deleted = 0;
  for (const b of toDelete) {
    try {
      await fetchJson(
        `/api/v1/repos/${OWNER}/${REPO}/branches/${encodeURIComponent(b.name)}`,
        'DELETE',
      );
      deleted++;
    } catch (e) {
      console.warn(`  ! failed to delete ${b.name}: ${(e as Error).message}`);
    }
  }
  console.log(`  deleted ${deleted}/${toDelete.length}\n`);
  return { total: toDelete.length, deleted };
}

async function main(): Promise<void> {
  console.log(`Resetting demo gitea ${OWNER}/${REPO} ...\n`);
  const t0 = Date.now();

  const prResult = await closeMockPRs();
  const branchResult = await deleteMockBranches();

  const ms = Date.now() - t0;
  console.log(`Done in ${ms}ms.`);
  console.log(`  mock PRs: closed ${prResult.closed}/${prResult.total}`);
  console.log(`  mock branches: deleted ${branchResult.deleted}/${branchResult.total}`);

  // 部分失败（如分支已不存在）不视为 fatal
  if (prResult.closed === 0 && prResult.total > 0) {
    console.warn('WARN: 0 PRs closed (expected > 0). Check API auth / network.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', (e as Error).message);
  process.exit(1);
});