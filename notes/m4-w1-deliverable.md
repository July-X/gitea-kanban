# W1 e2e 验证 deliverable

**Task**: W1: 仓库/分支/commits 端到端验证（repos.\* + branches.\* + commits.\*）
**Session**: mvs_2d0f407ffdaf4568aa27715310f67ea0
**日期**: 2026-06-11
**scope**: kanban_demo/m4java-test
**结果**: ✅ **15/15 全部通过**（repos / branches / commits / 缓存层 / 聚合算法）

---

## 1. 4 件套命令输出（producer 验证矩阵）

```text
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
(0 error)

$ pnpm build
out/main/index.js  137.87 kB
✓ built in 607ms
out/preload/index.cjs  5.50 kB
✓ built in 22ms
out/renderer/... (完整)
✓ built in 7.71s

$ pnpm check:no-jargon
[check:no-jargon] OK — 未发现禁用术语

$ bash scripts/e2e-verify-w1.sh
15 pass / 0 fail
```

---

## 2. e2e 验证脚本路径 + 跑通证据

### 2.1 脚本与 driver

| 文件 | 作用 |
|---|---|
| `scripts/e2e-verify-w1.ts` | 15 步 e2e 业务函数验证（tsx 源） |
| `scripts/e2e-verify-w1.sh` | 一键复跑 driver（bundle + ABI 切换 + 跑 + 恢复） |
| `scripts/.e2e-verify-w1.bundled.mjs` | esbuild 产物（带 electron/pino stub），gitignore |
| `/Users/zhongxingxing/.mavis/plans/plan_2f3810f0/outputs/w1-repos-branches-commits/e2e-samples.json` | 验证证据（pass=15, fail=0, full samples） |

### 2.2 复跑命令

```bash
bash scripts/e2e-verify-w1.sh
```

输出最后一行：`15 pass / 0 fail`

### 2.3 samples.json 关键 evidence

```json
{
  "pass": 15, "fail": 0, "failures": [],
  "samples": {
    "repos.list1.count": 1,
    "repos.list1.m4": {
      "fullName": "kanban_demo/m4java-test",
      "defaultBranch": "main",
      "isProject": false,
      "private": false
    },
    "branches.list.count": 4,
    "branches.list.names": ["develop", "feature-kanban", "feature-merge", "main"],
    "branches.list.mainIsDefault": true,
    "commits.list.mainCount": 7,
    "commits.list.firstSha": "37bb9a8",
    "commits.list.firstMessage": "看板 UI 改稿（feature-kanban → main） (#11)",
    "commits.get.parents": 1,
    "timeline.totalCommits": 15,
    "timeline.nodes": 15,
    "timeline.edges": 14,
    "timeline.lanes": [
      { "id": "branch:main",            "label": "main",            "color": "#609926" },
      { "id": "branch:feature-kanban",  "label": "feature-kanban",  "color": "#6c757d" },
      { "id": "branch:feature-merge",   "label": "feature-merge",   "color": "#f76707" },
      { "id": "branch:develop",         "label": "develop",         "color": "#6c757d" }
    ],
    "timeline.prs": [
      { "index": 12, "state": "merged", "title": "合并工作流（feature-merge → main）" },
      { "index": 11, "state": "merged", "title": "看板 UI 改稿（feature-kanban → main）" }
    ]
  }
}
```

---

## 3. 每个 IPC 端点的测试结果

| 端点 | step | 验证 | 结果 | 关键 metric |
|---|---|---|---|---|
| **repos.list** | 3 | listGiteaRepos + findProjectsByOwnerName JOIN | ✅ | 1 个仓库（m4java-test），isProject=false（addProject 前） |
| **repos.addProject** | 4+5 | cache/repos.addProject 幂等 | ✅ | 同 owner/name 第二次 add 返同 projectId |
| **repos.removeProject** | 7 | cache/repos.removeProject 幂等 | ✅ | 第二次 remove 不抛，listProjectsForAccount 验证已删 |
| **branches.list** | 8 | listGiteaBranches + listStarredBranches JOIN | ✅ | 4 分支（main / feature-kanban / feature-merge / develop），main.isDefault=true |
| **branches.star** | 9 | cache/branches.setStarred UPSERT | ✅ | starred_branches 表写入 OK |
| **branches cache** | 10 | getBranchesCache / setBranchesCache / invalidateBranchesCache | ✅ | 1 min TTL 写/读/失效三段全 OK |
| **commits.list** | 11 | listGiteaCommits + getLinkedCardsForCommits（v1 stub） | ✅ | main 上 7 commits，head 37bb9a8 "看板 UI 改稿" |
| **commits.get** | 12 | getGiteaCommit 走 /git/commits/ 拿 stats | ✅ | parents=1（merge commit parent 主分支） |
| **commits.timeline** | 13 | listGiteaCommits (4 branches) + listGiteaPulls + buildTimeline 聚合 | ✅ | **15 commits / 14 edges / 4 lanes / 2 PRs (merged)**，truncated=false |
| **timeline cache** | 14 | getTimelineCache / setTimelineCache 30s TTL | ✅ | payload roundtrip OK |
| **commits cache** | 15 | v1 stub 行为确认 | ✅ | get 永远 null，set no-op（按 ADR-0002 v1 简化） |

### 3.1 关键交叉验证

- **02-architecture §5.3.4 lane 颜色三色** 拍板**全部对上**：
  - main → `#609926`（主色 primary green）✓
  - feature-merge → `#f76707`（active orange）✓
  - feature-kanban / develop → `#6c757d`（archived gray）✓
  - main 在最上（order=0）✓
- **PRs**：2 个 merged PR（#11 看板 UI 改稿、#12 合并工作流）正确出现在 TimelineDto.prs 字段
- **commit sha 解析**：`37bb9a8` shortSha 与 list/get 一致

### 3.2 已知限制（v1 stub 行为，不是 bug）

- `cache/commits.linkedCards` 永远返空 Map（v1 不存 cards 表；ADR-0002 reset）
  - UI 看到 `linkedCards: []` 是预期行为
- `cache/commits.getCommitsCache` / `setCommitsCache` 是 no-op（v1 简化）
  - 写缓存调用**不会**真正落 cache_entries，但 IPC handler 仍正常返 DTO
- `commits.timeline` 缓存层（`cache/timeline.ts`）30s TTL **正常**（与 pulls 同步），但 commits list/get 缓存不写

---

## 4. 改动的文件清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `scripts/e2e-verify-w1.ts` | **新增** | 15 步 e2e 验证脚本（tsx 源） |
| `scripts/e2e-verify-w1.sh` | **新增** | 一键复跑 driver（bundle + ABI 切换 + 跑 + 恢复） |
| `scripts/.e2e-verify-w1.bundled.mjs` | **新增** | esbuild 产物（gitignored 即可） |
| `/tmp/e2e-shim/{electron-stub,pino-stub,bundle.mjs}.ts` | **新增** | bundling 阶段的 stub（独立于仓库，**不污染** gitea-kanban） |
| `src/main/**` | **未改** | task 禁止 |
| `src/main/ipc/**` | **未改** | task 禁止 |

> **src 改动 = 0**。所有 e2e 验证基于现有实现，task "**不**修改代码"边界完全遵守。

---

## 5. 关键工程决策（给 verifier + 后续 plan 参考）

### 5.1 e2e 脚本设计：tsx + esbuild bundle 避开 electron runtime

**问题**：task prompt 两个方案都有限制：
- 方案 A（spawn electron + IPC）：dev 启动有风险（AGENTS §8.14 教训）
- 方案 B（tsx 直接 require 业务函数）：`cache/sqlite.ts` 顶层引 `logger.ts` → `electron`，tsx 跑在 node 上下文**没有真 app**

**解决**：
- 用 esbuild bundle `scripts/e2e-verify-w1.ts` → `.bundled.mjs`（esm）
- alias `electron` → 最小 stub（app = `{ isPackaged: false, ... }`）
- alias `pino` → noop stub（避免 pino-pretty worker thread 路径问题）
- external：`better-sqlite3` / `@napi-rs/keyring*`（native binding 不进 bundle）
- banner：注入 `createRequire` 让 pino 的 dynamic require 仍能工作

### 5.2 ABI 切换（AGENTS §8.11 延伸）

- 默认 `.node` 是 **electron 41 ABI=145**（dev/build 用）
- node 25 ABI=141 跑 e2e 脚本要切换
- driver 自动 4 步：bundle → 切 node 25 → 跑测试 → 切回 electron 41
- 跑完状态：electron 145 OK，node 141 FAIL（= 已切回，预期）
- **替代方案**：用真 electron 跑 bundled 脚本（但 app.whenReady 卡住，复杂度更高）

### 5.3 为什么不引 `ipc/*` 模块

`ipc/*` 模块顶层 `import { ipcMain } from 'electron'`，并且需要 Electron 进程跑 `ipcMain.handle` 注册。但 e2e 验证的是**业务函数**（gitea/* + cache/* + gitea/timeline.ts buildTimeline），不是 IPC 桥——所以直接调 handler 等价物：

| IPC 端点 | 等价业务调用 |
|---|---|
| `repos.list` | `listGiteaRepos(...) + findProjectsByOwnerName(...)` |
| `repos.addProject` | `cacheAddProject(...)` |
| `repos.removeProject` | `cacheRemoveProject(...)` |
| `branches.list` | `listGiteaBranches(...) + listStarredBranches(...)` |
| `branches.star` | `setStarred(...)` |
| `commits.list` | `listGiteaCommits(...) + getLinkedCardsForCommits(...)` |
| `commits.get` | `getGiteaCommit(...)` |
| `commits.timeline` | `listGiteaCommits × N + listGiteaPulls + buildTimeline(...)` |

业务函数抛 `IpcError` → wrapIpc 在 IPC 边界转 JSON。这里直接 throw → `check()` 抓 `e.message` 验证错误码（同 try/catch 语义）。

### 5.4 临时 db 隔离

`GITEA_KANBAN_DATA_DIR` env var 在脚本顶部设到 `/tmp/gitea-kanban-w1-<uuid>/`，**不污染** `~/.gitea-kanban/kanban.db`。keychain 也走 keychainDelete 清掉。脚本最后 `rmSync(TEST_DATA_DIR, recursive, force)` 全清。

---

## 6. 跑前 vs 跑后状态

| 检查项 | 跑前 | 跑后 |
|---|---|---|
| `pnpm type-check` | 0 error | 0 error |
| `pnpm build` | OK | OK |
| `pnpm check:no-jargon` | OK | OK |
| better-sqlite3 ABI | electron 145 (electron 41.7.2) | electron 145（driver step 4 切回）|
| keychain | clean | clean（keychainDelete + 不留 entry）|
| `~/.gitea-kanban/kanban.db` | user data | user data（**未**被改）|
| `/tmp/gitea-kanban-w1-*` | n/a | n/a（cleanup 已删）|

**没有留下任何副作用**。

---

## 7. 已知问题 / 注意事项

1. **两份 prebuild cache file size 相同但 sha 不同**（electron=145 / node=141 = 各 1929888 bytes vs 1929888 bytes 实际同 size 但不同 sha）。
   prebuild-install 看 cached 命中会 unpack 覆盖，但 mod time 保持原值——视觉上看不出"切了"。
   **检查方法**：跑前 `shasum .../better_sqlite3.node` 跟 cached 比对，或跑完调 electron native verify。

2. **tsx 4.22.4 不支持 `--import` 直接传 ts loader**。ESM module mocking 走 esbuild alias 才能用——tsx + esbuild 是当前唯一的实操路径。

3. **commits cache v1 stub**：跟 ADR-0002 §"v1 简化" 一致（commits list/get 暂不缓存；只有 timeline 缓存 30s）。
   写 future commit 的 worker 看到这个不要去"补"——这是有意为之的 stub。

4. **commits.timeline 颜色 vs main 在最上**：main 在 lanes[0]（idx=0），但 feature-kanban 拿到 archived gray 颜色——main 用 primary green，**颜色 ≠ order**。
   这是 `gitea/timeline.ts:buildLanes` 的 `idx === 0 && b === 'main'` 分支条件，**符合** 02 §5.3.4 拍板。
   不过 **feature-kanban 跟 develop 同色**有点反直觉（视觉上"主要 feature" 跟"实验性分支"分不开）——但这是 v1 简化，AGENTS 没拍板区别。

5. **lane 顺序**：branches 数组顺序 = main / feature-kanban / feature-merge / develop。task prompt 没规定 lane 顺序，算法按 `args.branches` 顺序，**main 总是 lane 0**（IPC caller 决定顺序）。脚本里写死 `[main, feature-kanban, feature-merge, develop]`。

---

## 8. Stop condition 验证

- [x] e2e 验证脚本路径：`scripts/e2e-verify-w1.ts` + `scripts/e2e-verify-w1.sh`
- [x] 跑通证据：samples.json + 4 件套输出 + e2e 脚本 stdout（全部见上）
- [x] 4 件套命令：type-check 0 error / build OK / check:no-jargon OK / e2e 15 pass
- [x] 每个 IPC 端点测试结果：见 §3 表格
- [x] 已知问题：见 §7
- [x] 改动文件清单：见 §4（src 改动 = 0）
- [x] notes/m4-w1-deliverable.md：即本文档
