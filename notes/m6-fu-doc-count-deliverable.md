# M6 FU1: ipc-channels.ts / preload 头注释 39→44 对齐

> **触发**：M5-fix-final-deliverable §6 FU1
> **时间**：2026-06-13
> **结论**：✅ **PASS**

## 1. 改动

### 1.1 src/shared/ipc-channels.ts
- line 18：`端点清单（theme-ipc 拍板，39 个）` → `端点清单（M6 拍板，44 个）`
- line 30：preferences ×2 → preferences ×3（追加 clipboard.write）
- line 38：历史端点计数更新
- 顶部"历史"块加 2026-06-13 一条

### 1.2 src/preload/index.ts
- line 11/18/58：39 → 44
- line 53-58：preferences ×2 → preferences ×3

## 2. 实际端点核对

```
$ grep -cE "^\s+[A-Z_]+:\s*'" src/shared/ipc-channels.ts
44
```

| namespace | 数 | 端点 |
|---|---|---|
| auth | 3 | connect / disconnect / status |
| repos | 3 | list / addProject / removeProject |
| branches | 5 | list / create / rename / delete / star |
| commits | 3 | list / get / timeline |
| pulls | 4 | list / get / create / merge |
| board.columns | 7 | list / create / update / reorder / delete / mapLabel / unmapLabel |
| issues | 7 | list / get / create / update / addLabel / removeLabel / moveColumn |
| issues.comment | 2 | list / create |
| labels | 2 | list / create |
| members | 1 | list |
| user | 4 | prefs.get / prefs.set / undo / redo |
| preferences | 3 | theme.get / theme.set / clipboard.write |
| **合计** | **44** | |

## 3. 验证

```
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
（EXIT 0）

$ grep -n "39 个" src/shared/ipc-channels.ts src/preload/index.ts
（0 命中）

$ grep -n "44" src/shared/ipc-channels.ts src/preload/index.ts
src/preload/index.ts:11: * - src/main/ipc/schema.ts 注册 44 个 IpcChannel...
src/preload/index.ts:18: * - 本文件暴露完整44 个 invoke + on()监听器
src/preload/index.ts:58: *合计:44 个 invoke
src/shared/ipc-channels.ts:19: * 端点清单（M6 拍板，44 个）：
src/shared/ipc-channels.ts:39: * 历史端点计数：M3=32 → M5 fix-3=36 → ... → clipboard=44
（5 处命中）
```

## 4. 末行 VERDICT

**VERDICT: PASS**
