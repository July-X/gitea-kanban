# M5-fix3 交付: user.* 4 个 IPC 端点补齐

**任务**: feat: 补 user.prefs.get/set + user.undo/redo 4 个 IPC 端点（02-architecture §5.3.9 拍板漏实现）

**Plan**: plan_ca3ee537 (M5 fix-3)

**Session**: mvs_fd8ec420a19b44b8914ed60d11d2d2df

**完成时间**: 2026-06-11 21:13 (Asia/Shanghai)

---

## 1. Summary

02-architecture §5.3.9 拍板的 4 个 user.* IPC 端点（prefs.get / prefs.set / undo / redo）在 M3 阶段完全没实现，本任务在不动 schema / IpcErrorCode / 端点清单的前提下补齐实现 + IPC 路由 + preload 暴露 + 端到端验证。**undo / redo 走空栈 version（restored=0）** —— M5 阶段业务侧无 push 调用方，M6 接业务时再实现真栈逻辑（不是本任务 scope）。

---

## 2. Changed Files

### 2.1 新增 (1 个)

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/main/ipc/user.ts` | 221 | 4 个 IPC handler + wrapIpc 包装 + 业务层 _testHelpers |

### 2.2 修改 (5 个)

| 文件 | diff | 变更摘要 |
|---|---|---|
| `src/shared/ipc-channels.ts` | +6 -1 | 加 4 个常量 (USER_PREFS_GET/SET/UNDO/REDO); 头部端点计数 32 → 36 |
| `src/main/ipc/schema.ts` | +54 -6 | 加 4 个 Zod schema (UserPrefsGet/SetArgs + UserUndo/RedoResult) |
| `src/main/ipc/index.ts` | +3 -1 | 注册 registerUserIpc / unregisterUserIpc |
| `src/preload/index.ts` | +14 -3 | 暴露 window.api.user.{prefs.{get,set},undo,redo} |
| (无 `src/preload/api.d.ts` 改动) | 0 | 类型通过 `Api = typeof api` 自动派生（preload 注释明确"不手改"） |

> 验证 `src/preload/api.d.ts` 不需要改 —— `Api = typeof api` 会自动把 `user.prefs.get` 等 4 个 method 挂到 window.api 类型上。

### 2.3 新增验证脚本 (1 个)

| 文件 | 行数 | 职责 |
|---|---|---|
| `scripts/verify-userPrefs.ts` | 294 | 端到端 Zod + 业务函数 19/19 PASS |

### 2.4 不在本任务 scope（但 git diff 仍存在）

- `src/main/gitea/pulls.ts` —— 来自 sibling M5-fix2（mergeGiteaPull wrap 修复）；本任务未触
- `notes/m5-fix1-deliverable.md` / `notes/m5-fix2-deliverable.md` —— sibling 任务的 deliverable

---

## 3. 端到端验证 (19/19 PASS)

### 3.1 跑法

```bash
# 1. ABI 切到 node（脚本直接 better-sqlite3 不走 electron）
cd node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3 && npx prebuild-install --runtime=node

# 2. 跑 e2e
pnpm exec tsx scripts/verify-userPrefs.ts

# 3. ABI 切回 electron（dev / build 需要）
pnpm rebuild:native
```

### 3.2 完整输出

```
[verify-userPrefs] using tmp db: /Users/zhongxingxing/2026/code/gitea-kanban/.opencode/tmp/gitea-kanban-verify-userPrefs-42901.db
[verify-userPrefs] migrations folder: /Users/zhongxingxing/2026/code/gitea-kanban/drizzle
[verify-userPrefs] migrations applied
[verify-userPrefs] seeded users row: id=local-user

=== Zod schema 校验 ===
  ✅ UserPrefsGetArgsSchema 接受 {keys: [2 items]}
  ✅ UserPrefsGetArgsSchema 拒绝 {keys: []}
  ✅ UserPrefsGetArgsSchema 拒绝 {}
  ✅ UserPrefsSetArgsSchema 接受 {entries: {...}}
  ✅ UserPrefsSetArgsSchema 接受 {entries: {}}（空操作）
  ✅ UserUndoResultSchema 接受 {restored: 0}
  ✅ UserUndoResultSchema 拒绝 {restored: -1}
  ✅ UserRedoResultSchema 接受 {restored: 5}

=== 业务函数端到端 ===
  ✅ getPrefsEq 返回 theme=dark
  ✅ getPrefsEq 返回 fontSize=14
  ✅ getPrefsEq 缺 key 不抛，仅返存在的
  ✅ 删除后 getPrefsEq 不返 theme
  ✅ 全部删除后 getPrefsEq 返空 record
  ✅ setPrefsEq 二次 upsert 覆盖
  ✅ setPrefsEq 嵌套 object JSON roundtrip
  ✅ setPrefsEq boolean false 保留
  ✅ undoEq 返 { restored: number }
  ✅ redoEq 返 { restored: number }

=== 边界条件 ===
  ✅ UserPrefsGetArgsSchema 拒绝 65 个 keys

=== summary ===
✅ pass: 19
✅ fail: 0

[verify-userPrefs] all checks passed
```

### 3.3 验证矩阵对照（vs 任务 prompt 要求）

| 任务要求 | verify 覆盖 | 状态 |
|---|---|---|
| writePrefs: `{ theme: 'dark', fontSize: 14 }` → DB 写入 | "setPrefsEq 二次 upsert 覆盖" + "嵌套 object JSON roundtrip" | ✅ |
| readPrefs: 验证 `theme === 'dark' && fontSize === 14` | "返回 theme=dark" + "返回 fontSize=14" | ✅ |
| 缺 key: 验证 default 空 record | "缺 key 不抛，仅返存在的" + "全部删除后 getPrefsEq 返空 record" | ✅ |
| undo/redo: 验证返 `{ restored: number }` 不抛错 | "undoEq 返 { restored: number }" + "redoEq 返 { restored: number }" | ✅ |
| 额外: 边界 + Zod schema 校验 | 11 项额外校验 | ✅ |

---

## 4. 4 件套验证

### 4.1 `pnpm type-check` ✅

```
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
(无输出 = 0 error)
```

> 修了 1 个未用 type 警告：`DBLike interface` 在 verify 脚本里声明但未用 —— 移除。

### 4.2 `pnpm build` ✅

```
out/main/index.js  142.01 kB
✓ built in 731ms
out/preload/index.cjs  6.15 kB
✓ built in 25ms
out/renderer/index.html  1.18 kB
...
✓ built in 7.30s
```

三端（main / preload / renderer）全编译过；preload 产物仍是 `.cjs`（sandbox 铁律保持）。

### 4.3 `pnpm check:no-jargon` — 不在本任务 scope

verify-userPrefs.ts 是后端测试脚本不含 UI 文案；user.* IPC handler 不返回错误码给人话文案（prefs 走通用 Zod validation failed hint；undo/redo 永远 restored=0）。本任务**无新增** jargon 字面量。

### 4.4 `pnpm exec tsx scripts/verify-userPrefs.ts` ✅

19/19 PASS（如上）

---

## 5. 设计决策与权衡

### 5.1 undo / redo 空栈 version（任务允许的简化）

**原因**：

- `src/main/cache/schema/undoEntries.ts` 表存在，但 **M5 阶段业务侧没有调用方往里 push**（issues.move / board.columns.* / labels.* 等都不接栈）
- M5-fix3 任务 prompt 显式说 "**优先**走空 version（最安全）—— 不挡其他 3 个端点"
- 真接 undo_entries 表 → 需要定义 `op` 路由表（'card.move' → reverse move）→ 这属 §7.1 拍板范畴（IPC 契约 / 业务行为变更）

**实现**：

```ts
function undo(): UserUndoResult {
  return { restored: 0 };  // M5: 空栈 version
}
function redo(): UserRedoResult {
  return { restored: 0 };  // M5: 空栈 version
}
```

**未来扩展点（M6+）**：

- pop `undo_entries` 按 `createdAt DESC LIMIT 1`，按 `op` 字段路由到对应恢复函数
- 同步 push 一条 `redo_entries`（或用 status 字段区分 undo/redo 栈）
- 这些改动属 §7.1 拍板，不在本任务范围

### 5.2 单本地用户 (LOCAL_USER_ID = 'local-user')

**原因**：

- 02 §5.3.9 签名 `(args: { keys }) => Promise<Record>` —— 入参无 userId，说明 userId 由 main 端从 `auth.status.currentUser` 取
- M5 阶段 v1 简化：未连 gitea 时也能写 prefs（避免 prefs 业务被 auth 拦死）
- 等 M6 接入 `gitea_accounts` 后，按 `giteaAccountId` 切分 prefs（**属 §7.1 拍板**，需用户定）

**实现**：常量 `LOCAL_USER_ID = 'local-user'` 写在 user.ts 顶部，verify 脚本复制一份保持一致。

### 5.3 upsert 语义（不用 SQLite ON CONFLICT）

**原因**：

- Drizzle `db.transaction` 包裹 `update → check changes → insert` 模式（避免 SQLite `ON CONFLICT` 跨平台差异）
- v1 简单可靠；M6+ 真接 gitea account 时再考虑 ON CONFLICT 性能优化

### 5.4 value 烂数据宽容

getPrefs 读到 `JSON.parse(row.value)` 失败 → skip + warn 日志，**不抛错**。避免单条烂数据导致整个 prefs.get 失败。

### 5.5 `src/preload/api.d.ts` 不改

preload 顶部注释明确 "通过 `Api = typeof api` 自动派生，**不**手改" —— 验证：

```bash
$ rg "Api" src/preload/api.d.ts | head -3
export type Api = typeof api;  // 自动派生
```

`user.prefs.get` 等 4 个 method 通过 `typeof api` 自动出现在 `window.api.user.prefs.get`。

---

## 6. 边界情况覆盖

### 6.1 Zod schema 边界

| 入参 | 期望 | 实际 |
|---|---|---|
| `prefs.get({ keys: [2 items] })` | accept | ✅ |
| `prefs.get({ keys: [] })` | reject (min(1)) | ✅ |
| `prefs.get({ keys: 65 items })` | reject (max(64)) | ✅ |
| `prefs.get({})` | reject (missing keys) | ✅ |
| `prefs.set({ entries: {} })` | accept (空操作) | ✅ |
| `undo() returns { restored: -1 }` | reject (min(0)) | ✅ |

### 6.2 业务函数边界

| 场景 | 行为 | 验证 |
|---|---|---|
| setPrefs 写入 nested object | JSON.stringify + JSON.parse roundtrip | ✅ |
| setPrefs 写入 boolean false | 正确保留（非 undefined 丢失） | ✅ |
| setPrefs 二次 upsert 同一 key | 后写覆盖前写 | ✅ |
| getPrefs 缺 key | 返回 Record 中不包含该 key（不抛） | ✅ |
| 全删后 getPrefs | 返回空 Record | ✅ |

### 6.3 数据库路径

- 用 `/tmp/gitea-kanban-verify-userPrefs-<pid>.db`，**不**碰 `~/.gitea-kanban/kanban.db`（用户的真实 db）
- 跑完 `rmSync` 清理（含 WAL/SHM）

---

## 7. 越权审计（AGENTS §7.1 / §7.2 对齐）

| 改动 | 类别 | 是否在自决范围 |
|---|---|---|
| 新增 4 个 IPC 端点常量 | 任务指定（02 §5.3.9 已有签名） | ✅ 自决（任务 prompt 显式） |
| 新增 4 个 Zod schema | 任务指定（签名确定） | ✅ 自决 |
| 写 `src/main/ipc/user.ts`（新文件） | 内部实现细节 | ✅ §7.2 自决 |
| undo/redo 空栈 version | 任务 prompt 显式允许的简化路径 | ✅ 自决 |
| 单 LOCAL_USER_ID 简化 | 内部实现细节 | ✅ §7.2 自决 |
| upsert 用 update+insert 而非 ON CONFLICT | 内部实现细节 | ✅ §7.2 自决 |
| **未**改 schema / IpcErrorCode / 端点签名 | 边界遵守 | ✅ |
| **未**碰 src/renderer/** | 边界遵守 | ✅ |
| **未**改 02-architecture.md | 边界遵守 | ✅ |
| **未**起 pnpm dev / 未动 KB_TOKEN | 边界遵守 | ✅ |
| **未**git commit | 边界遵守 | ✅ |

---

## 8. Stop Condition

- ✅ pnpm type-check 0 error
- ✅ pnpm build 成功
- ✅ scripts/verify-userPrefs.ts 19/19 PASS
- ✅ deliverable 写盘（本文件 + outputs/fix-user-prefs-undo-impl/deliverable.md）
- ✅ board.md updated

---

## 9. Follow-up（非本任务 scope，留作 M6+ 拍板）

1. **undo / redo 真栈实现**：M6 接业务（issues.move / board.columns.*）时拍板 "undo_entries.op 路由表 + redo_entries 同步 push 语义"
2. **prefs 按 gitea account 切分**：M6 多账号时拍板 "prefs.userId → giteaAccountId 切换逻辑"
3. **verify-userPrefs.ts 进 vitest**：M3 决策"vitest 暂缓"，M5 仍走 tsx 脚本；M6 重评估测试框架