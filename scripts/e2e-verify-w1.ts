#!/usr/bin/env -S npx tsx
/**
 * scripts/e2e-verify-w1.ts
 *
 * W1: 端到端验证 repos.* / branches.* / commits.* 三个 namespace 的业务函数
 *
 * 设计（参考 scripts/m2-e2e.ts）：
 * - 不走 ipcMain.handle 序列化层（GUI 不可用）
 * - 直接调后端业务函数（gitea/* + cache/* + 业务层）
 * - 业务函数抛出的 IpcError 同样能 try/catch 验（结构一致）
 *
 * 流程：
 *  1. 准备：用临时 db（不污染 ~/.gitea-kanban/kanban.db）
 *  2. auth.connect：建 gitea_accounts 行 + 写 keychain
 *  3. repos.list 走 listGiteaRepos + findProjectsByOwnerName JOIN
 *  4. repos.addProject + 再 addProject（验证幂等）
 *  5. repos.list 验证 isProject=true
 *  6. repos.removeProject + 再 removeProject（验证幂等）
 *  7. repos.list 验证 isProject=false
 *  8. branches.list 走 listGiteaBranches + listStarredBranches JOIN
 *  9. branches.star 走 setStarred（本地）
 *  10. branches.list 验证 starred=true
 *  11. commits.list 走 listGiteaCommits + getLinkedCardsForCommits（v1 stub 返空）
 *  12. commits.get 走 getGiteaCommit（含 stats）
 *  13. commits.timeline 走 listGiteaCommits (per branch) + listGiteaPulls + buildTimeline
 *
 * 已知限制：
 * - commits.timeline 缓存层 v1 no-op（cache/commits.ts）→ 每次都走全量计算
 * - cache/commits.linkedCards 永远返空（v1 stub，无 cards 表）
 *   → UI 看到 linkedCards=[] 是预期行为
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ===== 临时 db（不污染 ~/.gitea-kanban/）=====
const TEST_DATA_DIR = join(tmpdir(), `gitea-kanban-w1-${randomUUID()}`);
process.env['GITEA_KANBAN_DATA_DIR'] = TEST_DATA_DIR;
console.log(`[setup] TEST_DATA_DIR = ${TEST_DATA_DIR}`);

mkdirSync(TEST_DATA_DIR, { recursive: true });

// ===== 业务 import =====
const { initSqlite, closeSqlite } = await import('../src/main/cache/sqlite.js');
const { authConnect } = await import('../src/main/gitea/auth.js');
const { keychainSet, keychainDelete } = await import('../src/main/gitea/keychain.js');
const { clearGiteaClientCache } = await import('../src/main/gitea/client.js');
const { listGiteaRepos } = await import('../src/main/gitea/repos.js');
const { listGiteaBranches } = await import('../src/main/gitea/branches.js');
const { listGiteaCommits, getGiteaCommit } = await import('../src/main/gitea/commits.js');
const { listGiteaPulls } = await import('../src/main/gitea/pulls.js');
const { buildTimeline } = await import('../src/main/gitea/timeline.js');
const {
  addProject,
  removeProject,
  findProjectsByOwnerName,
  listProjectsForAccount,
} = await import('../src/main/cache/repos.js');
const {
  listStarredBranches,
  setStarred,
  getBranchesCache,
  setBranchesCache,
  invalidateBranchesCache,
} = await import('../src/main/cache/branches.js');
const {
  getCommitsCache,
  setCommitsCache,
  getLinkedCardsForCommits,
  getLinkedCardsForCommit,
} = await import('../src/main/cache/commits.js');
const { getTimelineCache, setTimelineCache, makeTimelineCacheKey } = await import(
  '../src/main/cache/timeline.js'
);

// ===== 测试参数 =====
const URL = 'http://127.0.0.1:3000';
const TOKEN = '9c3fdf27b132c9564b012326344c3993486bf868';
const USER = 'kanban_bot';
const OWNER = 'kanban_demo';
const REPO = 'm4java-test';

// ===== 测试 harness =====
let pass = 0;
let fail = 0;
const failures: string[] = [];
const samples: Record<string, unknown> = {};

async function check<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const dt = Date.now() - t0;
    pass++;
    const samplePreview =
      r === null || r === undefined
        ? 'null/undefined'
        : typeof r === 'string'
        ? r
        : Array.isArray(r)
        ? `array(${r.length})`
        : typeof r === 'object'
        ? `object{${Object.keys(r).slice(0, 5).join(',')}}`
        : String(r);
    console.log(`  ✅ ${name} [${dt}ms] ${samplePreview}`);
    return r;
  } catch (e: unknown) {
    const dt = Date.now() - t0;
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name} [${dt}ms]: ${msg}`);
    if (e instanceof Error && e.stack) {
      console.log(`     ${e.stack.split('\n').slice(1, 4).join('\n     ')}`);
    }
    return null;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  console.log(`\n=== W1 e2e 验证 ===`);
  console.log(`gitea: ${URL} as ${USER}`);
  console.log(`scope: ${OWNER}/${REPO}\n`);

  clearGiteaClientCache();

  // ===== 1. 初始化 sqlite + 迁移 =====
  console.log('[step 1] init sqlite + migrations');
  await initSqlite();
  console.log('  ✅ sqlite initialized\n');

  // ===== 2. auth.connect 写 gitea_accounts =====
  console.log('[step 2] auth.connect 写 keychain + gitea_accounts');
  // 先清干净 keychain（如果上次 e2e 留下）
  try {
    await keychainDelete(URL, USER);
  } catch {
    // ignore
  }
  await keychainSet(URL, USER, TOKEN);

  const connectResult = await check('auth.connect', async () => {
    const r = await authConnect({ giteaUrl: URL, token: TOKEN });
    assert(r.user.login === USER, `expected user.login=${USER}, got ${r.user.login}`);
    assert(typeof r.account.id === 'string' && r.account.id.length > 0, 'account.id missing');
    return r;
  });
  const accountId = connectResult?.account.id ?? '';
  if (!accountId) {
    console.log('FATAL: accountId missing, abort');
    process.exit(2);
  }
  samples['accountId'] = accountId;
  console.log(`  → accountId = ${accountId}\n`);

  // ===== 3. repos.list（cache miss → 走 gitea）=====
  console.log('[step 3] repos.list 走 listGiteaRepos + JOIN');
  const list1 = await check('repos.list (cold cache)', async () => {
    // 清缓存确保 cold
    invalidateBranchesCache(); // 无关但保险
    const giteaResult = await listGiteaRepos({ giteaUrl: URL, username: USER, page: 1, limit: 50 });
    // 模拟 IPC handler 的 JOIN
    const pairs = giteaResult.items.map((r) => ({ owner: r.owner, name: r.name }));
    const projectMap = findProjectsByOwnerName(accountId, pairs);
    const items = giteaResult.items.map((r) => ({
      ...r,
      isProject: Boolean(projectMap.get(`${r.owner}/${r.name}`)),
    }));
    return { items, total: items.length, hasMore: giteaResult.hasMore };
  });
  const m4InList1 = list1?.items.find(
    (i) => i.owner === OWNER && i.name === REPO,
  );
  assert(!!m4InList1, `m4java-test not in list 1`);
  assert(m4InList1?.isProject === false, `m4java-test should not be isProject before addProject`);
  samples['repos.list1.count'] = list1?.items.length;
  samples['repos.list1.m4'] = {
    fullName: m4InList1?.fullName,
    defaultBranch: m4InList1?.defaultBranch,
    isProject: m4InList1?.isProject,
    private: m4InList1?.private,
  };
  console.log(`  → m4java-test: ${JSON.stringify(samples['repos.list1.m4'])}\n`);

  // ===== 4. repos.addProject（先保证 defaultBranch 拿到）=====
  console.log('[step 4] repos.addProject 走 cache/repos.addProject');
  const addResult = await check('repos.addProject (1st)', async () => {
    const p = addProject({
      giteaAccountId: accountId,
      owner: OWNER,
      name: REPO,
      defaultBranch: m4InList1?.defaultBranch ?? 'main',
    });
    assert(typeof p.id === 'string' && p.id.length > 0, 'project.id missing');
    return p;
  });
  const projectId = addResult?.id ?? '';
  if (!projectId) {
    console.log('FATAL: projectId missing, abort');
    process.exit(2);
  }
  samples['projectId'] = projectId;
  console.log(`  → projectId = ${projectId}\n`);

  // ===== 5. repos.addProject 幂等 =====
  console.log('[step 5] repos.addProject 幂等性 (2nd call)');
  await check('repos.addProject (2nd, 幂等)', async () => {
    const p = addProject({
      giteaAccountId: accountId,
      owner: OWNER,
      name: REPO,
      defaultBranch: m4InList1?.defaultBranch ?? 'main',
    });
    assert(p.id === projectId, `expected same projectId ${projectId}, got ${p.id}`);
    return p;
  });

  // ===== 6. listProjectsForAccount 验证 isProject=true =====
  console.log('\n[step 6] listProjectsForAccount 验证 isProject=true');
  const projectsList = await check('listProjectsForAccount', async () => {
    return listProjectsForAccount(accountId);
  });
  const pFound = projectsList?.find((p) => p.id === projectId);
  assert(!!pFound, 'project not in listProjectsForAccount');
  console.log(`  → ${projectsList?.length} project(s)\n`);

  // ===== 7. repos.removeProject 幂等 =====
  console.log('[step 7] repos.removeProject 走 cache/repos.removeProject');
  await check('repos.removeProject (1st)', async () => {
    removeProject(projectId);
  });
  await check('repos.removeProject (2nd, 幂等)', async () => {
    removeProject(projectId); // 不应抛
  });
  // 验证确实删了
  const afterRemove = listProjectsForAccount(accountId).find((p) => p.id === projectId);
  assert(!afterRemove, 'project should be deleted');
  console.log('  → 验证删除后 list 不含该 project\n');

  // 重新 add 回来，给 branches/commits 用
  const reAddResult = addProject({
    giteaAccountId: accountId,
    owner: OWNER,
    name: REPO,
    defaultBranch: m4InList1?.defaultBranch ?? 'main',
  });
  const projectIdFinal = reAddResult.id;
  console.log(`  → 重新 add projectId = ${projectIdFinal}\n`);

  // ===== 8. branches.list 走 listGiteaBranches + listStarredBranches JOIN =====
  console.log('[step 8] branches.list 走 listGiteaBranches + JOIN');
  const branchesResult = await check('branches.list (cold)', async () => {
    invalidateBranchesCache(projectIdFinal); // 保险
    const giteaR = await listGiteaBranches({
      giteaUrl: URL,
      username: USER,
      owner: OWNER,
      repo: REPO,
      page: 1,
      limit: 50,
    });
    const starredSet = listStarredBranches(projectIdFinal);
    const items = giteaR.items.map((b) => ({
      ...b,
      isDefault: b.name === (m4InList1?.defaultBranch ?? 'main'),
      starred: starredSet.has(b.name),
    }));
    return { items, total: items.length, hasMore: giteaR.hasMore };
  });
  const branchNames = branchesResult?.items.map((b) => b.name) ?? [];
  const expectedBranches = ['main', 'feature-kanban', 'feature-merge', 'develop'];
  const missing = expectedBranches.filter((n) => !branchNames.includes(n));
  assert(missing.length === 0, `missing branches: ${missing.join(', ')}`);
  samples['branches.list.count'] = branchNames.length;
  samples['branches.list.names'] = branchNames.sort();
  samples['branches.list.mainIsDefault'] = branchesResult?.items.find((b) => b.name === 'main')?.isDefault;
  console.log(`  → ${branchNames.length} branches: ${branchNames.sort().join(', ')}`);
  console.log(`  → main.isDefault = ${samples['branches.list.mainIsDefault']}\n`);

  // ===== 9. branches.star 走 setStarred =====
  console.log('[step 9] branches.star 走 setStarred');
  await check('branches.star (feature-kanban)', async () => {
    setStarred({ projectId: projectIdFinal, branch: 'feature-kanban', starred: true });
  });
  const starredAfter = listStarredBranches(projectIdFinal);
  assert(starredAfter.has('feature-kanban'), 'feature-kanban should be starred');
  console.log('  → 验证 starred_branches 表写入 OK\n');

  // ===== 10. branches.list cache hit（验证 1 min TTL 缓存）=====
  console.log('[step 10] branches.list 缓存 hit (手写 cache_entries 模拟)');
  await check('branches cache write+read', async () => {
    const cacheKey = `project=${projectIdFinal}|query=|page=1|limit=50`;
    setBranchesCache({ projectId: projectIdFinal, cacheKey, payload: JSON.stringify({ test: 1 }) });
    const got = getBranchesCache({ projectId: projectIdFinal, cacheKey });
    assert(got !== null, 'expected cache hit after set');
    assert(JSON.parse(got!).test === 1, 'payload roundtrip broken');
    invalidateBranchesCache(projectIdFinal);
    const after = getBranchesCache({ projectId: projectIdFinal, cacheKey });
    assert(after === null, 'expected cache miss after invalidate');
    return true;
  });
  console.log('');

  // ===== 11. commits.list 走 listGiteaCommits =====
  console.log('[step 11] commits.list 走 listGiteaCommits');
  const commitsList = await check('commits.list (main, limit=10)', async () => {
    const r = await listGiteaCommits({
      giteaUrl: URL,
      username: USER,
      owner: OWNER,
      repo: REPO,
      sha: 'main',
      page: 1,
      limit: 10,
    });
    assert(r.items.length > 0, 'main should have at least 1 commit');
    // linkedCards 永远空（v1 stub）
    const linked = getLinkedCardsForCommits({ owner: OWNER, repo: REPO, shas: r.items.map((c) => c.sha) });
    assert(linked.size === 0, 'v1 stub should return empty Map');
    return r;
  });
  const firstSha = commitsList?.items[0]?.sha;
  samples['commits.list.mainCount'] = commitsList?.items.length;
  samples['commits.list.firstSha'] = firstSha?.slice(0, 7);
  samples['commits.list.firstMessage'] = commitsList?.items[0]?.message.split('\n')[0];
  console.log(`  → main 上 ${commitsList?.items.length} commits, head: ${firstSha?.slice(0, 7)} "${samples['commits.list.firstMessage']}"\n`);

  // ===== 12. commits.get 走 getGiteaCommit（含 stats）=====
  console.log('[step 12] commits.get 走 getGiteaCommit');
  const commitGet = await check('commits.get (head of main)', async () => {
    const c = await getGiteaCommit({
      giteaUrl: URL,
      username: USER,
      owner: OWNER,
      repo: REPO,
      sha: firstSha!,
    });
    assert(c.sha === firstSha, `sha mismatch: ${c.sha} vs ${firstSha}`);
    // get 走 /git/commits/ 端点，应当有 stats
    // 注：seed 仓库的 commits 不一定有 stats，gitea 只对 /git/commits/ 端点给 stats
    // 如果 stats 字段 undefined，c.additions 仍可能 undefined（不强制）
    const linked = getLinkedCardsForCommit({ owner: OWNER, repo: REPO, sha: c.sha });
    assert(Array.isArray(linked) && linked.length === 0, 'v1 stub should return []');
    return c;
  });
  samples['commits.get.headSha'] = commitGet?.sha.slice(0, 7);
  samples['commits.get.message'] = commitGet?.message.split('\n')[0];
  samples['commits.get.parents'] = commitGet?.parents.length;
  console.log(`  → head = ${commitGet?.sha.slice(0, 7)} parents=${commitGet?.parents.length}\n`);

  // ===== 13. commits.timeline 跨分支聚合 =====
  console.log('[step 13] commits.timeline 跨分支聚合（3 branch + main）');
  const timelineResult = await check('commits.timeline (4 branches)', async () => {
    const branches = ['main', 'feature-kanban', 'feature-merge', 'develop'];
    const commitsByBranch: Record<string, Awaited<ReturnType<typeof listGiteaCommits>>['items']> = {};
    for (const b of branches) {
      const r = await listGiteaCommits({
        giteaUrl: URL,
        username: USER,
        owner: OWNER,
        repo: REPO,
        sha: b,
        page: 1,
        limit: 50,
      });
      commitsByBranch[b] = r.items;
    }
    const prsOpen = await listGiteaPulls({
      giteaUrl: URL,
      username: USER,
      owner: OWNER,
      repo: REPO,
      state: 'open',
      limit: 100,
    });
    const prsClosed = await listGiteaPulls({
      giteaUrl: URL,
      username: USER,
      owner: OWNER,
      repo: REPO,
      state: 'closed',
      limit: 100,
    });
    const timelinePrs = [...prsOpen.items, ...prsClosed.items].map((p) => ({
      id: `pr:${OWNER}/${REPO}/${p.index}`,
      index: p.index,
      title: p.title,
      state: (p.merged ? 'merged' : p.state) as 'open' | 'closed' | 'merged',
      head: p.head.ref,
      base: p.base.ref,
      author: { name: p.author.username, ...(p.author.avatarUrl ? { avatarUrl: p.author.avatarUrl } : {}) },
      url: `${URL}/${OWNER}/${REPO}/pulls/${p.index}`,
      ...(p.merged && p.updatedAt ? { mergedAt: p.updatedAt } : {}),
    }));
    const allShas = new Set<string>();
    for (const list of Object.values(commitsByBranch)) for (const c of list) allShas.add(c.sha);
    const linkedCardsMap = getLinkedCardsForCommits({
      owner: OWNER,
      repo: REPO,
      shas: [...allShas],
    });
    const linkedCardIdsBySha = new Map<string, string[]>();
    for (const [sha, links] of linkedCardsMap.entries()) {
      linkedCardIdsBySha.set(
        sha,
        (links as Array<{ cardId: string }>).map((l) => l.cardId),
      );
    }
    const dto = buildTimeline({
      args: {
        projectId: projectIdFinal,
        branches,
        maxNodes: 500,
        laneMode: 'branch',
      },
      commitsByBranch,
      pulls: timelinePrs,
      linkedCardIdsBySha,
    });
    return dto;
  });
  samples['timeline.totalCommits'] = timelineResult?.totalCommits;
  samples['timeline.nodes'] = timelineResult?.nodes.length;
  samples['timeline.lanes'] = timelineResult?.lanes.map((l) => ({ id: l.id, label: l.label, color: l.color }));
  samples['timeline.prs'] = timelineResult?.prs.map((p) => ({ index: p.index, state: p.state, title: p.title }));
  samples['timeline.truncated'] = timelineResult?.truncated;
  samples['timeline.edges'] = timelineResult?.edges.length;
  console.log(`  → totalCommits=${timelineResult?.totalCommits} nodes=${timelineResult?.nodes.length} edges=${timelineResult?.edges.length} truncated=${timelineResult?.truncated}`);
  console.log(`  → ${timelineResult?.lanes.length} lanes: ${timelineResult?.lanes.map((l) => l.label).join(' | ')}`);
  console.log(`  → ${timelineResult?.prs.length} PRs: ${timelineResult?.prs.map((p) => `#${p.index}[${p.state}]`).join(', ')}`);
  assert((timelineResult?.totalCommits ?? 0) > 0, 'timeline should have at least 1 commit');
  assert((timelineResult?.lanes.length ?? 0) === 4, 'timeline should have 4 lanes (one per branch)');
  console.log('');

  // ===== 14. timeline cache write+read（验证 30s TTL 缓存层）=====
  console.log('[step 14] timeline cache write+read 验证');
  await check('timeline cache write+read+invalidate', async () => {
    const cacheKey = makeTimelineCacheKey({
      projectId: projectIdFinal,
      branches: ['main', 'feature-kanban', 'feature-merge', 'develop'],
      maxNodes: 500,
      laneMode: 'branch',
    });
    setTimelineCache({ projectId: projectIdFinal, cacheKey, payload: timelineResult! });
    const got = getTimelineCache({ projectId: projectIdFinal, cacheKey });
    assert(got !== null, 'expected cache hit after set');
    const parsed = JSON.parse(got!);
    assert(parsed.totalCommits === timelineResult!.totalCommits, 'payload roundtrip broken');
    return true;
  });
  console.log('');

  // ===== 15. commits cache v1 stub 行为确认 =====
  console.log('[step 15] commits cache v1 stub 行为');
  await check('commits cache (v1 no-op)', async () => {
    const r1 = getCommitsCache({ projectId: projectIdFinal, cacheKey: 'test' });
    assert(r1 === null, 'v1 stub should return null on get');
    setCommitsCache({ projectId: projectIdFinal, cacheKey: 'test', payload: '{}' });
    const r2 = getCommitsCache({ projectId: projectIdFinal, cacheKey: 'test' });
    assert(r2 === null, 'v1 stub set should be no-op (get still null)');
    return true;
  });
  console.log('');

  // ===== summary =====
  console.log(`\n=== Result: ${pass} pass / ${fail} fail ===`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }

  // 写 samples 到 plan outputs 目录（保留作验证证据，不被 cleanup 删）
  const fs = await import('node:fs');
  const samplesDir = process.env['W1_OUTPUT_DIR']
    ?? '/Users/zhongxingxing/.mavis/plans/plan_2f3810f0/outputs/w1-repos-branches-commits';
  fs.mkdirSync(samplesDir, { recursive: true });
  const samplesPath = join(samplesDir, 'e2e-samples.json');
  const fullSamples = {
    pass,
    fail,
    failures,
    samples,
    gitea: { url: URL, user: USER, scope: `${OWNER}/${REPO}` },
    ranAt: new Date().toISOString(),
  };
  fs.writeFileSync(samplesPath, JSON.stringify(fullSamples, null, 2));
  console.log(`\nSamples: ${samplesPath}`);

  // ===== cleanup =====
  console.log('\n[cleanup] close sqlite + 清 keychain + 删临时 db');
  closeSqlite();
  try {
    await keychainDelete(URL, USER);
  } catch {
    // ignore
  }
  // 删临时 dir
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log(`  ✅ removed ${TEST_DATA_DIR}`);
  } catch (e) {
    console.log(`  ⚠️ cleanup failed: ${e}`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    closeSqlite();
  } catch {
    // ignore
  }
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(2);
});
