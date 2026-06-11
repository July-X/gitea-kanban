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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const URL = 'http://127.0.0.1:3000';
const KB_TOKEN = process.env['KB_TOKEN'] ?? '';
const KB_USER = 'kanban_bot';
/**
 * gitea 组织名带空格（display: "kanban demo"），但 REST API path 要用 `kanban_demo`（无空格）
 * —— 2026-06-11 实测验证：curl 走 `kanban%20demo` 返 404 `GetUserByName` 错误；走 `kanban_demo` 200
 * git clone URL 也是 `kanban_demo/m4java-test.git`（已实测）
 * 显示层（issue / PR 的 html_url）会 render 成 "kanban demo/m4java-test" —— 用户侧无感
 */
const REPO_OWNER = 'kanban_demo';
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
interface SeededCommit {
 branch: string;        // 提交到哪个分支
 message: string;       // commit message
 /** 如果设了，该 commit 是从这个分支的 SHA 拉出来的（用于"merge commit"前的 feature 提交） */
 fromBranch?: string;
}
interface SeededPR {
 title: string;
 body?: string;
 head: string;          // source 分支
 base: string;          // target 分支（merge into）
 /** 决定 PR 的最终状态 */
 closeAfterCreate?: boolean; // 创建后立即 close
 mergeAfterCreate?: boolean; // 创建后立即 merge（默认 squashed）
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

// ===== 分支 / commit / PR seed（2026-06-11 user 拍板扩 e2e 数据）=====
// 设计：3 个分支（main + feature-kanban + feature-merge），12 个 commit，2 个 PR（1 open + 1 merged）
// 全部在 m4java-test 内，**不**碰其他任何仓库

/**
 * 分支定义：
 * - main：已有（root session 之前拍板）
 * - feature-kanban：从 main HEAD 拉出来，4 个 commit（看板 UI 改稿）
 * - feature-merge：从 main HEAD 拉出来，4 个 commit（合并逻辑 + docs）
 *
 * 顺序：feature-kanban commit[0] 时间最早，feature-merge commit[0] 时间稍晚（模拟团队协作时序）
 */
const SEED_BRANCHES: Array<{ name: string; from: string }> = [
 { name: 'feature-kanban', from: 'main' },
 { name: 'feature-merge', from: 'main' },
];

/**
 * Commit 定义：每个 commit 在 notes/kanban-demo/<slug>.md 加一段
 * slug 由 message 派生（确定性 → 重跑幂等）
 */
const SEED_COMMITS: SeededCommit[] = [
 // feature-kanban: 4 个
 { branch: 'feature-kanban', message: 'feat(kanban): 加列容器组件' },
 { branch: 'feature-kanban', message: 'feat(kanban): 加卡片渲染' },
 { branch: 'feature-kanban', message: 'refactor(kanban): 提取 useColumnLayout hook' },
 { branch: 'feature-kanban', message: 'docs(kanban): 补 README 看板用法' },
 // feature-merge: 4 个
 { branch: 'feature-merge', message: 'feat(merge): 加 PR 合并前置检查' },
 { branch: 'feature-merge', message: 'feat(merge): 加合并策略选项（merge/squash/rebase）' },
 { branch: 'feature-merge', message: 'test(merge): 单测合并工作流' },
 { branch: 'feature-merge', message: 'docs(merge): 补合并决策树文档' },
 // main: 4 个（main 上独立的演进 commit，跟 feature branch 解耦）
 { branch: 'main', message: 'chore: 升级 better-sqlite3 到 12.x' },
 { branch: 'main', message: 'fix(sqlite): 修 ABI mismatch 后的初始化路径' },
 { branch: 'main', message: 'refactor: 提取 gitea client 单例' },
 { branch: 'main', message: 'docs: AGENTS §8.15 数据目录路径规范' },
];

/**
 * PR 定义：
 * - PR #1「看板 UI 改稿」feature-kanban → main：**open**（让 App 端测"合并"按钮）
 * - PR #2「合并工作流」feature-merge → main：**merged**（让 App 端测"已合并"列表）
 */
const SEED_PRS: SeededPR[] = [
 {
 title: '看板 UI 改稿（feature-kanban → main）',
 body: '看板视图初版；3 列容器 + 卡片渲染 + useColumnLayout hook。求 review @m4java',
 head: 'feature-kanban',
 base: 'main',
 },
 {
 title: '合并工作流（feature-merge → main）',
 body: '合并前置检查 + 策略选项（merge/squash/rebase） + 单测 + 决策树文档。',
 head: 'feature-merge',
 base: 'main',
 mergeAfterCreate: true,
 },
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

 // =====6. git clone + 创建 feature 分支 + 12 个 commit（git push 实写）=====
 // 隔离：clone 到 /tmp/seed-m4java-test-clone，**不**动 gitea-kanban 项目本身
 // 幂等：按 commit message 查重（gitea 端按 sha 唯一），重复跳过
 console.log('\n[6] git 操作：clone + 12 commits + 2 PRs');
 await seedGitHistory(api, KB_TOKEN);

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

 // verify branches / commits / PRs
 console.log('\n[verify] 列出 m4java-test 所有 branches');
 const finalBranchesRes = await api.repos.repoListBranches(REPO_OWNER, REPO_NAME, { limit: 50 });
 console.log(` → 共 ${finalBranchesRes.data.length} 个 branch`);
 for (const b of finalBranchesRes.data) console.log(` * ${b.name}`);

 console.log('\n[verify] 列出 m4java-test 所有 PRs');
 const finalPRsRes = await api.repos.repoListPullRequests(REPO_OWNER, REPO_NAME, { state: 'all', limit: 20 });
 const finalPRs = finalPRsRes.data;
 console.log(` → 共 ${finalPRs.length} 个 PR`);
 for (const pr of finalPRs) {
 console.log(` #${pr.number ?? '?'}「${pr.title ?? ''}」 ${pr.state}${pr.merged ? ' (merged)' : ''} ${pr.head?.ref ?? ''} → ${pr.base?.ref ?? ''}`);
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

/**
 * git 操作：clone m4java-test → 3 个 feature 分支 + 12 commits → push → 2 PRs
 *
 * 隔离保证：
 * - clone 到 ${tmpdir}/seed-m4java-test-clone，**不**写 gitea-kanban 项目本身
 * - REPO_NAME === 'm4java-test' hardcode 断言，push 前再断言 origin URL 含 m4java-test
 * - 异常路径上 rmSync(cloneDir, { force: true }) 清场
 *
 * 幂等：
 * - 分支：gitea 端按 branch name 查重，exists 则跳过该分支所有 commit
 * - PR：按 title 查重，exists 则跳过
 * - commit message：按 message 生成 deterministic slug，文件内容含 commit msg，重跑不会"双 commit"
 *   （gitea 端 sha 唯一，相同 tree 也不会再产生新 commit；push force = noop）
 */
async function seedGitHistory(
 api: ReturnType<typeof giteaApi<unknown>>,
 token: string,
): Promise<void> {
 // ===== 防御断言 =====
 if (REPO_NAME !== 'm4java-test') {
 throw new Error(`SAFETY: REPO_NAME !== 'm4java-test'（当前 ${REPO_NAME}）—— 拒绝执行，避免误伤其他仓库`);
 }

 const cloneDir = (() => {
 // 优先用 $TMPDIR（沙箱环境可能覆盖为 sandbox 内部目录）回退到 /tmp
 // 真实 macOS / Linux 默认 TMPDIR 已经是 /var/folders/.../T/ 或 /tmp —— 这里强制走 /tmp 更直观
 const preferTmp = isAbsolute('/tmp') ? '/tmp' : tmpdir();
 return join(preferTmp, 'seed-m4java-test-clone');
 })();
 const cloneUrl = `http://kanban_bot:${token}@127.0.0.1:3000/kanban_demo/m4java-test.git`;

 // 清场：上一次的 clone（如果失败中途退出）
 if (existsSync(cloneDir)) {
 console.log(` [clone] 清场旧的 ${cloneDir}`);
 rmSync(cloneDir, { recursive: true, force: true });
 }
 mkdirSync(cloneDir, { recursive: true });

 // ===== 1. clone =====
 console.log(` [clone] ${cloneUrl.replace(token, '***')} -> ${cloneDir}`);
 run('git', ['clone', cloneUrl, cloneDir], { stdio: 'pipe' });

 // push 前再断言 origin URL 包含 m4java-test
 const originUrl = run('git', ['-C', cloneDir, 'config', '--get', 'remote.origin.url'], { stdio: 'pipe' });
 if (!originUrl.includes('m4java-test')) {
 throw new Error(`SAFETY: origin URL 不含 m4java-test —— ${originUrl}`);
 }
 console.log(` [clone] origin 断言 OK：含 m4java-test`);

 // 配置 commit author
 run('git', ['-C', cloneDir, 'config', 'user.name', 'kanban_bot'], { stdio: 'pipe' });
 run('git', ['-C', cloneDir, 'config', 'user.email', 'kanban_bot@local.dev'], { stdio: 'pipe' });

 // ===== 2. 列已存在的 branches =====
 const existingBranchesRes = await api.repos.repoListBranches(REPO_OWNER, REPO_NAME, { limit: 100 });
 const existingBranchNames = new Set(existingBranchesRes.data.map((b) => b.name));
 console.log(` [branch] gitea 端已有 ${existingBranchNames.size} 个 branch: ${[...existingBranchNames].join(', ')}`);

 // ===== 3. 创建 feature 分支（如果不存在）=====
 for (const seed of SEED_BRANCHES) {
 if (existingBranchNames.has(seed.name)) {
 console.log(` [branch] 复用 feature 分支「${seed.name}」`);
 continue;
 }
 console.log(` [branch] 创建「${seed.name}」 (from ${seed.from})`);
 run('git', ['-C', cloneDir, 'checkout', '-b', seed.name, seed.from], { stdio: 'pipe' });
 run('git', ['-C', cloneDir, 'push', '-u', 'origin', seed.name], { stdio: 'pipe' });
 }

 // ===== 4. 12 个 commit（按 branch 分组顺序）=====
 // 按 branch 分桶
 const commitsByBranch = new Map<string, SeededCommit[]>();
 for (const c of SEED_COMMITS) {
 if (!commitsByBranch.has(c.branch)) commitsByBranch.set(c.branch, []);
 commitsByBranch.get(c.branch)!.push(c);
 }

 for (const [branch, commits] of commitsByBranch) {
 console.log(` [commit] branch「${branch}」${commits.length} 个 commit`);

 // 切到目标分支
 run('git', ['-C', cloneDir, 'checkout', branch], { stdio: 'pipe' });

 // 取当前 HEAD（幂等起点：如果是首次跑，从 main 拉；重跑则 HEAD 不变）
 for (const c of commits) {
 const slug = slugify(c.message);
 const filePath = join(cloneDir, 'notes', 'kanban-demo', `${slug}.md`);

 // 写文件（如果已存在且内容相同，git add 也幂等）
 mkdirSync(join(cloneDir, 'notes', 'kanban-demo'), { recursive: true });
 if (!existsSync(filePath)) {
 const content = `# ${c.message}\n\n> e2e seed commit created by scripts/seed-kanban-demo.ts\n\nbranch: \`${branch}\`\n`;
 writeFileSync(filePath, content, 'utf-8');
 }
 run('git', ['-C', cloneDir, 'add', `notes/kanban-demo/${slug}.md`], { stdio: 'pipe' });

 // 幂等检查：如果工作区已干净，跳过 commit + push
 const statusPorcelain = run('git', ['-C', cloneDir, 'status', '--porcelain'], { stdio: 'pipe' }).trim();
 if (statusPorcelain === '') {
 console.log(` ✓ ${branch} 已是最新，跳过「${c.message}」`);
 continue;
 }
 // commit + push
 run('git', ['-C', cloneDir, 'commit', '-m', c.message], { stdio: 'pipe' });
 run('git', ['-C', cloneDir, 'push', 'origin', branch], { stdio: 'pipe' });
 console.log(` ✓ ${branch} push「${c.message}」`);
 }
 }

 // ===== 5. PR 创建（幂等：按 title 查重）=====
 // 拉取 PR 列表（open + closed + merged 全要）
 const allPRsRes = await api.repos.repoListPullRequests(REPO_OWNER, REPO_NAME, { state: 'all', limit: 50 });
 const existingPRs = allPRsRes.data;
 const existingTitles = new Set(existingPRs.map((pr: { title?: string }) => pr.title ?? ''));

 for (const seed of SEED_PRS) {
 if (existingTitles.has(seed.title)) {
 console.log(` [pr] 复用「${seed.title}」`);
 continue;
 }
 console.log(` [pr] 创建「${seed.title}」${seed.head} → ${seed.base}`);
 const createRes = await api.repos.repoCreatePullRequest(REPO_OWNER, REPO_NAME, {
 title: seed.title,
 ...(seed.body !== undefined ? { body: seed.body } : {}),
 head: seed.head,
 base: seed.base,
 });
 const pr = createRes.data;
 console.log(` ✓ PR #${pr.number ?? '?'} 已创建`);

 // 立即合并
 if (seed.mergeAfterCreate) {
 console.log(` [pr] 合并 #${pr.number ?? '?'}（squash）`);
 await api.repos.repoMergePullRequest(REPO_OWNER, REPO_NAME, pr.number!, {
 Do: 'squash',
 MergeMessageField: `${pr.title}\n\nAuto-merged by seed-kanban-demo.ts`,
 });
 console.log(` ✓ PR #${pr.number ?? '?'} 已合并`);
 }
 }
}

/**
 * slugify(commit message) → 确定性文件名（重跑幂等）
 * "feat(kanban): 加列容器组件" -> "feat-kanban-jia-lie-rong-qi-zu-jian"
 */
function slugify(msg: string): string {
 return msg
 .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
 .toLowerCase()
 .replace(/^-+|-+$/g, '')
 .slice(0, 60);
}

function run(cmd: string, args: string[], opts: { stdio: 'pipe' | 'inherit' }): string {
 try {
 return execFileSync(cmd, args, { encoding: 'utf-8', ...opts, timeout: 30_000 }).toString();
 } catch (e: unknown) {
 const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
 const out = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
 throw new Error(`命令失败: ${cmd} ${args.join(' ')}\n${out || err.message || String(e)}`);
 }
}
