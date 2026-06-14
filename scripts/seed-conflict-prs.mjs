#!/usr/bin/env node
/**
 * 专造有冲突的 PR —— 用最直接的 git 冲突制造法
 *
 * 方法：同一个文件，PR 分支改第 2 行，main 也改第 2 行 → 必冲突
 */
import http from 'node:http';
import https from 'node:https';

const GITEA_URL = 'http://localhost:3000';
const OWNER = 'kanban_demo';
const REPO = 'm4java-test';
const TOKEN = '98997cbd9d76532e4a7d9c77761d407d86a506df';
const SUFFIX = String(Date.now()).slice(-6);

function fetchJson(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GITEA_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      headers: { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode} ${method} ${path}: ${data.slice(0, 200)}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function createBranch(name, from = 'main') {
  return fetchJson(`/api/v1/repos/${OWNER}/${REPO}/branches`, 'POST', { new_branch_name: name, old_branch_name: from });
}

async function writeFile(branch, path, content, message) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  let sha;
  try {
    const existing = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    sha = existing.sha;
  } catch { /* new file */ }
  const body = { branch, content: b64, message, author: { email: 'mock@example.com', name: 'Mock Bot' } };
  if (sha) body.sha = sha;
  try {
    return await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, 'POST', body);
  } catch (e) {
    if (e.message?.includes('422')) {
      const check = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`).catch(() => null);
      if (check?.sha) return check;
    }
    throw e;
  }
}

async function createPR(opts) {
  return fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls`, 'POST', opts);
}

async function main() {
  console.log(`造冲突 PR (suffix=${SUFFIX})\n`);

  // ===== 冲突 1：单文件同行冲突 =====
  // 关键：先在 main 写文件 → 拉分支 → PR 改同一行 → main 也改同一行
  const conflictFile = `conflict-${SUFFIX}/same-line.txt`;

  // Step 1: main 写基线（3 行）
  await writeFile('main', conflictFile,
    'line 1 - baseline\nline 2 - baseline\nline 3 - baseline\n',
    `chore: baseline for conflict test (${SUFFIX})`);
  console.log('  [1] main: baseline written');

  // Step 2: 拉 PR 分支
  const branch1 = `conflict-same-line-${SUFFIX}`;
  await createBranch(branch1, 'main');
  console.log('  [2] branch created:', branch1);

  // Step 3: PR 分支改第 2 行
  await writeFile(branch1, conflictFile,
    'line 1 - baseline\nline 2 - CHANGED BY PR BRANCH\nline 3 - baseline\n',
    `feat: PR changes line 2 (${SUFFIX})`);
  console.log('  [3] PR branch: line 2 changed');

  // Step 4: main 也改第 2 行（不同内容）→ 必冲突
  await writeFile('main', conflictFile,
    'line 1 - baseline\nline 2 - CHANGED BY MAIN\nline 3 - baseline\n',
    `fix: main also changes line 2 (${SUFFIX})`);
  console.log('  [4] main: line 2 changed (conflict!)');

  // Step 5: 创建 PR
  const pr1 = await createPR({
    head: branch1,
    base: 'main',
    title: `[冲突] 同行冲突 — 第 2 行双方都改了 #${SUFFIX}`,
    body: 'PR 改第 2 行为 "CHANGED BY PR BRANCH"，main 改第 2 行为 "CHANGED BY MAIN"。\n\n预期：gitea 检测到冲突，mergeable=false，合并按钮禁用。',
  });
  console.log(`  [5] PR #${pr1.number} created`);

  // 等 gitea 重新检测冲突
  await new Promise(r => setTimeout(r, 3000));

  // 检查 mergeable
  const check1 = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls/${pr1.number}`);
  console.log(`  → PR #${check1.number} mergeable=${check1.mergeable} (expect false)\n`);

  // ===== 冲突 2：删除 vs 修改冲突 =====
  const deleteFile = `conflict-${SUFFIX}/delete-vs-modify.txt`;
  await writeFile('main', deleteFile,
    'keep this\nalso keep this\nmaybe delete this\n',
    `chore: baseline for delete conflict (${SUFFIX})`);

  const branch2 = `conflict-delete-${SUFFIX}`;
  await createBranch(branch2, 'main');

  // PR 分支删除文件
  try {
    const existing = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(deleteFile)}?ref=${encodeURIComponent(branch2)}`);
    await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(deleteFile)}`, 'DELETE', {
      sha: existing.sha,
      branch: branch2,
      message: `feat: delete file (${SUFFIX})`,
      author: { email: 'mock@example.com', name: 'Mock Bot' },
    });
    console.log('  [6] PR branch: file deleted');
  } catch (e) {
    console.log('  [6] delete failed:', e.message?.slice(0, 80));
  }

  // main 修改同一文件
  await writeFile('main', deleteFile,
    'keep this\nMODIFIED BY MAIN\nmaybe delete this\n',
    `fix: modify file on main (${SUFFIX})`);
  console.log('  [7] main: file modified (conflict with delete!)');

  const pr2 = await createPR({
    head: branch2,
    base: 'main',
    title: `[冲突] 删除 vs 修改冲突 #${SUFFIX}`,
    body: 'PR 分支删除了文件，main 分支修改了同一文件。\n\n预期：gitea 检测到冲突，mergeable=false。',
  });
  console.log(`  [8] PR #${pr2.number} created`);

  await new Promise(r => setTimeout(r, 3000));
  const check2 = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls/${pr2.number}`);
  console.log(`  → PR #${check2.number} mergeable=${check2.mergeable} (expect false)\n`);

  // ===== 冲突 3：多文件冲突 =====
  const multiFile1 = `conflict-${SUFFIX}/multi-A.txt`;
  const multiFile2 = `conflict-${SUFFIX}/multi-B.txt`;

  await writeFile('main', multiFile1, 'A-1\nA-2\nA-3\n', `chore: multi-A baseline (${SUFFIX})`);
  await writeFile('main', multiFile2, 'B-1\nB-2\nB-3\n', `chore: multi-B baseline (${SUFFIX})`);

  const branch3 = `conflict-multi-${SUFFIX}`;
  await createBranch(branch3, 'main');

  // PR 改两个文件的第 2 行
  await writeFile(branch3, multiFile1, 'A-1\nA-2 CHANGED BY PR\nA-3\n', `feat: PR changes A-2 (${SUFFIX})`);
  await writeFile(branch3, multiFile2, 'B-1\nB-2 CHANGED BY PR\nB-3\n', `feat: PR changes B-2 (${SUFFIX})`);

  // main 也改两个文件的第 2 行
  await writeFile('main', multiFile1, 'A-1\nA-2 CHANGED BY MAIN\nA-3\n', `fix: main changes A-2 (${SUFFIX})`);
  await writeFile('main', multiFile2, 'B-1\nB-2 CHANGED BY MAIN\nB-3\n', `fix: main changes B-2 (${SUFFIX})`);

  const pr3 = await createPR({
    head: branch3,
    base: 'main',
    title: `[冲突] 多文件冲突 — 2 个文件都冲突 #${SUFFIX}`,
    body: 'PR 和 main 同时修改了 multi-A.txt 和 multi-B.txt 的第 2 行。\n\n预期：gitea 检测到冲突，mergeable=false。',
  });
  console.log(`  [9] PR #${pr3.number} created`);

  await new Promise(r => setTimeout(r, 3000));
  const check3 = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls/${pr3.number}`);
  console.log(`  → PR #${check3.number} mergeable=${check3.mergeable} (expect false)\n`);

  console.log('✓ 完成');
  console.log(`  PR #${pr1.number} — 同行冲突 (mergeable=${check1.mergeable})`);
  console.log(`  PR #${pr2.number} — 删除 vs 修改冲突 (mergeable=${check2.mergeable})`);
  console.log(`  PR #${pr3.number} — 多文件冲突 (mergeable=${check3.mergeable})`);
  console.log(`\n  URL: ${GITEA_URL}/${OWNER}/${REPO}/pulls`);
}

main().catch(e => { console.error(e); process.exit(1); });
