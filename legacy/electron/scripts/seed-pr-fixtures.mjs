#!/usr/bin/env node
/**
 * 给 Gitea demo 仓库注入"待合并请求"测试数据
 *
 * 用法：
 *   node scripts/seed-pr-fixtures.mjs
 *
 * 前提：
 *   - 本地有 Gitea 实例跑在 `localhost:3000`（任何来源的本地实例都可）
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

/** 路径编码：保留 / 作为目录分隔符 */
function encPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** 在指定分支创建/更新一个文件（每次一个 commit）
 *
 * gitea contents API：
 *   - 创建：POST /contents/{path} (CreateFileOptions，无 sha)
 *   - 更新：PUT  /contents/{path} (UpdateFileOptions，必须 sha)
 */
async function writeFileOnBranch(branch, path, content, message) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // 1) 先 GET 查 sha
  let sha = undefined;
  const getPath = `/api/v1/repos/${OWNER}/${REPO}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`;
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
  // 有 SHA = 更新用 PUT，无 SHA = 创建用 POST
  const method = sha ? 'PUT' : 'POST';
  return await fetchJson(
    `/api/v1/repos/${OWNER}/${REPO}/contents/${encPath(path)}`,
    method,
    body,
  );
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
  console.log('  3. 切换 tab: 全部 / 待合并 / 已合并 / 已关闭');

  // ===== 6) pr-closed-rejected：因冲突被关闭（驳回） =====
  // 造一个有冲突的 PR，然后直接关闭它（模拟人工驳回）
  const rejectBranch = `pr-closed-rejected-${SUFFIX}`;
  const rejectFile = `${dir}/reject-test.md`;
  await writeFileOnBranch('main', rejectFile, `# Reject baseline\nline 2\nline 3\n`, `chore(seed): reject baseline (${SUFFIX})`);
  await createBranch(rejectBranch, 'main');
  await writeFileOnBranch(rejectBranch, rejectFile, `# Reject baseline\nPR change on line 2 (conflict!)\nline 3\n`, `feat(pr): reject change (${SUFFIX})`);
  await writeFileOnBranch('main', rejectFile, `# Reject baseline\nmain change on line 2\nline 3\n`, `chore(seed): main changes line 2 (${SUFFIX})`);
  const pr6 = await createPR({
    head: rejectBranch,
    base: 'main',
    title: `[mock] 已驳回 — 冲突未解决被关闭 #${SUFFIX}-6`,
    body: '**验证场景**：冲突未解决 → 被人工关闭\n\n预期：\n- 状态徽章"已关闭"（灰色）\n- 无合并按钮\n- 详情区显示"冲突: 有冲突"',
  });
  // 通过 gitea API 关闭这个 PR（模拟驳回）
  await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls/${pr6.number}`, 'PATCH', { state: 'closed' });
  console.log(`  [6] created PR #${pr6.number}  ${pr6.title}  (CLOSED/rejected)`);

  // ===== 7) pr-with-labels：带标签的 PR =====
  const labelBranch = `pr-with-labels-${SUFFIX}`;
  await createBranch(labelBranch);
  await writeFileOnBranch(
    labelBranch,
    `${dir}/labeled-feature.md`,
    `# Labeled Feature\n\nThis PR has labels, milestone, assignee.\n`,
    `feat: labeled feature (${SUFFIX})`,
  );
  const pr7 = await createPR({
    head: labelBranch,
    base: 'main',
    title: `[mock] 带标签/指派/里程碑 — 完整属性 #${SUFFIX}-7`,
    body: '**验证场景**：完整属性展示\n\n预期：\n- 标签色块显示（bug=红、feature=蓝、needs-review=黄）\n- 指派人图标\n- 里程碑图标\n- 评审人图标\n- 评论数',
  });
  // 给 PR 打标签（先确保标签存在）
  const labelsToCreate = [
    { name: 'bug', color: 'd73a4a' },
    { name: 'feature', color: '0075ca' },
    { name: 'needs-review', color: 'fbca04' },
  ];
  for (const lb of labelsToCreate) {
    try {
      await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/labels`, 'POST', lb);
    } catch {
      // 标签已存在
    }
  }
  // 给 PR 加标签
  await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/issues/${pr7.number}/labels`, 'POST', {
    labels: labelsToCreate.map(l => l.name),
  });
  // 给 PR 加评论（增加评论数）
  await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/issues/${pr7.number}/comments`, 'POST', {
    body: '这个 PR 需要代码评审，请 @kanban_bot 看一下。',
  });
  console.log(`  [7] created PR #${pr7.number}  ${pr7.title}  (with labels/comments)`);

  // ===== 8) pr-merged-already：已被合并的 PR（验证"已合并"状态） =====
  const mergedBranch = `pr-merged-${SUFFIX}`;
  await createBranch(mergedBranch);
  await writeFileOnBranch(
    mergedBranch,
    `${dir}/merged-feature.md`,
    `# Merged Feature\n\nThis PR was merged.\n`,
    `feat: merged feature (${SUFFIX})`,
  );
  const pr8 = await createPR({
    head: mergedBranch,
    base: 'main',
    title: `[mock] 已合并测试 — 验证"已合并"状态 #${SUFFIX}-8`,
    body: '**验证场景**：已合并\n\n预期：\n- 状态徽章"已合并"（紫色）\n- 无合并按钮\n- 详情区显示合并人',
  });
  // 合并这个 PR
  try {
    await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls/${pr8.number}/merge`, 'POST', {
      Do: 'merge',
      MergeMessageField: `Merge PR #${pr8.number}: ${pr8.title}`,
    });
    console.log(`  [8] created PR #${pr8.number}  ${pr8.title}  (MERGED)`);
  } catch (e) {
    console.log(`  [8] created PR #${pr8.number}  ${pr8.title}  (merge failed: ${e.message?.slice(0, 80)})`);
  }

  console.log(`\n✓ 完成 — 创建了 8+ 个 PR（含冲突驳回/标签属性/已合并）`);
  console.log('\n测试方法：');
  console.log('  1. pnpm dev 打开应用');
  console.log('  2. 进入"合并请求"页（左侧栏）');
  console.log('  3. 切换 tab: 全部 / 待合并 / 已合并 / 已关闭');
  console.log('  4. 点开 PR 看详情区：标签色块、指派人、里程碑、评审人、评论数');
  console.log('  5. 验证冲突 PR：合并按钮 disabled + 红色"有冲突"提示');
  console.log('  6. 验证已驳回 PR：状态"已关闭"，无合并按钮');
  console.log('  7. 验证已合并 PR：状态"已合并"紫色徽章');
  console.log('\n清理：');
  console.log(`  - 所有 PR 真实落库，测试后去 gitea 页面手动 close / 删分支`);
  console.log(`  - URL: ${GITEA_URL}/${OWNER}/${REPO}/pulls`);
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
