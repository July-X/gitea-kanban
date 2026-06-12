# M5-Fix2: mergeGiteaPull 加 try/catch 包装 gitea-js throw Response — Deliverable

**Worker**: backend (session mvs_88a3fdd6f5b24c6c9bc4b623e1156bd9)
**Plan**: plan_ca3ee537 / task fix-mergegiteapull-wrap
**Date**: 2026-06-11 21:05 Asia/Shanghai

---

## Summary

`src/main/gitea/pulls.ts` 的 `mergeGiteaPull` 加 try/catch，识别 gitea-js 1.23.0 在 fetch 层 `throw` 出来的 `HttpResponse` 对象，走 `unwrapGitea` 复用 `httpErrorToIpcError` 映射成结构化 `IpcError`（CONFLICT / PERMISSION_DENIED / NOT_FOUND / VALIDATION_FAILED / GITEA_ERROR）。修后前端不再收到裸 `[object Response]` 误判成 `INTERNAL` 的"应用内部错误"。

---

## 背景

来自 M4 W3 报告 `notes/m4-w3-deliverable.md` step 5b 失败 + 自身 memory M4 plan_2f3810f0 follow-up 跟踪：

- `gitea-js 1.23.0` 的 `HttpClient.request` 在 `!response.ok` 时**直接 throw** 修改过的 Response（`node_modules/gitea-js/dist/index.js:161-162` 的 `if (!response.ok) throw data;`）
- 旧 `mergeGiteaPull` 没 try/catch，这个对象一路冒到 `src/main/ipc/pulls.ts:81-103` 的 `wrapIpc` catch-all
- `wrapIpc` 把它判成 `IpcError(INTERNAL)` → 前端只看到 "应用内部错误" + `cause="[object Response]"`
- **丢码**（应该是 `CONFLICT` 等）+ **丢人话**（无 hint、无 httpStatus、无 gitea 业务 message）

---

## 改动

### 1. `src/main/gitea/pulls.ts`（核心修复，2 处）

#### (a) import 加 `HttpResponse` type

```diff
-import type { PullRequest } from 'gitea-js';
+import type { HttpResponse, PullRequest } from 'gitea-js';
 import { getGiteaClient, unwrapGitea } from './client.js';
```

> **注意**：任务 prompt 示例 `import type { HttpResponse } from 'openapi-fetch';` 是错的——本项目 v3 升级后用的是 **`gitea-js`**（见 `src/main/gitea/client.ts:35` + ADR-0002 §"gitea-js 引入" + package.json `gitea-js: ^1.23.0`）。从 gitea-js 导 `HttpResponse` 才是正确路径。

#### (b) `mergeGiteaPull` 函数体套 try/catch

旧实现：直接 `await api.repos.repoMergePullRequest(...)`，fetch 失败时 throw 裸 `HttpResponse`。

新实现：包 try/catch；catch 内用 duck-typing 识别 `err.ok === false && 'status' in err`（即 gitea-js throw 出来的 `HttpResponse`），把它当 `HttpResponse<unknown, unknown>` 喂给 `unwrapGitea`，让 `httpErrorToIpcError` 做码映射：

- 409 → `IpcError(CONFLICT)`
- 403 → `IpcError(PERMISSION_DENIED)`
- 404 → `IpcError(NOT_FOUND)`
- 422 → `IpcError(VALIDATION_FAILED)`
- 405 / 其他 → `IpcError(GITEA_ERROR)`

非 `HttpResponse` 形状的 throw（如程序 bug / 业务层意外 throw）保持原样 re-throw，让 `wrapIpc` catch-all 走 `INTERNAL` 通用路径——**不**把未识别的 throw 强行转成 IpcError 丢上下文。

完整 diff：

```diff
 export async function mergeGiteaPull(args: {
   giteaUrl: string;
   username: string;
   owner: string;
   repo: string;
   index: number;
   method: 'merge' | 'rebase' | 'rebase-merge' | 'squash';
   deleteBranchAfter?: boolean;
   commitMessage?: string;
 }): Promise<MergePrResult> {
   const { api } = await getGiteaClient(args.giteaUrl, args.username);
 
-  const res = await api.repos.repoMergePullRequest(args.owner, args.repo, args.index, {
-    Do: args.method,
-    ...(args.deleteBranchAfter !== undefined ? { delete_branch_after_merge: args.deleteBranchAfter } : {}),
-    ...(args.commitMessage !== undefined ? { MergeMessageField: args.commitMessage } : {}),
-  });
-  // 合并成功时 gitea 通常 200 + 空 body；gitea-js res.data 是 void
-  // 走 ok 分支：返回基本成功标识
-  if (res.ok) {
+  try {
+    const res = await api.repos.repoMergePullRequest(args.owner, args.repo, args.index, {
+      Do: args.method,
+      ...(args.deleteBranchAfter !== undefined ? { delete_branch_after_merge: args.deleteBranchAfter } : {}),
+      ...(args.commitMessage !== undefined ? { MergeMessageField: args.commitMessage } : {}),
+    });
+    // 合并成功时 gitea 通常 200 + 空 body；gitea-js res.data 是 void
+    // 走 ok 分支：返回基本成功标识
+    if (res.ok) {
+      return {
+        sha: '',
+        merged: true,
+        message: 'merge success',
+      };
+    }
+    // 失败时 gitea-js res.data 也有内容，统一丢给 unwrapGitea 抛 IpcError
+    const raw = unwrapGitea(res, `合并 PR #${args.index}失败`) as { sha?: string; merged?: boolean; message?: string } | undefined;
     return {
-      sha: '',
-      merged: true,
-      message: 'merge success',
+      sha: raw?.sha ?? '',
+      merged: raw?.merged ?? true,
+      message: raw?.message ?? '',
     };
+  } catch (err) {
+    // gitea-js 1.23.0 在 fetch 层遇到 !ok 时**直接 throw** 修改过的 Response（HttpResponse 子类）
+    //   见 node_modules/gitea-js/dist/index.js:161-162 `if (!response.ok) throw data;`
+    // 如果不 catch，这个对象会一路冒到 IPC wrapIpc，被 catch-all 误判成 INTERNAL，
+    //   前端只能看到 "应用内部错误" + cause="[object Response]" —— 丢码又丢人话
+    // 这里把它当 HttpResponse 处理：走 unwrapGitea 复用 httpErrorToIpcError 映射
+    //   - 409 → IpcError(CONFLICT)
+    //   - 403 → IpcError(PERMISSION_DENIED)
+    //   - 404 → IpcError(NOT_FOUND)
+    //   - 422 → IpcError(VALIDATION_FAILED)
+    //   - 405 / 其他 → IpcError(GITEA_ERROR)
+    if (err && typeof err === 'object' && 'ok' in err && 'status' in err) {
+      // 类型守卫：把 unknown 当 HttpResponse 用（gitea-js throw 的就是 HttpResponse）
+      const httpErr = err as HttpResponse<unknown, unknown>;
+      // unwrapGitea 在 !ok 时一定 throw IpcError（不会 return）
+      unwrapGitea(httpErr, `合并 PR #${args.index}失败`);
+    }
+    // 非 HttpResponse 错误（程序 bug / IO 异常 / 其它）直接抛
+    //   wrapIpc 会把它 catch 成 IpcError(INTERNAL) 走通用错误路径
+    throw err;
   }
-  // 失败时 gitea-js res.data 也有内容，统一丢给 unwrapGitea 抛 IpcError
-  const raw = unwrapGitea(res, `合并 PR #${args.index}失败`) as { sha?: string; merged?: boolean; message?: string } | undefined;
-  return {
-    sha: raw?.sha ?? '',
-    merged: raw?.merged ?? true,
-    message: raw?.message ?? '',
-  };
 }
```

### 2. `scripts/verify-mergeWrap.ts`（新增验证脚本，~190 行）

3 case 矩阵，覆盖 `httpErrorToIpcError` 关键分支：

| Case | gitea 状态 | body | 期望 IpcError.code | 期望 httpStatus |
|---|---|---|---|---|
| PR 已合并 | 409 | `{message: "pull request is closed"}` | `CONFLICT` | 409 |
| 保护分支 | 422 | `{message: "head branch is protected"}` | `VALIDATION_FAILED` | 422 |
| 405 Method Not Allowed | 405 | `{message: "..."}` | `GITEA_ERROR` (default branch) | 405 |

**测试策略**：起本地 `http.createServer` 模拟 gitea，让 gitea-js 走**真实** fetch 路径（gitea-js 内部 `customFetch` 默认走 `globalThis.fetch`），触发 gitea-js 的 `throw data` 路径（line 161-162），跑通业务层 try/catch，验证最后抛的是 `IpcError` 而不是裸 `Response`。

**为什么不用 vitest**：AGENTS §8.12 plan 收口教训——vitest ABI 切回 node 后 `pnpm dev` 跑不了。

**为什么不用 nock / msw**：避免加新 dep。

**为什么不 mock gitea-js / monkey-patch fetch**：import 链太重；用真 HTTP server 反而更真实更可靠。

**断言 4 步**（每 case 跑 4 个断言）：

1. 必须是 `IpcError`（不是 `HttpResponse`、不是 `[object Response]`）
2. code 匹配预期（如果 case 指定了）
3. code **绝对不能**是 `INTERNAL`（`INTERNAL` = wrapIpc catch-all 误判的指纹，证明 catch 路径没生效）
4. `httpStatus` 透传正确

**副作用管理**：
- 临时在系统 keychain 写 `service=gitea-kanban@http://127.0.0.1:<port>` 下的 user=`mockuser` 的 fake token
- 跑完 `keychainDelete` + `clearGiteaClientCache` 清理
- **不**碰 gitea 端（mock server 跑完关掉）
- **不**碰 `~/.gitea-kanban/kanban.db`（脚本只 import keychain / client / pulls，没碰 sqlite）

---

## 验证结果

### 1. `pnpm type-check` — 0 error

```
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
(0 error)
```

注：项目当前有 sibling worker 的 uncommitted changes（`src/main/ipc/index.ts` / `src/main/ipc/schema.ts` / `src/shared/ipc-channels.ts` / `src/main/ipc/__tests__/` / `src/main/ipc/user.ts`），是 m5-fix1 任务的产物。**全局 0 error 说明我的修改与 sibling 改动无冲突**。

### 2. `pnpm build` — 通过

```
$ pnpm build
vite v7.3.5 building ssr environment for production...
✓ 50 modules transformed.
out/main/index.js  138.37 kB
✓ built in 637ms
...
out/preload/index.cjs  5.50 kB
✓ built in 25ms
...
✓ 2768 modules transformed.
✓ built in 8.25s
```

`out/main/index.js` 从修前 ~137 kB → 138.37 kB（+1.3 kB，含 try/catch + 注释）。

### 3. `pnpm exec tsx scripts/verify-mergeWrap.ts` — 3/3 pass

```
verify-mergeWrap: gitea-js throw HttpResponse → mergeGiteaPull try/catch wrap

[setup] mock gitea at http://127.0.0.1:50509
[setup] keychain seeded with fake token

[case] PR 已合并 → 409
       note: 典型 W3 step 5b fail 场景；映射到 CONFLICT 是 httpErrorToIpcError 唯一 409 case
  ✅ PR 已合并 → 409: IpcError(code=conflict, httpStatus=409, message="操作冲突：资源已存在或状态不允许", cause=Conflict)

[case] 保护分支 → 422
       note: doc pulls.ts:19 提到 422 protected branch → CONFLICT，但 httpErrorToIpcError 实际 422 → VALIDATION_FAILED（独立 doc vs 实现 issue）
  ✅ 保护分支 → 422: IpcError(code=validation_failed, httpStatus=422, message="请求参数不被服务端接受", cause=Unprocessable Entity)

[case] gitea 405 Method Not Allowed
       note: doc pulls.ts:19 说 405→CONFLICT，但 httpErrorToIpcError 当前 405 走 default → GITEA_ERROR。修后**不是**裸 Response，doc 不匹配属独立 issue
  ✅ gitea 405 Method Not Allowed: IpcError(code=gitea_error, httpStatus=405, message="合并 PR #1失败", cause=Method Not Allowed)

[cleanup] closing mock server + deleting keychain entry

[summary] pass=3 fail=0
all pass
```

3/3 pass，**没有** INTERNAL 误判，**没有** 裸 Response 泄漏。

### 4. 回归 — `pnpm check:no-jargon` — 通过

```
$ pnpm check:no-jargon
[check:no-jargon] OK — 未发现禁用术语
```

---

## 改的文件清单

| 文件 | 类型 | 行数变化 |
|---|---|---|
| `src/main/gitea/pulls.ts` | 修改 | +37 / -18（核心修复） |
| `scripts/verify-mergeWrap.ts` | 新增 | +190（验证脚本） |

**scope 严格限定**：任务 prompt 说"只改 mergeGiteaPull 这一处"——我没有动 `httpErrorToIpcError`（虽然 405→CONFLICT 是 doc 写的，但 §7.1 #3 是改错误码表的事，超出本任务 scope，记 follow-up 下面）。

---

## Follow-up（不在本任务 scope，记 verifier 参考）

### Follow-up 1: `httpErrorToIpcError` 405 → CONFLICT 缺失

**位置**：`src/main/gitea/client.ts:62-128` `httpErrorToIpcError` switch。

**现状**：
- 405 走 `default` → `IpcError(GITEA_ERROR, fallbackMessage, cause, 405)`
- doc comment `src/main/gitea/pulls.ts:19` 写 "405/409 'pull request is closed' → CONFLICT"
- doc comment `src/main/gitea/pulls.ts:135-139` 也写 "405/409 'pull request is closed' → CONFLICT"

**doc vs 实现不匹配**——本任务修的是"裸 Response 泄漏到 INTERNAL"，没动 405 映射。

**修法**（参考，**不**在本任务动）：
```ts
case 405:
  return new IpcError({
    code: IpcErrorCode.CONFLICT,
    message: '操作冲突：方法不允许（PR 已合并/状态不允许）',
    cause,
    httpStatus: 405,
  });
```

**为什么不在本任务做**：
- 加 405 case = 改错误码表 = §7.1 拍板清单 #3
- 本任务 prompt 明令 "**只**改 mergeGiteaPull 这一处"
- 是 doc vs 实现 drift 的独立 issue，下个 plan 单独开 ticket

### Follow-up 2: 同样的 throw 处理可能漏在其它 gitea-js handler

`src/main/gitea/issues.ts` / `src/main/gitea/commits.ts` / `src/main/gitea/branches.ts` 等其它业务层函数都走 `await api.xxx.yyy(...)` + `unwrapGitea(res, ...)` 模式，**也**会撞 gitea-js throw 裸 HttpResponse 的 bug。

本任务只修 `mergeGiteaPull`（任务 prompt 限定）。其它 handler 的修法**可能**不同——比如 `issues.ts` 的 `unwrapGitea(res, '...')` **已经**是同步调用 await 的返回值，`HttpResponse` 直接传进去，不会触发 throw。**但是**如果 `res.data` 是个对象、且 parse 失败，gitea-js 走 `.catch((e) => { r.error = e; return r; })` 分支，**然后** `if (!response.ok) throw data` 也会 throw 出来。

**结论**：其它 handler 撞不撞这个 bug 取决于 gitea 端响应是否能成功 parse 成 JSON。**建议**在下一个 m5 follow-up plan 里统一做一次 gitea-js error wrapping 的 audit（grep 所有 `unwrapGitea(` 找没 try/catch 的）。

### Follow-up 3: 跟 sibling m5-fix1 协同

`src/main/ipc/schema.ts:33` 的 `IsoDateSchema` 在 m5-fix1 任务中已修（`z.string().datetime({ offset: true })`）。我的修不依赖 schema，但**整链路**验证 W3 step 5b 应该重跑一次：

```bash
KB_TOKEN=<token> pnpm exec tsx scripts/e2e-verify-w3.ts
```

预期：Z1-Z3 命中 0 次，step 5b 抛 `IpcError(code=conflict, httpStatus=409)` 而不是 INTERNAL。

---

## 工程师备注（给未来 worker）

1. **HttpResponse 来源**：永远从 `gitea-js` 导入（**不**是 `openapi-fetch`）。本项目 v3 升级已统一。
2. **try/catch 模式**：catch 内 duck-type 识别 `err.ok === false && 'status' in err`——这个条件是 HttpResponse 的最小识别集。其它 throw（如 TypeError、NetworkError）不会满足，让它原样抛上去给 `wrapIpc` 走 INTERNAL。
3. **unwrapGitea 内部 throw**：在 `!res.ok` 时 `unwrapGitea` 一定 throw `IpcError`（不会 return），所以 `unwrapGitea(httpErr, ...)` 这一行的控制流等价于 `throw IpcError(...)`——不需要 return。
4. **不**改 `httpErrorToIpcError`——加 case 是改错误码表（§7.1 #3），需要 escalate。
5. **回归测试**：写脚本时**用真 HTTP server**，不要 mock gitea-js / fetch 内部——gitea-js 1.23.0 后续 minor 升级改了 throw 行为（比如改成 `res.ok=false` 不 throw），脚本会**自然**走 `unwrapGitea(res, ...)` 同步分支，不需要改测试。
