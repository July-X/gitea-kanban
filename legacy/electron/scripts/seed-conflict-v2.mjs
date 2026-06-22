#!/usr/bin/env node
/**
 * 造真正有冲突的 PR —— 用 git 三路合并冲突制造法
 */
import http from 'node:http';

const GITEA_URL = 'http://localhost:3000';
const OWNER = 'kanban_demo';
const REPO = 'm4java-test';
const TOKEN = '98997cbd9d76532e4a7d9c77761d407d86a506df';
const SUFFIX = String(Date.now()).slice(-6);

function api(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GITEA_URL);
    const headers = { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json' };
    let bodyStr;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function encPath(p) {
  // gitea contents API 需要 / 作为目录分隔符，不能编码成 %2F
  return p.split('/').map(encodeURIComponent).join('/');
}

async function getFileSha(branch, path) {
  try {
    const r = await api(`/api/v1/repos/${OWNER}/${REPO}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
    return r.sha || null;
  } catch {
    return null;
  }
}

async function writeFile(branch, path, content, msg) {
  const b64 = Buffer.from(content).toString('base64');
  const sha = await getFileSha(branch, path);
  const body = {
    branch,
    content: b64,
    message: msg,
    author: { email: 'mock@example.com', name: 'Mock Bot' },
  };
  if (sha) body.sha = sha;
  // 关键：有 SHA = 更新用 PUT，无 SHA = 创建用 POST
  const method = sha ? 'PUT' : 'POST';
  return api(`/api/v1/repos/${OWNER}/${REPO}/contents/${encPath(path)}`, method, body);
}

async function deleteFile(branch, path, msg) {
  const sha = await getFileSha(branch, path);
  if (!sha) throw new Error(`file not found on ${branch}: ${path}`);
  return api(`/api/v1/repos/${OWNER}/${REPO}/contents/${encPath(path)}`, 'DELETE', {
    sha,
    branch,
    message: msg,
  });
}

async function waitAndCheck(prNum) {
  // gitea 异步检测冲突，最多等 15 秒
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pr = await api(`/api/v1/repos/${OWNER}/${REPO}/pulls/${prNum}`);
    if (!pr.mergeable) return pr;
  }
  return api(`/api/v1/repos/${OWNER}/${REPO}/pulls/${prNum}`);
}

async function main() {
  console.log(`造冲突 PR (suffix=${SUFFIX})\n`);

  // ===== 冲突 1：单文件不同行修改 =====
  const f1 = `cx-${SUFFIX}/multi-line.txt`;
  await writeFile('main', f1,
    'line-1\nline-2\nline-3\nline-4\nline-5\n',
    `chore: baseline (${SUFFIX})`);
  console.log('  [1] main: baseline');

  const b1 = `cx-single-${SUFFIX}`;
  await api(`/api/v1/repos/${OWNER}/${REPO}/branches`, 'POST', { new_branch_name: b1, old_branch_name: 'main' });
  console.log('  [2] branch:', b1);

  // main 改第 2 行
  await writeFile('main', f1,
    'line-1\nline-2-MAIN\nline-3\nline-4\nline-5\n',
    `fix: main line-2 (${SUFFIX})`);
  console.log('  [3] main: line-2 changed');

  // 分支改第 4 行
  await writeFile(b1, f1,
    'line-1\nline-2\nline-3\nline-4-BRANCH\nline-5\n',
    `feat: branch line-4 (${SUFFIX})`);
  console.log('  [4] branch: line-4 changed');

  const pr1 = await api(`/api/v1/repos/${OWNER}/${REPO}/pulls`, 'POST', {
    head: b1, base: 'main',
    title: `[冲突] 不同行修改 #${SUFFIX}-1`,
    body: 'main 改 line-2，branch 改 line-4。三路合并时 git 可能自动合并（无重叠区域）。\n\n如果 mergeable=true 说明 git 能自动合并。',
  });
  console.log(`  [5] PR #${pr1.number}`);
  const c1 = await waitAndCheck(pr1.number);
  console.log(`  → mergeable=${c1.mergeable}\n`);

  // ===== 冲突 2：单文件同一行修改（必冲突） =====
  const f2 = `cx-${SUFFIX}/one-line.txt`;
  await writeFile('main', f2, 'ORIGINAL CONTENT\n', `chore: one-line baseline (${SUFFIX})`);
  console.log('  [6] main: one-line baseline');

  const b2 = `cx-same-${SUFFIX}`;
  await api(`/api/v1/repos/${OWNER}/${REPO}/branches`, 'POST', { new_branch_name: b2, old_branch_name: 'main' });

  // main 改
  await writeFile('main', f2, 'CHANGED BY MAIN\n', `fix: main change (${SUFFIX})`);
  console.log('  [7] main: content → "CHANGED BY MAIN"');

  // 分支改同一行
  await writeFile(b2, f2, 'CHANGED BY BRANCH\n', `feat: branch change (${SUFFIX})`);
  console.log('  [8] branch: content → "CHANGED BY BRANCH"');

  const pr2 = await api(`/api/v1/repos/${OWNER}/${REPO}/pulls`, 'POST', {
    head: b2, base: 'main',
    title: `[冲突] 同行冲突 #${SUFFIX}-2`,
    body: 'main 和 branch 都修改了 one-line.txt 的唯一一行，内容不同。\n\n预期：mergeable=false，合并按钮禁用。',
  });
  console.log(`  [9] PR #${pr2.number}`);
  const c2 = await waitAndCheck(pr2.number);
  console.log(`  → mergeable=${c2.mergeable}\n`);

  // ===== 冲突 3：文件删除 vs 修改 =====
  const f3 = `cx-${SUFFIX}/to-delete.txt`;
  await writeFile('main', f3, 'this line will be modified by main\n', `chore: delete baseline (${SUFFIX})`);

  const b3 = `cx-delete-${SUFFIX}`;
  await api(`/api/v1/repos/${OWNER}/${REPO}/branches`, 'POST', { new_branch_name: b3, old_branch_name: 'main' });

  // main 修改
  await writeFile('main', f3, 'MODIFIED BY MAIN\n', `fix: main modifies (${SUFFIX})`);
  console.log('  [10] main: file modified');

  // 分支删除
  await deleteFile(b3, f3, `feat: delete file (${SUFFIX})`);
  console.log('  [11] branch: file deleted');

  const pr3 = await api(`/api/v1/repos/${OWNER}/${REPO}/pulls`, 'POST', {
    head: b3, base: 'main',
    title: `[冲突] 删除 vs 修改 #${SUFFIX}-3`,
    body: 'PR 删除文件，main 修改同一文件。\n\n预期：mergeable=false。',
  });
  console.log(`  [12] PR #${pr3.number}`);
  const c3 = await waitAndCheck(pr3.number);
  console.log(`  → mergeable=${c3.mergeable}\n`);

  // ===== 冲突 4：多文件全部冲突 =====
  const f4a = `cx-${SUFFIX}/multi-A.txt`;
  const f4b = `cx-${SUFFIX}/multi-B.txt`;
  await writeFile('main', f4a, 'A-original\n', `chore: multi-A (${SUFFIX})`);
  await writeFile('main', f4b, 'B-original\n', `chore: multi-B (${SUFFIX})`);

  const b4 = `cx-multi-${SUFFIX}`;
  await api(`/api/v1/repos/${OWNER}/${REPO}/branches`, 'POST', { new_branch_name: b4, old_branch_name: 'main' });

  // main 改两个文件
  await writeFile('main', f4a, 'A-MAIN\n', `fix: main A (${SUFFIX})`);
  await writeFile('main', f4b, 'B-MAIN\n', `fix: main B (${SUFFIX})`);

  // 分支也改两个文件
  await writeFile(b4, f4a, 'A-BRANCH\n', `feat: branch A (${SUFFIX})`);
  await writeFile(b4, f4b, 'B-BRANCH\n', `feat: branch B (${SUFFIX})`);
  console.log('  [13] both sides: multi-A and multi-B conflicted');

  const pr4 = await api(`/api/v1/repos/${OWNER}/${REPO}/pulls`, 'POST', {
    head: b4, base: 'main',
    title: `[冲突] 多文件全部冲突 #${SUFFIX}-4`,
    body: 'main 和 branch 同时修改了 multi-A.txt 和 multi-B.txt，内容不同。\n\n预期：mergeable=false。',
  });
  console.log(`  [14] PR #${pr4.number}`);
  const c4 = await waitAndCheck(pr4.number);
  console.log(`  → mergeable=${c4.mergeable}\n`);

  console.log('✓ 完成');
  console.log(`  PR #${pr1.number} — 不同行修改 (mergeable=${c1.mergeable})`);
  console.log(`  PR #${pr2.number} — 同行冲突 (mergeable=${c2.mergeable})`);
  console.log(`  PR #${pr3.number} — 删除vs修改 (mergeable=${c3.mergeable})`);
  console.log(`  PR #${pr4.number} — 多文件冲突 (mergeable=${c4.mergeable})`);
}

main().catch(e => { console.error(e); process.exit(1); });
