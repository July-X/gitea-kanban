#!/usr/bin/env node
/**
 * test/scripts/_pull-gitea-fixtures.mjs（test fixture ad-hoc puller）
 *
 * 用途：拉真实 gitea 1.x 响应保存到 src/main/ipc/__tests__/fixtures/。
 * 给 schemaRoundtrip.test.ts 用，验证 IPC schema 跟 gitea 1.x 真实响应形状一致。
 *
 * 数据源：docker gitea at GITEA_URL（默认 http://localhost:3000）
 * Token：必须 KB_TOKEN 环境变量传入（不入仓敏感信息）
 *
 * 用法：
 *   KB_TOKEN=xxx node test/scripts/_pull-gitea-fixtures.mjs
 *   GITEA_URL=http://staging.gitea:3000 KB_TOKEN=xxx node test/scripts/_pull-gitea-fixtures.mjs
 *
 * 输出文件：src/main/ipc/__tests__/fixtures/ 下 10 个 JSON
 *   - giteaPullList.json / giteaPullSingle.json
 *   - giteaCommitList.json / giteaCommitSingle.json
 *   - giteaIssueList.json / giteaIssueSingle.json
 *   - giteaRepo.json / giteaBranchList.json
 *   - giteaLabelList.json / giteaCollaborators.json
 *
 * 何时跑：fixture 过期 / gitea 升级 / 加新 DTO 类型需要真实响应时
 *   - 不进 e2e:all；不进 CI；本地 ad-hoc 工具
 *   - 跑完确认 diff 合理后手动 commit fixtures/
 */
import http from 'node:http';
import https from 'node:https';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITEA_URL = process.env.GITEA_URL ?? 'http://localhost:3000';
const TOKEN = process.env.KB_TOKEN;
const OWNER = process.env.GITEA_OWNER ?? 'kanban_demo';
const REPO = process.env.GITEA_REPO ?? 'm4java-test';

if (!TOKEN) {
  console.error('需要 KB_TOKEN 环境变量（gitea personal access token）');
  console.error('用法: KB_TOKEN=xxx node test/scripts/_pull-gitea-fixtures.mjs');
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// 从 test/scripts/ 算 src/main/ipc/__tests__/fixtures/
const FIX_DIR = resolve(__dirname, '../../src/main/ipc/__tests__/fixtures');
mkdirSync(FIX_DIR, { recursive: true });

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
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          } catch (e) {
            reject(new Error(`parse fail: ${e.message}\n${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function save(name, data) {
  const path = `${FIX_DIR}/${name}`;
  writeFileSync(path, JSON.stringify(data, null, 2));
  const size = JSON.stringify(data).length;
  const isArr = Array.isArray(data);
  const sample = isArr ? data[0] : data;
  const fieldCount = sample ? Object.keys(sample).length : 0;
  console.log(`  ✓ ${name} (${isArr ? data.length + ' items' : 'object'}, ${size}B, top-level fields: ${fieldCount})`);
}

async function main() {
  console.log(`Pulling real gitea responses from ${GITEA_URL} for ${OWNER}/${REPO}...`);

  console.log('\n[1] PR list (?state=all)');
  const pulls = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls?state=all&limit=10`);
  save('giteaPullList.json', pulls);

  console.log('\n[2] Single PR #11');
  const pull11 = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/pulls/11`);
  save('giteaPullSingle.json', pull11);

  console.log('\n[3] Commit list (sha=main)');
  const commits = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/commits?sha=main&limit=5`);
  save('giteaCommitList.json', commits);

  if (commits[0]?.sha) {
    console.log(`\n[4] Single commit ${commits[0].sha.slice(0, 8)} (with files)`);
    const commit = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/git/commits/${commits[0].sha}`);
    save('giteaCommitSingle.json', commit);
  }

  console.log('\n[5] Issue list (state=all)');
  const issues = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/issues?state=all&limit=10`);
  save('giteaIssueList.json', issues);

  if (issues[0]?.number) {
    console.log(`\n[6] Single issue #${issues[0].number}`);
    const issue = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/issues/${issues[0].number}`);
    save('giteaIssueSingle.json', issue);
  }

  console.log('\n[7] Repo');
  const repo = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}`);
  save('giteaRepo.json', repo);

  console.log('\n[8] Branch list');
  const branches = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/branches?limit=10`);
  save('giteaBranchList.json', branches);

  console.log('\n[9] Label list');
  const labels = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/labels?limit=10`);
  save('giteaLabelList.json', labels);

  console.log('\n[10] Collaborators');
  const collabs = await fetchJson(`/api/v1/repos/${OWNER}/${REPO}/collaborators?limit=10`);
  save('giteaCollaborators.json', collabs);

  console.log(`\nDone. Saved to ${FIX_DIR}`);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});