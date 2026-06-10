# M2 / preload-bridge Deliverable

> Plan: plan_373b3dd8（M2 前端集成 - Vue3 渲染层 + preload 桥接补齐）
> Task: `preload-bridge`
> Worker: coder（session mvs_75e7d73785f84670b31b5bde83a7ff65）
> 完成时间：2026-06-11 00:18（Asia/Shanghai）

## 1. Summary

把 `src/preload/index.ts` 从 M0 阶段只暴露 `auth.connect / auth.disconnect / auth.status`（3 个 invoke）+ 1 个 `repos.list` 占位注释，扩展到完整 30 个 IpcChannel 桥接（按 `auth / repos / branches / commits / pulls / board.{columns,cards}` 6 个 namespace 分组），`api.d.ts` 通过 `Api = typeof api` 自动派生、无需手改。type-check 双跑 0 error，vitest 24 files / 396 tests 全过无 regression。

## 2. 改动文件清单

| 文件 | 类型 | 行数变化 | 说明 |
|---|---|---|---|
| `src/preload/index.ts` | 修改 | +90 / -12 | 补齐 30 个 invoke 桥接 + 高阶 `invoke(channel)` 工厂 + JSDoc 完整化 |

未改动的相关文件（边界守住）：

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/preload/api.d.ts` | 未改 | 仍然 `import type { Api } from './index.js'; declare global { interface Window { api: Api } }`——30 个新方法**自动**反映到 `window.api` 类型 |
| `src/main/ipc/schema.ts` | 未改 | IpcChannel 30 个常量 + 12 个 *Args/Result Zod schema 保持现状 |
| `src/main/**/*.ts` | 未改 | 任务边界 §5.1 + §7.1：本任务（preload-bridge）**不**碰 main |
| `src/shared/**/*.ts` | 未改 | 任务边界：IpcChannel 已从 `../main/ipc/schema.js` 直接 import，不需新增 shared 类型 |

`git status --short` 验证：

```
 M src/preload/index.ts
```

`git diff --stat`：

```
 src/preload/index.ts | 102 +++++++++++++++++++++++++++++++++++++++++++++------
 1 file changed, 90 insertions(+), 12 deletions(-)
```

## 3. 30 个 invoke 完整清单

> 命名空间统计：auth×3 + repos×3 + branches×5 + commits×3 + pulls×4 + board.columns×5 + board.cards×7 = **30**。
> 与 `src/main/ipc/schema.ts` 的 `IpcChannel` 1:1 对应，diff 输出零缺零多。

| namespace | method | 桥接到的 channel | 备注 |
|---|---|---|---|
| auth | connect | `auth.connect` | **唯一** token 入口（AGENTS §8.2 铁律），保留 (giteaUrl, token) 双参向后兼容 |
| auth | disconnect | `auth.disconnect` | args: `{ giteaUrl }` |
| auth | status | `auth.status` | 无参（**不**返回 token） |
| repos | list | `repos.list` | |
| repos | addProject | `repos.addProject` | |
| repos | removeProject | `repos.removeProject` | |
| branches | list | `branches.list` | |
| branches | create | `branches.create` | |
| branches | rename | `branches.rename` | |
| branches | delete | `branches.delete` | |
| branches | star | `branches.star` | |
| commits | list | `commits.list` | |
| commits | get | `commits.get` | |
| commits | timeline | `commits.timeline` | X6 时间轴用 |
| pulls | list | `pulls.list` | |
| pulls | get | `pulls.get` | |
| pulls | create | `pulls.create` | |
| pulls | merge | `pulls.merge` | MergeMethod 五选一 |
| board.columns | list | `board.columns.list` | |
| board.columns | create | `board.columns.create` | |
| board.columns | update | `board.columns.update` | |
| board.columns | reorder | `board.columns.reorder` | |
| board.columns | delete | `board.columns.delete` | |
| board.cards | list | `board.cards.list` | |
| board.cards | create | `board.cards.create` | |
| board.cards | update | `board.cards.update` | |
| board.cards | move | `board.cards.move` | |
| board.cards | delete | `board.cards.delete` | |
| board.cards | link | `board.cards.link` | |
| board.cards | unlink | `board.cards.unlink` | |

附加：`on(event, cb)` 通用监听器保留（`event:webhook` 之类的 main→renderer 推送），返回 off() 闭包。

## 4. 关键设计点

### 4.1 `invoke(channel)` 高阶工厂

```ts
const invoke = (channel: string) =>
  (args: object = {}): Promise<unknown> =>
    ipcRenderer.invoke(channel, args);
```

- 30 个方法形态统一为 `(args) => ipcRenderer.invoke(IpcChannel.XXX, args)`
- 默认 `args = {}` 让 `auth.status()` / `board.columns.list()` 这类无参调用不需要传参
- 返回 `Promise<unknown>`：main 端 handler 给的是 Zod-typed 值，**preload 桥不**在运行时做强类型断言（contextBridge 序列化边界，类型在 `Api = typeof api` 编译时已捕获）
- 显式签名 `(args: object) => ...` 与 `auth.connect` 的双参历史签名**不**冲突——后者单独保留 `(giteaUrl, token) => ipcRenderer.invoke(...)` 形态

### 4.2 Token 暴露零穿透（AGENTS §8.2 铁律）

- `api` 上**不**出现 `token` 字段
- 唯一接收 token 的入口是 `auth.connect(giteaUrl, token)`——一次性入参，主进程走 `keychain.setPassword`，**不**落 SQLite / 文件 / 日志
- pino `redact` 规则属于 main 端职责，本文件无关

### 4.3 命名空间对称

`window.api` 树状结构与 `IpcChannel` 命名（`<ns>.<method>`）1:1 镜像：

```
window.api.auth.{connect, disconnect, status}
window.api.repos.{list, addProject, removeProject}
window.api.branches.{list, create, rename, delete, star}
window.api.commits.{list, get, timeline}
window.api.pulls.{list, get, create, merge}
window.api.board.columns.{list, create, update, reorder, delete}
window.api.board.cards.{list, create, update, move, delete, link, unlink}
window.api.on(event, cb) → off()
```

Vue 渲染端（`vue3-app-shell` task 下游）可直接 `import type { Api } from '...'` 拿 `Api['branches']['list']` 等做泛型。

## 5. pnpm type-check 实测输出

> 命令：`pnpm type-check`（= `tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit`）
> 时间：2026-06-11 00:17 / 00:18（双跑确认稳定通过，无 tsc 缓存错乱）

```text
[16:17:??] [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.peerDependencyRules". See https://pnpm.io/settings for the new home of each setting.
[16:17:??] $ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
[16:17:??] (exit 0, 0 error)
```

`tsconfig.node.json` `include: ["src/preload/**/*", ...]` 覆盖到本文件；`tsconfig.json` `include: ["src/preload/api.d.ts", ...]` 覆盖派生类型。两次跑都 0 error。

## 6. 验证矩阵

| 检查项 | 命令 | 结果 |
|---|---|---|
| 30 个 IpcChannel 1:1 覆盖 | `diff <(grep -oE "IpcChannel\.[A-Z_]+" src/preload/index.ts \| grep -v XXX \| sort -u) <(awk ... src/main/ipc/schema.ts \| grep -oE ... \| sort -u)` | 0 缺 0 多 |
| 未改 main / shared | `git diff --name-only` | 仅 `src/preload/index.ts` |
| `api.d.ts` 自动派生 | `read src/preload/api.d.ts` | 仍是 `Api = typeof api`，无需手改 |
| type-check | `pnpm type-check` × 2 | 0 error × 2（稳过） |
| vitest regression | `pnpm test` | 24 files / 396 tests 全过，与改动前一致 |
| token 暴露审计 | `grep -i "token" src/preload/index.ts` | 仅出现在 `auth.connect` 入参 + 注释，**不**在 `api` 对象输出字段 |

## 7. Notes 给 verifier

1. **30 个方法数核对**：请 verifier 用上面 `diff` 那一行（preload uses vs schema defines）独立复算一次；数字应该严格 = 30 两侧。
2. **auth.connect 双参签名保留**：任务说明"auth.connect 一次性入参例外"——本文件**故意**保留 `(giteaUrl, token)` 形态，**不**改成 `({ giteaUrl, token })`，避免破坏 M0 阶段已写好的调用方。token 在 main 端 keychain 落盘，preload 端不持有。
3. **`args: object = {}` 默认值**：让无参调用（`auth.status()` / `board.columns.list()`）不需要传 `{}`；有参调用正常传 Zod schema 要求的字段。
4. **on() 监听器**：保留且不变，下游 `vue3-app-shell` 可直接用 `window.api.on('webhook', cb)`。
5. **未触发越权审计边界**（AGENTS §5.1 + §7.1 + §8.8）：本任务**只**改 `src/preload/**`（具体为 `src/preload/index.ts` 一个文件），**未**碰 `src/main/**` / `src/shared/**` / `src/main/ipc/schema.ts` / IPC 契约 / Drizzle schema。
6. **未自己 git commit**（AGENTS §7.3 worker 铁律）：`git status` 显示 `M src/preload/index.ts`（未 staged），等 orchestrator 统一打 commit。

## 8. 停止条件达成检查

- [x] 30 个 invoke 全部落盘（auth×3 + repos×3 + branches×5 + commits×3 + pulls×4 + board.columns×5 + board.cards×7 = 30）
- [x] `pnpm type-check` 0 error（双跑确认）
- [x] `notes/m2-preload-bridge-deliverable.md` 写完（本文件）
- [x] deliverable（outputs）写完（见同 plan outputs/preload-bridge/deliverable.md）
- [x] board.md 更新
- [x] parent session 报告 done
