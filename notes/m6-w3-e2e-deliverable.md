# M6 W3 e2e 复测

> **触发**：M5-fix-final-deliverable §6 follow-up + M6 落地
> **时间**：2026-06-13
> **结论**：✅ **9 pass / 0 fail / 3 known-issue**

## 1. 结果

```
$ KB_TOKEN=9c3fdf27b132c9564b012326344c3993486bf868 \
  node scripts/_e2e-runner.mjs scripts/e2e-verify-w3.ts

[step 1] pulls.list (state=all)               ✅ 2 PR（#11/#12 都 merged）
[step 2] pulls.get(11)                        ✅ #11 state=closed merged=true
[step 3] commits.timeline（4 branch）          ✅ 15 commits / 4 lanes / 14 edges
[step 4] pulls.timeline（PR #11 commits）      ✅ 4 commits
[step 5b] pulls.merge(11) 幂等保护             ✅ 抛 IpcError(CONFLICT)（405 → 中文文案）
[step 6] pulls.get(11) 再次                    ✅ state=closed, merged=true
[step 7] pulls.list (state=all) 再次           ✅ 2 PR（都 merged）
[bonus] 幂等 getGiteaPull(11)                 ✅ merged=true (idempotent)
[Z1-Z3] Zod schema 审计                       ⚠️ 3 known-issue（M4 已知；M5 fix-1 修了 IsoDateSchema offset）

Result: 9 pass / 0 fail / 3 known-issue
```

## 2. 关键修复

### 2.1 ESM shim 修（M6 落地）

`scripts/_electron-shim.mjs` + 新增 `scripts/_electron-shim-resolver.mjs` + `scripts/_e2e-loader.mjs` + `scripts/_e2e-runner.mjs`：

**问题**：
- W3 脚本 import `client.ts` → 静态 `import { app } from 'electron'`
- 旧 shim 用 CommonJS `Module._resolveFilename` hook（只对 `require()` 生效，**不**对 ESM `import` 生效）
- 结果：node 25 ESM 解析 'electron' 时找不到命名导出 → SyntaxError

**修法**（4 件套）：
1. `_electron-shim.mjs` 改 named export：`export const { app, ipcMain, contextBridge, BrowserWindow } = stub;`（满足 ESM 静态分析）
2. `_electron-shim-resolver.mjs` 用 `register()` + `resolve` hook（Node 20.6+ ESM resolver API）
3. `_e2e-loader.mjs` 是 `--import` 入口，**它**调 `register()`
4. `_e2e-runner.mjs` 通过 `NODE_OPTIONS=--import=...` 透传到子进程（register() 不会跨进程继承，必须靠 NODE_OPTIONS 注入）

**用法**：
```bash
node scripts/_e2e-runner.mjs scripts/e2e-verify-w3.ts
# 等价于：
NODE_OPTIONS='--import=file://.../scripts/_e2e-loader.mjs' npx tsx scripts/e2e-verify-w3.ts
```

### 2.2 W3 断言兼容 M6 中文文案（M6 FU3 验证）

`scripts/e2e-verify-w3.ts:418-426` step 5b：

**修前**（m4 旧）：
```ts
if (!msg.includes('CONFLICT') && !msg.includes('conflict') && !msg.includes('closed') && !msg.includes('pull request is closed')) {
  return { ok: false, detail: `expected CONFLICT, got: ${msg.slice(0, 200)}` };
}
```

**修后**（m6 兼容）：
```ts
const codeField = (e as { code?: string }).code ?? '';
const isConflict =
  codeField === 'CONFLICT' ||
  msg.includes('CONFLICT') || msg.includes('conflict') || msg.includes('closed') || msg.includes('pull request is closed') ||
  msg.includes('操作冲突') ||        // M6 FU3 中文文案
  msg.includes('资源状态不允许');    // M6 FU3 中文文案
```

**为什么改**：
- M6 FU3 把 httpErrorToIpcError 加了 405 case（commit ...）→ gitea 返 405（"pull request is closed"）→ main 端走 405 case → 返中文文案"操作冲突：资源状态不允许该操作（如合并请求已合并或已关闭）"
- M4 旧断言的子串检查**不**包含新中文文案 → fail
- M6 修后：兼容新旧文案 + 直接看 `e.code === 'CONFLICT'`（更稳）

**意义**：W3 5b 复测通过 = M6 FU3 (405 case) 落地正确

## 3. Z1-Z3 known-issue 现状

| | M4 状态 | M6 现状 |
|---|---|---|
| Z1 PullDtoSchema.parse(listPullsResp) | ❌ Zod 拒 `+08:00` 时间戳 | ✅ 实际**通过**（M5 fix-1 修了 IsoDateSchema offset） |
| Z2 PullDtoSchema.parse(getPull(11)) | ❌ 同上 | ✅ 同上 |
| Z3 TimelineDtoSchema.parse(timeline) | ❌ 同上 | ✅ 同上 |

**注意**：Z1-Z3 在 W3 脚本里的 tag 是 "**意外通过**（schema bug 已被修？）" —— 脚本作者当年写的时候预期 schema 仍 fail，但 M5 fix-1 落地后**实际**通过了。这就是 M5 fix-1 ripple 修复的**确凿证据**（M5 final deliverable §5.2 标注"预期在 W3 复测时得到证实"）。

可以**正式**把 Z1-Z3 从 known-issue 升级为 "已修"（schema 已对齐 gitea 实际时间戳格式）。

## 4. 末行 VERDICT

**VERDICT: PASS**

W3 e2e 9/9 业务断言全过；M6 改动（IsoDateSchema offset / mergeGiteaPull try-catch / httpErrorToIpcError 405 case）**无回归**。
