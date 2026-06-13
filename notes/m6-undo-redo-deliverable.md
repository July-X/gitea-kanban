# M6 undo/redo 真栈实现

> **触发**：M5-fix-final-deliverable §6 大件 #1（undo/redo 真栈）
> **时间**：2026-06-13
> **结论**：✅ **PASS**（type-check 0 错 · verify 29/29 · 业务接入 OK）

## 1. 改动文件

| 文件 | 类型 | 行数 | 说明 |
|---|---|---|---|
| `src/main/board/undo.ts` | new | 178 | in-memory undo/redo 栈 + handler 注册表 |
| `src/main/board/move-card.ts` | mod | +33 | 成功时 `pushUndo` + 模块加载即注册 handler |
| `src/main/ipc/user.ts` | mod | -8/+16 | `undo`/`redo` 改调 `undoOne`/`redoOne` |
| `scripts/verify-undoStack.ts` | new | 171 | 7 场景 29 用例验证 |

## 2. 设计

### 2.1 解耦：registry 模式

`undo.ts` **不** import 业务侧（move-card.ts 拉 electron/sqlite，tsx 跑不动）。
改为业务侧在模块加载时调 `registerUndoHandler(op, { forward, reverse })` 注入。
undo.ts 只依赖 `@shared/errors`，可在 Node 上下文单测。

```ts
// undo.ts
const handlers = new Map<UndoOp, OpHandler>();
export function registerUndoHandler(op, handler) { handlers.set(op, handler); }
```

```ts
// move-card.ts 末尾
registerUndoHandler('issues.moveColumn', {
  forward: (args) => moveIssueColumn(args as MoveIssueColumnArgs),
  reverse: (args) => moveIssueColumn(args as MoveIssueColumnArgs),  // 对称
});
```

### 2.2 栈结构

- per-projectId 隔离（`Map<projectId, UndoEntry[]>`）
- 上限 50（FIFO 丢头）
- 双向栈：undo pop → push redo；undo 失败保留 redo
- 新 push 清 redo 栈（行业惯例，branching 时空 redo 无意义）
- **不**入 DB（undo_entries 表保留为未来 crash recovery 留口子；本任务不写避免 §7.1 拍板）

### 2.3 业务接入

`moveIssueColumn` 成功时：

```ts
pushUndo(
  'issues.moveColumn',
  args.projectId,
  args,                                              // forwardArgs
  { ...args, fromColumnId: args.toColumnId, toColumnId: args.fromColumnId },  // reverseArgs（swap）
);
```

`moveIssueColumn` 对称（reverse = swap from/to），所以 forward/reverse 同一函数。

## 3. 验证（`pnpm exec tsx scripts/verify-undoStack.ts`）

```
[verify-undoStack] 29 pass · 0 fail
```

7 场景覆盖：
1. 栈基础（push/pop/空栈） — 4 用例
2. projectId 隔离 — 2 用例
3. 新操作清 redo 栈 — 7 用例（含 dispatch 验证）
4. redo 推进 undo 栈 — 10 用例（含 forward/reverse 实际派发）
5. 容量上限 FIFO 丢头 — 2 用例
6. snapshot — 2 用例
7. dispatch 表未注册 op 走 IpcError(INTERNAL) — 2 用例

## 4. 后续（M6 范围内 / 留 plan）

- [ ] UI 接入：BoardView 监听 Ctrl+Z / Ctrl+Y 调 `user.undo`/`user.redo`
- [ ] UI 灰化按钮：根据 `undoStackSize(projectId)` 灰化
- [ ] 跨 projectId 限制：undo 只撤当前 project（避免跨看板误撤销）

## 5. 末行 VERDICT

**VERDICT: PASS**
