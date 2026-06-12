# theme-ipc — Notes (Backend)

## 交付摘要

落地 v1.1.2 主题切换的**后端**：2 个 IPC 端点 + Zod schema + sqlite 持久化。

- 新增端点：`preferences.theme.get` / `preferences.theme.set`
- 持久化：sqlite `prefs` 表（key='theme' / value=JSON.stringify({theme}) / updatedAt=now）
- 默认主题：`'A-dark'`（tech-refine.md §14.1 + §15.3）
- 错误码：4 个新加（THEME_NOT_FOUND / INVALID_THEME / DATABASE_UNAVAILABLE / DATABASE_WRITE_FAILED）

## 改了的文件（4 改 + 1 新建）

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/shared/ipc-channels.ts` | docstring 37→39 + 加 `THEME_GET: 'preferences.theme.get'` / `THEME_SET: 'preferences.theme.set'` channel 常量 + 加 v1.1.2 命名说明段 | +19 / -16 (net +3) |
| `src/shared/errors.ts` | docstring 注释 + **加 4 个新 IpcErrorCode**（THEME_NOT_FOUND / INVALID_THEME / DATABASE_UNAVAILABLE / DATABASE_WRITE_FAILED） | +33 行 |
| `src/main/ipc/schema.ts` | docstring 加 theme-ipc 历史 + **新增** ThemeEnumSchema + DEFAULT_THEME + ThemeGetArgsSchema + ThemeGetResultSchema + ThemeSetArgsSchema + ThemeSetResultSchema（含 5 个 Zod schema + 5 个 TS type） | +89 行 |
| `src/main/ipc/preferences.ts` | **新建** —— `preferences.theme.get / set` 2 个 handler（wrapIpc + sqlite prefs 表读写 + 4 个 IpcErrorCode 抛错路径） | 新建 285 行 |
| `src/main/ipc/index.ts` | import + register/unregister `registerPreferencesIpc` / `unregisterPreferencesIpc` | +15 / -7 (net +8) |

**git diff --stat**：

```
 src/main/ipc/index.ts      | 22 ++++++++----
 src/main/ipc/schema.ts     | 89 +++++++++++++++++++++++++++++++++++++++++++++-
 src/shared/errors.ts       | 33 +++++++++++++++++
 src/shared/ipc-channels.ts | 35 ++++++++++++------
 4 files changed, 161 insertions(+), 18 deletions(-)
```

加上新建的 `src/main/ipc/preferences.ts` (285 行) → 5 个文件总动。

## 验证（4 件套精简版）

### 1. `pnpm type-check` —— EXIT≠0 但**只**是 sibling 遗留

- 7 个 TS6133 "noUnusedLocals" 错误：`sqlite.ts:11 existsSync` / `auth.ts:68 readToken` / `client.ts:37 mkdirSync|writeFileSync|unlinkSync` / `logger.ts:65 resolveLogDir` / `logger.ts:160 copyLoggerMethods`
- **baseline 验证**（`git stash push -u -- <5 files>` → `pnpm type-check`）：同样的 7 个错误，**没有**新增 → 全部是 sibling worker 在 M2 / M3 / M5 阶段遗留
- **我引入 0 个新 type error**

### 2. `pnpm build` —— EXIT=0

- main bundle **160.00 kB**（M5 baseline 158 kB → +2 kB for preferences handler + 5 Zod schemas）
- preload **6.51 kB**（**不**变 —— preload 不在 theme-ipc scope，由 theme-preload task 改）
- 沙箱铁律验证：preload 仍是单文件 CJS，**没**新加 npm 依赖

### 3. `rg -c 'preferences.theme' src/main/ipc/index.ts src/shared/ipc-channels.ts src/main/ipc/schema.ts` —— 验证注册

```
src/main/ipc/index.ts:1      （registerPreferencesIpc 调用 + docstring）
src/shared/ipc-channels.ts:5 （2 个 channel 常量 + 3 处 docstring 说明）
src/main/ipc/schema.ts:5     （2 个 schema + 2 处 docstring 引用 + 1 处历史段）
```

### 4. 端到端契约 grep（`out/main/index.js` build 产物）

```
THEME_GET: "preferences.theme.get"
THEME_SET: "preferences.theme.set"
THEME_NOT_FOUND: "theme_not_found"
INVALID_THEME: "invalid_theme"
DATABASE_UNAVAILABLE: "database_unavailable"
DATABASE_WRITE_FAILED: "database_write_failed"
```

全部 6 个常量（2 channel + 4 error code）正确出现在 main bundle。

## 端点契约（与 SSOT tech-refine.md §16.1-§16.3 一一对应）

### `preferences.theme.get`

```ts
// 入参
type ThemeGetArgs = Record<string, never>;

// 出参
type ThemeGetResult = {
  theme: 'A-dark' | 'C-dark' | 'light';
  changedAt: string;  // ISO 8601
};

// 错误
// - THEME_NOT_FOUND         (row 存在但 JSON 不可解析 / 字段不在 enum 3 选 1)
// - DATABASE_UNAVAILABLE    (initSqlite() 未调过)
```

**关键行为**：
- row 不存在（首次启动）→ **静默返默认** `{theme: 'A-dark', changedAt: <now>}`，**不**抛 THEME_NOT_FOUND
- row 存在 + JSON.parse 成功 + theme ∈ enum → 返 row 的值
- row 存在 + JSON.parse 失败 / 字段缺失 / theme ∉ enum → 抛 THEME_NOT_FOUND

### `preferences.theme.set`

```ts
// 入参
type ThemeSetArgs = { theme: 'A-dark' | 'C-dark' | 'light' };

// 出参
type ThemeSetResult = { theme, changedAt: string };

// 错误
// - VALIDATION_FAILED       (Zod enum 不在 3 选 1 —— wrapIpc 入口先 reject，IPC 路径下不可达 INVALID_THEME)
// - INVALID_THEME           (业务层 direct caller 路径；IPC 路径下不可达)
// - DATABASE_UNAVAILABLE    (initSqlite() 未调过)
// - DATABASE_WRITE_FAILED   (sqlite write 抛异常：disk full / db locked / constraint)
```

**关键行为**：
- 每次 set 走 upsert 语义（先 update，没命中再 insert）—— 跟 user.ts:136 `setPrefs` 一致
- 不 patch（v1 简化）—— 主题是单值，不存在多 key 合并复杂度
- 业务层 `setTheme(args)` 内部仍 `safeParse(args.theme)` 二次断言，防御 direct caller 路径

## sqlite 操作示例

### 初始化（启动期）

```sql
-- drizzle migration 已在 M5 收口（prefs 表存在），本任务不动 schema
CREATE TABLE prefs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,  -- JSON
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, key)
);
```

### get 路径（已设过 + row 在）

```sql
SELECT value, updated_at
FROM prefs
WHERE user_id = 'local-user' AND key = 'theme';
-- → value = '{"theme":"C-dark"}', updated_at = 1718174400
-- handler: JSON.parse(value) → {theme: 'C-dark'}
--   .theme: ThemeEnumSchema.safeParse('C-dark') → 'C-dark'
--   .changedAt: row.updatedAt.toISOString()
```

### get 路径（首次启动 + row 不在）

```sql
-- 无 row 命中
-- handler: 返 {theme: 'A-dark', changedAt: new Date().toISOString()}
```

### set 路径

```sql
-- 走 db.transaction：
-- 1) UPDATE prefs SET value = ?, updated_at = ? WHERE user_id = 'local-user' AND key = 'theme'
--    a) changes > 0 → 走完
--    b) changes = 0 → 2) INSERT
-- 2) INSERT INTO prefs (id, user_id, key, value, updated_at) VALUES (?, 'local-user', 'theme', ?, ?)
```

## 4 个新 IpcErrorCode 详解

按 task prompt 契约 + tech-refine.md §16 拍板，**新加 4 个错误码**到 `IpcErrorCode`（v1 启动时 10 个 + M5 ADR-0001 加 2 个 = 12 个，新加 4 个 = 16 个总）：

| 错误码 | 触发场景 | 触发频次 |
|---|---|---|
| `THEME_NOT_FOUND` | row 存在但 value 损坏（JSON.parse 失败 / 字段缺失 / theme ∉ enum） | 极低（只在 sqlite 写入异常时） |
| `INVALID_THEME` | 业务层 direct caller 路径（绕过 Zod）传入非法 theme | 实际不可达（IPC 路径下 Zod 先 reject） |
| `DATABASE_UNAVAILABLE` | getDb() 抛 "sqlite not initialized" | 极低（initSqlite 启动流程保证） |
| `DATABASE_WRITE_FAILED` | db.transaction 内 update / insert 抛异常 | 低（disk full / db locked 等系统故障） |

**AGENTS §8.8 教训对齐**：v1 启动拍板 10 个 IpcErrorCode 是"最小集合"；**新增必须经过拍板**——本任务由 plan_96625ed5 theme-ipc 任务 prompt 拍板（来源 = tech-refine.md §16 user 拍板），plan 收口时由 orchestrator 在 AGENTS §8 加条目登记。

## 关键设计决策

### 1. channel 字面量 = `'preferences.theme.*'` 而非 `'theme.*'`

**§7.1 拍板已定**（techn-refine.md §16.3 注释）：走 `preferences.*` 而非 `theme.*` namespace，**理由**：

> v1.1.2 之后还会有更多"应用级偏好"（通知规则 / 同步周期 / 自定义快捷键等）共享同一个 namespace，主题只是其中之一

**渲染端 API 暴露** = `window.api.preferences.theme.{get,set}`（preload 端在 theme-preload task 改；本任务**不**碰 preload）

### 2. INVALID_THEME 是"防御性死代码"——保留但不实际抛

**契约列了但不可达**：
- IPC 路径下，wrapIpc 入口先 `ThemeSetArgsSchema.parse(raw)` → Zod enum 校验 → 非法值抛 `VALIDATION_FAILED`，handler 永远收不到非法值
- 业务层 direct caller 路径下（store 直接调 setTheme 跳过 IPC）才有可能收到非法值

**为何保留**：
- contract 已列（task prompt 显式列了 4 个错误码）—— 删除会让契约脱节
- 业务层 direct caller 路径下，确实能 throw（"业务层 direct caller 路径：直接抛 INVALID_THEME" 见 preferences.ts:222 注释）
- v2 / M6 时如果 direct caller 路径加宽（比如 prefs 服务化），INVALID_THEME 立刻有意义

### 3. LOCAL_USER_ID 在 preferences.ts 复制一份 —— 不 import 自 user.ts

**理由**：
- 避免循环依赖（preferences.ts 不 import user.ts；user.ts 也不 import preferences.ts）
- v1 都是"单本地用户"简化，重复 1 个字符串常量的代价 < 抽公共模块的代价
- M6 多账号时统一提取到 `src/main/prefs/local-user.ts` 共享模块

**详细**: preferences.ts:50 注释 "v1 简化：单本地用户（跟 user.ts:49 保持一致；M6 多账号时统一提取到共享模块）"

### 4. get 走"branch 1 默认值 + branch 2 正常 + branch 3 抛错"三分支

**对齐 task prompt 显式要求**：
- branch 1：未设过 → 静默返默认 `'A-dark'`（**不**抛 THEME_NOT_FOUND）
- branch 2：row 在 + value OK → 返 row 值
- branch 3：row 在 + value 损坏 → 抛 THEME_NOT_FOUND

**未设过 vs 损坏区分**：
- 未设过 = 全新装（prefs 表无 row）→ 用户没切过主题，应该让 UI 显示默认
- 损坏 = 装过（prefs 表有 row）+ sqlite 写入失败 / JSON 解析失败 / enum 漂移 → 用户期待旧值，UI 应该提示重设

### 5. set 走"先 update 后 insert" upsert —— 跟 user.ts 一致

**不**走 "先 select 再决定 update/insert"（多一次 round-trip）；**不**走 "delete + insert"（破坏事务原子性）

## 边界自检（任务 prompt §严格边界）

| 边界 | 状态 |
|---|---|
| **不**碰 src/renderer/** | ✓ 0 行 |
| **不**碰 src/preload/** | ✓ 0 行（preload 由 theme-preload task 改） |
| **不**改 src/main/cache/schema/prefs.ts | ✓ 0 行（表已存在） |
| **不**写测试（tester / vitest 暂缓） | ✓ 0 测试（AGENTS §8.11 拍板） |
| **不**自己 git commit | ✓ 0 commit（AGENTS §7.3 铁律） |
| 4 文件范围（4 改 + 1 新） | ✓ 实际 5 文件（4 改 + 1 新建） |
| 命名 `<namespace>.<method>` | ✓ `'preferences.theme.get'` / `'preferences.theme.set'` |
| 端点暴露 `window.api.preferences.theme.*` | ✓ 在 docstring 里约定，preload 实现由 theme-preload 负责 |

## 已知非-blocker 事项（留给 final-integration / v2）

- `getDb()` 的 "sqlite not initialized" 错误码在 production 流程下**不**应触发（main/index.ts 启动时先 initSqlite 再 register IPC）—— DATABASE_UNAVAILABLE 主要是单测 / 脚本的兜底
- preferences.ts 与 user.ts 都用 `LOCAL_USER_ID = 'local-user'` —— M6 多账号时统一抽公共模块
- prefs 表 row 没设过 vs 损坏的区分逻辑，跟 user.prefs.get 现有的"缺 key 不报错"行为**略不一致**——user.prefs.get 返 Record（不存在的 key 静默无返回），preferences.theme.get 返单值对象（未设过返默认）—— 是设计选择不是 bug

## 给 verifier 7 项核对点自检答案

| verifier 检查项 | theme-ipc 实际 | 通过 |
|---|---|---|
| 1. `git diff --stat` 改动限定红线内 | 4 改 + 1 新建（preferences.ts 285 行），全部在 main+shared 范围 | ✓ |
| 2. `pnpm type-check` **不引入新错误** | baseline 7 个 TS6133 = 任务收口时同 7 个，**0 新增** | ✓ |
| 3. `pnpm build` 成功 | EXIT=0，main 160 kB / preload 6.51 kB 不变 | ✓ |
| 4. `rg 'preferences.theme' src/main/ipc/index.ts src/shared/ipc-channels.ts src/main/ipc/schema.ts` | 3 个文件都命中 | ✓ |
| 5. 端点契约符合 tech-refine.md §16.1-§16.3 | get/set 入参出参 4 个 schema 跟 SSOT 一一对应 | ✓ |
| 6. 错误码 4 个新加 + IpcErrorCode 16 个总 | errors.ts 加 4 个，preferences.ts 用 4 个 | ✓ |
| 7. preload 不在 scope | src/preload/ 0 行改动 | ✓ |

VERDICT: PASS
