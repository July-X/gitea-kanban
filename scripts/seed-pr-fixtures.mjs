#!/usr/bin/env node
/**
 * 给 Gitea demo 仓库注入"待合并请求"测试数据
 *
 * 用法：
 *   node scripts/seed-pr-fixtures.mjs
 *
 * 前提：
 *   - giteaDemo/docker compose up -d 已启动
 *   - 已给 kanban_demo 生成 access token（与 cdp-seed-timeline-data.mjs 同一 token）
 *
 * 会创建：
 *   1) pr-open-clean-<ts>    → 1 个 commit，开放，无冲突，可合并
 *   2) pr-open-draft-<ts>    → 1 个 commit，开放，草稿
 *   3) pr-open-conflict-<ts> → 1 个 commit，开放，但与 main 同时改一个文件，预期有冲突
 *   4) pr-multi-commits-<ts> → 3 个 commit，开放，无冲突，可压缩
 *   5) pr-target-develop-<ts>→ 1 个 commit，开放，target=develop（验证非 main 目标）
 *
 * 全部走 token 调用 gitea REST API，5 个 PR 真实落库；测试结束可手动 gitea 页面删分支 / 关 PR。
 */
import http from 'node:http';
import https from 'node:https';

const GITEA_URL = process.env.GITEA_URL ?? 'http://localhost:3000';
const OWNER = 'kanban_demo';
const REPO = 'm4java-test';
const TOKEN = process.env.GITEA_TOKEN;
if (!TOKEN) {
  console.error('需要 GITEA_TOKEN 环境变量（gitea personal access token）');
  console.error('用法: GITEA_TOKEN=xxx node scripts/seed-pr-fixtures.mjs');
  process.exit(2);
}

const ts = Date.now();
const SUFFIX = String(ts).slice(-6);

function fetchJson(path, method = 'GET', body = null) {
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
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode} ${method} ${path}: ${data.slice(0, 300)}`));
            }
          } catch (e) {
            reject(new Error(`parse fail: ${e.message}\n${data.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 创建一个新分支 */
async function createBranch(branchName, fromBranch = 'main') {
  return fetchJson(`/api/v1/repos/${OWNER}/${REPO}/branches`, 'POST', {
    new_branch_name: branchName,
    old_branch_name: fromBranch,
  });
}

/** 在指定分支创建/更新一个文件（每次一个 commit）
 *
 * gitea contents API：POST 同一路径 + 带 sha = update；POST 不带 sha = create。
 * 本实现：先 GET 拿 sha（带 5xx 重试），拿到走 update，拿不到走 create。
 */
async function writeFileOnBranch(branch, path, content, message) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // 1) 先 GET 查 sha
  let sha = undefined;
  const getPath = `/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const existing = await fetchJson(getPath).catch((e) => {
    if (e.message?.includes('404')) return null;
    throw e;
  });
  if (existing) sha = existing.sha;
  const body = {
    branch,
    content: b64,
    message,
    author: { email: 'pr-mock@example.com', name: 'PR Mock Bot' },
  };
  if (sha) body.sha = sha;
  // POST 后 422 "already exists" 兜底：gitea 1.26 contents API 偶发竞态
  // （POST 实际已成功创建文件但返回 422）。如遇 422 + 文件已存在，视为成功。
  try {
    return await fetchJson(
      `/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`,
      'POST',
      body,
    );
  } catch (e) {
    if (e.message?.includes('422')) {
      // 二次校验：文件是否已存在且内容正确
      const check = await fetchJson(getPath).catch(() => null);
      if (check?.sha) {
        return check;
      }
    }
    throw e;
  }
}

/** 创建合并请求 */
async function createPR({ head, base, title, body, draft = false }) {
  return fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls`, 'POST', {
    head,
    base,
    title,
    body,
    draft,
  });
}

async function main() {
  console.log(`Seeding PR fixtures into ${OWNER}/${REPO} (suffix=${SUFFIX})\n`);

  // 共享的"无冲突"路径前缀
  const dir = `pr-mock-${SUFFIX}`;

  // ===== 1) pr-open-clean：1 commit，无冲突，可合并 =====
  const cleanBranch = `pr-open-clean-${SUFFIX}`;
  await createBranch(cleanBranch);
  await writeFileOnBranch(
    cleanBranch,
    `${dir}/clean-feature.md`,
    `# Clean Feature\n\nA simple change ready to merge.\n`,
    `feat: add clean feature (${SUFFIX})`,
  );
  const pr1 = await createPR({
    head: cleanBranch,
    base: 'main',
    title: `[mock] 普通合并测试 — 干净可合并 #${SUFFIX}-1`,
    body: '**验证场景**：开放、无冲突、可合并\n\n测试点：\n- 4 种合并方式均可\n- 普通合并后保持全部历史',
  });
  console.log(`  [1/5] created PR #${pr1.number}  ${pr1.title}  (${cleanBranch} → main)`);

  // ===== 2) pr-open-draft：草稿 =====
  const draftBranch = `pr-open-draft-${SUFFIX}`;
  await createBranch(draftBranch);
  await writeFileOnBranch(
    draftBranch,
    `${dir}/draft-wip.md`,
    `# WIP\n\nnot ready yet.\n`,
    `wip: draft placeholder (${SUFFIX})`,
  );
  const pr2 = await createPR({
    head: draftBranch,
    base: 'main',
    title: `[mock] 草稿状态测试 #${SUFFIX}-2`,
    body: '**验证场景**：草稿徽章显示，合并按钮应隐藏（draft 不可合并）',
    draft: true,
  });
  console.log(`  [2/5] created PR #${pr2.number}  ${pr2.title}  (${draftBranch} → main, draft)`);

  // ===== 3) pr-open-conflict：制造真正冲突 =====
  // gitea 检测冲突的机制：
  //   - PR 分支和 base 分支在同一文件的同一区域有不同修改 = 冲突
  //   - 两边都新增同名文件（不同内容） 不一定算冲突（取决于 gitea 版本）
  //   - 三者都要：存在原始 base 内容 + 两侧各自修改
  // 这里采用最稳的造法：base 有文件 → 两边都修改同一行 → 必冲突

  // 第 1 步：确保 main 分支有基线文件
  const conflictFile = `${dir}/shared.md`;
  const baselineContent = `# Shared line 1\nbaseline (line 2)\nbaseline (line 3)\nbaseline (line 4)\nbaseline (line 5)\n`;
  await writeFileOnBranch('main', conflictFile, baselineContent, `chore(seed): add baseline file to main (${SUFFIX})`);

  // 第 2 步：从当前 main 拉新分支，PR 端修改第 2 行
  const conflictBranch = `pr-open-conflict-${SUFFIX}`;
  await createBranch(conflictBranch, 'main');
  const prConflictContent = `# Shared line 1\npr-branch change on line 2 (CONFLICT!)\nbaseline (line 3)\nbaseline (line 4)\nbaseline (line 5)\n`;
  await writeFileOnBranch(
    conflictBranch,
    conflictFile,
    prConflictContent,
    `feat(pr): modify line 2 on PR (${SUFFIX})`,
  );

  // 第 3 步：main 继续前进，main 也改第 2 行（让 PR 端的改动跟 main 后续进度冲突）
  // 这里不推进 main，用上一步的 baseline 已足够：pr 端改 line 2，base 还是 baseline line 2。
  // 为了制造 3-way merge conflict（更明确），在 main 上再改第 4 行，这样两边都在原有基线上动手
  await writeFileOnBranch('main', conflictFile, `# Shared line 1\nbaseline (line 2)\nbaseline (line 3)\nmain-branch change on line 4 (CONFLICT!)\nbaseline (line 5)\n`, `chore(seed): main changes line 4 (${SUFFIX})`);

  const pr3 = await createPR({
    head: conflictBranch,
    base: 'main',
    title: `[mock] 冲突测试 — 合并按钮应禁用 #${SUFFIX}-3`,
    body: '**验证场景**：有冲突（PR 改 line 2，main 改 line 4，3-way merge 冲突）\n\n预期：\n- 详情区"冲突: 有冲突"\n- 合并按钮 disabled\n- 显示"请先在 gitea 解决冲突"',
  });
  console.log(`  [3/5] created PR #${pr3.number}  ${pr3.title}  (${conflictBranch} → main, conflict on line 2 vs line 4)`);

  // ===== 3b) pr-open-conflict-2file：两文件都冲突 =====
  // 第 1 步：main 写两个文件
  const f1 = `${dir}/conflict-A.md`;
  const f2 = `${dir}/conflict-B.md`;
  await writeFileOnBranch('main', f1, 'A-line1\nA-line2\nA-line3\n', `chore(seed): conflict-A baseline (${SUFFIX})`);
  await writeFileOnBranch('main', f2, 'B-line1\nB-line2\nB-line3\n', `chore(seed): conflict-B baseline (${SUFFIX})`);
  // 第 2 步：PR 分支改两个文件
  const conflictBranch2 = `pr-conflict-2file-${SUFFIX}`;
  await createBranch(conflictBranch2, 'main');
  await writeFileOnBranch(conflictBranch2, f1, 'A-line1\nA-line2 changed by PR\nA-line3\n', `feat(pr): change A-line2 (${SUFFIX})`);
  await writeFileOnBranch(conflictBranch2, f2, 'B-line1\nB-line2 changed by PR\nB-line3\n', `feat(pr): change B-line2 (${SUFFIX})`);
  // 第 3 步：main 也改这两个文件
  await writeFileOnBranch('main', f1, 'A-line1\nA-line2 changed by main\nA-line3\n', `chore(seed): main changes A-line2 (${SUFFIX})`);
  await writeFileOnBranch('main', f2, 'B-line1\nB-line2 changed by main\nB-line3\n', `chore(seed): main changes B-line2 (${SUFFIX})`);
  const pr3b = await createPR({
    head: conflictBranch2,
    base: 'main',
    title: `[mock] 冲突测试 — 两个文件都冲突 #${SUFFIX}-3b`,
    body: '**验证场景**：两个文件都有冲突\n\n预期：gitea 标记 hasConflicts=true',
  });
  console.log(`  [3b] created PR #${pr3b.number}  ${pr3b.title}  (${conflictBranch2} → main, 2 file conflicts)`);

  // ===== 4) pr-multi-commits：3 个 commit，可测试 squash =====
  const multiBranch = `pr-multi-commits-${SUFFIX}`;
  await createBranch(multiBranch);
  for (let i = 1; i <= 3; i++) {
    await writeFileOnBranch(
      multiBranch,
      `${dir}/multi-${i}.md`,
      `# Commit ${i}\n\npart of a 3-commit series, squash candidates.\n`,
      `feat: step ${i}/3 (${SUFFIX})`,
    );
  }
  const pr4 = await createPR({
    head: multiBranch,
    base: 'main',
    title: `[mock] 多 commit 测试 — 验证 squash #${SUFFIX}-4`,
    body: '**验证场景**：3 个 commit\n\n测试点：\n- 选 squash 时需输入 commitMessage\n- 压缩后变 1 commit',
  });
  console.log(`  [4/5] created PR #${pr4.number}  ${pr4.title}  (${multiBranch} → main, 3 commits)`);

  // ===== 5) pr-target-develop：target=develop，验证非主线合并不弹额外警告 =====
  // 先确保 develop 分支存在
  try {
    await createBranch('develop', 'main');
  } catch {
    // develop 已存在
  }
  const devBranch = `pr-target-develop-${SUFFIX}`;
  await createBranch(devBranch);
  await writeFileOnBranch(
    devBranch,
    `${dir}/dev-feature.md`,
    `# Develop Feature\n\ngoes to develop branch.\n`,
    `feat: develop-only change (${SUFFIX})`,
  );
  const pr5 = await createPR({
    head: devBranch,
    base: 'develop',
    title: `[mock] 非主线目标测试 — target=develop #${SUFFIX}-5`,
    body: '**验证场景**：base=develop 不是 main\n\n预期：\n- 合并确认弹窗**不**显示"目标是主线分支"警告',
  });
  console.log(`  [5/5] created PR #${pr5.number}  ${pr5.title}  (${devBranch} → develop)`);

  console.log(`\n✓ 完成 — 创建了 6 个 PR（编号 #${pr1.number} ~ #${pr5.number}, #${pr3b.number}）`);
  console.log('\n测试方法：');
  console.log('  1. pnpm dev 打开应用');
  console.log('  2. 进入"合并请求"页（左侧栏）');
  console.log('  3. 切换 tab: 全部 / 开放 / 已合并 / 已关闭');
  console.log('  4. 点开 PR 看详情区：合并按钮、跳 gitea 链接、冲突状态');
  console.log('  5. 点合并按钮：选 4 种方式 → 二次确认 → 真实合并（合并到 main 需输入"我了解风险"）');
  console.log('\n清理：');
  console.log(`  - 6 个 PR 真实落库，测试后去 gitea 页面手动 close / 删分支`);
  console.log(`  - URL: ${GITEA_URL}/${OWNER}/${REPO}/pulls`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
