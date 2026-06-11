#!/usr/bin/env -S npx tsx
/**
 * scripts/seed-kanban-demo.ts
 *
 * 在 gitea给 m4java-test灌一组看板演示数据（labels + issues，ADR-0002 reset 后）：
 * -3 个label「待办/进行中/已完成」 →看板列绑 label用
 * -5 个issue，每个带1个对应 label →看板视图能看到5 个卡片分布到3 列
 *
 *2026-06-11 用户 A方案：自动跑 e2e数据准备。
 *
 * 用法（token通过 env注入，不进 history）：
 * KB_TOKEN=... pnpm exec tsx scripts/seed-kanban-demo.ts
 *
 * 设计：只用 kanban_bot token（kanban demo组织的 Owner），不需要 admin token。
 * idempotent：已有 label/issue会复用（按 name/title 去重）。
 *
 * 历史（2026-06-11 ADR-0002 reset）：
 * -旧版走 gitea /projects /columns /cards → 这些端点 gitea1.26 已删
 * - 新版走 gitea /labels /issues → gitea-js issueListLabels / issueCreateLabel / issueListIssues / issueCreateIssue
 */
import { giteaApi } from 'gitea-js';
import { keychainSet } from '../src/main/gitea/keychain.js';

const URL = 'http://127.0.0.1:3000';
const KB_TOKEN = process.env['KB_TOKEN'] ?? '';
const KB_USER = 'kanban_bot';
const REPO_OWNER = 'kanban demo';
const REPO_NAME = 'm4java-test';

if (!KB_TOKEN) {
 console.error('需要 KB_TOKEN 环境变量');
 process.exit(2);
}

let pass =0, fail =0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<unknown>) {
 try {
 const r = await fn();
 pass++;
 console.log(` ✅ ${name}`);
 return r;
 } catch (e: unknown) {
 fail++;
 const msg = e instanceof Error ? e.message : String(e);
 failures.push(`${name}: ${msg}`);
 console.log(` ❌ ${name}: ${msg}`);
 throw e;
 }
}

interface SeededLabel {
 name: string;
 color: string;
}
interface SeededIssue {
 columnLabel: string; // 该 issue属于哪个 label =哪个列
 title: string;
 body?: string;
}

const SEED_LABELS: SeededLabel[] = [
 { name: '待办', color: '#6c757d' }, // gray
 { name: '进行中', color: '#f76707' }, // active orange
 { name: '已完成', color: '#609926' }, // primary green
];

const SEED_ISSUES: SeededIssue[] = [
 { columnLabel: '待办', title: '设计看板 UI' },
 { columnLabel: '待办', title: '接 gitea API' },
 { columnLabel: '进行中', title: '实现卡片拖拽', body: '前端 +后端联动；换绑 label 是关键' },
 { columnLabel: '进行中', title: '实现 commit关联' },
 { columnLabel: '已完成', title: '完成仓库下拉' },
];

async function setKeychain(token: string): Promise<void> {
 try {
 await keychainSet(URL, KB_USER, token);
 } catch (e: unknown) {
 console.error('keychain set failed:', e instanceof Error ? e.message : String(e));
 process.exit(2);
 }
}

async function main() {
 console.log(`seed: ${REPO_OWNER}/${REPO_NAME}\n`);

 //写 admin token进 keychain（giteaFetch / gitea-js都通过 keychain拿 token）
 await setKeychain(KB_TOKEN);

 // 用 gitea-js Api（ADR-0002 reset 后取代 openapi-fetch）
 const api = giteaApi(URL, {
 token: KB_TOKEN,
 // gitea1.x用 `token <pat>` 不是 Bearer —— override securityWorker
 securityWorker: (securityData) => {
 if (!securityData) return;
 return { secure: true, headers: { Authorization: `token ${securityData}` } };
 },
 });

 // =====1. 列出现有 labels =====
 console.log('[1] 列出现有 labels');
 const existingLabelsRes = await api.repos.issueListLabels(REPO_OWNER, REPO_NAME, { limit:100 });
 const existingLabels = existingLabelsRes.data;
 console.log(` → 当前 ${existingLabels.length} 个 label`);

 // =====2. 创建 label（幂等：按 name去重）=====
 console.log('\n[2] 创建/复用3 个 label「待办/进行中/已完成」');
 const labelIds: Record<string, number> = {};
 for (const seed of SEED_LABELS) {
 const existing = existingLabels.find((l) => l.name === seed.name);
 if (existing) {
 labelIds[seed.name] = existing.id ?? 0;
 console.log(` →复用 label #${existing.id ?? '?'}「${seed.name}」color=${existing.color ?? ''}`);
 } else {
 await check(`create label「${seed.name}」`, async () => {
 const res = await api.repos.issueCreateLabel(REPO_OWNER, REPO_NAME, {
 name: seed.name,
 color: seed.color,
 });
 const created = res.data;
 labelIds[seed.name] = created.id ?? 0;
 console.log(` → 创建 label #${created.id ?? '?'}「${seed.name}」`);
 });
 }
 }

 // =====3. 列出现有 issues =====
 console.log('\n[3] 列出现有 issues');
 const existingIssuesRes = await api.repos.issueListIssues(REPO_OWNER, REPO_NAME, {
 state: 'all', type: 'issues', limit: 100,
 });
 const existingIssues = existingIssuesRes.data.filter((i) => !i.pull_request);
 console.log(` → 当前 ${existingIssues.length} 个 issue`);

 // =====4. 创建 issue（幂等：按 title 去重）=====
 console.log('\n[4] 灌5 个 issue（每个带1 个对应 label）');
 for (const seed of SEED_ISSUES) {
 const existing = existingIssues.find((i) => i.title === seed.title);
 if (existing) {
 console.log(` →复用 issue #${existing.number ?? '?'}「${seed.title}」`);
 continue;
 }
 await check(`create issue「${seed.title}」`, async () => {
 const labelId = labelIds[seed.columnLabel];
 if (!labelId) throw new Error(`label「${seed.columnLabel}」不存在`);
 const res = await api.repos.issueCreateIssue(REPO_OWNER, REPO_NAME, {
 title: seed.title,
 ...(seed.body !== undefined ? { body: seed.body } : {}),
 labels: [labelId],
 });
 const created = res.data;
 console.log(` → 创建 issue #${created.number ?? '?'}「${created.title ?? ''}」带 label #${labelId}「${seed.columnLabel}」`);
 });
 }

 // =====5. 让 kanban_bot 在本机关联这个项目（让 App端 isProject=true）=====
 console.log('\n[5] 关联 kanban_bot 到项目');
 // repos.addProject IPC 是 App端的能力
 // isProject 是本地标记（repo_projects 表），通过 App UI 的 selectProject → addProject触发
 console.log(' ℹ️ isProject 是本地标记，App UI选仓库时自动 addProject');

 // =====verify=====
 console.log('\n[verify] 列出 m4java-test 所有 issues');
 const finalIssuesRes = await api.repos.issueListIssues(REPO_OWNER, REPO_NAME, {
 state: 'all', type: 'issues', limit: 100,
 });
 const finalIssues = finalIssuesRes.data.filter((i) => !i.pull_request);
 console.log(` → 共 ${finalIssues.length} 个 issue`);
 for (const i of finalIssues) {
 const labels = (i.labels ?? []).map((l) => `「${l.name ?? ''}」`).join(',');
 console.log(` #${i.number ?? '?'}「${i.title ?? ''}」 ${labels}`);
 }

 console.log(`\nResult: ${pass} pass / ${fail} fail`);
 if (failures.length) {
 console.log('\nFailures:');
 failures.forEach((f) => console.log(' - ' + f));
 }
 process.exit(fail >0 ?1 :0);
}

main().catch((e) => {
 console.error('FATAL:', e);
 process.exit(2);
});
