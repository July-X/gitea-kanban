# M6 FU3: httpErrorToIpcError 加 405 case

> **触发**：M5-fix-final-deliverable §6 FU3
> **时间**：2026-06-13
> **结论**：✅ **PASS**

## 1. 改动

`src/main/gitea/client.ts:108-119`（在 case 409 之前新增 case 405）

```ts
case 405:
  // gitea "Method Not Allowed" 常表示资源状态不允许该操作
  // （如对已合并/已关闭的合并请求再调 merge）→ 走 CONFLICT
  // 参考 src/main/gitea/pulls.ts:19-22, 168-171, 220 文档说明
  return new IpcError({
    code: IpcErrorCode.CONFLICT,
    message: '操作冲突：资源状态不允许该操作（如合并请求已合并或已关闭）',
    hint: '请刷新后查看最新状态',
    cause,
    httpStatus: 405,
  });
case 409:
  return new IpcError({
    code: IpcErrorCode.CONFLICT,
    ...
  });
```

## 2. 验证

### 2.1 静态校验

```
$ pnpm type-check
（EXIT 0）

$ git diff src/main/gitea/client.ts
（仅 +12 行新增，0 行删除）
```

### 2.2 运行时：mock gitea 405 走通

`scripts/verify-405Case.ts`（新增）跑通：

```
$ pnpm exec tsx scripts/verify-405Case.ts
--- 静态校验 ---
  ✅ client.ts 含 case 405:
  ✅ case 405 走 IpcErrorCode.CONFLICT
  ✅ case 405 含 message
  ✅ case 405 含 httpStatus: 405
  ✅ case 409 保留:
  ✅ case 405 顺序在 case 409 之前
--- 运行时：mock gitea 405 走通 httpErrorToIpcError ---
  ✅ gitea-js 收到 405 响应（httpErr 非空）
  ✅ httpErr.status === 405
  ✅ 405 → IpcErrorCode.CONFLICT
  ✅ 405 → httpStatus: 405
  ✅ 405 → message 含 "状态不允许"

[verify-405Case] 11 pass · 0 fail
  (mock server 收到 1 个请求)
```

## 3. 修复后行为对照

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 对已合并 PR 再调 merge | gitea 返 405 → httpErrorToIpcError 走 default → IpcError(GITEA_ERROR) | gitea 返 405 → httpErrorToIpcError 走 case 405 → IpcError(CONFLICT) |
| 用户看到 | "Gitea 错误：pull request is closed" | "操作冲突：资源状态不允许该操作"（更精准） |

## 4. 末行 VERDICT

**VERDICT: PASS**
