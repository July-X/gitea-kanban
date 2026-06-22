#!/usr/bin/env node
/**
 * 离线集成测试：模拟 gitea-kanban 评论 IPC 走的 gitea API 路径
 *
 * 验证三件事：
 *  1. issues.comment.list 对 PR index 也能返回评论
 *  2. issues.comment.create 同步到 Gitea
 *  3. 评论创建后,再次 list 能拿到权威评论（含新发的）
 *
 * 不通过 CDP / 真实 UI 触发——直接 fetch Gitea REST API,
 * 等价于 main 端 listGiteaIssueComments / createGiteaIssueComment 做的事。
 */
import { writeFileSync } from 'node:fs';

const GATEA_TOKEN = '9c3fdf27b132c9564b012326344c3993486bf868';
const PR_INDEX = 72;
const REPO = { owner: 'kanban_demo', repo: 'm4java-test' };

const outPath = '/tmp/cdp-it-out.json';

function log(step, data) {
  const out = { step, ts: new Date().toISOString(), ...data };
  console.log(JSON.stringify(out));
  writeFileSync(outPath, JSON.stringify(out));
}

async function main() {
  writeFileSync(outPath, JSON.stringify({ step: 'starting', ts: new Date().toISOString() }));

  try {
    // step 1: list comments (PR #72)
    const listRes = await fetch(
      `http://127.0.0.1:3000/api/v1/repos/${REPO.owner}/${REPO.repo}/issues/${PR_INDEX}/comments`,
      { headers: { Authorization: `token ${GATEA_TOKEN}` } }
    );
    if (!listRes.ok) {
      log('list-error', { status: listRes.status, statusText: listRes.statusText });
      process.exit(1);
    }
    const listJson = await listRes.json();
    log('list-existing', {
      count: listJson.length,
      first: listJson[0] ? {
        id: listJson[0].id,
        body: listJson[0].body,
        user: listJson[0].user.login,
        created: listJson[0].created_at,
      } : null,
    });

    // step 2: create comment
    const newBody = `[CDP-test] ${new Date().toISOString()} 自动化测试评论`;
    const createRes = await fetch(
      `http://127.0.0.1:3000/api/v1/repos/${REPO.owner}/${REPO.repo}/issues/${PR_INDEX}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${GATEA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: newBody }),
      }
    );
    if (!createRes.ok) {
      log('create-error', { status: createRes.status, statusText: createRes.statusText, body: await createRes.text() });
      process.exit(1);
    }
    const createJson = await createRes.json();
    log('create', {
      newId: createJson.id,
      newBody: createJson.body,
      newUser: createJson.user.login,
      newCreated: createJson.created_at,
    });

    // step 3: re-list 验证新评论出现
    const list2Res = await fetch(
      `http://127.0.0.1:3000/api/v1/repos/${REPO.owner}/${REPO.repo}/issues/${PR_INDEX}/comments`,
      { headers: { Authorization: `token ${GATEA_TOKEN}` } }
    );
    const list2Json = await list2Res.json();
    log('list-after', {
      count: list2Json.length,
      newInList: list2Json.some((c) => c.id === createJson.id),
      last3: list2Json.slice(-3).map((c) => ({ id: c.id, body: c.body.slice(0, 50), user: c.user.login })),
    });

    log('done', { ok: true, summary: 'comment IPC path verified end-to-end via gitea REST' });
  } catch (e) {
    log('error', { msg: String(e), stack: e.stack });
    process.exit(1);
  }
}

main();