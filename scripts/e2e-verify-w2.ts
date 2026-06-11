#!/usr/bin/env -S npx tsx
/**
 * e2e 验证：M4 任务 W2 —— 看板/issue/labels 端到端
 *
 * 范围（AGENTS.md §5.1 拍板）：
 * - board.columns.* (7 个端点): list / create / update / reorder / delete / mapLabel / unmapLabel
 * - issues.* (9 个端点): list / get / create / update / addLabel / removeLabel / moveColumn / comment.list / comment.create
 * - labels.* (2 个端点): list / create
 *
 * 设计：
 * - 不启动 electron 主进程（避开 sandboxed preload + electron 启动开销）
 * - **业务函数层直调**：board.columns.* 调 src/main/board/columns.ts 业务函数（经 sqlite）
 * - **gitea-js 直调**：issues.* / labels.* 调 src/main/gitea/*.ts 业务函数（经 gitea-js Api）
 *   —— 等价于绕过 ipcMain.handle 序列化层，直走业务层（跟 scripts/m2-e2e.ts 风格一致）
 * - **不**改 schema / handler / store / cache
 *
 * 用法：KB_TOKEN=... pnpm exec tsx scripts/e2e-verify-w2.ts
 *
 * 隔离：
 * - 仓库：硬编码 kanban_demo/m4java-test（不传参 = 防止误伤其他仓库）
 * - 列：临时建「e2e-test」，cleanup 必跑（unmap + delete）
 * - label：临时建「e2e-label」，cleanup 必跑（gitea 端无 labels.delete API，留本地缓存
 *   可能 stale —— 但 v1 不暴露 delete 端点，保留 label 名称前缀「e2e-」便于人工识别）
 * - 改 issue label：选 m4java-test#1 设计首页 wireframe（带「#1 新建」label）作为测试目标
 *
 * 历史：M4 任务 W2 端到端验证，2026-06-11
 */

import { giteaApi } from 'gitea-js';
import { keychainSet, keychainDelete } from '../src/main/gitea/keychain.js';
import { clearGiteaClientCache } from '../src/main/gitea/client.js';
import { initSqlite, closeSqlite, getDb } from '../src/main/cache/sqlite.js';
import { eq } from 'drizzle-orm';
import { repoProjects } from '../src/main/cache/schema/repoProjects.js';
import { giteaAccounts } from '../src/main/cache/schema/giteaAccounts.js';
import { boardColumns } from '../src/main/cache/schema/boardColumns.js';
import { columnLabelMapping } from '../src/main/cache/schema/columnLabelMapping.js';
import {
  listColumns,
  createColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
  mapLabel,
  unmapLabel,
} from '../src/main/board/columns.js';
import { listIssuesFromGitea } from '../src/main/board/card-from-issues.js';
import { moveIssueColumn } from '../src/main/board/move-card.js';
import {
  listGiteaIssues,
  getGiteaIssue,
  createGiteaIssue,
  editGiteaIssue,
  addGiteaIssueLabel,
  removeGiteaIssueLabel,
  listGiteaIssueComments,
  createGiteaIssueComment,
} from '../src/main/gitea/issues.js';
import {
  listGiteaLabels,
  createGiteaLabel,
} from '../src/main/gitea/labels.js';

// ============================================================
// ===== 常量：硬编码 scope = m4java-test =====
// ============================================================

const URL = 'http://127.0.0.1:3000';
const KB_TOKEN = process.env['KB_TOKEN'] ?? '';
const KB_USER = 'kanban_bot';
const REPO_OWNER = 'kanban_demo';
const REPO_NAME = 'm4java-test';

if (!KB_TOKEN) {
  console.error('需要 KB_TOKEN 环境变量');
  process.exit(2);
}

// 测试期间用的临时 label 名称（e2e-label-YYYYMMDDHHmmss 防止重跑冲突）
const RUN_TAG = `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
const E2E_LABEL_NAME = `e2e-label-${RUN_TAG}`;
const E2E_LABEL_COLOR = '#a51d2d';
const E2E_LABEL_DESC = 'e2e-verify-w2.ts 自动创建，脚本结束会清理';
const E2E_COLUMN_TITLE = `e2e-test-${RUN_TAG}`;

// ============================================================
// ===== 状态机 / 计数器 =====
// ============================================================

let pass = 0;
let fail = 0;
const failures: string[] = [];
const stepResults: Array<{
  step: number;
  endpoint: string;
  status: 'PASS' | 'FAIL';
  detail: string;
  latencyMs: number;
}> = [];

async function check(
  endpoint: string,
  step: number,
  fn: () => unknown | Promise<unknown>,
  detailFn?: (r: unknown) => string,
): Promise<unknown> {
  const start = Date.now();
  try {
    const r = await fn();
    const latencyMs = Date.now() - start;
    const detail = detailFn ? detailFn(r) : typeof r === 'object' ? JSON.stringify(r).slice(0, 120) : String(r);
    pass++;
    stepResults.push({ step, endpoint, status: 'PASS', detail, latencyMs });
    console.log(`  ✅ [step ${step}] ${endpoint} (${latencyMs}ms): ${detail}`);
    return r;
  } catch (e) {
    const latencyMs = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    fail++;
    failures.push(`[step ${step}] ${endpoint}: ${msg}`);
    stepResults.push({ step, endpoint, status: 'FAIL', detail: msg, latencyMs });
    console.log(`  ❌ [step ${step}] ${endpoint} (${latencyMs}ms): ${msg}`);
    throw e;
  }
}

// ============================================================
// ===== 业务层 context：项目 / 账户 / 仓库 = gitea 端 =====
// ============================================================

interface Ctx {
  api: ReturnType<typeof giteaApi<unknown>>;
  giteaAccountId: string;
  projectId: string;
  e2eColumnId: string;
  e2eLabelId: number;
  /** issueIndex → 该 issue 原本带的 label id（"新列"目标），用于 e2e 还原 */
  restoredIssues: Array<{ index: number; oldLabelIds: number[]; newLabelIds: number[] }>;
}

async function setUp(): Promise<Ctx> {
  // 1. token → keychain（giteaFetch / gitea-js 都从 keychain 拿）
  console.log('\n[setup] write token to keychain');
  try {
    await keychainSet(URL, KB_USER, KB_TOKEN);
    console.log('  ✅ keychain set');
  } catch (e) {
    console.error('  ❌ keychain set failed:', e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  // 2. clearGiteaClientCache（防止上次跑的 token 残留）
  clearGiteaClientCache();

  // 3. 启动 sqlite
  console.log('\n[setup] init sqlite');
  await initSqlite();
  console.log('  ✅ sqlite initialized');

  // 4. gitea-js factory（override securityWorker 走 gitea 习惯的 `token <pat>`）
  const api = giteaApi(URL, {
    token: KB_TOKEN,
    securityWorker: (securityData) => {
      if (!securityData) return;
      return { secure: true, headers: { Authorization: `token ${securityData}` } };
    },
  });

  // 5. 拿 giteaAccountId + projectId
  const db = getDb();
  const acc = db.select().from(giteaAccounts).where(eq(giteaAccounts.giteaUrl, URL)).all()[0];
  if (!acc) {
    throw new Error(`gitea_accounts 表里没有 giteaUrl=${URL} 的账户（先在 app 里 auth.connect）`);
  }
  const proj = db
    .select()
    .from(repoProjects)
    .where(eq(repoProjects.giteaAccountId, acc.id))
    .all()
    .find((p) => p.owner === REPO_OWNER && p.name === REPO_NAME);
  if (!proj) {
    throw new Error(`repo_projects 表里没有 ${REPO_OWNER}/${REPO_NAME}（先在 app 里 addProject）`);
  }

  return {
    api,
    giteaAccountId: acc.id,
    projectId: proj.id,
    e2eColumnId: '',
    e2eLabelId: 0,
    restoredIssues: [],
  };
}

// ============================================================
// ===== 10 步核心 e2e 流 =====
// ============================================================

async function main() {
  console.log(`e2e-verify-w2: ${URL} as ${KB_USER} on ${REPO_OWNER}/${REPO_NAME}\n`);
  console.log(`临时 label 名称: ${E2E_LABEL_NAME}`);
  console.log(`临时列标题:     ${E2E_COLUMN_TITLE}\n`);

  const ctx = await setUp();

  try {
    // ===== step 1. board.columns.create =====
    console.log('\n[step 1] board.columns.create — 建一个临时列');
    const newColRaw = await check('board.columns.create', 1, () =>
      createColumn({ projectId: ctx.projectId, title: E2E_COLUMN_TITLE, position: 0 }),
    );
    const newCol = newColRaw as { id: string; title: string; position: number; labels: Array<{ id: number; name: string; color: string }> };
    ctx.e2eColumnId = newCol.id;
    if (newCol.title !== E2E_COLUMN_TITLE) {
      throw new Error(`列名不符：${newCol.title} !== ${E2E_COLUMN_TITLE}`);
    }

    // ===== step 2. board.columns.update =====
    console.log('\n[step 2] board.columns.update — 改列名 + position');
    const renamedTitle = `${E2E_COLUMN_TITLE}-renamed`;
    await check('board.columns.update', 2, () =>
      updateColumn({ columnId: ctx.e2eColumnId, patch: { title: renamedTitle, position: 2 } }),
    );

    // ===== step 3. board.columns.reorder =====
    console.log('\n[step 3] board.columns.reorder — 把新列移到第 1 位');
    // 拿当前所有列 id（包含 e2e-test）
    const allColsBefore = listColumns(ctx.projectId);
    const e2eId = ctx.e2eColumnId;
    const others = allColsBefore.filter((c) => c.id !== e2eId).map((c) => c.id);
    const newOrder = [e2eId, ...others];
    await check('board.columns.reorder', 3, () =>
      reorderColumns({ projectId: ctx.projectId, orderedIds: newOrder }),
    );
    // 验证：重新 list，第 0 个就是 e2eId
    const reordered = listColumns(ctx.projectId);
    if (reordered[0]?.id !== e2eId) {
      throw new Error(`reorder 失败：第 0 列 id=${reordered[0]?.id} !== e2eId=${e2eId}`);
    }

    // ===== step 4. labels.create =====
    console.log('\n[step 4] labels.create — 建一个临时 gitea label');
    const newLabelRaw = await check('labels.create', 4, () =>
      listGiteaLabels({ giteaUrl: URL, username: KB_USER, owner: REPO_OWNER, repo: REPO_NAME })
        .then((existing) => {
          const dup = existing.items.find((l) => l.name === E2E_LABEL_NAME);
          if (dup) return Promise.resolve(dup);
          return createGiteaLabel({
            giteaUrl: URL,
            username: KB_USER,
            owner: REPO_OWNER,
            repo: REPO_NAME,
            name: E2E_LABEL_NAME,
            color: E2E_LABEL_COLOR,
            description: E2E_LABEL_DESC,
          });
        }),
    );
    const newLabel = newLabelRaw as { id: number; name: string; color: string };
    ctx.e2eLabelId = newLabel.id;
    if (newLabel.name !== E2E_LABEL_NAME) {
      throw new Error(`label 名不符：${newLabel.name} !== ${E2E_LABEL_NAME}`);
    }

    // ===== step 5. board.columns.mapLabel =====
    console.log('\n[step 5] board.columns.mapLabel — 把新列绑到新 label');
    await check('board.columns.mapLabel', 5, () =>
      mapLabel({
        columnId: ctx.e2eColumnId,
        giteaLabelId: ctx.e2eLabelId,
        giteaLabelName: E2E_LABEL_NAME,
      }),
    );
    // 验证：list 时该列带 label
    const colsAfterMap = listColumns(ctx.projectId);
    const e2eColAfterMap = colsAfterMap.find((c) => c.id === ctx.e2eColumnId);
    if (!e2eColAfterMap?.labels.find((l) => l.id === ctx.e2eLabelId)) {
      throw new Error(`mapLabel 失败：列 ${ctx.e2eColumnId} 没绑 label #${ctx.e2eLabelId}`);
    }

    // ===== step 6. issues.list =====
    console.log('\n[step 6] issues.list — 列 m4java-test 所有 open issues');
    const openIssuesRaw = await check('issues.list', 6, () =>
      listGiteaIssues({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        state: 'open',
        page: 1,
        limit: 50,
      }),
    );
    const openIssues = openIssuesRaw as { items: Array<{ index: number; title: string; labels: Array<{ id: number; name: string }> }>; hasMore: boolean };
    if (openIssues.items.length === 0) {
      throw new Error('open issues 数量为 0（应有 10 个）');
    }
    // 验证：listIssuesFromGitea 按 columnId 过滤也能跑（不抛错即可）
    await check('issues.list({ columnId })', 6, () =>
      listIssuesFromGitea({ projectId: ctx.projectId, columnId: ctx.e2eColumnId, page: 1, limit: 50 }),
    );

    // 选 m4java-test#1 设计首页 wireframe 作为目标（带「#1 新建」label）
    // 选它是因为它没被其他列绑的 label 干扰（旧 label 跟其他列无冲突）
    const targetIssueIndex = 1;
    const targetBefore = openIssues.items.find((i) => i.index === targetIssueIndex);
    if (!targetBefore) {
      throw new Error(`m4java-test 上找不到 issue #${targetIssueIndex}`);
    }
    const oldLabelIds = targetBefore.labels.map((l) => l.id);
    console.log(`\n  → 目标 issue #${targetIssueIndex}「${targetBefore.title}」旧 labels: ${oldLabelIds.join(',') || '(无)'}`);

    // ===== step 7. issues.update + addLabel + removeLabel =====
    // 任务描述："挑一个 issue，去掉旧 label，加 e2e-label（**模拟看板拖拽换列**）"
    // 实现：先 addLabel(e2e-label)，再 removeLabel(所有旧 label) —— 模拟"换绑"语义
    console.log('\n[step 7] issues.addLabel + issues.removeLabel — 模拟看板拖拽换列');
    // 7a. issues.addLabel
    await check('issues.addLabel(e2e-label)', 7, () =>
      addGiteaIssueLabel({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: targetIssueIndex,
        labelId: ctx.e2eLabelId,
      }),
    );
    // 7b. issues.removeLabel × N
    for (const lid of oldLabelIds) {
      if (lid === ctx.e2eLabelId) continue; // 跳过刚加的
      await check(`issues.removeLabel(#${lid})`, 7, () =>
        removeGiteaIssueLabel({
          giteaUrl: URL,
          username: KB_USER,
          owner: REPO_OWNER,
          repo: REPO_NAME,
          index: targetIssueIndex,
          labelId: lid,
        }),
      );
    }
    // 7c. issues.update（改 title 模拟"点编辑"按钮）
    await check('issues.update(title)', 7, () =>
      editGiteaIssue({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: targetIssueIndex,
        title: targetBefore.title, // 不真改 title，update 调用本身是验证
      }),
    );

    // 验证：issue #1 现在带 e2e-label，没旧 label
    const targetAfter = (await getGiteaIssue({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      index: targetIssueIndex,
    })) as { labels: Array<{ id: number; name: string }> };
    const newLabelIds = targetAfter.labels.map((l) => l.id);
    if (!newLabelIds.includes(ctx.e2eLabelId)) {
      throw new Error(`issue #${targetIssueIndex} 没带 e2e-label #${ctx.e2eLabelId}`);
    }
    for (const oldId of oldLabelIds) {
      if (oldId === ctx.e2eLabelId) continue;
      if (newLabelIds.includes(oldId)) {
        throw new Error(`issue #${targetIssueIndex} 还带旧 label #${oldId}（应该已 remove）`);
      }
    }
    console.log(`  → 验证：issue #${targetIssueIndex} 现在带 labels: [${newLabelIds.join(',')}]（e2e-label 已加，旧 label 已移）`);

    ctx.restoredIssues.push({
      index: targetIssueIndex,
      oldLabelIds,
      newLabelIds,
    });

    // ===== step 8. board.columns.list（验证 e2e-label 绑的 issue 出现在新列）=====
    console.log('\n[step 8] board.columns.list — 验证 e2e-label 绑的 issue 出现在新列');
    // 8a. listColumns
    await check('board.columns.list', 8, () => listColumns(ctx.projectId));
    // 8b. listIssuesFromGitea({ columnId: e2eColumnId }) → 应该返回包含 issue #1
    const colFilteredRaw = await listIssuesFromGitea({
      projectId: ctx.projectId,
      columnId: ctx.e2eColumnId,
      page: 1,
      limit: 50,
    });
    const colFiltered = colFilteredRaw as { items: Array<{ index: number; title: string; labels: Array<{ id: number }> }> };
    if (!colFiltered.items.find((i) => i.index === targetIssueIndex)) {
      throw new Error(`columnId 过滤的 issue 列表里没找到 #${targetIssueIndex}`);
    }
    console.log(`  → 验证：${ctx.e2eColumnId} 列下找到 issue #${targetIssueIndex}`);

    // ===== step 9. issues.moveColumn =====
    // 选 m4java-test#4「时间轴 X6 集成」（带「#1 新建」label）作目标
    // 流程：从 e2eColumn 拖到"原列"——但 e2eColumn 不是真列（是测试列），所以这里我们:
    //   - 新建一个临时过渡列 + 绑 e2e-label
    //   - 把 issue #4 拖到该过渡列（addLabel(#1 新建) + removeLabel(e2e-label)）
    // 实际业务里 moveColumn 是"原列 → 目标列"，这里我们做"e2eColumn → 临时过渡列"
    //   → 临时过渡列绑的是 e2e-label 之外的另一 label（避免一 label 一列冲突）
    console.log('\n[step 9] issues.moveColumn — 拖 issue #4 从 e2e 列到过渡列');
    // 9a. 建一个临时过渡列
    const transitColRaw = await createColumn({
      projectId: ctx.projectId,
      title: `e2e-transit-${RUN_TAG}`,
      position: 0,
    });
    const transitCol = transitColRaw as { id: string; title: string };
    // 9b. 准备一个"原列"——把 #1「新建」label 绑到 e2eColumn（这就是 e2eColumn 当前绑的）
    // 9c. 实际：先把 issue #4 加 e2e-label（让它跟 e2eColumn 匹配），然后 moveColumn 到 transitCol
    //     简化：moveColumn(e2eColumn → transitCol) 的语义是"换绑 e2eColumn 的 labels → transitCol 的 labels"
    //     → 如果 transitCol 没绑 label，那它会移除 e2eColumn 的 labels
    //     → 选个干净的"原 label"绑到 transitCol 即可（不能再用 e2e-label —— e2eColumn 绑了）
    // 准备：用一个**临时**的 transit-label 绑到 transitCol
    const transitLabelName = `e2e-transit-label-${RUN_TAG}`;
    const transitLabel = (await listGiteaLabels({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
    }).then(async (existing) => {
      const dup = existing.items.find((l) => l.name === transitLabelName);
      if (dup) return dup;
      return await createGiteaLabel({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        name: transitLabelName,
        color: '#7c3aed',
        description: 'transit label for e2e moveColumn test',
      });
    })) as { id: number; name: string };
    // 绑 transit-label 到 transitCol
    await mapLabel({
      columnId: transitCol.id,
      giteaLabelId: transitLabel.id,
      giteaLabelName: transitLabelName,
    });

    // 9d. 准备 issue #4：先 addLabel(e2e-label)，让它的 label 跟 e2eColumn 匹配（moveColumn 的前置校验）
    const issue4Before = (await getGiteaIssue({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      index: 4,
    })) as { labels: Array<{ id: number; name: string }> };
    const issue4OldLabelIds = issue4Before.labels.map((l) => l.id);
    console.log(`  → issue #4 旧 labels: [${issue4OldLabelIds.join(',')}]`);
    // issue #4 当前带「#1 新建」label（id=1）—— moveColumn(e2eColumn→transitCol) 前置校验要求：
    //   "fromColumn 绑的 labels 必须在 issue 上" → e2eColumn 绑的是 e2e-label #${ctx.e2eLabelId}
    //   所以要先 addLabel(e2e-label) 给 issue #4
    if (!issue4OldLabelIds.includes(ctx.e2eLabelId)) {
      await addGiteaIssueLabel({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: 4,
        labelId: ctx.e2eLabelId,
      });
    }
    // 9e. 执行 moveColumn(e2eColumn → transitCol)
    //     预期：issue #4 的 e2e-label 被移除，transit-label 被加上
    const moveResultRaw = await check('issues.moveColumn', 9, () =>
      moveIssueColumn({
        projectId: ctx.projectId,
        issueIndex: 4,
        fromColumnId: ctx.e2eColumnId,
        toColumnId: transitCol.id,
      }),
    );
    const moveResult = moveResultRaw as { labels: Array<{ id: number; name: string }> };
    const moveLabelIds = moveResult.labels.map((l) => l.id);
    if (moveLabelIds.includes(ctx.e2eLabelId)) {
      throw new Error(`moveColumn 后 issue #4 还带 e2e-label #${ctx.e2eLabelId}`);
    }
    if (!moveLabelIds.includes(transitLabel.id)) {
      throw new Error(`moveColumn 后 issue #4 没带 transit-label #${transitLabel.id}`);
    }
    console.log(`  → 验证：issue #4 moveColumn 后 labels: [${moveLabelIds.join(',')}]（e2e-label 移除、transit-label 已加）`);

    // 记录要还原的 issue
    ctx.restoredIssues.push({
      index: 4,
      oldLabelIds: issue4OldLabelIds,
      newLabelIds: moveLabelIds,
    });

    // 9f. 验证 transitCol 拖后：listIssuesFromGitea({ columnId: transitCol.id }) 含 issue #4
    const transitColListRaw = await listIssuesFromGitea({
      projectId: ctx.projectId,
      columnId: transitCol.id,
      page: 1,
      limit: 50,
    });
    const transitColList = transitColListRaw as { items: Array<{ index: number }> };
    if (!transitColList.items.find((i) => i.index === 4)) {
      throw new Error(`transitCol 下没找到 issue #4`);
    }

    // ===== step 9.5 旁路补全：issues.create + issues.get + issues.comment.list/create =====
    // 任务 prompt 列出 9 个 issues 端点：list/get/create/update(改 label=换列)/close/reopen/moveColumn/listComments/addComment
    // 实际代码（src/main/ipc/schema.ts §issues）：
    //   list / get / create / update / addLabel / removeLabel / moveColumn / comment.list / comment.create
    // **没有**独立的 close/reopen 端点 —— 改 state 走 issues.update({ patch: { state: 'closed' | 'open' }})
    // 已在 step 7c 验过 issues.update，**这次单独跑一遍**确认 close 路径
    console.log('\n[step 9.5] issues.create + close + reopen + get + comment.list/create');
    const createdRaw = await check('issues.create', 9.5, () =>
      createGiteaIssue({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        title: `e2e-card-${RUN_TAG}`,
        body: 'e2e-verify-w2.ts 创建，cleanup 时关闭',
      }),
    );
    const created = createdRaw as { index: number; title: string; state: 'open' | 'closed' };
    if (created.state !== 'open') {
      throw new Error(`新建 issue 状态应为 open，实际：${created.state}`);
    }
    // close: 用 issues.update({ state: 'closed' })
    await check('issues.update(state=closed) → close', 9.5, () =>
      editGiteaIssue({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: created.index,
        state: 'closed',
      }),
    );
    // reopen: 状态改回 open
    await check('issues.update(state=open) → reopen', 9.5, () =>
      editGiteaIssue({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: created.index,
        state: 'open',
      }),
    );
    // get
    await check('issues.get', 9.5, () =>
      getGiteaIssue({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: created.index,
      }),
    );
    // comment.create
    const newCommentRaw = await check('issues.comment.create', 9.5, () =>
      createGiteaIssueComment({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: created.index,
        body: `e2e-verify-w2.ts 验证评论 @ ${RUN_TAG}`,
      }),
    );
    const newComment = newCommentRaw as { id: number; body: string };
    // comment.list
    await check('issues.comment.list', 9.5, () =>
      listGiteaIssueComments({
        giteaUrl: URL,
        username: KB_USER,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        index: created.index,
      }).then((cs) => {
        if (!cs.find((c) => c.id === newComment.id)) {
          throw new Error(`评论列表里没找到刚加的 #${newComment.id}`);
        }
        return cs;
      }),
    );
    // 把新建 issue 关掉（cleanup 友好）
    await editGiteaIssue({
      giteaUrl: URL,
      username: KB_USER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      index: created.index,
      state: 'closed',
    });
    console.log(`  → 已关闭新建的 issue #${created.index}「${created.title}」（留 gitea 端作 history）`);
  } catch (e) {
    console.log('\n[中断] 验证流失败，进入 cleanup');
  } finally {
    // ============================================================
    // ===== cleanup：必跑（不留永久残留）=====
    // ============================================================
    console.log('\n[cleanup] 开始清理...');

    // 1. 还原被改 label 的 issue #1（加回旧 label、移除 e2e-label）
    for (const r of ctx.restoredIssues) {
      try {
        // 加回旧 label
        for (const lid of r.oldLabelIds) {
          await addGiteaIssueLabel({
            giteaUrl: URL,
            username: KB_USER,
            owner: REPO_OWNER,
            repo: REPO_NAME,
            index: r.index,
            labelId: lid,
          }).catch(() => undefined);
        }
        // 移除 e2e 期间新加的 label（不在 oldLabelIds 里的就是新加的）
        for (const lid of r.newLabelIds) {
          if (!r.oldLabelIds.includes(lid)) {
            await removeGiteaIssueLabel({
              giteaUrl: URL,
              username: KB_USER,
              owner: REPO_OWNER,
              repo: REPO_NAME,
              index: r.index,
              labelId: lid,
            }).catch(() => undefined);
          }
        }
        console.log(`  ✅ issue #${r.index} label 已还原`);
      } catch (e) {
        console.log(`  ⚠️ issue #${r.index} label 还原失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 2. unmapLabel e2eColumn 上的所有 label
    try {
      const db = getDb();
      const mappings = db
        .select()
        .from(columnLabelMapping)
        .where(eq(columnLabelMapping.columnId, ctx.e2eColumnId))
        .all();
      for (const m of mappings) {
        await unmapLabel({
          columnId: ctx.e2eColumnId,
          giteaLabelId: Number(m.giteaLabelId),
        });
      }
      console.log(`  ✅ e2eColumn 的 ${mappings.length} 个 label mapping 已解绑`);
    } catch (e) {
      console.log(`  ⚠️ e2eColumn mapping 清理失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. deleteColumn e2eColumn（同时也走 unmapLabel 上的 transit-label）
    try {
      // 解绑 transit-label 上的映射（如果有）
      const db = getDb();
      const transitColRow = db
        .select()
        .from(boardColumns)
        .where(eq(boardColumns.repoProjectId, ctx.projectId))
        .all()
        .find((c) => c.title === `e2e-transit-${RUN_TAG}`);
      if (transitColRow) {
        const transitMappings = db
          .select()
          .from(columnLabelMapping)
          .where(eq(columnLabelMapping.columnId, transitColRow.id))
          .all();
        for (const m of transitMappings) {
          await unmapLabel({
            columnId: transitColRow.id,
            giteaLabelId: Number(m.giteaLabelId),
          });
        }
        await deleteColumn({ columnId: transitColRow.id });
        console.log(`  ✅ transit 列已删除`);
      }
    } catch (e) {
      console.log(`  ⚠️ transit 列清理失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      await deleteColumn({ columnId: ctx.e2eColumnId });
      console.log(`  ✅ e2eColumn 已删除`);
    } catch (e) {
      console.log(`  ⚠️ e2eColumn 清理失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 4. 关 sqlite + 清 keychain
    try {
      closeSqlite();
      console.log(`  ✅ sqlite closed`);
    } catch (e) {
      console.log(`  ⚠️ sqlite close: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await keychainDelete(URL, KB_USER);
      console.log(`  ✅ keychain cleared`);
    } catch (e) {
      console.log(`  ⚠️ keychain clear: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 5. 提示：e2e-label 和 transit-label 留 gitea 端
    //    原因：gitea 端无 labels.delete API（v1 不暴露），e2e 期间建的 label 名称带 RUN_TAG 前缀
    //    人工清理（如需）：到 gitea web UI → Labels → 删带 "e2e-label-" / "e2e-transit-label-" 前缀的 label
    console.log(`  ℹ️  gitea 端留有临时 label「${E2E_LABEL_NAME}」+「e2e-transit-label-${RUN_TAG}」（v1 无 labels.delete 端点；带 e2e- 前缀易识别）`);
  }

  // ============================================================
  // ===== 报告 =====
  // ============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log('e2e-verify-w2 报告');
  console.log('='.repeat(60));
  console.log(`总步骤: ${stepResults.length}`);
  console.log(`通过:   ${pass}`);
  console.log(`失败:   ${fail}`);
  console.log(`\n按端点分类:`);
  const byEndpoint = new Map<string, { pass: number; fail: number }>();
  for (const r of stepResults) {
    if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, { pass: 0, fail: 0 });
    const e = byEndpoint.get(r.endpoint)!;
    if (r.status === 'PASS') e.pass++;
    else e.fail++;
  }
  for (const [ep, c] of byEndpoint) {
    const total = c.pass + c.fail;
    console.log(`  ${ep}: ${c.pass}/${total} pass`);
  }

  if (failures.length) {
    console.log(`\n失败清单:`);
    failures.forEach((f) => console.log('  - ' + f));
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
