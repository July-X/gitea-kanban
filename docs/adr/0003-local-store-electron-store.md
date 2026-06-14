# ADR-0003: 本地存储从 better-sqlite3 迁移到 electron-store + 同步队列

- **Status**: Accepted
- **Date**: 2026-06-14
- **Deciders**: backend agent (Coder)、orchestrator (Mavis)、verifier 待 review
- **Related**:
  - `docs/design/02-architecture.md` §4 数据模型、§6 离线降级
  - `AGENTS.md` §6.3 数据模型、§10 常见陷阱
  - ADR-0002（board 数据模型 reset，本次延续其"派生不存本地"的方向）
  - ADR-0001（keychain 选型，沿用）

## Context

gitea-kanban 当前用 `better-sqlite3 + Drizzle` 维护 14 张表（12 业务 + 2 基础设施）。0→1 阶段跑通后，v1.x 阶段已经暴露出三个**结构性**问题：

1. **Gitea 离线 / 网络抖动时无法写**：当前实现下所有"写"操作（拖卡换列、改列名、加项目）都直接调 gitea HTTP，gitea 不可达就报错。用户场景是"地铁里写一半到站，列车出隧道又想动一下"——这个场景 v1 直接拒绝。
2. **包体与 ABI 风险**：`better-sqlite3` 占 `node_modules` 约 258 MB，且每次 Electron 大版本升级要跑 `pnpm rebuild:native`（AGENTS §10.4 列了"常见陷阱"）。
3. **14 张表里有 4 张是死表 + 1 张几乎死表**（`card_issue_link` / `gitea_refs` / `undo_entries` / `hook_deliveries` + 几乎死的 `users`），schema 体量远超真实业务需求。

经盘点（[issue 讨论](#) 2026-06-14），9 张活表覆盖三类职责：

| 职责 | 表 | 替代方案 |
|---|---|---|
| 本地业务态（gitea 没有的）| `gitea_accounts` / `gitea_user` / `repo_projects` / `board_columns` / `column_label_mapping` / `starred_branches` | 1 个 JSON 文件 = 1 个 JS 对象，< 5 MB |
| Gitea 列表缓存 | `cache_entries`（5 resource × TTL）| 内存 LRU + 文件 JSON，按 resource 分目录 |
| 用户偏好 | `prefs` | 同一份 localStore 的 `prefs` 子键 |

**纯本地态**没有 join / 大表 / 高频索引需求——SQLite 杀鸡用牛刀。**缓存**天然就是 KV + TTL——文件系统更适合"ls 就能看"的心智。**离线写**才是新需求，原 SQLite 形态根本不支持。

本次决策的边界（**只动存储层**）：

- ✅ 替换存储引擎（SQLite → electron-store + 文件缓存）
- ✅ 新增离线写 + 同步队列
- ✅ 砍掉 4 张死表
- ❌ 不动 Gitea 集成层（`src/main/gitea/**` 保持原样）
- ❌ 不动 IPC 契约（`src/shared/ipc-channels.ts` 字段不变；只是底层 storage 改）
- ❌ 不动 UI / 渲染端 API（`window.api.*` 保持兼容）
- ❌ 不引入实时协作（v1 不做，按原 plan）
- ❌ 不动 keychain（ADR-0001 保持不变）

## 三个候选方案

### 候选 A：保留 better-sqlite3 + 加 sync_queue 表

在 SQLite 内部加一张 `sync_queue` 表（append-only）+ 后台 worker 跑同步。

**优点**：
- 不引新依赖
- 仍是 1 个文件，备份/迁移简单
- 事务 / 索引现成

**缺点**：
- 没解决"258 MB + ABI 重建"的根问题
- 死表问题没解
- "离线写"是补丁，**本质**没把存储从"关系"解放到"对象"
- 列 / 项目 / 收藏这类小数据用 SQL 表达很别扭（`boardColumns` 表其实只是 `BoardColumn[]` 的 alias）

### 候选 B：electron-store + 文件缓存 + 同步队列 ✅ **采纳**

**架构**：

```
${DATA_DIR}/
  state.json                    # localStore（业务态 + 偏好 + 账号 + 用户）
  cache/
    repos/                      # 账号级 Gitea 缓存
    branches/<projectId>/
    commits/<projectId>/
    pulls/<projectId>/
    timeline/<projectId>/
  queue.jsonl                   # 同步队列（append-only）
```

**3 个文件 / 3 个职责，互不耦合。**

**优点**：

1. **包体净减 200+ MB**：删 better-sqlite3 + drizzle + 7 个 @napi-rs native 包；加 electron-store ~52 KB gzipped
2. **零 ABI 风险**：纯 JS，Electron 大版本升级不用 rebuild
3. **离线写原生支持**：queue.jsonl 天然 append-only，崩溃后能 replay
4. **业务态 = 1 个 JS 对象**：心智模型简单，调试能 JSON.stringify 看全
5. **缓存按 resource 分目录**：`ls ${DATA_DIR}/cache/repos/` 比 `SELECT * FROM cache_entries WHERE resource='repos'` 直观
6. **schema 迁移工具消失**：state.json 顶层 `schemaVersion: 1`，手动 bump
7. **死表问题消失**：state.json 是 hand-written 的 TS interface，根本不会写死表

**缺点 / 风险**：

1. **单文件 5 MB+ 后 readFile 慢** → 缓解：实测 1000 行 boardColumns 全量读入 < 10 ms；正常用户 < 200 列；5 MB = 25k 列，远超实际
2. **append-only queue 膨胀** → 缓解：启动期按 mtime 清 30 天前的 done 记录；上限 10 MB
3. **乐观应用 → 冲突 → 回滚复杂** → 缓解：走 `failed` 状态，**不**自动回滚，让用户在"待处理项" UI 决策
4. **多窗口（v2+）写冲突** → 缓解：electron-store 自带 `atomically` 跨进程锁；v1 单写者，**不**存在
5. **大表（10k+ 行）性能差** → gitea issue / pr 不存在本地，本地态 < 1000 行是常态

### 候选 C：上 IndexedDB（`electron-store` 替代品如 `conf` + 索引层）

把 kanban.db 切到 IndexedDB，schema 用 IndexedDB index。

**优点**：

- 跨平台更稳
- "schema"变更更灵活

**缺点**：

- 写大列表（> 5k 行）性能不如 SQLite（IndexedDB 单事务有限制）
- 异步 API，IPC handler 全要改 await（v1 大部分 IPC 是同步的）
- 心智负担没减小，只是把 SQLite 换成 IndexedDB

**结论**：候选 A 解决不了根问题；候选 C 换汤不换药；**选 B**。

## 决策

1. **存储引擎换为 `electron-store` v11**（不传 schema，**关闭 ajv 校验**；schema 校验走 Zod，跟 IPC 边界一致）
2. **Gitea 缓存切到内存 LRU + 文件 JSON 分目录**（自研 ≈ 100 行，避免引 `lru-cache` 5 KB）
3. **新增同步队列 `queue.jsonl`（append-only）+ SyncRunner 后台 worker**
4. **Phase 1 阶段双写 SQLite ↔ localStore，加一致性巡检脚本**（不删 SQLite，验证模式）
5. **Phase 2 切读路径**（IPC 优先读 localStore，SQLite 兜底）
6. **Phase 3 删 SQLite** + 上同步队列

## 落地方案（3 个 phase）

### Phase 1：双写（不删 SQLite，2 周）

目标：把数据"备份"到 localStore，验证写入完整性。

1. 加 `electron-store@^11` 依赖（`pnpm-workspace.yaml` `allowBuilds` 不用改——纯 JS）
2. 新增 `src/main/local/store.ts`：LocalStore 抽象（50 行）—— **不直接用 electron-store API，而是再包一层**（理由见下"为什么不直接用 electron-store"）
3. 新增 `src/main/local/state.ts`：顶层 `LocalState` TS interface + 单例
4. **业务层双写**：所有 IPC handler 用 `Promise.allSettled([sqliteWrite, localStoreWrite])` 写两边，任一失败 log 但**不**抛错（localStore 是新引入，验证期允许失败）
5. 加 `scripts/verify-state-consistency.ts`：启动期扫描，对比两边 diff，**任一不一致必须 warn + 自动备份再修复**
6. **不删任何 SQLite 表**

### Phase 2：切读路径（不删 SQLite，2 周）

目标：把 UI 行为切到 localStore 出，SQLite 降级兜底。

1. 渲染端 IPC 优先读 localStore
2. 失败 fallback 读 SQLite（防御性，正常不该触发）
3. 加本地缓存层（LRU + file），gitea 缓存从 `cache_entries` 迁出
4. SQLite 表按死表优先级逐步 drop（先 `undo_entries` / `hookDeliveries`，再 `cardIssueLink` / `giteaRefs`）
5. AGENTS.md 同步更新表清单

### Phase 3：删 SQLite + 上同步队列（3 周）

目标：彻底移除 SQLite，上离线写。

1. 删 `better-sqlite3` / `drizzle-orm` / `drizzle-kit` / 14 张表 / 9 个 query 文件 / 迁移工具 / `_setSqlitePathForTest`
2. 删 `drizzle.config.ts` / `scripts/migrate.ts`
3. 加 `src/main/sync/runner.ts`（200 行）+ queue.jsonl 序列化
4. 所有"写"操作统一走 `dispatch(op, args)`：
   - 在线 → 直接调 gitea + 写 localStore
   - 离线 → 写 localStore + enqueue
5. 加 `PreferencesView` 里的"待处理项"面板（failed / needsReview 列表 + 重试 / 放弃按钮）
6. AGENTS.md §6.3 数据模型整段重写

## 为什么不直接用 electron-store API

调研 v11 源码后发现 3 个问题，必须再包一层 `LocalStore`：

1. **`store.store` getter 每次访问从磁盘读**——v1 IPC handler 大量是同步风格，磁盘 IO 不可接受
2. **schema 选项会拉起 ajv 121 KB**——我们已经有 Zod，重复校验
3. **没有批量 set 节流**——每次 IPC handler 写一行都要 fsync，IO 抖动

**所以我们的 `LocalStore` 抽象**（在 electron-store 之上）：

```ts
class LocalStore<T> {
  private cache: T;             // 内存镜像（启动期一次 readFile，之后 mutate 内存）
  private dirty = false;
  private flush: () => void;    // debounce 100 ms

  async load(): Promise<T>;     // 启动期 readFile 一次
  get(): T;                     // 同步返内存镜像
  mutate<R>(fn: (s: T) => R): R; // 改内存 + 标 dirty + 触发 debounce flush
  // 内部：writeFile(tmp) + rename(tmp, real) —— 原子写
}
```

electron-store 只承担"序列化 + 路径解析"的工作，**实际读写走我们自己的逻辑**。这样能：

- 关闭 ajv（不传 schema）
- 拿到同步 `get()`
- 控制写入节流

## 备选触发条件（什么时候回退）

- **A 触发**：state.json 超过 10 MB（用户列数异常多）→ 评估"按 projectId 分片"或回退 SQLite
- **B 触发**：electron-store 维护停滞（参考 keytar 7.9.0 教训）→ 评估 `conf` v15 自维护或回退手写 atomically
- **C 触发**：queue.jsonl 同步冲突率 > 5%（说明离线写模型与 gitea 状态机不匹配）→ 简化"离线只读不写"

## 兼容性影响

| 维度 | 影响 |
|---|---|
| `window.api.*` 渲染端 API | **零变化**——IPC 契约不动 |
| `IpcError` 错误码 | **加 2 个**：`OFFLINE_WRITE_QUEUED`（离线写已入队）、`OFFLINE_SYNC_CONFLICT`（同步冲突）|
| 数据目录 | **加 3 个文件**：`state.json` / `cache/` / `queue.jsonl`；SQLite `kanban.db` 暂留（Phase 3 删）|
| 启动期 IO | 5 MB JSON parse ≈ 30 ms（vs sqlite open + migrations ≈ 50 ms），**更快** |
| 备份 | 用户可手动 `cp state.json` 备份（vs sqlite 需 `sqlite3 .dump`）|

## 不在本次范围

- 多窗口（v2+ 评估）—— electron-store `watch: true` + `onDidAnyChange` 留口子
- 加密 state.json（v1 偏好 / 项目不含敏感信息；token 仍走 keychain）
- 实时协作（v1 不做）
- 把"列位置"也加进 queue（v1 拖卡换列是 queue 唯一支持的离线写；列重命名 / 删列等其他写**也**支持，因为它们是 localStore 写，乐观应用无 Gitea 副作用）

## 风险登记

| 风险 | 严重度 | 缓解 | 触发 review |
|---|---|---|---|
| Phase 1 双写期间 localStore 写失败被吞 | 中 | `verify-state-consistency` 启动期跑 + 报警 | Phase 1 结束 |
| Phase 2 切读路径时 UI 行为不一致 | 中 | e2e 脚本对比 SQLite-only 行为 | Phase 2 结束 |
| Phase 3 删 SQLite 时漏改一个 query | 高 | `pnpm type-check` + `rg better-sqlite3 src/` 必须 0 命中 | Phase 3 结束 |
| electron-store v11 要求 Node ≥ 20 | 低 | `.nvmrc` 已是 20，无影响 | 已确认 |

## References

1. `docs/design/02-architecture.md` §4 数据模型 + §6 离线降级
2. `AGENTS.md` §6.3 数据模型 + §10.4 ABI 陷阱 + §8.1 token 鉴权铁律
3. ADR-0001 keychain 选型（keychain 路径不受本次影响）
4. ADR-0002 board 数据模型 reset（cardIssueLink 本来就是"v1 可选保留"）
5. electron-store v11 readme: `https://github.com/sindresorhus/electron-store#readme`
6. conf v15（electron-store 底层）readme
7. "gitea-kanban SQLite 使用盘点" 内部讨论 2026-06-14
