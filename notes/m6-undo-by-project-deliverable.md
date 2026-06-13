# M6 undo/redo 按 projectId 弹栈 + undoStatus 端点

> **触发**：m6-undo-redo-deliverable.md §4 follow-up（#16 + #17）
> **时间**：2026-06-13
> **结论**：✅ **PASS**（type-check 0 · jargon 0 · verify 49/49）

## 1. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/main/board/undo.ts` | mod | undoOne/redoOne 接受 `{ projectId? }`；无 projectId 走安全默认；新增 undoStatus(projectId) |
| `src/main/ipc/schema.ts` | mod | UserUndoArgsSchema (新) / UserUndoStatusArgsSchema (新) / UserUndoResultSchema 扩展为 { restored, op?, undoSize, redoSize } |
| `src/main/ipc/user.ts` | mod | undo/redo 接受 args + 新增 getUndoStatus + 注册 USER_UNDO_STATUS 端点 |
| `src/shared/ipc-channels.ts` | mod | 加 USER_UNDO_STATUS 端点；头注释 44→45；user ×4→×5 |
| `src/preload/index.ts` | mod | 暴露 user.undoStatus；头注释同步 45 |
| `src/renderer/stores/board.ts` | mod | **删**本地 undoStack；改用 main 端栈；新增 undoSize/redoSize ref + loadUndoStatus + canRedo + redoLastMove |
| `src/renderer/views/BoardView.vue` | mod | 加 redo 按钮 + onMounted 拉栈深度 + watch activeProjectId 重拉；CSS 加 .board__redo-btn |
| `scripts/verify-undoStack.ts` | mod | 7→11 场景；35→49 用例（加 8-11：跨 projectId / 安全默认 / undoStatus / 栈深度回传） |

## 2. 关键设计

### 2.1 跨 projectId 不互撤（#17）

`undoOne(args: { projectId })`：
- 传 projectId：只弹该 project 栈
- 不传 / undefined：返 `restored=0`，**不**弹任意栈（安全默认 → 不跨看板误撤销）

`undoOne()`（无参）场景的旧行为（遍历所有 project 栈弹第一条）被删除——避免误操作。

### 2.2 UI 灰化（#16）

`undoStatus(projectId)` → `{ undoSize, redoSize }`：纯读，不改栈
- onMounted：拉一次
- 切 project：重拉
- moveIssue 成功：拉一次
- undo/redo 返回值带 undoSize/redoSize，**免一次 roundtrip**

`undoOne` / `redoOne` 返回值扩展：
```ts
{ restored: 0|1, op?: UndoOp, undoSize: number, redoSize: number }
```

### 2.3 Single source of truth

删渲染端 `undoStack`（board.ts:62 旧 `ref<UndoEntry[]>`）→ 渲染端**零**状态。
- 不再"前端 pushUndo / 后端独立栈"两套
- 任何路径（拖拽 / API 调用 / 未来 bulk op）只走 main 端栈

### 2.4 IPC 端点 44 → 45

新增 `user.undoStatus`（栈深度查询）。`user.undo` / `user.redo` 签名变（加 projectId 字段），IPC 端点总数 45。

## 3. 验证

```
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
(0 error)

$ pnpm check:no-jargon
[check:no-jargon] OK — 未发现禁用术语

$ pnpm exec tsx scripts/verify-undoStack.ts
[verify-undoStack] 49 pass · 0 fail
```

11 场景：栈基础 / projectId 隔离 / 新操作清 redo / redo 推进 / 容量上限 FIFO / snapshot / dispatch 未注册 / **跨 projectId 不互撤** / **无 projectId 走安全默认** / **undoStatus 栈深度** / **栈深度回传**。

## 4. UI 行为

- BoardView topbar：撤销按钮（M5） + **重做按钮**（M6）
- 撤销 / 重做 按钮**仅在对应栈深度 > 0 时显示**（v-if board.canUndo() / board.canRedo()）
- 切换仓库 → 自动重拉栈深度
- 拖拽换列成功 → 自动重拉栈深度
- title 显示可撤销 / 可重做步数

## 5. 已知非-blocker

- 渲染端 IPC 调用仍是 `getIpcClient().invoke('user', 'undo', { projectId })`（无 typed wrapper）—— 可加 `userUndo(args)` 等具名函数到 ipc-client.ts（M7+ 体验优化）
- `undoSize` / `redoSize` 没用 computed（直接 ref 暴露）—— 简单够用

## 6. 末行 VERDICT

**VERDICT: PASS**
