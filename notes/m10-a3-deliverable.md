# M10-task-2 (A3) — schema 完整性 roundtrip 诊断

## 1. 拉了哪些端点、哪些 raw 响应保存到 fixtures/

**docker gitea**: `http://localhost:3000` (gitea-kanban-test, up 2 days healthy)
**token**: kanban_demo (giteaDemo seed 脚本硬编码 token)
**owner/repo**: `kanban_demo/m4java-test`

10 个端点拉了 raw gitea 1.x 响应，存到 `src/main/ipc/__tests__/fixtures/`：

| 端点 | fixture | 字段数 | 条数 |
|---|---|---|---|
| GET /repos/{o}/{r}/pulls?state=all&limit=10 | giteaPullList.json | 35 | 2 |
| GET /repos/{o}/{r}/pulls/11 | giteaPullSingle.json | 38 | 1 |
| GET /repos/{o}/{r}/commits?sha=main&limit=5 | giteaCommitList.json | 10 | 5 |
| GET /repos/{o}/{r}/git/commits/{sha} | giteaCommitSingle.json | 10 | 1 |
| GET /repos/{o}/{r}/issues?state=all&limit=10 | giteaIssueList.json | 27 | 10 |
| GET /repos/{o}/{r}/issues/25 | giteaIssueSingle.json | 27 | 1 |
| GET /repos/{o}/{r} | giteaRepo.json | 62 | 1 |
| GET /repos/{o}/{r}/branches?limit=10 | giteaBranchList.json | 9 | 6 |
| GET /repos/{o}/{r}/labels?limit=10 | giteaLabelList.json | 7 | 10 |
| GET /repos/{o}/{r}/collaborators?limit=10 | giteaCollaborators.json | 23 (User) | 1 |

拉响应脚本：`scripts/_pull-gitea-fixtures.mjs`（不入仓，ad-hoc 工具）。

## 2. roundtrip 诊断表

| Schema | parse 结果 | 漏字段 | 类型不匹配 | 状态 |
|---|---|---|---|---|
| PullDtoSchema | ✅ pass | 无 | 无 | OK |
| ListPullsRespSchema | ✅ pass | 无 | 无 | OK |
| ListCommitsRespSchema (list) | ✅ pass | 无 | 无 | OK |
| CommitDtoSchema (single + files) | ✅ pass | 无 | 无 | OK |
| ListIssuesRespSchema | ✅ pass | 无 | 无 | OK |
| IssueCardDtoSchema (single) | ✅ pass | 无 | 无 | OK |
| RepoDtoSchema | ✅ pass | 无 | 无 | OK |
| ListBranchesRespSchema | ✅ pass | 无 | 无 | OK |
| ListLabelsRespSchema | ✅ pass | 无 | 无 | OK |
| ListMembersRespSchema | ✅ pass | 无 | 无 | OK |

**附加检查**（.strict() 兜底回归）：所有 7 个 .strict() schema **正确拒绝** raw gitea 输入（gitea raw 38 字段 vs DTO 13 字段，期望 production path 不会发生，但 schema 兜底）。

**核心结论**：**10/10 schema 跟 gitea 1.x 真实响应形状一致 — 0 schema 修复需求。**

## 3. 加了哪些单测

**文件**：`src/main/ipc/__tests__/schemaRoundtrip.test.ts`（463 行，11 cases）

```bash
$ pnpm test
 Test Files  6 passed (6)            ← M9 task-2 5 files 68 tests + 本任务 1 file 11 tests = 6 files 79 tests
      Tests  79 passed (79)
   Start at  14:11:29
   Duration  2.79s
```

按 schema 分组（7 个 describe）：
- PullDtoSchema / ListPullsRespSchema（3 cases：单条/列表/.strict 兜底）
- CommitDtoSchema / ListCommitsRespSchema（2 cases：list 无 stats / single 带 stats+files）
- IssueCardDtoSchema / ListIssuesRespSchema（2 cases：单条/列表）
- RepoDtoSchema（1 case）
- BranchDtoSchema / ListBranchesRespSchema（1 case，main 分支 isDefault=true）
- LabelDtoSchema / ListLabelsRespSchema（1 case，验 color 是 6 位 hex）
- CollaboratorDtoSchema / ListMembersRespSchema（1 case，permission='unknown' 兜底）

不破 M9 task-2 已有 3 个 test file（isoDateSchema / pullDtoSchema / timelineDtoSchema，43 cases）。

## 4. 关键决策

1. **fixtures 在 `src/main/ipc/__tests__/fixtures/`**：不入 .gitignore（verifier 可见 + 复用价值高），不算"测试产物"而是 schema 真实响应的 capture
2. **toDto adapters hand-roll 镜像 src/main/gitea/*.ts**（行号标 MIRRORS 注释，1:1 防漂移）：
   - 不直接 import 业务层 — client.ts/auth.ts 顶层 import electron，node env 跑会崩
   - 这跟 M9 task 2 复用 memory `gitea-js-wrap` 的 §"tsx+ESM+electron CJS 互操作"是同源
3. **JSON 静态导入 + cast `unknown[]`**：TS 静态导入按首项 literal 推断 callback type，cast 让 toDto 接 broad shape
4. **gitea branch 端 `commit.author` 形状 = `{ name, email, username }`**，**不**是 user 形状的 `{ login }`：
   - gitea 端 PR/issue 用 user 形状（login 字段）
   - gitea 端 branch/commit 用 commit-author 形状（name 字段）
   - 容易踩坑：M9 task 2 的 timelineDto 用了 PR.user.name，但 branch.lastCommit 用 commit.author.name
5. **fixtures 第 1 条 = closed state**（e2e-card demo 是 closed），不要硬编码 open 期望（我第一版踩了 → 修）
6. **RepoDtoSchema.isProject**：`z.boolean().default(false)` 类型上是 required（`.default()` 不影响 input type），toRepoDto 必须显式 `isProject: false`（gitea 不区分 repo vs project，v1 简化 = 始终 false）

## 5. Commit 状态

**本任务未 git commit**（worker agent 守 AGENTS.md §7.1 + memory "worker 不自 commit"）。

期望 orchestrator 打 1 个 commit：
- `test: 补 schema 完整性 roundtrip 真实 fixture 单测 (M10-task-2)`
- 改动：fixtures/ (10 JSON) + schemaRoundtrip.test.ts (新增)
- **不**动 src/main/ipc/schema.ts（无修复需求）

## 6. 4 件套实证

```bash
# 1. type-check
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
(exit 0, 0 error)

# 2. vitest（better-sqlite3 ABI 切到 node 25）
$ pnpm test
 Test Files  6 passed (6)
      Tests  79 passed (79)
(exit 0)

# 3. build
$ pnpm build
✓ built in 5.40s
(exit 0)

# 4. ABI 切回（per memory 4 件套顺序）
(cd node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3 && npx prebuild-install --runtime=electron --target=41.7.2)
```

## 7. 已知 follow-up（**不**本任务范围）

- `gitea PR.body / labels / assignees / milestone / comments / review_comments / diff_url / patch_url / html_url` 等 25 字段在 toPullDto 被裁掉 — 这是 v1 简化（UI 用不到），不是 schema bug；如未来 UI 需要 (e.g. 卡片显示 PR 描述) 才扩展
- `gitea Issue.body` 同上 — 现有 IssueCardDtoSchema.body 必填 string，toDto 已传（schema OK）
- `CollaboratorDtoSchema.permission: 'unknown'` 是 fixture 没拉 per-user /permission 端点的兜底 — production 走 N+1 拉（src/main/gitea/repos.ts:152）

## 8. 守规则确认

- ✅ AGENTS.md §7.1：.strict() 全部保留不动
- ✅ 不跑 prettier --write 全量
- ✅ 改 schema.ts 1 处跑 1 次 tsc（本任务 0 处改 schema.ts，0 次 tsc 在 schema.ts 改时）
- ✅ 真实响应字段集合以 gitea 1.26 swagger 为准（gitea-js 1.23 类型已覆盖）
- ✅ 4 件套顺序：tsc（无 ABI 切换）→ 切 node ABI → vitest → build → 切回 electron ABI
- ✅ 不 git commit（worker 守则）
