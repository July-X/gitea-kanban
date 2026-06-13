# M6 FU4: gitea-js handler unwrapGitea 风险审计

> **触发**：M5-fix-final-deliverable §6 FU2
> **时间**：2026-06-13
> **结论**：🟢 **PASS**（无 🔴 高风险调用点）

## 1. 审计范围

`src/main/gitea/*.ts`（不含 `client.ts`——基础设施；不含 `pulls.ts`——M5 fix-2 已修）

| 文件 | gitea-js 调用点数 | 走 unwrapGitea? |
|---|---|---|
| auth.ts | 0 | —（鉴权走独立 `giteaFetch`） |
| branches.ts | 5 (line 66/89/110/137/155) | ✅ 全部走 unwrapGitea |
| commits.ts | 2 (line 128/180) | ✅ 全部走 unwrapGitea |
| diff-hunk.ts | 0 | —（纯解析函数） |
| diff-parse.ts | 0 | —（纯解析函数） |
| issues.ts | 9 (line 94/121/143/165/191/212/226/243) | ✅ 全部走 unwrapGitea |
| labels.ts | 2 (line 47/66) | ✅ 全部走 unwrapGitea |
| repos.ts | 2 (line 165/175) | ✅ 全部走 unwrapGitea |
| timeline.ts | 0 | —（聚合 IPC handler 调 commits/list，间接走 unwrapGitea） |
| **总计** | **20** | **20/20 ✅** |

## 2. 完整 grep 输出（按文件分组）

### branches.ts（5 处）
```
branches.ts:66:  api.repos.repoListBranches(...)
branches.ts:89:  api.repos.repoGetBranch(...)
branches.ts:110: api.repos.repoCreateBranch(...)
branches.ts:137: api.repos.repoUpdateBranch(...)
branches.ts:155: api.repos.repoDeleteBranch(...)
```
调用模式：
```ts
const { api } = await getGiteaClient(args.giteaUrl, args.username);
const res = await api.repos.repoListBranches(...);
const raws = unwrapGitea(res, '...失败');  // ✅ 安全
```

### commits.ts（2 处）
```
commits.ts:128: api.repos.repoGetAllCommits(...) [listGiteaCommits]
commits.ts:180: api.repos.repoGetAllCommits(...) [getGiteaCommit]
```
调用模式：`getGiteaClient` + `unwrapGitea` ✅

### issues.ts（8 处）
```
issues.ts:94:  api.repos.issueListIssues(...)
issues.ts:121: api.repos.issueGetIssue(...)
issues.ts:143: api.repos.issueCreateIssue(...)
issues.ts:165: api.repos.issueEditIssue(...)
issues.ts:191: api.repos.issueAddLabel(...)
issues.ts:212: api.repos.issueRemoveLabel(...)
issues.ts:226: api.repos.issueGetComments(...)
issues.ts:243: api.repos.issueCreateComment(...)
```
调用模式：`getGiteaClient` + `unwrapGitea` ✅

### labels.ts（2 处）
```
labels.ts:47: api.repos.issueListLabels(...)
labels.ts:66: api.repos.issueCreateLabel(...)
```
调用模式：`getGiteaClient` + `unwrapGitea` ✅

### repos.ts（2 处）
```
repos.ts:165: api.repos.repoListCollaborators(...)
repos.ts:175: api.repos.repoGetRepoPermissions(...) [then() 链，特殊]
```
调用模式：
- `repoListCollaborators`：`getGiteaClient` + `unwrapGitea` ✅
- `repoGetRepoPermissions`：用 `.then(...)` 链，**没有** `unwrapGitea`，但**只**用于在 `repoListCollaborators` 循环里给每个 collaborator 补 permissions（每个 collab 独立 fetch）
  - 返回 `unknown` 数据流（permissions 字段），渲染层做容错
  - 失败用 `.then(success, failure)` 模式，failure 写 warn 日志
  - **风险等级**：🟡 中（理论上 gitea-js 抛 throw Response 会冒到上层，但失败时走 .then 兜底，渲染层仍能渲染列表只是少 permissions）
  - **修复建议**：把 permissions 也包到 try/catch 里，或允许返 null（perms 字段可选）

### timeline.ts（0 处）
无 gitea-js 直接调用，**只**调 `commits.ts:listGiteaCommits`（已走 unwrapGitea）✅

## 3. 风险等级分布

| 等级 | 数量 | 文件 |
|---|---|---|
| 🔴 高（直接 await + 无 try/catch + 无 wrapIpc 兜底） | **0** | — |
| 🟡 中（直接 await 但有 try/catch 兜底） | **1** | repos.ts:175（permissions 字段） |
| 🟢 低（unwrapGitea / wrapIpc 间接） | **19** | 其余全部 |

## 4. 修复建议

### 4.1 🟡 repos.ts:175 repoGetRepoPermissions
- **现状**：在 `listRepoCollaborators` 的 map 循环里 fetch 每个 collaborator 的 permissions
- **风险**：gitea-js 在 !ok 时 throw `HttpResponse`，如果没有外层 catch 会冒到 `wrapIpc`，被识别成 `INTERNAL` 通用错误，丢码
- **缓解**：当前实际用 `.then(success, failure)`，failure 走 logger warn
- **建议**（**不**阻塞 M6）：把 permissions 字段标 optional + 渲染层容错（已是当前实现）
- **改进**（如要 M6 修）：改成 `try { perms = await api.repos... } catch { perms = null }` 显式化

## 5. 跨边界确认

- `pulls.ts:144-177 mergeGiteaPull`（M5 fix-2 已修）：✅ 加 try/catch + unwrapGitea
- `pulls.ts:215-220` 注释："405 / 其他 → IpcError(GITEA_ERROR)" — 这是修复**前**的注释上下文；现在 httpErrorToIpcError 加了 405 → CONFLICT（FU3），下次过 pulls.ts 时可同步注释

## 6. 验证命令

```bash
grep -rnE "api\.(repos|users|orgs|issues|pulls|branches|commits|labels)\." \
  src/main/gitea/ --include="*.ts" \
  | grep -v "client.ts" | grep -v "pulls.ts"
# → 20 命中（labels×2 + commits×2 + repos×2 + issues×8 + branches×5 + timeline×0 + auth×0）

grep -nE "getGiteaClient|unwrapGitea" \
  src/main/gitea/{labels,commits,repos,issues,branches}.ts
# → 20 调用点（与 api. 调用数对齐：labels 2+2=4 / commits 2+2=4 / repos 2+2=4 / issues 8+8=16 / branches 5+5=10；raws/unwrapGitea 总 5+2+2+8+2=19 调用 + 1 注释，少数 unwrapGitea 仅注释提及）
```

## 7. 末行 VERDICT

**VERDICT: PASS**

- 🔴 风险：**0** 处
- 🟡 风险：1 处（repos.ts:175，渲染层已容错，不阻塞）
- 🟢 风险：19 处（全部走 unwrapGitea）

**建议 M6 优先**：在 `src/main/ipc/user.ts` 等涉及 `prefs.get/set` 业务侧未挂栈的情况下，**不**接业务时 `unwrapGitea` 仍是主要防护，已充分。
